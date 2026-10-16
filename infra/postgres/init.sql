-- synapsedx core schema (IAM + workflow metadata)
-- Postgres 16 compatible

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Organizations (AWS Organizations-like)
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Accounts / projects inside an org (AWS Account-like)
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, slug)
);

-- Users (shadow record, federated from Authentik/Keycloak via OIDC `sub`)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_sub TEXT,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, email)
);
-- OIDC federation: one external_sub maps to at most one shadow user (NULLs excluded).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_sub ON users(external_sub) WHERE external_sub IS NOT NULL;
-- Case-insensitive email lookup (Foo@x vs foo@x must not duplicate).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_org_email_lower ON users(org_id, lower(email));

-- Roles (per account scope)
CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, slug)
);

-- Policies (AWS IAM-style JSON documents)
CREATE TABLE IF NOT EXISTS policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  description TEXT DEFAULT '',
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, slug)
);

CREATE TABLE IF NOT EXISTS role_policies (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  policy_id UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, policy_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- API keys (long-lived, hashed, prefix-searchable) — AWS access-key style
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  scopes TEXT[] NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_expiry ON api_keys(expires_at) WHERE revoked_at IS NULL;

-- Service accounts (machine identity inside account)
CREATE TABLE IF NOT EXISTS service_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, slug)
);

-- Refresh tokens (hashed)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Workflow metadata (legacy n8n workflow id cache, kept for backward compat)
CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  n8n_workflow_id TEXT UNIQUE,
  definition JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, slug)
);

-- Workflow engine (local built-in, Apache-2.0): workflows + executions.
-- Auto-created by workflow-service on boot as well (see store.ts ensureTables),
-- duplicated here so fresh `init.sql` installs have indexes from day one.
CREATE TABLE IF NOT EXISTS synapsedx_workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nodes JSONB NOT NULL DEFAULT '[]',
  connections JSONB NOT NULL DEFAULT '{}',
  settings JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_synapsedx_workflows_active ON synapsedx_workflows(active);

CREATE TABLE IF NOT EXISTS synapsedx_executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'success',
  input JSONB NOT NULL DEFAULT '{}',
  output JSONB,
  node_runs JSONB NOT NULL DEFAULT '[]',
  error TEXT,
  triggered_by TEXT NOT NULL DEFAULT 'manual',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_synapsedx_exec_workflow ON synapsedx_executions(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_synapsedx_exec_status ON synapsedx_executions(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_synapsedx_exec_time ON synapsedx_executions(started_at DESC);

-- Audit log cho authorize decisions (CloudTrail-lite)
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type TEXT NOT NULL DEFAULT 'user',
  actor_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  resource TEXT NOT NULL DEFAULT '',
  decision BOOLEAN NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, decision);
CREATE INDEX IF NOT EXISTS idx_refresh_expiry ON refresh_tokens(expires_at) WHERE revoked_at IS NULL;
-- NOTE: audit_log grows unbounded (every authorize/dry-run is a row). Schedule
-- retention (e.g. pg_cron DELETE WHERE created_at < now() - interval '90 days')
-- or partition by month before production scale.

-- FK-column indexes: list-by-parent queries + ON DELETE CASCADE fan-out
-- (unique constraints above already index slug/email/hash lookups).
CREATE INDEX IF NOT EXISTS idx_accounts_org ON accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_roles_account ON roles(account_id);
CREATE INDEX IF NOT EXISTS idx_policies_account ON policies(account_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_service_accounts_account ON service_accounts(account_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_workflows_account ON workflows(account_id);

-- Seed demo org for quickstart (idempotent)
INSERT INTO organizations (slug, display_name)
VALUES ('acme', 'ACME Demo Organization')
ON CONFLICT (slug) DO NOTHING;
-- Seed demo account to match DEMO_ACCOUNT_SLUG=prod (dev-login/quickstart orphan fix).
INSERT INTO accounts (org_id, slug, display_name)
SELECT id, 'prod', 'Production' FROM organizations WHERE slug='acme'
ON CONFLICT DO NOTHING;
