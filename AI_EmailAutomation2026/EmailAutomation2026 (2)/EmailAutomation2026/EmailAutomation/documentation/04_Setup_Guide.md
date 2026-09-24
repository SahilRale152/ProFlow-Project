# 04 — Setup Guide

Everything needed to install, configure, and run the OrbitAvanya Email Automation System.

---

## 1. Prerequisites

- **Python 3.8+** installed on Windows (added to PATH).
- **VS Code** (or any terminal) — the scripts print progress and expect a terminal.
- Access to the **email mailbox** (`pradeep@orbitavanytech.com`) — login details in `Config`.
- **cPanel access** to `orbitavanytech.com` (to upload the PHP tracker — production).
- Internet connection (needed for geolocation APIs and, on first run, package installs).

## 2. Environment & Dependencies

The launcher **auto-installs** anything missing, but you can install manually:

```bash
pip install flask openpyxl pandas tqdm requests deep-translator beautifulsoup4 dnspython
```

| Package | Used for |
|---------|----------|
| `flask` | local tracking HTTP server |
| `openpyxl` | styled Excel read/write |
| `pandas` | reading the lead Excel file |
| `tqdm` | progress bars |
| `requests` | geolocation APIs, PHP polling, tunnel metrics |
| `deep-translator` | Google Translate wrapper |
| `beautifulsoup4` | HTML-safe translation |
| `dnspython` | MX record lookups during email validation |

> `cloudflared.exe` and `ngrok.exe` are already present under `Tools/`. `RUN_CAMPAIGN.py` will download `cloudflared` automatically into the `Data/` folder if missing.

## 3. One-Time Configuration (editing `Config`)

Open `Scripts/RUN_CAMPAIGN.py` and edit the `Config` class (Section 2, around line 81):

### 3.1 Email credentials

```python
SENDER_EMAIL    = "pradeep@orbitavanytech.com"
SENDER_PASSWORD = "Prad@2026"
SMTP_SERVER     = "s13429.bom1.stableserver.net"
SMTP_PORT       = 465
IMAP_SERVER     = "s13429.bom1.stableserver.net"
IMAP_PORT       = 993
```

### 3.2 File paths (use full paths)

```python
EXCEL_FILE_PATH      = r"...\Data\Trail for email automation3112.xlsx"   # lead list
SHEET_NAME           = "Sheet1"
TRACKER_FILE         = r"...\Data\Email_Tracking_NEW.xlsx"               # master tracker
DUPLICATES_FILE      = r"...\Data\sent_emails_log.json"                  # duplicate protection
EVENTS_JSON_FILE     = r"...\Data\tracking_events.json"                  # event log
SENT_BOUNCED_REPORT_FILE = r"...\Data\Sent_Bounced_Report.xlsx"          # report
```

### 3.3 Tracking

```python
TRACKING_PORT        = 6060                                   # local Flask port
TRACKING_SCRIPT_URL  = "https://orbitavanytech.com/track.php" # PHP backend
```

### 3.4 Sending behavior

```python
EMAIL_SUBJECT    = "Exploring Collaboration Opportunity with {company_name}"
FOLLOWUP_SUBJECT = "Following up: Collaboration Opportunity with {company_name}"
EMAIL_DELAY_MIN  = 2
EMAIL_DELAY_MAX  = 2
MAX_EMAILS_PER_RUN = 100
AUTO_CONTINUE    = True        # keep sending in batches automatically
BATCH_INTERVAL_MINUTES = 10    # pause between batches
SKIP_ALREADY_SENT = True       # don't re-email anyone
```

### 3.5 Validation

```python
VALIDATE_EMAILS   = True
SMTP_CHECK_TIMEOUT = 6
```

> ⚠️ The same values must be mirrored in `check_replies_and_reminders.py` (it has its own `Config`).

## 4. One-Time PHP Backend Setup (production tracking)

1. Open cPanel → **File Manager** → `public_html/`.
2. Upload `Server/track.php` (or `deploy_tracker.php` — same logic) as `track.php`.
3. Verify the secret key `orbitavanya2026` matches `EVENTS_ACCESS_KEY` in `RUN_CAMPAIGN.py` and the key in `sync_tracking_events.py`.
4. Test: open `https://orbitavanytech.com/track.php?action=status` → should return `{"status":"running"}`.
5. The script auto-creates `tracking_log.json` next to it on first event.

> **Why PHP?** The email pixel is loaded by recipients at any hour; a PHP endpoint on always-on hosting records it even when your laptop is off. `sync_tracking_events.py` then pulls events into Excel when you start it.

## 5. Run the System

### Terminal 1 — full campaign

```bash
python Scripts\RUN_CAMPAIGN.py
```

What you'll see:
1. `[0/5]` Sender location detection
2. `[1/5]` Library check/install
3. `[2/5]` cloudflared check/download (if used)
4. `[3/5]` Flask tracker on port 6060
5. `[4/5]` Tracking URL set
6. `[5/5]` Sending emails with progress bar
7. Idle loop: replies every 5 min, reminders every 10 min

> Keep this terminal open while the campaign is live.

### Terminal 2 — standalone watcher (recommended)

```bash
python Scripts\check_replies_and_reminders.py
```

Runs reply/bounce checks and reminder sending forever, independent of the campaign run.

### Terminal 3 — PHP event sync (if using the PHP backend)

```bash
python Scripts\sync_tracking_events.py
```

Polls `track.php?action=events` every 60 s and applies new opens/clicks/visits to Excel.

## 6. First-Run Checklist

- [ ] `Config` paths point to real files
- [ ] Excel lead sheet has the expected columns: `Company Name`, `CEO Name`, `Lead Email ID`, `Country`, `City` (others optional)
- [ ] SMTP/IMAP credentials work (test via any email client)
- [ ] `track.php` uploaded & `/status` responds
- [ ] `sent_emails_log.json` exists (or will be created)
- [ ] Close `Email_Tracking_NEW.xlsx` in Excel before running (file-lock errors are handled but avoided this way)

## 7. Testing Mode

The `Testing/` folder contains smaller lead files (e.g. `50_Leads_With_Real_CEO_Names.xlsx`) — point `EXCEL_FILE_PATH` there for safe trial runs before the real campaign.