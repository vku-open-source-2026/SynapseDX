/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Synapse Faststore client: Redis-backed cache/KV with strings, hashes, lists,
 * sets, sorted sets, TTLs, counters, scans, batches and distributed locks.
 *
 * Every operation is scoped to the caller's tenant (org / account / user).
 * Platform callers set `tenant` on the client (x-synapsedx-tenant).
 */

import { HttpClient, SynapseDXError } from './_http';

const P = '/v1/faststore';

export class FaststoreService {
  constructor(private readonly http: HttpClient) {}

  private key(key: string): string {
    return encodeURIComponent(key);
  }

  // ---- stats / scans ----
  stats() { return this.http.req(`${P}/stats`); }

  /** Scan keys; returns `{keys, cursor, truncated}` (pass `cursor` back to continue). */
  listKeys(query: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const p = new URLSearchParams();
    if (query.prefix) p.set('prefix', query.prefix);
    if (query.limit !== undefined) p.set('limit', String(query.limit));
    if (query.cursor !== undefined) p.set('cursor', query.cursor);
    const s = p.toString();
    return this.http.req<{ keys: any[]; cursor: string | null; truncated: boolean }>(`${P}/keys${s ? `?${s}` : ''}`);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.get(key);
      return true;
    } catch (e) {
      if (e instanceof SynapseDXError && e.status === 404) return false;
      throw e;
    }
  }

  // ---- key/value ----
  get(key: string) { return this.http.req(`${P}/keys/${this.key(key)}`); }

  set(
    key: string,
    value: unknown,
    opts: { ttlSeconds?: number; ifNotExists?: boolean; ifExists?: boolean } = {},
  ) {
    return this.http.req(`${P}/keys/${this.key(key)}`, {
      method: 'PUT',
      body: JSON.stringify({
        value,
        ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
        ...(opts.ifNotExists ? { ifNotExists: true } : {}),
        ...(opts.ifExists ? { ifExists: true } : {}),
      }),
    });
  }

  delete(key: string) { return this.http.req(`${P}/keys/${this.key(key)}`, { method: 'DELETE' }); }
  ttl(key: string) { return this.http.req(`${P}/keys/${this.key(key)}/ttl`); }
  expire(key: string, ttlSeconds: number) {
    return this.http.req(`${P}/keys/${this.key(key)}/expire`, { method: 'POST', body: JSON.stringify({ ttlSeconds }) });
  }
  incr(key: string, opts: { by?: number; ttlSeconds?: number } = {}) {
    return this.http.req(`${P}/keys/${this.key(key)}/incr`, {
      method: 'POST',
      body: JSON.stringify({
        by: opts.by ?? 1,
        ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
      }),
    });
  }
  batch(operations: Record<string, unknown>[]) {
    return this.http.req<{ results: any[]; ok: boolean }>(`${P}/batch`, { method: 'POST', body: JSON.stringify({ operations }) });
  }

  // ---- hashes ----
  hashGet(key: string) { return this.http.req(`${P}/hashes/${this.key(key)}`); }
  hashSet(key: string, values: Record<string, unknown>, opts: { ttlSeconds?: number } = {}) {
    return this.http.req(`${P}/hashes/${this.key(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ values, ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}) }),
    });
  }
  hashDelete(key: string) { return this.http.req(`${P}/hashes/${this.key(key)}`, { method: 'DELETE' }); }
  hashLength(key: string) { return this.http.req(`${P}/hashes/${this.key(key)}/length`); }
  hashGetField(key: string, field: string) {
    return this.http.req(`${P}/hashes/${this.key(key)}/${encodeURIComponent(field)}`);
  }
  hashSetField(key: string, field: string, value: unknown, opts: { ttlSeconds?: number } = {}) {
    return this.http.req(`${P}/hashes/${this.key(key)}/${encodeURIComponent(field)}`, {
      method: 'PUT',
      body: JSON.stringify({ value, ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}) }),
    });
  }
  hashDeleteField(key: string, field: string) {
    return this.http.req(`${P}/hashes/${this.key(key)}/${encodeURIComponent(field)}`, { method: 'DELETE' });
  }
  hashIncr(key: string, field: string, opts: { by?: number; ttlSeconds?: number } = {}) {
    return this.http.req(`${P}/hashes/${this.key(key)}/incr`, {
      method: 'POST',
      body: JSON.stringify({ field, by: opts.by ?? 1, ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}) }),
    });
  }

  // ---- lists ----
  listRange(key: string, start = 0, stop = -1) {
    return this.http.req(`${P}/lists/${this.key(key)}?start=${start}&stop=${stop}`);
  }
  listDelete(key: string) { return this.http.req(`${P}/lists/${this.key(key)}`, { method: 'DELETE' }); }
  listPush(key: string, values: unknown[], opts: { side?: 'left' | 'right'; ttlSeconds?: number } = {}) {
    return this.http.req(`${P}/lists/${this.key(key)}/push`, {
      method: 'POST',
      body: JSON.stringify({ values, side: opts.side ?? 'right', ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}) }),
    });
  }
  listPop(key: string, opts: { side?: 'left' | 'right'; count?: number } = {}) {
    return this.http.req(`${P}/lists/${this.key(key)}/pop`, {
      method: 'POST',
      body: JSON.stringify({ side: opts.side ?? 'left', count: opts.count ?? 1 }),
    });
  }
  listTrim(key: string, start: number, stop: number) {
    return this.http.req(`${P}/lists/${this.key(key)}/trim`, { method: 'POST', body: JSON.stringify({ start, stop }) });
  }
  listLength(key: string) { return this.http.req(`${P}/lists/${this.key(key)}/length`); }

  // ---- sets ----
  setMembers(key: string) { return this.http.req(`${P}/sets/${this.key(key)}`); }
  setDelete(key: string) { return this.http.req(`${P}/sets/${this.key(key)}`, { method: 'DELETE' }); }
  setAdd(key: string, members: unknown[], opts: { ttlSeconds?: number } = {}) {
    return this.http.req(`${P}/sets/${this.key(key)}/add`, {
      method: 'POST',
      body: JSON.stringify({ members, ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}) }),
    });
  }
  setRemove(key: string, members: unknown[]) {
    return this.http.req(`${P}/sets/${this.key(key)}/remove`, { method: 'POST', body: JSON.stringify({ members }) });
  }
  setContains(key: string, member: unknown) {
    return this.http.req(`${P}/sets/${this.key(key)}/contains`, { method: 'POST', body: JSON.stringify({ member }) });
  }
  setCard(key: string) { return this.http.req(`${P}/sets/${this.key(key)}/card`); }

  // ---- sorted sets ----
  zsetRange(key: string, opts: { start?: number; stop?: number; rev?: boolean; withScores?: boolean } = {}) {
    const p = new URLSearchParams();
    p.set('start', String(opts.start ?? 0));
    p.set('stop', String(opts.stop ?? -1));
    if (opts.rev) p.set('rev', 'true');
    if (opts.withScores) p.set('withScores', 'true');
    return this.http.req(`${P}/zsets/${this.key(key)}?${p.toString()}`);
  }
  zsetDelete(key: string) { return this.http.req(`${P}/zsets/${this.key(key)}`, { method: 'DELETE' }); }
  zsetAdd(key: string, members: Array<{ member: unknown; score: number }>, opts: { ttlSeconds?: number } = {}) {
    return this.http.req(`${P}/zsets/${this.key(key)}/add`, {
      method: 'POST',
      body: JSON.stringify({ members, ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}) }),
    });
  }
  zsetIncr(key: string, member: unknown, opts: { by?: number; ttlSeconds?: number } = {}) {
    return this.http.req(`${P}/zsets/${this.key(key)}/incr`, {
      method: 'POST',
      body: JSON.stringify({ member, by: opts.by ?? 1, ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}) }),
    });
  }
  zsetRemove(key: string, members: unknown[]) {
    return this.http.req(`${P}/zsets/${this.key(key)}/remove`, { method: 'POST', body: JSON.stringify({ members }) });
  }
  zsetScore(key: string, member: unknown) {
    return this.http.req(`${P}/zsets/${this.key(key)}/score`, { method: 'POST', body: JSON.stringify({ member }) });
  }
  zsetRank(key: string, member: unknown, opts: { rev?: boolean } = {}) {
    return this.http.req(`${P}/zsets/${this.key(key)}/rank`, {
      method: 'POST',
      body: JSON.stringify({ member, ...(opts.rev ? { rev: true } : {}) }),
    });
  }
  zsetCard(key: string) { return this.http.req(`${P}/zsets/${this.key(key)}/card`); }

  // ---- distributed locks ----
  lockAcquire(name: string, opts: { ttlSeconds?: number; waitMs?: number; token?: string } = {}) {
    return this.http.req<{ acquired: boolean; lock: string; token?: string; ttlSeconds?: number; expiresAt?: string }>(
      `${P}/locks/${encodeURIComponent(name)}/acquire`,
      {
        method: 'POST',
        body: JSON.stringify({
          waitMs: opts.waitMs ?? 0,
          ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
          ...(opts.token !== undefined ? { token: opts.token } : {}),
        }),
      },
    );
  }
  lockRelease(name: string, token: string) {
    return this.http.req(`${P}/locks/${encodeURIComponent(name)}/release`, { method: 'POST', body: JSON.stringify({ token }) });
  }
  lockExtend(name: string, token: string, opts: { ttlSeconds?: number } = {}) {
    return this.http.req(`${P}/locks/${encodeURIComponent(name)}/extend`, {
      method: 'POST',
      body: JSON.stringify({ token, ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}) }),
    });
  }
}
