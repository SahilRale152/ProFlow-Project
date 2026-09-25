const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { createPoolFromEnv } = require("./db");
const { injectEmailTracking, startTrackingEventsPoller } = require("./lib/emailTracking");
const OpenAI = require("openai");
const PDFDocument = require("pdfkit");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
let Razorpay = null;
try {
  Razorpay = require("razorpay");
} catch (_) {
  // Package not installed yet — payment routes below stay disabled
  // (they respond 400) until `npm install razorpay` is run.
}
require("dotenv").config();

const app = express();
app.use(cors());

// Optional file upload used only by the Communications "Send email" flow.
const emailAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});
// `verify` stashes the exact request bytes on req.rawBody. Razorpay's webhook
// signature is computed over the raw JSON body, so the parsed req.body alone
// (re-serialized) is not guaranteed to match byte-for-byte and would fail
// signature checks intermittently.
app.use(express.json({
  limit: "25mb",
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

/* ============================================================
   Admin/runtime diagnostics
   - Keeps a small rolling text log for cPanel/local diagnostics.
   - The Admin page can read the latest entries without needing
     access to the VS Code terminal.
   ============================================================ */
const RUNTIME_LOG_DIR = process.env.RUNTIME_LOG_DIR || path.join(__dirname, "logs");
const RUNTIME_LOG_FILE = path.join(RUNTIME_LOG_DIR, "crm-runtime.log");

// Proposal template .html files live in nova-crm-project/public/templates —
// used by the proposal template list/fetch routes below. This was
// referenced as FRONTEND_PUBLIC_DIR in a few places without ever being
// defined, which crashed every "list templates" / "load template" request.
const FRONTEND_PUBLIC_DIR =
  process.env.FRONTEND_PUBLIC_DIR || path.join(__dirname, "..", "nova-crm-project", "public");

// Email clients (Gmail, Outlook, etc.) render HTML with no page URL behind
// it, so a root-relative path like src="/image/email-banner.png" has
// nothing to resolve against and just shows a broken image. Fixing that
// normally means pointing it at a real public URL (PUBLIC_BASE_URL) — but
// without one, we can instead embed the image FILES straight into the
// email as inline attachments (Content-ID / "cid:"), which every major
// email client supports and which needs no public hosting at all.
//
// This scans the HTML for local src="/image/..." references, reads each
// file from disk under FRONTEND_PUBLIC_DIR, and returns the HTML with
// those src attributes rewritten to "cid:<id>" plus the list of inline
// attachments nodemailer needs to send alongside them.
function novaCrmInlineLocalEmailImages(html, existingAttachments = []) {
  const attachments = [...existingAttachments];
  const seen = new Map(); // absolute file path -> cid, so repeated images reuse one cid
  let counter = 0;

  const rewritten = String(html || "").replace(
    /src=(["'])\/(?!\/)([^"']*)\1/gi,
    (match, quote, relPath) => {
      const decodedPath = decodeURIComponent(relPath.split("?")[0]);
      const absolutePath = path.join(FRONTEND_PUBLIC_DIR, decodedPath);

      // Guard against path traversal / anything outside the public dir.
      if (!absolutePath.startsWith(path.resolve(FRONTEND_PUBLIC_DIR))) return match;
      if (!fs.existsSync(absolutePath)) return match; // leave as-is if the file isn't found

      let cid = seen.get(absolutePath);
      if (!cid) {
        counter += 1;
        cid = `novacrm-img-${Date.now()}-${counter}@orbitavanyatech`;
        seen.set(absolutePath, cid);
        attachments.push({
          filename: path.basename(absolutePath),
          path: absolutePath,
          cid,
          contentDisposition: "inline",
        });
      }
      return `src=${quote}cid:${cid}${quote}`;
    }
  );

  return { html: rewritten, attachments };
}

try {
  fs.mkdirSync(RUNTIME_LOG_DIR, { recursive: true });
} catch (logDirErr) {
  console.warn("Could not create runtime log directory:", logDirErr.message);
}

function appendRuntimeLog(level, message, meta = null) {
  try {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message: String(message),
      meta: meta || undefined,
    }) + "\n";
    fs.appendFileSync(RUNTIME_LOG_FILE, line, "utf8");
  } catch (_) {
    // Logging must never crash the CRM.
  }
}

const FRONTEND_BUILD_LOG_FILE = path.join(RUNTIME_LOG_DIR, "frontend-build.log");

function appendFrontendBuildLog(message) {
  try {
    fs.appendFileSync(
      FRONTEND_BUILD_LOG_FILE,
      JSON.stringify({ time: new Date().toISOString(), message: String(message) }) + "\n",
      "utf8"
    );
  } catch (_) { }
}

// Give every request a lightweight diagnostic id. It is useful when the
// browser error, server log, and cPanel log need to be correlated.
app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  req.novaRequestId = requestId;
  res.setHeader("X-Nova-Request-Id", requestId);
  next();
});

const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  const message = args.map((arg) => {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === "string") return arg;
    try { return JSON.stringify(arg); } catch (_) { return String(arg); }
  }).join(" ");
  appendRuntimeLog("ERROR", message);
  originalConsoleError(...args);
};

process.on("uncaughtException", (err) => {
  appendRuntimeLog("ERROR", "uncaughtException", { message: err?.message, stack: err?.stack });
  console.error("uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  appendRuntimeLog("ERROR", "unhandledRejection", {
    message: reason?.message || String(reason),
    stack: reason?.stack,
  });
  console.error("unhandledRejection:", reason);
});


/* ============================================================
   PostgreSQL connection
   - This CRM uses PostgreSQL directly.
   - Supabase is not required by the backend.
   ============================================================ */
const DB_DIALECT = (process.env.DB_DIALECT || "mysql").toLowerCase();

if (DB_DIALECT !== "mysql") {
  throw new Error("This backend build is configured for MySQL. Set DB_DIALECT=mysql.");
}

const pool = createPoolFromEnv();
console.log(`[DB] MySQL ${process.env.DB_HOST || "localhost"}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME || "nova_crm"}`);

/* ============================================================
   Self-managed authentication (no Supabase)
   - PostgreSQL stores users and verification/reset tokens.
   - Passwords use Node's built-in scrypt hashing.
   - Sessions use signed HMAC tokens stored by the frontend.
   ============================================================ */
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.JWT_SECRET;
if (!AUTH_SECRET) {
  console.warn("AUTH_SECRET is not configured. Set a strong random AUTH_SECRET in .env.");
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function createAuthToken(user) {
  const payload = {
    sub: String(user.id),
    email: user.email,
    role: user.role || "user",
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  };
  const encoded = b64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", AUTH_SECRET || "missing-auth-secret")
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== "string") return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac("sha256", AUTH_SECRET || "missing-auth-secret")
    .update(encoded)
    .digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function hashAuthToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function hashPassword(password, saltHex = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), 64).toString("hex");
  return { hash, salt: saltHex };
}

function verifyPassword(password, storedHash, saltHex) {
  const candidate = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), 64).toString("hex");
  return candidate.length === storedHash.length &&
    crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(storedHash, "hex"));
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

async function getCurrentAuthUser(req) {
  const payload = verifyAuthToken(getBearerToken(req));
  if (!payload) return null;
  const result = await pool.query(
    `SELECT id, email, full_name, role, email_verified, created_at
     FROM crm_users WHERE id = $1 LIMIT 1`,
    [payload.sub]
  );
  return result.rows[0] || null;
}

/*
 * Authentication guard used by protected CRM APIs.
 * Returns the authenticated crm_users row or sends HTTP 401.
 */
async function requireAuthenticatedUser(req, res) {
  const user = await getCurrentAuthUser(req);
  if (!user) {
    res.status(401).json({ message: "Not authenticated." });
    return null;
  }
  return user;
}

function authUserResponse(user) {
  return {
    id: String(user.id),
    email: user.email,
    full_name: user.full_name || "",
    role: user.role || "user",
    email_verified: Boolean(user.email_verified),
  };
}

async function ensureCrmUpgradeSchema() {
  if (DB_DIALECT === "mysql") {
    appendRuntimeLog("INFO", "MySQL schema bootstrap skipped; using deployed MySQL schema files");
    return;
  }
  try {
    await pool.query(`
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS value_source TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS value_source TEXT NOT NULL DEFAULT 'manual';
      CREATE TABLE IF NOT EXISTS admin_login_activity (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        role TEXT,
        event_type TEXT NOT NULL DEFAULT 'session_seen',
        ip_address TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_admin_login_activity_created
        ON admin_login_activity(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_login_activity_email
        ON admin_login_activity(email);

      ALTER TABLE proposal_files
        ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'crm_customer';
      ALTER TABLE proposal_files
        ADD COLUMN IF NOT EXISTS tender_customer_id BIGINT;
      CREATE INDEX IF NOT EXISTS idx_proposal_files_tender_customer
        ON proposal_files(tender_customer_id);

      ALTER TABLE proposal_files
        ADD COLUMN IF NOT EXISTS digitization_live_tender_id BIGINT;
      ALTER TABLE proposal_files
        ADD COLUMN IF NOT EXISTS digitization_subcontracting_tender_id BIGINT;
      CREATE INDEX IF NOT EXISTS idx_proposal_files_digitization_live
        ON proposal_files(digitization_live_tender_id);
      CREATE INDEX IF NOT EXISTS idx_proposal_files_digitization_sub
        ON proposal_files(digitization_subcontracting_tender_id);

      ALTER TABLE tender_customers
        ADD COLUMN IF NOT EXISTS selected_for_proposal BOOLEAN NOT NULL DEFAULT false;
      CREATE INDEX IF NOT EXISTS idx_tender_customers_selected
        ON tender_customers(selected_for_proposal);

      ALTER TABLE customers
        ADD COLUMN IF NOT EXISTS selected_for_proposal BOOLEAN NOT NULL DEFAULT false;
      CREATE INDEX IF NOT EXISTS idx_customers_selected
        ON customers(selected_for_proposal);

      CREATE TABLE IF NOT EXISTS crm_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        full_name TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        verification_token_hash TEXT,
        verification_expires_at TIMESTAMPTZ,
        reset_token_hash TEXT,
        reset_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_crm_users_email ON crm_users(LOWER(email));
      CREATE INDEX IF NOT EXISTS idx_crm_users_verification
        ON crm_users(verification_token_hash);
      CREATE INDEX IF NOT EXISTS idx_crm_users_reset
        ON crm_users(reset_token_hash);

      CREATE TABLE IF NOT EXISTS email_capture_settings (
        id INT PRIMARY KEY DEFAULT 1,
        enabled BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT email_capture_settings_singleton CHECK (id = 1)
      );
      INSERT INTO email_capture_settings (id, enabled)
        VALUES (1, true)
        ON CONFLICT (id) DO NOTHING;
    `);
    appendRuntimeLog("INFO", "CRM upgrade schema verified");
  } catch (err) {
    appendRuntimeLog("ERROR", "CRM upgrade schema verification failed", { message: err.message, stack: err.stack });
    console.error("CRM upgrade schema verification failed:", err);
  }
}
ensureCrmUpgradeSchema();

/* ---------------- Live web search (Tavily) for AI company insights ----------------
   Used only by the /api/customers/:id/ai-insights endpoint below, to give the
   AI real, current information about a company instead of just guessing from
   the CRM record. No other feature depends on this. */

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
    return (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
    }));
  } catch (err) {
    console.error("[AI] Tavily search failed:", err.message);
    return [];
  }
}

async function gatherWebContext(companyName) {
  if (!companyName) return { text: "", sources: [] };
  const queries = [
    `${companyName} company profile`,
    `${companyName} official website`,
    `${companyName} LinkedIn CEO employees`,
    `${companyName} news 2026`,
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
  const text = flat
    .map((r, i) => `[Source ${i + 1}: ${r.title} — ${r.url}]\n${r.content}`)
    .join("\n\n");
  return { text, sources: flat.map((r) => ({ title: r.title, url: r.url })) };
}

/*
 * AI provider switch
 * --------------------
 * Set AI_PROVIDER=gemini or AI_PROVIDER=groq in backend/.env.
 * Gemini is used via Google's OpenAI-compatibility endpoint, so the
 * rest of the code (openai.chat.completions.create(...)) never has
 * to change no matter which provider is active.
 */
const AI_PROVIDER = (process.env.AI_PROVIDER || "gemini").toLowerCase();

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

/* ============================================================ */
/* -------------------- Customers -------------------- */
/* ============================================================ */

app.get("/api/customers", async (req, res) => {
  try {
    // ?selected=true restricts the list to customers explicitly marked
    // "selected for proposal" — used by the Proposals generator's CRM
    // Customer dropdown so it only shows companies chosen on this page.
    const selectedOnlyRaw = String(req.query.selected || "").trim().toLowerCase();
    const selectedOnly = selectedOnlyRaw === "true" || selectedOnlyRaw === "1";
    const result = await pool.query(
      selectedOnly
        ? "SELECT * FROM customers WHERE selected_for_proposal = true ORDER BY created_at DESC"
        : "SELECT * FROM customers ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/customers", async (req, res) => {
  const { company_name, contact_name, ceo_name, email, phone, website, industry, segment, notes } = req.body;
  if (!company_name) {
    return res.status(400).json({ message: "Company name is required." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO customers (company_name, contact_name, ceo_name, email, phone, website, industry, segment, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [company_name, contact_name, ceo_name, email, phone, website, industry, segment, notes]
    );
    res.json({ message: "Customer added successfully.", customer: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add customer.", error: err.message });
  }
});

app.put("/api/customers/:id", async (req, res) => {
  const { id } = req.params;
  const { company_name, contact_name, ceo_name, email, phone, website, industry, segment } = req.body;
  try {
    const result = await pool.query(
      `UPDATE customers
       SET company_name = $1, contact_name = $2, ceo_name = $3, email = $4, phone = $5, website = $6, industry = $7, segment = $8
       WHERE id = $9 RETURNING *`,
      [company_name, contact_name, ceo_name, email, phone, website, industry, segment, id]
    );
    res.json({ message: "Customer updated.", customer: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update customer.", error: err.message });
  }
});

app.delete("/api/customers/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM customers WHERE id = $1", [id]);
    res.json({ message: "Customer removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete customer.", error: err.message });
  }
});

app.post("/api/customers/delete-selected", async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: "No customers selected." });
  }
  try {
    await pool.query("DELETE FROM customers WHERE id = ANY($1::int[])", [ids]);
    res.json({ message: `${ids.length} customer(s) deleted.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete selected customers.", error: err.message });
  }
});

// Bulk mark/unmark customers as "selected for proposal". Only customers
// marked this way show up in the Proposals generator's CRM Customer
// dropdown (see GET /api/customers?selected=true above).
app.post("/api/customers/select-for-proposal", async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
    : [];
  const selected = Boolean(req.body?.selected);
  if (ids.length === 0) {
    return res.status(400).json({ message: "No customers selected." });
  }
  try {
    const result = await pool.query(
      "UPDATE customers SET selected_for_proposal = $1 WHERE id = ANY($2::int[]) RETURNING id",
      [selected, ids]
    );
    res.json({
      message: selected
        ? `${result.rowCount} customer(s) sent to Proposals.`
        : `${result.rowCount} customer(s) removed from Proposals.`,
      updated: result.rowCount,
      selected,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update selection.", error: err.message });
  }
});

app.put("/api/customers/:id/portal", async (req, res) => {
  const { id } = req.params;
  const { portal_access } = req.body;
  try {
    const result = await pool.query(
      "UPDATE customers SET portal_access = $1 WHERE id = $2 RETURNING *",
      [portal_access, id]
    );
    res.json({ portal_access: result.rows[0].portal_access });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/customers/:id/verification", async (req, res) => {
  const { id } = req.params;
  const { verification_status } = req.body;
  try {
    const result = await pool.query(
      "UPDATE customers SET verification_status = $1 WHERE id = $2 RETURNING *",
      [verification_status, id]
    );
    res.json({ verification_status: result.rows[0].verification_status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/customers/bulk-import", async (req, res) => {
  const { customers } = req.body;
  if (!Array.isArray(customers) || customers.length === 0) {
    return res.status(400).json({ message: "No customers to import." });
  }
  const valid = customers.filter((c) => c.company_name);
  if (valid.length === 0) {
    return res.status(400).json({ message: "No valid rows (missing company name)." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let inserted = 0;
    const BATCH_SIZE = 500;
    for (let i = 0; i < valid.length; i += BATCH_SIZE) {
      const batch = valid.slice(i, i + BATCH_SIZE);
      const values = [];
      const placeholders = batch.map((c, idx) => {
        const base = idx * 20;
        values.push(
          c.company_name || null,
          c.contact_name || null,
          c.ceo_name || null,
          c.email || null,
          c.phone || null,
          c.website || null,
          c.industry || null,
          c.segment || null,
          // Extra sheet columns — not shown on the Customers list, only on
          // the customer's detail page.
          c.region || null,
          c.city || null,
          c.country || null,
          c.time_zone || null,
          c.country_size || null,
          c.company_size || null,
          c.employee_count || null,
          c.category || null,
          c.linkedin_url || null,
          c.email_2 || null,
          c.email_3 || null,
          c.email_4 || null
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17}, $${base + 18}, $${base + 19}, $${base + 20})`;
      });
      const query = `
        INSERT INTO customers (
          company_name, contact_name, ceo_name, email, phone, website, industry, segment,
          region, city, country, time_zone, country_size, company_size, employee_count,
          category, linkedin_url, email_2, email_3, email_4
        )
        VALUES ${placeholders.join(", ")}
      `;
      await client.query(query, values);
      inserted += batch.length;
    }
    await client.query("COMMIT");
    res.json({ message: `${inserted} customer(s) imported.` });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ message: "Import failed.", error: err.message });
  } finally {
    client.release();
  }
});

/* ---------------- Customer detail page ----------------
   Backs the full "customer details" page opened from the Eye icon:
   overview + Contacts / Portal / Documents / Activities tabs. */

app.get("/api/customers/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM customers WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Customer not found." });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load customer.", error: err.message });
  }
});

app.get("/api/customers/:id/contacts", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM customer_contacts WHERE customer_id = $1 ORDER BY created_at DESC",
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load contacts.", error: err.message });
  }
});

app.post("/api/customers/:id/contacts", async (req, res) => {
  const { id } = req.params;
  const { name, designation, email, phone } = req.body;
  if (!name) {
    return res.status(400).json({ message: "Contact name is required." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO customer_contacts (customer_id, name, designation, email, phone)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, name, designation || null, email || null, phone || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add contact.", error: err.message });
  }
});

app.get("/api/customers/:id/documents", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, file_name AS name, category AS type, file_url, size_kb, created_at
       FROM documents WHERE customer_id = $1 ORDER BY created_at DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load documents.", error: err.message });
  }
});

app.get("/api/customers/:id/activities", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM activities WHERE customer_id = $1 ORDER BY occurred_at DESC",
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load activity.", error: err.message });
  }
});

/* ---------------- Customer detail page: AI company insights ----------------
   Uses the same Groq/OpenAI helper (callOpenAI) and the existing
   ai_coach_sessions table as the AI Assistant module — just a different
   `mode` value ('company_insights'), so nothing else about that table
   or the AI Assistant page is touched. */

app.get("/api/customers/:id/ai-insights", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT id, output_advice, created_at
       FROM ai_coach_sessions
       WHERE customer_id = $1 AND mode = 'company_insights'
       ORDER BY created_at DESC
       LIMIT 1`,
      [id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load AI insights.", error: err.message });
  }
});

app.post("/api/customers/:id/ai-insights", async (req, res) => {
  const { id } = req.params;
  try {
    const customerResult = await pool.query("SELECT * FROM customers WHERE id = $1", [id]);
    const customer = customerResult.rows[0];
    if (!customer) {
      return res.status(404).json({ message: "Customer not found." });
    }

    // Build the input context from exactly the imported/entered fields on
    // this customer — the same data already shown on the detail page.
    const facts = [
      ["Company", customer.company_name],
      ["CEO", customer.ceo_name],
      ["Primary contact", customer.contact_name],
      ["Industry", customer.industry],
      ["Segment/Tier", customer.segment],
      ["Website", customer.website],
      ["Region", customer.region],
      ["Country", customer.country],
      ["City", customer.city],
      ["Company size", customer.company_size],
      ["Number of employees", customer.employee_count],
      ["Category", customer.category],
      ["LinkedIn", customer.linkedin_url],
      ["Verification status", customer.verification_status],
      ["Notes on file", customer.notes],
    ]
      .filter(([, v]) => v && String(v).trim())
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    const { text: webContext, sources } = await gatherWebContext(customer.company_name);

    const input_context =
      `CRM record on file for this company:\n${facts}` +
      (webContext ? `\n\nLive web search results:\n${webContext}` : "");

    const output_advice = await callOpenAI([
      {
        role: "system",
        content:
          "You are a B2B research assistant inside a CRM. You are given the CRM's current " +
          "record for a company AND live web search results about that same company. " +
          "Cross-check the two, then respond in clean GitHub-flavoured Markdown using " +
          "EXACTLY this structure and these section headers (use ## for each header):\n\n" +
          "## Cross-Check Findings\n" +
          "A short bullet list (use \"- \") comparing the CRM record to the web results. " +
          "For each point that matters, bold the field name, e.g. \"- **Category** – ...\". " +
          "Call out anything in the CRM that looks outdated or wrong.\n\n" +
          "## Company Overview\n" +
          "2-4 sentences on what the company actually does, who it serves, and its scale/stage.\n\n" +
          "## Key Facts\n" +
          "A markdown table with two columns, \"Field\" and \"Details\", covering whatever of " +
          "these you have evidence for: Founded, Headquarters, Company Type, Industry, " +
          "Employees, Leadership, Website, LinkedIn.\n\n" +
          "## Specialties\n" +
          "A short bullet list of the company's main products, services, or focus areas.\n\n" +
          "## Sales Angles\n" +
          "2-3 numbered, concrete talking points a sales rep could use when reaching out, " +
          "each 1-2 sentences.\n\n" +
          "Rules: only state something as fact if the web results or CRM record support it; " +
          "otherwise say the data isn't available. If there were no usable web results at " +
          "all, still use this structure but say clearly under Cross-Check Findings that " +
          "this is based only on the CRM record. Do not add any text outside these five " +
          "sections.",
      },
      {
        role: "user",
        content: input_context,
      },
    ]);

    const result = await pool.query(
      `INSERT INTO ai_coach_sessions (customer_id, mode, input_context, output_advice)
       VALUES ($1, 'company_insights', $2, $3)
       RETURNING id, output_advice, created_at`,
      [id, input_context, output_advice]
    );

    res.json({ ...result.rows[0], sources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message || "Failed to generate AI insights." });
  }
});

/* ============================================================ */
/* -------------------- Documents -------------------- */
/* ============================================================ */

app.get("/api/documents", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, c.company_name AS customer_name
       FROM documents d
       LEFT JOIN customers c ON d.customer_id = c.id
       ORDER BY d.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/documents", async (req, res) => {
  const { file_name, category, customer_id, uploaded_by, file_url, size_kb } = req.body;
  if (!file_name) {
    return res.status(400).json({ message: "File name is required." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO documents (file_name, category, customer_id, uploaded_by, file_url, size_kb)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [file_name, category || null, customer_id || null, uploaded_by || null, file_url || null, size_kb || 0]
    );
    res.json({ message: "Document added.", document: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add document.", error: err.message });
  }
});

app.put("/api/documents/:id", async (req, res) => {
  const { id } = req.params;
  const { file_name, category, customer_id, uploaded_by, file_url, size_kb } = req.body;
  try {
    const result = await pool.query(
      `UPDATE documents
       SET file_name = $1, category = $2, customer_id = $3, uploaded_by = $4, file_url = $5, size_kb = $6
       WHERE id = $7 RETURNING *`,
      [file_name, category, customer_id || null, uploaded_by, file_url, size_kb, id]
    );
    res.json({ message: "Document updated.", document: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update document.", error: err.message });
  }
});

app.put("/api/documents/:id/share", async (req, res) => {
  const { id } = req.params;
  const { is_shared } = req.body;
  try {
    const result = await pool.query(
      "UPDATE documents SET is_shared = $1 WHERE id = $2 RETURNING *",
      [is_shared, id]
    );
    res.json({ is_shared: result.rows[0].is_shared });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/documents/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM documents WHERE id = $1", [id]);
    res.json({ message: "Document removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete document.", error: err.message });
  }
});

app.post("/api/documents/delete-selected", async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: "No documents selected." });
  }
  try {
    await pool.query("DELETE FROM documents WHERE id = ANY($1::int[])", [ids]);
    res.json({ message: `${ids.length} document(s) deleted.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete selected documents.", error: err.message });
  }
});

/* ============================================================ */
/* -------------------- Contracts -------------------- */
/* ============================================================ */

app.get("/api/contracts", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ct.*, c.company_name AS customer_name
       FROM contracts ct
       LEFT JOIN customers c ON ct.customer_id = c.id
       ORDER BY ct.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/contracts", async (req, res) => {
  const { contract_number, customer_id, start_date, end_date, status, value, sales_owner, attachment_url, notes } = req.body;
  if (!contract_number) {
    return res.status(400).json({ message: "Contract number is required." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO contracts (contract_number, customer_id, start_date, end_date, status, value, sales_owner, attachment_url, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        contract_number,
        customer_id || null,
        start_date || null,
        end_date || null,
        status || "Draft",
        value || null,
        sales_owner || null,
        attachment_url || null,
        notes || null,
      ]
    );
    res.json({ message: "Contract added.", contract: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add contract.", error: err.message });
  }
});

app.put("/api/contracts/:id", async (req, res) => {
  const { id } = req.params;
  const { contract_number, customer_id, start_date, end_date, status, value, sales_owner, attachment_url, notes, is_shared } = req.body;
  try {
    const result = await pool.query(
      `UPDATE contracts
       SET contract_number = $1, customer_id = $2, start_date = $3, end_date = $4, status = $5,
           value = $6, sales_owner = $7, attachment_url = $8, notes = $9, is_shared = COALESCE($10, is_shared)
       WHERE id = $11 RETURNING *`,
      [contract_number, customer_id || null, start_date || null, end_date || null, status, value || null, sales_owner, attachment_url, notes, is_shared, id]
    );
    res.json({ message: "Contract updated.", contract: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update contract.", error: err.message });
  }
});

app.delete("/api/contracts/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM contracts WHERE id = $1", [id]);
    res.json({ message: "Contract removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete contract.", error: err.message });
  }
});

app.post("/api/contracts/delete-selected", async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: "No contracts selected." });
  }
  try {
    await pool.query("DELETE FROM contracts WHERE id = ANY($1::int[])", [ids]);
    res.json({ message: `${ids.length} contract(s) deleted.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete selected contracts.", error: err.message });
  }
});

/* ============================================================ */
/* -------------------- Proposal Files -------------------- */
/* ============================================================ */

app.get("/api/proposals", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
              COALESCE(c.company_name, tc.company_name) AS customer_name,
              tc.company_name AS tender_customer_name,
              CASE
                WHEN p.source_type = 'tender_customer' THEN 'Tender Customer'
                ELSE 'CRM Customer'
              END AS customer_source
       FROM proposal_files p
       LEFT JOIN customers c ON p.customer_id = c.id
       LEFT JOIN tender_customers tc ON p.tender_customer_id = tc.id
       ORDER BY p.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/proposals", async (req, res) => {
  const {
    proposal_number,
    customer_id,
    tender_customer_id,
    source_type,
    opportunity,
    created_by,
    status,
    version,
    file_url,
  } = req.body;
  if (!proposal_number) {
    return res.status(400).json({ message: "Proposal number is required." });
  }
  if (customer_id && tender_customer_id) {
    return res.status(400).json({ message: "A proposal can belong to only one customer source." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO proposal_files
        (proposal_number, customer_id, tender_customer_id, source_type,
         opportunity, created_by, status, version, file_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        proposal_number,
        customer_id || null,
        tender_customer_id || null,
        source_type || (tender_customer_id ? "tender_customer" : "crm_customer"),
        opportunity || null,
        created_by || null,
        status || "Draft",
        version || 1,
        file_url || null,
      ]
    );
    res.json({ message: "Proposal added.", proposal: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add proposal.", error: err.message });
  }
});

app.put("/api/proposals/:id", async (req, res) => {
  const { id } = req.params;
  const {
    proposal_number,
    customer_id,
    tender_customer_id,
    source_type,
    opportunity,
    created_by,
    status,
    version,
    file_url,
    is_shared,
  } = req.body;
  if (customer_id && tender_customer_id) {
    return res.status(400).json({ message: "A proposal can belong to only one customer source." });
  }
  try {
    const result = await pool.query(
      `UPDATE proposal_files
       SET proposal_number = $1,
           customer_id = $2,
           tender_customer_id = $3,
           source_type = COALESCE($4, source_type),
           opportunity = $5,
           created_by = $6,
           status = $7,
           version = $8,
           file_url = $9,
           is_shared = COALESCE($10, is_shared)
       WHERE id = $11 RETURNING *`,
      [
        proposal_number,
        customer_id || null,
        tender_customer_id || null,
        source_type || null,
        opportunity,
        created_by,
        status,
        version,
        file_url,
        is_shared,
        id,
      ]
    );
    res.json({ message: "Proposal updated.", proposal: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update proposal.", error: err.message });
  }
});

app.delete("/api/proposals/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM proposal_files WHERE id = $1", [id]);
    res.json({ message: "Proposal removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete proposal.", error: err.message });
  }
});

app.post("/api/proposals/delete-selected", async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: "No proposals selected." });
  }
  try {
    await pool.query("DELETE FROM proposal_files WHERE id = ANY($1::int[])", [ids]);
    res.json({ message: `${ids.length} proposal(s) deleted.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete selected proposals.", error: err.message });
  }
});

/* ============================================================
   PROPOSAL GENERATOR
   - Templates live in `proposal_templates` (DB table — see
     proposal_generator_schema.sql), so templates can be added,
     edited, or switched from the CRM UI without redeploying code.
   - Merging is generic: every column on the selected customer row
     is exposed as {{COLUMN_NAME}} automatically, plus a few
     friendly aliases used by the existing template set
     (e.g. templates1.html).
   - Actual PDF rendering reuses the existing, already-working
     POST /api/proposals/export-pdf (Puppeteer, defined further
     below) — this section only produces merged HTML and hands it
     off, so there's no duplicate PDF logic anywhere in this file.
   ============================================================ */

function novaCrmBuildProposalTemplateData(customer = {}, overrides = {}) {
  const formattedDate = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Auto-derive {{COLUMN_NAME}} for every column on the customer row
  // (e.g. company_name -> {{COMPANY_NAME}}) so new customer fields
  // or new templates work without touching this file.
  const auto = {};
  Object.entries(customer).forEach(([key, value]) => {
    auto[key.toUpperCase()] = value == null ? "" : String(value);
  });

  const cover = novaCrmGetCoverImageInfo();

  return {
    ...auto,
    // Friendly aliases matching the tokens already used in templates1.html
    CUSTOMER_COMPANY_NAME: customer.company_name || "",
    CEO_NAME: customer.ceo_name || customer.contact_name || "",
    CUSTOMER_EMAIL: customer.email || "",
    CUSTOMER_CONTACT_NAME: customer.contact_name || "",
    CUSTOMER_PHONE: customer.phone || "",
    CUSTOMER_WEBSITE: customer.website || "",
    CUSTOMER_INDUSTRY: customer.industry || "",
    PROPOSAL_DATE: formattedDate,
    PROPOSAL_NUMBER: overrides.proposal_number || "",
    // Cover image tokens (see "Proposal cover image" upload in the
    // Generate tab). Two forms so a template can use whichever fits:
    //   <img src="{{COVER_IMAGE_URL}}">                     — bare URL
    //   <div style="{{COVER_IMAGE_STYLE}}">                 — CSS var form
    // If nothing has been uploaded yet, COVER_IMAGE_URL is "" and
    // COVER_IMAGE_STYLE is "" too — the latter leaves the inline style
    // attribute empty so a template's own CSS fallback (e.g. a gradient
    // default on --cover-img) still applies instead of a broken image.
    COVER_IMAGE_URL: cover ? cover.url : "",
    COVER_IMAGE_STYLE: cover ? `--cover-img: url('${cover.url}');` : "",
    ...overrides,
  };
}

// public/image/cover.<ext> — written by POST /api/proposals/cover-image
// below, overwriting whatever was there before regardless of the
// previous upload's extension. Returns null if nothing's been uploaded
// yet. The mtime-based query string keeps browsers/Puppeteer from
// showing a stale cached cover after a fresh upload.
function novaCrmGetCoverImageInfo() {
  try {
    const imageDir = path.join(FRONTEND_PUBLIC_DIR, "image");
    if (!fs.existsSync(imageDir)) return null;
    const match = fs
      .readdirSync(imageDir)
      .find((name) => /^cover\.(jpe?g|png|webp)$/i.test(name));
    if (!match) return null;
    const stat = fs.statSync(path.join(imageDir, match));
    return { url: `/image/${match}?v=${stat.mtimeMs}` };
  } catch (err) {
    console.error("[COVER IMAGE INFO]", err);
    return null;
  }
}

function novaCrmMergeProposalTemplate(html, data) {
  return String(html).replace(/{{\s*([A-Z0-9_]+)\s*}}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(data, key) ? String(data[key]) : match
  );
}

function novaCrmGenerateProposalNumber() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `PROP-${stamp}-${rand}`;
}

// Upload used by the Generate tab's "Upload image" button. Always
// normalizes to public/image/cover.<ext> — any older cover.* files (a
// previous upload in a different format) are removed first so exactly
// one exists at a time and novaCrmGetCoverImageInfo() above never has
// to guess which one is current.
const coverImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

const COVER_IMAGE_MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

app.post("/api/proposals/cover-image", coverImageUpload.single("image"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ message: "No image file was uploaded." });

    const ext = COVER_IMAGE_MIME_TO_EXT[file.mimetype];
    if (!ext) {
      return res.status(400).json({ message: "Unsupported image type. Use JPEG, PNG, or WebP." });
    }

    const imageDir = path.join(FRONTEND_PUBLIC_DIR, "image");
    fs.mkdirSync(imageDir, { recursive: true });

    // Remove any previous cover.* so only one ever exists.
    fs.readdirSync(imageDir)
      .filter((name) => /^cover\.(jpe?g|png|webp)$/i.test(name))
      .forEach((name) => {
        try {
          fs.unlinkSync(path.join(imageDir, name));
        } catch (_) {
          // Ignore — worst case an old file lingers unused.
        }
      });

    const fileName = `cover.${ext}`;
    fs.writeFileSync(path.join(imageDir, fileName), file.buffer);

    const cover = novaCrmGetCoverImageInfo();
    res.json({
      message: "Cover image updated. It will be used on every new proposal.",
      file_name: fileName,
      cover_image_url: cover ? cover.url : `/image/${fileName}`,
    });
  } catch (err) {
    console.error("[PROPOSAL COVER IMAGE UPLOAD]", err);
    res.status(500).json({ message: "Failed to upload cover image.", error: err.message });
  }
});



app.get("/api/proposal-templates", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, description, is_active, is_default, created_at, updated_at
       FROM proposal_templates ORDER BY is_default DESC, created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("[PROPOSAL TEMPLATES LIST]", err);
    res.status(500).json({ message: "Failed to load templates.", error: err.message });
  }
});

app.get("/api/proposal-templates/files", async (req, res) => {
  try {
    const templatesDir = path.join(FRONTEND_PUBLIC_DIR, "templates");
    if (!fs.existsSync(templatesDir)) return res.json([]);

    const files = fs.readdirSync(templatesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".html"))
      .map((entry) => ({
        id: `file:${entry.name}`,
        name: entry.name.replace(/\.html$/i, "").replace(/[-_]+/g, " "),
        file_name: entry.name,
        source: "file",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json(files);
  } catch (err) {
    console.error("[PROPOSAL FILE TEMPLATES LIST]", err);
    res.status(500).json({ message: "Failed to load file templates.", error: err.message });
  }
});

// Resolve a requested file-template filename safely inside templatesDir.
// Rejects path traversal (../, absolute paths, nested folders) and
// anything that isn't a plain .html filename.
function novaCrmResolveTemplateFile(rawName) {
  const templatesDir = path.join(FRONTEND_PUBLIC_DIR, "templates");
  const safeName = path.basename(String(rawName || ""));
  if (!/^[\w\-. ]+\.html$/i.test(safeName)) return null;
  const fullPath = path.join(templatesDir, safeName);
  if (path.dirname(fullPath) !== templatesDir) return null;
  return { templatesDir, safeName, fullPath };
}

// Read a single file-based template's raw HTML — powers the visual
// split editor's "load into editor" step for file templates.
app.get("/api/proposal-templates/files/:filename", async (req, res) => {
  try {
    const resolved = novaCrmResolveTemplateFile(req.params.filename);
    if (!resolved) return res.status(400).json({ message: "Invalid template filename." });
    if (!fs.existsSync(resolved.fullPath)) return res.status(404).json({ message: "Template file not found." });
    const html_content = fs.readFileSync(resolved.fullPath, "utf8");
    res.json({
      id: `file:${resolved.safeName}`,
      file_name: resolved.safeName,
      name: resolved.safeName.replace(/\.html$/i, "").replace(/[-_]+/g, " "),
      source: "file",
      html_content,
    });
  } catch (err) {
    console.error("[PROPOSAL FILE TEMPLATE GET]", err);
    res.status(500).json({ message: "Failed to load template file.", error: err.message });
  }
});

// Create a new file-based template on disk (public/templates/<name>.html).
app.post("/api/proposal-templates/files", async (req, res) => {
  try {
    const { file_name, html_content } = req.body || {};
    if (!file_name || !html_content) {
      return res.status(400).json({ message: "file_name and html_content are required." });
    }
    const normalized = /\.html$/i.test(file_name) ? file_name : `${file_name}.html`;
    const resolved = novaCrmResolveTemplateFile(normalized);
    if (!resolved) return res.status(400).json({ message: "Invalid template filename." });
    if (fs.existsSync(resolved.fullPath)) {
      return res.status(409).json({ message: "A template file with that name already exists." });
    }
    fs.mkdirSync(resolved.templatesDir, { recursive: true });
    fs.writeFileSync(resolved.fullPath, html_content, "utf8");
    res.json({
      message: "Template file created.",
      id: `file:${resolved.safeName}`,
      file_name: resolved.safeName,
      name: resolved.safeName.replace(/\.html$/i, "").replace(/[-_]+/g, " "),
      source: "file",
    });
  } catch (err) {
    console.error("[PROPOSAL FILE TEMPLATE CREATE]", err);
    res.status(500).json({ message: "Failed to create template file.", error: err.message });
  }
});

// Overwrite an existing file-based template's HTML — the save button in
// the visual split editor calls this for templates loaded from disk.
app.put("/api/proposal-templates/files/:filename", async (req, res) => {
  try {
    const { html_content } = req.body || {};
    if (typeof html_content !== "string" || !html_content) {
      return res.status(400).json({ message: "html_content is required." });
    }
    const resolved = novaCrmResolveTemplateFile(req.params.filename);
    if (!resolved) return res.status(400).json({ message: "Invalid template filename." });
    if (!fs.existsSync(resolved.fullPath)) return res.status(404).json({ message: "Template file not found." });
    fs.writeFileSync(resolved.fullPath, html_content, "utf8");
    res.json({ message: "Template file saved.", file_name: resolved.safeName });
  } catch (err) {
    console.error("[PROPOSAL FILE TEMPLATE SAVE]", err);
    res.status(500).json({ message: "Failed to save template file.", error: err.message });
  }
});

// Delete a file-based template from disk.
app.delete("/api/proposal-templates/files/:filename", async (req, res) => {
  try {
    const resolved = novaCrmResolveTemplateFile(req.params.filename);
    if (!resolved) return res.status(400).json({ message: "Invalid template filename." });
    if (!fs.existsSync(resolved.fullPath)) return res.status(404).json({ message: "Template file not found." });
    fs.unlinkSync(resolved.fullPath);
    res.json({ message: "Template file deleted." });
  } catch (err) {
    console.error("[PROPOSAL FILE TEMPLATE DELETE]", err);
    res.status(500).json({ message: "Failed to delete template file.", error: err.message });
  }
});

app.get("/api/proposal-templates/:id", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM proposal_templates WHERE id = $1`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ message: "Template not found." });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[PROPOSAL TEMPLATE GET]", err);
    res.status(500).json({ message: "Failed to load template.", error: err.message });
  }
});

/* ---------------- Templates: create / update / delete ---------------- */

app.post("/api/proposal-templates", async (req, res) => {
  const { name, description, html_content, is_active = true, is_default = false } = req.body || {};
  if (!name || !html_content) {
    return res.status(400).json({ message: "name and html_content are required." });
  }
  try {
    if (is_default) {
      await pool.query(`UPDATE proposal_templates SET is_default = false WHERE is_default = true`);
    }
    const result = await pool.query(
      `INSERT INTO proposal_templates (name, description, html_content, is_active, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, description, is_active, is_default, created_at, updated_at`,
      [name, description || null, html_content, is_active, is_default]
    );
    res.json({ message: "Template created.", template: result.rows[0] });
  } catch (err) {
    console.error("[PROPOSAL TEMPLATE CREATE]", err);
    res.status(500).json({ message: "Failed to create template.", error: err.message });
  }
});

app.put("/api/proposal-templates/:id", async (req, res) => {
  const { name, description, html_content, is_active, is_default } = req.body || {};
  try {
    if (is_default) {
      await pool.query(`UPDATE proposal_templates SET is_default = false WHERE id != $1 AND is_default = true`, [
        req.params.id,
      ]);
    }
    const result = await pool.query(
      `UPDATE proposal_templates
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           html_content = COALESCE($3, html_content),
           is_active = COALESCE($4, is_active),
           is_default = COALESCE($5, is_default),
           updated_at = NOW()
       WHERE id = $6
       RETURNING id, name, description, is_active, is_default, created_at, updated_at`,
      [name, description, html_content, is_active, is_default, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ message: "Template not found." });
    res.json({ message: "Template updated.", template: result.rows[0] });
  } catch (err) {
    console.error("[PROPOSAL TEMPLATE UPDATE]", err);
    res.status(500).json({ message: "Failed to update template.", error: err.message });
  }
});

app.delete("/api/proposal-templates/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM proposal_templates WHERE id = $1`, [req.params.id]);
    res.json({ message: "Template deleted." });
  } catch (err) {
    console.error("[PROPOSAL TEMPLATE DELETE]", err);
    res.status(500).json({ message: "Failed to delete template.", error: err.message });
  }
});

/* ---------------- Generate: merge customer -> template ----------------
   Returns merged HTML + a suggested filename. The frontend then posts
   that HTML straight to the existing /api/proposals/export-pdf to get
   the actual PDF bytes — no PDF logic is duplicated here.
------------------------------------------------------------------------- */

app.post("/api/proposals/generate", async (req, res) => {
  const {
    template_id,
    template_file,
    customer_id,
    tender_customer_id,
    digitization_tender_id,
    digitization_table, // "live" | "subcontracting" — required when digitization_tender_id is set
    overrides = {},
    save = true,
    opportunity,
    created_by,
  } = req.body || {};

  const sourceCount = [customer_id, tender_customer_id, digitization_tender_id].filter(Boolean).length;

  if ((!template_id && !template_file) || sourceCount === 0) {
    return res.status(400).json({
      message: "A template and one of customer_id, tender_customer_id or digitization_tender_id are required.",
    });
  }

  if (sourceCount > 1) {
    return res.status(400).json({
      message: "Select only one source: a CRM customer, a Tender Customer, or a Digitization tender.",
    });
  }

  if (digitization_tender_id && !["live", "subcontracting"].includes(digitization_table)) {
    return res.status(400).json({ message: "digitization_table must be 'live' or 'subcontracting'." });
  }

  try {
    let template;
    if (template_file) {
      const safeTemplateName = path.basename(String(template_file));
      if (!safeTemplateName.toLowerCase().endsWith(".html")) {
        return res.status(400).json({ message: "Only .html proposal templates are supported." });
      }

      const templatePath = path.join(FRONTEND_PUBLIC_DIR, "templates", safeTemplateName);
      const templatesRoot = path.resolve(path.join(FRONTEND_PUBLIC_DIR, "templates"));
      const resolvedTemplatePath = path.resolve(templatePath);
      if (!resolvedTemplatePath.startsWith(templatesRoot + path.sep)) {
        return res.status(400).json({ message: "Invalid template path." });
      }
      if (!fs.existsSync(resolvedTemplatePath)) {
        return res.status(404).json({ message: "Template file not found." });
      }

      template = {
        id: `file:${safeTemplateName}`,
        name: safeTemplateName.replace(/\.html$/i, "").replace(/[-_]+/g, " "),
        description: `File template: public/templates/${safeTemplateName}`,
        html_content: fs.readFileSync(resolvedTemplatePath, "utf8"),
        is_active: true,
        is_default: false,
      };
    } else {
      const templateResult = await pool.query(
        `SELECT * FROM proposal_templates WHERE id = $1`,
        [template_id]
      );
      template = templateResult.rows[0];
      if (!template) return res.status(404).json({ message: "Template not found." });
    }

    let sourceType = "crm_customer";
    let customer = null;
    let tenderCustomer = null;

    if (tender_customer_id) {
      sourceType = "tender_customer";
      const tenderResult = await pool.query(
        `SELECT * FROM tender_customers WHERE id = $1 LIMIT 1`,
        [Number(tender_customer_id)]
      );
      tenderCustomer = tenderResult.rows[0];
      if (!tenderCustomer) {
        return res.status(404).json({ message: "Tender customer not found." });
      }

      // The proposal template merger accepts a plain object. Tender rows
      // expose the normalized company fields plus every workbook column
      // through raw_data / tender_data.
      const tenderRows = Array.isArray(tenderCustomer.tender_data)
        ? tenderCustomer.tender_data
        : [];
      const uniqueText = (key) => [...new Set(
        tenderRows.map((row) => row?.[key]).filter((value) => value !== undefined && value !== null && String(value).trim() !== "")
      )];

      const tenderBase = {
        ...(tenderCustomer.raw_data || {}),
        COMPANY_NAME: tenderCustomer.company_name,
        LEGAL_COMPANY_NAME: tenderCustomer.legal_company_name || "",
        COMPANY_NUMBER: tenderCustomer.company_number || "",
        VERIFIED_OFFICIAL_WEBSITE: tenderCustomer.official_website || "",
        COMPANY_LINKEDIN_URL: tenderCustomer.linkedin_url || "",
        ALL_VERIFIED_COMPANY_EMAILS: tenderCustomer.company_emails || "",
        EXECUTIVE_1_NAME: tenderCustomer.executive_name || "",
        EXECUTIVE_1_ROLE: tenderCustomer.executive_role || "",
        TENDER_COUNT: tenderCustomer.tender_count || 0,
        TENDER_TITLES: uniqueText("TENDER_TITLE").join("\n"),
        TENDER_DESCRIPTIONS: uniqueText("TENDER_DESCRIPTION").join("\n\n"),
        TENDER_BUYERS: uniqueText("BUYER").join(", "),
        TENDER_DOMAINS: uniqueText("TENDER_DOMAIN").join(", "),
        TENDER_URLS: uniqueText("ORIGINAL_TENDER_URL").join("\n"),
        PROPOSAL_SOURCE: "Tender Customer",
      };

      const proposalNumber = overrides.proposal_number || novaCrmGenerateProposalNumber();
      const data = novaCrmBuildProposalTemplateData(
        { company_name: tenderCustomer.company_name, ...tenderBase },
        {
          ...overrides,
          proposal_number: proposalNumber,
          CUSTOMER_COMPANY_NAME: tenderCustomer.company_name,
          CUSTOMER_CONTACT_NAME: tenderCustomer.executive_name || "",
          CEO_NAME: tenderCustomer.executive_name || "",
          CUSTOMER_EMAIL: tenderCustomer.company_emails || "",
          CUSTOMER_WEBSITE: tenderCustomer.official_website || "",
          CUSTOMER_INDUSTRY: tenderCustomer.primary_domain || tenderCustomer.tender_domain || "",
          TENDER_CUSTOMER_ID: String(tenderCustomer.id),
          TENDER_CUSTOMER_STATUS: tenderCustomer.proposal_status || "Pending",
        }
      );
      const html = novaCrmMergeProposalTemplate(template.html_content, data);

      let savedProposal = null;
      if (save) {
        const dbClient = await pool.connect();
        try {
          await dbClient.query("BEGIN");

          const inserted = await dbClient.query(
            `INSERT INTO proposal_files
              (proposal_number, customer_id, tender_customer_id, source_type,
               opportunity, created_by, status, version, file_url)
             VALUES ($1, NULL, $2, 'tender_customer', $3, $4, 'Draft', 1, NULL)
             RETURNING *`,
            [
              proposalNumber,
              tenderCustomer.id,
              opportunity || template.name,
              created_by || null,
            ]
          );
          savedProposal = inserted.rows[0];

          await dbClient.query(
            `INSERT INTO tender_customer_proposals
              (tender_customer_id, proposal_id, proposal_number, created_by)
             VALUES ($1, $2, $3, $4)`,
            [tenderCustomer.id, savedProposal.id, proposalNumber, created_by || null]
          );

          await dbClient.query(
            `UPDATE tender_customers
             SET proposal_status = 'done',
                 last_proposal_id = $1,
                 proposal_created_at = NOW(),
                 updated_at = NOW()
             WHERE id = $2`,
            [savedProposal.id, tenderCustomer.id]
          );

          await dbClient.query("COMMIT");
        } catch (txErr) {
          await dbClient.query("ROLLBACK");
          throw txErr;
        } finally {
          dbClient.release();
        }
      }

      const safeCompany = (tenderCustomer.company_name || "proposal").replace(/[^a-z0-9]+/gi, "-");
      const filename = `${proposalNumber}-${safeCompany}.pdf`;

      return res.json({
        html,
        filename,
        proposal_number: proposalNumber,
        proposal: savedProposal,
        customer: {
          ...tenderBase,
          company_name: tenderCustomer.company_name,
          tender_customer_id: tenderCustomer.id,
          source_type: "tender_customer",
        },
        tender_customer: tenderCustomer,
        template: { id: template.id, name: template.name },
      });
    }

    if (digitization_tender_id) {
      sourceType = "digitization_tender";
      const table =
        digitization_table === "live" ? "digitization_tenders_live" : "digitization_tenders_subcontracting";
      const fkColumn =
        digitization_table === "live" ? "digitization_live_tender_id" : "digitization_subcontracting_tender_id";
      const titleCol = digitization_table === "live" ? "tender_title" : "contract_title";

      const tenderResult = await pool.query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [
        Number(digitization_tender_id),
      ]);
      const tender = tenderResult.rows[0];
      if (!tender) return res.status(404).json({ message: "Digitization tender not found." });

      const companyName =
        tender.prime_contractor || tender.legal_company_name || tender.agency || tender[titleCol];
      const contactEmail =
        tender.company_emails || tender.executive_emails || tender.contracting_officer_contact || "";
      const execName = (tender.executive_names_and_roles || "").split(",")[0]?.trim() || "";

      const tenderBase = {
        ...(tender.raw_data || {}),
        COMPANY_NAME: companyName,
        TENDER_TITLE: tender[titleCol],
        TENDER_SOURCE: tender.source,
        TENDER_AGENCY: tender.agency || "",
        TENDER_DESCRIPTION: tender.description || "",
        TENDER_DOMAIN: tender.domain || "",
        TENDER_URL: tender.sam_url || tender.tender_document_url || "",
        PROPOSAL_SOURCE: `Digitization (${tender.source || "SCAN"}) — ${
          digitization_table === "live" ? "Live Tender" : "Subcontracting Award"
        }`,
      };

      const proposalNumber = overrides.proposal_number || novaCrmGenerateProposalNumber();
      const data = novaCrmBuildProposalTemplateData(
        { company_name: companyName, ...tenderBase },
        {
          ...overrides,
          proposal_number: proposalNumber,
          CUSTOMER_COMPANY_NAME: companyName,
          CUSTOMER_CONTACT_NAME: execName,
          CEO_NAME: execName,
          CUSTOMER_EMAIL: contactEmail,
          CUSTOMER_WEBSITE: tender.official_website || "",
          CUSTOMER_INDUSTRY: tender.domain || tender.subdomain || "",
          DIGITIZATION_TENDER_ID: String(tender.id),
          DIGITIZATION_TENDER_STATUS: tender.proposal_status || "Pending",
        }
      );
      const html = novaCrmMergeProposalTemplate(template.html_content, data);

      let savedProposal = null;
      if (save) {
        const dbClient = await pool.connect();
        try {
          await dbClient.query("BEGIN");
          const inserted = await dbClient.query(
            `INSERT INTO proposal_files
              (proposal_number, customer_id, tender_customer_id, ${fkColumn}, source_type,
               opportunity, created_by, status, version, file_url)
             VALUES ($1, NULL, NULL, $2, 'digitization_tender', $3, $4, 'Draft', 1, NULL)
             RETURNING *`,
            [proposalNumber, tender.id, opportunity || template.name, created_by || null]
          );
          savedProposal = inserted.rows[0];

          await dbClient.query(
            `UPDATE ${table}
             SET proposal_status = 'done', last_proposal_id = $1, proposal_created_at = NOW(), updated_at = NOW()
             WHERE id = $2`,
            [savedProposal.id, tender.id]
          );
          await dbClient.query("COMMIT");
        } catch (txErr) {
          await dbClient.query("ROLLBACK");
          throw txErr;
        } finally {
          dbClient.release();
        }
      }

      const safeCompany = (companyName || "proposal").replace(/[^a-z0-9]+/gi, "-");
      const filename = `${proposalNumber}-${safeCompany}.pdf`;

      return res.json({
        html,
        filename,
        proposal_number: proposalNumber,
        proposal: savedProposal,
        customer: {
          ...tenderBase,
          company_name: companyName,
          digitization_tender_id: tender.id,
          digitization_table,
          source_type: "digitization_tender",
        },
        digitization_tender: tender,
        template: { id: template.id, name: template.name },
      });
    }

    const customerResult = await pool.query(
      `SELECT * FROM customers WHERE id = $1`,
      [customer_id]
    );
    customer = customerResult.rows[0];
    if (!customer) return res.status(404).json({ message: "Customer not found." });

    const proposalNumber = overrides.proposal_number || novaCrmGenerateProposalNumber();
    const data = novaCrmBuildProposalTemplateData(customer, {
      ...overrides,
      proposal_number: proposalNumber,
    });
    const html = novaCrmMergeProposalTemplate(template.html_content, data);

    let savedProposal = null;
    if (save) {
      const inserted = await pool.query(
        `INSERT INTO proposal_files
          (proposal_number, customer_id, tender_customer_id, source_type,
           opportunity, created_by, status, version, file_url)
         VALUES ($1, $2, NULL, 'crm_customer', $3, $4, 'Draft', 1, NULL)
         RETURNING *`,
        [proposalNumber, customer_id, opportunity || template.name, created_by || null]
      );
      savedProposal = inserted.rows[0];
    }

    const safeCompany = (customer.company_name || "proposal").replace(/[^a-z0-9]+/gi, "-");
    const filename = `${proposalNumber}-${safeCompany}.pdf`;

    return res.json({
      html,
      filename,
      proposal_number: proposalNumber,
      proposal: savedProposal,
      customer,
      template: { id: template.id, name: template.name },
    });
  } catch (err) {
    console.error("[PROPOSAL GENERATE]", err);
    return res.status(500).json({ message: "Failed to generate proposal.", error: err.message });
  }
});

/* ============================================================ */
/* -------------------- Customer Files -------------------- */
/* ============================================================ */

app.get("/api/customer-files", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cf.*, c.company_name AS customer_name
       FROM customer_files cf
       LEFT JOIN customers c ON cf.customer_id = c.id
       ORDER BY cf.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/customer-files", async (req, res) => {
  const { customer_id, document_type, file_url, uploaded_by, expiry_date, status } = req.body;
  if (!customer_id || !document_type) {
    return res.status(400).json({ message: "Customer and document type are required." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO customer_files (customer_id, document_type, file_url, uploaded_by, expiry_date, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [customer_id, document_type, file_url || null, uploaded_by || null, expiry_date || null, status || "Pending"]
    );
    res.json({ message: "Customer file added.", file: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add customer file.", error: err.message });
  }
});

app.put("/api/customer-files/:id", async (req, res) => {
  const { id } = req.params;
  const { customer_id, document_type, file_url, uploaded_by, expiry_date, status, is_shared } = req.body;
  try {
    const result = await pool.query(
      `UPDATE customer_files
       SET customer_id = $1, document_type = $2, file_url = $3, uploaded_by = $4, expiry_date = $5, status = $6,
           is_shared = COALESCE($7, is_shared)
       WHERE id = $8 RETURNING *`,
      [customer_id || null, document_type, file_url, uploaded_by, expiry_date || null, status, is_shared, id]
    );
    res.json({ message: "Customer file updated.", file: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update customer file.", error: err.message });
  }
});

app.delete("/api/customer-files/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM customer_files WHERE id = $1", [id]);
    res.json({ message: "Customer file removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete customer file.", error: err.message });
  }
});

app.post("/api/customer-files/delete-selected", async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: "No files selected." });
  }
  try {
    await pool.query("DELETE FROM customer_files WHERE id = ANY($1::int[])", [ids]);
    res.json({ message: `${ids.length} file(s) deleted.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete selected files.", error: err.message });
  }
});

/* ============================================================ */
/* -------------------- AI Assistant Suite -------------------- */
/* ============================================================ */

/*
 * AI configuration
 *
 * Put this in backend/.env:
 *
 * AI_PROVIDER=gemini
 * GEMINI_API_KEY=your_gemini_api_key
 * GEMINI_MODEL=gemini-2.0-flash
 *
 * (or AI_PROVIDER=groq with GROQ_API_KEY / GROQ_MODEL to go back to Groq)
 *
 * Get a free Gemini key at https://aistudio.google.com/apikey
 * See available Gemini models at https://ai.google.dev/gemini-api/docs/models
 */

const AI_MODEL =
  AI_PROVIDER === "gemini"
    ? process.env.GEMINI_MODEL || "gemini-2.0-flash"
    : process.env.GROQ_MODEL || process.env.AI_MODEL || "openai/gpt-oss-120b";

const AI_SYSTEM_PROMPT =
  "You are the AI Sales Assistant inside a CRM. " +
  "Help the sales representative with quick answers, " +
  "customer discussions, deals, sales strategy, email writing, " +
  "meeting preparation, and day-to-day sales work. " +
  "Be concise, practical, professional, and actionable.";


/* ============================================================ */
/* Groq model availability check                                */
/* ============================================================ */

async function checkGroqModelAccess() {
  if (AI_PROVIDER !== "groq") return; // this check only applies to Groq's /models endpoint
  if (!process.env.GROQ_API_KEY) {
    console.error(
      "[AI] GROQ_API_KEY is missing. AI features cannot work."
    );
    return;
  }

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/models",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "[AI] Unable to retrieve Groq models:",
        data?.error?.message || data
      );
      return;
    }

    const models = Array.isArray(data?.data)
      ? data.data.map((model) => model.id)
      : [];

    if (models.includes(AI_MODEL)) {
      console.log(`[AI] Groq model available: ${AI_MODEL}`);
    } else {
      console.error(
        `[AI] WARNING: Groq model "${AI_MODEL}" is not available to this API key.`
      );

      console.error(
        "[AI] Models available to this API key:"
      );

      console.error(
        models.length
          ? models.join(", ")
          : "No models returned."
      );
    }
  } catch (error) {
    console.error(
      "[AI] Failed to check Groq model access:",
      error?.message || error
    );
  }
}


/* ============================================================ */
/* Common Groq/OpenAI-compatible AI function                   */
/* ============================================================ */

async function callOpenAI(messages) {
  const activeKey = AI_PROVIDER === "gemini" ? process.env.GEMINI_API_KEY : process.env.GROQ_API_KEY;
  const keyName = AI_PROVIDER === "gemini" ? "GEMINI_API_KEY" : "GROQ_API_KEY";
  const providerLabel = AI_PROVIDER === "gemini" ? "Gemini" : "Groq";

  if (!activeKey) {
    throw new Error(
      `${keyName} is not configured in backend/.env.`
    );
  }

  try {
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages,
      temperature: 0.7,
    });

    const content = completion?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error(
        `${providerLabel} returned an empty AI response.`
      );
    }

    return content.trim();
  } catch (err) {
    console.error(`[AI] ${providerLabel} request failed:`);
    console.error(err);

    if (err?.status === 401) {
      throw new Error(
        `${providerLabel} authentication failed. Check ${keyName}.`
      );
    }

    if (err?.status === 403) {
      throw new Error(
        `${providerLabel} denied access to model "${AI_MODEL}". Check your ${providerLabel} project/model permissions.`
      );
    }

    if (err?.status === 404) {
      throw new Error(
        `${providerLabel} model "${AI_MODEL}" was not found or is not available to this API key.`
      );
    }

    if (err?.status === 429) {
      throw new Error(
        `${providerLabel} rate limit reached. Please wait a moment and try again.`
      );
    }

    throw new Error(
      err?.message || `${providerLabel} AI request failed.`
    );
  }
}


/* ============================================================ */
/* AI Chat                                                      */
/* ============================================================ */

app.get("/api/ai/chat/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({
      message: "sessionId is required.",
    });
  }

  try {
    const result = await pool.query(
      `
        SELECT
          id,
          session_id,
          role,
          content,
          created_at
        FROM ai_chat_messages
        WHERE session_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [sessionId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("[AI CHAT GET]", err);

    return res.status(500).json({
      message: "Failed to load AI chat history.",
      error: err?.message || "Unknown database error.",
    });
  }
});


app.post("/api/ai/chat", async (req, res) => {
  const { session_id, message } = req.body || {};

  if (!session_id || typeof session_id !== "string") {
    return res.status(400).json({
      message: "session_id is required.",
    });
  }

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      message: "message is required.",
    });
  }

  const userMessage = message.trim();

  try {
    /*
     * Save user message first.
     */
    await pool.query(
      `
        INSERT INTO ai_chat_messages
          (session_id, role, content)
        VALUES
          ($1, 'user', $2)
      `,
      [session_id, userMessage]
    );


    /*
     * Load conversation history.
     */
    const history = await pool.query(
      `
        SELECT
          role,
          content
        FROM ai_chat_messages
        WHERE session_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [session_id]
    );


    /*
     * Keep only valid chat roles.
     */
    const chatHistory = history.rows
      .filter(
        (row) =>
          row.role === "user" ||
          row.role === "assistant"
      )
      .map((row) => ({
        role: row.role,
        content: row.content,
      }));


    const messages = [
      {
        role: "system",
        content: AI_SYSTEM_PROMPT,
      },
      ...chatHistory,
    ];


    /*
     * Ask Groq.
     */
    const reply = await callOpenAI(messages);


    /*
     * Save AI response.
     */
    await pool.query(
      `
        INSERT INTO ai_chat_messages
          (session_id, role, content)
        VALUES
          ($1, 'assistant', $2)
      `,
      [session_id, reply]
    );


    return res.json({
      reply,
      model: AI_MODEL,
    });
  } catch (err) {
    console.error("[AI CHAT POST]", err);

    return res.status(500).json({
      message: "AI chat failed.",
      error: err?.message || "Unknown AI error.",
    });
  }
});



/* ============================================================ */
/* Check Groq after server configuration has loaded              */
/* ============================================================ */

checkGroqModelAccess().catch((err) => {
  console.error(
    "[AI] Groq startup check failed:",
    err?.message || err
  );
});

;

/* ============================================================ */
/* -------------------- Leads -------------------- */
/* ============================================================ */

app.get("/api/leads", async (req, res) => {
  const { status, assigned_to } = req.query;
  try {
    const conditions = [];
    const params = [];
    if (status) {
      params.push(status);
      conditions.push(`l.status = $${params.length}`);
    }
    if (assigned_to) {
      params.push(assigned_to);
      conditions.push(`l.assigned_to = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT l.*, c.company_name AS customer_name, c.email AS customer_email,
              c.contact_name AS customer_contact_name,
              (
                SELECT o.id
                FROM opportunities o
                WHERE o.lead_id = l.id
                ORDER BY o.id DESC
                LIMIT 1
              ) AS opportunity_id
       FROM leads l
       LEFT JOIN customers c ON l.customer_id = c.id
       ${where}
       ORDER BY l.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Read the capture switch shown in Sales.tsx. This MUST be registered
// before GET /api/leads/:id below — otherwise Express matches
// "email-capture" as an :id first and crashes trying to cast it to
// bigint (that was the exact bug: "invalid input syntax for type
// bigint: email-capture").
app.get("/api/leads/email-capture", async (req, res) => {
  try {
    const enabled = await getEmailCaptureEnabled();
    res.json({ enabled, configured: Boolean(EMAIL_USER && EMAIL_PASSWORD && IMAP_SERVER) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to read email capture setting.", error: err.message });
  }
});

app.get("/api/leads/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT l.*, c.company_name AS customer_name
       FROM leads l
       LEFT JOIN customers c ON l.customer_id = c.id
       WHERE l.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Not found." });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/leads", async (req, res) => {
  const { title, source, status, estimated_value, customer_id, notes, assigned_to } = req.body;
  if (!title) return res.status(400).json({ message: "Title is required." });
  try {
    const result = await pool.query(
      `INSERT INTO leads (title, source, status, estimated_value, customer_id, notes, assigned_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title, source || null, status || "new", estimated_value || 0, customer_id || null, notes || null, assigned_to || null]
    );
    res.json({ message: "Lead added.", lead: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add lead.", error: err.message });
  }
});

app.put("/api/leads/:id", async (req, res) => {
  const { id } = req.params;
  const { title, source, status, estimated_value, customer_id, notes } = req.body;
  try {
    const result = await pool.query(
      `UPDATE leads
       SET title = $1, source = $2, status = $3, estimated_value = $4, customer_id = $5, notes = $6
       WHERE id = $7 RETURNING *`,
      [title, source, status, estimated_value || 0, customer_id || null, notes, id]
    );
    res.json({ message: "Lead updated.", lead: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update lead.", error: err.message });
  }
});

app.delete("/api/leads/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM leads WHERE id = $1", [id]);
    res.json({ message: "Lead removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete lead.", error: err.message });
  }
});

/* ---------- AI Lead Scoring ---------- */

app.post("/api/leads/:id/score", async (req, res) => {
  const { id } = req.params;
  try {
    const leadResult = await pool.query(
      `SELECT l.*, c.company_name AS customer_name
       FROM leads l
       LEFT JOIN customers c ON l.customer_id = c.id
       WHERE l.id = $1`,
      [id]
    );
    const lead = leadResult.rows[0];
    if (!lead) return res.status(404).json({ message: "Lead not found." });

    const context = `Title: ${lead.title}
Source: ${lead.source || "N/A"}
Status: ${lead.status}
Estimated value: ₹${Number(lead.estimated_value || 0).toLocaleString("en-IN")}
Notes: ${lead.notes || ""}
Customer: ${lead.customer_name || ""}`;

    const prompt = `Score this sales lead from 0 to 100 based on how likely it is to convert, considering the source, estimated value, status, and notes.

${context}

Respond with ONLY valid JSON, no markdown fences, no commentary, in this exact shape:
{ "score": 0, "reason": "..." }`;

    const raw = await callOpenAI([
      { role: "system", content: "You are an expert B2B sales analyst. You always respond with strict JSON only." },
      { role: "user", content: prompt },
    ]);

    let data;
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      data = JSON.parse(cleaned);
    } catch (parseErr) {
      return res.status(500).json({ message: "AI returned an unexpected format. Try again.", error: parseErr.message });
    }

    const score = Math.max(0, Math.min(100, Math.round(Number(data.score) || 0)));
    const result = await pool.query(
      "UPDATE leads SET score = $1, ai_insight = $2 WHERE id = $3 RETURNING *",
      [score, data.reason || null, id]
    );
    res.json({ lead: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Lead scoring failed.", error: err.message });
  }
});

/* ---------- Lead Assignment ---------- */

app.put("/api/leads/:id/assign", async (req, res) => {
  const { id } = req.params;
  const { assigned_to } = req.body;
  try {
    const result = await pool.query(
      "UPDATE leads SET assigned_to = $1 WHERE id = $2 RETURNING *",
      [assigned_to || null, id]
    );
    res.json({ message: "Lead assigned.", lead: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Lead Conversion (lead -> opportunity) ---------- */

app.post("/api/leads/:id/convert", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const leadResult = await client.query("SELECT * FROM leads WHERE id = $1", [id]);
    const lead = leadResult.rows[0];
    if (!lead) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Lead not found." });
    }
    const existingOppResult = await client.query(
      `SELECT * FROM opportunities WHERE lead_id = $1 ORDER BY id DESC LIMIT 1`,
      [lead.id]
    );

    let opportunity;
    if (existingOppResult.rows[0]) {
      opportunity = existingOppResult.rows[0];
    } else {
      const oppResult = await client.query(
        `INSERT INTO opportunities (title, customer_id, lead_id, stage, value, probability, owner, notes, value_source)
         VALUES ($1, $2, $3, 'Prospecting', $4, 50, $5, $6, $7) RETURNING *`,
        [
          lead.title,
          lead.customer_id,
          lead.id,
          lead.estimated_value || 0,
          lead.assigned_to || null,
          lead.notes || null,
          "manual-lead-conversion",
        ]
      );
      opportunity = oppResult.rows[0];
    }
    const updatedLeadResult = await client.query(
      "UPDATE leads SET status = 'converted', converted_opportunity_id = $1 WHERE id = $2 RETURNING *",
      [opportunity.id, id]
    );
    await client.query("COMMIT");
    res.json({ message: "Lead converted.", lead: updatedLeadResult.rows[0], opportunity });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ message: "Conversion failed.", error: err.message });
  } finally {
    client.release();
  }
});

/* ============================================================ */
/* -------------------- Pipeline: Opportunities -------------------- */
/* ============================================================ */

app.get("/api/pipeline-stages", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pipeline_stages ORDER BY position");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/pipeline-stages", async (req, res) => {
  const { name, position, is_won, is_lost } = req.body;
  if (!name) return res.status(400).json({ message: "Stage name is required." });
  try {
    const result = await pool.query(
      "INSERT INTO pipeline_stages (name, position, is_won, is_lost) VALUES ($1, $2, $3, $4) RETURNING *",
      [name, position || 99, !!is_won, !!is_lost]
    );
    res.json({ message: "Stage created.", stage: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ message: "A stage with that name already exists." });
    }
    console.error(err);
    res.status(500).json({ message: "Failed to create stage.", error: err.message });
  }
});

app.get("/api/opportunities", async (req, res) => {
  const { stage } = req.query;
  try {
    const params = [];
    let where = "";
    if (stage) {
      params.push(stage);
      where = `WHERE o.stage = $1`;
    }
    const result = await pool.query(
      `SELECT o.*, c.company_name AS customer_name
       FROM opportunities o
       LEFT JOIN customers c ON o.customer_id = c.id
       ${where}
       ORDER BY o.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/opportunities", async (req, res) => {
  const { title, customer_id, lead_id, stage, value, probability, expected_close_date, owner, notes } = req.body;
  if (!title) return res.status(400).json({ message: "Title is required." });
  try {
    const result = await pool.query(
      `INSERT INTO opportunities (title, customer_id, lead_id, stage, value, probability, expected_close_date, owner, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        title,
        customer_id || null,
        lead_id || null,
        stage || "Prospecting",
        value || 0,
        probability || 50,
        expected_close_date || null,
        owner || null,
        notes || null,
      ]
    );
    res.json({ message: "Opportunity added.", opportunity: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add opportunity.", error: err.message });
  }
});

app.put("/api/opportunities/:id", async (req, res) => {
  const { id } = req.params;
  const { title, customer_id, stage, value, probability, expected_close_date, owner, notes } = req.body;
  try {
    const result = await pool.query(
      `UPDATE opportunities
       SET title = $1, customer_id = $2, stage = $3, value = $4, probability = $5,
           expected_close_date = $6, owner = $7, notes = $8
       WHERE id = $9 RETURNING *`,
      [title, customer_id || null, stage, value || 0, probability || 50, expected_close_date || null, owner, notes, id]
    );
    res.json({ message: "Opportunity updated.", opportunity: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update opportunity.", error: err.message });
  }
});

app.put("/api/opportunities/:id/stage", async (req, res) => {
  const { id } = req.params;
  const { stage } = req.body;
  if (!stage) return res.status(400).json({ message: "Stage is required." });
  try {
    const result = await pool.query(
      "UPDATE opportunities SET stage = $1 WHERE id = $2 RETURNING *",
      [stage, id]
    );
    res.json({ message: "Stage updated.", opportunity: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/opportunities/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM opportunities WHERE id = $1", [id]);
    res.json({ message: "Opportunity removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete opportunity.", error: err.message });
  }
});

/* ============================================================ */
/* -------------------- Tasks & Activities -------------------- */
/* ============================================================ */

app.get("/api/tasks", async (req, res) => {
  const { related_type, related_id, status } = req.query;
  try {
    const conditions = [];
    const params = [];
    if (related_type) {
      params.push(related_type);
      conditions.push(`related_type = $${params.length}`);
    }
    if (related_id) {
      params.push(related_id);
      conditions.push(`related_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT * FROM tasks ${where} ORDER BY due_date IS NULL, due_date ASC, created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tasks", async (req, res) => {
  const { title, description, due_date, status, priority, related_type, related_id, assigned_to } = req.body;
  if (!title) return res.status(400).json({ message: "Title is required." });
  try {
    const result = await pool.query(
      `INSERT INTO tasks (title, description, due_date, status, priority, related_type, related_id, assigned_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        title,
        description || null,
        due_date || null,
        status || "todo",
        priority || "medium",
        related_type || null,
        related_id || null,
        assigned_to || null,
      ]
    );
    res.json({ message: "Task added.", task: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add task.", error: err.message });
  }
});

app.put("/api/tasks/:id", async (req, res) => {
  const { id } = req.params;
  const { title, description, due_date, status, priority, assigned_to } = req.body;
  try {
    const result = await pool.query(
      `UPDATE tasks
       SET title = $1, description = $2, due_date = $3, status = $4, priority = $5, assigned_to = $6
       WHERE id = $7 RETURNING *`,
      [title, description, due_date || null, status, priority, assigned_to, id]
    );
    res.json({ message: "Task updated.", task: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update task.", error: err.message });
  }
});

app.put("/api/tasks/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const allowed = ["todo", "in_progress", "done"];
  if (!allowed.includes(status)) return res.status(400).json({ message: "Invalid status." });
  try {
    const result = await pool.query(
      "UPDATE tasks SET status = $1 WHERE id = $2 RETURNING *",
      [status, id]
    );
    res.json({ message: "Status updated.", task: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/tasks/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM tasks WHERE id = $1", [id]);
    res.json({ message: "Task removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete task.", error: err.message });
  }
});

/* ============================================================ */
/* -------------------- Calendar -------------------- */
/* ============================================================ */

app.get("/api/calendar-events", async (req, res) => {
  const { from, to } = req.query;
  try {
    const conditions = [];
    const params = [];
    if (from) {
      params.push(from);
      conditions.push(`start_time >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`start_time <= $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT * FROM calendar_events ${where} ORDER BY start_time ASC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/calendar-events", async (req, res) => {
  const { title, description, start_time, end_time, related_type, related_id, created_by } = req.body;
  if (!title || !start_time) {
    return res.status(400).json({ message: "Title and start time are required." });
  }
  try {
    const result = await pool.query(
      `INSERT INTO calendar_events (title, description, start_time, end_time, related_type, related_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title, description || null, start_time, end_time || null, related_type || null, related_id || null, created_by || null]
    );
    res.json({ message: "Event added.", event: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add event.", error: err.message });
  }
});

app.put("/api/calendar-events/:id", async (req, res) => {
  const { id } = req.params;
  const { title, description, start_time, end_time } = req.body;
  try {
    const result = await pool.query(
      `UPDATE calendar_events
       SET title = $1, description = $2, start_time = $3, end_time = $4
       WHERE id = $5 RETURNING *`,
      [title, description, start_time, end_time || null, id]
    );
    res.json({ message: "Event updated.", event: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update event.", error: err.message });
  }
});

app.delete("/api/calendar-events/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM calendar_events WHERE id = $1", [id]);
    res.json({ message: "Event removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete event.", error: err.message });
  }
});

/* ============================================================ */
/* -------------------- Approval Workflow -------------------- */
/* ============================================================ */

app.get("/api/approvals", async (req, res) => {
  const { status } = req.query;
  try {
    const params = [];
    let where = "";
    if (status) {
      params.push(status);
      where = `WHERE status = $1`;
    }
    const result = await pool.query(
      `SELECT * FROM approvals ${where} ORDER BY created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/approvals", async (req, res) => {
  const { type, related_type, related_id, requested_by, approver, notes } = req.body;
  if (!type) return res.status(400).json({ message: "Type is required." });
  try {
    const result = await pool.query(
      `INSERT INTO approvals (type, related_type, related_id, requested_by, approver, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [type, related_type || null, related_id || null, requested_by || null, approver || null, notes || null]
    );
    res.json({ message: "Approval requested.", approval: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to request approval.", error: err.message });
  }
});

app.put("/api/approvals/:id/decision", async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;
  const allowed = ["Approved", "Rejected", "Pending"];
  if (!allowed.includes(status)) return res.status(400).json({ message: "Invalid status." });
  try {
    const result = await pool.query(
      `UPDATE approvals
       SET status = $1, notes = COALESCE($2, notes), decided_at = CASE WHEN $1 = 'Pending' THEN NULL ELSE NOW() END
       WHERE id = $3 RETURNING *`,
      [status, notes || null, id]
    );
    res.json({ message: "Approval updated.", approval: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/approvals/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM approvals WHERE id = $1", [id]);
    res.json({ message: "Approval removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete approval.", error: err.message });
  }
});

/* ============================================================ */
/* -------------------- Lead Capture via Email -------------------- */
/* ============================================================ */
/* Polls a mailbox over IMAP and turns each unread email into a Lead
   automatically:
   - Subject becomes the lead title
   - Sender + body go into notes
   - If the sender's address matches an existing customer's email,
     the lead is linked to that customer (customer_id) — this is the
     "receive from customer" behavior. If there's no match, the lead
     is still created, just without a customer_id, so someone can
     manually attach/create the customer later.
   Manual lead creation (the "New lead" dialog in Sales.tsx) keeps
   working exactly as before — this only adds a second, automatic
   source.

   Uses the company mailbox (same account for both send and receive):
     EMAIL          e.g. pradeep@orbitavanyatech.com
     EMAIL_PASSWORD its mailbox password
     IMAP_SERVER    IMAP host (defaults to SMTP_SERVER, since cPanel-
                    style hosting usually serves both on one host)
     IMAP_PORT      defaults to 993
*/

const EMAIL_USER = process.env.EMAIL;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
const SMTP_SERVER = process.env.SMTP_SERVER;
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const IMAP_SERVER = process.env.IMAP_SERVER || SMTP_SERVER;
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const EMAIL_POLL_INTERVAL_MS = 2 * 60 * 1000; // check every 2 minutes

// ---------------------------------------------------------------------
// Senders the inbox poller should never turn into leads/opportunities:
//   - bounce/daemon addresses (mailer-daemon, postmaster, no-reply, etc.)
//   - anything @ the mail server's own hostname (bounces land here, not
//     real customer replies — a customer's domain is never the IMAP/SMTP
//     hostname itself)
//   - the mailbox's own address, in case of a self-send loop
// Add more addresses/domains via IGNORED_EMAIL_SENDERS in .env
// (comma-separated, case-insensitive, exact address or bare domain).
// ---------------------------------------------------------------------
const IGNORED_SENDER_PATTERNS = [
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^no-?reply@/i,
  /^bounce/i,
  /^avanyate@/i, // hosting/system account, not a real customer
];

const IGNORED_SENDER_DOMAINS = new Set(
  [IMAP_SERVER, SMTP_SERVER]
    .filter(Boolean)
    .flatMap((host) => {
      const h = host.toLowerCase();
      // Match both the full hostname (s13429.bom1.stableserver.net) and
      // just its first label (s13429) — cron/system mail on shared
      // hosting often uses the short hostname as the domain part.
      return [h, h.split(".")[0]];
    })
);

const EXTRA_IGNORED_SENDERS = new Set(
  (process.env.IGNORED_EMAIL_SENDERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function isIgnoredSender(fromEmail, fromName) {
  if (!fromEmail) return false;
  const email = fromEmail.toLowerCase();
  const domain = email.split("@")[1] || "";
  const name = (fromName || "").trim().toLowerCase();

  // Linux/cPanel cron jobs always set the display name to "Cron" —
  // this is the most reliable signal for "server-generated mail",
  // independent of whatever address/domain it happens to use.
  if (name === "cron") return true;

  if (email === (EMAIL_USER || "").toLowerCase()) return true;
  if (IGNORED_SENDER_DOMAINS.has(domain)) return true;
  if (EXTRA_IGNORED_SENDERS.has(email) || EXTRA_IGNORED_SENDERS.has(domain)) return true;
  return IGNORED_SENDER_PATTERNS.some((re) => re.test(email));
}

// ---------------------------------------------------------------------
// Email lead capture on/off switch.
// Backed by the email_capture_settings table (single row) so it
// persists across restarts and is shared by every server process.
// Sales.tsx reads/writes this via /api/leads/email-capture.
// ---------------------------------------------------------------------
async function getEmailCaptureEnabled() {
  try {
    const result = await pool.query(
      `SELECT enabled FROM email_capture_settings WHERE id = 1`
    );
    if (result.rows.length === 0) return true; // default: on
    return Boolean(result.rows[0].enabled);
  } catch (err) {
    console.error("Failed to read email_capture_settings, defaulting to enabled:", err.message);
    return true;
  }
}

async function setEmailCaptureEnabled(enabled) {
  await pool.query(
    `INSERT INTO email_capture_settings (id, enabled, updated_at)
     VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET enabled = $1, updated_at = NOW()`,
    [Boolean(enabled)]
  );
  return Boolean(enabled);
}


function parseMoneyAmount(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase().replace(/,/g, "").replace(/\s+/g, "");
  const suffix = s.match(/(lakh|lac|crore|cr|k|m)$/i)?.[1]?.toLowerCase();
  if (suffix) s = s.slice(0, -suffix.length);
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (suffix === "k") return n * 1_000;
  if (suffix === "m") return n * 1_000_000;
  if (suffix === "lakh" || suffix === "lac") return n * 100_000;
  if (suffix === "crore" || suffix === "cr") return n * 10_000_000;
  return n;
}

async function estimateLeadValueFromEmail(subject, text) {
  const content = `${subject || ""}\n${text || ""}`;
  const lower = content.toLowerCase();

  // Explicit INR/₹ amount wins.
  const inrMatch = content.match(
    /(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(lakh|lac|crore|cr|k|m)?/i
  );
  if (inrMatch) {
    const value = parseMoneyAmount(`${inrMatch[1]}${inrMatch[2] || ""}`);
    if (value) return { value, source: "email:explicit-inr" };
  }

  // Explicit USD amount is converted to INR using an environment-controlled rate.
  const usdMatch = content.match(
    /(?:\$|usd)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|m)?/i
  );
  if (usdMatch) {
    const usd = parseMoneyAmount(`${usdMatch[1]}${usdMatch[2] || ""}`);
    const rate = Number(process.env.USD_TO_INR_RATE || 88);
    if (usd && Number.isFinite(rate) && rate > 0) {
      return { value: Math.round(usd * rate), source: `email:usd-converted@${rate}` };
    }
  }

  // "budget/value/price ... 80000" without a currency is treated as INR.
  const plainMatch = content.match(
    /(?:budget|estimated\s+value|project\s+value|deal\s+value|investment|price|worth)\s*(?:is|of|around|about|:|-)?\s*(?:rs\.?|inr|₹)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(lakh|lac|crore|cr|k|m)?/i
  );
  if (plainMatch) {
    const value = parseMoneyAmount(`${plainMatch[1]}${plainMatch[2] || ""}`);
    if (value) return { value, source: "email:budget-text" };
  }

  // If no amount is written, use the first matching service in the pricing
  // catalog so an email such as "CRM demo" gets a useful starting value.
  try {
    const catalog = await pool.query(
      "SELECT service_name, starting_price FROM pricing_catalog WHERE starting_price IS NOT NULL"
    );
    const matching = catalog.rows.find((row) => {
      const service = String(row.service_name || "").toLowerCase();
      const words = service.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
      return words.some((word) => lower.includes(word));
    });
    if (matching) {
      const value = parseMoneyAmount(String(matching.starting_price).replace(/[^\d.]/g, ""));
      if (value) return { value, source: `pricing-catalog:${matching.service_name}` };
    }
  } catch (catalogErr) {
    appendRuntimeLog("WARN", "Could not estimate lead value from pricing catalog", {
      message: catalogErr.message,
    });
  }

  const defaultValue = Number(process.env.DEFAULT_LEAD_VALUE_INR || 0);
  if (defaultValue > 0 && /(demo|crm|software|website|app|proposal|quote|inquiry|project)/i.test(content)) {
    return { value: Math.round(defaultValue), source: "email:default-demo-value" };
  }

  return { value: 0, source: "email:no-value-found" };
}

async function findCustomerIdByEmail(fromEmail) {
  if (!fromEmail) return null;
  const result = await pool.query(
    "SELECT id FROM customers WHERE LOWER(email) = LOWER($1) LIMIT 1",
    [fromEmail]
  );
  return result.rows[0] ? result.rows[0].id : null;
}

async function createLeadFromEmail({ fromEmail, fromName, subject, text, messageId, receivedAt }) {
  const customerId = await findCustomerIdByEmail(fromEmail);
  const title = subject && subject.trim()
    ? subject.trim()
    : `Inquiry from ${fromName || fromEmail || "unknown sender"}`;

  const noteParts = [];
  if (fromEmail) noteParts.push(`From: ${fromName ? `${fromName} <${fromEmail}>` : fromEmail}`);
  if (text) noteParts.push(text.trim().slice(0, 4000));

  // Check whether this email was already processed.
  // IMPORTANT: the communication may already have been created
  // by createCommunicationFromEmail(), so we only treat it as
  // a duplicate if a lead is already linked to that communication.
  if (messageId) {
    const existing = await pool.query(
      `
    SELECT c.id AS communication_id, c.lead_id
    FROM communications c
    WHERE c.message_id = $1
    LIMIT 1
    `,
      [messageId]
    );

    if (existing.rows[0]?.lead_id) {
      return {
        leadId: existing.rows[0].lead_id,
        communicationId: existing.rows[0].communication_id,
        duplicate: true,
      };
    }
  }

  // Reuse the communication already created by the inbound email handler.
  // This prevents one email from creating two communication rows.
  let communicationId = null;
  if (messageId) {
    const communicationResult = await pool.query(
      `SELECT id, lead_id FROM communications WHERE message_id = $1 LIMIT 1`,
      [messageId]
    );
    if (communicationResult.rows[0]) {
      communicationId = communicationResult.rows[0].id;
      if (communicationResult.rows[0].lead_id) {
        return {
          leadId: communicationResult.rows[0].lead_id,
          communicationId,
          duplicate: true,
        };
      }
    }
  }

  // Fallback for manually-triggered/legacy ingestion where no communication
  // row exists yet. The normal IMAP path should always hit the branch above.
  if (!communicationId) {
    const communicationResult = await pool.query(
      `INSERT INTO communications
        (customer_id, type, direction, subject, body, sender_email, sender_name,
         recipient_email, recipient_name, status, message_id, is_read, received_at)
       VALUES ($1, 'email', 'inbound', $2, $3, $4, $5, $6, NULL, 'received', $7, false, $8)
       RETURNING id`,
      [
        customerId,
        subject || null,
        text ? text.trim().slice(0, 50000) : null,
        fromEmail || null,
        fromName || null,
        EMAIL_USER || null,
        messageId || null,
        receivedAt || new Date(),
      ]
    );
    communicationId = communicationResult.rows[0].id;
  }

  const estimate = await estimateLeadValueFromEmail(subject, text);

  const leadNotes = [
    ...noteParts,
    `Auto-estimated value: ₹${Number(estimate.value || 0).toLocaleString("en-IN")} (${estimate.source})`,
  ];

  const leadResult = await pool.query(
    `INSERT INTO leads (title, source, status, estimated_value, customer_id, notes, value_source)
     VALUES ($1, 'Email', 'new', $2, $3, $4, $5) RETURNING id`,
    [title, estimate.value || 0, customerId, leadNotes.join("\n\n") || null, estimate.source]
  );
  const leadId = leadResult.rows[0].id;

  // Every inbound sales email now creates a pipeline opportunity as well.
  // It stays in Prospecting until the sales team moves it forward.
  const opportunityResult = await pool.query(
    `INSERT INTO opportunities
       (title, customer_id, lead_id, stage, value, probability, owner, notes, value_source)
     VALUES ($1, $2, $3, 'Prospecting', $4, 25, NULL, $5, $6)
     RETURNING id`,
    [
      title,
      customerId,
      leadId,
      estimate.value || 0,
      `Created automatically from inbound email. ${estimate.source}`,
      estimate.source,
    ]
  );
  const opportunityId = opportunityResult.rows[0].id;

  await pool.query(
    `UPDATE leads SET converted_opportunity_id = NULL WHERE id = $1`,
    [leadId]
  );

  await pool.query(
    `UPDATE communications
     SET lead_id = $1, opportunity_id = $2
     WHERE id = $3`,
    [leadId, opportunityId, communicationId]
  );

  appendRuntimeLog("INFO", "Inbound email converted into lead + pipeline opportunity", {
    communicationId,
    leadId,
    opportunityId,
    fromEmail,
    estimatedValue: estimate.value || 0,
    valueSource: estimate.source,
  });

  console.log(
    `Email #${communicationId} captured from ${fromEmail || "unknown"} → lead #${leadId} → opportunity #${opportunityId}` +
    (customerId ? ` — linked to customer #${customerId}` : " — no matching customer")
  );

  return { leadId, communicationId, opportunityId, duplicate: false };
}

async function createCommunicationFromEmail({
  fromEmail,
  fromName,
  toEmail,
  toName,
  subject,
  text,
  messageId,
  threadId,
  receivedAt,
}) {
  try {
    if (!fromEmail && !text && !subject) {
      return null;
    }

    // Find matching customer by email.
    const customerResult = await pool.query(
      `
  SELECT id, company_name, email
  FROM customers
  WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
  LIMIT 1
  `,
      [fromEmail || ""]
    );

    const customer = customerResult.rows[0] || null;

    console.log(
      `Customer lookup for ${fromEmail || "unknown sender"}:`,
      customer
        ? `customer #${customer.id} (${customer.company_name})`
        : "no matching customer"
    );

    // Prevent duplicate emails.
    if (messageId) {
      const duplicateResult = await pool.query(
        `
        SELECT id
        FROM communications
        WHERE message_id = $1
        LIMIT 1
        `,
        [messageId]
      );

      if (duplicateResult.rows.length > 0) {
        console.log(
          `Communication already exists for message ${messageId}`
        );

        return duplicateResult.rows[0].id;
      }
    }

    // Save incoming email in PostgreSQL.
    const result = await pool.query(
      `
      INSERT INTO communications (
        customer_id,
        type,
        direction,
        subject,
        body,
        sender_email,
        sender_name,
        recipient_email,
        recipient_name,
        status,
        message_id,
        thread_id,
        is_read,
        received_at
      )
      VALUES (
        $1,
        'email',
        'inbound',
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        'received',
        $8,
        $9,
        false,
        $10
      )
      RETURNING *
      `,
      [
        customer ? customer.id : null,
        subject || null,
        text ? text.trim().slice(0, 50000) : null,
        fromEmail || null,
        fromName || null,
        toEmail || null,
        toName || null,
        messageId || null,
        threadId || null,
        receivedAt || new Date(),
      ]
    );

    const communication = result.rows[0];

    console.log(
      `Communication #${communication.id} received from ${fromEmail || "unknown sender"
      }`
    );

    // Create notification.
    await pool.query(
      `
      INSERT INTO notifications (
        type,
        title,
        message,
        link,
        related_type,
        related_id,
        read
      )
      VALUES (
        'email',
        $1,
        $2,
        $3,
        'communication',
        $4,
        false
      )
      `,
      [
        subject
          ? `New email: ${subject}`
          : "New incoming email",
        `Email received from ${fromName || fromEmail || "unknown sender"
        }`,
        "/communications",
        communication.id,
      ]
    );

    console.log(
      `Notification created for communication #${communication.id}`
    );

    return communication.id;
  } catch (err) {
    console.error(
      "Failed to create communication from email:",
      err
    );

    throw err;
  }
}

async function checkInboxForLeads() {
  if (!EMAIL_USER || !EMAIL_PASSWORD || !IMAP_SERVER) {
    console.log(
      "Email lead capture is not configured — set EMAIL, EMAIL_PASSWORD, and SMTP_SERVER (or IMAP_SERVER) to enable it."
    );
    return { created: 0, configured: false, enabled: false };
  }

  // Capture toggle (Sales.tsx): when off, don't even connect — just leave
  // existing leads/opportunities/communications exactly as they are.
  const enabled = await getEmailCaptureEnabled();
  if (!enabled) {
    return { created: 0, configured: true, enabled: false };
  }

  const client = new ImapFlow({
    host: IMAP_SERVER,
    port: IMAP_PORT,
    secure: true,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASSWORD,
    },
    logger: false,
  });

  let created = 0;

  await client.connect();

  try {
    const lock = await client.getMailboxLock("INBOX");

    try {
      const uids = await client.search({ seen: false });
      let failedCount = 0;
      let skippedCount = 0;
      const MAX_FAILURE_LOGS = 5; // don't flood the terminal on a big backlog

      for (const uid of uids) {
        try {
          const message = await client.download(uid);

          // A message can come back with no downloadable content (already
          // expunged between search and download, a bodiless notification,
          // etc). Treat that the same as any other unprocessable message
          // instead of letting simpleParser throw an unclear error.
          if (!message || !message.content) {
            throw new Error("message has no content (likely deleted/expunged, or a bodiless system message)");
          }

          const parsed = await simpleParser(message.content);

          // ---------------------------------------------
          // Sender
          // ---------------------------------------------

          const fromEmail =
            parsed.from &&
              parsed.from.value &&
              parsed.from.value[0]
              ? parsed.from.value[0].address
              : null;

          const fromName =
            parsed.from &&
              parsed.from.value &&
              parsed.from.value[0]
              ? parsed.from.value[0].name
              : null;

          // ---------------------------------------------
          // Skip bounces / daemon mail / self-sends so they don't
          // spam the CRM with a new lead + opportunity every poll.
          // ---------------------------------------------

          if (isIgnoredSender(fromEmail, fromName)) {
            // Silent — these are expected (bounces/cron/etc), not worth a
            // line per email. A single count is logged after the loop.
            skippedCount++;
            await client.messageFlagsAdd(uid, ["\\Seen"]);
            continue;
          }

          // ---------------------------------------------
          // Recipient
          // ---------------------------------------------

          const toEmail =
            parsed.to &&
              parsed.to.value &&
              parsed.to.value[0]
              ? parsed.to.value[0].address
              : EMAIL_USER;

          const toName =
            parsed.to &&
              parsed.to.value &&
              parsed.to.value[0]
              ? parsed.to.value[0].name
              : null;

          // ---------------------------------------------
          // Message ID
          // ---------------------------------------------

          const messageId = parsed.messageId || null;

          // ---------------------------------------------
          // Email thread
          // ---------------------------------------------

          const threadId =
            parsed.inReplyTo ||
            (
              parsed.references &&
                parsed.references.length > 0
                ? parsed.references[0]
                : null
            );

          // ---------------------------------------------
          // Received date
          // ---------------------------------------------

          const receivedAt = parsed.date || new Date();

          // ---------------------------------------------
          // 1. Save email to communications
          // ---------------------------------------------

          await createCommunicationFromEmail({
            fromEmail,
            fromName,
            toEmail,
            toName,
            subject: parsed.subject,
            text: parsed.text,
            messageId,
            threadId,
            receivedAt,
          });

          // ---------------------------------------------
          // 2. Keep existing lead creation
          // ---------------------------------------------

          const result = await createLeadFromEmail({
            fromEmail,
            fromName,
            subject: parsed.subject,
            text: parsed.text,
            messageId,
            receivedAt,
          });

          if (!result.duplicate) {
            created++;
          }

          // ---------------------------------------------
          // 3. Mark email as read
          // ---------------------------------------------

          await client.messageFlagsAdd(uid, ["\\Seen"]);

        } catch (perMessageErr) {
          failedCount++;
          if (failedCount <= MAX_FAILURE_LOGS) {
            console.error(
              `Failed to process inbox message uid ${uid}:`,
              perMessageErr.message
            );
          }

          // Mark it seen anyway (best-effort). Without this, a message
          // that can never be parsed gets re-fetched and re-logged on
          // every single poll, forever — which is what flooded the
          // terminal. Marking it seen means we log it (at most) once.
          try {
            await client.messageFlagsAdd(uid, ["\\Seen"]);
          } catch (flagErr) {
            if (failedCount <= MAX_FAILURE_LOGS) {
              console.error(`Also failed to mark uid ${uid} as seen:`, flagErr.message);
            }
          }
        }
      }

      if (skippedCount > 0) {
        console.log(`Skipped ${skippedCount} inbox message(s) from ignored senders this poll.`);
      }

      if (failedCount > MAX_FAILURE_LOGS) {
        console.error(
          `... and ${failedCount - MAX_FAILURE_LOGS} more inbox message(s) failed to process this poll (marked as seen, won't retry).`
        );
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return {
    created,
    configured: true,
    enabled: true,
  };
}

// Background poller — starts automatically when the server starts.
setInterval(() => {
  checkInboxForLeads().catch((err) => {
    // ImapFlow errors often carry the real IMAP server response in
    // .responseText/.response — err.message alone is frequently just the
    // generic "Command failed", which isn't actionable on its own.
    console.error(
      "Email lead check failed:",
      err.message,
      err.responseText || err.response || "",
      err.code ? `(code: ${err.code})` : ""
    );
  });
}, EMAIL_POLL_INTERVAL_MS);

// Manual trigger — call this to check right now instead of waiting for
// the next scheduled poll (handy for testing).
app.post("/api/leads/check-email", async (req, res) => {
  try {
    const result = await checkInboxForLeads();
    if (!result.configured) {
      return res.status(400).json({
        message: "Email lead capture isn't configured. Set EMAIL, EMAIL_PASSWORD, and SMTP_SERVER in your .env.",
      });
    }
    if (!result.enabled) {
      return res.status(400).json({
        message: "Email lead capture is turned off. Turn it on in Leads & Pipeline to capture new leads.",
      });
    }
    res.json({ message: `Checked inbox — ${result.created} lead(s) created.`, created: result.created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to check inbox.", error: err.message });
  }
});

// Read/toggle the capture switch shown in Sales.tsx. Turning it off just
// stops NEW leads from being captured — existing leads/opportunities are
// left exactly as they are and stay visible either way.
// (GET /api/leads/email-capture itself is registered earlier, above
// GET /api/leads/:id — otherwise Express would match "email-capture"
// as an :id and crash trying to cast it to bigint.)
app.post("/api/leads/email-capture", async (req, res) => {
  try {
    const enabled = await setEmailCaptureEnabled(Boolean(req.body?.enabled));
    // Turning it on immediately picks up anything waiting, instead of
    // making the user wait for the next scheduled poll.
    if (enabled) {
      checkInboxForLeads().catch((err) =>
        console.error("Email lead check failed after enabling capture:", err.message)
      );
    }
    res.json({ enabled });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update email capture setting.", error: err.message });
  }
});

// One-time cleanup for spam/cron leads captured BEFORE the sender filter
// above existed. Only touches leads with source='Email' whose notes show
// they came from a known-junk sender (avanyate@..., or a "Cron <...>"
// display name) — never touches manually-created or legitimate leads.
app.post("/api/leads/purge-spam", async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const spamLeads = await client.query(`
        SELECT id FROM leads
        WHERE source = 'Email'
          AND (
            notes ILIKE '%avanyate@%'
            OR notes ILIKE '%Cron <%'
            OR notes ILIKE '%<Cron>%'
          )
      `);
      const leadIds = spamLeads.rows.map((r) => r.id);

      if (leadIds.length === 0) {
        await client.query("COMMIT");
        return res.json({ deleted_leads: 0, deleted_opportunities: 0, deleted_communications: 0 });
      }

      const commResult = await client.query(
        `DELETE FROM communications WHERE lead_id = ANY($1::bigint[]) RETURNING id`,
        [leadIds]
      );
      const oppResult = await client.query(
        `DELETE FROM opportunities WHERE lead_id = ANY($1::bigint[]) RETURNING id`,
        [leadIds]
      );
      const leadResult = await client.query(
        `DELETE FROM leads WHERE id = ANY($1::bigint[]) RETURNING id`,
        [leadIds]
      );

      await client.query("COMMIT");
      res.json({
        deleted_leads: leadResult.rowCount,
        deleted_opportunities: oppResult.rowCount,
        deleted_communications: commResult.rowCount,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to clean up spam leads.", error: err.message });
  }
});


/* ============================================================ */
/* -------------------- PostgreSQL Connected Modules -------------------- */
/* ============================================================ */

/* -------------------- Products -------------------- */

app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*,
             ROUND((p.price * (1 - p.discount / 100) * (1 + p.tax_rate / 100))::numeric, 2) AS final_price
      FROM products p
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/products:", err);
    res.status(500).json({ message: "Failed to load products.", error: err.message });
  }
});

app.get("/api/products/summary", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total_products,
        COALESCE(SUM(price * (1 - discount / 100) * (1 + tax_rate / 100)), 0)::numeric AS catalog_value,
        COALESCE(AVG(price), 0)::numeric AS avg_price,
        COUNT(*) FILTER (WHERE is_package = true)::int AS packages,
        COUNT(*) FILTER (WHERE active = false)::int AS archived,
        COALESCE(MIN(price), 0)::numeric AS min_price,
        COALESCE(MAX(price), 0)::numeric AS max_price
      FROM products
    `);
    const categories = await pool.query(`
      SELECT COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS name, COUNT(*)::int AS count
      FROM products
      GROUP BY 1
      ORDER BY count DESC, name
    `);
    res.json({ ...result.rows[0], categories: categories.rows });
  } catch (err) {
    console.error("GET /api/products/summary:", err);
    res.status(500).json({ message: "Failed to load product summary.", error: err.message });
  }
});

app.post("/api/products", async (req, res) => {
  const { name, description, sku, category, price, tax_rate, discount, is_package, owner_id } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ message: "Product name is required." });
  try {
    const result = await pool.query(`
      INSERT INTO products (name, description, sku, category, price, tax_rate, discount, is_package, active, owner_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)
      RETURNING *
    `, [
      String(name).trim(), description || null, sku || null, category || null,
      Number(price) || 0, Number(tax_rate) || 0, Number(discount) || 0,
      !!is_package, owner_id || null
    ]);
    res.json({ message: "Product added.", product: result.rows[0] });
  } catch (err) {
    console.error("POST /api/products:", err);
    res.status(500).json({ message: "Failed to add product.", error: err.message });
  }
});

app.put("/api/products/:id", async (req, res) => {
  const { id } = req.params;
  const { name, description, sku, category, price, tax_rate, discount, is_package, active } = req.body;
  try {
    const result = await pool.query(`
      UPDATE products
      SET name=$1, description=$2, sku=$3, category=$4, price=$5, tax_rate=$6,
          discount=$7, is_package=$8, active=COALESCE($9, active), updated_at=NOW()
      WHERE id=$10 RETURNING *
    `, [
      name, description || null, sku || null, category || null, Number(price) || 0,
      Number(tax_rate) || 0, Number(discount) || 0, !!is_package,
      active === undefined ? null : !!active, id
    ]);
    if (!result.rows[0]) return res.status(404).json({ message: "Product not found." });
    res.json({ message: "Product updated.", product: result.rows[0] });
  } catch (err) {
    console.error("PUT /api/products/:id:", err);
    res.status(500).json({ message: "Failed to update product.", error: err.message });
  }
});

app.delete("/api/products/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM products WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ message: "Product not found." });
    res.json({ message: "Product removed." });
  } catch (err) {
    console.error("DELETE /api/products/:id:", err);
    res.status(500).json({ message: "Failed to delete product.", error: err.message });
  }
});

app.post("/api/products/:id/duplicate", async (req, res) => {
  try {
    const result = await pool.query(`
      INSERT INTO products (name, description, sku, category, price, tax_rate, discount, is_package, active, owner_id)
      SELECT name || ' (Copy)', description, sku, category, price, tax_rate, discount, is_package, true, owner_id
      FROM products WHERE id=$1
      RETURNING *
    `, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ message: "Product not found." });
    res.json({ message: "Product duplicated.", product: result.rows[0] });
  } catch (err) {
    console.error("POST /api/products/:id/duplicate:", err);
    res.status(500).json({ message: "Failed to duplicate product.", error: err.message });
  }
});

/* -------------------- Notifications -------------------- */

app.get("/api/notifications", async (req, res) => {
  const unread = String(req.query.unread || "") === "true";
  try {
    const result = await pool.query(
      `SELECT * FROM notifications ${unread ? "WHERE \`read\` = 0" : ""}
       ORDER BY created_at DESC LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/notifications:", err);
    res.status(500).json({ message: "Failed to load notifications.", error: err.message });
  }
});

app.get("/api/notifications/summary", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN \`read\` = 0 THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN created_at >= CURRENT_DATE THEN 1 ELSE 0 END) AS today
      FROM notifications
    `);
    const byType = await pool.query(`
      SELECT type, COUNT(*)::int AS count
      FROM notifications
      GROUP BY type
      ORDER BY count DESC
    `);
    res.json({ ...result.rows[0], by_type: byType.rows });
  } catch (err) {
    console.error("GET /api/notifications/summary:", err);
    res.status(500).json({ message: "Failed to load notification summary.", error: err.message });
  }
});

app.put("/api/notifications/:id/read", async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE notifications SET `read`=1 WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ message: "Notification not found." });
    res.json({ notification: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Failed to mark notification.", error: err.message });
  }
});

app.put("/api/notifications/read-all", async (req, res) => {
  try {
    const result = await pool.query("UPDATE notifications SET `read`=1 WHERE `read`=0");
    res.json({ message: "All notifications marked as read.", count: result.rowCount });
  } catch (err) {
    res.status(500).json({ message: "Failed to mark notifications.", error: err.message });
  }
});

app.delete("/api/notifications/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM notifications WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ message: "Notification not found." });
    res.json({ message: "Notification removed." });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete notification.", error: err.message });
  }
});

app.post("/api/communications/sync-reminders", async (req, res) => {
  try {
    const due = await pool.query(`
      SELECT id, type, subject, customer_id
      FROM activities
      WHERE status='scheduled'
        AND due_at IS NOT NULL
        AND due_at <= NOW()
        AND COALESCE(notified, false)=false
      ORDER BY due_at ASC
      LIMIT 200
    `);
    let count = 0;
    for (const a of due.rows) {
      await pool.query(`
        INSERT INTO notifications (type,title,message,link,related_type,related_id)
        VALUES ('reminder',$1,$2,'/communications','activity',$3)
      `, [
        "Follow-up due",
        a.subject || `Your ${a.type || "activity"} follow-up is due.`,
        a.id
      ]);
      await pool.query("UPDATE activities SET notified=true WHERE id=$1", [a.id]);
      count++;
    }
    res.json({ count });
  } catch (err) {
    console.error("sync reminders:", err);
    res.status(500).json({ message: "Failed to sync reminders.", error: err.message });
  }
});

app.post("/api/communications/send", emailAttachmentUpload.single("attachment"), async (req, res) => {
  try {
    const {
      // Backward-compatible single-recipient fields
      recipient_email,
      recipient_name,
      customer_id,
      lead_id,
      opportunity_id,

      // New bulk/customer-send fields
      recipients,
      company_name,
      ceo_name,
      subject,
      body,
      thread_id,
      proposal_ids,
    } = req.body || {};

    // Multipart form-data sends arrays as JSON strings; regular JSON requests remain supported.
    const parsedRecipients = typeof recipients === "string"
      ? (() => { try { return JSON.parse(recipients); } catch (_) { return []; } })()
      : recipients;
    const parsedProposalIds = typeof proposal_ids === "string"
      ? (() => { try { return JSON.parse(proposal_ids); } catch (_) { return []; } })()
      : proposal_ids;

    const rawRecipients = Array.isArray(parsedRecipients) && parsedRecipients.length
      ? parsedRecipients
      : [{
          recipient_email,
          recipient_name,
          customer_id,
          company_name,
          ceo_name,
          lead_id,
          opportunity_id,
        }];

    const validRecipients = rawRecipients
      .map((recipient) => ({
        recipient_email: String(recipient?.recipient_email || recipient?.email || "").trim(),
        recipient_name: String(recipient?.recipient_name || recipient?.name || "").trim(),
        customer_id: recipient?.customer_id ?? null,
        company_name: String(recipient?.company_name || recipient?.company || company_name || "").trim(),
        ceo_name: String(recipient?.ceo_name || recipient?.ceo || ceo_name || "").trim(),
        lead_id: recipient?.lead_id ?? lead_id ?? null,
        opportunity_id: recipient?.opportunity_id ?? opportunity_id ?? null,
      }))
      .filter((recipient) => recipient.recipient_email);

    if (!validRecipients.length) {
      return res.status(400).json({ message: "At least one recipient email is required." });
    }

    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ message: "Subject is required." });
    }

    if (!body || !String(body).trim()) {
      return res.status(400).json({ message: "Message body is required." });
    }

    if (!mailTransporter) {
      return res.status(500).json({
        message:
          "Email sending is not configured. Check EMAIL, EMAIL_PASSWORD, SMTP_SERVER, and SMTP_PORT in .env.",
      });
    }

    const senderEmail = EMAIL_USER;
    const senderName = "Pradeep Sir";

    // Optional proposal attachments selected from the CRM Proposal Files module.
    let attachments = [];
    const proposalIds = Array.isArray(parsedProposalIds)
      ? parsedProposalIds.map(Number).filter(Number.isFinite)
      : [];

    if (proposalIds.length) {
      const proposalResult = await pool.query(
        `SELECT id, proposal_number, file_url
         FROM proposal_files
         WHERE id = ANY($1::int[])
         ORDER BY id`,
        [proposalIds]
      );

      attachments = proposalResult.rows
        .filter((proposal) => proposal.file_url)
        .map((proposal) => {
          const fileUrl = String(proposal.file_url);
          const fallbackName = `${proposal.proposal_number || `proposal-${proposal.id}`}${path.extname(fileUrl) || ".pdf"}`;

          if (/^https?:\/\//i.test(fileUrl)) {
            return {
              filename: fallbackName,
              href: fileUrl,
            };
          }

          // For CRM paths such as /files/proposal.pdf, look inside server/public.
          // EMAIL_ATTACHMENTS_DIR can override this when uploaded files live elsewhere.
          const attachmentsRoot =
            process.env.EMAIL_ATTACHMENTS_DIR || path.join(__dirname, "public");
          const relativeFile = fileUrl.replace(/^\/+/, "");
          return {
            filename: path.basename(fileUrl) || fallbackName,
            path: path.join(attachmentsRoot, relativeFile),
          };
        });
    }

    // Optional proposal/document selected directly from the user's computer.
    if (req.file) {
      attachments.push({
        filename: path.basename(String(req.file.originalname || "attachment")),
        content: req.file.buffer,
        contentType: req.file.mimetype || undefined,
      });
    }

    const replaceTemplateVariables = (value, recipient) => {
      const displayName = recipient.recipient_name || recipient.ceo_name || "Sir/Madam";
      const replacements = {
        "{{CEO_Name}}": recipient.ceo_name || displayName,
        "{{Recipient_Name}}": displayName,
        "{{Contact_Name}}": recipient.recipient_name || displayName,
        "{{Company_Name}}": recipient.company_name || "",
        "{{Recipient_Email}}": recipient.recipient_email || "",
      };

      return String(value || "").replace(
        /\{\{CEO_Name\}\}|\{\{Recipient_Name\}\}|\{\{Contact_Name\}\}|\{\{Company_Name\}\}|\{\{Recipient_Email\}\}/g,
        (token) => replacements[token] ?? token
      );
    };

    const stripHtml = (html) =>
      String(html || "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .trim();

    const sent = [];
    const failures = [];

    for (const recipient of validRecipients) {
      const personalizedSubject = replaceTemplateVariables(subject, recipient).trim();
      const personalizedBody = replaceTemplateVariables(body, recipient);

      try {
        // Embed any local /image/... references in the template as inline
        // cid: attachments (no public URL needed — see
        // novaCrmInlineLocalEmailImages above), merged with whatever
        // proposal/file attachments were already selected for this send.
        const { html: inlinedBody, attachments: mailAttachments } =
          novaCrmInlineLocalEmailImages(personalizedBody, attachments);

        // Same tracking pixel + own-domain click wrapping as RUN_CAMPAIGN.py
        // uses, via the same track.php on your domain -- gives this send
        // path the same open/click tracking the Python campaign already
        // has. The DB `body` column below still stores the ORIGINAL,
        // untracked HTML, so the Communications timeline displays the
        // clean email rather than tracking-wrapped links.
        const trackedHtml = injectEmailTracking(
          inlinedBody,
          recipient.recipient_email,
          recipient.company_name
        );

        const mailInfo = await mailTransporter.sendMail({
          from: `"${senderName}" <${senderEmail}>`,
          to: recipient.recipient_email,
          subject: personalizedSubject,
          text: stripHtml(personalizedBody),
          html: trackedHtml,
          attachments: mailAttachments,
          ...(thread_id
            ? {
                inReplyTo: thread_id,
                references: thread_id,
              }
            : {}),
        });

        let resolvedLeadId = recipient.lead_id ? Number(recipient.lead_id) : null;
        let resolvedOpportunityId = recipient.opportunity_id
          ? Number(recipient.opportunity_id)
          : null;
        const resolvedCustomerId = recipient.customer_id
          ? Number(recipient.customer_id)
          : null;

        if (resolvedLeadId && !resolvedOpportunityId) {
          const existingOpp = await pool.query(
            `SELECT id FROM opportunities WHERE lead_id = $1 ORDER BY id DESC LIMIT 1`,
            [resolvedLeadId]
          );
          resolvedOpportunityId = existingOpp.rows[0]?.id || null;
        }

        // Preserve the CRM's existing behavior for outbound emails:
        // create a sales lead/opportunity only when one was not supplied.
        if (!resolvedLeadId) {
          const estimate = await estimateLeadValueFromEmail(
            personalizedSubject,
            stripHtml(personalizedBody)
          );

          const leadInsert = await pool.query(
            `INSERT INTO leads
               (title, source, status, estimated_value, customer_id, notes, value_source)
             VALUES ($1, 'Outbound Email', 'new', $2, $3, $4, $5)
             RETURNING id`,
            [
              personalizedSubject,
              estimate.value || 0,
              resolvedCustomerId,
              `Created from outbound sales email to ${recipient.recipient_email}.`,
              estimate.source,
            ]
          );
          resolvedLeadId = leadInsert.rows[0].id;

          const oppInsert = await pool.query(
            `INSERT INTO opportunities
               (title, customer_id, lead_id, stage, value, probability, owner, notes, value_source)
             VALUES ($1, $2, $3, 'Prospecting', $4, 25, NULL, $5, $6)
             RETURNING id`,
            [
              personalizedSubject,
              resolvedCustomerId,
              resolvedLeadId,
              estimate.value || 0,
              `Created from outbound sales email to ${recipient.recipient_email}.`,
              estimate.source,
            ]
          );
          resolvedOpportunityId = oppInsert.rows[0].id;
        }

        const result = await pool.query(
          `
          INSERT INTO communications (
            customer_id,
            lead_id,
            opportunity_id,
            type,
            direction,
            subject,
            body,
            sender_email,
            sender_name,
            recipient_email,
            recipient_name,
            status,
            message_id,
            thread_id,
            is_read,
            sent_at,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            'email',
            'outbound',
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            'sent',
            $10,
            $11,
            true,
            NOW(),
            NOW(),
            NOW()
          )
          RETURNING *
          `,
          [
            resolvedCustomerId,
            resolvedLeadId,
            resolvedOpportunityId,
            personalizedSubject,
            personalizedBody,
            senderEmail,
            senderName,
            recipient.recipient_email,
            recipient.recipient_name || recipient.ceo_name || null,
            mailInfo.messageId || null,
            thread_id || mailInfo.messageId || null,
          ]
        );

        sent.push(result.rows[0]);
      } catch (recipientErr) {
        console.error(
          `Failed to send email to ${recipient.recipient_email}:`,
          recipientErr
        );
        failures.push({
          email: recipient.recipient_email,
          message: recipientErr.message || "Failed to send.",
        });
      }
    }

    if (!sent.length) {
      return res.status(500).json({
        message: "No emails were sent.",
        failures,
      });
    }

    res.status(failures.length ? 207 : 201).json({
      success: true,
      message: failures.length
        ? `${sent.length} email(s) sent. ${failures.length} failed.`
        : `${sent.length} email(s) sent successfully.`,
      sent_count: sent.length,
      failed_count: failures.length,
      communications: sent,
      failures,
    });
  } catch (err) {
    console.error("POST /api/communications/send:", err);
    res.status(500).json({
      message: "Failed to send email.",
      error: err.message,
    });
  }
});

/* -------------------- Communications / Activities -------------------- */

app.get("/api/communications", async (req, res) => {
  const { type, customer_id } = req.query;
  try {
    const params = [];
    const conditions = [];
    if (type && type !== "all") {
      params.push(type);
      conditions.push(`x.type = $${params.length}`);
    }
    if (customer_id) {
      params.push(customer_id);
      conditions.push(`x.customer_id = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(`
      SELECT * FROM (
        SELECT
          'activity'::text AS source,
          a.id::text AS id,
          a.customer_id,
          NULL::bigint AS lead_id,
          NULL::bigint AS opportunity_id,
          a.type,
          a.direction,
          a.subject,
          a.body,
          NULL::text AS sender_email,
          NULL::text AS sender_name,
          NULL::text AS recipient_email,
          NULL::text AS recipient_name,
          a.status,
          NULL::text AS message_id,
          NULL::text AS thread_id,
          false AS is_read,
          CASE WHEN a.direction='outbound' THEN a.occurred_at ELSE NULL END AS sent_at,
          CASE WHEN a.direction='inbound' THEN a.occurred_at ELSE NULL END AS received_at,
          a.occurred_at AS created_at,
          a.occurred_at AS updated_at,
          a.due_at,
          a.duration_minutes,
          c.company_name AS customer_name
        FROM activities a
        LEFT JOIN customers c ON c.id=a.customer_id

        UNION ALL

        SELECT
          'communication'::text AS source,
          c.id::text AS id,
          c.customer_id,
          c.lead_id,
          c.opportunity_id,
          c.type,
          c.direction,
          c.subject,
          c.body,
          c.sender_email,
          c.sender_name,
          c.recipient_email,
          c.recipient_name,
          c.status,
          c.message_id,
          c.thread_id,
          c.is_read,
          c.sent_at,
          c.received_at,
          c.created_at,
          c.updated_at,
          NULL::timestamptz AS due_at,
          NULL::integer AS duration_minutes,
          cu.company_name AS customer_name
        FROM communications c
        LEFT JOIN customers cu ON cu.id=c.customer_id
      ) x
      ${where}
      ORDER BY COALESCE(x.received_at, x.sent_at, x.created_at) IS NULL, COALESCE(x.received_at, x.sent_at, x.created_at) DESC
      LIMIT 500
    `, params);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/communications:", err);
    res.status(500).json({ message: "Failed to load communications.", error: err.message });
  }
});

app.get("/api/communications/summary", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ((SELECT COUNT(*) FROM activities) + (SELECT COUNT(*) FROM communications))::int AS total,
        ((SELECT COUNT(*) FROM activities WHERE occurred_at >= NOW()-INTERVAL '7 days') +
         (SELECT COUNT(*) FROM communications WHERE created_at >= NOW()-INTERVAL '7 days'))::int AS this_week,
        (SELECT COUNT(*) FROM activities WHERE status='scheduled' AND due_at > NOW())::int AS upcoming_followups,
        (SELECT COUNT(*) FROM activities WHERE status='scheduled' AND due_at <= NOW())::int AS overdue_followups
    `);
    const byType = await pool.query(`
      SELECT type, COUNT(*)::int AS count FROM (
        SELECT type FROM activities
        UNION ALL
        SELECT type FROM communications
      ) z GROUP BY type ORDER BY count DESC
    `);
    res.json({ ...result.rows[0], by_type: byType.rows });
  } catch (err) {
    console.error("GET /api/communications/summary:", err);
    res.status(500).json({ message: "Failed to load communications summary.", error: err.message });
  }
});

app.delete("/api/communications/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ message: "Invalid communication id." });
    }

    const result = await pool.query(
      "DELETE FROM communications WHERE id=$1 RETURNING id",
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: "Communication not found." });
    }

    res.json({ message: "Communication deleted." });
  } catch (err) {
    console.error("DELETE /api/communications/:id:", err);
    res.status(500).json({
      message: "Failed to delete communication.",
      error: err.message,
    });
  }
});

app.post("/api/activities", async (req, res) => {
  const { type, subject, body, customer_id, direction, status, due_at, duration_minutes, owner_id } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO activities
        (type, subject, body, customer_id, direction, status, due_at, duration_minutes, owner_id, occurred_at, notified)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),false)
      RETURNING *
    `, [
      type || "note", subject || null, body || null, customer_id || null,
      direction || "outbound", status || "completed", due_at || null,
      duration_minutes || null, owner_id || null
    ]);
    res.json({ message: "Activity logged.", activity: result.rows[0] });
  } catch (err) {
    console.error("POST /api/activities:", err);
    res.status(500).json({ message: "Failed to log activity.", error: err.message });
  }
});

app.put("/api/activities/:id", async (req, res) => {
  const { type, subject, body, customer_id, direction, status, due_at, duration_minutes } = req.body;
  try {
    const result = await pool.query(`
      UPDATE activities
      SET type=$1, subject=$2, body=$3, customer_id=$4, direction=$5, status=$6,
          due_at=$7, duration_minutes=$8, notified=CASE WHEN $6='scheduled' THEN false ELSE notified END
      WHERE id=$9 RETURNING *
    `, [
      type || "note", subject || null, body || null, customer_id || null,
      direction || "outbound", status || "completed", due_at || null,
      duration_minutes || null, req.params.id
    ]);
    if (!result.rows[0]) return res.status(404).json({ message: "Activity not found." });
    res.json({ message: "Activity updated.", activity: result.rows[0] });
  } catch (err) {
    console.error("PUT /api/activities/:id:", err);
    res.status(500).json({ message: "Failed to update activity.", error: err.message });
  }
});

app.put("/api/activities/:id/complete", async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE activities SET status='completed', due_at=NULL, notified=true WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ message: "Activity not found." });
    res.json({ activity: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: "Failed to complete activity.", error: err.message });
  }
});

app.delete("/api/activities/:id", async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM activities WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ message: "Activity not found." });
    res.json({ message: "Activity removed." });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete activity.", error: err.message });
  }
});

/* Send a normal email from the CRM and record it in communications. */
app.post("/api/communications/send-email", async (req, res) => {
  const { recipient_email, recipient_name, subject, body, customer_id, lead_id, opportunity_id } = req.body;
  if (!recipient_email || !subject || !body) {
    return res.status(400).json({ message: "Recipient email, subject and body are required." });
  }
  if (!mailTransporter) {
    return res.status(400).json({
      message: "Email sending isn't configured. Set EMAIL, EMAIL_PASSWORD, SMTP_SERVER and SMTP_PORT in .env."
    });
  }
  try {
    // Same tracking pixel + own-domain click wrapping as
    // /api/communications/send -- see emailTracking.js. The stored
    // `body` column below stays the original, untracked text.
    const plainHtml = `<div style="white-space:pre-wrap">${String(body).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</div>`;
    const trackedHtml = injectEmailTracking(plainHtml, recipient_email, recipient_name);

    const info = await mailTransporter.sendMail({
      from: EMAIL_USER,
      to: recipient_email,
      subject,
      text: body,
      html: trackedHtml,
    });

    let resolvedLeadId = lead_id ? Number(lead_id) : null;
    let resolvedOpportunityId = opportunity_id ? Number(opportunity_id) : null;
    const resolvedCustomerId = customer_id ? Number(customer_id) : null;

    if (resolvedLeadId && !resolvedOpportunityId) {
      const existingOpp = await pool.query(
        `SELECT id FROM opportunities WHERE lead_id = $1 ORDER BY id DESC LIMIT 1`,
        [resolvedLeadId]
      );
      resolvedOpportunityId = existingOpp.rows[0]?.id || null;
    }

    if (!resolvedLeadId) {
      const estimate = await estimateLeadValueFromEmail(subject, body);
      const leadInsert = await pool.query(
        `INSERT INTO leads
          (title, source, status, estimated_value, customer_id, notes, value_source)
         VALUES ($1, 'Outbound Email', 'new', $2, $3, $4, $5)
         RETURNING id`,
        [
          String(subject).trim(),
          estimate.value || 0,
          resolvedCustomerId,
          `Created from outbound sales email to ${String(recipient_email).trim()}.`,
          estimate.source,
        ]
      );
      resolvedLeadId = leadInsert.rows[0].id;

      const oppInsert = await pool.query(
        `INSERT INTO opportunities
          (title, customer_id, lead_id, stage, value, probability, owner, notes, value_source)
         VALUES ($1, $2, $3, 'Prospecting', $4, 25, NULL, $5, $6)
         RETURNING id`,
        [
          String(subject).trim(),
          resolvedCustomerId,
          resolvedLeadId,
          estimate.value || 0,
          `Created from outbound sales email to ${String(recipient_email).trim()}.`,
          estimate.source,
        ]
      );
      resolvedOpportunityId = oppInsert.rows[0].id;
    }

    const result = await pool.query(`
      INSERT INTO communications
        (customer_id,lead_id,opportunity_id,type,direction,subject,body,
         sender_email,sender_name,recipient_email,recipient_name,status,
         message_id,is_read,sent_at)
      VALUES ($1,$2,$3,'email','outbound',$4,$5,$6,$7,$8,$9,'sent',$10,true,NOW())
      RETURNING *
    `, [
      resolvedCustomerId, resolvedLeadId, resolvedOpportunityId,
      subject, body, EMAIL_USER, null, recipient_email, recipient_name || null,
      info.messageId || null
    ]);
    res.json({ message: "Email sent.", communication: result.rows[0] });
  } catch (err) {
    console.error("POST /api/communications/send-email:", err);
    res.status(500).json({ message: "Failed to send email.", error: err.message });
  }
});


/* -------------------- Admin diagnostics -------------------- */

app.post("/api/admin/client-error", async (req, res) => {
  try {
    const body = req.body || {};
    appendRuntimeLog("ERROR", "Frontend client error", {
      requestId: req.novaRequestId,
      message: body.message || "Unknown frontend error",
      stack: body.stack || null,
      source: body.source || null,
      url: body.url || null,
      line: body.line || null,
      column: body.column || null,
      userAgent: req.get("user-agent") || null,
    });
    res.json({ ok: true, requestId: req.novaRequestId });
  } catch (err) {
    appendRuntimeLog("ERROR", "Failed to record frontend client error", {
      message: err.message,
      stack: err.stack,
    });
    res.status(500).json({ message: "Failed to record frontend error." });
  }
});

app.get("/api/admin/build-errors", async (req, res) => {
  try {
    if (!fs.existsSync(FRONTEND_BUILD_LOG_FILE)) return res.json([]);
    const lines = fs.readFileSync(FRONTEND_BUILD_LOG_FILE, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-200)
      .reverse()
      .map((line) => {
        try { return JSON.parse(line); }
        catch (_) { return { time: null, message: line }; }
      });
    res.json(lines);
  } catch (err) {
    res.status(500).json({ message: "Failed to read frontend build errors.", error: err.message });
  }
});

app.post("/api/admin/build-error", async (req, res) => {
  try {
    appendFrontendBuildLog(req.body?.message || "Frontend build/typecheck error");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to record build error.", error: err.message });
  }
});


app.get("/api/admin/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM customers)::int AS customers,
        (SELECT COUNT(*) FROM leads)::int AS leads,
        (SELECT COUNT(*) FROM opportunities)::int AS opportunities,
        (SELECT COUNT(*) FROM communications)::int AS communications,
        (SELECT COUNT(*) FROM notifications WHERE \`read\`=0)::int AS unread_notifications
    `);
    res.json({
      ok: true,
      database: "connected",
      email_receive: Boolean(EMAIL_USER && EMAIL_PASSWORD && IMAP_SERVER),
      email_send: Boolean(mailTransporter),
      uptime_seconds: Math.round(process.uptime()),
      ...result.rows[0],
    });
  } catch (err) {
    appendRuntimeLog("ERROR", "Admin health check failed", { message: err.message, stack: err.stack });
    res.status(500).json({ ok: false, database: "error", error: err.message });
  }
});

app.get("/api/admin/logs", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 150, 1), 500);
    if (!fs.existsSync(RUNTIME_LOG_FILE)) return res.json([]);
    const lines = fs.readFileSync(RUNTIME_LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    const parsed = lines.slice(-limit).reverse().map((line) => {
      try { return JSON.parse(line); }
      catch (_) { return { time: null, level: "INFO", message: line }; }
    });
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ message: "Failed to read runtime logs.", error: err.message });
  }
});


/* ============================================================
   Authentication API
   ============================================================ */
const AUTH_API_BASE_URL = String(
  process.env.AUTH_API_URL ||
  process.env.PUBLIC_BASE_URL ||
  `http://localhost:${process.env.PORT || 5000}`
).replace(/\/+$/, "");

const AUTH_APP_BASE_URL = String(
  process.env.FRONTEND_URL ||
  process.env.APP_BASE_URL ||
  `http://localhost:${process.env.FRONTEND_PORT || 8080}`
).replace(/\/+$/, "");

function buildVerificationUrl(token) {
  return `${AUTH_API_BASE_URL}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
}

function authHtmlPage(title, message, tone = "success", actionUrl = null, actionLabel = "Open OrbitAvanya CRM") {
  const success = tone === "success";
  const accent = success ? "#2563eb" : "#dc2626";
  const soft = success ? "#eff6ff" : "#fef2f2";
  const icon = success ? "✓" : "!";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
</head>
<body style="margin:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;">
    <div style="width:100%;max-width:520px;background:#fff;border:1px solid #e5e7eb;border-radius:18px;box-shadow:0 18px 50px rgba(15,23,42,.12);overflow:hidden;">
      <div style="padding:28px 30px;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;text-align:center;">
        <div style="font-size:26px;font-weight:700;">OrbitAvanya CRM</div>
        <div style="margin-top:7px;font-size:13px;opacity:.9;">Secure account verification</div>
      </div>
      <div style="padding:34px 30px;text-align:center;">
        <div style="width:52px;height:52px;line-height:52px;border-radius:50%;margin:0 auto 16px;background:${soft};color:${accent};font-size:28px;font-weight:700;">${icon}</div>
        <h1 style="margin:0 0 12px;font-size:24px;color:#111827;">${title}</h1>
        <p style="margin:0;color:#4b5563;line-height:1.7;font-size:15px;">${message}</p>
        ${actionUrl ? `<a href="${actionUrl}" style="display:inline-block;margin-top:24px;padding:12px 22px;border-radius:10px;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;font-size:14px;">${actionLabel}</a>` : ""}
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function sendVerificationEmail({ email, fullName, token }) {
  if (!mailTransporter) {
    const error = new Error("Email verification is not configured. Set EMAIL, EMAIL_PASSWORD and SMTP_SERVER in .env.");
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }

  const verifyUrl = buildVerificationUrl(token);

  await mailTransporter.sendMail({
    from: EMAIL_USER,
    to: email,
    subject: "Verify your OrbitAvanya CRM account",
    text:
      `Hi ${fullName || "there"},\n\n` +
      `Verify your OrbitAvanya CRM account by opening this link:\n${verifyUrl}\n\n` +
      `This link expires in 30 minutes.`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verify your OrbitAvanya CRM account</title>
</head>
<body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f7fb;padding:32px 12px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.08);">
        <tr><td align="center" style="padding:32px 28px;background:#2563eb;background:linear-gradient(135deg,#2563eb,#4f46e5);">
          <h1 style="margin:0;color:#ffffff;font-size:28px;">OrbitAvanya CRM</h1>
          <p style="margin:8px 0 0;color:#e0e7ff;font-size:14px;">Secure account verification</p>
        </td></tr>
        <tr><td style="padding:38px 34px 28px;">
          <h2 style="margin:0 0 14px;font-size:24px;color:#111827;">Verify your email address</h2>
          <p style="margin:0 0 15px;font-size:16px;line-height:1.7;color:#4b5563;">Hi ${fullName || "there"},</p>
          <p style="margin:0 0 20px;font-size:16px;line-height:1.7;color:#4b5563;">Thanks for creating your <strong>OrbitAvanya CRM</strong> account. Please verify your email address to activate your account.</p>
          <table cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;"><tr><td align="center" style="border-radius:10px;background:#2563eb;">
            <a href="${verifyUrl}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">Verify My Email</a>
          </td></tr></table>
          <p style="margin:18px 0 8px;font-size:14px;line-height:1.6;color:#6b7280;">This verification link expires in <strong>30 minutes</strong>.</p>
          <p style="margin:0;font-size:13px;line-height:1.6;color:#9ca3af;word-break:break-all;">If the button does not open, copy this link into your browser:<br>${verifyUrl}</p>
        </td></tr>
        <tr><td align="center" style="padding:22px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">This is an automated security email. Please do not reply.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

app.post("/api/auth/register", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const fullName = String(req.body?.full_name || "").trim().slice(0, 100);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: "Please enter a valid email address." });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters." });
  }

  try {
    const existingResult = await pool.query(
      "SELECT id, email, full_name, email_verified FROM crm_users WHERE LOWER(email) = LOWER($1) LIMIT 1",
      [email]
    );
    const existing = existingResult.rows[0];

    if (existing?.email_verified) {
      return res.status(409).json({ message: "An account with this email already exists. Please sign in." });
    }

    if (existing && !mailTransporter) {
      return res.status(503).json({
        message: "This account already exists but email sending is not configured. Set EMAIL, EMAIL_PASSWORD and SMTP_SERVER in .env.",
      });
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationHash = hashAuthToken(verificationToken);

    if (existing) {
      await pool.query(
        `UPDATE crm_users
         SET verification_token_hash = $1,
             verification_expires_at = DATE_ADD(NOW(), INTERVAL 30 MINUTE),
             updated_at = NOW()
         WHERE id = $2`,
        [verificationHash, existing.id]
      );
      await sendVerificationEmail({
        email: existing.email,
        fullName: existing.full_name || fullName,
        token: verificationToken,
      });
      return res.status(200).json({
        message: "This account already exists and is awaiting verification. A new verification email has been sent.",
      });
    }

    const { hash, salt } = hashPassword(password);
    await pool.query(
      `INSERT INTO crm_users
        (email, password_hash, password_salt, full_name, role, email_verified,
         verification_token_hash, verification_expires_at)
       VALUES ($1,$2,$3,$4, 'user',0,$5,DATE_ADD(NOW(), INTERVAL 30 MINUTE))`,
      [email, hash, salt, fullName || null, verificationHash]
    );

    const userResult = await pool.query(
      `SELECT id, email, full_name, role, email_verified
       FROM crm_users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [email]
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new Error("Registration insert completed but the new crm_users row could not be read back.");
    }

    try {
      await sendVerificationEmail({ email: user.email, fullName: user.full_name, token: verificationToken });
    } catch (mailErr) {
      await pool.query("DELETE FROM crm_users WHERE id = $1", [user.id]);
      throw mailErr;
    }

    return res.status(201).json({
      message: "Account created. Check your email and verify your account before signing in.",
    });
  } catch (err) {
    appendRuntimeLog("ERROR", "Registration failed", { message: err.message, stack: err.stack, requestId: req.novaRequestId });
    console.error(`[AUTH REGISTER] request=${req.novaRequestId || "unknown"} ${err.stack || err.message}`);
    return res.status(err.code === "EMAIL_NOT_CONFIGURED" ? 503 : 500).json({
      message: err.code === "EMAIL_NOT_CONFIGURED"
        ? err.message
        : "Could not create the account. Please check the server email configuration.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

app.get("/api/auth/verify-email", async (req, res) => {
  const token = String(req.query?.token || "");
  const wantsJson = String(req.headers.accept || "").includes("application/json");

  if (!token) {
    if (wantsJson) return res.status(400).json({ message: "Verification token is missing." });
    return res.status(400).send(authHtmlPage(
      "Verification link missing",
      "This verification link is incomplete. Please request a new verification email from the sign-in page.",
      "error",
      `${AUTH_APP_BASE_URL}/auth`,
      "Go to Sign In"
    ));
  }

  try {
    const result = await pool.query(
      `SELECT id FROM crm_users
       WHERE verification_token_hash = $1
         AND verification_expires_at > NOW()
       LIMIT 1`,
      [hashAuthToken(token)]
    );
    const user = result.rows[0];

    if (!user) {
      if (wantsJson) return res.status(400).json({ message: "This verification link is invalid or expired." });
      return res.status(400).send(authHtmlPage(
        "Verification link expired",
        "This verification link is invalid or has expired. Request a new verification email and try again.",
        "error",
        `${AUTH_APP_BASE_URL}/auth`,
        "Go to Sign In"
      ));
    }

    await pool.query(
      `UPDATE crm_users
       SET email_verified = 1,
           verification_token_hash = NULL,
           verification_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    if (wantsJson) return res.json({ message: "Email verified successfully." });

    return res.status(200).send(authHtmlPage(
      "Email verified successfully",
      "Your OrbitAvanya CRM account is now active. You can sign in using your email and password.",
      "success",
      `${AUTH_APP_BASE_URL}/auth?verified=1`,
      "Continue to Sign In"
    ));
  } catch (err) {
    appendRuntimeLog("ERROR", "Email verification failed", { message: err.message });
    if (wantsJson) return res.status(500).json({ message: "Could not verify the email address." });
    return res.status(500).send(authHtmlPage(
      "Verification failed",
      "We could not verify your email right now. Please request a new verification email and try again.",
      "error",
      `${AUTH_APP_BASE_URL}/auth`,
      "Go to Sign In"
    ));
  }
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  try {
    const result = await pool.query(
      `SELECT id, email, password_hash, password_salt, full_name, role, email_verified
       FROM crm_users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [email]
    );
    const user = result.rows[0];

    if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    if (!user.email_verified) {
      return res.status(403).json({
        message: "Please verify your email before signing in.",
        code: "EMAIL_NOT_VERIFIED",
        email: user.email,
      });
    }

    const token = createAuthToken(user);
    await pool.query(
      `INSERT INTO admin_login_activity (email, name, role, event_type, ip_address, user_agent)
       VALUES ($1,$2,$3,'login',$4,$5)`,
      [
        user.email,
        user.full_name || null,
        user.role || "user",
        req.headers["x-forwarded-for"] || req.socket.remoteAddress || null,
        req.get("user-agent") || null,
      ]
    );

    return res.json({ token, user: authUserResponse(user) });
  } catch (err) {
    appendRuntimeLog("ERROR", "Login failed", { message: err.message });
    return res.status(500).json({ message: "Could not sign in.", error: err.message });
  }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    const user = await getCurrentAuthUser(req);
    if (!user) return res.status(401).json({ message: "Not authenticated." });
    return res.json({ user: authUserResponse(user) });
  } catch (err) {
    return res.status(401).json({ message: "Not authenticated." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/resend-verification", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ message: "Email is required." });

  try {
    const result = await pool.query(
      "SELECT id, email, full_name, email_verified FROM crm_users WHERE LOWER(email)=LOWER($1) LIMIT 1",
      [email]
    );
    const user = result.rows[0];

    if (!user) {
      return res.json({ message: "If the account exists, a verification email will be sent." });
    }
    if (user.email_verified) {
      return res.json({ message: "This account is already verified. You can sign in." });
    }

    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `UPDATE crm_users
       SET verification_token_hash=$1, verification_expires_at=DATE_ADD(NOW(), INTERVAL 30 MINUTE), updated_at=NOW()
       WHERE id=$2`,
      [hashAuthToken(token), user.id]
    );

    await sendVerificationEmail({
      email: user.email,
      fullName: user.full_name,
      token,
    });

    return res.json({ message: "Verification email sent. Please check your inbox and spam folder." });
  } catch (err) {
    appendRuntimeLog("ERROR", "Resend verification failed", { message: err.message });
    return res.status(err.code === "EMAIL_NOT_CONFIGURED" ? 503 : 500).json({
      message: err.code === "EMAIL_NOT_CONFIGURED"
        ? err.message
        : "Could not send verification email.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ message: "Email is required." });

  try {
    const result = await pool.query(
      "SELECT id, email, full_name FROM crm_users WHERE LOWER(email)=LOWER($1) LIMIT 1",
      [email]
    );
    const user = result.rows[0];
    if (!user || !mailTransporter) {
      return res.json({ message: "If that email is registered, a password reset link will be sent." });
    }

    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `UPDATE crm_users
       SET reset_token_hash=$1, reset_expires_at=DATE_ADD(NOW(), INTERVAL 30 MINUTE), updated_at=NOW()
       WHERE id=$2`,
      [hashAuthToken(token), user.id]
    );

    const resetUrl = `${PUBLIC_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await mailTransporter.sendMail({
      from: EMAIL_USER,
      to: user.email,
      subject: "Reset your OrbitAvanya CRM password",
      html:
        `<p>Hi ${user.full_name || "there"},</p>` +
        `<p><a href="${resetUrl}">Reset your password</a></p>` +
        `<p>This link expires in 30 minutes.</p>`,
    });
    res.json({ message: "If that email is registered, a password reset link will be sent." });
  } catch (err) {
    res.status(500).json({ message: "Could not process the password reset request." });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  const token = String(req.body?.token || "");
  const password = String(req.body?.password || "");
  if (!token || password.length < 6) {
    return res.status(400).json({ message: "A valid reset token and password of at least 6 characters are required." });
  }

  try {
    const result = await pool.query(
      `SELECT id FROM crm_users
       WHERE reset_token_hash=$1 AND reset_expires_at > NOW()
       LIMIT 1`,
      [hashAuthToken(token)]
    );
    const user = result.rows[0];
    if (!user) return res.status(400).json({ message: "This reset link is invalid or expired." });

    const { hash, salt } = hashPassword(password);
    await pool.query(
      `UPDATE crm_users
       SET password_hash=$1, password_salt=$2,
           reset_token_hash=NULL, reset_expires_at=NULL, updated_at=NOW()
       WHERE id=$3`,
      [hash, salt, user.id]
    );
    res.json({ message: "Password updated. You can now sign in." });
  } catch (err) {
    res.status(500).json({ message: "Could not reset the password." });
  }
});

app.post("/api/admin/session", async (req, res) => {
  const { email, name, role } = req.body || {};
  if (!email) return res.status(400).json({ message: "Email is required." });
  try {
    await pool.query(
      `INSERT INTO admin_login_activity (email, name, role, event_type, ip_address, user_agent)
       VALUES ($1,$2,$3,'session_seen',$4,$5)`,
      [
        String(email).trim().toLowerCase(),
        name || null,
        role || null,
        req.headers["x-forwarded-for"] || req.socket.remoteAddress || null,
        req.get("user-agent") || null,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    appendRuntimeLog("ERROR", "Could not record admin session", { message: err.message });
    res.status(500).json({ message: "Failed to record session.", error: err.message });
  }
});

app.get("/api/admin/login-activity", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, email, name, role, event_type, ip_address, user_agent, created_at
      FROM admin_login_activity
      ORDER BY created_at DESC
      LIMIT 200
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: "Failed to load login activity.", error: err.message });
  }
});

/* -------------------- Analytics -------------------- */

app.get("/api/analytics/summary", async (req, res) => {
  const rawDays = req.query.days;
  const days = rawDays === undefined || rawDays === "" || rawDays === "null" ? null : Number(rawDays);
  try {
    const dateCondition = days && Number.isFinite(days)
      ? `created_at >= NOW() - INTERVAL '${Math.max(1, Math.round(days))} days'`
      : "TRUE";

    const totals = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN COALESCE(ps.is_won, lower(o.stage) IN ('won','closed won'), false) THEN o.value ELSE 0 END),0)::numeric AS won_revenue,
        COALESCE(SUM(CASE WHEN NOT COALESCE(ps.is_won, lower(o.stage) IN ('won','closed won'), false) AND NOT COALESCE(ps.is_lost, lower(o.stage) IN ('lost','closed lost'), false) THEN o.value ELSE 0 END),0)::numeric AS pipeline_value,
        COUNT(*) FILTER (WHERE NOT COALESCE(ps.is_won, lower(o.stage) IN ('won','closed won'), false) AND NOT COALESCE(ps.is_lost, lower(o.stage) IN ('lost','closed lost'), false))::int AS open_deals,
        COUNT(*) FILTER (WHERE COALESCE(ps.is_won, lower(o.stage) IN ('won','closed won'), false))::int AS won_count,
        COUNT(*) FILTER (WHERE COALESCE(ps.is_lost, lower(o.stage) IN ('lost','closed lost'), false))::int AS lost_count,
        COALESCE(AVG(o.value) FILTER (WHERE COALESCE(ps.is_won, lower(o.stage) IN ('won','closed won'), false)),0)::numeric AS avg_deal_size
      FROM opportunities o
      LEFT JOIN pipeline_stages ps ON ps.name=o.stage
      WHERE ${dateCondition.replace("created_at", "o.created_at")}
    `);
    const t = totals.rows[0];
    const winDenom = Number(t.won_count || 0) + Number(t.lost_count || 0);
    const wonRevenue = Number(t.won_revenue || 0);

    const stage = await pool.query(`
      SELECT o.stage AS name,
             COUNT(*)::int AS value,
             COALESCE(SUM(o.value),0)::numeric AS amount
      FROM opportunities o
      WHERE ${dateCondition.replace("created_at", "o.created_at")}
      GROUP BY o.stage ORDER BY value DESC
    `);

    const funnel = await pool.query(`
      SELECT l.status AS stage, CONCAT(UPPER(LEFT(REPLACE(l.status,'_',' '),1)), LOWER(SUBSTRING(REPLACE(l.status,'_',' '),2))) AS label, COUNT(*)::int AS count
      FROM leads l
      WHERE ${dateCondition.replace("created_at", "l.created_at")}
      GROUP BY l.status ORDER BY count DESC
    `);

    const monthly = await pool.query(`
      SELECT TO_CHAR(date_trunc('month', o.created_at), 'Mon YYYY') AS month,
             COALESCE(SUM(o.value) FILTER (WHERE COALESCE(ps.is_won, lower(o.stage) IN ('won','closed won'), false)),0)::numeric AS revenue,
             date_trunc('month', o.created_at) AS sort_month
      FROM opportunities o
      LEFT JOIN pipeline_stages ps ON ps.name=o.stage
      WHERE ${dateCondition.replace("created_at", "o.created_at")}
      GROUP BY 1,3 ORDER BY sort_month DESC LIMIT 6
    `);

    const customers = await pool.query(`
      SELECT c.company_name AS name,
             COALESCE(SUM(o.value) FILTER (WHERE COALESCE(ps.is_won, lower(o.stage) IN ('won','closed won'), false)),0)::numeric AS revenue
      FROM opportunities o
      JOIN customers c ON c.id=o.customer_id
      LEFT JOIN pipeline_stages ps ON ps.name=o.stage
      WHERE ${dateCondition.replace("created_at", "o.created_at")}
      GROUP BY c.id,c.company_name
      HAVING COALESCE(SUM(o.value) FILTER (WHERE COALESCE(ps.is_won, lower(o.stage) IN ('won','closed won'), false)),0) > 0
      ORDER BY revenue DESC LIMIT 10
    `);

    const sources = await pool.query(`
      SELECT COALESCE(NULLIF(source,''),'Unknown') AS source, COUNT(*)::int AS count
      FROM leads
      WHERE ${dateCondition.replace("created_at", "created_at")}
      GROUP BY 1 ORDER BY count DESC
    `);

    const lastMonths = monthly.rows.reverse().map(r => ({ month: r.month, revenue: Number(r.revenue) }));
    const last = lastMonths.length ? lastMonths[lastMonths.length - 1].revenue : 0;
    const forecast = lastMonths.length
      ? lastMonths.reduce((sum, r) => sum + r.revenue, 0) / lastMonths.length
      : 0;

    const proposalSent = await pool.query(`
      SELECT COUNT(*)::int AS sent,
             COUNT(*) FILTER (WHERE status IN ('Approved','approved'))::int AS approved
      FROM ai_proposals
      WHERE ${dateCondition.replace("created_at", "ai_proposals.created_at")}
    `);

    const psent = proposalSent.rows[0];
    const proposalConversion = Number(psent.sent) ? Math.round((Number(psent.approved) / Number(psent.sent)) * 100) : 0;

    res.json({
      won_revenue: wonRevenue,
      pipeline_value: Number(t.pipeline_value || 0),
      open_deals: Number(t.open_deals || 0),
      win_rate: winDenom ? Math.round((Number(t.won_count) / winDenom) * 100) : 0,
      avg_deal_size: Number(t.avg_deal_size || 0),
      proposal_conversion: proposalConversion,
      monthly_revenue: lastMonths,
      forecast_next_month: Math.round(forecast),
      by_stage: stage.rows.map(r => ({ ...r, value: Number(r.value), amount: Number(r.amount) })),
      funnel: funnel.rows,
      top_customers: customers.rows.map(r => ({ ...r, revenue: Number(r.revenue) })),
      lead_sources: sources.rows,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("GET /api/analytics/summary:", err);
    res.status(500).json({ message: "Failed to calculate analytics.", error: err.message });
  }
});

/* ============================================================ */
/* -------------------- Proposal Send + Click-to-Lead -------------------- */
/* ============================================================ */
/* Send an ai_proposals record to someone by email with a unique
   tracking link. When they click it, we log the click and — the
   first time only — create a Lead automatically, matched to an
   existing customer by the recipient's email when possible (same
   matching helper used by the inbox capture above). Then we hand
   them the proposal (redirects to the existing PDF export route).

   Requires proposal_sends table (see proposal_tracking_schema.sql)
   and reuses the same company mailbox as inbox capture:
     EMAIL, EMAIL_PASSWORD, SMTP_SERVER, SMTP_PORT — the account to
     send FROM
     PUBLIC_BASE_URL — the URL people on the internet can reach this
     server at. localhost will NOT work for a real recipient, see
     setup notes.
*/

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;

let mailTransporter = null;
if (EMAIL_USER && EMAIL_PASSWORD && SMTP_SERVER) {
  mailTransporter = nodemailer.createTransport({
    host: SMTP_SERVER,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // true for port 465 (implicit TLS), false for e.g. 587 (STARTTLS)
    auth: { user: EMAIL_USER, pass: EMAIL_PASSWORD },
    // Without these, a slow/unreachable SMTP host (common on Render's
    // network for some providers/ports) makes sendMail() hang on the OS-level
    // TCP timeout, which can be several minutes. Fail fast instead.
    connectionTimeout: 15000, // time to establish the TCP connection
    greetingTimeout: 15000,   // time to wait for the SMTP greeting after connecting
    socketTimeout: 20000,     // time to wait for any response once connected
  });
}

if (mailTransporter) {
  mailTransporter.verify()
    .then(() => console.log(`[EMAIL] SMTP verified successfully for ${EMAIL_USER}`))
    .catch((err) => console.error(`[EMAIL] SMTP verification failed: ${err.message}`));
} else {
  console.error("[EMAIL] SMTP NOT CONFIGURED — EMAIL/EMAIL_PASSWORD/SMTP_SERVER missing");
}

// Send a proposal by email with a tracked link.
app.post("/api/ai-proposals/:id/send", async (req, res) => {
  const { id } = req.params;
  const { recipient_email, recipient_name } = req.body;
  if (!recipient_email) {
    return res.status(400).json({ message: "Recipient email is required." });
  }
  if (!mailTransporter) {
    return res.status(400).json({
      message: "Email sending isn't configured. Set EMAIL, EMAIL_PASSWORD, and SMTP_SERVER in your .env.",
    });
  }
  try {
    const proposalResult = await pool.query("SELECT * FROM ai_proposals WHERE id = $1", [id]);
    const proposal = proposalResult.rows[0];
    if (!proposal) return res.status(404).json({ message: "Proposal not found." });

    const token = crypto.randomBytes(16).toString("hex");
    await pool.query(
      `INSERT INTO proposal_sends (proposal_id, recipient_email, recipient_name, tracking_token)
       VALUES ($1, $2, $3, $4)`,
      [id, recipient_email, recipient_name || null, token]
    );

    const viewUrl = `${PUBLIC_BASE_URL}/api/proposal-sends/${token}/view`;

    await mailTransporter.sendMail({
      from: EMAIL_USER,
      to: recipient_email,
      subject: proposal.title,
      html:
        `<p>Hi ${recipient_name || "there"},</p>` +
        `<p>Please find your proposal &mdash; <strong>${proposal.title}</strong>.</p>` +
        `<p><a href="${viewUrl}">View / Download Proposal</a></p>` +
        `<p>Thanks!</p>`,
    });

    res.json({ message: `Proposal sent to ${recipient_email}.`, tracking_token: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to send proposal.", error: err.message });
  }
});

// Send history for a proposal — who it went to, and whether they've
// opened the link yet, so the UI can show "Sent · Viewed" etc.
app.get("/api/ai-proposals/:id/sends", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM proposal_sends WHERE proposal_id = $1 ORDER BY sent_at DESC",
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

async function createLeadFromProposalClick(send, proposal) {
  const customerId = await findCustomerIdByEmail(send.recipient_email);
  const title = `Proposal viewed: ${proposal.title}`;
  const notes =
    `${send.recipient_name ? send.recipient_name + " " : ""}(${send.recipient_email}) opened the proposal ` +
    `"${proposal.title}" — sent ${new Date(send.sent_at).toLocaleString()}.`;

  const result = await pool.query(
    `INSERT INTO leads (title, source, status, estimated_value, customer_id, notes)
     VALUES ($1, 'Proposal Click', 'new', 0, $2, $3) RETURNING id`,
    [title, customerId, notes]
  );
  console.log(
    `Lead #${result.rows[0].id} captured from proposal click (${send.recipient_email})` +
    (customerId ? ` — linked to customer #${customerId}` : " — no matching customer")
  );
  return result.rows[0].id;
}

// The link recipients actually click. First click creates the lead;
// every click hands them the proposal PDF.
app.get("/api/proposal-sends/:token/view", async (req, res) => {
  const { token } = req.params;
  try {
    const sendResult = await pool.query("SELECT * FROM proposal_sends WHERE tracking_token = $1", [token]);
    const send = sendResult.rows[0];
    if (!send) return res.status(404).send("This link is invalid or has expired.");

    const proposalResult = await pool.query("SELECT * FROM ai_proposals WHERE id = $1", [send.proposal_id]);
    const proposal = proposalResult.rows[0];
    if (!proposal) return res.status(404).send("Proposal not found.");

    if (!send.clicked_at) {
      const leadId = await createLeadFromProposalClick(send, proposal);
      await pool.query(
        "UPDATE proposal_sends SET clicked_at = NOW(), lead_id = $1 WHERE id = $2",
        [leadId, send.id]
      );
    }

    res.redirect(`/api/ai-proposals/${proposal.id}/pdf`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Something went wrong opening this proposal.");
  }
});

/* ============================================================
   NOVA CRM - BROWSER-ACCURATE PROPOSAL PDF EXPORT
   Frontend: POST /api/proposals/export-pdf
   Body: { html: "...", filename: "proposal.pdf" }
   Response: application/pdf
   Requires: npm install puppeteer
   ============================================================ */

const NOVA_CRM_PDF_EXPORT_ENABLED = true;

function novaCrmSanitizePdfFilename(filename) {
  const fallback = "proposal.pdf";
  if (typeof filename !== "string" || !filename.trim()) return fallback;

  let safe = filename
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

  if (!safe.toLowerCase().endsWith(".pdf")) safe += ".pdf";
  return safe || fallback;
}

function novaCrmGetPdfBrowserOptions() {
  return {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--font-render-hinting=none",
    ],
  };
}

// Puppeteer renders the HTML string via page.setContent(), which has no
// real page URL behind it (Chromium treats it like about:blank). Any
// root-relative path in a template — <img src="/image/Picture2.png">,
// a css url('/image/...') — has nothing to resolve against and silently
// fails to load, which is why logos/cover photos show up blank in the
// exported PDF even though they render fine in an ordinary browser tab.
//
// Fix: inject a <base href="..."> pointing at PUBLIC_BASE_URL (the
// frontend origin that actually serves /image and /templates out of
// public/) so Chromium resolves those paths the same way a real browser
// tab would. Skipped if the template already defines its own <base>.
function novaCrmEnsureHtmlBase(html, baseUrl) {
  if (/<base[\s>]/i.test(html)) return html;
  const safeBase = String(baseUrl).replace(/"/g, "&quot;");
  const baseTag = `<base href="${safeBase}/">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}\n${baseTag}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (match) => `${match}\n<head>${baseTag}</head>`);
  }
  return `${baseTag}\n${html}`;
}

async function novaCrmCreateProposalPdf(html) {
  if (typeof html !== "string" || !html.trim()) {
    throw new Error("Proposal HTML is empty.");
  }

  html = novaCrmEnsureHtmlBase(html, PUBLIC_BASE_URL);

  let puppeteer;
  try {
    puppeteer = require("puppeteer");
  } catch (error) {
    const dependencyError = new Error("Puppeteer is not installed. Run: npm install puppeteer");
    dependencyError.cause = error;
    throw dependencyError;
  }

  const browser = await puppeteer.launch(novaCrmGetPdfBrowserOptions());
  try {
    const page = await browser.newPage();

    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

    await page.setContent(html, {
      waitUntil: ["domcontentloaded", "networkidle0"],
      timeout: 60000,
    });

    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        try {
          await document.fonts.ready;
        } catch {
          // Continue if a font fails.
        }
      }

      const images = Array.from(document.images || []);
      await Promise.all(
        images.map((image) => {
          if (image.complete) return Promise.resolve();
          return new Promise((resolve) => {
            const done = () => resolve();
            image.addEventListener("load", done, { once: true });
            image.addEventListener("error", done, { once: true });
            setTimeout(done, 10000);
          });
        })
      );
    });

    await page.emulateMediaType("print");

    return await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  } finally {
    await browser.close();
  }
}

if (!app.__novaCrmProposalPdfExportRegistered) {
  app.__novaCrmProposalPdfExportRegistered = true;

  app.post("/api/proposals/export-pdf", async (req, res) => {
    try {
      if (!NOVA_CRM_PDF_EXPORT_ENABLED) {
        return res.status(503).json({ message: "PDF export is currently disabled." });
      }

      const body = req.body || {};
      const html = body.html;
      const filename = novaCrmSanitizePdfFilename(body.filename);

      if (typeof html !== "string" || !html.trim()) {
        return res.status(400).json({ message: "Proposal HTML is required." });
      }

      if (html.length > 25 * 1024 * 1024) {
        return res.status(413).json({ message: "Proposal HTML is too large." });
      }

      console.log("Nova CRM: generating proposal PDF...");
      const pdf = await novaCrmCreateProposalPdf(html);
      console.log("Nova CRM: proposal PDF generated successfully.");

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", String(pdf.length));
      res.setHeader("Cache-Control", "no-store");

      return res.status(200).send(pdf);
    } catch (error) {
      console.error("Nova CRM proposal PDF export failed:", error);
      return res.status(500).json({
        message: error instanceof Error ? error.message : "Failed to generate proposal PDF.",
      });
    }
  });

  console.log("Nova CRM: PDF export endpoint registered: POST /api/proposals/export-pdf");
}

/* ============================================================
   CLIENT USER CONTRACT WORKSPACE
   IMPORTANT:
   - Access is based on crm_users.id -> client_contracts.user_id.
   - This feature does NOT use customers.id to decide portal access.
   - A login user may have multiple contracts.
   - Client users are read-only for commercial/admin-managed data.
   ============================================================ */

async function requireClientContractOwner(req, res, contractId) {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) return null;

  const id = Number(contractId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ message: "Invalid contract id." });
    return null;
  }

  const result = await pool.query(
    `SELECT DISTINCT cc.*,
            u.email AS user_email,
            u.full_name AS user_full_name,
            u.role AS user_role
     FROM client_contracts cc
     JOIN crm_users u ON u.id = cc.user_id
     LEFT JOIN client_contract_team t
       ON t.contract_id = cc.id
      AND t.member_user_id = $2
      AND t.assignment_status = 'accepted'
      AND t.is_current = TRUE
     WHERE cc.id = $1
       AND (cc.user_id = $2 OR t.id IS NOT NULL)
     LIMIT 1`,
    [id, user.id]
  );

  if (!result.rows[0]) {
    res.status(404).json({ message: "Contract is not assigned to this login." });
    return null;
  }

  return {
    user,
    contract: result.rows[0],
    is_owner: String(result.rows[0].user_id) === String(user.id),
    is_accepted_team_member: String(result.rows[0].user_id) !== String(user.id),
  };
}

async function getClientContractWorkspace(contractId) {
  const id = Number(contractId);
  const contractResult = await pool.query(
    `SELECT cc.*,
            u.email AS client_email,
            u.full_name AS client_name,
            u.role AS client_role,
            c.company_name AS crm_company_name,
            c.contact_name AS crm_contact_name,
            c.phone AS crm_phone,
            c.website AS crm_website
     FROM client_contracts cc
     JOIN crm_users u ON u.id = cc.user_id
     LEFT JOIN customers c ON c.id = cc.customer_id
     WHERE cc.id = $1
     LIMIT 1`,
    [id]
  );

  if (!contractResult.rows[0]) return null;

  const contract = contractResult.rows[0];

  const [onboarding, team, meetings, documents, billing, invoices, purchaseOrders, payments, activity] =
    await Promise.all([
      pool.query(
        `SELECT * FROM client_onboarding WHERE contract_id = $1 LIMIT 1`,
        [id]
      ),
      pool.query(
        `SELECT t.*, u.full_name AS assigned_user_name, u.email AS assigned_user_email
         FROM client_contract_team t
         LEFT JOIN crm_users u ON u.id = t.member_user_id
         WHERE t.contract_id = $1
         ORDER BY t.is_current DESC, t.assignment_start_date IS NULL, t.assignment_start_date DESC, t.created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT * FROM client_contract_meetings
         WHERE contract_id = $1
         ORDER BY meeting_date IS NULL, meeting_date DESC, created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT * FROM client_contract_documents
         WHERE contract_id = $1 AND is_client_visible = TRUE
         ORDER BY created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT * FROM client_contract_billing
         WHERE contract_id = $1
         ORDER BY next_billing_date IS NULL, next_billing_date ASC, created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT * FROM client_contract_invoices
         WHERE contract_id = $1
         ORDER BY invoice_date IS NULL, invoice_date DESC, created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT * FROM client_contract_purchase_orders
         WHERE contract_id = $1
         ORDER BY issue_date IS NULL, issue_date DESC, created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT * FROM client_contract_payments
         WHERE contract_id = $1
         ORDER BY payment_date IS NULL, payment_date DESC, created_at DESC`,
        [id]
      ),
      pool.query(
        `SELECT * FROM client_contract_activity
         WHERE contract_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [id]
      ),
    ]);

  return {
    contract,
    onboarding: onboarding.rows[0] || null,
    team: team.rows,
    meetings: meetings.rows,
    documents: documents.rows,
    billing: billing.rows,
    invoices: invoices.rows,
    purchase_orders: purchaseOrders.rows,
    payments: payments.rows,
    activity: activity.rows,
  };
}

/* Client: list only contracts owned by the authenticated login. */
app.get("/api/client/contracts", async (req, res) => {
  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;

    const result = await pool.query(
      `SELECT cc.id, cc.contract_number, cc.contract_title, cc.client_company_name,
              cc.status, cc.start_date, cc.end_date, cc.total_duration,
              cc.services_covered, cc.contract_value, cc.currency,
              co.onboarding_status, co.project_status, co.current_phase,
              co.progress_percent, co.project_start_date
       FROM client_contracts cc
       LEFT JOIN client_onboarding co ON co.contract_id = cc.id
       WHERE cc.user_id = $1
          OR EXISTS (
            SELECT 1
            FROM client_contract_team t
            WHERE t.contract_id = cc.id
              AND t.member_user_id = $1
              AND t.assignment_status = 'accepted'
              AND t.is_current = TRUE
          )
       ORDER BY
         CASE WHEN lower(cc.status) = 'active' THEN 0 ELSE 1 END,
         cc.start_date IS NULL, cc.start_date DESC,
         cc.id DESC`,
      [user.id]
    );

    return res.json({
      user: authUserResponse(user),
      contracts: result.rows,
    });
  } catch (err) {
    console.error("[CLIENT CONTRACTS GET]", err);
    return res.status(500).json({
      message: "Failed to load client contracts.",
      error: err.message,
    });
  }
});

/* Client: one complete contract workspace. */
app.get("/api/client/contracts/:contractId/workspace", async (req, res) => {
  try {
    const access = await requireClientContractOwner(req, res, req.params.contractId);
    if (!access) return;

    const workspace = await getClientContractWorkspace(access.contract.id);
    return res.json({
      user: authUserResponse(access.user),
      ...workspace,
    });
  } catch (err) {
    console.error("[CLIENT CONTRACT WORKSPACE GET]", err);
    return res.status(500).json({
      message: "Failed to load client contract workspace.",
      error: err.message,
    });
  }
});

/*
 * Client self-service update.
 * Only non-commercial onboarding notes are editable by the client.
 * Contract dates, amount, billing, invoices, PO and payments stay staff-managed.
 */
app.put("/api/client/contracts/:contractId/onboarding", async (req, res) => {
  try {
    const access = await requireClientContractOwner(req, res, req.params.contractId);
    if (!access) return;

    const {
      onboarding_notes,
      project_notes,
      service_notes,
      initial_project_discussion_date,
    } = req.body || {};

    const result = await pool.query(
      `INSERT INTO client_onboarding
        (contract_id, onboarding_notes, project_notes, service_notes,
         initial_project_discussion_date)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (contract_id)
       DO UPDATE SET
         onboarding_notes = COALESCE(EXCLUDED.onboarding_notes, client_onboarding.onboarding_notes),
         project_notes = COALESCE(EXCLUDED.project_notes, client_onboarding.project_notes),
         service_notes = COALESCE(EXCLUDED.service_notes, client_onboarding.service_notes),
         initial_project_discussion_date =
           COALESCE(EXCLUDED.initial_project_discussion_date,
                    client_onboarding.initial_project_discussion_date),
         updated_at = NOW()
       RETURNING *`,
      [
        access.contract.id,
        onboarding_notes ?? null,
        project_notes ?? null,
        service_notes ?? null,
        initial_project_discussion_date || null,
      ]
    );

    await pool.query(
      `INSERT INTO client_contract_activity
        (contract_id, activity_type, title, description, actor_user_id, actor_name, actor_role)
       VALUES ($1, 'client_update', 'Client onboarding information updated',
               'The client login updated permitted onboarding notes.', $2, $3, $4)`,
      [
        access.contract.id,
        access.user.id,
        access.user.full_name || access.user.email,
        access.user.role || "client",
      ]
    );

    return res.json({
      message: "Permitted onboarding information saved.",
      onboarding: result.rows[0],
    });
  } catch (err) {
    console.error("[CLIENT ONBOARDING PUT]", err);
    return res.status(500).json({
      message: "Failed to save onboarding information.",
      error: err.message,
    });
  }
});

/* ============================================================
   ADMIN / STAFF CONTRACT MANAGEMENT
   ============================================================ */

function isContractManager(role) {
  return ["admin", "manager", "staff", "sales"].includes(
    String(role || "").toLowerCase()
  );
}

async function requireContractManager(req, res) {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) return null;

  if (!isContractManager(user.role)) {
    res.status(403).json({ message: "Staff access required." });
    return null;
  }

  return user;
}

/* List client users for contract assignment. */
app.get("/api/admin/client-users", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;

    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.email_verified,
              u.created_at,
              COUNT(cc.id) AS contract_count,
              COALESCE(
                JSON_ARRAYAGG(
                  CASE WHEN cc.id IS NOT NULL THEN JSON_OBJECT(
                    'id', cc.id,
                    'contract_number', cc.contract_number,
                    'client_company_name', cc.client_company_name,
                    'contract_title', cc.contract_title,
                    'status', cc.status,
                    'start_date', cc.start_date,
                    'end_date', cc.end_date,
                    'contract_value', cc.contract_value,
                    'currency', cc.currency,
                    'onboarding_status', co.onboarding_status,
                    'progress_percent', co.progress_percent
                  ) END
                ),
                JSON_ARRAY()
              ) AS contracts
       FROM crm_users u
       LEFT JOIN client_contracts cc ON cc.user_id = u.id
       LEFT JOIN client_onboarding co ON co.contract_id = cc.id
       WHERE lower(u.role) IN ('client', 'user', 'customer')
          OR cc.id IS NOT NULL
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("[ADMIN CLIENT USERS GET]", err);
    return res.status(500).json({ message: "Failed to load client users.", error: err.message });
  }
});

/* Create a contract directly for a login user. */
app.post("/api/admin/client-contracts", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;

    const {
      user_id,
      customer_id,
      contract_number,
      client_company_name,
      contract_title,
      status,
      start_date,
      end_date,
      total_duration,
      services_covered,
      contract_value,
      currency,
      contract_document_url,
      notes,
    } = req.body || {};

    if (!user_id || !contract_number) {
      return res.status(400).json({
        message: "user_id and contract_number are required.",
      });
    }

    const result = await pool.query(
      `INSERT INTO client_contracts
        (user_id, customer_id, contract_number, client_company_name,
         contract_title, status, start_date, end_date, total_duration,
         services_covered, contract_value, currency, contract_document_url, notes)
       VALUES
        ($1, $2, $3, $4, COALESCE($5, 'Client Service Agreement'),
         COALESCE($6, 'Active'), $7, $8, $9, $10, COALESCE($11, 0),
         COALESCE($12, 'INR'), $13, $14)
       RETURNING *`,
      [
        user_id,
        customer_id || null,
        contract_number,
        client_company_name || null,
        contract_title || null,
        status || null,
        start_date || null,
        end_date || null,
        total_duration || null,
        services_covered || null,
        contract_value || 0,
        currency || "INR",
        contract_document_url || null,
        notes || null,
      ]
    );

    return res.status(201).json({
      message: "Contract created for login user.",
      contract: result.rows[0],
    });
  } catch (err) {
    console.error("[ADMIN CLIENT CONTRACT POST]", err);
    const duplicate = err.code === "23505";
    return res.status(duplicate ? 409 : 500).json({
      message: duplicate ? "Contract number already exists." : "Failed to create contract.",
      error: err.message,
    });
  }
});

/* Update contract master data. */
app.put("/api/admin/client-contracts/:contractId", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;

    const id = Number(req.params.contractId);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid contract id." });

    const {
      customer_id,
      client_company_name,
      contract_title,
      status,
      start_date,
      end_date,
      total_duration,
      services_covered,
      contract_value,
      currency,
      contract_document_url,
      notes,
    } = req.body || {};

    const result = await pool.query(
      `UPDATE client_contracts SET
         customer_id = COALESCE($1, customer_id),
         client_company_name = COALESCE($2, client_company_name),
         contract_title = COALESCE($3, contract_title),
         status = COALESCE($4, status),
         start_date = COALESCE($5, start_date),
         end_date = COALESCE($6, end_date),
         total_duration = COALESCE($7, total_duration),
         services_covered = COALESCE($8, services_covered),
         contract_value = COALESCE($9, contract_value),
         currency = COALESCE($10, currency),
         contract_document_url = COALESCE($11, contract_document_url),
         notes = COALESCE($12, notes),
         updated_at = NOW()
       WHERE id = $13
       RETURNING *`,
      [
        customer_id ?? null,
        client_company_name ?? null,
        contract_title ?? null,
        status ?? null,
        start_date ?? null,
        end_date ?? null,
        total_duration ?? null,
        services_covered ?? null,
        contract_value ?? null,
        currency ?? null,
        contract_document_url ?? null,
        notes ?? null,
        id,
      ]
    );

    if (!result.rows[0]) return res.status(404).json({ message: "Contract not found." });

    await pool.query(
      `INSERT INTO client_contract_activity
        (contract_id, activity_type, title, description, actor_user_id, actor_name, actor_role)
       VALUES ($1, 'contract_updated', 'Contract updated',
               'Contract master information was updated by staff.', $2, $3, $4)`,
      [id, actor.id, actor.full_name || actor.email, actor.role]
    );

    return res.json({ message: "Contract updated.", contract: result.rows[0] });
  } catch (err) {
    console.error("[ADMIN CLIENT CONTRACT PUT]", err);
    return res.status(500).json({ message: "Failed to update contract.", error: err.message });
  }
});

/* Update the official onboarding/project-start status. Staff only. */
app.put("/api/admin/client-contracts/:contractId/onboarding", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;

    const id = Number(req.params.contractId);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid contract id." });

    const {
      onboarding_status,
      onboarding_completed_at,
      onboarding_completed_by,
      onboarding_notes,
      project_start_date,
      initial_project_discussion_date,
      project_status,
      current_phase,
      progress_percent,
      service_name,
      service_duration,
      service_active_until,
      service_notes,
      project_notes,
    } = req.body || {};

    const result = await pool.query(
      `INSERT INTO client_onboarding
        (contract_id, onboarding_status, onboarding_completed_at,
         onboarding_completed_by, onboarding_notes, project_start_date,
         initial_project_discussion_date, project_status, current_phase,
         progress_percent, service_name, service_duration, service_active_until,
         service_notes, project_notes)
       VALUES ($1, COALESCE($2, 'Pending'), $3, $4, $5, $6, $7,
               COALESCE($8, 'Not Started'), COALESCE($9, 'Requirement Analysis'),
               COALESCE($10, 0), $11, $12, $13, $14, $15)
       ON CONFLICT (contract_id)
       DO UPDATE SET
         onboarding_status = COALESCE(EXCLUDED.onboarding_status, client_onboarding.onboarding_status),
         onboarding_completed_at = COALESCE(EXCLUDED.onboarding_completed_at, client_onboarding.onboarding_completed_at),
         onboarding_completed_by = COALESCE(EXCLUDED.onboarding_completed_by, client_onboarding.onboarding_completed_by),
         onboarding_notes = COALESCE(EXCLUDED.onboarding_notes, client_onboarding.onboarding_notes),
         project_start_date = COALESCE(EXCLUDED.project_start_date, client_onboarding.project_start_date),
         initial_project_discussion_date = COALESCE(EXCLUDED.initial_project_discussion_date, client_onboarding.initial_project_discussion_date),
         project_status = COALESCE(EXCLUDED.project_status, client_onboarding.project_status),
         current_phase = COALESCE(EXCLUDED.current_phase, client_onboarding.current_phase),
         progress_percent = COALESCE(EXCLUDED.progress_percent, client_onboarding.progress_percent),
         service_name = COALESCE(EXCLUDED.service_name, client_onboarding.service_name),
         service_duration = COALESCE(EXCLUDED.service_duration, client_onboarding.service_duration),
         service_active_until = COALESCE(EXCLUDED.service_active_until, client_onboarding.service_active_until),
         service_notes = COALESCE(EXCLUDED.service_notes, client_onboarding.service_notes),
         project_notes = COALESCE(EXCLUDED.project_notes, client_onboarding.project_notes),
         updated_at = NOW()
       RETURNING *`,
      [
        id,
        onboarding_status ?? null,
        onboarding_completed_at || null,
        onboarding_completed_by || (actor.full_name || actor.email),
        onboarding_notes ?? null,
        project_start_date || null,
        initial_project_discussion_date || null,
        project_status ?? null,
        current_phase ?? null,
        progress_percent == null ? null : Number(progress_percent),
        service_name ?? null,
        service_duration ?? null,
        service_active_until || null,
        service_notes ?? null,
        project_notes ?? null,
      ]
    );

    await pool.query(
      `INSERT INTO client_contract_activity
        (contract_id, activity_type, title, description, actor_user_id, actor_name, actor_role)
       VALUES ($1, 'onboarding_updated', 'Client onboarding updated',
               'Official onboarding/project information was updated by staff.', $2, $3, $4)`,
      [id, actor.id, actor.full_name || actor.email, actor.role]
    );

    return res.json({ message: "Onboarding updated.", onboarding: result.rows[0] });
  } catch (err) {
    console.error("[ADMIN CLIENT ONBOARDING PUT]", err);
    return res.status(500).json({ message: "Failed to update onboarding.", error: err.message });
  }
});

/* Admin/staff list of every assigned client contract. */
app.get("/api/admin/client-contracts", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;

    const result = await pool.query(
      `SELECT
         cc.*,
         u.email AS client_email,
         u.full_name AS client_name,
         u.role AS client_role,
         co.onboarding_status,
         co.onboarding_completed_at,
         co.project_start_date,
         co.project_status,
         co.current_phase,
         co.progress_percent
       FROM client_contracts cc
       JOIN crm_users u ON u.id = cc.user_id
       LEFT JOIN client_onboarding co ON co.contract_id = cc.id
       ORDER BY cc.created_at DESC, cc.id DESC`
    );

    return res.json({ contracts: result.rows });
  } catch (err) {
    console.error("[ADMIN CLIENT CONTRACTS GET]", err);
    return res.status(500).json({
      message: "Failed to load client contracts.",
      error: err.message,
    });
  }
});

/* Admin/staff complete workspace read API. */
app.get("/api/admin/client-contracts/:contractId/workspace", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;

    const workspace = await getClientContractWorkspace(req.params.contractId);
    if (!workspace) return res.status(404).json({ message: "Contract not found." });

    return res.json(workspace);
  } catch (err) {
    console.error("[ADMIN CLIENT WORKSPACE GET]", err);
    return res.status(500).json({ message: "Failed to load contract workspace.", error: err.message });
  }
});

/*
 * Generic staff CRUD for the secondary workspace collections.
 * The table names are never taken directly from the request.
 */
const CLIENT_CONTRACT_RESOURCE_TABLES = Object.freeze({
  team: {
    table: "client_contract_team",
    idColumn: "id",
    orderBy: "created_at DESC",
  },
  meetings: {
    table: "client_contract_meetings",
    idColumn: "id",
    orderBy: "meeting_date IS NULL, meeting_date DESC, created_at DESC",
  },
  documents: {
    table: "client_contract_documents",
    idColumn: "id",
    orderBy: "created_at DESC",
  },
  billing: {
    table: "client_contract_billing",
    idColumn: "id",
    orderBy: "next_billing_date IS NULL, next_billing_date ASC, created_at DESC",
  },
  invoices: {
    table: "client_contract_invoices",
    idColumn: "id",
    orderBy: "invoice_date IS NULL, invoice_date DESC, created_at DESC",
  },
  purchase_orders: {
    table: "client_contract_purchase_orders",
    idColumn: "id",
    orderBy: "issue_date IS NULL, issue_date DESC, created_at DESC",
  },
  payments: {
    table: "client_contract_payments",
    idColumn: "id",
    orderBy: "payment_date IS NULL, payment_date DESC, created_at DESC",
  },
});

function safeResource(resource) {
  return CLIENT_CONTRACT_RESOURCE_TABLES[resource] || null;
}


/* Project-team assignment requests. Only existing CRM login users can be assigned. */
app.post("/api/admin/client-contracts/:contractId/team", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;

    const contractId = Number(req.params.contractId);
    const body = req.body || {};
    if (!Number.isInteger(contractId) || !body.member_user_id) {
      return res.status(400).json({ message: "A valid contract and existing login user are required." });
    }

    const [contractResult, userResult] = await Promise.all([
      pool.query("SELECT id FROM client_contracts WHERE id = $1 LIMIT 1", [contractId]),
      pool.query(
        `SELECT id, full_name, email FROM crm_users
         WHERE id = $1 AND email_verified = TRUE
         LIMIT 1`,
        [body.member_user_id]
      ),
    ]);

    if (!contractResult.rows[0]) return res.status(404).json({ message: "Contract not found." });
    const member = userResult.rows[0];
    if (!member) return res.status(400).json({ message: "Selected login user does not exist or is not verified." });

    const duplicate = await pool.query(
      `SELECT id FROM client_contract_team
       WHERE contract_id = $1 AND member_user_id = $2
         AND assignment_status IN ('pending', 'accepted')
       LIMIT 1`,
      [contractId, member.id]
    );
    if (duplicate.rows[0]) {
      return res.status(409).json({ message: "This login user already has a pending or accepted assignment for this contract." });
    }

    const result = await pool.query(
      `INSERT INTO client_contract_team
        (contract_id, member_user_id, member_name, member_email, role, department,
         assignment_start_date, assignment_end_date, is_current, responsibilities,
         assignment_status, requested_at, requested_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9,'pending',NOW(),$10)
       RETURNING *`,
      [
        contractId, member.id, member.full_name || member.email, member.email,
        body.role || null, body.department || null,
        body.assignment_start_date || null, body.assignment_end_date || null,
        body.responsibilities || null, actor.id,
      ]
    );

    await pool.query(
      `INSERT INTO client_contract_activity
        (contract_id, activity_type, title, description, actor_user_id, actor_name, actor_role, metadata)
       VALUES ($1,'team_assignment_requested','Project team assignment request sent',
               $2,$3,$4,$5,$6)`,
      [
        contractId,
        `Assignment request sent to ${member.full_name || member.email}.`,
        actor.id, actor.full_name || actor.email, actor.role,
        JSON.stringify({ team_id: result.rows[0].id, member_user_id: member.id }),
      ]
    );

    return res.status(201).json({
      message: "Assignment request sent. The selected login user must accept it.",
      team: result.rows[0],
    });
  } catch (err) {
    console.error("[PROJECT TEAM REQUEST CREATE]", err);
    return res.status(500).json({ message: "Failed to send assignment request.", error: err.message });
  }
});

/* Logged-in user: list all pending project-team assignment requests. */
app.get("/api/client/team-assignment-requests", async (req, res) => {
  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;

    const result = await pool.query(
      `SELECT t.*, cc.contract_number, cc.contract_title, cc.client_company_name
       FROM client_contract_team t
       JOIN client_contracts cc ON cc.id = t.contract_id
       WHERE t.member_user_id = $1 AND t.assignment_status = 'pending'
       ORDER BY t.requested_at IS NULL, t.requested_at DESC, t.created_at DESC`,
      [user.id]
    );
    return res.json({ requests: result.rows });
  } catch (err) {
    console.error("[TEAM REQUESTS GET]", err);
    return res.status(500).json({ message: "Failed to load assignment requests.", error: err.message });
  }
});

/* Logged-in requested user: accept or decline only their own request. */
app.post("/api/client/team-assignment-requests/:teamId/respond", async (req, res) => {
  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;

    const teamId = Number(req.params.teamId);
    const decision = String(req.body?.decision || "").toLowerCase();
    if (!Number.isInteger(teamId) || !["accepted", "declined"].includes(decision)) {
      return res.status(400).json({ message: "Decision must be accepted or declined." });
    }

    const result = await pool.query(
      `UPDATE client_contract_team
       SET assignment_status = $1,
           is_current = CASE WHEN $1 = 'accepted' THEN TRUE ELSE FALSE END,
           responded_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND member_user_id = $3 AND assignment_status = 'pending'
       RETURNING *`,
      [decision, teamId, user.id]
    );

    const row = result.rows[0];
    if (!row) return res.status(404).json({ message: "Pending assignment request not found for this login." });

    await pool.query(
      `INSERT INTO client_contract_activity
        (contract_id, activity_type, title, description, actor_user_id, actor_name, actor_role, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.contract_id,
        decision === "accepted" ? "team_assignment_accepted" : "team_assignment_declined",
        decision === "accepted" ? "Project assignment accepted" : "Project assignment declined",
        `${user.full_name || user.email} ${decision} the project team assignment request.`,
        user.id, user.full_name || user.email, user.role,
        JSON.stringify({ team_id: row.id }),
      ]
    );

    return res.json({
      message: decision === "accepted" ? "Project assignment accepted." : "Project assignment declined.",
      team: row,
    });
  } catch (err) {
    console.error("[TEAM REQUEST RESPOND]", err);
    return res.status(500).json({ message: "Failed to respond to assignment request.", error: err.message });
  }
});

app.post("/api/admin/client-contracts/:contractId/:resource", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;

    const contractId = Number(req.params.contractId);
    const meta = safeResource(req.params.resource);
    if (!Number.isInteger(contractId) || !meta) {
      return res.status(400).json({ message: "Invalid contract or resource." });
    }

    const contractCheck = await pool.query(
      "SELECT id FROM client_contracts WHERE id = $1 LIMIT 1",
      [contractId]
    );
    if (!contractCheck.rows[0]) return res.status(404).json({ message: "Contract not found." });

    const body = req.body || {};
    const allowed = Object.keys(body).filter(
      (key) => key !== "id" && key !== "contract_id" && /^[a-z_][a-z0-9_]*$/i.test(key)
    );

    if (!allowed.length) return res.status(400).json({ message: "No fields supplied." });

    const columns = ["contract_id", ...allowed];
    const values = [contractId, ...allowed.map((key) => body[key])];
    const placeholders = columns.map((_, i) => `$${i + 1}`);

    const result = await pool.query(
      `INSERT INTO ${meta.table} (${columns.join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING *`,
      values
    );

    await pool.query(
      `INSERT INTO client_contract_activity
        (contract_id, activity_type, title, description, actor_user_id, actor_name, actor_role, metadata)
       VALUES ($1, 'resource_created', $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        contractId,
        `${req.params.resource} record added`,
        `Staff added a ${req.params.resource} record to the contract workspace.`,
        actor.id,
        actor.full_name || actor.email,
        actor.role,
        JSON.stringify({ resource: req.params.resource, record_id: result.rows[0].id }),
      ]
    );

    return res.status(201).json({ record: result.rows[0] });
  } catch (err) {
    console.error("[ADMIN CONTRACT RESOURCE POST]", err);
    return res.status(500).json({ message: "Failed to create workspace record.", error: err.message });
  }
});

app.put("/api/admin/client-contracts/:contractId/:resource/:recordId", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;

    const contractId = Number(req.params.contractId);
    const recordId = Number(req.params.recordId);
    const meta = safeResource(req.params.resource);

    if (!Number.isInteger(contractId) || !Number.isInteger(recordId) || !meta) {
      return res.status(400).json({ message: "Invalid contract, resource or record id." });
    }

    const body = req.body || {};

    /*
     * Project-team records have an approval workflow.
     * After a login user accepts, keep the accepted user and approval state intact.
     * Admin can still edit role, department, dates, responsibilities and
     * toggle "Currently assigned" without turning the accepted record into
     * a generic update that can break the assignment/access relationship.
     */
    if (req.params.resource === "team") {
      const existingResult = await pool.query(
        `SELECT *
         FROM client_contract_team
         WHERE id = $1 AND contract_id = $2
         LIMIT 1`,
        [recordId, contractId]
      );
      const existing = existingResult.rows[0];
      if (!existing) return res.status(404).json({ message: "Workspace record not found." });

      const accepted = String(existing.assignment_status || "").toLowerCase() === "accepted";
      const allowedTeamFields = [
        "member_user_id",
        "role",
        "department",
        "assignment_start_date",
        "assignment_end_date",
        "is_current",
        "responsibilities",
      ];

      const requested = allowedTeamFields.filter(
        (key) => Object.prototype.hasOwnProperty.call(body, key)
      );

      if (!requested.length) {
        return res.status(400).json({ message: "No editable team fields supplied." });
      }

      if (accepted && Object.prototype.hasOwnProperty.call(body, "member_user_id")
          && String(body.member_user_id || "") !== String(existing.member_user_id || "")) {
        return res.status(400).json({
          message: "An accepted assignment cannot be moved to another login user. Create a new assignment request instead.",
        });
      }

      const updateFields = accepted
        ? requested.filter((key) => key !== "member_user_id")
        : requested;

      if (!updateFields.length) {
        return res.status(400).json({
          message: "No editable changes were supplied for this accepted assignment.",
        });
      }

      const assignments = updateFields.map((key, i) => `${key} = $${i + 1}`);
      const values = updateFields.map((key) => {
        if (key === "is_current") return Boolean(body[key]);
        return body[key] === "" ? null : body[key];
      });

      assignments.push(`updated_at = NOW()`);

      const result = await pool.query(
        `UPDATE client_contract_team
         SET ${assignments.join(", ")}
         WHERE id = $${values.length + 1} AND contract_id = $${values.length + 2}
         RETURNING *`,
        [...values, recordId, contractId]
      );

      if (!result.rows[0]) return res.status(404).json({ message: "Workspace record not found." });

      await pool.query(
        `INSERT INTO client_contract_activity
          (contract_id, activity_type, title, description, actor_user_id, actor_name, actor_role, metadata)
         VALUES ($1, 'resource_updated', 'team record updated',
                 'Staff updated a project team record in the contract workspace.',
                 $2, $3, $4, $5::jsonb)`,
        [
          contractId,
          actor.id,
          actor.full_name || actor.email,
          actor.role,
          JSON.stringify({
            resource: "team",
            record_id: recordId,
            assignment_status: result.rows[0].assignment_status,
            is_current: result.rows[0].is_current,
          }),
        ]
      );

      return res.json({ record: result.rows[0] });
    }

    const allowed = Object.keys(body).filter(
      (key) => key !== "id" && key !== "contract_id" && /^[a-z_][a-z0-9_]*$/i.test(key)
    );

    if (!allowed.length) return res.status(400).json({ message: "No fields supplied." });

    const assignments = allowed.map((key, i) => `${key} = $${i + 1}`).join(", ");
    const values = allowed.map((key) => body[key]);

    const result = await pool.query(
      `UPDATE ${meta.table}
       SET ${assignments}
       WHERE id = $${values.length + 1} AND contract_id = $${values.length + 2}
       RETURNING *`,
      [...values, recordId, contractId]
    );

    if (!result.rows[0]) return res.status(404).json({ message: "Workspace record not found." });

    await pool.query(
      `INSERT INTO client_contract_activity
        (contract_id, activity_type, title, description, actor_user_id, actor_name, actor_role, metadata)
       VALUES ($1, 'resource_updated', $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        contractId,
        `${req.params.resource} record updated`,
        `Staff updated a ${req.params.resource} record in the contract workspace.`,
        actor.id,
        actor.full_name || actor.email,
        actor.role,
        JSON.stringify({ resource: req.params.resource, record_id: recordId }),
      ]
    );

    return res.json({ record: result.rows[0] });
  } catch (err) {
    console.error("[ADMIN CONTRACT RESOURCE PUT]", err);
    return res.status(500).json({ message: "Failed to update workspace record.", error: err.message });
  }
});

app.delete("/api/admin/client-contracts/:contractId/:resource/:recordId", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;

    const contractId = Number(req.params.contractId);
    const recordId = Number(req.params.recordId);
    const meta = safeResource(req.params.resource);

    if (!Number.isInteger(contractId) || !Number.isInteger(recordId) || !meta) {
      return res.status(400).json({ message: "Invalid contract, resource or record id." });
    }

    const result = await pool.query(
      `DELETE FROM ${meta.table}
       WHERE id = $1 AND contract_id = $2
       RETURNING id`,
      [recordId, contractId]
    );

    if (!result.rows[0]) return res.status(404).json({ message: "Workspace record not found." });

    await pool.query(
      `INSERT INTO client_contract_activity
        (contract_id, activity_type, title, description, actor_user_id, actor_name, actor_role, metadata)
       VALUES ($1, 'resource_deleted', $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        contractId,
        `${req.params.resource} record deleted`,
        `Staff deleted a ${req.params.resource} record from the contract workspace.`,
        actor.id,
        actor.full_name || actor.email,
        actor.role,
        JSON.stringify({ resource: req.params.resource, record_id: recordId }),
      ]
    );

    return res.json({ message: "Workspace record deleted." });
  } catch (err) {
    console.error("[ADMIN CONTRACT RESOURCE DELETE]", err);
    return res.status(500).json({ message: "Failed to delete workspace record.", error: err.message });
  }
});

/* Backward-compatible endpoint alias for older frontend code.
   It now creates a contract for the login user instead of linking to customer access. */
app.put("/api/admin/users/:userId/client-link", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;

    const { userId } = req.params;
    const {
      contract_number,
      client_company_name,
      start_date,
      end_date,
      services_covered,
      contract_value,
      currency,
      customer_id,
    } = req.body || {};

    if (!contract_number) {
      return res.status(400).json({
        message: "contract_number is required. This endpoint now creates a user contract.",
      });
    }

    const result = await pool.query(
      `INSERT INTO client_contracts
        (user_id, customer_id, contract_number, client_company_name,
         start_date, end_date, services_covered, contract_value, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 0), COALESCE($9, 'INR'))
       RETURNING *`,
      [
        userId,
        customer_id || null,
        contract_number,
        client_company_name || null,
        start_date || null,
        end_date || null,
        services_covered || null,
        contract_value || 0,
        currency || "INR",
      ]
    );

    await pool.query(
      `UPDATE crm_users SET role = 'client', updated_at = NOW() WHERE id = $1`,
      [userId]
    );

    return res.status(201).json({
      message: "Login user assigned to contract.",
      contract: result.rows[0],
    });
  } catch (err) {
    console.error("[ADMIN CLIENT LINK LEGACY]", err);
    return res.status(500).json({
      message: "Failed to assign contract to login user.",
      error: err.message,
    });
  }
});

/* ============================================================
   ONLINE PAYMENTS — Razorpay (UPI / Google Pay / cards) + manual
   bank transfer, wired into the existing invoices/payments tables.

   Required environment variables (server .env):
     RAZORPAY_KEY_ID        — from Razorpay Dashboard > API Keys
     RAZORPAY_KEY_SECRET    — from Razorpay Dashboard > API Keys
     RAZORPAY_WEBHOOK_SECRET— set when you add the webhook URL below
                              in Dashboard > Settings > Webhooks
     ADMIN_NOTIFY_EMAIL     — optional; where "payment received"
                              emails are sent (reuses the existing
                              EMAIL/EMAIL_PASSWORD/SMTP_SERVER sender)

   Webhook URL to register in the Razorpay dashboard:
     {PUBLIC_BASE_URL}/api/webhooks/razorpay
     Events to enable: payment.captured, payment.failed

   Until the two RAZORPAY_* keys are set, the "Pay Now" endpoints
   respond with a clear 400 instead of crashing the server, so the
   rest of the CRM keeps working with placeholder/no keys.
   ============================================================ */

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || "";

let razorpayClient = null;
if (Razorpay && RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpayClient = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
} else {
  console.warn(
    "[Razorpay] Not active yet — either the `razorpay` package isn't installed (run `npm install razorpay`) or RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET aren't set in .env. Online Pay Now will return a clear error until both are done."
  );
}

async function ensurePaymentsUpgradeSchema() {
  try {
    if (DB_DIALECT === "mysql") {
      // These objects are part of the runtime payment/notification feature.
      // The supplied SQL files are intentionally left unchanged, so create
      // only the MySQL runtime table when it is missing.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS client_contract_notifications (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          contract_id BIGINT NULL,
          notification_type VARCHAR(100) NOT NULL DEFAULT 'payment',
          title VARCHAR(255) NOT NULL,
          message TEXT,
          is_read TINYINT(1) NOT NULL DEFAULT 0,
          metadata JSON NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_client_contract_notifications_unread (is_read, created_at)
        )
      `);
      appendRuntimeLog("INFO", "MySQL payment/notification runtime schema verified");
      return;
    }
    await pool.query(`
      ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS invoice_id INTEGER
        REFERENCES client_contract_invoices(id) ON DELETE SET NULL;
      ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS payment_source TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS bank_account_id INTEGER;
      ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS razorpay_order_id TEXT;
      ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT;
      ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS razorpay_signature TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_client_contract_payments_razorpay_payment_id
        ON client_contract_payments(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_client_contract_payments_razorpay_order_id
        ON client_contract_payments(razorpay_order_id);
      ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

      ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS amount_paid NUMERIC NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS company_bank_accounts (
        id BIGSERIAL PRIMARY KEY,
        account_label TEXT NOT NULL,
        account_holder_name TEXT,
        bank_name TEXT,
        account_number TEXT,
        ifsc_code TEXT,
        upi_id TEXT,
        branch TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS client_contract_notifications (
        id BIGSERIAL PRIMARY KEY,
        contract_id INTEGER REFERENCES client_contracts(id) ON DELETE CASCADE,
        notification_type TEXT NOT NULL DEFAULT 'payment',
        title TEXT NOT NULL,
        message TEXT,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_client_contract_notifications_unread
        ON client_contract_notifications(is_read, created_at DESC);
    `);
    appendRuntimeLog("INFO", "Payments upgrade schema verified");
  } catch (err) {
    appendRuntimeLog("ERROR", "Payments upgrade schema verification failed", { message: err.message, stack: err.stack });
    console.error("Payments upgrade schema verification failed:", err);
  }
}
const paymentsSchemaReady = ensurePaymentsUpgradeSchema();

/* Records a staff-facing notification (bell icon) and, if SMTP is
   configured, emails ADMIN_NOTIFY_EMAIL. Never throws — a notification
   failure must not break the payment flow that triggered it. */
async function notifyAdmins(contractId, { type = "payment", title, message, metadata = null }) {
  try {
    await pool.query(
      `INSERT INTO client_contract_notifications (contract_id, notification_type, title, message, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [contractId, type, title, message || null, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (err) {
    console.error("[NOTIFY ADMINS] failed to store notification", err);
  }

  if (mailTransporter && ADMIN_NOTIFY_EMAIL) {
    try {
      await mailTransporter.sendMail({
        from: EMAIL_USER,
        to: ADMIN_NOTIFY_EMAIL,
        subject: title,
        html: `<p>${message || ""}</p><p style="color:#888;font-size:12px;">Contract #${contractId} · Nova CRM</p>`,
      });
    } catch (err) {
      console.error("[NOTIFY ADMINS] failed to send email", err);
    }
  }
}

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ---------------- Bank accounts (admin-managed, client-visible) ---------------- */

app.get("/api/admin/bank-accounts", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;
    const result = await pool.query(
      `SELECT * FROM company_bank_accounts ORDER BY is_active DESC, created_at DESC`
    );
    return res.json({ bank_accounts: result.rows });
  } catch (err) {
    console.error("[ADMIN BANK ACCOUNTS GET]", err);
    return res.status(500).json({ message: "Failed to load bank accounts.", error: err.message });
  }
});

app.post("/api/admin/bank-accounts", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;
    const {
      account_label, account_holder_name, bank_name, account_number,
      ifsc_code, upi_id, branch, is_active, notes,
    } = req.body || {};
    if (!account_label) return res.status(400).json({ message: "Account label is required." });

    const result = await pool.query(
      `INSERT INTO company_bank_accounts
        (account_label, account_holder_name, bank_name, account_number, ifsc_code, upi_id, branch, is_active, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, TRUE), $9)
       RETURNING *`,
      [account_label, account_holder_name || null, bank_name || null, account_number || null,
       ifsc_code || null, upi_id || null, branch || null, is_active, notes || null]
    );
    return res.status(201).json({ bank_account: result.rows[0] });
  } catch (err) {
    console.error("[ADMIN BANK ACCOUNT POST]", err);
    return res.status(500).json({ message: "Failed to add bank account.", error: err.message });
  }
});

app.put("/api/admin/bank-accounts/:id", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;
    const {
      account_label, account_holder_name, bank_name, account_number,
      ifsc_code, upi_id, branch, is_active, notes,
    } = req.body || {};

    const result = await pool.query(
      `UPDATE company_bank_accounts
       SET account_label = COALESCE($1, account_label),
           account_holder_name = $2, bank_name = $3, account_number = $4,
           ifsc_code = $5, upi_id = $6, branch = $7,
           is_active = COALESCE($8, is_active), notes = $9, updated_at = NOW()
       WHERE id = $10
       RETURNING *`,
      [account_label, account_holder_name || null, bank_name || null, account_number || null,
       ifsc_code || null, upi_id || null, branch || null, is_active, notes || null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ message: "Bank account not found." });
    return res.json({ bank_account: result.rows[0] });
  } catch (err) {
    console.error("[ADMIN BANK ACCOUNT PUT]", err);
    return res.status(500).json({ message: "Failed to update bank account.", error: err.message });
  }
});

app.delete("/api/admin/bank-accounts/:id", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;
    await pool.query(`DELETE FROM company_bank_accounts WHERE id = $1`, [req.params.id]);
    return res.json({ message: "Bank account removed." });
  } catch (err) {
    console.error("[ADMIN BANK ACCOUNT DELETE]", err);
    return res.status(500).json({ message: "Failed to delete bank account.", error: err.message });
  }
});

/* Client: bank accounts they can transfer to (active ones only). */
app.get("/api/client/bank-accounts", async (req, res) => {
  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;
    const result = await pool.query(
      `SELECT id, account_label, account_holder_name, bank_name, account_number, ifsc_code, upi_id, branch
       FROM company_bank_accounts WHERE is_active = TRUE ORDER BY created_at DESC`
    );
    return res.json({ bank_accounts: result.rows });
  } catch (err) {
    console.error("[CLIENT BANK ACCOUNTS GET]", err);
    return res.status(500).json({ message: "Failed to load bank accounts.", error: err.message });
  }
});

/* ---------------- Notifications bell (staff) ---------------- */

app.get("/api/admin/notifications", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;
    const unreadOnly = String(req.query.unread_only || "") === "true";
    const result = await pool.query(
      `SELECT n.*, cc.contract_number, cc.client_company_name
       FROM client_contract_notifications n
       LEFT JOIN client_contracts cc ON cc.id = n.contract_id
       ${unreadOnly ? "WHERE n.is_read = FALSE" : ""}
       ORDER BY n.created_at DESC
       LIMIT 50`
    );
    const unreadCount = await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM client_contract_notifications WHERE is_read = FALSE`
    );
    return res.json({ notifications: result.rows, unread_count: unreadCount.rows[0].count });
  } catch (err) {
    console.error("[ADMIN NOTIFICATIONS GET]", err);
    return res.status(500).json({ message: "Failed to load notifications.", error: err.message });
  }
});

app.put("/api/admin/notifications/:id/read", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;
    await pool.query(`UPDATE client_contract_notifications SET is_read = TRUE WHERE id = $1`, [req.params.id]);
    return res.json({ message: "Notification marked as read." });
  } catch (err) {
    console.error("[ADMIN NOTIFICATION READ]", err);
    return res.status(500).json({ message: "Failed to update notification.", error: err.message });
  }
});

app.put("/api/admin/notifications/read-all", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;
    await pool.query(`UPDATE client_contract_notifications SET is_read = TRUE WHERE is_read = FALSE`);
    return res.json({ message: "All notifications marked as read." });
  } catch (err) {
    console.error("[ADMIN NOTIFICATIONS READ ALL]", err);
    return res.status(500).json({ message: "Failed to update notifications.", error: err.message });
  }
});

/* ---------------- Razorpay: create order for an invoice ---------------- */

app.post("/api/client/contracts/:contractId/invoices/:invoiceId/razorpay-order", async (req, res) => {
  try {
    const access = await requireClientContractOwner(req, res, req.params.contractId);
    if (!access) return;

    if (!razorpayClient) {
      return res.status(400).json({
        message: "Online payment isn't configured yet. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the server .env.",
      });
    }

    const invoiceId = Number(req.params.invoiceId);
    if (!Number.isInteger(invoiceId)) return res.status(400).json({ message: "Invalid invoice id." });

    const invoiceResult = await pool.query(
      `SELECT * FROM client_contract_invoices WHERE id = $1 AND contract_id = $2 LIMIT 1`,
      [invoiceId, access.contract.id]
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });
    if (String(invoice.status || "").toLowerCase() === "paid") {
      return res.status(400).json({ message: "This invoice is already marked as paid." });
    }

    const outstanding = Number(invoice.total_amount || 0) - Number(invoice.amount_paid || 0);
    if (outstanding <= 0) {
      return res.status(400).json({ message: "Nothing outstanding on this invoice." });
    }

    const currency = invoice.currency || "INR";
    const order = await razorpayClient.orders.create({
      amount: Math.round(outstanding * 100), // Razorpay expects the smallest currency unit (paise)
      currency,
      receipt: `inv-${invoiceId}-${Date.now()}`,
      notes: { contract_id: String(access.contract.id), invoice_id: String(invoiceId) },
    });

    const paymentRow = await pool.query(
      `INSERT INTO client_contract_payments
        (contract_id, invoice_id, payment_source, payment_status, payment_method,
         amount_received, currency, razorpay_order_id, payment_date)
       VALUES ($1, $2, 'razorpay', 'Initiated', 'Razorpay (Online)', $3, $4, $5, NULL)
       RETURNING *`,
      [access.contract.id, invoiceId, outstanding, currency, order.id]
    );

    return res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: RAZORPAY_KEY_ID,
      contract_id: access.contract.id,
      invoice_id: invoiceId,
      payment_id: paymentRow.rows[0].id,
      prefill: { name: access.user.full_name || "", email: access.user.email || "" },
    });
  } catch (err) {
    console.error("[RAZORPAY ORDER CREATE]", err);
    return res.status(500).json({ message: "Failed to start payment.", error: err.message });
  }
});

/* Client-side verification, called right after Razorpay Checkout's handler
   fires. This is a convenience fast-path for the UI; the webhook below is
   the authoritative record and will also confirm the payment even if the
   browser closes before this call completes. */
app.post("/api/client/contracts/:contractId/payments/verify", async (req, res) => {
  try {
    const access = await requireClientContractOwner(req, res, req.params.contractId);
    if (!access) return;

    if (!razorpayClient) {
      return res.status(400).json({ message: "Online payment isn't configured yet." });
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Missing payment verification fields." });
    }

    const expected = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (!safeCompare(expected, razorpay_signature)) {
      return res.status(400).json({ message: "Payment signature verification failed." });
    }

    const result = await markRazorpayPaymentCaptured({
      contractId: access.contract.id,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
    });

    if (!result) return res.status(404).json({ message: "Matching payment record not found." });
    return res.json({ message: "Payment verified.", payment: result });
  } catch (err) {
    console.error("[RAZORPAY VERIFY]", err);
    return res.status(500).json({ message: "Failed to verify payment.", error: err.message });
  }
});

/* Shared by the client-verify fast-path and the webhook so both routes mark
   the payment/invoice consistently and only once (idempotent on
   razorpay_payment_id). */
async function markRazorpayPaymentCaptured({ contractId, orderId, paymentId, signature }) {
  const already = await pool.query(
    `SELECT * FROM client_contract_payments WHERE razorpay_payment_id = $1 LIMIT 1`,
    [paymentId]
  );
  if (already.rows[0]) return already.rows[0]; // already processed by the other path

  const existing = await pool.query(
    `SELECT * FROM client_contract_payments
     WHERE razorpay_order_id = $1 AND contract_id = $2 AND payment_status = 'Initiated'
     LIMIT 1`,
    [orderId, contractId]
  );
  const row = existing.rows[0];
  if (!row) return null;

  const updated = await pool.query(
    `UPDATE client_contract_payments
     SET payment_status = 'Received', razorpay_payment_id = $1, razorpay_signature = $2,
         payment_date = NOW(), transaction_reference = $1
     WHERE id = $3
     RETURNING *`,
    [paymentId, signature || null, row.id]
  );

  if (row.invoice_id) {
    await pool.query(
      `UPDATE client_contract_invoices
       SET amount_paid = amount_paid + $1,
           status = CASE WHEN amount_paid + $1 >= total_amount THEN 'Paid' ELSE status END
       WHERE id = $2`,
      [row.amount_received, row.invoice_id]
    );
  }

  await pool.query(
    `INSERT INTO client_contract_activity
      (contract_id, activity_type, title, description, actor_name, actor_role, metadata)
     VALUES ($1, 'payment_received', 'Online payment received', $2, 'Razorpay', 'system', $3::jsonb)`,
    [
      contractId,
      `${row.currency} ${row.amount_received} received via Razorpay.`,
      JSON.stringify({ payment_id: row.id, razorpay_payment_id: paymentId, invoice_id: row.invoice_id }),
    ]
  );

  await notifyAdmins(contractId, {
    type: "payment",
    title: "Payment received",
    message: `${row.currency} ${row.amount_received} received via Razorpay${row.invoice_id ? ` for invoice #${row.invoice_id}` : ""}.`,
    metadata: { payment_id: row.id, razorpay_payment_id: paymentId },
  });

  return updated.rows[0];
}

/* Razorpay webhook — source of truth. Registered in the Razorpay dashboard
   pointing at {PUBLIC_BASE_URL}/api/webhooks/razorpay. No auth header is
   sent by Razorpay; trust is established purely via the HMAC signature. */
app.post("/api/webhooks/razorpay", async (req, res) => {
  try {
    if (!RAZORPAY_WEBHOOK_SECRET) {
      console.error("[RAZORPAY WEBHOOK] received but RAZORPAY_WEBHOOK_SECRET is not set — rejecting.");
      return res.status(400).json({ message: "Webhook secret not configured." });
    }

    const signature = req.headers["x-razorpay-signature"];
    const expected = crypto
      .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
      .update(req.rawBody || Buffer.from(JSON.stringify(req.body)))
      .digest("hex");

    if (!safeCompare(expected, signature)) {
      console.error("[RAZORPAY WEBHOOK] signature mismatch — possible spoofed request.");
      return res.status(400).json({ message: "Invalid signature." });
    }

    const event = req.body?.event;
    const payment = req.body?.payload?.payment?.entity;

    if (event === "payment.captured" && payment) {
      const orderRow = await pool.query(
        `SELECT contract_id FROM client_contract_payments WHERE razorpay_order_id = $1 LIMIT 1`,
        [payment.order_id]
      );
      const contractId = orderRow.rows[0]?.contract_id;
      if (contractId) {
        await markRazorpayPaymentCaptured({
          contractId,
          orderId: payment.order_id,
          paymentId: payment.id,
          signature: null,
        });
      } else {
        console.error("[RAZORPAY WEBHOOK] payment.captured for unknown order_id", payment.order_id);
      }
    } else if (event === "payment.failed" && payment) {
      const updated = await pool.query(
        `UPDATE client_contract_payments
         SET payment_status = 'Failed', razorpay_payment_id = $1
         WHERE razorpay_order_id = $2 AND payment_status = 'Initiated'
         RETURNING contract_id, id`,
        [payment.id, payment.order_id]
      );
      if (updated.rows[0]) {
        await notifyAdmins(updated.rows[0].contract_id, {
          type: "payment",
          title: "Payment failed",
          message: `A Razorpay payment attempt failed (order ${payment.order_id}).`,
        });
      }
    }

    // Always 200 once the signature checks out, even for events we don't
    // act on, so Razorpay doesn't keep retrying.
    return res.json({ received: true });
  } catch (err) {
    console.error("[RAZORPAY WEBHOOK]", err);
    // Still 200: the error is already logged, and a 5xx here just causes
    // Razorpay to redeliver the same event on a schedule we don't control.
    return res.status(200).json({ received: true, note: "logged server error" });
  }
});

/* ---------------- Manual bank transfer: client reports, staff confirms ---------------- */

app.post("/api/client/contracts/:contractId/payments/bank-transfer", async (req, res) => {
  try {
    const access = await requireClientContractOwner(req, res, req.params.contractId);
    if (!access) return;

    const {
      invoice_id, bank_account_id, amount_received, currency,
      transaction_reference, payment_date, receipt_url, notes,
    } = req.body || {};

    if (!amount_received || !transaction_reference) {
      return res.status(400).json({ message: "Amount and transaction reference are required." });
    }

    let receivedAccountLabel = null;
    if (bank_account_id) {
      const bankResult = await pool.query(
        `SELECT account_label FROM company_bank_accounts WHERE id = $1`,
        [bank_account_id]
      );
      receivedAccountLabel = bankResult.rows[0]?.account_label || null;
    }

    const result = await pool.query(
      `INSERT INTO client_contract_payments
        (contract_id, invoice_id, bank_account_id, payment_source, payment_status, payment_method,
         amount_received, currency, received_account, transaction_reference, payment_date, receipt_url, notes)
       VALUES ($1, $2, $3, 'bank_transfer', 'Pending Confirmation', 'Bank Transfer',
               $4, $5, $6, $7, COALESCE($8, NOW()), $9, $10)
       RETURNING *`,
      [access.contract.id, invoice_id || null, bank_account_id || null, amount_received,
       currency || "INR", receivedAccountLabel, transaction_reference,
       payment_date || null, receipt_url || null, notes || null]
    );

    await pool.query(
      `INSERT INTO client_contract_activity
        (contract_id, activity_type, title, description, actor_name, actor_role, metadata)
       VALUES ($1, 'payment_reported', 'Bank transfer reported', $2, $3, 'client', $4::jsonb)`,
      [
        access.contract.id,
        `Client reported a bank transfer of ${currency || "INR"} ${amount_received}, awaiting confirmation.`,
        access.user.full_name || access.user.email,
        JSON.stringify({ payment_id: result.rows[0].id, invoice_id: invoice_id || null }),
      ]
    );

    await notifyAdmins(access.contract.id, {
      type: "payment",
      title: "Bank transfer reported — needs confirmation",
      message: `${access.user.full_name || access.user.email} reported a bank transfer of ${currency || "INR"} ${amount_received}.`,
      metadata: { payment_id: result.rows[0].id },
    });

    return res.status(201).json({ payment: result.rows[0] });
  } catch (err) {
    console.error("[BANK TRANSFER REPORT]", err);
    return res.status(500).json({ message: "Failed to report bank transfer.", error: err.message });
  }
});

/* Staff: confirm or reject a reported bank transfer (or any pending payment). */
app.put("/api/admin/client-contracts/:contractId/payments/:paymentId/confirm", async (req, res) => {
  try {
    const actor = await requireContractManager(req, res);
    if (!actor) return;

    const contractId = Number(req.params.contractId);
    const paymentId = Number(req.params.paymentId);
    const { action, notes } = req.body || {};
    if (!["confirm", "reject"].includes(action)) {
      return res.status(400).json({ message: "action must be 'confirm' or 'reject'." });
    }

    const paymentResult = await pool.query(
      `SELECT * FROM client_contract_payments WHERE id = $1 AND contract_id = $2 LIMIT 1`,
      [paymentId, contractId]
    );
    const payment = paymentResult.rows[0];
    if (!payment) return res.status(404).json({ message: "Payment not found." });

    const newStatus = action === "confirm" ? "Received" : "Rejected";
    const updated = await pool.query(
      `UPDATE client_contract_payments
       SET payment_status = $1, notes = COALESCE($2, notes)
       WHERE id = $3
       RETURNING *`,
      [newStatus, notes || null, paymentId]
    );

    if (action === "confirm" && payment.invoice_id) {
      await pool.query(
        `UPDATE client_contract_invoices
         SET amount_paid = amount_paid + $1,
             status = CASE WHEN amount_paid + $1 >= total_amount THEN 'Paid' ELSE status END
         WHERE id = $2`,
        [payment.amount_received, payment.invoice_id]
      );
    }

    await pool.query(
      `INSERT INTO client_contract_activity
        (contract_id, activity_type, title, description, actor_user_id, actor_name, actor_role, metadata)
       VALUES ($1, 'payment_confirmed', $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        contractId,
        action === "confirm" ? "Payment confirmed" : "Payment rejected",
        `Staff ${action === "confirm" ? "confirmed" : "rejected"} a reported payment.`,
        actor.id, actor.full_name || actor.email, actor.role,
        JSON.stringify({ payment_id: paymentId }),
      ]
    );

    return res.json({ payment: updated.rows[0] });
  } catch (err) {
    console.error("[ADMIN PAYMENT CONFIRM]", err);
    return res.status(500).json({ message: "Failed to update payment.", error: err.message });
  }
});


/* ============================================================
   TENDER CUSTOMER TRACKING MODULE
   Keeps the Excel-backed prospect workflow isolated from the main
   CRM business routes. trackingserver.js exports an Express router.
   ============================================================ */
try {
  const { createTenderTrackingRouter } = require("./trackingserver");
  app.use("/api/tender", createTenderTrackingRouter({
    pool,
    requireAuthenticatedUser,
    isContractManager,
  }));
  console.log("Tender customer tracking routes registered: /api/tender/*");
} catch (trackingErr) {
  console.error("[TENDER TRACKING] Failed to register trackingserver:", trackingErr);
}

/* ============================================================
   AI COMPANY RESEARCH MODULE
   Given a selected customer or tender customer, researches them
   against pricing_catalog + company_profile via the LLM, saves the
   result to company_research, and logs a row to an Excel file.
   researchserver.js exports an Express router.
   ============================================================ */
try {
  const { createResearchRouter } = require("./researchserver");
  app.use("/api/research", createResearchRouter({
    pool,
    requireAuthenticatedUser,
    isContractManager,
  }));
  console.log("AI company research routes registered: /api/research/*");
} catch (researchErr) {
  console.error("[AI RESEARCH] Failed to register researchserver:", researchErr);
}

/* ============================================================
   EMAIL AUTOMATION TRACKING ADAPTER
   Reads EmailAutomation output files without modifying the
   existing Python automation project.
   ============================================================ */
try {
  const emailTrackingModulePath = path.join(__dirname, "emailtrackingserver.js");
  const { createEmailTrackingRouter } = require(emailTrackingModulePath);
  app.use("/api/email-tracking", createEmailTrackingRouter({
    requireAuthenticatedUser,
    pool,
  }));
  console.log("EmailAutomation tracking routes registered: /api/email-tracking/*");

  // The legacy tracking poller alters the communications table with
  // PostgreSQL-specific ALTER TABLE syntax. The MySQL backend uses the
  // MySQL schema directly, so do not start that legacy schema-mutating
  // poller here. Email tracking API reads remain available, and the
  // emailtrackingserver module already falls back when tracking columns
  // are not present.
  if (DB_DIALECT !== "mysql") {
    startTrackingEventsPoller(pool);
  } else {
    console.log("[EMAIL TRACKING] MySQL mode: legacy track.php schema poller disabled");
  }
} catch (emailTrackingErr) {
  console.error("[EMAIL TRACKING] Failed to register emailtrackingserver:", emailTrackingErr);
  console.error("[EMAIL TRACKING] Expected adapter:", path.join(__dirname, "emailtrackingserver.js"));
}

/* ============================================================
   END CLIENT USER CONTRACT WORKSPACE
   ============================================================ */
const { createDigitizationRouter } = require("./digitizationserver");
// ...
app.use("/api/digitization", createDigitizationRouter({
  pool, requireAuthenticatedUser, isContractManager,
  moduleKey: "digitization", tablePrefix: "digitization",
  dataDirOverride: path.join(__dirname, "..", "nova-crm-project", "data", "digitization"),
}));
console.log("Scanning & Digitization routes registered: /api/digitization/*");

// SAM Data > Software / Application uses the exact same three source engines,
// but stores its results separately so application and scanning opportunities
// never get mixed. The master Excel export combines both modules.
app.use("/api/software", createDigitizationRouter({
  pool, requireAuthenticatedUser, isContractManager,
  moduleKey: "software", tablePrefix: "software",
  dataDirOverride: path.join(__dirname, "..", "nova-crm-project", "data", "digitization"),
}));
console.log("Software / Application routes registered: /api/software/*");




const PORT = process.env.PORT || 5000;

(async () => {
  // MySQL runtime tables must exist before the first browser request.
  // This prevents /api/admin/notifications from racing the async schema creation.
  await paymentsSchemaReady;

  app.listen(PORT, () => {
    appendRuntimeLog("INFO", `Server running on port ${PORT}`);
    console.log(`Server running on port ${PORT}`);
    if (mailTransporter) {
      console.log(`SMTP proposal send-and-track enabled (sending as ${EMAIL_USER} via ${SMTP_SERVER}:${SMTP_PORT}, links use ${PUBLIC_BASE_URL})`);
    }
    if (EMAIL_USER && IMAP_SERVER) {
      console.log(`Email receive enabled for ${EMAIL_USER} via ${IMAP_SERVER}:${IMAP_PORT} (polling every ${EMAIL_POLL_INTERVAL_MS / 1000}s)`);
    }
  });
})().catch((err) => {
  console.error("[STARTUP] Failed to initialize MySQL runtime schema:", err);
  process.exit(1);
});