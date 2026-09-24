# OrbitAvanya Email Automation System

**Final Year Project — Team Documentation**

This folder contains the complete documentation of the **OrbitAvanya Email Automation System** — an all-in-one B2B cold-email outreach and tracking platform built for **OrbitAvanya Tech LLP**.

> Use the table below to jump to the topic you need. All paths below are relative to the project root (`EmailAutomation/`).

---

## What this project does (short version)

It reads a list of CEO / CXO leads from an **Excel file**, **validates** that each email address is real (without sending anything first), then sends a **personalized email** to each valid lead. Every outgoing email contains an **invisible tracking pixel**, a **link-click tracker**, a **website-visit + time-on-site tracker**, and an option for the recipient to read the email in their **own regional language**.

The system then continuously:

- detects **opens** (who opened, when, how many times),
- detects **link clicks** (with real IP/city/country/timezone),
- detects **website visits** and measures **time spent** on the site,
- reads the inbox via **IMAP** to catch **replies** and **bounces**,
- automatically sends **follow-up reminders** to leads who haven't replied,
- logs everything into a **color-coded Excel master tracker** plus a separate **Sent/Bounced/Summary report**.

It was evolved through several versions: a Jupyter Notebook → a standalone Flask tracking server (with `ngrok`/`cloudflared` tunnels) → the final **"one file does everything"** launcher (`RUN_CAMPAIGN.py`) backed by a **PHP tracking endpoint** hosted on cPanel hosting.

---

## Quick start (3 commands)

```bash
# 1. Edit the configuration at the top of the script (email, Excel path)
# 2. Run the ALL-IN-ONE launcher (installs libraries, starts server, sends emails)
python Scripts\RUN_CAMPAIGN.py

# 3. In a SECOND terminal (optional, recommended), keep the standalone watcher alive
python Scripts\check_replies_and_reminders.py
```

> ⚠️ Keep the terminal running — the tracking server must stay alive to record opens/clicks.

---

## Documentation index

| # | Document | What it covers |
|---|----------|----------------|
| 1 | [01_Project_Overview.md](01_Project_Overview.md) | Goal, problem statement, scope, technology stack, workflow (5-step process) |
| 2 | [02_System_Architecture.md](02_System_Architecture.md) | End-to-end architecture: modules, data flow, deployment diagram (conceptual) |
| 3 | [03_Features_List.md](03_Features_List.md) | Every feature implemented, with short descriptions |
| 4 | [04_Setup_Guide.md](04_Setup_Guide.md) | Environment, installation, credentials, one-time PHP server setup, running the project |
| 5 | [05_Scripts_Reference.md](05_Scripts_Reference.md) | Every script (`RUN_CAMPAIGN.py`, tracking server, sync, reply checker) — purpose, inputs, outputs |
| 6 | [06_Tracking_System_Design.md](06_Tracking_System_Design.md) | How open/click/visit/reply/bounce tracking works (pixel, beacons, PHP endpoint, event flow) |
| 7 | [07_Excel_Master_Tracker.md](07_Excel_Master_Tracker.md) | Structure of `Email_Tracking_NEW.xlsx` and `Sent_Bounced_Report.xlsx` — every sheet & column |
| 8 | [08_Data_Files_and_Logs.md](08_Data_Files_and_Logs.md) | All data files (Excel lead lists, JSON logs) and what they store |
| 9 | [09_Configuration_Reference.md](09_Configuration_Reference.md) | Every config value in `Config` class — what it means and how to edit it |
| 10 | [10_Multilingual_System.md](10_Multilingual_System.md) | Country/city → language mapping, translation approach, brand-name protection |
| 11 | [11_Email_Validation_and_Safety.md](11_Email_Validation_and_Safety.md) | The 4-layer fake-email detection, duplicate protection, sender-reputation safeguards, bounce handling |
| 12 | [12_Troubleshooting_FAQ.md](12_Troubleshooting_FAQ.md) | Common errors, causes, and fixes |

---

## Technology stack

| Layer | Technology |
|-------|------------|
| Language | Python 3 (main logic), PHP 7/8 (hosted tracking endpoint) |
| Email sending | `smtplib` via SMTP (port 465 / SSL), reused connection for speed |
| Reply & bounce detection | `imaplib` via IMAP (port 993, SSL) |
| Tracking HTTP server | Flask (development/fallback) + **cloudflared** free tunnel |
| Hosted tracker | `track.php` on cPanel hosting (`https://orbitavanyatech.com/track.php`) |
| Excel read/write | `pandas` (read) + `openpyxl` (styled read/write) |
| Translation | `deep-translator` (Google Translator) + `beautifulsoup4` for HTML-safe translation |
| Email validation | syntax regex + disposable-domain list + DNS (`dnspython`) + SMTP mailbox probe |
| Geolocation | free `ip-api.com` + `ipinfo.io` fallback |
| Tunnel tools | `cloudflared.exe`, `ngrok.exe` (included under `Tools/`) |

---

## Folder layout (short version)

```
EmailAutomation/
├── Scripts/
│   ├── RUN_CAMPAIGN.py               → all-in-one launcher (send + track + replies)
│   ├── email_tracker_server.py       → standalone Flask open-tracker (dev/legacy)
│   ├── check_replies_and_reminders.py→ standalone reply/bounce + reminder daemon
│   └── sync_tracking_events.py       → pulls PHP events → Excel (60s loop)
├── Server/                           → PHP tracking backend to upload to hosting
│   ├── track.php                     → runtime tracking endpoint (used in production)
│   ├── deploy_tracker.php            → same logic (cPanel deployment variant)
│   ├── index.php                     → alternate route-style backend (retired)
│   └── htaccess.txt                  → URL rewrite rules (retired)
├── Templates/
│   ├── Email_Template_final_1.html   → first-contact email (placeholders)
│   ├── Followup_template.html        → follow-up / reminder email
│   └── portfolio_tracking_snippet.html → JS snippet for the real portfolio page
├── Data/                             → lead Excel files, tracker, JSON logs
├── Notebooks/                        → original development notebook
├── Testing/                          → test lead files
├── Tools/                            → cloudflared.exe, ngrok.exe
└── documentation/                    → (this folder)
```

> Detailed mapping of every single file is in **08_Data_Files_and_Logs.md** and **05_Scripts_Reference.md**.

---

## Quick demo of the workflow

1. Lead list (`Trail for email automation3112.xlsx`) contains ~10–50+ rows of bulk-scraped, pre-enriched company + CEO data.
2. `RUN_CAMPAIGN.py` reads it → [optional] drags: validates emails (syntax → disposable → MX → SMTP RCPT).
3. Fake addresses are **skipped**, recorded in the `Fake CEO Email` sheet.
4. Real addresses get a personalized HTML email (with translated-language banner or fully translated when applicable) containing a tracking pixel + click-redirect link.
5. Opens/clicks/visits are recorded live into `Email_Tracking_NEW.xlsx` (green highlighting), geolocated by IP.
6. After 2 days, an auto **follow-up** is sent to non-responders.
7. Replies & bounces are detected from the inbox and flagged in the tracker.
8. Reports (`Sent_Bounced_Report.xlsx`) are auto-rebuilt after everything.

---

This documentation is intended to be shared with teammates, so each topic is kept self-contained. If you only read one file, read **01_Project_Overview.md**.