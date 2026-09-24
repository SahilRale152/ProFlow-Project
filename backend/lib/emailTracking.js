/*
 * emailTracking.js
 *
 * Gives emails sent from the CRM's own Communications "Send email"
 * feature (POST /api/communications/send and /send-email) the SAME
 * open/click tracking that the EmailAutomation Python campaign
 * (RUN_CAMPAIGN.py) already has -- using the exact same track.php
 * script hosted on your domain, so nothing new needs to be deployed.
 *
 * Two halves:
 *   1. injectEmailTracking(html, email, company) -- called right before
 *      sendMail(), adds a 1x1 tracking pixel and rewrites any links that
 *      point at your own orbitavanyatech.com domain to route through
 *      track.php first (same regex/behaviour as RUN_CAMPAIGN.py).
 *   2. startTrackingEventsPoller(pool) -- runs continuously in this
 *      Node process (no separate script needed, unlike
 *      sync_tracking_events.py) and polls track.php's event log,
 *      applying "open"/"click" events onto the matching row(s) in the
 *      `communications` table by recipient_email.
 *
 * track.php's parameter scheme (from Server/track.php):
 *   ?action=track&email=...&company=...          -> logs "open", returns pixel
 *   ?action=click&email=...&company=...&dest=...  -> logs "click", redirects
 *   ?action=events&key=...                        -> returns the JSON event log
 *
 * TRACKING_SCRIPT_URL and the events key match RUN_CAMPAIGN.py's Config
 * exactly (TRACKING_SCRIPT_URL, EVENTS_ACCESS_KEY) -- both are already
 * live on your domain, so no server-side deployment is needed for any
 * of this to work.
 */

const TRACKING_SCRIPT_URL = process.env.EMAIL_TRACKING_SCRIPT_URL || "https://orbitavanyatech.com/track.php";
const TRACKING_EVENTS_KEY = process.env.EMAIL_TRACKING_EVENTS_KEY || "orbitavanya2026";
const POLL_INTERVAL_MS = Number(process.env.EMAIL_TRACKING_POLL_MS || 60_000); // 60s, same cadence as sync_tracking_events.py

function buildTrackingPixel(recipientEmail, companyName) {
  const url = `${TRACKING_SCRIPT_URL}?action=track&email=${encodeURIComponent(recipientEmail)}&company=${encodeURIComponent(companyName || "")}`;
  return `<img src="${url}" width="1" height="1" border="0" style="display:block;width:1px;height:1px;" alt="" />`;
}

// Only wraps links that point at your own orbitavanyatech.com domain --
// same restriction RUN_CAMPAIGN.py's wrap_links_with_tracking() uses, so
// arbitrary third-party links (e.g. a client's own site linked in a
// proposal) are never routed through your tracking redirect.
const OWN_DOMAIN_HREF_RE = /href="(https:\/\/(?:[a-zA-Z0-9-]+\.)?orbitavanyatech\.com(?:\/[^"]*)?)"/g;

function wrapLinksWithTracking(html, recipientEmail, companyName) {
  return html.replace(OWN_DOMAIN_HREF_RE, (_match, realUrl) => {
    const trackedUrl =
      `${TRACKING_SCRIPT_URL}?action=click` +
      `&email=${encodeURIComponent(recipientEmail)}` +
      `&company=${encodeURIComponent(companyName || "")}` +
      `&dest=${encodeURIComponent(realUrl)}`;
    return `href="${trackedUrl}"`;
  });
}

/**
 * Returns a NEW html string with the tracking pixel added and own-domain
 * links wrapped for click tracking. Does not mutate the input -- callers
 * should keep the original html for storing in the communications table,
 * and only use the returned value for the actual SMTP send, so what's
 * displayed back in the CRM's own Communications timeline stays clean.
 */
function injectEmailTracking(html, recipientEmail, companyName) {
  if (!recipientEmail) return html;
  const source = String(html || "");
  const pixel = buildTrackingPixel(recipientEmail, companyName);
  const wrapped = wrapLinksWithTracking(source, recipientEmail, companyName);
  const lower = wrapped.toLowerCase();
  if (lower.includes("</body>")) {
    const idx = lower.lastIndexOf("</body>");
    return wrapped.slice(0, idx) + pixel + wrapped.slice(idx);
  }
  return wrapped + pixel;
}

// ---------------------------------------------------------------------
// Poller: applies track.php's open/click events onto `communications`
// ---------------------------------------------------------------------

// In-memory de-dupe so a re-fetched event isn't counted twice while this
// process stays up. Resets on restart -- same acceptable trade-off
// sync_tracking_events.py makes with its own processed-events file,
// just without persisting across restarts.
const processedEventIds = new Set();
const MAX_PROCESSED_IDS = 20_000;

function eventId(evt) {
  return `${evt.type}_${evt.email}_${evt.timestamp}`;
}

async function ensureTrackingColumns(pool) {
  // Idempotent -- safe to call every startup. Adds the columns used to
  // store open/click tracking results directly on the communications
  // table, since CRM-sent emails have no row in Email_Tracking_NEW.xlsx
  // for sync_tracking_events.py to update.
  await pool.query(`
    ALTER TABLE communications
      ADD COLUMN IF NOT EXISTS tracking_open_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tracking_opened_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS tracking_click_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tracking_clicked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS tracking_country TEXT,
      ADD COLUMN IF NOT EXISTS tracking_city TEXT,
      ADD COLUMN IF NOT EXISTS tracking_timezone TEXT
  `);
}

async function applyEvent(pool, evt) {
  const email = String(evt.email || "").trim().toLowerCase();
  if (!email) return;

  // Match the most recent outbound "sent" email to this address -- same
  // one-row-per-email-ish matching sync_tracking_events.py does against
  // the Excel tracker, adapted to "most recent" since the same person
  // can legitimately receive more than one CRM email over time.
  const target = await pool.query(
    `SELECT id FROM communications
     WHERE type = 'email' AND direction = 'outbound'
       AND lower(recipient_email) = $1
     ORDER BY sent_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [email]
  );
  const row = target.rows[0];
  if (!row) return; // not a CRM-sent email (likely a Python-campaign address) -- nothing to update here

  if (evt.type === "open") {
    await pool.query(
      `UPDATE communications
       SET tracking_open_count = tracking_open_count + 1,
           tracking_opened_at = COALESCE(tracking_opened_at, NOW())
       WHERE id = $1`,
      [row.id]
    );
  } else if (evt.type === "click") {
    await pool.query(
      `UPDATE communications
       SET tracking_click_count = tracking_click_count + 1,
           tracking_clicked_at = COALESCE(tracking_clicked_at, NOW()),
           tracking_open_count = GREATEST(tracking_open_count, 1),
           tracking_opened_at = COALESCE(tracking_opened_at, NOW()),
           tracking_country = COALESCE($2, tracking_country),
           tracking_city = COALESCE($3, tracking_city),
           tracking_timezone = COALESCE($4, tracking_timezone)
       WHERE id = $1`,
      [row.id, evt.country || null, evt.city || null, evt.timezone || null]
    );
  }
}

async function pollOnce(pool) {
  const url = `${TRACKING_SCRIPT_URL}?action=events&key=${encodeURIComponent(TRACKING_EVENTS_KEY)}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    throw new Error(`track.php returned HTTP ${res.status}`);
  }
  const events = await res.json();
  if (!Array.isArray(events)) return;

  for (const evt of events) {
    if (evt.type !== "open" && evt.type !== "click") continue;
    const id = eventId(evt);
    if (processedEventIds.has(id)) continue;
    processedEventIds.add(id);
    try {
      await applyEvent(pool, evt);
    } catch (err) {
      console.error("[EMAIL TRACKING POLLER] Failed to apply event:", evt, err.message);
    }
  }

  if (processedEventIds.size > MAX_PROCESSED_IDS) {
    // Cheap bound on memory -- drop the oldest half. Order isn't
    // guaranteed by Set, but this only trades a small chance of a
    // re-counted event for not leaking memory forever.
    const ids = Array.from(processedEventIds);
    processedEventIds.clear();
    for (const keepId of ids.slice(ids.length / 2)) processedEventIds.add(keepId);
  }
}

/**
 * Starts polling track.php for open/click events, applying them onto
 * the `communications` table. Safe to call once at server startup --
 * network or track.php failures are logged and retried on the next
 * tick, never thrown (so they can't crash the CRM server).
 */
function startTrackingEventsPoller(pool) {
  if (!pool) return;

  ensureTrackingColumns(pool).catch((err) => {
    console.error("[EMAIL TRACKING POLLER] Could not add tracking_* columns to communications:", err.message);
  });

  const tick = async () => {
    try {
      await pollOnce(pool);
    } catch (err) {
      console.error("[EMAIL TRACKING POLLER] Poll failed (will retry):", err.message);
    }
  };

  tick(); // run once immediately, then on the interval
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[EMAIL TRACKING POLLER] Polling ${TRACKING_SCRIPT_URL} every ${POLL_INTERVAL_MS / 1000}s`);
}

module.exports = {
  TRACKING_SCRIPT_URL,
  injectEmailTracking,
  startTrackingEventsPoller,
  ensureTrackingColumns,
};
