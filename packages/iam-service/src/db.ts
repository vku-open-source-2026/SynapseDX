/*
 * Copyright 2026 OLP Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * IAM persistence layer — Postgres with in-memory fallback for dev/test.
 */
import { Pool } from 'pg';
import { randomUUID, createHash, randomBytes } from 'crypto';

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
  return createHash('sha256').update(s).digest('hex');
}

export function newApiKeyValue(prefix = 'olp'): { value: string; prefixPart: string } {
  const rand = randomBytes(24).toString('base64url');
  const value = `${prefix}_${rand}`;
  return { value, prefixPart: value.slice(0, 12) };
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

export async function createAccount(orgId: string, slug: string, display_name: string): Promise<Account> {
  if (pool) {
    const r = await pool.query('INSERT INTO accounts (org_id, slug, display_name) VALUES ($1,$2,$3) RETURNING id, org_id, slug, display_name', [orgId, slug, display_name]);
    return r.rows[0];
  }
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
  const r: Role = { id: randomUUID(), account_id: accountId, slug, description };
  mem.roles.set(r.id, r);
  return r;
}

export async function createPolicy(accountId: string, slug: string, description: string, document: PolicyDoc): Promise<Policy> {
  if (pool) {
    const r = await pool.query('INSERT INTO policies (account_id, slug, description, document) VALUES ($1,$2,$3,$4) RETURNING id, account_id, slug, description, document', [accountId, slug, description, document]);
    return r.rows[0];
  }
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

export interface ServiceAccount { id: string; account_id: string; slug: string; description?: string }

export async function createServiceAccount(accountId: string, slug: string, description = ''): Promise<ServiceAccount> {
  if (pool) {
    const r = await pool.query('INSERT INTO service_accounts (account_id, slug, description) VALUES ($1,$2,$3) RETURNING id, account_id, slug, description', [accountId, slug, description]);
    return r.rows[0];
  }
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
