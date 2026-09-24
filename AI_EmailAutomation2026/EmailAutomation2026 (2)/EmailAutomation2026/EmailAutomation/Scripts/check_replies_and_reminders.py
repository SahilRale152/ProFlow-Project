"""
============================================================================
ORBITAVANYA — REPLY CHECKER & REMINDER SENDER (standalone)
============================================================================
This is the IMAP reply-checking and follow-up-reminder logic pulled out of
RUN_CAMPAIGN.py so it can run on its own, independently of the email-sending
campaign and the (now-retired) local Flask tracking server.

Run this continuously, in its own terminal, alongside sync_tracking_events.py:

    python check_replies_and_reminders.py

It will, forever, every few minutes:
  1. Check your inbox (IMAP) for replies and bounces, and update Excel.
  2. Send any follow-up reminder emails that are due AND not already replied to.

Press Ctrl+C to stop.

NOTE: This version no longer creates or writes the "Inbox Status",
"Registered Country", or "Registered City" columns -- those were removed
from Email_Tracking_NEW.xlsx as unnecessary. The reminder location
fallback chain now goes: real detected location (from a click) -> email
domain lookup -> default language. It no longer falls back to a
"Registered Country/City" column since that column no longer exists.
============================================================================
"""

import subprocess
import sys
import os
import time
import json
import imaplib
import email
import re
from datetime import datetime, timedelta
from pathlib import Path
from email.utils import formatdate, make_msgid, parseaddr

# ============================================================================
# SECTION 1 — AUTO INSTALL LIBRARIES
# ============================================================================
def install(package):
    subprocess.check_call([sys.executable, "-m", "pip", "install", package, "--quiet"])

print("\n" + "="*60)
print("  ORBITAVANYA — REPLY CHECKER & REMINDER SENDER")
print("="*60)
print("\nChecking libraries...")

required = {
    "openpyxl": "openpyxl",
    "requests": "requests",
    "deep-translator": "deep_translator",
    "beautifulsoup4": "bs4",
}
for pip_name, import_name in required.items():
    try:
        __import__(import_name)
    except ImportError:
        print(f"  Installing {pip_name}...")
        install(pip_name)

import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment
from openpyxl.utils import get_column_letter
import requests

print("  ✅ Libraries ready!\n")

# ============================================================================
# SECTION 2 — CONFIG  ← must match RUN_CAMPAIGN.py exactly
# ============================================================================
class Config:
    SENDER_EMAIL    = "pradeep@orbitavanyatech.com"
    SENDER_PASSWORD = "Prad@2026"
    SMTP_SERVER     = "s13429.bom1.stableserver.net"
    SMTP_PORT       = 465
    IMAP_SERVER     = "s13429.bom1.stableserver.net"
    IMAP_PORT       = 993

    # Resolved relative to this script's own location (.../EmailAutomation/Scripts/),
    # not hardcoded to any one person's folder -- see RUN_CAMPAIGN.py for why.
    from pathlib import Path as _Path
    _SCRIPT_DIR = _Path(__file__).resolve().parent
    _BASE_DIR = _SCRIPT_DIR.parent
    _DATA_DIR = _BASE_DIR / "Data"

    EXCEL_FILE_PATH = str(_DATA_DIR / "Lead Gen_CXO_UAE_Mail Merge_8_06_2024.xlsx")
    TRACKER_FILE    = str(_DATA_DIR / "Email_Tracking_NEW.xlsx")

    # Separate Sent/Bounced/Summary report file, auto-rebuilt after every
    # reply/bounce check and reminder check -- see regenerate_sent_bounced_report().
    SENT_BOUNCED_REPORT_FILE = str(_DATA_DIR / "Sent_Bounced_Report.xlsx")

    # Matches RUN_CAMPAIGN.py's Config.TRACKING_SCRIPT_URL -- the PHP
    # tracking script hosted on your actual domain (track.orbitavanyatech.com
    # was an earlier, never-deployed subdomain approach; this is what's
    # actually live).
    TRACKING_SCRIPT_URL = "https://orbitavanyatech.com/track.php"

    EMAIL_SUBJECT     = "Exploring Collaboration Opportunity with {company_name}"
    FOLLOWUP_SUBJECT  = "Following up: Collaboration Opportunity with {company_name}"

    # ── Meeting link auto-scheduler ─────────────────────────────────────────
    # When a reply contains positive words (yes / call / meeting / schedule…),
    # an automatic reply with this link is sent to the lead and the tracker
    # gets a "Meeting Requested" mark. Set MEETING_AUTO_REPLY = False to
    # only flag the lead without sending anything.
    MEETING_LINK       = ""
    MEETING_AUTO_REPLY = True

    # How often to run each check, in seconds.
    REPLY_CHECK_INTERVAL    = 60   # 5 minutes
    REMINDER_CHECK_INTERVAL = 100   # 10 minutes


def get_master_sheet(wb):
    if "Total Sent" in wb.sheetnames:
        return wb["Total Sent"]
    ws = wb.active
    ws.title = "Total Sent"
    return ws


def get_current_sheet(wb):
    if "Sent" in wb.sheetnames:
        return wb["Sent"]
    return wb.create_sheet("Sent")


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
    current state of Config.TRACKER_FILE, with three sheets: Summary,
    Sent, Bounced. Never edits TRACKER_FILE itself -- always a fresh
    separate file, so it can't drift out of sync. Called automatically
    after every reply/bounce check and every reminder check.
    """
    try:
        if not os.path.exists(Config.TRACKER_FILE):
            return

        src_wb = openpyxl.load_workbook(Config.TRACKER_FILE, data_only=True)
        src_ws = get_master_sheet(src_wb)
        headers = [c.value for c in src_ws[1]]

        if "Email Send Status" not in headers:
            return
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


TRACKING_URL = Config.TRACKING_SCRIPT_URL

# ============================================================================
# SECTION 3 — LANGUAGE / LOCATION HELPERS  (same as RUN_CAMPAIGN.py)
# ============================================================================
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

INDIA_STATE_LANGUAGE = {
    "maharashtra": "mr", "delhi": "hi", "uttar pradesh": "hi",
    "madhya pradesh": "hi", "bihar": "hi", "rajasthan": "hi", "haryana": "hi",
    "tamil nadu": "ta", "andhra pradesh": "te", "telangana": "te",
    "karnataka": "kn", "kerala": "ml", "gujarat": "gu", "punjab": "pa",
    "west bengal": "bn",
}

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

FREE_EMAIL_PROVIDERS = {
    "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com",
    "icloud.com", "protonmail.com", "mail.com", "yandex.com", "zoho.com",
    "rediffmail.com", "live.com", "msn.com", "gmx.com",
}

SENDER_LANG = "en"  # fallback default; RUN_CAMPAIGN.py detects this at startup,
                     # this standalone script just defaults to English if unknown.


def detect_client_location_from_domain(email_addr: str) -> dict:
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
    country    = (country or "").strip()
    city_key   = (city or "").strip().lower()
    region_key = (region or "").strip().lower()

    if country.lower() == "india":
        if city_key in INDIA_CITY_LANGUAGE:
            return INDIA_CITY_LANGUAGE[city_key]
        if region_key in INDIA_STATE_LANGUAGE:
            return INDIA_STATE_LANGUAGE[region_key]
        return "hi"

    if not country:
        return SENDER_LANG or "en"

    return COUNTRY_LANGUAGE.get(country, "en")


def get_location_from_ip(ip_address: str) -> dict:
    try:
        if not ip_address:
            return {}
        if (ip_address in ("127.0.0.1", "localhost") or
            ip_address.startswith("192.168.") or
            ip_address.startswith("10.") or
            ip_address.startswith("172.16.")):
            return {}

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
    if target_lang == "en" or not target_lang:
        return text
    try:
        from deep_translator import GoogleTranslator
        translated = GoogleTranslator(source="en", target=target_lang).translate(text)
        return translated if translated else text
    except Exception as e:
        print(f"  ⚠️  Translation failed: {e} — sending in English")
        return text


BRAND_PROTECTED_TERMS = [
    "OrbitAvanya Tech LLP", "OrbitAvanya", "Ranjeet Kumar",
    "info@orbitavanyatech.com", "orbitavanyatech.com",
    "+91 70219 50643",
]


def _protect_terms(text: str, extra_terms=None):
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
    if not text or not text.strip() or target_lang == "en" or not target_lang:
        return text
    working, placeholders = _protect_terms(text, extra_terms)
    translated = translate_text(working, target_lang)
    return _restore_terms(translated, placeholders)


def translate_html_body(html_body: str, target_lang: str, extra_terms=None) -> str:
    if not target_lang or target_lang == "en":
        return html_body

    print(f"  🌍 Translating email body to {target_lang}...")
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
            continue
        leading_ws  = original[:len(original) - len(original.lstrip())]
        trailing_ws = original[len(original.rstrip()):]
        translated = translate_text_protected(original.strip(), target_lang, extra_terms)
        node.replace_with(leading_ws + translated + trailing_ws)

    return str(soup)


# ============================================================================
# SECTION 4 — TRACKING PIXEL / LINK HELPERS  (so reminders still get tracked)
# ============================================================================
from urllib.parse import quote

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


def send_email(recipient_email, ceo_name, company_name, subject, tracking_url, is_reminder=False, country="", city=""):
    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart

    try:
        folder = Path(Config.EXCEL_FILE_PATH).parent.parent / "Templates"
        template_file = folder / ("Followup_template.html" if is_reminder else "Email_Template_final_1.html")

        with open(template_file, "r", encoding="utf-8") as f:
            html_body = f.read()

        html_body = html_body.replace("{{CEO_Name}}", ceo_name)
        html_body = html_body.replace("{{Company_Name}}", company_name)

        target_lang = get_language_for_location(country, city)
        location_label = city or country or "Unknown location"
        protect_terms = [company_name, ceo_name]
        if target_lang != "en":
            lang_name = LANGUAGE_NAMES.get(target_lang, target_lang.upper())
            print(f"  🌍 {location_label} → Translating email to {lang_name}...")
            html_body = translate_html_body(html_body, target_lang, extra_terms=protect_terms)
            subject   = translate_text_protected(subject, target_lang, extra_terms=protect_terms)
            print(f"  ✅ Translation done! Subject: {subject}")
        else:
            print(f"  📧 {location_label} → Sending in English")

        if tracking_url:
            html_body = inject_pixel(html_body, recipient_email, company_name, tracking_url)
            html_body = wrap_links_with_tracking(html_body, recipient_email, company_name, tracking_url)

        plain_greeting = translate_text_protected(f"Dear {ceo_name},", target_lang, protect_terms)
        plain_body     = translate_text_protected(
            "Greetings from OrbitAvanya Tech LLP.", target_lang, protect_terms
        )
        plain_visit    = translate_text_protected("Visit:", target_lang, protect_terms)
        plain_regards  = translate_text_protected("Regards,", target_lang, protect_terms)
        plain = (f"{plain_greeting}\n\n{plain_body}\n\n"
                 f"{plain_visit} https://orbitavanyatech.com\n\n"
                 f"{plain_regards}\nOrbitAvanya Tech LLP")

        sender_domain = Config.SENDER_EMAIL.split("@")[-1]

        msg = MIMEMultipart("alternative")
        msg["From"]                  = f"Mansi | Orbitavanya Tech LLP <{Config.SENDER_EMAIL}>"
        msg["To"]                    = recipient_email
        msg["Subject"]               = subject
        msg["Reply-To"]              = "info@orbitavanyatech.com"
        msg["Date"]                  = formatdate(localtime=True)
        msg["Message-ID"]            = make_msgid(domain=sender_domain)
        msg["List-Unsubscribe"]      = f"<mailto:{Config.SENDER_EMAIL}?subject=unsubscribe>"
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
        msg["X-Mailer"]              = "OrbitAvanya Outreach"
        msg["X-Priority"]            = "3"
        msg["MIME-Version"]          = "1.0"
        msg.attach(MIMEText(plain, "plain"))
        msg.attach(MIMEText(html_body, "html"))

        with smtplib.SMTP_SSL(Config.SMTP_SERVER, Config.SMTP_PORT) as server:
            server.login(Config.SENDER_EMAIL, Config.SENDER_PASSWORD)
            server.sendmail(Config.SENDER_EMAIL, recipient_email, msg.as_string())

        return True, "Sent successfully"
    except Exception as e:
        return False, str(e)


# ============================================================================
# SECTION 5 — REPLY / BOUNCE CHECK
# ============================================================================
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
    positively (yes / call / meeting / schedule …)."""
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
        msg["From"]       = f"Mansi | Orbitavanya Tech LLP <{Config.SENDER_EMAIL}>"
        msg["To"]         = recipient_email
        msg["Subject"]    = subject
        msg["Date"]       = formatdate(localtime=True)
        msg["Message-ID"] = make_msgid(domain=Config.SENDER_EMAIL.split("@")[-1])
        msg.attach(MIMEText(plain, "plain"))
        msg.attach(MIMEText(html, "html"))
        with smtplib.SMTP_SSL(Config.SMTP_SERVER, Config.SMTP_PORT) as server:
            server.login(Config.SENDER_EMAIL, Config.SENDER_PASSWORD)
            server.sendmail(Config.SENDER_EMAIL, recipient_email, msg.as_string())
        return True, "Sent successfully"
    except Exception as e:
        return False, str(e)


def check_replies():
    print("\n  Checking for replies...")
    try:
        mail = imaplib.IMAP4_SSL(Config.IMAP_SERVER, Config.IMAP_PORT)
        mail.login(Config.SENDER_EMAIL, Config.SENDER_PASSWORD)
        mail.select("INBOX")

        if not os.path.exists(Config.TRACKER_FILE):
            print("  ⚠️  Tracker file not found. Run the campaign first.")
            return

        wb       = openpyxl.load_workbook(Config.TRACKER_FILE)
        ws       = get_master_sheet(wb)
        headers  = [cell.value for cell in ws[1]]

        def get_col(name):
            return headers.index(name) + 1 if name in headers else None

        email_col         = get_col("Email")
        reply_col         = get_col("Reply Received")
        reply_date_col    = get_col("Reply Date")

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

        email_row_map = {}
        for row in ws.iter_rows(min_row=2):
            cell_val = row[email_col - 1].value
            if cell_val:
                email_row_map[str(cell_val).strip().lower()] = row[0].row

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

                # ── BOUNCE CHECK — do this before the reply check, since a
                # bounce notification is from "Mail Delivery System" etc,
                # not the actual recipient, and should never be logged as
                # a reply from them. ──────────────────────────────────────
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

                    # The bounce body contains the ORIGINAL recipient's address
                    # somewhere in its text -- find it by matching against
                    # emails we actually have in the tracker (skip our own
                    # sender address so we don't match ourselves).
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

                    current_status = ws.cell(row=row_num, column=reply_col).value if reply_col else None
                    if current_status == "Yes":
                        continue

                    if reply_col:
                        rc = ws.cell(row=row_num, column=reply_col)
                        rc.value = "Yes"
                        rc.fill  = PatternFill("solid", fgColor="C6EFCE")
                        rc.font  = Font(color="276221", bold=True)

                    if reply_date_col:
                        ws.cell(row=row_num, column=reply_date_col).value = datetime.now().strftime("%d-%m-%Y %H:%M")

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

    except PermissionError:
        print(f"  ⚠️  Could not save — close {Path(Config.TRACKER_FILE).name} in Excel first!")
    except Exception as e:
        print(f"  ❌ Reply tracking error: {e}")


# ============================================================================
# SECTION 6 — DUE REMINDERS
# ============================================================================
def send_due_reminders():
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

            # Skip if not sent, already reminded, or ALREADY REPLIED --
            # this is the check that stops follow-ups going to people who
            # already replied, as long as check_replies() has run recently.
            #
            # NOTE: also skip anything marked "Bounced" -- there's no point
            # sending a follow-up reminder to an address that has already
            # permanently failed to deliver.
            if (status not in ("Sent",) or rsent == "Yes" or reply == "Yes"
                    or not due_val or due_val == "—"):
                continue

            try:
                due_date = datetime.strptime(str(due_val), "%d-%m-%Y").date()
            except ValueError:
                continue
            if due_date > today:
                continue

            company_name = ws.cell(row=row_num, column=c_company).value or ""
            ceo_name     = ws.cell(row=row_num, column=c_contact).value or ""
            email_addr   = ws.cell(row=row_num, column=c_email).value or ""
            if not email_addr:
                continue

            # Location fallback chain -- "Registered Country/City" was
            # removed as a fallback source (column no longer exists), so
            # this now goes: real detected click location -> email-domain
            # lookup -> default language.
            real_country = ws.cell(row=row_num, column=c_open_country).value if c_open_country else None
            real_city    = ws.cell(row=row_num, column=c_open_city).value if c_open_city else None

            if real_country and real_country != "—":
                country, city = real_country, (real_city if real_city and real_city != "—" else "")
                print(f"  📍 {company_name}: using REAL detected location ({city or '—'}, {country}) for reminder")
            else:
                detected = detect_client_location_from_domain(email_addr)
                if detected.get("country"):
                    country, city = detected.get("country", ""), detected.get("city", "")
                    print(f"  📍 {company_name}: no click yet — using email-domain location ({city or '—'}, {country}) for reminder")
                else:
                    country, city = "", ""
                    print(f"  📍 {company_name}: no location signal available — using default language for reminder")

            subject = Config.FOLLOWUP_SUBJECT.format(company_name=company_name)
            success, message = send_email(email_addr, ceo_name, company_name, subject,
                                           TRACKING_URL, is_reminder=True,
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
    except PermissionError:
        print(f"  ⚠️  Could not save — close {Path(Config.TRACKER_FILE).name} in Excel first!")
    except Exception as e:
        print(f"  ❌ Could not process reminders: {e}")


# ============================================================================
# SECTION 7 — MAIN LOOP
# ============================================================================
if __name__ == "__main__":
    print(f"Reply check every {Config.REPLY_CHECK_INTERVAL}s, "
          f"reminder check every {Config.REMINDER_CHECK_INTERVAL}s.")
    print("Press Ctrl+C to stop.\n")

    check_replies()
    send_due_reminders()

    reply_elapsed = 0
    reminder_elapsed = 0
    TICK = 30  # seconds

    try:
        while True:
            time.sleep(TICK)
            reply_elapsed += TICK
            reminder_elapsed += TICK

            if reply_elapsed >= Config.REPLY_CHECK_INTERVAL:
                check_replies()
                reply_elapsed = 0

            if reminder_elapsed >= Config.REMINDER_CHECK_INTERVAL:
                send_due_reminders()
                reminder_elapsed = 0
    except KeyboardInterrupt:
        print("\n  Stopped. Goodbye!")