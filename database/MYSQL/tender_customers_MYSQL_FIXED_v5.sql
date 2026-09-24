-- ============================================================
-- OrbitAvanya CRM — Tender Customers + Research Schema
-- MySQL 8.0 conversion of the supplied PostgreSQL file
-- ============================================================
-- Original tables, columns, seed data, relationships and business
-- logic are preserved; PostgreSQL-only syntax is converted to MySQL.
-- ============================================================

CREATE DATABASE IF NOT EXISTS gmfdmmzn_proflow;
USE gmfdmmzn_proflow;

-- ============================================================
-- MySQL compatibility helpers
-- These helpers make the migration safe for the partially-created
-- schema that can exist after an earlier MySQL conversion attempt.
-- They do NOT remove or modify existing data.
-- ============================================================
DELIMITER //

DROP PROCEDURE IF EXISTS sp_add_column_if_missing//
CREATE PROCEDURE sp_add_column_if_missing(
    IN p_table VARCHAR(64),
    IN p_column VARCHAR(64),
    IN p_definition TEXT
)
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = p_table
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
    ) THEN
        SET @sql = CONCAT(
            'ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition
        );
        PREPARE stmt FROM @sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END//

DROP PROCEDURE IF EXISTS sp_create_index_if_missing//
CREATE PROCEDURE sp_create_index_if_missing(
    IN p_table VARCHAR(64),
    IN p_index VARCHAR(64),
    IN p_sql TEXT
)
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = p_table
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_index
    ) THEN
        SET @sql = p_sql;
        PREPARE stmt FROM @sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END//

DROP PROCEDURE IF EXISTS sp_add_fk_if_missing//
CREATE PROCEDURE sp_add_fk_if_missing(
    IN p_table VARCHAR(64),
    IN p_constraint VARCHAR(64),
    IN p_sql TEXT
)
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = p_table
    ) AND EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = p_table
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_schema = DATABASE()
          AND table_name = p_table
          AND constraint_name = p_constraint
          AND constraint_type = 'FOREIGN KEY'
    ) THEN
        SET @sql = p_sql;
        PREPARE stmt FROM @sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END//

DELIMITER ;

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

CREATE TABLE IF NOT EXISTS tender_customers (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    source_key VARCHAR(255) NOT NULL UNIQUE,
    company_name TEXT NOT NULL,
    legal_company_name TEXT,
    company_number VARCHAR(255),
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
    tender_domain VARCHAR(255),
    tender_subdomain TEXT,
    tender_count INTEGER NOT NULL DEFAULT 0,
    raw_data JSON NOT NULL DEFAULT (JSON_OBJECT()),
    tender_data JSON NOT NULL DEFAULT (JSON_ARRAY()),
    proposal_status VARCHAR(255) NOT NULL DEFAULT 'pending'
        CHECK (proposal_status IN ('pending','done')),
    last_proposal_id INTEGER,
    proposal_created_at DATETIME(6),
    source_workbook TEXT,
    source_sheet TEXT,
    source_row_count INTEGER NOT NULL DEFAULT 0,
    source_updated_at DATETIME(6),
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);

CALL sp_create_index_if_missing(
    'tender_customers', 'idx_tender_customers_name',
    'CREATE INDEX idx_tender_customers_name ON tender_customers ((CAST(LOWER(company_name) AS CHAR(255))))'
);

CALL sp_create_index_if_missing(
    'tender_customers', 'idx_tender_customers_company_number',
    'CREATE INDEX idx_tender_customers_company_number ON tender_customers (company_number)'
);

CALL sp_create_index_if_missing(
    'tender_customers', 'idx_tender_customers_status',
    'CREATE INDEX idx_tender_customers_status ON tender_customers (proposal_status)'
);

CALL sp_create_index_if_missing(
    'tender_customers', 'idx_tender_customers_domain',
    'CREATE INDEX idx_tender_customers_domain ON tender_customers (tender_domain)'
);

-- proposal_files is created by the preceding Orbit schema.
-- Add the tender-customer linkage columns used by this module.
CALL sp_add_column_if_missing('proposal_files', 'source_type', "VARCHAR(255) NOT NULL DEFAULT 'crm_customer'");
CALL sp_add_column_if_missing('proposal_files', 'tender_customer_id', 'BIGINT');

CALL sp_add_fk_if_missing(
    'proposal_files', 'proposal_files_tender_customer_id_fkey',
    'ALTER TABLE proposal_files ADD CONSTRAINT proposal_files_tender_customer_id_fkey FOREIGN KEY (tender_customer_id) REFERENCES tender_customers(id) ON DELETE SET NULL'
);

CALL sp_create_index_if_missing(
    'proposal_files', 'idx_proposal_files_tender_customer',
    'CREATE INDEX idx_proposal_files_tender_customer ON proposal_files(tender_customer_id)'
);

CREATE TABLE IF NOT EXISTS tender_customer_proposals (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tender_customer_id BIGINT NOT NULL
        REFERENCES tender_customers(id) ON DELETE CASCADE,
    proposal_id INTEGER,
    proposal_number TEXT NOT NULL,
    created_by TEXT,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);

-- proposal_files exists in the preceding Orbit schema, so add the FK directly.
CALL sp_add_fk_if_missing(
    'tender_customer_proposals', 'tender_customer_proposals_proposal_id_fkey',
    'ALTER TABLE tender_customer_proposals ADD CONSTRAINT tender_customer_proposals_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES proposal_files(id) ON DELETE SET NULL'
);

CALL sp_create_index_if_missing(
    'tender_customer_proposals', 'idx_tender_customer_proposals_customer',
    'CREATE INDEX idx_tender_customer_proposals_customer ON tender_customer_proposals(tender_customer_id)'
);

CALL sp_create_index_if_missing(
    'tender_customer_proposals', 'idx_tender_customer_proposals_created',
    'CREATE INDEX idx_tender_customer_proposals_created ON tender_customer_proposals(created_at DESC)'
);

CREATE TABLE IF NOT EXISTS tender_import_runs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    source_workbook TEXT NOT NULL,
    source_sheet TEXT NOT NULL,
    company_count INTEGER NOT NULL DEFAULT 0,
    row_count INTEGER NOT NULL DEFAULT 0,
    imported_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);

CALL sp_create_index_if_missing(
    'tender_import_runs', 'idx_tender_import_runs_imported',
    'CREATE INDEX idx_tender_import_runs_imported ON tender_import_runs(imported_at DESC)'
);

CREATE TABLE IF NOT EXISTS company_research (
    id INT AUTO_INCREMENT PRIMARY KEY,
    source VARCHAR(255) NOT NULL,
    company_id INTEGER NOT NULL,
    company_name TEXT NOT NULL,
    summary TEXT,
    pain_points JSON NOT NULL DEFAULT (JSON_ARRAY()),
    recommended_services JSON NOT NULL DEFAULT (JSON_ARRAY()),
    recommended_pricing_tier TEXT,
    proposal_intro TEXT,
    raw_response JSON,
    model TEXT,
    web_sources JSON NOT NULL DEFAULT (JSON_ARRAY()),
    detailed_report TEXT,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    is_latest TINYINT(1) NOT NULL DEFAULT 1,
    company_category VARCHAR(255),
    company_needs_summary TEXT,
    content_hash VARCHAR(255)
);


CALL sp_create_index_if_missing(
    'company_research', 'idx_company_research_lookup',
    'CREATE INDEX idx_company_research_lookup ON company_research(source, company_id, created_at DESC)'
);

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
    core_services JSON,
    why_choose_us JSON,
    certifications JSON,
    registrations JSON,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);

-- company_profile is created above with the complete JSON columns.
-- The original PostgreSQL TEXT[] -> JSON conversion is unnecessary in MySQL:
-- these columns are defined as JSON from the start, preserving the same data model.
-- Existing Orbit schemas can already contain company_profile with a smaller set
-- of columns. Add the Tender/Research columns without deleting the older Orbit
-- columns (director_name, uei, etc.).
CALL sp_add_column_if_missing('company_profile', 'company_name', 'TEXT');
CALL sp_add_column_if_missing('company_profile', 'legal_name', 'TEXT');
CALL sp_add_column_if_missing('company_profile', 'tagline', 'TEXT');
CALL sp_add_column_if_missing('company_profile', 'description', 'TEXT');
CALL sp_add_column_if_missing('company_profile', 'registered_office', 'TEXT');
CALL sp_add_column_if_missing('company_profile', 'website', 'TEXT');
CALL sp_add_column_if_missing('company_profile', 'portfolio_url', 'TEXT');
CALL sp_add_column_if_missing('company_profile', 'email', 'TEXT');
CALL sp_add_column_if_missing('company_profile', 'phone', 'TEXT');
CALL sp_add_column_if_missing('company_profile', 'leadership_name', 'TEXT');
CALL sp_add_column_if_missing('company_profile', 'leadership_title', 'TEXT');
CALL sp_add_column_if_missing('company_profile', 'core_services', 'JSON');
CALL sp_add_column_if_missing('company_profile', 'why_choose_us', 'JSON');
CALL sp_add_column_if_missing('company_profile', 'certifications', 'JSON');
CALL sp_add_column_if_missing('company_profile', 'registrations', 'JSON');
CALL sp_add_column_if_missing('company_profile', 'updated_at', 'DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)');

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
    '["Enterprise Application Development","Workflow Automation Systems","Contractor Management Systems (CMS)","ERP & LMS Solutions","E-Governance Platforms","AI-Powered Applications","Cloud & Infrastructure Services","API & Third-Party Integrations"]',
    '["Registered U.S. Government Contractor","GeM Registered Seller","ISO 9001 & ISO/IEC 27001 Certified","GDPR Compliance Ready","CMMI Level 3 Process-Oriented Organization","Expertise in Government Digital Transformation Projects","Secure & Scalable Technology Architecture","End-to-End Project Implementation","Dedicated Technical & Support Team","Long-Term Operations & Maintenance Support"]',
    '["ISO 9001:2015 Certified","ISO/IEC 27001:2022 Certified","GDPR Compliance Ready","CMMI Level 3 Process-Oriented Organization"]',
    '{"UEI":"D19VM1JR7MN9","NATO Cage Code":"7719Y","D-U-N-S Number":"772678096","Skill India TP ID":"321291","GeM Seller ID":"MZKP2500129966592345"}'
)
ON DUPLICATE KEY UPDATE
    company_name = VALUES(company_name),
    legal_name = VALUES(legal_name),
    tagline = VALUES(tagline),
    description = VALUES(description),
    registered_office = VALUES(registered_office),
    website = VALUES(website),
    portfolio_url = VALUES(portfolio_url),
    email = VALUES(email),
    phone = VALUES(phone),
    leadership_name = VALUES(leadership_name),
    leadership_title = VALUES(leadership_title),
    core_services = VALUES(core_services),
    why_choose_us = VALUES(why_choose_us),
    certifications = VALUES(certifications),
    registrations = VALUES(registrations),
    updated_at = NOW();

CREATE TABLE IF NOT EXISTS pricing_catalog (
    id INT AUTO_INCREMENT PRIMARY KEY,
    service_name VARCHAR(255) NOT NULL,
    starting_price TEXT,
    delivery_time TEXT,
    amc TEXT,
    currency VARCHAR(255) NOT NULL DEFAULT 'USD',
    category VARCHAR(255)
);

-- currency and category are defined directly in the MySQL table below.
-- Older pricing tables may not contain these migration columns.
CALL sp_add_column_if_missing('pricing_catalog', 'currency', "VARCHAR(255) NOT NULL DEFAULT 'USD'");
CALL sp_add_column_if_missing('pricing_catalog', 'category', 'VARCHAR(255)');

-- MySQL cannot create a full-key UNIQUE index directly on TEXT.
-- Orbit's existing pricing_catalog may have service_name as TEXT, so use a
-- deterministic SHA-256 functional key to preserve uniqueness of the full
-- service_name value without truncating or altering stored data.
CALL sp_create_index_if_missing(
    'pricing_catalog', 'pricing_catalog_service_name_key',
    'CREATE UNIQUE INDEX pricing_catalog_service_name_key ON pricing_catalog ((SHA2(service_name, 256)))'
);

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
ON DUPLICATE KEY UPDATE
    starting_price = VALUES(starting_price),
    currency = VALUES(currency),
    delivery_time = VALUES(delivery_time),
    amc = VALUES(amc),
    category = VALUES(category);

-- ============================================================
-- Part 2: normalized research schema (findings, pain points,
-- opportunities, proposal recommendations, sources, excel log)
-- ============================================================


-- ---------- extend company_research (the "research run" header) ----------
-- The MySQL table below includes the normalized research metadata columns directly.
-- Ensure columns that may exist on older research tables.
CALL sp_add_column_if_missing('company_research', 'pain_points', 'JSON NOT NULL DEFAULT (JSON_ARRAY())');
CALL sp_add_column_if_missing('company_research', 'recommended_services', 'JSON NOT NULL DEFAULT (JSON_ARRAY())');
CALL sp_add_column_if_missing('company_research', 'web_sources', 'JSON NOT NULL DEFAULT (JSON_ARRAY())');
CALL sp_add_column_if_missing('company_research', 'detailed_report', 'TEXT');
CALL sp_add_column_if_missing('company_research', 'is_latest', 'TINYINT(1) NOT NULL DEFAULT 1');
CALL sp_add_column_if_missing('company_research', 'company_category', 'VARCHAR(255)');
CALL sp_add_column_if_missing('company_research', 'company_needs_summary', 'TEXT');
CALL sp_add_column_if_missing('company_research', 'content_hash', 'VARCHAR(255)');

-- Only one "current" research record per company — new runs supersede the
-- old one (is_latest set false) instead of creating a duplicate "current"
-- row. History is preserved: old runs just have is_latest = false.
-- MySQL has no PostgreSQL-style partial unique indexes.
-- latest_key enforces the same rule: only rows with is_latest=TRUE
-- participate in the unique key; historical rows produce NULL.
-- Backfill is_latest so only the newest research run per (source, company_id)
-- remains current. Older history is preserved with is_latest = 0.
UPDATE company_research cr
JOIN (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY source, company_id
               ORDER BY created_at DESC, id DESC
           ) AS rn
    FROM company_research
) ranked ON ranked.id = cr.id
SET cr.is_latest = CASE WHEN ranked.rn = 1 THEN 1 ELSE 0 END
WHERE cr.is_latest <> CASE WHEN ranked.rn = 1 THEN 1 ELSE 0 END;
CALL sp_add_column_if_missing(
    'company_research', 'latest_key',
    "VARCHAR(512) GENERATED ALWAYS AS (CASE WHEN is_latest = 1 THEN CONCAT(source, '|', company_id) ELSE NULL END) STORED"
);

CALL sp_create_index_if_missing(
    'company_research', 'idx_company_research_one_latest',
    'CREATE UNIQUE INDEX idx_company_research_one_latest ON company_research(latest_key)'
);

CALL sp_create_index_if_missing(
    'company_research', 'idx_company_research_history',
    'CREATE INDEX idx_company_research_history ON company_research(source, company_id, created_at DESC)'
);

-- ---------- Company Finding ----------
-- Raw, individually fact-checkable statements about the prospect. Every
-- finding is explicitly tagged so the UI/Excel can visually separate what
-- is verified (came from a live web source), inferred (reasoned from CRM
-- data + general knowledge), or an assumption (a working guess flagged as
-- such) — the "Data Quality" requirement.
CREATE TABLE IF NOT EXISTS research_findings (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT,
    fact_type VARCHAR(50) NOT NULL DEFAULT 'inferred'
        CHECK (fact_type IN ('verified', 'inferred', 'assumption')),
    priority TEXT CHECK (priority IN ('high', 'medium', 'low')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CALL sp_create_index_if_missing('research_findings', 'idx_research_findings_run', 'CREATE INDEX idx_research_findings_run ON research_findings(research_run_id)');

-- ---------- Pain Point / Need ----------
CREATE TABLE IF NOT EXISTS research_pain_points (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
    finding_id BIGINT REFERENCES research_findings(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT CHECK (priority IN ('high', 'medium', 'low')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CALL sp_create_index_if_missing('research_pain_points', 'idx_research_pain_points_run', 'CREATE INDEX idx_research_pain_points_run ON research_pain_points(research_run_id)');

-- ---------- Matching Service + Reason (the "Opportunity") ----------
CREATE TABLE IF NOT EXISTS research_opportunities (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
    pain_point_id BIGINT REFERENCES research_pain_points(id) ON DELETE SET NULL,
    service_id INTEGER REFERENCES pricing_catalog(id) ON DELETE SET NULL,
    service_name VARCHAR(255) NOT NULL,
    reason TEXT,
    priority TEXT CHECK (priority IN ('high', 'medium', 'low')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CALL sp_create_index_if_missing('research_opportunities', 'idx_research_opportunities_run', 'CREATE INDEX idx_research_opportunities_run ON research_opportunities(research_run_id)');
CALL sp_create_index_if_missing('research_opportunities', 'idx_research_opportunities_service', 'CREATE INDEX idx_research_opportunities_service ON research_opportunities(service_id)');

-- ---------- Proposal Recommendation ----------
-- Suggested proposal topics/angles ("Service Proposal", "Solution Proposal",
-- "Modernization Proposal", etc.) generated from the opportunities above —
-- distinct from tender_customer_proposals / proposal_files, which track
-- actual generated proposal documents.
CREATE TABLE IF NOT EXISTS research_proposal_recommendations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
    opportunity_id BIGINT REFERENCES research_opportunities(id) ON DELETE SET NULL,
    proposal_topic TEXT NOT NULL,
    proposal_type TEXT,
    pitch_summary TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CALL sp_create_index_if_missing('research_proposal_recommendations', 'idx_research_proposal_recs_run', 'CREATE INDEX idx_research_proposal_recs_run ON research_proposal_recommendations(research_run_id)');

-- ---------- Sources ----------
CREATE TABLE IF NOT EXISTS research_sources (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    research_run_id INTEGER NOT NULL REFERENCES company_research(id) ON DELETE CASCADE,
    title TEXT,
    url TEXT,
    query TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CALL sp_create_index_if_missing('research_sources', 'idx_research_sources_run', 'CREATE INDEX idx_research_sources_run ON research_sources(research_run_id)');

-- ---------- Excel export tracking ----------
CREATE TABLE IF NOT EXISTS excel_export_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    research_run_id INTEGER REFERENCES company_research(id) ON DELETE SET NULL,
    export_type VARCHAR(255) NOT NULL CHECK (export_type IN ('auto_append', 'manual_download')),
    exported_by TEXT,
    row_count INTEGER,
    file_path TEXT,
    written TINYINT(1) NOT NULL DEFAULT 1,
    failure_reason TEXT,
    exported_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CALL sp_create_index_if_missing('excel_export_log', 'idx_excel_export_log_run', 'CREATE INDEX idx_excel_export_log_run ON excel_export_log(research_run_id)');
CALL sp_create_index_if_missing('excel_export_log', 'idx_excel_export_log_time', 'CREATE INDEX idx_excel_export_log_time ON excel_export_log(exported_at DESC)');

COMMIT;

-- ============================================================
-- Verification
-- ============================================================
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

DELIMITER //
DROP PROCEDURE IF EXISTS sp_add_column_if_missing//
DROP PROCEDURE IF EXISTS sp_create_index_if_missing//
DROP PROCEDURE IF EXISTS sp_add_fk_if_missing//
DELIMITER ;
