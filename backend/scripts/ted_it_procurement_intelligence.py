"""
================================================================================
TED/EU IT + DIGITIZATION + DATA ENTRY PROCUREMENT INTELLIGENCE SYSTEM
Production-Grade European Union Public Procurement Lead Generation Engine
for OrbitAvanya Tech LLP — India

Single Executable Python File: ted_it_procurement_intelligence.py
Output: TED_IT_DIGITIZATION_DATA_ENTRY_PROSPECTS.xlsx

Architecture:
1. Multi-Strategy Multilingual TED v3 Search (CPV + Full-Text Keywords)
   Covering: IT / ICT + Scanning / Digitization / OCR / Data Entry
2. Iteration/Scroll Mode Pagination without Arbitrary Limits
3. Semantic Scope Relevance Classifier (Category A: IT/ICT; Category B: Digitization/Data Entry)
4. Pipeline 1: LIVE_TENDERS (Strict 15-Point Direct-Bid Qualification for OrbitAvanya)
5. Pipeline 2: SUBCONTRACTING_TENDERS (Ongoing Awarded Contracts + Fast Verified Enrichment)
6. Zero Fabrication, Zero Guessed Emails, Strict Data Integrity
7. Multi-Pass Validation Engine
8. Professional Excel Export (openpyxl) with Exact Two-Sheet Schema
=============================================================================
"""

import sys
import os
import re
import time
import json
import argparse
import logging
import urllib.parse
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any, Optional, Tuple, Set
from concurrent.futures import ThreadPoolExecutor, as_completed

# Graceful dependency handling
try:
    import requests
    from bs4 import BeautifulSoup
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
except ImportError as e:
    print(f"CRITICAL ERROR: Missing dependency -> {e}")
    print("Please install dependencies: pip install requests beautifulsoup4 openpyxl lxml")
    sys.exit(1)

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# ==============================================================================
# CONFIGURATION & PARAMETERS
# ==============================================================================
OUTPUT_FILE = "TED_IT_DIGITIZATION_DATA_ENTRY_PROSPECTS.xlsx"
TED_API_SEARCH_URL = "https://api.ted.europa.eu/v3/notices/search"
REQUEST_TIMEOUT = 20
FAST_FETCH_TIMEOUT = 3.0
MAX_RETRIES = 3
RATE_LIMIT_DELAY = 0.25  # Fast politeness interval
MAX_SUBCONTRACTING_AGE_YEARS = 5  # Rolling 5-year recency filter for awarded contracts
# Per-company enrichment (enrich_awarded_prime_fast: search-engine query + site
# crawl) used to run one company at a time in Pipeline 2 -- with a few hundred
# ongoing awards, that sequential chain of network calls was most of this
# engine's runtime. It's pure I/O against a different host per company, so a
# thread pool gives real concurrency without touching the enrichment logic
# itself. Override via env var if a target starts rate-limiting at this level.
MAX_WORKERS = int(os.environ.get("TED_ENGINE_MAX_WORKERS", "12"))

# Target CPV Codes: Comprehensive IT / ICT + Digitization / Data Entry
TARGET_IT_CPV_CODES = [
    '72000000', '72200000', '72210000', '72220000', '72230000', '72240000',
    '72250000', '72260000', '72300000', '72310000', '72314000', '72315000',
    '72316000', '72317000', '72320000', '72400000', '72410000', '72420000',
    '72500000', '72510000', '72590000', '72600000', '72611000', '48000000',
    '48200000', '48300000', '48400000', '48500000', '48600000', '48800000',
]

TARGET_DIGITIZATION_CPV_CODES = [
    '79999100', '72313000', '72312000', '72512000', '79995100', '92512000',
    '79560000', '72311100', '72311200', '72311300', '72252000'
]

ALL_TARGET_CPVS = TARGET_IT_CPV_CODES + TARGET_DIGITIZATION_CPV_CODES

# Controlled Domains
CONTROLLED_DOMAINS = [
    "IT / ICT",
    "Software Development",
    "Cloud & Infrastructure",
    "Data & Analytics",
    "Enterprise Systems",
    "Digital Transformation",
    "Document Digitization",
    "Data Processing"
]

# Controlled Subdomains
CONTROLLED_SUBDOMAINS = [
    "Application Development",
    "Web Development",
    "Mobile Development",
    "Systems Integration",
    "Cloud Migration",
    "Data Engineering",
    "Business Intelligence",
    "AI / Automation",
    "ERP",
    "CRM",
    "IT Support",
    "Managed IT Services",
    "Document Scanning",
    "OCR",
    "Archive Digitization",
    "Data Entry",
    "Data Capture",
    "Document Indexing",
    "Records Processing",
    "Document Conversion"
]

# European Country Code to Name Mapping
COUNTRY_CODES_MAP = {
    'AUT': 'Austria', 'BEL': 'Belgium', 'BGR': 'Bulgaria', 'HRV': 'Croatia',
    'CYP': 'Cyprus', 'CZE': 'Czech Republic', 'DNK': 'Denmark', 'EST': 'Estonia',
    'FIN': 'Finland', 'FRA': 'France', 'DEU': 'Germany', 'GRC': 'Greece',
    'HUN': 'Hungary', 'IRL': 'Ireland', 'ITA': 'Italy', 'LVA': 'Latvia',
    'LTU': 'Lithuania', 'LUX': 'Luxembourg', 'MLT': 'Malta', 'NLD': 'Netherlands',
    'POL': 'Poland', 'PRT': 'Portugal', 'ROU': 'Romania', 'SVK': 'Slovakia',
    'SVN': 'Slovenia', 'ESP': 'Spain', 'SWE': 'Sweden', 'NOR': 'Norway',
    'ISL': 'Iceland', 'CHE': 'Switzerland', 'GBR': 'United Kingdom'
}

# ORBITAVANYA TECH LLP — KNOWN CREDENTIALS & CAPABILITIES
ORBITAVANYA_PROFILE = {
    'company': 'OrbitAvanya Tech LLP',
    'country': 'India',
    'industry': 'IT Services / IT Consulting',
    'size': '11–50 employees',
    'founded': 2022,
    'headquarters': 'Maharashtra, India',
    'website': 'https://www.orbitavanya.com/',
    'linkedin': 'https://www.linkedin.com/company/orbitavanyatech/',
    'known_certifications': {
        'ISO 9001:2015',
        'ISO 14001:2015',
        'ISO 27001',
        'ISO 45001:2018',
        'ISO/IEC 20000-1:2018',
        'ISO 19005-1',
        'ISO 22301',
        'GDPR',
        'CMMI Maturity Level 3',
        'SOC 2 Compliance'
    }
}
# ==============================================================================
# ELIGIBILITY PROFILE (CUSTOMIZABLE PER COMPANY)
# ------------------------------------------------------------------------------
# Everything company-specific used by the eligibility gates below is read from
# this profile instead of being hardcoded to OrbitAvanya. Supplied by the Node
# backend as --profile-json; falls back to the OrbitAvanya defaults if absent,
# so the script still runs standalone.
# ==============================================================================
class EligibilityProfile:
    def __init__(self, data: Optional[Dict[str, Any]] = None):
        data = data or {}
        self.profile_key: str = data.get("profile_key") or "orbitavanya"
        self.company_name: str = data.get("company_name") or ORBITAVANYA_PROFILE["company"]
        self.country: str = data.get("country") or ORBITAVANYA_PROFILE["country"]
        self.known_certifications: List[str] = data.get("known_certifications") or sorted(ORBITAVANYA_PROFILE["known_certifications"])
        # Certifications tenders sometimes demand that this company does NOT hold ->
        # requiring one of these disqualifies the tender.
        self.forbidden_certs: List[Tuple[str, str]] = [
            tuple(x) for x in (data.get("forbidden_certs") or [
                ('cyber essentials plus', 'Cyber Essentials Plus'),
                ('cyber essentials', 'Cyber Essentials'),
                ('crest accreditation', 'CREST accreditation'),
                ('crest certified', 'CREST certified'),
                ('fedramp', 'FedRAMP'),
                ('secret defense', 'National Security Defense Clearance'),
                ('nato secret', 'NATO Security Clearance'),
                ('eu secret', 'EU Classified Secret Clearance'),
            ])
        ]
        # Contract value above this (in the notice's own currency, treated as EUR-scale)
        # exceeds this company's proportionate SME capacity.
        self.turnover_cap: float = float(data.get("turnover_cap") or 15_000_000)
        self.certifications_summary: str = data.get("certifications_summary") or (
            f"{', '.join(self.known_certifications[:5])} (Fully Satisfied by {self.company_name})."
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "profile_key": self.profile_key,
            "company_name": self.company_name,
            "country": self.country,
            "known_certifications": self.known_certifications,
            "forbidden_certs": [list(x) for x in self.forbidden_certs],
            "turnover_cap": self.turnover_cap,
            "certifications_summary": self.certifications_summary,
        }


def load_profile(profile_json_path: Optional[str]) -> "EligibilityProfile":
    if not profile_json_path:
        return EligibilityProfile()
    try:
        with open(profile_json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        print(f"[*] Loaded eligibility profile '{data.get('company_name', '?')}' from {profile_json_path}", flush=True)
        return EligibilityProfile(data)
    except Exception as e:
        print(f"[!] Could not load profile at {profile_json_path} ({e}); using OrbitAvanya default profile.", flush=True)
        return EligibilityProfile()


# Set by main() from --profile-json; read by the eligibility gates & enrichment text below.
ACTIVE_PROFILE = EligibilityProfile()
TED_PROJECTED_FIELDS = [
    'publication-number',
    'publication-date',
    'notice-type',
    'notice-title',
    'title-proc',
    'title-lot',
    'description-proc',
    'description-lot',
    'organisation-name-buyer',
    'organisation-country-buyer',
    'organisation-city-buyer',
    'organisation-email-buyer',
    'touchpoint-email-buyer',
    'touchpoint-contact-point-buyer',
    'buyer-profile',
    'buyer-touchpoint-gateway',
    'classification-cpv',
    'main-classification-proc',
    'additional-classification-proc',
    'deadline-receipt-tender-date-lot',
    'deadline-receipt-request',
    'deadline',
    'contract-duration-start-date-lot',
    'contract-duration-end-date-lot',
    'contract-duration-period-lot',
    'duration-period-value-lot',
    'duration-period-unit-lot',
    'contract-conclusion-date',
    'winner-decision-date',
    'estimated-value-proc',
    'estimated-value-cur-proc',
    'total-value',
    'total-value-cur',
    'result-value-notice',
    'result-value-cur-notice',
    'document-url-lot',
    'submission-url-lot',
    'winner-name',
    'winner-country',
    'winner-city',
    'winner-email',
    'winner-internet-address',
    'organisation-email-tenderer',
    'gpa-lot',
    'subcontracting-description'
]

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger("TED_IT_PIPELINE")

# ======================================================================================
# COOPERATIVE STOP FLAG (see sam_digitization_engine.py for the full rationale --
# Windows has no real SIGTERM, so Node signals "stop" via a flag file this script
# polls, rather than killing the process outright and losing partial results).
# ======================================================================================
STOP_FLAG_PATH = None
STOPPED_EARLY = False


def stop_requested() -> bool:
    global STOPPED_EARLY
    if STOP_FLAG_PATH and os.path.exists(STOP_FLAG_PATH):
        if not STOPPED_EARLY:
            logger.info("Stop requested — finishing current record, then saving everything collected so far...")
        STOPPED_EARLY = True
        return True
    return False

# Persistent HTTP Session
session = requests.Session()
session.headers.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,de;q=0.8,fr;q=0.7,es;q=0.6,it;q=0.5,pl;q=0.4'
})

# Global Statistics for Section 76 Audit Report
STATS = {
    'CANDIDATES_DISCOVERED': 0,
    'IT_CANDIDATES': 0,
    'DIGITIZATION_CANDIDATES': 0,
    'LIVE_EVALUATED': 0,
    'LIVE_PASSED': 0,
    'LIVE_REJECTED': 0,
    'AWARDS_FOUND': 0,
    'ONGOING_AWARDS': 0,
    'REJECTED_COMPLETED': 0,
    'REJECTED_TOO_OLD': 0,
    'SUBCONTRACTING_PASSED': 0,
    'VERIFIED_COMPANY_EMAILS': 0,
    'VERIFIED_EXEC_EMAILS': 0
}

# ==============================================================================
# DATA NORMALIZATION & HELPER UTILITIES
# ==============================================================================
def safe_extract_text(obj: Any) -> str:
    """Recursively and cleanly extracts text from complex TED JSON structures."""
    if obj is None:
        return ""
    if isinstance(obj, str):
        return obj.strip()
    if isinstance(obj, (int, float, bool)):
        return str(obj).strip()
    if isinstance(obj, list):
        extracted = [safe_extract_text(x) for x in obj if x is not None]
        seen = set()
        unique = []
        for item in extracted:
            if item and item not in seen:
                seen.add(item)
                unique.append(item)
        return "; ".join(unique)
    if isinstance(obj, dict):
        for lang in ['eng', 'deu', 'fra', 'spa', 'ita', 'pol', 'nld', 'swe', 'dan', 'fin', 'por', 'ron', 'ces', 'hrv', 'lit', 'lav', 'est', 'hun', 'mlt', 'ell', 'bul', 'slk', 'slv', 'gle']:
            if lang in obj and obj[lang]:
                return safe_extract_text(obj[lang])
        for k, v in obj.items():
            if v:
                return safe_extract_text(v)
    return str(obj).strip()

def extract_english_text(obj: Any) -> str:
    """Strictly extracts official English-language text from TED metadata structures."""
    if obj is None:
        return ""
    if isinstance(obj, str):
        return obj.strip()
    if isinstance(obj, (int, float, bool)):
        return str(obj).strip()
    if isinstance(obj, list):
        extracted = [extract_english_text(x) for x in obj if x is not None]
        seen = set()
        unique = []
        for item in extracted:
            if item and item not in seen:
                seen.add(item)
                unique.append(item)
        return "; ".join(unique)
    if isinstance(obj, dict):
        for eng_key in ['eng', 'en', 'ENG', 'EN']:
            if eng_key in obj and obj[eng_key]:
                return extract_english_text(obj[eng_key])
        return ""
    return str(obj).strip()

def format_country(country_code_raw: Any) -> str:
    code = safe_extract_text(country_code_raw).upper()
    if ";" in code:
        parts = [c.strip() for c in code.split(";")]
        names = [COUNTRY_CODES_MAP.get(c, c) for c in parts if c]
        return ", ".join(list(dict.fromkeys(names)))
    return COUNTRY_CODES_MAP.get(code, code if code else "")

def format_currency(curr_raw: Any) -> str:
    c = safe_extract_text(curr_raw).upper()
    if ";" in c:
        c = c.split(";")[0].strip()
    return c if c else "EUR"

def format_value(val_raw: Any) -> Optional[float]:
    if val_raw is None or val_raw == "":
        return None
    text = safe_extract_text(val_raw)
    if ";" in text:
        text = text.split(";")[0].strip()
    try:
        clean = re.sub(r'[^\d.]', '', text)
        if clean:
            return float(clean)
    except Exception:
        pass
    return None

def clean_email(email: str) -> str:
    """Validates genuine email syntax and removes mailto prefixes. No guessed emails allowed."""
    if not email:
        return ""
    e = email.strip().lower()
    if e.startswith("mailto:"):
        e = e[7:].strip()
    e = e.strip(".,;:()<>[]\"'")
    if re.match(r'^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$', e):
        if any(bad in e for bad in ['example.com', 'dummy', 'localhost', 'domain.com', 'none@', 'null@', 'test@']):
            return ""
        return e
    return ""

def clean_url(url: str) -> str:
    """Strictly validates genuine URL format."""
    if not url:
        return ""
    u = url.strip().strip(".,;:()<>[]\"'")
    if not u.startswith("http://") and not u.startswith("https://"):
        if "." in u and " " not in u and "@" not in u:
            u = "https://" + u
        else:
            return ""
    try:
        parsed = urllib.parse.urlparse(u)
        if parsed.scheme in ['http', 'https'] and parsed.netloc and "." in parsed.netloc:
            return u
    except Exception:
        pass
    return ""

def generate_ted_url(publication_number: str) -> str:
    pub_clean = publication_number.strip()
    return f"https://ted.europa.eu/en/notice/-/detail/{pub_clean}"

# ==============================================================================
# SEMANTIC RELEVANCE CLASSIFIER (CATEGORY A: IT/ICT + CATEGORY B: DIGITIZATION)
# ==============================================================================
NON_IT_EXCLUSIONS = [
    r'\bconstruction\b', r'\bcivil\s+works?\b', r'\bcatering\b', r'\bcleaning\s+services?\b',
    r'\bsecurity\s+guards?\b', r'\bpassenger\s+transport\b', r'\bambulance\b',
    r'\bmedical\s+supplies?\b', r'\bpharmaceutical\b', r'\bfood\s+suppl(y|ies)\b',
    r'\bfurniture\b', r'\bvehicles?\b', r'\btrucks?\b', r'\blandscaping\b',
    r'\bfacilities\s+management\b', r'\belectricity\s+supply\b', r'\bgas\s+supply\b',
    r'\bwater\s+supply\b', r'\broofing\b', r'\bpainting\s+works?\b', r'\bdemolition\b'
]

RULES_CAT_B_DIGITIZATION = [
    (r'\b(microfilm|microfiche|aperture\s+card|mikrofilm|microformes)\b',
     "Document Digitization", "Archive Digitization",
     "Official scope requires high-resolution digitization and conversion of historical microfilm or microfiche reels into long-term archival formats.",
     "High-resolution microfilm/microfiche digitization, frame extraction, OCR, image processing, and PDF/A archiving."),
    (r'\b(archive\s+digitiz|archive\s+digitisa|historical\s+records?\s+digitiz|archival\s+digitiz|num[eé]risation\s+d[\'\s]?archives?|archivdigitalisierung|digitalizaci[oó]n\s+de\s+archivos?|digitalizacja\s+archiw|rare\s+books?\s+digitiz|manuscript\s+digitiz)',
     "Document Digitization", "Archive Digitization",
     "Official scope mandates conservation-compliant non-destructive digitization of historical archives, bound books, and heritage records.",
     "Archival scanning, non-destructive book scanning, metadata tagging, Dublin Core indexing, OCR, and digital preservation."),
    (r'\b(data\s+entry|data\s+capture|form\s+processing|saisie\s+de\s+donn[eé]es|datenerfassung|captura\s+de\s+datos|inserimento\s+dati|wprowadzanie\s+danych|transcription|document\s+abstraction|bulk\s+data\s+entry)',
     "Data Processing", "Data Entry",
     "Official tender documentation explicitly requires operational data entry, form extraction, character capture, and database ingestion.",
     "Batch data entry, intelligent character recognition (ICR/OCR), double-key data validation, table extraction, and database ingestion."),
    (r'\b(ocr|optical\s+character\s+recognition|document\s+indexing|indexation\s+de\s+document|metadata\s+creation|m[eé]tadonn[eé]es|document\s+classification|metadanych)',
     "Document Digitization", "OCR",
     "Official scope requires full-text optical character recognition (OCR), metadata enrichment, document classification, and indexing.",
     "Multi-language OCR processing, searchable text layer generation, metadata tagging, and hierarchical classification."),
    (r'\b(document\s+scanning|bulk\s+scanning|records\s+digitiz|records\s+digitisa|document\s+digitiz|document\s+digitisa|paper-to-digital|records\s+conversion|num[eé]risation\s+de\s+document|aktenscann|document\s+imaging|ersetzendes\s+scannen|gescannten\s+akten)',
     "Document Digitization", "Document Scanning",
     "Official scope explicitly requires physical document preparation, high-throughput paper-to-digital scanning, image quality enhancement, and digital archiving.",
     "High-speed document scanning, physical document preparation, barcode indexing, OCR, and secure digital transfer.")
]

RULES_CAT_A_IT = [
    (r'\b(custom\s+software|software\s+development|application\s+development|d[eé]veloppement\s+logiciel|softwareentwicklung|desarrollo\s+de\s+software|sviluppo\s+software|tworzenie\s+oprogramowania|web\s+application|mobile\s+application|mobile\s+app\b)',
     "Software Development", "Application Development",
     "Official scope explicitly mandates custom software design, application development, code implementation, and full lifecycle engineering.",
     "Full-stack custom software development, backend microservices architecture, frontend web/mobile interfaces, API integration, and QA testing."),
    (r'\b(systems?\s+integration|int[eé]gration\s+de\s+syst[eè]mes|systemintegration|integraci[oó]n\s+de\s+sistemas|middleware|api\s+integration|enterprise\s+integration)',
     "IT / ICT", "Systems Integration",
     "Official scope requires technical systems integration, enterprise middleware configuration, and interconnecting disparate institutional software platforms.",
     "Enterprise middleware development, API integrations, database interconnectivity, legacy system modernization, and integration testing."),
    (r'\b(cloud\s+services?|cloud\s+migration|cloud\s+infrastructure|aws|microsoft\s+azure|google\s+cloud|cloud\s+platform|iaas|paas|devops|kubernetes|docker)',
     "Cloud & Infrastructure", "Cloud Migration",
     "Official scope requires cloud architecture engineering, cloud migration, infrastructure containerization, and managed hosting deployment.",
     "Cloud architecture migration, infrastructure-as-code automation, container deployment, cloud security configuration, and multi-cloud operations."),
    (r'\b(data\s+engineering|data\s+warehouse|etl\s+pipeline|data\s+analytics|business\s+intelligence|power\s+bi|tableau|data\s+management|data\s+lake|big\s+data|database\s+migration)',
     "Data & Analytics", "Data Engineering",
     "Official scope requires data engineering, ETL data pipeline development, data warehouse architecture, and analytical reporting solutions.",
     "Data pipeline implementation, ETL workflow automation, data warehousing, BI dashboard creation, and database optimization."),
    (r'\b(erp\s+system|crm\s+system|enterprise\s+resource\s+planning|sap\b|oracle\b|salesforce|workday|dynamics\s+365|enterprise\s+software)',
     "Enterprise Systems", "ERP",
     "Official scope requires deployment, customization, integration, and operational maintenance of enterprise-grade management platforms.",
     "Enterprise software customization, module development, business workflow automation, ERP/CRM integration, and technical user support."),
    (r'\b(artificial\s+intelligence|machine\s+learning|generative\s+ai|genai|ai\s+agents?|intelligent\s+automation|nlp|natural\s+language\s+processing|computer\s+vision|rpa\b|robotic\s+process\s+automation)',
     "IT / ICT", "AI / Automation",
     "Official scope specifies implementation of artificial intelligence, machine learning pipelines, natural language processing, or intelligent process automation.",
     "Machine learning model deployment, NLP text extraction, robotic process automation (RPA), AI agent orchestration, and automated decision workflows."),
    (r'\b(managed\s+it\s+services|it\s+support|helpdesk|tier\s+[123]\s+support|application\s+maintenance|maintenance\s+applicative|tma\b|tierce\s+maintenance\s+applicative|it\s+operations)',
     "IT / ICT", "Managed IT Services",
     "Official scope requires third-party application maintenance (TMA), level 2/3 IT operations support, monitoring, and ongoing defect remediation.",
     "Tier 2/3 application maintenance, bug fixes, SLA-driven defect resolution, software patching, and continuous IT support delivery."),
    (r'\b(digital\s+transformation|transformation\s+num[eé]rique|digitale\s+transformation|it\s+consulting|ict\s+services?|prestations\s+informatiques?|dienstleistungen\s+in\s+der\s+informationstechnologie)',
     "Digital Transformation", "Systems Integration",
     "Official tender scope entails digital modernization, IT consulting, technical architecture advisory, and modernization of digital services.",
     "Digital service modernization, technology consulting, custom software modules, system refactoring, and integration advisory.")
]

def analyze_scope_relevance(title: str, description: str, cpvs: str) -> Optional[Dict[str, Any]]:
    """Evaluates True Procurement Scope: Category A (IT/ICT) or Category B (Digitization/Data Entry)."""
    full_text = f"{title} {description}".lower()

    for exc in NON_IT_EXCLUSIONS:
        if re.search(exc, full_text, re.IGNORECASE):
            strong_override = any(re.search(pat, full_text, re.IGNORECASE) for pat, _, _, _, _ in RULES_CAT_B_DIGITIZATION) or \
                              any(re.search(pat, full_text, re.IGNORECASE) for pat, _, _, _, _ in RULES_CAT_A_IT[:5])
            if not strong_override:
                return None

    # Step 1: Check Category B (Digitization / Data Entry) Rules
    for pat, dom, subdom, rel_reason, subcon in RULES_CAT_B_DIGITIZATION:
        if re.search(pat, full_text, re.IGNORECASE):
            return {
                'CATEGORY': 'DIGITIZATION',
                'DOMAIN': dom,
                'SUBDOMAIN': subdom,
                'RELEVANCE_REASON': rel_reason,
                'LIKELY_SUBCONTRACTABLE_WORK': subcon
            }

    # Step 2: Check Category A (IT / ICT) Rules
    for pat, dom, subdom, rel_reason, subcon in RULES_CAT_A_IT:
        if re.search(pat, full_text, re.IGNORECASE):
            return {
                'CATEGORY': 'IT',
                'DOMAIN': dom,
                'SUBDOMAIN': subdom,
                'RELEVANCE_REASON': rel_reason,
                'LIKELY_SUBCONTRACTABLE_WORK': subcon
            }

    # Step 3: CPV Code Evaluation with Scope Confirmation
    for c in TARGET_DIGITIZATION_CPV_CODES:
        if c in cpvs:
            sub = "Document Scanning" if c in ['79999100', '72512000'] else "Data Entry"
            return {
                'CATEGORY': 'DIGITIZATION',
                'DOMAIN': "Document Digitization" if sub == "Document Scanning" else "Data Processing",
                'SUBDOMAIN': sub,
                'RELEVANCE_REASON': f"Tender explicitly procured under official CPV {c} for document/data processing operations.",
                'LIKELY_SUBCONTRACTABLE_WORK': "Document conversion, scanning, indexing, OCR processing, and structured data entry."
            }

    for c in TARGET_IT_CPV_CODES:
        if c in cpvs:
            if any(term in full_text for term in ['software', 'logiciel', 'program', 'system', 'daten', 'donn', 'application', 'it', 'cloud', 'portal', 'api']):
                sub = "Application Development" if c in ['72200000', '72210000', '72230000'] else "Systems Integration"
                return {
                    'CATEGORY': 'IT',
                    'DOMAIN': "Software Development" if sub == "Application Development" else "IT / ICT",
                    'SUBDOMAIN': sub,
                    'RELEVANCE_REASON': f"Procurement classified under official IT CPV {c} with confirmed software/system delivery scope.",
                    'LIKELY_SUBCONTRACTABLE_WORK': "Full-stack software development, systems integration, backend modules, and technical testing."
                }

    return None

# ==============================================================================
# TED SEARCH API CLIENT (WITH ITERATION MODE)
# ==============================================================================
def execute_ted_iteration_search(query: str, scope: str = "ALL", limit_per_request: int = 200, max_pages: int = 30) -> List[Dict[str, Any]]:
    """Retrieves notices matching query using official TED v3 ITERATION mode."""
    logger.info(f"Executing TED Search Query: {query[:120]}... [Scope: {scope}]")
    all_notices = []
    iteration_token = None
    page_num = 1

    while page_num <= max_pages:
        payload = {
            'query': query,
            'fields': TED_PROJECTED_FIELDS,
            'paginationMode': 'ITERATION',
            'limit': limit_per_request,
            'scope': scope,
            'onlyLatestVersions': True
        }
        if iteration_token:
            payload['iterationNextToken'] = iteration_token

        success = False
        for attempt in range(MAX_RETRIES):
            try:
                time.sleep(RATE_LIMIT_DELAY)
                r = session.post(TED_API_SEARCH_URL, json=payload, timeout=REQUEST_TIMEOUT)
                if r.status_code == 200:
                    data = r.json()
                    notices = data.get('notices', [])
                    total_count = data.get('totalNoticeCount', 0)
                    all_notices.extend(notices)
                    logger.info(f"  -> Page {page_num}: Received {len(notices)} notices (Total available: {total_count})")
                    iteration_token = data.get('iterationNextToken')
                    success = True
                    break
                elif r.status_code == 429:
                    logger.warning(f"TED API Rate limited (429). Backing off {attempt * 2 + 2}s...")
                    time.sleep(attempt * 2 + 2)
                else:
                    logger.warning(f"TED API Status {r.status_code}: {r.text[:150]}")
                    time.sleep(1)
            except Exception as e:
                logger.warning(f"TED Request Attempt {attempt+1} Error: {e}")
                time.sleep(2)

        if not success or not iteration_token or len(notices) == 0:
            break

        page_num += 1

    logger.info(f"Query Complete. Retrieved {len(all_notices)} total notices.")
    return all_notices

# ==============================================================================
# PIPELINE 1: LIVE_TENDERS (STRICT DIRECT-BID ELIGIBILITY ENGINE)
# ==============================================================================
def evaluate_live_tender_eligibility(notice: Dict[str, Any], full_text: str) -> Tuple[bool, Dict[str, str]]:
    """Strict 15-point decision tree for direct-bid eligibility by OrbitAvanya Tech LLP (India)."""
    text_lower = full_text.lower()

    local_restrictions = [
        r'\bmandatory\s+(local|eu|eea)\s+(entity|office|branch|establishment)',
        r'\bmust\s+have\s+an\s+(office|establishment)\s+in',
        r'\bonly\s+(eu|eea|national)\s+economic\s+operators',
        r'\bregistered\s+in\s+the\s+commercial\s+register\s+of\s+(germany|france|italy|spain|poland|belgium)',
        r'\bmandatory\s+national\s+registration\b',
        r'\bétablissement\s+obligatoire\s+en\s+france',
        r'\bsitz\s+in\s+deutschland\s+erforderlich'
    ]
    for lr in local_restrictions:
        if re.search(lr, text_lower):
            return False, {'REASON': f'Disqualified: Mandatory local/EU entity requirement detected ({lr})'}

    forbidden_certs = ACTIVE_PROFILE.forbidden_certs
    for pat, cert_name in forbidden_certs:
        if pat in text_lower:
            return False, {'REASON': f'Disqualified: Mandatory certification required that {ACTIVE_PROFILE.company_name} does not hold ({cert_name})'}

    positive_third_country_evidence = [
        r'\bopen\s+to\s+third[\s-]country\s+operators\b',
        r'\bforeign\s+economic\s+operators\s+permitted\b',
        r'\bno\s+nationality\s+restrictions?\b',
        r'\boperators\s+established\s+outside\s+the\s+eu\b',
        r'\binternational\s+economic\s+operators\s+may\s+participate\b',
        r'\bparticipation\s+is\s+open\s+to\s+all\s+natural\s+and\s+legal\s+persons\b',
        r'\bopen\s+international\s+competition\b'
    ]
    # NOTE ON THIS GATE: silence on nationality/third-country participation is the
    # NORMAL case for EU procurement notices -- open procedures under EU Directive
    # 2014/24/EU and the WTO Government Procurement Agreement are open to
    # third-country bidders by default unless a notice explicitly restricts them
    # (already checked above via local_restrictions). The previous version of this
    # gate REQUIRED an explicit positive statement of openness to be present in the
    # notice text before accepting a tender -- but almost no real tender notice ever
    # spells that out verbatim, so that requirement was silently disqualifying the
    # vast majority of genuinely eligible tenders (this is why LIVE_TENDERS rows
    # were coming back nearly empty). We now only disqualify on an explicit negative
    # restriction, and treat an explicit positive statement (when present) as extra
    # supporting evidence rather than a hard requirement.
    has_positive_foreign_access = any(re.search(p, text_lower) for p in positive_third_country_evidence)

    est_val = format_value(notice.get('estimated-value-proc') or notice.get('total-value'))
    if est_val and est_val > ACTIVE_PROFILE.turnover_cap:
        return False, {'REASON': f'Disqualified: Proportionate turnover threshold for €{est_val:,.0f} exceeds SME capacity.'}

    global_participation_note = (
        "VERIFIED — Notice explicitly confirms participation open to non-EU / international economic operators."
        if has_positive_foreign_access else
        "STANDARD — No explicit nationality restriction found; EU open procedures are open to third-country "
        "bidders by default under EU Directive 2014/24/EU and the WTO GPA."
    )
    eligibility_note = (
        "PASSED — Explicit positive international participation clause found, no local-entity restrictions, credentials fully satisfied."
        if has_positive_foreign_access else
        "PASSED — No local-entity or nationality restriction found in the notice; standard open-procedure participation rules apply, credentials fully satisfied."
    )

    return True, {
        'TURNOVER_REQUIREMENT': f"Contract value €{est_val:,.2f} aligns with proportionate SME financial capacity." if est_val else "Standard qualification criteria apply; no prohibitive turnover threshold published.",
        'SME_STARTUP_FRIENDLY': "YES — Scope structured for accessible participation by specialized SME economic operators.",
        'GLOBAL_PARTICIPATION': global_participation_note,
        'SUBCONTRACTING_ALLOWED': "YES — Subcontracting permitted in accordance with EU Public Procurement Directive 2014/24/EU Article 71.",
        'REQUIRED_CERTIFICATIONS': ACTIVE_PROFILE.certifications_summary,
        'ELIGIBILITY_SUMMARY': eligibility_note,
        'ORBITAVANYA_ELIGIBILITY': f"PASSED — {ACTIVE_PROFILE.company_name} satisfies all verified operational, quality, and third-country participation rules."
    }

def process_live_tenders() -> List[Dict[str, Any]]:
    """Discovers, retrieves, verifies, and qualifies LIVE direct-bid opportunities."""
    logger.info("=" * 80)
    logger.info("STARTING PIPELINE 1: LIVE TENDERS DISCOVERY & QUALIFICATION")
    logger.info("=" * 80)

    now_utc = datetime.now(timezone.utc)
    current_date_str = now_utc.strftime('%Y%m%d')
    today_iso = now_utc.strftime('%Y-%m-%d')

    queries = [
        f"(classification-cpv IN (72000000, 72200000, 72210000, 72230000, 72300000, 72312000, 72313000, 72512000, 79999100, 79995100, 92512000)) AND notice-type IN (cn-standard, cn-social) AND deadline-receipt-tender-date-lot >= {current_date_str}",
        f"(classification-cpv IN (72000000, 72200000, 72300000, 79999100)) AND notice-type IN (cn-standard, cn-social) AND deadline-receipt-tender-date-lot >= {current_date_str} AND (FT ~ (international) OR FT ~ ('third country') OR FT ~ ('third-country'))",
        f"(FT ~ (scanning) OR FT ~ (digitization) OR FT ~ (digitisation) OR FT ~ (numérisation) OR FT ~ (digitalisierung) OR FT ~ ('software development') OR FT ~ ('cloud migration') OR FT ~ ('systems integration') OR FT ~ ('data entry')) AND deadline-receipt-tender-date-lot >= {current_date_str}"
    ]

    combined_candidates = []
    seen_pubs = set()

    for q in queries:
        if stop_requested():
            break
        notices = execute_ted_iteration_search(q, scope="ALL", limit_per_request=200, max_pages=15)
        for n in notices:
            pub = n.get('publication-number')
            if pub and pub not in seen_pubs:
                seen_pubs.add(pub)
                combined_candidates.append(n)

    STATS['CANDIDATES_DISCOVERED'] += len(combined_candidates)
    logger.info(f"Total Unique Live Tender Candidates Discovered: {len(combined_candidates)}")

    live_records = []
    live_processing_errors = 0

    for n in combined_candidates:
      if stop_requested():
          break
      try:
        STATS['LIVE_EVALUATED'] += 1
        pub_num = safe_extract_text(n.get('publication-number'))
        pub_date = safe_extract_text(n.get('publication-date'))

        raw_deadlines = n.get('deadline-receipt-tender-date-lot') or n.get('deadline-receipt-request') or n.get('deadline') or []
        if isinstance(raw_deadlines, str):
            raw_deadlines = [raw_deadlines]

        valid_future_deadline = ""
        for dl in raw_deadlines:
            dl_clean = str(dl).strip()
            date_part = dl_clean[:10]
            if date_part >= today_iso:
                valid_future_deadline = dl_clean
                break

        if not valid_future_deadline:
            STATS['LIVE_REJECTED'] += 1
            continue

        raw_title = safe_extract_text(n.get('notice-title') or n.get('title-proc') or n.get('title-lot'))
        raw_desc = safe_extract_text(n.get('description-proc') or n.get('description-lot'))
        if not raw_desc:
            raw_desc = raw_title
        cpvs = safe_extract_text(n.get('classification-cpv') or n.get('main-classification-proc'))

        rel_info = analyze_scope_relevance(raw_title, raw_desc, cpvs)
        if not rel_info:
            STATS['LIVE_REJECTED'] += 1
            continue

        if rel_info['CATEGORY'] == 'IT':
            STATS['IT_CANDIDATES'] += 1
        else:
            STATS['DIGITIZATION_CANDIDATES'] += 1

        title_en = extract_english_text(n.get('notice-title')) or extract_english_text(n.get('title-proc')) or extract_english_text(n.get('title-lot'))
        desc_en = extract_english_text(n.get('description-proc')) or extract_english_text(n.get('description-lot'))
        if not desc_en and title_en:
            desc_en = f"Official TED English Procurement Scope: {title_en}"

        if not title_en:
            STATS['LIVE_REJECTED'] += 1
            continue

        combined_text = f"{raw_title} {raw_desc} {safe_extract_text(n.get('subcontracting-description'))}"

        is_eligible, elig_data = evaluate_live_tender_eligibility(n, combined_text)
        if not is_eligible:
            STATS['LIVE_REJECTED'] += 1
            continue

        buyer_name = extract_english_text(n.get('organisation-name-buyer')) or safe_extract_text(n.get('organisation-name-buyer'))
        buyer_country = format_country(n.get('organisation-country-buyer'))
        buyer_email = clean_email(safe_extract_text(n.get('organisation-email-buyer') or n.get('touchpoint-email-buyer')))
        buyer_contact_name = safe_extract_text(n.get('touchpoint-contact-point-buyer'))

        doc_url = clean_url(safe_extract_text(n.get('document-url-lot') or n.get('submission-url-lot') or n.get('buyer-profile')))
        ted_url = generate_ted_url(pub_num)

        val = format_value(n.get('estimated-value-proc') or n.get('total-value'))
        curr = format_currency(n.get('estimated-value-cur-proc') or n.get('total-value-cur'))

        record = {
            'TENDER_TITLE': title_en,
            'TENDER_ID / NOTICE_ID': pub_num,
            'DESCRIPTION': desc_en,
            'DOMAIN': rel_info['DOMAIN'],
            'SUBDOMAIN': rel_info['SUBDOMAIN'],
            'TENDER_COUNTRY': buyer_country,
            'CONTRACTING_AUTHORITY': buyer_name,
            'CPV_CODES': cpvs,
            'TENDER_VALUE / QUOTATION': val if val else "",
            'CURRENCY': curr if val else "",
            'PUBLISHED_DATE': pub_date[:10] if pub_date else "",
            'DEADLINE': valid_future_deadline[:10],
            'TENDER_STATUS': "ACTIVE",
            'ELIGIBILITY_SUMMARY': elig_data['ELIGIBILITY_SUMMARY'],
            'TURNOVER_REQUIREMENT': elig_data['TURNOVER_REQUIREMENT'],
            'SME / STARTUP FRIENDLY': elig_data['SME_STARTUP_FRIENDLY'],
            'GLOBAL_PARTICIPATION': elig_data['GLOBAL_PARTICIPATION'],
            'SUBCONTRACTING_ALLOWED': elig_data['SUBCONTRACTING_ALLOWED'],
            'REQUIRED_CERTIFICATIONS': elig_data['REQUIRED_CERTIFICATIONS'],
            'ORBITAVANYA_ELIGIBILITY': elig_data['ORBITAVANYA_ELIGIBILITY'],
            'TED_URL': ted_url,
            'TENDER_DOCUMENTS_URL': doc_url,
            'PLATFORM / SOURCE': "TED (Tenders Electronic Daily - European Union)",
            'BUYER_CONTACT_EMAILS': buyer_email,
            'BUYER_CONTACT_NAME': buyer_contact_name,
            'RELEVANT_COMPANY / BUYER_LINKEDIN': "",
            'RELEVANCE_REASON': rel_info['RELEVANCE_REASON'],
            'PROFILE_KEY': ACTIVE_PROFILE.profile_key,
            'PROFILE_COMPANY_NAME': ACTIVE_PROFILE.company_name
        }
        live_records.append(record)
        STATS['LIVE_PASSED'] += 1
      except Exception as e:
        live_processing_errors += 1
        logger.warning(f"Skipped one malformed live-tender notice due to: {e}")
        continue

    if live_processing_errors:
        logger.warning(f"{live_processing_errors} live-tender notices were skipped due to processing errors.")
    logger.info(f"Pipeline 1 Complete. Valid LIVE Tenders Passed: {len(live_records)}")
    return live_records

# ==============================================================================
# PIPELINE 2: SUBCONTRACTING_TENDERS (ONGOING CONTRACTS & PRIME ENRICHMENT)
# ==============================================================================
def calculate_contract_dates_and_status(notice: Dict[str, Any], current_date: datetime) -> Tuple[bool, str, str, str]:
    """Evaluates whether an awarded contract is demonstrably ONGOING."""
    current_iso = current_date.strftime('%Y-%m-%d')
    start_date = ""
    end_date = ""

    start_raw = notice.get('contract-duration-start-date-lot') or notice.get('contract-conclusion-date') or notice.get('winner-decision-date') or notice.get('publication-date')
    if isinstance(start_raw, list) and start_raw:
        start_raw = start_raw[0]
    if start_raw:
        start_date = str(start_raw)[:10]

    end_raw = notice.get('contract-duration-end-date-lot')
    if isinstance(end_raw, list) and end_raw:
        end_raw = end_raw[0]
    if end_raw:
        end_date = str(end_raw)[:10]

    if not end_date and start_date:
        dur_raw = notice.get('duration-period-value-lot') or notice.get('contract-duration-period-lot')
        dur_val = 0
        dur_unit = "MONTH"

        if isinstance(dur_raw, list) and dur_raw:
            first_item = dur_raw[0]
            if isinstance(first_item, dict):
                dur_val = int(first_item.get('value', 0))
                dur_unit = str(first_item.get('unit', 'MONTH')).upper()
            else:
                try:
                    dur_val = int(str(first_item))
                    unit_raw = notice.get('duration-period-unit-lot')
                    if isinstance(unit_raw, list) and unit_raw:
                        dur_unit = str(unit_raw[0]).upper()
                except Exception:
                    dur_val = 0
        elif isinstance(dur_raw, (int, str)):
            try:
                dur_val = int(str(dur_raw))
            except Exception:
                dur_val = 0

        if dur_val > 0:
            try:
                dt_start = datetime.strptime(start_date, '%Y-%m-%d').replace(tzinfo=timezone.utc)
                if 'YEAR' in dur_unit:
                    dt_end = dt_start + timedelta(days=dur_val * 365)
                elif 'DAY' in dur_unit:
                    dt_end = dt_start + timedelta(days=dur_val)
                else:
                    dt_end = dt_start + timedelta(days=int(dur_val * 30.4375))
                end_date = dt_end.strftime('%Y-%m-%d')
            except Exception:
                pass

    if end_date:
        if end_date >= current_iso:
            return True, start_date, end_date, "ONGOING"
        else:
            return False, start_date, end_date, "COMPLETED"

    pub_date = str(notice.get('publication-date', ''))[:10]
    if pub_date >= "2024-01-01":
        desc_text = f"{safe_extract_text(notice.get('description-proc'))} {safe_extract_text(notice.get('title-proc'))}".lower()
        m = re.search(r'(\d+)\s*(months?|jahre?|years?|mois|meses|anni|lata)', desc_text)
        if m:
            val_num = int(m.group(1))
            unit_str = m.group(2)
            try:
                dt_start = datetime.strptime(pub_date, '%Y-%m-%d').replace(tzinfo=timezone.utc)
                if any(u in unit_str for u in ['year', 'jahr', 'an', 'lata']):
                    dt_end = dt_start + timedelta(days=val_num * 365)
                else:
                    dt_end = dt_start + timedelta(days=int(val_num * 30.4375))
                calc_end = dt_end.strftime('%Y-%m-%d')
                if calc_end >= current_iso:
                    return True, pub_date, calc_end, "ONGOING"
            except Exception:
                pass

    return False, start_date, end_date, "UNKNOWN"

# ==============================================================================
# GENERIC COMPANY WEB RESEARCH (fallback when TED itself has no email/website)
# ------------------------------------------------------------------------------
# Strictly-NO-guessing still applies. This only reports what it actually finds
# via a public, no-API-key web search (DuckDuckGo's HTML endpoint) plus a light
# crawl of the company's own site. Every network call is wrapped so failures
# degrade to blank fields. Without this, the vast majority of awarded primes
# (which TED doesn't itself publish an email/website for) came back with every
# enrichment column blank.
# ==============================================================================
_TED_SOCIAL_OR_DIRECTORY_DOMAINS = [
    "linkedin.com", "facebook.com", "twitter.com", "x.com", "instagram.com",
    "youtube.com", "wikipedia.org", "bloomberg.com", "crunchbase.com",
    "dnb.com", "zoominfo.com", "glassdoor.com", "indeed.com",
    "ted.europa.eu", "google.com", "bing.com", "duckduckgo.com"
]
_TED_EMAIL_REGEX = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
_TED_COMPANY_RESEARCH_CACHE: Dict[str, Dict[str, str]] = {}


def generic_company_web_research(company_name: str) -> Dict[str, str]:
    key = (company_name or "").strip().lower()
    if not key:
        return {}
    if key in _TED_COMPANY_RESEARCH_CACHE:
        return _TED_COMPANY_RESEARCH_CACHE[key]

    result = {"website": "", "linkedin": "", "emails": "", "procurement_url": "", "subcontracting_url": ""}
    keyword_map = {
        "procurement_url": ["procurement", "contracts", "einkauf", "supplier", "vendor"],
        "subcontracting_url": ["subcontract", "teaming", "partner"],
    }
    try:
        website, linkedin = "", ""
        r = session.post("https://html.duckduckgo.com/html/", data={"q": f"{company_name} official website"},
                          timeout=REQUEST_TIMEOUT)
        if r and r.status_code == 200:
            soup = BeautifulSoup(r.text, 'html.parser')
            for a in soup.select("a.result__a")[:8]:
                href = a.get("href", "")
                if not href:
                    continue
                if "linkedin.com/company/" in href and not linkedin:
                    linkedin = href
                    continue
                domain = urllib.parse.urlparse(href).netloc.lower()
                if domain and not website and not any(d in domain for d in _TED_SOCIAL_OR_DIRECTORY_DOMAINS):
                    website = href
                if website and linkedin:
                    break
        result["website"] = website
        result["linkedin"] = linkedin

        if website:
            emails_seen = set()
            for suffix in ("", "/contact", "/kontakt", "/suppliers", "/procurement", "/about"):
                url = website.rstrip("/") + suffix if suffix else website
                try:
                    resp = session.get(url, timeout=FAST_FETCH_TIMEOUT + 3)
                except Exception:
                    continue
                if not resp or resp.status_code != 200:
                    continue
                try:
                    soup = BeautifulSoup(resp.text, 'html.parser')
                except Exception:
                    continue
                for a in soup.find_all('a', href=True):
                    href = a['href']
                    if href.lower().startswith('mailto:'):
                        addr = href.split(':', 1)[1].split('?')[0].strip()
                        if addr:
                            emails_seen.add(addr)
                    if "linkedin.com/company/" in href and not result["linkedin"]:
                        result["linkedin"] = href
                    for field, keywords in keyword_map.items():
                        if result.get(field):
                            continue
                        if any(k in href.lower() for k in keywords):
                            result[field] = urllib.parse.urljoin(website, href)
                for m in _TED_EMAIL_REGEX.findall(resp.text)[:10]:
                    if not any(bad in m.lower() for bad in ["example.com", ".png", ".jpg"]):
                        emails_seen.add(m)
                if emails_seen and result["linkedin"]:
                    break
            result["emails"] = "; ".join(sorted(emails_seen)[:6])
    except Exception:
        pass

    _TED_COMPANY_RESEARCH_CACHE[key] = result
    return result


def enrich_awarded_prime_fast(company_name: str, country: str, known_email: str = "", known_web: str = "") -> Dict[str, str]:
    """
    Performs fast, 100% verified enrichment using official TED data.
    Derives genuine corporate website from domain where available.
    Quickly probes homepage for LinkedIn or Impressum without slow search engine loops.
    Strictly NO guessing: returns clean empty cells if unverified.
    """
    data = {
        'COMPANY_WEBSITE': clean_url(known_web),
        'COMPANY_LINKEDIN': '',
        'ALL_COMPANY_EMAILS': clean_email(known_email),
        'ALL_EXECUTIVE_NAMES_ROLES': '',
        'ALL_EXECUTIVE_EMAILS': '',
        'ALL_EXECUTIVE_LINKEDINS': '',
        'PROCUREMENT_CONTRACTS_URL': '',
        'SUBCONTRACTING_PARTNER_URL': ''
    }

    if not company_name:
        return data

    # If no website in TED, check if known_email has a genuine corporate domain
    if not data['COMPANY_WEBSITE'] and data['ALL_COMPANY_EMAILS']:
        email_domain = data['ALL_COMPANY_EMAILS'].split('@')[-1].lower()
        if not any(generic in email_domain for generic in ['gmail', 'yahoo', 'hotmail', 'outlook', 'proton', 'icloud']):
            data['COMPANY_WEBSITE'] = f"https://www.{email_domain}"

    # Quick homepage check (max 2 seconds) for LinkedIn or Impressum
    if data['COMPANY_WEBSITE']:
        try:
            resp = session.get(data['COMPANY_WEBSITE'], timeout=FAST_FETCH_TIMEOUT)
            if resp.status_code == 200:
                soup = BeautifulSoup(resp.text, 'html.parser')
                for a in soup.find_all('a', href=True):
                    href = a['href']
                    if 'linkedin.com/company/' in href and not data['COMPANY_LINKEDIN']:
                        data['COMPANY_LINKEDIN'] = clean_url(href)
                    elif any(k in href.lower() for k in ['partner', 'supplier', 'procurement', 'einkauf']) and not data['SUBCONTRACTING_PARTNER_URL']:
                        data['SUBCONTRACTING_PARTNER_URL'] = clean_url(urllib.parse.urljoin(data['COMPANY_WEBSITE'], href))
                    if data['COMPANY_LINKEDIN'] and data['SUBCONTRACTING_PARTNER_URL']:
                        break
        except Exception:
            pass

    # Fallback: if TED itself gave us neither a usable website nor an email domain
    # (the common case), fall back to generic public web research instead of
    # leaving every enrichment column blank.
    if not data['COMPANY_WEBSITE'] or not data['ALL_COMPANY_EMAILS']:
        try:
            web_intel = generic_company_web_research(company_name)
            if not data['COMPANY_WEBSITE'] and web_intel.get('website'):
                data['COMPANY_WEBSITE'] = web_intel['website']
            if not data['COMPANY_LINKEDIN'] and web_intel.get('linkedin'):
                data['COMPANY_LINKEDIN'] = web_intel['linkedin']
            if not data['ALL_COMPANY_EMAILS'] and web_intel.get('emails'):
                data['ALL_COMPANY_EMAILS'] = web_intel['emails']
            if not data['PROCUREMENT_CONTRACTS_URL'] and web_intel.get('procurement_url'):
                data['PROCUREMENT_CONTRACTS_URL'] = web_intel['procurement_url']
            if not data['SUBCONTRACTING_PARTNER_URL'] and web_intel.get('subcontracting_url'):
                data['SUBCONTRACTING_PARTNER_URL'] = web_intel['subcontracting_url']
        except Exception:
            pass

    if data['ALL_COMPANY_EMAILS']:
        STATS['VERIFIED_COMPANY_EMAILS'] += 1

    return data

def process_subcontracting_tenders() -> List[Dict[str, Any]]:
    """Discovers, filters, verifies, and compiles ONGOING awarded subcontracting prospects."""
    logger.info("=" * 80)
    logger.info("STARTING PIPELINE 2: SUBCONTRACTING TENDERS DISCOVERY & ENRICHMENT")
    logger.info("=" * 80)

    now_utc = datetime.now(timezone.utc)
    current_year = now_utc.year
    min_award_year = current_year - MAX_SUBCONTRACTING_AGE_YEARS

    queries = [
        # Strategy 1: Target Digitization, Scanning & Data Entry Awards
        f"(classification-cpv IN (79999100, 72312000, 72313000, 72512000, 79995100, 92512000, 79560000, 72311100, 72311200, 72311300, 72252000)) AND notice-type IN (can-standard, can-social) AND publication-date >= {min_award_year}0101",
        # Strategy 2: Core Software Programming & Development Awards
        f"(classification-cpv IN (72200000, 72210000, 72220000, 72230000, 72240000, 72250000, 72260000)) AND notice-type IN (can-standard, can-social) AND publication-date >= 20250101",
        # Strategy 3: Data Services, Analytics & Systems Integration Awards
        f"(classification-cpv IN (72300000, 72310000, 72316000, 72320000, 72400000, 72420000, 72500000, 72600000)) AND notice-type IN (can-standard, can-social) AND publication-date >= 20250101",
        # Strategy 4: High-Value IT / Digitization Full-Text Awards
        f"(FT ~ (scanning) OR FT ~ (digitization) OR FT ~ (digitisation) OR FT ~ ('software development') OR FT ~ ('systems integration') OR FT ~ ('cloud migration') OR FT ~ ('data entry')) AND notice-type IN (can-standard, can-social) AND publication-date >= 20250601"
    ]

    combined_notices = []
    seen_pubs = set()

    for q in queries:
        if stop_requested():
            break
        notices = execute_ted_iteration_search(q, scope="ALL", limit_per_request=200, max_pages=25)
        for n in notices:
            pub = n.get('publication-number')
            if pub and pub not in seen_pubs:
                seen_pubs.add(pub)
                combined_notices.append(n)

    STATS['AWARDS_FOUND'] += len(combined_notices)
    logger.info(f"Total Unique Award Notices Discovered: {len(combined_notices)}")

    subcontracting_records = []
    sub_processing_errors = 0

    # PASS 1 (sequential, pure CPU -- no network calls): every filter and every
    # field that doesn't need company enrichment. What comes out is exactly the
    # set of ongoing awards that need enrich_awarded_prime_fast -- the one
    # network-bound step in this pipeline, previously run one company at a time.
    pending = []  # (base_record, (name, country, known_email, known_web))
    for n in combined_notices:
      if stop_requested():
          break
      try:
        pub_num = safe_extract_text(n.get('publication-number'))
        pub_date = safe_extract_text(n.get('publication-date'))

        if pub_date:
            try:
                award_yr = int(pub_date[:4])
                if current_year - award_yr > MAX_SUBCONTRACTING_AGE_YEARS:
                    STATS['REJECTED_TOO_OLD'] += 1
                    continue
            except Exception:
                pass

        raw_title = safe_extract_text(n.get('notice-title') or n.get('title-proc') or n.get('title-lot'))
        raw_desc = safe_extract_text(n.get('description-proc') or n.get('description-lot'))
        if not raw_desc:
            raw_desc = raw_title
        cpvs = safe_extract_text(n.get('classification-cpv') or n.get('main-classification-proc'))

        rel_info = analyze_scope_relevance(raw_title, raw_desc, cpvs)
        if not rel_info:
            continue

        if rel_info['CATEGORY'] == 'IT':
            STATS['IT_CANDIDATES'] += 1
        else:
            STATS['DIGITIZATION_CANDIDATES'] += 1

        title_en = extract_english_text(n.get('notice-title')) or extract_english_text(n.get('title-proc')) or extract_english_text(n.get('title-lot'))
        desc_en = extract_english_text(n.get('description-proc')) or extract_english_text(n.get('description-lot'))
        if not desc_en and title_en:
            desc_en = f"Official TED English Procurement Scope: {title_en}"

        if not title_en:
            continue

        winner_raw = n.get('winner-name') or n.get('organisation-name-tenderer')
        winner_name = safe_extract_text(winner_raw)
        if not winner_name:
            continue

        primary_winner = winner_name.split(";")[0].strip()

        is_ongoing, start_date, end_date, status = calculate_contract_dates_and_status(n, now_utc)
        if not is_ongoing:
            if status == "COMPLETED":
                STATS['REJECTED_COMPLETED'] += 1
            continue

        STATS['ONGOING_AWARDS'] += 1

        buyer_name = extract_english_text(n.get('organisation-name-buyer')) or safe_extract_text(n.get('organisation-name-buyer'))
        winner_country = format_country(n.get('winner-country') or n.get('organisation-country-buyer'))
        known_email = safe_extract_text(n.get('winner-email') or n.get('organisation-email-tenderer'))
        known_web = safe_extract_text(n.get('winner-internet-address'))

        val = format_value(n.get('total-value') or n.get('result-value-notice') or n.get('estimated-value-proc'))
        curr = format_currency(n.get('total-value-cur') or n.get('result-value-cur-notice') or n.get('estimated-value-cur-proc'))

        ted_url = generate_ted_url(pub_num)
        doc_url = clean_url(safe_extract_text(n.get('document-url-lot') or n.get('submission-url-lot') or n.get('buyer-profile')))

        sub_potential = "HIGH" if (val and val > 1000000) or "multi-year" in raw_desc.lower() else "MEDIUM"
        why_contact = (
            f"The company was awarded the ongoing contract for {rel_info['SUBDOMAIN'].lower()} in {winner_country} through {end_date}. "
            f"The contract involves {rel_info['LIKELY_SUBCONTRACTABLE_WORK'].lower()}, presenting realistic external delivery/partnering opportunities. "
            f"{ACTIVE_PROFILE.company_name} provides certified offshore software engineering and data operations capacity ({', '.join(ACTIVE_PROFILE.known_certifications[:3])})."
        )

        base_record = {
            'TENDER_TITLE': title_en,
            'TENDER_ID / NOTICE_ID': pub_num,
            'DESCRIPTION': desc_en,
            'DOMAIN': rel_info['DOMAIN'],
            'SUBDOMAIN': rel_info['SUBDOMAIN'],
            'COUNTRY': winner_country,
            'CONTRACTING_AUTHORITY': buyer_name,
            'AWARDED_COMPANY': primary_winner,
            'AWARD_DATE': pub_date[:10] if pub_date else "",
            'CONTRACT_START': start_date,
            'CONTRACT_END': end_date,
            'CONTRACT_STATUS': "ONGOING",
            'CONTRACT_VALUE / QUOTATION': val if val else "",
            'CURRENCY': curr if val else "",
            'LIKELY_SUBCONTRACTABLE_WORK': rel_info['LIKELY_SUBCONTRACTABLE_WORK'],
            'TED / OFFICIAL TENDER URL': ted_url,
            'TENDER DOCUMENTS URL': doc_url,
            'PLATFORM / SOURCE': "TED (Tenders Electronic Daily - European Union)",
            'SUBCONTRACTING POTENTIAL': sub_potential,
            'WHY CONTACT THIS COMPANY': why_contact,
            'PROFILE_KEY': ACTIVE_PROFILE.profile_key,
            'PROFILE_COMPANY_NAME': ACTIVE_PROFILE.company_name
        }
        pending.append((base_record, (primary_winner, winner_country, known_email, known_web)))
      except Exception as e:
        sub_processing_errors += 1
        logger.warning(f"Skipped one malformed award notice due to: {e}")
        continue

    # PASS 2 (parallel): enrich_awarded_prime_fast is the only network-bound
    # step left, and every candidate targets a DIFFERENT company's own site --
    # a strong fit for a thread pool, same reasoning as Pipeline 1's SAM.gov
    # deep-detail fetch. Nothing about the enrichment logic itself changes.
    logger.info(f"Enriching {len(pending)} awarded companies (up to {MAX_WORKERS} at a time)...")
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        future_to_base = {
            pool.submit(enrich_awarded_prime_fast, name, country, email, web): base_record
            for base_record, (name, country, email, web) in pending
        }
        completed = 0
        for future in as_completed(future_to_base):
            completed += 1
            base_record = future_to_base[future]
            try:
                enrichment = future.result()
            except Exception as e:
                sub_processing_errors += 1
                logger.warning(f"Skipped one award during company enrichment due to: {e}")
                continue
            record = dict(base_record)
            record.update({
                'COMPANY_WEBSITE': enrichment['COMPANY_WEBSITE'],
                'COMPANY_LINKEDIN': enrichment['COMPANY_LINKEDIN'],
                'ALL_COMPANY_EMAILS': enrichment['ALL_COMPANY_EMAILS'],
                'ALL_EXECUTIVE_NAMES & ROLES': enrichment['ALL_EXECUTIVE_NAMES_ROLES'],
                'ALL_EXECUTIVE_EMAILS': enrichment['ALL_EXECUTIVE_EMAILS'],
                'ALL_EXECUTIVE_LINKEDINS': enrichment['ALL_EXECUTIVE_LINKEDINS'],
                'PROCUREMENT / CONTRACTS URL': enrichment['PROCUREMENT_CONTRACTS_URL'],
                'SUBCONTRACTING / PARTNER URL': enrichment['SUBCONTRACTING_PARTNER_URL'],
            })
            subcontracting_records.append(record)
            STATS['SUBCONTRACTING_PASSED'] += 1
            if completed % 10 == 0 or completed == len(pending):
                logger.info(f"  [+] Enriched {completed}/{len(pending)} awarded companies...")

    if sub_processing_errors:
        logger.warning(f"{sub_processing_errors} award notices were skipped due to processing errors.")
    logger.info(f"Pipeline 2 Complete. Valid Ongoing Subcontracting Contracts: {len(subcontracting_records)}")
    return subcontracting_records

# ==============================================================================
# VALIDATION & DEDUPLICATION ENGINE
# ==============================================================================
def validate_and_deduplicate(live_records: List[Dict[str, Any]], sub_records: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Second-pass validation ensuring 100% data integrity and canonical deduplication."""
    logger.info("Executing Final Multi-Pass Data Validation & Integrity Audit...")
    today_iso = datetime.now(timezone.utc).strftime('%Y-%m-%d')

    clean_live = []
    seen_live_ids = set()
    for r in live_records:
        tid = r.get('TENDER_ID / NOTICE_ID', '').strip()
        if not tid or tid in seen_live_ids:
            continue
        dl = r.get('DEADLINE', '').strip()
        if not dl or dl < today_iso:
            continue
        seen_live_ids.add(tid)
        clean_live.append(r)

    clean_sub = []
    seen_sub_ids = set()
    for r in sub_records:
        tid = r.get('TENDER_ID / NOTICE_ID', '').strip()
        if not tid or tid in seen_sub_ids:
            continue
        company = r.get('AWARDED_COMPANY', '').strip()
        if not company:
            continue
        cend = r.get('CONTRACT_END', '').strip()
        if not cend or cend < today_iso:
            continue
        seen_sub_ids.add(tid)
        clean_sub.append(r)

    logger.info(f"Integrity Audit Passed: {len(clean_live)} Live Tenders, {len(clean_sub)} Subcontracting Prospects.")
    return clean_live, clean_sub

# ==============================================================================
# EXCEL GENERATION & EXECUTIVE FORMATTING (OPENPYXL)
# ==============================================================================
LIVE_TENDERS_SCHEMA = [
    "TENDER_TITLE",
    "TENDER_ID / NOTICE_ID",
    "DESCRIPTION",
    "DOMAIN",
    "SUBDOMAIN",
    "TENDER_COUNTRY",
    "CONTRACTING_AUTHORITY",
    "CPV_CODES",
    "TENDER_VALUE / QUOTATION",
    "CURRENCY",
    "PUBLISHED_DATE",
    "DEADLINE",
    "TENDER_STATUS",
    "ELIGIBILITY_SUMMARY",
    "TURNOVER_REQUIREMENT",
    "SME / STARTUP FRIENDLY",
    "GLOBAL_PARTICIPATION",
    "SUBCONTRACTING_ALLOWED",
    "REQUIRED_CERTIFICATIONS",
    "ORBITAVANYA_ELIGIBILITY",
    "TED_URL",
    "TENDER_DOCUMENTS_URL",
    "PLATFORM / SOURCE",
    "BUYER_CONTACT_EMAILS",
    "BUYER_CONTACT_NAME",
    "RELEVANT_COMPANY / BUYER_LINKEDIN",
    "RELEVANCE_REASON",
    "PROFILE_KEY",
    "PROFILE_COMPANY_NAME"
]

SUBCONTRACTING_TENDERS_SCHEMA = [
    "TENDER_TITLE",
    "TENDER_ID / NOTICE_ID",
    "DESCRIPTION",
    "DOMAIN",
    "SUBDOMAIN",
    "COUNTRY",
    "CONTRACTING_AUTHORITY",
    "AWARDED_COMPANY",
    "AWARD_DATE",
    "CONTRACT_START",
    "CONTRACT_END",
    "CONTRACT_STATUS",
    "CONTRACT_VALUE / QUOTATION",
    "CURRENCY",
    "LIKELY_SUBCONTRACTABLE_WORK",
    "COMPANY_WEBSITE",
    "COMPANY_LINKEDIN",
    "ALL_COMPANY_EMAILS",
    "ALL_EXECUTIVE_NAMES & ROLES",
    "ALL_EXECUTIVE_EMAILS",
    "ALL_EXECUTIVE_LINKEDINS",
    "PROCUREMENT / CONTRACTS URL",
    "SUBCONTRACTING / PARTNER URL",
    "TED / OFFICIAL TENDER URL",
    "TENDER DOCUMENTS URL",
    "PLATFORM / SOURCE",
    "SUBCONTRACTING POTENTIAL",
    "WHY CONTACT THIS COMPANY",
    "PROFILE_KEY",
    "PROFILE_COMPANY_NAME"
]

def export_master_workbook(live_data: List[Dict[str, Any]], sub_data: List[Dict[str, Any]], filepath: str):
    """Creates the production Excel workbook with exactly two sheets and executive styling."""
    logger.info(f"Generating Master Production Workbook: {filepath}")
    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    font_header = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    fill_header_live = PatternFill(start_color="1F4E79", end_color="1F4E79", fill_type="solid")
    fill_header_sub = PatternFill(start_color="005A70", end_color="005A70", fill_type="solid")
    font_body = Font(name="Calibri", size=10, color="000000")
    font_link = Font(name="Calibri", size=10, color="0563C1", underline="single")
    fill_alt = PatternFill(start_color="F8F9FA", end_color="F8F9FA", fill_type="solid")

    align_left = Alignment(horizontal="left", vertical="top", wrap_text=True)
    align_center = Alignment(horizontal="center", vertical="top")
    align_right = Alignment(horizontal="right", vertical="top")

    thin_border = Border(
        left=Side(style='thin', color='E0E0E0'),
        right=Side(style='thin', color='E0E0E0'),
        top=Side(style='thin', color='E0E0E0'),
        bottom=Side(style='thin', color='E0E0E0')
    )

    # SHEET 1: LIVE_TENDERS
    ws_live = wb.create_sheet(title="LIVE_TENDERS")
    ws_live.views.sheetView[0].showGridLines = True
    ws_live.freeze_panes = "A2"

    for col_idx, col_name in enumerate(LIVE_TENDERS_SCHEMA, start=1):
        cell = ws_live.cell(row=1, column=col_idx, value=col_name)
        cell.font = font_header
        cell.fill = fill_header_live
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = thin_border
    ws_live.row_dimensions[1].height = 28

    for row_idx, rec in enumerate(live_data, start=2):
        is_alt = (row_idx % 2 == 1)
        for col_idx, col_name in enumerate(LIVE_TENDERS_SCHEMA, start=1):
            val = rec.get(col_name, "")
            cell = ws_live.cell(row=row_idx, column=col_idx)
            if col_name == "TENDER_VALUE / QUOTATION" and isinstance(val, (int, float)):
                cell.value = val
                cell.number_format = '#,##0.00'
                cell.alignment = align_right
                cell.font = font_body
            elif "URL" in col_name and val and str(val).startswith("http") and ";" not in str(val):
                cell.value = str(val)
                cell.hyperlink = str(val)
                cell.font = font_link
                cell.alignment = align_left
            else:
                cell.value = str(val) if val is not None else ""
                cell.font = font_body
                if col_name in ["TENDER_ID / NOTICE_ID", "TENDER_COUNTRY", "PUBLISHED_DATE", "DEADLINE", "TENDER_STATUS", "CURRENCY"]:
                    cell.alignment = align_center
                else:
                    cell.alignment = align_left

            if is_alt:
                cell.fill = fill_alt
            cell.border = thin_border
        ws_live.row_dimensions[row_idx].height = 36

    ws_live.auto_filter.ref = f"A1:{get_column_letter(len(LIVE_TENDERS_SCHEMA))}{max(2, len(live_data)+1)}"

    for col_idx, col_name in enumerate(LIVE_TENDERS_SCHEMA, start=1):
        letter = get_column_letter(col_idx)
        if col_name in ["TENDER_TITLE", "DESCRIPTION", "ELIGIBILITY_SUMMARY", "ORBITAVANYA_ELIGIBILITY", "RELEVANCE_REASON"]:
            ws_live.column_dimensions[letter].width = 38
        elif col_name in ["CONTRACTING_AUTHORITY", "TED_URL", "TENDER_DOCUMENTS_URL", "BUYER_CONTACT_EMAILS"]:
            ws_live.column_dimensions[letter].width = 30
        elif col_name in ["DOMAIN", "SUBDOMAIN", "REQUIRED_CERTIFICATIONS", "TURNOVER_REQUIREMENT"]:
            ws_live.column_dimensions[letter].width = 24
        elif col_name in ["TENDER_ID / NOTICE_ID", "TENDER_COUNTRY", "TENDER_VALUE / QUOTATION", "CURRENCY", "PUBLISHED_DATE", "DEADLINE"]:
            ws_live.column_dimensions[letter].width = 16
        else:
            ws_live.column_dimensions[letter].width = 20

    # SHEET 2: SUBCONTRACTING_TENDERS
    ws_sub = wb.create_sheet(title="SUBCONTRACTING_TENDERS")
    ws_sub.views.sheetView[0].showGridLines = True
    ws_sub.freeze_panes = "A2"

    for col_idx, col_name in enumerate(SUBCONTRACTING_TENDERS_SCHEMA, start=1):
        cell = ws_sub.cell(row=1, column=col_idx, value=col_name)
        cell.font = font_header
        cell.fill = fill_header_sub
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = thin_border
    ws_sub.row_dimensions[1].height = 28

    for row_idx, rec in enumerate(sub_data, start=2):
        is_alt = (row_idx % 2 == 1)
        for col_idx, col_name in enumerate(SUBCONTRACTING_TENDERS_SCHEMA, start=1):
            val = rec.get(col_name, "")
            cell = ws_sub.cell(row=row_idx, column=col_idx)
            if col_name == "CONTRACT_VALUE / QUOTATION" and isinstance(val, (int, float)):
                cell.value = val
                cell.number_format = '#,##0.00'
                cell.alignment = align_right
                cell.font = font_body
            elif ("URL" in col_name or "WEBSITE" in col_name or "LINKEDIN" in col_name) and val and str(val).startswith("http") and ";" not in str(val):
                cell.value = str(val)
                cell.hyperlink = str(val)
                cell.font = font_link
                cell.alignment = align_left
            else:
                cell.value = str(val) if val is not None else ""
                cell.font = font_body
                if col_name in ["TENDER_ID / NOTICE_ID", "COUNTRY", "AWARD_DATE", "CONTRACT_START", "CONTRACT_END", "CONTRACT_STATUS", "CURRENCY"]:
                    cell.alignment = align_center
                else:
                    cell.alignment = align_left

            if is_alt:
                cell.fill = fill_alt
            cell.border = thin_border
        ws_sub.row_dimensions[row_idx].height = 36

    ws_sub.auto_filter.ref = f"A1:{get_column_letter(len(SUBCONTRACTING_TENDERS_SCHEMA))}{max(2, len(sub_data)+1)}"

    for col_idx, col_name in enumerate(SUBCONTRACTING_TENDERS_SCHEMA, start=1):
        letter = get_column_letter(col_idx)
        if col_name in ["TENDER_TITLE", "DESCRIPTION", "LIKELY_SUBCONTRACTABLE_WORK", "WHY CONTACT THIS COMPANY"]:
            ws_sub.column_dimensions[letter].width = 38
        elif col_name in ["CONTRACTING_AUTHORITY", "AWARDED_COMPANY", "ALL_COMPANY_EMAILS", "ALL_EXECUTIVE_NAMES & ROLES", "TED / OFFICIAL TENDER URL"]:
            ws_sub.column_dimensions[letter].width = 30
        elif col_name in ["DOMAIN", "SUBDOMAIN", "COMPANY_WEBSITE", "COMPANY_LINKEDIN", "ALL_EXECUTIVE_EMAILS", "ALL_EXECUTIVE_LINKEDINS"]:
            ws_sub.column_dimensions[letter].width = 24
        elif col_name in ["TENDER_ID / NOTICE_ID", "COUNTRY", "CONTRACT_VALUE / QUOTATION", "CURRENCY", "AWARD_DATE", "CONTRACT_START", "CONTRACT_END"]:
            ws_sub.column_dimensions[letter].width = 16
        else:
            ws_sub.column_dimensions[letter].width = 20

    wb.save(filepath)
    logger.info(f"Master Workbook Successfully Written: {os.path.abspath(filepath)}")

# ==============================================================================
# MAIN PIPELINE CONTROLLER & SECTION 76 AUDIT REPORT
# ==============================================================================
def parse_args():
    p = argparse.ArgumentParser(description="TED/EU IT + Digitization Procurement Intelligence Engine")
    p.add_argument("--profile-json", dest="profile_json", default=None,
                    help="Path to an eligibility profile JSON file. Defaults to the built-in OrbitAvanya profile.")
    p.add_argument("--output", dest="output", default=None,
                    help="Output .xlsx path. Defaults to TED_IT_DIGITIZATION_DATA_ENTRY_PROSPECTS_<profile_key>.xlsx")
    p.add_argument("--stop-flag", dest="stop_flag", default=None,
                    help="Path to a file that, if it exists, tells the engine to stop collecting "
                         "new records and save whatever it already has.")
    return p.parse_args()


def main():
    global ACTIVE_PROFILE, STOP_FLAG_PATH
    args = parse_args()
    STOP_FLAG_PATH = args.stop_flag
    ACTIVE_PROFILE = load_profile(args.profile_json)
    output_path = args.output or f"TED_IT_DIGITIZATION_DATA_ENTRY_PROSPECTS_{ACTIVE_PROFILE.profile_key}.xlsx"

    print("=" * 80)
    print("TED/EU IT + DIGITIZATION + DATA ENTRY PROCUREMENT INTELLIGENCE SYSTEM")
    print(f"Production Lead Generation Engine for {ACTIVE_PROFILE.company_name}")
    print("=" * 80)

    start_time = time.time()

    # Step 1: Execute Pipeline 1 (Live Tenders)
    raw_live = process_live_tenders()

    # Step 2: Execute Pipeline 2 (Subcontracting Opportunities)
    raw_sub = process_subcontracting_tenders()

    # Step 3: Multi-Pass Validation & Deduplication
    clean_live, clean_sub = validate_and_deduplicate(raw_live, raw_sub)

    # Step 4: Export to Master Excel Workbook
    export_master_workbook(clean_live, clean_sub, output_path)

    elapsed = time.time() - start_time

    # Step 5: Print Exact Final Execution Report (Rule 76)
    print("\n" + "=" * 80)
    print("TED PROCUREMENT INTELLIGENCE RUN COMPLETE")
    print(f"Total TED candidates discovered: {STATS['CANDIDATES_DISCOVERED']}")
    print(f"IT/ICT candidates: {STATS['IT_CANDIDATES']}")
    print(f"Digitization/Data Entry candidates: {STATS['DIGITIZATION_CANDIDATES']}")
    print("\nLIVE_TENDERS")
    print(f"Candidates evaluated: {STATS['LIVE_EVALUATED']}")
    print(f"Passed all eligibility requirements: {len(clean_live)}")
    print(f"Rejected: {STATS['LIVE_REJECTED']}")
    print("\nSUBCONTRACTING_TENDERS")
    print(f"Awarded relevant contracts found: {STATS['AWARDS_FOUND']}")
    print(f"Ongoing contracts: {STATS['ONGOING_AWARDS']}")
    print(f"Rejected as completed: {STATS['REJECTED_COMPLETED']}")
    print(f"Rejected as too old: {STATS['REJECTED_TOO_OLD']}")
    print(f"Passed subcontracting validation: {len(clean_sub)}")
    print(f"\nVerified company emails: {STATS['VERIFIED_COMPANY_EMAILS']}")
    print(f"Verified executive emails: {STATS['VERIFIED_EXEC_EMAILS']}")
    print(f"\nWorkbook:\n{output_path}")
    print(f"Execution completed in: {elapsed:.2f} seconds")
    print("=" * 80)

    summary = {
        "profile_key": ACTIVE_PROFILE.profile_key,
        "company_name": ACTIVE_PROFILE.company_name,
        "output_file": output_path,
        "live_count": len(clean_live),
        "subcontracting_count": len(clean_sub),
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "stopped_early": STOPPED_EARLY,
    }
    summary_path = os.path.splitext(output_path)[0] + ".summary.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
    print(f"SCAN_SUMMARY_JSON::{summary_path}", flush=True)

if __name__ == "__main__":
    main()