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
