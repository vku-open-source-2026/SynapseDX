/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Workflow Drizzle schema — tables/indexes are versioned migrations.
 */
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const workflows = pgTable(
  'synapseone_workflows',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    nodes: jsonb('nodes').$type<any[]>().notNull().default(sql`'[]'::jsonb`),
    connections: jsonb('connections').$type<Record<string, any>>().notNull().default(sql`'{}'::jsonb`),
    settings: jsonb('settings').$type<Record<string, any>>().notNull().default(sql`'{}'::jsonb`),
    active: boolean('active').notNull().default(false),
    orgId: text('org_id'),
    accountId: text('account_id'),
    ownerSub: text('owner_sub'),
    runAs: text('run_as'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_synapseone_workflows_active').on(t.active),
    index('idx_synapseone_workflows_tenant').on(t.orgId, t.accountId),
  ],
);

export const executions = pgTable(
  'synapseone_executions',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id').notNull(),
    workflowName: text('workflow_name').notNull().default(''),
    status: text('status').notNull().default('success'),
    input: jsonb('input').$type<any>().notNull().default(sql`'{}'::jsonb`),
    output: jsonb('output').$type<any>(),
    nodeRuns: jsonb('node_runs').$type<any[]>().notNull().default(sql`'[]'::jsonb`),
    error: text('error'),
    triggeredBy: text('triggered_by').notNull().default('manual'),
    principal: jsonb('principal').$type<Record<string, any> | null>(),
    actor: text('actor'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_synapseone_exec_workflow').on(t.workflowId, t.startedAt.desc()),
    index('idx_synapseone_exec_status').on(t.status, t.startedAt.desc()),
    index('idx_synapseone_exec_time').on(t.startedAt.desc()),
    index('idx_synapseone_exec_principal_org')
      .on(sql`(${t.principal}->>'org')`)
      .where(sql`${t.principal} is not null`),
    index('idx_synapseone_exec_principal_account')
      .on(sql`(${t.principal}->>'account')`)
      .where(sql`${t.principal} is not null`),
  ],
);

export const credentials = pgTable(
  'synapseone_credentials',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    orgId: text('org_id'),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('bearer'),
    secretEnc: text('secret_enc').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('synapseone_credentials_account_id_name_key').on(t.accountId, t.name),
    index('idx_synapseone_credentials_account').on(t.accountId),
    index('idx_synapseone_credentials_org').on(t.orgId),
  ],
);
