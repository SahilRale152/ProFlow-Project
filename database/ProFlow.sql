-- ============================================================
-- GMFDMMZN_PROFLOW (OrbitAvanya CRM) — COMBINED MASTER SCRIPT
-- Auto-combined on 2026-09-23. Run this single file top-to-bottom
-- in MySQL Workbench 8.0 CE (or `mysql < combined_gmfdmmzn_proflow.sql`).
--
-- Execution order (as specified):
--   1. gmfdmmzn_proflow_auth.sql
--   2. orbit_mysql_FIXED.sql
--   3. client_contract_onboarding_MYSQL_FULLY_FIXED.sql
--   4. tender_customers_MYSQL_FIXED_v5.sql
--   5. scanning_MYSQL_FULLY_FIXED.sql
--   6. demo_MYSQL_FULLY_FIXED.sql
DROP DATABASE IF EXISTS `gmfdmmzn_proflow`;
-- Nothing has been removed, reworded, or reordered within each
-- source file — each section below is that file's content verbatim,
-- one after another, exactly in the sequence above.
-- ============================================================

-- This script is meant to be run start-to-finish against a fresh
-- database (it includes schema + seed/demo data). The DROP below
-- wipes any previous run of this same database so ADD INDEX /
-- ADD COLUMN statements never collide with objects left over from
-- an earlier attempt (that's what caused Error 1061 "Duplicate key
-- name" if you saw it before). Comment this line out only if you
-- specifically want to keep existing data and are sure nothing in
-- this script duplicates it.


SET SQL_SAFE_UPDATES = 0;
CREATE DATABASE IF NOT EXISTS `gmfdmmzn_proflow`;
USE `gmfdmmzn_proflow`;


-- ============================================================
-- SECTION: 1. AUTH (crm_users, admin_login_activity)
-- Source file: gmfdmmzn_proflow_auth.sql
-- ============================================================

-- Self-managed authentication migration for OrbitAvanya CRM.
-- Run this after your existing CRM schema (gmfdmmzn_proflow_schema.sql).
-- Converted from PostgreSQL to MySQL (MySQL Workbench 8.0 CE).
-- pgcrypto / gen_random_uuid() is not needed on MySQL — MySQL's
-- built-in UUID() function is used instead.

-- If you're re-running this after a previous run, uncomment the line
-- below first (see the same note in gmfdmmzn_proflow_schema.sql).
-- DROP DATABASE IF EXISTS gmfdmmzn_proflow;

CREATE DATABASE IF NOT EXISTS gmfdmmzn_proflow;
USE gmfdmmzn_proflow;

-- See the matching note in gmfdmmzn_proflow_schema.sql — this avoids
-- Error 1175 on the DELETE further down, scoped to this session only.
SET SQL_SAFE_UPDATES = 0;

CREATE TABLE IF NOT EXISTS crm_users (
  id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT ('user'),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verification_token_hash VARCHAR(255),
  verification_expires_at TIMESTAMP NULL,
  reset_token_hash VARCHAR(255),
  reset_expires_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- email already has a UNIQUE key above (also covers case-sensitive lookups);
-- MySQL's default collation on VARCHAR is case-insensitive (ci), so a
-- separate LOWER(email) index isn't needed the way it was on Postgres.
ALTER TABLE crm_users ADD INDEX idx_crm_users_verification (verification_token_hash);
ALTER TABLE crm_users ADD INDEX idx_crm_users_reset (reset_token_hash);

-- Existing login activity table is retained for the Admin page.
CREATE TABLE IF NOT EXISTS admin_login_activity (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT,
  event_type TEXT NOT NULL DEFAULT ('session_seen'),
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE admin_login_activity ADD INDEX idx_admin_login_activity_created (created_at DESC);
ALTER TABLE admin_login_activity ADD INDEX idx_admin_login_activity_email (email(191));

-- To remove register emails.
DELETE FROM crm_users
WHERE LOWER(email) = LOWER('enteruseremailtodelete@gmail.com');


-- To see all register emails.
SELECT id, email, full_name, role, email_verified, created_at
FROM crm_users
ORDER BY created_at DESC;


UPDATE crm_users
SET role = 'admin',
    updated_at = CURRENT_TIMESTAMP
WHERE email = 'sahilrale15022005@gmail.com';


-- NOTE: commented out — client_contracts isn't created by this file or by
-- gmfdmmzn_proflow_schema.sql, so this always fails with "table doesn't
-- exist" until you've also run whatever script creates it (likely your
-- client_contract_onboarding_2_.sql, possibly under a different table
-- name). Uncomment and fix the table/column names once that's in place.
-- SELECT
--     u.id AS user_id,
--     u.full_name,
--     u.email,
--     u.role,
--     c.id AS contract_id,
--     c.contract_number,
--     c.client_company_name,
--     c.status
-- FROM crm_users u
-- LEFT JOIN client_contracts c
--     ON c.user_id = u.id
-- ORDER BY u.email, c.id;


-- ============================================================
-- SECTION: 2. ORBIT — Consolidated core schema
-- Source file: orbit_mysql_FIXED.sql
-- ============================================================

-- ============================================================
-- GMFDMMZN_PROFLOW (OrbitAvanya CRM) — CONSOLIDATED SCHEMA
-- Converted from PostgreSQL (orbit.sql) to MySQL for
-- MySQL Workbench 8.0 CE. Tables, columns, defaults, indexes
-- and seed data are kept as close to the original as MySQL
-- syntax allows — see the notes marked "NOTE:" for the few
-- spots where PostgreSQL-only features had to be adapted.
-- Run this against a fresh/empty gmfdmmzn_proflow database. CREATE TABLE
-- and the seed INSERTs are still guarded (IF NOT EXISTS / WHERE NOT
-- EXISTS), but ADD COLUMN / ADD INDEX are not, since MySQL (unlike
-- MariaDB) has no IF NOT EXISTS for those — see the NOTE further down.
-- Drop and recreate the database before re-running this file.
-- ============================================================

-- If you're re-running this after a previous run (partial or full),
-- uncomment the line below first — MySQL has no ADD INDEX/ADD COLUMN
-- IF NOT EXISTS, so re-running on top of an existing database will hit
-- "duplicate key/column" errors otherwise.
-- DROP DATABASE IF EXISTS gmfdmmzn_proflow;

CREATE DATABASE IF NOT EXISTS gmfdmmzn_proflow;
USE gmfdmmzn_proflow;

-- MySQL Workbench's "safe update mode" blocks DELETE/UPDATE statements
-- whose WHERE clause doesn't filter directly on a key column of the
-- table being modified (the de-dupe DELETE further down, and similar
-- statements in gmfdmmzn_proflow_auth.sql, filter through a join/
-- function instead). Disabling it here — scoped to this session/script
-- only — avoids Error 1175 without changing your global Workbench setting.
SET SQL_SAFE_UPDATES = 0;

-- ============================================================
-- Customers (base table)
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  industry TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  status TEXT NOT NULL DEFAULT ('Active'),
  owner_id TEXT,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE customers ADD INDEX idx_customers_created (created_at DESC);
ALTER TABLE customers ADD INDEX idx_customers_company_name (company_name(191));
ALTER TABLE customers ADD INDEX idx_customers_status (status(191));
ALTER TABLE customers ADD INDEX idx_customers_owner (owner_id(191));

-- ---------- customers: extra columns some modules expect ----------
ALTER TABLE customers ADD COLUMN verification_status TEXT DEFAULT ('Not Verified');
ALTER TABLE customers ADD COLUMN ceo_name TEXT;
-- Needed by the customer detail page's Portal tab (PUT /api/customers/:id/portal).
ALTER TABLE customers ADD COLUMN portal_access BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------- customers: extra CSV/Excel import columns ----------
ALTER TABLE customers ADD COLUMN region TEXT;
ALTER TABLE customers ADD COLUMN time_zone TEXT;
ALTER TABLE customers ADD COLUMN country_size TEXT;
ALTER TABLE customers ADD COLUMN company_size TEXT;
ALTER TABLE customers ADD COLUMN employee_count TEXT;
ALTER TABLE customers ADD COLUMN category TEXT;
ALTER TABLE customers ADD COLUMN linkedin_url TEXT;
ALTER TABLE customers ADD COLUMN email_2 TEXT;
ALTER TABLE customers ADD COLUMN email_3 TEXT;
ALTER TABLE customers ADD COLUMN email_4 TEXT;
ALTER TABLE customers ADD COLUMN scrape_status TEXT;

-- ---------- customer_contacts: contacts listed on the customer detail page ----------
CREATE TABLE IF NOT EXISTS customer_contacts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  designation TEXT,
  email TEXT,
  phone TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_customer_contacts_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
ALTER TABLE customer_contacts ADD INDEX idx_customer_contacts_customer (customer_id);

-- ============================================================
-- Products
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  sku TEXT,
  category TEXT,
  price NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(7,3) NOT NULL DEFAULT 0,
  discount NUMERIC(7,3) NOT NULL DEFAULT 0,
  is_package BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  owner_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT products_discount_range CHECK (discount >= 0 AND discount <= 100)
);
-- NOTE: MySQL has no "ADD CONSTRAINT IF NOT EXISTS" for CHECK constraints
-- (unlike the guarded DO // block in the original), so the CHECK is
-- declared inline above instead. Drop it first if you ever re-run this
-- against a database that already has it: ALTER TABLE products DROP CHECK products_discount_range;
-- NOTE: "IF NOT EXISTS" on ADD COLUMN / ADD INDEX / ADD UNIQUE INDEX is a
-- MariaDB-only extension, not real MySQL syntax, so it's left off those
-- statements throughout this file. Run this script only against a fresh/
-- empty gmfdmmzn_proflow database (drop and recreate the database first
-- if you need to re-run it) rather than relying on IF NOT EXISTS guards.

ALTER TABLE products ADD INDEX idx_products_created_at (created_at DESC);
ALTER TABLE products ADD INDEX idx_products_category (category(191));
ALTER TABLE products ADD INDEX idx_products_active (active);

-- ============================================================
-- Pipeline stages
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(191) NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 99,
  is_won BOOLEAN NOT NULL DEFAULT FALSE,
  is_lost BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT IGNORE INTO pipeline_stages (name, position, is_won, is_lost) VALUES
  ('Prospecting', 10, false, false),
  ('Qualification', 20, false, false),
  ('Proposal', 30, false, false),
  ('Negotiation', 40, false, false),
  ('Closed Won', 50, true, false),
  ('Closed Lost', 60, false, true);

-- ============================================================
-- Leads
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT,
  status TEXT NOT NULL DEFAULT ('new'),
  estimated_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  customer_id BIGINT,
  notes TEXT,
  assigned_to TEXT,
  score INTEGER,
  ai_insight TEXT,
  converted_opportunity_id BIGINT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_leads_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);
ALTER TABLE leads ADD INDEX idx_leads_created (created_at DESC);
ALTER TABLE leads ADD INDEX idx_leads_status (status(191));
ALTER TABLE leads ADD INDEX idx_leads_customer (customer_id);
ALTER TABLE leads ADD INDEX idx_leads_source (source(191));
ALTER TABLE leads ADD INDEX idx_leads_assigned (assigned_to(191));

-- ============================================================
-- Opportunities
-- ============================================================
CREATE TABLE IF NOT EXISTS opportunities (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title TEXT NOT NULL,
  customer_id BIGINT,
  lead_id BIGINT,
  stage TEXT NOT NULL DEFAULT ('Prospecting'),
  value NUMERIC(14,2) NOT NULL DEFAULT 0,
  probability NUMERIC(5,2) NOT NULL DEFAULT 50,
  expected_close_date DATE,
  owner TEXT,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_opportunities_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT fk_opportunities_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
);
ALTER TABLE opportunities ADD INDEX idx_opportunities_created (created_at DESC);
ALTER TABLE opportunities ADD INDEX idx_opportunities_stage (stage(191));
ALTER TABLE opportunities ADD INDEX idx_opportunities_customer (customer_id);
ALTER TABLE opportunities ADD INDEX idx_opportunities_lead (lead_id);

ALTER TABLE leads
  ADD CONSTRAINT fk_leads_converted_opportunity
  FOREIGN KEY (converted_opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL;
-- NOTE: like the CHECK constraint above, MySQL has no IF NOT EXISTS for
-- ADD CONSTRAINT, so on a re-run drop it first if it already exists:
-- ALTER TABLE leads DROP FOREIGN KEY fk_leads_converted_opportunity;

-- ============================================================
-- Activities
-- ============================================================
CREATE TABLE IF NOT EXISTS activities (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT ('note'),
  subject TEXT,
  body TEXT,
  customer_id BIGINT,
  direction TEXT NOT NULL DEFAULT ('outbound'),
  status TEXT NOT NULL DEFAULT ('completed'),
  due_at TIMESTAMP NULL,
  duration_minutes INTEGER,
  owner_id TEXT,
  notified BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_activities_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);
ALTER TABLE activities ADD INDEX idx_activities_customer (customer_id);
ALTER TABLE activities ADD INDEX idx_activities_due (status(100), due_at);
ALTER TABLE activities ADD INDEX idx_activities_occurred (occurred_at DESC);
ALTER TABLE activities ADD INDEX idx_activities_status (status(191));

-- ============================================================
-- Tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  status TEXT NOT NULL DEFAULT ('todo'),
  priority TEXT NOT NULL DEFAULT ('medium'),
  related_type TEXT,
  related_id BIGINT,
  assigned_to TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE tasks ADD INDEX idx_tasks_status (status(191));
ALTER TABLE tasks ADD INDEX idx_tasks_due (due_date);
ALTER TABLE tasks ADD INDEX idx_tasks_related (related_type(100), related_id);

-- ============================================================
-- Calendar events
-- ============================================================
CREATE TABLE IF NOT EXISTS calendar_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NULL,
  related_type TEXT,
  related_id BIGINT,
  created_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE calendar_events ADD INDEX idx_calendar_start (start_time);
ALTER TABLE calendar_events ADD INDEX idx_calendar_related (related_type(100), related_id);

-- ============================================================
-- Approvals
-- ============================================================
CREATE TABLE IF NOT EXISTS approvals (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT ('discount'),
  related_type TEXT,
  related_id BIGINT,
  requested_by TEXT,
  approver TEXT,
  status TEXT NOT NULL DEFAULT ('Pending'),
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMP NULL
);
ALTER TABLE approvals ADD INDEX idx_approvals_status (status(191));
ALTER TABLE approvals ADD INDEX idx_approvals_related (related_type(100), related_id);

-- ============================================================
-- Communications
-- ============================================================
CREATE TABLE IF NOT EXISTS communications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NULL,
  lead_id BIGINT NULL,
  opportunity_id BIGINT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'email',
  direction VARCHAR(20) NOT NULL DEFAULT 'inbound',
  subject TEXT,
  body TEXT,
  sender_email VARCHAR(255),
  sender_name VARCHAR(255),
  recipient_email VARCHAR(255),
  recipient_name VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'received',
  message_id TEXT,
  thread_id TEXT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at TIMESTAMP NULL,
  received_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE communications ADD INDEX idx_communications_customer_id (customer_id);
ALTER TABLE communications ADD INDEX idx_communications_lead_id (lead_id);
ALTER TABLE communications ADD INDEX idx_communications_opportunity_id (opportunity_id);
ALTER TABLE communications ADD INDEX idx_communications_direction (direction);
ALTER TABLE communications ADD INDEX idx_communications_received_at (received_at DESC);
ALTER TABLE communications ADD INDEX idx_communications_created_at (created_at DESC);
ALTER TABLE communications ADD INDEX idx_communications_sender_email (sender_email);
ALTER TABLE communications ADD INDEX idx_communications_message_id (message_id(191));
ALTER TABLE communications ADD INDEX idx_communications_is_read (is_read);

-- De-dupe by message_id before the unique index (safe no-op on a clean table)
-- NOTE: MySQL doesn't support "DELETE ... USING (subquery)"; rewritten as a
-- multi-table DELETE with a JOIN, using the same ROW_NUMBER() window function.
DELETE c FROM communications c
JOIN (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY id) AS rn
  FROM communications WHERE message_id IS NOT NULL
) dup ON c.id = dup.id
WHERE dup.rn > 1;

-- NOTE: Postgres' partial unique index ("WHERE message_id IS NOT NULL") has
-- no MySQL equivalent, but it's also redundant there: MySQL unique indexes
-- already treat NULL as distinct, so any number of NULL message_id rows are
-- allowed and only non-null values are checked for uniqueness — same effect.
ALTER TABLE communications ADD UNIQUE INDEX uq_communications_message_id (message_id(191));

-- ============================================================
-- Notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT ('info'),
  title TEXT NOT NULL,
  message TEXT,
  link TEXT,
  related_type TEXT,
  related_id BIGINT,
  `read` BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE notifications ADD INDEX idx_notifications_created (created_at DESC);
ALTER TABLE notifications ADD INDEX idx_notifications_unread (`read`, created_at DESC);
ALTER TABLE notifications ADD INDEX idx_notifications_related (related_type(100), related_id);

-- ============================================================
-- Proposal templates (+ default rows)
-- Stores the complete HTML used by the proposal generator.
-- `sections` is retained for compatibility with older CRM data.
-- NOTE: Postgres TEXT[] has no MySQL array type; converted to JSON,
-- holding the same list of strings as a JSON array.
-- ============================================================
CREATE TABLE IF NOT EXISTS proposal_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  html_content TEXT,
  sections JSON DEFAULT ('[]'),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- NOTE: the original Postgres file re-added html_content/is_active/
-- is_default/created_at/updated_at here with IF NOT EXISTS, purely to
-- migrate a database that still had the older, narrower table shape.
-- The CREATE TABLE above already includes all five on a fresh install,
-- and MySQL has no IF NOT EXISTS for ADD COLUMN, so those ALTERs are
-- left out here — they'd just fail with "duplicate column" every time.
-- If you're ever migrating a genuinely older proposal_templates table
-- that's missing one of these columns, add it back in manually with a
-- plain ALTER TABLE ... ADD COLUMN for just that column.

UPDATE proposal_templates
SET is_default = FALSE
WHERE is_default = TRUE
  AND id <> (SELECT MIN(id) FROM (SELECT id FROM proposal_templates WHERE is_default = TRUE) t);

-- NOTE: Postgres enforces "only one is_default=TRUE row" with a partial
-- unique index (WHERE is_default = TRUE). MySQL has no partial/filtered
-- indexes, and a plain UNIQUE(is_default) would also block having more
-- than one is_default=FALSE row, so it can't be replicated as a single
-- index here. Keep this invariant enforced in the app (server.js already
-- has to flip old defaults off when setting a new one, per the UPDATE
-- above) rather than at the MySQL schema level.

-- Keep at least one usable template row. The server imports
-- public/templates/templates1.html into html_content on startup.
INSERT INTO proposal_templates
  (name, description, html_content, sections, is_active, is_default)
SELECT * FROM (SELECT
  'Quick Proposal' AS name,
  'Professional A4 proposal template imported from public/templates/templates1.html.' AS description,
  NULL AS html_content,
  JSON_ARRAY('Cover','Executive Summary','Company Profile','Engagement Summary','Scope of Work','Implementation Plan','Deliverables','Investment','Closing') AS sections,
  TRUE AS is_active,
  TRUE AS is_default
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM proposal_templates);

UPDATE proposal_templates
SET updated_at = CURRENT_TIMESTAMP
WHERE updated_at IS NULL;

-- ============================================================
-- Company profile (+ default row)
-- NOTE: certifications / core_services were Postgres TEXT[]; converted
-- to JSON arrays, same values.
-- ============================================================
CREATE TABLE IF NOT EXISTS company_profile (
  id INT PRIMARY KEY DEFAULT 1,
  company_name TEXT,
  tagline TEXT,
  registered_office TEXT,
  website TEXT,
  email TEXT,
  phone TEXT,
  director_name TEXT,
  director_title TEXT,
  uei TEXT,
  nato_cage_code TEXT,
  duns_number TEXT,
  skill_india_tp_id TEXT,
  gem_seller_id TEXT,
  certifications JSON,
  core_services JSON,
  logo_url TEXT,
  primary_color TEXT DEFAULT ('#a855f7'),
  secondary_color TEXT DEFAULT ('#4c1d95'),
  usage_purpose TEXT,
  org_type TEXT,
  user_role TEXT,
  CONSTRAINT company_profile_single_row CHECK (id = 1)
);
INSERT INTO company_profile (
  id, company_name, tagline, registered_office, website, email, phone,
  director_name, director_title, uei, nato_cage_code, duns_number,
  skill_india_tp_id, gem_seller_id, certifications, core_services
)
SELECT * FROM (SELECT
  1 AS id, 'OrbitAvanya Tech LLP (AvanyaEdge)' AS company_name,
  'ISO-certified technology consulting and digital transformation company' AS tagline,
  'Shastri Nagar CHS, Vashi Naka, Near Hanuman Mandir, Chembur, Mumbai – 400074, Maharashtra, India' AS registered_office,
  'www.orbitavanyatech.com' AS website, 'info@orbitavanyatech.com' AS email, '+91 7021950643' AS phone,
  'Pradeep Kumar Singh' AS director_name, 'Director, Microsoft Certified Developer & AI Expert' AS director_title,
  'D19VM1JR7MN9' AS uei, '7719Y' AS nato_cage_code, '772678096' AS duns_number, '321291' AS skill_india_tp_id, 'MZKP2500129966592345' AS gem_seller_id,
  JSON_ARRAY('ISO 9001 Certified','ISO/IEC 27001 Certified','GDPR Compliance Ready','CMMI Level 3 Process-Oriented Organization') AS certifications,
  JSON_ARRAY('Enterprise Application Development','Workflow Automation Systems','Contractor Management Systems (CMS)','ERP & LMS Solutions','E-Governance Platforms','AI-Powered Applications','Cloud & Infrastructure Services','API & Third-Party Integrations') AS core_services
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM company_profile WHERE id = 1);

-- ============================================================
-- Pricing catalog (+ default rows)
-- ============================================================
CREATE TABLE IF NOT EXISTS pricing_catalog (
  id INT AUTO_INCREMENT PRIMARY KEY,
  service_name TEXT NOT NULL,
  starting_price TEXT NOT NULL,
  delivery_time TEXT,
  amc TEXT
);
INSERT INTO pricing_catalog (service_name, starting_price, delivery_time, amc)
SELECT * FROM (
  SELECT 'CRM Development' service_name,'40000' starting_price,'8–16 Weeks' delivery_time,'18%/Year' amc UNION ALL
  SELECT 'ERP Development','120000','4–8 Months','20%/Year' UNION ALL
  SELECT 'HRMS','35000','8–12 Weeks','18%/Year' UNION ALL
  SELECT 'Inventory Management','30000','6–10 Weeks','18%/Year' UNION ALL
  SELECT 'Hospital Management System','150000','5–9 Months','20%/Year' UNION ALL
  SELECT 'School ERP','50000','10–16 Weeks','18%/Year' UNION ALL
  SELECT 'Accounting Software','45000','8–14 Weeks','18%/Year' UNION ALL
  SELECT 'Billing Software','20000','4–8 Weeks','15%/Year' UNION ALL
  SELECT 'POS System','25000','6–10 Weeks','15%/Year' UNION ALL
  SELECT 'Business Website (5–10 Pages)','8000','2–4 Weeks','15%/Year' UNION ALL
  SELECT 'Corporate Website','20000','4–8 Weeks','15%/Year' UNION ALL
  SELECT 'Government Portal','80000','3–6 Months','20%/Year' UNION ALL
  SELECT 'E-commerce Website','35000','8–16 Weeks','18%/Year' UNION ALL
  SELECT 'Custom Web Portal','50000','10–20 Weeks','20%/Year' UNION ALL
  SELECT 'Android App','20000','8–12 Weeks','18%/Year' UNION ALL
  SELECT 'iOS App','25000','8–14 Weeks','18%/Year' UNION ALL
  SELECT 'Enterprise Mobile App','60000','3–6 Months','20%/Year' UNION ALL
  SELECT 'Document Management System','120000','4–7 Months','18%/Year' UNION ALL
  SELECT 'UI/UX Design','12000','3–6 Weeks','Optional' UNION ALL
  SELECT 'AVANYA AI LMS','150000','4–8 Months','20%/Year' UNION ALL
  SELECT 'AVANYA AI ERP','250000','6–12 Months','20%/Year'
) AS demo
WHERE NOT EXISTS (SELECT 1 FROM pricing_catalog);
-- NOTE: Postgres' "VALUES (...) AS demo(cols)" table constructor was
-- rewritten as a UNION ALL of SELECTs — same rows, MySQL-compatible.

-- ============================================================
-- Proposal folders (+ default rows)
-- ============================================================
CREATE TABLE IF NOT EXISTS proposal_folders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(191) NOT NULL UNIQUE
);
INSERT INTO proposal_folders (name)
SELECT * FROM (SELECT 'Sales' name UNION ALL SELECT 'Marketing' UNION ALL SELECT 'Clients') AS demo
WHERE NOT EXISTS (SELECT 1 FROM proposal_folders);

-- ============================================================
-- AI proposals
-- NOTE: JSONB -> JSON (MySQL has no JSONB; JSON is the equivalent).
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_proposals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title TEXT NOT NULL,
  customer_id BIGINT,
  template_id INT,
  requirements TEXT,
  budget TEXT,
  timeline TEXT,
  content JSON,
  selected_services JSON,
  status TEXT DEFAULT ('Draft'),
  cover_image_url TEXT,
  folder_id INT,
  chat_history JSON DEFAULT ('[]'),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ai_proposals_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT fk_ai_proposals_template FOREIGN KEY (template_id) REFERENCES proposal_templates(id) ON DELETE SET NULL,
  CONSTRAINT fk_ai_proposals_folder FOREIGN KEY (folder_id) REFERENCES proposal_folders(id) ON DELETE SET NULL
);
ALTER TABLE ai_proposals ADD INDEX idx_ai_proposals_customer (customer_id);
ALTER TABLE ai_proposals ADD INDEX idx_ai_proposals_template (template_id);
ALTER TABLE ai_proposals ADD INDEX idx_ai_proposals_folder (folder_id);
ALTER TABLE ai_proposals ADD INDEX idx_ai_proposals_status (status(191));
ALTER TABLE ai_proposals ADD INDEX idx_ai_proposals_created (created_at DESC);

-- ============================================================
-- Image assets (proposal designer upload library)
-- ============================================================
CREATE TABLE IF NOT EXISTS image_assets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  url TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Table may already exist from a partial earlier run with fewer columns —
-- add whatever's missing before indexing.
ALTER TABLE image_assets ADD COLUMN customer_id BIGINT;
ALTER TABLE image_assets ADD COLUMN proposal_id INT;
ALTER TABLE image_assets ADD COLUMN original_name TEXT;
ALTER TABLE image_assets ADD COLUMN size_kb INTEGER;
ALTER TABLE image_assets ADD COLUMN mime_type TEXT;
ALTER TABLE image_assets ADD COLUMN uploaded_by TEXT;
ALTER TABLE image_assets ADD INDEX idx_image_assets_customer (customer_id);
ALTER TABLE image_assets ADD INDEX idx_image_assets_created (created_at DESC);

ALTER TABLE image_assets
  ADD CONSTRAINT fk_image_assets_customer
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE image_assets
  ADD CONSTRAINT fk_image_assets_proposal
  FOREIGN KEY (proposal_id) REFERENCES ai_proposals(id) ON DELETE CASCADE;
-- NOTE: as above, MySQL can't guard ADD CONSTRAINT with IF NOT EXISTS —
-- drop first on a re-run if these already exist.

-- ============================================================
-- AI Assistant tables
-- Required by /api/ai/* endpoints in server.js
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE ai_chat_messages ADD INDEX idx_ai_chat_messages_session (session_id(191));
ALTER TABLE ai_chat_messages ADD INDEX idx_ai_chat_messages_created (created_at DESC);

CREATE TABLE IF NOT EXISTS ai_email_drafts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT,
  purpose TEXT NOT NULL,
  tone TEXT,
  input_notes TEXT NOT NULL,
  generated_subject TEXT NOT NULL,
  generated_body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ai_email_drafts_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);
ALTER TABLE ai_email_drafts ADD INDEX idx_ai_email_drafts_customer (customer_id);
ALTER TABLE ai_email_drafts ADD INDEX idx_ai_email_drafts_created (created_at DESC);

CREATE TABLE IF NOT EXISTS ai_coach_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT,
  mode TEXT NOT NULL,
  input_context TEXT NOT NULL,
  output_advice TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ai_coach_sessions_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);
ALTER TABLE ai_coach_sessions ADD INDEX idx_ai_coach_sessions_customer (customer_id);
ALTER TABLE ai_coach_sessions ADD INDEX idx_ai_coach_sessions_created (created_at DESC);

CREATE TABLE IF NOT EXISTS ai_meeting_summaries (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT,
  meeting_title TEXT,
  transcript TEXT NOT NULL,
  summary TEXT NOT NULL,
  action_items TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ai_meeting_summaries_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);
ALTER TABLE ai_meeting_summaries ADD INDEX idx_ai_meeting_summaries_customer (customer_id);
ALTER TABLE ai_meeting_summaries ADD INDEX idx_ai_meeting_summaries_created (created_at DESC);

-- ============================================================
-- Document categories (+ default rows)
-- ============================================================
CREATE TABLE IF NOT EXISTS document_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(191) NOT NULL UNIQUE
);
INSERT IGNORE INTO document_categories (name)
VALUES ('Contract'), ('Proposal'), ('Invoice'), ('Report'), ('Other');

-- ============================================================
-- Documents module
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  file_name TEXT NOT NULL,
  category TEXT,
  customer_id BIGINT,
  uploaded_by TEXT,
  file_url TEXT,
  size_kb NUMERIC DEFAULT 0,
  is_shared BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_documents_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);
ALTER TABLE documents ADD INDEX idx_documents_customer (customer_id);

CREATE TABLE IF NOT EXISTS document_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT,
  version_number INTEGER DEFAULT 1,
  file_url TEXT,
  uploaded_by TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_document_versions_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
ALTER TABLE document_versions ADD INDEX idx_document_versions_document (document_id);

CREATE TABLE IF NOT EXISTS document_shares (
  id INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT,
  shared_with TEXT,
  shared_by TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_document_shares_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
ALTER TABLE document_shares ADD INDEX idx_document_shares_document (document_id);

-- ============================================================
-- Contracts
-- ============================================================
CREATE TABLE IF NOT EXISTS contracts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contract_number TEXT NOT NULL,
  customer_id BIGINT,
  start_date DATE,
  end_date DATE,
  status TEXT DEFAULT ('Draft'),
  value NUMERIC,
  sales_owner TEXT,
  attachment_url TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_contracts_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);
ALTER TABLE contracts ADD INDEX idx_contracts_customer (customer_id);
ALTER TABLE contracts ADD INDEX idx_contracts_status (status(191));

-- ============================================================
-- Proposal files
-- ============================================================
CREATE TABLE IF NOT EXISTS proposal_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  proposal_number TEXT NOT NULL,
  customer_id BIGINT,
  opportunity TEXT,
  created_by TEXT,
  status TEXT DEFAULT ('Draft'),
  version INTEGER DEFAULT 1,
  file_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_proposal_files_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);
ALTER TABLE proposal_files ADD INDEX idx_proposal_files_customer (customer_id);
ALTER TABLE proposal_files ADD INDEX idx_proposal_files_status (status(191));

-- ============================================================
-- Customer files
-- ============================================================
CREATE TABLE IF NOT EXISTS customer_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT,
  document_type TEXT,
  file_url TEXT,
  uploaded_by TEXT,
  expiry_date DATE,
  status TEXT DEFAULT ('Pending'),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_customer_files_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
ALTER TABLE customer_files ADD INDEX idx_customer_files_customer (customer_id);
ALTER TABLE customer_files ADD INDEX idx_customer_files_status (status(191));

-- ============================================================
-- Proposal sends (send + click tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS proposal_sends (
  id INT AUTO_INCREMENT PRIMARY KEY,
  proposal_id INT,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  tracking_token VARCHAR(191) NOT NULL UNIQUE,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  opened_at TIMESTAMP NULL,
  clicked_at TIMESTAMP NULL,
  lead_id BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_proposal_sends_proposal FOREIGN KEY (proposal_id) REFERENCES ai_proposals(id) ON DELETE CASCADE,
  CONSTRAINT fk_proposal_sends_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
);
ALTER TABLE proposal_sends ADD INDEX idx_proposal_sends_proposal (proposal_id);
ALTER TABLE proposal_sends ADD INDEX idx_proposal_sends_recipient (recipient_email(191));
-- tracking_token already has a UNIQUE key above, which doubles as its lookup index.

-- ============================================================
-- Verify the connected tables
-- ============================================================
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'gmfdmmzn_proflow'
  AND table_name IN (
    'products','activities','communications','notifications',
    'customers','leads','opportunities','tasks','calendar_events',
    'approvals','proposal_templates','company_profile','pricing_catalog',
    'proposal_folders','ai_proposals','image_assets','document_categories',
    'documents','document_versions','document_shares','contracts',
    'proposal_files','customer_files','proposal_sends','pipeline_stages',
    'ai_chat_messages','ai_email_drafts','ai_coach_sessions','ai_meeting_summaries',
    'customer_contacts'
  )
ORDER BY table_name;

-- ============================================================
-- NOVA CRM — BUSINESS LOGIC FUNCTIONS
-- ============================================================
-- NOTE ON THIS WHOLE SECTION:
-- The original functions/triggers are PL/pgSQL and lean heavily on
-- Postgres-only features MySQL simply doesn't have:
--   - JSONB + jsonb_build_object/jsonb_agg (MySQL's JSON_OBJECT/
--     JSON_ARRAYAGG are close but the aggregate FILTER (WHERE ...)
--     syntax used throughout has no MySQL equivalent — it has to
--     become SUM(CASE WHEN ... THEN 1 ELSE 0 END) style logic)
--   - regr_slope()/regr_intercept() (linear regression) — no MySQL
--     built-in equivalent
--   - generate_series() — no MySQL built-in equivalent (would need
--     a recursive CTE)
--   - date_trunc() — no direct MySQL equivalent
-- get_analytics_summary() in particular uses regr_slope, regr_intercept
-- and generate_series and cannot be ported to a MySQL function without
-- being substantially rewritten (different logic, not just syntax).
-- Given the staged migration plan already in place (db-mysql.js adapter),
-- the safer path is to move this reporting logic into that Node.js layer
-- rather than as MySQL stored routines. The straightforward ones are
-- converted below as a starting point; get_analytics_summary is left
-- as a TODO for the JS side.
-- ============================================================

DELIMITER //

DROP PROCEDURE IF EXISTS get_communications_summary//
CREATE PROCEDURE get_communications_summary(IN p_owner_id TEXT)
BEGIN
  SELECT JSON_OBJECT(
    'total', (SELECT COUNT(*) FROM activities WHERE p_owner_id IS NULL OR owner_id = p_owner_id),
    'this_week', (SELECT COUNT(*) FROM activities WHERE (p_owner_id IS NULL OR owner_id = p_owner_id) AND occurred_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
    'upcoming_followups', (SELECT COUNT(*) FROM activities WHERE (p_owner_id IS NULL OR owner_id = p_owner_id) AND status = 'scheduled' AND due_at >= NOW()),
    'overdue_followups', (SELECT COUNT(*) FROM activities WHERE (p_owner_id IS NULL OR owner_id = p_owner_id) AND status = 'scheduled' AND due_at < NOW()),
    'by_type', (
      SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('type', type, 'count', cnt)), JSON_ARRAY())
      FROM (
        SELECT type, COUNT(*) AS cnt FROM activities
        WHERE p_owner_id IS NULL OR owner_id = p_owner_id
        GROUP BY type ORDER BY cnt DESC
      ) t
    )
  ) AS result;
END//

DROP PROCEDURE IF EXISTS sync_followup_notifications//
CREATE PROCEDURE sync_followup_notifications(IN p_owner_id TEXT, OUT inserted_count INT)
BEGIN
  INSERT INTO notifications (type, title, message, link, related_type, related_id)
  SELECT 'reminder', CONCAT('Follow-up due: ', COALESCE(a.subject, 'Untitled')),
    CASE WHEN c.company_name IS NOT NULL
      THEN CONCAT('With ', c.company_name, ' — ', DATE_FORMAT(a.due_at, '%b %d, %h:%i %p'))
      ELSE DATE_FORMAT(a.due_at, '%b %d, %h:%i %p') END,
    '/activities', 'activity', a.id
  FROM activities a
  LEFT JOIN customers c ON c.id = a.customer_id
  WHERE (p_owner_id IS NULL OR a.owner_id = p_owner_id)
    AND a.status = 'scheduled' AND a.due_at IS NOT NULL
    AND a.due_at <= DATE_ADD(NOW(), INTERVAL 1 DAY) AND a.notified = FALSE;
  SET inserted_count = ROW_COUNT();

  UPDATE activities a
  LEFT JOIN customers c ON c.id = a.customer_id
  SET a.notified = TRUE
  WHERE (p_owner_id IS NULL OR a.owner_id = p_owner_id)
    AND a.status = 'scheduled' AND a.due_at IS NOT NULL
    AND a.due_at <= DATE_ADD(NOW(), INTERVAL 1 DAY) AND a.notified = FALSE;
END//

-- ---------- Notifications backend: deal/proposal events -> notifications ----------

DROP TRIGGER IF EXISTS opportunities_notify//
CREATE TRIGGER opportunities_notify AFTER UPDATE ON opportunities
FOR EACH ROW
BEGIN
  DECLARE v_is_won BOOLEAN;
  DECLARE v_is_lost BOOLEAN;
  IF NOT (NEW.stage <=> OLD.stage) THEN
    SELECT is_won, is_lost INTO v_is_won, v_is_lost FROM pipeline_stages WHERE name = NEW.stage LIMIT 1;
    IF v_is_won THEN
      INSERT INTO notifications (type, title, message, link, related_type, related_id)
      VALUES ('deal_won', CONCAT('Deal won: ', NEW.title), CONCAT('Closed for ', FORMAT(COALESCE(NEW.value, 0), 2)), '/pipeline', 'opportunity', NEW.id);
    ELSEIF v_is_lost THEN
      INSERT INTO notifications (type, title, message, link, related_type, related_id)
      VALUES ('deal_lost', CONCAT('Deal lost: ', NEW.title), NULL, '/pipeline', 'opportunity', NEW.id);
    END IF;
  END IF;
END//

-- Status comparisons are case-insensitive since seed data uses
-- 'Draft' / 'Approved' (Title Case) rather than lowercase.
DROP TRIGGER IF EXISTS ai_proposals_notify//
CREATE TRIGGER ai_proposals_notify AFTER UPDATE ON ai_proposals
FOR EACH ROW
BEGIN
  IF NOT (NEW.status <=> OLD.status) THEN
    IF LOWER(NEW.status) = 'approved' THEN
      INSERT INTO notifications (type, title, message, link, related_type, related_id)
      VALUES ('proposal_approved', CONCAT('Proposal approved: ', NEW.title), NULL, '/proposals', 'ai_proposal', NEW.id);
    ELSEIF LOWER(NEW.status) = 'rejected' THEN
      INSERT INTO notifications (type, title, message, link, related_type, related_id)
      VALUES ('proposal_rejected', CONCAT('Proposal rejected: ', NEW.title), NULL, '/proposals', 'ai_proposal', NEW.id);
    ELSEIF LOWER(NEW.status) = 'sent' THEN
      INSERT INTO notifications (type, title, message, link, related_type, related_id)
      VALUES ('proposal_sent', CONCAT('Proposal sent: ', NEW.title), NULL, '/proposals', 'ai_proposal', NEW.id);
    END IF;
  END IF;
END//

-- notifications has no user_id column, so these are instance-wide.
DROP PROCEDURE IF EXISTS get_notifications_summary//
CREATE PROCEDURE get_notifications_summary()
BEGIN
  SELECT JSON_OBJECT(
    'total', (SELECT COUNT(*) FROM notifications),
    'unread', (SELECT COUNT(*) FROM notifications WHERE `read` = FALSE),
    'today', (SELECT COUNT(*) FROM notifications WHERE created_at >= CURDATE()),
    'by_type', (
      SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('type', type, 'count', cnt)), JSON_ARRAY())
      FROM (
        SELECT COALESCE(type, 'info') AS type, COUNT(*) AS cnt
        FROM notifications GROUP BY 1 ORDER BY cnt DESC
      ) t
    )
  ) AS result;
END//

DROP PROCEDURE IF EXISTS mark_all_notifications_read//
CREATE PROCEDURE mark_all_notifications_read(OUT updated_count INT)
BEGIN
  UPDATE notifications SET `read` = TRUE WHERE `read` = FALSE;
  SET updated_count = ROW_COUNT();
END//

-- ---------- Products & Pricing v2 ----------

DROP PROCEDURE IF EXISTS get_products_summary//
CREATE PROCEDURE get_products_summary(IN p_owner TEXT)
BEGIN
  SELECT JSON_OBJECT(
    'total_products', SUM(CASE WHEN active THEN 1 ELSE 0 END),
    'catalog_value', COALESCE(SUM(CASE WHEN active THEN final_price ELSE 0 END), 0),
    'avg_price', COALESCE(ROUND(AVG(CASE WHEN active THEN final_price END), 2), 0),
    'packages', SUM(CASE WHEN active AND is_package THEN 1 ELSE 0 END),
    'archived', SUM(CASE WHEN NOT active THEN 1 ELSE 0 END),
    'min_price', COALESCE(MIN(CASE WHEN active THEN final_price END), 0),
    'max_price', COALESCE(MAX(CASE WHEN active THEN final_price END), 0),
    'categories', (
      SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('name', category, 'count', cnt)), JSON_ARRAY())
      FROM (
        SELECT COALESCE(NULLIF(category, ''), 'Uncategorized') AS category, COUNT(*) AS cnt
        FROM products WHERE (p_owner IS NULL OR owner_id = p_owner) AND active
        GROUP BY 1 ORDER BY cnt DESC
      ) c
    )
  ) AS result
  FROM products WHERE (p_owner IS NULL OR owner_id = p_owner);
END//

-- p_id is BIGINT (products.id type), not UUID.
DROP PROCEDURE IF EXISTS duplicate_product//
CREATE PROCEDURE duplicate_product(IN p_id BIGINT)
BEGIN
  DECLARE v_owner_id TEXT;
  DECLARE v_name TEXT;
  DECLARE v_description TEXT;
  DECLARE v_price NUMERIC(14,2);
  DECLARE v_tax_rate NUMERIC(7,3);
  DECLARE v_discount NUMERIC(7,3);
  DECLARE v_category TEXT;
  DECLARE v_is_package BOOLEAN;
  DECLARE v_active BOOLEAN;
  DECLARE v_found INT DEFAULT 0;

  SELECT COUNT(*) INTO v_found FROM products WHERE id = p_id;
  IF v_found = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Product not found';
  END IF;

  SELECT owner_id, name, description, price, tax_rate, discount, category, is_package, active
  INTO v_owner_id, v_name, v_description, v_price, v_tax_rate, v_discount, v_category, v_is_package, v_active
  FROM products WHERE id = p_id;

  INSERT INTO products (owner_id, name, description, sku, price, tax_rate, discount, category, is_package, active)
  VALUES (v_owner_id, CONCAT(v_name, ' (Copy)'), v_description, NULL, v_price, v_tax_rate, v_discount, v_category, v_is_package, v_active);

  SELECT * FROM products WHERE id = LAST_INSERT_ID();
END//

DELIMITER ;

ALTER TABLE products ADD COLUMN final_price NUMERIC(14,2)
  GENERATED ALWAYS AS (
    ROUND(price * (1 - COALESCE(discount, 0) / 100.0) * (1 + COALESCE(tax_rate, 0) / 100.0), 2)
  ) STORED;
ALTER TABLE products ADD INDEX idx_products_owner_active (owner_id(191), active);

-- TODO (app layer): get_analytics_summary() — see the note at the top of
-- this section. Its filterable revenue/funnel/forecast report (won revenue,
-- pipeline value, win rate, monthly revenue trend + next-month forecast via
-- linear regression, funnel counts, top customers, lead sources) should be
-- computed in db-mysql.js / the analytics route instead of as a MySQL
-- function, since regr_slope/regr_intercept and generate_series have no
-- MySQL equivalent.

-- ============================================================
-- 2026-08 Sales + INR + Admin diagnostics upgrade
-- ============================================================

ALTER TABLE leads
  ADD COLUMN value_source TEXT NOT NULL DEFAULT ('manual');

ALTER TABLE opportunities
  ADD COLUMN value_source TEXT NOT NULL DEFAULT ('manual');

-- admin_login_activity (table + its indexes) is created by
-- gmfdmmzn_proflow_auth.sql. CREATE TABLE IF NOT EXISTS below is a safe
-- no-op if that ran first — but its indexes are NOT re-added here, since
-- MySQL has no ADD INDEX IF NOT EXISTS and auth.sql already creates them
-- under the same names. Run gmfdmmzn_proflow_auth.sql at some point
-- (before or after this file) so this table ends up indexed; if you ever
-- run this file completely on its own, add those two indexes manually:
--   ALTER TABLE admin_login_activity ADD INDEX idx_admin_login_activity_created (created_at DESC);
--   ALTER TABLE admin_login_activity ADD INDEX idx_admin_login_activity_email (email(191));
CREATE TABLE IF NOT EXISTS admin_login_activity (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT,
  event_type TEXT NOT NULL DEFAULT ('session_seen'),
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- NOVA CRM — PROJECTS MODULE (post-sale client project tracking)
-- Onboarding, contract, team, meetings, attachments, billing,
-- invoices, purchase orders, payments.
--
-- A project is created from a won Opportunity: it links to the
-- customer, the opportunity it came from, and the product sold.
-- Run AFTER the tables above (needs customers, opportunities, products).
-- ============================================================

-- ============================================================
-- Core project record
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_name TEXT NOT NULL,
  customer_id BIGINT,
  opportunity_id BIGINT,
  product_id BIGINT,

  status TEXT NOT NULL DEFAULT ('Onboarding'),        -- Onboarding / Active / On Hold / Completed / Cancelled

  -- Client Onboarding
  is_onboarded BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_date DATE,

  -- Project Start
  project_start_date DATE,
  initial_discussion_date DATE,

  -- Agreement / Contract
  agreement_start_date DATE,
  agreement_end_date DATE,
  contract_duration TEXT,                           -- e.g. "12 months"
  services_covered TEXT,

  -- Service Details
  service_name TEXT,
  service_duration TEXT,
  service_active_until DATE,

  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_projects_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT fk_projects_opportunity FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL,
  CONSTRAINT fk_projects_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);
ALTER TABLE projects ADD INDEX idx_projects_customer (customer_id);
ALTER TABLE projects ADD INDEX idx_projects_opportunity (opportunity_id);
ALTER TABLE projects ADD INDEX idx_projects_product (product_id);
ALTER TABLE projects ADD INDEX idx_projects_status (status(191));
ALTER TABLE projects ADD INDEX idx_projects_created (created_at DESC);

-- ============================================================
-- Project Team / Assignment
-- ============================================================
CREATE TABLE IF NOT EXISTS project_team_members (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  member_name TEXT NOT NULL,
  role TEXT,
  assigned_from DATE,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_project_team_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
ALTER TABLE project_team_members ADD INDEX idx_project_team_project (project_id);

-- ============================================================
-- Meetings / MoM
-- ============================================================
CREATE TABLE IF NOT EXISTS project_meetings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  meeting_title TEXT NOT NULL,
  meeting_date TIMESTAMP NULL,
  is_first_meeting BOOLEAN NOT NULL DEFAULT FALSE,
  discussion_summary TEXT,
  mom TEXT,                                         -- minutes of meeting
  notes_url TEXT,                                   -- where fuller notes are stored
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_project_meetings_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
ALTER TABLE project_meetings ADD INDEX idx_project_meetings_project (project_id);
ALTER TABLE project_meetings ADD INDEX idx_project_meetings_date (meeting_date DESC);

-- ============================================================
-- Attachments / Documents (project + agreement files)
-- ============================================================
CREATE TABLE IF NOT EXISTS project_attachments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  attachment_type TEXT NOT NULL DEFAULT ('Other'),     -- Agreement / Contract / Other
  file_name TEXT NOT NULL,
  file_url TEXT,
  uploaded_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_project_attachments_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
ALTER TABLE project_attachments ADD INDEX idx_project_attachments_project (project_id);

-- ============================================================
-- Billing
-- ============================================================
CREATE TABLE IF NOT EXISTS project_billing (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  billing_frequency TEXT NOT NULL DEFAULT ('One-Time'), -- Monthly / Quarterly / Half-Yearly / Yearly / One-Time
  first_billing_date DATE,
  next_billing_date DATE,
  billing_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_project_billing_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
ALTER TABLE project_billing ADD INDEX idx_project_billing_project (project_id);

-- ============================================================
-- Invoices
-- ============================================================
CREATE TABLE IF NOT EXISTS project_invoices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  invoice_number TEXT,
  generated_in_software BOOLEAN NOT NULL DEFAULT TRUE,
  invoice_date DATE,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  file_url TEXT,
  status TEXT NOT NULL DEFAULT ('Generated'),          -- Generated / Sent / Paid
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_project_invoices_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
ALTER TABLE project_invoices ADD INDEX idx_project_invoices_project (project_id);
ALTER TABLE project_invoices ADD INDEX idx_project_invoices_status (status(191));

-- ============================================================
-- Purchase Orders
-- ============================================================
CREATE TABLE IF NOT EXISTS project_purchase_orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  po_number TEXT,
  po_issued_date DATE,
  po_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  po_validity_date DATE,
  file_url TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_project_po_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
ALTER TABLE project_purchase_orders ADD INDEX idx_project_po_project (project_id);

-- ============================================================
-- Payments
-- ============================================================
CREATE TABLE IF NOT EXISTS project_payments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  amount_received NUMERIC(14,2) NOT NULL DEFAULT 0,
  received_date DATE,
  received_in_account TEXT,
  payment_status TEXT NOT NULL DEFAULT ('Pending'),    -- Pending / Received / Partial / Overdue
  reference_note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_project_payments_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
ALTER TABLE project_payments ADD INDEX idx_project_payments_project (project_id);
ALTER TABLE project_payments ADD INDEX idx_project_payments_status (payment_status(191));


-- ============================================================
-- SECTION: 3. CLIENT CONTRACT ONBOARDING
-- Source file: client_contract_onboarding_MYSQL_FULLY_FIXED.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS `gmfdmmzn_proflow`;
USE `gmfdmmzn_proflow`;

-- ============================================================
-- NOVA CRM — MySQL 8.0 conversion of client_contract_onboarding.sql
-- All tables, columns, constraints, indexes and seed/migration data retained.
-- PostgreSQL-only procedural blocks were converted to MySQL 8.0 triggers/DDL.
-- ============================================================

-- ============================================================
-- COMBINED CRM — CLIENT CONTRACT / ONBOARDING WORKSPACE
-- Merges OrbitAvanya CRM + Nova CRM contract-workspace schemas
-- into a single additive, idempotent migration.
--
-- Safe to run on either an existing OrbitAvanya schema, an
-- existing Nova CRM schema, or a fresh database.
--
-- Run after your existing CRM/auth schema (needs crm_users,
-- and optionally customers).
-- ============================================================

BEGIN;
-- PostgreSQL extension pgcrypto is not required in MySQL 8.0.
-- ------------------------------------------------------------
-- 1. CONTRACT MASTER
-- Owned by the login user (user_id). customer_id is optional
-- secondary/internal CRM linkage (Nova adds the FK).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contracts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
  customer_id BIGINT,
  contract_number VARCHAR(255) NOT NULL,
  client_company_name TEXT,
  contract_title VARCHAR(255) NOT NULL DEFAULT 'Client Service Agreement',
  status VARCHAR(255) NOT NULL DEFAULT 'Active',
  start_date DATE,
  end_date DATE,
  total_duration TEXT,
  services_covered TEXT,
  contract_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency VARCHAR(255) NOT NULL DEFAULT 'INR',
  contract_document_url TEXT,
  notes TEXT,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);


-- Add the customers FK only if a customers table actually exists
-- (Nova has it, Orbit doesn't) — done conditionally so this script
-- never fails on a database without a customers table.


CREATE UNIQUE INDEX ux_client_contracts_contract_number
  ON client_contracts(contract_number);
CREATE INDEX idx_client_contracts_user_id
  ON client_contracts(user_id);
CREATE INDEX idx_client_contracts_customer
  ON client_contracts(customer_id);
CREATE INDEX idx_client_contracts_status
  ON client_contracts(status);
CREATE INDEX idx_client_contracts_dates
  ON client_contracts(start_date, end_date);

-- ------------------------------------------------------------
-- 2. ONBOARDING / PROJECT START / SERVICE DETAILS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_onboarding (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  onboarding_status VARCHAR(255) NOT NULL DEFAULT 'Pending',
  onboarding_completed_at DATETIME(6),
  onboarding_completed_by TEXT,
  onboarding_notes TEXT,
  project_start_date DATE,
  initial_project_discussion_date DATE,
  project_status VARCHAR(255) NOT NULL DEFAULT 'Not Started',
  current_phase VARCHAR(255) NOT NULL DEFAULT 'Requirement Analysis',
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  service_name TEXT,
  service_duration TEXT,
  service_active_until DATE,
  service_notes TEXT,
  project_notes TEXT,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);


CREATE UNIQUE INDEX ux_client_onboarding_contract
  ON client_onboarding(contract_id);
CREATE INDEX idx_client_onboarding_status
  ON client_onboarding(onboarding_status);

-- ------------------------------------------------------------
-- 3. PROJECT TEAM
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_team (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL,
  member_email TEXT,
  role TEXT,
  department TEXT,
  assignment_start_date DATE,
  assignment_end_date DATE,
  is_current TINYINT(1) NOT NULL DEFAULT 1,
  responsibilities TEXT,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);


CREATE INDEX idx_client_contract_team_contract
  ON client_contract_team(contract_id);
CREATE INDEX idx_client_contract_team_current
  ON client_contract_team(contract_id, is_current);

-- PROJECT TEAM LOGIN-USER ASSIGNMENT REQUESTS
-- These columns are required before the related foreign keys and indexes below.
ALTER TABLE client_contract_team
  ADD COLUMN member_user_id CHAR(36),
  ADD COLUMN assignment_status VARCHAR(255) NOT NULL DEFAULT 'accepted',
  ADD COLUMN requested_at DATETIME(6),
  ADD COLUMN responded_at DATETIME(6),
  ADD COLUMN requested_by_user_id CHAR(36);


-- ------------------------------------------------------------
-- 4. MEETINGS / MoM
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_meetings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  meeting_title TEXT NOT NULL,
  meeting_date DATETIME(6),
  meeting_type VARCHAR(255) DEFAULT 'Project Meeting',
  participants TEXT,
  discussion TEXT,
  minutes_of_meeting TEXT,
  action_items TEXT,
  notes_storage_url TEXT,
  created_by TEXT,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);


CREATE INDEX idx_client_contract_meetings_contract
  ON client_contract_meetings(contract_id);
CREATE INDEX idx_client_contract_meetings_date
  ON client_contract_meetings(contract_id, meeting_date DESC);

-- ------------------------------------------------------------
-- 5. DOCUMENTS / ATTACHMENTS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_documents (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  document_type VARCHAR(255) NOT NULL DEFAULT 'Other',
  file_name TEXT NOT NULL,
  file_url TEXT,
  storage_path TEXT,
  mime_type TEXT,
  size_kb NUMERIC(12,2),
  description TEXT,
  uploaded_by TEXT,
  is_client_visible TINYINT(1) NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);


CREATE INDEX idx_client_contract_documents_contract
  ON client_contract_documents(contract_id);
CREATE INDEX idx_client_contract_documents_type
  ON client_contract_documents(contract_id, document_type);

-- ------------------------------------------------------------
-- 6. BILLING CYCLES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_billing (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  billing_cycle_name TEXT,
  billing_frequency VARCHAR(255) NOT NULL DEFAULT 'Monthly',
  billing_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency VARCHAR(255) NOT NULL DEFAULT 'INR',
  first_billing_date DATE,
  next_billing_date DATE,
  cycle_start_date DATE,
  cycle_end_date DATE,
  status VARCHAR(255) NOT NULL DEFAULT 'Active',
  notes TEXT,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);


CREATE INDEX idx_client_contract_billing_contract
  ON client_contract_billing(contract_id);
CREATE INDEX idx_client_contract_billing_next
  ON client_contract_billing(next_billing_date);

-- ------------------------------------------------------------
-- 7. INVOICES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_invoices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  invoice_number VARCHAR(255) NOT NULL,
  invoice_date DATE,
  due_date DATE,
  billing_period_start DATE,
  billing_period_end DATE,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency VARCHAR(255) NOT NULL DEFAULT 'INR',
  status VARCHAR(255) NOT NULL DEFAULT 'Draft',
  invoice_url TEXT,
  generated_in_software TINYINT(1) NOT NULL DEFAULT 1,
  generated_at DATETIME(6),
  notes TEXT,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);


-- Backfill total_amount for any pre-existing rows from the Orbit-style
-- schema (which only had total_amount, no amount/tax split).
UPDATE client_contract_invoices
SET amount = total_amount
WHERE amount = 0 AND total_amount <> 0;

CREATE UNIQUE INDEX ux_client_contract_invoices_number
  ON client_contract_invoices(invoice_number);
CREATE INDEX idx_client_contract_invoices_contract
  ON client_contract_invoices(contract_id);
CREATE INDEX idx_client_contract_invoices_date
  ON client_contract_invoices(invoice_date DESC);
CREATE INDEX idx_client_contract_invoices_status
  ON client_contract_invoices(status);

-- ------------------------------------------------------------
-- 8. PURCHASE ORDERS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_purchase_orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  po_number VARCHAR(255) NOT NULL,
  issue_date DATE,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency VARCHAR(255) NOT NULL DEFAULT 'INR',
  validity_start_date DATE,
  validity_end_date DATE,
  status VARCHAR(255) NOT NULL DEFAULT 'Active',
  po_document_url TEXT,
  notes TEXT,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);


CREATE INDEX idx_client_contract_po_contract
  ON client_contract_purchase_orders(contract_id);
CREATE INDEX idx_client_contract_po_number
  ON client_contract_purchase_orders(po_number);

-- ------------------------------------------------------------
-- 9. PAYMENTS
-- Nova adds invoice_id linkage on top of Orbit's fields.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_payments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  invoice_id BIGINT REFERENCES client_contract_invoices(id) ON DELETE SET NULL,
  payment_date DATE,
  amount_received NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency VARCHAR(255) NOT NULL DEFAULT 'INR',
  payment_status VARCHAR(255) NOT NULL DEFAULT 'Received',
  payment_method TEXT,
  received_account TEXT,
  payment_reference TEXT,
  transaction_reference TEXT,
  receipt_url TEXT,
  notes TEXT,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);




CREATE INDEX idx_client_contract_payments_contract
  ON client_contract_payments(contract_id);
CREATE INDEX idx_client_contract_payments_invoice
  ON client_contract_payments(invoice_id);
CREATE INDEX idx_client_contract_payments_date
  ON client_contract_payments(payment_date DESC);

-- ------------------------------------------------------------
-- 10. ACTIVITY / AUDIT TIMELINE
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_activity (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  actor_user_id CHAR(36),
  actor_name TEXT,
  actor_role TEXT,
  metadata JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);




CREATE INDEX idx_client_contract_activity_contract_created
  ON client_contract_activity(contract_id, created_at DESC);

-- ------------------------------------------------------------
-- 11. updated_at TRIGGERS (applied to every table via loop,
-- Orbit-style, so adding a new table later just means adding
-- its name to the array)
-- ------------------------------------------------------------
-- ------------------------------------------------------------
-- 12. AUTO-CREATE ONBOARDING ROW + ACTIVITY LOG ON NEW CONTRACT
-- (Nova's trigger — new contracts no longer need a manual
-- onboarding insert or activity entry.)
-- ------------------------------------------------------------
-- ------------------------------------------------------------
-- 13. BACKFILL FOR EXISTING DATA
-- Seed missing onboarding rows for any contract created before
-- this migration (the trigger above only fires on new inserts),
-- and clamp legacy progress values into range.
-- ------------------------------------------------------------
INSERT INTO client_onboarding (contract_id)
SELECT cc.id
FROM client_contracts cc
LEFT JOIN client_onboarding co ON co.contract_id = cc.id
WHERE co.contract_id IS NULL;

UPDATE client_onboarding
SET progress_percent = GREATEST(0, LEAST(100, COALESCE(progress_percent, 0)));


-- ============================================================
-- MySQL 8.0 trigger equivalents
-- ============================================================
ALTER TABLE client_contracts
  ADD CONSTRAINT client_contracts_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;

ALTER TABLE client_contract_payments
  ADD CONSTRAINT client_contract_payments_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES client_contract_invoices(id) ON DELETE SET NULL;

ALTER TABLE client_contract_activity
  ADD CONSTRAINT client_contract_activity_actor_user_id_fkey
  FOREIGN KEY (actor_user_id) REFERENCES crm_users(id) ON DELETE SET NULL;

ALTER TABLE client_contract_team
  ADD CONSTRAINT client_contract_team_member_user_id_fkey
  FOREIGN KEY (member_user_id) REFERENCES crm_users(id) ON DELETE SET NULL;

ALTER TABLE client_contract_team
  ADD CONSTRAINT client_contract_team_requested_by_user_id_fkey
  FOREIGN KEY (requested_by_user_id) REFERENCES crm_users(id) ON DELETE SET NULL;

ALTER TABLE client_contract_team
  ADD CONSTRAINT client_contract_team_assignment_status_check
  CHECK (assignment_status IN ('pending', 'accepted', 'declined', 'cancelled'));

DELIMITER //

DROP TRIGGER IF EXISTS trg_client_contracts_updated_at//
CREATE TRIGGER trg_client_contracts_updated_at
BEFORE UPDATE ON client_contracts
FOR EACH ROW
BEGIN
  SET NEW.updated_at = CURRENT_TIMESTAMP(6);
END//

DROP TRIGGER IF EXISTS trg_client_onboarding_updated_at//
CREATE TRIGGER trg_client_onboarding_updated_at
BEFORE UPDATE ON client_onboarding
FOR EACH ROW
BEGIN
  SET NEW.updated_at = CURRENT_TIMESTAMP(6);
END//

DROP TRIGGER IF EXISTS trg_client_contract_team_updated_at//
CREATE TRIGGER trg_client_contract_team_updated_at
BEFORE UPDATE ON client_contract_team
FOR EACH ROW
BEGIN
  SET NEW.updated_at = CURRENT_TIMESTAMP(6);
END//

DROP TRIGGER IF EXISTS trg_client_contract_meetings_updated_at//
CREATE TRIGGER trg_client_contract_meetings_updated_at
BEFORE UPDATE ON client_contract_meetings
FOR EACH ROW
BEGIN
  SET NEW.updated_at = CURRENT_TIMESTAMP(6);
END//

DROP TRIGGER IF EXISTS trg_client_contract_documents_updated_at//
CREATE TRIGGER trg_client_contract_documents_updated_at
BEFORE UPDATE ON client_contract_documents
FOR EACH ROW
BEGIN
  SET NEW.updated_at = CURRENT_TIMESTAMP(6);
END//

DROP TRIGGER IF EXISTS trg_client_contract_billing_updated_at//
CREATE TRIGGER trg_client_contract_billing_updated_at
BEFORE UPDATE ON client_contract_billing
FOR EACH ROW
BEGIN
  SET NEW.updated_at = CURRENT_TIMESTAMP(6);
END//

DROP TRIGGER IF EXISTS trg_client_contract_invoices_updated_at//
CREATE TRIGGER trg_client_contract_invoices_updated_at
BEFORE UPDATE ON client_contract_invoices
FOR EACH ROW
BEGIN
  SET NEW.updated_at = CURRENT_TIMESTAMP(6);
END//

DROP TRIGGER IF EXISTS trg_client_contract_purchase_orders_updated_at//
CREATE TRIGGER trg_client_contract_purchase_orders_updated_at
BEFORE UPDATE ON client_contract_purchase_orders
FOR EACH ROW
BEGIN
  SET NEW.updated_at = CURRENT_TIMESTAMP(6);
END//

DROP TRIGGER IF EXISTS trg_client_contract_payments_updated_at//
CREATE TRIGGER trg_client_contract_payments_updated_at
BEFORE UPDATE ON client_contract_payments
FOR EACH ROW
BEGIN
  SET NEW.updated_at = CURRENT_TIMESTAMP(6);
END//

DROP TRIGGER IF EXISTS trg_client_contracts_create_workspace//
CREATE TRIGGER trg_client_contracts_create_workspace
AFTER INSERT ON client_contracts
FOR EACH ROW
BEGIN
  INSERT IGNORE INTO client_onboarding (contract_id) VALUES (NEW.id);
  INSERT INTO client_contract_activity
    (contract_id, activity_type, title, description)
  VALUES
    (NEW.id, 'contract_created', 'Contract workspace created',
     'A contract workspace was created for the client login.');
END//

DELIMITER ;

COMMIT;

-- ============================================================
-- 10A. COMPANY BANK ACCOUNTS
-- Originally created by the application payment schema upgrade.
-- Included here so the MySQL schema contains the complete project table.
-- ============================================================
CREATE TABLE IF NOT EXISTS company_bank_accounts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_label VARCHAR(255) NOT NULL,
  account_holder_name VARCHAR(255),
  bank_name VARCHAR(255),
  account_number VARCHAR(255),
  ifsc_code VARCHAR(255),
  upi_id VARCHAR(255),
  branch VARCHAR(255),
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);

CREATE INDEX idx_company_bank_accounts_active
  ON company_bank_accounts(is_active);

-- ============================================================
-- VERIFICATION QUERY
-- ============================================================
SELECT
  u.id AS user_id,
  u.full_name,
  u.email,
  u.role,
  cc.id AS contract_id,
  cc.contract_number,
  cc.client_company_name,
  cc.status,
  co.onboarding_status,
  co.project_start_date,
  co.progress_percent
FROM crm_users u
LEFT JOIN client_contracts cc ON cc.user_id = u.id
LEFT JOIN client_onboarding co ON co.contract_id = cc.id
WHERE cc.id IS NOT NULL
ORDER BY u.email, cc.id;

-- ============================================================
-- ADMIN EXAMPLES
--
-- List login users:
-- SELECT id, email, full_name, role, email_verified
-- FROM crm_users ORDER BY created_at DESC;
--
-- Create a contract for a login (onboarding row + activity log
-- are created automatically by the trigger):
-- INSERT INTO client_contracts
--   (user_id, contract_number, client_company_name, start_date, end_date,
--    services_covered, contract_value)
-- VALUES
--   ('USER-CHAR(36)', 'ORB-2026-001', 'ABC Technologies',
--    '2026-08-20', '2027-08-19',
--    'CRM Development + AMC', 400000);
--
-- Client access is determined by crm_users.id -> client_contracts.user_id.
-- It does NOT depend on customers.id.
-- ============================================================


-- ============================================================
-- SECTION: 4. TENDER CUSTOMERS + RESEARCH
-- Source file: tender_customers_MYSQL_FIXED_v5.sql
-- ============================================================

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
CALL sp_add_column_if_missing('proposal_files', 'source_type', 'VARCHAR(255) NOT NULL DEFAULT ''crm_customer''');
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
CALL sp_add_column_if_missing('pricing_catalog', 'currency', 'VARCHAR(255) NOT NULL DEFAULT ''USD''');
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
    'VARCHAR(512) GENERATED ALWAYS AS (CASE WHEN is_latest = 1 THEN CONCAT(source, ''|'', company_id) ELSE NULL END) STORED'
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


-- ============================================================
-- SECTION: 5. SCANNING & DIGITIZATION MODULE
-- Source file: scanning_MYSQL_FULLY_FIXED.sql
-- ============================================================

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
    'VARCHAR(10) NOT NULL DEFAULT ''SAM'''
);

CALL sp_scan_add_column_if_missing(
    'digitization_tenders_subcontracting', 'source',
    'VARCHAR(10) NOT NULL DEFAULT ''SAM'''
);

CALL sp_scan_add_column_if_missing(
    'digitization_scan_runs', 'source',
    'VARCHAR(10) NOT NULL DEFAULT ''SAM'''
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


-- ============================================================
-- SECTION: 6. DEMO DATA
-- Source file: demo_MYSQL_FULLY_FIXED.sql
-- ============================================================

-- ============================================================
-- NOVA CRM — DEMO DATA (MySQL 8.0)
-- Converted from the supplied PostgreSQL demo.sql.
-- All demo rows and business content are retained; only SQL syntax
-- needed for MySQL 8.0 compatibility has been adapted.
-- Target database: gmfdmmzn_proflow
-- ============================================================

CREATE DATABASE IF NOT EXISTS gmfdmmzn_proflow;
USE gmfdmmzn_proflow;
SET NAMES utf8mb4;
SET SQL_SAFE_UPDATES = 0;

-- ============================================================
-- NOVA CRM — DEMO DATA
-- Products, Leads, Pipeline, Documents (all 4 subsections),
-- Communications
--
-- Safe to re-run: every insert below is guarded with a natural-key
-- check or INSERT IGNORE where the original script was not idempotent.
-- Run orbit_mysql_FIXED.sql FIRST — this depends on that schema.
-- ============================================================

START TRANSACTION;

-- ============================================================
-- Customers (needed so everything else has something to link to)
-- ============================================================
INSERT INTO customers (company_name, contact_name, email, phone, website, industry, city, state, country, status, owner_id, ceo_name)
SELECT v.company_name, v.contact_name, v.email, v.phone, v.website, v.industry, v.city, v.state, v.country, v.status, v.owner_id, v.ceo_name
FROM (
  SELECT 'Sunrise Logistics Pvt Ltd' AS company_name,'Ravi Deshmukh' AS contact_name,'ravi@sunriselogistics.in' AS email,'+91 9820011223' AS phone,'sunriselogistics.in' AS website,'Logistics' AS industry,'Pune' AS city,'Maharashtra' AS state,'India' AS country,'Active' AS status,'sahil' AS owner_id,'Anil Deshmukh' AS ceo_name
  UNION ALL SELECT 'BrightPath EdTech','Neha Kulkarni','neha@brightpathedu.com','+91 9822033445','brightpathedu.com','Education','Mumbai','Maharashtra','India','Active','sahil','Suresh Kulkarni'
  UNION ALL SELECT 'GreenLeaf Foods','Amit Shah','amit@greenleaffoods.in','+91 9812044556','greenleaffoods.in','FMCG','Ahmedabad','Gujarat','India','Active','sahil','Manish Shah'
  UNION ALL SELECT 'Vertex Manufacturing','Priya Nair','priya@vertexmfg.com','+91 9845055667','vertexmfg.com','Manufacturing','Bengaluru','Karnataka','India','Active','sahil','Rajesh Nair'
  UNION ALL SELECT 'Coral Hospitality Group','Sanjay Rao','sanjay@coralhg.com','+91 9867066778','coralhg.com','Hospitality','Goa','Goa','India','Prospect','sahil',NULL
  UNION ALL SELECT 'NimbusTech Solutions','Anjali Mehta','anjali@nimbustech.io','+91 9876077889','nimbustech.io','IT Services','Pune','Maharashtra','India','Prospect','sahil',NULL
) AS v
WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.company_name = v.company_name);

-- ============================================================
-- Products (CRM-001 already seeded by the schema file)
-- ============================================================
INSERT INTO products (name, description, sku, category, price, tax_rate, discount, is_package, active)
SELECT v.name, v.description, v.sku, v.category, v.price, v.tax_rate, v.discount, v.is_package, v.active
FROM (
  SELECT 'ERP Development' AS name,'Custom ERP build and rollout' AS description,'ERP-001' AS sku,'Software' AS category,120000 AS price,18 AS tax_rate,0 AS discount,FALSE AS is_package,TRUE AS active
  UNION ALL SELECT 'School ERP','Ready-to-deploy school management ERP','SCH-001','Software',50000,18,5,TRUE,TRUE
  UNION ALL SELECT 'E-commerce Website','Full online store with payment integration','ECM-001','Web',35000,18,0,FALSE,TRUE
  UNION ALL SELECT 'Business Website','5-10 page business website','WEB-001','Web',8000,18,0,FALSE,TRUE
  UNION ALL SELECT 'Android App','Native Android application','AND-001','Mobile',20000,18,0,FALSE,TRUE
  UNION ALL SELECT 'UI/UX Design Package','Design-only engagement','UIX-001','Design',12000,18,10,FALSE,TRUE
) AS v
WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.sku = v.sku);

-- ============================================================
-- Leads
-- ============================================================
INSERT INTO leads (title, source, status, estimated_value, customer_id, notes, assigned_to, score, ai_insight)
SELECT v.title, v.source, v.status, v.estimated_value, c.id, v.notes, v.assigned_to, v.score, v.ai_insight
FROM (
  SELECT 'Sunrise Logistics — Fleet Tracking CRM' AS title,'Website' AS source,'new' AS status,180000 AS estimated_value,'Sunrise Logistics Pvt Ltd' AS customer_name,'Wants fleet + delivery tracking module included' AS notes,'sahil' AS assigned_to,72 AS score,'Strong budget signal, fast follow-up recommended' AS ai_insight
  UNION ALL SELECT 'BrightPath — Student LMS','Referral','contacted',150000,'BrightPath EdTech','Comparing us against 2 other vendors','sahil',65,'Price-sensitive, emphasize AMC value'
  UNION ALL SELECT 'GreenLeaf Foods — Inventory System','Cold Call','qualified',30000,'GreenLeaf Foods','Needs barcode scanning support','sahil',58,'Mid-size deal, quick close likely'
  UNION ALL SELECT 'Vertex Manufacturing — ERP Upgrade','Website','qualified',250000,'Vertex Manufacturing','Migrating off legacy on-prem ERP','sahil',80,'High-value enterprise lead, prioritize'
  UNION ALL SELECT 'Coral Hospitality — Booking Portal','LinkedIn','new',45000,'Coral Hospitality Group','Multi-property booking requirement','sahil',50,'Early stage, needs discovery call'
  UNION ALL SELECT 'NimbusTech — Corporate Website Revamp','Referral','new',20000,'NimbusTech Solutions','Wants modern redesign within 6 weeks','sahil',40,'Small deal, fast turnaround expected'
) AS v
JOIN customers c ON c.company_name = v.customer_name
WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE l.title = v.title);

-- ============================================================
-- Pipeline (Opportunities)
-- ============================================================
INSERT INTO opportunities (title, customer_id, lead_id, stage, value, probability, expected_close_date, owner, notes)
SELECT v.title, c.id, l.id, v.stage, v.value, v.probability, v.expected_close_date, v.owner, v.notes
FROM (
  SELECT 'Vertex Manufacturing — ERP Upgrade Deal' AS title,'Vertex Manufacturing' AS customer_name,'Vertex Manufacturing — ERP Upgrade' AS lead_title,'Negotiation' AS stage,250000 AS value,70 AS probability,'2026-09-15' AS expected_close_date,'sahil' AS owner,'Final pricing round with procurement team' AS notes
  UNION ALL SELECT 'GreenLeaf Foods — Inventory Deal','GreenLeaf Foods','GreenLeaf Foods — Inventory System','Proposal',30000,55,'2026-09-05','sahil','Proposal sent, awaiting feedback'
  UNION ALL SELECT 'BrightPath — LMS Deal','BrightPath EdTech','BrightPath — Student LMS','Qualification',150000,40,'2026-10-01','sahil','Second demo scheduled'
  UNION ALL SELECT 'Sunrise Logistics — Fleet CRM Deal','Sunrise Logistics Pvt Ltd','Sunrise Logistics — Fleet Tracking CRM','Prospecting',180000,25,'2026-10-20','sahil','Initial discovery call done'
  UNION ALL SELECT 'Coral Hospitality — Booking Deal','Coral Hospitality Group','Coral Hospitality — Booking Portal','Prospecting',45000,20,'2026-11-01','sahil','Awaiting requirement doc from client'
  UNION ALL SELECT 'Legacy Client — CRM Renewal','GreenLeaf Foods',NULL,'Closed Won',40000,100,'2026-08-01','sahil','Annual renewal, signed'
) AS v
JOIN customers c ON c.company_name = v.customer_name
LEFT JOIN leads l ON l.title = v.lead_title
WHERE NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.title = v.title);

-- ============================================================
-- Documents module — subsection 1: Documents
-- ============================================================
INSERT INTO documents (file_name, category, customer_id, uploaded_by, file_url, size_kb, is_shared)
SELECT v.file_name, v.category, c.id, v.uploaded_by, v.file_url, v.size_kb, v.is_shared
FROM (
  SELECT 'Vertex_Manufacturing_Requirements.pdf' AS file_name,'Report' AS category,'Vertex Manufacturing' AS customer_name,'sahil' AS uploaded_by,'/files/vertex_requirements.pdf' AS file_url,842 AS size_kb,TRUE AS is_shared
  UNION ALL SELECT 'GreenLeaf_Inventory_Scope.docx','Report','GreenLeaf Foods','sahil','/files/greenleaf_scope.docx',310,FALSE
  UNION ALL SELECT 'BrightPath_LMS_Wireframes.pdf','Other','BrightPath EdTech','sahil','/files/brightpath_wireframes.pdf',1200,TRUE
) AS v
JOIN customers c ON c.company_name = v.customer_name
WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.file_name = v.file_name);

-- ============================================================
-- Documents module — subsection 2: Contracts
-- ============================================================
INSERT INTO contracts (contract_number, customer_id, start_date, end_date, status, value, sales_owner, notes)
SELECT v.contract_number, c.id, v.start_date, v.end_date, v.status, v.value, v.sales_owner, v.notes
FROM (
  SELECT 'CNT-2026-001' AS contract_number,'GreenLeaf Foods' AS customer_name,'2026-08-01' AS start_date,'2027-07-31' AS end_date,'Active' AS status,40000 AS value,'sahil' AS sales_owner,'Annual CRM renewal contract' AS notes
  UNION ALL SELECT 'CNT-2026-002','Vertex Manufacturing','2026-09-20','2027-09-19','Draft',250000,'sahil','Pending final signature'
) AS v
JOIN customers c ON c.company_name = v.customer_name
WHERE NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.contract_number = v.contract_number);

-- ============================================================
-- Documents module — subsection 3: Proposal Files
-- ============================================================
INSERT INTO proposal_files (proposal_number, customer_id, opportunity, created_by, status, version, file_url)
SELECT v.proposal_number, c.id, v.opportunity, v.created_by, v.status, v.version, v.file_url
FROM (
  SELECT 'PROP-2026-101' AS proposal_number,'Vertex Manufacturing' AS customer_name,'Vertex Manufacturing — ERP Upgrade Deal' AS opportunity,'sahil' AS created_by,'Sent' AS status,2 AS version,'/files/prop_vertex_erp_v2.pdf' AS file_url
  UNION ALL SELECT 'PROP-2026-102','GreenLeaf Foods','GreenLeaf Foods — Inventory Deal','sahil','Draft',1,'/files/prop_greenleaf_inv_v1.pdf'
) AS v
JOIN customers c ON c.company_name = v.customer_name
WHERE NOT EXISTS (SELECT 1 FROM proposal_files pf WHERE pf.proposal_number = v.proposal_number);

-- ============================================================
-- Documents module — subsection 4: Customer Files
-- ============================================================
INSERT INTO customer_files (customer_id, document_type, file_url, uploaded_by, expiry_date, status)
SELECT c.id, v.document_type, v.file_url, v.uploaded_by, v.expiry_date, v.status
FROM (
  SELECT 'Vertex Manufacturing' AS customer_name,'GST Certificate' AS document_type,'/files/vertex_gst.pdf' AS file_url,'sahil' AS uploaded_by,'2027-03-31' AS expiry_date,'Approved' AS status
  UNION ALL SELECT 'GreenLeaf Foods','PAN Card','/files/greenleaf_pan.pdf','sahil',NULL,'Approved'
  UNION ALL SELECT 'BrightPath EdTech','Company Registration','/files/brightpath_incorp.pdf','sahil',NULL,'Pending'
) AS v
JOIN customers c ON c.company_name = v.customer_name
WHERE NOT EXISTS (
  SELECT 1 FROM customer_files cf WHERE cf.customer_id = c.id AND cf.document_type = v.document_type
);

-- ============================================================
-- Communications
-- ============================================================
INSERT INTO communications (customer_id, lead_id, opportunity_id, type, direction, subject, body, sender_email, sender_name, recipient_email, recipient_name, status, message_id, is_read, sent_at, received_at)
SELECT c.id, l.id, o.id, v.type, v.direction, v.subject, v.body, v.sender_email, v.sender_name, v.recipient_email, v.recipient_name, v.status, v.message_id, v.is_read, v.sent_at, v.received_at
FROM (
  SELECT 'Vertex Manufacturing' AS customer_name,'Vertex Manufacturing — ERP Upgrade' AS lead_title,'Vertex Manufacturing — ERP Upgrade Deal' AS opportunity_title,'email' AS type,'outbound' AS direction,'ERP Proposal for Vertex Manufacturing' AS subject,'Hi Priya, please find attached our proposal for the ERP upgrade...' AS body,'pradeep@orbitavanyatech.com' AS sender_email,'Pradeep Singh' AS sender_name,'priya@vertexmfg.com' AS recipient_email,'Priya Nair' AS recipient_name,'sent' AS status,'msg-vertex-001' AS message_id,TRUE AS is_read,'2026-08-12 10:15:00' AS sent_at,NULL AS received_at
  UNION ALL SELECT 'Vertex Manufacturing','Vertex Manufacturing — ERP Upgrade','Vertex Manufacturing — ERP Upgrade Deal','email','inbound','Re: ERP Proposal for Vertex Manufacturing','Thanks, we are reviewing internally and will revert by Friday.','priya@vertexmfg.com','Priya Nair','pradeep@orbitavanyatech.com','Pradeep Singh','received','msg-vertex-002',TRUE,NULL,'2026-08-13 09:40:00'
  UNION ALL SELECT 'GreenLeaf Foods','GreenLeaf Foods — Inventory System','GreenLeaf Foods — Inventory Deal','email','outbound','Inventory System Proposal','Hi Amit, sharing the proposal for the inventory management system.','pradeep@orbitavanyatech.com','Pradeep Singh','amit@greenleaffoods.in','Amit Shah','sent','msg-greenleaf-001',FALSE,'2026-08-14 11:00:00',NULL
  UNION ALL SELECT 'BrightPath EdTech','BrightPath — Student LMS','BrightPath — LMS Deal','call','outbound','Discovery call — LMS requirements','Discussed core LMS modules and rollout timeline.','pradeep@orbitavanyatech.com','Pradeep Singh','neha@brightpathedu.com','Neha Kulkarni','completed','msg-brightpath-001',TRUE,'2026-08-10 15:30:00',NULL
  UNION ALL SELECT 'Sunrise Logistics Pvt Ltd','Sunrise Logistics — Fleet Tracking CRM',NULL,'email','inbound','Fleet tracking CRM — initial enquiry','We are looking for a CRM with live fleet tracking, can you help?','ravi@sunriselogistics.in','Ravi Deshmukh','pradeep@orbitavanyatech.com','Pradeep Singh','received','msg-sunrise-001',TRUE,NULL,'2026-08-11 08:20:00'
) AS v
JOIN customers c ON c.company_name = v.customer_name
LEFT JOIN leads l ON l.title = v.lead_title
LEFT JOIN opportunities o ON o.title = v.opportunity_title
WHERE NOT EXISTS (SELECT 1 FROM communications co WHERE co.message_id = v.message_id);

COMMIT;

-- ============================================================
-- DEMO DATA — Client Contract / Onboarding Workspace
-- Populates one full example client (ABC Technologies) so you
-- can see every field on the Client Onboarding page filled in.
--
-- HOW TO USE
-- 1. Just run this whole file against your database. It creates
--    its own demo login automatically:
--
--        Email:    demo.client@example.com
--        Password: Demo@12345
--
-- 2. Log in as demo.client@example.com (or as any admin/staff
--    user) and open Client Onboarding — fully populated.
-- 3. To attach the demo data to a different, existing login, change
--    the demo_user_email variable below.
--
-- Safe to re-run: only the demo contract matched by
-- contract_number = 'CNT-2026-DEMO-001' is deleted and rebuilt.
-- ============================================================

START TRANSACTION;

-- ------------------------------------------------------------
-- 0. DEMO LOGIN (created only if it doesn't already exist)
-- Email:    demo.client@example.com
-- Password: Demo@12345
-- ------------------------------------------------------------
INSERT INTO crm_users
    (email, password_hash, password_salt, full_name, role, email_verified)
SELECT
    'demo.client@example.com',
    '98450715833f658101e1cbedf622a1d5f274c5086cb89c02657ecce85de88e390df2f78fc94f9ee3f6bdb06a22fade6fe6121466ee6f3cc0be9a4090654130c4',
    '994bf557726ba2a2874d26bbd4360a07',
    'John Smith',
    'client',
    TRUE
WHERE NOT EXISTS (
    SELECT 1 FROM crm_users WHERE LOWER(email) = LOWER('demo.client@example.com')
);

SET @demo_user_email = 'demo.client@example.com';
SET @v_user_id = (
    SELECT id FROM crm_users
    WHERE LOWER(email) = LOWER(@demo_user_email)
    LIMIT 1
);

-- ============================================================
-- Additional test contract from the supplied demo.sql
-- MySQL-safe and re-runnable. It targets the demo login created below.
-- ============================================================
INSERT IGNORE INTO client_contracts (
    user_id,
    contract_number,
    client_company_name,
    contract_title,
    status,
    start_date,
    end_date,
    total_duration,
    services_covered,
    contract_value,
    currency,
    notes
)
SELECT
    id,
    'TEST-001',
    'Test Client Company',
    'Client Service Agreement',
    'Active',
    CURRENT_DATE,
    DATE_ADD(CURRENT_DATE, INTERVAL 1 YEAR),
    '12 months',
    'CRM Software Services',
    0,
    'INR',
    'Test contract for validating client onboarding.'
FROM crm_users
WHERE LOWER(email) = LOWER('demo.client@example.com')
LIMIT 1;

SELECT * FROM client_contracts WHERE contract_number = 'TEST-001';

-- Clean up any previous run of this demo (idempotent re-seed)
DELETE FROM client_contracts WHERE contract_number = 'CNT-2026-DEMO-001';

-- ----------------------------------------------------------
-- 1. CONTRACT MASTER  (Agreement / Contract section)
-- ----------------------------------------------------------
INSERT INTO client_contracts
  (user_id, contract_number, client_company_name, contract_title, status,
   start_date, end_date, total_duration, services_covered,
   contract_value, currency, contract_document_url, notes)
VALUES
  (@v_user_id, 'CNT-2026-DEMO-001', 'ABC Technologies', 'Annual Managed Services Agreement', 'Active',
   '2026-08-21', '2027-08-20', '12 Months',
   'CRM Development, Cloud Hosting & Support, Monthly Maintenance (AMC)',
   900000, 'INR', 'https://files.example.com/contracts/abc-technologies-msa-2026.pdf',
   'Signed via DocuSign on 20 Aug 2026. Renewal to be reviewed 60 days before end date.');

SET @v_contract_id = LAST_INSERT_ID();

-- The insert trigger auto-creates a blank client_onboarding row
-- and a "contract workspace created" activity entry. We now
-- fill that onboarding row in with real demo values.

-- ----------------------------------------------------------
-- 2. ONBOARDING / PROJECT START / SERVICE DETAILS
-- ----------------------------------------------------------
UPDATE client_onboarding SET
  onboarding_status = 'Completed',
  onboarding_completed_at = '2026-08-20 10:42:00',
  onboarding_completed_by = 'Pradeep Singh',
  onboarding_notes = 'All initial requirements collected and client orientation completed. KYC and technical access handed over.',
  project_start_date = '2026-08-21',
  initial_project_discussion_date = '2026-08-15',
  project_status = 'In Progress',
  current_phase = 'Requirement Analysis',
  progress_percent = 35,
  service_name = 'CRM Development',
  service_duration = '12 Months',
  service_active_until = '2027-08-20',
  service_notes = 'Custom CRM build covering sales pipeline, onboarding workspace and billing modules, plus 12 months of AMC support.',
  project_notes = 'Kickoff completed. Requirement document shared with client for sign-off. Sprint 1 planning scheduled for 28 Aug 2026.'
WHERE contract_id = @v_contract_id;

-- ----------------------------------------------------------
-- 3. PROJECT TEAM
-- ----------------------------------------------------------
INSERT INTO client_contract_team
  (contract_id, member_name, member_email, role, department, assignment_start_date, is_current, responsibilities)
VALUES
  (@v_contract_id, 'Neha Sharma', 'neha.sharma@nova.com', 'Project Manager', 'Delivery', '2026-08-21', TRUE,
   'Overall delivery ownership, client communication, sprint planning and status reporting.'),
  (@v_contract_id, 'Arjun Mehta', 'arjun.mehta@nova.com', 'Lead Developer', 'Engineering', '2026-08-21', TRUE,
   'Backend architecture, API development and code reviews.'),
  (@v_contract_id, 'Priya Nair', 'priya.nair@nova.com', 'UI/UX Designer', 'Design', '2026-08-21', TRUE,
   'Wireframes, UI design system and usability testing.'),
  (@v_contract_id, 'Rohit Verma', 'rohit.verma@nova.com', 'QA Engineer', 'Engineering', '2026-08-24', TRUE,
   'Test planning, functional QA and release sign-off.');

-- ----------------------------------------------------------
-- 4. MEETINGS & MoM
-- ----------------------------------------------------------
INSERT INTO client_contract_meetings
  (contract_id, meeting_title, meeting_date, meeting_type, participants, discussion,
   minutes_of_meeting, action_items, notes_storage_url, created_by)
VALUES
  (@v_contract_id, 'Kickoff & Requirement Discussion', '2026-08-15 11:00:00', 'Kickoff Meeting',
   'Neha Sharma (Nova), Pradeep Singh (Nova), John Smith (ABC Technologies), Sarah Lee (ABC Technologies)',
   'Reviewed scope of work, confirmed timelines, discussed integration requirements with existing ERP and data migration approach.',
   'Client confirmed 12-month engagement. Nova to share detailed requirement document by 18 Aug. Client to provide ERP API access by 20 Aug.',
   'Nova: share requirement doc (due 18 Aug). Client: share ERP credentials (due 20 Aug). Both: confirm sprint cadence (weekly).',
   'https://drive.example.com/abc-technologies/meetings/kickoff-15aug2026',
   'Pradeep Singh'),
  (@v_contract_id, 'Sprint 1 Planning', '2026-08-23 15:30:00', 'Project Meeting',
   'Neha Sharma (Nova), Arjun Mehta (Nova), John Smith (ABC Technologies)',
   'Walked through Sprint 1 backlog covering authentication, client onboarding module and dashboard shell.',
   'Sprint 1 scope finalized. Demo scheduled for 06 Sep 2026. Client raised a request to prioritize the billing module.',
   'Nova: adjust sprint backlog to prioritize billing module. Client: confirm billing field list by 26 Aug.',
   'https://drive.example.com/abc-technologies/meetings/sprint1-23aug2026',
   'Neha Sharma');

-- ----------------------------------------------------------
-- 5. DOCUMENTS / ATTACHMENTS
-- ----------------------------------------------------------
INSERT INTO client_contract_documents
  (contract_id, document_type, file_name, file_url, mime_type, size_kb, uploaded_by, is_client_visible, notes)
VALUES
  (@v_contract_id, 'Agreement', 'ABC_Technologies_MSA_2026.pdf', 'https://files.example.com/contracts/abc-technologies-msa-2026.pdf', 'application/pdf', 812, 'Pradeep Singh', TRUE, 'Signed master service agreement.'),
  (@v_contract_id, 'Requirement Document', 'ABC_Requirement_Doc_v1.pdf', 'https://files.example.com/abc/requirement-doc-v1.pdf', 'application/pdf', 456, 'Neha Sharma', TRUE, 'Approved by client on 18 Aug 2026.'),
  (@v_contract_id, 'Proposal', 'ABC_Technologies_Proposal.pdf', 'https://files.example.com/abc/proposal.pdf', 'application/pdf', 320, 'Pradeep Singh', TRUE, NULL),
  (@v_contract_id, 'NDA', 'ABC_NDA_Signed.pdf', 'https://files.example.com/abc/nda-signed.pdf', 'application/pdf', 140, 'Pradeep Singh', TRUE, 'Executed 10 Aug 2026.'),
  (@v_contract_id, 'Design', 'ABC_UI_Wireframes.pdf', 'https://files.example.com/abc/ui-wireframes.pdf', 'application/pdf', 980, 'Priya Nair', TRUE, 'Sprint 1 wireframes.'),
  (@v_contract_id, 'Invoice', 'INV-2026-0001.pdf', 'https://files.example.com/abc/invoices/INV-2026-0001.pdf', 'application/pdf', 96, 'Nova Billing', TRUE, NULL),
  (@v_contract_id, 'Purchase Order', 'PO-2026-0001.pdf', 'https://files.example.com/abc/po/PO-2026-0001.pdf', 'application/pdf', 88, 'John Smith', TRUE, 'Received from client on 18 Aug 2026.'),
  (@v_contract_id, 'Other', 'ABC_Kickoff_Presentation.pptx', 'https://files.example.com/abc/kickoff-presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 2140, 'Pradeep Singh', TRUE, 'Shared in kickoff meeting.');

-- ----------------------------------------------------------
-- 6. BILLING
-- ----------------------------------------------------------
INSERT INTO client_contract_billing
  (contract_id, billing_cycle_name, billing_frequency, billing_amount, currency,
   first_billing_date, next_billing_date, cycle_start_date, cycle_end_date, status, notes)
VALUES
  (@v_contract_id, 'Monthly Retainer', 'Monthly', 75000, 'INR',
   '2026-08-25', '2026-09-01', '2026-08-21', '2026-09-20', 'Active',
   'Billed on the 1st of every month for the previous cycle.');

-- ----------------------------------------------------------
-- 7. INVOICES  (includes generated_in_software / generated_at)
-- ----------------------------------------------------------
INSERT INTO client_contract_invoices
  (contract_id, invoice_number, invoice_date, due_date, billing_period_start, billing_period_end,
   amount, tax_amount, total_amount, currency, status, invoice_url,
   generated_in_software, generated_at, notes)
VALUES
  (@v_contract_id, 'INV-2026-0001', '2026-08-25', '2026-09-04', '2026-08-21', '2026-08-31',
   75000, 13500, 88500, 'INR', 'Paid', 'https://files.example.com/abc/invoices/INV-2026-0001.pdf',
   TRUE, '2026-08-25 09:15:00', 'First invoice of the engagement, paid on time.'),
  (@v_contract_id, 'INV-2026-0002', '2026-09-01', '2026-09-11', '2026-09-01', '2026-09-30',
   75000, 13500, 88500, 'INR', 'Pending', 'https://files.example.com/abc/invoices/INV-2026-0002.pdf',
   TRUE, '2026-09-01 09:05:00', 'Awaiting payment.');

-- ----------------------------------------------------------
-- 8. PURCHASE ORDERS
-- ----------------------------------------------------------
INSERT INTO client_contract_purchase_orders
  (contract_id, po_number, issue_date, amount, currency,
   validity_start_date, validity_end_date, status, po_document_url, notes)
VALUES
  (@v_contract_id, 'PO-2026-0001', '2026-08-18', 900000, 'INR',
   '2026-08-21', '2027-08-20', 'Active', 'https://files.example.com/abc/po/PO-2026-0001.pdf',
   'Covers the full 12-month engagement value.');

-- ----------------------------------------------------------
-- 9. PAYMENTS
-- ----------------------------------------------------------
INSERT INTO client_contract_payments
  (contract_id, payment_date, amount_received, currency, payment_status,
   payment_method, received_account, payment_reference, transaction_reference, receipt_url, notes)
VALUES
  (@v_contract_id, '2026-08-26', 88500, 'INR', 'Received',
   'Bank Transfer (NEFT)', 'Nova Solutions — HDFC Bank ****4521', 'INV-2026-0001',
   'NEFT-REF-88231045', 'https://files.example.com/abc/receipts/receipt-inv-0001.pdf',
   'Payment against INV-2026-0001, received within due date.');

-- ----------------------------------------------------------
-- 10. ACTIVITY LOG (a few extra entries beyond the auto ones)
-- ----------------------------------------------------------
INSERT INTO client_contract_activity
  (contract_id, activity_type, title, description, actor_name, actor_role)
VALUES
  (@v_contract_id, 'onboarding_completed', 'Onboarding completed', 'Client officially onboarded after orientation call.', 'Pradeep Singh', 'admin'),
  (@v_contract_id, 'project_started', 'Project started', 'Project kicked off and Sprint 1 planning scheduled.', 'Neha Sharma', 'manager'),
  (@v_contract_id, 'agreement_signed', 'Agreement signed', 'Master service agreement executed via DocuSign.', 'Pradeep Singh', 'admin'),
  (@v_contract_id, 'document_uploaded', 'Document uploaded', 'Requirement document v1 uploaded and shared with client.', 'Neha Sharma', 'manager'),
  (@v_contract_id, 'meeting_scheduled', 'Meeting scheduled', 'Sprint 1 planning meeting scheduled with client.', 'Neha Sharma', 'manager'),
  (@v_contract_id, 'invoice_generated', 'Invoice generated', 'INV-2026-0001 generated in software and sent to client.', 'Nova Billing', 'staff'),
  (@v_contract_id, 'payment_received', 'Payment received', 'Payment of INR 88,500 received against INV-2026-0001.', 'Nova Billing', 'staff');

COMMIT;

-- ============================================================
-- VERIFY
-- ============================================================
SELECT cc.id AS contract_id, cc.contract_number, cc.client_company_name, cc.status,
       co.onboarding_status, co.project_status, co.progress_percent,
       (SELECT COUNT(*) FROM client_contract_team t WHERE t.contract_id = cc.id) AS team_count,
       (SELECT COUNT(*) FROM client_contract_meetings m WHERE m.contract_id = cc.id) AS meeting_count,
       (SELECT COUNT(*) FROM client_contract_documents d WHERE d.contract_id = cc.id) AS document_count,
       (SELECT COUNT(*) FROM client_contract_invoices i WHERE i.contract_id = cc.id) AS invoice_count,
       (SELECT COUNT(*) FROM client_contract_payments p WHERE p.contract_id = cc.id) AS payment_count
FROM client_contracts cc
LEFT JOIN client_onboarding co ON co.contract_id = cc.id
WHERE cc.contract_number = 'CNT-2026-DEMO-001';
SHOW DATABASES;

UPDATE crm_users
SET email_verified = 1
WHERE email = 'sahilrale15022005@gmail.com';

SELECT email, email_verified
FROM crm_users
WHERE email = 'sahilrale15022005@gmail.com';
