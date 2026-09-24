-- ============================================================
-- OrbitAvanya CRM — "Scanning & Digitization" Module Schema
-- ============================================================
-- MySQL 8.0 conversion of the original PostgreSQL scanning.sql.
-- No module/table/data/business logic has been intentionally removed.
-- PostgreSQL-only syntax is adapted for MySQL while preserving the
-- original columns, relationships, seed profile, indexes, and proposal
-- linking behavior.
-- Target database: gmfdmmzn_proflow
-- ============================================================

CREATE DATABASE IF NOT EXISTS gmfdmmzn_proflow;
USE gmfdmmzn_proflow;

SET SQL_SAFE_UPDATES = 0;


-- ---------- 1) Eligibility profiles (one company = one profile) ----------
CREATE TABLE IF NOT EXISTS digitization_eligibility_profiles (
    id BIGINT NOT NULL AUTO_INCREMENT,
    profile_key VARCHAR(255) NOT NULL,
    company_name TEXT NOT NULL,
    certifications JSON NOT NULL DEFAULT (JSON_ARRAY()),
    core_services JSON NOT NULL DEFAULT (JSON_ARRAY()),
    search_queries JSON NOT NULL DEFAULT (JSON_ARRAY()),
    relevant_naics JSON NOT NULL DEFAULT (JSON_ARRAY()),
    relevant_psc JSON NOT NULL DEFAULT (JSON_ARRAY()),
    exclusion_keywords JSON NOT NULL DEFAULT (JSON_ARRAY()),
    certification_rules JSON NOT NULL DEFAULT (JSON_OBJECT()),
    is_sme BOOLEAN NOT NULL DEFAULT TRUE,
    hard_disqualifier_rules JSON NOT NULL DEFAULT (JSON_ARRAY()),
    default_eligibility VARCHAR(50) NOT NULL DEFAULT 'HIGH',
    default_score INTEGER NOT NULL DEFAULT 90,
    default_international_note TEXT,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_by TEXT,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_digitization_profile_key (profile_key),
    -- MySQL has no partial unique indexes. This generated value is NULL
    -- for non-default profiles, so only TRUE/default rows must be unique.
    default_profile_key VARCHAR(255)
        GENERATED ALWAYS AS (
            CASE WHEN is_default = TRUE THEN profile_key ELSE NULL END
        ) STORED,
    UNIQUE KEY idx_digitization_profiles_one_default (default_profile_key)
);

-- Idempotent upgrade path for older scanning tables.
-- Existing rows keep their data; only the missing source column is added.
DELIMITER //
DROP PROCEDURE IF EXISTS sp_scan_add_column_if_missing//
CREATE PROCEDURE sp_scan_add_column_if_missing(
    IN p_table VARCHAR(64),
    IN p_column VARCHAR(64),
    IN p_definition TEXT
)
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = p_table
    )
    AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = p_table
          AND column_name = p_column
    ) THEN
        SET @scan_sql = CONCAT(
            'ALTER TABLE `', REPLACE(p_table, '`', '``'),
            '` ADD COLUMN `', REPLACE(p_column, '`', '``'),
            '` ', p_definition
        );
        PREPARE scan_stmt FROM @scan_sql;
        EXECUTE scan_stmt;
        DEALLOCATE PREPARE scan_stmt;
    END IF;
END//

DROP PROCEDURE IF EXISTS sp_scan_add_index_if_missing//
CREATE PROCEDURE sp_scan_add_index_if_missing(
    IN p_table VARCHAR(64),
    IN p_index VARCHAR(64),
    IN p_create_sql TEXT
)
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = p_table
    )
    AND NOT EXISTS (
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = p_table
          AND index_name = p_index
    ) THEN
        SET @scan_sql = p_create_sql;
        PREPARE scan_stmt FROM @scan_sql;
        EXECUTE scan_stmt;
        DEALLOCATE PREPARE scan_stmt;
    END IF;
END//

DROP PROCEDURE IF EXISTS sp_scan_add_fk_if_missing//
CREATE PROCEDURE sp_scan_add_fk_if_missing(
    IN p_table VARCHAR(64),
    IN p_constraint VARCHAR(64),
    IN p_create_sql TEXT
)
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = p_table
    )
    AND NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_schema = DATABASE()
          AND table_name = p_table
          AND constraint_name = p_constraint
          AND constraint_type = 'FOREIGN KEY'
    ) THEN
        SET @scan_sql = p_create_sql;
        PREPARE scan_stmt FROM @scan_sql;
        EXECUTE scan_stmt;
        DEALLOCATE PREPARE scan_stmt;
    END IF;
END//
DELIMITER ;

CALL sp_scan_add_column_if_missing(
    'digitization_tenders_live', 'source',
    "VARCHAR(10) NOT NULL DEFAULT 'SAM'"
);
CALL sp_scan_add_column_if_missing(
    'digitization_tenders_subcontracting', 'source',
    "VARCHAR(10) NOT NULL DEFAULT 'SAM'"
);
CALL sp_scan_add_column_if_missing(
    'digitization_scan_runs', 'source',
    "VARCHAR(10) NOT NULL DEFAULT 'SAM'"
);

-- Seed the OrbitAvanya profile from the engine's built-in defaults so the
-- module works immediately, before anyone opens "Manage Eligibility Profiles".
-- JSON arrays/objects below contain the same values as the PostgreSQL JSONB.
INSERT INTO digitization_eligibility_profiles (
    profile_key, company_name, certifications, core_services,
    is_sme, default_eligibility, default_score, default_international_note, is_default
)
VALUES (
    'orbitavanya',
    'OrbitAvanya Tech LLP',
    JSON_ARRAY(
        'ISO 9001:2015',
        'ISO 14001:2015',
        'ISO 27001',
        'ISO 45001',
        'ISO/IEC 20000-1:2018',
        'ISO 19005-1 (PDF/A)',
        'ISO 22301',
        'GDPR Compliance',
        'CMMI Maturity Level 3',
        'SOC 2 Type II Compliance',
        'UN Global Compact (ID: 221221)'
    ),
    JSON_ARRAY(
        'High-Volume Document Scanning & Digitization',
        'OCR, Automated Data Capture & Metadata Indexing',
        'Manual & Electronic Data Entry, Form Processing & Abstraction',
        'Records Management & Electronic Document Conversion',
        'Archival Digitization, Heritage Records & Microfilm/Microfiche Scanning',
        'PDF/A Long-Term Digital Preservation (ISO 19005-1 Compliance)',
        'Legal, Medical & Administrative Document Transcription'
    ),
    TRUE, 'HIGH', 90,
    'Subcontracting & Teaming Route Recommended (Direct bidding subject to FAR international vendor guidelines)',
    FALSE
)
ON DUPLICATE KEY UPDATE
    company_name = VALUES(company_name),
    certifications = VALUES(certifications),
    core_services = VALUES(core_services),
    is_sme = VALUES(is_sme),
    default_eligibility = VALUES(default_eligibility),
    default_score = VALUES(default_score),
    default_international_note = VALUES(default_international_note);

-- Preserve any already-selected default. On a fresh database, OrbitAvanya
-- becomes the default because no other profile is marked default.
UPDATE digitization_eligibility_profiles
SET is_default = TRUE
WHERE profile_key = 'orbitavanya'
  AND NOT EXISTS (
      SELECT 1
      FROM (
          SELECT profile_key
          FROM digitization_eligibility_profiles
          WHERE is_default = TRUE
            AND profile_key <> 'orbitavanya'
          LIMIT 1
      ) AS existing_default
  );

-- ---------- 2) LIVE_TENDERS (from SAM.gov opportunities) ----------
CREATE TABLE IF NOT EXISTS digitization_tenders_live (
    id BIGINT NOT NULL AUTO_INCREMENT,
    source_key VARCHAR(750) NOT NULL,
    source VARCHAR(10) NOT NULL DEFAULT 'SAM'
        CHECK (source IN ('SAM','TED','UK')),
    profile_key VARCHAR(255) NOT NULL,
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
    raw_data JSON NOT NULL DEFAULT (JSON_OBJECT()),
    selected_for_proposal BOOLEAN NOT NULL DEFAULT FALSE,
    proposal_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (proposal_status IN ('pending','done')),
    last_proposal_id INTEGER,
    proposal_created_at TIMESTAMP(6),
    source_workbook TEXT,
    source_sheet TEXT,
    source_updated_at TIMESTAMP(6),
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_digitization_live_source_key (source_key),
    CONSTRAINT fk_digitization_live_profile
        FOREIGN KEY (profile_key)
        REFERENCES digitization_eligibility_profiles(profile_key)
        ON DELETE CASCADE,
    INDEX idx_digitization_live_profile (profile_key),
    INDEX idx_digitization_live_source (source),
    INDEX idx_digitization_live_status (proposal_status),
    INDEX idx_digitization_live_deadline (response_deadline(191))
);

-- MySQL cannot index LOWER(TEXT) directly without a compatible return type.
-- The CAST preserves the original case-insensitive functional index behavior.
CREATE INDEX idx_digitization_live_title
    ON digitization_tenders_live ((CAST(LOWER(tender_title) AS CHAR(255))));

-- ---------- 3) SUBCONTRACTING_TENDERS (from USAspending prime-contractor awards) ----------
CREATE TABLE IF NOT EXISTS digitization_tenders_subcontracting (
    id BIGINT NOT NULL AUTO_INCREMENT,
    source_key VARCHAR(750) NOT NULL,
    source VARCHAR(10) NOT NULL DEFAULT 'SAM'
        CHECK (source IN ('SAM','TED','UK')),
    profile_key VARCHAR(255) NOT NULL,
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
    raw_data JSON NOT NULL DEFAULT (JSON_OBJECT()),
    selected_for_proposal BOOLEAN NOT NULL DEFAULT FALSE,
    proposal_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (proposal_status IN ('pending','done')),
    last_proposal_id INTEGER,
    proposal_created_at TIMESTAMP(6),
    source_workbook TEXT,
    source_sheet TEXT,
    source_updated_at TIMESTAMP(6),
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uq_digitization_sub_source_key (source_key),
    CONSTRAINT fk_digitization_sub_profile
        FOREIGN KEY (profile_key)
        REFERENCES digitization_eligibility_profiles(profile_key)
        ON DELETE CASCADE,
    INDEX idx_digitization_sub_profile (profile_key),
    INDEX idx_digitization_sub_source (source),
    INDEX idx_digitization_sub_status (proposal_status)
);

CREATE INDEX idx_digitization_sub_prime
    ON digitization_tenders_subcontracting ((CAST(LOWER(prime_contractor) AS CHAR(255))));

-- ---------- 4) Scan run history (drives the "Run Scan" button + status) ----------
CREATE TABLE IF NOT EXISTS digitization_scan_runs (
    id BIGINT NOT NULL AUTO_INCREMENT,
    profile_key VARCHAR(255) NOT NULL,
    source VARCHAR(10) NOT NULL DEFAULT 'SAM'
        CHECK (source IN ('SAM','TED','UK')),
    status VARCHAR(20) NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','success','failed')),
    triggered_by TEXT,
    output_file TEXT,
    live_count INTEGER,
    subcontracting_count INTEGER,
    error_message TEXT,
    log_tail TEXT,
    started_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    finished_at TIMESTAMP(6),
    PRIMARY KEY (id),
    INDEX idx_digitization_scan_runs_profile (profile_key, started_at DESC),
    INDEX idx_digitization_scan_runs_source (source)
);

-- ---------- 5) proposal_files patch: link proposals back to a digitization tender ----------
-- Mirrors the existing tender_customer_id pattern. Only runs if proposal_files exists.
CALL sp_scan_add_column_if_missing(
    'proposal_files', 'digitization_live_tender_id', 'BIGINT NULL'
);
CALL sp_scan_add_column_if_missing(
    'proposal_files', 'digitization_subcontracting_tender_id', 'BIGINT NULL'
);

CALL sp_scan_add_fk_if_missing(
    'proposal_files',
    'proposal_files_digitization_live_fkey',
    'ALTER TABLE proposal_files
       ADD CONSTRAINT proposal_files_digitization_live_fkey
       FOREIGN KEY (digitization_live_tender_id)
       REFERENCES digitization_tenders_live(id)
       ON DELETE SET NULL'
);

CALL sp_scan_add_fk_if_missing(
    'proposal_files',
    'proposal_files_digitization_sub_fkey',
    'ALTER TABLE proposal_files
       ADD CONSTRAINT proposal_files_digitization_sub_fkey
       FOREIGN KEY (digitization_subcontracting_tender_id)
       REFERENCES digitization_tenders_subcontracting(id)
       ON DELETE SET NULL'
);

CALL sp_scan_add_index_if_missing(
    'proposal_files',
    'idx_proposal_files_digitization_live',
    'CREATE INDEX idx_proposal_files_digitization_live
       ON proposal_files(digitization_live_tender_id)'
);

CALL sp_scan_add_index_if_missing(
    'proposal_files',
    'idx_proposal_files_digitization_sub',
    'CREATE INDEX idx_proposal_files_digitization_sub
       ON proposal_files(digitization_subcontracting_tender_id)'
);

-- Cleanup helper procedures.
DROP PROCEDURE IF EXISTS sp_scan_add_column_if_missing;
DROP PROCEDURE IF EXISTS sp_scan_add_index_if_missing;
DROP PROCEDURE IF EXISTS sp_scan_add_fk_if_missing;

-- ---------- verification ----------
SELECT 'digitization_eligibility_profiles' AS table_name, COUNT(*) AS record_count FROM digitization_eligibility_profiles
UNION ALL SELECT 'digitization_tenders_live', COUNT(*) FROM digitization_tenders_live
UNION ALL SELECT 'digitization_tenders_subcontracting', COUNT(*) FROM digitization_tenders_subcontracting
UNION ALL SELECT 'digitization_scan_runs', COUNT(*) FROM digitization_scan_runs;

-- ============================================================
-- End of MySQL Scanning & Digitization conversion
-- ============================================================
