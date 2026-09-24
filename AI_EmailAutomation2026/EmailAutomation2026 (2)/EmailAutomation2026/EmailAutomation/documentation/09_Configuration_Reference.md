# 09 — Configuration Reference

Every setting in the `Config` class (from `Scripts/RUN_CAMPAIGN.py`), what it does, and how to change it. The standalone scripts keep their own `Config` — mirror the values there.

---

## 1. Email & server credentials

| Setting | Type of Default | Meaning |
|---------|---------|---------|
| `SENDER_EMAIL` | `"pradeep@orbitavanytech.com"` | From address (also used for SMTP/IMAP login and as `MAIL FROM` in validation) |
| `SENDER_PASSWORD` | `"Prad@2026"` | SMTP/IMAP password |
| `SMTP_SERVER` | `"s13429.bom1.stableserver.net"` | Outgoing mail server |
| `SMTP_PORT` | `465` | SSL SMTP port |
| `IMAP_SERVER` | `"s13429.bom1.stableserver.net"` | Incoming mail server |
| `IMAP_PORT` | `993` | SSL IMAP port |

## 9.2 File paths & input

| Setting | Default | Meaning |
|---------|---------|---------|
| `EXCEL_FILE_PATH` | full lead Excel path | File the campaign reads leads from |
| `SHEET_NAME` | `Sheet1` | Sheet containing the leads |
| `TRACKER_FILE` | full path | Master tracker workbook |
| `DUPLICATES_FILE` | full path | `sent_emails_log.json` (duplicate guard) |
| `EVENTS_JSON_FILE` | full path | `tracking_events.json` (event archive) |
| `SENT_BOUNCED_REPORT_FILE` | full path | Auto-refreshed report workbook |

## 9.3 Tracking

| Setting | Default | Meaning |
|---------|---------|---------|
| `TRACKING_PORT` | `6060` | TCP port for the embedded Flask tracker |
| `TRACKING_SCRIPT_URL` | `https://orbitavanytech.com/track.php` | Live PHP endpoint that email pixels/clicks call |

## 9.4 Email copy

| Setting | Default | Meaning |
|---------|---------|---------|
| `EMAIL_SUBJECT` | `"Exploring Collaboration Opportunity with {company_name}"` | First-email subject (placeholders filled per lead) |
| `FOLLOWUP_SUBJECT` | `"Following up: Collaboration Opportunity with {company_name}"` | Reminder subject |

## 9.5 Sending pace & guardrails

| Setting | Default | Meaning |
|---------|---------|---------|
| `EMAIL_DELAY_MIN / MAX` | `2` / `2` | Random delay (seconds) between sends |
| `MAX_EMAILS_PER_RUN` | `100` | Cap per batch |
| `AUTO_CONTINUE` | `True` | Continue automatically in batches until all done |
| `BATCH_INTERVAL_MINUTES` | `10` | Pause with checks between batches |
| `SKIP_ALREADY_SENT` | `True` | Skip emails present in `sent_emails_log.json`; set `False` to allow re-sends |

## 9.6 Validation

| Setting | Default | Meaning |
|---------|---------|---------|
| `VALIDATE_EMAILS` | `True` | Run 4-layer validation before send; `False` = send everything |
| `SMTP_CHECK_TIMEOUT` | `6` | Seconds to wait on each mailbox SMTP probe |

## 9.7 Embedded constants (not in Config but worth knowing)

| Constant | Value | Purpose |
|----------|-------|---------|
| `EVENTS_ACCESS_KEY` | `"orbitavanya2026"` | Key protecting `/events`; must match PHP `SECRET_KEY` + `sync_tracking_events.py` `key=...` |
| `EVENTS_LOG` / `MAX_EVENTS_LOG_SIZE` | in-memory list / `5000` | In-memory event buffer served by local `/events` |
| `PIXEL_BYTES` | 1×1 transparent GIF | The tracked image |
| `TRACKING_PORT` | `6060` | server port (same as above) |
| `PENDING_FLUSH_SIZE` | `10` | records buffered before an Excel write batch |
| `DEFAULT_HEADERS` / `FAKE_HEADERS` | 25 / 27 headers | Excel column definitions |
| `DISPOSABLE_DOMAINS` | ~31 domains | temp-mail blocklist |
| `GOOGLE_IP_RANGES` | prefix tuple | prevents crawler pseudo-opens |
| `BRAND_PROTECTED_TERMS` | brand/name/contact list | terms protected from translation |

---

## 9.8 Where to edit

| File | Editing |
|------|------------------|
| `Scripts/RUN_CAMPAIGN.py` | full `Config` class (lines ~81–151) |
| `Scripts/check_replies_and_reminders.py` | `Config` class (lines ~74–100) |
| `Scripts/sync_tracking_events.py` | top constants `TRACKING_URL`, `TRACKER_FILE`, `EVENTS_JSON_FILE`, `SYNC_INTERVAL` |
| `Scripts/email_tracker_server.py` | `TRACKER_FILE`, `LOG_FILE` at top |
| `Server/track.php` | `$LOG_FILE`, `$SECRET_KEY` |
| `Templates/portfolio_tracking_snippet.html` | `TRACKING_SERVER` constant |

## 9.9 Secrets & hygiene warnings

- The sender password is stored in plaintext in the scripts. Restrict access to the repo with team credentials; consider `.env`-style injection for larger deployments.
- The shared `SECRET_KEY`/`EVENTS_ACCESS_KEY` controls access to the events feed — rotate if the repo becomes shared.