/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * IAM persistence layer — Drizzle ORM on Postgres with in-memory fallback
 * (dev/test). Tables/indexes live in ./schema.ts and are applied by versioned
 * Drizzle migrations.
 */
import path from 'path';
import { Pool } from 'pg';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'crypto';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema';

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
const db: NodePgDatabase<typeof schema> | null = pool ? drizzle(pool, { schema }) : null;

let ensured = false;
export async function ensureTables(): Promise<void> {
  if (!db || ensured) return;
  ensured = true;
  try {
    const client = await pool!.connect();
    try {
      // Hold the advisory lock on the same dedicated session that runs the
      // migration (pool connections are not guaranteed to be reused).
      const migrationDb = drizzle(client, { schema });
      await migrationDb.execute(sql`select pg_advisory_lock(hashtext('synapsedx_iam_migrations'))`);
      try {
        await migrate(migrationDb, {
          migrationsFolder: path.join(__dirname, '..', 'drizzle'),
          migrationsTable: '__drizzle_migrations_iam',
        });
      } finally {
        await migrationDb.execute(sql`select pg_advisory_unlock(hashtext('synapsedx_iam_migrations'))`).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  } catch (e: any) {
    ensured = false;
    console.error('[iam][db] migrations failed:', e?.message || e);
  }
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
  usage: [] as any[], // request/feature usage events (schedule from gateway)
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

export function useDb(): boolean { return !!db; }
export function getPool(): Pool | null { return pool; }
/** Internal Drizzle handle used by the token module; callers must check useDb(). */
export function getDb(): NodePgDatabase<typeof schema> | null { return db; }

function iso(v: Date | string | null | undefined): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function orgRow(r: { id: string; slug: string; displayName: string; createdAt?: Date | null }): Organization {
  return { id: r.id, slug: r.slug, display_name: r.displayName, ...(r.createdAt ? { created_at: iso(r.createdAt) } : {}) };
}
function accountRow(r: { id: string; orgId: string; slug: string; displayName: string }): Account {
  return { id: r.id, org_id: r.orgId, slug: r.slug, display_name: r.displayName };
}
function userRow(r: { id: string; orgId: string; email: string; displayName: string | null; externalSub: string | null }): User {
  return { id: r.id, org_id: r.orgId, email: r.email, display_name: r.displayName ?? undefined, external_sub: r.externalSub ?? undefined };
}
function roleRow(r: { id: string; accountId: string; slug: string; description: string | null }): Role {
  return { id: r.id, account_id: r.accountId, slug: r.slug, description: r.description ?? '' };
}
function policyRow(r: { id: string; accountId: string; slug: string; description: string | null; document: Record<string, any> }): Policy {
  return { id: r.id, account_id: r.accountId, slug: r.slug, description: r.description ?? '', document: r.document as PolicyDoc };
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
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.organizations)
      .values({ slug, displayName: display_name })
      .returning({ id: schema.organizations.id, slug: schema.organizations.slug, displayName: schema.organizations.displayName });
    return orgRow(rows[0]);
  }
  if (mem.orgsBySlug.has(slug)) throw Object.assign(new Error('org exists'), { status: 409 });
  const o: Organization = { id: randomUUID(), slug, display_name };
  mem.orgs.set(o.id, o); mem.orgsBySlug.set(slug, o);
  return o;
}

export async function listOrganizations(): Promise<Organization[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      displayName: schema.organizations.displayName,
      createdAt: schema.organizations.createdAt,
    }).from(schema.organizations).orderBy(asc(schema.organizations.createdAt));
    return rows.map(orgRow);
  }
  return [...mem.orgs.values()];
}

export async function getOrgBySlug(slug: string): Promise<Organization | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      displayName: schema.organizations.displayName,
    }).from(schema.organizations).where(eq(schema.organizations.slug, slug)).limit(1);
    return rows[0] ? orgRow(rows[0]) : null;
  }
  return mem.orgsBySlug.get(slug) || null;
}

export async function getOrgById(id: string): Promise<Organization | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      displayName: schema.organizations.displayName,
    }).from(schema.organizations).where(eq(schema.organizations.id, id)).limit(1);
    return rows[0] ? orgRow(rows[0]) : null;
  }
  return mem.orgs.get(id) || null;
}

export async function createAccount(orgId: string, slug: string, display_name: string): Promise<Account> {
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.accounts)
      .values({ orgId, slug, displayName: display_name })
      .returning({ id: schema.accounts.id, orgId: schema.accounts.orgId, slug: schema.accounts.slug, displayName: schema.accounts.displayName });
    return accountRow(rows[0]);
  }
  const dup = [...mem.accounts.values()].find((a) => a.org_id === orgId && a.slug === slug);
  if (dup) throw Object.assign(new Error('account exists'), { status: 409 });
  const a: Account = { id: randomUUID(), org_id: orgId, slug, display_name };
  mem.accounts.set(a.id, a);
  return a;
}

export async function listAccounts(orgId: string): Promise<Account[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.accounts.id,
      orgId: schema.accounts.orgId,
      slug: schema.accounts.slug,
      displayName: schema.accounts.displayName,
    }).from(schema.accounts).where(eq(schema.accounts.orgId, orgId)).orderBy(asc(schema.accounts.slug));
    return rows.map(accountRow);
  }
  return [...mem.accounts.values()].filter((a) => a.org_id === orgId);
}

export async function upsertUser(orgId: string, email: string, displayName?: string, externalSub?: string): Promise<User> {
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.users)
      .values({ orgId, email, displayName: displayName || email, externalSub: externalSub || null })
      .onConflictDoUpdate({
        target: [schema.users.orgId, schema.users.email],
        set: { displayName: sql`excluded.display_name` },
      })
      .returning({
        id: schema.users.id,
        orgId: schema.users.orgId,
        email: schema.users.email,
        displayName: schema.users.displayName,
        externalSub: schema.users.externalSub,
      });
    return userRow(rows[0]);
  }
  const existing = [...mem.users.values()].find((u) => u.org_id === orgId && u.email === email);
  if (existing) { existing.display_name = displayName || existing.display_name; return existing; }
  const u: User = { id: randomUUID(), org_id: orgId, email, display_name: displayName, external_sub: externalSub };
  mem.users.set(u.id, u);
  return u;
}

export async function createRole(accountId: string, slug: string, description = ''): Promise<Role> {
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.roles)
      .values({ accountId, slug, description })
      .returning({
        id: schema.roles.id,
        accountId: schema.roles.accountId,
        slug: schema.roles.slug,
        description: schema.roles.description,
      });
    return roleRow(rows[0]);
  }
  const dup = [...mem.roles.values()].find((r) => r.account_id === accountId && r.slug === slug);
  if (dup) throw Object.assign(new Error('role exists'), { status: 409 });
  const r: Role = { id: randomUUID(), account_id: accountId, slug, description };
  mem.roles.set(r.id, r);
  return r;
}

export async function createPolicy(accountId: string, slug: string, description: string, document: PolicyDoc): Promise<Policy> {
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.policies)
      .values({ accountId, slug, description, document })
      .returning({
        id: schema.policies.id,
        accountId: schema.policies.accountId,
        slug: schema.policies.slug,
        description: schema.policies.description,
        document: schema.policies.document,
      });
    return policyRow(rows[0]);
  }
  const dup = [...mem.policies.values()].find((p) => p.account_id === accountId && p.slug === slug);
  if (dup) throw Object.assign(new Error('policy exists'), { status: 409 });
  const p: Policy = { id: randomUUID(), account_id: accountId, slug, description, document };
  mem.policies.set(p.id, p);
  return p;
}

export async function attachPolicy(roleId: string, policyId: string): Promise<void> {
  if (db) {
    await ensureTables();
    await db.insert(schema.rolePolicies).values({ roleId, policyId }).onConflictDoNothing();
    return;
  }
  if (!mem.rolePolicies.has(roleId)) mem.rolePolicies.set(roleId, new Set());
  mem.rolePolicies.get(roleId)!.add(policyId);
}

export async function assignRole(userId: string, roleId: string): Promise<void> {
  if (db) {
    await ensureTables();
    await db.insert(schema.userRoles).values({ userId, roleId }).onConflictDoNothing();
    return;
  }
  if (!mem.userRoles.has(userId)) mem.userRoles.set(userId, new Set());
  mem.userRoles.get(userId)!.add(roleId);
}

/** Idempotent removals (true when a row existed). */
export async function detachPolicy(roleId: string, policyId: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(schema.rolePolicies).where(and(
      eq(schema.rolePolicies.roleId, roleId),
      eq(schema.rolePolicies.policyId, policyId),
    )).returning({ policyId: schema.rolePolicies.policyId });
    return rows.length > 0;
  }
  const set = mem.rolePolicies.get(roleId);
  if (!set) return false;
  return set.delete(policyId);
}

export async function unassignRole(userId: string, roleId: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(schema.userRoles).where(and(
      eq(schema.userRoles.userId, userId),
      eq(schema.userRoles.roleId, roleId),
    )).returning({ roleId: schema.userRoles.roleId });
    return rows.length > 0;
  }
  const set = mem.userRoles.get(userId);
  if (!set) return false;
  return set.delete(roleId);
}

export async function policiesForUser(userId: string): Promise<PolicyDoc[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({ document: schema.policies.document })
      .from(schema.policies)
      .innerJoin(schema.rolePolicies, eq(schema.rolePolicies.policyId, schema.policies.id))
      .innerJoin(schema.userRoles, eq(schema.userRoles.roleId, schema.rolePolicies.roleId))
      .where(eq(schema.userRoles.userId, userId));
    return rows.map((x) => x.document as PolicyDoc);
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
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.roles.id,
      accountId: schema.roles.accountId,
      slug: schema.roles.slug,
      description: schema.roles.description,
    }).from(schema.roles).where(eq(schema.roles.accountId, accountId)).orderBy(asc(schema.roles.slug));
    return rows.map(roleRow);
  }
  return [...mem.roles.values()].filter((r) => r.account_id === accountId);
}

export async function listPolicies(accountId: string): Promise<Policy[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.policies.id,
      accountId: schema.policies.accountId,
      slug: schema.policies.slug,
      description: schema.policies.description,
      document: schema.policies.document,
    }).from(schema.policies).where(eq(schema.policies.accountId, accountId)).orderBy(asc(schema.policies.slug));
    return rows.map(policyRow);
  }
  return [...mem.policies.values()].filter((p) => p.account_id === accountId);
}

export async function listUsers(orgId: string): Promise<User[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.users.id,
      orgId: schema.users.orgId,
      email: schema.users.email,
      displayName: schema.users.displayName,
      externalSub: schema.users.externalSub,
    }).from(schema.users).where(eq(schema.users.orgId, orgId)).orderBy(asc(schema.users.email));
    return rows.map(userRow);
  }
  return [...mem.users.values()].filter((u) => u.org_id === orgId);
}

export async function getUserById(id: string): Promise<User | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.users.id,
      orgId: schema.users.orgId,
      email: schema.users.email,
      displayName: schema.users.displayName,
      externalSub: schema.users.externalSub,
    }).from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return rows[0] ? userRow(rows[0]) : null;
  }
  return mem.users.get(id) || null;
}

/** Membership check by (org, email) — used by the OIDC callback before letting
 *  an IdP identity join an EXISTING org (no auto-join across tenants, #9). */
export async function findUserByOrgEmail(orgId: string, email: string): Promise<User | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.users.id,
      orgId: schema.users.orgId,
      email: schema.users.email,
      displayName: schema.users.displayName,
      externalSub: schema.users.externalSub,
    }).from(schema.users).where(and(
      eq(schema.users.orgId, orgId),
      eq(schema.users.email, email),
    )).limit(1);
    return rows[0] ? userRow(rows[0]) : null;
  }
  return [...mem.users.values()].find((u) => u.org_id === orgId && u.email === email) || null;
}

/** Existence checks for FK-safe attach/assign (404 thay vì 500 khi id lạ). */
export async function roleExists(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.id, id)).limit(1);
    return rows.length > 0;
  }
  return mem.roles.has(id);
}

export async function policyExists(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.select({ id: schema.policies.id }).from(schema.policies).where(eq(schema.policies.id, id)).limit(1);
    return rows.length > 0;
  }
  return mem.policies.has(id);
}

/** Policies attached to a role / roles assigned to a user (for management UI). */
export async function policiesForRole(roleId: string): Promise<Policy[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.policies.id,
      accountId: schema.policies.accountId,
      slug: schema.policies.slug,
      description: schema.policies.description,
      document: schema.policies.document,
    }).from(schema.policies)
      .innerJoin(schema.rolePolicies, eq(schema.rolePolicies.policyId, schema.policies.id))
      .where(eq(schema.rolePolicies.roleId, roleId))
      .orderBy(asc(schema.policies.slug));
    return rows.map(policyRow);
  }
  const out: Policy[] = [];
  for (const pid of mem.rolePolicies.get(roleId) || []) {
    const p = mem.policies.get(pid);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function rolesForUser(userId: string): Promise<Role[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.roles.id,
      accountId: schema.roles.accountId,
      slug: schema.roles.slug,
      description: schema.roles.description,
    }).from(schema.roles)
      .innerJoin(schema.userRoles, eq(schema.userRoles.roleId, schema.roles.id))
      .where(eq(schema.userRoles.userId, userId))
      .orderBy(asc(schema.roles.slug));
    return rows.map(roleRow);
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
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.roles.id,
      accountId: schema.roles.accountId,
      slug: schema.roles.slug,
      description: schema.roles.description,
    }).from(schema.roles).where(eq(schema.roles.id, id)).limit(1);
    return rows[0] ? roleRow(rows[0]) : null;
  }
  return mem.roles.get(id) || null;
}

export async function getPolicyById(id: string): Promise<Policy | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.policies.id,
      accountId: schema.policies.accountId,
      slug: schema.policies.slug,
      description: schema.policies.description,
      document: schema.policies.document,
    }).from(schema.policies).where(eq(schema.policies.id, id)).limit(1);
    return rows[0] ? policyRow(rows[0]) : null;
  }
  return mem.policies.get(id) || null;
}

export async function getAccountById(id: string): Promise<Account | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.accounts.id,
      orgId: schema.accounts.orgId,
      slug: schema.accounts.slug,
      displayName: schema.accounts.displayName,
    }).from(schema.accounts).where(eq(schema.accounts.id, id)).limit(1);
    return rows[0] ? accountRow(rows[0]) : null;
  }
  return mem.accounts.get(id) || null;
}

/** Account ids where the user holds at least one role (tenant membership). */
export async function accountsForUser(userId: string): Promise<string[]> {
  if (db) {
    await ensureTables();
    const rows = await db.selectDistinct({ accountId: schema.roles.accountId })
      .from(schema.roles)
      .innerJoin(schema.userRoles, eq(schema.userRoles.roleId, schema.roles.id))
      .where(eq(schema.userRoles.userId, userId));
    return rows.map((x) => x.accountId);
  }
  const out = new Set<string>();
  for (const rid of mem.userRoles.get(userId) || []) {
    const role = mem.roles.get(rid);
    if (role) out.add(role.account_id);
  }
  return [...out];
}

export async function deleteRole(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(schema.roles).where(eq(schema.roles.id, id)).returning({ id: schema.roles.id });
    return rows.length > 0;
  }
  return mem.roles.delete(id);
}

export async function deletePolicy(id: string): Promise<boolean> {
  if (db) {
    await ensureTables();
    const rows = await db.delete(schema.policies).where(eq(schema.policies.id, id)).returning({ id: schema.policies.id });
    return rows.length > 0;
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

export async function logAudit(e: AuditEntry): Promise<void> {
  if (db) {
    await ensureTables();
    await db.insert(schema.auditLog).values({
      actorType: e.actor_type,
      actorId: e.actor_id,
      action: e.action,
      resource: e.resource || '',
      decision: !!e.decision,
      context: e.context || {},
    });
    return;
  }
  if (!(__mem as any).audit) (__mem as any).audit = [];
  ((__mem as any).audit as any[]).push({ id: randomUUID(), created_at: new Date().toISOString(), ...e });
  if (((__mem as any).audit as any[]).length > 1000) ((__mem as any).audit as any[]).splice(0, 100);
}

export async function listAudit(limit = 50, actorId?: string, allowed?: boolean, orgId?: string): Promise<any[]> {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const dec = allowed === undefined ? undefined : !!allowed;
  if (db) {
    await ensureTables();
    const conds = [];
    if (actorId) conds.push(eq(schema.auditLog.actorId, actorId));
    if (dec !== undefined) conds.push(eq(schema.auditLog.decision, dec));
    if (orgId) {
      // Tenant scoping (#7): rows belong to the org they targeted
      // (context.org) or to the org of the caller who triggered them
      // (context.callerOrg, e.g. dry-run rows).
      conds.push(sql`(${schema.auditLog.context}->>'org' = ${orgId} OR ${schema.auditLog.context}->>'callerOrg' = ${orgId})`);
    }
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select({
      id: schema.auditLog.id,
      createdAt: schema.auditLog.createdAt,
      actorType: schema.auditLog.actorType,
      actorId: schema.auditLog.actorId,
      action: schema.auditLog.action,
      resource: schema.auditLog.resource,
      decision: schema.auditLog.decision,
      context: schema.auditLog.context,
    }).from(schema.auditLog).where(where).orderBy(desc(schema.auditLog.createdAt)).limit(lim);
    return rows.map((r) => ({
      id: r.id,
      created_at: iso(r.createdAt),
      actor_type: r.actorType,
      actor_id: r.actorId,
      action: r.action,
      resource: r.resource,
      decision: r.decision,
      context: r.context,
    }));
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
  const cutoff = new Date(Date.now() - olderThanDays * 86400000);
  const lim = Math.min(Math.max(Math.floor(batch) || 1000, 1), 10000);
  if (db) {
    await ensureTables();
    // Postgres has no DELETE..LIMIT: batch via id sub-select.
    const ids = await db.select({ id: schema.auditLog.id }).from(schema.auditLog)
      .where(lt(schema.auditLog.createdAt, cutoff))
      .limit(lim);
    if (ids.length === 0) return 0;
    const rows = await db.delete(schema.auditLog)
      .where(inArray(schema.auditLog.id, ids.map((x) => x.id)))
      .returning({ id: schema.auditLog.id });
    return rows.length;
  }
  const arr: any[] = ((__mem as any).audit as any[]) || [];
  const kept = arr.filter((a) => String(a.created_at || '') >= cutoff.toISOString()).slice(-10000);
  const removed = arr.length - kept.length;
  (__mem as any).audit = kept;
  return removed;
}

export interface ServiceAccount { id: string; account_id: string; slug: string; description?: string }

export async function createServiceAccount(accountId: string, slug: string, description = ''): Promise<ServiceAccount> {
  if (db) {
    await ensureTables();
    const rows = await db.insert(schema.serviceAccounts)
      .values({ accountId, slug, description })
      .returning({
        id: schema.serviceAccounts.id,
        accountId: schema.serviceAccounts.accountId,
        slug: schema.serviceAccounts.slug,
        description: schema.serviceAccounts.description,
      });
    return { id: rows[0].id, account_id: rows[0].accountId, slug: rows[0].slug, description: rows[0].description ?? '' };
  }
  const dup = [...__mem.serviceAccounts.values()].find((s: any) => s.account_id === accountId && s.slug === slug);
  if (dup) throw Object.assign(new Error('service account exists'), { status: 409 });
  const sa: ServiceAccount = { id: randomUUID(), account_id: accountId, slug, description };
  __mem.serviceAccounts.set(sa.id, sa);
  return sa;
}

export async function listServiceAccounts(accountId: string): Promise<ServiceAccount[]> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.serviceAccounts.id,
      accountId: schema.serviceAccounts.accountId,
      slug: schema.serviceAccounts.slug,
      description: schema.serviceAccounts.description,
    }).from(schema.serviceAccounts).where(eq(schema.serviceAccounts.accountId, accountId)).orderBy(asc(schema.serviceAccounts.slug));
    return rows.map((r) => ({ id: r.id, account_id: r.accountId, slug: r.slug, description: r.description ?? '' }));
  }
  return [...__mem.serviceAccounts.values()].filter((s: any) => s.account_id === accountId);
}

export async function getServiceAccount(id: string): Promise<ServiceAccount | null> {
  if (db) {
    await ensureTables();
    const rows = await db.select({
      id: schema.serviceAccounts.id,
      accountId: schema.serviceAccounts.accountId,
      slug: schema.serviceAccounts.slug,
      description: schema.serviceAccounts.description,
    }).from(schema.serviceAccounts).where(eq(schema.serviceAccounts.id, id)).limit(1);
    return rows[0]
      ? { id: rows[0].id, account_id: rows[0].accountId, slug: rows[0].slug, description: rows[0].description ?? '' }
      : null;
  }
  return (__mem.serviceAccounts.get(id) as ServiceAccount) || null;
}

export const __mem = mem;
