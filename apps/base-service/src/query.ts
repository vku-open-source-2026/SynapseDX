/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseBase query engine: filter tree, ordering, pagination and projection.
 * Queries are evaluated over the collection's documents by the service; the
 * response always reports the effective limit/offset and a next cursor.
 */
import { BaseMapping, cloneJson, dataToObject, getPath } from './mapping';

export const QUERY_OPS = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin',
  'contains', 'startsWith', 'endsWith', 'exists',
] as const;
export type QueryOp = (typeof QUERY_OPS)[number];

export interface FilterNode {
  field?: string;
  op?: QueryOp;
  value?: unknown;
  and?: FilterNode[];
  or?: FilterNode[];
  not?: FilterNode;
}

export interface OrderBy {
  field: string;
  direction: 'asc' | 'desc';
}

export interface QuerySpec {
  where?: FilterNode;
  orderBy: OrderBy[];
  limit: number;
  offset: number;
  select?: string[];
  as: 'data' | 'object';
}

export class QueryError extends Error {
  code = 'invalid_query';
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

export interface StoredDocumentView {
  id: string;
  data: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

const FIELD_RE = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,255}$/;
const BANNED = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_FILTERS = 50;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function assertField(field: unknown): string {
  const s = String(field || '');
  if (!FIELD_RE.test(s) || s.split('.').some((p) => BANNED.has(p))) {
    throw new QueryError(`invalid field '${s.slice(0, 100)}'`);
  }
  return s;
}

function resolveField(field: string, mapping?: BaseMapping | null): string {
  if (!field.startsWith('$') && mapping?.fields?.[field]) return mapping.fields[field].path;
  return field;
}

function parseFilter(input: unknown, depth = 0, mapping?: BaseMapping | null): FilterNode {
  if (depth > 8) throw new QueryError('filter nesting exceeds 8 levels');
  if (Array.isArray(input)) {
    if (!input.length) throw new QueryError('filter array cannot be empty');
    return { and: input.map((x) => parseFilter(x, depth + 1, mapping)) };
  }
  if (!isPlainObject(input)) throw new QueryError('where must be a filter object or array');

  if (Array.isArray(input.and)) {
    if (!input.and.length) throw new QueryError('and[] cannot be empty');
    return { and: input.and.map((x) => parseFilter(x, depth + 1, mapping)) };
  }
  if (Array.isArray(input.or)) {
    if (!input.or.length) throw new QueryError('or[] cannot be empty');
    return { or: input.or.map((x) => parseFilter(x, depth + 1, mapping)) };
  }
  if (input.not !== undefined) return { not: parseFilter(input.not, depth + 1, mapping) };

  if (input.field !== undefined) {
    const field = resolveField(assertField(input.field), mapping);
    const op = String(input.op || 'eq') as QueryOp;
    if (!(QUERY_OPS as readonly string[]).includes(op)) throw new QueryError(`unsupported operator '${op}'`);
    if (op === 'in' || op === 'nin') {
      if (!Array.isArray(input.value) || input.value.length === 0 || input.value.length > 1000) {
        throw new QueryError(`${op} expects a non-empty array (max 1000)`);
      }
    }
    if (op === 'exists' && typeof input.value !== 'boolean') throw new QueryError('exists expects a boolean');
    return { field, op, value: input.value };
  }

  // Shorthand: {"status": "active", "age": {"gte": 18}}.
  const entries = Object.entries(input);
  if (!entries.length) throw new QueryError('where cannot be empty');
  const nodes: FilterNode[] = [];
  for (const [key, value] of entries) {
    if (key === 'field' || key === 'op' || key === 'value') {
      throw new QueryError('leaf filters need field/op/value');
    }
    const field = resolveField(assertField(key), mapping);
    if (isPlainObject(value) && Object.keys(value).length === 1) {
      const [opRaw, opValue] = Object.entries(value)[0];
      if ((QUERY_OPS as readonly string[]).includes(opRaw)) {
        nodes.push(parseFilter({ field, op: opRaw, value: opValue }, depth + 1, mapping));
        continue;
      }
    }
    nodes.push({ field, op: 'eq', value });
  }
  return nodes.length === 1 ? nodes[0] : { and: nodes };
}

function parseOrderBy(input: unknown, mapping?: BaseMapping | null): OrderBy[] {
  if (input === undefined || input === null) return [];
  const raw = Array.isArray(input) ? input : [input];
  if (raw.length > 3) throw new QueryError('at most 3 orderBy fields');
  return raw.map((item) => {
    if (typeof item === 'string') return { field: resolveField(assertField(item), mapping), direction: 'asc' as const };
    if (!isPlainObject(item)) throw new QueryError('orderBy entries must be strings or {field,direction}');
    const direction = String(item.direction || 'asc').toLowerCase();
    if (direction !== 'asc' && direction !== 'desc') throw new QueryError("orderBy direction must be 'asc' or 'desc'");
    return { field: resolveField(assertField(item.field), mapping), direction: direction as 'asc' | 'desc' };
  });
}

function parseSelect(input: unknown, mapping?: BaseMapping | null): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  const list = Array.isArray(input) ? input : [input];
  if (!list.length || list.length > 100) throw new QueryError('select must contain 1..100 paths');
  return list.map((f) => resolveField(assertField(f), mapping));
}

function parseCursor(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(input), 'base64url').toString('utf8'));
    const offset = Number(decoded?.offset);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('bad offset');
    return offset;
  } catch {
    throw new QueryError('invalid cursor');
  }
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), 'utf8').toString('base64url');
}

export function parseQuerySpec(body: unknown, mapping?: BaseMapping | null): QuerySpec {
  const b = isPlainObject(body) ? body : {};
  const where = b.where === undefined ? undefined : parseFilter(b.where, 0, mapping);
  if (where) {
    const count = countFilters(where);
    if (count > MAX_FILTERS) throw new QueryError(`at most ${MAX_FILTERS} filters per query`);
  }
  const orderBy = parseOrderBy(b.orderBy, mapping);
  const rawLimit = b.limit === undefined ? 100 : Number(b.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 1000) {
    throw new QueryError('limit must be an integer 1..1000');
  }
  const cursorOffset = parseCursor(b.cursor);
  const rawOffset = b.offset === undefined ? 0 : Number(b.offset);
  if (!Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 10_000_000) {
    throw new QueryError('offset must be an integer >= 0');
  }
  if (cursorOffset !== null && b.offset !== undefined) {
    throw new QueryError('use either cursor or offset, not both');
  }
  const as = b.as === undefined ? 'data' : String(b.as);
  if (as !== 'data' && as !== 'object') throw new QueryError("as must be 'data' or 'object'");
  return {
    where,
    orderBy,
    limit: rawLimit,
    offset: cursorOffset ?? rawOffset,
    select: parseSelect(b.select, mapping),
    as,
  };
}

function countFilters(node: FilterNode): number {
  if (node.and) return node.and.reduce((n, x) => n + countFilters(x), 0);
  if (node.or) return node.or.reduce((n, x) => n + countFilters(x), 0);
  if (node.not) return countFilters(node.not);
  return 1;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function compare(a: unknown, b: unknown): number | null {
  if (a === b) return 0;
  if (a === undefined || a === null || b === undefined || b === null) return null;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return null;
}

/** Query-visible document fields: `$id`/`$version`/`$createdAt`/`$updatedAt`
 *  address document metadata; every other path reads the data payload. */
function fieldValue(doc: StoredDocumentView, field: string): unknown {
  switch (field) {
    case '$id': return doc.id;
    case '$version': return doc.version;
    case '$createdAt': return doc.created_at;
    case '$updatedAt': return doc.updated_at;
    default: return getPath(doc.data || {}, field);
  }
}

function matches(node: FilterNode, doc: StoredDocumentView): boolean {
  if (node.and) return node.and.every((n) => matches(n, doc));
  if (node.or) return node.or.some((n) => matches(n, doc));
  if (node.not) return !matches(node.not, doc);
  const value = fieldValue(doc, node.field!);
  const op = node.op || 'eq';
  switch (op) {
    case 'exists':
      return (value !== undefined) === node.value;
    case 'eq':
      return jsonEqual(value, node.value);
    case 'ne':
      return value !== undefined && !jsonEqual(value, node.value);
    case 'in':
      return Array.isArray(node.value) && node.value.some((v) => jsonEqual(value, v));
    case 'nin':
      return Array.isArray(node.value) && value !== undefined && !node.value.some((v) => jsonEqual(value, v));
    case 'gt': {
      const c = compare(value, node.value);
      return c !== null && c > 0;
    }
    case 'gte': {
      const c = compare(value, node.value);
      return c !== null && c >= 0;
    }
    case 'lt': {
      const c = compare(value, node.value);
      return c !== null && c < 0;
    }
    case 'lte': {
      const c = compare(value, node.value);
      return c !== null && c <= 0;
    }
    case 'contains':
      if (typeof value === 'string') return value.includes(String(node.value ?? ''));
      if (Array.isArray(value)) return value.some((v) => jsonEqual(v, node.value));
      return false;
    case 'startsWith':
      return typeof value === 'string' && value.startsWith(String(node.value ?? ''));
    case 'endsWith':
      return typeof value === 'string' && value.endsWith(String(node.value ?? ''));
    default:
      return false;
  }
}

function project(data: Record<string, unknown>, select: string[] | undefined): Record<string, unknown> {
  if (!select) return cloneJson(data);
  const out: Record<string, unknown> = {};
  for (const path of select) {
    const value = getPath(data, path);
    if (value === undefined) continue;
    setProjected(out, path, cloneJson(value));
  }
  return out;
}

function setProjected(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cur: any = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  cur[segments[segments.length - 1]] = value;
}

export interface QueryResult {
  items: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
}

export function applyQuery(
  docs: StoredDocumentView[],
  spec: QuerySpec,
  mapping: BaseMapping | null | undefined,
): QueryResult {
  const filtered = spec.where ? docs.filter((d) => matches(spec.where!, d)) : docs.slice();
  if (spec.orderBy.length) {
    filtered.sort((a, b) => {
      for (const order of spec.orderBy) {
        const av = fieldValue(a, order.field);
        const bv = fieldValue(b, order.field);
        const c = compare(av, bv);
        if (c === null) {
          if (av === undefined && bv === undefined) continue;
          if (av === undefined) return 1;
          if (bv === undefined) return -1;
          continue;
        }
        if (c !== 0) return order.direction === 'asc' ? c : -c;
      }
      return a.id.localeCompare(b.id);
    });
  } else {
    filtered.sort((a, b) => a.id.localeCompare(b.id));
  }
  const total = filtered.length;
  const page = filtered.slice(spec.offset, spec.offset + spec.limit);
  const items = page.map((d) => {
    const data = project(d.data || {}, spec.select);
    return {
      id: d.id,
      version: d.version,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
      ...(spec.as === 'object' ? { object: dataToObject(data, mapping) } : { data }),
    };
  });
  const nextOffset = spec.offset + page.length;
  return {
    items,
    total,
    limit: spec.limit,
    offset: spec.offset,
    nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
  };
}
