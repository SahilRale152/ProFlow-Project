
-- ============================================================
-- NOVA CRM (OrbitAvanya) — CONSOLIDATED, DEDUPLICATED SCHEMA
-- ============================================================
-- This is a cleaned-up version of orbit.sql: the original file
-- had the full schema pasted in three times (plus a partial
-- fourth copy), all defining the same tables/functions/seed data.
-- This version keeps exactly one copy of everything, in
-- dependency order, and merges the later INR/admin-diagnostics
-- migration and the AI Assistant tables in as their own guarded
-- blocks.
--
-- Assumes `customers` already exists in your database (nothing
-- here creates it — only ALTERs it). Safe to re-run: every
-- statement is IF NOT EXISTS / OR REPLACE / ON CONFLICT DO NOTHING.
-- ============================================================

BEGIN;

-- ============================================================
-- Customers (base table)
-- Created here if it doesn't already exist. If you already have
-- a customers table with a different shape, this is a no-op
-- (IF NOT EXISTS) and the ALTERs below just add any missing columns.
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
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
  status TEXT NOT NULL DEFAULT 'Active',
  owner_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customers_created ON customers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customers_company_name ON customers(company_name);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_owner ON customers(owner_id);

-- ---------- customers: extra columns some modules expect ----------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'Not Verified';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ceo_name TEXT;
-- Needed by the customer detail page's Portal tab (PUT /api/customers/:id/portal).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS portal_access BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------- customers: extra CSV/Excel import columns ----------
-- Populated by /api/customers/bulk-import. Not shown on the Customers list —
-- only on the customer's detail page ("View").
ALTER TABLE customers ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS time_zone TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS country_size TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS company_size TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS employee_count TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_2 TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_3 TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_4 TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS scrape_status TEXT;

-- ---------- customer_contacts: contacts listed on the customer detail page ----------
-- Backs GET/POST /api/customers/:id/contacts.
CREATE TABLE IF NOT EXISTS customer_contacts (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  designation TEXT,
  email TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer ON customer_contacts(customer_id);

-- ============================================================
-- Products
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_discount_range') THEN
    ALTER TABLE products ADD CONSTRAINT products_discount_range CHECK (discount >= 0 AND discount <= 100);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

-- ============================================================
-- Pipeline stages
-- ============================================================
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 99,
  is_won BOOLEAN NOT NULL DEFAULT FALSE,
  is_lost BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO pipeline_stages (name, position, is_won, is_lost) VALUES
  ('Prospecting', 10, false, false),
  ('Qualification', 20, false, false),
  ('Proposal', 30, false, false),
  ('Negotiation', 40, false, false),
  ('Closed Won', 50, true, false),
  ('Closed Lost', 60, false, true)
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- Leads
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  estimated_value NUMERIC(14,2) NOT NULL DEFAULT 0,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  notes TEXT,
  assigned_to TEXT,
  score INTEGER,
  ai_insight TEXT,
  converted_opportunity_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_customer ON leads(customer_id);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);

-- ============================================================
-- Opportunities
-- ============================================================
CREATE TABLE IF NOT EXISTS opportunities (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  lead_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'Prospecting',
  value NUMERIC(14,2) NOT NULL DEFAULT 0,
  probability NUMERIC(5,2) NOT NULL DEFAULT 50,
  expected_close_date DATE,
  owner TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_opportunities_created ON opportunities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_stage ON opportunities(stage);
CREATE INDEX IF NOT EXISTS idx_opportunities_customer ON opportunities(customer_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_lead ON opportunities(lead_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_converted_opportunity') THEN
    ALTER TABLE leads
      ADD CONSTRAINT fk_leads_converted_opportunity
      FOREIGN KEY (converted_opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================
-- Activities
-- ============================================================
CREATE TABLE IF NOT EXISTS activities (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'note',
  subject TEXT,
  body TEXT,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT 'outbound',
  status TEXT NOT NULL DEFAULT 'completed',
  due_at TIMESTAMPTZ,
  duration_minutes INTEGER,
  owner_id TEXT,
  notified BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activities_customer ON activities(customer_id);
CREATE INDEX IF NOT EXISTS idx_activities_due ON activities(status, due_at);
CREATE INDEX IF NOT EXISTS idx_activities_occurred ON activities(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_status ON activities(status);

-- ============================================================
-- Tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  related_type TEXT,
  related_id BIGINT,
  assigned_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_related ON tasks(related_type, related_id);

-- ============================================================
-- Calendar events
-- ============================================================
CREATE TABLE IF NOT EXISTS calendar_events (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  related_type TEXT,
  related_id BIGINT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calendar_start ON calendar_events(start_time);
CREATE INDEX IF NOT EXISTS idx_calendar_related ON calendar_events(related_type, related_id);

-- ============================================================
-- Approvals
-- ============================================================
CREATE TABLE IF NOT EXISTS approvals (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'discount',
  related_type TEXT,
  related_id BIGINT,
  requested_by TEXT,
  approver TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_related ON approvals(related_type, related_id);

-- ============================================================
-- Communications
-- ============================================================
CREATE TABLE IF NOT EXISTS communications (
  id BIGSERIAL PRIMARY KEY,
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
  sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_communications_customer_id ON communications(customer_id);
CREATE INDEX IF NOT EXISTS idx_communications_lead_id ON communications(lead_id);
CREATE INDEX IF NOT EXISTS idx_communications_opportunity_id ON communications(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_communications_direction ON communications(direction);
CREATE INDEX IF NOT EXISTS idx_communications_received_at ON communications(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_communications_created_at ON communications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_communications_sender_email ON communications(sender_email);
CREATE INDEX IF NOT EXISTS idx_communications_message_id ON communications(message_id);
CREATE INDEX IF NOT EXISTS idx_communications_is_read ON communications(is_read);

-- De-dupe by message_id before the unique index (safe no-op on a clean table)
DELETE FROM communications c
USING (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY id) AS rn
  FROM communications WHERE message_id IS NOT NULL
) dup
WHERE c.id = dup.id AND dup.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_communications_message_id ON communications(message_id) WHERE message_id IS NOT NULL;

-- ============================================================
-- Notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  message TEXT,
  link TEXT,
  related_type TEXT,
  related_id BIGINT,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_related ON notifications(related_type, related_id);

-- ============================================================
-- Proposal templates (+ default rows)
-- Proposal templates
-- Stores the complete HTML used by the proposal generator.
-- `sections` is retained for compatibility with older CRM data.
CREATE TABLE IF NOT EXISTS proposal_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  html_content TEXT,
  sections TEXT[] DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe migration for databases that already have the older
-- `proposal_templates(name, description, sections)` structure.
ALTER TABLE proposal_templates ADD COLUMN IF NOT EXISTS html_content TEXT;
ALTER TABLE proposal_templates ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE proposal_templates ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE proposal_templates ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE proposal_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE proposal_templates
SET is_default = FALSE
WHERE is_default = TRUE
  AND id <> (SELECT MIN(id) FROM proposal_templates WHERE is_default = TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS proposal_templates_single_default
  ON proposal_templates (is_default)
  WHERE is_default = TRUE;

-- Keep at least one usable template row. The server imports
-- public/templates/templates1.html into html_content on startup.
INSERT INTO proposal_templates
  (name, description, html_content, sections, is_active, is_default)
SELECT
  'Quick Proposal',
  'Professional A4 proposal template imported from public/templates/templates1.html.',
  NULL,
  ARRAY['Cover','Executive Summary','Company Profile','Engagement Summary','Scope of Work','Implementation Plan','Deliverables','Investment','Closing'],
  TRUE,
  TRUE
WHERE NOT EXISTS (SELECT 1 FROM proposal_templates);

UPDATE proposal_templates
SET updated_at = NOW()
WHERE updated_at IS NULL;

-- ============================================================
-- Company profile (+ default row)
-- ============================================================
CREATE TABLE IF NOT EXISTS company_profile (
  id INTEGER PRIMARY KEY DEFAULT 1,
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
  certifications TEXT[],
  core_services TEXT[],
  logo_url TEXT,
  primary_color TEXT DEFAULT '#a855f7',
  secondary_color TEXT DEFAULT '#4c1d95',
  usage_purpose TEXT,
  org_type TEXT,
  user_role TEXT,
  CHECK (id = 1)
);
INSERT INTO company_profile (
  id, company_name, tagline, registered_office, website, email, phone,
  director_name, director_title, uei, nato_cage_code, duns_number,
  skill_india_tp_id, gem_seller_id, certifications, core_services
)
SELECT
  1, 'OrbitAvanya Tech LLP (AvanyaEdge)',
  'ISO-certified technology consulting and digital transformation company',
  'Shastri Nagar CHS, Vashi Naka, Near Hanuman Mandir, Chembur, Mumbai – 400074, Maharashtra, India',
  'www.orbitavanyatech.com', 'info@orbitavanyatech.com', '+91 7021950643',
  'Pradeep Kumar Singh', 'Director, Microsoft Certified Developer & AI Expert',
  'D19VM1JR7MN9', '7719Y', '772678096', '321291', 'MZKP2500129966592345',
  ARRAY['ISO 9001 Certified','ISO/IEC 27001 Certified','GDPR Compliance Ready','CMMI Level 3 Process-Oriented Organization'],
  ARRAY['Enterprise Application Development','Workflow Automation Systems','Contractor Management Systems (CMS)','ERP & LMS Solutions','E-Governance Platforms','AI-Powered Applications','Cloud & Infrastructure Services','API & Third-Party Integrations']
WHERE NOT EXISTS (SELECT 1 FROM company_profile WHERE id = 1);

-- ============================================================
-- Pricing catalog (+ default rows)
-- ============================================================
CREATE TABLE IF NOT EXISTS pricing_catalog (
  id SERIAL PRIMARY KEY,
  service_name TEXT NOT NULL,
  starting_price TEXT NOT NULL,
  delivery_time TEXT,
  amc TEXT
);
INSERT INTO pricing_catalog (service_name, starting_price, delivery_time, amc)
SELECT * FROM (VALUES
  ('CRM Development','40000','8–16 Weeks','18%/Year'),
  ('ERP Development','120000','4–8 Months','20%/Year'),
  ('HRMS','35000','8–12 Weeks','18%/Year'),
  ('Inventory Management','30000','6–10 Weeks','18%/Year'),
  ('Hospital Management System','150000','5–9 Months','20%/Year'),
  ('School ERP','50000','10–16 Weeks','18%/Year'),
  ('Accounting Software','45000','8–14 Weeks','18%/Year'),
  ('Billing Software','20000','4–8 Weeks','15%/Year'),
  ('POS System','25000','6–10 Weeks','15%/Year'),
  ('Business Website (5–10 Pages)','8000','2–4 Weeks','15%/Year'),
  ('Corporate Website','20000','4–8 Weeks','15%/Year'),
  ('Government Portal','80000','3–6 Months','20%/Year'),
  ('E-commerce Website','35000','8–16 Weeks','18%/Year'),
  ('Custom Web Portal','50000','10–20 Weeks','20%/Year'),
  ('Android App','20000','8–12 Weeks','18%/Year'),
  ('iOS App','25000','8–14 Weeks','18%/Year'),
  ('Enterprise Mobile App','60000','3–6 Months','20%/Year'),
  ('Document Management System','120000','4–7 Months','18%/Year'),
  ('UI/UX Design','12000','3–6 Weeks','Optional'),
  ('AVANYA AI LMS','150000','4–8 Months','20%/Year'),
  ('AVANYA AI ERP','250000','6–12 Months','20%/Year')
) AS demo(service_name, starting_price, delivery_time, amc)
WHERE NOT EXISTS (SELECT 1 FROM pricing_catalog);

-- ============================================================
-- Proposal folders (+ default rows)
-- ============================================================
CREATE TABLE IF NOT EXISTS proposal_folders (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
INSERT INTO proposal_folders (name)
SELECT * FROM (VALUES ('Sales'), ('Marketing'), ('Clients')) AS demo(name)
WHERE NOT EXISTS (SELECT 1 FROM proposal_folders);

-- ============================================================
-- AI proposals
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_proposals (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  template_id INTEGER REFERENCES proposal_templates(id) ON DELETE SET NULL,
  requirements TEXT,
  budget TEXT,
  timeline TEXT,
  content JSONB,
  selected_services JSONB,
  status TEXT DEFAULT 'Draft',
  cover_image_url TEXT,
  folder_id INTEGER REFERENCES proposal_folders(id) ON DELETE SET NULL,
  chat_history JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_proposals_customer ON ai_proposals(customer_id);
CREATE INDEX IF NOT EXISTS idx_ai_proposals_template ON ai_proposals(template_id);
CREATE INDEX IF NOT EXISTS idx_ai_proposals_folder ON ai_proposals(folder_id);
CREATE INDEX IF NOT EXISTS idx_ai_proposals_status ON ai_proposals(status);
CREATE INDEX IF NOT EXISTS idx_ai_proposals_created ON ai_proposals(created_at DESC);

-- ============================================================
-- Image assets (proposal designer upload library)
-- ============================================================
CREATE TABLE IF NOT EXISTS image_assets (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
-- Table may already exist from a partial earlier run with fewer columns —
-- add whatever's missing before indexing.
ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS proposal_id INTEGER;
ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS original_name TEXT;
ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS size_kb INTEGER;
ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE image_assets ADD COLUMN IF NOT EXISTS uploaded_by TEXT;
CREATE INDEX IF NOT EXISTS idx_image_assets_customer ON image_assets(customer_id);
CREATE INDEX IF NOT EXISTS idx_image_assets_created ON image_assets(created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_image_assets_proposal') THEN
    ALTER TABLE image_assets
      ADD CONSTRAINT fk_image_assets_proposal
      FOREIGN KEY (proposal_id) REFERENCES ai_proposals(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ============================================================
-- AI Assistant tables
-- Required by /api/ai/* endpoints in server.js
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session ON ai_chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_created ON ai_chat_messages(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_email_drafts (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL,
  tone TEXT,
  input_notes TEXT NOT NULL,
  generated_subject TEXT NOT NULL,
  generated_body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_email_drafts_customer ON ai_email_drafts(customer_id);
CREATE INDEX IF NOT EXISTS idx_ai_email_drafts_created ON ai_email_drafts(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_coach_sessions (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  mode TEXT NOT NULL,
  input_context TEXT NOT NULL,
  output_advice TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_coach_sessions_customer ON ai_coach_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_ai_coach_sessions_created ON ai_coach_sessions(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_meeting_summaries (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  meeting_title TEXT,
  transcript TEXT NOT NULL,
  summary TEXT NOT NULL,
  action_items TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_meeting_summaries_customer ON ai_meeting_summaries(customer_id);
CREATE INDEX IF NOT EXISTS idx_ai_meeting_summaries_created ON ai_meeting_summaries(created_at DESC);

-- ============================================================
-- Document categories (+ default rows)
-- ============================================================
CREATE TABLE IF NOT EXISTS document_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
INSERT INTO document_categories (name)
VALUES ('Contract'), ('Proposal'), ('Invoice'), ('Report'), ('Other')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- Documents module
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  file_name TEXT NOT NULL,
  category TEXT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  uploaded_by TEXT,
  file_url TEXT,
  size_kb NUMERIC DEFAULT 0,
  is_shared BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documents_customer ON documents(customer_id);

CREATE TABLE IF NOT EXISTS document_versions (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  version_number INTEGER DEFAULT 1,
  file_url TEXT,
  uploaded_by TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_versions_document ON document_versions(document_id);

CREATE TABLE IF NOT EXISTS document_shares (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  shared_with TEXT,
  shared_by TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_shares_document ON document_shares(document_id);

-- ============================================================
-- Contracts
-- ============================================================
CREATE TABLE IF NOT EXISTS contracts (
  id SERIAL PRIMARY KEY,
  contract_number TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  start_date DATE,
  end_date DATE,
  status TEXT DEFAULT 'Draft',
  value NUMERIC,
  sales_owner TEXT,
  attachment_url TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contracts_customer ON contracts(customer_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);

-- ============================================================
-- Proposal files
-- ============================================================
CREATE TABLE IF NOT EXISTS proposal_files (
  id SERIAL PRIMARY KEY,
  proposal_number TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  opportunity TEXT,
  created_by TEXT,
  status TEXT DEFAULT 'Draft',
  version INTEGER DEFAULT 1,
  file_url TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proposal_files_customer ON proposal_files(customer_id);
CREATE INDEX IF NOT EXISTS idx_proposal_files_status ON proposal_files(status);

-- ============================================================
-- Customer files
-- ============================================================
CREATE TABLE IF NOT EXISTS customer_files (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  document_type TEXT,
  file_url TEXT,
  uploaded_by TEXT,
  expiry_date DATE,
  status TEXT DEFAULT 'Pending',
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customer_files_customer ON customer_files(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_files_status ON customer_files(status);

-- ============================================================
-- Proposal sends (send + click tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS proposal_sends (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER REFERENCES ai_proposals(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  tracking_token TEXT NOT NULL UNIQUE,
  sent_at TIMESTAMP DEFAULT NOW(),
  opened_at TIMESTAMP,
  clicked_at TIMESTAMP,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proposal_sends_proposal ON proposal_sends(proposal_id);
CREATE INDEX IF NOT EXISTS idx_proposal_sends_token ON proposal_sends(tracking_token);
CREATE INDEX IF NOT EXISTS idx_proposal_sends_recipient ON proposal_sends(recipient_email);

COMMIT;

-- ============================================================
-- Verify the connected tables
-- ============================================================
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'products','activities','communications','notifications',
    'customers','leads','opportunities','tasks','calendar_events', -- customers now created above if missing
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
-- (bigint/serial ids, owner_id/owner as free-text, no users table)
--
-- Every summary function takes an optional `p_owner` / `p_owner_id`
-- parameter: pass a value to scope to one salesperson, or omit it
-- (NULL) for an instance-wide view.
--
-- Safe to re-run: CREATE OR REPLACE / IF NOT EXISTS throughout.
-- ============================================================

BEGIN;

-- ---------- Communications tab: summary + follow-up reminders ----------

CREATE OR REPLACE FUNCTION get_communications_summary(p_owner_id TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  result JSONB;
BEGIN
  WITH mine AS (
    SELECT * FROM activities
    WHERE (p_owner_id IS NULL OR owner_id = p_owner_id)
  ),
  by_type AS (SELECT type, COUNT(*) AS cnt FROM mine GROUP BY type ORDER BY cnt DESC)
  SELECT jsonb_build_object(
    'total', (SELECT COUNT(*) FROM mine),
    'this_week', (SELECT COUNT(*) FROM mine WHERE occurred_at >= date_trunc('week', now())),
    'upcoming_followups', (SELECT COUNT(*) FROM mine WHERE status = 'scheduled' AND due_at >= now()),
    'overdue_followups', (SELECT COUNT(*) FROM mine WHERE status = 'scheduled' AND due_at < now()),
    'by_type', (SELECT COALESCE(jsonb_agg(jsonb_build_object('type', type, 'count', cnt)), '[]'::jsonb) FROM by_type)
  ) INTO result;
  RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION sync_followup_notifications(p_owner_id TEXT DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  inserted_count INTEGER := 0;
BEGIN
  WITH due AS (
    SELECT a.id, a.subject, a.due_at, a.customer_id, c.company_name
    FROM activities a
    LEFT JOIN customers c ON c.id = a.customer_id
    WHERE (p_owner_id IS NULL OR a.owner_id = p_owner_id)
      AND a.status = 'scheduled' AND a.due_at IS NOT NULL
      AND a.due_at <= now() + interval '1 day' AND a.notified = false
  ),
  ins AS (
    INSERT INTO notifications (type, title, message, link, related_type, related_id)
    SELECT 'reminder', 'Follow-up due: ' || COALESCE(subject, 'Untitled'),
      CASE WHEN company_name IS NOT NULL THEN 'With ' || company_name || ' — ' || to_char(due_at, 'Mon DD, HH12:MI AM')
           ELSE to_char(due_at, 'Mon DD, HH12:MI AM') END,
      '/activities', 'activity', id
    FROM due
    RETURNING 1
  )
  UPDATE activities SET notified = true WHERE id IN (SELECT id FROM due);
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END; $$;

-- ---------- Notifications backend: deal/proposal events -> notifications ----------

CREATE OR REPLACE FUNCTION notify_opportunity_stage_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_is_won BOOLEAN;
  v_is_lost BOOLEAN;
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    SELECT is_won, is_lost INTO v_is_won, v_is_lost FROM pipeline_stages WHERE name = NEW.stage;
    IF v_is_won THEN
      INSERT INTO notifications (type, title, message, link, related_type, related_id)
      VALUES ('deal_won', 'Deal won: ' || NEW.title, 'Closed for ' || to_char(COALESCE(NEW.value, 0), 'FM999,999,990.00'), '/pipeline', 'opportunity', NEW.id);
    ELSIF v_is_lost THEN
      INSERT INTO notifications (type, title, message, link, related_type, related_id)
      VALUES ('deal_lost', 'Deal lost: ' || NEW.title, NULL, '/pipeline', 'opportunity', NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS opportunities_notify ON opportunities;
CREATE TRIGGER opportunities_notify AFTER UPDATE ON opportunities
FOR EACH ROW EXECUTE FUNCTION notify_opportunity_stage_change();

-- Status comparisons are case-insensitive since seed data uses
-- 'Draft' / 'Approved' (Title Case) rather than lowercase.
CREATE OR REPLACE FUNCTION notify_proposal_status_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF lower(NEW.status) = 'approved' THEN
      INSERT INTO notifications (type, title, message, link, related_type, related_id)
      VALUES ('proposal_approved', 'Proposal approved: ' || NEW.title, NULL, '/proposals', 'ai_proposal', NEW.id);
    ELSIF lower(NEW.status) = 'rejected' THEN
      INSERT INTO notifications (type, title, message, link, related_type, related_id)
      VALUES ('proposal_rejected', 'Proposal rejected: ' || NEW.title, NULL, '/proposals', 'ai_proposal', NEW.id);
    ELSIF lower(NEW.status) = 'sent' THEN
      INSERT INTO notifications (type, title, message, link, related_type, related_id)
      VALUES ('proposal_sent', 'Proposal sent: ' || NEW.title, NULL, '/proposals', 'ai_proposal', NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS ai_proposals_notify ON ai_proposals;
CREATE TRIGGER ai_proposals_notify AFTER UPDATE ON ai_proposals
FOR EACH ROW EXECUTE FUNCTION notify_proposal_status_change();

-- notifications has no user_id column, so these are instance-wide.
CREATE OR REPLACE FUNCTION get_notifications_summary()
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  result JSONB;
BEGIN
  WITH by_type AS (SELECT COALESCE(type, 'info') AS type, COUNT(*) AS cnt FROM notifications GROUP BY 1 ORDER BY cnt DESC)
  SELECT jsonb_build_object(
    'total', (SELECT COUNT(*) FROM notifications),
    'unread', (SELECT COUNT(*) FROM notifications WHERE read = false),
    'today', (SELECT COUNT(*) FROM notifications WHERE created_at >= date_trunc('day', now())),
    'by_type', (SELECT COALESCE(jsonb_agg(jsonb_build_object('type', type, 'count', cnt)), '[]'::jsonb) FROM by_type)
  ) INTO result;
  RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION mark_all_notifications_read()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE notifications SET read = true WHERE read = false;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END; $$;

-- ---------- Analytics: filterable summary, funnel, revenue forecast ----------

CREATE OR REPLACE FUNCTION get_analytics_summary(p_days INTEGER DEFAULT NULL, p_owner TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
  result JSONB;
  since TIMESTAMPTZ := CASE WHEN p_days IS NULL THEN '-infinity'::timestamptz ELSE now() - (p_days || ' days')::interval END;
BEGIN
  WITH opp AS (
    SELECT * FROM opportunities
    WHERE created_at >= since AND (p_owner IS NULL OR owner = p_owner)
  ),
  prop AS (
    SELECT * FROM ai_proposals WHERE created_at >= since
  ),
  won AS (SELECT o.* FROM opp o JOIN pipeline_stages ps ON ps.name = o.stage WHERE ps.is_won),
  decided_count AS (
    SELECT COUNT(*) AS cnt FROM opp o JOIN pipeline_stages ps ON ps.name = o.stage WHERE ps.is_won OR ps.is_lost
  ),
  months AS (
    SELECT to_char(d, 'Mon') AS month, to_char(d, 'YYYY-MM') AS sort_key
    FROM generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') d
  ),
  monthly_rev AS (
    SELECT m.month, m.sort_key, COALESCE(SUM(w.value), 0) AS revenue
    FROM months m
    LEFT JOIN won w ON to_char(w.created_at, 'YYYY-MM') = m.sort_key
    GROUP BY m.month, m.sort_key ORDER BY m.sort_key
  ),
  trend AS (
    SELECT regr_slope(revenue, idx) AS slope, regr_intercept(revenue, idx) AS intercept
    FROM (SELECT revenue, row_number() OVER () AS idx FROM monthly_rev) t
  ),
  stage_counts AS (
    SELECT stage, COUNT(*) AS cnt, COALESCE(SUM(value), 0) AS amt FROM opp GROUP BY stage
  ),
  funnel_base AS (
    SELECT ps.name AS stage, ps.position,
      (SELECT COUNT(*) FROM opp o JOIN pipeline_stages ps2 ON ps2.name = o.stage
        WHERE ps2.position >= ps.position AND NOT ps2.is_lost) AS cnt
    FROM pipeline_stages ps
    WHERE NOT ps.is_lost
  ),
  top_customers AS (
    SELECT c.company_name, SUM(w.value) AS revenue
    FROM won w JOIN customers c ON c.id = w.customer_id
    GROUP BY c.company_name ORDER BY revenue DESC LIMIT 5
  ),
  lead_sources AS (
    SELECT COALESCE(NULLIF(source, ''), 'Unknown') AS source, COUNT(*) AS cnt
    FROM leads WHERE created_at >= since
    GROUP BY 1 ORDER BY cnt DESC LIMIT 6
  )
  SELECT jsonb_build_object(
    'won_revenue', COALESCE((SELECT SUM(value) FROM won), 0),
    'pipeline_value', COALESCE((SELECT SUM(value) FROM opp o JOIN pipeline_stages ps ON ps.name = o.stage WHERE NOT ps.is_won AND NOT ps.is_lost), 0),
    'open_deals', (SELECT COUNT(*) FROM opp o JOIN pipeline_stages ps ON ps.name = o.stage WHERE NOT ps.is_won AND NOT ps.is_lost),
    'win_rate', CASE WHEN (SELECT cnt FROM decided_count) = 0 THEN 0
      ELSE ROUND((SELECT COUNT(*) FROM won)::numeric / (SELECT cnt FROM decided_count) * 100) END,
    'avg_deal_size', CASE WHEN (SELECT COUNT(*) FROM won) = 0 THEN 0
      ELSE ROUND((SELECT SUM(value) FROM won) / (SELECT COUNT(*) FROM won)) END,
    'proposal_conversion', CASE WHEN (SELECT COUNT(*) FROM prop) = 0 THEN 0
      ELSE ROUND((SELECT COUNT(*) FROM prop WHERE lower(status) = 'approved')::numeric / (SELECT COUNT(*) FROM prop) * 100) END,
    'monthly_revenue', (SELECT COALESCE(jsonb_agg(jsonb_build_object('month', month, 'revenue', revenue) ORDER BY sort_key), '[]'::jsonb) FROM monthly_rev),
    'forecast_next_month', (SELECT GREATEST(0, ROUND(COALESCE(slope, 0) * 7 + COALESCE(intercept, 0))) FROM trend),
    'by_stage', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', stage, 'value', cnt, 'amount', amt)), '[]'::jsonb) FROM stage_counts),
    'funnel', (SELECT COALESCE(jsonb_agg(jsonb_build_object('stage', stage, 'label', stage, 'count', cnt) ORDER BY position), '[]'::jsonb) FROM funnel_base),
    'top_customers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', company_name, 'revenue', revenue)), '[]'::jsonb) FROM top_customers),
    'lead_sources', (SELECT COALESCE(jsonb_agg(jsonb_build_object('source', source, 'count', cnt)), '[]'::jsonb) FROM lead_sources),
    'generated_at', now()
  ) INTO result;
  RETURN result;
END; $$;

-- ---------- Products & Pricing v2 ----------

ALTER TABLE products ADD COLUMN IF NOT EXISTS final_price NUMERIC(14,2)
  GENERATED ALWAYS AS (
    ROUND(price * (1 - COALESCE(discount, 0) / 100.0) * (1 + COALESCE(tax_rate, 0) / 100.0), 2)
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_products_owner_active ON products (owner_id, active);

CREATE OR REPLACE FUNCTION get_products_summary(p_owner TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'total_products', COUNT(*) FILTER (WHERE active),
    'catalog_value', COALESCE(SUM(final_price) FILTER (WHERE active), 0),
    'avg_price', COALESCE(ROUND(AVG(final_price) FILTER (WHERE active), 2), 0),
    'packages', COUNT(*) FILTER (WHERE active AND is_package),
    'archived', COUNT(*) FILTER (WHERE NOT active),
    'min_price', COALESCE(MIN(final_price) FILTER (WHERE active), 0),
    'max_price', COALESCE(MAX(final_price) FILTER (WHERE active), 0),
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', category, 'count', cnt))
      FROM (
        SELECT COALESCE(NULLIF(category, ''), 'Uncategorized') AS category, COUNT(*) AS cnt
        FROM products WHERE (p_owner IS NULL OR owner_id = p_owner) AND active
        GROUP BY 1 ORDER BY cnt DESC
      ) c
    ), '[]'::jsonb)
  )
  FROM products WHERE (p_owner IS NULL OR owner_id = p_owner);
$$;

-- p_id is BIGINT (products.id type), not UUID.
CREATE OR REPLACE FUNCTION duplicate_product(p_id BIGINT)
RETURNS products LANGUAGE plpgsql AS $$
DECLARE
  src products;
  copy products;
BEGIN
  SELECT * INTO src FROM products WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  INSERT INTO products (owner_id, name, description, sku, price, tax_rate, discount, category, is_package, active)
  VALUES (src.owner_id, src.name || ' (Copy)', src.description, NULL, src.price, src.tax_rate, src.discount, src.category, src.is_package, src.active)
  RETURNING * INTO copy;
  RETURN copy;
END; $$;

COMMIT;

-- ============================================================
-- 2026-08 Sales + INR + Admin diagnostics upgrade
-- Safe to re-run.
-- ============================================================

BEGIN;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS value_source TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS value_source TEXT NOT NULL DEFAULT 'manual';

CREATE TABLE IF NOT EXISTS admin_login_activity (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT,
  event_type TEXT NOT NULL DEFAULT 'session_seen',
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_login_activity_created ON admin_login_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_login_activity_email ON admin_login_activity(email);

COMMIT;

-- This CRM displays all sales/product monetary values in Indian Rupees.
-- Existing numeric values are not silently converted; they are treated as
-- the CRM's current INR values. If old records were entered as USD, convert
-- those records intentionally before production use.

-- ============================================================
-- Seed: one starter product (guarded — original had no guard,
-- so re-running the file would insert a duplicate row each time)
-- ============================================================
INSERT INTO products (name, description, sku, category, price, tax_rate, discount, is_package, active)
SELECT 'CRM Development', 'Custom CRM development and implementation', 'CRM-001', 'Software', 40000, 18, 0, false, true
WHERE NOT EXISTS (SELECT 1 FROM products WHERE sku = 'CRM-001');

-- ============================================================
-- Fix: customer CSV import failing because customers.segment
-- doesn't exist. server.js's /api/customers/bulk-import inserts
-- into (company_name, contact_name, ceo_name, email, phone,
-- website, industry, segment) — segment was missing from the
-- customers table.
-- Safe to re-run.
-- ============================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS segment TEXT;

-- ============================================================
-- NOVA CRM — PROJECTS MODULE (post-sale client project tracking)
-- Onboarding, contract, team, meetings, attachments, billing,
-- invoices, purchase orders, payments.
--
-- A project is created from a won Opportunity: it links to the
-- customer, the opportunity it came from, and the product sold.
-- Safe to re-run: everything is IF NOT EXISTS.
-- Run AFTER orbit_combined.sql (needs customers, opportunities, products).
-- ============================================================

BEGIN;

-- ============================================================
-- Core project record
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  project_name TEXT NOT NULL,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  opportunity_id BIGINT REFERENCES opportunities(id) ON DELETE SET NULL,
  product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'Onboarding',        -- Onboarding / Active / On Hold / Completed / Cancelled

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects(customer_id);
CREATE INDEX IF NOT EXISTS idx_projects_opportunity ON projects(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_projects_product ON projects(product_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at DESC);

-- ============================================================
-- Project Team / Assignment
-- ============================================================
CREATE TABLE IF NOT EXISTS project_team_members (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL,
  role TEXT,
  assigned_from DATE,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_team_project ON project_team_members(project_id);

-- ============================================================
-- Meetings / MoM
-- ============================================================
CREATE TABLE IF NOT EXISTS project_meetings (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  meeting_title TEXT NOT NULL,
  meeting_date TIMESTAMPTZ,
  is_first_meeting BOOLEAN NOT NULL DEFAULT FALSE,
  discussion_summary TEXT,
  mom TEXT,                                         -- minutes of meeting
  notes_url TEXT,                                   -- where fuller notes are stored
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_meetings_project ON project_meetings(project_id);
CREATE INDEX IF NOT EXISTS idx_project_meetings_date ON project_meetings(meeting_date DESC);

-- ============================================================
-- Attachments / Documents (project + agreement files)
-- ============================================================
CREATE TABLE IF NOT EXISTS project_attachments (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  attachment_type TEXT NOT NULL DEFAULT 'Other',     -- Agreement / Contract / Other
  file_name TEXT NOT NULL,
  file_url TEXT,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_attachments_project ON project_attachments(project_id);

-- ============================================================
-- Billing
-- ============================================================
CREATE TABLE IF NOT EXISTS project_billing (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  billing_frequency TEXT NOT NULL DEFAULT 'One-Time', -- Monthly / Quarterly / Half-Yearly / Yearly / One-Time
  first_billing_date DATE,
  next_billing_date DATE,
  billing_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_billing_project ON project_billing(project_id);

-- ============================================================
-- Invoices
-- ============================================================
CREATE TABLE IF NOT EXISTS project_invoices (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  invoice_number TEXT,
  generated_in_software BOOLEAN NOT NULL DEFAULT TRUE,
  invoice_date DATE,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  file_url TEXT,
  status TEXT NOT NULL DEFAULT 'Generated',          -- Generated / Sent / Paid
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_invoices_project ON project_invoices(project_id);
CREATE INDEX IF NOT EXISTS idx_project_invoices_status ON project_invoices(status);

-- ============================================================
-- Purchase Orders
-- ============================================================
CREATE TABLE IF NOT EXISTS project_purchase_orders (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  po_number TEXT,
  po_issued_date DATE,
  po_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  po_validity_date DATE,
  file_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_po_project ON project_purchase_orders(project_id);

-- ============================================================
-- Payments
-- ============================================================
CREATE TABLE IF NOT EXISTS project_payments (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  amount_received NUMERIC(14,2) NOT NULL DEFAULT 0,
  received_date DATE,
  received_in_account TEXT,
  payment_status TEXT NOT NULL DEFAULT 'Pending',    -- Pending / Received / Partial / Overdue
  reference_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_payments_project ON project_payments(project_id);
CREATE INDEX IF NOT EXISTS idx_project_payments_status ON project_payments(payment_status);

COMMIT;
