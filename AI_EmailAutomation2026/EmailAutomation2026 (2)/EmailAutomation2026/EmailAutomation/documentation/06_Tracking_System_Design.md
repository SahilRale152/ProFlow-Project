# 06 — Tracking System Design

This is the deepest dive into *how* the system knows when someone opens, clicks, or visits — and what happens at every step.

---

## 1. What gets injected into each email

When `send_email()` runs, three things are added to the HTML body:

### 1.1 The tracking pixel

```html
<img src="https://orbitavanytech.com/track.php?action=track&email=<encoded>&company=<encoded>"
     width="1" height="1" border="0" style="display:block;width:1px;height:1px;" alt="" />
```

- 1×1 transparent GIF (base64 decoded at runtime).
- Loaded by the recipient's mail client when they open the email (HTML images enabled).
- The PHP backend records an `open` event **with the recipient's real IP**.
- `Cache-Control: no-store, no-cache` headers stop clients/proxies from caching the pixel, so every open is a fresh request.
- Guarded against Google-proxy crawler IPs so Google's "safe browsing" scanners don't fake an open.

### 1.2 The "view in browser" location beacon

```html
<a href="...?action=locate&email=...&company=...">View this email in your browser</a>
```

- Nearly invisible (9px, light gray) at the bottom of the email.
- When clicked, `/locate` captures real IP + geolocation, then redirects to `https://orbitavanytech.com`.
- Purpose: get a clean, user-initiated location signal (browser hits are much more reliable than client-side image loads).

### 1.3 Click-wrapped links

```html
<a href="https://orbitavanytech.com/track.php?action=click&email=...&company=...&dest=https%3A%2F%2Forbitavanytech.com">orbitavanytech.com</a>
```

- Only `orbitavanytech.com` links are rewritten (`wrap_links_with_tracking()` regex).
- `action=click` records the click + geolocation, then 302-redirects to the `/visit` landing page.

---

## 2. The full click funnel (most valuable signal)

```
Recipient clicks "orbitavanytech.com" link in email
        │
        ▼
track.php?action=click&email=...&dest=...
        │  saves {type:"click", country, city, timezone, dest, ip}
        ▼
302 → track.php?action=visit&email=...&company=...&dest=...
        │  saves {type:"visit_start", page}
        │  serves a branded "OrbitAvanya Tech LLP — Taking you to our website..." page
        │  with JavaScript:
        │     · records startTime
        │     · on beforeunload/pagehide → sendBeacon(visit-end?seconds=N)
        │     · after 1.5s → window.location.href = dest (plus lead_email/lead_company/lead_page query params)
        ▼
Real portfolio page (portfolio.orbitavanyatech.com)
        │  IF the portfolio_tracking_snippet.html is embedded:
        │     · reads lead_email/lead_company/lead_page
        │     · heartbeat every 10 s → /visit-heartbeat?seconds=delta
        │     · final beacon on leave → /visit-end?seconds=delta
        ▼
sync_tracking_events.py → Excel columns:
        Link Clicked=Yes, Link Clicked At, Link Click Count,
        Opened From Country/City/Timezone, Website Visits, Total Time on Website, Last Visit At
```

**Why the /visit middle-page exists:** so the time-on-site measurement can start before the top-level redirect hands off to a third-party page (where our JS would lose access). The portfolio snippet extends the measurement into the real page.

## 3. Event types & what they update

| Event type | Trigger | Excel updates |
|------------|---------|---------------|
| `open` | pixel loaded | `Email Open Status=Opened` (green), `Email Opened At` (first only), `Email Open Count+1` |
| `click` | click-wrapped link clicked | `Link Clicked=Yes` (red), `Link Clicked At`, `Link Click Count+1`, also marks opened, plus `Opened From Country/City/Timezone` |
| `visit_start` | /visit page loaded | `Website Visits+1`, `Last Visit At` |
| `visit_end` | sendBeacon on leave | `Total Time on Website` accumulated (`X min Y sec` format) |
| `locate` | "view in browser" link | `Opened From Country/City/Timezone` |
| `auto_followup` | reminder sent in a language | `Auto Follow-up Sent`, `Follow-up Language` |

## 4. Who processes events — three writers, one Excel

1. **Flask app inside `RUN_CAMPAIGN.py`** — writes directly to Excel with a `threading.Lock` (used when the tracking URL is local).
2. **`email_tracker_server.py`** — the original standalone writer (port 5050, `open` events only).
3. **`sync_tracking_events.py`** — polls the PHP backend's `/events` and applies them (deduplicated by event ID `type_email_timestamp`).

**Locking:** all writers use per-process locks; `openpyxl` reloads the workbook each time so cross-process conflicts are avoided by design (Excel file access is exclusive per write, not per process).

## 5. Geolocation chain (quality first)

Used for both tracking location and choosing the language:

```
Real IP (click / visit / locate)
   │  Cloudflare-Connecting-IP → X-Forwarded-For → remote_addr
   ▼
get_location_from_ip(ip)
   │  ip-api.com (free, 5 s timeout) → fields: status,country,city,timezone,regionName,isp
   │  on failure → ipinfo.io fallback
   ▼
{country, city, region, timezone, isp}
```

- Private/reserved IPs (`127.x`, `192.168.x`, `10.x`, `172.16.x`) are skipped.
- Google crawler ranges are filtered so Google proxies don't corrupt open/click stats.
- Generic webmail domains (`gmail.com`, `yahoo.com`, …) are **not** geolocated from the domain — the provider's datacenter is not the lead's real location.

## 6. Inbox-side detection (IMAP)

`check_replies()` connects via `IMAP4_SSL` and scans a rolling **30-day window**:

1. Fetch `FROM / SUBJECT / DATE` headers.
2. **Bounce check first** — if the sender looks like `mailer-daemon`/`postmaster`/`mail delivery system`, or the subject matches delivery-failure keywords, parse the body for the original recipient address and mark that row `Bounced` (red) — bounces are **never** treated as replies.
3. **Reply check** — if the sender matches a tracked email, set `Reply Received=Yes` (green), `Reply Date`, `Reply Subject`. One reply per lead (repeat messages skipped).
4. Refresh the `Success`/`Bounced` sheets and the `Sent_Bounced_Report.xlsx`.

## 7. Reminder trigger logic

`send_due_reminders()` iterates the master sheet and selects rows where:

- `Email Send Status == "Sent"` AND
- `Reply Received != "Yes"` AND
- `Reminder Sent != "Yes"` AND
- `Reminder Due <= today` (default: send date + 2 days) AND
- row not bounced

It then sends `Followup_template.html` and sets `Reminder Sent=Yes`. The reminder's language uses the **real detected location** if the lead ever clicked (most trustworthy) → else domain-based detection → else default language.

## 8. `/events` API (PHP + Flask) — the sync bridge

- PHP `/events?key=orbitavanya2026` returns the entire `tracking_log.json` as JSON.
- Flask `/events?key=...` returns the in-memory event log.
- `sync_tracking_events.py` polls, dedupes by `type_email_timestamp`, and writes to Excel.
- The shared key must be identical in `RUN_CAMPAIGN.py`, `sync_tracking_events.py`, and `track.php`.

## 9. Why no paid services?

Everything runs on free tiers: `ip-api.com` (unlimited, no key), `ipinfo.io` (free fallback), `cloudflared` (free quick tunnels), PHP on existing cPanel hosting, and a fully open-source Python stack. This was a deliberate project goal — zero subscription cost.