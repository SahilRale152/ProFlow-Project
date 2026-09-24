"""
============================================================================
ORBITAVANYA TRACKING SYNC
============================================================================
This script runs on your computer and:
1. Fetches all tracking events from track.orbitavanyatech.com
2. Updates Email_Tracking_NEW.xlsx automatically
3. Runs every 60 seconds continuously

HOW TO RUN:
   python SYNC_TRACKING.py

Keep this running in a separate VS Code terminal while your campaign is active.
============================================================================
"""

import requests
import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment
from datetime import datetime
import time
import os
import sys
import subprocess
import json

# ============================================================================
# CONFIG — UPDATE IF NEEDED
# ============================================================================
TRACKING_URL   = "https://orbitavanyatech.com/track.php?action=events&key=orbitavanya2026"
# Resolved relative to this script's own location, not hardcoded to one
# person's folder -- see RUN_CAMPAIGN.py Config for why.
from pathlib import Path as _Path
_DATA_DIR = _Path(__file__).resolve().parent.parent / "Data"
TRACKER_FILE   = str(_DATA_DIR / "Email_Tracking_NEW.xlsx")
EVENTS_JSON_FILE = str(_DATA_DIR / "tracking_events.json")
SYNC_INTERVAL  = 60   # seconds between each sync
# ============================================================================

# Track which event IDs we already processed (avoid double-updating)
processed_events = set()

# Persistent copy of processed event IDs (so restarts never re-count opens)
SYNC_IDS_FILE = os.path.join(os.path.dirname(TRACKER_FILE), "synced_event_ids.json")


def _event_id(e):
    return f"{e.get('type')}_{e.get('email')}_{e.get('timestamp')}"


def load_processed():
    """Load previously processed event IDs from the persistent file."""
    try:
        with open(SYNC_IDS_FILE, "r") as f:
            data = json.load(f)
        return set(data) if isinstance(data, list) else set()
    except Exception:
        return set()


def save_processed(ids):
    try:
        with open(SYNC_IDS_FILE, "w") as f:
            json.dump(sorted(ids), f, indent=1)
    except Exception as e:
        print(f"  ⚠️  Could not save sync state: {e}")


def seed_from_log():
    """
    Rebuild the 'already processed' set from tracking_events.json -- events
    that were actually written to Excel and logged. This is used instead of
    a blanket bootstrap so NEW events that arrived since the last sync are
    NEVER marked as done (that would silently lose real-time data).
    Returns (ids, visit_end_pairs). The pairs cover old time_on_site entries
    that predate the end_at field (matched by email+seconds_added).
    """
    ids = set()
    pairs = set()
    try:
        if not os.path.exists(EVENTS_JSON_FILE):
            return ids, pairs
        with open(EVENTS_JSON_FILE, "r") as f:
            logged = json.load(f)
        if not isinstance(logged, list):
            return ids, pairs
        for ev in logged:
            email = str(ev.get("email", "") or "").strip()
            etype = str(ev.get("event", "") or "").strip()
            if not email:
                continue
            ts = (ev.get("opened_at") or ev.get("clicked_at")
                  or ev.get("visited_at") or ev.get("end_at")
                  or ev.get("occurred_at") or "")
            server_type = {
                "email_opened": "open", "link_clicked": "click",
                "website_visit": "visit_start", "time_on_site": "visit_end",
                "auto_followup": "auto_followup",
            }.get(etype)
            if server_type and ts:
                ids.add(f"{server_type}_{email}_{ts}")
            elif server_type == "visit_end" and ev.get("seconds_added"):
                pairs.add((email, int(ev["seconds_added"])))
    except Exception:
        pass
    return ids, pairs

def install_if_missing(package):
    try:
        __import__(package)
    except ImportError:
        print(f"  Installing {package}...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", package, "--quiet"])

install_if_missing("requests")
install_if_missing("openpyxl")


def log_tracking_event(event_type, email_address, company="", **details):
    """
    Appends a tracking event to EVENTS_JSON_FILE as a JSON list, mirroring
    what's written to Excel. Uses the same file/schema as RUN_CAMPAIGN.py's
    local tracking so events from both sources land in one combined log.
    Never raises -- a JSON logging failure should not interrupt syncing.
    """
    event = {
        "event":     event_type,
        "email":     email_address,
        "company":   company,
        "timestamp": datetime.now().strftime("%d-%m-%Y %H:%M:%S"),
        **details,
    }
    try:
        events = []
        if os.path.exists(EVENTS_JSON_FILE):
            try:
                with open(EVENTS_JSON_FILE, "r") as f:
                    events = json.load(f)
                if not isinstance(events, list):
                    events = []
            except (json.JSONDecodeError, ValueError):
                events = []
        events.append(event)
        with open(EVENTS_JSON_FILE, "w") as f:
            json.dump(events, f, indent=2)
    except Exception as e:
        print(f"  ⚠️  Could not write event to JSON log: {e}")


def get_or_create_col(ws, headers, name):
    if name in headers:
        return headers.index(name) + 1
    col_idx = len(headers) + 1
    cell = ws.cell(row=1, column=col_idx, value=name)
    cell.font      = Font(bold=True, color="FFFFFF")
    cell.fill      = PatternFill("solid", fgColor="0D5A9E")
    cell.alignment = Alignment(horizontal="center", vertical="center")
    headers.append(name)
    return col_idx

def get_master_sheet(wb):
    """Return the sheet tracking updates actually go to ('Total Sent' first,
    matching RUN_CAMPAIGN.py) -- NEVER the 'active' sheet, which can be
    'Summary' and silently drop every event (no Email column there)."""
    if "Total Sent" in wb.sheetnames:
        return wb["Total Sent"]
    if "Current Sent" in wb.sheetnames:
        return wb["Current Sent"]
    if "Sent" in wb.sheetnames:
        return wb["Sent"]
    ws = wb.active
    ws.title = "Total Sent"
    return ws


def find_email_row(ws, headers, email_address):
    email_col = next(
        (i+1 for i, h in enumerate(headers) if h and str(h).strip().lower() == "email"),
        None
    )
    if not email_col:
        return None
    for row in ws.iter_rows(min_row=2):
        cell_val = row[email_col - 1].value
        if cell_val and str(cell_val).strip().lower() == email_address.strip().lower():
            return row[0].row
    return None

def update_excel(events):
    if not os.path.exists(TRACKER_FILE):
        print(f"  ❌ Tracker file not found: {TRACKER_FILE}")
        return 0

    try:
        wb      = openpyxl.load_workbook(TRACKER_FILE)
        ws      = get_master_sheet(wb)
        headers = [cell.value for cell in ws[1]]
        updated = 0

        for event in events:
            # Create unique event ID to avoid reprocessing
            event_id = f"{event.get('type')}_{event.get('email')}_{event.get('timestamp')}"
            if event_id in processed_events:
                continue

            email   = str(event.get("email", "")).strip()
            company = str(event.get("company", "")).strip()
            etype   = str(event.get("type", "")).strip()
            ts      = str(event.get("timestamp", "")).strip()

            if not email:
                continue

            row_num = find_email_row(ws, headers, email)
            if not row_num:
                continue   # email not in tracker — skip

            now_str = ts if ts else datetime.now().strftime("%d-%m-%Y %H:%M:%S")

            # ── EMAIL OPEN (pixel) ────────────────────────────────────────
            if etype == "open":
                status_col = get_or_create_col(ws, headers, "Email Open Status")
                time_col   = get_or_create_col(ws, headers, "Email Opened At")
                count_col  = get_or_create_col(ws, headers, "Email Open Count")

                sc = ws.cell(row=row_num, column=status_col)
                sc.value = "Opened"
                sc.fill  = PatternFill("solid", fgColor="C6EFCE")
                sc.font  = Font(color="276221", bold=True)

                tc = ws.cell(row=row_num, column=time_col)
                if not tc.value or tc.value == "—":
                    tc.value = now_str

                cc = ws.cell(row=row_num, column=count_col)
                cc.value = (int(cc.value or 0)) + 1

                print(f"  📬 EMAIL OPENED: {email} at {now_str}")
                log_tracking_event("email_opened", email, company,
                                   opened_at=now_str, open_count=int(cc.value))
                updated += 1

            # ── LINK CLICK ────────────────────────────────────────────────
            elif etype == "click":
                click_col    = get_or_create_col(ws, headers, "Link Clicked")
                click_t_col  = get_or_create_col(ws, headers, "Link Clicked At")
                click_ct_col = get_or_create_col(ws, headers, "Link Click Count")
                country_col  = get_or_create_col(ws, headers, "Opened From Country")
                city_col     = get_or_create_col(ws, headers, "Opened From City")
                tz_col       = get_or_create_col(ws, headers, "Opened Timezone")

                lc = ws.cell(row=row_num, column=click_col)
                lc.value = "Yes"
                lc.fill  = PatternFill("solid", fgColor="F4CCCC")
                lc.font  = Font(color="990000", bold=True)

                lt = ws.cell(row=row_num, column=click_t_col)
                if not lt.value or lt.value == "—":
                    lt.value = now_str

                lcc = ws.cell(row=row_num, column=click_ct_col)
                lcc.value = (int(lcc.value or 0)) + 1

                # Also mark as opened
                status_col = get_or_create_col(ws, headers, "Email Open Status")
                sc = ws.cell(row=row_num, column=status_col)
                if sc.value != "Opened":
                    sc.value = "Opened"
                    sc.fill  = PatternFill("solid", fgColor="C6EFCE")
                    sc.font  = Font(color="276221", bold=True)

                # Location from click
                country = event.get("country", "")
                city    = event.get("city", "")
                tz      = event.get("timezone", "")
                if country:
                    ws.cell(row=row_num, column=country_col).value = country
                    ws.cell(row=row_num, column=city_col).value    = city
                    ws.cell(row=row_num, column=tz_col).value      = tz

                loc_str = f"{city}, {country}" if country else "Unknown"
                page_label = event.get("page", "")
                page_str = f" | Page: {page_label}" if page_label else ""
                print(f"  🔗 LINK CLICKED: {email}{page_str} | Location: {loc_str} | {now_str}")
                log_tracking_event("link_clicked", email, company,
                                   clicked_at=now_str, click_count=int(lcc.value),
                                   page=page_label,
                                   location={"country": country, "city": city, "timezone": tz})
                updated += 1

            # ── WEBSITE VISIT ─────────────────────────────────────────────
            elif etype == "visit_start":
                visit_col = get_or_create_col(ws, headers, "Website Visits")
                last_col  = get_or_create_col(ws, headers, "Last Visit At")

                vc = ws.cell(row=row_num, column=visit_col)
                vc.value = (int(vc.value or 0)) + 1
                vc.fill  = PatternFill("solid", fgColor="D9EAD3")
                vc.font  = Font(color="276221", bold=True)

                ws.cell(row=row_num, column=last_col).value = now_str

                country = event.get("country", "")
                city    = event.get("city", "")

                page_label = event.get("page", "")
                page_str = f" | Page: {page_label}" if page_label else ""
                print(f"  🌐 WEBSITE VISIT: {email}{page_str} | Visit #{vc.value} | {city}, {country}")
                log_tracking_event("website_visit", email, company,
                                   visit_number=int(vc.value), visited_at=now_str,
                                   page=page_label,
                                   location={"country": country, "city": city})
                updated += 1

            # ── TIME ON SITE ──────────────────────────────────────────────
            elif etype == "visit_end":
                time_col  = get_or_create_col(ws, headers, "Total Time on Website")
                seconds   = int(event.get("seconds", 0))
                if seconds > 0:
                    tc       = ws.cell(row=row_num, column=time_col)
                    existing = str(tc.value or "0 sec")
                    try:
                        if "min" in existing:
                            parts        = existing.split("min")
                            existing_sec = int(parts[0].strip()) * 60 + int(parts[1].replace("sec","").strip())
                        else:
                            existing_sec = int(existing.replace("sec","").strip())
                    except:
                        existing_sec = 0
                    total_sec = existing_sec + seconds
                    tc.value  = f"{total_sec // 60} min {total_sec % 60} sec" if total_sec >= 60 else f"{total_sec} sec"
                    tc.fill   = PatternFill("solid", fgColor="D9EAD3")
                    tc.font   = Font(color="276221", bold=True)
                    page_label = event.get("page", "")
                    page_str = f" | Page: {page_label}" if page_label else ""
                    print(f"  ⏱️  TIME ON SITE: {email}{page_str} spent {tc.value} total")
                    log_tracking_event("time_on_site", email, company,
                                       seconds_added=seconds, total_time=tc.value,
                                       page=page_label, end_at=now_str)
                    updated += 1

            # ── AUTO FOLLOW-UP LANGUAGE ───────────────────────────────────
            elif etype == "auto_followup":
                fu_col   = get_or_create_col(ws, headers, "Auto Follow-up Sent")
                lang_col = get_or_create_col(ws, headers, "Follow-up Language")
                lang     = event.get("language", "")

                fc = ws.cell(row=row_num, column=fu_col)
                fc.value = "Yes"
                fc.fill  = PatternFill("solid", fgColor="C6EFCE")
                fc.font  = Font(color="276221", bold=True)

                ws.cell(row=row_num, column=lang_col).value = lang
                print(f"  🌍 FOLLOW-UP: {email} | Language: {lang}")
                log_tracking_event("auto_followup", email, company, language=lang,
                                   occurred_at=now_str)
                updated += 1

            processed_events.add(event_id)

        if updated > 0:
            wb.save(TRACKER_FILE)
            print(f"  ✅ Excel updated with {updated} new events!")
        
        return updated

    except PermissionError:
        print("  ⚠️  Close Email_Tracking_NEW.xlsx in Excel first!")
        return 0
    except Exception as e:
        print(f"  ❌ Excel update error: {e}")
        return 0


def fetch_events():
    try:
        r = requests.get(TRACKING_URL, timeout=10)
        if r.status_code == 200:
            return r.json()
        elif r.status_code == 403:
            print("  ❌ Wrong secret key in TRACKING_URL — check orbitavanya2026")
        else:
            print(f"  ❌ Server returned {r.status_code}")
    except requests.exceptions.ConnectionError:
        print("  ❌ Cannot reach track.orbitavanyatech.com — check internet connection")
    except Exception as e:
        print(f"  ❌ Fetch error: {e}")
    return []


def main():
    print("\n" + "="*60)
    print("  ORBITAVANYA TRACKING SYNC")
    print("="*60)
    print(f"  Tracking URL : {TRACKING_URL}")
    print(f"  Excel file   : {TRACKER_FILE}")
    print(f"  JSON events  : {EVENTS_JSON_FILE}")
    print(f"  Sync every   : {SYNC_INTERVAL} seconds")
    print("="*60)
    print("  Watching for new tracking events...")
    print("  Press Ctrl+C to stop.\n")

    sync_count = 0
    while True:
        try:
            sync_count += 1
            now = datetime.now().strftime("%H:%M:%S")
            print(f"\n  [{now}] Sync #{sync_count} — fetching events...")

            events = fetch_events()
            if events:
                if not processed_events:
                    # Fresh process — restore previously processed IDs so we
                    # never double-count opens/clicks after a restart. Only
                    # events actually logged in tracking_events.json count;
                    # brand-new server events are processed normally.
                    processed_events.update(load_processed())
                    seeded, pairs = seed_from_log()
                    if seeded or pairs:
                        processed_events.update(seeded)
                        # Old time_on_site entries predate the end_at field —
                        # skip matching visit_end events so seconds aren't
                        # double-added after a restart.
                        for e in events:
                            if (e.get("type") == "visit_end"
                                    and (str(e.get("email", "") or "").strip(),
                                         int(e.get("seconds") or 0)) in pairs):
                                processed_events.add(_event_id(e))
                        print(f"  🛡️  Restored {len(seeded)} previously-synced event IDs from the log (no double counting).")

                new_events = [e for e in events
                              if _event_id(e)
                              not in processed_events]
                if new_events:
                    print(f"  Found {len(new_events)} new events to process...")
                    update_excel(events)
                    save_processed(processed_events)
                else:
                    print(f"  No new events (total on server: {len(events)})")
            else:
                print("  No events on server yet.")

            print(f"  Next sync in {SYNC_INTERVAL} seconds...")
            time.sleep(SYNC_INTERVAL)

        except KeyboardInterrupt:
            print("\n\n  Sync stopped. Goodbye!")
            break


if __name__ == "__main__":
    main()