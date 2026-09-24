# 12 — Troubleshooting & FAQ

Common errors you'll hit while running the project, what they mean, and how to fix them.

---

## Connection & credentials

| Symptom | Probable cause | Fix |
|---------|----------------|-----|
| `SMTPAuthenticationError` / `smtplib.SMTPConnectError` | Wrong password or server/port | Verify in `Config` — SMTP `s13429.bom1.stableserver.net:465` |
| `imaplib.error: login failed` | Wrong IMAP creds | Confirm IMAP login via your mailbox; IMAP port `993` |
| `Connection timed out` on port 25 | Host blocks SMTP probing / port | Not fatal — `unknown` → still send; or set `VALIDATE_EMAILS=False` for a trial |
| `TimeoutError` / `SMTPServerDisconnected` mid-campaign | Mail server drip-cap | The script auto-reconnects and retries once; consider raising `EMAIL_DELAY` |

## File / Excel issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `⚠️ COULD NOT SAVE! Close ... in Excel first!` | Workbook open in Excel (Windows lock) | Close it; records stay queued and are retried on next flush |
| `❌ Could not read Excel: ...` | Wrong `EXCEL_FILE_PATH` or missing sheet | Correct path; confirm `SHEET_NAME` (`Sheet1`) |
| Tracker shows `PermissionError` | same file lock | as above (or the file is read-only) |
| New columns missing | Created on demand | Safe — they appear the first time a feature triggers them |

## Tracking problems

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No tracking URL" at start | `TRACKING_SCRIPT_URL` empty/unreachable | Set it to `https://orbitavanytech.com/track.php` (or use the local tunnel) |
| Opens not recorded | Pixel blocked (images off) or tracking URL not live | Verify `?action=status` responds; recipient must load images; keep the terminal running |
| `sync_tracking_events.py` sees nothing | `key` mismatch | Match `orbitavanya2026` in PHP, `RUN_CAMPAIGN.py`, and the sync script |
| `Cannot reach track.orbitavanytech.com` | Domain wrong for `TRACKING_URL` | Use `orbitavanytech.com/track.php` (production) |
| Google "opens" inflate stats | Gmail previews images | By design — `GOOGLE_IP_RANGES` filter mitigates, not eliminates |

## Language

| Symptom | Cause | Fix |
|---------|-------|-----|
| Everything sent in English | Country/City not filled in the sheet, or a webmail domain that can't be auto-detected | Fill `Country`/`City`; domain-detection only works for company domains |
| Error `Translation failed` | Google rate-limit or no internet | Falls back to original text automatically; email still sends |
| Brand name mangled | Translation outside protected terms for unusual names | Add the term to `BRAND_PROTECTED_TERMS` (or `extra_terms`) |

## Replies / reminders

| Symptom | Cause | Fix |
|---------|-------|-----|
| No reminders sent | No rows due (2-day grace), or all replied so far | Check `Reminder Due` column values; timeline |
| Reminder to someone who replied | `check_replies()` hasn't run recently | Run `check_replies_and_reminders.py` continuously |
| `⚠️ Tracker missing required columns` | Fresh tracker without Reminder columns | Send at least one campaign first |

## Duplicate protection

| Symptom | Cause | Fix |
|---------|-------|-----|
| Everyone "already sent" | `sent_emails_log.json` has them | Delete the file (or set `SKIP_ALREADY_SENT=False`) only when you intend a re-send |

## Tunnels & local dev

| Symptom | Cause | Fix |
|---------|-------|-----|
| `cloudflared` download fails in the launcher | no network / blocked GitHub | Put `Tools/cloudflared.exe` into `Data/` manually |
| Tunnel URL changes every run | quick tunnel | Use `start_named_tunnel()` with once-tuned named tunnel config |
| `ngrok` asks for an account token | ngrok limits the free tier | Prefer cloudflared (no account) or the production PHP endpoint |

---

## Most-common "do the simple thing" tips

1. **Always keep the campaign terminal open** while tracking (the idle loop watches replies/reminders and serves the local pixel if used).
2. **Never leave `Email_Tracking_NEW.xlsx` open in Excel** while scripts run.
3. **Edit paths once** in `RUN_CAMPAIGN.py` and copy the same values into `check_replies_and_reminders.py`.
4. **Test first** with `Testing/50_Leads_With_Real_CEO_Names.xlsx`.
5. **Check `/status`** after PHP upload to confirm the backend is live.