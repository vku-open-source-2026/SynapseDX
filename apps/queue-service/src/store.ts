/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseQueue persistence — Redis (sorted sets + hashes + Lua) in
 * production, in-memory fallback for development and tests.
 *
 * Delivery semantics are at-least-once: consuming leases a message for a
 * visibility timeout and returns a receipt. Ack removes it; nack (or an
 * expired lease) makes it available again. Messages that exhaust max attempts
 * move to the dead-letter set and can be replayed.
 */
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

export type QueueErrorCode = 'not_found' | 'conflict' | 'invalid' | 'storage_unavailable';

export class QueueError extends Error {
  code: QueueErrorCode;
  constructor(code: QueueErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'QueueError';
  }
}

export interface QueueConfig {
  name: string;
  maxAttempts: number;
  visibilityTimeoutSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface InternalMessage {
  id: string;
  payload: unknown;
  headers?: Record<string, unknown>;
  published_at: number;
  available_at?: number;
  attempts: number;
  max_attempts: number;
  dedupe_key?: string;
  last_error?: string;
  dead: boolean;
  dead_at?: number;
  consumer?: string;
}

export interface ConsumedMessage {
  message: InternalMessage;
  receipt: string;
  leaseExpiresAt: number;
}

export interface PublishInput {
  id?: string;
  payload: unknown;
  headers?: Record<string, unknown>;
  delaySeconds?: number;
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface PublishResult {
  id: string;
  duplicate: boolean;
  message: InternalMessage;
}

export interface NackResult {
  id: string;
  state: 'retry' | 'dead';
  attempts: number;
  availableAt?: number;
  deadAt?: number;
}

export interface QueueStats {
  queue: string;
  pending: number;
  inflight: number;
  dead: number;
  published: number;
  acked: number;
  retried: number;
  replayed: number;
  maxAttempts: number;
  visibilityTimeoutSeconds: number;
}

interface Envelope {
  published_at: number;
  available_at?: number;
  attempts: number;
  max_attempts: number;
  dedupe_key?: string;
  last_error?: string;
  dead?: boolean;
  dead_at?: number;
  consumer?: string;
  receipt?: string;
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.QUEUE_REDIS_URL || process.env.REDIS_URL || '';
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
    client.on('error', (e: any) => console.error('[queue][redis]', e?.message || e));
    try {
      await client.connect();
      await client.ping();
      redis = client;
      console.log('[queue] connected to Redis');
      return true;
    } catch (e: any) {
      console.warn('[queue] Redis unavailable, using in-memory fallback:', e?.message || e);
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

function qPrefix(tenant: string): string {
  return `synapsedx:queue:v1:${tenant}:`;
}

function keysFor(tenant: string, name: string) {
  const q = `${qPrefix(tenant)}q:${name}:`;
  return {
    queues: `${qPrefix(tenant)}queues`,
    meta: `${q}meta`,
    messages: `${q}messages`,
    payloads: `${q}payloads`,
    headers: `${q}headers`,
    pending: `${q}pending`,
    inflight: `${q}inflight`,
    receipts: `${q}receipts`,
    dedupe: `${q}dedupe`,
    dead: `${q}dead`,
    prefix: q,
  };
}

const QUEUE_PREFIX = 'synapsedx:queue:v1:';

function mapRedisError(e: any): never {
  if (e instanceof QueueError) throw e;
  const msg = String(e?.message || e || 'redis error');
  if (/ECONNREFUSED|ECONNRESET|NR_CLOSED|Connection is closed|READONLY/i.test(msg)) {
    throw new QueueError('storage_unavailable', 'queue backend is unavailable');
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

function toMessage(id: string, envRaw: string | null, payloadRaw: string | null, headersRaw: string | null): InternalMessage | null {
  if (!envRaw) return null;
  let env: Envelope;
  try {
    env = JSON.parse(envRaw) as Envelope;
  } catch {
    return null;
  }
  return {
    id,
    payload: dec(payloadRaw),
    ...(headersRaw ? { headers: dec(headersRaw) as Record<string, unknown> } : {}),
    published_at: Number(env.published_at || 0),
    ...(env.available_at !== undefined ? { available_at: Number(env.available_at) } : {}),
    attempts: Number(env.attempts || 0),
    max_attempts: Number(env.max_attempts || 5),
    ...(env.dedupe_key ? { dedupe_key: env.dedupe_key } : {}),
    ...(env.last_error ? { last_error: env.last_error } : {}),
    dead: !!env.dead,
    ...(env.dead_at !== undefined ? { dead_at: Number(env.dead_at) } : {}),
    ...(env.consumer ? { consumer: env.consumer } : {}),
  };
}

function configFrom(meta: Record<string, string>, name: string): QueueConfig {
  return {
    name,
    maxAttempts: Number(meta.max_attempts || 5),
    visibilityTimeoutSeconds: Number(meta.visibility_timeout || 30),
    createdAt: Number(meta.created_at || 0),
    updatedAt: Number(meta.updated_at || 0),
  };
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

interface MemQueue {
  config: QueueConfig;
  messages: Map<string, { envelope: Envelope; payload: string; headers?: string }>;
  pending: Map<string, number>;
  inflight: Map<string, { id: string; deadline: number }>;
  receipts: Map<string, string>;
  dedupe: Map<string, string>;
  dead: Map<string, number>;
  counters: { published: number; acked: number; retried: number; dead: number; replayed: number };
  seq: number;
}

const memQueues = new Map<string, MemQueue>();

function memKey(tenant: string, name: string): string {
  return `${tenant}\u0000${name}`;
}

function ensureQueueMem(tenant: string, name: string, opts: { maxAttempts?: number; visibilityTimeoutSeconds?: number } = {}): MemQueue {
  const key = memKey(tenant, name);
  const now = Date.now();
  let q = memQueues.get(key);
  if (!q) {
    q = {
      config: {
        name,
        maxAttempts: opts.maxAttempts ?? 5,
        visibilityTimeoutSeconds: opts.visibilityTimeoutSeconds ?? 30,
        createdAt: now,
        updatedAt: now,
      },
      messages: new Map(),
      pending: new Map(),
      inflight: new Map(),
      receipts: new Map(),
      dedupe: new Map(),
      dead: new Map(),
      counters: { published: 0, acked: 0, retried: 0, dead: 0, replayed: 0 },
      seq: 0,
    };
    memQueues.set(key, q);
  } else if (opts.maxAttempts !== undefined || opts.visibilityTimeoutSeconds !== undefined) {
    if (opts.maxAttempts !== undefined) q.config.maxAttempts = opts.maxAttempts;
    if (opts.visibilityTimeoutSeconds !== undefined) q.config.visibilityTimeoutSeconds = opts.visibilityTimeoutSeconds;
    q.config.updatedAt = now;
  }
  return q;
}

function memMessage(q: MemQueue, id: string): InternalMessage | null {
  const row = q.messages.get(id);
  if (!row) return null;
  return toMessage(id, JSON.stringify(row.envelope), row.payload, row.headers ?? null);
}

export function __clearQueueMem(): void {
  memQueues.clear();
}

// ---------------------------------------------------------------------------
// Queue metadata
// ---------------------------------------------------------------------------

export async function ensureQueue(
  tenant: string,
  name: string,
  opts: { maxAttempts?: number; visibilityTimeoutSeconds?: number } = {},
): Promise<QueueConfig> {
  if (!redis) return ensureQueueMem(tenant, name, opts).config;
  const k = keysFor(tenant, name);
  return r(async () => {
    const now = Date.now();
    const exists = (await redis!.exists(k.meta)) === 1;
    if (!exists) {
      await redis!.hset(k.meta, {
        max_attempts: String(opts.maxAttempts ?? 5),
        visibility_timeout: String(opts.visibilityTimeoutSeconds ?? 30),
        created_at: String(now),
        updated_at: String(now),
        published: '0',
        acked: '0',
        retried: '0',
        dead: '0',
        replayed: '0',
        receipt_seq: '0',
      });
    } else if (opts.maxAttempts !== undefined || opts.visibilityTimeoutSeconds !== undefined) {
      const update: Record<string, string> = { updated_at: String(now) };
      if (opts.maxAttempts !== undefined) update.max_attempts = String(opts.maxAttempts);
      if (opts.visibilityTimeoutSeconds !== undefined) update.visibility_timeout = String(opts.visibilityTimeoutSeconds);
      await redis!.hset(k.meta, update);
    }
    await redis!.sadd(k.queues, name);
    const meta = await redis!.hgetall(k.meta);
    return configFrom(meta, name);
  });
}

export async function getQueue(tenant: string, name: string): Promise<QueueConfig | null> {
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name));
    return q ? { ...q.config } : null;
  }
  const k = keysFor(tenant, name);
  return r(async () => {
    const meta = await redis!.hgetall(k.meta);
    if (!meta || !Object.keys(meta).length) return null;
    return configFrom(meta, name);
  });
}

export async function listQueues(tenant: string): Promise<QueueConfig[]> {
  if (!redis) {
    const prefix = `${tenant}\u0000`;
    return [...memQueues.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, q]) => ({ ...q.config }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const prefix = qPrefix(tenant);
  return r(async () => {
    const names = await redis!.smembers(`${prefix}queues`);
    const configs = await Promise.all(names.map(async (name) => {
      const meta = await redis!.hgetall(keysFor(tenant, name).meta);
      return Object.keys(meta).length ? configFrom(meta, name) : null;
    }));
    return configs.filter((c): c is QueueConfig => !!c).sort((a, b) => a.name.localeCompare(b.name));
  });
}

export async function deleteQueue(tenant: string, name: string): Promise<boolean> {
  if (!redis) return memQueues.delete(memKey(tenant, name));
  const k = keysFor(tenant, name);
  return r(async () => {
    const found = (await redis!.exists(k.meta)) === 1;
    const keys = await scanKeys(`${k.prefix}*`);
    if (keys.length) await redis!.del(...keys);
    await redis!.srem(k.queues, name);
    return found;
  });
}

export async function purgeQueue(tenant: string, name: string): Promise<boolean> {
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name));
    if (!q) return false;
    q.messages.clear();
    q.pending.clear();
    q.inflight.clear();
    q.receipts.clear();
    q.dedupe.clear();
    q.dead.clear();
    q.counters = { published: 0, acked: 0, retried: 0, dead: 0, replayed: 0 };
    q.seq = 0;
    q.config.updatedAt = Date.now();
    return true;
  }
  const k = keysFor(tenant, name);
  return r(async () => {
    if ((await redis!.exists(k.meta)) !== 1) return false;
    await redis!.del(k.messages, k.payloads, k.headers, k.pending, k.inflight, k.receipts, k.dedupe, k.dead);
    await redis!.hset(k.meta, { published: '0', acked: '0', retried: '0', dead: '0', replayed: '0', receipt_seq: '0', updated_at: String(Date.now()) });
    return true;
  });
}

async function scanKeys(pattern: string): Promise<string[]> {
  if (!redis) return [];
  const out: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await r(() => redis!.scan(cursor, 'MATCH', pattern, 'COUNT', '500'));
    cursor = String(next);
    for (const key of batch) out.push(key);
  } while (cursor !== '0');
  return out;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

const PUBLISH_LUA = `
  if ARGV[3] ~= '' then
    local existing = redis.call('HGET', KEYS[4], ARGV[3])
    if existing and redis.call('HEXISTS', KEYS[1], existing) == 1 then
      return {existing, '1'}
    end
  end
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[6])
  if ARGV[7] ~= '' then redis.call('HSET', KEYS[3], ARGV[1], ARGV[7]) end
  redis.call('ZADD', KEYS[5], ARGV[4], ARGV[1])
  if ARGV[3] ~= '' then redis.call('HSET', KEYS[4], ARGV[3], ARGV[1]) end
  redis.call('HINCRBY', KEYS[6], 'published', 1)
  redis.call('SADD', KEYS[7], ARGV[5])
  return {ARGV[1], '0'}
`;

export async function publishMessage(tenant: string, name: string, input: PublishInput): Promise<PublishResult> {
  const config = await ensureQueue(tenant, name);
  const now = Date.now();
  const delayMs = Math.max(0, Math.round((input.delaySeconds || 0) * 1000));
  const availableAt = now + delayMs;
  const maxAttempts = input.maxAttempts ?? config.maxAttempts;
  const id = input.id || randomUUID();

  if (!redis) {
    const q = ensureQueueMem(tenant, name);
    if (input.dedupeKey) {
      const existing = q.dedupe.get(input.dedupeKey);
      if (existing && q.messages.has(existing)) {
        return { id: existing, duplicate: true, message: memMessage(q, existing)! };
      }
    }
    if (q.messages.has(id)) throw new QueueError('conflict', `message '${id}' already exists`);
    const envelope: Envelope = {
      published_at: now,
      available_at: availableAt,
      attempts: 0,
      max_attempts: maxAttempts,
      ...(input.dedupeKey ? { dedupe_key: input.dedupeKey } : {}),
    };
    q.messages.set(id, { envelope, payload: enc(input.payload), ...(input.headers ? { headers: enc(input.headers) } : {}) });
    q.pending.set(id, availableAt);
    if (input.dedupeKey) q.dedupe.set(input.dedupeKey, id);
    q.counters.published += 1;
    return { id, duplicate: false, message: memMessage(q, id)! };
  }

  const k = keysFor(tenant, name);
  const envelope: Envelope = {
    published_at: now,
    available_at: availableAt,
    attempts: 0,
    max_attempts: maxAttempts,
    ...(input.dedupeKey ? { dedupe_key: input.dedupeKey } : {}),
  };
  const out = await r(async () => {
    const res = await (redis as any).eval(
      PUBLISH_LUA, 7,
      k.messages, k.payloads, k.headers, k.dedupe, k.pending, k.meta, k.queues,
      id, JSON.stringify(envelope), input.dedupeKey || '', String(availableAt), name,
      enc(input.payload), input.headers ? enc(input.headers) : '',
    ) as [string, string];
    return res;
  });
  const resultId = String(out?.[0] || id);
  const duplicate = String(out?.[1] || '0') === '1';
  const message = duplicate ? await getMessage(tenant, name, resultId) : await getMessage(tenant, name, id);
  if (!message) throw new QueueError('conflict', 'message could not be read after publish');
  return { id: resultId, duplicate, message };
}

async function getMessage(tenant: string, name: string, id: string): Promise<InternalMessage | null> {
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name));
    return q ? memMessage(q, id) : null;
  }
  const k = keysFor(tenant, name);
  return r(async () => {
    const [env, payload, headers] = await Promise.all([
      redis!.hget(k.messages, id),
      redis!.hget(k.payloads, id),
      redis!.hget(k.headers, id),
    ]);
    return toMessage(id, env, payload, headers);
  });
}

async function loadMessages(tenant: string, name: string, ids: string[]): Promise<InternalMessage[]> {
  if (!ids.length) return [];
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name));
    if (!q) return [];
    return ids.map((id) => memMessage(q, id)).filter((m): m is InternalMessage => !!m);
  }
  const k = keysFor(tenant, name);
  return r(async () => {
    const [envs, payloads, headers] = await Promise.all([
      redis!.hmget(k.messages, ...ids),
      redis!.hmget(k.payloads, ...ids),
      redis!.hmget(k.headers, ...ids),
    ]);
    return ids
      .map((id, i) => toMessage(id, envs[i], payloads[i], headers[i]))
      .filter((m): m is InternalMessage => !!m);
  });
}

// ---------------------------------------------------------------------------
// Consume, ack, nack, heartbeat
// ---------------------------------------------------------------------------

/**
 * Move leases whose visibility deadline passed back to the pending set. This
 * is what makes at-least-once delivery work when a consumer crashes without
 * nacking: the next consume/stats/peek call reclaims the expired receipt.
 */
export async function reclaimExpired(tenant: string, name: string, now = Date.now()): Promise<number> {
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name));
    if (!q) return 0;
    let reclaimed = 0;
    for (const [receipt, entry] of [...q.inflight.entries()]) {
      if (entry.deadline > now) continue;
      reclaimed += 1;
      q.inflight.delete(receipt);
      q.receipts.delete(receipt);
      const row = q.messages.get(entry.id);
      if (!row || row.envelope.dead) continue;
      delete row.envelope.receipt;
      delete row.envelope.consumer;
      row.envelope.available_at = now;
      q.pending.set(entry.id, now);
    }
    return reclaimed;
  }
  const k = keysFor(tenant, name);
  return r(async () => {
    const script = `
      local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
      for _, receipt in ipairs(expired) do
        local id = redis.call('HGET', KEYS[2], receipt)
        redis.call('ZREM', KEYS[1], receipt)
        redis.call('HDEL', KEYS[2], receipt)
        if id then
          local raw = redis.call('HGET', KEYS[3], id)
          if raw then
            local env = cjson.decode(raw)
            if not env.dead then
              env.receipt = nil
              env.consumer = nil
              env.available_at = tonumber(ARGV[1])
              redis.call('HSET', KEYS[3], id, cjson.encode(env))
              redis.call('ZADD', KEYS[4], ARGV[1], id)
            end
          end
        end
      end
      return #expired`;
    return Number(await (redis as any).eval(
      script, 4, k.inflight, k.receipts, k.messages, k.pending, String(now),
    ));
  });
}

const CONSUME_LUA = `
  local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
  local out = {}
  for _, id in ipairs(ids) do
    local raw = redis.call('HGET', KEYS[2], id)
    if raw then
      redis.call('ZREM', KEYS[1], id)
      local env = cjson.decode(raw)
      env.attempts = (env.attempts or 0) + 1
      env.available_at = nil
      local seq = redis.call('HINCRBY', KEYS[5], 'receipt_seq', 1)
      local receipt = id .. ':' .. seq
      env.receipt = receipt
      env.consumer = ARGV[4]
      local deadline = tonumber(ARGV[1]) + tonumber(ARGV[3])
      redis.call('HSET', KEYS[2], id, cjson.encode(env))
      redis.call('ZADD', KEYS[3], deadline, receipt)
      redis.call('HSET', KEYS[4], receipt, id)
      table.insert(out, {id, receipt, tostring(deadline)})
    else
      redis.call('ZREM', KEYS[1], id)
    end
  end
  return out
`;

export async function consumeMessages(
  tenant: string,
  name: string,
  opts: { maxMessages: number; visibilityTimeoutSeconds: number; consumer?: string },
): Promise<ConsumedMessage[]> {
  const config = await ensureQueue(tenant, name);
  const now = Date.now();
  await reclaimExpired(tenant, name, now);
  if (!redis) {
    const q = ensureQueueMem(tenant, name);
    const ready = [...q.pending.entries()]
      .filter(([, at]) => at <= now)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, opts.maxMessages);
    const out: ConsumedMessage[] = [];
    for (const [id] of ready) {
      q.pending.delete(id);
      const row = q.messages.get(id);
      if (!row) continue;
      row.envelope.attempts = (row.envelope.attempts || 0) + 1;
      delete row.envelope.available_at;
      q.seq += 1;
      const receipt = `${id}:${q.seq}`;
      const deadline = now + opts.visibilityTimeoutSeconds * 1000;
      row.envelope.receipt = receipt;
      row.envelope.consumer = opts.consumer || 'consumer';
      q.inflight.set(receipt, { id, deadline });
      q.receipts.set(receipt, id);
      const message = memMessage(q, id);
      if (message) out.push({ message, receipt, leaseExpiresAt: deadline });
    }
    return out;
  }
  const k = keysFor(tenant, name);
  const raw = await r(async () => (redis as any).eval(
    CONSUME_LUA, 5,
    k.pending, k.messages, k.inflight, k.receipts, k.meta,
    String(now), String(opts.maxMessages), String(opts.visibilityTimeoutSeconds * 1000), opts.consumer || 'consumer',
  ) as string[][]);
  const rows = Array.isArray(raw) ? raw : [];
  const ids = rows.map((row) => String(row[0]));
  const messages = await loadMessages(tenant, name, ids);
  const byId = new Map(messages.map((m) => [m.id, m]));
  return rows
    .map((row) => {
      const id = String(row[0]);
      const message = byId.get(id);
      if (!message) return null;
      return { message, receipt: String(row[1]), leaseExpiresAt: Number(row[2]) };
    })
    .filter((m): m is ConsumedMessage => !!m);
}

const ACK_LUA = `
  local id = redis.call('HGET', KEYS[4], ARGV[1])
  if not id then return '' end
  redis.call('HDEL', KEYS[4], ARGV[1])
  redis.call('ZREM', KEYS[5], ARGV[1])
  redis.call('HDEL', KEYS[1], id)
  redis.call('HDEL', KEYS[2], id)
  redis.call('HDEL', KEYS[3], id)
  redis.call('HINCRBY', KEYS[6], 'acked', 1)
  return id
`;

export async function ackMessage(tenant: string, name: string, receipt: string): Promise<string | null> {
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name));
    if (!q) return null;
    const id = q.receipts.get(receipt);
    if (!id) return null;
    q.receipts.delete(receipt);
    q.inflight.delete(receipt);
    q.messages.delete(id);
    q.counters.acked += 1;
    return id;
  }
  const k = keysFor(tenant, name);
  return r(async () => {
    const id = String(await (redis as any).eval(
      ACK_LUA, 6,
      k.messages, k.payloads, k.headers, k.receipts, k.inflight, k.meta,
      receipt,
    ) || '');
    return id || null;
  });
}

const NACK_LUA = `
  local id = redis.call('HGET', KEYS[2], ARGV[1])
  if not id then return {} end
  local raw = redis.call('HGET', KEYS[1], id)
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[3], ARGV[1])
  if not raw then return {} end
  local env = cjson.decode(raw)
  env.receipt = nil
  env.consumer = nil
  if ARGV[4] ~= '' then env.last_error = ARGV[4] end
  local max = tonumber(env.max_attempts or 5)
  if ARGV[5] == '0' or (env.attempts or 0) >= max then
    env.dead = true
    env.dead_at = tonumber(ARGV[2])
    redis.call('HSET', KEYS[1], id, cjson.encode(env))
    redis.call('ZADD', KEYS[5], ARGV[2], id)
    redis.call('HINCRBY', KEYS[6], 'dead', 1)
    return {id, 'dead', tostring(env.attempts or 0), ARGV[2]}
  else
    local available = tonumber(ARGV[2]) + tonumber(ARGV[3])
    env.available_at = available
    redis.call('HSET', KEYS[1], id, cjson.encode(env))
    redis.call('ZADD', KEYS[4], available, id)
    redis.call('HINCRBY', KEYS[6], 'retried', 1)
    return {id, 'retry', tostring(env.attempts or 0), tostring(available)}
  end
`;

export async function nackMessage(
  tenant: string,
  name: string,
  receipt: string,
  opts: { requeue?: boolean; delaySeconds?: number; error?: string } = {},
): Promise<NackResult | null> {
  const requeue = opts.requeue !== false;
  const delayMs = Math.max(0, Math.round((opts.delaySeconds || 0) * 1000));
  const now = Date.now();
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name));
    if (!q) return null;
    const id = q.receipts.get(receipt);
    if (!id) return null;
    q.receipts.delete(receipt);
    q.inflight.delete(receipt);
    const row = q.messages.get(id);
    if (!row) return null;
    const env = row.envelope;
    delete env.receipt;
    delete env.consumer;
    if (opts.error) env.last_error = opts.error;
    if (!requeue || (env.attempts || 0) >= env.max_attempts) {
      env.dead = true;
      env.dead_at = now;
      q.dead.set(id, now);
      q.counters.dead += 1;
      return { id, state: 'dead', attempts: env.attempts || 0, deadAt: now };
    }
    const availableAt = now + delayMs;
    env.available_at = availableAt;
    q.pending.set(id, availableAt);
    q.counters.retried += 1;
    return { id, state: 'retry', attempts: env.attempts || 0, availableAt };
  }
  const k = keysFor(tenant, name);
  const raw = await r(async () => (redis as any).eval(
    NACK_LUA, 6,
    k.messages, k.receipts, k.inflight, k.pending, k.dead, k.meta,
    receipt, String(now), String(delayMs), opts.error || '', requeue ? '1' : '0',
  ) as string[]);
  if (!Array.isArray(raw) || !raw.length) return null;
  const state = String(raw[1]);
  const attempts = Number(raw[2] || 0);
  return state === 'dead'
    ? { id: String(raw[0]), state: 'dead', attempts, deadAt: Number(raw[3] || now) }
    : { id: String(raw[0]), state: 'retry', attempts, availableAt: Number(raw[3] || now) };
}

const HEARTBEAT_LUA = `
  local id = redis.call('HGET', KEYS[1], ARGV[1])
  if not id then return '' end
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
  return ARGV[2]
`;

export async function heartbeatMessage(
  tenant: string,
  name: string,
  receipt: string,
  visibilityTimeoutSeconds: number,
): Promise<number | null> {
  await reclaimExpired(tenant, name);
  const deadline = Date.now() + visibilityTimeoutSeconds * 1000;
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name));
    const entry = q?.inflight.get(receipt);
    if (!q || !entry) return null;
    entry.deadline = deadline;
    return deadline;
  }
  const k = keysFor(tenant, name);
  return r(async () => {
    const out = String(await (redis as any).eval(
      HEARTBEAT_LUA, 2, k.receipts, k.inflight,
      receipt, String(deadline),
    ) || '');
    return out ? Number(out) : null;
  });
}

// ---------------------------------------------------------------------------
// Peek, dead letters and replay
// ---------------------------------------------------------------------------

export async function peekMessages(tenant: string, name: string, limit: number): Promise<InternalMessage[]> {
  if (!(await getQueue(tenant, name))) return [];
  await reclaimExpired(tenant, name);
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name))!;
    return [...q.pending.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([id]) => memMessage(q, id))
      .filter((m): m is InternalMessage => !!m);
  }
  const k = keysFor(tenant, name);
  const ids = await r(() => redis!.zrangebyscore(k.pending, '-inf', '+inf', 'LIMIT', 0, limit));
  return loadMessages(tenant, name, ids);
}

export async function deadMessages(tenant: string, name: string, limit: number): Promise<InternalMessage[]> {
  if (!(await getQueue(tenant, name))) return [];
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name))!;
    return [...q.dead.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => memMessage(q, id))
      .filter((m): m is InternalMessage => !!m);
  }
  const k = keysFor(tenant, name);
  const ids = await r(() => redis!.zrevrange(k.dead, 0, limit - 1));
  return loadMessages(tenant, name, ids);
}

const REPLAY_LUA = `
  local raw = redis.call('HGET', KEYS[1], ARGV[1])
  if not raw then return 0 end
  local env = cjson.decode(raw)
  if not env.dead then return 0 end
  env.dead = nil
  env.dead_at = nil
  env.last_error = nil
  env.receipt = nil
  env.consumer = nil
  if ARGV[4] == '1' then env.attempts = 0 end
  local available = tonumber(ARGV[2]) + tonumber(ARGV[3])
  env.available_at = available
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(env))
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('ZADD', KEYS[3], available, ARGV[1])
  redis.call('HINCRBY', KEYS[4], 'replayed', 1)
  return 1
`;

export async function replayDeadMessage(
  tenant: string,
  name: string,
  id: string,
  opts: { delaySeconds?: number; resetAttempts?: boolean } = {},
): Promise<InternalMessage | null> {
  const delayMs = Math.max(0, Math.round((opts.delaySeconds || 0) * 1000));
  const now = Date.now();
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name));
    if (!q) return null;
    const row = q.messages.get(id);
    if (!row || !row.envelope.dead) return null;
    row.envelope.dead = undefined;
    row.envelope.dead_at = undefined;
    row.envelope.last_error = undefined;
    row.envelope.receipt = undefined;
    row.envelope.consumer = undefined;
    if (opts.resetAttempts) row.envelope.attempts = 0;
    const availableAt = now + delayMs;
    row.envelope.available_at = availableAt;
    q.dead.delete(id);
    q.pending.set(id, availableAt);
    q.counters.replayed += 1;
    return memMessage(q, id);
  }
  const k = keysFor(tenant, name);
  const ok = await r(async () => Number(await (redis as any).eval(
    REPLAY_LUA, 4, k.messages, k.dead, k.pending, k.meta,
    id, String(now), String(delayMs), opts.resetAttempts ? '1' : '0',
  )));
  return ok === 1 ? getMessage(tenant, name, id) : null;
}

const DELETE_DEAD_LUA = `
  local removed = redis.call('ZREM', KEYS[4], ARGV[1])
  if removed == 0 then return 0 end
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('HDEL', KEYS[3], ARGV[1])
  return 1
`;

export async function deleteDeadMessage(tenant: string, name: string, id: string): Promise<boolean> {
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name));
    if (!q || !q.dead.has(id)) return false;
    q.dead.delete(id);
    q.messages.delete(id);
    return true;
  }
  const k = keysFor(tenant, name);
  return r(async () => Number(await (redis as any).eval(
    DELETE_DEAD_LUA, 4, k.messages, k.payloads, k.headers, k.dead, id,
  )) === 1);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function queueStats(tenant: string, name: string): Promise<QueueStats | null> {
  if (!(await getQueue(tenant, name))) return null;
  await reclaimExpired(tenant, name);
  if (!redis) {
    const q = memQueues.get(memKey(tenant, name));
    if (!q) return null;
    return {
      queue: name,
      pending: q.pending.size,
      inflight: q.inflight.size,
      dead: q.dead.size,
      published: q.counters.published,
      acked: q.counters.acked,
      retried: q.counters.retried,
      replayed: q.counters.replayed,
      maxAttempts: q.config.maxAttempts,
      visibilityTimeoutSeconds: q.config.visibilityTimeoutSeconds,
    };
  }
  const k = keysFor(tenant, name);
  return r(async () => {
    const meta = await redis!.hgetall(k.meta);
    if (!meta || !Object.keys(meta).length) return null;
    const [pending, inflight, dead] = await Promise.all([
      redis!.zcard(k.pending),
      redis!.zcard(k.inflight),
      redis!.zcard(k.dead),
    ]);
    return {
      queue: name,
      pending,
      inflight,
      dead,
      published: Number(meta.published || 0),
      acked: Number(meta.acked || 0),
      retried: Number(meta.retried || 0),
      replayed: Number(meta.replayed || 0),
      maxAttempts: Number(meta.max_attempts || 5),
      visibilityTimeoutSeconds: Number(meta.visibility_timeout || 30),
    };
  });
}

export { QUEUE_PREFIX };
