/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseBase Drizzle schema — the single source of truth for tables/indexes.
 */
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { BaseMapping } from './mapping';

export const baseCollections = pgTable(
  'synapsedx_base_collections',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    mapping: jsonb('mapping').$type<BaseMapping>().notNull().default(sql`'{"fields":{}}'::jsonb`),
    orgId: text('org_id'),
    accountId: text('account_id'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_base_collections_scope_name').on(
      sql`coalesce(${t.orgId}, '')`,
      sql`coalesce(${t.accountId}, '')`,
      t.name,
    ),
    index('idx_base_collections_tenant').on(t.orgId, t.accountId),
    index('idx_base_collections_org_name').on(t.orgId, t.name, t.createdAt).where(sql`${t.orgId} is not null`),
    index('idx_base_collections_account_name')
      .on(t.accountId, t.name)
      .where(sql`${t.orgId} is null and ${t.accountId} is not null`),
    index('idx_base_collections_global_name')
      .on(t.name)
      .where(sql`${t.orgId} is null and ${t.accountId} is null`),
  ],
);

export const baseDocuments = pgTable(
  'synapsedx_base_documents',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => baseCollections.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.id] }),
    index('idx_base_documents_updated').on(t.collectionId, t.updatedAt.desc()),
    index('idx_base_documents_changes').on(t.collectionId, t.updatedAt, t.id),
    // jsonb_path_ops is smaller/faster for the containment (@>) queries Base uses.
    index('idx_base_documents_data').using('gin', t.data.op('jsonb_path_ops')),
  ],
);

export const baseVectors = pgTable(
  'synapsedx_base_vectors',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => baseCollections.id, { onDelete: 'cascade' }),
    documentId: text('document_id').notNull(),
    fieldName: text('field_name').notNull(),
    embedding: text('embedding').notNull(),
    dimension: integer('dimension').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.documentId, t.fieldName] }),
    index('idx_base_vectors_lookup').on(t.collectionId, t.fieldName),
  ],
);
