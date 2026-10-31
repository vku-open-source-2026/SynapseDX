/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseLDS Drizzle schema — tables/indexes are versioned migrations.
 */
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const ldsDatasources = pgTable(
  'lds_datasources',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    entityType: text('entity_type').notNull(),
    license: text('license').notNull(),
    licenseUrl: text('license_url'),
    contexts: jsonb('contexts').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    defaultVisibility: text('default_visibility').notNull().default('internal'),
    description: text('description'),
    orgId: text('org_id'),
    accountId: text('account_id'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_lds_datasources_scope_slug').on(sql`coalesce(${t.orgId}, '')`, t.slug),
    index('idx_lds_datasources_tenant').on(t.orgId, t.accountId),
  ],
);

export const ldsAttributes = pgTable(
  'lds_attributes',
  {
    datasourceId: text('datasource_id').notNull().references(() => ldsDatasources.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ngsiLdType: text('ngsi_ld_type').notNull().default('Property'),
    visibility: text('visibility').notNull().default('internal'),
    description: text('description'),
    sourceField: text('source_field'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.datasourceId, t.name] })],
);

export const ldsRecords = pgTable(
  'lds_records',
  {
    datasourceId: text('datasource_id').notNull().references(() => ldsDatasources.id, { onDelete: 'cascade' }),
    entityId: text('entity_id').notNull(),
    sourceRecordId: text('source_record_id'),
    version: integer('version').notNull().default(1),
    core: jsonb('core').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    entity: jsonb('entity').$type<any>().notNull().default(sql`'{}'::jsonb`),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.datasourceId, t.entityId] }),
    index('idx_lds_records_ds').on(t.datasourceId, t.updatedAt.desc()),
  ],
);
