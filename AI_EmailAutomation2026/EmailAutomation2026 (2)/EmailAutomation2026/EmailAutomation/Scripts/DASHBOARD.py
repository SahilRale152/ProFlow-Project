"""
============================================================================
ORBITAVANYA EMAIL AUTOMATION — WEB DASHBOARD
============================================================================
One control center for the whole campaign system. Run it with:

    python DASHBOARD.py

then open http://localhost:7070 in your browser (it opens automatically).

What you can do from the dashboard:
  1. OVERVIEW  — live campaign stats (sent / opened / clicked / replied /
                 bounced / fake-skipped), charts (emails per day, opens &
                 clicks per day, top countries, languages)
  2. LEADS     — searchable, filterable table of everything in the tracker
  3. EVENTS    — live feed of opens / clicks / website visits as they come in
  4. ACTIONS   — Start / Stop the full campaign (with live console log),
                 check replies now, send due reminders, refresh the report
  5. SETTINGS  — edit the campaign configuration without touching code
                 (saved back into RUN_CAMPAIGN.py's Config class)

Everything runs locally on your machine (127.0.0.1). No internet needed.
============================================================================
"""

import io
import os
import sys
import csv
import json
import time
import threading
import subprocess
import contextlib
import webbrowser
import re
from datetime import datetime, timedelta
from pathlib import Path

try:
    from flask import Flask, request, jsonify, send_file
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "flask", "--quiet"])
    from flask import Flask, request, jsonify, send_file

try:
    import openpyxl
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl", "--quiet"])
    import openpyxl
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

try:
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests", "--quiet"])
    import requests

# ============================================================================
# PATHS (auto-derived, moves with the project)
# ============================================================================
BASE    = Path(__file__).resolve().parent.parent          # EmailAutomation/
SCRIPTS = BASE / "Scripts"
DATA    = BASE / "Data"
LOGS_DIR = DATA / "dashboard_logs"
LOGS_DIR.mkdir(parents=True, exist_ok=True)

CAMPAIGN_LOG = LOGS_DIR / "campaign_live.log"
ACTIVITY_LOG  = LOGS_DIR / "dashboard_activity.log"

DASHBOARD_PORT = 7070

# ============================================================================
# LIGHTWEIGHT ACCESS TO RUN_CAMPAIGN's Config (never runs a campaign itself)
# ============================================================================
_CFG = None
_CFG_LOCK = threading.Lock()


def get_config():
    """Returns (freshly reloaded) RUN_CAMPAIGN.Config so settings edits
    and script changes are always picked up."""
    global _CFG
    with _CFG_LOCK:
        try:
            sys.path.insert(0, str(SCRIPTS))
            cfg_module = get_config.cache.get("module")
            if cfg_module is None:
                import importlib
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    cfg_module = importlib.import_module("RUN_CAMPAIGN")
                get_config.cache["module"] = cfg_module
            else:
                import importlib
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    cfg_module = importlib.reload(cfg_module)
                get_config.cache["module"] = cfg_module
            _CFG = cfg_module.Config
        except Exception as e:
            if _CFG is None or not hasattr(_CFG, "TRACKER_FILE"):
                class _Fallback:
                    TRACKER_FILE = str(DATA / "Email_Tracking_NEW.xlsx")
                    EVENTS_JSON_FILE = str(DATA / "tracking_events.json")
                    DUPLICATES_FILE = str(DATA / "sent_emails_log.json")
                    SENT_BOUNCED_REPORT_FILE = str(DATA / "Sent_Bounced_Report.xlsx")
                _CFG = _Fallback
        return _CFG


get_config.cache = {"module": None}


def tracker_path():
    return Path(get_config().TRACKER_FILE)


def events_path():
    return Path(get_config().EVENTS_JSON_FILE)


def log_line(msg):
    try:
        with open(ACTIVITY_LOG, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().strftime('%d-%m-%Y %H:%M:%S')}] {msg}\n")
    except Exception:
        pass


# ============================================================================
# DATA READING (all reads are defensive — never crash the dashboard)
# ============================================================================
def read_master_rows():
    """Returns (headers, rows) from the master 'Total Sent' sheet."""
    path = tracker_path()
    rows, headers = [], []
    try:
        wb = openpyxl.load_workbook(path, data_only=True, read_only=False)
    except PermissionError:
        return [], []
    except FileNotFoundError:
        return [], []
    except Exception:
        return [], []
    try:
        ws = None
        for name in ("Total Sent", "Current Sent"):
            if name in wb.sheetnames:
                ws = wb[name]
                break
        if ws is None:
            ws = wb.active
        headers = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
        for r in ws.iter_rows(min_row=2, values_only=True):
            if r and any(v is not None and str(v).strip() not in ("", None) for v in r):
                row = {headers[i]: r[i] for i in range(min(len(headers), len(r)))}
                rows.append(row)
    finally:
        wb.close()
    return headers, rows


def read_fake_rows():
    path = tracker_path()
    rows = []
    try:
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        if "Fake CEO Email" in wb.sheetnames:
            ws = wb["Fake CEO Email"]
            headers = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
            for r in ws.iter_rows(min_row=2, values_only=True):
                if r and any(v is not None for v in r):
                    rows.append({headers[i]: r[i] for i in range(min(len(headers), len(r)))})
        wb.close()
    except Exception:
        pass
    return rows


def load_events_json():
    try:
        with open(events_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def load_sent_log():
    try:
        with open(get_config().DUPLICATES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _dt(v):
    """Parse dd-mm-yyyy [HH:MM:SS] -> datetime or None."""
    if v is None:
        return None
    s = str(v).strip()
    if not s or s in ("—", "-", "nan", "None"):
        return None
    if isinstance(v, datetime):
        return v
    for fmt in ("%d-%m-%Y %H:%M:%S", "%d-%m-%Y %H:%M", "%d-%m-%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


# ============================================================================
# STATS AGGREGATION
# ============================================================================
def compute_summary():
    headers, rows = read_master_rows()
    locked = not rows and tracker_path().exists() and not _excel_readable()
    fakes = read_fake_rows()
    events = load_events_json()

    st = {
        "total": 0, "sent": 0, "failed": 0, "bounced": 0,
        "opened": 0, "clicked": 0, "replied": 0,
        "reminders_sent": 0, "reminders_due": 0,
        "visits": 0, "fake": len(fakes),
    }
    today = datetime.now().date()

    for r in rows:
        status = str(r.get("Email Send Status", "")).strip()
        if status:
            st["total"] += 1
            if status == "Sent":
                st["sent"] += 1
            elif status == "Failed":
                st["failed"] += 1
            elif status == "Bounced":
                st["bounced"] += 1
                st["sent"] += 1  # was delivered then bounced — counted as sent
        if str(r.get("Email Open Status", "")).strip() == "Opened":
            st["opened"] += 1
        if str(r.get("Link Clicked", "")).strip() == "Yes":
            st["clicked"] += 1
        if str(r.get("Reply Received", "")).strip() == "Yes":
            st["replied"] += 1
        if str(r.get("Reminder Sent", "")).strip() == "Yes":
            st["reminders_sent"] += 1
        v = r.get("Website Visits")
        try:
            st["visits"] += int(v or 0)
        except (TypeError, ValueError):
            pass
        due = _dt(r.get("Reminder Due"))
        if (due and due.date() <= today
                and str(r.get("Email Send Status", "")).strip() == "Sent"
                and str(r.get("Reply Received", "")).strip() != "Yes"
                and str(r.get("Reminder Sent", "")).strip() != "Yes"):
            st["reminders_due"] += 1

    base = st["sent"] or 1
    st["open_rate"]  = round(100 * st["opened"] / base, 1)
    st["click_rate"] = round(100 * st["clicked"] / base, 1)
    st["reply_rate"] = round(100 * st["replied"] / base, 1)
    st["bounce_rate"] = round(100 * st["bounced"] / base, 1)
    st["locked"] = locked

    # ── charts ────────────────────────────────────────────────────────────
    days = []
    for r in rows:
        d = _dt(r.get("Sent Date"))
        if d:
            days.append((d.date(), str(r.get("Email Send Status", "")).strip()))

    def _counts(key_expr):
        # events-based counters per date
        by = {}
        for e in events:
            dtm = _dt(e.get("timestamp")) or _dt(e.get("opened_at")) or _dt(e.get("clicked_at")) or _dt(e.get("visited_at"))
            if not dtm:
                continue
            if e.get("event") == key_expr:
                key = dtm.date().isoformat()
                by[key] = by.get(key, 0) + 1
        return by

    # Count opens/clicks per day from the TRACKER SHEET first (same source as
    # the KPIs / sent graph), and fall back to the event feed only when the
    # sheet has no open/click timestamps.
    opens_by_day, clicks_by_day, visits_by_day = {}, {}, {}
    for r in rows:
        od = _dt(r.get("Email Opened At"))
        if od:
            key = od.date().isoformat()
            opens_by_day[key] = opens_by_day.get(key, 0) + 1
        cd = _dt(r.get("Link Clicked At"))
        if cd:
            key = cd.date().isoformat()
            clicks_by_day[key] = clicks_by_day.get(key, 0) + 1
    if not opens_by_day:
        opens_by_day = _counts("email_opened")
    if not clicks_by_day:
        clicks_by_day = _counts("link_clicked")
    visits_by_day = _counts("website_visit")

    sent_by_day, failed_by_day = {}, {}
    for d, status in days:
        key = d.isoformat()
        if status == "Sent":
            sent_by_day[key] = sent_by_day.get(key, 0) + 1
        elif status == "Failed":
            failed_by_day[key] = failed_by_day.get(key, 0) + 1

    # last 14 days axis (include today)
    all_dates = set(sent_by_day) | set(opens_by_day) | set(clicks_by_day) | set(visits_by_day) | set(failed_by_day)
    if all_dates:
        ref = max(datetime.fromisoformat(x) for x in all_dates)
    else:
        ref = datetime.now()
    ref = datetime(ref.year, ref.month, ref.day)
    axis = [(ref - timedelta(days=i)).date().isoformat() for i in range(13, -1, -1)]

    def series(m):
        return {
            "axis": axis,
            "values": [m.get(d, 0) for d in axis],
        }

    # ── top countries (from clicks in master + event locations) ──────────
    country_counts = {}
    for r in rows:
        c = str(r.get("Opened From Country", "")).strip()
        if c and c not in ("—", "", "nan", "None"):
            country_counts[c] = country_counts.get(c, 0) + 1
    for e in events:
        loc = e.get("location") or {}
        c = str(loc.get("country", "")).strip()
        if c:
            country_counts[c] = country_counts.get(c, 0) + 1
    top_countries = sorted(country_counts.items(), key=lambda kv: -kv[1])[:12]

    # ── languages ────────────────────────────────────────────────────────
    lang_counts = {}
    for r in rows:
        lg = str(r.get("Email Sent In Language", "")).strip()
        if lg and lg not in ("—", "", "nan", "None"):
            lang_counts[lg] = lang_counts.get(lg, 0) + 1

    st["charts"] = {
        "sent":    series(sent_by_day),
        "failed":  series(failed_by_day),
        "opens":   series(opens_by_day),
        "clicks":  series(clicks_by_day),
        "visits":  series(visits_by_day),
        "countries": [{"name": k, "count": v} for k, v in top_countries],
        "languages": sorted(lang_counts.items(), key=lambda kv: -kv[1]),
    }

    # ── smart analytics ────────────────────────────────────────────────────
    st["bounce"] = bounce_analysis(rows)
    st["forecast"] = forecast(rows)
    st["template_stats"] = template_stats(rows)
    st["score_counts"] = {"Hot": 0, "Warm": 0, "Cold": 0}
    for r in rows:
        if str(r.get("Email Send Status", "")).strip() not in ("Sent", "Bounced"):
            continue
        _s, label = lead_score(r)
        st["score_counts"][label] += 1

    st["last_updated"] = datetime.now().strftime("%d-%m-%Y %H:%M:%S")
    return st


def _excel_readable():
    try:
        wb = openpyxl.load_workbook(tracker_path(), data_only=True, read_only=True)
        wb.close()
        return True
    except Exception:
        return False


# ============================================================================
# SMART ANALYTICS — lead score, dup companies, bounce causes, forecast,
# per-template performance
# ============================================================================
def lead_score(row):
    """Ranks a tracker row as Hot / Warm / Cold (replied > clicked > opened > visits)."""
    try:
        visits = int(row.get("Website Visits") or 0)
    except (TypeError, ValueError):
        visits = 0
    score = 0
    if str(row.get("Reply Received", "")).strip() == "Yes":
        score += 3
    if str(row.get("Link Clicked", "")).strip() == "Yes":
        score += 2
    if str(row.get("Email Open Status", "")).strip() == "Opened":
        score += 1
    score += min(visits, 2)
    label = "Hot" if score >= 4 else ("Warm" if score >= 2 else "Cold")
    return score, label


def flag_dup_companies(rows):
    """Annotates each row with _dup / _dup_count when its Company Name appears
    more than once in the list (avoid emailing the same company twice)."""
    counts = {}
    for r in rows:
        c = str(r.get("Company Name", "")).strip().lower()
        if c and c not in ("nan", "none"):
            counts[c] = counts.get(c, 0) + 1
    dup_rows = 0
    for r in rows:
        c = str(r.get("Company Name", "")).strip().lower()
        n = counts.get(c, 0)
        r["_dup"] = n > 1
        r["_dup_count"] = n
        if n > 1:
            dup_rows += 1
    return dup_rows


HARD_BOUNCE_HINTS = ("550", "no such user", "does not exist", "invalid recipient",
                     "unknown user", "mailbox unavailable", "user unknown",
                     "address rejected", "recipient rejected", "not found",
                     "permanent", "undeliverable")
SOFT_BOUNCE_HINTS = ("temporar", "try again", "delayed", "later", "4.2",
                     "mailbox full", "quota", "over quota", "suspended", "greylist")
SPAM_BOUNCE_HINTS = ("spam", "blacklist", "blocked", "rejected", "policy",
                     "content", "reputation", "rate limit", "banned")


def classify_bounce_reason(text):
    t = str(text or "").lower()
    if any(k in t for k in HARD_BOUNCE_HINTS):
        return "hard"
    if any(k in t for k in SOFT_BOUNCE_HINTS):
        return "soft"
    if any(k in t for k in SPAM_BOUNCE_HINTS):
        return "spam-filter"
    return "unknown"


def bounce_analysis(rows):
    """Classifies every bounced row by root cause and flags problem domains
    (≥2 bounces, or ≥50% of that domain's sends bounced) to be dropped."""
    types = {"hard": 0, "soft": 0, "spam-filter": 0, "unknown": 0}
    by_domain = {}
    for r in rows:
        status = str(r.get("Email Send Status", "")).strip()
        email = str(r.get("Email", "")).strip().lower()
        domain = email.split("@")[-1] if "@" in email else ""
        if not domain:
            continue
        d = by_domain.setdefault(domain, {"bounced": 0, "sent": 0})
        if status == "Bounced":
            types[classify_bounce_reason(r.get("Send Error"))] += 1
            d["bounced"] += 1
            d["sent"] += 1
        elif status == "Sent":
            d["sent"] += 1
    drop = []
    for dom, d in by_domain.items():
        share = d["bounced"] / d["sent"] if d["sent"] else 0
        if d["bounced"] >= 2 or (d["sent"] >= 3 and share >= 0.5):
            drop.append({"domain": dom, "bounced": d["bounced"],
                         "sent": d["sent"], "share": round(100 * share, 1)})
    drop.sort(key=lambda x: -x["bounced"])
    return {"types": types, "drop": drop[:10], "total": sum(types.values())}


def template_stats(rows):
    """Per-template leaderboard: sent / opened / clicked / replied + rates.
    Template names come from the tracker's 'Template' column; older rows
    without it are inferred from the email subject."""
    stats = {}
    for r in rows:
        if str(r.get("Email Send Status", "")).strip() != "Sent":
            continue
        name = str(r.get("Template", "")).strip()
        if not name:
            subj = str(r.get("Subject", "")).lower()
            name = "Followup_template.html" if "following up" in subj else "Email_Template_final_1.html"
        t = stats.setdefault(name, {"sent": 0, "opened": 0, "clicked": 0, "replied": 0})
        t["sent"] += 1
        if str(r.get("Email Open Status", "")).strip() == "Opened":
            t["opened"] += 1
        if str(r.get("Link Clicked", "")).strip() == "Yes":
            t["clicked"] += 1
        if str(r.get("Reply Received", "")).strip() == "Yes":
            t["replied"] += 1
    out = []
    for name, t in stats.items():
        out.append({**t, "name": name,
                    "open_rate": round(100 * t["opened"] / t["sent"], 1),
                    "click_rate": round(100 * t["clicked"] / t["sent"], 1),
                    "reply_rate": round(100 * t["replied"] / t["sent"], 1)})
    out.sort(key=lambda x: -x["opened"])
    return out


def _lin_predict(xs, vals, days):
    """Simple least-squares line through (xs, vals); returns predicted value
    at x=days, or None when there's no usable trend."""
    n = len(xs)
    if n < 2:
        return None
    sx = sum(xs); sy = sum(vals)
    sxx = sum(x * x for x in xs); sxy = sum(x * y for x, y in zip(xs, vals))
    denom = n * sxx - sx * sx
    if denom == 0:
        return None
    b = (n * sxy - sx * sy) / denom
    a = (sy - b * sx) / n
    v = a + b * days
    return max(0.0, min(100.0, round(v, 1)))


def forecast(rows, days=7):
    """Predicts tomorrow's open / reply rate from the last `days` days of
    sends (linear regression). Returns None when there isn't enough data."""
    now = datetime.now().date()
    sent_by_day, opened_by_day, replied_by_day = {}, {}, {}
    for r in rows:
        sd = _dt(r.get("Sent Date"))
        if sd and str(r.get("Email Send Status", "")).strip() in ("Sent", "Bounced"):
            sent_by_day[sd.date().isoformat()] = sent_by_day.get(sd.date().isoformat(), 0) + 1
        od = _dt(r.get("Email Opened At"))
        if od:
            opened_by_day[od.date().isoformat()] = opened_by_day.get(od.date().isoformat(), 0) + 1
        rd = _dt(r.get("Reply Date"))
        if rd:
            replied_by_day[rd.date().isoformat()] = replied_by_day.get(rd.date().isoformat(), 0) + 1

    xs = list(range(days))
    open_rates, reply_rates = [], []
    for i in xs:
        d = (now - timedelta(days=days - 1 - i)).isoformat()
        s = sent_by_day.get(d, 0)
        open_rates.append(round(100 * opened_by_day.get(d, 0) / s, 1) if s else 0)
        reply_rates.append(round(100 * replied_by_day.get(d, 0) / s, 1) if s else 0)

    if sum(1 for v in open_rates if v) < 3 and sum(1 for v in reply_rates if v) < 3:
        return None
    op = _lin_predict(xs, open_rates, days)
    rp = _lin_predict(xs, reply_rates, days)
    avg_open = round(sum(open_rates) / days, 1)
    avg_reply = round(sum(reply_rates) / days, 1)
    trend = "up" if (op or 0) >= avg_open else "down"
    return {"open": op, "reply": rp, "days": days, "trend": trend,
            "avg_open": avg_open, "avg_reply": avg_reply}


# ============================================================================
# FLASK APP
# ============================================================================
app = Flask(__name__)

# No browser caching anywhere — every refresh reads the live files.
@app.after_request
def _no_cache(resp):
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp

# ── one-shot action jobs ──────────────────────────────────────────────────
ACTION_LOCK = threading.Lock()
JOBS = {}           # job_id -> {"name","started","done","ok","error","log"}
JOB_ID = [0]

# ── campaign subprocess ───────────────────────────────────────────────────
CAMP_SLOTS = ("leads", "full")
CAMP = {s: {"proc": None, "started": None} for s in CAMP_SLOTS}



@app.route("/")
def index():
    return INDEX_HTML


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "time": datetime.now().strftime("%d-%m-%Y %H:%M:%S")})


@app.route("/api/summary")
def api_summary():
    return jsonify(compute_summary())


@app.route("/api/leads")
def api_leads():
    headers, rows = read_master_rows()
    q = (request.args.get("q", "") or "").strip().lower()
    status = (request.args.get("status", "") or "").strip()
    opened = (request.args.get("opened", "") or "").strip()
    replied = (request.args.get("replied", "") or "").strip()
    clicked = (request.args.get("clicked", "") or "").strip()
    only = (request.args.get("only", "") or "").strip()   # "sent" / "bounced" / "fake"

    out = []
    for r in rows:
        if q and not any(q in str(v).lower() for v in r.values()):
            continue
        s = str(r.get("Email Send Status", "")).strip()
        if status and s != status:
            continue
        if opened == "yes" and str(r.get("Email Open Status", "")).strip() != "Opened":
            continue
        if opened == "no" and str(r.get("Email Open Status", "")).strip() == "Opened":
            continue
        if replied == "yes" and str(r.get("Reply Received", "")).strip() != "Yes":
            continue
        if replied == "no" and str(r.get("Reply Received", "")).strip() == "Yes":
            continue
        if clicked == "yes" and str(r.get("Link Clicked", "")).strip() != "Yes":
            continue
        if clicked == "no" and str(r.get("Link Clicked", "")).strip() == "Yes":
            continue
        if only == "sent" and s != "Sent":
            continue
        if only == "bounced" and s != "Bounced":
            continue
        if only == "failed" and s != "Failed":
            continue
        # ── lead score (hot / warm / cold) ────────────────────────────────
        score, label = lead_score(r)
        r["score"] = score
        r["score_label"] = label
        out.append(r)

    fakes = []
    if only == "fake":
        fakes = read_fake_rows()
        if q:
            fakes = [f for f in fakes if q in json.dumps(f, ensure_ascii=False).lower()]

    return jsonify({"count": len(out), "rows": out, "fake_count": len(fakes), "fakes": fakes})


@app.route("/api/events")
def api_events():
    limit = int(request.args.get("limit", 200))
    events = load_events_json()
    events.sort(key=lambda e: _dt(e.get("timestamp")) or datetime.min, reverse=True)
    return jsonify(events[:limit])


# ── Download report (same filters as the Leads tab) ──────────────────────────
def _filtered_lead_rows():
    """Shared filter logic for /api/leads and the report download."""
    headers, rows = read_master_rows()
    q = (request.args.get("q", "") or "").strip().lower()
    status = (request.args.get("status", "") or "").strip()
    opened = (request.args.get("opened", "") or "").strip()
    replied = (request.args.get("replied", "") or "").strip()
    clicked = (request.args.get("clicked", "") or "").strip()
    only = (request.args.get("only", "") or "").strip()

    out = []
    for r in rows:
        if q and not any(q in str(v).lower() for v in r.values()):
            continue
        s = str(r.get("Email Send Status", "")).strip()
        if status and s != status:
            continue
        if opened == "yes" and str(r.get("Email Open Status", "")).strip() != "Opened":
            continue
        if opened == "no" and str(r.get("Email Open Status", "")).strip() == "Opened":
            continue
        if replied == "yes" and str(r.get("Reply Received", "")).strip() != "Yes":
            continue
        if replied == "no" and str(r.get("Reply Received", "")).strip() == "Yes":
            continue
        if clicked == "yes" and str(r.get("Link Clicked", "")).strip() != "Yes":
            continue
        if clicked == "no" and str(r.get("Link Clicked", "")).strip() == "Yes":
            continue
        if only == "sent" and s != "Sent":
            continue
        if only == "bounced" and s != "Bounced":
            continue
        if only == "failed" and s != "Failed":
            continue
        score, label = lead_score(r)
        r["score"] = score
        r["score_label"] = label
        out.append(r)
    return out


@app.route("/api/report/download")
def api_report_download():
    """Downloads the currently-filtered lead records as an Excel report."""
    fmt = (request.args.get("fmt", "xlsx") or "xlsx").lower()
    only = (request.args.get("only", "") or "").strip()
    status = (request.args.get("status", "") or "").strip()
    rows = _filtered_lead_rows()

    fakes = []
    if only == "fake":
        fakes = read_fake_rows()
        q = (request.args.get("q", "") or "").strip().lower()
        if q:
            fakes = [f for f in fakes if q in json.dumps(f, ensure_ascii=False).lower()]

    def _cell(v):
        if v is None:
            return ""
        s = str(v)
        return s if s.lower() not in ("nan", "none") else ""

    if fmt == "csv":
        buf = io.StringIO()
        wr = csv.writer(buf)
        headers = list(rows[0].keys()) if rows else [
            "Company", "Contact Person", "Email", "Sent Date", "Email Send Status",
            "Email Open Status", "Link Clicked", "Website Visits", "Reply Received",
            "Reminder Sent", "Opened From Country", "Subject"]
        wr.writerow(headers)
        for r in rows:
            wr.writerow([_cell(r.get(h)) for h in headers])
        data = buf.getvalue().encode("utf-8-sig")
        ext, mime = "csv", "text/csv"
        label = "leads"
    else:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Leads"
        headers = list(rows[0].keys()) if rows else [
            "Company", "Contact Person", "Email", "Sent Date", "Email Send Status",
            "Email Open Status", "Link Clicked", "Website Visits", "Reply Received",
            "Reminder Sent", "Opened From Country", "Subject"]
        ws.append(headers)
        for c in ws[1]:
            c.font = Font(bold=True)
        for r in rows:
            ws.append([_cell(r.get(h)) for h in headers])
        if fakes:
            fws = wb.create_sheet("Fake CEO Emails")
            fheaders = list(fakes[0].keys()) if fakes else ["Email", "Company"]
            fws.append(fheaders)
            for c in fws[1]:
                c.font = Font(bold=True)
            for f in fakes:
                fws.append([_cell(f.get(h)) for h in fheaders])
        for column_cells in ws.columns:
            max_len = max(len(str(c.value)) if c.value is not None else 0 for c in column_cells)
            ws.column_dimensions[get_column_letter(column_cells[0].column)].width = min(45, max_len + 2)
        buf = io.BytesIO()
        wb.save(buf)
        data = buf.getvalue()
        ext, mime = "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        label = status or only or "leads"

    from flask import send_file
    resp = send_file(io.BytesIO(data), mimetype=mime,
                     as_attachment=True,
                     download_name=f"OrbitAvanya_{label}_report_{datetime.now().strftime('%d-%m-%Y')}.{ext}")
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _campaign_slot():
    mode = request.args.get("mode") or (request.json or {}).get("mode") or "leads"
    if mode not in CAMP_SLOTS:
        mode = "leads"
    return mode


@app.route("/api/campaign/status")
def campaign_status():
    slot = CAMP[_campaign_slot()]
    proc = slot["proc"]
    running = proc is not None and proc.poll() is None
    return jsonify({
        "running": running,
        "started": slot["started"],
        "exit_code": None if running else (proc.poll() if proc else None),
        "log_file": str(CAMPAIGN_LOG),
    })


@app.route("/api/campaign/start", methods=["POST"])
def campaign_start():
    mode = _campaign_slot()
    slot = CAMP[mode]
    proc = slot["proc"]
    if proc is not None and proc.poll() is None:
        return jsonify({"ok": False, "error": "Campaign is already running."}), 409
    if any((CAMP[s]["proc"] is not None and CAMP[s]["proc"].poll() is None) for s in CAMP_SLOTS):
        return jsonify({"ok": False, "error": "Another campaign is still running. Stop it first."}), 409

    try:
        CAMPAIGN_LOG.write_text("", encoding="utf-8")
        env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        f = open(CAMPAIGN_LOG, "a", encoding="utf-8")
        header = f"\n{'='*60}\n  CAMPAIGN STARTED {datetime.now().strftime('%d-%m-%Y %H:%M:%S')} (via Dashboard) — mode: {mode.upper()}\n{'='*60}\n"
        f.write(header)
        f.flush()
        cmd = [sys.executable, str(SCRIPTS / "RUN_CAMPAIGN.py")]
        if mode == "full":
            cmd.append("--once")
        proc = subprocess.Popen(
            cmd,
            cwd=str(BASE),
            stdout=f, stderr=subprocess.STDOUT,
            env=env, creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        slot["proc"] = proc
        slot["started"] = datetime.now().strftime("%d-%m-%Y %H:%M:%S")
        log_line(f"Campaign started (pid {proc.pid})")
        threading.Thread(target=_reap_campaign, args=(proc, f, mode), daemon=True).start()
        return jsonify({"ok": True, "pid": proc.pid})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


def _reap_campaign(proc, f, mode):
    while proc.poll() is None:
        time.sleep(2)
    try:
        f.write(f"\n{'='*60}\n  CAMPAIGN EXITED (code {proc.returncode}) {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}\n{'='*60}\n")
        f.flush()
    except Exception:
        pass
    try:
        f.close()
    except Exception:
        pass
    if CAMP[mode]["proc"] is proc:
        CAMP[mode]["proc"] = None
    log_line(f"Campaign exited with code {proc.returncode}")


@app.route("/api/campaign/stop", methods=["POST"])
def campaign_stop():
    slot = CAMP[_campaign_slot()]
    proc = slot["proc"]
    if proc is None or proc.poll() is not None:
        return jsonify({"ok": False, "error": "No campaign is running."}), 409
    try:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       capture_output=True, timeout=10)
        log_line("Campaign stopped from dashboard")
        return jsonify({"ok": True})
    except Exception as e:
        try:
            proc.terminate()
        except Exception:
            pass
        return jsonify({"ok": True, "note": str(e)})


@app.route("/api/action/<name>", methods=["POST"])
def run_action(name):
    if name not in ("check-replies", "reminders", "report", "sync-tracking"):
        return jsonify({"ok": False, "error": "Unknown action"}), 404
    if not ACTION_LOCK.acquire(blocking=False):
        return jsonify({"ok": False, "error": "Another action is already running."}), 409

    JOB_ID[0] += 1
    job = {
        "id": JOB_ID[0], "name": name,
        "started": datetime.now().strftime("%H:%M:%S"),
        "done": False, "ok": None, "error": "", "log": "",
    }
    JOBS[job["id"]] = job

    def worker():
        try:
            sys.path.insert(0, str(SCRIPTS))
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                import RUN_CAMPAIGN as rc
                import importlib
                rc = importlib.reload(rc)
                if name == "check-replies":
                    rc.check_replies()
                    job["ok"] = "Reply check finished."
                elif name == "reminders":
                    rc.send_due_reminders(rc.Config.TRACKING_SCRIPT_URL)
                    job["ok"] = "Reminder check finished."
                elif name == "report":
                    rc.regenerate_sent_bounced_report()
                    job["ok"] = "Sent/Bounced report refreshed."
                else:
                    n, total, msg = _sync_once()
                    if n is None:
                        job["ok"] = False
                        job["error"] = msg
                    else:
                        job["ok"] = msg
            job["log"] = buf.getvalue()[-4000:]
        except Exception as e:
            job["error"] = str(e)
            job["ok"] = False
        finally:
            job["done"] = True
            ACTION_LOCK.release()
            log_line(f"Action '{name}' done")

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"ok": True, "job_id": job["id"]})


# ── Tracking sync: pull remote events into Excel (deduped, never re-counts) ─
# Runs IN-PROCESS on a background thread every 30 s so the dashboard always
# shows fresh tracking data without any external process to manage/crash.
SYNC_LIVE_LOG = LOGS_DIR / "sync_live.log"
SYNC_STATE = {"running": False, "started": None, "last": "", "error": "", "pid": os.getpid()}
SYNC_INTERVAL_S = 30


def _log_sync(line):
    try:
        with open(SYNC_LIVE_LOG, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().strftime('%d-%m-%Y %H:%M:%S')}] {line}\n")
    except Exception:
        pass


def _sync_once():
    """
    One-shot tracking sync: fetch events from the remote server (track.php),
    update the tracker Excel + event JSON. Returns (new_count, total, message)
    or (None, 0, error_message) on failure. Deduplication is persistent via
    Data/synced_event_ids.json AND the event log, so repeated syncs never
    double-count opens/clicks/visits.
    Caller (action worker) already holds ACTION_LOCK.
    """
    try:
        sys.path.insert(0, str(SCRIPTS))
        import sync_tracking_events as ste
        events = ste.fetch_events()
        if not isinstance(events, list) or not events:
            return 0, 0, "Server returned no events (nothing tracked yet)."
        total = len(events)

        if not ste.processed_events:
            ste.processed_events.update(ste.load_processed())
            seeded, pairs = ste.seed_from_log()
            ste.processed_events.update(seeded)
            for e in events:
                if (e.get("type") == "visit_end"
                        and (str(e.get("email", "") or "").strip(),
                             int(e.get("seconds") or 0)) in pairs):
                    ste.processed_events.add(ste._event_id(e))
        new_events = [e for e in events if ste._event_id(e) not in ste.processed_events]
        if not new_events:
            return 0, total, f"No new events (server has {total})."

        updated = ste.update_excel(events)
        ste.processed_events |= {ste._event_id(e) for e in new_events}
        ste.save_processed(ste.processed_events)
        return updated, total, f"Fetched {total} events — processed {updated} new."
    except Exception as e:
        return None, 0, f"Sync failed: {e}"


def _sync_loop():
    """Background loop: syncs every SYNC_INTERVAL_S while SYNC_STATE['running']."""
    while True:
        try:
            if SYNC_STATE["running"]:
                new_c, total, msg = _sync_once()
                if new_c is not None:
                    SYNC_STATE["last"] = msg
                    SYNC_STATE["error"] = ""
                    _log_sync(msg)
                else:
                    SYNC_STATE["error"] = msg
                    _log_sync("⚠ " + msg)
        except Exception as e:
            SYNC_STATE["error"] = str(e)
            _log_sync(f"⚠ Sync loop error: {e}")
        time.sleep(SYNC_INTERVAL_S)


@app.route("/api/sync/status")
def sync_status():
    return jsonify({
        "running": SYNC_STATE["running"],
        "started": SYNC_STATE["started"],
        "last": SYNC_STATE["last"],
        "error": SYNC_STATE["error"],
        "interval_s": SYNC_INTERVAL_S,
        "pid": SYNC_STATE["pid"],
        "log_file": str(SYNC_LIVE_LOG),
    })


@app.route("/api/sync/start", methods=["POST"])
def sync_start():
    if SYNC_STATE["running"]:
        return jsonify({"ok": False, "error": "Tracking sync is already running."}), 409
    SYNC_STATE["running"] = True
    SYNC_STATE["started"] = datetime.now().strftime("%d-%m-%Y %H:%M:%S")
    SYNC_STATE["error"] = ""
    _log_sync(f"▶ Auto-sync started (every {SYNC_INTERVAL_S} s, in-dashboard)")
    log_line("Tracking auto-sync started")
    threading.Thread(target=_sync_once_probe, daemon=True).start()
    return jsonify({"ok": True, "pid": SYNC_STATE["pid"]})


def _sync_once_probe():
    try:
        new_c, total, msg = _sync_once()
        if new_c is not None:
            SYNC_STATE["last"] = msg
            _log_sync(msg)
    except Exception as e:
        SYNC_STATE["error"] = str(e)


@app.route("/api/sync/stop", methods=["POST"])
def sync_stop():
    if not SYNC_STATE["running"]:
        return jsonify({"ok": False, "error": "No tracking sync is running."}), 409
    SYNC_STATE["running"] = False
    SYNC_STATE["started"] = None
    _log_sync("■ Auto-sync stopped")
    log_line("Tracking auto-sync stopped")
    return jsonify({"ok": True})


@app.route("/api/jobs")
def api_jobs():
    jobs = sorted(JOBS.values(), key=lambda j: -j["id"])[:20]
    return jsonify([{k: v for k, v in j.items() if k != "log"} for j in jobs])


@app.route("/api/jobs/<int:job_id>")
def api_job(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return jsonify(job)


@app.route("/api/log")
def api_log():
    which = request.args.get("which", "campaign")
    if which == "campaign":
        fn = CAMPAIGN_LOG
    elif which == "sync":
        fn = SYNC_LIVE_LOG
    else:
        fn = ACTIVITY_LOG
    tail = int(request.args.get("tail", 2000))
    try:
        with open(fn, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
        return jsonify({"lines": lines[-tail:]})
    except FileNotFoundError:
        return jsonify({"lines": []})


# ── Settings: read / write RUN_CAMPAIGN.py Config lines ───────────────────
CONFIG_FIELDS = [
    # (key, group, type)
    ("SENDER_EMAIL",             "Email credentials", "str"),
    ("SENDER_PASSWORD",          "Email credentials", "str"),
    ("SMTP_SERVER",              "Email credentials", "str"),
    ("SMTP_PORT",                "Email credentials", "int"),
    ("IMAP_SERVER",              "Email credentials", "str"),
    ("IMAP_PORT",                "Email credentials", "int"),
    ("DIGEST_EMAIL",             "Email credentials", "str"),
    ("DIGEST_HOUR",              "Email credentials", "int"),
    ("EXCEL_FILE_PATH",          "Files",             "path"),
    ("SHEET_NAME",               "Files",             "str"),
    ("TRACKER_FILE",             "Files",             "path"),
    ("DUPLICATES_FILE",          "Files",             "path"),
    ("EVENTS_JSON_FILE",         "Files",             "path"),
    ("SENT_BOUNCED_REPORT_FILE", "Files",             "path"),
    ("TRACKING_PORT",            "Tracking",          "int"),
    ("TRACKING_SCRIPT_URL",      "Tracking",          "str"),
    ("EMAIL_SUBJECT",            "Campaign",          "str"),
    ("FOLLOWUP_SUBJECT",         "Campaign",          "str"),
    ("EMAIL_DELAY_MIN",          "Campaign",          "int"),
    ("EMAIL_DELAY_MAX",          "Campaign",          "int"),
    ("MAX_EMAILS_PER_RUN",       "Campaign",          "int"),
    ("DAILY_SEND_LIMIT",         "Campaign",          "int"),
    ("MEETING_LINK",             "Campaign",          "str"),
    ("MEETING_AUTO_REPLY",       "Campaign",          "bool"),
    ("AUTO_CONTINUE",            "Campaign",          "bool"),
    ("BATCH_INTERVAL_MINUTES",   "Campaign",          "int"),
    ("SKIP_ALREADY_SENT",        "Campaign",          "bool"),
    ("VALIDATE_EMAILS",          "Validation",        "bool"),
    ("SMTP_CHECK_TIMEOUT",       "Validation",        "int"),
    ("TEMPLATE_FILE",            "Templates",         "path"),
    ("FOLLOWUP_TEMPLATE_FILE",   "Templates",         "path"),
]


def _load_cfg_values():
    values = {}
    for key, _, _ in CONFIG_FIELDS:
        try:
            v = getattr(get_config(), key)
            if isinstance(v, Path):
                values[key] = str(v)
            else:
                values[key] = v
        except Exception:
            values[key] = ""
    return values


@app.route("/api/config")
def api_config():
    return jsonify({"fields": CONFIG_FIELDS, "values": _load_cfg_values()})


def _apply_config_values(data):
    """Writes the given {field: value} map into the Config class of
    RUN_CAMPAIGN.py AND check_replies_and_reminders.py, so a settings save
    in the dashboard applies to every script automatically.
    Returns (ok, changed, error)."""
    files = [SCRIPTS / "RUN_CAMPAIGN.py", SCRIPTS / "check_replies_and_reminders.py"]
    all_changed = []
    for rcp in files:
        ok, changed, err = _apply_config_to_file(rcp, data)
        if not ok:
            return False, all_changed, f"{rcp.name}: {err}"
        all_changed += changed

    get_config.cache["module"] = None
    log_line(f"Config updated: {', '.join(sorted(set(all_changed)))}")
    return True, sorted(set(all_changed)), ""


def _apply_config_to_file(rcp, data):
    """Writes config keys into one script's Config class region."""
    try:
        src = rcp.read_text(encoding="utf-8")
    except Exception as e:
        return False, [], f"Could not read {rcp.name}: {e}"

    m = re.search(r"(?m)^class Config:\s*$", src)
    if not m:
        return False, [], "Config class not found"

    marker_start = m.end()  # everything after the "class Config:" line
    tail_marker = re.search(r"(?m)\ndef ", src[marker_start:])
    region_len = tail_marker.start() if tail_marker else len(src) - marker_start
    region = src[marker_start:marker_start + region_len]
    tail = src[marker_start + region_len:]

    changed = []
    for key in data:
        typ = {f[0]: f[2] for f in CONFIG_FIELDS}.get(key, "str")
        raw = data[key]
        try:
            if typ == "int":
                literal = str(int(raw))
            elif typ == "bool":
                v = str(raw).strip().lower()
                literal = "True" if v in ("1", "true", "yes", "on") else "False"
            else:
                literal = json.dumps(str(raw), ensure_ascii=False)
        except (TypeError, ValueError):
            return False, [], f"Invalid value for {key}"

        pat = re.compile(r"(?m)^(\s*" + re.escape(key) + r"\s*=\s*).*?$")
        mm = pat.search(region)
        if mm:
            region = region[:mm.start()] + mm.group(1) + literal + region[mm.end():]
        else:
            # only append keys the script already knows about — keeps the
            # reply-checker Config from growing unrelated dashboard fields
            if rcp.name != "RUN_CAMPAIGN.py":
                continue
            region = region + f"    {key} = {literal}\n"
        changed.append(key)

    new_src = src[:marker_start] + region + tail

    try:
        rcp.write_text(new_src, encoding="utf-8")
    except PermissionError:
        return False, [], "Cannot write {rcp.name} (read-only?)."

    return True, changed, ""


@app.route("/api/config", methods=["POST"])
def api_config_save():
    data = request.get_json(force=True) or {}
    ok, changed, err = _apply_config_values(data)
    if not ok:
        return jsonify({"ok": False, "error": err}), 400
    return jsonify({"ok": True, "changed": changed})


# ============================================================================
# SOURCE LEADS (the campaign Excel with all leads, plus computed status)
# ============================================================================
@app.route("/api/source-leads")
def api_source_leads():
    cfg = get_config()
    path = Path(getattr(cfg, "EXCEL_FILE_PATH", ""))
    rows = []
    try:
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        for sn in wb.sheetnames:
            ws = wb[sn]
            headers = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
            for r in ws.iter_rows(min_row=2, values_only=True):
                if r and any(v is not None and str(v).strip() not in ("", "nan", "None") for v in r):
                    rows.append({headers[i]: r[i] for i in range(min(len(headers), len(r)))})
        wb.close()
    except Exception:
        return jsonify({"count": 0, "rows": [], "error": "Could not read leads Excel. Check the EXCEL_FILE_PATH setting."})

    sent_log = {str(x).strip().lower() for x in load_sent_log() if str(x).strip()}
    _, master_rows = read_master_rows()
    sent_log |= {str(r.get("Email", "")).strip().lower() for r in master_rows if str(r.get("Email", "")).strip()}
    fake_emails = {str(f.get("Email", "")).strip().lower() for f in read_fake_rows() if str(f.get("Email", "")).strip()}

    for r in rows:
        e = str(r.get("Lead Email ID", "")).strip().lower()
        if not e or e in ("nan", "ceo mail id@gmail.com"):
            r["_status"] = "No email"
        elif e in fake_emails:
            r["_status"] = "Fake"
        elif e in sent_log:
            r["_status"] = "Sent"
        else:
            r["_status"] = "Not sent"

    dup_rows = flag_dup_companies(rows)

    q = (request.args.get("q", "") or "").strip().lower()
    st = (request.args.get("status", "") or "").strip()
    out = []
    for r in rows:
        if q and not any(q in str(v).lower() for v in r.values()):
            continue
        if st and r.get("_status") != st:
            continue
        out.append(r)

    counts = {}
    for r in rows:
        k = r.get("_status", "?")
        counts[k] = counts.get(k, 0) + 1
    return jsonify({"count": len(out), "rows": out, "counts": counts,
                    "dup_rows": dup_rows})


# ============================================================================
# EMAIL LIST — the emails we send to. Add / delete with duplicate protection.
# ============================================================================
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")

# Column names looked up in the leads Excel (only existing ones are filled)
ADD_COLUMN_MAP = [
    ("Company Name", "company"),
    ("CEO Name", "ceo"),
    ("Lead Email ID", "email"),
    ("Country", "country"),
    ("Region", "region"),
    ("Major Industries", "industries"),
]


def _leads_workbook():
    """Opens the source leads workbook for writing. Raises on locked file."""
    cfg = get_config()
    path = Path(getattr(cfg, "EXCEL_FILE_PATH", ""))
    wb = openpyxl.load_workbook(path)
    sheet = getattr(cfg, "SHEET_NAME", "Sheet1")
    ws = wb[sheet] if sheet in wb.sheetnames else wb.active
    return wb, ws, path


def _excel_emails(ws):
    headers = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
    try:
        ecol = headers.index("Lead Email ID") + 1
    except ValueError:
        return [], headers, None
    emails = []
    for r in ws.iter_rows(min_row=2):
        v = r[ecol - 1].value
        if v and str(v).strip().lower() not in ("nan", "none"):
            emails.append(str(v).strip())
    return emails, headers, ecol


@app.route("/api/email-list")
def api_email_list():
    cfg = get_config()
    path = Path(getattr(cfg, "EXCEL_FILE_PATH", ""))
    rows = []
    try:
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        ws = wb[getattr(cfg, "SHEET_NAME", "Sheet1")] if getattr(cfg, "SHEET_NAME", "Sheet1") in wb.sheetnames else wb.active
        headers = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
        idx = {h: i for i, h in enumerate(headers) if h}
        for r in ws.iter_rows(min_row=2, values_only=True):
            if r and any(v is not None and str(v).strip() not in ("", "nan", "None") for v in r):
                rows.append({headers[i]: r[i] for i in range(min(len(headers), len(r)))})
        wb.close()
    except PermissionError:
        return jsonify({"rows": [], "counts": {},
                        "sent_blocked": [], "error": "Tracker Excel is open in Excel — close it first."})
    except Exception as e:
        return jsonify({"rows": [], "counts": {},
                        "sent_blocked": [], "error": f"Could not read leads Excel: {e}"})

    sent_log = {str(x).strip().lower() for x in load_sent_log() if str(x).strip()}
    fake_emails = {str(f.get("Email", "")).strip().lower() for f in read_fake_rows() if str(f.get("Email", "")).strip()}

    for r in rows:
        e = str(r.get("Lead Email ID", "")).strip().lower()
        if not e or e in ("nan", "ceo mail id@gmail.com"):
            r["_status"] = "No email"
        elif e in fake_emails:
            r["_status"] = "Fake"
        elif e in sent_log:
            r["_status"] = "Sent"
        else:
            r["_status"] = "Not sent"

    dup_rows = flag_dup_companies(rows)

    # Merge: every email that was EVER sent from this campaign must stay
    # visible in the Email List too — even if its row was removed from the
    # leads Excel (e.g. a CSV was deleted). Sent data lives forever: here
    # (from the tracker master sheet) AND on the Leads tab.
    excel_emails = {str(r.get("Lead Email ID", "")).strip().lower()
                    for r in rows if str(r.get("Lead Email ID", "")).strip().lower() not in ("", "nan")}
    try:
        _tr = openpyxl.load_workbook(tracker_path(), data_only=True, read_only=True)
        tname = next((n for n in ("Total Sent", "Current Sent") if n in _tr.sheetnames), None)
        if tname:
            tws = _tr[tname]
            th = [str(c.value).strip() if c.value is not None else "" for c in tws[1]]
            ti = {h: i for i, h in enumerate(th) if h}
            ei = ti.get("Email")
            if ei is not None:
                for tr in tws.iter_rows(min_row=2, values_only=True):
                    if not tr or ei >= len(tr) or not tr[ei]:
                        continue
                    te = str(tr[ei]).strip().lower()
                    if te in excel_emails or te not in sent_log:
                        continue
                    gv = lambda k: str(tr[ti[k]]).strip() if k in ti and ti[k] < len(tr) and tr[ti[k]] is not None else ""
                    rows.append({
                        "Company Name": gv("Company"),
                        "CEO Name": gv("Contact Person"),
                        "Lead Email ID": gv("Email"),
                        "Country": gv("Country"),
                        "Region": gv("Region"),
                        "Major Industries": "",
                        "City": gv("City"),
                        "_status": "Sent",
                    })
                    excel_emails.add(te)
        _tr.close()
    except Exception:
        pass

    q = (request.args.get("q", "") or "").strip().lower()
    st = (request.args.get("status", "") or "").strip()
    out = []
    for r in rows:
        if q and not any(q in str(v).lower() for v in r.values()):
            continue
        if st and r.get("_status") != st:
            continue
        out.append(r)

    counts = {}
    for r in rows:
        k = r.get("_status", "?")
        counts[k] = counts.get(k, 0) + 1

    return jsonify({
        "count": len(out),
        "rows": out,
        "counts": counts,
        "dup_rows": dup_rows,
        "sent_blocked": sorted(sent_log),
        "error": "",
    })


@app.route("/api/email-list/add", methods=["POST"])
def api_email_list_add():
    data = request.get_json(force=True) or {}
    email = str(data.get("email", "") or "").strip()
    if not email:
        return jsonify({"ok": False, "error": "Email address is required."}), 400
    if not _EMAIL_RE.match(email):
        return jsonify({"ok": False, "error": "Invalid email format."}), 400

    try:
        wb, ws, path = _leads_workbook()
    except PermissionError:
        return jsonify({"ok": False, "error": "The leads Excel is open in Excel — close it first, then try again."}), 409
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not open leads Excel: {e}"}), 500

    try:
        emails, headers, ecol = _excel_emails(ws)
        email_l = email.lower()

        # Duplicate already in the list?
        if any(e.lower() == email_l for e in emails):
            wb.close()
            return jsonify({"ok": False, "error": f"Duplicate! '{email}' is already in the email list."}), 409

        # Was it sent before? (once sent, never allowed again)
        sent_log = {str(x).strip().lower() for x in load_sent_log()}
        already_sent = email_l in sent_log
        if already_sent:
            wb.close()
            return jsonify({"ok": False,
                            "error": f"'{email}' was ALREADY SENT before — re-sending is blocked (duplicate protection)."}), 409

        header_list = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
        row = ws.max_row + 1
        for h, key in ADD_COLUMN_MAP:
            if h in header_list and data.get(key):
                ws.cell(row=row, column=header_list.index(h) + 1, value=str(data[key]).strip())
        ws.cell(row=row, column=header_list.index("Lead Email ID") + 1, value=email)
        wb.save(path)
        wb.close()
        log_line(f"Email added to list: {email}")
        return jsonify({"ok": True, "email": email})
    except PermissionError:
        try:
            wb.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": "The leads Excel is open in Excel — close it first, then try again."}), 409
    except Exception as e:
        try:
            wb.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": f"Could not save: {e}"}), 500


def _upload_header_classify(norm):
    """Maps a normalised uploaded-file header to a leads-field key."""
    if any(s in norm for s in ("email", "e-mail", "mail id", "mail address")):
        return "email"
    if any(s in norm for s in ("company", "organization", "organisation", "business", "firm")):
        return "company"
    if any(s in norm for s in ("ceo", "contact person", "contact name", "director", "founder", "representative")):
        return "ceo"
    if "country" in norm:
        return "country"
    if any(s in norm for s in ("region", "state", "province")):
        return "region"
    if any(s in norm for s in ("industr", "sector")):
        return "industries"
    return None


def _parse_upload_file(f):
    """Reads a CSV / XLSX / XLS upload. Returns (name, col_map, records, error).
    `col_map`: leads-field -> index in the uploaded row.
    `records`: list of dicts with the mapped fields (only non-empty emails)."""
    name = Path(f.filename).name
    ext = Path(f.filename).suffix.lower()
    raw = f.read()
    if not raw:
        return name, {}, [], f"'{name}' is empty."

    try:
        if ext == ".csv":
            text = raw.decode("utf-8-sig", errors="replace")
            rows = list(csv.reader(io.StringIO(text, newline="")))
            rows = [r for r in rows if any(c and str(c).strip() for c in r)]
            if not rows:
                raise ValueError("no data rows found")
            headers, data_rows = [str(c).strip() for c in rows[0]], rows[1:]
        elif ext in (".xlsx", ".xlsm", ".xls"):
            if ext == ".xls":  # old Excel — needs pandas
                try:
                    import pandas as pd
                except Exception:
                    return name, {}, [], "Old .xls files need 'pandas' — convert the file to .xlsx or install pandas (pip install pandas)."
                df = pd.read_excel(io.BytesIO(raw), engine="xlrd")
                headers = [str(c).strip() for c in df.columns]
                data_rows = []
                for _, r in df.iterrows():
                    data_rows.append([r[c] if r[c] is not None and str(r[c]).strip().lower() not in ("nan", "none") else "" for c in df.columns])
            else:
                wb_up = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
                ws_up = wb_up[wb_up.sheetnames[0]]
                all_rows = list(ws_up.iter_rows(values_only=True))
                all_rows = [r for r in all_rows if any(v is not None and str(v).strip() for v in r)]
                wb_up.close()
                if not all_rows:
                    raise ValueError("no data rows found")
                headers = [str(c).strip() if c is not None else "" for c in all_rows[0]]
                data_rows = [[v if v is not None else "" for v in r] for r in all_rows[1:]]
        else:
            return name, {}, [], f"Unsupported file type '{ext}' — use .csv, .xlsx or .xls."
    except Exception as e:
        return name, {}, [], f"Could not read '{name}': {e}"

    col_map = {}  # field -> index in uploaded data row
    for i, h in enumerate(headers):
        field = _upload_header_classify(re.sub(r"\s+", " ", str(h or "").strip().lower()))
        if field and field not in col_map:
            col_map[field] = i
    if "email" not in col_map:
        return name, {}, [], "No email column found in the file. Add a column named 'Email' (or 'Lead Email ID', 'Client Email'…)."

    records = []
    for r in data_rows:
        rec = {}
        for field, i in col_map.items():
            v = r[i] if i < len(r) else ""
            rec[field] = str(v).strip() if v is not None else ""
        if rec.get("email"):
            records.append(rec)
    return name, col_map, records, ""


UPLOADS_FILE = DATA / "dashboard_logs" / "upload_batches.json"


def _load_uploads():
    try:
        with open(UPLOADS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, list) else []
    except Exception:
        return []


def _save_uploads(items):
    try:
        UPLOADS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(UPLOADS_FILE, "w", encoding="utf-8") as f:
            json.dump(items, f, indent=2, ensure_ascii=False)
    except Exception as e:
        log_line(f"Could not save upload registry: {e}")


@app.route("/api/email-list/upload", methods=["POST"])
def api_email_list_upload():
    """Bulk-import a client list from a CSV (.csv) or Excel (.xlsx/.xls) file.

    Column names in the file are matched loosely (case-insensitive, synonyms
    like "Email" / "Lead Email ID" / "Client Email" are all recognised).
    Duplicate protection is applied the same way as manual Add: emails already
    in the list are skipped, emails sent before are blocked.

    With `dry_run=1` (from the preview step) nothing is written — a per-row
    preview + counts are returned instead.
    """
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify({"ok": False, "error": "No file received — select a CSV or Excel file first."}), 400

    dry = request.form.get("dry_run") == "1"
    name, col_map, records, err = _parse_upload_file(f)
    if err:
        return jsonify({"ok": False, "error": err}), 400
    if not records:
        return jsonify({"ok": False, "error": f"'{name}' has no rows with an email address."}), 400
    total = len(records)

    cols_labels = {"email": "Email", "company": "Company Name", "ceo": "CEO Name",
                   "country": "Country", "region": "Region", "industries": "Major Industries"}

    # ---- evaluate every row against the live list + sent log --------------
    try:
        wb, ws, path = _leads_workbook()
    except PermissionError:
        return jsonify({"ok": False, "error": "The leads Excel is open in Excel — close it first, then try again."}), 409
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not open leads Excel: {e}"}), 500

    try:
        existing_emails, _headers, _ecol = _excel_emails(ws)
        existing = {e.lower() for e in existing_emails if e}
        sent_log = {str(x).strip().lower() for x in load_sent_log()}
        header_list = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]

        # classify phase only — used by both preview and real import
        verdicts = []  # (rec, status)
        added = dup = sent = invalid = 0
        for rec in records:
            email = rec.get("email", "").lower()
            if not _EMAIL_RE.match(email):
                verdicts.append((rec, "invalid")); invalid += 1
            elif email in sent_log:
                verdicts.append((rec, "sent")); sent += 1
            elif email in existing:
                verdicts.append((rec, "dup")); dup += 1
            else:
                verdicts.append((rec, "added")); added += 1

        if dry:
            wb.close()
            rows = [{"status": st, "email": rec.get("email", ""),
                     "company": rec.get("company", ""), "ceo": rec.get("ceo", ""),
                     "country": rec.get("country", ""), "region": rec.get("region", ""),
                     "industries": rec.get("industries", "")}
                    for rec, st in verdicts]
            return jsonify({"ok": True, "preview": True, "file": name, "total": total,
                            "added": added, "skipped_dup": dup, "skipped_sent": sent,
                            "skipped_invalid": invalid,
                            "cols": col_map, "cols_labels": cols_labels,
                            "rows": rows})

        for rec, st in verdicts:
            if st != "added":
                continue
            row = ws.max_row + 1
            for h, key in ADD_COLUMN_MAP:
                if h in header_list and rec.get(key):
                    ws.cell(row=row, column=header_list.index(h) + 1, value=rec[key])
            ws.cell(row=row, column=header_list.index("Lead Email ID") + 1, value=rec["email"])

        wb.save(path)
        wb.close()
        log_line(f"Bulk upload '{name}': {total} rows → added {added}, dup {dup}, already-sent {sent}, invalid {invalid}")
        batch_id = datetime.now().strftime("%Y%m%d%H%M%S%f")
        if added:
            batch = {"id": batch_id, "file": name,
                     "when": datetime.now().strftime("%d-%m-%Y %H:%M:%S"),
                     "emails": [rec["email"].lower() for rec, st in verdicts if st == "added"]}
            ups = _load_uploads()
            ups.append(batch)
            _save_uploads(ups)
        return jsonify({"ok": True, "file": name, "total": total, "added": added,
                        "skipped_dup": dup, "skipped_sent": sent, "skipped_invalid": invalid,
                        "cols": col_map, "batch_id": batch_id})
    except PermissionError:
        try:
            wb.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": "The leads Excel is open in Excel — close it first, then try again."}), 409
    except Exception as e:
        try:
            wb.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": f"Could not save: {e}"}), 500


@app.route("/api/email-list/uploads")
def api_email_list_uploads():
    sent_log = {str(x).strip().lower() for x in load_sent_log()}
    batches = [{"id": b.get("id", ""), "file": b.get("file", ""),
                "when": b.get("when", ""), "count": len(b.get("emails", []) or []),
                "sent_count": sum(1 for e in (b.get("emails", []) or []) if str(e).strip().lower() in sent_log)}
               for b in _load_uploads()]
    return jsonify({"ok": True, "batches": batches})


@app.route("/api/email-list/upload/remove", methods=["POST"])
def api_email_list_upload_remove():
    """Deletes ONLY the rows that were added by one specific CSV/Excel upload.

    Emails that also appear in ANOTHER upload batch are kept (they were
    legitimately added by that file too). Emails already sent are also kept
    safe — the sent log never allows re-sending regardless.
    """
    data = request.get_json(force=True) or {}
    bid = str(data.get("batch_id", "") or "").strip()
    ups = _load_uploads()
    batch = next((b for b in ups if b.get("id") == bid), None)
    if not batch:
        return jsonify({"ok": False, "error": "Upload batch not found — it may have been removed already."}), 404

    emails = [str(e).strip().lower() for e in batch.get("emails", []) or []]
    others = set()
    for b in ups:
        if b.get("id") != bid:
            others.update(str(e).strip().lower() for e in b.get("emails", []) or [])
    sent_log = {str(x).strip().lower() for x in load_sent_log()}
    # Without purge: SENT leads stay stored forever (list + tracker + log).
    # With purge: everything this file added is removed, sent records too.
    # SENT leads are NEVER removed — sent data is stored forever: in the
    # email list (leads Excel, and even if those rows are gone, they are
    # merged back via the tracker) and on the Leads tab. Removing a file
    # only ever deletes its UNSENT rows.
    to_delete = [e for e in emails if e and e not in others and e not in sent_log]
    kept_sent = sum(1 for e in emails if e and e in sent_log)

    if not to_delete:
        ups = [b for b in ups if b.get("id") != bid]
        _save_uploads(ups)
        if kept_sent:
            return jsonify({"ok": True, "removed": 0, "kept_sent": kept_sent,
                            "note": f"{kept_sent} already-sent lead(s) kept — sent data stays in the Email List + Leads tab forever."})
        return jsonify({"ok": True, "removed": 0,
                        "note": "All emails from this file were also imported by another file — list rows kept."})

    try:
        wb, ws, path = _leads_workbook()
    except PermissionError:
        return jsonify({"ok": False, "error": "The leads Excel is open in Excel — close it first, then try again."}), 409
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not open leads Excel: {e}"}), 500

    try:
        emails_cur, _h, ecol = _excel_emails(ws)
        target = set(to_delete)
        row_numbers = []
        for r in ws.iter_rows(min_row=2):
            v = r[ecol - 1].value
            if v and str(v).strip().lower() in target:
                row_numbers.append(r[0].row)
        for rnum in reversed(row_numbers):
            ws.delete_rows(rnum)
        wb.save(path)
        wb.close()
        ups = [b for b in ups if b.get("id") != bid]
        _save_uploads(ups)
        log_line(f"Removed uploaded batch '{batch['file']}': {len(row_numbers)} row(s) (kept {kept_sent} already-sent)")
        return jsonify({"ok": True, "removed": len(row_numbers), "kept_sent": kept_sent})
    except PermissionError:
        try:
            wb.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": "The leads Excel is open in Excel — close it first, then try again."}), 409
    except Exception as e:
        try:
            wb.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": f"Could not remove: {e}"}), 500


# ============================================================================
# RAW DATA — messy/unstructured import → extract → validate → organise → send
# ============================================================================
_RAW_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
_RAW_MAX_ROWS = 500
_RAW_BATCH = {"file": "", "when": "", "rows": []}   # in-memory session batch
_RAW_LOCK = threading.Lock()
_RAW_VALID_CACHE = {}                                # email -> (verdict, reason)


def _extract_raw_emails(f):
    """Parses a raw/messy file (csv/xlsx/xls/txt) into rows of
    {email, company, ceo}. If there is an email-looking header the columns
    are mapped; otherwise every cell is regex-scanned for addresses.
    Returns (rows, error)."""
    name = Path(f.filename).name
    ext = Path(f.filename).suffix.lower()
    raw = f.read()
    if not raw:
        return [], f"'{name}' is empty."

    cells = []
    try:
        if ext == ".csv":
            text = raw.decode("utf-8-sig", errors="replace")
            rows = [r for r in csv.reader(io.StringIO(text, newline="")) if any(c and str(c).strip() for c in r)]
            if not rows:
                return [], f"'{name}' has no data rows."
            cells = [[str(c).strip() for c in r] for r in rows]
        elif ext == ".txt":
            text = raw.decode("utf-8-sig", errors="replace")
            cells = [[ln.strip()] for ln in text.splitlines() if ln.strip()]
        elif ext in (".xlsx", ".xlsm", ".xls"):
            if ext == ".xls":  # old Excel — needs pandas
                try:
                    import pandas as pd
                except Exception:
                    return [], "Old .xls files need 'pandas' — convert to .xlsx or install pandas (pip install pandas)."
                df = pd.read_excel(io.BytesIO(raw), engine="xlrd")
                cells = [["" if v is None or str(v).strip().lower() in ("nan", "none") else str(v).strip() for v in r]
                         for r in df.itertuples(index=False, name=None)]
            else:
                wb2 = openpyxl.load_workbook(io.BytesIO(raw), data_only=True, read_only=True)
                ws2 = wb2[wb2.sheetnames[0]]
                cells = [[str(c).strip() if c is not None else "" for c in r] for r in ws2.iter_rows(values_only=True)]
                wb2.close()
                cells = [r for r in cells if any(c for c in r)]
        else:
            return [], f"Unsupported file type '{ext}' — use .csv, .xlsx, .xls or .txt."
    except Exception as e:
        return [], f"Could not read '{name}': {e}"
    if not cells:
        return [], f"'{name}' has no data rows."

    # Structured? (first row has an email-ish header)
    structured = False
    try:
        structured = any(_upload_header_classify(re.sub(r"\s+", " ", h.lower())) == "email"
                         for h in cells[0])
    except Exception:
        pass

    rows, seen = [], set()
    if structured:
        col_map = {}
        for i, h in enumerate(cells[0]):
            f_ = _upload_header_classify(re.sub(r"\s+", " ", str(h).lower()))
            if f_ and f_ not in col_map:
                col_map[f_] = i
        for r in cells[1:]:
            rec = {}
            for f_, i in col_map.items():
                rec[f_] = r[i] if i < len(r) else ""
            for em in _RAW_EMAIL_RE.findall(rec.get("email", "")):
                if em.lower() in seen:
                    continue
                seen.add(em.lower())
                rows.append({"email": em, "company": rec.get("company", ""), "ceo": rec.get("ceo", "")})
    else:
        for r in cells:
            found, cands = None, []
            for c in r:
                if not c:
                    continue
                hits = _RAW_EMAIL_RE.findall(c)
                if found is None and hits:
                    found = hits[0]
                elif not hits and len(c) >= 3 and not c.lower().startswith(("http", "www")):
                    cands.append(c)
            if not found or found.lower() in seen:
                continue
            bad = ("noemail", "no email", "none@", "example.com", "yourname", "test@")
            if any(b in found.lower() for b in bad):
                continue
            seen.add(found.lower())
            company = max(cands, key=len)[:60] if cands else ""
            if not company:
                dom = found.split("@")[-1].rsplit(".", 1)[0]
                company = dom.replace(".", " ").replace("-", " ").title()
            rows.append({"email": found, "company": company, "ceo": ""})
        if len(rows) > _RAW_MAX_ROWS:
            rows = rows[:_RAW_MAX_ROWS]
    if not rows:
        return [], f"No valid email addresses found in '{name}'."
    return rows, None


def _validate_raw_batch(rows):
    """Real/fake validation for every extracted email (reuses RUN_CAMPAIGN's
    multi-layer check: syntax → disposable domain → MX → SMTP mailbox).
    Results are cached so repeat previews/saves don't re-verify."""
    mod = _rc_module()
    sender = mod.Config.SENDER_EMAIL

    def check(row):
        key = row["email"].strip().lower()
        if key in _RAW_VALID_CACHE:
            v, r_ = _RAW_VALID_CACHE[key]
            return {**row, "valid": v, "reason": r_}
        v, r_ = mod.validate_email(key, sender)
        _RAW_VALID_CACHE[key] = (v, r_)
        return {**row, "valid": v, "reason": r_}

    try:
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
            return list(ex.map(check, rows))
    except Exception:
        return [check(r) for r in rows]


def _raw_slice(emails):
    """Returns the current batch rows whose email is in `emails`."""
    want = {str(e).strip().lower() for e in (emails or [])}
    with _RAW_LOCK:
        return [r for r in _RAW_BATCH.get("rows", [])
                if r["email"].strip().lower() in want]


@app.route("/api/email-list/raw/preview", methods=["POST"])
def api_raw_preview():
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify({"ok": False, "error": "No file received — select a raw CSV / Excel / TXT file first."}), 400
    rows, err = _extract_raw_emails(f)
    if err:
        return jsonify({"ok": False, "error": err}), 400
    with _RAW_LOCK:
        _RAW_BATCH["file"] = Path(f.filename).name
        _RAW_BATCH["when"] = datetime.now().strftime("%d-%m-%Y %H:%M:%S")
        _RAW_BATCH["rows"] = _validate_raw_batch(rows)
        out = [{"email": r["email"], "company": r.get("company", ""), "ceo": r.get("ceo", ""),
                "valid": r["valid"], "reason": r.get("reason", "")} for r in _RAW_BATCH["rows"]]
        counts = {}
        for r in _RAW_BATCH["rows"]:
            counts[r["valid"]] = counts.get(r["valid"], 0) + 1
    log_line(f"Raw import preview: {_RAW_BATCH['file']} — {len(out)} emails (real {counts.get('real',0)} / fake {counts.get('fake',0)} / unknown {counts.get('unknown',0)})")
    return jsonify({"ok": True, "file": _RAW_BATCH["file"], "total": len(out),
                    "counts": {"real": counts.get("real", 0), "fake": counts.get("fake", 0),
                               "unknown": counts.get("unknown", 0)}, "rows": out})


@app.route("/api/email-list/raw/save", methods=["POST"])
def api_raw_save():
    """Writes the selected extracted rows into a NEW structured Excel file
    (Real Leads sheet + Fake/Errors sheet with validation reasons)."""
    data = request.get_json(force=True) or {}
    rows = _raw_slice(data.get("emails"))
    if not rows:
        return jsonify({"ok": False, "error": "No matching rows in the current raw batch."}), 400
    path = DATA / f"Raw_Import_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    try:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Real Leads"
        ws.append(["Company Name", "CEO Name", "Lead Email ID", "Country", "Region",
                   "Major Industries", "Email Send Status", "Validation", "Validation Reason"])
        for r in rows:
            ws.append([r.get("company", ""), r.get("ceo", ""), r["email"], "", "", "",
                       "Not sent" if r["valid"] == "real" else "Skipped",
                       r["valid"], r.get("reason", "")])
        bad = [r for r in rows if r["valid"] != "real"]
        if bad:
            ws2 = wb.create_sheet("Fake & Errors")
            ws2.append(["Company Name", "CEO Name", "Lead Email ID", "Validation", "Validation Reason"])
            for r in bad:
                ws2.append([r.get("company", ""), r.get("ceo", ""), r["email"], r["valid"], r.get("reason", "")])
        wb.save(path)
    except PermissionError:
        return jsonify({"ok": False, "error": "The raw Excel file is open in Excel — close it first."}), 409
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not save Excel: {e}"}), 500
    log_line(f"Raw import organised into {path.name} ({len(rows)} rows)")
    return jsonify({"ok": True, "file": path.name, "count": len(rows)})


@app.route("/api/email-list/raw/real", methods=["POST"])
def api_raw_real():
    """Builds a downloadable ORGANISED Excel of ALL validated REAL emails
    from the current raw batch — fakes/unknowns are never included."""
    with _RAW_LOCK:
        rows = [r for r in _RAW_BATCH.get("rows", []) if r["valid"] == "real"]
    if not rows:
        return jsonify({"ok": False, "error": "No validated REAL emails in the current raw batch."}), 400
    path = DATA / f"Raw_Real_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    try:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Real Leads"
        ws.append(["Company Name", "CEO Name", "Lead Email ID", "Country",
                   "Region", "Major Industries", "Email Send Status", "Validation"])
        for r in rows:
            ws.append([r.get("company", ""), r.get("ceo", ""), r["email"], "", "", "",
                       "Not sent", r["valid"]])
        wb.save(path)
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not save real list: {e}"}), 500
    log_line(f"Raw real list exported: {path.name} ({len(rows)} emails)")
    return jsonify({"ok": True, "file": path.name, "count": len(rows)})


@app.route("/api/email-list/raw/fake", methods=["POST"])
def api_raw_fake():
    """Builds a downloadable Excel of ALL fake/unknown emails extracted from
    the current raw batch (with validation reasons)."""
    with _RAW_LOCK:
        rows = [r for r in _RAW_BATCH.get("rows", []) if r["valid"] != "real"]
    if not rows:
        return jsonify({"ok": False, "error": "No fake/invalid emails in the current raw batch."}), 400
    path = DATA / f"Raw_Fake_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    try:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Fake Emails"
        ws.append(["No.", "Email Address", "Company", "Contact", "Validation", "Reason"])
        for i, r in enumerate(rows, start=1):
            ws.append([i, r["email"], r.get("company", ""), r.get("ceo", ""), r["valid"], r.get("reason", "")])
        wb.save(path)
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not save fake list: {e}"}), 500
    log_line(f"Raw fake list exported: {path.name} ({len(rows)} emails)")
    return jsonify({"ok": True, "file": path.name, "count": len(rows)})


@app.route("/api/email-list/fake/download", methods=["POST", "GET"])
def api_fake_download():
    """Downloads the tracker's accumulated 'Fake CEO Email' sheet (everything
    the campaign ever skipped as fake) as a ready-made Excel file."""
    rows = read_fake_rows()
    if not rows:
        return jsonify({"ok": False, "error": "No fake emails recorded yet."}), 404
    path = DATA / f"Fake_Emails_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    try:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Fake Emails"
        keys = list(rows[0].keys())
        ws.append(keys)
        for r in rows:
            ws.append([r.get(k, "") for k in keys])
        wb.save(path)
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not save fake list: {e}"}), 500
    log_line(f"Tracker fake list exported: {path.name} ({len(rows)} records)")
    return jsonify({"ok": True, "file": path.name, "count": len(rows)})


@app.route("/api/email-list/raw/download")
def api_raw_download():
    fn = Path(request.args.get("file", "")).name
    p = Path(DATA) / fn
    if not p.exists() or p.parent != DATA:
        return jsonify({"ok": False, "error": "File not found."}), 404
    return send_file(str(p), as_attachment=True, download_name=p.name)


@app.route("/api/email-list/raw/add", methods=["POST"])
def api_raw_add():
    """Adds ONLY validated REAL emails to the Email List (master leads Excel),
    with the same duplicate + already-sent protection as upload."""
    data = request.get_json(force=True) or {}
    rows = [r for r in _raw_slice(data.get("emails")) if r["valid"] == "real"]
    if not rows:
        return jsonify({"ok": False, "error": "No validated REAL emails selected."}), 400
    try:
        wb, ws, path = _leads_workbook()
    except PermissionError:
        return jsonify({"ok": False, "error": "The leads Excel is open in Excel — close it first, then try again."}), 409
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not open leads Excel: {e}"}), 500
    try:
        existing = {e.lower() for e in _excel_emails(ws)[0] if e}
        sent_log = {str(x).strip().lower() for x in load_sent_log()}
        header_list = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
        added = dup = sent = 0
        for r in rows:
            e = r["email"].strip().lower()
            if e in sent_log:
                sent += 1
                continue
            if e in existing:
                dup += 1
                continue
            row = ws.max_row + 1
            for h, key in ADD_COLUMN_MAP:
                if h in header_list and r.get(key):
                    ws.cell(row=row, column=header_list.index(h) + 1, value=r[key][:240])
            ws.cell(row=row, column=header_list.index("Lead Email ID") + 1, value=r["email"])
            existing.add(e)
            added += 1
        wb.save(path)
        wb.close()
        log_line(f"Raw import added to list: {added} real email(s) (dup {dup}, already-sent {sent})")
        return jsonify({"ok": True, "added": added, "skipped_dup": dup, "skipped_sent": sent})
    except PermissionError:
        try:
            wb.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": "The leads Excel is open in Excel — close it first, then try again."}), 409
    except Exception as e:
        try:
            wb.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": f"Could not save: {e}"}), 500


@app.route("/api/email-list/raw/send", methods=["POST"])
def api_raw_send():
    """Sends emails ONLY to validated REAL rows of the raw batch. Every send
    result (success or error) is reported back per email."""
    data = request.get_json(force=True) or {}
    rows = [r for r in _raw_slice(data.get("emails")) if r["valid"] == "real"]
    if not rows:
        return jsonify({"ok": False, "error": "No validated REAL emails selected — fake/invalid emails are never sent."}), 400
    sent_log = {str(x).strip().lower() for x in load_sent_log()}
    results = []
    for r in rows:
        if r["email"].strip().lower() in sent_log:
            results.append({"email": r["email"], "ok": False,
                            "error": "Already sent before — skipped (duplicate protection)"})
            continue
        try:
            ok, msg = send_single_email(r["email"], company=r.get("company", ""), ceo=r.get("ceo", ""))
        except Exception as e:
            ok, msg = False, str(e)
        results.append({"email": r["email"], "ok": ok, "error": None if ok else msg})
        time.sleep(2)   # polite delay between sends
    sent_n = sum(1 for x in results if x["ok"])
    log_line(f"Raw import send: {sent_n}/{len(results)} delivered to validated real emails")
    return jsonify({"ok": True, "sent": sent_n, "failed": len(results) - sent_n,
                    "results": results})


# ============================================================================
# SINGLE SEND — send one personalised email straight from the Email List
# ============================================================================
def _rc_module():
    """Freshly loaded RUN_CAMPAIGN module (same importlib trick as get_config)."""
    import importlib
    sys.path.insert(0, str(SCRIPTS))
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        mod = importlib.import_module("RUN_CAMPAIGN")
        mod = importlib.reload(mod)
    return mod


def send_single_email(email, subject=None, company=None, ceo=None, country=None, city=None):
    """Sends one personalised campaign email to `email`. Returns (ok, message).
    If company/ceo are NOT given they are looked up in the leads Excel."""
    mod = _rc_module()
    cfg = mod.Config
    email_l = email.strip().lower()

    if company is None:
        wb = openpyxl.load_workbook(Path(cfg.EXCEL_FILE_PATH), data_only=True)
        try:
            sheet = getattr(cfg, "SHEET_NAME", "Sheet1")
            ws = wb[sheet] if sheet in wb.sheetnames else wb.active
            headers = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
            hdr = {h: i for i, h in enumerate(headers) if h}
            if "Lead Email ID" not in hdr:
                return False, "Leads Excel has no 'Lead Email ID' column."
            ecol = hdr["Lead Email ID"]
            row = None
            for r in ws.iter_rows(min_row=2, values_only=True):
                if r and r[ecol] and str(r[ecol]).strip().lower() == email_l:
                    row = r
                    break
            if row is None:
                return False, f"'{email}' was not found in the leads Excel."
            getv = lambda k: str(row[hdr[k]]).strip() if k in hdr and hdr[k] < len(row) and row[hdr[k]] is not None else ""
            company, ceo = getv("Company Name"), getv("CEO Name")
            country, city = getv("Country"), getv("City")
        finally:
            wb.close()

    company = company or email.split("@")[-1].rsplit(".", 1)[0].replace(".", " ").title()
    ceo = ceo or ""
    country = country or ""
    city = city or ""

    subject = subject or cfg.EMAIL_SUBJECT.format(company_name=company)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        ok, message = mod.send_email(email, ceo, company, subject, cfg.TRACKING_SCRIPT_URL,
                                     country=country, city=city)
    if ok:
        mod.DuplicateTracker().mark_sent(email)
        lang = mod.get_language_for_location(country, city)
        mod.save_email_record(company, ceo, email, subject, country=country, city=city,
                              language=mod.LANGUAGE_NAMES.get(lang, "English"), status="Sent")
        mod.flush_saved_records()
    return ok, message


@app.route("/api/email-list/send", methods=["POST"])
def api_email_list_send():
    data = request.get_json(force=True) or {}
    email = str(data.get("email", "") or "").strip()
    if not email:
        return jsonify({"ok": False, "error": "Email address is required."}), 400
    if not _EMAIL_RE.match(email):
        return jsonify({"ok": False, "error": "Invalid email format."}), 400

    email_l = email.lower()
    if email_l in {str(x).strip().lower() for x in load_sent_log()}:
        return jsonify({"ok": False, "error": f"'{email}' was ALREADY SENT before — re-sending is blocked (duplicate protection)."}), 409
    fake = {str(x.get("Email", "")).strip().lower() for x in read_fake_rows() if str(x.get("Email", "")).strip()}
    if email_l in fake:
        return jsonify({"ok": False, "error": f"'{email}' is marked FAKE (invalid mailbox) — not sending."}), 409

    try:
        ok, message = send_single_email(email)
    except Exception as e:
        return jsonify({"ok": False, "error": f"Send failed: {e}"}), 500
    if ok:
        log_line(f"Single email sent: {email}")
        return jsonify({"ok": True, "email": email})
    return jsonify({"ok": False, "error": f"Send failed: {message}"}), 500

@app.route("/api/email-list/delete", methods=["POST"])
def api_email_list_delete():
    data = request.get_json(force=True) or {}
    email = str(data.get("email", "") or "").strip().lower()
    if not email:
        return jsonify({"ok": False, "error": "Email address is required."}), 400

    try:
        wb, ws, path = _leads_workbook()
    except PermissionError:
        return jsonify({"ok": False, "error": "The leads Excel is open in Excel — close it first, then try again."}), 409
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not open leads Excel: {e}"}), 500

    try:
        emails, headers, ecol = _excel_emails(ws)
        row_numbers = []
        for r in ws.iter_rows(min_row=2):
            v = r[ecol - 1].value
            if v and str(v).strip().lower() == email:
                row_numbers.append(r[0].row)
        if not row_numbers:
            wb.close()
            return jsonify({"ok": False, "error": "Email not found in the list."}), 404
        for rnum in reversed(row_numbers):
            ws.delete_rows(rnum)
        wb.save(path)
        wb.close()
        log_line(f"Email removed from list: {email} ({len(row_numbers)} row(s))")
        return jsonify({"ok": True, "removed": len(row_numbers)})
    except PermissionError:
        try:
            wb.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": "The leads Excel is open in Excel — close it first, then try again."}), 409
    except Exception as e:
        try:
            wb.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": f"Could not delete: {e}"}), 500


@app.route("/api/email-list/update", methods=["POST"])
def api_email_list_update():
    data = request.get_json(force=True) or {}
    orig = str(data.get("email", "") or "").strip()
    new_email = str(data.get("new_email", "") or orig).strip()
    if not orig:
        return jsonify({"ok": False, "error": "Email address is required."}), 400
    if not _EMAIL_RE.match(new_email):
        return jsonify({"ok": False, "error": "Invalid email format."}), 400

    try:
        wb, ws, path = _leads_workbook()
    except PermissionError:
        return jsonify({"ok": False, "error": "The leads Excel is open in Excel — close it first, then try again."}), 409
    except Exception as e:
        return jsonify({"ok": False, "error": f"Could not open leads Excel: {e}"}), 500

    try:
        emails, headers, ecol = _excel_emails(ws)
        orig_l = orig.lower()
        new_l = new_email.lower()

        matched = []
        for r in ws.iter_rows(min_row=2):
            v = r[ecol - 1].value
            if v and str(v).strip().lower() == orig_l:
                matched.append(r[0].row)
        if not matched:
            wb.close()
            return jsonify({"ok": False, "error": f"'{orig}' not found in the list."}), 404

        # Changing the email? Make sure the new one isn't used by another row
        for r in ws.iter_rows(min_row=2):
            v = r[ecol - 1].value
            if v and r[0].row not in matched and str(v).strip().lower() == new_l:
                wb.close()
                return jsonify({"ok": False,
                                "error": f"Duplicate! '{new_email}' already belongs to another lead in the list."}), 409

        # Already-sent emails can never return, even under a different look
        if new_l != orig_l and any(str(x).strip().lower() == new_l for x in load_sent_log()):
            wb.close()
            return jsonify({"ok": False,
                            "error": f"'{new_email}' was ALREADY SENT before — re-sending is blocked (duplicate protection)."}), 409

        header_list = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
        for rnum in matched:
            for h, key in ADD_COLUMN_MAP:
                if h in header_list and data.get(key):
                    ws.cell(row=rnum, column=header_list.index(h) + 1, value=str(data[key]).strip())
            ws.cell(row=rnum, column=header_list.index("Lead Email ID") + 1, value=new_email)

        wb.save(path)
        wb.close()
        log_line(f"Email updated: {orig} -> {new_email}")
        return jsonify({"ok": True, "email": new_email})
    except PermissionError:
        try:
            wb.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": "The leads Excel is open in Excel — close it first, then try again."}), 409
    except Exception as e:
        try:
            wb.close()
        except Exception:
            pass
        return jsonify({"ok": False, "error": f"Could not update: {e}"}), 500


# ============================================================================
# TEMPLATES — list / preview / activate / save / AI-generate
# ============================================================================
TEMPLATES_DIR = BASE / "Templates"


def _template_names():
    try:
        return sorted(f.name for f in TEMPLATES_DIR.glob("*.html"))
    except Exception:
        return []


@app.route("/api/templates")
def api_templates():
    cfg = get_config()

    def name_of(p):
        try:
            return Path(p).name if p and Path(p).exists() else ""
        except Exception:
            return ""
    return jsonify({
        "templates": _template_names(),
        "active": name_of(getattr(cfg, "TEMPLATE_FILE", "")),
        "active_followup": name_of(getattr(cfg, "FOLLOWUP_TEMPLATE_FILE", "")),
        "dir": str(TEMPLATES_DIR),
    })


@app.route("/api/template/preview")
def api_template_preview():
    fname = Path(request.args.get("file", "")).name
    path = TEMPLATES_DIR / fname
    if not path.exists():
        return jsonify({"error": "Template not found"}), 404
    html = path.read_text(encoding="utf-8")
    html = html.replace("{{CEO_Name}}", "Sarah Williams (CEO)")
    html = html.replace("{{Company_Name}}", "ACME Industries")
    return jsonify({"html": html})


@app.route("/api/template/read")
def api_template_read():
    """Returns the RAW template file (placeholders kept) for editing."""
    fname = Path(request.args.get("file", "")).name
    path = TEMPLATES_DIR / fname
    if not path.exists():
        return jsonify({"error": "Template not found"}), 404
    try:
        html = path.read_text(encoding="utf-8")
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"html": html, "file": fname})


@app.route("/api/template/activate", methods=["POST"])
def api_template_activate():
    data = request.get_json(force=True) or {}
    mode = data.get("mode")          # "first" | "followup"
    fname = Path(str(data.get("file", ""))).name
    path = TEMPLATES_DIR / fname
    if not path.exists():
        return jsonify({"ok": False, "error": "Template not found"}), 404
    field = "TEMPLATE_FILE" if mode == "first" else "FOLLOWUP_TEMPLATE_FILE"
    ok, changed, err = _apply_config_values({field: str(path)})
    if not ok:
        return jsonify({"ok": False, "error": err}), 400
    return jsonify({"ok": True})


# ── AI settings (stored privately in Data/dashboard_ai.json) ──────────────
AI_FILE = DATA / "dashboard_ai.json"
AI_DEFAULTS = {"api_key": "", "model": "gpt-4o-mini", "base_url": "https://api.openai.com/v1/chat/completions"}


def _load_ai():
    try:
        with open(AI_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        return {**AI_DEFAULTS, **d}
    except Exception:
        return dict(AI_DEFAULTS)


@app.route("/api/ai")
def api_ai():
    return jsonify(_load_ai())


@app.route("/api/ai", methods=["POST"])
def api_ai_save():
    data = request.get_json(force=True) or {}
    cur = _load_ai()
    for k in ("api_key", "model", "base_url"):
        if k in data:
            cur[k] = str(data[k]).strip()
    try:
        AI_FILE.write_text(json.dumps(cur, indent=2, ensure_ascii=False), encoding="utf-8")
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Offline ("built-in AI") generator — industry-aware, works with no key ──
GEN_STYLES = {
    "professional": ("Professional", "formal business tone"),
    "warm":         ("Warm & friendly", "personable, approachable tone"),
    "short":        ("Short & direct", "brief, to-the-point"),
    "executive":    ("Executive", "board-level, result-focused"),
    "partnership":  ("Partnership", "collaborative, win-win framing"),
}

INDUSTRY_PITCH = [
    (("software", "it services", "technology", "digital", "cloud", "saas", "product",
      "engineering", "machine learning", "data", "development", "telecom", "ai"),
     "we help technology businesses move faster by providing skilled engineering talent and "
     "outsourced product teams, so your team can stay focused on your roadmap while we handle "
     "the delivery load"),

    (("hr", "human resource", "payroll", "staffing", "recruitment", "hiring", "people"),
     "we modernise HR and payroll operations with technology-led automation, reducing manual "
     "work and keeping payroll compliant and accurate as you scale"),

    (("finance", "bank", "insurance", "accounting", "fintech", "audit", "investment"),
     "we help finance teams digitise manual processes with secure, audit-ready automation, so "
     "your team spends less time on paperwork and more time on decision-making"),

    (("consult", "advisory", "strategy"),
     "we serve as a dependable technology delivery partner for consulting firms, turning "
     "strategic recommendations into shipped products with dedicated engineering squads"),

    (("manufactur", "factory", "industrial", "production", "logistics", "supply chain"),
     "we help industrial and logistics companies automate operations from order to delivery, "
     "using practical digital tools that connect production, inventory, and workforce data"),

    (("health", "pharma", "hospital", "medical", "clinical"),
     "we build secure, compliant digital solutions for healthcare organisations, improving "
     "patient journeys and reducing administrative overhead without compromising data safety"),

    (("education", "university", "college", "school", "training", "elearning", "learning"),
     "we help educational institutions and edtech companies deliver better learner experiences "
     "with scalable digital platforms and automation behind the scenes"),

    (("retail", "ecommerce", "e-commerce", "consumer", "fashion", "store"),
     "we help retail and e-commerce businesses automate the customer journey from enquiry to "
     "checkout, improving conversion and cutting operational effort"),
]
GENERIC_PITCH = ("we help businesses like yours get technology-driven projects delivered on time "
                 "and on budget, with a dedicated team that handles the build so your own people "
                 "can focus on the business")


def _match_industry(lead):
    text = " ".join(str(lead.get(k, "") or "") for k in
                    ("Major Industries", "Category", "Category Type", "Company Size")).lower()
    for keywords, pitch in INDUSTRY_PITCH:
        if any(kw in text for kw in keywords):
            return pitch
    return GENERIC_PITCH


def _gen_body(lead, use_placeholder, style, variant):
    """Built-in generator — writes the email body from the lead's own details."""
    sty = GEN_STYLES.get(style, GEN_STYLES["professional"])[0]
    ceo = "{{CEO_Name}}" if use_placeholder else str(lead.get("CEO Name", "") or "there").strip()
    comp = "{{Company_Name}}" if use_placeholder else str(lead.get("Company Name", "") or "your company").strip()
    country = "" if use_placeholder else str(lead.get("Country", "") or "").strip()
    city = "" if use_placeholder else str(lead.get("City", "") or "").strip()
    emp = "" if use_placeholder else str(lead.get("No Of Employees", "") or "").strip()
    ind_match = "your industry" if use_placeholder else _match_industry(lead)

    lines = []
    lines.append(f"<p>Dear {ceo},</p>")

    if variant == "followup":
        lines.append("<p>I wanted to follow up on my previous note — I know inboxes get busy, so I kept this one short.</p>")
        opener = (f"While looking at {comp}" + (f" in {country}" if country else "") + ", I thought our automation services might be genuinely useful to you right now.")
        lines.append(f"<p>{opener}</p>")
    else:
        opener = (f"I was looking at <b>{comp}</b>" + (f" in {country}" if country else "")
                  + " and thought there might be a real opportunity for us to work together.")
        lines.append(f"<p>{opener}</p>")

    pitch = ("we help businesses in your industry get technology-driven initiatives delivered "
             f"on time and on budget") if use_placeholder else ind_match
    lines.append(f"<p>At OrbitAvanya Tech LLP, {pitch}.</p>")

    if emp and emp not in ("0", "nan", "None"):
        lines.append(f"<p>For a company of your scale — {emp} employees — we tailor scope and teams so you only pay for what moves the needle.</p>")

    if style == "short":
        lines.append("<p>If a 20-minute call in the coming week could help, I would be glad to set one up — no preparation needed on your side.</p>")
    elif style == "executive":
        lines.append("<p>If there is an initiative where a dependable delivery partner would help, I would welcome a short conversation with you or your team.</p>")
    elif style == "partnership":
        lines.append("<p>If you see potential for a collaboration — whether an initial pilot or a long-term engagement — I would be happy to explore it together.</p>")
    else:
        lines.append("<p>If you have a few minutes in the coming weeks, I would be happy to have a brief call to learn about your priorities and share how we work.</p>")

    lines.append("<p>You can learn more about us here:<br>"
                 '<a href="https://orbitavanyatech.com">orbitavanyatech.com</a> - Website<br>'
                 "portfolio.orbitavanyatech.com - Portfolio</p>")
    lines.append("<p>Thank you for your time.</p>")
    lines.append("<p>Best regards,<br>Pradeep Kumar<br>OrbitAvanya Tech LLP<br>+91 70219 50643<br>"
                 '<a href="mailto:info@orbitavanyatech.com">info@orbitavanyatech.com</a></p>')
    return "\n\n".join(lines)


def _subject_for(lead, use_placeholder, style, variant):
    comp = "{{Company_Name}}" if use_placeholder else str(lead.get("Company Name", "") or "your company").strip()
    if variant == "followup":
        return f"Following up: ideas for {comp}"
    if style == "short":
        return f"A quick idea for {comp}"
    if style == "executive":
        return f"Delivery partner opportunity — {comp}"
    return f"Exploring a collaboration opportunity with {comp}"


def _ai_generate(prompt_hint, lead, use_placeholder, style, variant):
    """Optional real-AI generation via a user-supplied API key. Returns HTML or None."""
    ai = _load_ai()
    if not ai.get("api_key"):
        return None
    try:
        comp = "{{Company_Name}}" if use_placeholder else str(lead.get("Company Name", "") or "your company")
        ceo = "{{CEO_Name}}" if use_placeholder else str(lead.get("CEO Name", "") or "there")
        lead_snapshot = json.dumps({k: v for k, v in lead.items()
                                    if k not in ("Company Email", "Company Ph No", "Lead Email ID")},
                                   ensure_ascii=False)[:1800]
        sys_tone = GEN_STYLES.get(style, GEN_STYLES["professional"])[1]
        is_fol = "follow-up (reminder)" if variant == "followup" else "first-contact"
        if prompt_hint:
            prompt = (
                f"You write cold outreach emails for OrbitAvanya Tech LLP (IT services/automation company, "
                f"website orbitavanyatech.com, contact +91 70219 50643, info@orbitavanyatech.com, "
                f"from Pradeep Kumar).\n"
                f"Lead details: {lead_snapshot}\n"
                f"Follow the user's own instruction for this email:\n{prompt_hint}\n"
                "Rules: output ONLY the HTML body (no commentary, no markdown fences), using <p> paragraphs; "
                "keep exactly the tokens {{CEO_Name}} and {{Company_Name}} when the lead is used; "
                "end with a thank-you line and the signature (Pradeep Kumar, OrbitAvanya Tech LLP, "
                "+91 70219 50643, info@orbitavanyatech.com)."
            )
        else:
            prompt = (
                f"You write cold outreach emails for OrbitAvanya Tech LLP (IT services/automation company, "
                f"website orbitavanyatech.com, contact +91 70219 50643, info@orbitavanyatech.com, "
                f"from Pradeep Kumar).\n"
                f"Write the HTML body for a {is_fol} email to CEO {ceo} of company '{comp}' with in {sys_tone}.\n"
                f"Lead details: {lead_snapshot}\n"
                "Rules: use <p> paragraphs; keep exactly the tokens {{CEO_Name}} and {{Company_Name}} "
                "(in the greeting and body); mention one concrete idea relevant to the lead's industry; "
                "include the links line (https://orbitavanyatech.com — Website, portfolio.orbitavanyatech.com — Portfolio), "
                "a thank-you line, and the signature (Pradeep Kumar, OrbitAvanya Tech LLP, +91 70219 50643, "
                "info@orbitavanyatech.com). Output ONLY the HTML, no commentary, no markdown fences."
            )
        r = requests.post(ai.get("base_url") or AI_DEFAULTS["base_url"],
                          headers={"Authorization": f"Bearer {ai['api_key']}",
                                   "Content-Type": "application/json"},
                          json={"model": ai.get("model") or AI_DEFAULTS["model"],
                                "messages": [{"role": "user", "content": prompt}],
                                "temperature": 0.7},
                          timeout=90)
        r.raise_for_status()
        data = r.json()
        content = data["choices"][0]["message"]["content"]
        content = content.strip()
        if content.startswith("```"):
            content = re.sub(r"^```(?:html)?\s*|\s*```$", "", content)
        if "<p" not in content:
            return None
        return content
    except Exception:
        return None


@app.route("/api/template/generate", methods=["POST"])
def api_template_generate():
    data = request.get_json(force=True) or {}
    style = data.get("style", "professional")
    variant = data.get("variant", "first")
    use_placeholder = bool(data.get("use_placeholder"))
    lead = data.get("lead") or {}
    prompt = str(data.get("prompt", "") or "").strip()

    used_ai = False
    html = _ai_generate(prompt or None, lead, use_placeholder, style, variant)
    if html:
        used_ai = True
        note = "Generated with your AI API key." + (" Your custom prompt was used." if prompt else "")
    else:
        if prompt:
            note = ("Custom prompts need an AI API key — add one in Settings → AI to use your own "
                    "prompt. Showing a built-in draft instead.")
        else:
            note = ("Generated with the built-in engine (no API key). Add an OpenAI-style key in "
                    "Settings → AI to use a real AI model.")
        html = _gen_body(lead, use_placeholder, style, variant)
    subject = _subject_for(lead, use_placeholder, style, variant)
    return jsonify({"html": html, "subject": subject, "used_ai": used_ai, "note": note})


@app.route("/api/template/save", methods=["POST"])
def api_template_save():
    data = request.get_json(force=True) or {}
    name = str(data.get("name", "")).strip()
    html = str(data.get("html", "")).strip()
    if not name.endswith(".html"):
        name += ".html"
    name = re.sub(r'[\\/:*?"<>|]', "_", name)
    if not name:
        return jsonify({"ok": False, "error": "Missing template name"}), 400
    path = TEMPLATES_DIR / name
    try:
        path.write_text(html, encoding="utf-8")
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    activate = data.get("activate")  # "first" | "followup" | "none"
    if activate in ("first", "followup"):
        field = "TEMPLATE_FILE" if activate == "first" else "FOLLOWUP_TEMPLATE_FILE"
        ok, _, err = _apply_config_values({field: str(path)})
        if not ok:
            return jsonify({"ok": False, "error": f"Saved but could not activate: {err}"}), 400
    log_line(f"Template saved: {name}" + (f" (active {activate})" if activate != "none" else ""))
    return jsonify({"ok": True, "file": name})


# ============================================================================
# HTML (self-contained — works offline, no CDNs)
# ============================================================================
INDEX_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OrbitAvanya — Campaign Dashboard</title>
<style>
  :root{
    --bg:#0b1220; --panel:#111a2c; --panel2:#0e1626; --line:#1e2c45;
    --txt:#dbe6f7; --mut:#7d90ad; --acc:#3b82f6; --acc2:#0D5A9E;
    --grn:#22c55e; --red:#ef4444; --amb:#f59e0b; --cyan:#06b6d4; --pur:#a78bfa;
  }
  *{box-sizing:border-box; margin:0; padding:0}
  body{background:var(--bg); color:var(--txt);
       font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif; font-size:14px;}
  ::-webkit-scrollbar{width:9px;height:9px} ::-webkit-scrollbar-thumb{background:#243a5e;border-radius:5px}
  a{color:var(--acc)}
  .wrap{display:flex; min-height:100vh}

  /* ── sidebar ── */
  .side{width:220px; background:var(--panel2); border-right:1px solid var(--line);
        padding:16px 10px; position:sticky; top:0; height:100vh; overflow-y:auto}
  .logo{font-size:16px; font-weight:700; padding:6px 10px 14px; letter-spacing:.3px}
  .logo span{color:var(--acc)}
  .nav b{display:block; font-size:10px; color:var(--mut); text-transform:uppercase;
         letter-spacing:1px; padding:10px 10px 4px}
  .nav button{display:flex; align-items:center; gap:9px; width:100%; text-align:left;
        background:none; border:none; color:var(--mut); font-size:13.5px; cursor:pointer;
        padding:9px 10px; border-radius:8px; margin-bottom:2px}
  .nav button:hover{background:#16233c; color:var(--txt)}
  .nav button.on{background:var(--acc2); color:#fff; font-weight:600}
  .nav button .ic{width:18px; text-align:center}
  .foot-tip{margin-top:20px; padding:10px; font-size:11px; color:var(--mut);
            border:1px dashed var(--line); border-radius:8px; line-height:1.5}
  .status-dot{display:inline-block; width:8px; height:8px; border-radius:50%; background:#64748b; margin-right:6px}

  /* ── main ── */
  .main{flex:1; padding:22px 26px; max-width:1400px}
  .topbar{display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; gap:12px}
  h1{font-size:21px; font-weight:700}
  .sub{color:var(--mut); font-size:12.5px; margin-top:3px}
  .btn{background:var(--acc2); color:#fff; border:none; padding:7px 16px; border-radius:8px;
       font-size:13px; cursor:pointer; font-weight:600}
  .btn:hover{filter:brightness(1.15)}
  .btn.ghost{background:transparent; border:1px solid var(--line); color:var(--mut)}
  .btn.green{background:#157a3a} .btn.red{background:#a32020} .btn.amber{background:#8a5a0c}
  .btn.sm{padding:4px 10px; font-size:12px}
  .btn:disabled{opacity:.45; cursor:not-allowed}
  #toast{position:fixed; bottom:18px; left:50%; transform:translateX(-50%) translateY(20px); z-index:999;
    background:#0e1626; color:#c9d6e9; border:1px solid var(--line); border-radius:10px;
    padding:10px 18px; font-size:12.5px; opacity:0; pointer-events:none; transition:.25s;
    box-shadow:0 8px 24px rgba(0,0,0,.45); max-width:80vw}
  #toast.show{opacity:1; transform:translateX(-50%) translateY(0)}

  .banner{background:#422006; border:1px solid #854d0e; color:#fcd34d; padding:9px 14px;
          border-radius:8px; font-size:12.5px; margin-bottom:14px; display:none}

  .section{display:none} .section.on{display:block}

  /* KPI cards */
  .kpis{display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:12px; margin-bottom:18px}
  .kpi.clickable{cursor:pointer; transition:transform .12s ease, border-color .12s ease, box-shadow .12s ease}
  .kpi.clickable:hover{transform:translateY(-2px); border-color:var(--acc); box-shadow:0 4px 14px rgba(37,211,148,.12)}
  .kpi.clickable .go{font-size:10.5px; color:var(--acc); margin-top:6px; opacity:0; transition:opacity .12s ease}
  .kpi.clickable:hover .go{opacity:1}
  .kpi{background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 15px}
  .kpi .lbl{font-size:11.5px; color:var(--mut); text-transform:uppercase; letter-spacing:.6px}
  .kpi .val{font-size:26px; font-weight:700; margin-top:6px}
  .kpi .note{font-size:11.5px; color:var(--mut); margin-top:4px}
  .kpi .val.c-grn{color:var(--grn)} .kpi .val.c-red{color:var(--red)}
  .kpi .val.c-amb{color:var(--amb)} .kpi .val.c-cyn{color:var(--cyan)} .kpi .val.c-pur{color:var(--pur)}

  /* charts */
  .grid2{display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px}
  .grid3{display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-bottom:14px}
  @media (max-width:1100px){.grid2,.grid3{grid-template-columns:1fr}}
  .card{background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px}
  .card h3{font-size:13.5px; margin-bottom:12px; color:#c9d9f0}
  .bars{display:flex; align-items:flex-end; gap:5px; height:150px; padding-top:8px}
  .bar{flex:1; display:flex; flex-direction:column; justify-content:flex-end; position:relative;
       min-width:7px; background:#1b2c49; border-radius:4px 4px 0 0; cursor:default}
  .bar i{display:block; background:var(--acc2); border-radius:4px 4px 0 0; width:100%}
  .bar.s2 i{background:var(--cyan)} .bar.s3 i{background:var(--amb)}
  .bar:hover{outline:1px solid var(--acc); outline-offset:1px}
  .bar span{position:absolute; top:-18px; left:50%; transform:translateX(-50%);
            font-size:10px; color:var(--txt); background:#1b2c49; padding:1px 6px;
            border-radius:4px; white-space:nowrap; display:none}
  .bar:hover span{display:block}
  .axis-labels{display:flex; justify-content:space-between; font-size:10px; color:var(--mut); margin-top:6px}
  .legend{display:flex; gap:14px; font-size:11px; color:var(--mut); margin-bottom:10px; flex-wrap:wrap}
  .legend span{display:inline-flex; align-items:center; gap:5px}
  .legend i{width:10px; height:10px; border-radius:3px; display:inline-block}
  .mini{font-size:11px; color:var(--mut); margin-bottom:8px}

  .rows-l{display:flex; flex-direction:column; gap:9px}
  .cnt-row{display:flex; align-items:center; gap:8px; font-size:12.5px}
  .cnt-row .n{width:140px; color:#b9cbe6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
  .cnt-row .track{flex:1; background:#1b2c49; height:16px; border-radius:4px; overflow:hidden}
  .cnt-row .track i{display:block; height:100%; background:var(--acc2); border-radius:4px}
  .cnt-row .c{width:34px; text-align:right; font-weight:600; color:var(--txt)}
  .chip{display:inline-block; background:#16233c; border:1px solid var(--line); padding:3px 10px;
        border-radius:14px; font-size:11.5px; margin:0 5px 5px 0}
  .chip b{color:var(--acc)}

  /* tables */
  .toolbar{display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; align-items:center}
  .toolbar input,.toolbar select{background:var(--panel); border:1px solid var(--line); color:var(--txt);
        padding:7px 10px; border-radius:8px; font-size:13px}
  .toolbar input[type=search]{flex:1; min-width:180px}
  table{width:100%; border-collapse:collapse; font-size:12.5px}
  th{position:sticky; top:0; background:var(--panel2); color:#9fb4d3; text-align:left;
     padding:8px 10px; border-bottom:1px solid var(--line); font-weight:600; white-space:nowrap}
  td{padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:middle; white-space:nowrap}
  td.mono{font-family:Consolas,monospace; font-size:11.5px; color:#b9cbe6}
  tr:hover td{background:#131f36}
  .tblbox{max-height:62vh; overflow:auto; border:1px solid var(--line); border-radius:12px; background:var(--panel)}
  .pill{display:inline-block; padding:2px 9px; border-radius:10px; font-size:11px; font-weight:600}
  .pill.sent{background:#12351f; color:#4ade80} .pill.failed{background:#3a1414; color:#f87171}
  .pill.bounced{background:#3a1414; color:#fca5a5} .pill.opened{background:#10305e; color:#60a5fa}
  .pill.closed{background:#16233c; color:#64748b} .pill.yes{background:#12351f; color:#4ade80}
  .pill.no{background:#16233c; color:#64748b} .pill.fake{background:#3a2a10; color:#fbbf24}
  .pill.due{background:#3a1414; color:#f87171}
  .count-note{font-size:12px; color:var(--mut); margin-bottom:10px}

  /* events feed */
  .feed{display:flex; flex-direction:column; gap:8px; max-height:68vh; overflow:auto;
        padding-right:4px}
  .ev{display:flex; gap:11px; align-items:flex-start; background:var(--panel);
      border:1px solid var(--line); border-radius:10px; padding:10px 13px}
  .ev .ic{width:32px; height:32px; border-radius:8px; display:flex; align-items:center;
      justify-content:center; font-size:15px; flex-shrink:0}
  .ev .t{font-size:12.5px} .ev .t b{color:#d3e2f7} .ev .m{font-size:11.5px; color:var(--mut); margin-top:2px}
  .ic.open{background:#10305e} .ic.click{background:#4c1919} .ic.visit{background:#12351f} .ic.time{background:#3a2a10}
  .filters{display:flex; gap:7px; margin-bottom:11px; flex-wrap:wrap}

  /* actions */
  .act-grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; margin-bottom:16px}
  .act{background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:17px}
  .act h3{font-size:14.5px; margin-bottom:5px}
  .act p{font-size:12px; color:var(--mut); line-height:1.5; margin-bottom:12px}
  .state{font-size:12px; margin-top:10px}
  .state.ok{color:var(--grn)} .state.err{color:var(--red)} .state.run{color:var(--amb)}
  .logbox{background:#060b14; border:1px solid var(--line); border-radius:10px; padding:12px 14px;
         font-family:Consolas,monospace; font-size:11.5px; line-height:1.55; color:#a9c1e2;
         height:300px; overflow:auto; white-space:pre-wrap; word-break:break-word}
  .loghead{display:flex; justify-content:space-between; align-items:center; margin-bottom:8px}

  /* settings */
  .set-grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:16px}
  .set-grp{background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px}
  .set-grp h3{font-size:13.5px; margin-bottom:12px; color:#c9d9f0; border-bottom:1px solid var(--line); padding-bottom:8px}
  .f{margin-bottom:11px}
  .f label{display:block; font-size:11.5px; color:var(--mut); margin-bottom:4px}
  .f label code{background:#16233c; padding:1px 6px; border-radius:4px; color:#8fb3e8}
  .f input{width:100%; background:var(--panel2); border:1px solid var(--line); color:var(--txt);
        padding:8px 10px; border-radius:8px; font-size:12.5px}
  .f input:focus{outline:1px solid var(--acc)}
  .saved{color:var(--grn); font-size:12.5px; margin-left:10px}
  .err{color:var(--red); font-size:12.5px; margin-left:10px}
  .hint{font-size:11px; color:#64748b; margin-top:2px}

  .spin{display:inline-block; width:13px; height:13px; border:2px solid var(--mut);
        border-top-color:transparent; border-radius:50%; animation:sp .7s linear infinite; vertical-align:-2px}
  @keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="wrap">
  <aside class="side">
    <div class="logo">Orbit<span>Avanya</span><br><span style="font-size:11px;color:#7d90ad;font-weight:400">Email Campaign Dashboard</span></div>
    <nav class="nav">
      <b>Menu</b>
      <button class="on" data-sec="overview"><span class="ic">📊</span> Overview</button>
      <button data-sec="leads"><span class="ic">🧑‍💼</span> Leads</button>
      <button data-sec="emaillist"><span class="ic">📋</span> Email List</button>
      <button data-sec="events"><span class="ic">📡</span> Live Events</button>
      <button data-sec="templates"><span class="ic">📝</span> Templates</button>
      <button data-sec="actions"><span class="ic">▶️</span> Actions</button>
      <button data-sec="settings"><span class="ic">⚙️</span> Settings</button>
      <b>System</b>
      <button data-sec="sysinfo" hidden></button>
    </nav>
    <div class="foot-tip" id="sideStatus">
      <span class="status-dot" id="dotCmp"></span><b id="cmpState">checking…</b><br>
      Tracker server: <span id="trkState">?</span><br>
      <span style="font-size:10.5px">Port 7070 · local only</span>
    </div>
  </aside>

  <main class="main">
    <div class="topbar">
      <div>
        <h1 id="pageTitle">Overview</h1>
        <div class="sub" id="pageSub">Campaign performance at a glance</div>
      </div>
      <div style="display:flex; gap:8px; align-items:center">
        <span id="lastUpd" style="font-size:11.5px;color:#7d90ad"></span>
        <button class="btn ghost sm" onclick="refreshAll(true)">⟳ Refresh</button>
      </div>
    </div>
    <div class="banner" id="lockBanner">⚠️ The tracker Excel file is open in Excel or locked.
      Close it so live data can be read. Stats shown may be stale.</div>

    <!-- ══════════ OVERVIEW ══════════ -->
    <div class="section on" id="sec-overview">
      <div class="kpis" id="kpiCards"></div>
      <div class="card" style="margin-bottom:14px">
        <h3>📊 Sent · Opens · Clicks per day <span class="mini">(last 14 days)</span></h3>
        <div class="legend" id="chartLegend"></div>
          <div class="bars" id="chartSent"></div>
          <div class="axis-labels" id="axisSent"></div></div>
      <div class="grid2">
        <div class="card"><h3>🌍 Where leads came from (latest opens/clicks)</h3>
          <div class="rows-l" id="countryList"></div></div>
        <div class="card"><h3>🗣️ Languages used</h3>
          <div id="langList" style="padding-top:4px"></div>
          <h3 style="margin-top:18px">🚫 Fake emails skipped</h3>
          <div id="fakeMini" style="font-size:12px; color:#7d90ad"></div></div>
      </div>
      <div class="grid2">
        <div class="card"><h3>🔮 Forecast <span class="mini">(next-day prediction from 7-day trend)</span></h3>
          <div id="forecastBox" style="font-size:12.5px;padding-top:2px"><span class="spin"></span></div></div>
        <div class="card"><h3>📭 Bounce analysis <span class="mini">(root cause + domains to drop)</span></h3>
          <div id="bounceBox" style="font-size:12px;padding-top:2px"><span class="spin"></span></div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <h3>📈 Per-template performance <span class="mini">(sent emails only)</span></h3>
        <div id="tmplStats" style="font-size:12.5px;padding-top:4px"><span class="spin"></span></div>
      </div>
    </div>

    <!-- ══════════ LEADS ══════════ -->
    <div class="section" id="sec-leads">
      <div class="toolbar" style="margin-bottom:10px">
        <button class="btn ghost sm tbl-src on" data-src="tracker" onclick="setLeadSource('tracker',this)">Tracker (already processed)</button>
        <button class="btn ghost sm tbl-src" data-src="source" onclick="setLeadSource('source',this)">Source leads Excel</button>
        <span style="flex:1"></span>
        <span id="srcCounts" style="font-size:12px;color:#7d90ad"></span>
      </div>
      <div class="toolbar">
        <input type="search" id="leadQ" placeholder="Search company, person, email, subject…" oninput="leadRefresh()">
        <select id="leadStatus" onchange="leadRefresh()">
          <option value="">All send statuses</option>
          <option>Sent</option><option>Failed</option><option>Bounced</option>
        </select>
        <select id="leadOpen" onchange="leadRefresh()">
          <option value="">Opened: any</option><option value="yes">Opened</option><option value="no">Not opened</option>
        </select>
        <select id="leadClicked" onchange="leadRefresh()">
          <option value="">Clicked: any</option><option value="yes">Clicked</option><option value="no">Not clicked</option>
        </select>
        <select id="leadReply" onchange="leadRefresh()">
          <option value="">Replied: any</option><option value="yes">Replied</option><option value="no">No reply</option>
        </select>
        <select id="leadOnly" onchange="leadRefresh()">
          <option value="">All records</option><option value="fake">Fake CEO emails</option>
        </select>
        <button class="btn ghost sm" title="Download the currently-filtered records as an Excel report" onclick="downloadReport('xlsx')">⬇ Excel</button>
        <button class="btn ghost sm" title="Download the currently-filtered records as CSV" onclick="downloadReport('csv')">⬇ CSV</button>
      </div>
      <div class="count-note" id="leadCount"></div>
      <div class="tblbox"><table id="leadTable">
        <thead><tr>
          <th>Company</th><th>Contact</th><th>Email</th><th>Sent date</th>
          <th>Score</th><th>Status</th><th>Opened</th><th>Link</th><th>Visits</th>
          <th>Reply</th><th>Reminder</th><th>Country</th><th>Subject</th>
        </tr></thead>
        <tbody></tbody>
      </table>
      <table id="srcTable" style="display:none">
        <thead><tr>
          <th>Company</th><th>CEO</th><th>Email</th><th>Status</th>
          <th>Country</th><th>Best time</th><th>City</th><th>Industries</th><th>Employees</th><th>Category</th>
        </tr></thead>
        <tbody></tbody>
      </table></div>
    </div>

    <!-- ══════════ EMAIL LIST ══════════ -->
    <div class="section" id="sec-emaillist">
      <div class="card" style="margin-bottom:14px">
        <h3>➕ Add an email to the list</h3>
        <div class="mini" style="margin-bottom:10px">New leads are added to the campaign Excel and will be included in the next run.
          Duplicates and previously-sent emails are blocked automatically.</div>
        <div class="toolbar" style="margin-bottom:8px;flex-wrap:wrap">
          <input type="text" id="elCompany" placeholder="Company Name" style="min-width:170px">
          <input type="text" id="elCEO" placeholder="CEO / Contact Person" style="min-width:150px">
          <input type="email" id="elEmail" placeholder="email@company.com *" style="min-width:210px" onkeydown="if(event.key==='Enter')addEmail()">
          <input type="text" id="elCountry" placeholder="Country" style="min-width:110px">
          <input type="text" id="elRegion" placeholder="Region" style="min-width:110px">
          <button class="btn green" id="elAddBtn" onclick="addEmail()">＋ Add</button>
          <button class="btn ghost" id="elCancelBtn" style="display:none" onclick="cancelEdit()">✖ Cancel edit</button>
        </div>
        <div class="state" id="elMsg"></div>
      </div>

      <div class="toolbar">
        <input type="search" id="elQ" placeholder="Search company, CEO, email…" oninput="loadEmailList()">
        <select id="elStatus" onchange="loadEmailList()">
          <option value="">All</option>
          <option>Not sent</option>
          <option>Sent</option>
          <option>Fake</option>
        </select>
        <span style="flex:1"></span>
        <button class="btn ghost sm" title="Import a client list from CSV or Excel (Email / company / CEO / country columns are matched automatically). You get a preview before anything is added."
                onclick="document.getElementById('elFile').click()">📤 Upload CSV/Excel</button>
        <input type="file" id="elFile" accept=".csv,.xlsx,.xls" style="display:none" onchange="uploadEmails()">
        <span id="elCounts" style="font-size:12px;color:#7d90ad"></span>
      </div>
      <div id="elPreview" style="display:none"></div>
      <div id="elUploads" style="display:none;margin:10px 0 4px"></div>
      <div class="count-note" id="elCount"></div>
      <div class="tblbox"><table id="elTable">
        <thead><tr>
          <th>Company</th><th>CEO / Contact</th><th>Email</th><th>Country</th>
          <th>Best time</th><th>Region</th><th>Industries</th><th>Status</th><th style="text-align:right">Action</th>
        </tr></thead>
        <tbody></tbody>
      </table></div>

      <div class="card" style="margin-top:14px">
        <h3>🧹 RAW DATA → EXTRACT → VALIDATE → ORGANISE → SEND</h3>
        <div class="mini" style="margin-bottom:8px">Upload a messy / improper client file (CSV, Excel or TXT) — emails are extracted automatically even from
          unstructured text, each one is <b>validated</b> (syntax → disposable domain → MX → SMTP mailbox check) <b>before</b> anything is added or sent,
          then organised into a brand-new structured Excel. Only <b>REAL</b> emails can be added to the list or sent; fakes are skipped with the reason.</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn green sm" onclick="document.getElementById('rawFile').click()">📄 Upload raw data</button>
          <input type="file" id="rawFile" accept=".csv,.xlsx,.xls,.txt" style="display:none" onchange="rawPreview()">
          <span style="flex:1"></span>
          <button class="btn green sm" style="display:none" id="rawRealBtn" onclick="rawRealList()">⬇ Download real list (no fakes)</button>
          <button class="btn red sm" style="display:none" id="rawFakeBtn" onclick="rawFakeList()">⬇ Download fake list</button>
          <button class="btn ghost sm" style="display:none" id="rawSaveBtn" onclick="rawSaveExcel()">💾 Save organised Excel</button>
          <button class="btn ghost sm" style="display:none" id="rawAddBtn" onclick="rawAddToList()">➕ Add real to Email List</button>
          <button class="btn green sm" style="display:none" id="rawSendBtn" onclick="rawSend()">📨 Send to real</button>
        </div>
        <div class="state" id="rawMsg"></div>
        <div id="rawPanel" style="display:none;margin-top:10px">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px" id="rawChips"></div>
          <div class="tblbox" style="max-height:300px;overflow:auto"><table>
            <thead><tr><th><input type="checkbox" id="rawSelAll" onchange="rawToggleAll()" title="Select all REAL"></th><th>Email</th><th>Company</th><th>Contact</th><th>Validation</th><th>Reason</th></tr></thead>
            <tbody id="rawTable"></tbody>
          </table></div>
          <div style="font-size:12px;color:#7d90ad;margin-top:6px" id="rawSelInfo"></div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <h3>🚫 Already sent — blocked from sending again</h3>
        <div class="mini" style="margin-bottom:8px">These emails were sent before and will NEVER be sent again
          (kept in <code>sent_emails_log.json</code> + tracker). Deleting a lead from the list does not unblock it.</div>
        <div id="elBlocked" style="display:flex;flex-wrap:wrap;gap:6px"></div>
        <div style="margin-top:8px;font-size:12px">
          <button class="btn ghost sm" onclick="fakeListDownload()">⬇ Download accumulated fake-emails list (tracker)</button>
        </div>
      </div>
    </div>

    <!-- ══════════ EVENTS ══════════ -->
    <div class="section" id="sec-events">
      <div class="filters">
        <button class="btn ghost sm fbtn on" data-f="all" onclick="setEventFilter('all',this)">All</button>
        <button class="btn ghost sm fbtn" data-f="email_opened" onclick="setEventFilter('email_opened',this)">Opens</button>
        <button class="btn ghost sm fbtn" data-f="link_clicked" onclick="setEventFilter('link_clicked',this)">Clicks</button>
        <button class="btn ghost sm fbtn" data-f="website_visit" onclick="setEventFilter('website_visit',this)">Visits</button>
        <button class="btn ghost sm fbtn" data-f="time_on_site" onclick="setEventFilter('time_on_site',this)">Time on site</button>
        <span style="flex:1"></span>
        <span id="evCount" style="font-size:12px;color:#7d90ad"></span>
      </div>
      <div class="feed" id="eventFeed"></div>
    </div>

    <!-- ══════════ TEMPLATES ══════════ -->
    <div class="section" id="sec-templates">
      <div class="grid2">
        <div class="card">
          <h3>📁 Email templates <span class="mini">(Templates\ folder)</span></h3>
          <div id="tmplList" style="display:flex;flex-direction:column;gap:10px"></div>
        </div>
        <div class="card">
          <h3>👁️ Preview <span class="mini" id="previewName"></span></h3>
          <iframe id="tmplPreview" style="width:100%;height:430px;background:#fff;border-radius:8px;border:none"
                  sandbox="allow-same-origin allow-scripts"></iframe>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <h3>✨ AI template generator</h3>
        <div class="mini" style="margin-bottom:12px">Builds a personalized email from a lead's own details —
          industry, size, country. Uses your AI API key if configured (Settings → AI), otherwise the built-in engine.</div>
        <div class="toolbar" style="margin-bottom:4px">
          <label class="mini" style="margin-right:2px">Type:</label>
          <select id="genVariant">
            <option value="first">First contact</option>
            <option value="followup">Follow-up / reminder</option>
          </select>
          <label class="mini" style="margin:0 2px 0 14px">Style:</label>
          <select id="genStyle">
            <option value="professional">Professional</option>
            <option value="warm">Warm &amp; friendly</option>
            <option value="short">Short &amp; direct</option>
            <option value="executive">Executive</option>
            <option value="partnership">Partnership</option>
          </select>
          <label class="mini" style="margin:0 2px 0 14px">For lead:</label>
          <select id="genLead" style="min-width:240px"></select>
          <label class="mini" style="margin:0 2px 0 14px;display:flex;align-items:center;gap:5px">
            <input type="checkbox" id="genPlaceholder" style="width:auto"> Use {{placeholders}}</label>
          <button class="btn" onclick="generateTemplate()">✨ Generate</button>
        </div>
        <div style="margin:6px 0 2px">
          <label class="mini" style="display:block;margin-bottom:4px">✍️ Your own prompt (optional — tell AI exactly what to write, e.g. "short email offering a free audit, mention Dubai office"):</label>
          <textarea id="genPrompt" rows="2" style="width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:9px 11px;font-size:12.5px;resize:vertical" placeholder="Write your instruction here — leave empty to use the Type/Style/Lead settings"></textarea>
        </div>
        <div class="state" id="genStatus"></div>
        <div id="genResult" style="display:none;margin-top:12px">
          <div class="mini">Suggested subject: <b id="genSubject"></b></div>
          <div class="toolbar" style="margin-top:8px">
            <input type="text" id="genSaveName" placeholder="template_name.html" style="width:240px">
            <button class="btn green" onclick="saveGenerated('first')">💾 Save as first-contact template</button>
            <button class="btn amber" onclick="saveGenerated('followup')">💾 Save as follow-up template</button>
            <button class="btn ghost" onclick="saveGenerated('none')">💾 Save only</button>
            <button class="btn ghost sm" onclick="toggleGenEdit()" id="btnGenEdit">✏️ Edit HTML</button>
          </div>
          <div class="mini" style="margin-top:6px;display:none" id="genEditHint">
            You can edit the HTML below manually, then click Save. After saving, the template is yours to change any time via this editor.
          </div>
          <iframe id="genPreview" style="width:100%;height:360px;background:#fff;border-radius:8px;border:none;margin-top:10px"
                  sandbox="allow-same-origin allow-scripts"></iframe>
          <div id="genEditBox" style="display:none;margin-top:10px">
            <div class="mini" style="margin-bottom:4px">Edit the HTML below, then click a Save button to keep your changes:</div>
            <textarea id="genEdit" rows="16" style="width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:10px 12px;font-family:Consolas,monospace;font-size:12px;resize:vertical"></textarea>
            <div class="toolbar" style="margin-top:8px">
              <button class="btn ghost sm" onclick="genPreviewRefresh()">👁️ Refresh preview</button>
              <button class="btn green" onclick="saveGenerated('first')">💾 Save as first-contact template</button>
              <button class="btn amber" onclick="saveGenerated('followup')">💾 Save as follow-up template</button>
              <button class="btn ghost" onclick="saveGenerated('none')">💾 Save only</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ══════════ ACTIONS ══════════ -->
    <div class="section" id="sec-actions">
      <div class="act-grid">
        <div class="act">
          <h3>📨 Email lead send</h3>
          <p>Auto-batch mode: sends <b>100 emails now</b>, waits 1 hour, sends the next 100,
             and keeps going day after day automatically until <b>all</b> leads are done
             (respects the 500/day limit, pauses overnight, resumes tomorrow).
             Already-sent emails are skipped automatically — so if you stop mid-way, just
             click <b>Continue</b> and it resumes exactly where it stopped.</p>
          <button class="btn green" id="btnCmpStart" onclick="startCampaign('leads')">▶ Continue email lead send</button>
          <button class="btn red" id="btnCmpStop" onclick="stopCampaign('leads')" disabled>■ Stop email lead</button>
          <div class="state" id="cmpState2"><span class="spin"></span> checking…</div>
        </div>
        <div class="act">
          <h3>🚀 Full campaign</h3>
          <p>Permanent run-and-stop mode (as before): sends one batch, then <b>stops</b> —
             no auto-resume. Re-run it manually whenever you want the next batch sent.
             Starts the tracking server, validates emails, and stops after
             <code>MAX_EMAILS_PER_RUN</code> emails.</p>
          <button class="btn green" id="btnFullStart" onclick="startCampaign('full')">▶ Run full campaign</button>
          <button class="btn red" id="btnFullStop" onclick="stopCampaign('full')" disabled>■ Stop campaign permanently</button>
          <div class="state" id="fullState2"><span class="spin"></span> checking…</div>
        </div>
        <div class="act">
          <h3>📬 Check replies &amp; bounces</h3>
          <p>Scans the inbox (IMAP, last 30 days) and marks replies / bounces in the tracker.
             Bounced emails get moved to the Bounced sheet.</p>
          <button class="btn" onclick="runAction('check-replies')">Check now</button>
          <div class="state" id="st-replies"></div>
        </div>
        <div class="act">
          <h3>⏰ Send due reminders</h3>
          <p>Sends follow-up emails to leads whose 2-day reminder date has passed and who
             haven't replied or bounced.</p>
          <button class="btn amber" onclick="runAction('reminders')">Send due reminders</button>
          <div class="state" id="st-reminders"></div>
        </div>
        <div class="act">
          <h3>📊 Refresh report</h3>
          <p>Rebuilds <code>Sent_Bounced_Report.xlsx</code> (Summary / Sent / Bounced sheets)
             from the live tracker.</p>
          <button class="btn ghost" onclick="runAction('report')">Refresh report</button>
          <div class="state" id="st-report"></div>
        </div>
        <div class="act">
          <h3>🔄 Tracking sync</h3>
          <p>Pulls opens / clicks / visits recorded on your server
             (<code>track.php</code>) into the tracker Excel + event log.
             Runs every 60&nbsp;s once started. Never double-counts events.</p>
          <button class="btn" onclick="runAction('sync-tracking')">Sync now</button>
          <button class="btn green" id="btnSyncStart" onclick="startSync()">▶ Run continuously</button>
          <button class="btn red" id="btnSyncStop" onclick="stopSync()" disabled>■ Stop</button>
          <div class="state" id="st-sync-tracking"></div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <h3>🕘 Recent jobs</h3>
        <table id="jobTable" style="font-size:12px">
          <thead><tr><th>Time</th><th>Job</th><th>Status</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="card">
        <div class="loghead">
          <h3 style="margin:0">📜 Console log</h3>
          <span style="display:flex;gap:6px">
            <button class="btn ghost sm" onclick="setLog('campaign')" id="btnLogCampaign">Campaign</button>
            <button class="btn ghost sm" onclick="setLog('sync')" id="btnLogSync">Sync</button>
            <button class="btn ghost sm" onclick="setLog('activity')" id="btnLogActivity">Activity</button>
            <button class="btn ghost sm" onclick="clearLog()" id="btnClrLog">Clear</button>
          </span>
        </div>
        <div class="logbox" id="logbox">
          <span class="spin"></span> waiting for log…
        </div>
      </div>
    </div>

    <!-- ══════════ SETTINGS ══════════ -->
    <div class="section" id="sec-settings">
      <div style="margin-bottom:12px;font-size:12.5px;color:#7d90ad">
        Changes are saved automatically into <code>Scripts/RUN_CAMPAIGN.py</code>
        <b>and</b> <code>Scripts/check_replies_and_reminders.py</code> (both Config classes).
        They take effect the next time a campaign, action, or reply-checker run starts.
      </div>
      <div class="set-grid" id="setGrid"></div>
      <div style="margin-top:16px">
        <button class="btn" onclick="saveConfig()">💾 Save settings</button>
        <span id="cfgMsg"></span>
      </div>
    </div>
  </main>
</div>

<script>
"use strict";
const $ = (s) => document.querySelector(s);
const secNames = {overview:"Overview", leads:"Leads", emaillist:"Email List", events:"Live Events", templates:"Templates", actions:"Actions", settings:"Settings"};
let EV_FILTER = "all";
let LEAD_SRC = "tracker";

/* ── navigation ── */
document.querySelectorAll(".nav button").forEach(b=>{
  b.addEventListener("click", ()=>{
    document.querySelectorAll(".nav button").forEach(x=>x.classList.remove("on"));
    document.querySelectorAll(".section").forEach(x=>x.classList.remove("on"));
    b.classList.add("on");
    const s = b.dataset.sec;
    $("#sec-"+s).classList.add("on");
    $("#pageTitle").textContent = secNames[s] || s;
    if(s==="events") loadEvents();
    if(s==="leads") loadLeads();
    if(s==="emaillist") loadEmailList();
    if(s==="templates") loadTemplates();
    if(s==="actions") loadActions();
    if(s==="settings") loadConfig();
  });
});

/* ── helpers ── */
async function get(url){ const r = await fetch(url, {cache:"no-store"}); return r.json(); }
function esc(s){
  if(s===null||s===undefined) return "";
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function pillTxt(txt, cls){ return `<span class="pill ${cls}">${esc(txt)}</span>`; }
/* Best-time-to-send per lead: maps the lead's country to a business-hours
   window in its local timezone (sent between 9 AM and 3 PM local). */
const COUNTRY_TZ = {
  "United States":"America/New_York","USA":"America/New_York","United Kingdom":"Europe/London","UK":"Europe/London",
  "India":"Asia/Kolkata","Australia":"Australia/Sydney","Canada":"America/Toronto","Germany":"Europe/Berlin",
  "France":"Europe/Paris","Spain":"Europe/Madrid","Italy":"Europe/Rome","Netherlands":"Europe/Amsterdam",
  "Belgium":"Europe/Brussels","Switzerland":"Europe/Zurich","Sweden":"Europe/Stockholm","Norway":"Europe/Oslo",
  "Denmark":"Europe/Copenhagen","Finland":"Europe/Helsinki","Poland":"Europe/Warsaw","Austria":"Europe/Vienna",
  "Portugal":"Europe/Lisbon","Ireland":"Europe/Dublin","Czech Republic":"Europe/Prague","Romania":"Europe/Bucharest",
  "Hungary":"Europe/Budapest","Greece":"Europe/Athens","Turkey":"Europe/Istanbul","Russia":"Europe/Moscow",
  "Ukraine":"Europe/Kiev","United Arab Emirates":"Asia/Dubai","UAE":"Asia/Dubai","Saudi Arabia":"Asia/Riyadh",
  "Qatar":"Asia/Qatar","Kuwait":"Asia/Kuwait","Bahrain":"Asia/Bahrain","Oman":"Asia/Muscat","Israel":"Asia/Jerusalem",
  "Singapore":"Asia/Singapore","Malaysia":"Asia/Kuala_Lumpur","Indonesia":"Asia/Jakarta","Thailand":"Asia/Bangkok",
  "Vietnam":"Asia/Ho_Chi_Minh","Philippines":"Asia/Manila","Hong Kong":"Asia/Hong_Kong","Taiwan":"Asia/Taipei",
  "China":"Asia/Shanghai","Japan":"Asia/Tokyo","South Korea":"Asia/Seoul","Pakistan":"Asia/Karachi",
  "Bangladesh":"Asia/Dhaka","Sri Lanka":"Asia/Colombo","Nepal":"Asia/Kathmandu","New Zealand":"Pacific/Auckland",
  "Mexico":"America/Mexico_City","Brazil":"America/Sao_Paulo","Argentina":"America/Argentina/Buenos_Aires",
  "Chile":"America/Santiago","Colombia":"America/Bogota","Peru":"America/Lima","South Africa":"Africa/Johannesburg",
  "Nigeria":"Africa/Lagos","Kenya":"Africa/Nairobi","Egypt":"Africa/Cairo","Morocco":"Africa/Casablanca",
  "Ghana":"Africa/Accra","Ethiopia":"Africa/Addis_Ababa","Tanzania":"Africa/Dar_es_Salaam","Uganda":"Africa/Kampala",
  "Zimbabwe":"Africa/Harare","Zambia":"Africa/Lusaka","Botswana":"Africa/Gaborone","Mauritius":"Indian/Mauritius",
  "Iceland":"Atlantic/Reykjavik"
};
function bestTimeFor(country){
  const tz = COUNTRY_TZ[String(country||"").trim()];
  if(!tz) return {txt:"9 AM–3 PM", title:"Local timezone unknown — use default business hours"};
  let label, offset="";
  try{
    const now = new Date().toLocaleString("en-US",{timeZone:tz});
    const off = new Date().toLocaleString("en-US",{timeZone:tz,timeZoneName:"short"}).split(" ").pop();
    offset = ` (UTC${off})`;
  }catch(e){}
  if(tz==="Asia/Kolkata") label="10 AM–4 PM";
  else if(tz==="Asia/Dubai"||tz==="Asia/Riyadh"||tz==="Asia/Qatar"||tz==="Asia/Kuwait") label="10 AM–3 PM";
  else if(tz.startsWith("Asia/")||tz.startsWith("Pacific/")) label="9 AM–2 PM";
  else label="9 AM–3 PM";
  return {txt:label+offset, title:`Best send window for ${esc(country)} — ${label} ${tz}`};
}
let _toastT=null;
function showToast(msg){
  let t = $("#toast");
  if(!t){ t = document.createElement("div"); t.id="toast"; document.body.appendChild(t); }
  t.textContent = msg; t.className = "show";
  clearTimeout(_toastT);
  _toastT = setTimeout(()=>{ t.className=""; }, 4200);
}

/* ── overview ── */
async function loadSummary(){
  const d = await get("/api/summary");
  $("#lockBanner").style.display = d.locked ? "block" : "none";
  $("#lastUpd").textContent = "Last updated " + (d.last_updated||"");
  const st = d;
  const cards = [
    ["📧 Emails sent", st.sent, "c-grn", `${st.total} total leads`, "status=Sent"],
    ["❌ Failed", st.failed, "c-red", "", "status=Failed"],
    ["📭 Bounced", st.bounced, "c-red", `${st.bounce_rate}% bounce rate`, "status=Bounced"],
    ["👁️ Opened", st.opened, "c-cyn", `${st.open_rate}% open rate`, "opened=yes"],
    ["🔗 Clicked", st.clicked, "c-amb", `${st.click_rate}% click rate`, "clicked=yes"],
    ["💬 Replied", st.replied, "c-pur", `${st.reply_rate}% reply rate`, "replied=yes"],
    ["⏰ Reminders", `${st.reminders_sent} sent`, "c-cyn", `${st.reminders_due} due now`, ""],
    ["🚫 Fake emails", st.fake, "c-red", "skipped, never emailed", "only=fake"],
  ];
  $("#kpiCards").innerHTML = cards.map(([l,v,cl,n,flt])=>
    `<div class="kpi${flt?" clickable":""}" ${flt?`onclick="openFiltered('${flt}')" title="Open these records in the Leads tab"`:""}>
      <div class="lbl">${l}</div><div class="val ${cl}">${v}</div><div class="note">${n}</div>
      ${flt?`<div class="go">open records →</div>`:""}
    </div>`).join("");

  const c = d.charts;
  $("#chartLegend").innerHTML =
    `<span><i style="background:var(--acc2)"></i> Sent</span>` +
    `<span><i style="background:var(--cyan)"></i> Opened</span>` +
    `<span><i style="background:var(--amb)"></i> Clicked</span>` +
    `<span><i style="background:var(--red)"></i> Failed</span>`;
  const sMax = Math.max(1, ...c.sent.values, ...c.failed.values, ...c.opens.values, ...c.clicks.values);
  let sh = "";
  c.sent.axis.forEach((day,i)=>{
    const s = c.sent.values[i], f = c.failed.values[i];
    const o = c.opens.values[i], k = c.clicks.values[i];
    const h = (n)=>n>0? Math.max(4,Math.round(100*n/sMax)) : 0;
    sh += `<div class="bar"><span>${day}: sent ${s} · opened ${o} · clicked ${k} · failed ${f}</span>`
        + `<i style="height:${h(s)}%;background:var(--acc2)"></i>`
        + `<i style="height:${h(o)}%;background:var(--cyan);transform:translateY(-100%)"></i>`
        + `<i style="height:${h(k)}%;background:var(--amb);transform:translateY(-200%)"></i>`
        + (f>0? `<i style="height:${h(f)}%;background:var(--red);transform:translateY(-300%)"></i>`:"") + `</div>`;
  });
  $("#chartSent").innerHTML = sh;
  const ax = c.sent.axis.map(d=>{
    const [, mo, dy] = d.split("-");
    return mo+"/"+dy;
  });
  $("#axisSent").innerHTML = `<span>${ax[0]}</span><span>${ax[Math.floor(ax.length/2)]}</span><span>${ax[ax.length-1]}</span>`;

  const cmax = Math.max(1, ...c.countries.map(x=>x.count));
  $("#countryList").innerHTML = c.countries.length
    ? c.countries.map(x=>`<div class="cnt-row"><span class="n" title="${esc(x.name)}">${esc(x.name)}</span>
        <span class="track"><i style="width:${Math.round(100*x.count/cmax)}%"></i></span>
        <span class="c">${x.count}</span></div>`).join("")
    : `<span style="color:#7d90ad;font-size:12px">No clicked links yet — people open but haven't clicked.</span>`;

  $("#langList").innerHTML = c.languages.length
    ? c.languages.map(([l,n])=>`<span class="chip"><b>${esc(l)}</b> · ${n}</span>`).join("")
    : `<span style="color:#7d90ad;font-size:12px">No data yet.</span>`;
  $("#fakeMini").innerHTML = d.fake
    ? `See the <b>Fake CEO Email</b> sheet in the tracker, or the Leads tab for details.`
    : `No fake emails detected — validation is active, so none got through.`;

  /* ── forecast card ── */
  const fc = d.forecast;
  $("#forecastBox").innerHTML = fc
    ? `<div style="display:flex;gap:22px;flex-wrap:wrap;align-items:center">
        <div><div style="font-size:11px;color:var(--mut)">Tomorrow's open rate</div>
          <div style="font-size:23px;font-weight:700;color:${fc.trend==="up"?"var(--grn)":"var(--red)"}">${fc.open==null?"—":fc.open+"%"}</div></div>
        <div><div style="font-size:11px;color:var(--mut)">Tomorrow's reply rate</div>
          <div style="font-size:23px;font-weight:700;color:${fc.trend==="up"?"var(--grn)":"var(--red)"}">${fc.reply==null?"—":fc.reply+"%"}</div></div>
        <div style="font-size:12px;color:var(--mut);line-height:1.6">
          7-day avg: open <b style="color:var(--txt)">${fc.avg_open}%</b> · reply <b style="color:var(--txt)">${fc.avg_reply}%</b><br>
          Trend: <b style="color:${fc.trend==="up"?"var(--grn)":"var(--red)"}">${fc.trend}</b></div>
      </div>`
    : `<span style="color:var(--mut)">Not enough data yet — need at least a few days of sends.</span>`;

  /* ── bounce analysis card ── */
  const bz = d.bounce||{};
  const bt = bz.types||{};
  $("#bounceBox").innerHTML =
    `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
       ${[["hard","Hard (no such user)"],["soft","Soft (temp/quota)"],["spam-filter","Spam-filter"],["unknown","Unknown"]]
          .map(([k,l])=>`<span class="chip" title="${l}">${esc(l)}: <b style="color:var(--red)">${bt[k]||0}</b></span>`).join("")}
       ${(bz.total||0)===0?`<span style="color:var(--mut);font-size:12px">No bounces recorded.</span>`:""}
     </div>` +
    ((bz.drop||[]).length
      ? `<div style="font-size:12px;color:#fca5a5;line-height:1.7">⚠ Suggest dropping these domains:<br>
           ${bz.drop.map(x=>`<span class="chip" title="${esc(x.domain)}: ${x.bounced}/${x.sent} sends bounced">${esc(x.domain)} · ${x.bounced}/${x.sent} (${x.share}%)</span>`).join("")}</div>`
      : `<span style="color:var(--mut);font-size:12px">No problematic domains — bounce profile is healthy.</span>`);

  /* ── per-template leaderboard ── */
  const ts = d.template_stats||[];
  $("#tmplStats").innerHTML = ts.length
    ? `<table><thead><tr>
        <th>Template</th><th style="text-align:right">Sent</th><th style="text-align:right">Opened</th>
        <th style="text-align:right">Open %</th><th style="text-align:right">Clicked</th>
        <th style="text-align:right">Replied</th><th style="text-align:right">Reply %</th></tr></thead>
       <tbody>${ts.map(t=>`<tr>
          <td style="font-weight:600;max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(t.name)}</td>
          <td style="text-align:right">${t.sent}</td><td style="text-align:right">${t.opened}</td>
          <td style="text-align:right;color:var(--grn);font-weight:600">${t.open_rate}%</td>
          <td style="text-align:right">${t.clicked}</td><td style="text-align:right">${t.replied}</td>
          <td style="text-align:right;color:var(--pur);font-weight:600">${t.reply_rate}%</td>
        </tr>`).join("")}</tbody></table>`
    : `<span style="color:var(--mut)">No sent emails yet — the leaderboard fills in as the campaign sends.</span>`;
}

/* ── leads ── */
let leadTimer=null;
function leadRefresh(){ if(LEAD_SRC==="source") loadSourceLeads(); else loadLeads(); }
function setLeadSource(src, btn){
  LEAD_SRC = src;
  document.querySelectorAll(".tbl-src").forEach(x=>x.classList.remove("on"));
  btn.classList.add("on");
  leadRefresh();
}
/* Clicking an Overview KPI card jumps to the Leads tab pre-filtered to
   exactly those records (e.g. "Bounced" → status=Bounced). */
function openFiltered(params){
  setLeadSource("tracker", document.querySelector('.tbl-src[data-src="tracker"]'));
  const p = {};
  (params||"").split("&").filter(Boolean).forEach(kv=>{
    const [k,v] = kv.split("="); p[k]=v;
  });
  $("#leadStatus").value  = p.status||"";
  $("#leadOpen").value    = p.opened||"";
  $("#leadReply").value   = p.replied||"";
  $("#leadOnly").value    = p.only||"";
  document.querySelectorAll(".nav button").forEach(x=>x.classList.remove("on"));
  document.querySelector('.nav button[data-sec="leads"]').classList.add("on");
  document.querySelectorAll(".section").forEach(x=>x.classList.remove("on"));
  $("#sec-leads").classList.add("on");
  $("#pageTitle").textContent = "Leads";
  loadLeads();
}
/* Download the currently-filtered lead records (Excel by default). */
function downloadReport(fmt){
  const params = `q=${encodeURIComponent($("#leadQ").value)}&status=${encodeURIComponent($("#leadStatus").value)}&opened=${$("#leadOpen").value}&replied=${$("#leadReply").value}&only=${encodeURIComponent($("#leadOnly").value)}&fmt=${fmt||"xlsx"}`;
  window.location.href = "/api/report/download?" + params;
  showToast("Downloading report…");
}
async function loadLeads(){
  clearTimeout(leadTimer);
  leadTimer = setTimeout(async ()=>{
    const q=$("#leadQ").value, status=$("#leadStatus").value, open=$("#leadOpen").value,
          reply=$("#leadReply").value, only=$("#leadOnly").value, clicked=$("#leadClicked")?$("#leadClicked").value:"";
    const d = await get(`/api/leads?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}&opened=${open}&replied=${reply}&clicked=${clicked}&only=${only}`);
    $("#leadCount").textContent = `${d.count} record(s) found` + (d.fake_count ? ` · ${d.fake_count} fake CEO email(s)` : "");
    $("#leadTable").style.display=""; $("#srcTable").style.display="none";
    let html = "";
    const pushRow = (r)=>{
      const s = String(r["Email Send Status"]||"").trim();
      const opened = String(r["Email Open Status"]||"").trim() === "Opened";
      const clicked = String(r["Link Clicked"]||"").trim() === "Yes";
      const replied = String(r["Reply Received"]||"").trim() === "Yes";
      const rsent = String(r["Reminder Sent"]||"").trim() === "Yes";
      const sCls = s==="Sent"?"sent":s==="Failed"?"failed":s==="Bounced"?"bounced":"fake";
      const score = r["score"]||0;
      const sl = r["score_label"]||"Cold";
      const scoreCls = sl==="Hot"?"yes":sl==="Warm"?"opened":"closed";
      html += `<tr>
        <td><b>${esc(r["Company"])}</b></td>
        <td>${esc(r["Contact Person"])}</td>
        <td class="mono">${esc(r["Email"])}</td>
        <td>${esc(r["Sent Date"])}</td>
        <td>${pillTxt(`${sl} ${score}`, scoreCls)}</td>
        <td>${pillTxt(s||"—", sCls)}</td>
        <td>${opened ? pillTxt("Opened","opened") : pillTxt("—","closed")}</td>
        <td>${clicked ? pillTxt("Yes","yes") : pillTxt("—","no")}</td>
        <td>${esc(r["Website Visits"]||"0")}</td>
        <td>${replied ? pillTxt("Yes","yes") : pillTxt("No","no")}</td>
        <td>${rsent ? pillTxt("Sent","yes") : pillTxt("—","no")}</td>
        <td>${esc(r["Opened From Country"]||"—")}</td>
        <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis">${esc(r["Subject"])}</td>
      </tr>`;
    };
    d.rows.forEach(pushRow);
    d.fakes.forEach(f=>{
      html += `<tr>
        <td><b>${esc(f["Company"])}</b></td>
        <td>${esc(f["Contact Person"])}</td>
        <td class="mono">${esc(f["Email"])}</td>
        <td>—</td>
        <td>${pillTxt("Fake","fake")}</td>
        <td colspan="6" style="color:#fbbf24">${esc(f["Validation Reason"]||"")} · ${esc(f["Country"]||"")} ${esc(f["City"]||"")}</td>
        <td colspan="2">${f["Validated At"]?esc(f["Validated At"]):""}</td>
      </tr>`;
    });
    $("#leadTable tbody").innerHTML = html || `<tr><td colspan="13" style="text-align:center;color:#7d90ad;padding:30px">No records match.</td></tr>`;
  }, 250);
}

/* ── source leads (the campaign Excel) ── */
let srcTimer=null;
async function loadSourceLeads(){
  clearTimeout(srcTimer);
  srcTimer = setTimeout(async ()=>{
    const q=$("#leadQ").value, st=$("#leadStatus").value;
    const d = await get(`/api/source-leads?q=${encodeURIComponent(q)}&status=${encodeURIComponent(st)}`);
    $("#leadCount").textContent = `${d.count} lead(s) · ${d.error||""}`.trim();
    const c = d.counts||{};
    $("#srcCounts").innerHTML = Object.entries(c).map(([k,v])=>
      `<span class="chip">${esc(k)}: <b>${v}</b></span>`).join("");
    $("#leadTable").style.display="none"; $("#srcTable").style.display="";
    const clsMap = {"Sent":"sent","Fake":"fake","Not sent":"no","No email":"closed"};
    $("#srcTable tbody").innerHTML = (d.rows||[]).map(r=>{
      const bt = bestTimeFor(r["Country"]);
      return `<tr>
      <td><b>${esc(r["Company Name"])}</b>${r["_dup"]?` <span class="pill fake" title="This company appears ${r["_dup_count"]||2} times in the list — avoid emailing the same company twice">⚠ dup</span>`:""}</td>
      <td>${esc(r["CEO Name"])}</td>
      <td class="mono">${esc(r["Lead Email ID"])}</td>
      <td>${pillTxt(esc(r["_status"]), clsMap[r["_status"]]||"closed")}</td>
      <td>${esc(r["Country"])}</td>
      <td title="${bt.title}">${bt.txt}</td>
      <td>${esc(r["City"])}</td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(r["Major Industries"])}</td>
      <td>${esc(r["No Of Employees"])}</td>
      <td>${esc(r["Category Type"])}</td>
    </tr>`;}).join("") || `<tr><td colspan="10" style="text-align:center;color:#7d90ad;padding:30px">No leads match.</td></tr>`;
    $("#srcCounts").innerHTML = (d.dup_rows||0) ? `<span class="chip" style="color:var(--amb)">⚠ ${d.dup_rows} row(s) share a company — check duplicates</span>` : "";
  }, 250);
}

/* ── email list ── */
let elTimer=null;
let EL_ROWS = [];
let EL_EDITING = null;   // original email currently being edited
async function loadEmailList(){
  clearTimeout(elTimer);
  elTimer = setTimeout(async ()=>{
    const q=$("#elQ").value, st=$("#elStatus").value;
    const d = await get(`/api/email-list?q=${encodeURIComponent(q)}&status=${encodeURIComponent(st)}`);
    EL_ROWS = d.rows || [];
    if(d.error){
      $("#elCount").innerHTML = `<span style="color:var(--red)">⚠ ${esc(d.error)}</span>`;
      $("#elCounts").textContent = "";
      $("#elBlocked").innerHTML = "";
      $("#elTable tbody").innerHTML = "";
      return;
    }
    $("#elCount").textContent = `${d.count} email(s)`;
    const c = d.counts||{};
    $("#elCounts").innerHTML = Object.entries(c).map(([k,v])=>
      `<span class="chip">${esc(k)}: <b>${v}</b></span>`).join("");
    const clsMap = {"Sent":"sent","Fake":"fake","Not sent":"no","No email":"closed"};
    $("#elTable tbody").innerHTML = EL_ROWS.map((r,i)=>{
      const stt = r["_status"]||"Not sent";
      const bt = bestTimeFor(r["Country"]);
      return `<tr>
        <td><b>${esc(r["Company Name"])}</b>${r["_dup"]?` <span class="pill fake" title="This company appears ${r["_dup_count"]||2} times in the list — avoid emailing the same company twice">⚠ dup</span>`:""}</td>
        <td>${esc(r["CEO Name"])}</td>
        <td class="mono">${esc(r["Lead Email ID"])}</td>
        <td>${esc(r["Country"])}</td>
        <td title="${bt.title}">${bt.txt}</td>
        <td>${esc(r["Region"])}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(r["Major Industries"])}</td>
        <td>${pillTxt(stt, clsMap[stt]||"closed")}</td>
        <td style="text-align:right;white-space:nowrap">
          ${stt==="Not sent"
            ? `<button class="btn green sm" title="Send a personalised campaign email to this lead right now" onclick="sendOneEmail(${i})">📨 Send</button>`
            : ""}
          <button class="btn ghost sm" onclick="editEmail(${i})">✏️ Edit</button>
          <button class="btn red sm" onclick="deleteEmail(${i})">🗑 Remove</button>
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="9" style="text-align:center;color:#7d90ad;padding:30px">No emails in the list.</td></tr>`;
    $("#elBlocked").innerHTML = (d.sent_blocked||[]).length
      ? d.sent_blocked.map(e=>`<span class="chip" title="${esc(e)}">${esc(e)}</span>`).join("")
      : `<span style="font-size:12px;color:#7d90ad">Nothing sent yet — empty log.</span>`;
    loadUploads();
  }, 250);
}
async function loadUploads(){
  const box = $("#elUploads");
  try{
    const d = await get("/api/email-list/uploads");
    const b = d.batches||[];
    box.style.display = b.length ? "block" : "none";
    box.innerHTML = `<div style="font-size:12px;color:#7d90ad;margin-bottom:4px">📂 Imported from files — remove only that file's data:</div>` +
      b.map(x=>`<span class="chip" title="${esc(x.file)} (${x.count} emails, ${esc(x.when)})">
          ${esc(x.file)} · ${x.count}
          <button class="btn red sm" style="margin-left:6px" onclick="removeUploadBatch('${esc(x.id)}','${esc(x.file)}',${x.sent_count||0})">🗑</button>
        </span>`).join("");
  }catch(e){ box.style.display="none"; }
}
async function removeUploadBatch(id, file, sentCount){
  if(!confirm(`Remove the '${file}' data from the email list?\n\nUnsent leads of that file are removed.\n\nALREADY-SENT data is NEVER removed — it stays in the Email List and the Leads tab forever (${sentCount||0} sent lead(s) in this file).`)) return;
  const msg = $("#elMsg");
  msg.className="state run"; msg.innerHTML=`<span class="spin"></span> removing ${esc(file)} data…`;
  const res = await fetch("/api/email-list/upload/remove",{method:"POST", cache:"no-store",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify({batch_id: id})});
  const d = await res.json();
  msg.className = d.ok ? "state ok" : "state err";
  msg.innerHTML = d.ok
    ? `<span style="color:var(--grn)">✔ Removed ${d.removed} row(s) of '<b>${esc(file)}</b>' data` +
      ((d.kept_sent||0)>0 ? ` — <b>${d.kept_sent}</b> already-sent lead(s) kept (shown in Email List + Leads tab forever)` : "") +
      (d.note?` — ${esc(d.note)}`:"") + `.</span>`
    : "⚠ "+(d.error||"failed");
  if(d.ok) showToast(`Removed ${d.removed} uploaded rows`);
  loadEmailList();
}
function editEmail(i){
  const r = EL_ROWS[i];
  if(!r) return;
  EL_EDITING = r["Lead Email ID"];
  $("#elCompany").value = r["Company Name"]||"";
  $("#elCEO").value = r["CEO Name"]||"";
  $("#elEmail").value = r["Lead Email ID"]||"";
  $("#elCountry").value = r["Country"]||"";
  $("#elRegion").value = r["Region"]||"";
  $("#elAddBtn").textContent = "💾 Save changes";
  $("#elCancelBtn").style.display = "";
  const msg = $("#elMsg");
  msg.className="state run";
  msg.innerHTML = `Editing <b>${esc(EL_EDITING)}</b> — change the fields and press <b>Save changes</b>.`;
  window.scrollTo({top:0, behavior:"smooth"});
}
function cancelEdit(){
  EL_EDITING = null;
  ["elEmail","elCompany","elCEO","elCountry","elRegion"].forEach(id=>{ $("#"+id).value=""; });
  $("#elAddBtn").textContent = "＋ Add";
  $("#elCancelBtn").style.display = "none";
  $("#elMsg").className=""; $("#elMsg").textContent="";
  $("#elEmail").focus();
}
async function addEmail(){
  const msg = $("#elMsg");
  const email = $("#elEmail").value.trim();
  if(!email){ msg.className="state err"; msg.textContent="⚠ Email is required."; return; }
  const fields = { email,
    company: $("#elCompany").value.trim(),
    ceo: $("#elCEO").value.trim(),
    country: $("#elCountry").value.trim(),
    region: $("#elRegion").value.trim(),
  };
  if(EL_EDITING){
    fields.email = EL_EDITING;
    fields.new_email = email;
    msg.className="state run"; msg.innerHTML=`<span class="spin"></span> saving changes…`;
    const r = await fetch("/api/email-list/update",{method:"POST", cache:"no-store",
        headers:{"Content-Type":"application/json"}, body: JSON.stringify(fields)});
    const d = await r.json();
    if(d.ok){
      msg.className="state ok"; msg.innerHTML=`<span style="color:var(--grn)">✔ Saved changes (${esc(d.email)}).</span>`;
      cancelEdit();
    } else {
      msg.className="state err"; msg.textContent="⚠ "+(d.error||"failed");
    }
    loadEmailList();
    return;
  }
  msg.className="state run"; msg.innerHTML=`<span class="spin"></span> adding…`;
  const r = await fetch("/api/email-list/add",{method:"POST", cache:"no-store",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify(fields)});
  const d = await r.json();
  if(d.ok){
    msg.className="state ok"; msg.innerHTML=`<span style="color:var(--grn)">✔ Added ${esc(d.email)} to the list.</span>`;
    ["elEmail","elCompany","elCEO","elCountry","elRegion"].forEach(id=>{ $("#"+id).value=""; });
    loadEmailList();
  } else {
    msg.className="state err"; msg.textContent="⚠ "+(d.error||"failed");
  }
}
let UPLOAD_FILE = null;   // File object held between preview and import
async function uploadEmails(){
  const input = document.getElementById("elFile");
  const f = input.files[0];
  if(!f) return;
  UPLOAD_FILE = f;
  const pv = $("#elPreview");
  const msg = $("#elMsg");
  pv.style.display = "block";
  pv.innerHTML = `<div class="state run"><span class="spin"></span> reading ${esc(f.name)}…</div>`;
  msg.className=""; msg.textContent="";
  const fd = new FormData();
  fd.append("file", f);
  fd.append("dry_run", "1");
  try{
    const r = await fetch("/api/email-list/upload",{method:"POST", cache:"no-store", body: fd});
    const d = await r.json();
    if(!d.ok){ pv.style.display="none"; msg.className="state err"; msg.textContent="⚠ "+(d.error||"upload failed"); return; }
    if(!d.preview){ pv.style.display="none"; msg.className="state ok"; msg.textContent=`✔ ${d.added} of ${d.total} imported.`; loadEmailList(); return; }

    const stMeta = {
      added:     ["✔ to add",   "no"],
      dup:       ["duplicate",  "closed"],
      sent:      ["already sent","sent"],
      invalid:   ["no email",   "fake"]
    };
    const show = d.rows.slice(0, 50);
    const rest = d.rows.length - show.length;
    const rowsTxt = show.map(r=>{
      const m = stMeta[r.status]||["","closed"];
      return `<tr>
        <td><b>${esc(r.company)}</b></td>
        <td>${esc(r.ceo)}</td>
        <td class="mono">${esc(r.email)}</td>
        <td>${esc(r.country)}</td>
        <td>${esc(r.region)}</td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis">${esc(r.industries)}</td>
        <td>${pillTxt(m[0], m[1])}</td>
      </tr>`;
    }).join("");

    pv.innerHTML = `
      <div class="card" style="margin-top:10px">
        <h3>🖇 Preview — <b>${esc(d.file)}</b></h3>
        <div style="font-size:12px;color:#7d90ad;margin-bottom:8px">
          Detected columns: ${Object.entries(d.cols_labels||{}).filter(([k])=>k in (d.cols||{})).map(([k,v])=>`<code>${esc(v)}</code>`).join(", ")}
          — nothing has been saved yet.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
          <span class="chip">Will add: <b style="color:var(--grn)">${d.added}</b></span>
          <span class="chip">Duplicate: <b>${d.skipped_dup}</b></span>
          <span class="chip">Already sent: <b>${d.skipped_sent}</b></span>
          <span class="chip">Invalid: <b>${d.skipped_invalid}</b></span>
        </div>
        <div class="tblbox" style="max-height:320px;overflow:auto"><table>
          <thead><tr><th>Company</th><th>CEO / Contact</th><th>Email</th><th>Country</th><th>Region</th><th>Industries</th><th>Status</th></tr></thead>
          <tbody>${rowsTxt||`<tr><td colspan="7" style="text-align:center;color:#7d90ad;padding:20px">No rows.</td></tr>`}</tbody>
        </table></div>
        ${rest>0?`<div style="font-size:12px;color:#7d90ad;margin-top:6px">…and ${rest} more row(s) — all will be added/skipped the same way.</div>`:""}
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn green" onclick="confirmUpload()">✔ Import ${d.added} email(s)</button>
          <button class="btn ghost" onclick="cancelUpload()">✖ Cancel</button>
        </div>
      </div>`;
  }catch(e){
    pv.style.display="none";
    msg.className="state err"; msg.textContent="⚠ Upload failed — is the dashboard running?";
  }
  input.value ="";
}
async function confirmUpload(){
  const pv = $("#elPreview");
  const msg = $("#elMsg");
  if(!UPLOAD_FILE) return;
  pv.innerHTML = `<div class="state run"><span class="spin"></span> importing ${esc(UPLOAD_FILE.name)}…</div>`;
  const fd = new FormData();
  fd.append("file", UPLOAD_FILE);
  try{
    const r = await fetch("/api/email-list/upload",{method:"POST", cache:"no-store", body: fd});
    const d = await r.json();
    pv.style.display = "none";
    UPLOAD_FILE = null;
    if(d.ok){
      msg.className="state ok";
      msg.innerHTML = `<span style="color:var(--grn)">✔ Imported <b>${d.added}</b> of ${d.total} email(s)</span> from <b>${esc(d.file)}</b>` +
        (d.skipped_dup||d.skipped_sent||d.skipped_invalid
          ? ` — skipped: duplicate ${d.skipped_dup}, already-sent ${d.skipped_sent}, invalid ${d.skipped_invalid}`
          : "");
      showToast(`Imported ${d.added} emails`);
    } else {
      msg.className="state err"; msg.textContent="⚠ "+(d.error||"import failed");
    }
  }catch(e){
    pv.style.display="none"; UPLOAD_FILE = null;
    msg.className="state err"; msg.textContent="⚠ Import failed — is the dashboard running?";
  }
  loadEmailList();
}
function cancelUpload(){
  $("#elPreview").style.display = "none";
  UPLOAD_FILE = null;
  const msg = $("#elMsg");
  msg.className="state ok"; msg.textContent="✔ Preview cancelled — nothing was changed.";
}
async function sendOneEmail(i){
  const r = EL_ROWS[i];
  if(!r) return;
  const email = r["Lead Email ID"];
  const msg = $("#elMsg");
  if(!confirm(`Send a personalised campaign email to ${email} now?\n\nThis sends the standard campaign template with tracking (pixel + link tracking), and marks the lead as SENT.\n\nCompany: ${r["Company Name"]||"—"}\nContact: ${r["CEO Name"]||"—"}`)) return;
  msg.className="state run"; msg.innerHTML=`<span class="spin"></span> sending to ${esc(email)}…`;
  const res = await fetch("/api/email-list/send",{method:"POST", cache:"no-store",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify({email})});
  const d = await res.json();
  msg.className = d.ok ? "state ok" : "state err";
  msg.innerHTML = d.ok
    ? `<span style="color:var(--grn)">✔ Sent to ${esc(email)} — marked as sent (duplicate protection now active).</span>`
    : "⚠ "+(d.error||"send failed");
  if(d.ok) showToast(`Sent to ${email}`);
  loadEmailList();
}
/* ── raw data → validate → organise → send ── */
let RAW_ROWS = [];
const RAW_VAL_CLS = {"real":"no","fake":"fake","unknown":"closed"};
async function rawPreview(){
  const input = document.getElementById("rawFile");
  const f = input.files[0];
  if(!f) return;
  const msg = $("#rawMsg");
  msg.className="state run"; msg.innerHTML=`<span class="spin"></span> extracting + validating emails (SMTP check can take a moment)…`;
  const fd = new FormData();
  fd.append("file", f);
  try{
    const r = await fetch("/api/email-list/raw/preview",{method:"POST", cache:"no-store", body: fd});
    const d = await r.json();
    if(!d.ok){ msg.className="state err"; msg.textContent="⚠ "+(d.error||"failed"); $("#rawPanel").style.display="none"; return; }
    RAW_ROWS = d.rows || [];
    const c = d.counts||{};
    $("#rawChips").innerHTML =
      `<span class="chip">✔ Real: <b style="color:var(--grn)">${c.real||0}</b></span>` +
      `<span class="chip">✖ Fake: <b style="color:var(--red)">${c.fake||0}</b></span>` +
      `<span class="chip">? Unknown: <b>${c.unknown||0}</b></span>` +
      `<span class="chip">Total: <b>${d.total}</b> from ${esc(d.file)}</span>`;
    const tb = $("#rawTable");
    tb.innerHTML = RAW_ROWS.map((r,i)=>{
      const v = r.valid==="real" ? "✔ REAL" : r.valid==="fake" ? "✖ FAKE" : "? UNKNOWN";
      return `<tr>
        <td><input type="checkbox" class="rawck" data-i="${i}"${r.valid==="real"?" checked":""} ${r.valid==="real"?"":"disabled"}></td>
        <td class="mono">${esc(r.email)}</td>
        <td>${esc(r.company)||"—"}</td>
        <td>${esc(r.ceo)||"—"}</td>
        <td>${pillTxt(v, RAW_VAL_CLS[r.valid]||"closed")}</td>
        <td style="font-size:12px;color:#7d90ad">${esc(r.reason)||""}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" style="text-align:center;padding:20px">No emails found.</td></tr>`;
    rawSelInfo();
    rawSelAllSet();
    $("#rawPanel").style.display = "block";
    $("#rawSaveBtn").style.display = "";  // any selected rows can be saved
    $("#rawAddBtn").style.display  = $("#rawSendBtn").style.display = c.real ? "" : "none";
    $("#rawFakeBtn").style.display = (c.fake||0)+(c.unknown||0) ? "" : "none";
    msg.className="state ok"; msg.innerHTML=`<span style="color:var(--grn)">✔ Extracted <b>${d.total}</b> email(s) — validated. Nothing was added or sent yet.</span>`;
  }catch(e){
    msg.className="state err"; msg.textContent="⚠ Upload failed — is the dashboard running?";
  }
  input.value = "";
}
function rawSelected(){
  return [...document.querySelectorAll("#rawPanel .rawck:checked")].map(cb=>RAW_ROWS[+cb.dataset.i].email);
}
function rawSelectedCount(){
  return document.querySelectorAll("#rawPanel .rawck:checked").length;
}
function rawSelInfo(){
  const n = rawSelectedCount();
  $("#rawSelInfo").textContent = `${n} selected (only REAL emails are selectable — fakes can never be added or sent)`;
  $("#rawAddBtn").style.display = $("#rawSendBtn").style.display = n ? "" : "none";
}
function rawSelAllSet(){
  const cbs = [...document.querySelectorAll("#rawPanel .rawck")];
  const on = cbs.filter(c=>!c.disabled).length;
  const chk = cbs.filter(c=>c.checked).length;
  const sel = document.getElementById("rawSelAll")||null;
  if(sel) sel.checked = on>0 && chk===on;
}
function rawToggleAll(){
  const cbs = [...document.querySelectorAll("#rawPanel .rawck")];
  const sel = document.getElementById("rawSelAll");
  if(!sel) return;
  cbs.forEach(c=>{ if(!c.disabled) c.checked = sel.checked; });
  rawSelInfo();
}
async function rawSaveExcel(){
  const emails = rawSelected();
  if(!emails.length) return;
  const msg = $("#rawMsg");
  msg.className="state run"; msg.innerHTML=`<span class="spin"></span> building organised Excel…`;
  const r = await fetch("/api/email-list/raw/save",{method:"POST", cache:"no-store",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify({emails})});
  const d = await r.json();
  msg.className = d.ok ? "state ok" : "state err";
  msg.innerHTML = d.ok
    ? `<span style="color:var(--grn)">✔ Organised <b>${d.count}</b> row(s) into <b>${esc(d.file)}</b> (Real Leads + Fake/Errors sheets) — ` +
      `<a href="/api/email-list/raw/download?file=${encodeURIComponent(d.file)}" style="color:var(--grn);text-decoration:underline">⬇ download this file</a>.</span>`
    : "⚠ "+(d.error||"failed");
}
async function rawAddToList(){
  const emails = rawSelected();
  if(!emails.length) return;
  const msg = $("#rawMsg");
  msg.className="state run"; msg.innerHTML=`<span class="spin"></span> adding REAL emails to the Email List…`;
  const r = await fetch("/api/email-list/raw/add",{method:"POST", cache:"no-store",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify({emails})});
  const d = await r.json();
  msg.className = d.ok ? "state ok" : "state err";
  msg.innerHTML = d.ok
    ? `<span style="color:var(--grn)">✔ Added <b>${d.added}</b> validated real email(s) to the list` +
      (d.skipped_dup||d.skipped_sent ? ` — skipped: duplicate ${d.skipped_dup}, already-sent ${d.skipped_sent}` : "") + `.</span>`
    : "⚠ "+(d.error||"failed");
  if(d.ok) loadEmailList();
}
async function rawSend(){
  const emails = rawSelected();
  if(!emails.length) return;
  if(!confirm(`Send campaign emails to ${emails.length} validated REAL email(s)?\n\nOnly emails that passed validation are sent. Each result is reported below.\n\nThis may take a while (polite delay between sends).`)) return;
  const msg = $("#rawMsg");
  msg.className="state run"; msg.innerHTML=`<span class="spin"></span> sending to ${emails.length} validated email(s)…`;
  try{
    const r = await fetch("/api/email-list/raw/send",{method:"POST", cache:"no-store",
        headers:{"Content-Type":"application/json"}, body: JSON.stringify({emails})});
    const d = await r.json();
    if(d.ok){
      const errs = (d.results||[]).filter(x=>!x.ok);
      msg.className="state ok";
      msg.innerHTML = `<span style="color:var(--grn)">✔ Sent <b>${d.sent}</b>, failed <b>${d.failed}</b></span>` +
        (errs.length ? `<div style="margin-top:6px;font-size:12px">${errs.map(e=>`⚠ <b>${esc(e.email)}</b>: ${esc(e.error)}`).join("<br>")}</div>` : "");
      showToast(`Sent ${d.sent} emails`);
      loadEmailList();
    } else {
      msg.className="state err"; msg.textContent="⚠ "+(d.error||"send failed");
    }
  }catch(e){
    msg.className="state err"; msg.textContent="⚠ Send failed — is the dashboard running?";
  }
}

async function rawFakeList(){
  const msg = $("#rawMsg");
  msg.className="state run"; msg.innerHTML=`<span class="spin"></span> building fake list…`;
  const r = await fetch("/api/email-list/raw/fake",{method:"POST", cache:"no-store"});
  const d = await r.json();
  msg.className = d.ok ? "state ok" : "state err";
  msg.innerHTML = d.ok
    ? `<span style="color:var(--red)">Fake list ready: <b>${d.count}</b> fake/invalid email(s) → <b>${esc(d.file)}</b> — ` +
      `<a href="/api/email-list/raw/download?file=${encodeURIComponent(d.file)}" style="color:var(--red);text-decoration:underline">⬇ download</a>.</span>`
    : "⚠ "+(d.error||"failed");
}
async function fakeListDownload(){
  const msg = $("#elMsg");
  msg.className="state run"; msg.innerHTML=`<span class="spin"></span> building fake list…`;
  const r = await fetch("/api/email-list/fake/download",{method:"POST", cache:"no-store"});
  const d = await r.json();
  msg.className = d.ok ? "state ok" : "state err";
  msg.innerHTML = d.ok
    ? `<span style="color:var(--red)">Tracker fake list ready: <b>${d.count}</b> record(s) → <b>${esc(d.file)}</b> — ` +
      `<a href="/api/email-list/raw/download?file=${encodeURIComponent(d.file)}" style="color:var(--red);text-decoration:underline">⬇ download</a>.</span>`
    : "⚠ "+(d.error||"failed");
}

async function deleteEmail(i){
  const r = EL_ROWS[i];
  if(!r) return;
  const email = r["Lead Email ID"];
  if(!confirm(`Remove ${email} from the email list?\n\nThis deletes the row from the campaign Excel.`)) return;
  const msg = $("#elMsg");
  msg.className="state run"; msg.innerHTML=`<span class="spin"></span> removing…`;
  const res = await fetch("/api/email-list/delete",{method:"POST", cache:"no-store",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify({email})});
  const d = await res.json();
  msg.className = d.ok ? "state ok" : "state err";
  msg.innerHTML = d.ok
    ? `<span style="color:var(--grn)">✔ Removed ${esc(email)} (${d.removed} row${d.removed>1?"s":""}).</span>`
    : "⚠ "+(d.error||"failed");
  if(d.ok) loadEmailList();
}

/* ── events ── */
function setEventFilter(f, btn){
  EV_FILTER = f;
  document.querySelectorAll(".fbtn").forEach(x=>x.classList.remove("on"));
  btn.classList.add("on");
  loadEvents();
}
async function loadEvents(){
  const d = await get("/api/events?limit=250");
  const list = d.filter(e=> EV_FILTER==="all" || e.event===EV_FILTER);
  $("#evCount").textContent = `${list.length} shown · ${d.length} latest`;
  const map = {
    email_opened:["📬","open","opened an email"],
    link_clicked:["🔗","click","clicked a link"],
    website_visit:["🌐","visit","visited the website"],
    time_on_site:["⏱️","time","spent time on the website"],
  };
  $("#eventFeed").innerHTML = list.map(e=>{
    const [ic, cls, verb] = map[e.event] || ["•","open",e.event||"event"];
    let det = "";
    if(e.event==="email_opened") det = `opened at ${esc(e.opened_at)} · open #${esc(e.open_count)}`;
    if(e.event==="link_clicked"){
      const loc = e.location||{};
      det = `clicked at ${esc(e.clicked_at||"—")} · ${esc(loc.city||"")} ${esc(loc.country||"")}`.trim();
    }
    if(e.event==="website_visit") det = `visit #${esc(e.visit_number)} at ${esc(e.visited_at||"—")}`;
    if(e.event==="time_on_site") det = `+${esc(e.seconds_added)}s → total ${esc(e.total_time||"—")}`;
    return `<div class="ev"><div class="ic ${cls}">${ic}</div>
      <div class="t"><b>${esc(e.company||"?")}</b> ${verb}
        <span style="color:#7d90ad">· <span class="mono" style="font-size:11px">${esc(e.email)}</span></span><br>
        <span class="m">${det}</span>
        <span class="m"> · ${esc(e.timestamp)}</span></div></div>`;
  }).join("") || `<div style="color:#7d90ad;padding:24px;text-align:center">No events yet — send a campaign first.</div>`;
}

/* ── templates ── */
let PREV_FILE = null, GEN_LEADS = [];
async function loadTemplates(){
  const d = await get("/api/templates");
  let html = "";
  d.templates.forEach(f=>{
    const isFirst = f===d.active, isFol = f===d.active_followup;
    html += `<div style="background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:11px 13px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <b>📄 ${esc(f)}</b>
        ${isFirst?pillTxt("first-contact","sent"):""}
        ${isFol?pillTxt("follow-up","opened"):""}
        <span style="flex:1"></span>
        <button class="btn ghost sm" onclick="previewTemplate('${esc(f)}')">Preview</button>
        <button class="btn ghost sm amber" onclick="editTemplate('${esc(f)}')">✏️ Edit</button>
        <button class="btn sm" onclick="activateTemplate('${esc(f)}','first')">Use as first-contact</button>
        <button class="btn sm amber" onclick="activateTemplate('${esc(f)}','followup')">Use as follow-up</button>
      </div></div>`;
  });
  $("#tmplList").innerHTML = html || `<span style="color:#7d90ad;font-size:12px">No templates found in Templates\\ folder.</span>`;
  if(!PREV_FILE && d.templates.length) previewTemplate(d.active || d.templates[0]);
  loadGenLeads();
}
async function previewTemplate(file){
  PREV_FILE = file;
  const d = await get(`/api/template/preview?file=${encodeURIComponent(file)}`);
  if(d.error){ $("#previewName").textContent = d.error; return; }
  $("#previewName").textContent = " — " + file + " (sample data filled in)";
  $("#tmplPreview").srcdoc = `<html><body style="font-family:Arial,sans-serif;background:#fff;padding:26px;color:#222;font-size:14px">${d.html}</body></html>`;
}
async function activateTemplate(file, mode){
  const r = await fetch("/api/template/activate",{method:"POST", cache:"no-store",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify({file, mode})});
  const d = await r.json();
  if(d.ok){ loadTemplates(); }
  else alert("⚠ "+(d.error||"failed"));
}
/* Load an existing template into the manual HTML editor below. */
async function editTemplate(file){
  const d = await get(`/api/template/read?file=${encodeURIComponent(file)}`);
  if(d.error){ alert("⚠ "+d.error); return; }
  activateGh = {html: d.html};
  $("#genEdit").value = d.html;
  $("#genSaveName").value = d.file;
  $("#genPreview").srcdoc = `<html><body style="font-family:Arial,sans-serif;background:#fff;padding:26px;color:#222;font-size:14px">${d.html}</body></html>`;
  $("#genResult").style.display = "block";
  $("#genEditBox").style.display = "block";
  $("#genPreview").style.display = "none";
  $("#btnGenEdit").textContent = "👁️ Preview";
  $("#genEditHint").style.display = "block";
  showToast("Template loaded into the editor — edit and click Save.");
  document.querySelector("#sec-templates .grid2").scrollIntoView({behavior:"smooth", block:"end"});
  $("#genEdit").focus();
}
async function loadGenLeads(){
  try{
    const d = await get("/api/source-leads");
    GEN_LEADS = d.rows||[];
    const opt = GEN_LEADS.map((r,i)=>`<option value="${i}">${esc(r["Company Name"]||"Lead "+(i+1))}</option>`).join("");
    $("#genLead").innerHTML = `<option value="-1">(first lead with details)</option>` + opt;
  }catch(e){ $("#genLead").innerHTML = `<option value="-1">(no leads available)</option>`; }
}
const GEN_STYLE_LABELS = {professional:"Professional",warm:"Warm &amp; friendly",short:"Short &amp; direct",executive:"Executive",partnership:"Partnership"};
async function generateTemplate(){
  const stEl = $("#genStatus");
  stEl.className="state run"; stEl.innerHTML=`<span class="spin"></span> generating…`;
  const usePh = $("#genPlaceholder").checked;
  let lead = {};
  if(!usePh){
    const idx = parseInt($("#genLead").value||"-1",10);
    if(idx>=0 && GEN_LEADS[idx]) lead = GEN_LEADS[idx];
  }
  const body = {
    style: $("#genStyle").value,
    variant: $("#genVariant").value,
    use_placeholder: usePh,
    prompt: $("#genPrompt").value,
    lead: lead,
  };
  const r = await fetch("/api/template/generate",{method:"POST", cache:"no-store",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)});
  const d = await r.json();
  if(d.error){ stEl.className="state err"; stEl.textContent="⚠ "+d.error; return; }
  $("#genSubject").textContent = d.subject;
  $("#genSaveName").value = (usePh?"generated_":"ai_"+slug(lead["Company Name"]||"lead"))+"_"
      + $("#genVariant").value + "_" + $("#genStyle").value + ".html";
  $("#genPreview").srcdoc = `<html><body style="font-family:Arial,sans-serif;background:#fff;padding:26px;color:#222;font-size:14px">${d.html}</body></html>`;
  $("#genEdit").value = d.html;
  $("#genResult").style.display = "block";
  stEl.className = "state ok";
  stEl.innerHTML = `<span style="color:var(--grn)">✔ ${d.used_ai?"Generated with AI ("+($("#genStyle").value)+")":d.note}</span>`;
  activateGh = {html:d.html};
  setTimeout(()=>{ $("#genSaveName").focus(); },300);
}
function toggleGenEdit(){
  const show = $("#genEditBox").style.display === "none";
  $("#genEditBox").style.display = show ? "block" : "none";
  $("#genPreview").style.display = show ? "none" : "block";
  $("#btnGenEdit").textContent = show ? "👁️ Preview" : "✏️ Edit HTML";
  if(show) $("#genEdit").focus();
}
function genPreviewRefresh(){
  activateGh = {html: $("#genEdit").value};
  $("#genPreview").srcdoc = `<html><body style="font-family:Arial,sans-serif;background:#fff;padding:26px;color:#222;font-size:14px">${$("#genEdit").value}</body></html>`;
}
let activateGh = null;
function slug(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,40) || "lead"; }
async function saveGenerated(mode){
  const name = ($("#genSaveName").value||"").trim();
  if(!name || !activateGh){ alert("Generate first, then enter a file name."); return; }
  const edited = $("#genEdit").value;
  activateGh.html = edited && edited.trim() ? edited : activateGh.html;
  const r = await fetch("/api/template/save",{method:"POST", cache:"no-store",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({name, html:activateGh.html, activate:mode})});
  const d = await r.json();
  if(d.ok){ loadTemplates(); previewTemplate(d.file);
    $("#genStatus").className="state ok";
    $("#genStatus").innerHTML = `<span style="color:var(--grn)">✔ Saved as ${esc(d.file)}</span>` +
      (mode!=="none"?` — now active as ${mode==="first"?"first-contact":"follow-up"} template.`:"");
  } else { $("#genStatus").className="state err"; $("#genStatus").textContent="⚠ "+d.error; }
}

/* ── actions ── */
async function loadActions(){
  const st = await get("/api/campaign/status?mode=leads");
  const run = st.running;
  $("#btnCmpStart").disabled = run;
  $("#btnCmpStop").disabled = !run;
  $("#cmpState2").className = "state " + (run?"run":"ok");
  $("#cmpState2").innerHTML = run
    ? `<span class="status-dot" style="background:var(--grn)"></span> Running — started ${esc(st.started)}`
    : `<span class="status-dot"></span> Not running (${st.exit_code!==null?`last exit ${st.exit_code}`:"ready"})`;
  const stf = await get("/api/campaign/status?mode=full");
  const runf = stf.running;
  $("#btnFullStart").disabled = runf;
  $("#btnFullStop").disabled = !runf;
  $("#fullState2").className = "state " + (runf?"run":"ok");
  $("#fullState2").innerHTML = runf
    ? `<span class="status-dot" style="background:var(--grn)"></span> Running — started ${esc(stf.started)}`
    : `<span class="status-dot"></span> Not running (${stf.exit_code!==null?`last exit ${stf.exit_code}`:"ready"})`;
  const anyRun = run || runf;
  $("#dotCmp").style.background = anyRun ? "var(--grn)" : "#64748b";
  $("#cmpState").textContent = anyRun ? "Campaign running" : "Campaign stopped";
  const s = await get("/api/sync/status");
  syncButtons(s);
  loadLogTail();
  loadJobs();
}
async function loadJobs(){
  const jobs = await get("/api/jobs");
  $("#jobTable tbody").innerHTML = jobs.map(j=>`<tr>
    <td>${esc(j.started)}</td><td>${esc(j.name)}</td>
    <td>${j.done ? (j.ok ? `<span style="color:var(--grn)">✔ done</span>` : `<span style="color:var(--red)">✖ error</span>`)
                : `<span class="state run">running…</span>`}</td></tr>`).join("") || "";
}
async function loadLogTail(){
  const which = currentLog(); 
  const d = await get(`/api/log?which=${which}&tail=1500`);
  const box = $("#logbox");
  const isBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.textContent = d.lines.join("\n") || "(log is empty)";
  if(isBottom) box.scrollTop = box.scrollHeight;
}
function currentLog(){ return $("#btnClrLog").dataset.which || "campaign"; }
async function startCampaign(mode){
  const stEl = mode==="full" ? $("#fullState2") : $("#cmpState2");
  stEl.className="state run"; stEl.innerHTML=`<span class="spin"></span> starting…`;
  const r = await fetch("/api/campaign/start",{method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({mode}), cache:"no-store"});
  const d = await r.json();
  if(!d.ok){ stEl.className="state err"; stEl.textContent = "⚠ "+(d.error||"failed"); return; }
  setTimeout(loadActions, 1500);
}
async function stopCampaign(mode){
  const stEl = mode==="full" ? $("#fullState2") : $("#cmpState2");
  const r = await fetch("/api/campaign/stop",{method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({mode}), cache:"no-store"});
  const d = await r.json();
  stEl.className = "state err";
  stEl.textContent = d.ok
    ? (mode==="full" ? "■ Campaign stopped permanently." : "■ Email lead sending stopped. Click Continue to resume from where it stopped.")
    : "⚠ "+(d.error||"");
  setTimeout(loadActions, 1000);
}
function stateElFor(name){
  const ids = {"check-replies":"st-replies", "reminders":"st-reminders", "report":"st-report", "sync-tracking":"st-sync-tracking"};
  return $("#"+ids[name]);
}
async function runAction(name){
  const stEl = stateElFor(name);
  stEl.className="state run"; stEl.innerHTML=`<span class="spin"></span> running…`;
  const r = await fetch("/api/action/"+name,{method:"POST", cache:"no-store"});
  const d = await r.json();
  if(!d.ok){ stEl.className="state err"; stEl.textContent="⚠ "+(d.error||""); return; }
  pollJob(name, d.job_id);
}
async function pollJob(name, id){
  const stEl = stateElFor(name);
  const r = await get("/api/jobs/"+id);
  if(!r.done){ setTimeout(()=>pollJob(name,id), 1500); return; }
  stEl.className = "state "+(r.ok ? "ok" : "err");
  stEl.textContent = r.ok ? ("✔ " + r.ok) : ("⚠ " + (r.error||"failed"));
  loadActions();
}
function setLog(w){
  $("#btnClrLog").dataset.which = w;
  ["campaign","sync","activity"].forEach(k=>{
    $("#btnLog"+k.charAt(0).toUpperCase()+k.slice(1)).className = "btn sm "+(k===w?"":"ghost");
  });
  loadLogTail();
}
async function clearLog(){
  const cur = currentLog();
  const nx = cur==="campaign" ? "activity" : "campaign";
  setLog(nx);
}
async function syncButtons(d){
  const run = !!(d && d.running);
  $("#btnSyncStart").disabled = run;
  $("#btnSyncStop").disabled = !run;
  $("#btnSyncStart").textContent = run ? "⏳ Running…" : "▶ Run continuously";
}
async function startSync(){
  $("#btnSyncStart").disabled = true;
  const r = await fetch("/api/sync/start",{method:"POST", cache:"no-store"});
  const d = await r.json();
  if(!d.ok){ $("#btnSyncStart").disabled = false; alert("⚠ "+(d.error||"failed")); return; }
  setLog("sync"); showToast("Tracking sync started — it polls the server every 60 s.");
  loadActions();
}
async function stopSync(){
  $("#btnSyncStop").disabled = true;
  const d = await fetch("/api/sync/stop",{method:"POST", cache:"no-store"}).then(r=>r.json());
  if(!d.ok){ $("#btnSyncStop").disabled = false; alert("⚠ "+(d.error||"failed")); return; }
  showToast("Tracking sync stopped.");
  loadActions();
}

/* ── settings ── */
async function loadConfig(){
  const d = await get("/api/config");
  const groups = {};
  d.fields.forEach(f=>{ (groups[f[1]] = groups[f[1]]||[]).push(f); });
  let gridHtml = Object.entries(groups).map(([g, fields])=>`
    <div class="set-grp"><h3>${esc(g)}</h3>
      ${fields.map(f=>{
        const v = d.values[f[0]];
        const disp = f[2]==="bool" ? (v?"true":"false") : (v??"");
        const input = f[2]==="bool"
          ? `<input type="text" id="cfg-${f[0]}" value="${esc(disp)}" placeholder="true / false">`
          : `<input type="text" id="cfg-${f[0]}" value="${esc(disp)}" spellcheck="false">`;
        return `<div class="f"><label><code>${f[0]}</code></label>${input}</div>`;
      }).join("")}
    </div>`).join("");

  const ai = await get("/api/ai");
  gridHtml += `<div class="set-grp"><h3>🤖 AI generator (optional)</h3>
    <div class="mini" style="margin-bottom:10px">Used by the Templates → AI generator.
      Any OpenAI-compatible endpoint works. Leave blank to use the built-in engine (no internet needed).</div>
    <div class="f"><label><code>AI_API_KEY</code></label>
      <input type="password" id="ai-api_key" value="${esc(ai.api_key)}" placeholder="sk-…" spellcheck="false"></div>
    <div class="f"><label><code>AI_MODEL</code></label>
      <input type="text" id="ai-model" value="${esc(ai.model)}" placeholder="gpt-4o-mini"></div>
    <div class="f"><label><code>AI_BASE_URL</code></label>
      <input type="text" id="ai-base_url" value="${esc(ai.base_url)}" spellcheck="false"></div>
  </div>`;
  $("#setGrid").innerHTML = gridHtml;
  setTimeout(()=>{ $("#cfgMsg").textContent=""; },400);
}
async function saveConfig(){
  const d = await get("/api/config");
  const payload = {};
  d.fields.forEach(f=>{ payload[f[0]] = $("#cfg-"+f[0]).value; });
  const ai = { api_key:$("#ai-api_key").value, model:$("#ai-model").value, base_url:$("#ai-base_url").value };
  $("#cfgMsg").innerHTML = `<span class="spin"></span> saving…`;
  const r = await fetch("/api/config",{method:"POST", cache:"no-store",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)});
  const res = await r.json();
  const r2 = await fetch("/api/ai",{method:"POST", cache:"no-store",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify(ai)});
  await r2.json();
  $("#cfgMsg").innerHTML = res.ok
    ? `<span class="saved">✔ saved: ${(res.changed||[]).join(", ")}</span>`
    : `<span class="err">⚠ ${esc(res.error||"failed")}</span>`;
  if(res.ok){ loadConfig(); }
}

/* ── polling ── */
async function refreshAll(all){
  loadSummary();
  await get("/api/campaign/status");
  loadActions();
  if(all || document.querySelector("#sec-leads").classList.contains("on")) leadRefresh();
  if(all || document.querySelector("#sec-emaillist").classList.contains("on")) loadEmailList();
  if(all || document.querySelector("#sec-events").classList.contains("on")) loadEvents();
  if(all || document.querySelector("#sec-actions").classList.contains("on")) loadActions();
  if(all) loadTemplates();
  if(all) loadConfig();
  if(all) loadLogTail();
}
setInterval(()=>refreshAll(false), 5000);
setInterval(()=>{ if(document.querySelector("#sec-actions").classList.contains("on")) loadLogTail(); }, 3000);

/* ── boot ── */
refreshAll();
loadActions();
</script>
</body>
</html>"""


# ============================================================================
# DAILY DIGEST — 9 AM summary email (opens / replies / visits of yesterday)
# ============================================================================
DIGEST_STATE_FILE = LOGS_DIR / "digest_sent.json"


def _digest_last_date():
    try:
        return json.loads(DIGEST_STATE_FILE.read_text(encoding="utf-8")).get("last", "")
    except Exception:
        return ""


def _digest_mark(date_str):
    try:
        DIGEST_STATE_FILE.write_text(json.dumps({"last": date_str}), encoding="utf-8")
    except Exception:
        pass


def _send_digest_email():
    """Sends the daily summary email (once per day, at DIGEST_HOUR) to
    DIGEST_EMAIL (falls back to SENDER_EMAIL)."""
    cfg = get_config()
    to = (getattr(cfg, "DIGEST_EMAIL", "") or getattr(cfg, "SENDER_EMAIL", "") or "").strip()
    if not to:
        return
    try:
        hour = int(getattr(cfg, "DIGEST_HOUR", 9) or 9)
    except Exception:
        hour = 9
    now = datetime.now()
    if now.hour != hour or now.minute > 5:
        return
    today = now.strftime("%Y-%m-%d")
    if _digest_last_date() == today:
        return
    log_line("Sending daily digest email")

    headers, rows = read_master_rows()
    events = load_events_json()
    totals = {"sent": 0, "opened": 0, "clicked": 0, "replied": 0,
              "bounced": 0, "visits": 0, "reminders": 0}
    for r in rows:
        s = str(r.get("Email Send Status", "")).strip()
        if s == "Sent":
            totals["sent"] += 1
        elif s == "Bounced":
            totals["bounced"] += 1
        if str(r.get("Email Open Status", "")).strip() == "Opened":
            totals["opened"] += 1
        if str(r.get("Link Clicked", "")).strip() == "Yes":
            totals["clicked"] += 1
        if str(r.get("Reply Received", "")).strip() == "Yes":
            totals["replied"] += 1
        if str(r.get("Reminder Sent", "")).strip() == "Yes":
            totals["reminders"] += 1
        try:
            totals["visits"] += int(r.get("Website Visits") or 0)
        except (TypeError, ValueError):
            pass

    yday = now - timedelta(days=1)
    ev_yday = [e for e in events
               if (_dt(e.get("timestamp")) or datetime.min).date() == yday.date()]
    ev_counts = {"opens": 0, "clicks": 0, "visits": 0}
    for e in ev_yday:
        if e.get("event") == "email_opened":
            ev_counts["opens"] += 1
        elif e.get("event") == "link_clicked":
            ev_counts["clicks"] += 1
        elif e.get("event") == "website_visit":
            ev_counts["visits"] += 1
    hot = sorted([e for e in ev_yday if e.get("event") in ("link_clicked", "website_visit")],
                 key=lambda e: _dt(e.get("timestamp")) or datetime.min, reverse=True)[:6]

    sent_base = totals["sent"] or 1
    ydate = yday.strftime("%d-%m-%Y")
    lines = [
        ("Total emails sent", str(totals["sent"])),
        ("Opened (all time)", f"{totals['opened']} ({round(100*totals['opened']/sent_base,1)}%)"),
        ("Clicked", f"{totals['clicked']} ({round(100*totals['clicked']/sent_base,1)}%)"),
        ("Replied", f"{totals['replied']} ({round(100*totals['replied']/sent_base,1)}%)"),
        ("Bounced", f"{totals['bounced']} ({round(100*totals['bounced']/sent_base,1)}%)"),
        ("Website visits", str(totals["visits"])),
        ("Reminders sent", str(totals["reminders"])),
        (f"Events on {ydate}", f"{ev_counts['opens']} opens · {ev_counts['clicks']} clicks · {ev_counts['visits']} visits"),
    ]
    rows_html = "".join(
        f"<tr><td style='padding:5px 12px;border-bottom:1px solid #e5e9f0;color:#0D5A9E'>{esc_html(k)}</td>"
        f"<td style='padding:5px 12px;border-bottom:1px solid #e5e9f0;text-align:right'><b>{esc_html(v)}</b></td></tr>"
        for k, v in lines)
    hot_html = "".join(
        f"<li style='margin:4px 0'>{'🔗' if e.get('event')=='link_clicked' else '🌐'} "
        f"<b>{esc_html(str(e.get('company') or '?'))}</b> "
        f"<span style='color:#888;font-size:12px'>{esc_html(str(e.get('email') or ''))} · {esc_html(str(e.get('timestamp') or ''))}</span></li>"
        for e in hot)

    subject = f"OrbitAvanya Daily Digest — {ydate}"
    plain = "ORBITAVANYA DAILY DIGEST\n" + "=" * 40 + "\n\n" + \
        "\n".join(f"{k}: {v}" for k, v in lines) + \
        "\n\nRecent activity:\n" + ("\n".join(f"  - {e.get('company')} ({e.get('event')})" for e in hot) if hot else "  - none") + \
        "\n\nBest regards,\nOrbitAvanya Email Automation"
    html = (
        "<html><body style='font-family:Arial,sans-serif;color:#222;font-size:13px'>"
        f"<h2 style='color:#0D5A9E;margin-bottom:4px'>OrbitAvanya Daily Digest</h2>"
        f"<div style='color:#888;font-size:12px;margin-bottom:16px'>Campaign summary — {ydate}</div>"
        f"<table style='border-collapse:collapse;min-width:320px'>{rows_html}</table>"
        f"<h4 style='margin:16px 0 6px'>Recent activity</h4>"
        f"<ul style='margin:0;padding-left:18px'>{hot_html or '<li>none</li>'}</ul>"
        f"<p style='color:#888;font-size:11px;margin-top:20px'>Sent automatically by your campaign dashboard.</p>"
        "</body></html>"
    )

    try:
        import smtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart
        msg = MIMEMultipart("alternative")
        msg["From"] = f"OrbitAvanya Dashboard <{to}>"
        msg["To"] = to
        msg["Subject"] = subject
        msg.attach(MIMEText(plain, "plain"))
        msg.attach(MIMEText(html, "html"))
        with smtplib.SMTP_SSL(cfg.SMTP_SERVER, int(cfg.SMTP_PORT), timeout=60) as server:
            server.login(cfg.SENDER_EMAIL, cfg.SENDER_PASSWORD)
            server.sendmail(cfg.SENDER_EMAIL, to, msg.as_string())
        _digest_mark(today)
        log_line("Daily digest sent")
    except Exception as e:
        log_line(f"Daily digest FAILED: {e}")


def _digest_loop():
    while True:
        try:
            _send_digest_email()
        except Exception:
            pass
        time.sleep(60)


def esc_html(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ============================================================================
# ENTRY POINT
# ============================================================================
if __name__ == "__main__":
    print("=" * 58)
    print("  ORBITAVANYA EMAIL AUTOMATION — DASHBOARD")
    print(f"  Open:  http://localhost:{DASHBOARD_PORT}")
    print(f"  Data:  {DATA}")
    print("  Press Ctrl+C to stop. (Closing does NOT stop the campaign.)")
    print("=" * 58)

    # Auto-start the tracking sync loop (30 s interval) so the dashboard
    # always shows fresh opens/clicks/visits without any manual step.
    SYNC_STATE["running"] = True
    SYNC_STATE["started"] = datetime.now().strftime("%d-%m-%Y %H:%M:%S")
    threading.Thread(target=_sync_loop, daemon=True).start()
    _log_sync("▶ Auto-sync started with the dashboard (every 30 s)")
    log_line("Tracking auto-sync started with dashboard")

    # Daily digest: sends a 9 AM summary email (DIGEST_HOUR / DIGEST_EMAIL
    # in Settings). Starts now, checks the clock every minute.
    threading.Thread(target=_digest_loop, daemon=True).start()

    threading.Timer(1.2, lambda: webbrowser.open(f"http://localhost:{DASHBOARD_PORT}")).start()

    import logging as lg
    lg.getLogger("werkzeug").setLevel(lg.ERROR)

    app.run(host="127.0.0.1", port=DASHBOARD_PORT, debug=False, use_reloader=False)