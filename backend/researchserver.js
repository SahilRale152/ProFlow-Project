const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const OpenAI = require("openai");

let ExcelJS;
try {
  ExcelJS = require("exceljs");
} catch (err) {
  ExcelJS = null;
}

/**
 * AI Company Research
 * ====================
 * Self-contained, like trackingserver.js — its own Groq client, its own
 * DB table, its own xlsx logging. server.js only needs a require + a
 * one-line app.use() mount.
 *
 * What it does, given { source: 'customer' | 'tender', id }:
 *   1. Loads that company's row from `customers` or `tender_customers`.
 *   2. Loads your service list from `pricing_catalog`.
 *   3. Asks the LLM (Groq, same model your AI Assistant already uses) to:
 *        - summarize what the company does
 *        - identify likely gaps/pain points
 *        - match specific services from YOUR catalog to those gaps
 *        - suggest a starting pricing tier
 *        - write a short paragraph usable directly in a proposal intro
 *   4. Saves the full result to a `company_research` table (so the
 *      Proposal editor / AI Assistant can pull it back up instantly)
 *   5. ALSO appends a row to an Excel log file on disk, exactly as
 *      requested — every research run is added as a new row to
 *      data/company_research_log.xlsx.
 *
 * IMPORTANT HONEST NOTE: Groq's llama model has no live internet access.
 * "Research" here means the model reasoning over the real data you already
 * have on the company (from the customers/tender_customers row, including
 * the full tender_data JSONB for tender companies) plus whatever it
 * already knows about that company/industry from training. It is NOT
 * live web browsing. If you want true live web research (fetching their
 * actual current website, news, etc.), that needs a web-search API
 * wired in as a separate step — say the word and I'll add it.
 *
 * UPDATE: since your .env has TAVILY_API_KEY configured (same key your
 * server.js already uses for the /api/customers/:id/ai-insights feature),
 * this module now also does real live web search before asking the LLM
 * to research — so the caveat above no longer fully applies. The model
 * gets actual current search results about the company, not just the
 * CRM row, and is told which claims came from real sources vs its own
 * background knowledge.
 */
function createResearchRouter({ pool, requireAuthenticatedUser, isContractManager }) {
  const router = express.Router();

  /*
   * AI provider switch — set AI_PROVIDER=gemini or AI_PROVIDER=groq in
   * backend/.env. Uses Google's OpenAI-compatibility endpoint for Gemini,
   * so the rest of this file (openai.chat.completions.create) is unchanged
   * either way. Kept self-contained here rather than importing from
   * server.js, matching how this file already works.
   */
  const AI_PROVIDER = (process.env.AI_PROVIDER || "gemini").toLowerCase();

  const AI_MODEL =
    AI_PROVIDER === "gemini"
      ? process.env.GEMINI_MODEL || "gemini-3.1-flash-lite"
      : process.env.GROQ_MODEL || process.env.RESEARCH_AI_MODEL || process.env.AI_MODEL || "openai/gpt-oss-120b";

  const openai = new OpenAI(
    AI_PROVIDER === "gemini"
      ? {
          apiKey: process.env.GEMINI_API_KEY,
          baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        }
      : {
          apiKey: process.env.GROQ_API_KEY,
          baseURL: "https://api.groq.com/openai/v1",
        }
  );

  /* ---------------- Live web search (Tavily) ----------------
     Same service, same env var, same call shape as server.js's existing
     gatherWebContext() for /api/customers/:id/ai-insights — kept
     self-contained here rather than importing from server.js. */

  async function tavilySearch(query, maxResults = 3) {
    if (!process.env.TAVILY_API_KEY) return [];
    try {
      const resp = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          search_depth: "advanced",
          max_results: maxResults,
          include_answer: false,
        }),
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.results || []).map((r) => ({ title: r.title, url: r.url, content: r.content }));
    } catch (err) {
      console.error("[RESEARCH] Tavily search failed:", err.message);
      return [];
    }
  }

  async function gatherWebContext(companyName, extraQuery) {
    if (!companyName) return { text: "", sources: [] };
    const queries = [
      `${companyName} company profile`,
      `${companyName} official website services`,
      extraQuery ? `${companyName} ${extraQuery}` : `${companyName} news`,
    ];
    const batches = await Promise.all(queries.map((q) => tavilySearch(q, 3)));
    const seen = new Set();
    const flat = [];
    for (const batch of batches) {
      for (const r of batch) {
        if (r.url && !seen.has(r.url)) {
          seen.add(r.url);
          flat.push(r);
        }
      }
    }
    const text = flat.map((r, i) => `[Source ${i + 1}: ${r.title} — ${r.url}]\n${r.content}`).join("\n\n");
    return { text, sources: flat.map((r) => ({ title: r.title, url: r.url })) };
  }

  const DEFAULT_DATA_DIR =
    process.env.TENDER_DATA_DIR ||
    path.join(__dirname, "..", "nova-crm-project", "data");

  // The path you actually want to see the file at (default: inside your
  // OneDrive-synced Desktop folder, matching how the project is laid out).
  const EXCEL_LOG_PATH =
    process.env.RESEARCH_EXCEL_PATH || path.join(DEFAULT_DATA_DIR, "company_research_log.xlsx");

  // Reading and writing .xlsx files directly inside a OneDrive-synced
  // folder is unreliable: OneDrive can hold a file as a not-yet-downloaded
  // "placeholder", lock it mid-upload, or serve a stale/partial copy while
  // syncing — any of which makes ExcelJS think the log is empty/corrupt and
  // silently start over from a single row every time. That matches exactly
  // what you were seeing (only ever 1 row, log preview empty).
  //
  // Fix: every read/write of real data happens against a LOCAL, non-synced
  // "master" copy (under %LOCALAPPDATA%, which OneDrive doesn't touch).
  // After every successful write, we best-effort copy the finished file
  // out to EXCEL_LOG_PATH too, so you can still open/share it from the
  // familiar OneDrive location — but that copy is never load-bearing.
  const SAFE_MASTER_DIR = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".orbitavanya-crm"),
    "OrbitAvanyaCRM"
  );
  const SAFE_MASTER_PATH = path.join(SAFE_MASTER_DIR, "company_research_log.xlsx");

  function mirrorToVisiblePath() {
    // Best-effort only — never let a OneDrive hiccup fail the actual save.
    try {
      fs.mkdirSync(path.dirname(EXCEL_LOG_PATH), { recursive: true });
      fs.copyFileSync(SAFE_MASTER_PATH, EXCEL_LOG_PATH);
    } catch (err) {
      console.warn(
        `[RESEARCH] Could not mirror the Excel log to ${EXCEL_LOG_PATH} (your data is safe at ${SAFE_MASTER_PATH}):`,
        err.message
      );
    }
  }

  /* ---------------- Schema (idempotent, runs once on require) ---------------- */
  async function ensureSchema() {
    if ((process.env.DB_DIALECT || "mysql").toLowerCase() === "mysql") {
      console.log("[researchserver] MySQL schema bootstrap skipped; using deployed MySQL schema");
      return;
    }
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS company_research (
          id SERIAL PRIMARY KEY,
          source TEXT NOT NULL,               -- 'customer' | 'tender'
          company_id INTEGER NOT NULL,
          company_name TEXT NOT NULL,
          summary TEXT,
          pain_points JSONB,
          recommended_services JSONB,
          recommended_pricing_tier TEXT,
          proposal_intro TEXT,
          raw_response JSONB,
          model TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        ALTER TABLE company_research ADD COLUMN IF NOT EXISTS web_sources JSONB;
        ALTER TABLE company_research ADD COLUMN IF NOT EXISTS detailed_report TEXT;
        ALTER TABLE company_research ADD COLUMN IF NOT EXISTS is_latest BOOLEAN NOT NULL DEFAULT TRUE;
        ALTER TABLE company_research ADD COLUMN IF NOT EXISTS company_category TEXT;
        ALTER TABLE company_research ADD COLUMN IF NOT EXISTS company_needs_summary TEXT;
        ALTER TABLE company_research ADD COLUMN IF NOT EXISTS content_hash TEXT;
        CREATE INDEX IF NOT EXISTS idx_company_research_lookup
          ON company_research(source, company_id, created_at DESC);
      `);
      // Backfill is_latest before building the unique index: ADD COLUMN
      // ... DEFAULT TRUE (above) marks every pre-existing row TRUE, and the
      // partial unique index below requires exactly one TRUE per company —
      // so on a DB with research history this index creation would 25P02
      // without this backfill running first.
      await pool.query(`
        WITH ranked AS (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY source, company_id ORDER BY created_at DESC, id DESC) AS rn
          FROM company_research
        )
        UPDATE company_research cr
        SET is_latest = (ranked.rn = 1)
        FROM ranked
        WHERE cr.id = ranked.id
          AND cr.is_latest IS DISTINCT FROM (ranked.rn = 1);
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_company_research_one_latest
          ON company_research (source, company_id) WHERE is_latest;

        CREATE TABLE IF NOT EXISTS research_findings (
          id BIGSERIAL PRIMARY KEY,
          research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          body TEXT,
          fact_type TEXT NOT NULL DEFAULT 'inferred'
            CHECK (fact_type IN ('verified','inferred','assumption')),
          priority TEXT CHECK (priority IN ('high','medium','low')),
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_research_findings_run ON research_findings(research_run_id);

        CREATE TABLE IF NOT EXISTS research_pain_points (
          id BIGSERIAL PRIMARY KEY,
          research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
          finding_id BIGINT REFERENCES research_findings(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          description TEXT,
          priority TEXT CHECK (priority IN ('high','medium','low')),
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_research_pain_points_run ON research_pain_points(research_run_id);

        CREATE TABLE IF NOT EXISTS research_opportunities (
          id BIGSERIAL PRIMARY KEY,
          research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
          pain_point_id BIGINT REFERENCES research_pain_points(id) ON DELETE SET NULL,
          service_id INTEGER REFERENCES pricing_catalog(id) ON DELETE SET NULL,
          service_name TEXT NOT NULL,
          reason TEXT,
          priority TEXT CHECK (priority IN ('high','medium','low')),
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_research_opportunities_run ON research_opportunities(research_run_id);

        CREATE TABLE IF NOT EXISTS research_proposal_recommendations (
          id BIGSERIAL PRIMARY KEY,
          research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
          opportunity_id BIGINT REFERENCES research_opportunities(id) ON DELETE SET NULL,
          proposal_topic TEXT NOT NULL,
          proposal_type TEXT,
          pitch_summary TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_research_proposal_recs_run ON research_proposal_recommendations(research_run_id);

        CREATE TABLE IF NOT EXISTS research_sources (
          id BIGSERIAL PRIMARY KEY,
          research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
          title TEXT,
          url TEXT,
          query TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_research_sources_run ON research_sources(research_run_id);

        CREATE TABLE IF NOT EXISTS excel_export_log (
          id BIGSERIAL PRIMARY KEY,
          research_run_id INTEGER REFERENCES company_research(id) ON DELETE SET NULL,
          export_type TEXT NOT NULL CHECK (export_type IN ('auto_append','manual_download')),
          exported_by TEXT,
          row_count INTEGER,
          file_path TEXT,
          written BOOLEAN NOT NULL DEFAULT TRUE,
          failure_reason TEXT,
          exported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_excel_export_log_run ON excel_export_log(research_run_id);
      `);
      console.log("[researchserver] company_research schema ready");
    } catch (err) {
      console.error("[researchserver] schema check failed:", err.message);
    }
  }
  ensureSchema();

  /* ---------------- Excel export tracking helper ---------------- */
  async function logExcelExport({ researchRunId, exportType, exportedBy, rowCount, filePath, written, failureReason }) {
    try {
      await pool.query(
        `INSERT INTO excel_export_log
          (research_run_id, export_type, exported_by, row_count, file_path, written, failure_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [researchRunId || null, exportType, exportedBy || null, rowCount ?? null, filePath || null, written !== false, failureReason || null]
      );
    } catch (err) {
      console.error("[RESEARCH] Failed to log excel export:", err.message);
    }
  }

  /* ---------------- Match a recommended service name to our catalog ---------------- */
  function matchCatalogRowByName(catalog, name) {
    if (!name) return null;
    const wanted = String(name).toLowerCase().trim();
    return (
      catalog.find((row) => String(row.service_name).toLowerCase() === wanted) ||
      catalog.find(
        (row) =>
          String(row.service_name).toLowerCase().includes(wanted) ||
          wanted.includes(String(row.service_name).toLowerCase())
      ) ||
      null
    );
  }

  /* ---------------- Persist the normalized research chain ----------------
     Company Finding -> Pain Point/Need -> Matching Service -> Reason ->
     Opportunity -> Proposal Recommendation. Runs alongside the existing
     JSONB columns on company_research (kept for backward compatibility /
     the raw AI response), so nothing that already reads company_research
     directly breaks. */
  async function insertNormalizedResearch(researchRunId, parsed, catalog) {
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const painPoints = Array.isArray(parsed.pain_points_detailed) ? parsed.pain_points_detailed : [];
    const services = Array.isArray(parsed.recommended_services) ? parsed.recommended_services : [];
    const proposalTopics = Array.isArray(parsed.proposal_topics) ? parsed.proposal_topics : [];

    try {
      const findingIdByTitle = new Map();
      for (let i = 0; i < findings.length; i++) {
        const f = findings[i] || {};
        const row = await pool.query(
          `INSERT INTO research_findings (research_run_id, title, body, fact_type, priority, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            researchRunId,
            String(f.title || `Finding ${i + 1}`).slice(0, 500),
            f.body || null,
            ["verified", "inferred", "assumption"].includes(f.fact_type) ? f.fact_type : "inferred",
            ["high", "medium", "low"].includes(f.priority) ? f.priority : null,
            i,
          ]
        );
        if (f.title) findingIdByTitle.set(String(f.title).toLowerCase().trim(), row.rows[0].id);
      }

      const painPointIdByTitle = new Map();
      for (let i = 0; i < painPoints.length; i++) {
        const p = painPoints[i] || {};
        const linkedFindingId = p.related_finding
          ? findingIdByTitle.get(String(p.related_finding).toLowerCase().trim()) || null
          : null;
        const row = await pool.query(
          `INSERT INTO research_pain_points (research_run_id, finding_id, title, description, priority, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            researchRunId,
            linkedFindingId,
            String(p.title || `Pain point ${i + 1}`).slice(0, 500),
            p.description || null,
            ["high", "medium", "low"].includes(p.priority) ? p.priority : null,
            i,
          ]
        );
        if (p.title) painPointIdByTitle.set(String(p.title).toLowerCase().trim(), row.rows[0].id);
      }

      const opportunityIdByService = new Map();
      for (let i = 0; i < services.length; i++) {
        const s = services[i] || {};
        const matched = matchCatalogRowByName(catalog, s.service_name);
        const linkedPainPointId = s.related_pain_point
          ? painPointIdByTitle.get(String(s.related_pain_point).toLowerCase().trim()) || null
          : null;
        const row = await pool.query(
          `INSERT INTO research_opportunities
             (research_run_id, pain_point_id, service_id, service_name, reason, priority, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            researchRunId,
            linkedPainPointId,
            matched?.id || null,
            String(s.service_name || `Service ${i + 1}`).slice(0, 300),
            s.reason || null,
            ["high", "medium", "low"].includes(s.priority) ? s.priority : null,
            i,
          ]
        );
        if (s.service_name) opportunityIdByService.set(String(s.service_name).toLowerCase().trim(), row.rows[0].id);
      }

      for (let i = 0; i < proposalTopics.length; i++) {
        const t = proposalTopics[i] || {};
        const linkedOpportunityId = t.related_service
          ? opportunityIdByService.get(String(t.related_service).toLowerCase().trim()) || null
          : null;
        await pool.query(
          `INSERT INTO research_proposal_recommendations
             (research_run_id, opportunity_id, proposal_topic, proposal_type, pitch_summary, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            researchRunId,
            linkedOpportunityId,
            String(t.topic || `Proposal idea ${i + 1}`).slice(0, 300),
            t.type || null,
            t.pitch || null,
            i,
          ]
        );
      }
    } catch (err) {
      console.error("[RESEARCH] Failed to persist normalized findings/opportunities:", err.message);
      // Non-fatal: the JSONB columns on company_research still have the full data.
    }
  }

  /* ---------------- Attach normalized child rows to a research row for API responses ---------------- */
  async function attachNormalizedData(research) {
    if (!research) return research;
    try {
      const [findings, painPoints, opportunities, proposalTopics, sources] = await Promise.all([
        pool.query(`SELECT * FROM research_findings WHERE research_run_id = $1 ORDER BY sort_order`, [research.id]),
        pool.query(`SELECT * FROM research_pain_points WHERE research_run_id = $1 ORDER BY sort_order`, [research.id]),
        pool.query(`SELECT * FROM research_opportunities WHERE research_run_id = $1 ORDER BY sort_order`, [research.id]),
        pool.query(`SELECT * FROM research_proposal_recommendations WHERE research_run_id = $1 ORDER BY sort_order`, [research.id]),
        pool.query(`SELECT * FROM research_sources WHERE research_run_id = $1 ORDER BY sort_order`, [research.id]),
      ]);
      return {
        ...research,
        findings: findings.rows,
        pain_points_detailed: painPoints.rows,
        opportunities: opportunities.rows,
        proposal_topics: proposalTopics.rows,
        sources: sources.rows,
      };
    } catch (err) {
      console.error("[RESEARCH] Failed to attach normalized data:", err.message);
      return research;
    }
  }

  function managerGuard(req, res, next) {
    Promise.resolve(requireAuthenticatedUser(req, res))
      .then((user) => {
        if (!user) return;
        if (!isContractManager(user.role)) {
          return res.status(403).json({ message: "Staff access required." });
        }
        req.researchActor = user;
        next();
      })
      .catch((err) => {
        console.error("[RESEARCH AUTH]", err);
        res.status(500).json({ message: "Authentication check failed.", error: err.message });
      });
  }

  function clean(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim();
  }

  /* ---------------- Load the company (either table) ---------------- */

  async function loadCompany(source, id) {
    if (source === "tender") {
      const result = await pool.query(`SELECT * FROM tender_customers WHERE id = $1`, [id]);
      return result.rows[0] || null;
    }
    const result = await pool.query(`SELECT * FROM customers WHERE id = $1`, [id]);
    return result.rows[0] || null;
  }

  /* ---------------- Load our services ---------------- */

  async function loadCatalog() {
    try {
      const result = await pool.query(`SELECT * FROM pricing_catalog ORDER BY id ASC`);
      return result.rows;
    } catch (err) {
      // Table might have different columns than expected, or not exist
      // in some installs yet — research still works without it, it just
      // won't be able to match specific services.
      console.error("[RESEARCH] pricing_catalog lookup failed:", err.message);
      return [];
    }
  }

  /* ---------------- Load who "we" are ---------------- */

  async function loadCompanyProfile() {
    try {
      const result = await pool.query(`SELECT * FROM company_profile WHERE id = 1 LIMIT 1`);
      return result.rows[0] || null;
    } catch (err) {
      console.error("[RESEARCH] company_profile lookup failed:", err.message);
      return null;
    }
  }

  /* ---------------- Build the prompt ---------------- */

  function summarizeCompanyForPrompt(source, company) {
    if (source === "tender") {
      const lines = [
        `Company name: ${clean(company.company_name)}`,
        company.legal_company_name && `Legal name: ${clean(company.legal_company_name)}`,
        company.company_number && `Company number: ${clean(company.company_number)}`,
        company.official_website && `Website: ${clean(company.official_website)}`,
        company.linkedin_url && `LinkedIn: ${clean(company.linkedin_url)}`,
        company.executive_name && `Key contact: ${clean(company.executive_name)} (${clean(company.executive_role) || "role unknown"})`,
        company.primary_domain && `Primary domain: ${clean(company.primary_domain)}`,
        company.tender_domain && `Tender activity domain: ${clean(company.tender_domain)}`,
        company.tender_subdomain && `Tender sub-domain: ${clean(company.tender_subdomain)}`,
        Number(company.tender_count) > 0 && `Known tender/contract records on file: ${company.tender_count}`,
        company.procurement_url && `Procurement page: ${clean(company.procurement_url)}`,
        company.supplier_url && `Supplier/vendor page: ${clean(company.supplier_url)}`,
        company.subcontracting_url && `Subcontracting page: ${clean(company.subcontracting_url)}`,
        company.teaming_url && `Teaming/partnership page: ${clean(company.teaming_url)}`,
      ].filter(Boolean);

      // Include a trimmed slice of the raw workbook row(s) for extra
      // color the model can use — capped so the prompt stays small.
      let rawSample = "";
      try {
        const raw = company.raw_data || {};
        rawSample = JSON.stringify(raw).slice(0, 1500);
      } catch (_) {
        rawSample = "";
      }

      return `${lines.join("\n")}\n\nAdditional raw workbook fields (may be partial):\n${rawSample}`;
    }

    // Regular CRM customer
    const lines = [
      `Company name: ${clean(company.company_name)}`,
      company.contact_name && `Contact: ${clean(company.contact_name)}`,
      company.ceo_name && `CEO / senior contact: ${clean(company.ceo_name)}`,
      company.industry && `Industry: ${clean(company.industry)}`,
      company.website && `Website: ${clean(company.website)}`,
      company.company_size && `Company size: ${clean(company.company_size)}`,
      company.employee_count && `Employee count: ${clean(company.employee_count)}`,
      (company.city || company.state || company.country) &&
        `Location: ${[company.city, company.state, company.country].filter(Boolean).join(", ")}`,
      company.category && `Category: ${clean(company.category)}`,
      company.email && `Email on file: ${clean(company.email)}`,
      company.phone && `Phone on file: ${clean(company.phone)}`,
      company.notes && `Notes on file: ${clean(company.notes)}`,
    ].filter(Boolean);

    return lines.join("\n");
  }

  const CURRENCY_SYMBOLS = { USD: "$", INR: "₹", EUR: "€", GBP: "£" };
  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[String(code || "").toUpperCase()] || (code ? `${code} ` : "$");
  }

  function summarizeCatalogForPrompt(catalog) {
    if (!catalog.length) {
      return "No service catalog rows were found in pricing_catalog — recommend generically based on the company profile, and say pricing needs to be confirmed manually.";
    }
    return catalog
      .map((row) => {
        const sym = currencySymbol(row.currency);
        const parts = [
          `- ${row.service_name}`,
          row.starting_price && `starting at ${sym}${row.starting_price}`,
          row.delivery_time && `delivery ${row.delivery_time}`,
          row.amc && `AMC ${row.amc}`,
        ].filter(Boolean);
        return parts.join(", ");
      })
      .join("\n");
  }

  function summarizeCompanyProfileForPrompt(profile) {
    if (!profile) return "(No company profile on file — describe recommendations generically as 'our team'.)";
    const registrations = profile.registrations || {};
    const registrationLines = Object.entries(registrations)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`);

    const lines = [
      profile.company_name && `We are: ${clean(profile.company_name)}`,
      profile.legal_name && `Legal name: ${clean(profile.legal_name)}`,
      profile.tagline && `Tagline: ${clean(profile.tagline)}`,
      profile.description && `About us: ${clean(profile.description)}`,
      Array.isArray(profile.core_services) && profile.core_services.length &&
        `Core service areas: ${profile.core_services.join(", ")}`,
      Array.isArray(profile.why_choose_us) && profile.why_choose_us.length &&
        `Why clients choose us: ${profile.why_choose_us.join("; ")}`,
      Array.isArray(profile.certifications) && profile.certifications.length &&
        `Certifications: ${profile.certifications.join(", ")}`,
      registrationLines.length && `Registrations: ${registrationLines.join(", ")}`,
      profile.website && `Website: ${clean(profile.website)}`,
      (profile.leadership_name || profile.leadership_title) &&
        `Leadership: ${[profile.leadership_name, profile.leadership_title].filter(Boolean).join(", ")}`,
    ].filter(Boolean);
    return lines.join("\n");
  }

  async function callLlm(messages) {
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 6000,
      response_format: { type: "json_object" },
    });
    const raw = completion?.choices?.[0]?.message?.content;
    if (!raw) throw new Error(`${AI_PROVIDER === "gemini" ? "Gemini" : "Groq"} returned an empty research response.`);
    return raw;
  }

  function safeParseJson(raw) {
    let text = String(raw).trim();
    // Strip ```json ... ``` fences if the model added them despite
    // response_format: json_object (some models still do occasionally).
    text = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error("Could not parse the AI's research response as JSON: " + err.message);
    }
  }

  /* ---------------- Excel logging (professional workbook via ExcelJS) ----------------
     Design goals:
       - Looks like a real report: dark navy header row, white bold header
         text, frozen header + autofilter, sensible column widths, wrapped
         text for long fields, a colored HIGH/MEDIUM/LOW priority column.
       - "Auto update": every successful /generate call appends one row —
         no manual export step needed.
       - Safe against the file being open in Excel: we write to a temp file
         first and only swap it into place with a rename, and retry a few
         times with a short delay if the target is locked (EBUSY/EPERM),
         which happens on Windows when the workbook is open. If it's still
         locked after retries, we fall back to a timestamped sibling file
         so the research itself is never lost, and we tell the caller why.
  */

  const EXCEL_SHEET_NAME = "Company Research Log";
  const EXCEL_TITLE = "Company Research Log — OrbitAvanya CRM";
  const EXCEL_SUBTITLE = "Auto-synced live from every AI research run. Do not manually reorder columns.";
  const EXCEL_HEADER_FILL = "FF1F4E79"; // dark navy, matches your prospect-master workbooks
  const EXCEL_HEADER_FONT = "FFFFFFFF";
  const EXCEL_TITLE_FILL = "FF14304D"; // deeper navy banner
  const EXCEL_SUBTITLE_FILL = "FFEAF1FB"; // pale blue strip
  const EXCEL_GRID_BORDER = "FFD9E1EC";
  const ZEBRA_FILL = "FFF4F8FC"; // very light blue-gray band
  const CATEGORY_FILL = "FFEFF4FC";
  const CATEGORY_FONT = "FF1F4E79";

  const PRIORITY_FILL = {
    high: "FFF8D7DA",
    medium: "FFFFF3CD",
    low: "FFE2E3E5",
  };
  const PRIORITY_FONT = {
    high: "FF842029",
    medium: "FF664D03",
    low: "FF41464B",
  };
  const PRIORITY_BORDER = {
    high: "FFDC7C87",
    medium: "FFE0C46A",
    low: "FFB6BCC2",
  };

  const EXCEL_COLUMNS = [
    { header: "Timestamp", key: "Timestamp", width: 20 },
    { header: "Source", key: "Source", width: 12 },
    { header: "Company ID", key: "CompanyID", width: 12 },
    { header: "Company Name", key: "CompanyName", width: 30 },
    { header: "Company Category", key: "CompanyCategory", width: 24 },
    { header: "Company Needs", key: "CompanyNeeds", width: 40 },
    { header: "Top Priority", key: "TopPriority", width: 14 },
    { header: "Summary", key: "Summary", width: 55 },
    { header: "Detailed Report", key: "DetailedReport", width: 70 },
    { header: "Verified Findings", key: "VerifiedFindings", width: 40 },
    { header: "Inferred Findings", key: "InferredFindings", width: 40 },
    { header: "Assumptions", key: "Assumptions", width: 40 },
    { header: "Pain Points / Gaps", key: "PainPoints", width: 45 },
    { header: "Recommended Services", key: "RecommendedServices", width: 45 },
    { header: "Proposal Topics", key: "ProposalTopics", width: 40 },
    { header: "Pricing Tier", key: "RecommendedPricingTier", width: 20 },
    { header: "Proposal Intro", key: "ProposalIntro", width: 45 },
    { header: "Web Sources", key: "WebSources", width: 40 },
    { header: "AI Model", key: "Model", width: 18 },
  ];

  // Columns that get centered, non-wrapped treatment (short categorical values).
  const CENTERED_COLUMNS = new Set(["Source", "CompanyID", "TopPriority", "RecommendedPricingTier", "Model"]);
  const WRAPPED_COLUMNS = new Set([
    "CompanyNeeds",
    "Summary",
    "DetailedReport",
    "VerifiedFindings",
    "InferredFindings",
    "Assumptions",
    "PainPoints",
    "RecommendedServices",
    "ProposalTopics",
    "ProposalIntro",
    "WebSources",
  ]);

  const LAST_COL_LETTER = String.fromCharCode(64 + EXCEL_COLUMNS.length); // works while <= 26 cols
  const HEADER_ROW_NUMBER = 3; // row 1 = title banner, row 2 = subtitle strip, row 3 = header

  function thinBorder(colorArgb) {
    const side = { style: "thin", color: { argb: colorArgb } };
    return { top: side, bottom: side, left: side, right: side };
  }

  function styleTitleBanner(sheet) {
    sheet.mergeCells(`A1:${LAST_COL_LETTER}1`);
    const titleCell = sheet.getCell("A1");
    titleCell.value = EXCEL_TITLE;
    titleCell.font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
    titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: EXCEL_TITLE_FILL } };
    titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    sheet.getRow(1).height = 32;

    sheet.mergeCells(`A2:${LAST_COL_LETTER}2`);
    const subtitleCell = sheet.getCell("A2");
    subtitleCell.value = `${EXCEL_SUBTITLE}  •  Generated ${new Date().toLocaleString()}`;
    subtitleCell.font = { italic: true, size: 10, color: { argb: "FF4A5A70" } };
    subtitleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: EXCEL_SUBTITLE_FILL } };
    subtitleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    sheet.getRow(2).height = 18;
  }

  function refreshSubtitleTimestamp(sheet) {
    try {
      const cell = sheet.getCell("A2");
      if (cell && typeof cell.value === "string" && cell.value.includes(EXCEL_SUBTITLE)) {
        cell.value = `${EXCEL_SUBTITLE}  •  Last synced ${new Date().toLocaleString()}`;
      }
    } catch (_) {
      /* cosmetic only — never block a write over this */
    }
  }

  // Writes the header row's text values (must always succeed — this is what
  // getHeaderRowNumber()/readExcelLogPreview() key off of) separately from
  // its fill/border/font styling (cosmetic — wrapped in try/catch by the
  // caller so a styling quirk in a given ExcelJS/Node setup never blocks
  // the actual research data from being written).
  function writeHeaderValues(sheet) {
    const headerRow = sheet.getRow(HEADER_ROW_NUMBER);
    EXCEL_COLUMNS.forEach((col, i) => {
      headerRow.getCell(i + 1).value = col.header;
    });
  }

  function styleHeaderRow(sheet) {
    const headerRow = sheet.getRow(HEADER_ROW_NUMBER);
    headerRow.height = 26;
    EXCEL_COLUMNS.forEach((col, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = col.header;
      cell.font = { bold: true, color: { argb: EXCEL_HEADER_FONT }, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: EXCEL_HEADER_FILL } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = {
        ...thinBorder("FF16324A"),
        bottom: { style: "medium", color: { argb: "FF0D1F30" } },
      };
    });
    // Freeze the header row only. Freezing rows + columns together
    // (xSplit + ySplit) tripped a serialization bug on some ExcelJS
    // versions ("Cannot read properties of undefined (reading 'sheets')")
    // when writing the file — row-only freeze is the well-tested pattern.
    sheet.views = [{ state: "frozen", ySplit: HEADER_ROW_NUMBER }];
  }

  function getHeaderRowNumber(sheet) {
    try {
      return sheet.getCell("A1").value === EXCEL_TITLE ? HEADER_ROW_NUMBER : 1;
    } catch (_) {
      return 1;
    }
  }

  function applyAutoFilter(sheet) {
    try {
      const headerRowNumber = getHeaderRowNumber(sheet);
      sheet.autoFilter = { from: `A${headerRowNumber}`, to: `${LAST_COL_LETTER}${headerRowNumber}` };
    } catch (err) {
      console.warn("[RESEARCH] Excel autofilter styling skipped:", err.message);
    }
  }

  async function openOrCreateWorkbook() {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "OrbitAvanya CRM — AI Company Research";
    workbook.created = new Date();
    let sheet;
    if (fs.existsSync(SAFE_MASTER_PATH)) {
      await workbook.xlsx.readFile(SAFE_MASTER_PATH);
      sheet = workbook.getWorksheet(EXCEL_SHEET_NAME) || workbook.worksheets[0];
    }
    const columnDefs = EXCEL_COLUMNS.map((c) => ({ key: c.key, width: c.width }));
    if (!sheet) {
      sheet = workbook.addWorksheet(EXCEL_SHEET_NAME);
      sheet.columns = columnDefs;
      writeHeaderValues(sheet);
      // Cosmetic styling (banner, colors, borders, frozen panes) is
      // best-effort: if any of it throws on this environment's ExcelJS
      // version, the sheet still has correct columns + header text and
      // the research data write below will still succeed.
      try {
        styleTitleBanner(sheet);
      } catch (err) {
        console.warn("[RESEARCH] Excel title banner styling skipped:", err.message);
      }
      try {
        styleHeaderRow(sheet);
      } catch (err) {
        console.warn("[RESEARCH] Excel header styling skipped:", err.message);
      }
    } else if (sheet.columns?.length !== EXCEL_COLUMNS.length) {
      // Older log with a different column shape (e.g. written before the
      // Company Category / fact-type columns existed). Reassigning
      // sheet.columns on a sheet that already has rows would just relabel
      // the existing column letters — the OLD data would silently end up
      // sitting under the NEW headers in the wrong places. Instead: keep
      // the old sheet exactly as-is under its own tab, and start a fresh,
      // correctly-shaped sheet for everything going forward.
      const legacyName = `${EXCEL_SHEET_NAME} (legacy ${new Date().toISOString().slice(0, 10)})`.slice(0, 31);
      if (!workbook.getWorksheet(legacyName)) {
        sheet.name = legacyName;
      }
      sheet = workbook.addWorksheet(EXCEL_SHEET_NAME);
      sheet.columns = columnDefs;
      writeHeaderValues(sheet);
      try {
        styleTitleBanner(sheet);
      } catch (err) {
        console.warn("[RESEARCH] Excel title banner styling skipped:", err.message);
      }
      try {
        styleHeaderRow(sheet);
      } catch (err) {
        console.warn("[RESEARCH] Excel header styling skipped:", err.message);
      }
    } else {
      refreshSubtitleTimestamp(sheet);
    }
    return { workbook, sheet };
  }

  function addStyledRow(sheet, row) {
    // The data itself must always be written, regardless of whether the
    // cosmetic styling below succeeds on this particular ExcelJS/Node setup.
    const excelRow = sheet.addRow(row);
    try {
      const priority = String(row.TopPriority || "").toLowerCase();
      // Zebra banding: alternate light-blue / white bands for readability,
      // computed from data-row position (rows below the title + header,
      // whichever layout this sheet actually uses — new banner or legacy).
      const headerRowNumber = getHeaderRowNumber(sheet);
      const dataRowIndex = excelRow.number - headerRowNumber; // 1-based within data
      const isBanded = dataRowIndex % 2 === 0;

      excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const colKey = EXCEL_COLUMNS[colNumber - 1]?.key;
        const isCentered = CENTERED_COLUMNS.has(colKey);
        const isWrapped = WRAPPED_COLUMNS.has(colKey);

        cell.alignment = {
          vertical: isWrapped ? "top" : "middle",
          horizontal: isCentered ? "center" : isWrapped ? "left" : "left",
          wrapText: isWrapped,
        };
        cell.border = thinBorder(EXCEL_GRID_BORDER);

        if (colKey === "CompanyID") {
          cell.numFmt = "0";
        }

        if (colKey === "CompanyCategory" && row.CompanyCategory) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CATEGORY_FILL } };
          cell.font = { bold: true, color: { argb: CATEGORY_FONT }, size: 10 };
          cell.alignment = { ...cell.alignment, horizontal: "center" };
        } else if (colKey === "TopPriority" && priority && PRIORITY_FILL[priority]) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PRIORITY_FILL[priority] } };
          cell.font = { bold: true, color: { argb: PRIORITY_FONT[priority] }, size: 10.5 };
          cell.border = thinBorder(PRIORITY_BORDER[priority]);
        } else if (isBanded) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA_FILL } };
        }
      });
      excelRow.height = 60;
    } catch (err) {
      console.warn("[RESEARCH] Excel row styling skipped (data was still saved):", err.message);
    }
    return excelRow;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function writeWorkbookSafely(workbook) {
    fs.mkdirSync(path.dirname(SAFE_MASTER_PATH), { recursive: true });
    const tmpPath = `${SAFE_MASTER_PATH}.tmp-${process.pid}-${Date.now()}.xlsx`;
    await workbook.xlsx.writeFile(tmpPath);

    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        fs.renameSync(tmpPath, SAFE_MASTER_PATH);
        mirrorToVisiblePath();
        return { written: true, path: SAFE_MASTER_PATH, visible_path: EXCEL_LOG_PATH };
      } catch (err) {
        // Local-disk %LOCALAPPDATA% essentially never locks like this, but
        // keep the retry for safety (antivirus scanners, etc.).
        const locked = err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES";
        if (!locked || attempt === maxAttempts) {
          const fallbackPath = SAFE_MASTER_PATH.replace(/\.xlsx$/i, `_${Date.now()}.xlsx`);
          try {
            fs.renameSync(tmpPath, fallbackPath);
          } catch (_) {
            /* best effort */
          }
          return {
            written: false,
            reason: locked
              ? "The Excel log is currently open in Excel (or another program) and locked for writing. Please close company_research_log.xlsx and re-run — this research was still saved to the database and to a backup file."
              : err.message,
            fallback_path: fs.existsSync(fallbackPath) ? fallbackPath : undefined,
          };
        }
        await sleep(400 * attempt);
      }
    }
    return { written: false, reason: "Unknown error writing Excel log." };
  }

  async function appendToExcelLog(row) {
    if (!ExcelJS) {
      console.error("[RESEARCH] 'exceljs' package not installed — skipping Excel log. Run: npm install exceljs");
      return { written: false, reason: "exceljs package not installed" };
    }
    try {
      const { workbook, sheet } = await openOrCreateWorkbook();
      addStyledRow(sheet, row);
      applyAutoFilter(sheet);
      const result = await writeWorkbookSafely(workbook);
      const headerOffset = getHeaderRowNumber(sheet);
      return { ...result, total_rows: Math.max(0, sheet.rowCount - headerOffset) };
    } catch (err) {
      console.error("[RESEARCH] Failed to write styled Excel log:", err.stack || err.message);
      // Last-resort fallback: a completely bare workbook with no custom
      // styling/merges/frozen-panes at all, so a single research run is
      // never silently lost even if something in the styled write path is
      // incompatible with the installed ExcelJS/Node version.
      try {
        const bareResult = await appendToExcelLogBare(row);
        if (bareResult.written) {
          console.warn(
            "[RESEARCH] Wrote Excel log in plain fallback mode (styling skipped) after the styled write failed above."
          );
        }
        return bareResult;
      } catch (fallbackErr) {
        console.error("[RESEARCH] Plain fallback Excel write also failed:", fallbackErr.stack || fallbackErr.message);
        return { written: false, reason: err.message };
      }
    }
  }

  // Minimal, no-frills append used only when the fully-styled write above
  // throws — same well-tested pattern ExcelJS's own docs use (columns with
  // a `header` property so it writes row 1 for us, no merges, no custom
  // views). If the on-disk file itself can't even be read, starts fresh
  // rather than losing this research run.
  async function appendToExcelLogBare(row) {
    const workbook = new ExcelJS.Workbook();
    let sheet;
    if (fs.existsSync(SAFE_MASTER_PATH)) {
      try {
        await workbook.xlsx.readFile(SAFE_MASTER_PATH);
        sheet = workbook.getWorksheet(EXCEL_SHEET_NAME) || workbook.worksheets[0];
      } catch (_) {
        sheet = undefined;
      }
    }
    if (!sheet) {
      sheet = workbook.addWorksheet(EXCEL_SHEET_NAME);
      sheet.columns = EXCEL_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    }
    sheet.addRow(row);
    const result = await writeWorkbookSafely(workbook);
    return { ...result, total_rows: Math.max(0, sheet.rowCount - 1) };
  }

  // Used by /export/sync-all: replaces the ENTIRE data section of the log
  // with exactly the given rows (one per currently-latest research run).
  // Unlike appendToExcelLog (which adds one row on top of whatever's
  // already there and can accumulate duplicates if you sync the same
  // company repeatedly), this always produces a clean 1-row-per-company
  // sheet, safe to run as many times as you like.
  async function rebuildExcelLog(rows) {
    if (!ExcelJS) {
      console.error("[RESEARCH] 'exceljs' package not installed — skipping Excel log. Run: npm install exceljs");
      return { written: false, reason: "exceljs package not installed" };
    }
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "OrbitAvanya CRM — AI Company Research";
      workbook.created = new Date();
      const sheet = workbook.addWorksheet(EXCEL_SHEET_NAME);
      sheet.columns = EXCEL_COLUMNS.map((c) => ({ key: c.key, width: c.width }));
      writeHeaderValues(sheet);
      try {
        styleTitleBanner(sheet);
      } catch (err) {
        console.warn("[RESEARCH] Excel title banner styling skipped:", err.message);
      }
      try {
        styleHeaderRow(sheet);
      } catch (err) {
        console.warn("[RESEARCH] Excel header styling skipped:", err.message);
      }
      rows.forEach((row) => addStyledRow(sheet, row));
      applyAutoFilter(sheet);
      const result = await writeWorkbookSafely(workbook);
      return { ...result, total_rows: rows.length };
    } catch (err) {
      console.error("[RESEARCH] Failed to rebuild Excel log:", err.stack || err.message);
      return { written: false, reason: err.message };
    }
  }

  // Last N rows of the log as plain JSON, so the UI can show a live preview
  // without forcing a download every time ("auto update so i can see it").
  async function readExcelLogPreview(limit = 20) {
    if (!ExcelJS || !fs.existsSync(SAFE_MASTER_PATH)) return [];
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(SAFE_MASTER_PATH);
      const sheet = workbook.getWorksheet(EXCEL_SHEET_NAME) || workbook.worksheets[0];
      if (!sheet) return [];
      const headerOffset = getHeaderRowNumber(sheet);
      const rows = [];
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber <= headerOffset) return;
        const obj = {};
        EXCEL_COLUMNS.forEach((col, i) => {
          obj[col.key] = row.getCell(i + 1).value ?? "";
        });
        rows.push(obj);
      });
      return rows.slice(-limit).reverse();
    } catch (err) {
      console.error("[RESEARCH] Failed to read Excel log preview:", err.message);
      return [];
    }
  }

  /* ---------------- Turn research into proposal template fields ----------------
     server.js's proposal generator merges any `overrides` object straight into
     the template as {{UPPERCASE_KEY}} tokens (see novaCrmBuildProposalTemplateData
     in server.js). So the keys below are exactly the tokens you can drop into
     your template HTML — e.g. {{AI_PROPOSAL_INTRO}}, {{AI_PROPOSED_PRICE}}. */

  async function buildTemplateOverrides(research) {
    const services = Array.isArray(research.recommended_services) ? research.recommended_services : [];
    const topService = services.find((s) => s.priority === "high") || services[0] || null;

    let matchedCatalogRow = null;
    if (topService?.service_name) {
      try {
        const catalog = await loadCatalog();
        const wanted = String(topService.service_name).toLowerCase();
        matchedCatalogRow =
          catalog.find((row) => String(row.service_name).toLowerCase() === wanted) ||
          catalog.find((row) => String(row.service_name).toLowerCase().includes(wanted) || wanted.includes(String(row.service_name).toLowerCase())) ||
          null;
      } catch (_) {
        matchedCatalogRow = null;
      }
    }

    return {
      AI_SUMMARY: research.summary || "",
      AI_DETAILED_REPORT: research.detailed_report || "",
      AI_PAIN_POINTS: (research.pain_points || []).map((p) => `• ${p}`).join("\n"),
      AI_RECOMMENDED_SERVICES: services.map((s) => `${s.service_name} (${s.priority}) — ${s.reason}`).join("\n"),
      AI_TOP_SERVICE: topService?.service_name || "",
      AI_PRICING_TIER: research.recommended_pricing_tier || "",
      AI_PROPOSAL_INTRO: research.proposal_intro || "",
      AI_PROPOSED_PRICE: matchedCatalogRow
        ? `${currencySymbol(matchedCatalogRow.currency)}${matchedCatalogRow.starting_price}`
        : "",
      AI_PROPOSED_DELIVERY_TIME: matchedCatalogRow?.delivery_time || "",
      AI_PROPOSED_AMC: matchedCatalogRow?.amc || "",
    };
  }

  /* ---------------- Routes ---------------- */

  router.post("/generate", managerGuard, async (req, res) => {
    try {
      const source = req.body?.source === "tender" ? "tender" : "customer";
      const id = Number(req.body?.id);
      if (!id) return res.status(400).json({ message: "A valid company id is required." });

      const company = await loadCompany(source, id);
      if (!company) return res.status(404).json({ message: "Company not found." });

      const catalog = await loadCatalog();
      const profile = await loadCompanyProfile();
      const webContext = await gatherWebContext(company.company_name);

      const companyBrief = summarizeCompanyForPrompt(source, company);
      const catalogBrief = summarizeCatalogForPrompt(catalog);
      const aboutUsBrief = summarizeCompanyProfileForPrompt(profile);

      const systemPrompt = `You are a senior B2B pre-sales research analyst working for the company described in "ABOUT US" below. You research a prospect company using the CRM data given to you, PLUS the live web search results provided below when available. Only state something as fact if it's in the CRM data or the search results — if the search results are empty or don't cover something, say so or reason generically from industry knowledge instead of inventing specifics (exact revenue, headcount, recent news, etc.).

ABOUT US (the company you work for and are pitching on behalf of):
${aboutUsBrief}

IMPORTANT FRAMING RULE: if the prospect is itself a large, capable technology/consulting company, do NOT claim they "lack" core technology capabilities (e.g. don't say a major IT services firm "lacks AI" or "lacks cloud"). Instead frame findings as "potential gaps / partner opportunities" — specific, scoped work packages, delivery capacity, or specialized components where we can complement their existing capability. Be honest and realistic either way.

Your job is to write a LONG, thorough, ChatGPT-style research report — not a few short bullet points. Aim for genuine depth: multiple sections, each with real substance (a paragraph or two, not a one-liner). Write it the way a sharp pre-sales consultant would write an internal briefing document, similar in depth and structure to this shape:

1. Company overview — 1-2 solid paragraphs on what the prospect does, their market position, who they likely serve, and anything concrete from the live search results.
2. Potential gaps / opportunities — 5-10 numbered findings. For EACH one, write: a clear title, a priority (HIGH/MEDIUM/LOW), a "Potential gap" paragraph explaining the opportunity in real detail (not just a phrase), and a "How we can help" paragraph or bullet list naming which of OUR services apply and why, drawn only from the service catalog below.
3. Strongest overall finding — a short summary paragraph giving the single clearest positioning statement for this prospect.
4. Where we fit best — a simple mapping of "Their need -> Our solution" pairs (as short lines), covering the top opportunities.
5. Top services to lead with — a ranked short list (3-5) of which catalog services to lead the proposal with, and why.

Write in full sentences and paragraphs, not sparse fragments. This report is going to be read directly by a person preparing a proposal, so it should feel complete and information-dense, not skeletal.

DATA QUALITY — tag every finding honestly:
- "verified": stated directly in the live web search results or the CRM data given to you.
- "inferred": a reasonable conclusion drawn from verified facts + general industry knowledge, but not itself directly stated anywhere.
- "assumption": a working guess made because information was missing — flag these clearly, do not present them as fact.
Never upgrade an assumption to "verified" just because it sounds plausible.

Respond with ONLY a JSON object matching this exact shape (all long-form string fields should contain plain text/markdown, using markdown headings "##"/"###", bold "**text**", and "-" bullet lists where useful for structure):
{
  "summary": "string - 1-2 paragraph company overview",
  "company_category": "string - a short, concrete classification of what this company IS, e.g. 'Software Product Company', 'Government Department', 'Manufacturing / Industrial Distributor', 'Healthcare Provider', 'Logistics & Supply Chain', 'Educational Institution' etc.",
  "company_needs_summary": "string - 2-4 sentences in plain language on what this company most likely needs from a technology/services partner right now, independent of our specific catalog",
  "detailed_report": "string - the FULL long-form markdown report covering sections 2-5 above in depth",
  "findings": [
    { "title": "string - short finding title", "body": "string - 1-3 sentences of detail", "fact_type": "verified" | "inferred" | "assumption", "priority": "high" | "medium" | "low" }
  ],
  "pain_points": ["string", "... 5-10 short restatements of the gap titles, for quick scanning"],
  "pain_points_detailed": [
    { "title": "string", "description": "string - 1-3 sentences", "priority": "high" | "medium" | "low", "related_finding": "string - must exactly match a findings[].title above, or omit" }
  ],
  "recommended_services": [
    { "service_name": "string - must match a name from OUR SERVICE CATALOG where possible", "reason": "string - one to two sentences", "priority": "high" | "medium" | "low", "related_pain_point": "string - must exactly match a pain_points_detailed[].title above, or omit" }
  ],
  "proposal_topics": [
    { "topic": "string - a concrete proposal title/angle, e.g. 'Supply Chain Inventory Optimization Platform'", "type": "string - e.g. 'Service Proposal', 'Solution Proposal', 'Modernization Proposal', 'Pilot/POC Proposal'", "pitch": "string - 1-2 sentence pitch for this proposal", "related_service": "string - must exactly match a recommended_services[].service_name above, or omit" }
  ],
  "recommended_pricing_tier": "string",
  "proposal_intro": "string - 3-5 sentence proposal-ready introduction paragraph, written as if it's from us, to them"
}`;

      const userPrompt = `PROSPECT COMPANY DATA (from our CRM):\n${companyBrief}\n\nLIVE WEB SEARCH RESULTS${webContext.text ? "" : " (none found — reason from the CRM data and general knowledge instead)"}:\n${webContext.text || "(no results)"}\n\nOUR SERVICE CATALOG:\n${catalogBrief}`;

      const raw = await callLlm([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);

      const parsed = safeParseJson(raw);

      // Dedup: this run becomes the one current record for this company;
      // the previous current record (if any) is kept for history but no
      // longer flagged as latest.
      await pool.query(
        `UPDATE company_research SET is_latest = FALSE WHERE source = $1 AND company_id = $2 AND is_latest = TRUE`,
        [source, id]
      );

      const dbResult = await pool.query(
        `INSERT INTO company_research
          (source, company_id, company_name, summary, pain_points, recommended_services, recommended_pricing_tier, proposal_intro, raw_response, model, web_sources, detailed_report, is_latest, company_category, company_needs_summary)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9::jsonb,$10,$11::jsonb,$12,TRUE,$13,$14)
         RETURNING *`,
        [
          source,
          id,
          company.company_name,
          parsed.summary || null,
          JSON.stringify(parsed.pain_points || []),
          JSON.stringify(parsed.recommended_services || []),
          parsed.recommended_pricing_tier || null,
          parsed.proposal_intro || null,
          JSON.stringify(parsed),
          AI_MODEL,
          JSON.stringify(webContext.sources || []),
          parsed.detailed_report || null,
          parsed.company_category || null,
          parsed.company_needs_summary || null,
        ]
      );

      const researchRow = dbResult.rows[0];

      // Persist the normalized chain: Finding -> Pain Point -> Matching
      // Service+Reason (Opportunity) -> Proposal Recommendation, plus
      // sources — alongside the JSONB columns above.
      await insertNormalizedResearch(researchRow.id, parsed, catalog);
      if (Array.isArray(webContext.sources) && webContext.sources.length) {
        try {
          await Promise.all(
            webContext.sources.map((s, i) =>
              pool.query(
                `INSERT INTO research_sources (research_run_id, title, url, sort_order) VALUES ($1,$2,$3,$4)`,
                [researchRow.id, s.title || null, s.url || null, i]
              )
            )
          );
        } catch (err) {
          console.error("[RESEARCH] Failed to persist sources:", err.message);
        }
      }

      const services = Array.isArray(parsed.recommended_services) ? parsed.recommended_services : [];
      const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
      const proposalTopics = Array.isArray(parsed.proposal_topics) ? parsed.proposal_topics : [];
      const topPriority =
        (services.find((s) => s.priority === "high") ||
          services.find((s) => s.priority === "medium") ||
          services[0] || {}
        ).priority || "";

      const excelResult = await appendToExcelLog({
        Timestamp: new Date().toISOString(),
        Source: source,
        CompanyID: id,
        CompanyName: company.company_name,
        CompanyCategory: parsed.company_category || "",
        CompanyNeeds: parsed.company_needs_summary || "",
        TopPriority: topPriority,
        Summary: parsed.summary || "",
        DetailedReport: parsed.detailed_report || "",
        VerifiedFindings: findings.filter((f) => f.fact_type === "verified").map((f) => f.title).join(" | "),
        InferredFindings: findings.filter((f) => f.fact_type === "inferred").map((f) => f.title).join(" | "),
        Assumptions: findings.filter((f) => f.fact_type === "assumption").map((f) => f.title).join(" | "),
        PainPoints: (parsed.pain_points || []).join(" | "),
        RecommendedServices: services
          .map((s) => `${s.service_name} (${s.priority || "?"}): ${s.reason || ""}`)
          .join(" | "),
        ProposalTopics: proposalTopics.map((t) => `${t.topic} [${t.type || "Proposal"}]`).join(" | "),
        RecommendedPricingTier: parsed.recommended_pricing_tier || "",
        ProposalIntro: parsed.proposal_intro || "",
        WebSources: (webContext.sources || []).map((s) => s.url).join(" | "),
        Model: AI_MODEL,
      });

      if (!excelResult.written) {
        console.warn("[RESEARCH] Excel log not updated:", excelResult.reason);
      }

      await logExcelExport({
        researchRunId: researchRow.id,
        exportType: "auto_append",
        exportedBy: req.researchActor?.email || req.researchActor?.name || null,
        rowCount: excelResult.total_rows,
        filePath: excelResult.path || excelResult.fallback_path || null,
        written: excelResult.written,
        failureReason: excelResult.reason,
      });

      const templateOverrides = await buildTemplateOverrides(researchRow);
      const fullResearch = await attachNormalizedData(researchRow);

      return res.json({
        research: fullResearch,
        template_overrides: templateOverrides,
        excel: excelResult,
      });
    } catch (err) {
      console.error("[RESEARCH GENERATE]", err);
      return res.status(500).json({
        message: err.message || "Failed to generate research.",
        error: err.message,
      });
    }
  });

  // Latest saved research for a company (so the Proposal editor / AI
  // Assistant can show "already researched" results without re-running).
  //
  // IMPORTANT: /export/excel and /export/preview below MUST be registered
  // before this route. Express matches routes in registration order, and
  // "/:source/:id" matches literally any two-segment path — including
  // "/export/excel" (source="export", id="excel"). That's exactly the bug
  // that caused every download/preview request to 400 with "A valid
  // company id is required." instead of ever reaching its real handler.
  router.get("/export/excel", managerGuard, async (req, res) => {
    console.log(
      `[RESEARCH] /export/excel — pid ${process.pid}, checking master at:`,
      SAFE_MASTER_PATH,
      "| visible mirror at:",
      EXCEL_LOG_PATH
    );
    if (!fs.existsSync(SAFE_MASTER_PATH)) {
      // Help diagnose the classic "it says logged but download 404s" case —
      // usually two different backend processes ended up serving requests
      // (e.g. an old process still bound to a port from before a restart).
      let hint = "";
      try {
        const last = await pool.query(
          `SELECT file_path, exported_at FROM excel_export_log ORDER BY exported_at DESC LIMIT 1`
        );
        if (last.rows[0]?.file_path) {
          hint = ` The last successful write (per the database) went to: ${last.rows[0].file_path} at ${last.rows[0].exported_at}. If that's a different machine/process than pid ${process.pid} answering this request now, you likely have two backend processes running — stop all node processes for this project and start it fresh.`;
        }
      } catch (_) {
        /* best effort diagnostic only */
      }
      return res.status(404).json({
        message: `No research has been logged yet (checked ${SAFE_MASTER_PATH}).${hint}`,
      });
    }
    logExcelExport({
      exportType: "manual_download",
      exportedBy: req.researchActor?.email || req.researchActor?.name || null,
      filePath: SAFE_MASTER_PATH,
      written: true,
    });
    return res.download(SAFE_MASTER_PATH, "company_research_log.xlsx");
  });

  // Last N rows of the log for an in-app preview, no download needed.
  router.get("/export/preview", managerGuard, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const rows = await readExcelLogPreview(limit);
    return res.json({ rows });
  });

  // Push EVERY company's latest research into the Excel log in one go —
  // for catching up companies that were researched before the log existed,
  // or ones only ever viewed (cached) rather than freshly generated/synced
  // individually. Rebuilds the log's data rows from scratch each time from
  // company_research (source of truth), so it never ends up with
  // duplicates no matter how many times you run it.
  router.post("/export/sync-all", managerGuard, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM company_research WHERE is_latest = TRUE ORDER BY company_name ASC`
      );
      const researchRows = result.rows;
      if (researchRows.length === 0) {
        return res.json({ excel: { written: false, reason: "No research found yet." }, synced: 0 });
      }

      const excelRows = [];
      for (const researchRow of researchRows) {
        const full = await attachNormalizedData(researchRow);
        excelRows.push(buildExcelRowFromResearch(researchRow.source, researchRow.company_id, full));
      }

      const excelResult = await rebuildExcelLog(excelRows);

      if (!excelResult.written) {
        console.warn("[RESEARCH SYNC-ALL] Excel log not updated:", excelResult.reason);
      }

      await logExcelExport({
        exportType: "auto_append",
        exportedBy: req.researchActor?.email || req.researchActor?.name || null,
        rowCount: excelResult.total_rows,
        filePath: excelResult.path || excelResult.fallback_path || null,
        written: excelResult.written,
        failureReason: excelResult.reason,
      });

      return res.json({ excel: excelResult, synced: excelRows.length });
    } catch (err) {
      console.error("[RESEARCH SYNC-ALL]", err);
      return res.status(500).json({ message: err.message || "Failed to sync all research to Excel.", error: err.message });
    }
  });

  router.get("/:source/:id", managerGuard, async (req, res) => {
    try {
      const source = req.params.source === "tender" ? "tender" : "customer";
      const id = Number(req.params.id);
      if (!id || Number.isNaN(id)) {
        return res.status(400).json({ message: "A valid company id is required." });
      }
      const result = await pool.query(
        `SELECT * FROM company_research
         WHERE source = $1 AND company_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [source, id]
      );
      if (!result.rows[0]) return res.status(404).json({ message: "No research saved yet for this company." });
      const templateOverrides = await buildTemplateOverrides(result.rows[0]);
      const fullResearch = await attachNormalizedData(result.rows[0]);
      return res.json({ research: fullResearch, template_overrides: templateOverrides });
    } catch (err) {
      console.error("[RESEARCH GET]", err);
      return res.status(500).json({ message: err.message || "Failed to load research.", error: err.message });
    }
  });

  // Every research run ever done for a company (history).
  router.get("/:source/:id/history", managerGuard, async (req, res) => {
    try {
      const source = req.params.source === "tender" ? "tender" : "customer";
      const id = Number(req.params.id);
      if (!id || Number.isNaN(id)) {
        return res.status(400).json({ message: "A valid company id is required." });
      }
      const result = await pool.query(
        `SELECT * FROM company_research WHERE source = $1 AND company_id = $2 ORDER BY created_at DESC`,
        [source, id]
      );
      return res.json({ history: result.rows });
    } catch (err) {
      console.error("[RESEARCH HISTORY]", err);
      return res.status(500).json({ message: err.message || "Failed to load research history.", error: err.message });
    }
  });

  // Manually (re)sync a company's most recent saved research into the Excel
  // log — for research that was generated before this row existed in the
  // log, or if a row needs refreshing without re-running the AI. This is
  // the explicit "Sync" button in the UI, distinct from the automatic
  // append that already happens at the end of every /generate call.
  // Shared by the single-company sync route and the "sync everything" bulk
  // route below — turns one company_research row (with its normalized
  // findings/services/etc already attached) into the flat object the Excel
  // log expects.
  function buildExcelRowFromResearch(source, id, full) {
    const services = Array.isArray(full.recommended_services) ? full.recommended_services : [];
    const findings = Array.isArray(full.findings) ? full.findings : [];
    const proposalTopics = Array.isArray(full.proposal_topics) ? full.proposal_topics : [];
    const topPriority =
      (services.find((s) => s.priority === "high") ||
        services.find((s) => s.priority === "medium") ||
        services[0] || {}
      ).priority || "";
    const sources = Array.isArray(full.sources) ? full.sources : Array.isArray(full.web_sources) ? full.web_sources : [];

    return {
      Timestamp: full.created_at ? new Date(full.created_at).toISOString() : new Date().toISOString(),
      Source: source,
      CompanyID: id,
      CompanyName: full.company_name,
      CompanyCategory: full.company_category || "",
      CompanyNeeds: full.company_needs_summary || "",
      TopPriority: topPriority,
      Summary: full.summary || "",
      DetailedReport: full.detailed_report || "",
      VerifiedFindings: findings.filter((f) => f.fact_type === "verified").map((f) => f.title).join(" | "),
      InferredFindings: findings.filter((f) => f.fact_type === "inferred").map((f) => f.title).join(" | "),
      Assumptions: findings.filter((f) => f.fact_type === "assumption").map((f) => f.title).join(" | "),
      PainPoints: Array.isArray(full.pain_points) ? full.pain_points.join(" | ") : "",
      RecommendedServices: services
        .map((s) => `${s.service_name} (${s.priority || "?"}): ${s.reason || ""}`)
        .join(" | "),
      ProposalTopics: proposalTopics
        .map((t) => `${t.proposal_topic || t.topic} [${t.proposal_type || t.type || "Proposal"}]`)
        .join(" | "),
      RecommendedPricingTier: full.recommended_pricing_tier || "",
      ProposalIntro: full.proposal_intro || "",
      WebSources: sources.map((s) => s.url).filter(Boolean).join(" | "),
      Model: full.model || AI_MODEL,
    };
  }

  router.post("/:source/:id/sync-excel", managerGuard, async (req, res) => {
    try {
      const source = req.params.source === "tender" ? "tender" : "customer";
      const id = Number(req.params.id);
      if (!id || Number.isNaN(id)) {
        return res.status(400).json({ message: "A valid company id is required." });
      }
      const result = await pool.query(
        `SELECT * FROM company_research WHERE source = $1 AND company_id = $2 ORDER BY created_at DESC LIMIT 1`,
        [source, id]
      );
      const researchRow = result.rows[0];
      if (!researchRow) {
        return res.status(404).json({ message: "No research saved yet for this company — run research first." });
      }
      const full = await attachNormalizedData(researchRow);
      const excelResult = await appendToExcelLog(buildExcelRowFromResearch(source, id, full));

      if (!excelResult.written) {
        console.warn("[RESEARCH SYNC] Excel log not updated:", excelResult.reason);
      }

      await logExcelExport({
        researchRunId: researchRow.id,
        exportType: "auto_append",
        exportedBy: req.researchActor?.email || req.researchActor?.name || null,
        rowCount: excelResult.total_rows,
        filePath: excelResult.path || excelResult.fallback_path || null,
        written: excelResult.written,
        failureReason: excelResult.reason,
      });

      return res.json({ excel: excelResult });
    } catch (err) {
      console.error("[RESEARCH SYNC]", err);
      return res.status(500).json({ message: err.message || "Failed to sync to Excel.", error: err.message });
    }
  });

  console.log(
    `[RESEARCH] Router initialized — pid ${process.pid}. Excel master (source of truth): ${SAFE_MASTER_PATH} | Visible mirror: ${EXCEL_LOG_PATH}`
  );

  return router;
}

module.exports = { createResearchRouter };