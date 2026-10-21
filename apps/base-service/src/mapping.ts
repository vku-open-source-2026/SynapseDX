/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseBase object <-> data mapping.
 *
 * A collection can declare a mapping from stable logical field names to paths
 * inside the stored JSON document:
 *
 *   {
 *     "fields": {
 *       "fullName": {"path": "profile.name", "type": "string", "required": true},
 *       "age":      {"path": "profile.age",  "type": "number"},
 *       "joinedAt": {"path": "meta.joinedAt", "type": "date"}
 *     }
 *   }
 *
 * Writes may send `object` (logical keys) and reads may ask `as=object`;
 * the service converts both directions without ever inventing columns or
 * leaking unmapped fields. The mapping is also the validation contract:
 * required fields and declared types are enforced server-side.
 */

export type MappingType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' | 'any';

export interface MappingField {
  /** Dot path inside the stored document. */
  path: string;
  /** Validation type (default: any). */
  type?: MappingType;
  /** Required on full writes (create/replace), not on partial patches. */
  required?: boolean;
}

export interface BaseMapping {
  /** Allow logical keys that are not declared in `fields` (default: false). */
  additional?: boolean;
  fields: Record<string, MappingField>;
}

export class MappingError extends Error {
  code = 'mapping_error';
  details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'MappingError';
    this.details = details;
  }
}

const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9_$-]{1,64}$/;
const BANNED_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const MAPPING_TYPES = new Set<string>(['string', 'number', 'boolean', 'date', 'array', 'object', 'any']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

/**
 * Accepts either the canonical `{fields: {name: {path,type,required}}}` form
 * or a shorthand `{name: "dot.path"}` / `{name: {path}}` map. Returns a
 * normalized deep copy; throws MappingError on invalid input.
 */
export function normalizeMapping(input: unknown): BaseMapping {
  if (input === undefined || input === null) return { additional: false, fields: {} };
  if (!isPlainObject(input)) throw new MappingError('mapping must be an object');
  const rawFields = isPlainObject(input.fields) ? input.fields : input;
  const fields: Record<string, MappingField> = {};
  const seenPaths = new Set<string>();
  if (Object.keys(rawFields).length > 100) throw new MappingError('mapping supports at most 100 fields');
  for (const [name, spec] of Object.entries(rawFields)) {
    if (!FIELD_NAME_RE.test(name)) {
      throw new MappingError(`invalid mapping field name '${name}' (want [A-Za-z_][A-Za-z0-9_-]{0,63})`);
    }
    let field: MappingField;
    if (typeof spec === 'string') {
      field = { path: spec };
    } else if (isPlainObject(spec)) {
      field = { path: String(spec.path || '') };
      if (spec.type !== undefined) {
        const t = String(spec.type);
        if (!MAPPING_TYPES.has(t)) {
          throw new MappingError(`invalid type '${t}' for mapping field '${name}'`);
        }
        field.type = t as MappingType;
      }
      if (spec.required !== undefined) field.required = !!spec.required;
    } else {
      throw new MappingError(`mapping field '${name}' must be a path string or {path,type,required}`);
    }
    if (!field.path) throw new MappingError(`mapping field '${name}' requires a path`);
    const segments = field.path.split('.');
    if (segments.length > 16 || segments.some((s) => !PATH_SEGMENT_RE.test(s) || BANNED_SEGMENTS.has(s))) {
      throw new MappingError(`invalid path '${field.path}' for mapping field '${name}'`);
    }
    if (seenPaths.has(field.path)) {
      throw new MappingError(`duplicate mapping path '${field.path}'`);
    }
    seenPaths.add(field.path);
    fields[name] = field;
  }
  const additional = input.additional === undefined ? false : !!input.additional;
  return { additional, fields };
}

export function hasMapping(mapping: BaseMapping | null | undefined): boolean {
  return !!mapping && Object.keys(mapping.fields || {}).length > 0;
}

function typeError(field: string, expected: MappingType, got: unknown): MappingError {
  const actual = got === null ? 'null' : Array.isArray(got) ? 'array' : typeof got;
  return new MappingError(`field '${field}' must be ${expected}, got ${actual}`);
}

function validateTyped(field: string, type: MappingType, value: unknown): void {
  if (type === 'any' || value === null) return;
  switch (type) {
    case 'string':
      if (typeof value !== 'string') throw typeError(field, type, value);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw typeError(field, type, value);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw typeError(field, type, value);
      return;
    case 'date':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw typeError(field, 'date', value);
      return;
    case 'array':
      if (!Array.isArray(value)) throw typeError(field, type, value);
      return;
    case 'object':
      if (!isPlainObject(value)) throw typeError(field, type, value);
      return;
  }
}

export function getPath(data: Record<string, unknown>, path: string): unknown {
  let cur: any = data;
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cur: any = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (!isPlainObject(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[segments[segments.length - 1]] = value;
}

export function unsetPath(target: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  let cur: any = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (!isPlainObject(cur[key])) return;
    cur = cur[key];
  }
  delete cur[segments[segments.length - 1]];
}

/** Deep clone of JSON-compatible data (protects in-memory fallback). */
export function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

/** Deep merge: objects merge recursively; arrays and scalars replace. */
export function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = cloneJson(base || {});
  for (const [key, value] of Object.entries(patch || {})) {
    if (BANNED_SEGMENTS.has(key)) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = cloneJson(value);
    }
  }
  return out;
}

/** Validate a raw stored document (size/depth/prototype-pollution guards). */
export function validateDocumentData(input: unknown, maxBytes = 256 * 1024): Record<string, unknown> {
  if (!isPlainObject(input)) throw new MappingError('data must be a JSON object');
  const raw = JSON.stringify(input);
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw new MappingError(`document exceeds ${Math.floor(maxBytes / 1024)}KB`);
  }
  const walk = (v: unknown, depth: number): void => {
    if (depth > 32) throw new MappingError('document nesting exceeds 32 levels');
    if (Array.isArray(v)) {
      if (v.length > 10000) throw new MappingError('array exceeds 10000 items');
      for (const item of v) walk(item, depth + 1);
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (BANNED_SEGMENTS.has(k)) throw new MappingError(`reserved object key '${k}'`);
        walk(child, depth + 1);
      }
    }
  };
  walk(input, 0);
  return cloneJson(input);
}

/**
 * Convert a logical object (mapped keys) into stored data.
 * `partial` skips the required check (used by PATCH / object patches).
 */
export function objectToData(
  object: unknown,
  mapping: BaseMapping | null | undefined,
  opts: { partial?: boolean } = {},
): Record<string, unknown> {
  if (!isPlainObject(object)) throw new MappingError('object must be a JSON object');
  const map = mapping || { fields: {} };
  if (!hasMapping(map)) {
    if (map.additional !== true) throw new MappingError('collection has no mapping; send data instead of object');
    return validateDocumentData(object);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object)) {
    if (!map.fields[key] && map.additional !== true) {
      throw new MappingError(`unknown mapped field '${key}'`, { allowed: Object.keys(map.fields) });
    }
  }
  for (const [name, field] of Object.entries(map.fields)) {
    const present = Object.prototype.hasOwnProperty.call(object, name);
    if (!present) {
      if (!opts.partial && field.required) throw new MappingError(`required field '${name}' is missing`);
      continue;
    }
    const value = (object as Record<string, unknown>)[name];
    if (value === undefined) {
      if (!opts.partial && field.required) throw new MappingError(`required field '${name}' is missing`);
      continue;
    }
    validateTyped(name, field.type || 'any', value);
    setPath(out, field.path, cloneJson(value));
  }
  if (map.additional === true) {
    for (const [key, value] of Object.entries(object)) {
      if (!map.fields[key]) setPath(out, key, cloneJson(value));
    }
  }
  return validateDocumentData(out);
}

/** Convert stored data into a logical object (mapped keys only). */
export function dataToObject(data: Record<string, unknown>, mapping: BaseMapping | null | undefined): Record<string, unknown> {
  const map = mapping || { fields: {} };
  if (!hasMapping(map)) return cloneJson(data || {});
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(map.fields)) {
    const value = getPath(data || {}, field.path);
    if (value !== undefined) out[name] = cloneJson(value);
  }
  return out;
}

/**
 * Ensure a raw `data` write satisfies the mapping's required/typed fields.
 * Raw writes may still carry extra fields; mapping is a view, not a whitelist.
 * `partial` skips the required check (PATCH / partial raw updates).
 */
export function validateDataAgainstMapping(
  data: Record<string, unknown>,
  mapping: BaseMapping | null | undefined,
  opts: { partial?: boolean } = {},
): void {
  if (!hasMapping(mapping)) return;
  for (const [name, field] of Object.entries(mapping!.fields)) {
    const value = getPath(data, field.path);
    if (value === undefined) {
      if (field.required && !opts.partial) throw new MappingError(`required field '${name}' is missing (path '${field.path}')`);
      continue;
    }
    validateTyped(name, field.type || 'any', value);
  }
}

/** Validate a full stored doc after a raw write, without altering extra fields. */
export function normalizeDocumentData(
  input: unknown,
  mapping: BaseMapping | null | undefined,
  maxBytes = 256 * 1024,
): Record<string, unknown> {
  const data = validateDocumentData(input, maxBytes);
  validateDataAgainstMapping(data, mapping);
  return data;
}
