/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * IAM persistence layer — Postgres with in-memory fallback for dev/test.
 */
import { Pool } from 'pg';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'crypto';

export interface Organization { id: string; slug: string; display_name: string; created_at?: string }
export interface Account { id: string; org_id: string; slug: string; display_name: string }
export interface User { id: string; org_id: string; email: string; display_name?: string; external_sub?: string }
export interface Role { id: string; account_id: string; slug: string; description?: string }
export interface PolicyDoc { Version?: string; Statement: Array<{ Effect: 'Allow'|'Deny'; Action: string|string[]; Resource: string|string[]; Condition?: any }> }
export interface Policy { id: string; account_id: string; slug: string; description?: string; document: PolicyDoc }

const DATABASE_URL = process.env.DATABASE_URL || '';

let pool: Pool | null = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL });
  pool.on('error', (e) => console.error('[iam][db] pool error', e.message));
}

// ---- in-memory fallback ----
const mem = {
  orgs: new Map<string, Organization>(),
  orgsBySlug: new Map<string, Organization>(),
  accounts: new Map<string, Account>(),
  users: new Map<string, User>(),
  roles: new Map<string, Role>(),
  policies: new Map<string, Policy>(),
  rolePolicies: new Map<string, Set<string>>(), // roleId -> policyIds
  userRoles: new Map<string, Set<string>>(), // userId -> roleIds
  apiKeys: new Map<string, any>(), // hash -> record
  refresh: new Map<string, any>(),
  serviceAccounts: new Map<string, any>(),
};

function seedMem() {
  if (mem.orgsBySlug.has('acme')) return;
  const org: Organization = { id: randomUUID(), slug: 'acme', display_name: 'ACME Demo Organization' };
  mem.orgs.set(org.id, org); mem.orgsBySlug.set(org.slug, org);
  const acc: Account = { id: randomUUID(), org_id: org.id, slug: 'prod', display_name: 'Production' };
  mem.accounts.set(acc.id, acc);
  const adminRole: Role = { id: randomUUID(), account_id: acc.id, slug: 'admin', description: 'Full access' };
  mem.roles.set(adminRole.id, adminRole);
  const adminPolicy: Policy = {
    id: randomUUID(), account_id: acc.id, slug: 'admin-full',
    description: 'Allow all',
    document: { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] },
  };
  mem.policies.set(adminPolicy.id, adminPolicy);
  mem.rolePolicies.set(adminRole.id, new Set([adminPolicy.id]));
}
seedMem();

export function useDb(): boolean { return !!pool; }
export function getPool(): Pool | null { return pool; }

export async function query<T extends import('pg').QueryResultRow = any>(text: string, params?: any[]): Promise<{ rows: T[] }> {
  if (!pool) throw new Error('no pg pool');
  const r = await pool.query<T>(text, params);
  return { rows: r.rows };
}

export function hashSecret(s: string): string {
  const pepper = process.env.IAM_API_KEY_PEPPER || '';
  if (pepper) return createHmac('sha256', pepper).update(s).digest('hex');
  if (!hashSecret.warned) {
    hashSecret.warned = true;
    console.warn('[iam][security] IAM_API_KEY_PEPPER not set — API keys hashed with plain SHA-256 (dev default). Set a pepper in production.');
  }
  return createHash('sha256').update(s).digest('hex');
}
hashSecret.warned = false as boolean;

/** Legacy plain-SHA-256 hash (for verifying keys created before a pepper was set). */
export function hashSecretLegacy(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Candidate hashes to try on verify: peppered first, then legacy (rotation-safe). */
export function hashCandidates(s: string): string[] {
  const pepper = process.env.IAM_API_KEY_PEPPER || '';
  if (pepper) return [hashSecret(s), hashSecretLegacy(s)];
  return [hashSecretLegacy(s)];
}

/** Constant-time string compare (hash-then-compare to hide length via timing). */
export function secretsEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ---------- high-level CRUD that works on both pg + memory ----------

export async function createOrganization(slug: string, display_name: string): Promise<Organization> {
  if (pool) {
    const r = await pool.query('INSERT INTO organizations (slug, display_name) VALUES ($1,$2) RETURNING id, slug, display_name', [slug, display_name]);
    return r.rows[0];
  }
  if (mem.orgsBySlug.has(slug)) throw Object.assign(new Error('org exists'), { status: 409 });
  const o: Organization = { id: randomUUID(), slug, display_name };
  mem.orgs.set(o.id, o); mem.orgsBySlug.set(slug, o);
  return o;
}

export async function listOrganizations(): Promise<Organization[]> {
  if (pool) {
    const r = await pool.query('SELECT id, slug, display_name, created_at FROM organizations ORDER BY created_at');
    return r.rows;
  }
  return [...mem.orgs.values()];
}

export async function getOrgBySlug(slug: string): Promise<Organization | null> {
  if (pool) {
    const r = await pool.query('SELECT id, slug, display_name FROM organizations WHERE slug=$1', [slug]);
    return r.rows[0] || null;
  }
  return mem.orgsBySlug.get(slug) || null;
}

export async function getOrgById(id: string): Promise<Organization | null> {
  if (pool) {
    const r = await pool.query('SELECT id, slug, display_name FROM organizations WHERE id=$1', [id]);
    return r.rows[0] || null;
  }
  return mem.orgs.get(id) || null;
}

export async function createAccount(orgId: string, slug: string, display_name: string): Promise<Account> {
  if (pool) {
    const r = await pool.query('INSERT INTO accounts (org_id, slug, display_name) VALUES ($1,$2,$3) RETURNING id, org_id, slug, display_name', [orgId, slug, display_name]);
    return r.rows[0];
  }
  const dup = [...mem.accounts.values()].find((a) => a.org_id === orgId && a.slug === slug);
  if (dup) throw Object.assign(new Error('account exists'), { status: 409 });
  const a: Account = { id: randomUUID(), org_id: orgId, slug, display_name };
  mem.accounts.set(a.id, a);
  return a;
}

export async function listAccounts(orgId: string): Promise<Account[]> {
  if (pool) {
    const r = await pool.query('SELECT id, org_id, slug, display_name FROM accounts WHERE org_id=$1 ORDER BY slug', [orgId]);
    return r.rows;
  }
  return [...mem.accounts.values()].filter((a) => a.org_id === orgId);
}

export async function upsertUser(orgId: string, email: string, displayName?: string, externalSub?: string): Promise<User> {
  if (pool) {
    const r = await pool.query(
      `INSERT INTO users (org_id, email, display_name, external_sub) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, email) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id, org_id, email, display_name, external_sub`,
      [orgId, email, displayName || email, externalSub || null],
    );
    return r.rows[0];
  }
  const existing = [...mem.users.values()].find((u) => u.org_id === orgId && u.email === email);
  if (existing) { existing.display_name = displayName || existing.display_name; return existing; }
  const u: User = { id: randomUUID(), org_id: orgId, email, display_name: displayName, external_sub: externalSub };
  mem.users.set(u.id, u);
  return u;
}

export async function createRole(accountId: string, slug: string, description = ''): Promise<Role> {
  if (pool) {
    const r = await pool.query('INSERT INTO roles (account_id, slug, description) VALUES ($1,$2,$3) RETURNING id, account_id, slug, description', [accountId, slug, description]);
    return r.rows[0];
  }
  const dup = [...mem.roles.values()].find((r) => r.account_id === accountId && r.slug === slug);
  if (dup) throw Object.assign(new Error('role exists'), { status: 409 });
  const r: Role = { id: randomUUID(), account_id: accountId, slug, description };
  mem.roles.set(r.id, r);
  return r;
}

export async function createPolicy(accountId: string, slug: string, description: string, document: PolicyDoc): Promise<Policy> {
  if (pool) {
    const r = await pool.query('INSERT INTO policies (account_id, slug, description, document) VALUES ($1,$2,$3,$4) RETURNING id, account_id, slug, description, document', [accountId, slug, description, document]);
    return r.rows[0];
  }
  const dup = [...mem.policies.values()].find((p) => p.account_id === accountId && p.slug === slug);
  if (dup) throw Object.assign(new Error('policy exists'), { status: 409 });
  const p: Policy = { id: randomUUID(), account_id: accountId, slug, description, document };
  mem.policies.set(p.id, p);
  return p;
}

export async function attachPolicy(roleId: string, policyId: string): Promise<void> {
  if (pool) {
    await pool.query('INSERT INTO role_policies (role_id, policy_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [roleId, policyId]);
    return;
  }
  if (!mem.rolePolicies.has(roleId)) mem.rolePolicies.set(roleId, new Set());
  mem.rolePolicies.get(roleId)!.add(policyId);
}

export async function assignRole(userId: string, roleId: string): Promise<void> {
  if (pool) {
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, roleId]);
    return;
  }
  if (!mem.userRoles.has(userId)) mem.userRoles.set(userId, new Set());
  mem.userRoles.get(userId)!.add(roleId);
}

/** Idempotent removals (true when a row existed). */
export async function detachPolicy(roleId: string, policyId: string): Promise<boolean> {
  if (pool) {
    const r = await pool.query('DELETE FROM role_policies WHERE role_id=$1 AND policy_id=$2', [roleId, policyId]);
    return (r.rowCount || 0) > 0;
  }
  const set = mem.rolePolicies.get(roleId);
  if (!set) return false;
  return set.delete(policyId);
}

export async function unassignRole(userId: string, roleId: string): Promise<boolean> {
  if (pool) {
    const r = await pool.query('DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2', [userId, roleId]);
    return (r.rowCount || 0) > 0;
  }
  const set = mem.userRoles.get(userId);
  if (!set) return false;
  return set.delete(roleId);
}

export async function policiesForUser(userId: string): Promise<PolicyDoc[]> {
  if (pool) {
    const r = await pool.query(
      `SELECT p.document FROM policies p
       JOIN role_policies rp ON rp.policy_id = p.id
       JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = $1`, [userId]);
    return r.rows.map((x) => x.document);
  }
  const roleIds = mem.userRoles.get(userId) || new Set();
  const docs: PolicyDoc[] = [];
  for (const rid of roleIds) {
    const pids = mem.rolePolicies.get(rid) || new Set();
    for (const pid of pids) {
      const p = mem.policies.get(pid);
      if (p) docs.push(p.document);
    }
  }
  return docs;
}

export async function listRoles(accountId: string): Promise<Role[]> {
  if (pool) {
    const r = await pool.query('SELECT id, account_id, slug, description FROM roles WHERE account_id=$1 ORDER BY slug', [accountId]);
    return r.rows;
  }
  return [...mem.roles.values()].filter((r) => r.account_id === accountId);
}

export async function listPolicies(accountId: string): Promise<Policy[]> {
  if (pool) {
    const r = await pool.query('SELECT id, account_id, slug, description, document FROM policies WHERE account_id=$1 ORDER BY slug', [accountId]);
    return r.rows;
  }
  return [...mem.policies.values()].filter((p) => p.account_id === accountId);
}

export async function listUsers(orgId: string): Promise<User[]> {
  if (pool) {
    const r = await pool.query('SELECT id, org_id, email, display_name, external_sub FROM users WHERE org_id=$1 ORDER BY email', [orgId]);
    return r.rows;
  }
  return [...mem.users.values()].filter((u) => u.org_id === orgId);
}

export async function getUserById(id: string): Promise<User | null> {
  if (pool) {
    const r = await pool.query('SELECT id, org_id, email, display_name, external_sub FROM users WHERE id=$1', [id]);
    return r.rows[0] || null;
  }
  return mem.users.get(id) || null;
}

/** Membership check by (org, email) — used by the OIDC callback before letting
 *  an IdP identity join an EXISTING org (no auto-join across tenants, #9). */
export async function findUserByOrgEmail(orgId: string, email: string): Promise<User | null> {
  if (pool) {
    const r = await pool.query(
      'SELECT id, org_id, email, display_name, external_sub FROM users WHERE org_id=$1 AND email=$2',
      [orgId, email],
    );
    return r.rows[0] || null;
  }
  return [...mem.users.values()].find((u) => u.org_id === orgId && u.email === email) || null;
}

/** Existence checks for FK-safe attach/assign (404 thay vì 500 khi id lạ). */
export async function roleExists(id: string): Promise<boolean> {
  if (pool) {
    const r = await pool.query('SELECT 1 FROM roles WHERE id=$1', [id]);
    return r.rows.length > 0;
  }
  return mem.roles.has(id);
}

export async function policyExists(id: string): Promise<boolean> {
  if (pool) {
    const r = await pool.query('SELECT 1 FROM policies WHERE id=$1', [id]);
    return r.rows.length > 0;
  }
  return mem.policies.has(id);
}

/** Policies attached to a role / roles assigned to a user (for management UI). */
export async function policiesForRole(roleId: string): Promise<Policy[]> {
  if (pool) {
    const r = await pool.query(
      'SELECT p.id, p.account_id, p.slug, p.description, p.document FROM policies p JOIN role_policies rp ON rp.policy_id = p.id WHERE rp.role_id = $1 ORDER BY p.slug',
      [roleId],
    );
    return r.rows;
  }
  const out: Policy[] = [];
  for (const pid of mem.rolePolicies.get(roleId) || []) {
    const p = mem.policies.get(pid);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function rolesForUser(userId: string): Promise<Role[]> {
  if (pool) {
    const r = await pool.query(
      'SELECT r.id, r.account_id, r.slug, r.description FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1 ORDER BY r.slug',
      [userId],
    );
    return r.rows;
  }
  const out: Role[] = [];
  for (const rid of mem.userRoles.get(userId) || []) {
    const role = mem.roles.get(rid);
    if (role) out.push(role);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Full-row lookups for cross-tenant scoping (attach/assign/mint). */
export async function getRoleById(id: string): Promise<Role | null> {
  if (pool) {
    const r = await pool.query('SELECT id, account_id, slug, description FROM roles WHERE id=$1', [id]);
    return r.rows[0] || null;
  }
  return mem.roles.get(id) || null;
}

export async function getPolicyById(id: string): Promise<Policy | null> {
  if (pool) {
    const r = await pool.query('SELECT id, account_id, slug, description, document FROM policies WHERE id=$1', [id]);
    return r.rows[0] || null;
  }
  return mem.policies.get(id) || null;
}

export async function getAccountById(id: string): Promise<Account | null> {
  if (pool) {
    const r = await pool.query('SELECT id, org_id, slug, display_name FROM accounts WHERE id=$1', [id]);
    return r.rows[0] || null;
  }
  return mem.accounts.get(id) || null;
}

/** Account ids where the user holds at least one role (tenant membership). */
export async function accountsForUser(userId: string): Promise<string[]> {
  if (pool) {
    const r = await pool.query(
      'SELECT DISTINCT r.account_id FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1',
      [userId],
    );
    return r.rows.map((x) => x.account_id);
  }
  const out = new Set<string>();
  for (const rid of mem.userRoles.get(userId) || []) {
    const role = mem.roles.get(rid);
    if (role) out.add(role.account_id);
  }
  return [...out];
}

export async function deleteRole(id: string): Promise<boolean> {
  if (pool) {
    const r = await pool.query('DELETE FROM roles WHERE id=$1', [id]);
    return (r.rowCount || 0) > 0;
  }
  return mem.roles.delete(id);
}

export async function deletePolicy(id: string): Promise<boolean> {
  if (pool) {
    const r = await pool.query('DELETE FROM policies WHERE id=$1', [id]);
    return (r.rowCount || 0) > 0;
  }
  return mem.policies.delete(id);
}

export interface AuditEntry {
  id?: string;
  actor_type: string;
  actor_id: string;
  action: string;
  resource: string;
  decision: boolean;
  context?: any;
}

export async function logAudit(e: AuditEntry): Promise<void> {  if (pool) {
    await pool.query(
      'INSERT INTO audit_log (actor_type, actor_id, action, resource, decision, context) VALUES ($1,$2,$3,$4,$5,$6)',
      [e.actor_type, e.actor_id, e.action, e.resource || '', !!e.decision, e.context || {}],
    );
    return;
  }
  if (!(__mem as any).audit) (__mem as any).audit = [];
  ((__mem as any).audit as any[]).push({ id: randomUUID(), created_at: new Date().toISOString(), ...e });
  if (((__mem as any).audit as any[]).length > 1000) ((__mem as any).audit as any[]).splice(0, 100);
}

export async function listAudit(limit = 50, actorId?: string, allowed?: boolean, orgId?: string): Promise<any[]> {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const dec = allowed === undefined ? undefined : !!allowed;
  if (pool) {
    const conds: string[] = [];
    const params: any[] = [];
    if (actorId) {
      params.push(actorId);
      conds.push(`actor_id=$${params.length}`);
    }
    if (dec !== undefined) {
      params.push(dec);
      conds.push(`decision=$${params.length}`);
    }
    if (orgId) {
      // Tenant scoping (#7): rows belong to the org they targeted
      // (context.org) or to the org of the caller who triggered them
      // (context.callerOrg, e.g. dry-run rows).
      params.push(orgId);
      conds.push(`(context->>'org'=$${params.length} OR context->>'callerOrg'=$${params.length})`);
    }
    params.push(lim);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT id, created_at, actor_type, actor_id, action, resource, decision, context FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  }
  const all: any[] = (((__mem as any).audit as any[]) || []).slice().reverse();
  const filtered = all.filter(
    (a) => (!actorId || a.actor_id === actorId)
      && (dec === undefined || !!a.decision === dec)
      && (!orgId || a.context?.org === orgId || a.context?.callerOrg === orgId),
  );
  return filtered.slice(0, lim);
}

/** Retention purge: delete audit rows older than `olderThanDays` (batched).
 *  Non-positive input is a no-op (retention disabled by default). */
export async function purgeAudit(olderThanDays: number, batch = 1000): Promise<number> {
  if (!(olderThanDays > 0) || !Number.isFinite(olderThanDays)) return 0;
  const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
  const lim = Math.min(Math.max(Math.floor(batch) || 1000, 1), 10000);
  if (pool) {
    // Postgres has no DELETE..LIMIT: batch via id sub-select.
    const r = await pool.query(
      'DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at < $1 LIMIT $2)',
      [cutoff, lim],
    );
    return r.rowCount || 0;
  }
  const arr: any[] = ((__mem as any).audit as any[]) || [];
  const kept = arr.filter((a) => String(a.created_at || '') >= cutoff).slice(-10000);
  const removed = arr.length - kept.length;
  (__mem as any).audit = kept;
  return removed;
}

export interface ServiceAccount { id: string; account_id: string; slug: string; description?: string }

export async function createServiceAccount(accountId: string, slug: string, description = ''): Promise<ServiceAccount> {
  if (pool) {
    const r = await pool.query('INSERT INTO service_accounts (account_id, slug, description) VALUES ($1,$2,$3) RETURNING id, account_id, slug, description', [accountId, slug, description]);
    return r.rows[0];
  }
  const dup = [...__mem.serviceAccounts.values()].find((s: any) => s.account_id === accountId && s.slug === slug);
  if (dup) throw Object.assign(new Error('service account exists'), { status: 409 });
  const sa: ServiceAccount = { id: randomUUID(), account_id: accountId, slug, description };
  __mem.serviceAccounts.set(sa.id, sa);
  return sa;
}

export async function listServiceAccounts(accountId: string): Promise<ServiceAccount[]> {
  if (pool) {
    const r = await pool.query('SELECT id, account_id, slug, description FROM service_accounts WHERE account_id=$1 ORDER BY slug', [accountId]);
    return r.rows;
  }
  return [...__mem.serviceAccounts.values()].filter((s: any) => s.account_id === accountId);
}

export async function getServiceAccount(id: string): Promise<ServiceAccount | null> {
  if (pool) {
    const r = await pool.query('SELECT id, account_id, slug, description FROM service_accounts WHERE id=$1', [id]);
    return r.rows[0] || null;
  }
  return (__mem.serviceAccounts.get(id) as ServiceAccount) || null;
}

export const __mem = mem;
