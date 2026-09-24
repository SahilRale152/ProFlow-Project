-- Self-managed authentication migration for OrbitAvanya CRM.
-- Run this after your existing CRM schema.
-- This uses PostgreSQL directly; no Supabase Auth tables are required.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS crm_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verification_token_hash TEXT,
  verification_expires_at TIMESTAMPTZ,
  reset_token_hash TEXT,
  reset_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_users_email ON crm_users(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_crm_users_verification ON crm_users(verification_token_hash);
CREATE INDEX IF NOT EXISTS idx_crm_users_reset ON crm_users(reset_token_hash);

-- Existing login activity table is retained for the Admin page.
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

CREATE INDEX IF NOT EXISTS idx_admin_login_activity_created
  ON admin_login_activity(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_login_activity_email
  ON admin_login_activity(email);

-- To remove register emails.
DELETE FROM crm_users
WHERE LOWER(email) = LOWER('enteruseremailtodelete@gmail.com');


-- To see all register emails.
SELECT id, email, full_name, role, email_verified, created_at
FROM crm_users
ORDER BY created_at DESC;


UPDATE crm_users
SET role = 'admin',
    updated_at = NOW()
WHERE email = 'sahilrale15022005@gmail.com';


SELECT
    u.id AS user_id,
    u.full_name,
    u.email,
    u.role,
    c.id AS contract_id,
    c.contract_number,
    c.client_company_name,
    c.status
FROM crm_users u
LEFT JOIN client_contracts c
    ON c.user_id = u.id
ORDER BY u.email, c.id;