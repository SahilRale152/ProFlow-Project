# 07 — Excel Master Tracker

The heart of the reports. This file (`Data/Email_Tracking_NEW.xlsx`) is created and updated automatically. The workbook contains **6 sheets**.

---

## 1. Sheets in `Email_Tracking_NEW.xlsx`

| Sheet | Purpose |
|-------|---------|
| `Total Sent` | **Master, append-only.** Every email ever processed, from every run, kept forever. Used for all cumulative totals. |
| `Current Sent` | Emails sent in the **last 15 days** (auto-pruned). Good for "what's live right now" views. |
| `Success` | Filtered view of master rows with `Email Send Status = Sent` (auto-refreshed). |
| `Bounced` | Filtered view of master rows with `Email Send Status = Bounced` (auto-refreshed). |
| `Summary` | Cross-run totals + date-by-date send/fail breakdown. |
| `Fake CEO Email` | Every fake/unvalidatable email that was **skipped** before sending, with all its lead details + reason. |

### Sheet creation rules (to avoid data loss)

- Never renames an existing data sheet — if `Sent`/`Current Sent` exist, they're reused as-is.
- A **fresh** "Total Sent" is only created when none exists (never migrates rows by renaming).
- Header columns are created **on demand** (adds new columns like `Email Open Status` the first time a feature needs them).

---

## 2. Master sheet columns (25)

| # | Column | Meaning | Example |
|---|--------|---------|---------|
| 1 | `Company` | Lead company name | Plain Concepts |
| 2 | `Contact Person` | CEO / contact name | John Doe |
| 3 | `Email` | The lead's email that was emailed | ceo@… |
| 4 | `Subject` | The subject line sent | Exploring Collaboration… |
| 5 | `Sent Date` | Date of the attempt (sent or failed) | 29-06-2026 |
| 6 | `Email Sent In Language` | Language chosen for this lead | English / Marathi / German … |
| 7 | `Email Open Status` | Not Opened → **Opened** (green) | Opened |
| 8 | `Email Opened At` | First open timestamp | 13-07-2026 09:14:23 |
| 9 | `Email Open Count` | How many times opened | 3 |
| 10 | `Link Clicked` | No → **Yes** (red) | Yes |
| 11 | `Link Clicked At` | First click timestamp | 13-07-2026 09:16:11 |
| 12 | `Link Click Count` | How many times clicked | 2 |
| 13 | `Opened From Country` | Geolocation on click/locate | United States |
| 14 | `Opened From City` | | Boston |
| 15 | `Opened Timezone` | | America/New_York |
| 16 | `Website Visits` | Count of visits to /visit | 1 |
| 17 | `Total Time on Website` | Accumulated time (format `X min Y sec`) | 2 min 14 sec |
| 18 | `Last Visit At` | Most recent visit timestamp | 13-07-2026 09:18:00 |
| 19 | `Email Send Status` | **Sent** (green) / **Failed** (red) / **Bounced** (red) | Sent |
| 20 | `Send Error` | SMTP error string for failures, — otherwise — | 450 … |
| 21 | `Reply Received` | **Yes** (green) when replied | Yes |
| 22 | `Reply Date` | When the reply arrived | 13-07-2026 10:12 |
| 23 | `Reply Subject` | Subject of the reply | Re: Exploring… |
| 24 | `Reminder Due` | send date + 2 days (only when Sent) | 01-07-2026 |
| 25 | `Reminder Sent` | **Yes** once follow-up sent | Yes |

> Columns are added automatically on first-need and are bold-formatted. Rows are updated **in place** (never duplicated) by looking up the email.

## 3. `Fake CEO Email` sheet columns (27)

All the lead's original fields + validation info:

```
Company | Contact Person | Email | Subject | Country | City | Region | Time Zone |
Country Size | Major Industries | Company Size | No Of Employees | Category Type |
Category | Company URL | Company Email | Company Ph No | CEO Status | CEO Found On |
CEO Note | Lead Email Status | Lead Email Note | Company Email Status |
Company Email Note | Email Send Status(=Fake) | Validation Reason | Validated At
```

- Same fake email found twice → the **existing row is updated** (reason refreshed), never duplicated.

## 4. `Summary` sheet

```
Metric                          | Value
Last Updated                    | 29-06-2026 18:41:22
Total Leads (All Runs)          | 44
Emails Sent (All Runs)          | 42
Emails Failed (All Runs)        | 1
Emails Bounced (All Runs)       | 1
Fake CEO Emails Skipped (All Runs) | 2
Sent This Run                   | 10
Failed This Run                 | 0
Skipped This Run                | 33
Fake Skipped This Run           | 2
──────────────────────────────
Emails By Date (below)
Date            | Emails Sent | Emails Failed
29-06-2026      | 42          | 1
```

- Values are computed from the **whole** `Total Sent` sheet across all runs.
- Sends/fails are tinted green/red; the per-date block is sorted newest first.

## 5. `Sent_Bounced_Report.xlsx` (auto-refreshed separate file)

| Sheet | Content |
|-------|---------|
| `Summary` | Last Updated, Total Leads, Emails Sent, Emails Bounced, Bounce Rate % |
| `Sent` | Master rows where Status=Sent (all headers, green fill) |
| `Bounced` | Master rows where Status=Bounced (red fill) |

- Rebuilt **from scratch** every time (after sends, reply/bounce checks, reminder checks) — never increments, so it can never drift out of sync.
- Formatted: frozen header row, auto-filter, 20-width columns, white header on navy fill.

## 6. Color legend

| Color | Meaning |
|-------|---------|
| Green (`#C6EFCE` / `#D9EAD3` / `#E2EFDA`) | Opened, Sent, Reply received, Visit recorded, Summary positives |
| Red (`#F4CCCC` / `#FCE4E4`) | Failed, Bounced, Link clicked |
| Navy (`#1F4E78`) | Table headers |
| Blue (`#0D5A9E`) | sync-created column headers |

## 7. Safety behaviors

- If Excel has the file open, scripts print a warning and **retry on the next flush** — nothing is lost.
- Writes are batched (default 10 records) so 1000 emails doesn't mean 1000 file saves — the report refreshes once per batch.
- Everything that reads the tracker uses `get_master_sheet()` so code never depends on which sheet is "active".