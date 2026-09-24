# 11 — Email Validation and Sender-Safety

This project was designed with **no paid validation API** and with **sender-reputation safety** as a first-class concern. Here's how.

---

## 1. The 4-layer email validation (before any send)

Every lead email is checked in order (`validate_email()`), and the **first "fake" verdict wins**; anything `unknown` is still sent.

```
1) SYNTAX
   regex: ^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$
   → "fake" if the format isn't valid.

2) DISPOSABLE / TEMP-MAIL DOMAINS
   32 known domains (mailinator, 10minutemail, guerrillamail,
   yopmail, maildrop, getnada, trashmail, ...) → "fake".

3) MX RECORD (dnspython)
   Query the domain's MX records; none → "fake" (no mail server).

4) SMTP MAILBOX PROBE (the smartest step)
   • Resolve the domain's MX host.
   • Open an SMTP connection (port 25, timeout ~6s).
   • EHLO (fallback HELO)
   • MAIL FROM: <sender> (250) → RCPT TO: <candidate>
       250/251/252 → mailbox exists  ("real")
       550-554     → mailbox rejected ("fake" — retried 2× with 1.5 s pauses,
                     because greylisting/anti-probe servers sometimes reject
                     once then accept if the box really exists)
       any other / error → "unknown" (send anyway)
```

**Outcome rules** (`validate_email`):

| Verdict | Meaning | Action |
|---------|---------|--------|
| `real` | box confirmed | send |
| `fake` | confirmed rejected | **skip**, store in `Fake CEO Email` sheet with reason |
| `unknown` | server refused to answer | **send anyway** (maximizes reach; the follow-up bot and bounce checker guard the rest) |

> No message content is ever transmitted during the probe — just `MAIL FROM` and `RCPT TO` commands. This is why it costs nothing and hits 0 paid APIs.

## 2. Where fake results go

- `save_fake_email_record()` queues the record.
- `flush_saved_records()` writes it into the **`Fake CEO Email`** sheet with **all** extra fields of the lead row (region, company URL, phone, CEO status, notes, etc.), the `Validation Reason`, and a `Validated At` timestamp.
- Re-found bug entry updates the existing same-mail row (no duplication).

## 3. Duplicate protection

- `DuplicateTracker` stores every successfully sent address in `sent_emails_log.json` (a JSON array/S из set).
- On every run, `SKIP_ALREADY_SENT=True` skips those — no accidental double-emailers, even across repeated runs.
- Set `SKIP_ALREADY_SENT=False` to deliberately allow re-emailing (testing only).

## 4. Sender-reputation guardrails

Because cold-email at scale can hurt deliverability, the system has multiple knobs:

| Feature | Setting | Effect |
|---------|---------|--------|
| Per-send delay | `EMAIL_DELAY_MIN/MAX` (2 s by default) | Space between mailshots; raise to 20–40 s for gentler patterns |
| Batch cap | `MAX_EMAILS_PER_RUN` (100) | Only sends 100 per run — protects against bursts |
| AUTO-CONTINUE pause | `BATCH_INTERVAL_MINUTES` (10) | Sends 100, waits + hits reply/bounce/reminder checks, then continues |
| One click to pause | `AUTO_CONTINUE=False` | Stops after 100 and requires manual re-run |

## 5. Bounce handling (post-send)

- `check_replies()` runs on schedule; bounces are **detected before** replies.
- Identify bounce messages by:
  - **sender** keywords: `mailer-daemon`, `postmaster`, `mail delivery subsystem/system`, `mailerdaemon`
  - **subject** keywords: `undelivered`, `delivery status notification`, `returned mail`, `delivery failure`, `undeliverable`, `delivery has failed`
- The bounce body is extracted and the **original recipient address is matched** against tracked emails (skipping the sender's own address).
- The row's `Email Send Status` → `Bounced` (red) + `Send Error` stores the failure, then the row is copied to the **Bounced** sheet.
- Bounces are never counted as replies (explicitly `continue`).

## 6. What makes this "safe" overall

- No paid APIs (validation, geo, tunnels, translation all free).
- Verification is all pre-send, live — the recipient's own mail server confirms the mailbox.
- Fake emails are never emailed. Unknowns are emailed but guarded afterwards by bounces.
- A deliberate **manual stop** option exists (`AUTO_CONTINUE=False`).

## 7. Known limitations to note in the report

| Limitation | Context |
|-----------|---------|
| SMTP probing can be blocked/grey-listed by strict hosts | mitigation: 3 attempts, timeout 6 s, "unknown" falls through to send |
| `unknown` verdict still sends | necessary to preserve reach; bounce-checker then catches failures |
| For data lists (a CSV of scraped emails) some "verifiable but thrown-away" exist | the Fake sheet is the review backlog |
| Reputation of domain is outside scope of code | real-time actions, per-destination considerations are operational choices, not code |