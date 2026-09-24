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
