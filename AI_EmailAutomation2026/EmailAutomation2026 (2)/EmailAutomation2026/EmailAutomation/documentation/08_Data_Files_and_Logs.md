# 08 — Data Files and Logs

Complete inventory of every data file the project reads/writes, grouped by purpose.

---

## 1. Lead / input files (`Data/` & `Testing/`)

| File | Format | Purpose |
|------|--------|---------|
| `Data/Trail for email automation3112.xlsx` | Excel (22 cols, 11 rows) | Primary lead list used in `Config.EXCEL_FILE_PATH` |
| `Data/Lead Gen_CXO_UAE_Mail Merge_8_06_2024----.xlsx` | Excel | Original scraped pull (65 rows) |
| `Data/Lead Gen_CXO_UAE_Mail Merge_8_06_2024.xlsx` | Excel | Truncated/copy variant |
| `Data/Copy of Lead Gen_CXO_UAE_Mail Merge_8_06_2024.xlsx` | Excel | Backup copy |
| `Testing/Trail for email automation3112.xlsx` | Excel | Smaller trial lead set |
| `Testing/50_Leads_With_Real_CEO_Names.xlsx` | Excel (53 rows) | Test dataset with real CEO names for safe trial runs |

**Lead sheet columns** (all three datasets share the same 22-column schema):

```
Region | Country | Time Zone | Country Size | Major Industries | Company Name |
Company Size | No Of Employees | Category Type | Category | Company URL |
Company Email | Company Ph No | CEO Name | Lead Email ID | CEO Status |
CEO Found On | CEO Note | Lead Email Status | Lead Email Note |
Company Email Status | Company Email Note
```

Only `Company Name`, `CEO Name`, `Lead Email ID` (and optionally `Country`/`City`) are required by the campaign.

## 2. Tracker & output workbooks (`Data/`)

| File | Written by | Purpose |
|------|-----------|---------|
| `Email_Tracking_NEW.xlsx` | all scripts | **Master tracker** (6 sheets — see doc 07) |
| `Sent_Bounced_Report.xlsx` | RUN / checker | Auto-refreshed **Summary/Sent/Bounced** report |

## 3. Log & JSON state files (`Data/`)

| File | Contents |
|------|----------|
| `sent_emails_log.json` | JSON **array** of every email address already sent. Used by `DuplicateTracker` for duplicate protection |
| `tracking_events.json` | JSON **array** of `{event, email, company, timestamp, ...}` — combined portable log of all opens/clicks/visits/time-on-site (mirrors Excel; written by `sync_tracking_events.py`) |
| `open_tracking.log` | (repo root; also on disk) — log written by the legacy `email_tracker_server.py` for each pixel hit |

> Note: `RUN_CAMPAIGN.py` auto-downloads `cloudflared.exe` into the **folder of the lead Excel file** (`Data/`) if missing; the copy under `Tools/` is bundled in the repo for convenience.

> Other site-side file: `Server/tracking_log.json` — created **on the cPanel host** by `track.php`; stores every raw event (open/click/visit/visit-end/locate) with IP + geo. It is the source for `/events`.

## 4. Campaign log files (`email_campaign_logs/`)

- Timestamped per-run text logs written by the notebook-based iteration:
  - `email_campaign_20260629_152906.log` → per-send results.
- Each line follows `time - LEVEL - message` formatting.

## 5. Tunnel binaries (`Tools/`)

| File | Size | Purpose |
|------|------|---------|
| `cloudflared.exe` | ~54 MB | Free Cloudflare quick-tunnel client (used by `RUN_CAMPAIGN.py` when tracking is local) |
| `ngrok.exe` + `ngrok.zip` | ~33 MB | Alternative tunnel client (used by the legacy server / tutorials; requires account token for some features) |

## 6. Templates (`Templates/`)

| File | Purpose |
|------|---------|
| `Email_Template_final_1.html` | First-contact email body (placeholders `{{CEO_Name}}`, `{{Company_Name}}`) |
| `Followup_template.html` | Follow-up / reminder email body |
| `portfolio_tracking_snippet.html` | JS snippet for the real portfolio page to keep measuring time-on-site after the / redirect hand-off |

## 7. Notebook (development artifact)

`Notebooks/OrbitAvanya_Email_Automation_WITH_TRACKING.ipynb` — original development notebook showing the incremental build-out of the same pipeline (SMTP, pixel, duplicates, replies, language) before it was hardened into production `.py` scripts.

## 8. Miscellaneous

| Path | Purpose |
|------|---------|
| `Notebooks/` | Retired dev notebooks |
| `.history/`, `__pycache__/`, `.ipynb_checkpoints/`, `.vscode/` | Editor/cache folders — safe to ignore |
| `open_tracking.log` | At repo root: log from legacy server runs |

---

### Where should the user care least about?

- `.history/`, `__pycache__/`, `.ipynb_checkpoints/`, `.vscode/` — machine-generated; no project logic.