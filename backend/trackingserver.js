const express = require("express");
const fs = require("fs");
const path = require("path");

let XLSX;
try {
  XLSX = require("xlsx");
} catch (err) {
  XLSX = null;
}

/**
 * Tender Customer Tracking API
 *
 * The workbooks remain the source of truth for prospect/company data.
 * PostgreSQL stores a normalized searchable copy plus proposal tracking
 * so a tender company can be marked "done" without changing the xlsx.
 *
 * Two workbooks are synced, each with its OWN column layout:
 *   1) UK_SUBCONTRACTOR_PROSPECT_MASTER_FINAL.xlsx
 *      sheet: UK_SUBCONTRACTOR_PROSPECTS
 *   2) SUBCONTRACTOR_PROSPECT_MASTER.xlsx
 *      sheet: SUBCONTRACTOR_PROSPECTS (US-style federal contract data)
 *
 * Default folder: <nova-crm-project>/data (a SIBLING of the backend
 * folder this file lives in — NOT backend/data). Override with
 * TENDER_DATA_DIR, or point at each file individually with
 * TENDER_WORKBOOK_UK_PATH / TENDER_WORKBOOK_US_PATH.
 */
function createTenderTrackingRouter({ pool, requireAuthenticatedUser, isContractManager }) {
  const router = express.Router();

  const DEFAULT_DATA_DIR =
    process.env.TENDER_DATA_DIR ||
    path.join(__dirname, "..", "nova-crm-project", "data");

  function normalizeKey(value) {
    return clean(value).toLowerCase().replace(/\s+/g, " ");
  }

  const WORKBOOKS = [
    {
      key: "uk",
      path: process.env.TENDER_WORKBOOK_UK_PATH || path.join(DEFAULT_DATA_DIR, "UK_SUBCONTRACTOR_PROSPECT_MASTER_FINAL.xlsx"),
      sheetMatch: (name) => normalizeKey(name) === "uk_subcontractor_prospects",
      mapRow: mapUkRow,
    },
    {
      key: "us",
      path: process.env.TENDER_WORKBOOK_US_PATH || path.join(DEFAULT_DATA_DIR, "SUBCONTRACTOR_PROSPECT_MASTER.xlsx"),
      sheetMatch: (name) => normalizeKey(name) === "subcontractor_prospects",
      mapRow: mapUsRow,
    },
  ];

  let lastLoadedMtimes = {}; // key -> mtimeMs
  let loadingPromise = null;

  function managerGuard(req, res, next) {
    Promise.resolve(requireAuthenticatedUser(req, res))
      .then((user) => {
        if (!user) return;
        if (!isContractManager(user.role)) {
          return res.status(403).json({ message: "Staff access required." });
        }
        req.tenderActor = user;
        next();
      })
      .catch((err) => {
        console.error("[TENDER AUTH]", err);
        res.status(500).json({ message: "Authentication check failed.", error: err.message });
      });
  }

  function clean(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim();
  }

  function firstNonEmpty(...values) {
    return values.map(clean).find(Boolean) || "";
  }

  function compactRow(row) {
    const out = {};
    for (const [key, value] of Object.entries(row || {})) {
      if (value === undefined || value === null || String(value).trim() === "") continue;
      out[String(key).toUpperCase()] = value;
    }
    return out;
  }

  /* ---------------- Column mapping: UK workbook ----------------
     Real headers confirmed from UK_SUBCONTRACTOR_PROSPECT_MASTER_FINAL.xlsx
     -> sheet UK_SUBCONTRACTOR_PROSPECTS. */
  function mapUkRow(first) {
    return {
      company_name: firstNonEmpty(first.COMPANY_NAME, first.LEGAL_COMPANY_NAME),
      legal_company_name: clean(first.LEGAL_COMPANY_NAME),
      company_number: clean(first.COMPANY_NUMBER),
      official_website: clean(first.VERIFIED_OFFICIAL_WEBSITE),
      linkedin_url: clean(first.COMPANY_LINKEDIN_URL),
      company_emails: clean(first.ALL_VERIFIED_COMPANY_EMAILS),
      executive_name: clean(first.EXECUTIVE_1_NAME),
      executive_role: clean(first.EXECUTIVE_1_ROLE),
      executive_email: clean(first.EXECUTIVE_1_EMAIL),
      procurement_url: clean(first.PROCUREMENT_URL),
      procurement_emails: clean(first.PROCUREMENT_EMAILS),
      supplier_url: clean(first.SUPPLIER_URL),
      supplier_emails: clean(first.SUPPLIER_EMAILS),
      subcontracting_url: clean(first.SUBCONTRACTING_URL),
      subcontracting_emails: clean(first.SUBCONTRACTING_EMAILS),
      teaming_url: clean(first.TEAMING_URL),
      teaming_emails: clean(first.TEAMING_EMAILS),
      partnership_url: clean(first.PARTNERSHIP_URL),
      partnership_emails: clean(first.PARTNERSHIP_EMAILS),
      primary_domain: "",
      tender_domain: "",
      tender_subdomain: "",
    };
  }

  /* ---------------- Column mapping: US/global workbook ----------------
     Real headers confirmed from SUBCONTRACTOR_PROSPECT_MASTER.xlsx
     -> sheet SUBCONTRACTOR_PROSPECTS. This sheet has NO company_number,
     NO tender_domain/tender_subdomain (it uses federal award fields
     instead), and different field names for several columns. */
  function mapUsRow(first) {
    return {
      company_name: firstNonEmpty(first.COMPANY_NAME, first.LEGAL_NAME, first.DISPLAY_NAME),
      legal_company_name: clean(first.LEGAL_NAME),
      company_number: "",
      official_website: clean(first.OFFICIAL_COMPANY_WEBSITE),
      linkedin_url: clean(first.COMPANY_LINKEDIN),
      company_emails: firstNonEmpty(first.ALL_COMPANY_EMAILS, first.PRIMARY_LEAD_EMAILS, first.GENERAL_EMAILS),
      executive_name: clean(first.EXECUTIVE_1_NAME),
      executive_role: clean(first.EXECUTIVE_1_TITLE),
      executive_email: clean(first.EXECUTIVE_1_EMAIL),
      procurement_url: clean(first.PROCUREMENT_URL),
      procurement_emails: clean(first.PROCUREMENT_EMAILS),
      supplier_url: clean(first.SUPPLIER_URL),
      supplier_emails: clean(first.SUPPLIER_EMAILS),
      subcontracting_url: clean(first.SUBCONTRACTING_URL),
      subcontracting_emails: clean(first.SUBCONTRACTING_EMAILS),
      teaming_url: clean(first.TEAMING_URL),
      teaming_emails: clean(first.TEAMING_EMAILS),
      partnership_url: clean(first.PARTNERSHIP_URL),
      partnership_emails: clean(first.PARTNERSHIP_EMAILS),
      primary_domain: clean(first.OFFICIAL_DOMAIN),
      tender_domain: "",
      tender_subdomain: "",
    };
  }

  function sourceKey(workbookKey, row) {
    const companyNumber = normalizeKey(row.COMPANY_NUMBER);
    const companyName = normalizeKey(row.COMPANY_NAME);
    return `${workbookKey}::${companyNumber || "no-number"}::${companyName}`;
  }

  function companyFromRows(workbookKey, mapRow, rows) {
    const first = rows[0] || {};
    const base = mapRow(first);

    const domains = rows.map((r) => clean(r.TENDER_DOMAIN)).filter(Boolean);
    const subdomains = rows.map((r) => clean(r.TENDER_SUBDOMAIN)).filter(Boolean);

    return {
      source_key: sourceKey(workbookKey, first),
      ...base,
      primary_domain: base.primary_domain || domains[0] || "",
      tender_domain: domains[0] || "",
      tender_subdomain: subdomains[0] || "",
      tender_count: rows.length,
      raw_data: compactRow(first),
      tender_data: rows.map(compactRow),
    };
  }

  async function upsertCompany(client, c, workbookBasename, sheetName, rowCount) {
    await client.query(
      `INSERT INTO tender_customers (
        source_key, company_name, legal_company_name, company_number,
        official_website, linkedin_url, company_emails,
        executive_name, executive_role, executive_email,
        procurement_url, procurement_emails,
        supplier_url, supplier_emails,
        subcontracting_url, subcontracting_emails,
        teaming_url, teaming_emails,
        partnership_url, partnership_emails,
        primary_domain, tender_domain, tender_subdomain,
        tender_count, raw_data, tender_data, source_workbook,
        source_sheet, source_row_count, source_updated_at, updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25::jsonb,$26::jsonb,$27,$28,$29,NOW(),NOW()
      )
      ON CONFLICT (source_key) DO UPDATE SET
        company_name = EXCLUDED.company_name,
        legal_company_name = EXCLUDED.legal_company_name,
        company_number = EXCLUDED.company_number,
        official_website = EXCLUDED.official_website,
        linkedin_url = EXCLUDED.linkedin_url,
        company_emails = EXCLUDED.company_emails,
        executive_name = EXCLUDED.executive_name,
        executive_role = EXCLUDED.executive_role,
        executive_email = EXCLUDED.executive_email,
        procurement_url = EXCLUDED.procurement_url,
        procurement_emails = EXCLUDED.procurement_emails,
        supplier_url = EXCLUDED.supplier_url,
        supplier_emails = EXCLUDED.supplier_emails,
        subcontracting_url = EXCLUDED.subcontracting_url,
        subcontracting_emails = EXCLUDED.subcontracting_emails,
        teaming_url = EXCLUDED.teaming_url,
        teaming_emails = EXCLUDED.teaming_emails,
        partnership_url = EXCLUDED.partnership_url,
        partnership_emails = EXCLUDED.partnership_emails,
        primary_domain = EXCLUDED.primary_domain,
        tender_domain = EXCLUDED.tender_domain,
        tender_subdomain = EXCLUDED.tender_subdomain,
        tender_count = EXCLUDED.tender_count,
        raw_data = EXCLUDED.raw_data,
        tender_data = EXCLUDED.tender_data,
        source_workbook = EXCLUDED.source_workbook,
        source_sheet = EXCLUDED.source_sheet,
        source_row_count = EXCLUDED.source_row_count,
        source_updated_at = NOW(),
        updated_at = NOW()`,
      [
        c.source_key,
        c.company_name,
        c.legal_company_name || null,
        c.company_number || null,
        c.official_website || null,
        c.linkedin_url || null,
        c.company_emails || null,
        c.executive_name || null,
        c.executive_role || null,
        c.executive_email || null,
        c.procurement_url || null,
        c.procurement_emails || null,
        c.supplier_url || null,
        c.supplier_emails || null,
        c.subcontracting_url || null,
        c.subcontracting_emails || null,
        c.teaming_url || null,
        c.teaming_emails || null,
        c.partnership_url || null,
        c.partnership_emails || null,
        c.primary_domain || null,
        c.tender_domain || null,
        c.tender_subdomain || null,
        c.tender_count,
        JSON.stringify(c.raw_data),
        JSON.stringify(c.tender_data),
        workbookBasename,
        sheetName,
        rowCount,
      ]
    );
  }

  async function syncOneWorkbook(client, workbook) {
    if (!fs.existsSync(workbook.path)) {
      return { file: path.basename(workbook.path), skipped: true, reason: "file not found at " + workbook.path };
    }

    const wb = XLSX.readFile(workbook.path, { cellDates: false, raw: false });
    const sheetName = wb.SheetNames.find(workbook.sheetMatch) || wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    if (!sheet) {
      return { file: path.basename(workbook.path), skipped: true, reason: "no matching worksheet found" };
    }

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

    const grouped = new Map();
    for (const row of rows) {
      if (!clean(row.COMPANY_NAME)) continue;
      const key = sourceKey(workbook.key, row);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }

    let count = 0;
    for (const companyRows of grouped.values()) {
      const c = companyFromRows(workbook.key, workbook.mapRow, companyRows);
      await upsertCompany(client, c, path.basename(workbook.path), sheetName, companyRows.length);
      count++;
    }

    await client.query(
      `INSERT INTO tender_import_runs (source_workbook, source_sheet, company_count, row_count, imported_at)
       VALUES ($1,$2,$3,$4,NOW())`,
      [path.basename(workbook.path), sheetName, count, rows.length]
    );

    return { file: path.basename(workbook.path), sheet: sheetName, company_count: count, row_count: rows.length };
  }

  async function syncWorkbooks(force = false) {
    if (!XLSX) {
      throw new Error("The 'xlsx' package is not installed in backend/. Run: npm install xlsx");
    }

    if (!force) {
      const anyChanged = WORKBOOKS.some((wb) => {
        if (!fs.existsSync(wb.path)) return false;
        const stat = fs.statSync(wb.path);
        return !lastLoadedMtimes[wb.key] || stat.mtimeMs > lastLoadedMtimes[wb.key];
      });
      if (!anyChanged) return { synced: false, reason: "unchanged" };
    }

    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
      const client = await pool.connect();
      const results = [];
      try {
        await client.query("BEGIN");
        for (const wb of WORKBOOKS) {
          const result = await syncOneWorkbook(client, wb);
          results.push(result);
          if (!result.skipped && fs.existsSync(wb.path)) {
            lastLoadedMtimes[wb.key] = fs.statSync(wb.path).mtimeMs;
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      const missing = results.filter((r) => r.skipped);
      if (missing.length === WORKBOOKS.length) {
        // Neither workbook was found — this is almost certainly a path
        // problem, so say so plainly instead of pretending it synced.
        throw new Error(
          "No tender workbooks found. Checked: " + WORKBOOKS.map((w) => w.path).join(", ")
        );
      }

      return {
        synced: true,
        workbooks: results,
        company_count: results.reduce((sum, r) => sum + (r.company_count || 0), 0),
        row_count: results.reduce((sum, r) => sum + (r.row_count || 0), 0),
      };
    })();

    try {
      return await loadingPromise;
    } finally {
      loadingPromise = null;
    }
  }

  let tenderCustomerSchemaPromise = null;

  async function ensureTenderCustomerSchema() {
    if (String(process.env.DB_DIALECT || "mysql").toLowerCase() !== "mysql") return;
    if (tenderCustomerSchemaPromise) return tenderCustomerSchemaPromise;

    tenderCustomerSchemaPromise = (async () => {
      const check = await pool.query(`
        SELECT COUNT(*) AS count
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'tender_customers'
          AND column_name = 'selected_for_proposal'
      `);

      if (Number(check.rows?.[0]?.count || 0) === 0) {
        await pool.query(`
          ALTER TABLE tender_customers
          ADD COLUMN selected_for_proposal TINYINT(1) NOT NULL DEFAULT 0
        `);
        console.log("[TENDER CUSTOMERS] Added missing selected_for_proposal column");
      }
    })().catch((err) => {
      tenderCustomerSchemaPromise = null;
      throw err;
    });

    return tenderCustomerSchemaPromise;
  }

  async function ensureFresh() {
    await ensureTenderCustomerSchema();
    return syncWorkbooks(false);
  }

  router.get("/customers", managerGuard, async (req, res) => {
    try {
      await ensureFresh();

      const search = clean(req.query.search);
      const status = clean(req.query.status);
      // ?selected=true restricts the list to companies the team has
      // explicitly marked "selected for proposal" — this is how the
      // Proposals generator's Tender Customer dropdown stays limited
      // to only the companies chosen on the Tender Customers page.
      const selectedOnlyRaw = clean(req.query.selected).toLowerCase();
      const selectedOnly = selectedOnlyRaw === "true" || selectedOnlyRaw === "1";
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const offset = Math.max(Number(req.query.offset) || 0, 0);

      const result = await pool.query(
        `SELECT
           id, company_name, legal_company_name, company_number,
           official_website, linkedin_url, company_emails,
           executive_name, executive_role, executive_email,
           primary_domain, tender_domain, tender_subdomain, tender_count,
           proposal_status, last_proposal_id, proposal_created_at,
           selected_for_proposal,
           source_workbook, source_sheet, source_row_count,
           source_updated_at, created_at, updated_at
         FROM tender_customers
         WHERE ($1 = '' OR
                company_name ILIKE '%' || $1 || '%' OR
                legal_company_name ILIKE '%' || $1 || '%' OR
                company_number ILIKE '%' || $1 || '%' OR
                company_emails ILIKE '%' || $1 || '%')
           AND ($2 = '' OR proposal_status = $2)
           AND ($5 = false OR selected_for_proposal = true)
         ORDER BY
           CASE WHEN proposal_status = 'pending' THEN 0 ELSE 1 END,
           company_name ASC
         LIMIT $3 OFFSET $4`,
        [search, status, limit, offset, selectedOnly]
      );

      const count = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM tender_customers
         WHERE ($1 = '' OR
                company_name ILIKE '%' || $1 || '%' OR
                legal_company_name ILIKE '%' || $1 || '%' OR
                company_number ILIKE '%' || $1 || '%' OR
                company_emails ILIKE '%' || $1 || '%')
           AND ($2 = '' OR proposal_status = $2)
           AND ($3 = false OR selected_for_proposal = true)`,
        [search, status, selectedOnly]
      );

      return res.json({
        customers: result.rows,
        total: count.rows[0]?.total || 0,
        limit,
        offset,
      });
    } catch (err) {
      console.error("[TENDER CUSTOMERS GET]", err);
      return res.status(500).json({
        // Real reason shown to the UI now, not a generic string, so
        // config problems (bad path, missing table, missing package)
        // are visible without needing the server console.
        message: err.message || "Failed to load tender customers.",
        error: err.message,
      });
    }
  });

  router.get("/customers/:id", managerGuard, async (req, res) => {
    try {
      await ensureFresh();

      const result = await pool.query(
        `SELECT * FROM tender_customers WHERE id = $1 LIMIT 1`,
        [Number(req.params.id)]
      );
      const customer = result.rows[0];
      if (!customer) return res.status(404).json({ message: "Tender customer not found." });

      const proposals = await pool.query(
        `SELECT tcp.*, pf.opportunity, pf.status, pf.version, pf.file_url, pf.created_at
         FROM tender_customer_proposals tcp
         LEFT JOIN proposal_files pf ON pf.id = tcp.proposal_id
         WHERE tcp.tender_customer_id = $1
         ORDER BY tcp.created_at DESC`,
        [customer.id]
      );

      return res.json({ customer, proposals: proposals.rows });
    } catch (err) {
      console.error("[TENDER CUSTOMER GET]", err);
      return res.status(500).json({
        message: err.message || "Failed to load tender customer.",
        error: err.message,
      });
    }
  });

  router.post("/sync", managerGuard, async (req, res) => {
    try {
      const result = await syncWorkbooks(true);
      return res.json({ message: "Tender workbooks synced.", ...result });
    } catch (err) {
      console.error("[TENDER SYNC]", err);
      return res.status(500).json({
        message: err.message || "Failed to sync tender workbooks.",
        error: err.message,
      });
    }
  });

  router.patch("/customers/:id/status", managerGuard, async (req, res) => {
    try {
      const status = clean(req.body?.status).toLowerCase();
      if (!["pending", "done"].includes(status)) {
        return res.status(400).json({ message: "status must be pending or done." });
      }

      const result = await pool.query(
        `UPDATE tender_customers
         SET proposal_status = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING id, company_name, proposal_status, last_proposal_id, proposal_created_at`,
        [status, Number(req.params.id)]
      );
      if (!result.rows[0]) return res.status(404).json({ message: "Tender customer not found." });
      return res.json({ customer: result.rows[0] });
    } catch (err) {
      console.error("[TENDER STATUS]", err);
      return res.status(500).json({
        message: err.message || "Failed to update tender customer status.",
        error: err.message,
      });
    }
  });

  // Bulk mark/unmark companies as "selected for proposal". This is the
  // only thing that controls whether a tender company shows up in the
  // Proposals generator's Tender Customer dropdown (see GET /customers
  // ?selected=true above).
  router.post("/customers/select", managerGuard, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
        : [];
      const selected = Boolean(req.body?.selected);

      if (ids.length === 0) {
        return res.status(400).json({ message: "Provide at least one id." });
      }

      const result = await pool.query(
        `UPDATE tender_customers
         SET selected_for_proposal = $1,
             updated_at = NOW()
         WHERE id = ANY($2::bigint[])
         RETURNING id`,
        [selected, ids]
      );

      return res.json({
        message: selected
          ? `${result.rowCount} compan${result.rowCount === 1 ? "y" : "ies"} sent to Proposals.`
          : `${result.rowCount} compan${result.rowCount === 1 ? "y" : "ies"} removed from Proposals.`,
        updated: result.rowCount,
        selected,
      });
    } catch (err) {
      console.error("[TENDER CUSTOMERS SELECT]", err);
      return res.status(500).json({
        message: err.message || "Failed to update selection.",
        error: err.message,
      });
    }
  });

  router.get("/stats", managerGuard, async (req, res) => {
    try {
      await ensureFresh();
      const result = await pool.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE proposal_status = 'pending')::int AS pending,
           COUNT(*) FILTER (WHERE proposal_status = 'done')::int AS done,
           COUNT(*) FILTER (WHERE selected_for_proposal = true)::int AS selected,
           COALESCE(SUM(tender_count), 0)::int AS tender_rows
         FROM tender_customers`
      );
      return res.json(result.rows[0]);
    } catch (err) {
      console.error("[TENDER STATS]", err);
      return res.status(500).json({ message: err.message || "Failed to load tender statistics.", error: err.message });
    }
  });

  // Lightweight diagnostic endpoint — hit this in the browser or curl
  // it to see exactly which paths this server is looking at.
  router.get("/health", managerGuard, async (_req, res) => {
    return res.json({
      ok: Boolean(XLSX),
      xlsx_package: Boolean(XLSX),
      workbooks: WORKBOOKS.map((wb) => ({
        key: wb.key,
        path: wb.path,
        exists: fs.existsSync(wb.path),
      })),
    });
  });

  return router;
}

module.exports = { createTenderTrackingRouter };