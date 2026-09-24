/*
 * OrbitAvanya CRM - EmailAutomation integration adapter
 *
 * IMPORTANT:
 *   This file DOES NOT modify the EmailAutomation Python project.
 *   It only reads the files that EmailAutomation already maintains:
 *     - Email_Tracking_NEW.xlsx
 *     - tracking_events.json
 *     - sent_emails_log.json
 *
 * Configure the folder in .env:
 *   EMAIL_AUTOMATION_DATA_DIR=C:\\path\\to\\EmailAutomation\\Data
 *
 * ALSO shows emails sent directly from the CRM's own Communications
 * "Send email" feature (POST /api/communications/send and
 * /send-email), which write straight to Postgres and never touch the
 * Python project's Excel/JSON files. Those rows are read from the
 * `communications` table (pool is passed in from server.js) and
 * merged in alongside the Excel-based rows, so the Analytics page
 * shows every email sent from either path, not only Python campaign
 * sends. CRM-sent rows show as "Sent" with open/click tracking as
 * "Not tracked", since only the Python pipeline's tracking pixel can
 * report opens/clicks.
 *
 * Mounted by server.js at:
 *   /api/email-tracking/*
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const DEFAULT_DATA_DIR = path.resolve(
  process.env.EMAIL_AUTOMATION_DATA_DIR ||
    path.join(__dirname, "..", "EmailAutomation2026", "EmailAutomation", "Data")
);

const TRACKER_FILE = path.resolve(
  process.env.EMAIL_TRACKING_XLSX || path.join(DEFAULT_DATA_DIR, "Email_Tracking_NEW.xlsx")
);
const EVENTS_FILE = path.resolve(
  process.env.EMAIL_TRACKING_EVENTS_JSON || path.join(DEFAULT_DATA_DIR, "tracking_events.json")
);
const SENT_LOG_FILE = path.resolve(
  process.env.EMAIL_SENT_LOG_JSON || path.join(DEFAULT_DATA_DIR, "sent_emails_log.json")
);

function asString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  const text = asString(value);
  if (!text) return null;

  // DD-MM-YYYY [HH:mm:ss] used by EmailAutomation.
  let m = text.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, dd, mm, yyyy, hh = "00", mi = "00", ss = "00"] = m;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(value) {
  const d = parseDate(value);
  return d ? d.toISOString() : null;
}

function dateKey(value) {
  const d = parseDate(value);
  if (!d) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function displayDate(value) {
  const d = parseDate(value);
  return d ? d.toLocaleString() : asString(value) || "—";
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return [];
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch (err) {
    throw new Error(`Could not read ${path.basename(file)}: ${err.message}`);
  }
}

// Emails sent through the CRM's own Communications "Send email" feature
// (POST /api/communications/send and /send-email) are stored in Postgres
// and never touch the Python EmailAutomation project's files. Read them
// here and shape them exactly like an Excel tracker row (same header
// names) so they can flow through the same normaliseLead()/buildSummary()
// pipeline as Python-sent rows below.
async function fetchCrmSentRows(pool) {
  if (!pool) return [];

  // CRM-sent emails now carry the same tracking pixel/click-wrapping as
  // the Python campaign (see lib/emailTracking.js), and a background
  // poller in server.js writes results onto these tracking_* columns.
  // Fall back to the columns-less query if they don't exist yet (e.g.
  // right after upgrading, before the poller's first run has added
  // them) so Analytics never loses CRM-sent rows entirely.
  const queryWithTracking = `
    SELECT c.subject, c.recipient_email, c.recipient_name, c.sent_at, c.status,
           c.tracking_open_count, c.tracking_opened_at,
           c.tracking_click_count, c.tracking_clicked_at,
           c.tracking_country, c.tracking_city, c.tracking_timezone,
           cu.company_name
    FROM communications c
    LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE c.type = 'email' AND c.direction = 'outbound' AND c.sent_at IS NOT NULL
    ORDER BY c.sent_at DESC
    LIMIT 2000
  `;
  const queryWithoutTracking = `
    SELECT c.subject, c.recipient_email, c.recipient_name, c.sent_at, c.status,
           cu.company_name
    FROM communications c
    LEFT JOIN customers cu ON cu.id = c.customer_id
    WHERE c.type = 'email' AND c.direction = 'outbound' AND c.sent_at IS NOT NULL
    ORDER BY c.sent_at DESC
    LIMIT 2000
  `;

  let result;
  try {
    result = await pool.query(queryWithTracking);
  } catch (err) {
    try {
      result = await pool.query(queryWithoutTracking);
    } catch (fallbackErr) {
      console.error("[EMAIL TRACKING] Failed to load CRM-sent communications:", fallbackErr.message);
      return [];
    }
  }

  return result.rows.map((r) => {
    const openCount = Number(r.tracking_open_count || 0);
    const clickCount = Number(r.tracking_click_count || 0);
    return {
      Company: r.company_name || "—",
      "Contact Person": r.recipient_name || "—",
      Email: r.recipient_email || "—",
      Subject: r.subject || "—",
      "Sent Date": r.sent_at ? new Date(r.sent_at).toISOString() : "",
      "Email Sent In Language": "English",
      "Email Open Status": openCount > 0 ? "Opened" : "Not Opened",
      "Email Opened At": r.tracking_opened_at ? new Date(r.tracking_opened_at).toISOString() : "",
      "Email Open Count": openCount,
      "Link Clicked": clickCount > 0 ? "Yes" : "No",
      "Link Clicked At": r.tracking_clicked_at ? new Date(r.tracking_clicked_at).toISOString() : "",
      "Link Click Count": clickCount,
      "Opened From Country": r.tracking_country || "",
      "Opened From City": r.tracking_city || "",
      "Opened Timezone": r.tracking_timezone || "",
      "Website Visits": 0,
      "Total Time on Website": "0 sec",
      "Last Visit At": "",
      "Email Send Status": r.status === "sent" ? "Sent" : (r.status || "Sent"),
      "Send Error": "",
      "Reply Received": "No",
      "Reply Date": "",
      "Reply Subject": "",
      "Reminder Due": "",
      "Reminder Sent": "No",
      Source: "CRM (Communications)",
    };
  });
}

function getMasterSheet(workbook) {
  for (const name of ["Total Sent", "Current Sent", "Sent"]) {
    if (workbook.Sheets[name]) return workbook.Sheets[name];
  }
  const first = workbook.SheetNames[0];
  return first ? workbook.Sheets[first] : null;
}

function readTrackerRows() {
  if (!fs.existsSync(TRACKER_FILE)) {
    throw new Error(`Email tracking workbook not found: ${TRACKER_FILE}`);
  }

  const workbook = XLSX.readFile(TRACKER_FILE, {
    cellDates: true,
    raw: false,
    defval: null,
  });
  const sheet = getMasterSheet(workbook);
  if (!sheet) return [];

  return XLSX.utils.sheet_to_json(sheet, {
    defval: null,
    raw: false,
  });
}

function normaliseLead(row, index) {
  const sentStatus = asString(row["Email Send Status"]);
  const openStatus = asString(row["Email Open Status"]);
  const clicked = asString(row["Link Clicked"]).toLowerCase() === "yes";
  const replied = asString(row["Reply Received"]).toLowerCase() === "yes";
  const bounced = sentStatus.toLowerCase() === "bounced";
  const sent = sentStatus.toLowerCase() === "sent" || Boolean(asString(row["Sent Date"]));

  return {
    ...row,
    _id: `${asString(row.Email) || "row"}-${index}`,
    Company: asString(row.Company) || "—",
    "Contact Person": asString(row["Contact Person"]) || "—",
    Email: asString(row.Email) || "—",
    Subject: asString(row.Subject) || "—",
    "Sent Date": asString(row["Sent Date"]) || "—",
    "Email Open Status": openStatus || "—",
    "Email Opened At": asString(row["Email Opened At"]) || "—",
    "Email Open Count": asNumber(row["Email Open Count"]),
    "Link Clicked": clicked ? "Yes" : (asString(row["Link Clicked"]) || "No"),
    "Link Clicked At": asString(row["Link Clicked At"]) || "—",
    "Link Click Count": asNumber(row["Link Click Count"]),
    "Opened From Country": asString(row["Opened From Country"]) || "—",
    "Opened From City": asString(row["Opened From City"]) || "—",
    "Opened Timezone": asString(row["Opened Timezone"]) || "—",
    "Website Visits": asNumber(row["Website Visits"]),
    "Total Time on Website": asString(row["Total Time on Website"]) || "0 sec",
    "Last Visit At": asString(row["Last Visit At"]) || "—",
    "Email Send Status": sentStatus || "—",
    "Send Error": asString(row["Send Error"]) || "—",
    "Reply Received": replied ? "Yes" : (asString(row["Reply Received"]) || "No"),
    "Reply Date": asString(row["Reply Date"]) || "—",
    "Reply Subject": asString(row["Reply Subject"]) || "—",
    "Reminder Due": asString(row["Reminder Due"]) || "—",
    "Reminder Sent": asString(row["Reminder Sent"]) || "—",
    _sent: sent,
    _opened: openStatus.toLowerCase() === "opened" || asNumber(row["Email Open Count"]) > 0,
    _clicked: clicked,
    _replied: replied,
    _bounced: bounced,
  };
}

function filterByDays(rows, days) {
  if (!days || days <= 0) return rows;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days + 1);

  return rows.filter((row) => {
    const d = parseDate(row["Sent Date"]);
    return !d || d >= cutoff;
  });
}

function buildSummary(rows) {
  const total = rows.length;
  const sent = rows.filter((r) => r._sent).length;
  const bounced = rows.filter((r) => r._bounced).length;
  const opened = rows.filter((r) => r._opened).length;
  const clicked = rows.filter((r) => r._clicked).length;
  const replied = rows.filter((r) => r._replied).length;
  const visited = rows.filter((r) => r["Website Visits"] > 0).length;

  const rate = (n, denominator) => denominator ? Number(((n / denominator) * 100).toFixed(1)) : 0;

  return {
    total,
    sent,
    bounced,
    opened,
    clicked,
    replied,
    visited,
    openRate: rate(opened, sent),
    clickRate: rate(clicked, sent),
    replyRate: rate(replied, sent),
    bounceRate: rate(bounced, sent),
  };
}

function buildTimeseries(rows, days) {
  const buckets = new Map();
  const add = (dateValue, key) => {
    const keyDate = dateKey(dateValue);
    if (!keyDate) return;
    if (!buckets.has(keyDate)) {
      buckets.set(keyDate, { date: keyDate, Sent: 0, Opens: 0, Clicks: 0, Bounces: 0 });
    }
    buckets.get(keyDate)[key] += 1;
  };

  for (const row of rows) {
    if (row._sent) add(row["Sent Date"], "Sent");
    if (row._opened) add(row["Email Opened At"], "Opens");
    if (row._clicked) add(row["Link Clicked At"], "Clicks");
    if (row._bounced) add(row["Sent Date"], "Bounces");
  }

  let result = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  if (days && days <= 31) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days + 1);
    const all = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const key = `${yyyy}-${mm}-${dd}`;
      all.push(buckets.get(key) || { date: key, Sent: 0, Opens: 0, Clicks: 0, Bounces: 0 });
    }
    result = all;
  }

  return result.map((r) => ({ ...r, label: r.date.slice(5) }));
}

function buildEvents(rows, events, limit = 100) {
  const fromExcel = [];
  for (const row of rows) {
    if (row._opened) {
      fromExcel.push({
        type: "email_opened",
        company: row.Company,
        email: row.Email,
        occurred_at: formatDate(row["Email Opened At"]),
        display_at: displayDate(row["Email Opened At"]),
        count: row["Email Open Count"],
        location: {
          country: row["Opened From Country"],
          city: row["Opened From City"],
          timezone: row["Opened Timezone"],
        },
      });
    }
    if (row._clicked) {
      fromExcel.push({
        type: "link_clicked",
        company: row.Company,
        email: row.Email,
        occurred_at: formatDate(row["Link Clicked At"]),
        display_at: displayDate(row["Link Clicked At"]),
        count: row["Link Click Count"],
      });
    }
    if (row["Website Visits"] > 0) {
      fromExcel.push({
        type: "website_visit",
        company: row.Company,
        email: row.Email,
        occurred_at: formatDate(row["Last Visit At"]),
        display_at: displayDate(row["Last Visit At"]),
        count: row["Website Visits"],
        total_time: row["Total Time on Website"],
      });
    }
    if (row._replied) {
      fromExcel.push({
        type: "reply_received",
        company: row.Company,
        email: row.Email,
        occurred_at: formatDate(row["Reply Date"]),
        display_at: displayDate(row["Reply Date"]),
        subject: row["Reply Subject"],
      });
    }
  }

  const fromJson = events.map((event, index) => ({
    ...event,
    type: event.type || event.event || "event",
    occurred_at: formatDate(
      event.opened_at || event.clicked_at || event.visited_at || event.reply_date || event.timestamp
    ),
    _event_index: index,
  }));

  return [...fromExcel, ...fromJson]
    .sort((a, b) => (b.occurred_at || "").localeCompare(a.occurred_at || ""))
    .slice(0, limit);
}

async function getSnapshot(days, pool) {
  const rawRows = readTrackerRows();
  const crmRows = await fetchCrmSentRows(pool);
  const allRows = [...rawRows, ...crmRows].map(normaliseLead);
  const rows = filterByDays(allRows, days);
  const events = readJson(EVENTS_FILE);
  const sentLog = readJson(SENT_LOG_FILE);

  const summary = buildSummary(rows);
  const timeseries = buildTimeseries(rows, days);
  const columns = rows.length
    ? Object.keys(rows[0]).filter((key) => !key.startsWith("_"))
    : [];

  return {
    data: rows.map(({ _sent, _opened, _clicked, _replied, _bounced, ...row }) => row),
    summary,
    timeseries,
    events: buildEvents(rows, events),
    columns,
    meta: {
      tracker_file: TRACKER_FILE,
      events_file: EVENTS_FILE,
      sent_log_file: SENT_LOG_FILE,
      tracker_exists: fs.existsSync(TRACKER_FILE),
      events_exists: fs.existsSync(EVENTS_FILE),
      sent_log_exists: fs.existsSync(SENT_LOG_FILE),
      tracker_modified_at: fs.existsSync(TRACKER_FILE) ? fs.statSync(TRACKER_FILE).mtime.toISOString() : null,
      events_modified_at: fs.existsSync(EVENTS_FILE) ? fs.statSync(EVENTS_FILE).mtime.toISOString() : null,
      events_count: events.length,
      sent_log_count: sentLog.length,
      generated_at: new Date().toISOString(),
    },
  };
}

function createEmailTrackingRouter({ requireAuthenticatedUser, pool } = {}) {
  const router = express.Router();

  async function guard(req, res, next) {
    if (typeof requireAuthenticatedUser !== "function") return next();
    try {
      const user = await requireAuthenticatedUser(req, res);
      if (!user) return;
      req.emailTrackingUser = user;
      next();
    } catch (err) {
      return res.status(401).json({ message: "Not authenticated." });
    }
  }

  router.get("/status", guard, (req, res) => {
    const stat = (file) => {
      if (!fs.existsSync(file)) return { exists: false, path: file, modified_at: null, age_seconds: null };
      const s = fs.statSync(file);
      return {
        exists: true,
        path: file,
        modified_at: s.mtime.toISOString(),
        age_seconds: Math.max(0, Math.round((Date.now() - s.mtimeMs) / 1000)),
        size_bytes: s.size,
      };
    };

    const tracker = stat(TRACKER_FILE);
    const events = stat(EVENTS_FILE);
    const sentLog = stat(SENT_LOG_FILE);

    return res.json({
      status: tracker.exists ? "ready" : "not_configured",
      tracker,
      events,
      sent_log: sentLog,
      configured_data_dir: DEFAULT_DATA_DIR,
      note: "EmailAutomation is kept separate. This API reads its output files and never edits the Python project.",
    });
  });

  router.get("/live", guard, async (req, res) => {
    try {
      const rawDays = Number(req.query.days || 0);
      const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 3650) : null;
      return res.json(await getSnapshot(days, pool));
    } catch (err) {
      console.error("[EMAIL TRACKING LIVE]", err);
      return res.status(500).json({ message: "Failed to load EmailAutomation tracking data.", error: err.message });
    }
  });

  router.get("/summary", guard, async (req, res) => {
    try {
      const rawDays = Number(req.query.days || 0);
      const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 3650) : null;
      const snapshot = await getSnapshot(days, pool);
      return res.json({ summary: snapshot.summary, timeseries: snapshot.timeseries, meta: snapshot.meta });
    } catch (err) {
      console.error("[EMAIL TRACKING SUMMARY]", err);
      return res.status(500).json({ message: "Failed to load EmailAutomation summary.", error: err.message });
    }
  });

  router.get("/events", guard, async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
      const events = readJson(EVENTS_FILE);
      const crmRows = await fetchCrmSentRows(pool);
      const rows = [...readTrackerRows(), ...crmRows].map(normaliseLead);
      return res.json({ events: buildEvents(rows, events, limit) });
    } catch (err) {
      console.error("[EMAIL TRACKING EVENTS]", err);
      return res.status(500).json({ message: "Failed to load tracking events.", error: err.message });
    }
  });

  router.get("/excel", guard, (req, res) => {
    if (!fs.existsSync(TRACKER_FILE)) {
      return res.status(404).json({ message: "Email tracking workbook not found.", path: TRACKER_FILE });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.download(TRACKER_FILE, path.basename(TRACKER_FILE));
  });

  return router;
}

module.exports = {
  createEmailTrackingRouter,
  getSnapshot,
  TRACKER_FILE,
  EVENTS_FILE,
  SENT_LOG_FILE,
};
