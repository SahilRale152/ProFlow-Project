# 05 — Scripts Reference

Detailed reference for every executable in the project. "Entry point" = the command that runs it.

---

## 1. `Scripts/RUN_CAMPAIGN.py` ⭐ **MAIN LAUNCHER**

- **Purpose:** Run an entire campaign from one file — install libraries, download tunnel, start tracking server, set tracking URL, validate emails, send all emails, track replies, send reminders, update reports.
- **Entry point:** `python Scripts/RUN_CAMPAIGN.py`
- **Depends on:** `flask`, `openpyxl`, `pandas`, `tqdm`, `requests`, `deep-translator`, `beautifulsoup4`, `dnspython` (auto-installed).
- **In-file sections** (11 total):

| Section | Content |
|---------|---------|
| 1 | Auto-install libraries |
| 2 | `Config` class (credentials, paths, delays, tracking) |
| 2b | `regenerate_sent_bounced_report()` — rebuilds the report workbook |
| 3 | `get_cloudflared()` — download tunnel binary |
| 4 | Flask app (routes `/track`, `/click`, `/visit`, `/visit-heartbeat`, `/visit-end`, `/locate`, `/status`, `/events`), geolocation + language helpers embedded |
| 5 | `start_tunnel()` / `start_named_tunnel()` |
| 6 | `build_tracking_pixel()`, `inject_pixel()`, `wrap_links_with_tracking()`, `build_translate_banner()`, `send_email()`, SMTP connection reuse |
| 6b | Email validation (syntax → disposable → MX → SMTP probe) |
| 7 | Excel save helpers (queued batching, `Fake CEO Email` sheet, `Total Sent`/`Current Sent` updates) + `update_campaign_summary()` |
| 8 | Reply & reminder logic (`check_replies()`, `send_due_reminders()`) |
| 9 | `DuplicateTracker` (JSON-backed) |
| 10 | `run_campaign()` main flow with tqdm + AUTO-CONTINUE + check loops |
| 11 | `if __name__ == "__main__"` — orchestrates everything, then the keep-alive loop |

---

## 2. `Scripts/check_replies_and_reminders.py` — STANDALONE WATCHER

- **Practical:** Runs forever, every few minutes checking the inbox for replies and bounces (IMAP) and sending due follow-up reminders.
- **Entry point:** `python Scripts\check_replies_and_reminders.py`
- **Depends on:** `openpyxl`, `requests`, `deep-translator`, `beautifulsoup4` (auto-installed).
- **Config:** own `Config` class — **must mirror** `RUN_CAMPAIGN.py` path.
- **Intervals:** reply check every 60 s, reminder check every 100 s (see `REPLY_CHECK_INTERVAL` / `REMINDER_CHECK_INTERVAL`), main loop tick 30 s.
- **Notes on the dev loop:** in development it runs an immediate check on start, then loops.

> ⚠️ It reuses `send_email()` internally to send reminders, so the SMTP/IMAP/Excel settings all come from its own `Config`.

---

## 3. `Scripts/sync_tracking_events.py` — PHP EVENT SYNC

- **Practical:** Polls the PHP endpoint `.../track.php?action=events&key=orbitavanya2026` every 60 seconds and applies any new tracking events to `Email_Tracking_NEW.xlsx`.
- **Entry point:** `python Scripts\sync_tracking_events.py`
- **Handles event types:** `open` (pixel), `click` (link click + location), `visit_start` (websites visit), `visit_end` (time on site), `auto_followup` (reminder language).
- **Safety:** keeps a **set of processed event IDs** in memory so a restarted sync never double-applies; writes also to `tracking_events.json`.
- **Config (top of file):** `TRACKING_URL`, `TRACKER_FILE`, `EVENTS_JSON_FILE`, `SYNC_INTERVAL`.

---

## 4. `Scripts/email_tracker_server.py` — STANDALONE FLASK TRACKER (dev/legacy)

- **Purpose:** Serve the 1×1 tracking pixel on port **5050** and update `Email_Tracking_NEW.xlsx` on each open. The original design when using ngrok.
- **Entry point:** `python Scripts\email_tracker_server.py`
- **Expose:** `ngrok http 5050` → paste URL into the notebook `Config.TRACKING_BASE_URL`.
- **Endpoints:** `/track` (pixel → updates Excel, logs `open_tracking.log`), `/status` (health).
- **Engine:** writes `Email Open Status`, `Email Opened At`, `Open Count` columns.
- **Status:** superseded by the PHP backend for production, but kept for reference/tests.

---

## 5. `Server/*.php` — PUBLIC TRACKING BACKEND

Three variants, functionally the same core:

| File | Deployment target | Notes |
|------|-------------------|-------|
| `Server/track.php` | `public_html/track.php` on `orbitavanytech.com` | **Active / recommended.** Query-string `?action=track|click|visit|visit-end|locate|events|status` |
| `Server/deploy_tracker.php` | same — candidate deployment | Nearly identical to `track.php` |
| `Server/index.php` | `track.orbitavanytech.com` (retired subdomain idea) | Uses URL path routing (`/track`, `/click`, …) + `.htaccess` rewrite |
| `Server/htaccess (1).txt` | rewrite rules for the retired subdomain | Not used with `track.php` (plain `?action=` style) |

**Common endpoints:**

| action | URL | Behavior |
|--------|-----|----------|
| `track` | `?action=track&email=…&company=…` | saves `open` event, returns GIF pixel |
| `click` | `?action=click&email=…&company=…&dest=…` | saves `click` + location, 302 → `visit` page |
| `visit` | `?action=visit&email=…&company=…&dest=…` | saves `visit_start`, shows branded page → redirects to `dest` after 1.5 s |
| `visit-end` | `?action=visit-end&email=…&seconds=N` | saves total seconds on page (sendBeacon) |
| `locate` | `?action=locate&email=…&company=…` | saves `locate` + geolocation, redirects to website |
| `events` | `?action=events&key=<SECRET>` | returns all events as JSON |
| `status` | `?action=status` | health check JSON |

**Server-side features:** `get_real_ip()` handles Cloudflare / X-Forwarded-For; `get_location()` uses ip-api.com; `save_event()` appends to `tracking_log.json`; `send_pixel()` returns the 1×1 GIF with no-cache headers.

---

## 6. `Templates/*` — email bodies + portfolio snippet

| File | Use |
|------|-----|
| `Email_Template_final_1.html` | First-contact email. Placeholders `{{CEO_Name}}`, `{{Company_Name}}` |
| `Followup_template.html` | Reminder email. Same placeholders, short follow-up copy |
| `portfolio_tracking_snippet.html` | JS snippet to embed on the **real** portfolio page so the tracker keeps measuring time-on-site even after the /visit handoff. Reads `?lead_email=…&lead_company=…&lead_page=…` (added by the /visit redirect) and beacons `/visit-heartbeat` + `/visit-end` |

---

## 7. `Notebooks/OrbitAvanya_Email_Automation_WITH_TRACKING.ipynb`

- Original exploratory Jupyter notebook (first iteration) — SMTP sending, open-pixel, `DuplicateTracker`, reply checking, `Config`, `TRACKING_SCRIPT_URL` approach.
- Retired in favor of the standalone script pipeline, but documents the original approach and logging (`email_campaign_logs/`).

---

## Process matrix — who talks to Excel

| Script | Reads lead Excel | Writes tracker | Reads IMAP | Sends email | Writes logs |
|--------|------------------|---------------|------------|-------------|-------------|
| `RUN_CAMPAIGN.py` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `check_replies_and_reminders.py` | ❌ | ✅ | ✅ | ✅ (reminders) | ❌ |
| `sync_tracking_events.py` | ❌ | ✅ (events) | ❌ | ❌ | ✅ (`tracking_events.json`) |
| `email_tracker_server.py` | ❌ | ✅ (opens) | ❌ | ❌ | ✅ (`open_tracking.log`) |