-- ============================================================
-- NOVA CRM — DEMO DATA
-- Products, Leads, Pipeline, Documents (all 4 subsections),
-- Communications
--
-- Safe to re-run: every insert is guarded with WHERE NOT EXISTS
-- against a natural key, so running this twice won't duplicate rows.
-- Run orbit_combined.sql FIRST — this depends on that schema.
-- ============================================================

BEGIN;

-- ============================================================
-- Customers (needed so everything else has something to link to)
-- ============================================================
INSERT INTO customers (company_name, contact_name, email, phone, website, industry, city, state, country, status, owner_id, ceo_name)
SELECT * FROM (VALUES
  ('Sunrise Logistics Pvt Ltd','Ravi Deshmukh','ravi@sunriselogistics.in','+91 9820011223','sunriselogistics.in','Logistics','Pune','Maharashtra','India','Active','sahil','Anil Deshmukh'),
  ('BrightPath EdTech','Neha Kulkarni','neha@brightpathedu.com','+91 9822033445','brightpathedu.com','Education','Mumbai','Maharashtra','India','Active','sahil','Suresh Kulkarni'),
  ('GreenLeaf Foods','Amit Shah','amit@greenleaffoods.in','+91 9812044556','greenleaffoods.in','FMCG','Ahmedabad','Gujarat','India','Active','sahil','Manish Shah'),
  ('Vertex Manufacturing','Priya Nair','priya@vertexmfg.com','+91 9845055667','vertexmfg.com','Manufacturing','Bengaluru','Karnataka','India','Active','sahil','Rajesh Nair'),
  ('Coral Hospitality Group','Sanjay Rao','sanjay@coralhg.com','+91 9867066778','coralhg.com','Hospitality','Goa','Goa','India','Prospect','sahil',NULL),
  ('NimbusTech Solutions','Anjali Mehta','anjali@nimbustech.io','+91 9876077889','nimbustech.io','IT Services','Pune','Maharashtra','India','Prospect','sahil',NULL)
) AS v(company_name, contact_name, email, phone, website, industry, city, state, country, status, owner_id, ceo_name)
WHERE NOT EXISTS (SELECT 1 FROM customers c WHERE c.company_name = v.company_name);

-- ============================================================
-- Products (CRM-001 already seeded by the schema file)
-- ============================================================
INSERT INTO products (name, description, sku, category, price, tax_rate, discount, is_package, active)
SELECT * FROM (VALUES
  ('ERP Development','Custom ERP build and rollout','ERP-001','Software',120000,18,0,false,true),
  ('School ERP','Ready-to-deploy school management ERP','SCH-001','Software',50000,18,5,true,true),
  ('E-commerce Website','Full online store with payment integration','ECM-001','Web',35000,18,0,false,true),
  ('Business Website','5-10 page business website','WEB-001','Web',8000,18,0,false,true),
  ('Android App','Native Android application','AND-001','Mobile',20000,18,0,false,true),
  ('UI/UX Design Package','Design-only engagement','UIX-001','Design',12000,18,10,false,true)
) AS v(name, description, sku, category, price, tax_rate, discount, is_package, active)
WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.sku = v.sku);

-- ============================================================
-- Leads
-- ============================================================
INSERT INTO leads (title, source, status, estimated_value, customer_id, notes, assigned_to, score, ai_insight)
SELECT v.title, v.source, v.status, v.estimated_value, c.id, v.notes, v.assigned_to, v.score, v.ai_insight
FROM (VALUES
  ('Sunrise Logistics — Fleet Tracking CRM','Website','new',180000,'Sunrise Logistics Pvt Ltd','Wants fleet + delivery tracking module included','sahil',72,'Strong budget signal, fast follow-up recommended'),
  ('BrightPath — Student LMS','Referral','contacted',150000,'BrightPath EdTech','Comparing us against 2 other vendors','sahil',65,'Price-sensitive, emphasize AMC value'),
  ('GreenLeaf Foods — Inventory System','Cold Call','qualified',30000,'GreenLeaf Foods','Needs barcode scanning support','sahil',58,'Mid-size deal, quick close likely'),
  ('Vertex Manufacturing — ERP Upgrade','Website','qualified',250000,'Vertex Manufacturing','Migrating off legacy on-prem ERP','sahil',80,'High-value enterprise lead, prioritize'),
  ('Coral Hospitality — Booking Portal','LinkedIn','new',45000,'Coral Hospitality Group','Multi-property booking requirement','sahil',50,'Early stage, needs discovery call'),
  ('NimbusTech — Corporate Website Revamp','Referral','new',20000,'NimbusTech Solutions','Wants modern redesign within 6 weeks','sahil',40,'Small deal, fast turnaround expected')
) AS v(title, source, status, estimated_value, customer_name, notes, assigned_to, score, ai_insight)
JOIN customers c ON c.company_name = v.customer_name
WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE l.title = v.title);

-- ============================================================
-- Pipeline (Opportunities)
-- ============================================================
INSERT INTO opportunities (title, customer_id, lead_id, stage, value, probability, expected_close_date, owner, notes)
SELECT v.title, c.id, l.id, v.stage, v.value, v.probability, v.expected_close_date::date, v.owner, v.notes
FROM (VALUES
  ('Vertex Manufacturing — ERP Upgrade Deal','Vertex Manufacturing','Vertex Manufacturing — ERP Upgrade','Negotiation',250000,70,'2026-09-15','sahil','Final pricing round with procurement team'),
  ('GreenLeaf Foods — Inventory Deal','GreenLeaf Foods','GreenLeaf Foods — Inventory System','Proposal',30000,55,'2026-09-05','sahil','Proposal sent, awaiting feedback'),
  ('BrightPath — LMS Deal','BrightPath EdTech','BrightPath — Student LMS','Qualification',150000,40,'2026-10-01','sahil','Second demo scheduled'),
  ('Sunrise Logistics — Fleet CRM Deal','Sunrise Logistics Pvt Ltd','Sunrise Logistics — Fleet Tracking CRM','Prospecting',180000,25,'2026-10-20','sahil','Initial discovery call done'),
  ('Coral Hospitality — Booking Deal','Coral Hospitality Group','Coral Hospitality — Booking Portal','Prospecting',45000,20,'2026-11-01','sahil','Awaiting requirement doc from client'),
  ('Legacy Client — CRM Renewal','GreenLeaf Foods',NULL,'Closed Won',40000,100,'2026-08-01','sahil','Annual renewal, signed')
) AS v(title, customer_name, lead_title, stage, value, probability, expected_close_date, owner, notes)
JOIN customers c ON c.company_name = v.customer_name
LEFT JOIN leads l ON l.title = v.lead_title
WHERE NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.title = v.title);

-- ============================================================
-- Documents module — subsection 1: Documents
-- ============================================================
INSERT INTO documents (file_name, category, customer_id, uploaded_by, file_url, size_kb, is_shared)
SELECT v.file_name, v.category, c.id, v.uploaded_by, v.file_url, v.size_kb, v.is_shared
FROM (VALUES
  ('Vertex_Manufacturing_Requirements.pdf','Report','Vertex Manufacturing','sahil','/files/vertex_requirements.pdf',842,true),
  ('GreenLeaf_Inventory_Scope.docx','Report','GreenLeaf Foods','sahil','/files/greenleaf_scope.docx',310,false),
  ('BrightPath_LMS_Wireframes.pdf','Other','BrightPath EdTech','sahil','/files/brightpath_wireframes.pdf',1200,true)
) AS v(file_name, category, customer_name, uploaded_by, file_url, size_kb, is_shared)
JOIN customers c ON c.company_name = v.customer_name
WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.file_name = v.file_name);

-- ============================================================
-- Documents module — subsection 2: Contracts
-- ============================================================
INSERT INTO contracts (contract_number, customer_id, start_date, end_date, status, value, sales_owner, notes)
SELECT v.contract_number, c.id, v.start_date::date, v.end_date::date, v.status, v.value, v.sales_owner, v.notes
FROM (VALUES
  ('CNT-2026-001','GreenLeaf Foods','2026-08-01','2027-07-31','Active',40000,'sahil','Annual CRM renewal contract'),
  ('CNT-2026-002','Vertex Manufacturing','2026-09-20','2027-09-19','Draft',250000,'sahil','Pending final signature')
) AS v(contract_number, customer_name, start_date, end_date, status, value, sales_owner, notes)
JOIN customers c ON c.company_name = v.customer_name
WHERE NOT EXISTS (SELECT 1 FROM contracts ct WHERE ct.contract_number = v.contract_number);

-- ============================================================
-- Documents module — subsection 3: Proposal Files
-- ============================================================
INSERT INTO proposal_files (proposal_number, customer_id, opportunity, created_by, status, version, file_url)
SELECT v.proposal_number, c.id, v.opportunity, v.created_by, v.status, v.version, v.file_url
FROM (VALUES
  ('PROP-2026-101','Vertex Manufacturing','Vertex Manufacturing — ERP Upgrade Deal','sahil','Sent',2,'/files/prop_vertex_erp_v2.pdf'),
  ('PROP-2026-102','GreenLeaf Foods','GreenLeaf Foods — Inventory Deal','sahil','Draft',1,'/files/prop_greenleaf_inv_v1.pdf')
) AS v(proposal_number, customer_name, opportunity, created_by, status, version, file_url)
JOIN customers c ON c.company_name = v.customer_name
WHERE NOT EXISTS (SELECT 1 FROM proposal_files pf WHERE pf.proposal_number = v.proposal_number);

-- ============================================================
-- Documents module — subsection 4: Customer Files
-- ============================================================
INSERT INTO customer_files (customer_id, document_type, file_url, uploaded_by, expiry_date, status)
SELECT c.id, v.document_type, v.file_url, v.uploaded_by, v.expiry_date::date, v.status
FROM (VALUES
  ('Vertex Manufacturing','GST Certificate','/files/vertex_gst.pdf','sahil','2027-03-31','Approved'),
  ('GreenLeaf Foods','PAN Card','/files/greenleaf_pan.pdf','sahil',NULL,'Approved'),
  ('BrightPath EdTech','Company Registration','/files/brightpath_incorp.pdf','sahil',NULL,'Pending')
) AS v(customer_name, document_type, file_url, uploaded_by, expiry_date, status)
JOIN customers c ON c.company_name = v.customer_name
WHERE NOT EXISTS (
  SELECT 1 FROM customer_files cf WHERE cf.customer_id = c.id AND cf.document_type = v.document_type
);

-- ============================================================
-- Communications
-- ============================================================
INSERT INTO communications (customer_id, lead_id, opportunity_id, type, direction, subject, body, sender_email, sender_name, recipient_email, recipient_name, status, message_id, is_read, sent_at, received_at)
SELECT c.id, l.id, o.id, v.type, v.direction, v.subject, v.body, v.sender_email, v.sender_name, v.recipient_email, v.recipient_name, v.status, v.message_id, v.is_read, v.sent_at::timestamptz, v.received_at::timestamptz
FROM (VALUES
  ('Vertex Manufacturing','Vertex Manufacturing — ERP Upgrade','Vertex Manufacturing — ERP Upgrade Deal','email','outbound','ERP Proposal for Vertex Manufacturing','Hi Priya, please find attached our proposal for the ERP upgrade...','pradeep@orbitavanyatech.com','Pradeep Singh','priya@vertexmfg.com','Priya Nair','sent','msg-vertex-001',true,'2026-08-12 10:15:00',NULL),
  ('Vertex Manufacturing','Vertex Manufacturing — ERP Upgrade','Vertex Manufacturing — ERP Upgrade Deal','email','inbound','Re: ERP Proposal for Vertex Manufacturing','Thanks, we are reviewing internally and will revert by Friday.','priya@vertexmfg.com','Priya Nair','pradeep@orbitavanyatech.com','Pradeep Singh','received','msg-vertex-002',true,NULL,'2026-08-13 09:40:00'),
  ('GreenLeaf Foods','GreenLeaf Foods — Inventory System','GreenLeaf Foods — Inventory Deal','email','outbound','Inventory System Proposal','Hi Amit, sharing the proposal for the inventory management system.','pradeep@orbitavanyatech.com','Pradeep Singh','amit@greenleaffoods.in','Amit Shah','sent','msg-greenleaf-001',false,'2026-08-14 11:00:00',NULL),
  ('BrightPath EdTech','BrightPath — Student LMS','BrightPath — LMS Deal','call','outbound','Discovery call — LMS requirements','Discussed core LMS modules and rollout timeline.','pradeep@orbitavanyatech.com','Pradeep Singh','neha@brightpathedu.com','Neha Kulkarni','completed','msg-brightpath-001',true,'2026-08-10 15:30:00',NULL),
  ('Sunrise Logistics Pvt Ltd','Sunrise Logistics — Fleet Tracking CRM',NULL,'email','inbound','Fleet tracking CRM — initial enquiry','We are looking for a CRM with live fleet tracking, can you help?','ravi@sunriselogistics.in','Ravi Deshmukh','pradeep@orbitavanyatech.com','Pradeep Singh','received','msg-sunrise-001',true,NULL,'2026-08-11 08:20:00')
) AS v(customer_name, lead_title, opportunity_title, type, direction, subject, body, sender_email, sender_name, recipient_email, recipient_name, status, message_id, is_read, sent_at, received_at)
JOIN customers c ON c.company_name = v.customer_name
LEFT JOIN leads l ON l.title = v.lead_title
LEFT JOIN opportunities o ON o.title = v.opportunity_title
WHERE NOT EXISTS (SELECT 1 FROM communications co WHERE co.message_id = v.message_id);

COMMIT;

INSERT INTO client_contracts (
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
VALUES (
    '87b0798c-c91f-4a7f-8c45-4c51f5ed19e8',
    'TEST-001',
    'Test Client Company',
    'Client Service Agreement',
    'Active',
    CURRENT_DATE,
    CURRENT_DATE + INTERVAL '1 year',
    '12 months',
    'CRM Software Services',
    0,
    'INR',
    'Test contract for validating client onboarding.'
)
RETURNING *;

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
--    (If your crm_users table has extra required columns this
--    script doesn't know about, that step is skipped safely —
--    sign up demo.client@example.com through your app instead,
--    then re-run this script.)
-- 2. Log in as demo.client@example.com (or as any admin/staff
--    user) and open Client Onboarding — fully populated.
-- 3. Want to attach the demo data to a different, existing
--    login instead? Change demo_user_email inside the second
--    DO block further down.
--
-- Safe to re-run: it deletes only the demo contract it created
-- on a previous run (matched by contract_number), so re-running
-- just refreshes the same demo data.
-- ============================================================

-- If a previous run of this script (or any earlier statement in this
-- session) failed, the connection may be sitting in an aborted
-- transaction. This clears that safely — it's a harmless no-op if
-- there's nothing to roll back.
ROLLBACK;

BEGIN;

-- ------------------------------------------------------------
-- 0. DEMO LOGIN (created only if it doesn't already exist)
-- Email:    demo.client@example.com
-- Password: Demo@12345
-- The password hash below was generated with Node's crypto.scryptSync
-- the exact same way this app's hashPassword() function does, so this
-- is a real, working login — not a placeholder.
-- ------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO crm_users
    (email, password_hash, password_salt, full_name, role, email_verified)
  SELECT
    'demo.client@example.com',
    '98450715833f658101e1cbedf622a1d5f274c5086cb89c02657ceec85de88e390df2f78fc94f9ee3f6bdb06a22fade6fe6121466ee6f3cc0be9a4090654130c4',
    '994bf557726ba2a2874d26bbd4360a07',
    'John Smith',
    'client',
    TRUE
  WHERE NOT EXISTS (
    SELECT 1 FROM crm_users WHERE LOWER(email) = LOWER('demo.client@example.com')
  );
EXCEPTION WHEN OTHERS THEN
  -- crm_users may have extra NOT NULL columns this script doesn't know about
  -- (e.g. a required phone/username field). If so, skip auto-creation here
  -- and just sign up demo.client@example.com through your app's normal
  -- registration screen instead, then re-run this script.
  RAISE WARNING 'Could not auto-create demo login (%). Sign it up via the app instead, then re-run this script.', SQLERRM;
END $$;

DO $$
DECLARE
  demo_user_email   TEXT := 'demo.client@example.com';  -- <-- edit only if you want to target a different existing login
  v_user_id         UUID;
  v_contract_id     BIGINT;
BEGIN
  SELECT id INTO v_user_id FROM crm_users WHERE LOWER(email) = LOWER(demo_user_email) LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION
      'No crm_users row found for %. Create/sign up that login first, or edit demo_user_email at the top of this script to an existing user email.',
      demo_user_email;
  END IF;

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
    (v_user_id, 'CNT-2026-DEMO-001', 'ABC Technologies', 'Annual Managed Services Agreement', 'Active',
     '2026-08-21', '2027-08-20', '12 Months',
     'CRM Development, Cloud Hosting & Support, Monthly Maintenance (AMC)',
     900000, 'INR', 'https://files.example.com/contracts/abc-technologies-msa-2026.pdf',
     'Signed via DocuSign on 20 Aug 2026. Renewal to be reviewed 60 days before end date.')
  RETURNING id INTO v_contract_id;

  -- The insert trigger auto-creates a blank client_onboarding row
  -- and a "contract workspace created" activity entry. We now
  -- fill that onboarding row in with real demo values.

  -- ----------------------------------------------------------
  -- 2. ONBOARDING / PROJECT START / SERVICE DETAILS
  -- ----------------------------------------------------------
  UPDATE client_onboarding SET
    onboarding_status = 'Completed',
    onboarding_completed_at = '2026-08-20 10:42:00+05:30',
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
  WHERE contract_id = v_contract_id;

  -- ----------------------------------------------------------
  -- 3. PROJECT TEAM
  -- ----------------------------------------------------------
  INSERT INTO client_contract_team
    (contract_id, member_name, member_email, role, department, assignment_start_date, is_current, responsibilities)
  VALUES
    (v_contract_id, 'Neha Sharma', 'neha.sharma@nova.com', 'Project Manager', 'Delivery', '2026-08-21', TRUE,
     'Overall delivery ownership, client communication, sprint planning and status reporting.'),
    (v_contract_id, 'Arjun Mehta', 'arjun.mehta@nova.com', 'Lead Developer', 'Engineering', '2026-08-21', TRUE,
     'Backend architecture, API development and code reviews.'),
    (v_contract_id, 'Priya Nair', 'priya.nair@nova.com', 'UI/UX Designer', 'Design', '2026-08-21', TRUE,
     'Wireframes, UI design system and usability testing.'),
    (v_contract_id, 'Rohit Verma', 'rohit.verma@nova.com', 'QA Engineer', 'Engineering', '2026-08-24', TRUE,
     'Test planning, functional QA and release sign-off.');

  -- ----------------------------------------------------------
  -- 4. MEETINGS & MoM
  -- ----------------------------------------------------------
  INSERT INTO client_contract_meetings
    (contract_id, meeting_title, meeting_date, meeting_type, participants, discussion,
     minutes_of_meeting, action_items, notes_storage_url, created_by)
  VALUES
    (v_contract_id, 'Kickoff & Requirement Discussion', '2026-08-15 11:00:00+05:30', 'Kickoff Meeting',
     'Neha Sharma (Nova), Pradeep Singh (Nova), John Smith (ABC Technologies), Sarah Lee (ABC Technologies)',
     'Reviewed scope of work, confirmed timelines, discussed integration requirements with existing ERP and data migration approach.',
     'Client confirmed 12-month engagement. Nova to share detailed requirement document by 18 Aug. Client to provide ERP API access by 20 Aug.',
     'Nova: share requirement doc (due 18 Aug). Client: share ERP credentials (due 20 Aug). Both: confirm sprint cadence (weekly).',
     'https://drive.example.com/abc-technologies/meetings/kickoff-15aug2026',
     'Pradeep Singh'),
    (v_contract_id, 'Sprint 1 Planning', '2026-08-23 15:30:00+05:30', 'Project Meeting',
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
    (v_contract_id, 'Agreement', 'ABC_Technologies_MSA_2026.pdf', 'https://files.example.com/contracts/abc-technologies-msa-2026.pdf', 'application/pdf', 812, 'Pradeep Singh', TRUE, 'Signed master service agreement.'),
    (v_contract_id, 'Requirement Document', 'ABC_Requirement_Doc_v1.pdf', 'https://files.example.com/abc/requirement-doc-v1.pdf', 'application/pdf', 456, 'Neha Sharma', TRUE, 'Approved by client on 18 Aug 2026.'),
    (v_contract_id, 'Proposal', 'ABC_Technologies_Proposal.pdf', 'https://files.example.com/abc/proposal.pdf', 'application/pdf', 320, 'Pradeep Singh', TRUE, NULL),
    (v_contract_id, 'NDA', 'ABC_NDA_Signed.pdf', 'https://files.example.com/abc/nda-signed.pdf', 'application/pdf', 140, 'Pradeep Singh', TRUE, 'Executed 10 Aug 2026.'),
    (v_contract_id, 'Design', 'ABC_UI_Wireframes.pdf', 'https://files.example.com/abc/ui-wireframes.pdf', 'application/pdf', 980, 'Priya Nair', TRUE, 'Sprint 1 wireframes.'),
    (v_contract_id, 'Invoice', 'INV-2026-0001.pdf', 'https://files.example.com/abc/invoices/INV-2026-0001.pdf', 'application/pdf', 96, 'Nova Billing', TRUE, NULL),
    (v_contract_id, 'Purchase Order', 'PO-2026-0001.pdf', 'https://files.example.com/abc/po/PO-2026-0001.pdf', 'application/pdf', 88, 'John Smith', TRUE, 'Received from client on 18 Aug 2026.'),
    (v_contract_id, 'Other', 'ABC_Kickoff_Presentation.pptx', 'https://files.example.com/abc/kickoff-presentation.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 2140, 'Pradeep Singh', TRUE, 'Shared in kickoff meeting.');

  -- ----------------------------------------------------------
  -- 6. BILLING
  -- ----------------------------------------------------------
  INSERT INTO client_contract_billing
    (contract_id, billing_cycle_name, billing_frequency, billing_amount, currency,
     first_billing_date, next_billing_date, cycle_start_date, cycle_end_date, status, notes)
  VALUES
    (v_contract_id, 'Monthly Retainer', 'Monthly', 75000, 'INR',
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
    (v_contract_id, 'INV-2026-0001', '2026-08-25', '2026-09-04', '2026-08-21', '2026-08-31',
     75000, 13500, 88500, 'INR', 'Paid', 'https://files.example.com/abc/invoices/INV-2026-0001.pdf',
     TRUE, '2026-08-25 09:15:00+05:30', 'First invoice of the engagement, paid on time.'),
    (v_contract_id, 'INV-2026-0002', '2026-09-01', '2026-09-11', '2026-09-01', '2026-09-30',
     75000, 13500, 88500, 'INR', 'Pending', 'https://files.example.com/abc/invoices/INV-2026-0002.pdf',
     TRUE, '2026-09-01 09:05:00+05:30', 'Awaiting payment.');

  -- ----------------------------------------------------------
  -- 8. PURCHASE ORDERS
  -- ----------------------------------------------------------
  INSERT INTO client_contract_purchase_orders
    (contract_id, po_number, issue_date, amount, currency,
     validity_start_date, validity_end_date, status, po_document_url, notes)
  VALUES
    (v_contract_id, 'PO-2026-0001', '2026-08-18', 900000, 'INR',
     '2026-08-21', '2027-08-20', 'Active', 'https://files.example.com/abc/po/PO-2026-0001.pdf',
     'Covers the full 12-month engagement value.');

  -- ----------------------------------------------------------
  -- 9. PAYMENTS
  -- ----------------------------------------------------------
  INSERT INTO client_contract_payments
    (contract_id, payment_date, amount_received, currency, payment_status,
     payment_method, received_account, payment_reference, transaction_reference, receipt_url, notes)
  VALUES
    (v_contract_id, '2026-08-26', 88500, 'INR', 'Received',
     'Bank Transfer (NEFT)', 'Nova Solutions — HDFC Bank ****4521', 'INV-2026-0001',
     'NEFT-REF-88231045', 'https://files.example.com/abc/receipts/receipt-inv-0001.pdf',
     'Payment against INV-2026-0001, received within due date.');

  -- ----------------------------------------------------------
  -- 10. ACTIVITY LOG (a few extra entries beyond the auto ones)
  -- ----------------------------------------------------------
  INSERT INTO client_contract_activity
    (contract_id, activity_type, title, description, actor_name, actor_role)
  VALUES
    (v_contract_id, 'onboarding_completed', 'Onboarding completed', 'Client officially onboarded after orientation call.', 'Pradeep Singh', 'admin'),
    (v_contract_id, 'project_started', 'Project started', 'Project kicked off and Sprint 1 planning scheduled.', 'Neha Sharma', 'manager'),
    (v_contract_id, 'agreement_signed', 'Agreement signed', 'Master service agreement executed via DocuSign.', 'Pradeep Singh', 'admin'),
    (v_contract_id, 'document_uploaded', 'Document uploaded', 'Requirement document v1 uploaded and shared with client.', 'Neha Sharma', 'manager'),
    (v_contract_id, 'meeting_scheduled', 'Meeting scheduled', 'Sprint 1 planning meeting scheduled with client.', 'Neha Sharma', 'manager'),
    (v_contract_id, 'invoice_generated', 'Invoice generated', 'INV-2026-0001 generated in software and sent to client.', 'Nova Billing', 'staff'),
    (v_contract_id, 'payment_received', 'Payment received', 'Payment of INR 88,500 received against INV-2026-0001.', 'Nova Billing', 'staff');

  RAISE NOTICE 'Demo contract % created for user % (contract_id = %).', 'CNT-2026-DEMO-001', demo_user_email, v_contract_id;
END $$;

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

ROLLBACK;

BEGIN;

DO $$
DECLARE
    v_user_id UUID;
    v_contract_id BIGINT;
    v_user_email TEXT := 'sahilsrale15@gmail.com';
BEGIN

    -- ============================================================
    -- 1. FIND SAHIL'S EXISTING ACCOUNT
    -- ============================================================

    SELECT id
    INTO v_user_id
    FROM crm_users
    WHERE LOWER(email) = LOWER(v_user_email)
    LIMIT 1;

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION
            'User % was not found in crm_users. Please create this account first.',
            v_user_email;
    END IF;

    RAISE NOTICE 'Found user % with ID %', v_user_email, v_user_id;


    -- ============================================================
    -- 2. REMOVE ONLY OLD GODREJ DEMO CONTRACT
    -- ============================================================

    DELETE FROM client_contracts
    WHERE user_id = v_user_id
      AND contract_number = 'CNT-GODREJ-2026-001';


    -- ============================================================
    -- 3. CREATE GODREJ ONE INDUSTRIES CONTRACT
    -- ============================================================

    INSERT INTO client_contracts (
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
        contract_document_url,
        notes
    )
    VALUES (
        v_user_id,
        'CNT-GODREJ-2026-001',
        'Godrej One Industries',
        'Annual CRM Development and Managed Services Agreement',
        'Active',
        '2026-08-22',
        '2027-08-21',
        '12 Months',
        'CRM Development, Client Onboarding, Sales Pipeline, Billing, AMC Support',
        1200000,
        'INR',
        '/files/contracts/godrej-one-industries-agreement-2026.pdf',
        'Godrej One Industries annual CRM implementation and managed services contract.'
    )
    RETURNING id INTO v_contract_id;


    -- ============================================================
    -- 4. ONBOARDING / PROJECT START / SERVICE DETAILS
    -- ============================================================

    UPDATE client_onboarding
    SET
        onboarding_status = 'Completed',
        onboarding_completed_at = '2026-08-22 10:30:00+05:30',
        onboarding_completed_by = 'Sahil',
        onboarding_notes = 'Client onboarding completed successfully. Requirements, project scope and communication process confirmed.',

        project_start_date = '2026-08-22',
        initial_project_discussion_date = '2026-08-18',
        project_status = 'In Progress',
        current_phase = 'Requirement Analysis',
        progress_percent = 35,

        service_name = 'CRM Development and Managed Services',
        service_duration = '12 Months',
        service_active_until = '2027-08-21',
        service_notes = 'Custom CRM development, sales management, client onboarding, billing, reporting and annual maintenance support.',

        project_notes = 'Initial requirements completed. Sprint planning in progress. Team members assigned and project kickoff completed.'
    WHERE contract_id = v_contract_id;


    -- ============================================================
    -- 5. PROJECT TEAM
    -- ============================================================

    INSERT INTO client_contract_team (
        contract_id,
        member_name,
        member_email,
        role,
        department,
        assignment_start_date,
        is_current,
        responsibilities
    )
    VALUES

    (
        v_contract_id,
        'Sahil',
        'sahilsrale15@gmail.com',
        'Project Owner',
        'Management',
        '2026-08-22',
        TRUE,
        'Overall project ownership, client coordination, contract management and final approvals.'
    ),

    (
        v_contract_id,
        'Neha Sharma',
        'neha.sharma@nova.com',
        'Project Manager',
        'Delivery',
        '2026-08-22',
        TRUE,
        'Project planning, client communication, sprint coordination and delivery tracking.'
    ),

    (
        v_contract_id,
        'Arjun Mehta',
        'arjun.mehta@nova.com',
        'Lead Developer',
        'Engineering',
        '2026-08-22',
        TRUE,
        'Technical architecture, backend development, APIs and code review.'
    ),

    (
        v_contract_id,
        'Priya Nair',
        'priya.nair@nova.com',
        'UI/UX Designer',
        'Design',
        '2026-08-23',
        TRUE,
        'User interface design, wireframes, design system and usability improvements.'
    ),

    (
        v_contract_id,
        'Rohit Verma',
        'rohit.verma@nova.com',
        'QA Engineer',
        'Engineering',
        '2026-08-25',
        TRUE,
        'Test planning, functional testing, regression testing and release validation.'
    );


    -- ============================================================
    -- 6. MEETINGS & MOM
    -- ============================================================

    INSERT INTO client_contract_meetings (
        contract_id,
        meeting_title,
        meeting_date,
        meeting_type,
        participants,
        discussion,
        minutes_of_meeting,
        action_items,
        notes_storage_url,
        created_by
    )
    VALUES

    (
        v_contract_id,
        'Godrej One Industries Project Kickoff',
        '2026-08-18 11:00:00+05:30',
        'Kickoff Meeting',
        'Sahil, Neha Sharma, Arjun Mehta, Godrej One Industries stakeholders',
        'Reviewed project scope, timelines, CRM requirements, onboarding workflow and billing requirements.',
        'Project officially approved. Requirement analysis to begin immediately. Weekly status meetings agreed.',
        'Prepare requirement document, confirm user roles and collect existing customer data.',
        '/files/meetings/godrej-kickoff-2026.pdf',
        'Sahil'
    ),

    (
        v_contract_id,
        'Requirement Analysis Meeting',
        '2026-08-23 15:00:00+05:30',
        'Project Meeting',
        'Sahil, Neha Sharma, Arjun Mehta, Client Team',
        'Detailed discussion about sales pipeline, customers, contracts, project teams and invoices.',
        'Core CRM modules finalized. Client onboarding and billing identified as priority modules.',
        'Development team to prepare Sprint 1 tasks.',
        '/files/meetings/godrej-requirements-2026.pdf',
        'Neha Sharma'
    );


    -- ============================================================
    -- 7. DOCUMENTS / ATTACHMENTS
    -- ============================================================

    INSERT INTO client_contract_documents (
        contract_id,
        document_type,
        file_name,
        file_url,
        mime_type,
        size_kb,
        uploaded_by,
        is_client_visible,
        notes
    )
    VALUES

    (
        v_contract_id,
        'Agreement',
        'Godrej_One_Industries_Agreement_2026.pdf',
        '/files/contracts/godrej-one-industries-agreement-2026.pdf',
        'application/pdf',
        850,
        'Sahil',
        TRUE,
        'Signed annual service agreement.'
    ),

    (
        v_contract_id,
        'Requirement Document',
        'Godrej_CRM_Requirements_v1.pdf',
        '/files/godrej/requirements-v1.pdf',
        'application/pdf',
        620,
        'Neha Sharma',
        TRUE,
        'Initial CRM requirement document.'
    ),

    (
        v_contract_id,
        'Proposal',
        'Godrej_CRM_Proposal.pdf',
        '/files/godrej/proposal.pdf',
        'application/pdf',
        410,
        'Sahil',
        TRUE,
        'Approved project proposal.'
    ),

    (
        v_contract_id,
        'Design',
        'Godrej_CRM_UI_Wireframes.pdf',
        '/files/godrej/ui-wireframes.pdf',
        'application/pdf',
        980,
        'Priya Nair',
        TRUE,
        'Initial dashboard and CRM wireframes.'
    );


    -- ============================================================
    -- 8. BILLING
    -- ============================================================

    INSERT INTO client_contract_billing (
        contract_id,
        billing_cycle_name,
        billing_frequency,
        billing_amount,
        currency,
        first_billing_date,
        next_billing_date,
        cycle_start_date,
        cycle_end_date,
        status,
        notes
    )
    VALUES (
        v_contract_id,
        'Monthly CRM Managed Services',
        'Monthly',
        100000,
        'INR',
        '2026-08-25',
        '2026-09-01',
        '2026-08-22',
        '2026-09-21',
        'Active',
        'Monthly billing cycle for CRM development and managed services.'
    );


    -- ============================================================
    -- 9. INVOICES
    -- ============================================================

    INSERT INTO client_contract_invoices (
        contract_id,
        invoice_number,
        invoice_date,
        due_date,
        billing_period_start,
        billing_period_end,
        amount,
        tax_amount,
        total_amount,
        currency,
        status,
        invoice_url,
        generated_in_software,
        generated_at,
        notes
    )
    VALUES

    (
        v_contract_id,
        'INV-GODREJ-2026-001',
        '2026-08-25',
        '2026-09-04',
        '2026-08-22',
        '2026-08-31',
        100000,
        18000,
        118000,
        'INR',
        'Paid',
        '/files/godrej/invoices/INV-GODREJ-2026-001.pdf',
        TRUE,
        '2026-08-25 09:00:00+05:30',
        'First invoice generated through the CRM software.'
    ),

    (
        v_contract_id,
        'INV-GODREJ-2026-002',
        '2026-09-01',
        '2026-09-11',
        '2026-09-01',
        '2026-09-30',
        100000,
        18000,
        118000,
        'INR',
        'Pending',
        '/files/godrej/invoices/INV-GODREJ-2026-002.pdf',
        TRUE,
        '2026-09-01 09:00:00+05:30',
        'Second monthly invoice awaiting payment.'
    );


    -- ============================================================
    -- 10. PURCHASE ORDER
    -- ============================================================

    INSERT INTO client_contract_purchase_orders (
        contract_id,
        po_number,
        issue_date,
        amount,
        currency,
        validity_start_date,
        validity_end_date,
        status,
        po_document_url,
        notes
    )
    VALUES (
        v_contract_id,
        'PO-GODREJ-2026-001',
        '2026-08-20',
        1200000,
        'INR',
        '2026-08-22',
        '2027-08-21',
        'Active',
        '/files/godrej/po/PO-GODREJ-2026-001.pdf',
        'Purchase order covering the complete annual engagement.'
    );


    -- ============================================================
    -- 11. PAYMENT
    -- ============================================================

    INSERT INTO client_contract_payments (
        contract_id,
        payment_date,
        amount_received,
        currency,
        payment_status,
        payment_method,
        received_account,
        payment_reference,
        transaction_reference,
        receipt_url,
        notes
    )
    VALUES (
        v_contract_id,
        '2026-08-27',
        118000,
        'INR',
        'Received',
        'Bank Transfer',
        'Business Account',
        'INV-GODREJ-2026-001',
        'GODREJ-NEFT-2026-001',
        '/files/godrej/receipts/receipt-001.pdf',
        'Payment received successfully against the first invoice.'
    );


    -- ============================================================
    -- 12. ACTIVITY LOG
    -- ============================================================

    INSERT INTO client_contract_activity (
        contract_id,
        activity_type,
        title,
        description,
        actor_name,
        actor_role
    )
    VALUES

    (
        v_contract_id,
        'contract_created',
        'Godrej contract created',
        'New client contract workspace created for Godrej One Industries.',
        'Sahil',
        'admin'
    ),

    (
        v_contract_id,
        'onboarding_completed',
        'Client onboarding completed',
        'Godrej One Industries onboarding process completed successfully.',
        'Sahil',
        'admin'
    ),

    (
        v_contract_id,
        'project_started',
        'Project started',
        'CRM development project moved to Requirement Analysis phase.',
        'Neha Sharma',
        'manager'
    ),

    (
        v_contract_id,
        'team_assigned',
        'Project team assigned',
        'Project manager, lead developer, UI/UX designer and QA engineer assigned.',
        'Sahil',
        'admin'
    ),

    (
        v_contract_id,
        'invoice_generated',
        'First invoice generated',
        'INV-GODREJ-2026-001 generated successfully.',
        'Sahil',
        'admin'
    ),

    (
        v_contract_id,
        'payment_received',
        'Payment received',
        'First invoice payment received successfully.',
        'Sahil',
        'admin'
    );


    RAISE NOTICE
        'Godrej One Industries demo data created successfully for % (contract ID: %)',
        v_user_email,
        v_contract_id;

END $$;

COMMIT;