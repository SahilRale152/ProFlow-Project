-- ============================================================
-- OrbitAvanya CRM — "Scanning & Digitization" Module Schema
-- ============================================================
-- Adds:
--   1) digitization_eligibility_profiles  (customisable per company)
--   2) digitization_tenders_live          (SAM.gov LIVE_TENDERS sheet)
--   3) digitization_tenders_subcontracting (SAM.gov SUBCONTRACTING_TENDERS sheet)
--   4) digitization_scan_runs             (history/status of each "Run Scan")
--   5) proposal_files patch               (link a generated proposal back to a
--                                           digitization tender, same pattern as
--                                           the existing tender_customer_id link)
--
-- Safe to run top-to-bottom on a DB that already has the base schema from
-- tender_customers.sql. Everything is IF NOT EXISTS / idempotent.
-- ============================================================

BEGIN;

-- ---------- 1) Eligibility profiles (one company = one profile) ----------
CREATE TABLE IF NOT EXISTS digitization_eligibility_profiles (
    id BIGSERIAL PRIMARY KEY,
    profile_key TEXT NOT NULL UNIQUE,        -- slug, e.g. 'orbitavanya', 'acme-scan-co'
    company_name TEXT NOT NULL,
    certifications JSONB NOT NULL DEFAULT '[]'::jsonb,
    core_services JSONB NOT NULL DEFAULT '[]'::jsonb,
    search_queries JSONB NOT NULL DEFAULT '[]'::jsonb,
    relevant_naics JSONB NOT NULL DEFAULT '[]'::jsonb,
    relevant_psc JSONB NOT NULL DEFAULT '[]'::jsonb,
    exclusion_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- { "regex pattern to match in tender text": "label shown if this company holds it" }
    certification_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_sme BOOLEAN NOT NULL DEFAULT TRUE,
    -- [ { match, label, eligibility, score, international_note } ]
    hard_disqualifier_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    default_eligibility TEXT NOT NULL DEFAULT 'HIGH',
    default_score INTEGER NOT NULL DEFAULT 90,
    default_international_note TEXT,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one profile may be the default (pre-selected in the UI / used when no
-- profile is specified for a scan).
CREATE UNIQUE INDEX IF NOT EXISTS idx_digitization_profiles_one_default
    ON digitization_eligibility_profiles (is_default)
    WHERE is_default;

-- Idempotent upgrade path: if these tables already exist from an earlier
-- (SAM.gov-only) version of this migration, add the new source column.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'digitization_tenders_live') THEN
        ALTER TABLE digitization_tenders_live ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'SAM';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'digitization_tenders_subcontracting') THEN
        ALTER TABLE digitization_tenders_subcontracting ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'SAM';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'digitization_scan_runs') THEN
        ALTER TABLE digitization_scan_runs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'SAM';
    END IF;
END $$;

-- Seed the OrbitAvanya profile from the engine's built-in defaults so the
-- module works immediately, before anyone opens "Manage Eligibility Profiles".
INSERT INTO digitization_eligibility_profiles (
    profile_key, company_name, certifications, core_services,
    is_sme, default_eligibility, default_score, default_international_note, is_default
)
VALUES (
    'orbitavanya',
    'OrbitAvanya Tech LLP',
    '["ISO 9001:2015","ISO 14001:2015","ISO 27001","ISO 45001","ISO/IEC 20000-1:2018","ISO 19005-1 (PDF/A)","ISO 22301","GDPR Compliance","CMMI Maturity Level 3","SOC 2 Type II Compliance","UN Global Compact (ID: 221221)"]'::jsonb,
    '["High-Volume Document Scanning & Digitization","OCR, Automated Data Capture & Metadata Indexing","Manual & Electronic Data Entry, Form Processing & Abstraction","Records Management & Electronic Document Conversion","Archival Digitization, Heritage Records & Microfilm/Microfiche Scanning","PDF/A Long-Term Digital Preservation (ISO 19005-1 Compliance)","Legal, Medical & Administrative Document Transcription"]'::jsonb,
    TRUE, 'HIGH', 90,
    'Subcontracting & Teaming Route Recommended (Direct bidding subject to FAR international vendor guidelines)',
    TRUE
)
ON CONFLICT (profile_key) DO NOTHING;

-- ---------- 2) LIVE_TENDERS (from SAM.gov opportunities) ----------
CREATE TABLE IF NOT EXISTS digitization_tenders_live (
    id BIGSERIAL PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,   -- source::profile_key::live::notice_id
    source TEXT NOT NULL DEFAULT 'SAM' CHECK (source IN ('SAM','TED','UK')),
    profile_key TEXT NOT NULL REFERENCES digitization_eligibility_profiles(profile_key) ON DELETE CASCADE,
    tender_title TEXT NOT NULL,
    notice_id TEXT,
    solicitation_number TEXT,
    notice_type TEXT,
    status TEXT,
    agency TEXT,
    subagency TEXT,
    contracting_office TEXT,
    posted_date TEXT,
    response_deadline TEXT,
    estimated_value TEXT,
    currency TEXT,
    domain TEXT,
    subdomain TEXT,
    relevance_score INTEGER,
    description TEXT,
    scope_summary TEXT,
    location TEXT,
    set_aside_type TEXT,
    naics_code TEXT,
    psc_code TEXT,
    eligibility TEXT,
    eligibility_score INTEGER,
    turnover_requirement TEXT,
    startup_sme_friendly TEXT,
    certification_compatibility TEXT,
    international_eligibility TEXT,
    key_disqualifiers TEXT,
    contracting_officer_contact TEXT,
    sam_url TEXT,
    tender_document_url TEXT,
    all_document_urls TEXT,
    source_platform TEXT,
    verification_status TEXT,
    raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    selected_for_proposal BOOLEAN NOT NULL DEFAULT FALSE,
    proposal_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (proposal_status IN ('pending','done')),
    last_proposal_id INTEGER,
    proposal_created_at TIMESTAMPTZ,
    source_workbook TEXT,
    source_sheet TEXT,
    source_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_digitization_live_profile ON digitization_tenders_live (profile_key);
CREATE INDEX IF NOT EXISTS idx_digitization_live_source ON digitization_tenders_live (source);
CREATE INDEX IF NOT EXISTS idx_digitization_live_status ON digitization_tenders_live (proposal_status);
CREATE INDEX IF NOT EXISTS idx_digitization_live_deadline ON digitization_tenders_live (response_deadline);
CREATE INDEX IF NOT EXISTS idx_digitization_live_title ON digitization_tenders_live (LOWER(tender_title));

-- ---------- 3) SUBCONTRACTING_TENDERS (from USAspending prime-contractor awards) ----------
CREATE TABLE IF NOT EXISTS digitization_tenders_subcontracting (
    id BIGSERIAL PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,   -- source::profile_key::sub::notice_id
    source TEXT NOT NULL DEFAULT 'SAM' CHECK (source IN ('SAM','TED','UK')),
    profile_key TEXT NOT NULL REFERENCES digitization_eligibility_profiles(profile_key) ON DELETE CASCADE,
    contract_title TEXT NOT NULL,
    award_number TEXT,
    notice_id TEXT,
    prime_contractor TEXT,
    legal_company_name TEXT,
    uei TEXT,
    cage_code TEXT,
    agency TEXT,
    subagency TEXT,
    contracting_office TEXT,
    award_date TEXT,
    contract_start_date TEXT,
    contract_end_date TEXT,
    period_of_performance TEXT,
    award_value TEXT,
    total_contract_value TEXT,
    currency TEXT,
    domain TEXT,
    subdomain TEXT,
    relevance_score INTEGER,
    description TEXT,
    subcontracting_scope_relevance TEXT,
    official_website TEXT,
    company_linkedin TEXT,
    company_emails TEXT,
    executive_names_and_roles TEXT,
    executive_emails TEXT,
    executive_linkedins TEXT,
    procurement_url TEXT,
    subcontracting_url TEXT,
    supplier_vendor_url TEXT,
    partner_teaming_url TEXT,
    sam_url TEXT,
    usaspending_award_url TEXT,
    tender_document_url TEXT,
    source_platform TEXT,
    verification_evidence TEXT,
    raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    selected_for_proposal BOOLEAN NOT NULL DEFAULT FALSE,
    proposal_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (proposal_status IN ('pending','done')),
    last_proposal_id INTEGER,
    proposal_created_at TIMESTAMPTZ,
    source_workbook TEXT,
    source_sheet TEXT,
    source_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_digitization_sub_profile ON digitization_tenders_subcontracting (profile_key);
CREATE INDEX IF NOT EXISTS idx_digitization_sub_source ON digitization_tenders_subcontracting (source);
CREATE INDEX IF NOT EXISTS idx_digitization_sub_status ON digitization_tenders_subcontracting (proposal_status);
CREATE INDEX IF NOT EXISTS idx_digitization_sub_prime ON digitization_tenders_subcontracting (LOWER(prime_contractor));

-- ---------- 4) Scan run history (drives the "Run Scan" button + status) ----------
CREATE TABLE IF NOT EXISTS digitization_scan_runs (
    id BIGSERIAL PRIMARY KEY,
    profile_key TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'SAM' CHECK (source IN ('SAM','TED','UK')),
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','success','failed')),
    triggered_by TEXT,
    output_file TEXT,
    live_count INTEGER,
    subcontracting_count INTEGER,
    error_message TEXT,
    log_tail TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_digitization_scan_runs_profile ON digitization_scan_runs (profile_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_digitization_scan_runs_source ON digitization_scan_runs (source);

-- ---------- 5) proposal_files patch: link proposals back to a digitization tender ----------
-- Mirrors the existing tender_customer_id pattern. Only runs if proposal_files exists.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'proposal_files') THEN
        ALTER TABLE proposal_files
            ADD COLUMN IF NOT EXISTS digitization_live_tender_id BIGINT;
        ALTER TABLE proposal_files
            ADD COLUMN IF NOT EXISTS digitization_subcontracting_tender_id BIGINT;

        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'proposal_files_digitization_live_fkey'
        ) THEN
            ALTER TABLE proposal_files
                ADD CONSTRAINT proposal_files_digitization_live_fkey
                FOREIGN KEY (digitization_live_tender_id)
                REFERENCES digitization_tenders_live(id)
                ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'proposal_files_digitization_sub_fkey'
        ) THEN
            ALTER TABLE proposal_files
                ADD CONSTRAINT proposal_files_digitization_sub_fkey
                FOREIGN KEY (digitization_subcontracting_tender_id)
                REFERENCES digitization_tenders_subcontracting(id)
                ON DELETE SET NULL;
        END IF;

        CREATE INDEX IF NOT EXISTS idx_proposal_files_digitization_live
            ON proposal_files(digitization_live_tender_id);
        CREATE INDEX IF NOT EXISTS idx_proposal_files_digitization_sub
            ON proposal_files(digitization_subcontracting_tender_id);
    END IF;
END $$;

COMMIT;

-- ---------- verification ----------
SELECT 'digitization_eligibility_profiles' AS table_name, COUNT(*) AS record_count FROM digitization_eligibility_profiles
UNION ALL SELECT 'digitization_tenders_live', COUNT(*) FROM digitization_tenders_live
UNION ALL SELECT 'digitization_tenders_subcontracting', COUNT(*) FROM digitization_tenders_subcontracting
UNION ALL SELECT 'digitization_scan_runs', COUNT(*) FROM digitization_scan_runs;