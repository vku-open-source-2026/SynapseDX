// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Shared helpers for Tier-2 business modules (H/P/D/I). */
import { randomUUID } from 'crypto';
import { SynapseOneClient, SynapseOneError } from '@synapseone/sdk';
import { CallerPrincipal, isAdmin } from '../auth';
import { apiError } from '../errors';
import {
  getDocumentOrNull, queryDocuments, StoredDocument,
} from '../platform';

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

export function requiredString(value: unknown, name: string, min = 1, max = 240): string {
  const text = String(value ?? '').trim();
  if (text.length < min || text.length > max) {
    throw apiError(400, 'invalid_request', `${name} must be ${min}..${max} characters`);
  }
  return text;
}

export function optionalString(value: unknown, name: string, max = 500): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (text.length > max) throw apiError(400, 'invalid_request', `${name} must be ≤${max} characters`);
  return text;
}

export function stringArray(value: unknown, name: string, max = 50): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw apiError(400, 'invalid_request', `${name} must be an array of ≤${max} non-empty strings`);
  }
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

export function objectValue(value: unknown, name: string, maxBytes = 64_000): Record<string, any> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw apiError(400, 'invalid_request', `${name} must be a JSON object`);
  if (JSON.stringify(value).length > maxBytes) throw apiError(400, 'invalid_request', `${name} is too large`);
  return value as Record<string, any>;
}

export function dateValue(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw apiError(400, 'invalid_request', `${name} must be an ISO timestamp`);
  return date.toISOString();
}

export interface ScopedRecord {
  id: string;
  tenant: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: any;
}

export function tenantOf(principal: CallerPrincipal): string {
  return principal.tenantKey;
}

export function scopeWhere(principal: CallerPrincipal, where: Record<string, unknown> = {}): Record<string, unknown> {
  return isAdmin(principal) ? where : { ...where, tenant: principal.tenantKey };
}

export async function createScoped<T extends Record<string, any>>(
  client: SynapseOneClient,
  collection: string,
  principal: CallerPrincipal,
  data: T,
): Promise<T & ScopedRecord> {
  const now = nowIso();
  const record = {
    id: String((data as any).id || newId()),
    ...data,
    tenant: tenantOf(principal),
    createdBy: principal.subject,
    createdAt: now,
    updatedAt: now,
  } as T & ScopedRecord;
  await client.base.createDocument(collection, { id: record.id, data: record as unknown as Record<string, unknown> });
  return record;
}

export async function getScoped<T>(
  client: SynapseOneClient,
  collection: string,
  id: string,
  principal: CallerPrincipal,
  notFound = 'not_found',
): Promise<{ record: T & ScopedRecord; version: number }> {
  const document = await getDocumentOrNull<T & ScopedRecord>(client, collection, id);
  if (!document) throw apiError(404, notFound as any, notFound.replace(/_/g, ' '));
  if (!isAdmin(principal) && document.data.tenant !== tenantOf(principal)) {
    throw apiError(404, notFound as any, notFound.replace(/_/g, ' '));
  }
  return { record: document.data, version: document.version };
}

export async function listScoped<T>(
  client: SynapseOneClient,
  collection: string,
  principal: CallerPrincipal,
  options: {
    where?: Record<string, unknown>;
    orderBy?: { field: string; direction?: 'asc' | 'desc' };
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: Array<T & ScopedRecord>; total: number }> {
  const result = await queryDocuments<T & ScopedRecord>(client, collection, {
    where: scopeWhere(principal, options.where || {}),
    orderBy: options.orderBy || { field: 'createdAt', direction: 'desc' },
    limit: Math.min(Math.max(options.limit || 100, 1), 1000),
    offset: Math.max(options.offset || 0, 0),
  });
  return { items: result.items.map((item) => item.data), total: result.total };
}

export async function updateScoped<T extends Record<string, any>>(
  client: SynapseOneClient,
  collection: string,
  id: string,
  principal: CallerPrincipal,
  patch: Partial<T>,
  ifVersion?: number,
): Promise<T & ScopedRecord> {
  const { record, version } = await getScoped<T>(client, collection, id, principal);
  const next = { ...record, ...patch, tenant: record.tenant, id: record.id, updatedAt: nowIso() } as T & ScopedRecord;
  try {
    const saved = await client.base.updateDocument(collection, id, {
      data: next as unknown as Record<string, unknown>,
      ifVersion: ifVersion ?? version,
    });
    return saved.data as unknown as T & ScopedRecord;
  } catch (error) {
    if (error instanceof SynapseOneError && error.status === 409) {
      throw apiError(409, 'version_conflict', 'the record was modified by another request');
    }
    throw error;
  }
}

export async function deleteScoped(
  client: SynapseOneClient,
  collection: string,
  id: string,
  principal: CallerPrincipal,
): Promise<void> {
  await getScoped(client, collection, id, principal);
  try {
    await client.base.deleteDocument(collection, id);
  } catch (error) {
    if (!(error instanceof SynapseOneError && error.status === 404)) throw error;
  }
}

export function assertOwnerOrAdmin(record: { createdBy?: string }, principal: CallerPrincipal, message = 'only the owner or an administrator may change this record'): void {
  if (!isAdmin(principal) && record.createdBy !== principal.subject) throw apiError(403, 'forbidden', message);
}

export function accessible(record: { tenant?: string; viewers?: string[]; owner?: string }, principal: CallerPrincipal): boolean {
  if (isAdmin(principal)) return true;
  if (record.tenant !== principal.tenantKey) return false;
  if (!record.viewers?.length) return true;
  return record.viewers.includes(principal.subject) || record.owner === principal.subject;
}

export function doc<T>(item: StoredDocument<T>): T {
  return item.data;
}
