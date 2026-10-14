/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0;
 */
// API catalog the AI agent may pick from. Mirrors
// apps/console/src/lib/endpoints.js (which mirrors docs/api.md) —
// keep all three in sync when endpoints change.
// NOTE: /v1/ai/* is intentionally EXCLUDED — the agent must not
// call itself (recursion + LLM cost).

export interface CatalogEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  auth: string;
  desc: string;
  body?: unknown;
}

export const CATALOG: CatalogEndpoint[] = [
  // Auth
  { method: 'POST', path: '/v1/auth/login', auth: 'none', desc: 'Dev sign-in, mints JWT + refresh', body: { email: 'demo@acme.local', orgSlug: 'acme' } },
  { method: 'POST', path: '/v1/auth/refresh', auth: 'none', desc: 'Rotate refresh token (single-use)', body: { refreshToken: '<rt>' } },
  { method: 'POST', path: '/v1/auth/logout', auth: 'none', desc: 'Revoke one refresh token', body: { refreshToken: '<rt>' } },
  { method: 'POST', path: '/v1/auth/logout-all', auth: 'none', desc: 'Revoke all of your own sessions', body: { refreshToken: '<rt>' } },
  { method: 'GET', path: '/v1/auth/verify', auth: 'jwt/key', desc: 'Verify a Bearer token or X-API-Key' },
  { method: 'GET', path: '/v1/auth/me', auth: 'jwt', desc: 'The user behind the Bearer token' },
  { method: 'GET', path: '/v1/auth/oidc/config', auth: 'none', desc: 'OIDC issuer/client (Authentik/Keycloak)' },
  { method: 'GET', path: '/v1/auth/oidc/start?org=acme', auth: 'none', desc: 'Build IdP authorize URL + signed state' },
  { method: 'POST', path: '/v1/auth/oidc/callback', auth: 'none', desc: 'Real code exchange → tokens (or demo email in dev)', body: { code: '<code>', state: '<state>' } },
  // Organizations & Accounts
  { method: 'GET', path: '/v1/orgs', auth: 'either', desc: 'List organizations' },
  { method: 'POST', path: '/v1/orgs', auth: 'either', desc: 'Create an org', body: { slug: 'acme-2', displayName: 'ACME 2' } },
  { method: 'GET', path: '/v1/orgs/:orgId/accounts', auth: 'either', desc: 'Accounts in the org' },
  { method: 'POST', path: '/v1/orgs/:orgId/accounts', auth: 'either', desc: 'Create an account', body: { slug: 'prod', displayName: 'Production' } },
  { method: 'GET', path: '/v1/orgs/:orgId/users', auth: 'either', desc: 'Users in the org' },
  { method: 'POST', path: '/v1/orgs/:orgId/users', auth: 'either', desc: 'Add a user', body: { email: 'a@acme.local' } },
  // Roles · Policies · Authorize
  { method: 'GET', path: '/v1/accounts/:accountId/roles', auth: 'either', desc: 'Roles in the account' },
  { method: 'POST', path: '/v1/accounts/:accountId/roles', auth: 'either', desc: 'Create a role', body: { slug: 'runner' } },
  { method: 'DELETE', path: '/v1/roles/:roleId', auth: 'either', desc: 'Delete a role' },
  { method: 'GET', path: '/v1/accounts/:accountId/policies', auth: 'either', desc: 'Policies in the account' },
  { method: 'POST', path: '/v1/accounts/:accountId/policies', auth: 'either', desc: 'Create an AWS-style policy', body: { slug: 'run-only', document: { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: ['workflow:Execute'], Resource: '*' }] } } },
  { method: 'DELETE', path: '/v1/policies/:policyId', auth: 'either', desc: 'Delete a policy' },
  { method: 'POST', path: '/v1/roles/:roleId/attach', auth: 'either', desc: 'Attach a policy to a role', body: { policyId: '<pid>' } },
  { method: 'POST', path: '/v1/users/:userId/assign', auth: 'either', desc: 'Assign a role to a user', body: { roleId: '<rid>' } },
  { method: 'GET', path: '/v1/users/:userId/policies', auth: 'either', desc: "The user's effective policies" },
  { method: 'POST', path: '/v1/authorize', auth: 'either', desc: 'Evaluate Allow/Deny (+Condition)', body: { userId: '<uid>', action: 'workflow:Execute', resource: '*', context: { team: 'etl' } } },
  { method: 'POST', path: '/v1/authorize/dry-run', auth: 'either', desc: 'Simulator without a user', body: { documents: [], action: 'workflow:Execute', resource: '*' } },
  { method: 'GET', path: '/v1/audit', auth: 'either', desc: 'Audit log (?limit=&actor=)' },
  // API Keys & Service Accounts
  { method: 'POST', path: '/v1/accounts/:accountId/keys', auth: 'either', desc: 'Create a key (shown once)', body: { name: 'demo' } },
  { method: 'GET', path: '/v1/accounts/:accountId/keys', auth: 'either', desc: 'List key metadata (id/prefix only, never secrets)' },
  { method: 'POST', path: '/v1/keys/verify', auth: 'either', desc: 'Verify a key', body: { apiKey: '<key>' } },
  { method: 'DELETE', path: '/v1/keys/:id', auth: 'either', desc: 'Revoke a key' },
  { method: 'GET', path: '/v1/accounts/:accountId/service-accounts', auth: 'either', desc: 'Service accounts' },
  { method: 'POST', path: '/v1/accounts/:accountId/service-accounts', auth: 'either', desc: 'Create a service account', body: { slug: 'etl-worker' } },
  { method: 'POST', path: '/v1/service-accounts/:id/token', auth: 'either', desc: 'Mint a kind=service-account JWT', body: {} },
  // Workflows (n8n)
  { method: 'GET', path: '/v1/templates', auth: 'either', desc: 'Built-in templates' },
  { method: 'GET', path: '/v1/templates/:name', auth: 'either', desc: 'One template in detail' },
  { method: 'GET', path: '/v1/workflows', auth: 'either', desc: 'Workflows on n8n (proxied)' },
  { method: 'POST', path: '/v1/workflows', auth: 'either', desc: 'Create from a template', body: { template: 'webhook-to-log', name: 'demo' } },
  { method: 'GET', path: '/v1/workflows/:id', auth: 'either', desc: 'Workflow details' },
  { method: 'DELETE', path: '/v1/workflows/:id', auth: 'either', desc: 'Delete a workflow on n8n' },
  { method: 'PUT', path: '/v1/workflows/:id', auth: 'either', desc: 'Update name/definition', body: { name: 'demo', definition: { nodes: [], connections: {} } } },
  { method: 'POST', path: '/v1/workflows/:id/activate', auth: 'either', desc: 'Activate' },
  { method: 'POST', path: '/v1/workflows/:id/deactivate', auth: 'either', desc: 'Deactivate' },
  { method: 'POST', path: '/v1/workflows/:id/execute', auth: 'either', desc: 'Execute manually', body: {} },
  { method: 'GET', path: '/v1/executions', auth: 'either', desc: 'Execution history' },
  { method: 'GET', path: '/v1/executions/:id', auth: 'either', desc: 'One execution in detail' },
  // Ops
  { method: 'GET', path: '/health', auth: 'none', desc: 'Liveness per service + gateway' },
  { method: 'GET', path: '/ready', auth: 'none', desc: 'Aggregate readiness (503 when degraded)' },
  { method: 'GET', path: '/metrics', auth: 'none', desc: 'Prometheus metrics (gateway)' },
  { method: 'GET', path: '/', auth: 'none', desc: 'Service index + live route table' },
];
