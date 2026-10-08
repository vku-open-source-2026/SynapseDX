// API catalog for the in-console API docs (mirrors docs/api.md). Apache-2.0.
export const GROUPS = [
  {
    name: 'Auth',
    endpoints: [
      { method: 'POST', path: '/v1/auth/login', auth: 'none', desc: 'Dev login, cấp JWT + refresh', body: { email: 'demo@acme.local', orgSlug: 'acme' } },
      { method: 'POST', path: '/v1/auth/refresh', auth: 'none', desc: 'Xoay refresh token (single-use)', body: { refreshToken: '<rt>' } },
      { method: 'POST', path: '/v1/auth/logout', auth: 'none', desc: 'Thu hồi 1 refresh token', body: { refreshToken: '<rt>' } },
      { method: 'POST', path: '/v1/auth/logout-all', auth: 'none', desc: 'Thu hồi mọi session của chính mình', body: { refreshToken: '<rt>' } },
      { method: 'GET', path: '/v1/auth/verify', auth: 'jwt/key', desc: 'Verify Bearer hoặc X-API-Key' },
      { method: 'GET', path: '/v1/auth/me', auth: 'jwt', desc: 'User của chính Bearer token' },
      { method: 'GET', path: '/v1/auth/oidc/config', auth: 'none', desc: 'Issuer/client OIDC (Authentik/Keycloak)' },
    ],
  },
  {
    name: 'Organizations & Accounts',
    endpoints: [
      { method: 'GET', path: '/v1/orgs', auth: 'either', desc: 'Liệt kê organizations' },
      { method: 'POST', path: '/v1/orgs', auth: 'either', desc: 'Tạo org', body: { slug: 'acme-2', displayName: 'ACME 2' } },
      { method: 'GET', path: '/v1/orgs/:orgId/accounts', auth: 'either', desc: 'Accounts trong org' },
      { method: 'POST', path: '/v1/orgs/:orgId/accounts', auth: 'either', desc: 'Tạo account', body: { slug: 'prod', displayName: 'Production' } },
      { method: 'GET', path: '/v1/orgs/:orgId/users', auth: 'either', desc: 'Users trong org' },
      { method: 'POST', path: '/v1/orgs/:orgId/users', auth: 'either', desc: 'Thêm user', body: { email: 'a@acme.local' } },
    ],
  },
  {
    name: 'Roles · Policies · Authorize',
    endpoints: [
      { method: 'GET', path: '/v1/accounts/:accountId/roles', auth: 'either', desc: 'Roles trong account' },
      { method: 'POST', path: '/v1/accounts/:accountId/roles', auth: 'either', desc: 'Tạo role', body: { slug: 'runner' } },
      { method: 'DELETE', path: '/v1/roles/:roleId', auth: 'either', desc: 'Xóa role' },
      { method: 'GET', path: '/v1/accounts/:accountId/policies', auth: 'either', desc: 'Policies trong account' },
      { method: 'POST', path: '/v1/accounts/:accountId/policies', auth: 'either', desc: 'Tạo policy AWS-style', body: { slug: 'run-only', document: { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: ['workflow:Execute'], Resource: '*' }] } } },
      { method: 'DELETE', path: '/v1/policies/:policyId', auth: 'either', desc: 'Xóa policy' },
      { method: 'POST', path: '/v1/roles/:roleId/attach', auth: 'either', desc: 'Gắn policy vào role', body: { policyId: '<pid>' } },
      { method: 'POST', path: '/v1/users/:userId/assign', auth: 'either', desc: 'Gán role cho user', body: { roleId: '<rid>' } },
      { method: 'GET', path: '/v1/users/:userId/policies', auth: 'either', desc: 'Policies hiệu lực của user' },
      { method: 'POST', path: '/v1/authorize', auth: 'either', desc: 'Đánh giá Allow/Deny (+Condition)', body: { userId: '<uid>', action: 'workflow:Execute', resource: '*', context: { team: 'etl' } } },
      { method: 'POST', path: '/v1/authorize/dry-run', auth: 'either', desc: 'Simulator không cần user', body: { documents: [], action: 'workflow:Execute', resource: '*' } },
      { method: 'GET', path: '/v1/audit', auth: 'either', desc: 'Audit log (?limit=&actor=)' },
    ],
  },
  {
    name: 'API Keys & Service Accounts',
    endpoints: [
      { method: 'POST', path: '/v1/accounts/:accountId/keys', auth: 'either', desc: 'Tạo key (hiện 1 lần)', body: { name: 'demo' } },
      { method: 'POST', path: '/v1/keys/verify', auth: 'either', desc: 'Verify key', body: { apiKey: '<key>' } },
      { method: 'DELETE', path: '/v1/keys/:id', auth: 'either', desc: 'Thu hồi key' },
      { method: 'GET', path: '/v1/accounts/:accountId/service-accounts', auth: 'either', desc: 'Service accounts' },
      { method: 'POST', path: '/v1/accounts/:accountId/service-accounts', auth: 'either', desc: 'Tạo SA', body: { slug: 'etl-worker' } },
      { method: 'POST', path: '/v1/service-accounts/:id/token', auth: 'either', desc: 'Cấp JWT kind=service-account', body: {} },
    ],
  },
  {
    name: 'Workflows (n8n)',
    endpoints: [
      { method: 'GET', path: '/v1/templates', auth: 'either', desc: 'Built-in templates' },
      { method: 'GET', path: '/v1/templates/:name', auth: 'either', desc: 'Chi tiết 1 template' },
      { method: 'GET', path: '/v1/workflows', auth: 'either', desc: 'Workflows trên n8n (proxy)' },
      { method: 'POST', path: '/v1/workflows', auth: 'either', desc: 'Tạo từ template', body: { template: 'webhook-to-log', name: 'demo' } },
      { method: 'GET', path: '/v1/workflows/:id', auth: 'either', desc: 'Chi tiết workflow' },
      { method: 'POST', path: '/v1/workflows/:id/activate', auth: 'either', desc: 'Kích hoạt' },
      { method: 'POST', path: '/v1/workflows/:id/deactivate', auth: 'either', desc: 'Tắt' },
      { method: 'POST', path: '/v1/workflows/:id/execute', auth: 'either', desc: 'Execute thủ công', body: {} },
      { method: 'GET', path: '/v1/executions', auth: 'either', desc: 'Lịch sử executions' },
      { method: 'GET', path: '/v1/executions/:id', auth: 'either', desc: 'Chi tiết 1 execution' },
    ],
  },
  {
    name: 'Ops',
    endpoints: [
      { method: 'GET', path: '/health', auth: 'none', desc: 'Liveness từng service + gateway' },
      { method: 'GET', path: '/ready', auth: 'none', desc: 'Aggregate readiness (503 khi degraded)' },
      { method: 'GET', path: '/metrics', auth: 'none', desc: 'Prometheus (gateway)' },
      { method: 'GET', path: '/', auth: 'none', desc: 'Service index + bảng route live' },
    ],
  },
];
