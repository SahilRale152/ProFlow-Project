"""
============================================================================
ORBITAVANYA EMAIL CAMPAIGN - ALL IN ONE LAUNCHER
============================================================================
Just run this ONE file from VS Code terminal:
    python RUN_CAMPAIGN.py

It will automatically:
1. Install all required libraries
2. Download cloudflared (free tunnel - no account needed)
3. Start the tracking server
4. Create a public URL for tracking
5. Update the tracking URL in notebook/config
6. Send all emails with tracking pixel
7. Track opens  → updates Email_Tracking.xlsx
8. Track replies → updates Email_Tracking.xlsx
============================================================================
"""

import subprocess
import sys
import os
import threading
import time
import json
import random
import logging
import imaplib
import email
import re
import base64
import zipfile
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from email.utils import formatdate, make_msgid, parseaddr
from urllib.parse import quote

# ============================================================================
# SECTION 1 — AUTO INSTALL LIBRARIES
# ============================================================================
def install(package):
    subprocess.check_call([sys.executable, "-m", "pip", "install", package, "--quiet"])

print("\n" + "="*60)
print("  ORBITAVANYA EMAIL CAMPAIGN - ALL IN ONE")
print("="*60)
print("\n[1/5] Checking libraries...")

required = {
    "flask": "flask",
    "openpyxl": "openpyxl",
    "pandas": "pandas",
    "tqdm": "tqdm",
    "requests": "requests",
    "deep-translator": "deep_translator",
    "beautifulsoup4": "bs4",
    "dnspython": "dns",
}
for pip_name, import_name in required.items():
    try:
        __import__(import_name)
    except ImportError:
        print(f"  Installing {pip_name}...")
        install(pip_name)

import flask
from flask import Flask, request, make_response, jsonify
import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment
from openpyxl.utils import get_column_letter
import pandas as pd
from tqdm import tqdm
import requests

print("  ✅ All libraries ready!")

# ============================================================================
# SECTION 2 — YOUR CONFIGURATION  ← EDIT THIS PART
# ============================================================================
# All Data/Templates file paths below are resolved RELATIVE TO THIS SCRIPT'S
# OWN LOCATION (not hardcoded to any one person's C:\Users\... folder).
# This file lives in .../EmailAutomation/Scripts/, so:
#   _BASE_DIR      = .../EmailAutomation
#   _BASE_DIR/Data = .../EmailAutomation/Data
# This is exactly the folder the Node CRM's EMAIL_AUTOMATION_DATA_DIR (in
# backend/.env) should point to. Move the whole "EmailAutomation" folder
# anywhere you like -- these paths always resolve correctly, no manual
# editing needed on a new machine or a new folder location.
from pathlib import Path as _Path
_SCRIPT_DIR = _Path(__file__).resolve().parent
_BASE_DIR = _SCRIPT_DIR.parent
_DATA_DIR = _BASE_DIR / "Data"
_TEMPLATES_DIR = _BASE_DIR / "Templates"

class Config:
    # ── Your email credentials ───────────────────────────────────────────────
    SENDER_EMAIL    = "pradeep@orbitavanyatech.com"
    SENDER_PASSWORD = "Prad@2026"
    SMTP_SERVER     = "s13429.bom1.stableserver.net"
    SMTP_PORT       =  465
    IMAP_SERVER     = "s13429.bom1.stableserver.net"
    IMAP_PORT       =  993

    # ── Daily digest email (dashboard) ──────────────────────────────────────
    # Sends a daily summary email to DIGEST_EMAIL at DIGEST_HOUR (24 h clock).
    # Leave DIGEST_EMAIL empty to send it to the sender's own address instead.
    DIGEST_EMAIL = ""
    DIGEST_HOUR  = 9

    EXCEL_FILE_PATH = str(_DATA_DIR / "Trail for email automation3112.xlsx")
    SHEET_NAME      = "Sheet1"
    TRACKER_FILE    = str(_DATA_DIR / "Email_Tracking_NEW.xlsx")
    DUPLICATES_FILE = str(_DATA_DIR / "sent_emails_log.json")
    EVENTS_JSON_FILE = str(_DATA_DIR / "tracking_events.json")

    # ── Active email templates ────────────────────────────────────────────
    # Switchable from the Dashboard (Templates tab). Files must contain the
    # {{CEO_Name}} and {{Company_Name}} placeholders.
    TEMPLATE_FILE          = str(_TEMPLATES_DIR / "Email_Template_final_1.html")
    FOLLOWUP_TEMPLATE_FILE = str(_TEMPLATES_DIR / "Followup_template.html")

    # ── Tracking server port ─────────────────────────────────────────────────
    TRACKING_PORT   = 6060

    # ── PHP tracking script on your hosting ────────────────────────────────
    # Set this to your PHP tracking script URL.
    # Upload track.php to cPanel's public_html folder, then set the URL here.
    TRACKING_SCRIPT_URL   = "https://orbitavanyatech.com/track.php"

    # ── Email subject template ───────────────────────────────────────────────
    EMAIL_SUBJECT   = "Exploring Collaboration Opportunity with {company_name}"
    FOLLOWUP_SUBJECT = "Following up: Collaboration Opportunity with {company_name}"

    # ── Delay between emails (seconds) ──────────────────────────────────────
    # Kept small so the campaign sends fast. Raise these values if you
    # want to slow down for sender-reputation safety.
    EMAIL_DELAY_MIN = 2
    EMAIL_DELAY_MAX = 2
    
    MAX_EMAILS_PER_RUN = 100

    # ── Daily send limit + auto-pause ───────────────────────────────────────
    # Max emails to send per calendar day. Once reached, the campaign pauses
    # and (with AUTO_CONTINUE on) automatically resumes the next day.
    DAILY_SEND_LIMIT = 500

    # ── Meeting link auto-scheduler ─────────────────────────────────────────
    # When a reply contains positive words (yes / call / meeting / schedule…),
    # an automatic reply with this link is sent to the lead and the tracker
    # gets a "Meeting Requested" mark. Set MEETING_AUTO_REPLY = False to
    # only flag the lead without sending anything.
    MEETING_LINK       = ""
    MEETING_AUTO_REPLY = True

    # ── AUTO-CONTINUE: send in batches automatically until ALL leads are done ──
    # With AUTO_CONTINUE=True the script waits BATCH_INTERVAL_MINUTES between
    # batches and keeps sending by itself until every lead in the Excel file
    # is processed (or skipped as already sent) -- no manual restarts needed.
    # Example: 10000 leads, MAX_EMAILS_PER_RUN=100, interval 60 min
    #          -> 100 sent, 1 hr pause, next 100, ... until all 10000 done.
    AUTO_CONTINUE            = True
    BATCH_INTERVAL_MINUTES   = 60

    # ── Duplicate protection ─────────────────────────────────────────────────
    # If True (recommended for real campaigns), a lead that's already in
    # sent_emails_log.json is skipped on future runs -- prevents accidentally
    # re-emailing the same person every time you re-run the script.
    # Set to False only if you deliberately want to allow re-sends.
    SKIP_ALREADY_SENT = True

    # ── Fake CEO email validation (free checks, no paid API) ─────────────────
    # Every lead's email is validated BEFORE sending using (in order):
    #   1. syntax check           2. disposable-domain check
    #   3. MX record check        4. SMTP mailbox verification (asks the
    #                               recipient's own mail server -- no email
    #                               is ever sent, MAIL FROM uses your
    #                               SENDER_EMAIL below, same as everywhere).
    # If the email is found FAKE it is SKIPPED (never emailed) and the full
    # record is stored in the "Fake CEO Email" sheet of the tracker file.
    # Emails that can't be verified (server refused to answer) are still sent.
    # Set VALIDATE_EMAILS = False to send everything without checking.
    VALIDATE_EMAILS  = True
    SMTP_CHECK_TIMEOUT = 6

    # ── Separate Sent/Bounced/Summary report file ───────────────────────────
    # Auto-regenerated (not modified in place -- always rebuilt fresh from
    # TRACKER_FILE) every time emails are sent or replies/bounces are
    # checked, so it's always current without needing to run a separate
    # script by hand.
    SENT_BOUNCED_REPORT_FILE = str(_DATA_DIR / "Sent_Bounced_Report.xlsx")


def get_master_sheet(wb):
    if "Total Sent" in wb.sheetnames:
        return wb["Total Sent"]
    # Never rename a data sheet ("Current Sent" / "Sent") into "Total Sent" --
    # that would silently move/merge its rows. Create a fresh master sheet.
    if "Current Sent" in wb.sheetnames or "Sent" in wb.sheetnames:
        return wb.create_sheet("Total Sent")
    ws = wb.active
    ws.title = "Total Sent"
    return ws


def get_current_sheet(wb):
    if "Current Sent" in wb.sheetnames:
        return wb["Current Sent"]
    if "Sent" in wb.sheetnames:          # rename the old sheet so no data is lost
        wb["Sent"].title = "Current Sent"
        return wb["Current Sent"]
    return wb.create_sheet("Current Sent")


def get_success_sheet(wb):
    if "Success" in wb.sheetnames:
        return wb["Success"]
    return wb.create_sheet("Success")


def get_bounced_sheet(wb):
    if "Bounced" in wb.sheetnames:
        return wb["Bounced"]
    return wb.create_sheet("Bounced")


def refresh_derived_sheets(wb, headers, master_ws=None):
    if master_ws is None:
        master_ws = get_master_sheet(wb)
    if "Email Send Status" not in headers:
        return
    status_idx = headers.index("Email Send Status")

    rows = []
    for row in master_ws.iter_rows(min_row=2, values_only=True):
        if row and any(v is not None for v in row):
            rows.append(row)

    sent_rows    = [r for r in rows if len(r) > status_idx and str(r[status_idx]).strip() == "Sent"]
    bounced_rows = [r for r in rows if len(r) > status_idx and str(r[status_idx]).strip() == "Bounced"]

    for name, data_rows in [("Success", sent_rows), ("Bounced", bounced_rows)]:
        ws = wb[name] if name in wb.sheetnames else wb.create_sheet(name)
        if ws.max_row > 1:
            ws.delete_rows(2, ws.max_row - 1)
        for j, h in enumerate(headers, start=1):
            ws.cell(row=1, column=j, value=h).font = Font(bold=True)
        for i, row in enumerate(data_rows, start=2):
            for j, val in enumerate(row, start=1):
                ws.cell(row=i, column=j, value=val)


# ============================================================================
# SECTION 2b — SENT / BOUNCED / SUMMARY REPORT (auto-refreshed)
# ============================================================================
def regenerate_sent_bounced_report():
    """
    Rebuilds Config.SENT_BOUNCED_REPORT_FILE from scratch, reading the
    current state of Config.TRACKER_FILE, with three sheets:
      - Summary  -> totals + bounce rate
      - Sent     -> only rows where Email Send Status == "Sent"
      - Bounced  -> only rows where Email Send Status == "Bounced"

    This is a separate FILE from TRACKER_FILE (never edits TRACKER_FILE
    itself) and is always fully rebuilt, not incrementally patched -- so
    it can never drift out of sync with the live tracker. Safe to call
    often; called automatically after sending emails and after each
    reply/bounce check.
    """
    try:
        if not os.path.exists(Config.TRACKER_FILE):
            return

        src_wb = openpyxl.load_workbook(Config.TRACKER_FILE, data_only=True)
        src_ws = get_master_sheet(src_wb)
        headers = [c.value for c in src_ws[1]]

        if "Email Send Status" not in headers:
            return  # tracker not in expected shape yet -- skip quietly
        status_idx = headers.index("Email Send Status")

        rows = []
        for row in src_ws.iter_rows(min_row=2, values_only=True):
            if row and any(v is not None for v in row):
                rows.append(row)

        sent_rows    = [r for r in rows if str(r[status_idx]).strip() == "Sent"]
        bounced_rows = [r for r in rows if str(r[status_idx]).strip() == "Bounced"]

        total   = len(rows)
        sent_n  = len(sent_rows)
        bounce_n = len(bounced_rows)

        out_wb = openpyxl.Workbook()

        header_fill = PatternFill("solid", fgColor="1F4E78")
        header_font = Font(bold=True, color="FFFFFF", size=11)
        body_font   = Font(size=10)
        sent_fill    = PatternFill("solid", fgColor="E2EFDA")
        bounced_fill = PatternFill("solid", fgColor="FCE4E4")

        def write_sheet(ws, rows_to_write, fill=None):
            for j, h in enumerate(headers, start=1):
                c = ws.cell(row=1, column=j, value=h)
                c.font = header_font
                c.fill = header_fill
                c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            for i, row in enumerate(rows_to_write, start=2):
                for j, val in enumerate(row, start=1):
                    cell = ws.cell(row=i, column=j, value=val)
                    cell.font = body_font
                    if fill:

                        cell.fill = fill
            for j in range(1, len(headers) + 1):
                ws.column_dimensions[get_column_letter(j)].width = 20
            ws.freeze_panes = "A2"
            ws.auto_filter.ref = ws.dimensions

        ws_summary = out_wb.active
        ws_summary.title = "Summary"
        ws_summary["A1"] = "Metric"
        ws_summary["B1"] = "Value"
        for cell_ref in ("A1", "B1"):
            ws_summary[cell_ref].font = header_font
            ws_summary[cell_ref].fill = header_fill
        bounce_rate = round(100 * bounce_n / total, 1) if total else 0
        summary_rows = [
            ("Last Updated", datetime.now().strftime("%d-%m-%Y %H:%M:%S")),
            ("Total Leads", total),
            ("Emails Sent", sent_n),
            ("Emails Bounced", bounce_n),
            ("Bounce Rate (%)", bounce_rate),
        ]
        for i, (label, value) in enumerate(summary_rows, start=2):
            ws_summary.cell(row=i, column=1, value=label).font = Font(bold=True)
            ws_summary.cell(row=i, column=2, value=value)
        ws_summary.column_dimensions["A"].width = 32
        ws_summary.column_dimensions["B"].width = 20

        write_sheet(out_wb.create_sheet("Sent"), sent_rows, fill=sent_fill)
        write_sheet(out_wb.create_sheet("Bounced"), bounced_rows, fill=bounced_fill)

        out_wb.save(Config.SENT_BOUNCED_REPORT_FILE)
        print(f"  📊 Sent/Bounced report refreshed → {Path(Config.SENT_BOUNCED_REPORT_FILE).name} "
              f"({sent_n} sent, {bounce_n} bounced, {bounce_rate}% bounce rate)")

    except PermissionError:
        print(f"  ⚠️  Could not refresh report — close {Path(Config.SENT_BOUNCED_REPORT_FILE).name} in Excel first!")
    except Exception as e:
        print(f"  ❌ Could not refresh Sent/Bounced report: {e}")


# ============================================================================
# SECTION 3 — DOWNLOAD CLOUDFLARED (FREE TUNNEL, NO ACCOUNT NEEDED)
# ============================================================================
def get_cloudflared():
    folder = Path(Config.EXCEL_FILE_PATH).parent
    cf_path = folder / "cloudflared.exe"

    if cf_path.exists():
        print("  ✅ cloudflared already downloaded!")
        return str(cf_path)

    print("\n[2/5] Downloading cloudflared tunnel (free, no account needed)...")
    url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    try:
        urllib.request.urlretrieve(url, cf_path)
        print("  ✅ cloudflared downloaded!")
        return str(cf_path)
    except Exception as e:
        print(f"  ❌ Could not download cloudflared: {e}")
        print("  Will try to continue without tunnel (local only)...")
        return None

# ============================================================================
# SECTION 4 — TRACKING SERVER (FLASK)
# ============================================================================
app = Flask(__name__)
excel_lock = threading.Lock()

# ── In-memory event log, served via /events for sync_tracking_events.py ────
# RUN_CAMPAIGN.py updates Excel directly and doesn't need this for its own
# operation -- this log exists purely so a SEPARATE machine/script (like
# sync_tracking_events.py, running elsewhere) can poll /events and get the
# same tracking data without needing direct access to this Excel file.
EVENTS_LOG = []
EVENTS_LOG_LOCK = threading.Lock()
EVENTS_ACCESS_KEY = "orbitavanya2026"   # must match TRACKING_URL's ?key= in sync_tracking_events.py
MAX_EVENTS_LOG_SIZE = 5000              # trim oldest events past this to bound memory use

def log_event_for_sync(event_type, email_address, company="", **details):
    """Appends an event to the in-memory log that /events serves."""
    with EVENTS_LOG_LOCK:
        EVENTS_LOG.append({
            "type":      event_type,
            "email":     email_address,
            "company":   company,
            "timestamp": datetime.now().strftime("%d-%m-%Y %H:%M:%S"),
            **details,
        })
        if len(EVENTS_LOG) > MAX_EVENTS_LOG_SIZE:
            del EVENTS_LOG[: len(EVENTS_LOG) - MAX_EVENTS_LOG_SIZE]

# Tiny 1x1 transparent GIF
PIXEL_BYTES = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")

# ── Country → Language code mapping ─────────────────────────────────────────
COUNTRY_LANGUAGE = {
    "Germany": "de", "France": "fr", "Spain": "es", "Italy": "it",
    "Portugal": "pt", "Netherlands": "nl", "Russia": "ru", "China": "zh-CN",
    "Japan": "ja", "South Korea": "ko", "Saudi Arabia": "ar", "UAE": "ar",
    "Brazil": "pt", "Mexico": "es", "Argentina": "es", "Turkey": "tr",
    "Poland": "pl", "Sweden": "sv", "Norway": "no", "Denmark": "da",
    "Finland": "fi", "Czech Republic": "cs", "Romania": "ro", "Hungary": "hu",
    "Indonesia": "id", "Thailand": "th", "Vietnam": "vi", "Israel": "he",
    "India": "en", "USA": "en", "UK": "en", "Australia": "en",
    "Canada": "en", "Singapore": "en", "United States": "en",
    "United Kingdom": "en",
}

# ── India: City → regional language code ────────────────────────────────────
# Used so that leads inside India get an email in their own regional language
# instead of generic English/Hindi.
INDIA_CITY_LANGUAGE = {
    "pune": "mr", "mumbai": "mr", "nagpur": "mr", "nashik": "mr",
    "thane": "mr", "aurangabad": "mr", "kolhapur": "mr",
    "delhi": "hi", "new delhi": "hi", "jaipur": "hi", "lucknow": "hi",
    "kanpur": "hi", "bhopal": "hi", "indore": "hi", "patna": "hi",
    "gurgaon": "hi", "gurugram": "hi", "noida": "hi", "agra": "hi",
    "chennai": "ta", "coimbatore": "ta", "madurai": "ta", "trichy": "ta",
    "hyderabad": "te", "vijayawada": "te", "visakhapatnam": "te", "warangal": "te",
    "bengaluru": "kn", "bangalore": "kn", "mysuru": "kn", "mysore": "kn", "hubli": "kn",
    "kochi": "ml", "cochin": "ml", "thiruvananthapuram": "ml",
    "kozhikode": "ml", "kottayam": "ml",
    "ahmedabad": "gu", "surat": "gu", "vadodara": "gu", "rajkot": "gu",
    "chandigarh": "pa", "ludhiana": "pa", "amritsar": "pa", "jalandhar": "pa",
    "kolkata": "bn", "howrah": "bn", "durgapur": "bn",
}

# ── India: State/region → regional language code (fallback when city unknown) ──
INDIA_STATE_LANGUAGE = {
    "maharashtra": "mr", "delhi": "hi", "uttar pradesh": "hi",
    "madhya pradesh": "hi", "bihar": "hi", "rajasthan": "hi", "haryana": "hi",
    "tamil nadu": "ta", "andhra pradesh": "te", "telangana": "te",
    "karnataka": "kn", "kerala": "ml", "gujarat": "gu", "punjab": "pa",
    "west bengal": "bn",
}

# ── Sender's own detected location (filled in at startup) ───────────────────
SENDER_COUNTRY = ""
SENDER_CITY    = ""
SENDER_REGION  = ""
SENDER_LANG    = "en"

LANGUAGE_NAMES = {
    "en": "English", "de": "German", "fr": "French", "es": "Spanish",
    "it": "Italian", "pt": "Portuguese", "nl": "Dutch", "ru": "Russian",
    "zh-CN": "Chinese", "ja": "Japanese", "ko": "Korean", "ar": "Arabic",
    "tr": "Turkish", "pl": "Polish", "sv": "Swedish", "no": "Norwegian",
    "da": "Danish", "fi": "Finnish", "cs": "Czech", "ro": "Romanian",
    "hu": "Hungarian", "id": "Indonesian", "th": "Thai", "vi": "Vietnamese",
    "he": "Hebrew", "mr": "Marathi", "hi": "Hindi", "ta": "Tamil",
    "te": "Telugu", "kn": "Kannada", "ml": "Malayalam", "gu": "Gujarati",
    "pa": "Punjabi", "bn": "Bengali",
}


# Generic webmail providers -- geolocating these would just return the
# provider's datacenter location (e.g. Google/Microsoft), not the lead's
# actual company location, so these domains are skipped.
FREE_EMAIL_PROVIDERS = {
    "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com",
    "icloud.com", "protonmail.com", "mail.com", "yandex.com", "zoho.com",
    "rediffmail.com", "live.com", "msn.com", "gmx.com",
}


def detect_client_location_from_domain(email_addr: str) -> dict:
    """
    Auto-detects a lead's likely country/city from their company email
    domain (e.g. someone@planconcepts.de -> Germany) by resolving the
    domain to an IP address and geolocating it -- so leads get the right
    regional language even when the Excel sheet has no Country/City filled
    in. Skipped for generic webmail domains (gmail.com etc).
    """
    try:
        domain = email_addr.split("@")[-1].strip().lower()
        if not domain or domain in FREE_EMAIL_PROVIDERS:
            return {}
        import socket
        ip = socket.gethostbyname(domain)
        return get_location_from_ip(ip)
    except Exception:
        return {}


def get_language_for_location(country: str, city: str = "", region: str = "") -> str:
    """
    Decide which language to send an email in, based on recipient location.
      - India            -> regional language by city, then by state, then Hindi
      - Any other country -> COUNTRY_LANGUAGE mapping (defaults to English)
      - No country given  -> falls back to the sender's own detected language
    """
    country    = (country or "").strip()
    city_key   = (city or "").strip().lower()
    region_key = (region or "").strip().lower()

    if country.lower() == "india":
        if city_key in INDIA_CITY_LANGUAGE:
            return INDIA_CITY_LANGUAGE[city_key]
        if region_key in INDIA_STATE_LANGUAGE:
            return INDIA_STATE_LANGUAGE[region_key]
        return "hi"  # default regional language for India when city is unknown

    if not country:
        # No location info on the lead at all -- use whatever we detected
        # for the sender's own machine at startup.
        return SENDER_LANG or "en"

    return COUNTRY_LANGUAGE.get(country, "en")


def detect_sender_location():
    """
    Detect the current machine's public location (country/city/region) via
    its public IP, and use it to pick a sensible default language for leads
    that don't have a Country/City filled in on the Excel sheet.
    """
    global SENDER_COUNTRY, SENDER_CITY, SENDER_REGION, SENDER_LANG

    print("\n[0/5] Detecting your location for language selection...")
    try:
        r = requests.get(
            "http://ip-api.com/json/?fields=status,country,city,regionName",
            timeout=5
        )
        data = r.json()
        if data.get("status") == "success":
            SENDER_COUNTRY = data.get("country", "") or ""
            SENDER_CITY    = data.get("city", "") or ""
            SENDER_REGION  = data.get("regionName", "") or ""
    except Exception:
        pass

    if SENDER_CITY and SENDER_COUNTRY:
        print(f"  📍 Your current location: {SENDER_CITY}, {SENDER_REGION}, {SENDER_COUNTRY}")
    elif SENDER_COUNTRY:
        print(f"  📍 Your current location: {SENDER_REGION}, {SENDER_COUNTRY}")
    else:
        print("  ⚠️  Could not detect your location — defaulting to English")

    SENDER_LANG = get_language_for_location(SENDER_COUNTRY, SENDER_CITY, SENDER_REGION)
    lang_display = LANGUAGE_NAMES.get(SENDER_LANG, SENDER_LANG)
    print(f"  Default language for unspecified countries: {lang_display}")


# Known Google/Gmail proxy IP ranges — location from these is always Mountain View, USA
# so we skip them entirely for location tracking
GOOGLE_IP_RANGES = (
    "66.102.", "66.249.", "64.233.", "72.14.", "74.125.",
    "173.194.", "216.239.", "209.85.", "142.250.", "172.217.",
    "108.177.", "35.190.", "34.64.", "34.96.", "34.128.",
)

def is_google_proxy_ip(ip: str) -> bool:
    """Returns True if the IP belongs to Google's proxy/crawler network."""
    return any(ip.startswith(prefix) for prefix in GOOGLE_IP_RANGES)

def get_location_from_ip(ip_address: str) -> dict:
    """
    Get country, city, timezone from IP address using free ip-api.com.
    Returns real location for ALL IPs including Google proxy.
    For Google proxy IPs, this gives Google's datacenter location —
    but we now use multiple IP lookup services to get the best result.
    """
    try:
        if not ip_address:
            return {}
        # Skip only truly private/local IPs
        if (ip_address in ("127.0.0.1", "localhost") or
            ip_address.startswith("192.168.") or
            ip_address.startswith("10.") or
            ip_address.startswith("172.16.")):
            return {}

        # Try ip-api.com first (free, reliable)
        r = requests.get(
            f"http://ip-api.com/json/{ip_address}?fields=status,country,city,timezone,regionName,isp",
            timeout=5
        )
        data = r.json()
        if data.get("status") == "success" and data.get("country"):
            return {
                "country":  data.get("country", ""),
                "city":     data.get("city", ""),
                "region":   data.get("regionName", ""),
                "timezone": data.get("timezone", ""),
                "isp":      data.get("isp", ""),
            }

        # Fallback: try ipinfo.io
        r2 = requests.get(f"https://ipinfo.io/{ip_address}/json", timeout=5)
        data2 = r2.json()
        if data2.get("country"):
            return {
                "country":  data2.get("country", ""),
                "city":     data2.get("city", ""),
                "region":   data2.get("region", ""),
                "timezone": data2.get("timezone", ""),
                "isp":      data2.get("org", ""),
            }
    except Exception:
        pass
    return {}


def translate_text(text: str, target_lang: str) -> str:
    """
    Translate text using deep-translator library (more reliable than raw Google API).
    Falls back to original text if translation fails.
    Auto-installs deep-translator if not present.
    """
    if target_lang == "en" or not target_lang:
        return text
    try:
        try:
            from deep_translator import GoogleTranslator
        except ImportError:
            import subprocess
            subprocess.check_call([sys.executable, "-m", "pip", "install", "deep-translator", "--quiet"])
            from deep_translator import GoogleTranslator
        translated = GoogleTranslator(source="en", target=target_lang).translate(text)
        return translated if translated else text
    except Exception as e:
        print(f"  ⚠️  Translation failed: {e} — sending in English")
        return text


# Brand/contact details that must NEVER be machine-translated, no matter
# which language the rest of the email goes out in.
BRAND_PROTECTED_TERMS = [
    "OrbitAvanya Tech LLP", "OrbitAvanya", "Ranjeet Kumar",
    "info@orbitavanyatech.com", "orbitavanyatech.com",
    "+91 70219 50643",
]


def _protect_terms(text: str, extra_terms=None):
    """
    Swaps out proper nouns (brand name, CEO name, company name, contact info)
    for short placeholder tokens before translation, so Google Translate
    can't mangle them (e.g. translating a company's name as if it were an
    English phrase). Returns (protected_text, {token: original_term}).
    """
    terms = list(BRAND_PROTECTED_TERMS) + list(extra_terms or [])
    terms = sorted({t.strip() for t in terms if t and t.strip()}, key=len, reverse=True)
    placeholders = {}
    working = text
    for i, term in enumerate(terms):
        if term in working:
            token = f"zzptk{i}zz"
            working = working.replace(term, token)
            placeholders[token] = term
    return working, placeholders


def _restore_terms(text: str, placeholders: dict) -> str:
    for token, term in placeholders.items():
        text = text.replace(token, term)
    return text


def translate_text_protected(text: str, target_lang: str, extra_terms=None) -> str:
    """Same as translate_text but keeps proper nouns (names, brand, contact info) untranslated."""
    if not text or not text.strip() or target_lang == "en" or not target_lang:
        return text
    working, placeholders = _protect_terms(text, extra_terms)
    translated = translate_text(working, target_lang)
    return _restore_terms(translated, placeholders)


def translate_html_body(html_body: str, target_lang: str, extra_terms=None) -> str:
    """
    Translates EVERY piece of visible text in the HTML email body into
    target_lang (e.g. "mr" for Marathi, "hi" for Hindi, "de" for German) --
    not just text inside <p> tags, so nothing is left behind in English
    (signature blocks, buttons, links, table cells, etc. all get covered).
    Proper nouns (company name, CEO name, brand name, contact details) are
    protected from translation. HTML structure, tags, and links are preserved.
    """
    if not target_lang or target_lang == "en":
        return html_body  # no translation needed

    print(f"  🌍 Translating email body to {target_lang}...")

    try:
        from bs4 import BeautifulSoup, Comment
    except ImportError:
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "beautifulsoup4", "--quiet"])
        from bs4 import BeautifulSoup, Comment

    soup = BeautifulSoup(html_body, "html.parser")
    SKIP_PARENT_TAGS = {"script", "style"}

    for node in soup.find_all(string=True):
        if isinstance(node, Comment):
            continue
        parent_name = node.parent.name if node.parent else None
        if parent_name in SKIP_PARENT_TAGS:
            continue
        original = str(node)
        if not original.strip():
            continue  # whitespace-only text node between tags
        leading_ws  = original[:len(original) - len(original.lstrip())]
        trailing_ws = original[len(original.rstrip()):]
        translated = translate_text_protected(original.strip(), target_lang, extra_terms)
        node.replace_with(leading_ws + translated + trailing_ws)

    return str(soup)


def update_open_status(email_address: str, company: str, method: str = "pixel", client_ip: str = ""):
    """
    Updates Email_Tracking.xlsx when email is opened or link is clicked.
    - method='pixel' → Email Open Status only, NO location
    - method='click' → Link Clicked + real location from client IP
    """
    location = (get_location_from_ip(client_ip)
                if (client_ip and method == "click" and not is_google_proxy_ip(client_ip))
                else {})

    with excel_lock:
        try:
            wb = openpyxl.load_workbook(Config.TRACKER_FILE)
            ws = get_master_sheet(wb)
            headers = [cell.value for cell in ws[1]]

            def get_or_create_col(name):
                if name in headers:
                    return headers.index(name) + 1
                col_idx = len(headers) + 1
                ws.cell(row=1, column=col_idx, value=name).font = Font(bold=True)
                headers.append(name)
                return col_idx

            # ── Column indices ──────────────────────────────────────────────
            # Email open (pixel)
            open_status_col  = get_or_create_col("Email Open Status")
            open_time_col    = get_or_create_col("Email Opened At")
            open_count_col   = get_or_create_col("Email Open Count")
            # Link click
            click_status_col = get_or_create_col("Link Clicked")
            click_time_col   = get_or_create_col("Link Clicked At")
            click_count_col  = get_or_create_col("Link Click Count")
            # Location
            country_col      = get_or_create_col("Opened From Country")
            city_col         = get_or_create_col("Opened From City")
            timezone_col     = get_or_create_col("Opened Timezone")

            # Find Email column
            email_col_idx = next(
                (i+1 for i, h in enumerate(headers) if h and str(h).strip().lower() == "email"),
                None
            )
            if not email_col_idx:
                return

            now_str = datetime.now().strftime("%d-%m-%Y %H:%M:%S")

            for row in ws.iter_rows(min_row=2):
                cell_val = row[email_col_idx - 1].value
                if cell_val and str(cell_val).strip().lower() == email_address.lower():
                    r = row[0].row

                    if method == "pixel":
                        # ── Email Open tracking ───────────────────────────
                        sc = ws.cell(row=r, column=open_status_col)
                        sc.value = "Opened"
                        sc.fill  = PatternFill("solid", fgColor="C6EFCE")
                        sc.font  = Font(color="276221", bold=True)

                        tc = ws.cell(row=r, column=open_time_col)
                        if not tc.value or tc.value == "—":
                            tc.value = now_str

                        cc = ws.cell(row=r, column=open_count_col)
                        cc.value = (int(cc.value or 0)) + 1

                    elif method == "click":
                        # ── Link Click tracking ───────────────────────────
                        lc = ws.cell(row=r, column=click_status_col)
                        lc.value = "Yes"
                        lc.fill  = PatternFill("solid", fgColor="F4CCCC")
                        lc.font  = Font(color="990000", bold=True)

                        lt = ws.cell(row=r, column=click_time_col)
                        if not lt.value or lt.value == "—":
                            lt.value = now_str

                        lcc = ws.cell(row=r, column=click_count_col)
                        lcc.value = (int(lcc.value or 0)) + 1

                        # Also mark email as opened when link is clicked
                        sc = ws.cell(row=r, column=open_status_col)
                        if sc.value != "Opened":
                            sc.value = "Opened"
                            sc.fill  = PatternFill("solid", fgColor="C6EFCE")
                            sc.font  = Font(color="276221", bold=True)
                            tc = ws.cell(row=r, column=open_time_col)
                            if not tc.value or tc.value == "—":
                                tc.value = now_str
                            cc = ws.cell(row=r, column=open_count_col)
                            cc.value = (int(cc.value or 0)) + 1

                    # ── Location — only on click, NOT on pixel ───────────
                    if method == "click" and location and "country" in location:
                        ws.cell(row=r, column=country_col).value  = location.get("country", "—")
                        ws.cell(row=r, column=city_col).value     = location.get("city", "—")
                        ws.cell(row=r, column=timezone_col).value = location.get("timezone", "—")

                    if method == "pixel":
                        print(f"\n  📬 EMAIL OPENED! {email_address} at {now_str}")
                        log_event_for_sync("open", email_address, company)
                    else:
                        loc_str = f"{location.get('city', '—')}, {location.get('country', '—')}" if location else "Unknown"
                        print(f"\n  🔗 LINK CLICKED! {email_address}")
                        print(f"     Location: {loc_str} | Time: {now_str}")
                        log_event_for_sync("click", email_address, company,
                                           country=location.get("country", "") if location else "",
                                           city=location.get("city", "") if location else "",
                                           timezone=location.get("timezone", "") if location else "")
                    break

            wb.save(Config.TRACKER_FILE)

        except PermissionError:
            print(f"\n  ⚠️  COULD NOT SAVE! Close {Path(Config.TRACKER_FILE).name} in Excel first!")
        except Exception as e:
            print(f"  ❌ Excel update error: {e}")


@app.route("/track")
def track_open():
    email_param   = request.args.get("email", "").strip()
    company_param = request.args.get("company", "").strip()
    client_ip = (request.headers.get("CF-Connecting-IP") or
                 request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or
                 request.remote_addr or "")
    if email_param:
        threading.Thread(
            target=update_open_status,
            args=(email_param, company_param, "pixel", client_ip),
            daemon=True
        ).start()
    resp = make_response(PIXEL_BYTES)
    resp.headers["Content-Type"]  = "image/gif"
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp



def update_website_visit(email_address: str, company: str, event: str = "start", seconds: int = 0):
    if not os.path.exists(Config.TRACKER_FILE):
        return
    with excel_lock:
        try:
            wb = openpyxl.load_workbook(Config.TRACKER_FILE)
            ws = get_master_sheet(wb)
            headers = [cell.value for cell in ws[1]]

            def get_or_create_col(name):
                if name in headers:
                    return headers.index(name) + 1
                col_idx = len(headers) + 1
                ws.cell(row=1, column=col_idx, value=name).font = Font(bold=True)
                headers.append(name)
                return col_idx

            visit_col   = get_or_create_col("Website Visits")
            time_col    = get_or_create_col("Total Time on Website")
            last_col    = get_or_create_col("Last Visit At")
            email_col   = next((i+1 for i,h in enumerate(headers)
                                if h and str(h).strip().lower()=="email"), None)
            if not email_col:
                return

            now_str = datetime.now().strftime("%d-%m-%Y %H:%M:%S")

            for row in ws.iter_rows(min_row=2):
                cell_val = row[email_col - 1].value
                if cell_val and str(cell_val).strip().lower() == email_address.lower():
                    r = row[0].row
                    if event == "start":
                        vc = ws.cell(row=r, column=visit_col)
                        vc.value = (int(vc.value or 0)) + 1
                        vc.fill  = PatternFill("solid", fgColor="D9EAD3")
                        vc.font  = Font(color="276221", bold=True)
                        ws.cell(row=r, column=last_col).value = now_str
                        print(f"\n  🌐 WEBSITE VISITED! {email_address} | Visit #{vc.value} at {now_str}")
                        log_event_for_sync("visit_start", email_address, company)

                    elif event == "end" and seconds > 0:
                        tc = ws.cell(row=r, column=time_col)
                        existing = str(tc.value or "0 sec")
                        try:
                            existing_sec = int(existing.replace(" sec","").replace(" min","").strip())
                            if "min" in existing:
                                existing_sec *= 60
                        except:
                            existing_sec = 0
                        total_sec = existing_sec + seconds
                        if total_sec >= 60:
                            tc.value = f"{total_sec // 60} min {total_sec % 60} sec"
                        else:
                            tc.value = f"{total_sec} sec"
                        tc.fill = PatternFill("solid", fgColor="D9EAD3")
                        tc.font = Font(color="276221", bold=True)
                        print(f"\n  ⏱️  TIME ON SITE: {email_address} spent {tc.value} total")
                        log_event_for_sync("visit_end", email_address, company,
                                           seconds=seconds, total_time=tc.value)
                    break

            wb.save(Config.TRACKER_FILE)
        except PermissionError:
            print(f"\n  ⚠️  Close {Path(Config.TRACKER_FILE).name} in Excel first!")
        except Exception as e:
            print(f"  ❌ Visit tracking error: {e}")


@app.route("/click")
def track_click():
    from flask import redirect
    email_param   = request.args.get("email", "").strip()
    company_param = request.args.get("company", "").strip()
    dest          = request.args.get("dest", "https://orbitavanyatech.com").strip()
    client_ip = (request.headers.get("CF-Connecting-IP") or
                 request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or
                 request.remote_addr or "")
    if email_param:
        update_open_status(email_param, company_param, "click", client_ip)
    visit_url = (f"{request.host_url}visit?email={quote(email_param, safe='')}"
                 f"&company={quote(company_param, safe='')}&dest={quote(dest, safe='')}")
    return redirect(visit_url, code=302)


@app.route("/visit")
def visit_page():
    email_param   = request.args.get("email", "").strip()
    company_param = request.args.get("company", "").strip()
    dest          = request.args.get("dest", "https://orbitavanyatech.com").strip()

    if email_param:
        threading.Thread(
            target=update_website_visit,
            args=(email_param, company_param, "start"),
            daemon=True
        ).start()

    from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
    parts = urlsplit(dest)
    q = dict(parse_qsl(parts.query))
    q["lead_email"]   = email_param
    q["lead_company"] = company_param
    dest = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), parts.fragment))

    # ── Offer a translated view based on the visitor's own location ────────
    # (Uses IP-based geolocation, same as the rest of this script. True
    # phone-GPS location would require an intrusive browser permission
    # popup, so IP location is used to quietly suggest a language instead.)
    client_ip = (request.headers.get("CF-Connecting-IP") or
                 request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or
                 request.remote_addr or "")
    visitor_location = get_location_from_ip(client_ip) if client_ip else {}
    visitor_country   = visitor_location.get("country", "")
    visitor_city      = visitor_location.get("city", "")
    visitor_lang      = get_language_for_location(visitor_country, visitor_city)
    translate_banner  = ""
    if visitor_lang and visitor_lang != "en":
        lang_label = LANGUAGE_NAMES.get(visitor_lang, visitor_lang.upper())
        translate_url = ("https://translate.google.com/translate?sl=auto&tl="
                          + quote(visitor_lang, safe="") + "&u=" + quote(dest, safe=""))
        translate_banner = (
            f'<a href="{translate_url}" target="_blank" rel="noopener" '
            f'class="translate-link">🌐 View in {lang_label}</a>'
        )

    html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>OrbitAvanya Tech LLP</title>
<style>
  body {{ margin:0; display:flex; align-items:center; justify-content:center;
         height:100vh; font-family:Arial,sans-serif; background:#EAF3FB; }}
  .box {{ text-align:center; color:#062E56; }}
  .logo {{ font-size:22px; font-weight:bold; margin-bottom:8px; }}
  .sub  {{ font-size:13px; color:#0D5A9E; margin-bottom:14px; }}
  .translate-link {{ display:inline-block; background:#062E56; color:#fff !important;
                      text-decoration:none; font-size:12px; padding:6px 14px;
                      border-radius:16px; }}
</style>
</head>
<body>
  <div class="box">
    <div class="logo">OrbitAvanya Tech LLP</div>
    <div class="sub">Taking you to {company_param or 'our website'}...</div>
    {translate_banner}
  </div>

<script>
  var startTime = Date.now();
  var email     = "{email_param}";
  var company   = "{company_param}";
  var baseUrl   = window.location.origin;

  function sendTimeSpent() {{
    var spent = Math.round((Date.now() - startTime) / 1000);
    if (spent > 0) {{
      navigator.sendBeacon(baseUrl + "/visit-end?email=" + encodeURIComponent(email) +
        "&company=" + encodeURIComponent(company) + "&seconds=" + spent);
    }}
  }}
  window.addEventListener("beforeunload", sendTimeSpent);
  window.addEventListener("pagehide", sendTimeSpent);

  setTimeout(function() {{
    window.location.href = "{dest}";
  }}, 1800);
</script>
</body>
</html>"""
    return html


@app.route("/visit-heartbeat", methods=["GET", "POST"])
def visit_heartbeat():
    email_param   = request.args.get("email", "").strip()
    company_param = request.args.get("company", "").strip()
    seconds_str   = request.args.get("seconds", "0").strip()
    try:
        seconds = int(seconds_str)
    except:
        seconds = 0

    if email_param and seconds > 0:
        threading.Thread(
            target=update_website_visit,
            args=(email_param, company_param, "end", seconds),
            daemon=True
        ).start()

    return "", 204


@app.route("/visit-end", methods=["GET", "POST"])
def visit_end():
    email_param   = request.args.get("email", "").strip()
    company_param = request.args.get("company", "").strip()
    seconds_str   = request.args.get("seconds", "0").strip()
    try:
        seconds = int(seconds_str)
    except:
        seconds = 0

    if email_param and seconds > 0:
        threading.Thread(
            target=update_website_visit,
            args=(email_param, company_param, "end", seconds),
            daemon=True
        ).start()

    return "", 204  # No content response


@app.route("/locate")
def locate():
    """
    Called by a hidden link in the email when opened in browser.
    Captures real IP and updates location in Excel.
    """
    from flask import redirect
    email_param   = request.args.get("email", "").strip()
    company_param = request.args.get("company", "").strip()
    client_ip = (request.headers.get("CF-Connecting-IP") or
                 request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or
                 request.remote_addr or "")

    if email_param:
        # Force location update using this real IP
        location = get_location_from_ip(client_ip)
        if location and "country" in location and not location.get("note"):
            with excel_lock:
                try:
                    wb = openpyxl.load_workbook(Config.TRACKER_FILE)
                    ws = get_master_sheet(wb)
                    headers = [cell.value for cell in ws[1]]
                    def get_or_create_col(name):
                        if name in headers:
                            return headers.index(name) + 1
                        col_idx = len(headers) + 1
                        ws.cell(row=1, column=col_idx, value=name).font = Font(bold=True)
                        headers.append(name)
                        return col_idx
                    email_col    = next((i+1 for i,h in enumerate(headers) if h and str(h).strip().lower()=="email"), None)
                    country_col  = get_or_create_col("Opened From Country")
                    city_col     = get_or_create_col("Opened From City")
                    timezone_col = get_or_create_col("Opened Timezone")
                    if email_col:
                        for row in ws.iter_rows(min_row=2):
                            if row[email_col-1].value and str(row[email_col-1].value).strip().lower() == email_param.lower():
                                r = row[0].row
                                ws.cell(row=r, column=country_col).value  = location.get("country","—")
                                ws.cell(row=r, column=city_col).value     = location.get("city","—")
                                ws.cell(row=r, column=timezone_col).value = location.get("timezone","—")
                                print(f"\n  📍 LOCATION UPDATED: {email_param} → {location.get('city')}, {location.get('country')}")
                                break
                    wb.save(Config.TRACKER_FILE)
                except Exception as e:
                    print(f"  ❌ Location update error: {e}")

    # Redirect to homepage silently
    return redirect("https://orbitavanyatech.com", code=302)


@app.route("/status")
def status():
    return {"status": "running"}, 200


@app.route("/events")
def get_events():
    """
    Serves the in-memory event log as JSON, for sync_tracking_events.py
    (or any other machine/script) to poll. Protected by a simple shared
    key in the query string -- matches TRACKING_URL's ?key=... in
    sync_tracking_events.py. Not needed for RUN_CAMPAIGN.py's own
    operation (it updates Excel directly) -- this exists purely to
    support a SEPARATE script/machine reading the same tracking data
    without direct access to this Excel file.
    """
    key = request.args.get("key", "").strip()
    if key != EVENTS_ACCESS_KEY:
        return {"error": "Invalid or missing key"}, 403
    with EVENTS_LOG_LOCK:
        return jsonify(list(EVENTS_LOG))




def start_flask():
    """Start Flask server in background thread."""
    import logging as lg
    log = lg.getLogger("werkzeug")
    log.setLevel(lg.ERROR)   # suppress Flask request logs
    app.run(host="0.0.0.0", port=Config.TRACKING_PORT, debug=False, use_reloader=False)

# ============================================================================
# SECTION 5 — START TUNNEL & GET PUBLIC URL
# ============================================================================
def start_tunnel(cf_path):
    """Start cloudflared tunnel and return public URL."""
    try:
        proc = subprocess.Popen(
            [cf_path, "tunnel", "--url", f"http://localhost:{Config.TRACKING_PORT}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )

        print("  Waiting for tunnel URL", end="", flush=True)

        # Read stderr line by line to find the full URL
        for _ in range(40):
            line = proc.stderr.readline()
            print(".", end="", flush=True)

            if not line:
                time.sleep(1)
                continue

            # cloudflared prints URL in a line like:
            # INF +----------------------------+
            # INF | https://xxxx.trycloudflare.com |
            # OR just a line containing the full URL
            import re
            match = re.search(r'https://[a-zA-Z0-9\-]+\.trycloudflare\.com', line)
            if match:
                url = match.group(0).strip()
                print()  # newline after dots
                return url, proc

        print()  # newline after dots
        print("  ⚠️  Could not auto-detect URL — trying API fallback...")

        # Fallback: try cloudflared metrics API
        time.sleep(3)
        try:
            import re
            r = requests.get("http://localhost:20241/metrics", timeout=5)
            match = re.search(r'https://[a-zA-Z0-9\-]+\.trycloudflare\.com', r.text)
            if match:
                return match.group(0).strip(), proc
        except:
            pass

        return None, proc

    except Exception as e:
        print(f"\n  ❌ Tunnel error: {e}")
        return None, None


def start_named_tunnel(cf_path):
    """
    Starts a NAMED Cloudflare Tunnel bound to your own fixed domain
    (Config.TRACKING_DOMAIN), instead of a random *.trycloudflare.com
    address that changes every run. Requires a ONE-TIME setup (see
    RUN_CAMPAIGN.py header / ask Claude for the exact steps):
      1. cloudflared tunnel login
      2. cloudflared tunnel create <CLOUDFLARE_TUNNEL_NAME>
      3. cloudflared tunnel route dns <CLOUDFLARE_TUNNEL_NAME> <TRACKING_DOMAIN>
      4. A cloudflared config.yml with an ingress rule pointing to
         http://localhost:<TRACKING_PORT>
    Once that's done, the domain is permanent -- no URL parsing needed,
    we already know exactly what it is.
    """
    try:
        proc = subprocess.Popen(
            [cf_path, "tunnel", "run", Config.CLOUDFLARE_TUNNEL_NAME],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        time.sleep(3)  # give the tunnel a moment to connect
        if proc.poll() is not None:
            # Process already exited -- something's wrong with the named
            # tunnel setup (not created, DNS not routed, config missing, etc)
            print("  ❌ Named tunnel failed to start -- check your one-time setup steps.")
            return None, None
        return f"https://{Config.TRACKING_DOMAIN}", proc
    except Exception as e:
        print(f"\n  ❌ Named tunnel error: {e}")
        return None, None

# ============================================================================
# SECTION 6 — EMAIL SENDING WITH TRACKING PIXEL
# ============================================================================
def build_tracking_pixel(recipient_email, company_name, base_url):
    url = f"{base_url}?action=track&email={quote(recipient_email, safe='')}&company={quote(company_name, safe='')}"
    return f'<img src="{url}" width="1" height="1" border="0" style="display:block;width:1px;height:1px;" alt="" />'


def build_location_beacon(recipient_email, company_name, base_url):
    locate_url = f"{base_url}?action=locate&email={quote(recipient_email, safe='')}&company={quote(company_name, safe='')}"
    return (
        f'<div style="font-size:9px;color:#cccccc;text-align:center;margin-top:20px;">'
        f'<a href="{locate_url}" style="color:#cccccc;text-decoration:none;" target="_blank">'
        f'View this email in your browser</a></div>'
    )


def inject_pixel(html_body, recipient_email, company_name, base_url):
    pixel  = build_tracking_pixel(recipient_email, company_name, base_url)
    beacon = build_location_beacon(recipient_email, company_name, base_url)
    inject = pixel + beacon
    if "</body>" in html_body.lower():
        idx = html_body.lower().rfind("</body>")
        return html_body[:idx] + inject + html_body[idx:]
    return html_body + inject

def wrap_links_with_tracking(html_body, recipient_email, company_name, base_url):
    import re

    def _replace(match):
        real_url = match.group(1)
        tracked_url = (
            f"{base_url}?action=click"
            f"&email={quote(recipient_email, safe='')}"
            f"&company={quote(company_name, safe='')}"
            f"&dest={quote(real_url, safe='')}"
        )
        return f'href="{tracked_url}"'

    pattern = re.compile(r'href="(https://(?:[a-zA-Z0-9-]+\.)?orbitavanyatech\.com(?:/[^"]*)?)"')
    return pattern.sub(_replace, html_body)


def build_translate_banner(html_body: str, target_lang: str, lang_name: str) -> str:
    """
    Adds a small 'View this email in <language>' button near the top of
    the email, using Google Translate's text-translate URL -- the email
    body itself stays in English. Which language to offer is driven by
    the lead's Country/City from the Excel sheet (via get_language_for_location),
    NOT by the recipient's own mail-client language settings -- so a
    German lead reliably gets a German option regardless of what language
    their inbox happens to be configured in.
    """
    import re
    # Rough plain-text extraction so the URL stays a sane length -- Google
    # Translate's text URL has practical length limits in most browsers.
    # IMPORTANT: strip <style>/<script> blocks INCLUDING their contents
    # first -- otherwise raw CSS/JS leaks into the translated text (a bare
    # tag-stripping regex only removes the tags, not what's between them).
    stripped = re.sub(r'(?is)<(style|script)[^>]*>.*?</\1>', ' ', html_body)
    plain_text = re.sub(r'<[^<]+?>', ' ', stripped)
    plain_text = re.sub(r'\s+', ' ', plain_text).strip()
    plain_text = plain_text[:1800]

    translate_url = (
        "https://translate.google.com/?sl=en&tl=" + quote(target_lang, safe="")
        + "&text=" + quote(plain_text, safe="") + "&op=translate"
    )
    banner = (
        f'<div style="text-align:center;margin:6px 0 18px 0;">'
        f'<a href="{translate_url}" target="_blank" rel="noopener" '
        f'style="display:inline-block;background:#f0f4f9;color:#0D5A9E !important;'
        f'text-decoration:none;font-size:12px;padding:6px 14px;border-radius:16px;'
        f'border:1px solid #cfe0f2;">🌐 View this email in {lang_name}</a></div>'
    )
    lower = html_body.lower()
    if "<body" in lower:
        idx = lower.find("<body")
        end_tag_idx = html_body.find(">", idx) + 1
        return html_body[:end_tag_idx] + banner + html_body[end_tag_idx:]
    return banner + html_body


_SMTP_LOCK = threading.Lock()
_SMTP_CONN = None


def _get_smtp():
    """Returns a shared, already-logged-in SMTP connection (reused for speed)."""
    global _SMTP_CONN
    with _SMTP_LOCK:
        if _SMTP_CONN is None:
            import smtplib
            conn = smtplib.SMTP_SSL(Config.SMTP_SERVER, Config.SMTP_PORT, timeout=60)
            conn.login(Config.SENDER_EMAIL, Config.SENDER_PASSWORD)
            _SMTP_CONN = conn
        return _SMTP_CONN


def _close_smtp():
    global _SMTP_CONN
    with _SMTP_LOCK:
        if _SMTP_CONN is not None:
            try:
                _SMTP_CONN.quit()
            except Exception:
                pass
            _SMTP_CONN = None


def send_email(recipient_email, ceo_name, company_name, subject, tracking_url, is_reminder=False, country="", city=""):
    import smtplib
    import re
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart

    try:
        # Choose template
        template_file = Path(Config.FOLLOWUP_TEMPLATE_FILE if is_reminder else Config.TEMPLATE_FILE)

        with open(template_file, "r", encoding="utf-8") as f:
            html_body = f.read()

        html_body = html_body.replace("{{CEO_Name}}", ceo_name)
        html_body = html_body.replace("{{Company_Name}}", company_name)

        # ── Always send in English. If the Excel sheet's Country/City for
        # this lead maps to a non-English language, add a small
        # "View this email in <language>" button instead of machine-
        # translating the whole body -- keeps the English wording reliable
        # and gives the recipient a one-click option, driven by the Excel
        # data rather than the recipient's own mail-client settings.
        target_lang = get_language_for_location(country, city)
        location_label = city or country or "Unknown location"
        if target_lang != "en":
            lang_name = LANGUAGE_NAMES.get(target_lang, target_lang.upper())
            print(f"  📧 {location_label} → Sending in English, with a 'view in {lang_name}' button")
            html_body = build_translate_banner(html_body, target_lang, lang_name)
        else:
            print(f"  📧 {location_label} → Sending in English")

        # Inject tracking pixel (backup method)
        if tracking_url:
            html_body = inject_pixel(html_body, recipient_email, company_name, tracking_url)
            html_body = wrap_links_with_tracking(html_body, recipient_email, company_name, tracking_url)

        plain = (f"Dear {ceo_name},\n\n"
                 f"Greetings from OrbitAvanya Tech LLP.\n\n"
                 f"Visit: https://orbitavanyatech.com\n\n"
                 f"Regards,\nOrbitAvanya Tech LLP")
        if target_lang != "en":
            lang_name = LANGUAGE_NAMES.get(target_lang, target_lang.upper())
            plain += f"\n\n(This email is in English. To read it in {lang_name}, open it in your inbox and use the 🌐 button near the top.)"

        sender_domain = Config.SENDER_EMAIL.split("@")[-1]

        msg = MIMEMultipart("alternative")
        msg["From"]                  = f"Pradeep | Orbitavanya Tech LLP <{Config.SENDER_EMAIL}>"
        msg["To"]                    = recipient_email
        msg["Subject"]               = subject
        msg["Date"]                  = formatdate(localtime=True)
        msg["Message-ID"]            = make_msgid(domain=sender_domain)
        msg["List-Unsubscribe"]      = f"<mailto:{Config.SENDER_EMAIL}?subject=unsubscribe>"
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
        msg["X-Mailer"]              = "OrbitAvanya Outreach"
        msg["X-Priority"]            = "3"
        msg["MIME-Version"]          = "1.0"
        msg.attach(MIMEText(plain, "plain"))
        msg.attach(MIMEText(html_body, "html"))

        # Reuse one logged-in SMTP connection for all emails (much faster
        # than logging in again for every single send). If the server drops
        # the connection, reconnect once and retry the send.
        try:
            _get_smtp().sendmail(Config.SENDER_EMAIL, recipient_email, msg.as_string())
        except (smtplib.SMTPServerDisconnected, ConnectionError, TimeoutError, OSError):
            _close_smtp()
            _get_smtp().sendmail(Config.SENDER_EMAIL, recipient_email, msg.as_string())

        return True, "Sent successfully"
    except Exception as e:
        return False, str(e)

# ============================================================================
# SECTION 6b — FAKE CEO EMAIL VALIDATION (free checks, no paid API)
# ============================================================================
# Every lead's email is checked BEFORE sending using multiple layers:
#   1. Syntax check  -> "fake" if the address isn't well-formed
#   2. Disposable-domain check -> "fake" for known temp-mail domains
#   3. MX record check -> "fake" if the domain has no mail server
#   4. SMTP mailbox check -> connects to the recipient's own mail server and
#      asks (RCPT TO, never sends) whether the mailbox exists. Uses the
#      sender's own credentials/config, same as everywhere else.
# Fake emails are SKIPPED and stored in the "Fake CEO Email" sheet.

DISPOSABLE_DOMAINS = {
    "mailinator.com", "10minutemail.com", "guerrillamail.com", "sharklasers.com",
    "temp-mail.org", "tempmail.com", "yopmail.com", "throwawaymail.com",
    "maildrop.cc", "getnada.com", "dispostable.com", "mailnesia.com",
    "spamgourmet.com", "trashmail.com", "emailondeck.com", "mytemp.email",
    "burnermail.io", "fakeinbox.com", "tempinbox.com", "tempr.email",
    "maileater.com", "mintemail.com", "deadaddress.com", "spam4.me",
    "mohmal.com", "emailfake.com", "mailtemp.net", "fakemail.net",
    "mailnator.com", "dropmail.me", "luxusmail.org", "spambox.us",
}

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")


def _ensure_dnspython():
    try:
        import dns.resolver
        return dns.resolver
    except ImportError:
        print("  Installing dnspython for email validation...")
        install("dnspython")
        import dns.resolver
        return dns.resolver


def _syntax_ok(email_addr):
    return bool(_EMAIL_RE.fullmatch(email_addr or ""))


def _is_disposable(domain):
    return domain in DISPOSABLE_DOMAINS


def _has_mx(domain):
    """Returns True if the domain has at least one MX (mail) record."""
    try:
        resolver = _ensure_dnspython()
        records = resolver.resolve(domain, "MX", lifetime=5)
        return len(records) > 0
    except Exception:
        return False


def _smtp_mailbox_check(email_addr, sender_email, timeout=None):
    """
    Connects to the recipient's mail server (MX host, port 25) and asks
    whether the mailbox exists via MAIL FROM / RCPT TO -- no message is ever
    sent. A rejection (5xx) is retried up to 2 extra times with a short
    pause, because many servers temporarily reject verification attempts
    (greylisting / anti-verification). Only a CONSISTENT rejection marks
    the mailbox fake. Returns:
        True  -> mailbox exists (250/251/252)
        False -> mailbox consistently rejected (5xx: 550/551/552/553/554)
        None  -> server refused to answer or network error (unknown)
    """
    timeout = timeout or Config.SMTP_CHECK_TIMEOUT
    import smtplib
    domain = email_addr.split("@")[-1]
    mx_host = domain
    try:
        resolver = _ensure_dnspython()
        mx = sorted(resolver.resolve(domain, "MX", lifetime=5),
                    key=lambda r: r.preference)[0]
        mx_host = str(mx.exchange).rstrip(".")
    except Exception:
        pass  # fall back to connecting to the domain itself

    def _one_attempt():
        try:
            server = smtplib.SMTP(mx_host, 25, timeout=timeout)
            try:
                code, _ = server.ehlo()
                if code >= 400:
                    server.quit()
                    return None
            except Exception:
                try:
                    server.helo()
                except Exception:
                    server.quit()
                    return None
            code, _ = server.mail(sender_email)
            if code not in (250, 251):
                server.quit()
                return None
            code, _ = server.rcpt(email_addr)
            server.quit()
            if code in (250, 251, 252):
                return True
            if code in (550, 551, 552, 553, 554):
                return False
            return None
        except Exception:
            return None

    result = _one_attempt()
    if result is not False:
        return result
    # Rejection -- retry twice (servers often reject verification attempts
    # once, then accept on the next try if the mailbox really exists).
    for _ in range(2):
        time.sleep(1.5)
        result = _one_attempt()
        if result is not False:
            return result
    return False


def validate_email(email_addr, sender_email):
    """
    Multi-layer free email validation (no paid API). Returns
    (verdict, reason) where verdict is "real", "fake" or "unknown".
    Only a verified FAKE address is blocked -- "unknown" still sends.
    """
    email_addr = (email_addr or "").strip()
    if not _syntax_ok(email_addr):
        return "fake", "Invalid email format"
    domain = email_addr.split("@")[-1].lower()
    if _is_disposable(domain):
        return "fake", f"Disposable/temp-mail domain ({domain})"
    if not _has_mx(domain):
        return "fake", f"No mail server (MX record) for {domain}"
    result = _smtp_mailbox_check(email_addr, sender_email)
    if result is True:
        return "real", "SMTP verified — mailbox exists"
    if result is False:
        return "fake", "Mail server rejected the mailbox (does not exist)"
    return "unknown", "Mail server did not answer — sent anyway"


# ============================================================================
# SECTION 7 — SAVE TO TRACKER EXCEL
# ============================================================================
# Records are queued in memory and written to Excel in batches -- saving the
# workbook once per email is very slow, so the file is only touched every
# PENDING_FLUSH_SIZE records (plus one final flush at the end of the run).
PENDING_RECORDS    = {}   # email(lower) -> {"col_map": {...}, "full": {...}}
PENDING_FAKE_RECORDS = []  # fake CEO emails -> written to the "Fake CEO Email" sheet
PENDING_FLUSH_SIZE = 10

DEFAULT_HEADERS = [
    "Company", "Contact Person", "Email", "Subject", "Template", "Sent Date",
    "Email Sent In Language",
    "Email Open Status", "Email Opened At",
    "Email Open Count", "Link Clicked", "Link Clicked At", "Link Click Count",
    "Opened From Country", "Opened From City", "Opened Timezone",
    "Website Visits", "Total Time on Website", "Last Visit At",
    "Email Send Status", "Send Error",
    "Reply Received", "Reply Date", "Reply Subject",
    "Reminder Due", "Reminder Sent",
]

# Columns for the "Fake CEO Email" sheet (ALL details of the skipped fake
# lead). Any extra column found in the leads Excel is added automatically.
FAKE_HEADERS = [
    "Company", "Contact Person", "Email", "Subject",
    "Country", "City",
    "Region", "Time Zone", "Country Size", "Major Industries",
    "Company Size", "No Of Employees", "Category Type", "Category",
    "Company URL", "Company Email", "Company Ph No",
    "CEO Status", "CEO Found On", "CEO Note",
    "Lead Email Status", "Lead Email Note",
    "Company Email Status", "Company Email Note",
    "Email Send Status", "Validation Reason", "Validated At",
]


def get_fake_sheet(wb):
    """Returns (creating if needed) the 'Fake CEO Email' sheet."""
    if "Fake CEO Email" in wb.sheetnames:
        return wb["Fake CEO Email"]
    ws = wb.create_sheet("Fake CEO Email")
    for j, h in enumerate(FAKE_HEADERS, start=1):
        ws.cell(row=1, column=j, value=h).font = Font(bold=True)
    return ws


def save_fake_email_record(company, contact_person, email_addr, subject,
                           country="", city="", reason="", extra=None):
    """
    Queues a fake CEO email record; it is written to the "Fake CEO Email"
    sheet in batches (same fast mechanism as normal records). If the same
    fake email is found again in a later run, its row is UPDATED, not
    duplicated. `extra` may contain ALL remaining fields of the lead row
    (Region, Company URL, Phone, CEO Status, notes, etc.) -- each one
    becomes its own column in the sheet.
    """
    record = {
        "Company":            company,
        "Contact Person":     contact_person,
        "Email":              email_addr,
        "Subject":            subject,
        "Country":            country,
        "City":               city,
    }
    if extra:
        for k, v in extra.items():
            if k not in record:
                record[k] = v
    record["Email Send Status"] = "Fake"
    record["Validation Reason"] = reason
    record["Validated At"]      = datetime.now().strftime("%d-%m-%Y %H:%M:%S")
    PENDING_FAKE_RECORDS.append(record)
    if len(PENDING_FAKE_RECORDS) + len(PENDING_RECORDS) >= PENDING_FLUSH_SIZE:
        flush_saved_records()


def _style_send_status(ws, row_num, status_col_idx, status):
    sc = ws.cell(row=row_num, column=status_col_idx)
    if status == "Sent":
        sc.fill = PatternFill("solid", fgColor="D9EAD3")
        sc.font = Font(color="276221", bold=True)
    else:
        sc.fill = PatternFill("solid", fgColor="F4CCCC")
        sc.font = Font(color="990000", bold=True)


def save_email_record(company, contact_person, email_addr, subject, country="", city="",
                       language="English", status="Sent", error="", template=""):
    """
    Queues a sent/failed-email record in memory; the actual Excel write
    happens in batches via flush_saved_records() (much faster than saving
    the workbook once per email). If this email already has a row, that
    row is UPDATED instead of creating a duplicate (so tracking always
    points to ONE row). The master "Total Sent" sheet is append-only --
    rows from EVERY run are kept forever, so totals keep adding up.
    """
    now = datetime.now()
    col_map = {
        "Company":            company,
        "Contact Person":     contact_person,
        "Email":              email_addr,
        "Subject":            subject,
        "Template":           template or "—",
        "Email Send Status":  status,
        "Send Error":         error if status == "Failed" else "—",
        "Sent Date":          now.strftime("%d-%m-%Y"),   # attempt date for BOTH sent & failed
    }
    if status == "Sent":
        col_map["Reminder Due"]              = (now + timedelta(days=2)).strftime("%d-%m-%Y")
        col_map["Email Sent In Language"]    = language

    full_row = {
        **col_map,
        "Sent Date":              col_map.get("Sent Date", "—"),
        "Email Sent In Language": col_map.get("Email Sent In Language", "—"),
        "Reply Received":         "No",
        "Reply Date":             "—",
        "Reply Subject":          "—",
        "Reminder Due":           col_map.get("Reminder Due", "—"),
        "Reminder Sent":          "No",
        "Email Open Status":      "Not Opened",
        "Email Opened At":        "—",
        "Email Open Count":       0,
        "Link Clicked":           "No",
        "Link Clicked At":        "—",
        "Link Click Count":       0,
        "Opened From Country":    "—",
        "Opened From City":       "—",
        "Opened Timezone":        "—",
        "Website Visits":         0,
        "Total Time on Website":  "0 sec",
        "Last Visit At":          "—",
    }

    PENDING_RECORDS[email_addr.strip().lower()] = {"col_map": col_map, "full": full_row}
    if len(PENDING_RECORDS) >= PENDING_FLUSH_SIZE:
        flush_saved_records()


def reset_current_sheet():
    """
    Prunes the current-run "Current Sent" sheet so it shows only emails from
    the LAST 15 DAYS (header row is kept). Rows older than 15 days are
    removed from this sheet; the "Total Sent" master sheet is never touched
    and keeps ALL data from every run, past and future.
    """
    try:
        if not os.path.exists(Config.TRACKER_FILE):
            return
        wb = openpyxl.load_workbook(Config.TRACKER_FILE)
        ws = get_current_sheet(wb)

        if ws.max_row > 1:
            headers = [cell.value for cell in ws[1]]
            date_col = headers.index("Sent Date") + 1 if "Sent Date" in headers else None

            cutoff = datetime.now().date() - timedelta(days=15)
            rows_to_delete = []
            if date_col:
                for row in ws.iter_rows(min_row=2):
                    val = row[date_col - 1].value
                    if val is None or val == "—":
                        continue  # keep rows without a date
                    if isinstance(val, datetime):
                        row_date = val.date()
                    else:
                        try:
                            row_date = datetime.strptime(str(val).strip(), "%d-%m-%Y").date()
                        except ValueError:
                            continue  # unreadable date — keep the row
                    if row_date < cutoff:
                        rows_to_delete.append(row[0].row)

            for r in reversed(rows_to_delete):
                ws.delete_rows(r)

        wb.save(Config.TRACKER_FILE)
        print("  📋 'Current Sent' sheet will show only emails from the last 15 days (Total Sent keeps everything)")
    except PermissionError:
        print(f"  ⚠️  Could not update 'Sent' sheet — close {Path(Config.TRACKER_FILE).name} in Excel first!")
    except Exception as e:
        print(f"  ❌ Could not update 'Sent' sheet: {e}")


def flush_saved_records():
    """Writes every queued record into Email_Tracking_NEW.xlsx in one pass."""
    if not PENDING_RECORDS and not PENDING_FAKE_RECORDS:
        return
    records = dict(PENDING_RECORDS)
    PENDING_RECORDS.clear()
    fakes = list(PENDING_FAKE_RECORDS)
    PENDING_FAKE_RECORDS.clear()

    try:
        if os.path.exists(Config.TRACKER_FILE):
            wb = openpyxl.load_workbook(Config.TRACKER_FILE)
            ws = get_master_sheet(wb)
            headers = [cell.value for cell in ws[1]]
        else:
            wb = openpyxl.Workbook()
            ws = get_master_sheet(wb)
            headers = list(DEFAULT_HEADERS)
            ws.append(headers)

        def get_or_create_col(name):
            if name in headers:
                return headers.index(name) + 1
            col_idx = len(headers) + 1
            ws.cell(row=1, column=col_idx, value=name).font = Font(bold=True)
            headers.append(name)
            return col_idx

        email_col  = get_or_create_col("Email")
        status_col = get_or_create_col("Email Send Status")

        # Existing rows on the master sheet (from ANY earlier run)
        row_by_email = {}
        for row in ws.iter_rows(min_row=2):
            cell_val = row[email_col - 1].value
            if cell_val:
                row_by_email[str(cell_val).strip().lower()] = row[0].row

        # Current-run "Current Sent" sheet
        current_ws = get_current_sheet(wb)
        current_headers = [cell.value for cell in current_ws[1]]
        if not current_headers or not current_headers[0]:
            current_headers = headers
            for j, h in enumerate(current_headers, start=1):
                current_ws.cell(row=1, column=j, value=h).font = Font(bold=True)

        def cur_col(name):
            if name in current_headers:
                return current_headers.index(name) + 1
            ci = len(current_headers) + 1
            current_ws.cell(row=1, column=ci, value=name).font = Font(bold=True)
            current_headers.append(name)
            return ci

        cur_status_col = cur_col("Email Send Status")
        cur_email_col  = cur_col("Email")
        cur_row_by_email = {}
        for row in current_ws.iter_rows(min_row=2):
            cell_val = row[cur_email_col - 1].value
            if cell_val:
                cur_row_by_email[str(cell_val).strip().lower()] = row[0].row

        for email_key, rec in records.items():
            col_map     = rec["col_map"]
            email_display = col_map["Email"]

            if email_key in row_by_email:
                row_num = row_by_email[email_key]
                for col_name, value in col_map.items():
                    ws.cell(row=row_num, column=get_or_create_col(col_name), value=value)
                _style_send_status(ws, row_num, status_col, col_map["Email Send Status"])
                print(f"  ↻ Updated existing record for {email_display} (no duplicate row created)")
            else:
                row_num = ws.max_row + 1
                for col_name, value in rec["full"].items():
                    ws.cell(row=row_num, column=get_or_create_col(col_name), value=value)
                _style_send_status(ws, row_num, status_col, col_map["Email Send Status"])
                row_by_email[email_key] = row_num

            # Current Sent — same dedupe: update existing row, never append a
            # second row for the same email (fixes duplicate rows on re-runs)
            if email_key in cur_row_by_email:
                cur_row = cur_row_by_email[email_key]
                for col_name, value in col_map.items():
                    current_ws.cell(row=cur_row, column=cur_col(col_name), value=value)
                _style_send_status(current_ws, cur_row, cur_status_col, col_map["Email Send Status"])
            else:
                cur_row = current_ws.max_row + 1
                for col_name, value in col_map.items():
                    current_ws.cell(row=cur_row, column=cur_col(col_name), value=value)
                _style_send_status(current_ws, cur_row, cur_status_col, col_map["Email Send Status"])
                cur_row_by_email[email_key] = cur_row

        wb.save(Config.TRACKER_FILE)

        # ── Fake CEO Email sheet (skipped fake emails, one pass) ─────────
        if fakes:
            fake_ws = get_fake_sheet(wb)
            fake_headers = [cell.value for cell in fake_ws[1]]

            def fake_col(name):
                if name in fake_headers:
                    return fake_headers.index(name) + 1
                ci = len(fake_headers) + 1
                fake_ws.cell(row=1, column=ci, value=name).font = Font(bold=True)
                fake_headers.append(name)
                return ci

            fake_email_col = fake_col("Email")
            fake_row_by_email = {}
            for row in fake_ws.iter_rows(min_row=2):
                val = row[fake_email_col - 1].value
                if val:
                    fake_row_by_email[str(val).strip().lower()] = row[0].row

            for rec in fakes:
                fkey = str(rec["Email"]).strip().lower()
                if fkey in fake_row_by_email:
                    row_num = fake_row_by_email[fkey]
                    for col_name, value in rec.items():
                        fake_ws.cell(row=row_num, column=fake_col(col_name), value=value)
                    print(f"  ↻ Updated existing fake record for {rec['Email']}")
                else:
                    row_num = fake_ws.max_row + 1
                    for col_name, value in rec.items():
                        fake_ws.cell(row=row_num, column=fake_col(col_name), value=value)
                    fake_row_by_email[fkey] = row_num
                    print(f"  🚫 Stored fake email record: {rec['Email']} → 'Fake CEO Email' sheet")
            wb.save(Config.TRACKER_FILE)

        print(f"  💾 Tracker updated: {len(records)} record(s) → {Path(Config.TRACKER_FILE).name}")
    except PermissionError:
        print(f"  ⚠️  COULD NOT SAVE! Close {Path(Config.TRACKER_FILE).name} in Excel first!")
        PENDING_RECORDS.update(records)   # keep records so a later flush retries
        PENDING_FAKE_RECORDS.extend(fakes)
    except Exception as e:
        print(f"  ❌ Could not save records: {e}")
        PENDING_RECORDS.update(records)
        PENDING_FAKE_RECORDS.extend(fakes)


def update_campaign_summary(results: dict, total_leads: int):
    """
    Rebuilds the 'Summary' sheet with TRUE TOTALS ACROSS ALL RUNS --
    computed from the master "Total Sent" sheet, which is append-only and
    keeps every email ever sent. Earlier runs are never overwritten, so
    this always shows ALL data, not just the latest run. The latest run's
    own counts are shown separately.
    Returns {"sent": ..., "failed": ..., "bounced": ..., "total": ...}.
    """
    sent_all = failed_all = bounced_all = rows_all = fake_all = 0
    by_date = {}   # date -> [sent_count, failed_count]

    try:
        if os.path.exists(Config.TRACKER_FILE):
            src_wb = openpyxl.load_workbook(Config.TRACKER_FILE, data_only=True)
            src_ws = get_master_sheet(src_wb)
            src_headers = [cell.value for cell in src_ws[1]]
            if "Email Send Status" in src_headers:
                s_idx = src_headers.index("Email Send Status")
                d_idx = src_headers.index("Sent Date") if "Sent Date" in src_headers else None

                def _date_key(dval):
                    if dval is None or str(dval).strip() in ("", "—"):
                        return None
                    if isinstance(dval, datetime):
                        return dval.date()
                    try:
                        return datetime.strptime(str(dval).strip(), "%d-%m-%Y").date()
                    except ValueError:
                        return None

                for row in src_ws.iter_rows(min_row=2, values_only=True):
                    if not row or not any(v is not None for v in row):
                        continue
                    rows_all += 1
                    st = str(row[s_idx]).strip() if len(row) > s_idx and row[s_idx] is not None else ""
                    d_key = _date_key(row[d_idx]) if d_idx is not None and len(row) > d_idx else None
                    if st == "Sent":
                        sent_all += 1
                        if d_key is not None:
                            by_date.setdefault(d_key, [0, 0])[0] += 1
                    elif st == "Failed":
                        failed_all += 1
                        if d_key is not None:
                            by_date.setdefault(d_key, [0, 0])[1] += 1
                    elif st == "Bounced":
                        bounced_all += 1

            # Count fake CEO emails stored in the "Fake CEO Email" sheet
            if "Fake CEO Email" in src_wb.sheetnames:
                fake_ws = src_wb["Fake CEO Email"]
                fake_headers = [cell.value for cell in fake_ws[1]]
                if "Email" in fake_headers:
                    e_idx = fake_headers.index("Email")
                    for row in fake_ws.iter_rows(min_row=2, values_only=True):
                        if len(row) > e_idx and row[e_idx]:
                            fake_all += 1

        wb = (openpyxl.load_workbook(Config.TRACKER_FILE)
              if os.path.exists(Config.TRACKER_FILE) else openpyxl.Workbook())

        if "Summary" in wb.sheetnames:
            ws = wb["Summary"]
            if ws.max_row > 1:
                ws.delete_rows(2, ws.max_row - 1)
        else:
            ws = wb.create_sheet("Summary")

        ws["A1"] = "Metric"
        ws["B1"] = "Value"
        for ref in ("A1", "B1"):
            ws[ref].font = Font(bold=True)

        summary_rows = [
            ("Last Updated",               datetime.now().strftime("%d-%m-%Y %H:%M:%S")),
            ("Total Leads (All Runs)",     rows_all),
            ("Emails Sent (All Runs)",     sent_all),
            ("Emails Failed (All Runs)",   failed_all),
            ("Emails Bounced (All Runs)",  bounced_all),
            ("Fake CEO Emails Skipped (All Runs)", fake_all),
            ("Sent This Run",              results.get("sent", 0)),
            ("Failed This Run",            results.get("failed", 0)),
            ("Skipped This Run",           results.get("skipped", 0)),
            ("Fake Skipped This Run",      results.get("fake", 0)),
        ]
        for i, (label, value) in enumerate(summary_rows, start=2):
            ws.cell(row=i, column=1, value=label).font = Font(bold=True)
            vc = ws.cell(row=i, column=2, value=value)
            if "Sent" in label:
                vc.fill = PatternFill("solid", fgColor="D9EAD3")
                vc.font = Font(color="276221", bold=True)
            elif "Failed" in label:
                vc.fill = PatternFill("solid", fgColor="F4CCCC")
                vc.font = Font(color="990000", bold=True)

        # ── Date-wise breakdown: how many sent / failed on each date ────
        if by_date:
            r = 2 + len(summary_rows) + 1   # leave one blank row
            ws.cell(row=r, column=1, value="Emails By Date").font = Font(bold=True, size=11)
            r += 1
            ws.cell(row=r, column=1, value="Date").font = Font(bold=True)
            ws.cell(row=r, column=2, value="Emails Sent").font = Font(bold=True)
            ws.cell(row=r, column=3, value="Emails Failed").font = Font(bold=True)
            r += 1
            for d_key in sorted(by_date.keys(), reverse=True):
                ws.cell(row=r, column=1, value=d_key.strftime("%d-%m-%Y"))
                sent_n, failed_n = by_date[d_key]
                sv = ws.cell(row=r, column=2, value=sent_n)
                sv.fill = PatternFill("solid", fgColor="E2EFDA")
                sv.font = Font(color="276221")
                fv = ws.cell(row=r, column=3, value=failed_n)
                fv.fill = PatternFill("solid", fgColor="F4CCCC")
                fv.font = Font(color="990000")
                r += 1

        ws.column_dimensions["A"].width = 28
        ws.column_dimensions["B"].width = 16
        ws.column_dimensions["C"].width = 16
        wb.save(Config.TRACKER_FILE)
    except Exception as e:
        print(f"  ❌ Could not update summary sheet: {e}")

    if by_date:
        print("  📅 Emails by date:")
        for d_key in sorted(by_date.keys(), reverse=True):
            sent_n, failed_n = by_date[d_key]
            print(f"     {d_key.strftime('%d-%m-%Y')}: {sent_n} sent, {failed_n} failed")

    return {"sent": sent_all, "failed": failed_all, "bounced": bounced_all,
            "total": rows_all, "fake": fake_all}

# ============================================================================
# SECTION 8 — REPLY TRACKER
# ============================================================================
def send_due_reminders(tracking_url: str):
    """
    Sends follow-up/reminder emails to leads whose 'Reminder Due' date has
    passed and who haven't replied yet.

    IMPORTANT: the language of the reminder is chosen using the lead's REAL,
    ACTUALLY-DETECTED location -- 'Opened From Country' / 'Opened From City'
    -- captured from their IP when they opened the first email or clicked
    the tracking link. This is the only point in the whole flow where we
    genuinely know where the person currently is.

    If they never opened/clicked anything, we fall back to a fresh
    email-domain lookup, then finally to the default sender language.
    """
    if not os.path.exists(Config.TRACKER_FILE):
        return

    print("\n  Checking for reminders due...")
    try:
        wb = openpyxl.load_workbook(Config.TRACKER_FILE)
        ws = get_master_sheet(wb)
        headers = [c.value for c in ws[1]]

        def col(name):
            return headers.index(name) + 1 if name in headers else None

        c_company   = col("Company")
        c_contact   = col("Contact Person")
        c_email     = col("Email")
        c_status    = col("Email Send Status")
        c_reply     = col("Reply Received")
        c_due       = col("Reminder Due")
        c_rsent     = col("Reminder Sent")
        c_open_country = col("Opened From Country")
        c_open_city    = col("Opened From City")

        if not all([c_company, c_contact, c_email, c_status, c_due, c_rsent]):
            print("  ⚠️  Tracker is missing required columns for reminders — skipping.")
            return

        today = datetime.now().date()
        sent_count = 0

        for row in ws.iter_rows(min_row=2):
            row_num = row[0].row
            status  = ws.cell(row=row_num, column=c_status).value
            reply   = ws.cell(row=row_num, column=c_reply).value if c_reply else "No"
            rsent   = ws.cell(row=row_num, column=c_rsent).value
            due_val = ws.cell(row=row_num, column=c_due).value

            if status != "Sent" or rsent == "Yes" or reply == "Yes" or not due_val or due_val == "—":
                continue

            try:
                due_date = datetime.strptime(str(due_val), "%d-%m-%Y").date()
            except ValueError:
                continue
            if due_date > today:
                continue  # not due yet

            company_name = ws.cell(row=row_num, column=c_company).value or ""
            ceo_name     = ws.cell(row=row_num, column=c_contact).value or ""
            email_addr   = ws.cell(row=row_num, column=c_email).value or ""
            if not email_addr:
                continue

            # ── Location fallback chain, most-trusted first ────────────────
            # 1) Real detected location from an actual click (most trustworthy)
            real_country = ws.cell(row=row_num, column=c_open_country).value if c_open_country else None
            real_city    = ws.cell(row=row_num, column=c_open_city).value if c_open_city else None

            if real_country and real_country != "—":
                country, city = real_country, (real_city if real_city and real_city != "—" else "")
                print(f"  📍 {company_name}: using REAL detected location ({city or '—'}, {country}) for reminder")
            else:
                # 2) Re-try domain-based detection (in case it wasn't used originally)
                detected = detect_client_location_from_domain(email_addr)
                if detected.get("country"):
                    country, city = detected.get("country", ""), detected.get("city", "")
                    print(f"  📍 {company_name}: no click yet — using email-domain location ({city or '—'}, {country}) for reminder")
                # 3) Last resort: unknown -- send_email/get_language_for_location falls back to sender's own location
                else:
                    country, city = "", ""
                    print(f"  📍 {company_name}: no location signal available — using default language for reminder")

            subject = Config.FOLLOWUP_SUBJECT.format(company_name=company_name)
            success, message = send_email(email_addr, ceo_name, company_name, subject,
                                           tracking_url, is_reminder=True,
                                           country=country, city=city)
            if success:
                ws.cell(row=row_num, column=c_rsent, value="Yes")
                sent_count += 1
                print(f"  ✅ Reminder sent to {email_addr}")
            else:
                print(f"  ❌ Reminder failed for {email_addr}: {message}")

        refresh_derived_sheets(wb, headers)
        wb.save(Config.TRACKER_FILE)
        if sent_count:
            print(f"  ✅ Reminder check done. Sent {sent_count} reminder(s).")
        else:
            print("  ✅ Reminder check done. None due right now.")
        regenerate_sent_bounced_report()
    except Exception as e:
        print(f"  ❌ Could not process reminders: {e}")


BOUNCE_SENDER_HINTS = ("mailer-daemon", "postmaster", "mail delivery subsystem",
                       "mail delivery system", "mailerdaemon")
BOUNCE_SUBJECT_HINTS = ("undelivered", "delivery status notification",
                        "returned mail", "delivery failure", "failure notice",
                        "undeliverable", "delivery has failed", "mail delivery failed")

# ── Meeting-link auto-scheduler: replies containing any of these words are
# treated as a positive/booking signal and get an automatic reply with the
# Calendly/meeting link (see Config.MEETING_LINK).
MEETING_POSITIVE_RE = re.compile(
    r"\b(yes|sure|ok|okay|interested|absolutely|great|happy to|glad|keen|"
    r"available|let'?s talk|call|meeting|schedule|book|good time|discuss|"
    r"connect|sounds good|works for me|would love|looking forward|want to)\b",
    re.I)


def send_meeting_reply(recipient_email, company_name, ceo_name, meeting_link):
    """Sends an automatic reply with the meeting link when a lead replies
    positively (yes / call / meeting / schedule …). Reuses the shared SMTP
    connection, same as send_email()."""
    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart
    try:
        ceo = ceo_name or "there"
        subject = f"Re: Scheduling our call — {company_name or 'OrbitAvanya'}"
        html = (
            "<html><body style=\"font-family:Arial,sans-serif;color:#222;font-size:14px;line-height:1.6\">"
            f"<p>Dear {ceo},</p>"
            "<p>Wonderful to hear from you! Thank you for your interest in working "
            "with OrbitAvanya Tech LLP.</p>"
            "<p>You can pick the time that suits you best here:<br>"
            f"<a href=\"{meeting_link}\" style=\"color:#0D5A9E\">▶ Schedule a meeting — {meeting_link}</a></p>"
            "<p>Alternatively, just reply with a time that works for you and I will confirm it.</p>"
            "<p>Best regards,<br>Pradeep Kumar<br>OrbitAvanya Tech LLP<br>+91 70219 50643<br>"
            "<a href=\"mailto:info@orbitavanyatech.com\">info@orbitavanyatech.com</a></p>"
            "</body></html>"
        )
        plain = (
            f"Dear {ceo},\n\n"
            "Wonderful to hear from you! Thank you for your interest in working "
            "with OrbitAvanya Tech LLP.\n\n"
            f"You can pick the time that suits you best here: {meeting_link}\n\n"
            "Alternatively, just reply with a time that works for you and I will confirm it.\n\n"
            "Best regards,\nPradeep Kumar\nOrbitAvanya Tech LLP\n+91 70219 50643\n"
            "info@orbitavanyatech.com"
        )
        msg = MIMEMultipart("alternative")
        msg["From"]       = f"Pradeep | Orbitavanya Tech LLP <{Config.SENDER_EMAIL}>"
        msg["To"]         = recipient_email
        msg["Subject"]    = subject
        msg["Date"]       = formatdate(localtime=True)
        msg["Message-ID"] = make_msgid(domain=Config.SENDER_EMAIL.split("@")[-1])
        msg.attach(MIMEText(plain, "plain"))
        msg.attach(MIMEText(html, "html"))
        try:
            _get_smtp().sendmail(Config.SENDER_EMAIL, recipient_email, msg.as_string())
        except (smtplib.SMTPServerDisconnected, ConnectionError, TimeoutError, OSError):
            _close_smtp()
            _get_smtp().sendmail(Config.SENDER_EMAIL, recipient_email, msg.as_string())
        return True, "Sent successfully"
    except Exception as e:
        return False, str(e)


def check_replies():
    """Check inbox for replies and bounces, and update tracker Excel using openpyxl (preserves formatting)."""
    print("\n  Checking for replies...")
    try:
        # ── Connect to IMAP ──────────────────────────────────────────────────
        mail = imaplib.IMAP4_SSL(Config.IMAP_SERVER, Config.IMAP_PORT)
        mail.login(Config.SENDER_EMAIL, Config.SENDER_PASSWORD)
        mail.select("INBOX")

        # ── Load tracker with openpyxl (preserves all formatting/colors) ─────
        if not os.path.exists(Config.TRACKER_FILE):
            print("  ⚠️  Tracker file not found. Run campaign first.")
            return

            wb = openpyxl.load_workbook(Config.TRACKER_FILE)
            ws = get_master_sheet(wb)
            headers = [cell.value for cell in ws[1]]

        def get_col(name):
            return headers.index(name) + 1 if name in headers else None

        email_col         = get_col("Email")
        reply_col         = get_col("Reply Received")
        reply_date_col    = get_col("Reply Date")
        reply_subject_col = None

        # Add Reply Subject column if missing
        if "Reply Subject" not in headers:
            reply_subject_col = len(headers) + 1
            ws.cell(row=1, column=reply_subject_col, value="Reply Subject").font = Font(bold=True)
            headers.append("Reply Subject")
        else:
            reply_subject_col = get_col("Reply Subject")

        # ── Meeting-link columns (auto-scheduler) ──────────────────────────
        def ensure_col(name):
            if name in headers:
                return get_col(name)
            ci = len(headers) + 1
            ws.cell(row=1, column=ci, value=name).font = Font(bold=True)
            headers.append(name)
            return ci

        meet_requested_col = ensure_col("Meeting Requested")
        meet_sent_col      = ensure_col("Meeting Link Sent")
        meet_date_col      = ensure_col("Meeting Link Date")
        meet_note_col      = ensure_col("Meeting Link Note")

        if not email_col:
            print("  ❌ No Email column found in tracker.")
            return

        # Build dict of email → row number for fast lookup
        email_row_map = {}
        for row in ws.iter_rows(min_row=2):
            cell_val = row[email_col - 1].value
            if cell_val:
                email_row_map[str(cell_val).strip().lower()] = row[0].row

        # ── Search inbox for recent emails only ──────────────────────────────
        # Re-scanning the ENTIRE inbox history every 5 minutes gets slower
        # every day the campaign runs. A rolling 30-day window comfortably
        # covers the 2-day reminder window plus a wide grace period for late
        # replies, while keeping each check fast regardless of inbox size.
        since_date = (datetime.now() - timedelta(days=30)).strftime("%d-%b-%Y")
        _, messages = mail.search(None, f'(SINCE "{since_date}")')
        mail_ids    = messages[0].split()
        reply_count  = 0
        bounce_count = 0

        print(f"  Scanning {len(mail_ids)} emails in inbox...")

        for mail_id in reversed(mail_ids):
            try:
                _, header_data = mail.fetch(mail_id, "(BODY[HEADER.FIELDS (FROM SUBJECT DATE)])")
                if not header_data or not header_data[0]:
                    continue

                raw_header = header_data[0][1] if isinstance(header_data[0], tuple) else b""
                msg_header = email.message_from_bytes(raw_header)

                sender  = parseaddr(msg_header.get("From", ""))[1].strip().lower()
                subject = str(msg_header.get("Subject", "")).strip()

                # ── BOUNCE CHECK — before the reply check, since a bounce
                # notification is from "Mail Delivery System" etc, not the
                # actual recipient, and must never be logged as their reply.
                is_bounce = (
                    any(hint in sender for hint in BOUNCE_SENDER_HINTS) or
                    any(hint in subject.lower() for hint in BOUNCE_SUBJECT_HINTS)
                )
                if is_bounce:
                    try:
                        _, body_data = mail.fetch(mail_id, "(BODY[TEXT])")
                        raw_body = body_data[0][1] if body_data and body_data[0] else b""
                        body_text = raw_body.decode("utf-8", errors="ignore")
                    except Exception:
                        body_text = ""

                    candidates = re.findall(r'[\w\.\-+]+@[\w\-]+\.[\w\.\-]+', body_text)
                    matched_row = None
                    matched_email = None
                    for candidate in candidates:
                        candidate_l = candidate.strip().lower()
                        if candidate_l in email_row_map and candidate_l != Config.SENDER_EMAIL.lower():
                            matched_row = email_row_map[candidate_l]
                            matched_email = candidate_l
                            break

                    if matched_row:
                        status_col = get_col("Email Send Status")
                        error_col  = get_col("Send Error")
                        current_status = ""
                        if status_col:
                            current_status = str(ws.cell(row=matched_row, column=status_col).value or "").strip()
                        if current_status in ("Sent", "Bounced"):
                            pass  # skip — already sent successfully or already recorded as bounced
                        else:
                            if status_col:
                                sc = ws.cell(row=matched_row, column=status_col)
                                sc.value = "Bounced"
                                sc.fill  = PatternFill("solid", fgColor="F4CCCC")
                                sc.font  = Font(color="990000", bold=True)
                            if error_col:
                                ws.cell(row=matched_row, column=error_col).value = (subject or "Delivery failed")[:200]
                            # Copy row to Bounced sheet
                            bounced_ws = get_bounced_sheet(wb)
                            bounced_headers = [cell.value for cell in bounced_ws[1]] if bounced_ws.max_row > 0 else []
                            row_data = {}
                            for cell in ws[matched_row]:
                                if cell.column <= len(headers):
                                    col_name = headers[cell.column - 1]
                                    row_data[col_name] = cell.value
                            if not bounced_headers:
                                bounced_headers = headers
                                for i, h in enumerate(bounced_headers, start=1):
                                    bounced_ws.cell(row=1, column=i, value=h).font = Font(bold=True)
                            bounced_row_num = bounced_ws.max_row + 1
                            for i, h in enumerate(bounced_headers, start=1):
                                if h in row_data:
                                    bounced_ws.cell(row=bounced_row_num, column=i, value=row_data[h])
                            bounce_count += 1
                            print(f"  📭 BOUNCE detected for {matched_email}: {subject}")
                    continue  # never treat a bounce as a reply

                if sender in email_row_map:
                    row_num = email_row_map[sender]

                    # Check if already marked as replied
                    current_status = ws.cell(row=row_num, column=reply_col).value if reply_col else None
                    if current_status == "Yes":
                        continue  # already recorded

                    # Update Reply Received
                    if reply_col:
                        rc = ws.cell(row=row_num, column=reply_col)
                        rc.value = "Yes"
                        rc.fill  = PatternFill("solid", fgColor="C6EFCE")
                        rc.font  = Font(color="276221", bold=True)

                    # Update Reply Date
                    if reply_date_col:
                        ws.cell(row=row_num, column=reply_date_col).value = datetime.now().strftime("%d-%m-%Y %H:%M")

                    # Update Reply Subject
                    if reply_subject_col:
                        ws.cell(row=row_num, column=reply_subject_col).value = subject

                    # ── Meeting-link auto-scheduler ─────────────────────────
                    # Positive reply (yes/call/meeting/…) → flag the lead and,
                    # if enabled, auto-reply with the Calendly/meeting link.
                    try:
                        _, body_data = mail.fetch(mail_id, "(BODY[TEXT])")
                        raw_body = body_data[0][1] if body_data and body_data[0] else b""
                        body_text = raw_body.decode("utf-8", errors="ignore")
                    except Exception:
                        body_text = ""
                    if MEETING_POSITIVE_RE.search(body_text or ""):
                        ws.cell(row=row_num, column=meet_requested_col).value = "Yes"
                        ws.cell(row=row_num, column=meet_date_col).value = datetime.now().strftime("%d-%m-%Y %H:%M")
                        if Config.MEETING_AUTO_REPLY and Config.MEETING_LINK:
                            company_name_r = str(ws.cell(row=row_num, column=get_col("Company")).value or "") if get_col("Company") else ""
                            ceo_name_r     = str(ws.cell(row=row_num, column=get_col("Contact Person")).value or "") if get_col("Contact Person") else ""
                            ok_m, msg_m = send_meeting_reply(sender, company_name_r, ceo_name_r, Config.MEETING_LINK)
                            ws.cell(row=row_num, column=meet_sent_col).value = "Yes" if ok_m else "Failed"
                            ws.cell(row=row_num, column=meet_note_col).value = (msg_m or "—")[:200]
                            print(f"  📅 Meeting auto-reply to {sender}: "
                                  + ("link sent ✔" if ok_m else f"FAILED — {msg_m}"))
                        else:
                            ws.cell(row=row_num, column=meet_sent_col).value = "Flagged"
                            ws.cell(row=row_num, column=meet_note_col).value = "Positive reply — add MEETING_LINK to auto-send"
                            print(f"  📅 Positive reply from {sender} — meeting requested (link not configured).")
                    else:
                        ws.cell(row=row_num, column=meet_requested_col).value = "No"

                    print(f"  💬 REPLY from: {sender}")
                    print(f"     Subject: {subject}")
                    reply_count += 1

            except Exception:
                continue

        refresh_derived_sheets(wb, headers)
        wb.save(Config.TRACKER_FILE)
        mail.logout()
        print(f"  ✅ Reply check done. Found {reply_count} new replies, {bounce_count} bounce(s).")
        regenerate_sent_bounced_report()

    except Exception as e:
        print(f"  ❌ Reply tracking error: {e}")

# ============================================================================
# SECTION 9 — DUPLICATE TRACKER
# ============================================================================
class DuplicateTracker:
    def __init__(self):
        self.file_path   = Config.DUPLICATES_FILE
        self.sent_emails = self._load()

    def _load(self):
        """Loads ALL previously-sent emails from BOTH sources so nothing is
        ever re-sent: the sent_emails_log.json AND the tracker's master sheet
        (rows whose Email Send Status == 'Sent')."""
        sent = set()
        try:
            if os.path.exists(self.file_path):
                with open(self.file_path) as f:
                    data = json.load(f)
                if isinstance(data, list):
                    sent.update(str(x).strip().lower() for x in data if x)
        except:
            pass
        try:
            if os.path.exists(Config.TRACKER_FILE):
                wb = openpyxl.load_workbook(Config.TRACKER_FILE, data_only=True, read_only=True)
                try:
                    ws = get_master_sheet(wb)
                    headers = [c.value for c in ws[1]]
                    email_idx = next((i for i, h in enumerate(headers)
                                      if h and str(h).strip().lower() == "email"), None)
                    status_idx = next((i for i, h in enumerate(headers)
                                       if h and str(h).strip().lower() == "email send status"), None)
                    if email_idx is not None and status_idx is not None:
                        for row in ws.iter_rows(min_row=2, values_only=True):
                            if len(row) > max(email_idx, status_idx) and row[email_idx]:
                                if str(row[status_idx]).strip() == "Sent":
                                    sent.add(str(row[email_idx]).strip().lower())
                finally:
                    wb.close()
        except Exception:
            pass
        return sent

    def already_sent(self, email_addr):
        return email_addr.lower() in self.sent_emails

    def mark_sent(self, email_addr):
        self.sent_emails.add(email_addr.lower())
        with open(self.file_path, "w") as f:
            json.dump(list(self.sent_emails), f, indent=2)

# ============================================================================
# SECTION 10 — MAIN CAMPAIGN RUNNER
# ============================================================================
def count_sent_today():
    """Returns how many emails were recorded as 'Sent' with today's date in
    the tracker's master sheet. Used by the daily send limit."""
    try:
        if not os.path.exists(Config.TRACKER_FILE):
            return 0
        wb = openpyxl.load_workbook(Config.TRACKER_FILE, data_only=True, read_only=True)
        try:
            ws = get_master_sheet(wb)
            headers = [c.value for c in ws[1]]
            if "Email Send Status" not in headers or "Sent Date" not in headers:
                return 0
            s_idx = headers.index("Email Send Status")
            d_idx = headers.index("Sent Date")
            today = datetime.now().strftime("%d-%m-%Y")
            n = 0
            for row in ws.iter_rows(min_row=2, values_only=True):
                if not row or len(row) <= max(s_idx, d_idx):
                    continue
                if str(row[s_idx]).strip() != "Sent":
                    continue
                dv = row[d_idx]
                if isinstance(dv, datetime):
                    n += int(dv.strftime("%d-%m-%Y") == today)
                else:
                    n += int(str(dv).strip() == today)
            return n
        finally:
            wb.close()
    except Exception:
        return 0


def run_campaign(tracking_url):
    print(f"\n[5/5] Sending emails...")
    if tracking_url:
        print(f"  Tracking URL: {tracking_url}")
    else:
        print("  ⚠️  No tracking URL — emails will send but open tracking disabled")

    try:
        df = pd.read_excel(Config.EXCEL_FILE_PATH, sheet_name=Config.SHEET_NAME)
        print(f"  Loaded {len(df)} records from Excel\n")
    except Exception as e:
        print(f"  ❌ Could not read Excel: {e}")
        return

    dup = DuplicateTracker()
    results = {"sent": 0, "failed": 0, "skipped": 0, "fake": 0}

    # "Current Sent" sheet shows only the last 15 days; "Total Sent" keeps all data
    reset_current_sheet()

    # ── Daily send limit: how many were already sent today? ────────────────
    today_sent = count_sent_today()
    if Config.DAILY_SEND_LIMIT:
        print(f"  📅 Daily send limit: {Config.DAILY_SEND_LIMIT} emails/day "
              f"(already sent today: {today_sent})")

    cycle_count = 0
    batch_no = 1
    for _, row in tqdm(df.iterrows(), total=len(df), desc="  Sending"):
        # ── Daily send limit: pause until tomorrow when today's quota is hit ─
        if Config.DAILY_SEND_LIMIT and today_sent >= Config.DAILY_SEND_LIMIT:
            if not Config.AUTO_CONTINUE:
                print(f"\n  🛑 Daily send limit reached ({Config.DAILY_SEND_LIMIT} sent today). "
                      f"Stopping here — run again tomorrow.")
                break
            now = datetime.now()
            nxt = (now + timedelta(days=1)).replace(hour=0, minute=1, second=0, microsecond=0)
            wait = max(30, int((nxt - now).total_seconds()))
            print(f"\n  🌙 Daily send limit reached ({Config.DAILY_SEND_LIMIT} sent today). "
                  f"Pausing until {nxt.strftime('%d-%m-%Y %H:%M')} "
                  f"({wait // 3600}h {wait % 3600 // 60}m)...")
            print(f"     Progress so far: {results['sent']} sent | {results['failed']} failed")
            # Keep tracking/replies/reminders alive during the pause
            check_replies()
            send_due_reminders(tracking_url)
            time.sleep(wait)
            today_sent = count_sent_today()
            print("\n  ▶ New day — resuming sends.")
        if cycle_count >= Config.MAX_EMAILS_PER_RUN:
            if Config.AUTO_CONTINUE:
                print(f"\n  🕒 Batch {batch_no} done ({cycle_count} emails) — waiting {Config.BATCH_INTERVAL_MINUTES} min, then sending the next batch automatically...")
                print(f"     Progress so far: {results['sent']} sent | {results['failed']} failed | {results['skipped']} skipped | {results['fake']} fake")
                # Keep tracking/replies/reminders alive during the wait
                check_replies()
                send_due_reminders(tracking_url)
                time.sleep(Config.BATCH_INTERVAL_MINUTES * 60)
                batch_no += 1
                cycle_count = 0
                print(f"\n  ▶ Starting batch {batch_no}...")
            else:
                print(f"\n  🛑 Reached batch limit of {Config.MAX_EMAILS_PER_RUN} emails. Stopping here to protect sender reputation.")
                print(f"  Run the script again to continue with the remaining leads.")
                break
        try:
            ceo_name     = str(row.get("CEO Name", "")).strip()
            company_name = str(row.get("Company Name", "")).strip()
            email_addr   = str(row.get("Lead Email ID", "")).strip()
            # Get country + city for auto-translation
            country      = str(row.get("Country", "")).strip()
            if country.lower() in ("nan", "none", ""):
                country = ""
            # Get city for India regional language detection
            city         = str(row.get("City", "")).strip()
            if city.lower() in ("nan", "none", ""):
                city = ""
            # If the Excel row has no country/city at all, try to auto-detect
            # the LEAD'S OWN location from their company email domain first
            # (e.g. someone@plainconcepts.de -> Germany) -- this is the
            # client's real location, not ours. Only if that fails do we
            # fall back to the sender's own detected location.
            if not country and not city:
                detected = detect_client_location_from_domain(email_addr)
                if detected.get("country"):
                    country = detected.get("country", "")
                    city    = detected.get("city", "")
                    print(f"  📍 Auto-detected location from email domain: {city or '—'}, {country}")
                else:
                    country = SENDER_COUNTRY
                    city    = SENDER_CITY
            # If country is India but city wasn't filled in, use the
            # sender's detected city so the regional language still applies.
            elif country == "India" and not city:
                city = SENDER_CITY

            # Skip empty or placeholder emails
            if not email_addr or email_addr.lower() in ["nan", "ceo mail id@gmail.com", ""]:
                results["skipped"] += 1
                continue

            if dup.already_sent(email_addr):
                if Config.SKIP_ALREADY_SENT:
                    print(f"\n  ⏭️  Skipping {email_addr} — already sent previously (duplicate protection on)")
                    results["skipped"] += 1
                    continue
                else:
                    print(f"\n  ℹ️  Already sent to {email_addr} before — sending again (duplicates allowed in Config)")

            subject = Config.EMAIL_SUBJECT.format(company_name=company_name)

            # ── Fake CEO email check: validate BEFORE sending, skip if fake ──
            # Free multi-layer check (syntax → disposable domain → MX →
            # SMTP mailbox) using the same sender config as everywhere else.
            # Fake emails are never emailed and are stored in the
            # "Fake CEO Email" sheet of the tracker with all their details.
            if Config.VALIDATE_EMAILS:
                verdict, reason = validate_email(email_addr, Config.SENDER_EMAIL)
                if verdict == "fake":
                    results["fake"] += 1
                    print(f"\n  🚫 FAKE EMAIL — SKIPPED: {email_addr} — {reason}")
                    # Store ALL remaining fields of the lead row in the sheet
                    extra = {}
                    for col_name in df.columns:
                        val = row.get(col_name)
                        if pd.isna(val):
                            continue
                        key = str(col_name).strip()
                        if key in ("Company Name", "CEO Name", "Lead Email ID", "Country", "City"):
                            continue
                        extra[key] = str(val).strip()
                    save_fake_email_record(company_name, ceo_name, email_addr, subject,
                                           country=country, city=city, reason=reason,
                                           extra=extra)
                    continue
                if verdict == "unknown":
                    print(f"  ⚠️  {email_addr} — {reason}")

            success, message = send_email(email_addr, ceo_name, company_name, subject, tracking_url, country=country, city=city)

            if success:
                dup.mark_sent(email_addr)
                # Determine language name for Excel
                lang_code = get_language_for_location(country, city)
                language_name = LANGUAGE_NAMES.get(lang_code, "English")
                save_email_record(company_name, ceo_name, email_addr, subject,
                                   country=country, city=city, language=language_name, status="Sent",
                                   template=Path(Config.TEMPLATE_FILE).name)
                results["sent"] += 1
                today_sent += 1
                cycle_count += 1
                print(f"\n  ✅ Sent to {email_addr}")
                print(f"     Country: {country or 'Unknown'} | Language: {language_name}")
            else:
                results["failed"] += 1
                save_email_record(company_name, ceo_name, email_addr, subject,
                                   country=country, city=city, status="Failed", error=message,
                                   template=Path(Config.TEMPLATE_FILE).name)
                print(f"\n  ❌ Failed: {email_addr} — {message}")

            # Delay between emails
            time.sleep(random.uniform(Config.EMAIL_DELAY_MIN, Config.EMAIL_DELAY_MAX))

        except Exception as e:
            results["failed"] += 1
            print(f"\n  ❌ Error: {e}")
            try:
                if email_addr:
                    save_email_record(company_name, ceo_name, email_addr, subject,
                                       country=country, city=city, status="Failed", error=str(e),
                                       template=Path(Config.TEMPLATE_FILE).name)
            except Exception:
                pass

    # Write any remaining queued records to the tracker (batched, fast)
    flush_saved_records()

    # Refresh derived sheets (Success, Bounced) from master
    try:
        rwb = openpyxl.load_workbook(Config.TRACKER_FILE)
        rws = get_master_sheet(rwb)
        rh = [cell.value for cell in rws[1]]
        refresh_derived_sheets(rwb, rh, rws)
        rwb.save(Config.TRACKER_FILE)
    except Exception:
        pass

    totals = update_campaign_summary(results, len(df))

    print("\n" + "="*60)
    print("  CAMPAIGN COMPLETE!")
    print(f"  ✅ Sent:    {results['sent']}  (this run)")
    print(f"  ❌ Failed:  {results['failed']}  (this run)")
    print(f"  ⏭️  Skipped: {results['skipped']}  (this run)")
    print(f"  🚫 Fake:    {results['fake']}  (this run)")
    if totals.get("total"):
        print(f"  📈 TOTAL SO FAR (ALL RUNS): {totals['sent']} sent | "
              f"{totals['failed']} failed | {totals['bounced']} bounced "
              f"| {totals.get('fake', 0)} fake "
              f"(across {totals['total']} leads)")
    if Config.DAILY_SEND_LIMIT:
        print(f"  📅 Daily limit: {Config.DAILY_SEND_LIMIT} emails/day "
              f"({count_sent_today()} sent today)")
    print("="*60)

    # Check for replies after sending
    check_replies()

    # Send any reminders that are already due (e.g. from a previous run)
    send_due_reminders(tracking_url)

    print(f"\n  📊 Open {Path(Config.TRACKER_FILE).name} to see results!")
    print("     - Send Status column      → 'Sent' (green) or 'Failed' (red), with Send Error reason")
    print("     - Summary sheet           → ALL-RUN totals (Emails Sent/Failed/Bounced across every run)")
    print("     - Email Open Status column → shows 'Opened' in green")
    print("     - Email Opened At column  → shows date & time")
    print("     - Website Visits / Total Time on Website → how long they browsed your site")
    print("     - Reply Received column   → shows 'Yes' if replied")
    print("     - Fake CEO Email sheet    → all skipped fake emails with full details")
    print(f"  📊 Also see {Path(Config.SENT_BOUNCED_REPORT_FILE).name} — separate Summary/Sent/Bounced sheets,")
    print("     auto-refreshed after every send and every reply/bounce check.")
    print("\n  ⏳ Tracking server is still running...")
    print("     Keep this terminal open to track future opens.")
    print("     Press Ctrl+C to stop.\n")

# ============================================================================
# SECTION 11 — ENTRY POINT
# ============================================================================
if __name__ == "__main__":

    # Command-line modes:
    #   (default)             AUTO mode — batches (100), waits 1 hr, next batch,
    #                         resumes next day automatically until ALL leads done.
    #   --once                PERMANENT mode — sends until the batch/daily limit,
    #                         then stops; re-run manually to continue.
    #   --batch N             override MAX_EMAILS_PER_RUN (e.g. --batch 100)
    #   --interval M          override BATCH_INTERVAL_MINUTES (e.g. --interval 60)
    import argparse as _argparse
    _ap = _argparse.ArgumentParser(add_help=False)
    _ap.add_argument("--once", action="store_true")
    _ap.add_argument("--batch", type=int, default=None)
    _ap.add_argument("--interval", type=int, default=None)
    _args, _ = _ap.parse_known_args(sys.argv[1:])

    if _args.once:
        Config.AUTO_CONTINUE = False
        Config.MAX_EMAILS_PER_RUN = 10 ** 9  # one continuous run; only the daily limit stops it
        print("\n  M O D E   : FULL CAMPAIGN (--once) — sends everything allowed today,")
        print("              then stops permanently. Re-run manually for the next day.")
    else:
        print("\n  M O D E   : AUTO SEND — batches automatically until ALL leads are done.")
        print(f"              {Config.MAX_EMAILS_PER_RUN} emails, wait {Config.BATCH_INTERVAL_MINUTES} min, next batch,"
              f" daily limit {Config.DAILY_SEND_LIMIT or 'off'}, resumes tomorrow automatically.")
    if _args.batch:
        Config.MAX_EMAILS_PER_RUN = _args.batch
        print(f"  📦 Batch size overridden → {Config.MAX_EMAILS_PER_RUN} emails per batch")
    if _args.interval:
        Config.BATCH_INTERVAL_MINUTES = _args.interval
        print(f"  ⏱  Batch interval overridden → {Config.BATCH_INTERVAL_MINUTES} minutes")

    # Step 0 — Detect sender's current location (used for default language)
    detect_sender_location()

    # Step 1 — Start Flask tracking server in background
    print("\n[3/5] Starting tracking server...")
    flask_thread = threading.Thread(target=start_flask, daemon=True)
    flask_thread.start()
    time.sleep(2)

    # Verify server started
    try:
        r = requests.get(f"http://localhost:{Config.TRACKING_PORT}/status", timeout=3)
        if r.status_code == 200:
            print(f"  ✅ Tracking server running on port {Config.TRACKING_PORT}")
    except:
        print(f"  ⚠️  Server may not have started — continuing anyway")

    # Step 2 — Set tracking URL (PHP script on your domain)
    print("\n[4/5] Setting up tracking URL...")
    tracking_url = Config.TRACKING_SCRIPT_URL
    tunnel_proc = None
    print(f"  ✅ Using tracking URL: {tracking_url}")

    # Step 3 — Run campaign
    try:
        run_campaign(tracking_url)
        # Keep running to serve tracking pixel for future opens
        print("\n  👀 Watching for email opens... (leave this terminal open!)")
        if tracking_url:
            print(f"  🔗 Live tracking URL: {tracking_url}")
        print("  Press Ctrl+C only when done for the day.\n")
        check_interval = 0
        reminder_interval = 0
        while True:
            time.sleep(30)
            check_interval += 30
            reminder_interval += 30
            if check_interval >= 300:   # check replies every 5 minutes
                check_replies()
                check_interval = 0
            if reminder_interval >= 600:   # check for due reminders every 10 minutes
                send_due_reminders(tracking_url)
                reminder_interval = 0
    except KeyboardInterrupt:
        print("\n  Stopping... Tracking is now OFF for all emails. Goodbye!")
        if tunnel_proc:
            tunnel_proc.terminate()