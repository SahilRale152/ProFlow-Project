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
