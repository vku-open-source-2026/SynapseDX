/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * Synapse Faststore persistence — Redis in production, in-memory fallback for
 * development and tests. Keys are always tenant-scoped by the caller.
 */
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

export type FaststoreType = 'string' | 'hash' | 'list' | 'set' | 'zset';

export type FaststoreErrorCode =
  | 'invalid_key'
  | 'invalid_field'
  | 'key_exists'
  | 'not_found'
  | 'wrong_type'
  | 'not_a_number'
  | 'invalid_ttl'
  | 'storage_unavailable';

export class FaststoreError extends Error {
  code: FaststoreErrorCode;
  constructor(code: FaststoreErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'FaststoreError';
  }
}

export interface WriteOptions {
  ttlSeconds?: number;
  ifNotExists?: boolean;
  ifExists?: boolean;
}

export interface ScannedKey {
  key: string;
  type: FaststoreType;
  ttlSeconds: number | null;
}

export interface ScanResult {
  keys: ScannedKey[];
  cursor: string | null;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.FASTSTORE_REDIS_URL || process.env.REDIS_URL || '';
let redis: Redis | null = null;
let connecting: Promise<boolean> | null = null;

export function useRedis(): boolean {
  return !!redis;
}

export async function initStore(): Promise<boolean> {
  if (!REDIS_URL) return false;
  if (redis) return true;
  if (connecting) return connecting;
  connecting = (async () => {
    const client = new Redis(REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    client.on('error', (e: any) => console.error('[faststore][redis]', e?.message || e));
    try {
      await client.connect();
      await client.ping();
      redis = client;
      console.log('[faststore] connected to Redis');
      return true;
    } catch (e: any) {
      console.warn('[faststore] Redis unavailable, using in-memory fallback:', e?.message || e);
      client.disconnect();
      redis = null;
      return false;
    }
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function closeStore(): Promise<void> {
  if (redis) {
    redis.disconnect();
    redis = null;
  }
}

function tPrefix(tenant: string): string {
  return `synapseone:faststore:v1:${tenant}:`;
}

function rk(tenant: string, key: string): string {
  return `${tPrefix(tenant)}${key}`;
}

function lockKey(tenant: string, name: string): string {
  return `synapseone:faststore:v1:${tenant}:__lock__:${name}`;
}

function enc(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function dec(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function mapRedisError(e: any): never {
  if (e instanceof FaststoreError) throw e;
  const msg = String(e?.message || e || 'redis error');
  if (/WRONGTYPE/i.test(msg)) throw new FaststoreError('wrong_type', 'key holds a different value type');
  if (/NOT_A_NUMBER|not an integer|is not a valid float|value is not an integer/i.test(msg)) {
    throw new FaststoreError('not_a_number', 'value is not a number');
  }
  if (/ECONNREFUSED|ECONNRESET|NR_CLOSED|Connection is closed|Loading|READONLY/i.test(msg)) {
    throw new FaststoreError('storage_unavailable', 'cache backend is unavailable');
  }
  throw e;
}

async function r<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    mapRedisError(e);
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

type MemEntry =
  | { type: 'string'; value: string; expiresAt: number | null }
  | { type: 'hash'; value: Map<string, string>; expiresAt: number | null }
  | { type: 'list'; value: string[]; expiresAt: number | null }
  | { type: 'set'; value: Set<string>; expiresAt: number | null }
  | { type: 'zset'; value: Map<string, number>; expiresAt: number | null };

const mem = new Map<string, MemEntry>();
const memLocks = new Map<string, { token: string; expiresAt: number }>();
const MAX_SCAN_KEYS = 10_000;

function expiryFrom(ttlSeconds?: number): number | null {
  return ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
}

function liveEntry(fullKey: string): MemEntry | null {
  const e = mem.get(fullKey);
  if (!e) return null;
  if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
    mem.delete(fullKey);
    return null;
  }
  return e;
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [k, e] of mem) {
    if (e.expiresAt !== null && e.expiresAt <= now) mem.delete(k);
  }
  for (const [k, l] of memLocks) {
    if (l.expiresAt <= now) memLocks.delete(k);
  }
}

function expectType<T extends MemEntry['type']>(entry: MemEntry | null, type: T): (MemEntry & { type: T }) | null {
  if (!entry) return null;
  if (entry.type !== type) throw new FaststoreError('wrong_type', `key holds ${entry.type}, not ${type}`);
  return entry as MemEntry & { type: T };
}

function memTtl(e: MemEntry): number | null {
  if (e.expiresAt === null) return null;
  return Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 1000));
}

function touch<T extends MemEntry>(fullKey: string, entry: T, ttlSeconds?: number): T {
  if (ttlSeconds !== undefined) entry.expiresAt = expiryFrom(ttlSeconds);
  mem.set(fullKey, entry);
  return entry;
}

export function __clearFaststoreMem(): void {
  mem.clear();
  memLocks.clear();
}

// ---------------------------------------------------------------------------
// Basic key/value operations
// ---------------------------------------------------------------------------

export async function setValue(
  tenant: string,
  key: string,
  value: unknown,
  opts: WriteOptions = {},
): Promise<{ created: boolean }> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const existed = (await redis!.exists(full)) === 1;
      if (opts.ifNotExists && existed) throw new FaststoreError('key_exists', `key '${key}' already exists`);
      if (opts.ifExists && !existed) throw new FaststoreError('not_found', `key '${key}' not found`);
      const args: string[] = [];
      if (opts.ifNotExists) args.push('NX');
      else if (opts.ifExists) args.push('XX');
      if (opts.ttlSeconds && opts.ttlSeconds > 0) args.push('EX', String(opts.ttlSeconds));
      const result = await (redis as any).set(full, enc(value), ...args);
      if (result === null) {
        throw new FaststoreError(opts.ifNotExists ? 'key_exists' : 'not_found', opts.ifNotExists ? `key '${key}' already exists` : `key '${key}' not found`);
      }
      return { created: !existed };
    });
  }
  const existed = liveEntry(full);
  if (opts.ifNotExists && existed) throw new FaststoreError('key_exists', `key '${key}' already exists`);
  if (opts.ifExists && !existed) throw new FaststoreError('not_found', `key '${key}' not found`);
  mem.set(full, { type: 'string', value: enc(value), expiresAt: expiryFrom(opts.ttlSeconds) });
  return { created: !existed };
}

export async function getValue(tenant: string, key: string): Promise<{ type: FaststoreType; value: unknown; ttlSeconds: number | null } | null> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = (await redis!.type(full)) as string;
      if (type === 'none') return null;
      const ttlSeconds = await redis!.ttl(full);
      if (type === 'string') {
        return { type: 'string' as FaststoreType, value: dec(await redis!.get(full)), ttlSeconds: ttlSeconds < 0 ? null : ttlSeconds };
      }
      if (type === 'hash') {
        const raw = await redis!.hgetall(full);
        return { type: 'hash' as FaststoreType, value: decodeObject(raw), ttlSeconds: ttlSeconds < 0 ? null : ttlSeconds };
      }
      if (type === 'list') {
        const raw = await redis!.lrange(full, 0, -1);
        return { type: 'list' as FaststoreType, value: raw.map(dec), ttlSeconds: ttlSeconds < 0 ? null : ttlSeconds };
      }
      if (type === 'set') {
        const raw = await redis!.smembers(full);
        return { type: 'set' as FaststoreType, value: raw.map(dec).sort(), ttlSeconds: ttlSeconds < 0 ? null : ttlSeconds };
      }
      if (type === 'zset') {
        const raw = await (redis as any).zrange(full, 0, -1, 'WITHSCORES') as string[];
        return { type: 'zset' as FaststoreType, value: parseZRange(raw), ttlSeconds: ttlSeconds < 0 ? null : ttlSeconds };
      }
      throw new FaststoreError('wrong_type', `unsupported key type '${type}'`);
    });
  }
  const e = liveEntry(full);
  if (!e) return null;
  if (e.type === 'string') return { type: 'string', value: dec(e.value), ttlSeconds: memTtl(e) };
  if (e.type === 'hash') return { type: 'hash', value: Object.fromEntries([...e.value].map(([k, v]) => [k, dec(v)])), ttlSeconds: memTtl(e) };
  if (e.type === 'list') return { type: 'list', value: e.value.map(dec), ttlSeconds: memTtl(e) };
  if (e.type === 'set') return { type: 'set', value: [...e.value].map(dec).sort(), ttlSeconds: memTtl(e) };
  const sorted = [...e.value.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  return { type: 'zset', value: sorted.map(([member, score]) => ({ member: dec(member), score })), ttlSeconds: memTtl(e) };
}

export async function deleteKey(tenant: string, key: string): Promise<boolean> {
  const full = rk(tenant, key);
  if (redis) return r(async () => (await redis!.del(full)) > 0);
  return mem.delete(full);
}

export async function expireKey(tenant: string, key: string, ttlSeconds: number): Promise<boolean> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      if (ttlSeconds === 0) return (await redis!.persist(full)) === 1;
      return (await redis!.expire(full, ttlSeconds)) === 1;
    });
  }
  const e = liveEntry(full);
  if (!e) return false;
  e.expiresAt = expiryFrom(ttlSeconds);
  return true;
}

export async function ttlKey(tenant: string, key: string): Promise<number | null> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const ttl = await redis!.ttl(full);
      if (ttl === -2) return null;
      return ttl === -1 ? -1 : ttl;
    });
  }
  const e = liveEntry(full);
  if (!e) return null;
  return e.expiresAt === null ? -1 : memTtl(e);
}

export async function incrValue(tenant: string, key: string, by: number, ttlSeconds?: number): Promise<number> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const script = `
        local v = redis.call('GET', KEYS[1])
        if v == false then v = '0' end
        if tonumber(v) == nil then return redis.error_reply('NOT_A_NUMBER') end
        local out = redis.call('INCRBY', KEYS[1], ARGV[1])
        if ARGV[2] ~= '' then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
        return out`;
      const out = await redis!.eval(script, 1, full, String(by), ttlSeconds && ttlSeconds > 0 ? String(ttlSeconds) : '');
      return Number(out);
    });
  }
  const e = liveEntry(full);
  if (e && e.type !== 'string') throw new FaststoreError('wrong_type', `key holds ${e.type}, not string`);
  const raw = e ? e.value : '0';
  const current = Number(raw);
  if (raw === '' || Number.isNaN(current)) throw new FaststoreError('not_a_number', `key '${key}' does not hold a number`);
  const next = current + by;
  mem.set(full, { type: 'string', value: enc(next), expiresAt: ttlSeconds !== undefined ? expiryFrom(ttlSeconds) : (e?.expiresAt ?? null) });
  return next;
}

// ---------------------------------------------------------------------------
// Scanning and stats
// ---------------------------------------------------------------------------

function escapeGlob(s: string): string {
  return s.replace(/([*?[\]\\])/g, '\\$1');
}

async function allTenantKeys(tenant: string, prefix = ''): Promise<{ keys: string[]; truncated: boolean }> {
  const base = tPrefix(tenant);
  if (redis) {
    const pattern = `${base}${escapeGlob(prefix)}*`;
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await r(() => redis!.scan(cursor, 'MATCH', pattern, 'COUNT', '500'));
      cursor = String(next);
      for (const k of batch) {
        if (typeof k !== 'string') continue;
        out.push(k);
        if (out.length >= MAX_SCAN_KEYS) return { keys: out.sort(), truncated: true };
      }
    } while (cursor !== '0');
    return { keys: out.sort(), truncated: false };
  }
  purgeExpired();
  const out = [...mem.keys()].filter((k) => k.startsWith(base) && k.slice(base.length).startsWith(prefix)).sort();
  return { keys: out.slice(0, MAX_SCAN_KEYS), truncated: out.length > MAX_SCAN_KEYS };
}

async function metaFor(tenant: string, full: string, key: string): Promise<ScannedKey | null> {
  if (redis) {
    const type = (await redis.type(full)) as string;
    if (type === 'none') return null;
    const ttl = await redis.ttl(full);
    const mapped: FaststoreType = type === 'string' || type === 'hash' || type === 'list' || type === 'set' || type === 'zset' ? type : 'string';
    return { key, type: mapped, ttlSeconds: ttl < 0 ? null : ttl };
  }
  const e = liveEntry(full);
  if (!e) return null;
  return { key, type: e.type, ttlSeconds: memTtl(e) };
}

export async function scanKeys(
  tenant: string,
  opts: { prefix?: string; limit: number; cursor?: string },
): Promise<ScanResult> {
  const { keys, truncated } = await allTenantKeys(tenant, opts.prefix || '');
  const offset = Math.max(0, Number(opts.cursor || 0) || 0);
  const page = keys.slice(offset, offset + opts.limit);
  const base = tPrefix(tenant);
  const metas = await Promise.all(page.map(async (full) => {
    try {
      return await metaFor(tenant, full, full.slice(base.length));
    } catch {
      return null;
    }
  }));
  const next = offset + page.length;
  return {
    keys: metas.filter((m): m is ScannedKey => !!m),
    cursor: next < keys.length ? String(next) : null,
    truncated,
  };
}

export async function tenantStats(tenant: string): Promise<{ keys: number; byType: Record<FaststoreType, number> }> {
  const byType: Record<FaststoreType, number> = { string: 0, hash: 0, list: 0, set: 0, zset: 0 };
  const { keys } = await allTenantKeys(tenant);
  const base = tPrefix(tenant);
  for (const full of keys) {
    try {
      const meta = await metaFor(tenant, full, full.slice(base.length));
      if (meta) byType[meta.type] += 1;
    } catch { /* ignore vanishing keys */ }
  }
  return { keys: Object.values(byType).reduce((a, b) => a + b, 0), byType };
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

export async function hSetFields(
  tenant: string,
  key: string,
  values: Record<string, unknown>,
  opts: WriteOptions = {},
): Promise<{ created: boolean }> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const existed = (await redis!.exists(full)) === 1;
      if (opts.ifNotExists && existed) throw new FaststoreError('key_exists', `key '${key}' already exists`);
      if (opts.ifExists && !existed) throw new FaststoreError('not_found', `key '${key}' not found`);
      const encoded: Record<string, string> = {};
      for (const [f, v] of Object.entries(values)) encoded[f] = enc(v);
      await redis!.hset(full, encoded);
      if (opts.ttlSeconds !== undefined) {
        if (opts.ttlSeconds > 0) await redis!.expire(full, opts.ttlSeconds);
        else await redis!.persist(full);
      }
      return { created: !existed };
    });
  }
  const existing = liveEntry(full);
  if (opts.ifNotExists && existing) throw new FaststoreError('key_exists', `key '${key}' already exists`);
  if (opts.ifExists && !existing) throw new FaststoreError('not_found', `key '${key}' not found`);
  const entry = existing ? expectType(existing, 'hash')! : { type: 'hash' as const, value: new Map<string, string>(), expiresAt: null };
  for (const [f, v] of Object.entries(values)) entry.value.set(f, enc(v));
  if (opts.ttlSeconds !== undefined) entry.expiresAt = expiryFrom(opts.ttlSeconds);
  mem.set(full, entry);
  return { created: !existing };
}

export async function hGetAll(tenant: string, key: string): Promise<{ values: Record<string, unknown>; ttlSeconds: number | null } | null> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return null;
      if (type !== 'hash') throw new FaststoreError('wrong_type', `key holds ${type}, not hash`);
      const raw = await redis!.hgetall(full);
      const ttl = await redis!.ttl(full);
      return { values: decodeObject(raw), ttlSeconds: ttl < 0 ? null : ttl };
    });
  }
  const e = expectType(liveEntry(full), 'hash');
  if (!e) return null;
  return { values: Object.fromEntries([...e.value].map(([k, v]) => [k, dec(v)])), ttlSeconds: memTtl(e) };
}

export async function hGetField(tenant: string, key: string, field: string): Promise<{ found: boolean; value?: unknown; ttlSeconds: number | null }> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return { found: false, ttlSeconds: null };
      if (type !== 'hash') throw new FaststoreError('wrong_type', `key holds ${type}, not hash`);
      const raw = await redis!.hget(full, field);
      const ttl = await redis!.ttl(full);
      return { found: raw !== null && raw !== undefined, value: raw === null || raw === undefined ? undefined : dec(raw), ttlSeconds: ttl < 0 ? null : ttl };
    });
  }
  const e = expectType(liveEntry(full), 'hash');
  if (!e) return { found: false, ttlSeconds: null };
  const raw = e.value.get(field);
  return { found: raw !== undefined, value: raw === undefined ? undefined : dec(raw), ttlSeconds: memTtl(e) };
}

export async function hDelField(tenant: string, key: string, field: string): Promise<boolean> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return false;
      if (type !== 'hash') throw new FaststoreError('wrong_type', `key holds ${type}, not hash`);
      return (await redis!.hdel(full, field)) > 0;
    });
  }
  const e = expectType(liveEntry(full), 'hash');
  if (!e) return false;
  const ok = e.value.delete(field);
  if (!e.value.size) mem.delete(full);
  return ok;
}

export async function hIncrField(
  tenant: string,
  key: string,
  field: string,
  by: number,
  ttlSeconds?: number,
): Promise<number> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const out = await redis!.hincrby(full, field, by);
      if (ttlSeconds !== undefined) {
        if (ttlSeconds > 0) await redis!.expire(full, ttlSeconds);
        else await redis!.persist(full);
      }
      return out;
    });
  }
  const existing = liveEntry(full);
  const e = existing ? expectType(existing, 'hash')! : { type: 'hash' as const, value: new Map<string, string>(), expiresAt: null };
  const raw = e.value.get(field) ?? '0';
  const current = Number(raw);
  if (Number.isNaN(current)) throw new FaststoreError('not_a_number', `field '${field}' does not hold a number`);
  const next = current + by;
  e.value.set(field, enc(next));
  if (ttlSeconds !== undefined) e.expiresAt = expiryFrom(ttlSeconds);
  mem.set(full, e);
  return next;
}

export async function hLen(tenant: string, key: string): Promise<number> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return 0;
      if (type !== 'hash') throw new FaststoreError('wrong_type', `key holds ${type}, not hash`);
      return redis!.hlen(full);
    });
  }
  const e = expectType(liveEntry(full), 'hash');
  return e ? e.value.size : 0;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export async function lPush(
  tenant: string,
  key: string,
  values: unknown[],
  side: 'left' | 'right' = 'right',
  ttlSeconds?: number,
): Promise<number> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const args = values.map(enc);
      const len = side === 'left' ? await redis!.lpush(full, ...args) : await redis!.rpush(full, ...args);
      if (ttlSeconds !== undefined) {
        if (ttlSeconds > 0) await redis!.expire(full, ttlSeconds);
        else await redis!.persist(full);
      }
      return len;
    });
  }
  const existing = liveEntry(full);
  const e = existing ? expectType(existing, 'list')! : { type: 'list' as const, value: [] as string[], expiresAt: null };
  const encoded = values.map(enc);
  if (side === 'left') e.value.unshift(...encoded.reverse());
  else e.value.push(...encoded);
  if (ttlSeconds !== undefined) e.expiresAt = expiryFrom(ttlSeconds);
  mem.set(full, e);
  return e.value.length;
}

export async function lPop(tenant: string, key: string, side: 'left' | 'right' = 'left', count = 1): Promise<unknown[]> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return [];
      if (type !== 'list') throw new FaststoreError('wrong_type', `key holds ${type}, not list`);
      const raw = side === 'left'
        ? await (redis as any).lpop(full, count)
        : await (redis as any).rpop(full, count);
      if (raw === null || raw === undefined) return [];
      const list: string[] = Array.isArray(raw) ? raw : [raw];
      return list.map(dec);
    });
  }
  const e = expectType(liveEntry(full), 'list');
  if (!e) return [];
  let out: string[];
  if (side === 'left') out = e.value.splice(0, count);
  else out = e.value.splice(Math.max(0, e.value.length - count), count);
  if (!e.value.length) mem.delete(full);
  return out.map(dec);
}

export async function lRange(tenant: string, key: string, start: number, stop: number): Promise<unknown[]> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return [];
      if (type !== 'list') throw new FaststoreError('wrong_type', `key holds ${type}, not list`);
      return (await redis!.lrange(full, start, stop)).map(dec);
    });
  }
  const e = expectType(liveEntry(full), 'list');
  if (!e) return [];
  return e.value.slice(start, stop === -1 ? undefined : stop + 1).map(dec);
}

export async function lLen(tenant: string, key: string): Promise<number> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return 0;
      if (type !== 'list') throw new FaststoreError('wrong_type', `key holds ${type}, not list`);
      return redis!.llen(full);
    });
  }
  const e = expectType(liveEntry(full), 'list');
  return e ? e.value.length : 0;
}

export async function lTrim(tenant: string, key: string, start: number, stop: number): Promise<boolean> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return false;
      if (type !== 'list') throw new FaststoreError('wrong_type', `key holds ${type}, not list`);
      await redis!.ltrim(full, start, stop);
      return true;
    });
  }
  const e = expectType(liveEntry(full), 'list');
  if (!e) return false;
  e.value = e.value.slice(start, stop === -1 ? undefined : stop + 1);
  if (!e.value.length) mem.delete(full);
  return true;
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

export async function sAdd(tenant: string, key: string, members: unknown[], ttlSeconds?: number): Promise<number> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const added = await redis!.sadd(full, ...members.map(enc));
      if (ttlSeconds !== undefined) {
        if (ttlSeconds > 0) await redis!.expire(full, ttlSeconds);
        else await redis!.persist(full);
      }
      return added;
    });
  }
  const existing = liveEntry(full);
  const e = existing ? expectType(existing, 'set')! : { type: 'set' as const, value: new Set<string>(), expiresAt: null };
  let added = 0;
  for (const m of members.map(enc)) {
    if (!e.value.has(m)) {
      e.value.add(m);
      added += 1;
    }
  }
  if (ttlSeconds !== undefined) e.expiresAt = expiryFrom(ttlSeconds);
  mem.set(full, e);
  return added;
}

export async function sRem(tenant: string, key: string, members: unknown[]): Promise<number> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return 0;
      if (type !== 'set') throw new FaststoreError('wrong_type', `key holds ${type}, not set`);
      return redis!.srem(full, ...members.map(enc));
    });
  }
  const e = expectType(liveEntry(full), 'set');
  if (!e) return 0;
  let removed = 0;
  for (const m of members.map(enc)) if (e.value.delete(m)) removed += 1;
  if (!e.value.size) mem.delete(full);
  return removed;
}

export async function sMembers(tenant: string, key: string): Promise<unknown[]> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return [];
      if (type !== 'set') throw new FaststoreError('wrong_type', `key holds ${type}, not set`);
      return (await redis!.smembers(full)).map(dec).sort();
    });
  }
  const e = expectType(liveEntry(full), 'set');
  return e ? [...e.value].map(dec).sort() : [];
}

export async function sIsMember(tenant: string, key: string, member: unknown): Promise<boolean> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return false;
      if (type !== 'set') throw new FaststoreError('wrong_type', `key holds ${type}, not set`);
      return (await redis!.sismember(full, enc(member))) === 1;
    });
  }
  const e = expectType(liveEntry(full), 'set');
  return !!e && e.value.has(enc(member));
}

export async function sCard(tenant: string, key: string): Promise<number> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return 0;
      if (type !== 'set') throw new FaststoreError('wrong_type', `key holds ${type}, not set`);
      return redis!.scard(full);
    });
  }
  const e = expectType(liveEntry(full), 'set');
  return e ? e.value.size : 0;
}

// ---------------------------------------------------------------------------
// Sorted sets
// ---------------------------------------------------------------------------

export interface ZMember {
  member: unknown;
  score: number;
}

export async function zAdd(tenant: string, key: string, members: ZMember[], ttlSeconds?: number): Promise<number> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const args: (string | number)[] = [];
      for (const m of members) args.push(m.score, enc(m.member));
      const added = await (redis as any).zadd(full, ...args);
      if (ttlSeconds !== undefined) {
        if (ttlSeconds > 0) await redis!.expire(full, ttlSeconds);
        else await redis!.persist(full);
      }
      return Number(added);
    });
  }
  const existing = liveEntry(full);
  const e = existing ? expectType(existing, 'zset')! : { type: 'zset' as const, value: new Map<string, number>(), expiresAt: null };
  let added = 0;
  for (const m of members) {
    const encoded = enc(m.member);
    if (!e.value.has(encoded)) added += 1;
    e.value.set(encoded, m.score);
  }
  if (ttlSeconds !== undefined) e.expiresAt = expiryFrom(ttlSeconds);
  mem.set(full, e);
  return added;
}

export async function zRem(tenant: string, key: string, members: unknown[]): Promise<number> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return 0;
      if (type !== 'zset') throw new FaststoreError('wrong_type', `key holds ${type}, not zset`);
      return redis!.zrem(full, ...members.map(enc));
    });
  }
  const e = expectType(liveEntry(full), 'zset');
  if (!e) return 0;
  let removed = 0;
  for (const m of members.map(enc)) if (e.value.delete(m)) removed += 1;
  if (!e.value.size) mem.delete(full);
  return removed;
}

function parseZRange(raw: unknown[]): ZMember[] {
  const out: ZMember[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    out.push({ member: dec(String(raw[i])), score: Number(raw[i + 1]) });
  }
  return out;
}

export async function zRange(
  tenant: string,
  key: string,
  start: number,
  stop: number,
  opts: { rev?: boolean; withScores?: boolean } = {},
): Promise<ZMember[] | unknown[]> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return [];
      if (type !== 'zset') throw new FaststoreError('wrong_type', `key holds ${type}, not zset`);
      const args: (string | number)[] = [full, start, stop];
      if (opts.rev) args.push('REV');
      if (opts.withScores) args.push('WITHSCORES');
      const raw = await (redis as any).zrange(...args) as string[];
      return opts.withScores ? parseZRange(raw) : raw.map(dec);
    });
  }
  const e = expectType(liveEntry(full), 'zset');
  if (!e) return [];
  const sorted = [...e.value.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  if (opts.rev) sorted.reverse();
  const page = sorted.slice(start, stop === -1 ? undefined : stop + 1);
  return opts.withScores ? page.map(([member, score]) => ({ member: dec(member), score })) : page.map(([member]) => dec(member));
}

export async function zScore(tenant: string, key: string, member: unknown): Promise<number | null> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return null;
      if (type !== 'zset') throw new FaststoreError('wrong_type', `key holds ${type}, not zset`);
      const raw = await redis!.zscore(full, enc(member));
      return raw === null ? null : Number(raw);
    });
  }
  const e = expectType(liveEntry(full), 'zset');
  return e?.value.get(enc(member)) ?? null;
}

export async function zRank(tenant: string, key: string, member: unknown, rev = false): Promise<number | null> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return null;
      if (type !== 'zset') throw new FaststoreError('wrong_type', `key holds ${type}, not zset`);
      const raw = rev ? await redis!.zrevrank(full, enc(member)) : await redis!.zrank(full, enc(member));
      return raw === null ? null : raw;
    });
  }
  const e = expectType(liveEntry(full), 'zset');
  if (!e) return null;
  const sorted = [...e.value.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  if (rev) sorted.reverse();
  const idx = sorted.findIndex(([m]) => m === enc(member));
  return idx === -1 ? null : idx;
}

export async function zIncrBy(tenant: string, key: string, member: unknown, by: number, ttlSeconds?: number): Promise<number> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const out = await redis!.zincrby(full, by, enc(member));
      if (ttlSeconds !== undefined) {
        if (ttlSeconds > 0) await redis!.expire(full, ttlSeconds);
        else await redis!.persist(full);
      }
      return Number(out);
    });
  }
  const existing = liveEntry(full);
  const e = existing ? expectType(existing, 'zset')! : { type: 'zset' as const, value: new Map<string, number>(), expiresAt: null };
  const encoded = enc(member);
  const next = (e.value.get(encoded) ?? 0) + by;
  e.value.set(encoded, next);
  if (ttlSeconds !== undefined) e.expiresAt = expiryFrom(ttlSeconds);
  mem.set(full, e);
  return next;
}

export async function zCard(tenant: string, key: string): Promise<number> {
  const full = rk(tenant, key);
  if (redis) {
    return r(async () => {
      const type = await redis!.type(full);
      if (type === 'none') return 0;
      if (type !== 'zset') throw new FaststoreError('wrong_type', `key holds ${type}, not zset`);
      return redis!.zcard(full);
    });
  }
  const e = expectType(liveEntry(full), 'zset');
  return e ? e.value.size : 0;
}

// ---------------------------------------------------------------------------
// Distributed locks
// ---------------------------------------------------------------------------

const RELEASE_LOCK = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0`;

const EXTEND_LOCK = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0`;

export async function acquireLock(tenant: string, name: string, token: string, ttlMs: number): Promise<boolean> {
  const full = lockKey(tenant, name);
  if (redis) {
    return r(async () => (await (redis as any).set(full, token, 'PX', String(ttlMs), 'NX')) === 'OK');
  }
  const now = Date.now();
  const existing = memLocks.get(full);
  if (existing && existing.expiresAt > now) return false;
  memLocks.set(full, { token, expiresAt: now + ttlMs });
  return true;
}

export async function releaseLock(tenant: string, name: string, token: string): Promise<boolean> {
  const full = lockKey(tenant, name);
  if (redis) return r(async () => Number(await redis!.eval(RELEASE_LOCK, 1, full, token)) === 1);
  const existing = memLocks.get(full);
  if (!existing || existing.token !== token || existing.expiresAt <= Date.now()) {
    if (existing && existing.expiresAt <= Date.now()) memLocks.delete(full);
    return false;
  }
  memLocks.delete(full);
  return true;
}

export async function extendLock(tenant: string, name: string, token: string, ttlMs: number): Promise<boolean> {
  const full = lockKey(tenant, name);
  if (redis) return r(async () => Number(await redis!.eval(EXTEND_LOCK, 1, full, token, String(ttlMs))) === 1);
  const existing = memLocks.get(full);
  if (!existing || existing.token !== token || existing.expiresAt <= Date.now()) {
    if (existing && existing.expiresAt <= Date.now()) memLocks.delete(full);
    return false;
  }
  existing.expiresAt = Date.now() + ttlMs;
  return true;
}

export function newLockToken(): string {
  return randomUUID();
}

function decodeObject(raw: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, dec(v)]));
}
