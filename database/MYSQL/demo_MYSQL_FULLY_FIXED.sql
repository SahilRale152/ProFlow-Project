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
