# 01 — Project Overview

## 1. Problem Statement

Manually sending hundreds of business-development (cold) emails to CEOs and C-level executives is:

- **Slow** — copy/paste + mailbox windows quickly become impossible at scale.
- **No feedback** — you never know who opened, who clicked, or who's interested.
- **High risk of mistakes** — sending to duplicate or fake addresses, forgetting follow-ups.
- **Impossible to track** — no time-based follow-up discipline, no location insight, no bounced detection.

## 2. Solution

**OrbitAvanya Email Automation System** automates the entire outreach lifecycle for **OrbitAvanya Tech LLP**:

1. Reads a bulk lead Excel sheet (pre-scraped company/CEO data).
2. **Validates** every email before sending (no paid API; 4 free layers).
3. Sends a **personalized HTML email** to each valid lead.
4. Attaches **open tracking**, **link-click tracking**, **website-visit tracking**, and **time-on-site** measurement.
5. Sends the email in a preferred or detected language (India gets regional languages; other countries get a "view in your language" button or full translation).
6. Watches the inbox and **flags replies and bounces**.
7. Sends timed **follow-up reminders** automatically to non-responders.
8. Writes everything to a **colour-coded Excel master tracker** + a refreshed report workbook.
9. Runs **hands-free in batches** — after hitting a daily send limit it pauses, checks replies/reminders, then resumes by itself.

## 3. Scope

**In scope**
- Automated bulk email sending via SMTP.
- Multi-layered email validation (0 cost).
- Open / click / visit / time-on-site tracking via an invisible 1x1 pixel + redirects + JS beacons.
- Reply & bounce detection over IMAP.
- Automatic follow-up reminders.
- Duplicate protection and batch/AUTO-CONTINUE sending.
- Localized / multilingual emails (30+ languages).
- Excel-based reporting (tracker + separate report file).

**Out of scope**
- Paid email-deliverability services.
- Full inbound CRM.
- Legal/compliance advisory (data is pre-scraped; sending at scale should follow anti-spam law in the target region).

## 4. Technology Stack

| Component | Tool |
|-----------|------|
| Language | Python 3 |
| Email sending | `smtplib` / SMTP over SSL (port 465) |
| Inbox scans | `imaplib` / IMAP over SSL (port 993) |
| Tracking HTTP | Flask (dev) + **cloudflared** (public URL during dev) |
| Production tracker | **PHP** script hosted on cPanel (`track.php`) |
| Excel write | `openpyxl` (keeps formatting) |
| Excel read / tables | `pandas` |
| Progress | `tqdm` |
| Translation | `deep-translator` (Google Translator), `beautifulsoup4` |
| DNS / MX | `dnspython` |
| HTTP | `requests` |
| Geolocation | `ip-api.com` (free) + `ipinfo.io` (fallback) |
| Tunnels | `cloudflared.exe`, `ngrok.exe` |

## 5. The 5-Step Automated Workflow

Every run of `RUN_CAMPAIGN.py` follows these five printed steps:

| Step | What happens |
|------|--------------|
| 0/5 | Detect the sender machine's real location (used as the default language for leads with no location) |
| 1/5 | Auto-install required Python libraries if missing |
| 2/5 | Download `cloudflared` (free tunnel, no account) if not already present |
| 3/5 | Start the Flask tracking server on port `6060` (background thread) |
| 4/5 | Set the **tracking URL** — production uses the PHP endpoint `https://orbitavanytech.com/track.php` |
| 5/5 | Send all emails (batched, auto-continuing) with validation, tracking pixel, click wrap, language handling |

After step 5/5 the script enters an **idle loop**:
- every 5 minutes → `check_replies()`
- every 10 minutes → `send_due_reminders()`

## 6. Audit Considerations

- Sender mailbox: `pradeep@orbitavanytech.com`.
- SMTP/IMAP host: `s13429.bom1.stableserver.net` (ports 465/993).
- The project was built and run locally on Windows (VS Code terminal), with the PHP backend deployed via cPanel File Manager to `public_html/track.php`.

## 7. Success Criteria (measured by the project)

- Emails sent with **1x1 invisible pixel** → open status recorded automatically.
- Fake CEO emails **caught before sending** → stored for review.
- Auto follow-ups → leads that never opened are recontacted exactly once.
- Reply detection → inbox is auto-scanned every 5 minutes.
- Full audit trail → Excel tracker with 25 columns per lead, all runs kept forever.