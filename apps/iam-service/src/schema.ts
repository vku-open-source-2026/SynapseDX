/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * IAM Drizzle schema — tables/indexes are versioned migrations.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('organizations_slug_key').on(t.slug)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_org_id_slug_key').on(t.orgId, t.slug),
    index('idx_accounts_org').on(t.orgId),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    externalSub: text('external_sub'),
    email: text('email').notNull(),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_org_id_email_key').on(t.orgId, t.email),
    uniqueIndex('idx_users_external_sub').on(t.externalSub).where(sql`${t.externalSub} is not null`),
    uniqueIndex('idx_users_org_email_lower').on(t.orgId, sql`lower(${t.email})`),
    index('idx_users_org').on(t.orgId),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    description: text('description').default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('roles_account_id_slug_key').on(t.accountId, t.slug),
    index('idx_roles_account').on(t.accountId),
  ],
);

export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    description: text('description').default(''),
    document: jsonb('document').$type<Record<string, any>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('policies_account_id_slug_key').on(t.accountId, t.slug),
    index('idx_policies_account').on(t.accountId),
  ],
);

export const rolePolicies = pgTable(
  'role_policies',
  {
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
    policyId: uuid('policy_id').notNull().references(() => policies.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.policyId] })],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    name: text('name').notNull().default(''),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_key_hash_key').on(t.keyHash),
    index('idx_api_keys_prefix').on(t.keyPrefix),
    index('idx_api_keys_expiry').on(t.expiresAt).where(sql`${t.revokedAt} is null`),
    index('idx_api_keys_account').on(t.accountId),
  ],
);

export const serviceAccounts = pgTable(
  'service_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    description: text('description').default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('service_accounts_account_id_slug_key').on(t.accountId, t.slug),
    index('idx_service_accounts_account').on(t.accountId),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_token_hash_key').on(t.tokenHash),
    index('idx_refresh_expiry').on(t.expiresAt).where(sql`${t.revokedAt} is null`),
    index('idx_refresh_tokens_user').on(t.userId),
  ],
);

/** Legacy workflow metadata table (kept for backward compatibility). */
export const legacyWorkflows = pgTable(
  'workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    definition: jsonb('definition').$type<Record<string, any>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('workflows_account_id_slug_key').on(t.accountId, t.slug),
    index('idx_workflows_account').on(t.accountId),
  ],
);

/** Request/feature usage events written by the gateway (batched, best-effort).
 *  Rows are tenant-scoped by org_id; account/user ids are optional because
 *  API-key and anonymous traffic has no user principal. */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    requestId: text('request_id').notNull().default(''),
    feature: text('feature').notNull(),
    route: text('route').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull().default(''),
    status: integer('status').notNull(),
    durationMs: integer('duration_ms').notNull(),
    authKind: text('auth_kind').notNull().default('unknown'),
    orgId: uuid('org_id'),
    accountId: uuid('account_id'),
    userId: uuid('user_id'),
    error: text('error'),
  },
  (t) => [
    index('idx_usage_time').on(t.createdAt.desc()),
    index('idx_usage_org_time').on(t.orgId, t.createdAt.desc()),
    index('idx_usage_feature_time').on(t.feature, t.createdAt.desc()),
    index('idx_usage_status').on(t.status),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type').notNull().default('user'),
    actorId: text('actor_id').notNull().default(''),
    action: text('action').notNull(),
    resource: text('resource').notNull().default(''),
    decision: boolean('decision').notNull(),
    context: jsonb('context').$type<Record<string, any>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    index('idx_audit_actor').on(t.actorId, t.createdAt.desc()),
    index('idx_audit_time').on(t.createdAt.desc()),
    index('idx_audit_action').on(t.action, t.decision),
  ],
);
