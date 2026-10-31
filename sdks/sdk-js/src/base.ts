/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseBase client: collections, documents, queries, batch writes, atomic
 * counters, the change feed and typed object<->data mapping.
 *
 * The service stores raw JSON `data`; a collection may declare a mapping from
 * logical field names to dot paths inside that data. Writes can send `object`
 * (logical keys) and reads can ask `as: 'object'` — the service converts in
 * both directions. `BaseCollection` is a typed wrapper for one collection.
 */

import { HttpClient } from './_http';

export type BaseMappingType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' | 'vector' | 'any';
export type BaseVectorMetric = 'cosine' | 'l2' | 'ip';

export interface BaseMappingField {
  /** Dot path inside the stored document. */
  path: string;
  /** Validation type (default: any). */
  type?: BaseMappingType;
  /** Required on full writes (create/replace), not on partial patches. */
  required?: boolean;
  /** Vector dimension (optional, verified if provided). */
  dimension?: number;
  /** Distance metric for similarity queries (default: cosine). */
  metric?: BaseVectorMetric;
}

export interface BaseMapping {
  /** Allow logical keys that are not declared in `fields` (default: false). */
  additional?: boolean;
  fields: Record<string, BaseMappingField>;
}

/** Canonical `{fields: ...}` mapping or the shorthand `{logical: 'dot.path'}` form. */
export type BaseMappingInput = BaseMapping | Record<string, string | BaseMappingField>;

export type BaseQueryOp =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin'
  | 'contains' | 'startsWith' | 'endsWith' | 'exists';

export interface BaseFilter {
  field?: string;
  op?: BaseQueryOp;
  value?: unknown;
  and?: BaseFilter[];
  or?: BaseFilter[];
  not?: BaseFilter;
}

export interface BaseOrderBy {
  field: string;
  direction?: 'asc' | 'desc';
}

export interface BaseQuery {
  where?: BaseFilter | BaseFilter[] | Record<string, unknown>;
  orderBy?: BaseOrderBy | string | Array<BaseOrderBy | string>;
  limit?: number;
  offset?: number;
  cursor?: string;
  select?: string[];
  as?: 'data' | 'object';
}

export interface BaseDocument<T = Record<string, unknown>> {
  id: string;
  data?: T;
  object?: T;
  version: number;
  createdAt: string;
  updatedAt: string;
  collection?: string;
}

export interface BaseCollectionInfo {
  id: string;
  name: string;
  description?: string;
  mapping?: BaseMapping;
  orgId?: string;
  accountId?: string;
  createdAt: string;
  updatedAt: string;
  stats?: Record<string, unknown>;
}

export interface BaseQueryResult<T = Record<string, unknown>> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
}

export interface BaseVectorSearchOptions {
  vector: number[];
  limit?: number;
  k?: number;
  field?: string;
  metric?: BaseVectorMetric;
  where?: BaseFilter | BaseFilter[] | Record<string, unknown>;
  filter?: BaseFilter | BaseFilter[] | Record<string, unknown>;
  select?: string[];
  as?: 'data' | 'object';
}

export interface BaseVectorSearchItem<T = Record<string, unknown>> {
  id: string;
  similarity: number;
  distance: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  data?: T;
  object?: T;
}

export interface BaseVectorSearchResult<T = Record<string, unknown>> {
  items: BaseVectorSearchItem<T>[];
  total: number;
  limit: number;
  metric: string;
}

const _UNSET = Symbol('unset');

// ---------------------------------------------------------------------------
// mapping helpers (client-side mirror of the server object<->data mapping)
// ---------------------------------------------------------------------------

export function normalizeMapping(input?: BaseMappingInput | null): Record<string, BaseMappingField> {
  if (!input) return {};
  const raw = (input as BaseMapping).fields && typeof (input as BaseMapping).fields === 'object'
    ? (input as BaseMapping).fields
    : (input as Record<string, string | BaseMappingField>);
  const out: Record<string, BaseMappingField> = {};
  for (const [name, spec] of Object.entries(raw)) {
    if (typeof spec === 'string') out[name] = { path: spec };
    else if (spec && typeof spec === 'object') out[name] = { ...(spec as BaseMappingField) };
  }
  return out;
}

function getPath(data: any, path: string): unknown {
  let cur: any = data;
  for (const key of String(path).split('.')) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) return _UNSET;
    cur = cur[key];
  }
  return cur;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = String(path).split('.');
  let cur: any = target;
  for (const key of segments.slice(0, -1)) {
    if (!cur[key] || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[segments[segments.length - 1]] = value;
}

/** Project stored `data` onto logical field names (empty mapping = copy). */
export function dataToObject(data: Record<string, unknown> | null | undefined, mapping?: BaseMappingInput | null): Record<string, unknown> {
  const fields = normalizeMapping(mapping);
  if (!Object.keys(fields).length) return { ...(data || {}) };
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(fields)) {
    const value = getPath(data || {}, spec.path);
    if (value !== _UNSET) out[name] = value;
  }
  return out;
}

/** Project a logical object onto stored `data` (empty mapping = copy). */
export function objectToData(obj: Record<string, unknown> | null | undefined, mapping?: BaseMappingInput | null): Record<string, unknown> {
  const fields = normalizeMapping(mapping);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj || {})) {
    setPath(out, fields[key] ? fields[key].path : key, value);
  }
  return out;
}

function writeBody(body: { data?: unknown; object?: unknown }): Record<string, unknown> {
  const hasData = body.data !== undefined;
  const hasObject = body.object !== undefined;
  if (hasData === hasObject) throw new Error('provide exactly one of data or object');
  return hasData ? { data: body.data } : { object: body.object };
}

function queryString(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class BaseService {
  constructor(private readonly http: HttpClient) {}

  /** Bind a collection name (plus optional model/mapping) for typed use. */
  collection<T = Record<string, unknown>>(name: string, opts: BaseCollectionOptions<T> = {}): BaseCollection<T> {
    return new BaseCollection<T>(this, name, opts);
  }

  // ---- collections ----
  listCollections(query: { orgId?: string; accountId?: string } = {}): Promise<BaseCollectionInfo[]> {
    return this.http.req(`/v1/base/collections${queryString({ orgId: query.orgId, accountId: query.accountId })}`);
  }

  createCollection(input: {
    name: string;
    description?: string;
    mapping?: BaseMappingInput;
    orgId?: string;
    accountId?: string;
  }): Promise<BaseCollectionInfo> {
    return this.http.req('/v1/base/collections', { method: 'POST', body: JSON.stringify(input) });
  }

  getCollection(name: string): Promise<BaseCollectionInfo> {
    return this.http.req(`/v1/base/collections/${encodeURIComponent(name)}`);
  }

  updateCollection(name: string, patch: { name?: string; description?: string | null; mapping?: BaseMappingInput }): Promise<BaseCollectionInfo> {
    return this.http.req(`/v1/base/collections/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }

  deleteCollection(name: string) {
    return this.http.req<{ ok: boolean; id: string; name: string }>(`/v1/base/collections/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  collectionStats(name: string) {
    return this.http.req(`/v1/base/collections/${encodeURIComponent(name)}/stats`);
  }

  // ---- documents ----
  createDocument<T = Record<string, unknown>>(
    collection: string,
    body: { data?: Record<string, unknown>; object?: T; id?: string },
  ): Promise<BaseDocument<T>> {
    return this.http.req(`/v1/base/collections/${encodeURIComponent(collection)}/documents`, {
      method: 'POST',
      body: JSON.stringify({ ...writeBody(body), ...(body.id !== undefined ? { id: body.id } : {}) }),
    });
  }

  getDocument<T = Record<string, unknown>>(
    collection: string,
    id: string,
    query: { as?: 'data' | 'object' } = {},
  ): Promise<BaseDocument<T>> {
    return this.http.req(`/v1/base/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}${queryString({ as: query.as })}`);
  }

  setDocument<T = Record<string, unknown>>(
    collection: string,
    id: string,
    body: { data?: Record<string, unknown>; object?: T; ifVersion?: number; merge?: boolean },
  ): Promise<BaseDocument<T>> {
    return this.http.req(`/v1/base/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...writeBody(body),
        ...(body.ifVersion !== undefined ? { ifVersion: body.ifVersion } : {}),
        ...(body.merge ? { merge: true } : {}),
      }),
    });
  }

  updateDocument<T = Record<string, unknown>>(
    collection: string,
    id: string,
    body: { data?: Record<string, unknown>; object?: T; unset?: string[]; ifVersion?: number },
  ): Promise<BaseDocument<T>> {
    if (body.data === undefined && body.object === undefined && !body.unset?.length) {
      throw new Error('provide data/object and/or unset');
    }
    const payload: Record<string, unknown> = {};
    if (body.data !== undefined || body.object !== undefined) Object.assign(payload, writeBody(body));
    if (body.unset?.length) payload.unset = body.unset;
    if (body.ifVersion !== undefined) payload.ifVersion = body.ifVersion;
    return this.http.req(`/v1/base/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(payload),
    });
  }

  deleteDocument(collection: string, id: string, opts: { ifVersion?: number } = {}) {
    return this.http.req<{ ok: boolean; id: string }>(
      `/v1/base/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}${queryString({ ifVersion: opts.ifVersion })}`,
      { method: 'DELETE' },
    );
  }

  // ---- query / batch / changes ----
  queryDocuments<T = Record<string, unknown>>(collection: string, query: BaseQuery = {}): Promise<BaseQueryResult<T>> {
    const body: Record<string, unknown> = { as: query.as ?? 'data' };
    if (query.where !== undefined) body.where = query.where;
    if (query.orderBy !== undefined) body.orderBy = query.orderBy;
    if (query.limit !== undefined) body.limit = query.limit;
    if (query.offset !== undefined) body.offset = query.offset;
    if (query.cursor !== undefined) body.cursor = query.cursor;
    if (query.select !== undefined) body.select = query.select;
    return this.http.req(`/v1/base/collections/${encodeURIComponent(collection)}/query`, {
      method: 'POST', body: JSON.stringify(body),
    });
  }

  vectorSearch<T = Record<string, unknown>>(
    collection: string,
    options: BaseVectorSearchOptions,
  ): Promise<BaseVectorSearchResult<T>> {
    const body: Record<string, unknown> = {
      vector: options.vector,
      as: options.as ?? 'data',
    };
    if (options.limit !== undefined) body.limit = options.limit;
    if (options.k !== undefined) body.k = options.k;
    if (options.field !== undefined) body.field = options.field;
    if (options.metric !== undefined) body.metric = options.metric;
    if (options.where !== undefined) body.where = options.where;
    if (options.filter !== undefined) body.filter = options.filter;
    if (options.select !== undefined) body.select = options.select;
    return this.http.req(`/v1/base/collections/${encodeURIComponent(collection)}/vector-search`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  listDocuments<T = Record<string, unknown>>(
    collection: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<Array<BaseDocument<T>>> {
    return this.http.req(`/v1/base/collections/${encodeURIComponent(collection)}/documents${queryString({ limit: opts.limit, offset: opts.offset })}`);
  }

  increment<T = Record<string, unknown>>(
    collection: string,
    id: string,
    body: { field: string; by?: number; ifVersion?: number },
  ): Promise<BaseDocument<T>> {
    return this.http.req(`/v1/base/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}/increment`, {
      method: 'POST',
      body: JSON.stringify({
        field: body.field,
        by: body.by ?? 1,
        ...(body.ifVersion !== undefined ? { ifVersion: body.ifVersion } : {}),
      }),
    });
  }

  batch(collection: string, operations: Record<string, unknown>[]) {
    return this.http.req<{ results: any[]; ok: boolean }>(
      `/v1/base/collections/${encodeURIComponent(collection)}/documents:batch`,
      { method: 'POST', body: JSON.stringify({ operations }) },
    );
  }

  changes<T = Record<string, unknown>>(
    collection: string,
    query: { since: string; limit?: number; as?: 'data' | 'object' },
  ): Promise<{ changes: any[]; nextSince: string; hasMore: boolean }> {
    return this.http.req(`/v1/base/collections/${encodeURIComponent(collection)}/changes${queryString({
      since: query.since, limit: query.limit, as: query.as,
    })}`);
  }
}

// ---------------------------------------------------------------------------
// typed collection
// ---------------------------------------------------------------------------

export interface BaseCollectionOptions<T> {
  /** Optional factory turning a logical object into your model instance. */
  model?: (obj: Record<string, unknown>) => T;
  /** Server-side mapping (logical -> dot path), used for data responses. */
  mapping?: BaseMappingInput;
}

/**
 * A collection bound to a service, with optional model factory + mapping.
 *
 * Typed methods send logical `object` payloads; raw `data` writes are available
 * through the `data` option. Reads use `as: 'object'` and run through the model
 * factory, while endpoints that return raw `data` (list/increment/changes) are
 * converted locally with the mapping.
 */
export class BaseCollection<T = Record<string, unknown>> {
  constructor(
    private readonly service: BaseService,
    readonly name: string,
    private readonly opts: BaseCollectionOptions<T> = {},
  ) {}

  toObject(value: T): Record<string, unknown> {
    return value as unknown as Record<string, unknown>;
  }

  fromObject(obj: Record<string, unknown> | null | undefined): T {
    const value = obj ?? {};
    return this.opts.model ? this.opts.model(value) : (value as unknown as T);
  }

  fromData(data: Record<string, unknown> | null | undefined): T {
    return this.fromObject(dataToObject(data, this.opts.mapping));
  }

  private docResult(doc: BaseDocument<any>): T {
    return doc.object !== undefined ? this.fromObject(doc.object) : this.fromData(doc.data);
  }

  create(value?: T, opts: { id?: string; data?: Record<string, unknown> } = {}): Promise<T> {
    const body = this.writeInput(value, opts.data, 'value');
    return this.service
      .createDocument(this.name, { ...body, id: opts.id })
      .then((doc) => this.docResult(doc));
  }

  get(id: string): Promise<T> {
    return this.service
      .getDocument(this.name, id, { as: 'object' })
      .then((doc) => this.fromObject(doc.object));
  }

  getDocument(id: string, as: 'data' | 'object' = 'data'): Promise<BaseDocument<any>> {
    return this.service.getDocument(this.name, id, { as });
  }

  list(opts: { limit?: number; offset?: number } = {}): Promise<T[]> {
    return this.service
      .listDocuments(this.name, opts)
      .then((docs) => docs.map((doc) => this.fromData(doc.data)));
  }

  set(
    id: string,
    value?: T,
    opts: { data?: Record<string, unknown>; ifVersion?: number; merge?: boolean } = {},
  ): Promise<T> {
    const body = this.writeInput(value, opts.data, 'value');
    return this.service
      .setDocument(this.name, id, { ...body, ifVersion: opts.ifVersion, merge: opts.merge })
      .then((doc) => this.docResult(doc));
  }

  update(
    id: string,
    value?: T,
    opts: { data?: Record<string, unknown>; unset?: string[]; ifVersion?: number } = {},
  ): Promise<T> {
    const body: { data?: Record<string, unknown>; object?: T } = {};
    if (value !== undefined || opts.data !== undefined) Object.assign(body, this.writeInput(value, opts.data, 'value'));
    else if (!opts.unset?.length) throw new Error('provide a value, data or unset');
    return this.service
      .updateDocument(this.name, id, { ...body, unset: opts.unset, ifVersion: opts.ifVersion })
      .then((doc) => this.docResult(doc));
  }

  delete(id: string, opts: { ifVersion?: number } = {}) {
    return this.service.deleteDocument(this.name, id, opts);
  }

  increment(id: string, body: { field: string; by?: number; ifVersion?: number }): Promise<T> {
    return this.service
      .increment(this.name, id, body)
      .then((doc) => this.fromData(doc.data));
  }

  query(query: BaseQuery = {}): Promise<BaseQueryResult<T>> {
    return this.service.queryDocuments<any>(this.name, { ...query, as: 'object' }).then((result) => ({
      ...result,
      items: result.items.map((item) => this.fromObject(item.object)),
    }));
  }

  vectorSearch(options: Omit<BaseVectorSearchOptions, 'as'>): Promise<BaseVectorSearchResult<T>> {
    return this.service
      .vectorSearch<any>(this.name, { ...options, as: 'object' })
      .then((result) => ({
        ...result,
        items: result.items.map((item) => ({
          ...item,
          object: this.fromObject(item.object),
        })),
      }));
  }

  changes(query: { since: string; limit?: number }) {
    return this.service.changes(this.name, { ...query, as: 'object' }).then((raw) => ({
      ...raw,
      changes: raw.changes.map((ch) => ({ ...ch, document: this.fromObject(ch.object) })),
    }));
  }

  batch(operations: Record<string, unknown>[]) {
    return this.service.batch(this.name, operations);
  }

  stats() {
    return this.service.collectionStats(this.name);
  }

  private writeInput(
    value: T | undefined,
    data: Record<string, unknown> | undefined,
    name: string,
  ): { data?: Record<string, unknown>; object?: T } {
    if (value !== undefined && data !== undefined) throw new Error(`provide exactly one of ${name} or data`);
    if (value === undefined && data === undefined) throw new Error(`provide exactly one of ${name} or data`);
    return data !== undefined ? { data } : { object: value as T };
  }
}
