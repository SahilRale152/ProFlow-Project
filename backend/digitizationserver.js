const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

let XLSX;
try {
  XLSX = require("xlsx");
} catch (err) {
  XLSX = null;
}

/**
 * Scanning & Digitization Module — SAM.gov + TED (EU) + UK Tender Capture
 * ---------------------------------------------------------------------
 * Wraps all three engines behind one API:
 *   - sam_digitization_engine.py          (SAM.gov, US)
 *   - ted_it_procurement_intelligence.py  (TED, European Union)
 *   - uk_tender_intelligence.py           (UK Contracts Finder / Find a Tender)
 *
 * All three now accept the same CLI contract: --profile-json <file> --output <file>,
 * and all three print a final `SCAN_SUMMARY_JSON::<path>` line this router greps for.
 * TED and UK share an identical Excel schema (UK's engine was derived from TED's),
 * so they share one column map; SAM.gov has its own.
 *
 * Mount with:
 *   app.use("/api/digitization", createDigitizationRouter({ pool, requireAuthenticatedUser, isContractManager }));
 */
function createDigitizationRouter({
  pool,
  requireAuthenticatedUser,
  isContractManager,
  moduleKey = "digitization",
  tablePrefix = "digitization",
  dataDirOverride = null,
  scriptsDirOverride = null,
  pythonBinOverride = null,
  scanTimeoutMsOverride = null,
}) {
  const router = express.Router();

  const MODULE_KEY = String(moduleKey || "digitization").toLowerCase();
  const LOG_LABEL = MODULE_KEY.toUpperCase();
  const TABLE_PREFIX = String(tablePrefix || MODULE_KEY).toLowerCase();
  const LIVE_TABLE = `${TABLE_PREFIX}_tenders_live`;
  const SUB_TABLE = `${TABLE_PREFIX}_tenders_subcontracting`;
  const SCAN_TABLE = `${TABLE_PREFIX}_scan_runs`;
  const DATA_DIR =
    dataDirOverride ||
    process.env[`${MODULE_KEY.toUpperCase()}_DATA_DIR`] ||
    (MODULE_KEY === "digitization"
      ? process.env.DIGITIZATION_DATA_DIR
      : null) ||
    path.join(__dirname, "..", "nova-crm-project", "data", MODULE_KEY);
  const SCRIPTS_DIR =
    scriptsDirOverride ||
    process.env[`${MODULE_KEY.toUpperCase()}_SCRIPTS_DIR`] ||
    (MODULE_KEY === "digitization" ? process.env.DIGITIZATION_SCRIPTS_DIR : null) ||
    path.join(__dirname, "scripts");
  function resolvePythonCommand() {
    const configured =
      pythonBinOverride ||
      process.env[`${MODULE_KEY.toUpperCase()}_PYTHON_BIN`] ||
      (MODULE_KEY === "digitization" ? process.env.DIGITIZATION_PYTHON_BIN : null);

    // Build a portable candidate list. On Windows, `python` can resolve to a
    // broken shim such as C:\python.exe, so discover every Python executable
    // on PATH and verify that it can import the standard-library encodings module.
    const candidates = [];
    const addCandidate = (command, args = []) => {
      if (!command) return;
      candidates.push({ command: String(command).trim(), args });
    };

    if (process.platform === "win32") {
      // Resolve the actual executables behind `python` without hard-coding any
      // developer-specific installation path.
      const where = spawnSync("where.exe", ["python"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (!where.error && where.status === 0 && where.stdout) {
        String(where.stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => addCandidate(line));
      }

      if (configured && !/^python3?$|^py$/i.test(String(configured).trim())) {
        addCandidate(configured);
      }
      addCandidate("py", ["-3"]);

      const where3 = spawnSync("where.exe", ["python3"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (!where3.error && where3.status === 0 && where3.stdout) {
        String(where3.stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => addCandidate(line));
      }
      addCandidate("python3");
      addCandidate("python");
    } else {
      if (configured) addCandidate(configured);
      addCandidate("python3");
      addCandidate("python");
    }

    const seen = new Set();
    for (const candidate of candidates) {
      const key = `${candidate.command.toLowerCase()}\0${candidate.args.join(" ")}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // `python --version` is not sufficient: a broken Python installation can
      // still print a version while failing to initialize the standard library.
      const probe = spawnSync(
        candidate.command,
        [
          ...candidate.args,
          "-c",
          "import encodings,sys; print(sys.executable)",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
        }
      );

      if (!probe.error && probe.status === 0) {
        return candidate;
      }

      console.log(
        `[${LOG_LABEL}] python probe failed for "${candidate.command} ${candidate.args.join(" ")}" — ` +
        (probe.error ? probe.error.message : `exit code ${probe.status}`) +
        " (trying the next candidate)"
      );
    }

    // Keep a platform-appropriate fallback so the eventual child-process error
    // remains clear if no usable Python installation exists.
    return process.platform === "win32"
      ? { command: "py", args: ["-3"] }
      : { command: "python3", args: [] };
  }
    const PYTHON_COMMAND = resolvePythonCommand();
  console.log(
    `[${LOG_LABEL}] using Python interpreter: ${PYTHON_COMMAND.command}` +
    (PYTHON_COMMAND.args.length ? ` ${PYTHON_COMMAND.args.join(" ")}` : "")
  );
  const SCAN_TIMEOUT_MS = Number(
    scanTimeoutMsOverride ||
      process.env[`${MODULE_KEY.toUpperCase()}_SCAN_TIMEOUT_MS`] ||
      (MODULE_KEY === "digitization" ? process.env.DIGITIZATION_SCAN_TIMEOUT_MS : null) ||
      25 * 60 * 1000
  );
  // How long a manual Stop click waits for the engine to notice the stop
  // flag and exit on its own before this force-kills it. Same idea as the
  // timeout path's 90s grace period below, just reachable from a user
  // click instead of only from the 25-minute timeout.
  const STOP_GRACE_MS = Number(
    process.env[`${MODULE_KEY.toUpperCase()}_STOP_GRACE_MS`] ||
      (MODULE_KEY === "digitization" ? process.env.DIGITIZATION_STOP_GRACE_MS : null) ||
      60 * 1000
  );

  fs.mkdirSync(DATA_DIR, { recursive: true });


  /* -------------------------------------------------------------------------
     Self-healing schema. Existing installations keep their data; missing
     columns/tables are added so both SAM Data modules can share this router.
  ------------------------------------------------------------------------- */
  const LIVE_SCHEMA_COLUMNS = [
    ["source_key", "TEXT UNIQUE"], ["source", "TEXT"], ["profile_key", "TEXT"],
    ["company_name", "TEXT"], ["legal_company_name", "TEXT"],
    ["tender_title", "TEXT"], ["notice_id", "TEXT"], ["solicitation_number", "TEXT"], ["notice_type", "TEXT"],
    ["status", "TEXT"], ["agency", "TEXT"], ["subagency", "TEXT"], ["contracting_office", "TEXT"],
    ["posted_date", "TEXT"], ["response_deadline", "TEXT"], ["estimated_value", "TEXT"], ["currency", "TEXT"],
    ["domain", "TEXT"], ["subdomain", "TEXT"], ["relevance_score", "INTEGER"], ["description", "TEXT"],
    ["scope_summary", "TEXT"], ["location", "TEXT"], ["set_aside_type", "TEXT"], ["naics_code", "TEXT"],
    ["psc_code", "TEXT"], ["eligibility", "TEXT"], ["eligibility_score", "INTEGER"], ["turnover_requirement", "TEXT"],
    ["startup_sme_friendly", "TEXT"], ["certification_compatibility", "TEXT"], ["international_eligibility", "TEXT"],
    ["key_disqualifiers", "TEXT"], ["contracting_officer_contact", "TEXT"], ["buyer_contact_email", "TEXT"],
    ["buyer_contact_name", "TEXT"], ["relevant_company_or_buyer_linkedin", "TEXT"], ["relevance_reason", "TEXT"],
    ["sam_url", "TEXT"], ["tender_document_url", "TEXT"], ["all_document_urls", "TEXT"], ["source_platform", "TEXT"],
    ["verification_status", "TEXT"], ["selected_for_proposal", "BOOLEAN DEFAULT FALSE"], ["proposal_status", "TEXT DEFAULT 'pending'"],
    ["raw_data", "JSONB DEFAULT '{}'::jsonb"], ["source_workbook", "TEXT"], ["source_sheet", "TEXT"],
    ["source_updated_at", "TIMESTAMP"], ["created_at", "TIMESTAMP DEFAULT NOW()"], ["updated_at", "TIMESTAMP DEFAULT NOW()"],
  ];
  const SUB_SCHEMA_COLUMNS = [
    ["source_key", "TEXT UNIQUE"], ["source", "TEXT"], ["profile_key", "TEXT"], ["contract_title", "TEXT"],
    ["award_number", "TEXT"], ["notice_id", "TEXT"], ["prime_contractor", "TEXT"], ["legal_company_name", "TEXT"],
    ["company_name", "TEXT"], ["company_type", "TEXT"], ["company_status", "TEXT"], ["parent_company", "TEXT"],
    ["agency", "TEXT"], ["subagency", "TEXT"], ["contracting_office", "TEXT"], ["award_date", "TEXT"],
    ["contract_start_date", "TEXT"], ["contract_end_date", "TEXT"], ["period_of_performance", "TEXT"], ["award_value", "TEXT"],
    ["total_contract_value", "TEXT"], ["currency", "TEXT"], ["domain", "TEXT"], ["subdomain", "TEXT"],
    ["relevance_score", "INTEGER"], ["description", "TEXT"], ["subcontracting_scope_relevance", "TEXT"],
    ["contract_status", "TEXT"], ["country", "TEXT"], ["official_website", "TEXT"], ["company_linkedin", "TEXT"],
    ["general_phone", "TEXT"], ["company_emails", "TEXT"], ["procurement_emails", "TEXT"], ["executive_names_and_roles", "TEXT"],
    ["executive_emails", "TEXT"], ["executive_linkedins", "TEXT"], ["procurement_url", "TEXT"], ["supplier_url", "TEXT"],
    ["subcontracting_url", "TEXT"], ["teaming_url", "TEXT"], ["partnership_url", "TEXT"], ["government_contractor", "TEXT"],
    ["federal_contracting_relevance", "TEXT"], ["company_description", "TEXT"], ["headquarters", "TEXT"], ["city", "TEXT"],
    ["state", "TEXT"], ["outreach_priority", "TEXT"], ["qualified_lead", "TEXT"], ["total_awarded_contracts", "TEXT"],
    ["total_award_value", "TEXT"], ["latest_award_date", "TEXT"], ["earliest_award_date", "TEXT"], ["agencies_awarded", "TEXT"],
    ["naics_codes", "TEXT"], ["psc_codes", "TEXT"], ["subcontracting_potential", "TEXT"], ["why_contact_this_company", "TEXT"],
    ["sam_url", "TEXT"], ["tender_document_url", "TEXT"], ["verification_evidence", "TEXT"],
    ["source_platform", "TEXT"], ["uei", "TEXT"], ["cage_code", "TEXT"], ["usaspending_award_url", "TEXT"],
    ["supplier_vendor_url", "TEXT"], ["partner_teaming_url", "TEXT"],
    ["selected_for_proposal", "BOOLEAN DEFAULT FALSE"], ["proposal_status", "TEXT DEFAULT 'pending'"], ["raw_data", "JSONB DEFAULT '{}'::jsonb"],
    ["source_workbook", "TEXT"], ["source_sheet", "TEXT"], ["source_updated_at", "TIMESTAMP"], ["created_at", "TIMESTAMP DEFAULT NOW()"], ["updated_at", "TIMESTAMP DEFAULT NOW()"],
  ];

  async function ensureTableSchema(table, columns, extra = "") {
    const defs = columns.map(([name, type]) => `${name} ${type}`).join(", ");
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (${defs}${extra ? ", " + extra : ""})`);
    for (const [name, type] of columns) {
      // UNIQUE is handled by the CREATE statement / index below; ALTER with a
      // unique constraint can be problematic on already-populated tables.
      if (name === "source_key") continue;
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    }
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_source_key_uidx ON ${table}(source_key)`);
  }

  /* -------------------------------------------------------------------------
     Self-healing primary key. LIVE_SCHEMA_COLUMNS / SUB_SCHEMA_COLUMNS never
     declared an `id` column, so on any install where this table was created
     by THIS code (not by an older hand-written migration) every row's `id`
     comes back as undefined. That breaks selection in the UI: since every
     broken row shares the same `undefined`, checking one appears to check
     them all. This adds a real BIGSERIAL primary key after the fact, backfilling
     existing rows in their current (relevance_score, created_at) order so
     ids stay stable across future selects/detail views. Safe to run on every
     boot — it checks for the column first and does nothing once it exists.
  ------------------------------------------------------------------------- */
  async function ensureIdColumn(table) {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'id'`,
      [table]
    );
    if (rows.length) return; // already has a real id column — nothing to do

    // Both SAM Data module instances (software + digitization) call this for
    // the same four physical tables at boot, so a second instance can land
    // here microseconds after the first. Treat "someone else already fixed
    // it" as success rather than a fatal boot error.
    try {
      console.log(`[${LOG_LABEL}] ${table} has no id column — adding one now (existing rows will be backfilled).`);
      const seq = `${table}_id_seq`;
      await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${seq}`);
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS id BIGINT`);
      // Backfill in a stable, deterministic order so existing "View" links /
      // any id a user may have already noted stay meaningful after this runs.
      await pool.query(
        `UPDATE ${table} t SET id = s.rn
         FROM (SELECT source_key, ROW_NUMBER() OVER (ORDER BY created_at, source_key) AS rn FROM ${table}) s
         WHERE t.source_key = s.source_key AND t.id IS NULL`
      );
      await pool.query(`SELECT setval('${seq}', GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`);
      await pool.query(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${seq}')`);
      await pool.query(`ALTER TABLE ${table} ALTER COLUMN id SET NOT NULL`);
      await pool.query(`ALTER SEQUENCE ${seq} OWNED BY ${table}.id`);
      await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_pkey PRIMARY KEY (id)`);
      console.log(`[${LOG_LABEL}] ${table}: id column added and backfilled.`);
    } catch (err) {
      // 42701 duplicate_column, 42710 duplicate_object, 42P16 invalid_table_definition
      // (already has a primary key), 23505 unique_violation (a concurrent
      // CREATE ... IF NOT EXISTS raced on the catalog) — all mean the other
      // module instance won the race. The advisory lock in ensureModuleSchema
      // should prevent this already; this catch is a defensive fallback.
      if (["42701", "42710", "42P16", "23505"].includes(err.code)) {
        console.log(`[${LOG_LABEL}] ${table}: id column already added by a concurrent boot — continuing.`);
        return;
      }
      throw err;
    }
  }

  async function ensureModuleSchema() {
    if ((process.env.DB_DIALECT || "mysql").toLowerCase() === "mysql") {
      // The main digitization tables come from scanning_MYSQL_FULLY_FIXED.sql.
      // The software module uses the same schema but has its own table names,
      // so create those four missing runtime tables in MySQL-compatible syntax.
      const mysqlType = (type) => {
        let t = String(type);
        t = t.replace(/JSONB/gi, "JSON").replace(/TIMESTAMPTZ/gi, "TIMESTAMP").replace(/NOW\(\)/gi, "CURRENT_TIMESTAMP");
        t = t.replace(/BIGSERIAL/gi, "BIGINT AUTO_INCREMENT");
        t = t.replace(/\bBOOLEAN\b/gi, "TINYINT(1)");
        if (/^TEXT\s+UNIQUE$/i.test(t)) t = "VARCHAR(512) UNIQUE";
        // MySQL does not allow DEFAULT values on TEXT/BLOB columns.
        // Keep PostgreSQL-style TEXT columns that have defaults as VARCHAR.
        if (/^TEXT\s+DEFAULT\b/i.test(t)) {
          t = t.replace(/^TEXT\b/i, "VARCHAR(255)");
        }
        // MySQL JSON defaults are version-dependent; omit the JSON default
        // so table creation works across supported MySQL 8.x installations.
        if (/^JSON\b/i.test(t) && /\bDEFAULT\b/i.test(t)) {
          t = t.replace(/\s+DEFAULT\s+.+$/i, "");
        }
        return t;
      };
      const createTenderTable = async (table, columns) => {
        const defs = columns.map(([name, type]) => `\`${name}\` ${mysqlType(type)}`).join(", ");
        await pool.query(`CREATE TABLE IF NOT EXISTS \`${table}\` (id BIGINT AUTO_INCREMENT PRIMARY KEY, ${defs})`);
      };
      await createTenderTable("digitization_tenders_live", LIVE_SCHEMA_COLUMNS);
      await createTenderTable("digitization_tenders_subcontracting", SUB_SCHEMA_COLUMNS);
      await createTenderTable("software_tenders_live", LIVE_SCHEMA_COLUMNS);
      await createTenderTable("software_tenders_subcontracting", SUB_SCHEMA_COLUMNS);
      await pool.query(`CREATE TABLE IF NOT EXISTS \`${SCAN_TABLE}\` (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, profile_key TEXT, source TEXT, status TEXT,
        triggered_by TEXT, output_file TEXT, live_count INT DEFAULT 0,
        subcontracting_count INT DEFAULT 0, error_message TEXT, log_tail TEXT,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMP NULL
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS digitization_eligibility_profiles (
        profile_key VARCHAR(255) PRIMARY KEY, company_name TEXT NOT NULL, certifications JSON, core_services JSON,
        search_queries JSON, relevant_naics JSON, relevant_psc JSON, exclusion_keywords JSON,
        certification_rules JSON, is_sme TINYINT(1) DEFAULT 1, hard_disqualifier_rules JSON,
        default_eligibility VARCHAR(255) DEFAULT 'HIGH', default_score INT DEFAULT 90, default_international_note TEXT,
        is_default TINYINT(1) DEFAULT 0, created_by TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      return;
    }
    // This function runs once per module instance (software AND digitization
    // each call it at boot), against the same four physical tables. Plain
    // "IF NOT EXISTS" DDL isn't safe under that concurrency — both instances
    // can check "does this sequence exist?" in the same instant, both see
    // "no", and both try to create it, which is exactly the
    // pg_class_relname_nsp_index duplicate-key error seen in production.
    // A session-scoped advisory lock makes the two instances take turns:
    // whichever gets here first runs the full migration; the second one
    // waits, then finds everything already in place and returns immediately.
    const lockClient = await pool.connect();
    try {
      await lockClient.query("SELECT pg_advisory_lock(hashtext('orbitavanya_sam_data_schema'))");

      // Ensure BOTH modules' tables exist regardless of which module instance boots
      // first / is mounted at all -- syncWorkbookForProfile can write a single scan's
      // rows into either pair (split by category), so both must always exist.
      await ensureTableSchema("digitization_tenders_live", LIVE_SCHEMA_COLUMNS);
      await ensureTableSchema("digitization_tenders_subcontracting", SUB_SCHEMA_COLUMNS);
      await ensureTableSchema("software_tenders_live", LIVE_SCHEMA_COLUMNS);
      await ensureTableSchema("software_tenders_subcontracting", SUB_SCHEMA_COLUMNS);
      await ensureTableSchema(LIVE_TABLE, LIVE_SCHEMA_COLUMNS);
      await ensureTableSchema(SUB_TABLE, SUB_SCHEMA_COLUMNS);
      // Backfills a real primary key on any of these four tables that's
      // missing one (see ensureIdColumn above for why that happens).
      await ensureIdColumn("digitization_tenders_live");
      await ensureIdColumn("digitization_tenders_subcontracting");
      await ensureIdColumn("software_tenders_live");
      await ensureIdColumn("software_tenders_subcontracting");
      await pool.query(`CREATE TABLE IF NOT EXISTS ${SCAN_TABLE} (
        id BIGSERIAL PRIMARY KEY, profile_key TEXT, source TEXT, status TEXT,
        triggered_by TEXT, output_file TEXT, live_count INTEGER DEFAULT 0,
        subcontracting_count INTEGER DEFAULT 0, error_message TEXT, log_tail TEXT,
        started_at TIMESTAMP DEFAULT NOW(), finished_at TIMESTAMP
      )`);
      for (const [name, type] of [
        ["profile_key", "TEXT"], ["source", "TEXT"], ["status", "TEXT"], ["triggered_by", "TEXT"],
        ["output_file", "TEXT"], ["live_count", "INTEGER DEFAULT 0"], ["subcontracting_count", "INTEGER DEFAULT 0"],
        ["error_message", "TEXT"], ["log_tail", "TEXT"], ["started_at", "TIMESTAMP DEFAULT NOW()"], ["finished_at", "TIMESTAMP"],
      ]) await pool.query(`ALTER TABLE ${SCAN_TABLE} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
      await pool.query(`CREATE TABLE IF NOT EXISTS digitization_eligibility_profiles (
        profile_key TEXT PRIMARY KEY, company_name TEXT NOT NULL, certifications JSONB DEFAULT '[]', core_services JSONB DEFAULT '[]',
      search_queries JSONB DEFAULT '[]', relevant_naics JSONB DEFAULT '[]', relevant_psc JSONB DEFAULT '[]', exclusion_keywords JSONB DEFAULT '[]',
      certification_rules JSONB DEFAULT '{}', is_sme BOOLEAN DEFAULT TRUE, hard_disqualifier_rules JSONB DEFAULT '[]',
      default_eligibility TEXT DEFAULT 'HIGH', default_score INTEGER DEFAULT 90, default_international_note TEXT,
      is_default BOOLEAN DEFAULT FALSE, created_by TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    )`);
    } finally {
      // Always release, even if a migration step threw — otherwise the lock
      // stays held for the lifetime of this pooled connection and the other
      // module instance (or the next boot) hangs waiting for it forever.
      try {
        await lockClient.query("SELECT pg_advisory_unlock(hashtext('orbitavanya_sam_data_schema'))");
      } catch (unlockErr) {
        console.error(`[${LOG_LABEL}] failed to release schema migration lock:`, unlockErr.message);
      }
      lockClient.release();
    }
  }

  const schemaReady = ensureModuleSchema();
  router.use(async (_req, res, next) => {
    try { await schemaReady; next(); }
    catch (err) { console.error(`[${LOG_LABEL}] schema initialization failed`, err); res.status(500).json({ message: "SAM Data database schema initialization failed.", error: err.message }); }
  });

  /* =========================================================================
     SOURCE REGISTRY — one entry per engine/platform
  ========================================================================= */

  // Canonical DB column -> SAM.gov Excel header
  const SAM_LIVE_MAP = {
    company_name: "COMPANY_NAME", legal_company_name: "LEGAL_COMPANY_NAME",
    tender_title: "TENDER_TITLE", notice_id: "NOTICE_ID", solicitation_number: "SOLICITATION_NUMBER",
    notice_type: "NOTICE_TYPE", status: "STATUS", agency: "AGENCY", subagency: "SUBAGENCY",
    contracting_office: "CONTRACTING_OFFICE", posted_date: "POSTED_DATE", response_deadline: "RESPONSE_DEADLINE",
    estimated_value: "ESTIMATED_VALUE", currency: "CURRENCY", domain: "DOMAIN", subdomain: "SUBDOMAIN",
    relevance_score: "RELEVANCE_SCORE", description: "DESCRIPTION", scope_summary: "SCOPE_SUMMARY",
    location: "LOCATION", set_aside_type: "SET_ASIDE_TYPE", naics_code: "NAICS_CODE", psc_code: "PSC_CODE",
    eligibility: "ORBIT_ELIGIBILITY", eligibility_score: "ORBIT_SCORE", turnover_requirement: "TURNOVER_REQUIREMENT",
    startup_sme_friendly: "STARTUP_SME_FRIENDLY", certification_compatibility: "CERTIFICATION_COMPATIBILITY",
    international_eligibility: "INTERNATIONAL_ELIGIBILITY", key_disqualifiers: "KEY_DISQUALIFIERS",
    contracting_officer_contact: "CONTRACTING_OFFICER_CONTACT", sam_url: "SAM_URL",
    tender_document_url: "TENDER_DOCUMENT_URL", all_document_urls: "ALL_DOCUMENT_URLS",
    source_platform: "SOURCE_PLATFORM", verification_status: "VERIFICATION_STATUS",
  };
  const SAM_SUB_MAP = {
    contract_title: "CONTRACT_TITLE", award_number: "AWARD_NUMBER", notice_id: "NOTICE_ID",
    prime_contractor: "PRIME_CONTRACTOR", legal_company_name: "LEGAL_COMPANY_NAME", uei: "UEI",
    cage_code: "CAGE_CODE", agency: "AGENCY", subagency: "SUBAGENCY", contracting_office: "CONTRACTING_OFFICE",
    award_date: "AWARD_DATE", contract_start_date: "CONTRACT_START_DATE", contract_end_date: "CONTRACT_END_DATE",
    period_of_performance: "PERIOD_OF_PERFORMANCE", award_value: "AWARD_VALUE",
    total_contract_value: "TOTAL_CONTRACT_VALUE", currency: "CURRENCY", domain: "DOMAIN", subdomain: "SUBDOMAIN",
    relevance_score: "RELEVANCE_SCORE", description: "DESCRIPTION",
    subcontracting_scope_relevance: "SUBCONTRACTING_SCOPE_RELEVANCE", official_website: "VERIFIED_OFFICIAL_WEBSITE",
    company_linkedin: "COMPANY_LINKEDIN", company_emails: "COMPANY_EMAILS",
    executive_names_and_roles: "EXECUTIVE_NAMES_AND_ROLES", executive_emails: "EXECUTIVE_EMAILS",
    executive_linkedins: "EXECUTIVE_LINKEDINS", procurement_url: "PROCUREMENT_URL",
    subcontracting_url: "SUBCONTRACTING_URL", supplier_vendor_url: "SUPPLIER_VENDOR_URL",
    partner_teaming_url: "PARTNER_TEAMING_URL", sam_url: "SAM_URL",
    usaspending_award_url: "USASPENDING_AWARD_URL", tender_document_url: "TENDER_DOCUMENT_URL",
    source_platform: "SOURCE_PLATFORM", verification_evidence: "VERIFICATION_EVIDENCE",
  };

  // Canonical DB column -> TED / UK Excel header (both engines share this exact schema —
  // the UK engine was derived from the TED one).
  const EU_LIVE_MAP = {
    company_name: "AWARDED_COMPANY", legal_company_name: "AWARDED_COMPANY",
    tender_title: "TENDER_TITLE", notice_id: "TENDER_ID / NOTICE_ID", status: "TENDER_STATUS",
    agency: "CONTRACTING_AUTHORITY", posted_date: "PUBLISHED_DATE", response_deadline: "DEADLINE",
    estimated_value: "TENDER_VALUE / QUOTATION", currency: "CURRENCY", domain: "DOMAIN", subdomain: "SUBDOMAIN",
    description: "DESCRIPTION", scope_summary: "RELEVANCE_REASON", location: "TENDER_COUNTRY",
    psc_code: "CPV_CODES", eligibility: "ORBITAVANYA_ELIGIBILITY",
    buyer_contact_email: "BUYER_CONTACT_EMAILS", buyer_contact_name: "BUYER_CONTACT_NAME",
    relevant_company_or_buyer_linkedin: "RELEVANT_COMPANY / BUYER_LINKEDIN",
    relevance_reason: "RELEVANCE_REASON", turnover_requirement: "TURNOVER_REQUIREMENT",
    startup_sme_friendly: "SME / STARTUP FRIENDLY", certification_compatibility: "REQUIRED_CERTIFICATIONS",
    international_eligibility: "GLOBAL_PARTICIPATION", key_disqualifiers: "ELIGIBILITY_SUMMARY",
    contracting_officer_contact: "BUYER_CONTACT_NAME", sam_url: "TED_URL",
    tender_document_url: "TENDER_DOCUMENTS_URL", source_platform: "PLATFORM / SOURCE",
  };
  const EU_SUB_MAP = {
    contract_title: "TENDER_TITLE", notice_id: "TENDER_ID / NOTICE_ID", prime_contractor: "AWARDED_COMPANY",
    legal_company_name: "AWARDED_COMPANY", agency: "CONTRACTING_AUTHORITY", award_date: "AWARD_DATE",
    contract_start_date: "CONTRACT_START", contract_end_date: "CONTRACT_END", award_value: "CONTRACT_VALUE / QUOTATION",
    currency: "CURRENCY", domain: "DOMAIN", subdomain: "SUBDOMAIN", description: "DESCRIPTION",
    contract_status: "CONTRACT_STATUS", country: "COUNTRY",
    subcontracting_scope_relevance: "LIKELY_SUBCONTRACTABLE_WORK",
    subcontracting_potential: "SUBCONTRACTING POTENTIAL", why_contact_this_company: "WHY CONTACT THIS COMPANY",
    official_website: "COMPANY_WEBSITE",
    company_linkedin: "COMPANY_LINKEDIN", company_emails: "ALL_COMPANY_EMAILS",
    executive_names_and_roles: "ALL_EXECUTIVE_NAMES & ROLES", executive_emails: "ALL_EXECUTIVE_EMAILS",
    executive_linkedins: "ALL_EXECUTIVE_LINKEDINS", procurement_url: "PROCUREMENT / CONTRACTS URL",
    subcontracting_url: "SUBCONTRACTING / PARTNER URL", sam_url: "TED / OFFICIAL TENDER URL",
    tender_document_url: "TENDER DOCUMENTS URL", source_platform: "PLATFORM / SOURCE",
    verification_evidence: "WHY CONTACT THIS COMPANY",
  };

  const SOURCES = {
    sam: {
      key: "sam", label: "SAM.gov (US)", engine: "sam_digitization_engine.py",
      liveMap: SAM_LIVE_MAP, subMap: SAM_SUB_MAP,
      liveTitleCol: "TENDER_TITLE", liveIdCols: ["NOTICE_ID", "SOLICITATION_NUMBER"],
      subTitleCol: "CONTRACT_TITLE", subIdCols: ["NOTICE_ID", "AWARD_NUMBER"],
    },
    ted: {
      key: "ted", label: "TED (European Union)", engine: "ted_it_procurement_intelligence.py",
      liveMap: EU_LIVE_MAP, subMap: EU_SUB_MAP,
      liveTitleCol: "TENDER_TITLE", liveIdCols: ["TENDER_ID / NOTICE_ID"],
      subTitleCol: "TENDER_TITLE", subIdCols: ["TENDER_ID / NOTICE_ID"],
    },
    uk: {
      key: "uk", label: "UK (Contracts Finder / Find a Tender)", engine: "uk_tender_intelligence.py",
      liveMap: EU_LIVE_MAP, subMap: EU_SUB_MAP,
      liveTitleCol: "TENDER_TITLE", liveIdCols: ["TENDER_ID / NOTICE_ID"],
      subTitleCol: "TENDER_TITLE", subIdCols: ["TENDER_ID / NOTICE_ID"],
    },
  };
  const SOURCE_KEYS = Object.keys(SOURCES);

  // In-memory registry of currently-running scans, keyed by "source:profile_key".
  const activeScans = new Map();

  function managerGuard(req, res, next) {
    Promise.resolve(requireAuthenticatedUser(req, res))
      .then((user) => {
        if (!user) return;
        if (!isContractManager(user.role)) {
          return res.status(403).json({ message: "Staff access required." });
        }
        req.digitizationActor = user;
        next();
      })
      .catch((err) => {
        console.error(`[${LOG_LABEL} AUTH]`, err);
        res.status(500).json({ message: "Authentication check failed.", error: err.message });
      });
  }

  function clean(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim();
  }

  function slugify(value) {
    return (
      clean(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || crypto.randomBytes(4).toString("hex")
    );
  }

  function compactRow(row) {
    const out = {};
    for (const [key, value] of Object.entries(row || {})) {
      if (value === undefined || value === null || String(value).trim() === "") continue;
      out[String(key).toUpperCase()] = value;
    }
    return out;
  }

  function requireSource(value) {
    const s = clean(value).toLowerCase();
    return SOURCE_KEYS.includes(s) ? s : null;
  }

  /* =========================================================================
     ELIGIBILITY PROFILES (CRUD) — unchanged shape, shared across all 3 sources
  ========================================================================= */

  const PROFILE_JSON_FIELDS = [
    "certifications", "core_services", "search_queries", "relevant_naics",
    "relevant_psc", "exclusion_keywords", "certification_rules", "hard_disqualifier_rules",
  ];

  function rowToProfile(row) {
    const out = { ...row };
    for (const f of PROFILE_JSON_FIELDS) {
      if (typeof out[f] === "string") {
        try { out[f] = JSON.parse(out[f]); } catch { /* leave as-is */ }
      }
    }
    return out;
  }

  router.get("/sources", managerGuard, (_req, res) => {
    res.json({ sources: SOURCE_KEYS.map((k) => ({ key: k, label: SOURCES[k].label })) });
  });

  router.get("/profiles", managerGuard, async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM digitization_eligibility_profiles ORDER BY is_default DESC, company_name ASC`
      );
      res.json({ profiles: rows.map(rowToProfile) });
    } catch (err) {
      console.error(`[${LOG_LABEL}] list profiles`, err);
      res.status(500).json({ message: "Failed to load eligibility profiles.", error: err.message });
    }
  });

  router.post("/profiles", managerGuard, async (req, res) => {
    const b = req.body || {};
    if (!clean(b.company_name)) {
      return res.status(400).json({ message: "company_name is required." });
    }
    const profileKey = clean(b.profile_key) || slugify(b.company_name);

    try {
      const { rows } = await pool.query(
        `INSERT INTO digitization_eligibility_profiles (
          profile_key, company_name, certifications, core_services, search_queries,
          relevant_naics, relevant_psc, exclusion_keywords, certification_rules,
          is_sme, hard_disqualifier_rules, default_eligibility, default_score,
          default_international_note, created_by, updated_at
        ) VALUES (
          $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,
          $10,$11::jsonb,$12,$13,$14,$15,NOW()
        )
        ON CONFLICT (profile_key) DO UPDATE SET
          company_name = EXCLUDED.company_name,
          certifications = EXCLUDED.certifications,
          core_services = EXCLUDED.core_services,
          search_queries = EXCLUDED.search_queries,
          relevant_naics = EXCLUDED.relevant_naics,
          relevant_psc = EXCLUDED.relevant_psc,
          exclusion_keywords = EXCLUDED.exclusion_keywords,
          certification_rules = EXCLUDED.certification_rules,
          is_sme = EXCLUDED.is_sme,
          hard_disqualifier_rules = EXCLUDED.hard_disqualifier_rules,
          default_eligibility = EXCLUDED.default_eligibility,
          default_score = EXCLUDED.default_score,
          default_international_note = EXCLUDED.default_international_note,
          updated_at = NOW()
        RETURNING *`,
        [
          profileKey,
          clean(b.company_name),
          JSON.stringify(b.certifications || []),
          JSON.stringify(b.core_services || []),
          JSON.stringify(b.search_queries || []),
          JSON.stringify(b.relevant_naics || []),
          JSON.stringify(b.relevant_psc || []),
          JSON.stringify(b.exclusion_keywords || []),
          JSON.stringify(b.certification_rules || {}),
          b.is_sme !== false,
          JSON.stringify(b.hard_disqualifier_rules || []),
          clean(b.default_eligibility) || "HIGH",
          Number.isFinite(b.default_score) ? b.default_score : 90,
          clean(b.default_international_note) || null,
          req.digitizationActor?.email || req.digitizationActor?.id || null,
        ]
      );
      res.json({ profile: rowToProfile(rows[0]) });
    } catch (err) {
      console.error(`[${LOG_LABEL}] save profile`, err);
      res.status(500).json({ message: "Failed to save eligibility profile.", error: err.message });
    }
  });

  router.patch("/profiles/:key/default", managerGuard, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE digitization_eligibility_profiles SET is_default = FALSE WHERE is_default`);
      const { rows } = await client.query(
        `UPDATE digitization_eligibility_profiles SET is_default = TRUE, updated_at = NOW()
         WHERE profile_key = $1 RETURNING *`,
        [req.params.key]
      );
      if (!rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Profile not found." });
      }
      await client.query("COMMIT");
      res.json({ profile: rowToProfile(rows[0]) });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[${LOG_LABEL}] set default profile`, err);
      res.status(500).json({ message: "Failed to set default profile.", error: err.message });
    } finally {
      client.release();
    }
  });

  router.delete("/profiles/:key", managerGuard, async (req, res) => {
    if (req.params.key === "orbitavanya") {
      return res.status(400).json({ message: "The default OrbitAvanya profile cannot be deleted." });
    }
    try {
      await pool.query(`DELETE FROM digitization_eligibility_profiles WHERE profile_key = $1`, [req.params.key]);
      res.json({ message: "Profile deleted." });
    } catch (err) {
      console.error(`[${LOG_LABEL}] delete profile`, err);
      res.status(500).json({ message: "Failed to delete profile.", error: err.message });
    }
  });

  /* =========================================================================
     SCAN TRIGGER + STATUS  ("Run Scan" button — single source or all 3)
  ========================================================================= */

  async function getProfile(profileKey) {
    const { rows } = await pool.query(
      `SELECT * FROM digitization_eligibility_profiles WHERE profile_key = $1`,
      [profileKey]
    );
    return rows[0] ? rowToProfile(rows[0]) : null;
  }

  function runEngine(sourceDef, profile, outputPath, stopFlagPath, onChild) {
    return new Promise((resolve, reject) => {
      const enginePath = path.join(SCRIPTS_DIR, sourceDef.engine);
      const tag = `${LOG_LABEL}:${sourceDef.key.toUpperCase()}`;
      if (!fs.existsSync(enginePath)) {
        const err = new Error(`Engine script not found at ${enginePath}`);
        console.error(`[${tag}] scan failed — ${err.message}`);
        return reject(err);
      }
      const profileJsonPath = path.join(
        DATA_DIR,
        `.profile-${sourceDef.key}-${profile.profile_key}-${Date.now()}.json`
      );
      fs.writeFileSync(profileJsonPath, JSON.stringify(profile, null, 2));

      // Make sure no stale flag file from a previous run is already sitting there.
      try { fs.unlinkSync(stopFlagPath); } catch {}

      console.log(`[${tag}] starting scan — engine=${sourceDef.engine}, profile='${profile.profile_key}'`);

      const child = spawn(
        PYTHON_COMMAND.command,
        // "-u" = unbuffered stdout/stderr. Piped (non-TTY) Python defaults to
        // block-buffering, so without this every print() would sit in an
        // internal buffer and only reach Node in one lump at the end — the
        // live [DIGITIZATION:SAM]-style lines below would print instantly,
        // but the engine's OWN "[*] Searching SAM.gov..." lines wouldn't show
        // up until the scan finished. The env var is a second safety net for
        // the same thing (covers a python.exe that ignores CLI flags).
        [...PYTHON_COMMAND.args, "-u", enginePath, "--profile-json", profileJsonPath, "--output", outputPath, "--stop-flag", stopFlagPath],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: "1" } }
      );
      // Handed to the caller synchronously (Promise executors run
      // synchronously, so this fires before runEngine() even returns) so
      // requestStop() below can force-kill this exact process if it doesn't
      // respond to the stop flag in time.
      if (typeof onChild === "function") onChild(child);

      let logTail = "";
      const appendLog = (chunk) => {
        logTail = (logTail + chunk.toString()).slice(-8000);
      };
      // Echo the engine's own progress lines to this process's console in
      // real time (not just after the fact) so "what is it doing right now"
      // is visible while a scan is running, not only once it finishes.
      // Line-buffered so a chunk split mid-line doesn't print a half line.
      function makeLiveEcho(streamTag) {
        let carry = "";
        return (chunk) => {
          carry += chunk.toString();
          const lines = carry.split(/\r?\n/);
          carry = lines.pop() || "";
          for (const line of lines) {
            if (line.trim()) console.log(`[${streamTag}] ${line}`);
          }
        };
      }
      const echoStdout = makeLiveEcho(tag);
      const echoStderr = makeLiveEcho(`${tag}:stderr`);
      child.stdout.on("data", (chunk) => { appendLog(chunk); echoStdout(chunk); });
      child.stderr.on("data", (chunk) => { appendLog(chunk); echoStderr(chunk); });

      // On timeout, try the SAME graceful stop as a manual Stop click first --
      // write the flag file and give the engine a grace period to notice it,
      // finish its current record, and save. Only SIGKILL (which throws away
      // everything, since the engine never reaches its Excel-writing code) if it
      // doesn't exit within the grace period. The normal "close" handler below
      // still runs either way and resolves/rejects based on what actually happened.
      let hardKilled = false;
      const timer = setTimeout(() => {
        console.error(`[${tag}] scan hit the ${SCAN_TIMEOUT_MS / 1000}s timeout — requesting graceful stop instead of killing outright...`);
        try { fs.writeFileSync(stopFlagPath, String(Date.now())); } catch {}
        const graceTimer = setTimeout(() => {
          if (!child.killed) {
            hardKilled = true;
            console.error(`[${tag}] did not exit within the grace period — force-killing (partial results NOT guaranteed for this run).`);
            child.kill("SIGKILL");
          }
        }, 90_000);
        child.once("close", () => clearTimeout(graceTimer));
      }, SCAN_TIMEOUT_MS);

      child.on("error", (err) => {
        clearTimeout(timer);
        try { fs.unlinkSync(profileJsonPath); } catch {}
        try { fs.unlinkSync(stopFlagPath); } catch {}
        console.error(`[${tag}] scan failed to start — ${err.message} (is "${PYTHON_COMMAND.command}" on PATH?)`);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        try { fs.unlinkSync(profileJsonPath); } catch {}
        try { fs.unlinkSync(stopFlagPath); } catch {}
        if (code !== 0) {
          const err = new Error(`Engine exited with code ${code}. Last output:\n${logTail}`);
          console.error(`[${tag}] scan failed — engine exited with code ${code}`);
          return reject(err);
        }
        const match = logTail.match(/SCAN_SUMMARY_JSON::(.+)/);
        if (!match) {
          const err = new Error(`Engine finished but produced no summary. Last output:\n${logTail}`);
          console.error(`[${tag}] scan failed — ${err.message.split("\n")[0]}`);
          return reject(err);
        }
        try {
          const summary = JSON.parse(fs.readFileSync(match[1].trim(), "utf-8"));
          const stoppedNote = summary.stopped_early ? " (stopped early by user — partial results)" : "";
          console.log(
            `[${tag}] scan finished${stoppedNote} — ${summary.live_count ?? 0} live, ${summary.subcontracting_count ?? 0} ` +
            `subcontracting found (raw, before the software/digitization split).`
          );
          resolve({ summary, logTail });
        } catch (err) {
          console.error(`[${tag}] scan failed — could not read scan summary: ${err.message}`);
          reject(new Error(`Could not read scan summary: ${err.message}`));
        }
      });
    });
  }

  async function startScan({ source, profileKey, actor }) {
    const scanKey = `${source}:${profileKey}`;
    const who = actor?.email || actor?.id || "unknown user";
    if (activeScans.has(scanKey)) {
      console.log(`[${LOG_LABEL}] ${who} requested a ${SOURCES[source]?.label || source} scan for '${profileKey}' — already running, ignoring.`);
      return { started: false, already_running: true, run_id: activeScans.get(scanKey).runId };
    }

    const sourceDef = SOURCES[source];
    const profile = await getProfile(profileKey);
    if (!profile) {
      const err = new Error(`Eligibility profile '${profileKey}' not found.`);
      console.error(`[${LOG_LABEL}] ${who} requested a ${sourceDef?.label || source} scan — ${err.message}`);
      throw Object.assign(err, { status: 404 });
    }

    console.log(`[${LOG_LABEL}] ${who} started a ${sourceDef.label} scan for profile '${profileKey}'.`);

    const { rows: runRows } = await pool.query(
      `INSERT INTO ${SCAN_TABLE} (profile_key, source, status, triggered_by)
       VALUES ($1, $2, 'running', $3) RETURNING id`,
      [profileKey, source.toUpperCase(), actor?.email || actor?.id || null]
    );
    const runId = runRows[0].id;
    const outputPath = path.join(DATA_DIR, `${source.toUpperCase()}_${MODULE_KEY.toUpperCase()}_PROSPECTS_${profileKey}.xlsx`);
    const stopFlagPath = path.join(DATA_DIR, `.stop-${source}-${profileKey}-${runId}.flag`);

    let childRef = null;
    const promise = (async () => {
      try {
        const { logTail } = await runEngine(sourceDef, profile, outputPath, stopFlagPath, (child) => {
          childRef = child;
        });
        // splitCounts reflects THIS module's actual share after the digitization/
        // software split -- not the engine's raw total -- so the UI's tile counts
        // and scan-history numbers match what actually landed in this module's table.
        const splitCounts = await syncWorkbookForProfile(source, profileKey, outputPath);
        console.log(`[${LOG_LABEL}] rebuilding master workbook after ${sourceDef.label} scan...`);
        // NOTE: buildDetailedMasterWorkbook (build_master_workbook.py) reads every raw
        // per-source .xlsx directly and now understands TENDER_CATEGORY, so it fully
        // supersedes buildMasterWorkbook's DB-driven output. Both used to write the
        // SAME SAM_DATA_MASTER.xlsx path back-to-back -- this one silently overwrote
        // the other every single run, making the first call pure wasted work.
        await buildDetailedMasterWorkbook(profileKey).catch((e) =>
          console.error(`[${LOG_LABEL}] master workbook rebuild failed`, e)
        );
        await pool.query(
          `UPDATE ${SCAN_TABLE} SET status = 'success', finished_at = NOW(),
           output_file = $2, live_count = $3, subcontracting_count = $4, log_tail = $5
           WHERE id = $1`,
          [runId, outputPath, splitCounts.live_count, splitCounts.subcontracting_count, logTail.slice(-4000)]
        );
        console.log(
          `[${LOG_LABEL}] ${sourceDef.label} scan complete for '${profileKey}' — ` +
          `${splitCounts.live_count} live, ${splitCounts.subcontracting_count} subcontracting stored in this module.`
        );

        // Mirror a lightweight history entry into the sibling module's scan_runs
        // table too, since one scan now populates both modules' tender tables --
        // without this, running from Scanning & Digitization would leave the
        // Software / Application scan-history tab looking like it never ran.
        try {
          const siblingScanTable = MODULE_KEY === "software" ? "digitization_scan_runs" : "software_scan_runs";
          await pool.query(
            `INSERT INTO ${siblingScanTable} (profile_key, source, status, triggered_by, output_file, live_count, subcontracting_count, started_at, finished_at)
             VALUES ($1, $2, 'success', $3, $4, $5, $6, NOW(), NOW())`,
            [profileKey, source.toUpperCase(), actor?.email || actor?.id || null, outputPath, splitCounts.other_live_count, splitCounts.other_subcontracting_count]
          );
        } catch (mirrorErr) {
          console.error(`[${LOG_LABEL}] sibling scan-history mirror failed (non-fatal)`, mirrorErr);
        }
      } catch (err) {
        console.error(`[${LOG_LABEL}] ${sourceDef.label} scan FAILED for profile '${profileKey}': ${err.message}`);
        await pool.query(
          `UPDATE ${SCAN_TABLE} SET status = 'failed', finished_at = NOW(), error_message = $2
           WHERE id = $1`,
          [runId, String(err.message || err).slice(0, 2000)]
        );
        throw err;
      } finally {
        activeScans.delete(scanKey);
      }
    })();

    activeScans.set(scanKey, { runId, promise, stopFlagPath, getChild: () => childRef });
    promise.catch(() => {}); // status is polled via the DB row, not an unhandled rejection

    return { started: true, run_id: runId };
  }

  // Writing the flag file IS the stop signal -- the engine notices it on its next
  // loop check and winds down gracefully, still saving whatever it collected. This
  // does not kill any process, so it's safe even mid-request to a slow external API.
  // If the engine doesn't respond within STOP_GRACE_MS (its poll interval is longer
  // than expected, or it's stuck on a slow network call), this force-kills it so a
  // manual Stop click is never left waiting indefinitely -- same trade-off the
  // 25-minute timeout path above already makes: try to save everything first, but
  // guarantee this ends within a bounded time either way.
  function requestStop(source, profileKey) {
    const scanKey = `${source}:${profileKey}`;
    const active = activeScans.get(scanKey);
    if (!active) return false;
    try {
      fs.writeFileSync(active.stopFlagPath, String(Date.now()));
      console.log(
        `[${LOG_LABEL}] stop requested for ${source.toUpperCase()} scan (run #${active.runId}, profile '${profileKey}') ` +
        `— waiting up to ${STOP_GRACE_MS / 1000}s for it to exit gracefully before forcing it.`
      );
      const graceTimer = setTimeout(() => {
        // Only act if this exact scan is still the one running -- if it
        // already finished (or a new scan started under the same key), do
        // nothing rather than kill an unrelated process.
        if (activeScans.get(scanKey) !== active) return;
        const child = active.getChild?.();
        if (child && !child.killed) {
          console.error(
            `[${LOG_LABEL}] ${source.toUpperCase()} scan (run #${active.runId}) did not exit within ` +
            `${STOP_GRACE_MS / 1000}s of the stop request — force-killing. Only results already written ` +
            `before this point are guaranteed saved.`
          );
          child.kill("SIGKILL");
        }
      }, STOP_GRACE_MS);
      if (typeof graceTimer.unref === "function") graceTimer.unref(); // don't keep the process alive just for this
      return true;
    } catch (err) {
      console.error(`[${LOG_LABEL}] failed to write stop flag for ${source}:${profileKey}`, err);
      return false;
    }
  }

  router.post("/scan", managerGuard, async (req, res) => {
    if (!XLSX) {
      return res.status(500).json({ message: "The 'xlsx' package is not installed in backend/. Run: npm install xlsx" });
    }
    const source = requireSource(req.body?.source);
    if (!source) {
      return res.status(400).json({ message: `source must be one of: ${SOURCE_KEYS.join(", ")}` });
    }
    const profileKey = clean(req.body?.profile_key) || "orbitavanya";
    console.log(`[${LOG_LABEL}] POST /scan — source=${source} profile=${profileKey}`);
    try {
      const result = await startScan({ source, profileKey, actor: req.digitizationActor });
      res.json(result);
    } catch (err) {
      console.error(`[${LOG_LABEL}] POST /scan failed — ${err.message}`);
      res.status(err.status || 500).json({ message: err.message });
    }
  });

  // Kick off SAM.gov + TED + UK together for one profile. Runs in true
  // parallel via Promise.all; returns one run_id per source so the UI can
  // poll all three. If the profile_key doesn't match a row in
  // digitization_eligibility_profiles, every source fails the same way —
  // that 404 is returned verbatim per source instead of a swallowed
  // generic "could not start" so it's obvious what to fix.
  router.post("/scan-all", managerGuard, async (req, res) => {
    if (!XLSX) {
      return res.status(500).json({ message: "The 'xlsx' package is not installed in backend/. Run: npm install xlsx" });
    }
    const profileKey = clean(req.body?.profile_key) || "orbitavanya";
    console.log(`[${LOG_LABEL}] POST /scan-all — profile=${profileKey} (SAM.gov + TED + UK)`);

    const profile = await getProfile(profileKey);
    if (!profile) {
      console.error(`[${LOG_LABEL}] POST /scan-all failed — eligibility profile '${profileKey}' not found`);
      const results = Object.fromEntries(
        SOURCE_KEYS.map((source) => [
          source,
          { started: false, error: `Eligibility profile '${profileKey}' not found. Pick a valid profile from the dropdown.` },
        ])
      );
      return res.json({ results });
    }

    const entries = await Promise.all(
      SOURCE_KEYS.map(async (source) => {
        try {
          return [source, await startScan({ source, profileKey, actor: req.digitizationActor })];
        } catch (err) {
          return [source, { started: false, error: err.message }];
        }
      })
    );
    const startedCount = entries.filter(([, r]) => r.started).length;
    console.log(`[${LOG_LABEL}] POST /scan-all — started ${startedCount}/${entries.length} scans for '${profileKey}'`);
    res.json({ results: Object.fromEntries(entries) });
  });

  // Stop ONE source's currently-running scan. Body: { source, profile_key }.
  // This is a graceful request (flag file), not a kill -- the response returns
  // immediately, but the run itself will keep going for a few more seconds while
  // the engine finishes its current record and writes out the partial results.
  router.post("/scan/stop", managerGuard, async (req, res) => {
    const source = requireSource(req.body?.source);
    if (!source) {
      return res.status(400).json({ message: `source must be one of: ${SOURCE_KEYS.join(", ")}` });
    }
    const profileKey = clean(req.body?.profile_key) || "orbitavanya";
    const stopped = requestStop(source, profileKey);
    res.json({
      stopped,
      message: stopped
        ? `Stop requested — it will finish its current record and save partial results within about ${STOP_GRACE_MS / 1000}s.`
        : `No running ${SOURCES[source]?.label || source} scan found for profile '${profileKey}'.`,
    });
  });

  // Stop ALL currently-running sources for a profile at once. Body: { profile_key }.
  router.post("/scan-all/stop", managerGuard, async (req, res) => {
    const profileKey = clean(req.body?.profile_key) || "orbitavanya";
    const results = Object.fromEntries(
      SOURCE_KEYS.map((source) => [source, requestStop(source, profileKey)])
    );
    const stoppedCount = Object.values(results).filter(Boolean).length;
    console.log(`[${LOG_LABEL}] POST /scan-all/stop — signaled ${stoppedCount}/${SOURCE_KEYS.length} running scans for '${profileKey}'`);
    res.json({
      results,
      message: stoppedCount
        ? `Stop requested for ${stoppedCount} running source(s) — partial results will be saved within about ${STOP_GRACE_MS / 1000}s.`
        : `No running scans found for profile '${profileKey}'.`,
    });
  });

  router.get("/scan/:id", managerGuard, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM ${SCAN_TABLE} WHERE id = $1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ message: "Scan run not found." });
      res.json({ run: rows[0] });
    } catch (err) {
      res.status(500).json({ message: "Failed to load scan status.", error: err.message });
    }
  });

  router.get("/scan", managerGuard, async (req, res) => {
    const { profile_key: profileKey, source } = req.query;
    const clauses = [];
    const params = [];
    if (profileKey) { params.push(profileKey); clauses.push(`profile_key = $${params.length}`); }
    if (source) { params.push(String(source).toUpperCase()); clauses.push(`source = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    try {
      const { rows } = await pool.query(
        `SELECT * FROM ${SCAN_TABLE} ${where} ORDER BY started_at DESC LIMIT 30`,
        params
      );
      res.json({ runs: rows });
    } catch (err) {
      res.status(500).json({ message: "Failed to load scan history.", error: err.message });
    }
  });

  /* =========================================================================
     WORKBOOK -> POSTGRES SYNC (per-source column map, two sheets each)
  ========================================================================= */

  async function upsertRow(client, table, columnMap, sourceKey, source, profileKey, row, workbookBasename, sheetName) {
    const namedCols = ["source_key", "source", "profile_key", ...Object.keys(columnMap)];
    const values = [sourceKey, source.toUpperCase(), profileKey];
    for (const dbCol of Object.keys(columnMap)) {
      const xlsxCol = columnMap[dbCol];
      let val = row[xlsxCol];
      if (dbCol.endsWith("_score") && val !== undefined && val !== "") val = parseInt(val, 10) || null;
      values.push(val === undefined || val === "" ? null : val);
    }
    values.push(JSON.stringify(compactRow(row)), workbookBasename, sheetName);

    const setClauses = Object.keys(columnMap)
      .map((c) => `${c} = EXCLUDED.${c}`)
      .concat([
        "raw_data = EXCLUDED.raw_data",
        "source_workbook = EXCLUDED.source_workbook",
        "source_sheet = EXCLUDED.source_sheet",
        "source_updated_at = NOW()",
        "updated_at = NOW()",
      ])
      .join(",\n        ");

    const valuePlaceholders = namedCols
      .map((_, idx) => `$${idx + 1}`)
      .concat([`$${namedCols.length + 1}::jsonb`, `$${namedCols.length + 2}`, `$${namedCols.length + 3}`, "NOW()", "NOW()"]);

    await client.query(
      `INSERT INTO ${table} (${namedCols.join(", ")}, raw_data, source_workbook, source_sheet, source_updated_at, updated_at)
       VALUES (${valuePlaceholders.join(", ")})
       ON CONFLICT (source_key) DO UPDATE SET
        ${setClauses}`,
      values
    );
  }

  function firstNonEmpty(row, cols) {
    for (const c of cols) {
      const v = row[c];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    }
    return "";
  }

  // Every engine tags each row's DOMAIN (SAM.gov also tags an explicit TENDER_CATEGORY
  // column post-patch). These are the DOMAIN values that mean "this is Software /
  // Application work", not "Scanning & Digitization" work -- for every source. Anything
  // NOT in this set is treated as a digitization-domain row. Keeping this as one shared
  // list (instead of duplicating the split logic per source) means a single scan run
  // populates BOTH modules' tables correctly no matter which module's "Run" button
  // triggered it.
  const SOFTWARE_DOMAIN_VALUES = new Set([
    // SAM.gov (sam_digitization_engine.py, software scope)
    "custom software development", "web & mobile application development",
    "system integration & it modernization", "cloud & saas application development",
    "enterprise application development (erp/crm)", "software maintenance & support",
    "api & middleware development", "related software/it development",
    // TED (ted_it_procurement_intelligence.py)
    "it / ict", "software development", "cloud & infrastructure", "data & analytics",
    "enterprise systems", "digital transformation",
    // UK (uk_tender_intelligence.py)
    "it / ict",
  ]);

  // Fixed destination tables -- deliberately NOT derived from this router instance's
  // own TABLE_PREFIX, because ONE scan (triggered from either module) has to be able to
  // write into BOTH modules' tables at once, split by category.
  const DIGITIZATION_LIVE_TABLE = "digitization_tenders_live";
  const DIGITIZATION_SUB_TABLE = "digitization_tenders_subcontracting";
  const SOFTWARE_LIVE_TABLE = "software_tenders_live";
  const SOFTWARE_SUB_TABLE = "software_tenders_subcontracting";

  function categorizeRow(row) {
    const explicit = clean(row["TENDER_CATEGORY"]).toUpperCase();
    if (explicit === "SOFTWARE") return "software";
    if (explicit === "DIGITIZATION") return "digitization";
    const domainVal = clean(row["DOMAIN"]).toLowerCase();
    return SOFTWARE_DOMAIN_VALUES.has(domainVal) ? "software" : "digitization";
  }

  async function syncWorkbookForProfile(source, profileKey, filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Scan output not found at ${filePath}`);
    }
    const sourceDef = SOURCES[source];
    const wb = XLSX.readFile(filePath, { cellDates: false, raw: false });
    const liveSheet = wb.Sheets["LIVE_TENDERS"];
    const subSheet = wb.Sheets["SUBCONTRACTING_TENDERS"];
    const liveRows = liveSheet ? XLSX.utils.sheet_to_json(liveSheet, { defval: "", raw: false }) : [];
    const subRows = subSheet ? XLSX.utils.sheet_to_json(subSheet, { defval: "", raw: false }) : [];

    let digitizationLiveCount = 0, softwareLiveCount = 0;
    let digitizationSubCount = 0, softwareSubCount = 0;
    let failedRows = 0;
    let firstError = null;

    const client = await pool.connect();
    try {
      // Deliberately NOT one big transaction around every row. A single malformed
      // row (unexpected value shape, a future missing column, etc.) used to abort
      // the ENTIRE batch via ROLLBACK -- discarding every other row this scan found,
      // even when it collected hundreds of good records. Each row now commits on
      // its own; one bad row is skipped and logged, not a whole run's data.
      for (const row of liveRows) {
        const title = clean(row[sourceDef.liveTitleCol]);
        if (!title) continue;
        const idVal = firstNonEmpty(row, sourceDef.liveIdCols) || title;
        const sourceKey = `${source}::${profileKey}::live::${idVal}`;
        const destTable = categorizeRow(row) === "software" ? SOFTWARE_LIVE_TABLE : DIGITIZATION_LIVE_TABLE;
        try {
          await client.query("BEGIN");
          await upsertRow(client, destTable, sourceDef.liveMap, sourceKey, source, profileKey, row, path.basename(filePath), "LIVE_TENDERS");
          await client.query("COMMIT");
          if (destTable === SOFTWARE_LIVE_TABLE) softwareLiveCount++; else digitizationLiveCount++;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          failedRows++;
          firstError = firstError || err;
          console.error(`[${LOG_LABEL}] skipped one LIVE_TENDERS row (${title.slice(0, 60)}) — ${err.message}`);
        }
      }
      for (const row of subRows) {
        const title = clean(row[sourceDef.subTitleCol]);
        if (!title) continue;
        const idVal = firstNonEmpty(row, sourceDef.subIdCols) || title;
        const sourceKey = `${source}::${profileKey}::sub::${idVal}`;
        const destTable = categorizeRow(row) === "software" ? SOFTWARE_SUB_TABLE : DIGITIZATION_SUB_TABLE;
        try {
          await client.query("BEGIN");
          await upsertRow(client, destTable, sourceDef.subMap, sourceKey, source, profileKey, row, path.basename(filePath), "SUBCONTRACTING_TENDERS");
          await client.query("COMMIT");
          if (destTable === SOFTWARE_SUB_TABLE) softwareSubCount++; else digitizationSubCount++;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          failedRows++;
          firstError = firstError || err;
          console.error(`[${LOG_LABEL}] skipped one SUBCONTRACTING_TENDERS row (${title.slice(0, 60)}) — ${err.message}`);
        }
      }
      if (failedRows > 0) {
        console.error(`[${LOG_LABEL}] ${source.toUpperCase()} sync: ${failedRows} row(s) failed to save (first error: ${firstError?.message}). Every other row still saved normally.`);
      }
    } finally {
      client.release();
    }

    console.log(
      `[${LOG_LABEL}] ${source.toUpperCase()} scan split: ` +
      `digitization live=${digitizationLiveCount} sub=${digitizationSubCount}, ` +
      `software live=${softwareLiveCount} sub=${softwareSubCount}`
    );

    // Report counts for the module that actually triggered this run (used for its own
    // scan_runs row / toast), plus the sibling module's counts (used to mirror a
    // history entry into the sibling module -- see startScan).
    return MODULE_KEY === "software"
      ? {
          live_count: softwareLiveCount, subcontracting_count: softwareSubCount,
          other_live_count: digitizationLiveCount, other_subcontracting_count: digitizationSubCount,
        }
      : {
          live_count: digitizationLiveCount, subcontracting_count: digitizationSubCount,
          other_live_count: softwareLiveCount, other_subcontracting_count: softwareSubCount,
        };
  }

  /* =========================================================================
     MASTER WORKBOOK — one synchronized workbook for BOTH SAM Data modules.
     The workbook intentionally mirrors the UI: company/prospect information and
     tender information live together on the subcontracting sheets, while direct
     tenders keep the tender-first layout. Every sheet is filterable and frozen.
  ========================================================================= */

  const COMPANY_EXPORT_COLUMNS = [
    ["Module", "module"], ["Company", "company_name"], ["Legal Company Name", "legal_company_name"],
    ["Company Type", "company_type"], ["Company Status", "company_status"], ["Parent Company", "parent_company"],
    ["Official Website", "official_website"], ["LinkedIn", "company_linkedin"], ["Phone", "general_phone"],
    ["Company Emails", "company_emails"], ["Procurement Emails", "procurement_emails"],
    ["Procurement URL", "procurement_url"], ["Supplier URL", "supplier_url"],
    ["Subcontracting URL", "subcontracting_url"], ["Teaming / Partnership URL", "teaming_url"],
    ["Executives", "executive_names_and_roles"], ["Executive Emails", "executive_emails"],
    ["Executive LinkedIns", "executive_linkedins"], ["Government Contractor", "government_contractor"],
    ["Federal Contracting Relevance", "federal_contracting_relevance"], ["Industry", "industry"],
    ["Company Description", "company_description"], ["Headquarters", "headquarters"], ["City", "city"],
    ["State", "state"], ["Country", "country"], ["Outreach Priority", "outreach_priority"],
    ["Qualified Lead", "qualified_lead"], ["Module Domain", "domain"], ["Source", "source"],
    ["Total Awarded Contracts", "total_awarded_contracts"], ["Total Award Value", "total_award_value"],
    ["Latest Award Date", "latest_award_date"], ["Earliest Award Date", "earliest_award_date"],
    ["Agencies Awarded", "agencies_awarded"], ["NAICS Codes", "naics_codes"], ["PSC Codes", "psc_codes"],
  ];

  const LIVE_EXPORT_COLUMNS = [
    ["Module", "module"], ["Company / Buyer", "company_name"], ["Legal Company Name", "legal_company_name"],
    ["CEO / Executives", "executive_names_and_roles"], ["Company Emails", "company_emails"], ["Website", "official_website"], ["LinkedIn", "company_linkedin"],
    ["Tender Title", "tender_title"], ["Source", "source"], ["Agency / Buyer", "agency"],
    ["Subagency", "subagency"], ["Contracting Office", "contracting_office"], ["Domain", "domain"],
    ["Subdomain", "subdomain"], ["Posted Date", "posted_date"], ["Deadline", "response_deadline"],
    ["Estimated Value", "estimated_value"], ["Currency", "currency"], ["Score", "relevance_score"],
    ["Eligibility", "eligibility"], ["Eligibility Score", "eligibility_score"], ["Set Aside", "set_aside_type"],
    ["Description", "description"], ["What They Need / Scope", "what_they_need"], ["Scope Summary", "scope_summary"], ["Location", "location"],
    ["NAICS", "naics_code"], ["PSC / CPV", "psc_code"], ["Buyer Contact", "contracting_officer_contact"],
    ["Tender URL", "sam_url"], ["Document URL", "tender_document_url"], ["Selected for Proposal", "selected_for_proposal"],
    ["Proposal Status", "proposal_status"], ["Profile", "profile_key"],
  ];

  const SUB_EXPORT_COLUMNS = [
    ["Module", "module"], ["Company", "company_name"], ["Legal Company Name", "legal_company_name"],
    ["Company Type", "company_type"], ["Company Status", "company_status"], ["Parent Company", "parent_company"],
    ["CEO / Executives", "executive_names_and_roles"], ["Executive Emails", "executive_emails"],
    ["Executive LinkedIns", "executive_linkedins"], ["Contact / General Phone", "general_phone"],
    ["Company Emails", "company_emails"], ["Official Website", "official_website"], ["Company LinkedIn", "company_linkedin"],
    ["Procurement URL", "procurement_url"], ["Supplier URL", "supplier_url"], ["Subcontracting URL", "subcontracting_url"],
    ["Teaming / Partnership URL", "teaming_url"], ["Industry", "industry"], ["Company Description", "company_description"],
    ["Headquarters", "headquarters"], ["Country", "country"], ["Government Contractor", "government_contractor"],
    ["Federal Relevance", "federal_contracting_relevance"], ["Tender / Contract", "contract_title"],
    ["Tender ID / Award Number", "notice_id"], ["Agency / Buyer", "agency"], ["Contracting Office", "contracting_office"],
    ["Award Date", "award_date"], ["Contract Start", "contract_start_date"], ["Contract End", "contract_end_date"],
    ["Award / Contract Value", "award_value"], ["Currency", "currency"], ["Domain", "domain"], ["Subdomain", "subdomain"],
    ["Score", "relevance_score"], ["What They Need / Subcontractable Work", "subcontracting_scope_relevance"],
    ["Why Contact This Company", "why_contact_this_company"], ["Subcontracting Potential", "subcontracting_potential"],
    ["Tender URL", "sam_url"], ["Tender Documents", "tender_document_url"], ["Source", "source"],
    ["Selected for Proposal", "selected_for_proposal"], ["Proposal Status", "proposal_status"], ["Profile", "profile_key"],
  ];

  function rawObject(row) {
    if (!row || !row.raw_data) return {};
    if (typeof row.raw_data === "object") return row.raw_data;
    try { return JSON.parse(row.raw_data); } catch { return {}; }
  }

  function pick(row, aliases, fallback = "") {
    const raw = rawObject(row);
    for (const key of aliases) {
      if (row && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") return row[key];
      if (raw && raw[key] !== undefined && raw[key] !== null && String(raw[key]).trim() !== "") return raw[key];
      const upper = String(key).toUpperCase();
      if (raw && raw[upper] !== undefined && raw[upper] !== null && String(raw[upper]).trim() !== "") return raw[upper];
    }
    return fallback;
  }

  function companyFromRow(row, moduleName) {
    return {
      module: moduleName,
      company_name: pick(row, ["prime_contractor", "company_name", "AWARDED_COMPANY", "PRIME_CONTRACTOR"]),
      legal_company_name: pick(row, ["legal_company_name", "LEGAL_COMPANY_NAME"]),
      company_type: pick(row, ["company_type", "COMPANY_TYPE"]),
      company_status: pick(row, ["company_status", "COMPANY_STATUS"]),
      parent_company: pick(row, ["parent_company", "PARENT_COMPANY"]),
      official_website: pick(row, ["official_website", "COMPANY_WEBSITE", "VERIFIED_OFFICIAL_WEBSITE"]),
      company_linkedin: pick(row, ["company_linkedin", "COMPANY_LINKEDIN"]),
      general_phone: pick(row, ["general_phone", "GENERAL_PHONE", "PROCUREMENT_PHONE"]),
      company_emails: pick(row, ["company_emails", "ALL_COMPANY_EMAILS", "GENERAL_EMAILS"]),
      procurement_emails: pick(row, ["procurement_emails", "PROCUREMENT_EMAILS"]),
      procurement_url: pick(row, ["procurement_url", "PROCUREMENT_URL", "PROCUREMENT / CONTRACTS URL"]),
      supplier_url: pick(row, ["supplier_url", "SUPPLIER_URL", "SUPPLIER_VENDOR_URL"]),
      subcontracting_url: pick(row, ["subcontracting_url", "SUBCONTRACTING_URL", "SUBCONTRACTING / PARTNER URL"]),
      teaming_url: pick(row, ["teaming_url", "TEAMING_URL", "PARTNER_TEAMING_URL", "PARTNERSHIP_URL"]),
      executive_names_and_roles: pick(row, ["executive_names_and_roles", "ALL_EXECUTIVE_NAMES & ROLES", "EXECUTIVE_NAMES_AND_ROLES"]),
      executive_emails: pick(row, ["executive_emails", "ALL_EXECUTIVE_EMAILS", "EXECUTIVE_EMAILS"]),
      executive_linkedins: pick(row, ["executive_linkedins", "ALL_EXECUTIVE_LINKEDINS", "EXECUTIVE_LINKEDINS"]),
      government_contractor: pick(row, ["government_contractor", "GOVERNMENT_CONTRACTOR"]),
      federal_contracting_relevance: pick(row, ["federal_contracting_relevance", "FEDERAL_CONTRACTING_RELEVANCE"]),
      industry: pick(row, ["industry", "INDUSTRY", "DOMAIN"]),
      company_description: pick(row, ["company_description", "COMPANY_DESCRIPTION", "DESCRIPTION"]),
      headquarters: pick(row, ["headquarters", "HEADQUARTERS"]),
      city: pick(row, ["city", "CITY"]), state: pick(row, ["state", "STATE"]), country: pick(row, ["country", "COUNTRY", "TENDER_COUNTRY"]),
      outreach_priority: pick(row, ["outreach_priority", "SUBCONTRACTOR_OUTREACH_PRIORITY"]),
      qualified_lead: pick(row, ["qualified_lead", "QUALIFIED_LEAD"]),
      domain: pick(row, ["domain", "DOMAIN"]), source: pick(row, ["source", "PLATFORM / SOURCE", "SOURCE_PLATFORM"]),
      total_awarded_contracts: pick(row, ["total_awarded_contracts", "TOTAL_AWARDED_CONTRACTS"]),
      total_award_value: pick(row, ["total_award_value", "TOTAL_AWARD_VALUE"]),
      latest_award_date: pick(row, ["latest_award_date", "LATEST_AWARD_DATE"]),
      earliest_award_date: pick(row, ["earliest_award_date", "EARLIEST_AWARD_DATE"]),
      agencies_awarded: pick(row, ["agencies_awarded", "AGENCIES_AWARDED"]),
      naics_codes: pick(row, ["naics_codes", "NAICS_CODES", "NAICS"]),
      psc_codes: pick(row, ["psc_codes", "PSC_CODES", "PSC"]),
    };
  }

  function normalizeLive(row, moduleName) {
    const r = rawObject(row);
    const get = (db, ...aliases) => pick(row, [db, ...aliases]);
    return {
      module: moduleName,
      // Preserve company/contact fields when a source supplies them. For a live
      // notice there may be no awarded supplier yet, so company_name can remain
      // empty while the buyer/agency is still fully represented below.
      company_name: get("company_name", "COMPANY_NAME", "prime_contractor", "PRIME_CONTRACTOR", "awarded_company", "AWARDED_COMPANY"),
      legal_company_name: get("legal_company_name", "LEGAL_COMPANY_NAME"),
      official_website: get("official_website", "COMPANY_WEBSITE", "VERIFIED_OFFICIAL_WEBSITE"),
      company_linkedin: get("company_linkedin", "COMPANY_LINKEDIN"),
      company_emails: get("company_emails", "ALL_COMPANY_EMAILS", "COMPANY_EMAILS", "buyer_contact_email", "BUYER_CONTACT_EMAILS"),
      executive_names_and_roles: get("executive_names_and_roles", "ALL_EXECUTIVE_NAMES & ROLES", "EXECUTIVE_NAMES_AND_ROLES"),
      tender_title: get("tender_title", "TENDER_TITLE"), source: get("source", "PLATFORM / SOURCE", "SOURCE_PLATFORM"),
      agency: get("agency", "AGENCY", "CONTRACTING_AUTHORITY"), subagency: get("subagency", "SUBAGENCY"),
      contracting_office: get("contracting_office", "CONTRACTING_OFFICE"), domain: get("domain", "DOMAIN"),
      subdomain: get("subdomain", "SUBDOMAIN"), posted_date: get("posted_date", "POSTED_DATE", "PUBLISHED_DATE"),
      response_deadline: get("response_deadline", "RESPONSE_DEADLINE", "DEADLINE"), estimated_value: get("estimated_value", "ESTIMATED_VALUE", "TENDER_VALUE / QUOTATION"),
      currency: get("currency", "CURRENCY"), relevance_score: get("relevance_score", "RELEVANCE_SCORE"), eligibility: get("eligibility", "ORBIT_ELIGIBILITY", "ORBITAVANYA_ELIGIBILITY"),
      what_they_need: get("what_they_need", "WHAT THEY NEED", "SCOPE_SUMMARY", "RELEVANCE_REASON"),
      eligibility_score: get("eligibility_score", "ORBIT_SCORE"), set_aside_type: get("set_aside_type", "SET_ASIDE_TYPE"), description: get("description", "DESCRIPTION"),
      scope_summary: get("scope_summary", "SCOPE_SUMMARY", "RELEVANCE_REASON"), location: get("location", "LOCATION", "TENDER_COUNTRY"),
      naics_code: get("naics_code", "NAICS_CODE"), psc_code: get("psc_code", "PSC_CODE", "CPV_CODES"), contracting_officer_contact: get("contracting_officer_contact", "CONTRACTING_OFFICER_CONTACT", "BUYER_CONTACT_NAME", "BUYER_CONTACT_EMAILS"),
      sam_url: get("sam_url", "SAM_URL", "TED_URL"), tender_document_url: get("tender_document_url", "TENDER_DOCUMENT_URL", "TENDER_DOCUMENTS_URL"),
      selected_for_proposal: row.selected_for_proposal, proposal_status: row.proposal_status, profile_key: row.profile_key,
    };
  }

  function normalizeSub(row, moduleName) {
    const company = companyFromRow(row, moduleName);
    return {
      ...company,
      contract_title: pick(row, ["contract_title", "tender_title", "CONTRACT_TITLE", "TENDER_TITLE"]),
      notice_id: pick(row, ["notice_id", "award_number", "TENDER_ID / NOTICE_ID", "NOTICE_ID", "AWARD_NUMBER"]),
      agency: pick(row, ["agency", "CONTRACTING_AUTHORITY", "AGENCY"]), contracting_office: pick(row, ["contracting_office", "CONTRACTING_OFFICE"]),
      award_date: pick(row, ["award_date", "AWARD_DATE"]), contract_start_date: pick(row, ["contract_start_date", "CONTRACT_START", "CONTRACT_START_DATE"]),
      contract_end_date: pick(row, ["contract_end_date", "CONTRACT_END", "CONTRACT_END_DATE"]), award_value: pick(row, ["award_value", "CONTRACT_VALUE / QUOTATION", "AWARD_VALUE"]),
      currency: pick(row, ["currency", "CURRENCY"]), domain: pick(row, ["domain", "DOMAIN"]), subdomain: pick(row, ["subdomain", "SUBDOMAIN"]),
      relevance_score: pick(row, ["relevance_score", "RELEVANCE_SCORE"]), subcontracting_scope_relevance: pick(row, ["subcontracting_scope_relevance", "LIKELY_SUBCONTRACTABLE_WORK", "SUBCONTRACTING_SCOPE_RELEVANCE"]),
      why_contact_this_company: pick(row, ["why_contact_this_company", "WHY CONTACT THIS COMPANY", "VERIFICATION_EVIDENCE"]),
      subcontracting_potential: pick(row, ["subcontracting_potential", "SUBCONTRACTING POTENTIAL"]),
      sam_url: pick(row, ["sam_url", "TED / OFFICIAL TENDER URL", "SAM_URL"]), tender_document_url: pick(row, ["tender_document_url", "TENDER DOCUMENTS URL", "TENDER_DOCUMENT_URL"]),
      source: pick(row, ["source", "PLATFORM / SOURCE", "SOURCE_PLATFORM"]), selected_for_proposal: row.selected_for_proposal, proposal_status: row.proposal_status, profile_key: row.profile_key,
    };
  }

  function safeSheetName(name) { return String(name).slice(0, 31); }

  function styledSheet(wb, name, columns, rows) {
    const header = columns.map(([label]) => label);
    const data = rows.map((row) => columns.map(([, key]) => {
      const v = row[key];
      if (v === null || v === undefined) return "";
      if (typeof v === "object") return JSON.stringify(v);
      return v;
    }));
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    ws["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(Math.max(0, header.length - 1))}${Math.max(1, data.length + 1)}` };
    ws["!freeze"] = { xSplit: 0, ySplit: 1 };
    ws["!cols"] = header.map((h) => ({ wch: Math.min(60, Math.max(14, String(h).length + 2)) }));
    for (let c = 0; c < header.length; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
      if (cell) cell.s = { font: { bold: true, color: "FFFFFF" }, fill: { fgColor: { rgb: "D81B60" } }, alignment: { vertical: "center" } };
    }
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(name));
  }

  async function queryTable(table, profileKey) {
    const where = profileKey ? "WHERE profile_key = $1" : "";
    const params = profileKey ? [profileKey] : [];
    try {
      const { rows } = await pool.query(`SELECT * FROM ${table} ${where} ORDER BY relevance_score IS NULL, relevance_score DESC, created_at DESC`, params);
      return rows;
    } catch (err) {
      // A missing table should not make the other SAM Data module impossible to export.
      if (err && err.code === "42P01") return [];
      throw err;
    }
  }

  async function buildMasterWorkbook(profileKey) {
    if (!XLSX) return null;
    console.log(`[${LOG_LABEL}] building SAM_DATA_MASTER.xlsx (software + digitization, profile='${profileKey || "all"}')...`);
    const [appLive, appSub, scanLive, scanSub] = await Promise.all([
      queryTable("software_tenders_live", profileKey), queryTable("software_tenders_subcontracting", profileKey),
      queryTable("digitization_tenders_live", profileKey), queryTable("digitization_tenders_subcontracting", profileKey),
    ]);
    const wb = XLSX.utils.book_new();
    styledSheet(wb, "APPLICATION_TENDERS", LIVE_EXPORT_COLUMNS, appLive.map((r) => normalizeLive(r, "Application / Software")));
    styledSheet(wb, "APPLICATION_SUBCONTRACTING", SUB_EXPORT_COLUMNS, appSub.map((r) => normalizeSub(r, "Application / Software")));
    styledSheet(wb, "SCANNING_TENDERS", LIVE_EXPORT_COLUMNS, scanLive.map((r) => normalizeLive(r, "Scanning & Digitization")));
    styledSheet(wb, "SCANNING_SUBCONTRACTING", SUB_EXPORT_COLUMNS, scanSub.map((r) => normalizeSub(r, "Scanning & Digitization")));

    const allSubs = [...appSub.map((r) => normalizeSub(r, "Application / Software")), ...scanSub.map((r) => normalizeSub(r, "Scanning & Digitization"))];
    const companyMap = new Map();
    for (const row of allSubs) {
      const key = String(row.company_name || row.legal_company_name || "").trim().toLowerCase();
      if (!key) continue;
      if (!companyMap.has(key)) companyMap.set(key, row);
      else {
        const existing = companyMap.get(key);
        for (const [k, v] of Object.entries(row)) if (!existing[k] && v) existing[k] = v;
      }
    }
    styledSheet(wb, "COMPANY_MASTER", COMPANY_EXPORT_COLUMNS, [...companyMap.values()]);
    const sourceRows = [];
    for (const [label, rows] of [["Application / Software — Live", appLive], ["Application / Software — Subcontracting", appSub], ["Scanning & Digitization — Live", scanLive], ["Scanning & Digitization — Subcontracting", scanSub]]) {
      const bySource = {};
      for (const r of rows) { const src = String(pick(r, ["source", "PLATFORM / SOURCE", "SOURCE_PLATFORM"]) || "Unknown"); bySource[src] = (bySource[src] || 0) + 1; }
      for (const [source, count] of Object.entries(bySource)) sourceRows.push({ category: label, source, records: count });
    }
    styledSheet(wb, "SOURCE_SUMMARY", [["Category", "category"], ["Source", "source"], ["Records", "records"]], sourceRows);

    const outPath = path.join(DATA_DIR, "SAM_DATA_MASTER.xlsx");
    XLSX.writeFile(wb, outPath);
    console.log(`[${LOG_LABEL}] SAM_DATA_MASTER.xlsx written — ${appLive.length + scanLive.length} live, ${appSub.length + scanSub.length} subcontracting rows across both modules.`);
    return outPath;
  }

  async function buildDetailedMasterWorkbook(profileKey) {
    if (!XLSX) return null;
    const builder = path.join(SCRIPTS_DIR, "build_master_workbook.py");
    if (!fs.existsSync(builder)) throw new Error(`Master workbook builder not found at ${builder}`);
    const outPath = path.join(DATA_DIR, "SAM_DATA_MASTER.xlsx");
    const args = [builder, "--data-dir", DATA_DIR, "--output", outPath];
    console.log(`[${LOG_LABEL}] running detailed master workbook builder (build_master_workbook.py)...`);
    await new Promise((resolve, reject) => {
      const child = spawn(PYTHON_COMMAND.command, [...PYTHON_COMMAND.args, "-u", ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
      let tail = "";
      const add = (b) => { tail = (tail + b.toString()).slice(-6000); };
      child.stdout.on("data", add); child.stderr.on("data", add);
      child.on("error", (err) => {
        console.error(`[${LOG_LABEL}] detailed master workbook builder failed to start — ${err.message}`);
        reject(err);
      });
      child.on("close", (code) => {
        if (code === 0) {
          console.log(`[${LOG_LABEL}] detailed master workbook builder finished successfully.`);
          resolve();
        } else {
          console.error(`[${LOG_LABEL}] detailed master workbook builder exited with code ${code}`);
          reject(new Error(`Detailed master builder exited with code ${code}. ${tail}`));
        }
      });
    });
    return outPath;
  }

  router.get("/export", managerGuard, async (req, res) => {
    if (!XLSX) return res.status(500).json({ message: "The 'xlsx' package is not installed. Run: npm install xlsx" });
    try {
      const profileKey = clean(req.query.profile_key) || null;
      const outPath = await buildDetailedMasterWorkbook(profileKey);
      res.download(outPath, "SAM_DATA_MASTER.xlsx");
    } catch (err) {
      console.error(`[${LOG_LABEL}] export master workbook`, err);
      res.status(500).json({ message: "Failed to build master workbook.", error: err.message });
    }
  });

  /* =========================================================================
     LISTING / DETAIL / SELECT-FOR-PROPOSAL  (mirrors /api/tender/* shape)
  ========================================================================= */

  function listEndpoint(table, titleCol) {
    return async (req, res) => {
      const { search = "", profile_key = "", source = "", status = "", limit = 200 } = req.query;
      const clauses = [];
      const params = [];
      if (profile_key) { params.push(profile_key); clauses.push(`profile_key = $${params.length}`); }
      if (source) { params.push(String(source).toUpperCase()); clauses.push(`source = $${params.length}`); }
      if (status) { params.push(status); clauses.push(`proposal_status = $${params.length}`); }
      if (search) {
        params.push(`%${search}%`);
        const n = params.length;
        if (table === SUB_TABLE) {
          clauses.push(`(contract_title ILIKE $${n} OR prime_contractor ILIKE $${n} OR company_name ILIKE $${n} OR agency ILIKE $${n} OR domain ILIKE $${n} OR subdomain ILIKE $${n} OR company_emails ILIKE $${n} OR description ILIKE $${n} OR subcontracting_scope_relevance ILIKE $${n})`);
        } else {
          clauses.push(`(${titleCol} ILIKE $${n} OR agency ILIKE $${n} OR domain ILIKE $${n} OR subdomain ILIKE $${n} OR description ILIKE $${n})`);
        }
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const countParams = [...params];
      params.push(Number(limit) || 200);
      try {
        const { rows } = await pool.query(
          `SELECT * FROM ${table} ${where} ORDER BY relevance_score IS NULL, relevance_score DESC, created_at DESC LIMIT $${params.length}`,
          params
        );
        const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total FROM ${table} ${where}`, countParams);
        res.json({ tenders: rows, total: countRows[0]?.total || rows.length });
      } catch (err) {
        console.error(`[${LOG_LABEL}] list ${table}`, err);
        res.status(500).json({ message: "Failed to load tenders.", error: err.message });
      }
    };
  }

  router.get("/live-tenders", managerGuard, listEndpoint(LIVE_TABLE, "tender_title"));
  router.get("/subcontracting-tenders", managerGuard, listEndpoint(SUB_TABLE, "contract_title"));

  router.get("/live-tenders/:id", managerGuard, async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM ${LIVE_TABLE} WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Tender not found." });
    res.json({ tender: rows[0] });
  });

  router.get("/subcontracting-tenders/:id", managerGuard, async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM ${SUB_TABLE} WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Tender not found." });
    res.json({ tender: rows[0] });
  });

  function selectEndpoint(table) {
    return async (req, res) => {
      const { ids = [], selected = true } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ message: "ids[] is required." });
      }
      try {
        await pool.query(
          `UPDATE ${table} SET selected_for_proposal = $1, updated_at = NOW() WHERE id = ANY($2::bigint[])`,
          [Boolean(selected), ids]
        );
        res.json({ message: `${ids.length} tender(s) updated.` });
      } catch (err) {
        res.status(500).json({ message: "Failed to update selection.", error: err.message });
      }
    };
  }

  router.post("/live-tenders/select", managerGuard, selectEndpoint(LIVE_TABLE));
  router.post("/subcontracting-tenders/select", managerGuard, selectEndpoint(SUB_TABLE));

  router.get("/stats", managerGuard, async (req, res) => {
    const profileKey = req.query.profile_key;
    const params = profileKey ? [profileKey] : [];
    const profileClause = profileKey ? `WHERE profile_key = $1` : "";
    try {
      const [live, sub, liveBySource, subBySource, profiles] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE selected_for_proposal)::int AS selected,
           COUNT(*) FILTER (WHERE proposal_status = 'done')::int AS done
           FROM ${LIVE_TABLE} ${profileClause}`,
          params
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE selected_for_proposal)::int AS selected,
           COUNT(*) FILTER (WHERE proposal_status = 'done')::int AS done
           FROM ${SUB_TABLE} ${profileClause}`,
          params
        ),
        pool.query(
          `SELECT source, COUNT(*)::int AS total FROM ${LIVE_TABLE} ${profileClause} GROUP BY source`,
          params
        ),
        pool.query(
          `SELECT source, COUNT(*)::int AS total FROM ${SUB_TABLE} ${profileClause} GROUP BY source`,
          params
        ),
        pool.query(`SELECT COUNT(*)::int AS total FROM digitization_eligibility_profiles`),
      ]);
      res.json({
        live: live.rows[0],
        subcontracting: sub.rows[0],
        live_by_source: liveBySource.rows,
        subcontracting_by_source: subBySource.rows,
        profile_count: profiles.rows[0].total,
      });
    } catch (err) {
      res.status(500).json({ message: "Failed to load stats.", error: err.message });
    }
  });

  router.get("/health", managerGuard, async (_req, res) => {
    res.json({
      ok: true,
      data_dir: DATA_DIR,
      scripts_dir: SCRIPTS_DIR,
      sources: SOURCE_KEYS.map((k) => ({
        key: k,
        engine: SOURCES[k].engine,
        engine_exists: fs.existsSync(path.join(SCRIPTS_DIR, SOURCES[k].engine)),
      })),
      xlsx_installed: Boolean(XLSX),
    });
  });

  return router;
}

module.exports = { createDigitizationRouter };