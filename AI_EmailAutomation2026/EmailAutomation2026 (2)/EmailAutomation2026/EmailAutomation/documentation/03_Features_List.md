# 03 — Features List

A complete list of features implemented in the OrbitAvanya Email Automation System. Each is tagged with where it lives.

---

## A. Email Sending

| # | Feature | Description | Where |
|---|---------|-------------|-------|
| 1 | **Personalized HTML emails** | Each email fills `{{CEO_Name}}` and `{{Company_Name}}` from the lead Excel row | `RUN_CAMPAIGN.py`, `Templates/*.html` |
| 2 | **Templates** | First-contact (`Email_Template_final_1.html`) and follow-up (`Followup_template.html`) templates | `Templates/` |
| 3 | **Reused SMTP connection** | One logged-in SMTP session reused across sends (much faster); auto-reconnects and retries once if the server drops it | `_get_smtp() / _close_smtp()` |
| 4 | **Fully-formed RFC email headers** | `Message-ID`, `Date`, `List-Unsubscribe` (+ One-Click Post), `X-Mailer`, `X-Priority` — good deliverability hygiene | `send_email()` |
| 5 | **Plain-text + HTML multipart** | Recipients who disable HTML still get a friendly text version | `MIMEMultipart("alternative")` |
| 6 | **Random delay between sends** | `EMAIL_DELAY_MIN/MAX` in seconds (default 2) to look human and protect reputation | `run_campaign()` |
| 7 | **Batch limit** | `MAX_EMAILS_PER_RUN` stops each run (default 100) | `run_campaign()` |
| 8 | **AUTO-CONTINUE batches** | Automatically pauses `BATCH_INTERVAL_MINUTES`, runs reply/bounce checks, then resumes until all leads are processed | `run_campaign()` |
| 9 | **Duplicate protection** | Emails already in `sent_emails_log.json` are skipped on later runs (optional toggle) | `DuplicateTracker` |
| 10 | **Failure recording** | Failed sends are stored with the error message (`Send Error` column) | `save_email_record()` |

## B. Email Validation (FREE, no paid API)

| # | Feature | Where |
|---|---------|-------|
| 11 | **Syntax check** — regex validates the format | `_syntax_ok()` |
| 12 | **Disposable-domain blocklist** — 30+ temp-mail providers blocked | `DISPOSABLE_DOMAINS` |
| 13 | **MX record check** — domain must have a mail server (`dnspython`) | `_has_mx()` |
| 14 | **SMTP mailbox probe** — connects to the recipient's own mail server and asks via `MAIL FROM`/`RCPT TO` (never sends). Retries greylisting; only a consistent 5xx marks the mailbox fake | `_smtp_mailbox_check()` |
| 15 | **Unverifiable = still send** — if the server didn't answer (`unknown`), the email is sent anyway | `validate_email()` |
| 16 | **Fake emails stored for review** — full record saved to the `Fake CEO Email` sheet with reason; updates the same row if re-found | `save_fake_email_record()`, `flush_saved_records()` |

## C. Tracking (open / click / visit / time-on-site / location)

| # | Feature | Where |
|---|---------|-------|
| 17 | **Invisible 1x1 tracking pixel** injected before `</body>` | `inject_pixel()` / `build_tracking_pixel()` |
| 18 | **Open tracking** → `Email Open Status = Opened`, first-open timestamp, open count | `update_open_status()` |
| 19 | **Click tracking** — every orbitavanya.com link rewritten into an `action=click` redirect | `wrap_links_with_tracking()` |
| 20 | **Real location on click** — country/city/timezone resolved from the client's public IP (Cloudflare-aware header parsing) | `get_location_from_ip()` |
| 21 | **Google-proxy IP filtering** — Google's crawler ranges aren't stored as "opens" | `GOOGLE_IP_RANGES`, `is_google_proxy_ip()` |
| 22 | **Website-visit landing page** — branded "Taking you to our website…" page from `/visit` | `visit_page()` |
| 23 | **Visit count + timestamps** — `Website Visits`, `Last Visit At` | `update_website_visit()` |
| 24 | **Time-on-website** — JS beacons (`/visit-heartbeat` + `/visit-end`) via `navigator.sendBeacon` accumulate `Total Time on Website` (min / sec format) | `visit_heartbeat()`, `visit_end()` |
| 25 | **Location beacon** — "View this email in your browser" hidden link (`action=locate`) captures real IP + location | `build_location_beacon()` |
| 26 | **PHP production endpoint** — fully functional `track.php` backend on cPanel: `track`, `click`, `visit`, `visit-end`, `locate`, `events`, `status` | `Server/track.php` |
| 27 | **Cloudflare-tunnel support** — auto-download + launch `cloudflared` for a local public URL; named-tunnel option for a permanent domain | `get_cloudflared()`, `start_tunnel()`, `start_named_tunnel()` |
| 28 | **Standalone Flask tracker** — original track-local server (port 5050) for development | `email_tracker_server.py` |

## D. Replies & Bounces (IMAP)

| # | Feature | Where |
|---|---------|-------|
| 29 | **Reply detection** — scans IMAP for senders seen in the tracker; marks `Reply Received = Yes`, date + subject; one per lead | `check_replies()` |
| 30 | **Bounce detection** — recognizes mailer-daemon / delivery-failure senders and subjects, extracts the original recipient from the body, marks `Bounced`, copies row to the Bounced sheet | `check_replies()` |
| 31 | **Rolling inbox window** — only scans the last 30 days (fast even with huge inboxes) | `mail.search(... SINCE ...)` |
| 32 | **Never double-count** — already-replied/already-bounced leads are skipped | `check_replies()` |

## E. Follow-up Reminders

| # | Feature | Where |
|---|---------|-------|
| 33 | **Automatic due reminders** — `Reminder Due = sent date + 2 days` | `save_email_record()` |
| 34 | **Reminders sent to non-responders only** — skips leads with a reply, bounced leads, and already-reminded | `send_due_reminders()` |
| 35 | **Location-aware reminder language** — uses real detected location (click) → domain lookup → default language | `send_due_reminders()` |
| 36 | **Runs in both modes** — inside `RUN_CAMPAIGN.py` idle loop and as a standalone script | both scripts |
| 37 | **FOLLOWUP_SUBJECT** — dedicated subject line for reminders | `Config` |

## F. Multilingual & Localization

| # | Feature | Where |
|---|---------|-------|
| 38 | **30+ language mapping** — country → language code table | `COUNTRY_LANGUAGE` |
| 39 | **India regional languages** — city-level map (`Pune→Marathi`, `Chennai→Tamil`, etc.) and state fallback | `INDIA_CITY_LANGUAGE`, `INDIA_STATE_LANGUAGE` |
| 40 | **Auto-detect lead location from email domain** — resolves domain IP → geolocation | `detect_client_location_from_domain()` |
| 41 | **Sender-location default** | `detect_sender_location()` |
| 42 | **HTML body translation** — every visible text node via BeautifulSoup; HTML structure preserved | `translate_html_body()` |
| 43 | **Brand/name protection** — company name, CEO name, phone, email swapped to placeholders before translation, restored after | `_protect_terms()` / `_restore_terms()` / `translate_text_protected()` |
| 44 | **Translate-in-email button** — for non-English countries the **English** email includes a "🌐 View in **Language**" Google-Translate banner | `build_translate_banner()` |
| 45 | **Translated visit page** — `/visit` offers visitors a "View in your language" link based on their IP | `visit_page()` |
| 46 | **Language recorded in Excel** — `Email Sent In Language` column | `save_email_record()` |

## G. Excel Master Tracker & Reporting

| # | Feature | Where |
|---|---------|-------|
| 47 | **Color-coded statuses** — green = Sent / Opened / Replied; red = Failed / Bounced / Clicked | `_style_send_status()`, `update_open_status()` |
| 48 | **Multiple auto-created sheets** — Current Sent, Total Sent, Success, Bounced, Summary, Fake CEO Email | Section 7 |
| 49 | **Append-only master** — Total Sent keeps every run | `flush_saved_records()` |
| 50 | **15-day pruning of Current Sent** | `reset_current_sheet()` |
| 51 | **Updating instead of duplicating** — existing email rows are updated in place | `flush_saved_records()` |
| 52 | **Cumulative Summary sheet** — totals across all runs + per-date breakdown | `update_campaign_summary()` |
| 53 | **Sent/Bounced/Summary report** — separate auto-refreshed workbook | `regenerate_sent_bounced_report()` |
| 54 | **Batch flushing** — Excel written in batches (fast) | `PENDING_FLUSH_SIZE`, `flush_saved_records()` |

## H. Automation Convenience

| # | Feature | Where |
|---|---------|-------|
| 55 | **Auto pip-install** missing libraries at first run | `install()` |
| 56 | **Auto tunnel download** (`cloudflared`) | `get_cloudflared()` |
| 57 | **5-step console wizard** feedback (`[x/5]`) | entry point |
| 58 | **tqdm progress bars** | `run_campaign()` |
| 59 | **Keep-alive loop** — replies every 5 min, reminders every 10 min | main block |
| 60 | **Event log JSON** — tracking events synced in a portable file | `log_tracking_event()` / `/events` |
| 61 | **Campaign log files** — timestamped log per run | `Notebooks/...` logging setup, `email_campaign_logs/` |
| 62 | **Health checks** — `/status` endpoint on both Flask & PHP | `status()` |

## Summary

- **~60 features** across 8 categories (sending, validation, tracking, replies, reminders, localization, Excel reporting, automation).
- Implemented in **4 Python scripts**, **3 PHP variants**, **3 HTML templates + 1 JS snippet**, entirely on free/open-source tech.