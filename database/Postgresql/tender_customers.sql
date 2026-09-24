-- ============================================================
-- OrbitAvanya CRM — Combined PostgreSQL Schema (v2 + Migration 2)
-- ============================================================
-- This file merges:
--   1) orbitavanya_schema_fixed.sql   (base schema + the text[]->jsonb fix)
--   2) 02_research_normalized_schema.sql (normalized research chain: 
--      Finding -> Pain Point -> Opportunity -> Proposal Recommendation,
--      + Sources + Excel export tracking + dedup via is_latest)
--
-- Safe to run top-to-bottom on either a fresh database or one that already
-- has some/all of these objects (everything is IF NOT EXISTS / idempotent).
-- Run ROLLBACK once first if a previous attempt failed mid-transaction.
-- ============================================================

BEGIN;


CREATE TABLE IF NOT EXISTS tender_customers (
    id BIGSERIAL PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    company_name TEXT NOT NULL,
    legal_company_name TEXT,
    company_number TEXT,
    official_website TEXT,
    linkedin_url TEXT,
    company_emails TEXT,
    executive_name TEXT,
    executive_role TEXT,
    executive_email TEXT,
    procurement_url TEXT,
    procurement_emails TEXT,
    supplier_url TEXT,
    supplier_emails TEXT,
    subcontracting_url TEXT,
    subcontracting_emails TEXT,
    teaming_url TEXT,
    teaming_emails TEXT,
    partnership_url TEXT,
    partnership_emails TEXT,
    primary_domain TEXT,
    tender_domain TEXT,
    tender_subdomain TEXT,
    tender_count INTEGER NOT NULL DEFAULT 0,
    raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    tender_data JSONB NOT NULL DEFAULT '[]'::jsonb,
    proposal_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (proposal_status IN ('pending','done')),
    last_proposal_id INTEGER,
    proposal_created_at TIMESTAMPTZ,
    source_workbook TEXT,
    source_sheet TEXT,
    source_row_count INTEGER NOT NULL DEFAULT 0,
    source_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tender_customers_name
    ON tender_customers (LOWER(company_name));

CREATE INDEX IF NOT EXISTS idx_tender_customers_company_number
    ON tender_customers (company_number);

CREATE INDEX IF NOT EXISTS idx_tender_customers_status
    ON tender_customers (proposal_status);

CREATE INDEX IF NOT EXISTS idx_tender_customers_domain
    ON tender_customers (tender_domain);

-- proposal_files may not exist in a fresh DB; only patch it if it does.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'proposal_files') THEN
        ALTER TABLE proposal_files
            ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'crm_customer';
        ALTER TABLE proposal_files
            ADD COLUMN IF NOT EXISTS tender_customer_id BIGINT;

        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'proposal_files_tender_customer_id_fkey'
        ) THEN
            ALTER TABLE proposal_files
                ADD CONSTRAINT proposal_files_tender_customer_id_fkey
                FOREIGN KEY (tender_customer_id)
                REFERENCES tender_customers(id)
                ON DELETE SET NULL;
        END IF;

        CREATE INDEX IF NOT EXISTS idx_proposal_files_tender_customer
            ON proposal_files(tender_customer_id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS tender_customer_proposals (
    id BIGSERIAL PRIMARY KEY,
    tender_customer_id BIGINT NOT NULL
        REFERENCES tender_customers(id) ON DELETE CASCADE,
    proposal_id INTEGER,
    proposal_number TEXT NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only add the FK to proposal_files if that table exists.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'proposal_files')
       AND NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'tender_customer_proposals_proposal_id_fkey'
       ) THEN
        ALTER TABLE tender_customer_proposals
            ADD CONSTRAINT tender_customer_proposals_proposal_id_fkey
            FOREIGN KEY (proposal_id) REFERENCES proposal_files(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tender_customer_proposals_customer
    ON tender_customer_proposals(tender_customer_id);

CREATE INDEX IF NOT EXISTS idx_tender_customer_proposals_created
    ON tender_customer_proposals(created_at DESC);

CREATE TABLE IF NOT EXISTS tender_import_runs (
    id BIGSERIAL PRIMARY KEY,
    source_workbook TEXT NOT NULL,
    source_sheet TEXT NOT NULL,
    company_count INTEGER NOT NULL DEFAULT 0,
    row_count INTEGER NOT NULL DEFAULT 0,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tender_import_runs_imported
    ON tender_import_runs(imported_at DESC);

CREATE TABLE IF NOT EXISTS company_research (
    id SERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    company_id INTEGER NOT NULL,
    company_name TEXT NOT NULL,
    summary TEXT,
    pain_points JSONB DEFAULT '[]'::jsonb,
    recommended_services JSONB DEFAULT '[]'::jsonb,
    recommended_pricing_tier TEXT,
    proposal_intro TEXT,
    raw_response JSONB,
    model TEXT,
    web_sources JSONB DEFAULT '[]'::jsonb,
    detailed_report TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE company_research ADD COLUMN IF NOT EXISTS web_sources JSONB DEFAULT '[]'::jsonb;
ALTER TABLE company_research ADD COLUMN IF NOT EXISTS pain_points JSONB DEFAULT '[]'::jsonb;
ALTER TABLE company_research ADD COLUMN IF NOT EXISTS recommended_services JSONB DEFAULT '[]'::jsonb;
ALTER TABLE company_research ADD COLUMN IF NOT EXISTS detailed_report TEXT;

CREATE INDEX IF NOT EXISTS idx_company_research_lookup
    ON company_research(source, company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS company_profile (
    id INTEGER PRIMARY KEY DEFAULT 1,
    company_name TEXT,
    legal_name TEXT,
    tagline TEXT,
    description TEXT,
    registered_office TEXT,
    website TEXT,
    portfolio_url TEXT,
    email TEXT,
    phone TEXT,
    leadership_name TEXT,
    leadership_title TEXT,
    core_services JSONB,
    why_choose_us JSONB,
    certifications JSONB,
    registrations JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS tagline TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS registered_office TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS portfolio_url TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS leadership_name TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS leadership_title TEXT;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS core_services JSONB;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS why_choose_us JSONB;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS certifications JSONB;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS registrations JSONB;
ALTER TABLE company_profile ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- *** THE ACTUAL FIX ***
-- These four columns may already exist on your DB as TEXT[] (array) from an
-- older version of this script. ADD COLUMN IF NOT EXISTS above is a no-op on
-- a column that already exists, so it never changed the type. Convert them
-- to JSONB now, translating any existing array data instead of discarding it.
DO $$
DECLARE
    col TEXT;
BEGIN
    FOREACH col IN ARRAY ARRAY['core_services', 'why_choose_us', 'certifications', 'registrations']
    LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'company_profile'
              AND column_name = col
              AND data_type <> 'jsonb'
        ) THEN
            EXECUTE format(
                'ALTER TABLE company_profile ALTER COLUMN %I TYPE JSONB USING to_jsonb(%I)',
                col, col
            );
        END IF;
    END LOOP;
END $$;

INSERT INTO company_profile (
    id, company_name, legal_name, tagline, description,
    registered_office, website, portfolio_url, email, phone,
    leadership_name, leadership_title, core_services,
    why_choose_us, certifications, registrations
)
VALUES (
    1,
    'OrbitAvanya Tech',
    'OrbitAvanya Tech LLP (AvanyaEdge)',
    'Secure, scalable, and future-ready technology platforms for government and enterprise digital transformation.',
    'OrbitAvanya Tech LLP (AvanyaEdge) is an ISO-certified technology consulting and digital transformation company specializing in enterprise software solutions, workflow automation systems, ERP platforms, AI-enabled applications, and government-oriented digital solutions. Headquartered in Mumbai, Maharashtra, the company focuses on delivering secure, scalable, innovative, and future-ready technology platforms for government departments, enterprises, educational institutions, and organizations across multiple sectors. OrbitAvanya Tech LLP is a Registered U.S. Government Contractor and Government e-Marketplace (GeM) Registered Seller.',
    'Shastri Nagar CHS, Vashi Naka, Near Hanuman Mandir, Chembur, Mumbai – 400074, Maharashtra, India',
    'www.orbitavanyatech.com',
    'portfolio.orbitavanyatech.com',
    'info@orbitavanyatech.com',
    '+91 7021950643',
    'Pradeep Kumar Singh',
    'Director, Microsoft Certified Developer & AI Expert',
    '["Enterprise Application Development","Workflow Automation Systems","Contractor Management Systems (CMS)","ERP & LMS Solutions","E-Governance Platforms","AI-Powered Applications","Cloud & Infrastructure Services","API & Third-Party Integrations"]'::jsonb,
    '["Registered U.S. Government Contractor","GeM Registered Seller","ISO 9001 & ISO/IEC 27001 Certified","GDPR Compliance Ready","CMMI Level 3 Process-Oriented Organization","Expertise in Government Digital Transformation Projects","Secure & Scalable Technology Architecture","End-to-End Project Implementation","Dedicated Technical & Support Team","Long-Term Operations & Maintenance Support"]'::jsonb,
    '["ISO 9001:2015 Certified","ISO/IEC 27001:2022 Certified","GDPR Compliance Ready","CMMI Level 3 Process-Oriented Organization"]'::jsonb,
    '{"UEI":"D19VM1JR7MN9","NATO Cage Code":"7719Y","D-U-N-S Number":"772678096","Skill India TP ID":"321291","GeM Seller ID":"MZKP2500129966592345"}'::jsonb
)
ON CONFLICT (id)
DO UPDATE SET
    company_name = EXCLUDED.company_name,
    legal_name = EXCLUDED.legal_name,
    tagline = EXCLUDED.tagline,
    description = EXCLUDED.description,
    registered_office = EXCLUDED.registered_office,
    website = EXCLUDED.website,
    portfolio_url = EXCLUDED.portfolio_url,
    email = EXCLUDED.email,
    phone = EXCLUDED.phone,
    leadership_name = EXCLUDED.leadership_name,
    leadership_title = EXCLUDED.leadership_title,
    core_services = EXCLUDED.core_services,
    why_choose_us = EXCLUDED.why_choose_us,
    certifications = EXCLUDED.certifications,
    registrations = EXCLUDED.registrations,
    updated_at = NOW();

CREATE TABLE IF NOT EXISTS pricing_catalog (
    id SERIAL PRIMARY KEY,
    service_name TEXT NOT NULL,
    starting_price TEXT,
    delivery_time TEXT,
    amc TEXT
);

ALTER TABLE pricing_catalog ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE pricing_catalog ADD COLUMN IF NOT EXISTS category TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS pricing_catalog_service_name_key
    ON pricing_catalog(service_name);

INSERT INTO pricing_catalog (
    service_name, starting_price, currency, delivery_time, amc, category
)
VALUES
('CRM Development','40000','USD','8–16 Weeks','18%/Year','core'),
('ERP Development','120000','USD','4–8 Months','20%/Year','core'),
('HRMS','35000','USD','8–12 Weeks','18%/Year','core'),
('Inventory Management','30000','USD','6–10 Weeks','18%/Year','core'),
('Hospital Management System','150000','USD','5–9 Months','20%/Year','core'),
('School ERP','50000','USD','10–16 Weeks','18%/Year','core'),
('Accounting Software','45000','USD','8–14 Weeks','18%/Year','core'),
('Billing Software','20000','USD','4–8 Weeks','15%/Year','core'),
('POS System','25000','USD','6–10 Weeks','15%/Year','core'),
('Business Website (5–10 Pages)','8000','USD','2–4 Weeks','15%/Year','core'),
('Corporate Website','20000','USD','4–8 Weeks','15%/Year','core'),
('Government Portal','80000','USD','3–6 Months','20%/Year','core'),
('E-commerce Website','35000','USD','8–16 Weeks','18%/Year','core'),
('Custom Web Portal','50000','USD','10–20 Weeks','20%/Year','core'),
('Android App','20000','USD','8–12 Weeks','18%/Year','core'),
('iOS App','25000','USD','8–14 Weeks','18%/Year','core'),
('Flutter App','30000','USD','10–16 Weeks','18%/Year','core'),
('React Native App','30000','USD','10–16 Weeks','18%/Year','core'),
('Enterprise Mobile App','60000','USD','3–6 Months','20%/Year','core'),
('Document Management System','120000','USD','4–7 Months','18%/Year','core'),
('Scanning & Digitization','$0.10–$1.00','USD','Volume-Based','Optional','core'),
('OCR & Metadata Indexing','35000','USD','6–10 Weeks','15%/Year','core'),
('Digital Archiving','90000','USD','3–6 Months','18%/Year','core'),
('UI/UX Design','12000','USD','3–6 Weeks','Optional','core'),
('Figma Prototype','8000','USD','2–4 Weeks','Optional','core'),
('AVANYA AI LMS','150000','USD','4–8 Months','20%/Year','core'),
('AVANYA AI ERP','250000','USD','6–12 Months','20%/Year','core'),
('Multi-Tenant SaaS Architecture','40000+','USD',NULL,NULL,'addon'),
('SCORM/xAPI Integration','10000+','USD',NULL,NULL,'addon'),
('Video Streaming Platform Integration','15000+','USD',NULL,NULL,'addon'),
('SAP / Oracle / Microsoft Dynamics Integration','40000+','USD',NULL,NULL,'addon'),
('API & Third-Party Integrations','5000+ per integration','USD',NULL,NULL,'addon'),
('Data Migration','8000+','USD',NULL,NULL,'addon'),
('Progressive Web App (PWA)','8000+','USD',NULL,NULL,'addon'),
('CMS Integration','3000+','USD',NULL,NULL,'addon'),
('Payment Gateway Integration','2500+','USD',NULL,NULL,'addon'),
('API Integration','2000+ per API','USD',NULL,NULL,'addon')
ON CONFLICT (service_name)
DO UPDATE SET
    starting_price = EXCLUDED.starting_price,
    currency = EXCLUDED.currency,
    delivery_time = EXCLUDED.delivery_time,
    amc = EXCLUDED.amc,
    category = EXCLUDED.category;

-- ============================================================
-- Part 2: normalized research schema (findings, pain points,
-- opportunities, proposal recommendations, sources, excel log)
-- ============================================================


-- ---------- extend company_research (the "research run" header) ----------
ALTER TABLE company_research ADD COLUMN IF NOT EXISTS is_latest BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE company_research ADD COLUMN IF NOT EXISTS company_category TEXT;
ALTER TABLE company_research ADD COLUMN IF NOT EXISTS company_needs_summary TEXT;
ALTER TABLE company_research ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- *** THE FIX FOR 25P02 ***
-- If company_research already had multiple runs per company (history from
-- before this migration), the ADD COLUMN above just defaulted every one of
-- them to is_latest = TRUE. The unique index below requires exactly ONE
-- TRUE per (source, company_id), so building it would fail with a
-- duplicate-key violation. Backfill it correctly first: only the most
-- recent run per company stays TRUE, everything older becomes FALSE.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY source, company_id ORDER BY created_at DESC, id DESC) AS rn
    FROM company_research
)
UPDATE company_research cr
SET is_latest = (ranked.rn = 1)
FROM ranked
WHERE cr.id = ranked.id
  AND cr.is_latest IS DISTINCT FROM (ranked.rn = 1);

-- Only one "current" research record per company — new runs supersede the
-- old one (is_latest set false) instead of creating a duplicate "current"
-- row. History is preserved: old runs just have is_latest = false.
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_research_one_latest
    ON company_research (source, company_id)
    WHERE is_latest;

CREATE INDEX IF NOT EXISTS idx_company_research_history
    ON company_research (source, company_id, created_at DESC);

-- ---------- Company Finding ----------
-- Raw, individually fact-checkable statements about the prospect. Every
-- finding is explicitly tagged so the UI/Excel can visually separate what
-- is verified (came from a live web source), inferred (reasoned from CRM
-- data + general knowledge), or an assumption (a working guess flagged as
-- such) — the "Data Quality" requirement.
CREATE TABLE IF NOT EXISTS research_findings (
    id BIGSERIAL PRIMARY KEY,
    research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT,
    fact_type TEXT NOT NULL DEFAULT 'inferred'
        CHECK (fact_type IN ('verified', 'inferred', 'assumption')),
    priority TEXT CHECK (priority IN ('high', 'medium', 'low')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_research_findings_run ON research_findings(research_run_id);

-- ---------- Pain Point / Need ----------
CREATE TABLE IF NOT EXISTS research_pain_points (
    id BIGSERIAL PRIMARY KEY,
    research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
    finding_id BIGINT REFERENCES research_findings(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT CHECK (priority IN ('high', 'medium', 'low')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_research_pain_points_run ON research_pain_points(research_run_id);

-- ---------- Matching Service + Reason (the "Opportunity") ----------
CREATE TABLE IF NOT EXISTS research_opportunities (
    id BIGSERIAL PRIMARY KEY,
    research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
    pain_point_id BIGINT REFERENCES research_pain_points(id) ON DELETE SET NULL,
    service_id INTEGER REFERENCES pricing_catalog(id) ON DELETE SET NULL,
    service_name TEXT NOT NULL,
    reason TEXT,
    priority TEXT CHECK (priority IN ('high', 'medium', 'low')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_research_opportunities_run ON research_opportunities(research_run_id);
CREATE INDEX IF NOT EXISTS idx_research_opportunities_service ON research_opportunities(service_id);

-- ---------- Proposal Recommendation ----------
-- Suggested proposal topics/angles ("Service Proposal", "Solution Proposal",
-- "Modernization Proposal", etc.) generated from the opportunities above —
-- distinct from tender_customer_proposals / proposal_files, which track
-- actual generated proposal documents.
CREATE TABLE IF NOT EXISTS research_proposal_recommendations (
    id BIGSERIAL PRIMARY KEY,
    research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
    opportunity_id BIGINT REFERENCES research_opportunities(id) ON DELETE SET NULL,
    proposal_topic TEXT NOT NULL,
    proposal_type TEXT,
    pitch_summary TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_research_proposal_recs_run ON research_proposal_recommendations(research_run_id);

-- ---------- Sources ----------
CREATE TABLE IF NOT EXISTS research_sources (
    id BIGSERIAL PRIMARY KEY,
    research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
    title TEXT,
    url TEXT,
    query TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_research_sources_run ON research_sources(research_run_id);

-- ---------- Excel export tracking ----------
CREATE TABLE IF NOT EXISTS excel_export_log (
    id BIGSERIAL PRIMARY KEY,
    research_run_id INTEGER REFERENCES company_research(id) ON DELETE SET NULL,
    export_type TEXT NOT NULL CHECK (export_type IN ('auto_append', 'manual_download')),
    exported_by TEXT,
    row_count INTEGER,
    file_path TEXT,
    written BOOLEAN NOT NULL DEFAULT TRUE,
    failure_reason TEXT,
    exported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_excel_export_log_run ON excel_export_log(research_run_id);
CREATE INDEX IF NOT EXISTS idx_excel_export_log_time ON excel_export_log(exported_at DESC);

COMMIT;

-- ---------- verification ----------
SELECT 'tender_customers' AS table_name, COUNT(*) AS record_count FROM tender_customers
UNION ALL SELECT 'company_research', COUNT(*) FROM company_research
UNION ALL SELECT 'company_profile', COUNT(*) FROM company_profile
UNION ALL SELECT 'pricing_catalog', COUNT(*) FROM pricing_catalog
UNION ALL SELECT 'tender_customer_proposals', COUNT(*) FROM tender_customer_proposals
UNION ALL SELECT 'tender_import_runs', COUNT(*) FROM tender_import_runs
UNION ALL SELECT 'research_findings', COUNT(*) FROM research_findings
UNION ALL SELECT 'research_pain_points', COUNT(*) FROM research_pain_points
UNION ALL SELECT 'research_opportunities', COUNT(*) FROM research_opportunities
UNION ALL SELECT 'research_proposal_recommendations', COUNT(*) FROM research_proposal_recommendations
UNION ALL SELECT 'research_sources', COUNT(*) FROM research_sources
UNION ALL SELECT 'excel_export_log', COUNT(*) FROM excel_export_log;

