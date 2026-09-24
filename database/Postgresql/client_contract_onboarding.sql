-- ============================================================
-- COMBINED CRM — CLIENT CONTRACT / ONBOARDING WORKSPACE
-- Merges OrbitAvanya CRM + Nova CRM contract-workspace schemas
-- into a single additive, idempotent migration.
--
-- Safe to run on either an existing OrbitAvanya schema, an
-- existing Nova CRM schema, or a fresh database.
-- Uses CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN
-- IF NOT EXISTS throughout, so re-running is harmless and it
-- will "fill in" whichever columns are missing on either side.
--
-- Run after your existing CRM/auth schema (needs crm_users,
-- and optionally customers).
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1. CONTRACT MASTER
-- Owned by the login user (user_id). customer_id is optional
-- secondary/internal CRM linkage (Nova adds the FK).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contracts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
  customer_id BIGINT,
  contract_number TEXT NOT NULL,
  client_company_name TEXT,
  contract_title TEXT NOT NULL DEFAULT 'Client Service Agreement',
  status TEXT NOT NULL DEFAULT 'Active',
  start_date DATE,
  end_date DATE,
  total_duration TEXT,
  services_covered TEXT,
  contract_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  contract_document_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS customer_id BIGINT;
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS contract_number TEXT;
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS client_company_name TEXT;
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS contract_title TEXT DEFAULT 'Client Service Agreement';
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Active';
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS total_duration TEXT;
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS services_covered TEXT;
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS contract_value NUMERIC(18,2) DEFAULT 0;
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR';
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS contract_document_url TEXT;
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE client_contracts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Add the customers FK only if a customers table actually exists
-- (Nova has it, Orbit doesn't) — done conditionally so this script
-- never fails on a database without a customers table.
DO $$
BEGIN
  IF to_regclass('public.customers') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.table_constraints
       WHERE constraint_name = 'client_contracts_customer_id_fkey'
     )
  THEN
    ALTER TABLE client_contracts
      ADD CONSTRAINT client_contracts_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_client_contracts_contract_number
  ON client_contracts(contract_number);
CREATE INDEX IF NOT EXISTS idx_client_contracts_user_id
  ON client_contracts(user_id);
CREATE INDEX IF NOT EXISTS idx_client_contracts_customer
  ON client_contracts(customer_id);
CREATE INDEX IF NOT EXISTS idx_client_contracts_status
  ON client_contracts(status);
CREATE INDEX IF NOT EXISTS idx_client_contracts_dates
  ON client_contracts(start_date, end_date);

-- ------------------------------------------------------------
-- 2. ONBOARDING / PROJECT START / SERVICE DETAILS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_onboarding (
  id BIGSERIAL PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  onboarding_status TEXT NOT NULL DEFAULT 'Pending',
  onboarding_completed_at TIMESTAMPTZ,
  onboarding_completed_by TEXT,
  onboarding_notes TEXT,
  project_start_date DATE,
  initial_project_discussion_date DATE,
  project_status TEXT NOT NULL DEFAULT 'Not Started',
  current_phase TEXT NOT NULL DEFAULT 'Requirement Analysis',
  progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  service_name TEXT,
  service_duration TEXT,
  service_active_until DATE,
  service_notes TEXT,
  project_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS onboarding_status TEXT DEFAULT 'Pending';
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS onboarding_completed_by TEXT;
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS onboarding_notes TEXT;
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS project_start_date DATE;
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS initial_project_discussion_date DATE;
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS project_status TEXT DEFAULT 'Not Started';
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS current_phase TEXT DEFAULT 'Requirement Analysis';
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS progress_percent INTEGER DEFAULT 0;
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS service_name TEXT;
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS service_duration TEXT;
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS service_active_until DATE;
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS service_notes TEXT;
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS project_notes TEXT;
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE client_onboarding ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS ux_client_onboarding_contract
  ON client_onboarding(contract_id);
CREATE INDEX IF NOT EXISTS idx_client_onboarding_status
  ON client_onboarding(onboarding_status);

-- ------------------------------------------------------------
-- 3. PROJECT TEAM
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_team (
  id BIGSERIAL PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL,
  member_email TEXT,
  role TEXT,
  department TEXT,
  assignment_start_date DATE,
  assignment_end_date DATE,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  responsibilities TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE client_contract_team ADD COLUMN IF NOT EXISTS member_name TEXT;
ALTER TABLE client_contract_team ADD COLUMN IF NOT EXISTS member_email TEXT;
ALTER TABLE client_contract_team ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE client_contract_team ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE client_contract_team ADD COLUMN IF NOT EXISTS assignment_start_date DATE;
ALTER TABLE client_contract_team ADD COLUMN IF NOT EXISTS assignment_end_date DATE;
ALTER TABLE client_contract_team ADD COLUMN IF NOT EXISTS is_current BOOLEAN DEFAULT TRUE;
ALTER TABLE client_contract_team ADD COLUMN IF NOT EXISTS responsibilities TEXT;
ALTER TABLE client_contract_team ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE client_contract_team ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_client_contract_team_contract
  ON client_contract_team(contract_id);
CREATE INDEX IF NOT EXISTS idx_client_contract_team_current
  ON client_contract_team(contract_id, is_current);

-- ------------------------------------------------------------
-- 4. MEETINGS / MoM
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_meetings (
  id BIGSERIAL PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  meeting_title TEXT NOT NULL,
  meeting_date TIMESTAMPTZ,
  meeting_type TEXT DEFAULT 'Project Meeting',
  participants TEXT,
  discussion TEXT,
  minutes_of_meeting TEXT,
  action_items TEXT,
  notes_storage_url TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE client_contract_meetings ADD COLUMN IF NOT EXISTS meeting_title TEXT;
ALTER TABLE client_contract_meetings ADD COLUMN IF NOT EXISTS meeting_date TIMESTAMPTZ;
ALTER TABLE client_contract_meetings ADD COLUMN IF NOT EXISTS meeting_type TEXT DEFAULT 'Project Meeting';
ALTER TABLE client_contract_meetings ADD COLUMN IF NOT EXISTS participants TEXT;
ALTER TABLE client_contract_meetings ADD COLUMN IF NOT EXISTS discussion TEXT;
ALTER TABLE client_contract_meetings ADD COLUMN IF NOT EXISTS minutes_of_meeting TEXT;
ALTER TABLE client_contract_meetings ADD COLUMN IF NOT EXISTS action_items TEXT;
ALTER TABLE client_contract_meetings ADD COLUMN IF NOT EXISTS notes_storage_url TEXT;
ALTER TABLE client_contract_meetings ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE client_contract_meetings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE client_contract_meetings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_client_contract_meetings_contract
  ON client_contract_meetings(contract_id);
CREATE INDEX IF NOT EXISTS idx_client_contract_meetings_date
  ON client_contract_meetings(contract_id, meeting_date DESC);

-- ------------------------------------------------------------
-- 5. DOCUMENTS / ATTACHMENTS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_documents (
  id BIGSERIAL PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL DEFAULT 'Other',
  file_name TEXT NOT NULL,
  file_url TEXT,
  storage_path TEXT,
  mime_type TEXT,
  size_kb NUMERIC(12,2),
  description TEXT,
  uploaded_by TEXT,
  is_client_visible BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE client_contract_documents ADD COLUMN IF NOT EXISTS document_type TEXT DEFAULT 'Other';
ALTER TABLE client_contract_documents ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE client_contract_documents ADD COLUMN IF NOT EXISTS file_url TEXT;
ALTER TABLE client_contract_documents ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE client_contract_documents ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE client_contract_documents ADD COLUMN IF NOT EXISTS size_kb NUMERIC(12,2);
ALTER TABLE client_contract_documents ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE client_contract_documents ADD COLUMN IF NOT EXISTS uploaded_by TEXT;
ALTER TABLE client_contract_documents ADD COLUMN IF NOT EXISTS is_client_visible BOOLEAN DEFAULT TRUE;
ALTER TABLE client_contract_documents ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE client_contract_documents ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE client_contract_documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_client_contract_documents_contract
  ON client_contract_documents(contract_id);
CREATE INDEX IF NOT EXISTS idx_client_contract_documents_type
  ON client_contract_documents(contract_id, document_type);

-- ------------------------------------------------------------
-- 6. BILLING CYCLES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_billing (
  id BIGSERIAL PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  billing_cycle_name TEXT,
  billing_frequency TEXT NOT NULL DEFAULT 'Monthly',
  billing_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  first_billing_date DATE,
  next_billing_date DATE,
  cycle_start_date DATE,
  cycle_end_date DATE,
  status TEXT NOT NULL DEFAULT 'Active',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE client_contract_billing ADD COLUMN IF NOT EXISTS billing_cycle_name TEXT;
ALTER TABLE client_contract_billing ADD COLUMN IF NOT EXISTS billing_frequency TEXT DEFAULT 'Monthly';
ALTER TABLE client_contract_billing ADD COLUMN IF NOT EXISTS billing_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE client_contract_billing ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR';
ALTER TABLE client_contract_billing ADD COLUMN IF NOT EXISTS first_billing_date DATE;
ALTER TABLE client_contract_billing ADD COLUMN IF NOT EXISTS next_billing_date DATE;
ALTER TABLE client_contract_billing ADD COLUMN IF NOT EXISTS cycle_start_date DATE;
ALTER TABLE client_contract_billing ADD COLUMN IF NOT EXISTS cycle_end_date DATE;
ALTER TABLE client_contract_billing ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Active';
ALTER TABLE client_contract_billing ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE client_contract_billing ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE client_contract_billing ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_client_contract_billing_contract
  ON client_contract_billing(contract_id);
CREATE INDEX IF NOT EXISTS idx_client_contract_billing_next
  ON client_contract_billing(next_billing_date);

-- ------------------------------------------------------------
-- 7. INVOICES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_invoices (
  id BIGSERIAL PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  invoice_date DATE,
  due_date DATE,
  billing_period_start DATE,
  billing_period_end DATE,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'Draft',
  invoice_url TEXT,
  generated_in_software BOOLEAN NOT NULL DEFAULT TRUE,
  generated_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS invoice_date DATE;
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS billing_period_start DATE;
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS billing_period_end DATE;
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS total_amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR';
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Draft';
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS invoice_url TEXT;
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS generated_in_software BOOLEAN DEFAULT TRUE;
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ;
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE client_contract_invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill total_amount for any pre-existing rows from the Orbit-style
-- schema (which only had total_amount, no amount/tax split).
UPDATE client_contract_invoices
SET amount = total_amount
WHERE amount = 0 AND total_amount <> 0;

CREATE UNIQUE INDEX IF NOT EXISTS ux_client_contract_invoices_number
  ON client_contract_invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_client_contract_invoices_contract
  ON client_contract_invoices(contract_id);
CREATE INDEX IF NOT EXISTS idx_client_contract_invoices_date
  ON client_contract_invoices(invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_client_contract_invoices_status
  ON client_contract_invoices(status);

-- ------------------------------------------------------------
-- 8. PURCHASE ORDERS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_purchase_orders (
  id BIGSERIAL PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  po_number TEXT NOT NULL,
  issue_date DATE,
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  validity_start_date DATE,
  validity_end_date DATE,
  status TEXT NOT NULL DEFAULT 'Active',
  po_document_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE client_contract_purchase_orders ADD COLUMN IF NOT EXISTS po_number TEXT;
ALTER TABLE client_contract_purchase_orders ADD COLUMN IF NOT EXISTS issue_date DATE;
ALTER TABLE client_contract_purchase_orders ADD COLUMN IF NOT EXISTS amount NUMERIC(18,2) DEFAULT 0;
ALTER TABLE client_contract_purchase_orders ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR';
ALTER TABLE client_contract_purchase_orders ADD COLUMN IF NOT EXISTS validity_start_date DATE;
ALTER TABLE client_contract_purchase_orders ADD COLUMN IF NOT EXISTS validity_end_date DATE;
ALTER TABLE client_contract_purchase_orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Active';
ALTER TABLE client_contract_purchase_orders ADD COLUMN IF NOT EXISTS po_document_url TEXT;
ALTER TABLE client_contract_purchase_orders ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE client_contract_purchase_orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE client_contract_purchase_orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_client_contract_po_contract
  ON client_contract_purchase_orders(contract_id);
CREATE INDEX IF NOT EXISTS idx_client_contract_po_number
  ON client_contract_purchase_orders(po_number);

-- ------------------------------------------------------------
-- 9. PAYMENTS
-- Nova adds invoice_id linkage on top of Orbit's fields.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_payments (
  id BIGSERIAL PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  invoice_id BIGINT REFERENCES client_contract_invoices(id) ON DELETE SET NULL,
  payment_date DATE,
  amount_received NUMERIC(18,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  payment_status TEXT NOT NULL DEFAULT 'Received',
  payment_method TEXT,
  received_account TEXT,
  payment_reference TEXT,
  transaction_reference TEXT,
  receipt_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS invoice_id BIGINT;
ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS payment_date DATE;
ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS amount_received NUMERIC(18,2) DEFAULT 0;
ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR';
ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'Received';
ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS received_account TEXT;
ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS payment_reference TEXT;
ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS transaction_reference TEXT;
ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS receipt_url TEXT;
ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE client_contract_payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'client_contract_payments_invoice_id_fkey'
  ) THEN
    ALTER TABLE client_contract_payments
      ADD CONSTRAINT client_contract_payments_invoice_id_fkey
      FOREIGN KEY (invoice_id) REFERENCES client_contract_invoices(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_client_contract_payments_contract
  ON client_contract_payments(contract_id);
CREATE INDEX IF NOT EXISTS idx_client_contract_payments_invoice
  ON client_contract_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_client_contract_payments_date
  ON client_contract_payments(payment_date DESC);

-- ------------------------------------------------------------
-- 10. ACTIVITY / AUDIT TIMELINE
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_contract_activity (
  id BIGSERIAL PRIMARY KEY,
  contract_id BIGINT NOT NULL REFERENCES client_contracts(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  actor_user_id UUID,
  actor_name TEXT,
  actor_role TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE client_contract_activity ADD COLUMN IF NOT EXISTS activity_type TEXT;
ALTER TABLE client_contract_activity ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE client_contract_activity ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE client_contract_activity ADD COLUMN IF NOT EXISTS actor_user_id UUID;
ALTER TABLE client_contract_activity ADD COLUMN IF NOT EXISTS actor_name TEXT;
ALTER TABLE client_contract_activity ADD COLUMN IF NOT EXISTS actor_role TEXT;
ALTER TABLE client_contract_activity ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE client_contract_activity ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'client_contract_activity_actor_user_id_fkey'
  ) THEN
    ALTER TABLE client_contract_activity
      ADD CONSTRAINT client_contract_activity_actor_user_id_fkey
      FOREIGN KEY (actor_user_id) REFERENCES crm_users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_client_contract_activity_contract_created
  ON client_contract_activity(contract_id, created_at DESC);

-- ------------------------------------------------------------
-- 11. updated_at TRIGGERS (applied to every table via loop,
-- Orbit-style, so adding a new table later just means adding
-- its name to the array)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION client_contract_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'client_contracts',
    'client_onboarding',
    'client_contract_team',
    'client_contract_meetings',
    'client_contract_documents',
    'client_contract_billing',
    'client_contract_invoices',
    'client_contract_purchase_orders',
    'client_contract_payments'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_client_workspace_updated_at ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_client_workspace_updated_at
       BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION client_contract_set_updated_at()', t
    );
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 12. AUTO-CREATE ONBOARDING ROW + ACTIVITY LOG ON NEW CONTRACT
-- (Nova's trigger — new contracts no longer need a manual
-- onboarding insert or activity entry.)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION client_contract_create_onboarding()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO client_onboarding (contract_id)
  VALUES (NEW.id)
  ON CONFLICT (contract_id) DO NOTHING;

  INSERT INTO client_contract_activity
    (contract_id, activity_type, title, description)
  VALUES
    (NEW.id, 'contract_created', 'Contract workspace created',
     'A contract workspace was created for the client login.');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_client_contracts_create_workspace ON client_contracts;
CREATE TRIGGER trg_client_contracts_create_workspace
AFTER INSERT ON client_contracts
FOR EACH ROW EXECUTE FUNCTION client_contract_create_onboarding();

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

COMMIT;

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
--   ('USER-UUID', 'ORB-2026-001', 'ABC Technologies',
--    '2026-08-20', '2027-08-19',
--    'CRM Development + AMC', 400000);
--
-- Client access is determined by crm_users.id -> client_contracts.user_id.
-- It does NOT depend on customers.id.
-- ============================================================

-- ============================================================
-- FIX: company_bank_accounts.account_label NOT NULL error
-- ============================================================
-- The 25P02 error just means an earlier statement in this same
-- session already failed, and everything after it got skipped
-- until a ROLLBACK. This version clears that automatically and
-- wraps the actual fix in an exception-safe block.
-- ============================================================

-- Clear any stuck transaction from a previous failed run in this
-- session. Harmless no-op if there's nothing to roll back.
ROLLBACK;

BEGIN;

DO $$
BEGIN
  -- Make account_label optional (only if it currently exists and is required).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'company_bank_accounts'
      AND column_name = 'account_label'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE company_bank_accounts ALTER COLUMN account_label DROP NOT NULL;
    RAISE NOTICE 'account_label is now optional.';
  ELSE
    RAISE NOTICE 'account_label was already optional or does not exist — nothing to change.';
  END IF;

  -- Backfill any existing rows where account_label is NULL.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'company_bank_accounts' AND column_name = 'account_label'
  ) THEN
    UPDATE company_bank_accounts
    SET account_label = COALESCE(account_label, bank_name || ' — ' || account_number)
    WHERE account_label IS NULL;
    RAISE NOTICE 'Backfilled account_label on existing rows.';
  END IF;
END $$;

COMMIT;

-- ============================================================
-- VERIFY
-- ============================================================
SELECT id, account_label, bank_name, account_number, is_active
FROM company_bank_accounts
ORDER BY id;

-- ============================================================

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
--   ('USER-UUID', 'ORB-2026-001', 'ABC Technologies',
--    '2026-08-20', '2027-08-19',
--    'CRM Development + AMC', 400000);
--
-- Client access is determined by crm_users.id -> client_contracts.user_id.
-- It does NOT depend on customers.id.
-- ============================================================

-- ============================================================
-- FIX: company_bank_accounts.account_label NOT NULL error
-- ============================================================
-- The 25P02 error just means an earlier statement in this same
-- session already failed, and everything after it got skipped
-- until a ROLLBACK. This version clears that automatically and
-- wraps the actual fix in an exception-safe block.
-- ============================================================

-- Clear any stuck transaction from a previous failed run in this
-- session. Harmless no-op if there's nothing to roll back.
ROLLBACK;

BEGIN;

DO $$
BEGIN
  -- Make account_label optional (only if it currently exists and is required).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'company_bank_accounts'
      AND column_name = 'account_label'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE company_bank_accounts ALTER COLUMN account_label DROP NOT NULL;
    RAISE NOTICE 'account_label is now optional.';
  ELSE
    RAISE NOTICE 'account_label was already optional or does not exist — nothing to change.';
  END IF;

  -- Backfill any existing rows where account_label is NULL.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'company_bank_accounts' AND column_name = 'account_label'
  ) THEN
    UPDATE company_bank_accounts
    SET account_label = COALESCE(account_label, bank_name || ' — ' || account_number)
    WHERE account_label IS NULL;
    RAISE NOTICE 'Backfilled account_label on existing rows.';
  END IF;
END $$;

COMMIT;

-- ============================================================
-- VERIFY
-- ============================================================
SELECT id, account_label, bank_name, account_number, is_active
FROM company_bank_accounts
ORDER BY id;

-- ============================================================
-- PROJECT TEAM LOGIN-USER ASSIGNMENT REQUESTS
-- ============================================================
ALTER TABLE client_contract_team
  ADD COLUMN IF NOT EXISTS member_user_id UUID,
  ADD COLUMN IF NOT EXISTS assignment_status TEXT NOT NULL DEFAULT 'accepted',
  ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requested_by_user_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'client_contract_team_member_user_id_fkey'
  ) THEN
    ALTER TABLE client_contract_team
      ADD CONSTRAINT client_contract_team_member_user_id_fkey
      FOREIGN KEY (member_user_id) REFERENCES crm_users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'client_contract_team_requested_by_user_id_fkey'
  ) THEN
    ALTER TABLE client_contract_team
      ADD CONSTRAINT client_contract_team_requested_by_user_id_fkey
      FOREIGN KEY (requested_by_user_id) REFERENCES crm_users(id) ON DELETE SET NULL;
  END IF;
END $$;

UPDATE client_contract_team
SET assignment_status = CASE
  WHEN is_current THEN 'accepted'
  ELSE 'pending'
END
WHERE assignment_status IS NULL OR assignment_status = '';

ALTER TABLE client_contract_team
  DROP CONSTRAINT IF EXISTS client_contract_team_assignment_status_check;
ALTER TABLE client_contract_team
  ADD CONSTRAINT client_contract_team_assignment_status_check
  CHECK (assignment_status IN ('pending', 'accepted', 'declined', 'cancelled'));

CREATE INDEX IF NOT EXISTS idx_client_contract_team_member_user
  ON client_contract_team(member_user_id);
CREATE INDEX IF NOT EXISTS idx_client_contract_team_member_status
  ON client_contract_team(member_user_id, assignment_status);