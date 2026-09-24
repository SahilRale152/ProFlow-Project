# 10 — Multilingual System

How the project personalizes emails in the **recipient's own language** across more than 30 languages — for free.

---

## 1. The goal

A German lead gets a German-capable email, a lead from Pune (India) gets a Marathi-capable one, a lead from Chennai gets Tamil — not by guessing, but by **data-driven language selection** (country/city from the lead sheet, or auto-detected from the email domain or IP).

## 2. Language selection chain

For each lead, `get_language_for_location(country, city, region)` picks the language using this order:

```
If country == India:
    city in INDIA_CITY_LANGUAGE ?   → e.g. Pune → "mr" (Marathi)
    else region in INDIA_STATE_LANGUAGE ? → state-based → Marathi/Hindi/Tamil etc.
    else → "hi" (Hindi)
Else if country given
    → COUNTRY_LANGUAGE[country]  (e.g. Germany→"de")
Else (no location at all)
    → sender's own detected language (default English)
```

### Country → language table (`COUNTRY_LANGUAGE`)

| Country | Lang |
|---------|------|
| Germany, Austria | de |
| France | fr |
| Spain, Mexico, Argentina | es |
| Italy | it |
| Portugal, Brazil | pt |
| Netherlands | nl |
| Russia | ru |
| China | zh-CN |
| Japan | ja |
| South Korea | ko |
| Saudi Arabia, UAE | ar |
| Turkey | tr |
| Poland | pl |
| Sweden, Norway, Denmark, Finland | sv / no / da / fi |
| Czech Republic / Romania / Hungary / Indonesia / Thailand / Vietnam / Israel | cs / ro / hu / id / th / vi / he |
| USA, UK, Australia, Canada, Singapore, India | en |

### India regional map — by city (`INDIA_CITY_LANGUAGE`)

| City(s) | Lang |
|---------|------|
| Pune, Mumbai, Nagpur, Nashik, Thane, Aurangabad, Kolhapur | mr (Marathi) |
| Delhi, New Delhi, Jaipur, Lucknow, Kanpur, Bhopal, Indore, Patna, Gurgaon, Noida, Agra | hi (Hindi) |
| Chennai, Coimbatore, Madurai, Trichy | ta (Tamil) |
| Hyderabad, Vijayawada, Visakhapatnam, Warangal | te (Telugu) |
| Bengaluru, Mysuru, Hubli | kn (Kannada) |
| Kochi, Cochin, Thiruvananthapuram, Kozhikode, Kottayam | ml (Malayalam) |
| Ahmedabad, Surat, Vadodara, Rajkot | gu (Gujarati) |
| Chandigarh, Ludhiana, Amritsar, Jalandhar | pa (Punjabi) |
| Kolkata, Howrah, Durgapur | bn (Bengali) |

### India state fallback (`INDIA_STATE_LANGUAGE`)

`Maharashtra→mr, Delhi/UP/MP/Bihar/Rajasthan/Haryana→hi, Tamil Nadu→ta, Andhra/Telangana→te, Karnataka→kn, Kerala→ml, Gujarat→gu, Punjab→pa, West Bengal→bn`.

### Where do country / city come from?

1. Directly from the lead sheet (`Country`, `City` columns).
2. **Auto-detected** from the **company-email domain** (`someone@company.de` → resolve domain IP → geolocate) when the sheet has no country/city. Skipped for webmail domains.
3. **Sender's own location** as the final default; India-city from the sender fills missing city for Indian leads.

### Language recorded
Each sent email stores the human-readable language name in the `Email Sent In Language` column (e.g. `Marathi`, `German`, `English`).

---

## 3. Two translation modes

### Mode A — Full translation (older behavior)
- `translate_html_body()` walks every text node in the HTML (using BeautifulSoup) and machine-translates it into the target language, while **preserving all HTML structure, links, styles, and skipped script/style tags**.
- Proper nouns (brand name, CEO name, company URL, contact line, email address, phone) are **protected**: replaced with short placeholder tokens before translation and restored afterward (`_protect_terms` / `_restore_terms`). `BRAND_PROTECTED_TERMS` lists the fixed brand vocabulary + per-send terms.
- Both the plain-text part of the email and (in standalone reminder script) the **subject** get translated.
- Engine: `deep-translator` (GoogleTranslator) with a `en → target` call; on any failure the original text is preserved.

### Mode B — "View in your language" button (default in the launcher)
- Keep the email **always in English** (reliable wording), but if the lead's location maps to a language, inject a subtle banner near the top:

  > `🌐 View this email in हिंदी` (or German / Spanish / …)

  Tapping it opens Google Translate on the whole email text. The plain-text part adds a friendly sentence pointing at the "🌐" button.

  This is the mode used by `RUN_CAMPAIGN.py`'s `send_email()`.

> Both modes exist in code; the launcher currently prefers the button (`build_translate_banner()`), while `check_replies_and_reminders.py` still has full translation via `translate_html_body()`.

## 4. Translated view for website visitors

When a recipient lands on the `/visit` page, their IP is geolocated; if the country maps to a non-English language, the page shows a real "View in [Language]" Google-Translate link (respecting their own browser instead of assuming).

## 5. What is NEVER translated

- Brand/proper nouns (see list).
- HTML tags, attributes, links, styles.
- Scripts (JS for tracking).
- Empty/whitespace text nodes.
- Comments.

## 6. Edge cases

- **Google-Translate rate limits:** translated text uses a 1800-char slice for the banner URL to keep it within browser URL limits.
- **Translation failure fallback:** original text stays, and the email is still sent.
- **Unknown language mapping** → `en`.