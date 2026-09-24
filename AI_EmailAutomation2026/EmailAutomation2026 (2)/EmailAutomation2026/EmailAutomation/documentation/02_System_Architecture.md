# 02 — System Architecture

This document explains how all the pieces of the OrbitAvanya Email Automation System fit together, how data flows, and how the deployment looks.

## 1. High-Level Architecture

```
                         ┌──────────────────────────────────────────────┐
                         │            YOUR COMPUTER (Windows)          │
                         │                                              │
   Lead Excel            │   ┌─────────────────────────────┐            │
   (Lead Gen_...xlsx) ──►│   │   RUN_CAMPAIGN.py           │            │
                         │   │  (All-in-one launcher)      │            │
                         │   │  · reads leads (pandas)     │            │
                         │   │  · validates emails (4 layers│           │
                         │   │  · builds HTML + pixel      │            │
                         │   │  · sends via SMTP (465)     │            │
                         │   └──────────┬──────────────────┘            │
                         │              │                               │
                         │              │ sends email with:            │
                         │              │   - 1x1 tracking pixel <img>  │
                         │              │   - tracked click links       │
                         │              │   - "view in browser" beacon  │
                         └──────────────┼───────────────────────────────┘
                                        ▼
                    ┌───────────────────────────────────────┐
                    │         RECIPIENT'S EMAIL CLIENT      │
                    │  (opens email → loads pixel / clicks) │
                    └───────┬───────────────┬───────────────┘
                            │               │
              open / locate │               │ click (redirect)
                            ▼               ▼
        ┌─────────────────────────────────────────────┐
        │   PHP TRACKING BACKEND  (cPanel hosting)    │
        │   https://orbitavanytech.com/track.php      │
        │   actions: track, click, visit, visit-end,  │
        │   locate, events, status                    │
        │   writes to tracking_log.json on the server │
        └──────────────────────┬──────────────────────┘
                               │
                    sync_tracking_events.py
                    (polls /events every 60 s)
                               │
                               ▼
        ┌─────────────────────────────────────────────┐
        │  Email_Tracking_NEW.xlsx  (master tracker)  │
        │  Total Sent | Current Sent | Success |      │
        │  Bounced | Summary | Fake CEO Email         │
        └─────────────────────────────────────────────┘
                               ▲
                               │  direct Excel writes (same machine)
        ┌──────────────────────┴──────────────────────┐
        │  RUN_CAMPAIGN.py  (opens, clicks, visits)   │
        │  check_replies_and_reminders.py (replies,   │
        │  bounces, reminders)                        │
        └─────────────────────────────────────────────┘
```

## 2. The Three Tracking Paths

The system deliberately supports **two tracking backends** so development and production never block each other:

### Path A — Local Flask server (development / fallback)
- `RUN_CAMPAIGN.py` embeds a **Flask app** on port `6060` with routes `/track`, `/click`, `/visit`, `/visit-heartbeat`, `/visit-end`, `/locate`, `/status`, `/events`.
- It can be exposed publicly with **cloudflared** (`cloudflared tunnel --url http://localhost:6060`) for a temporary `*.trycloudflare.com` URL.
- A named tunnel (fixed domain) option exists via `start_named_tunnel()` (requires one-time `cloudflared` setup).
- This path updates the Excel tracker **directly** (via `openpyxl` with a thread lock).

### Path B — PHP endpoint on cPanel (production, currently active)
- `Server/track.php` (also `deploy_tracker.php`) is uploaded to `public_html/track.php` on `orbitavanytech.com`.
- Emails embed URLs to `https://orbitavanytech.com/track.php?action=track&email=...&company=...`.
- PHP writes events to `tracking_log.json` on the server and geolocates via `ip-api.com`.
- `sync_tracking_events.py` polls `.../track.php?action=events&key=orbitavanya2026` every 60 seconds and applies new events to the Excel tracker.

> Why both? The PHP endpoint survives your laptop being offline (recipients open emails anytime), while the Flask path gives instant local writes during development. `RUN_CAMPAIGN.py`'s idle loop uses the Flask app when `TRACKING_SCRIPT_URL` is not set; with the PHP URL set, `sync_tracking_events.py` is the sync mechanism.

## 3. Module Responsibilities

| Module | Responsibility |
|--------|----------------|
| `RUN_CAMPAIGN.py` | Everything: config, validation, sending, embedded Flask tracker, Excel writes, reply/bounce checking, reminders, summaries |
| `email_tracker_server.py` | Standalone open-tracking server (original design; port 5050; kept for reference/dev) |
| `check_replies_and_reminders.py` | Runs the reply/bounce + reminder logic continuously in its own terminal (no sending) |
| `sync_tracking_events.py` | Pulls PHP-side events into the Excel tracker every 60 s |
| `Server/*.php` | Public tracking backend (pixel, click redirect, visit page, time-on-site beacon, location beacon, events API) |
| `Templates/*.html` | Email bodies (with `{{CEO_Name}}` / `{{Company_Name}}` placeholders) + portfolio JS snippet |
| `Data/*` | Lead lists, master tracker, JSON logs, reports |
| `Tools/` | `cloudflared.exe`, `ngrok.exe` |

## 4. Data Flow — From Lead to Report

1. **Read** — `pd.read_excel(Config.EXCEL_FILE_PATH)` loads the lead sheet.
2. **Enrich (auto)** — if a lead has no Country/City, the company email domain is resolved to an IP and geolocated; sender location is used as the final fallback.
3. **Validate** — 4-layer email check (see doc 11). Fake → `Fake CEO Email` sheet, skipped.
4. **Send** — personalization (`CEO Name`, `Company Name`), optional language banner/full translation, pixel + click-wrap injection, SMTP send with a shared connection.
5. **Track** — recipient actions hit the PHP endpoint → events → `sync_tracking_events.py` → Excel (or directly via Flask → Excel).
6. **Watch** — IMAP scans every 5 min → replies (`Reply Received = Yes`) & bounces (`Email Send Status = Bounced`).
7. **Remind** — after 2 days, non-responders get `Followup_template.html` automatically.
8. **Report** — `Sent_Bounced_Report.xlsx` (Summary/Sent/Bounced) rebuilt after every send/reply/bounce/reminder action.

## 5. Concurrency & Data-Safety Design

- `threading.Lock` guards all Excel writes (multiple pixel hits can arrive at once).
- Email records are **queued in memory** and flushed to Excel in **batches of 10** (`PENDING_FLUSH_SIZE`) — the workbook is not saved per-email (performance).
- If Excel is open in another program, `PermissionError` is caught; records stay queued and are retried on the next flush.
- The **"Total Sent" master sheet is append-only** — every run is preserved forever.
- The **"Current Sent" sheet** prunes to the last 15 days automatically.
- Duplicate protection uses `sent_emails_log.json` (a JSON set of already-sent emails).
- `tracking_events.json` records every event in a portable log (mirrors Excel) for auditing.

## 6. Deployment Topology

| Component | Where it runs |
|-----------|---------------|
| Python scripts | Local Windows machine (VS Code terminal) |
| PHP tracker | Shared cPanel hosting (`orbitavanytech.com`, `public_html/track.php`) |
| DNS / domain | `orbitavanytech.com` (already pointed at the cPanel host) |
| Email server | Third-party host `s13429.bom1.stableserver.net` (SMTP 465, IMAP 993) |
| Tunnels (optional dev) | `cloudflared` / `ngrok` locally |

## 7. Configuration & Secrets

Everything that matters is in the `Config` class at the top of `RUN_CAMPAIGN.py`:

- Sender credentials (email, password, SMTP/IMAP hosts & ports)
- Excel input / tracker / log paths
- Tracking port (`6060`) and tracking script URL (`https://orbitavanytech.com/track.php`)
- Subject templates, delays, batch size, auto-continue, validation toggle
- Security key shared with PHP (`orbitavanya2026`) — must match between scripts

Full reference: **09_Configuration_Reference.md**.