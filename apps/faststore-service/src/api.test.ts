/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * Synapse Faststore API tests: boot the real Express app on the in-memory
 * backend and cover keys/TTL/NX, counters, batch, scans, hashes, lists, sets,
 * sorted sets, locks, tenancy and validation.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';
import { createApp } from './index';
import { __clearFaststoreMem } from './store';

let server: Server;
let base = '';

function headers(org = 'tenant-a', sub = 'user-1'): Record<string, string> {
  return { 'content-type': 'application/json', 'x-synapsedx-user': sub, 'x-synapsedx-org': org, 'x-synapsedx-kind': 'user' };
}

async function call(method: string, path: string, body?: any, h: Record<string, string> = headers()): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`${base}${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => __clearFaststoreMem());

test('health and metrics are served', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.service, 'faststore');
  assert.equal(health.json.backend, 'memory');
  const metrics = await fetch(`${base}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /synapsedx_faststore_up 1/);
});

test('key/value CRUD, TTL, NX/XX and tenant isolation', async () => {
  const created = await call('PUT', '/v1/faststore/keys/session:1', { value: { user: 'a' }, ttlSeconds: 60 });
  assert.equal(created.status, 201);
  assert.equal(created.json.created, true);

  const got = await call('GET', '/v1/faststore/keys/session:1');
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.value, { user: 'a' });
  assert.equal(got.json.type, 'string');
  assert.ok(got.json.ttlSeconds > 0);

  const updated = await call('PUT', '/v1/faststore/keys/session:1', { value: [1, 2] });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.created, false);
  assert.deepEqual((await call('GET', '/v1/faststore/keys/session:1')).json.value, [1, 2]);

  const nx = await call('PUT', '/v1/faststore/keys/session:1', { value: 1, ifNotExists: true });
  assert.equal(nx.status, 409);
  assert.equal(nx.json.error, 'key_exists');

  const xxMissing = await call('PUT', '/v1/faststore/keys/nope', { value: 1, ifExists: true });
  assert.equal(xxMissing.status, 404);

  const foreign = await call('GET', '/v1/faststore/keys/session:1', undefined, headers('tenant-b'));
  assert.equal(foreign.status, 404);

  const short = await call('PUT', '/v1/faststore/keys/short', { value: 'x', ttlSeconds: 1 });
  assert.equal(short.status, 201);
  assert.ok((await call('GET', '/v1/faststore/keys/short/ttl')).json.ttlSeconds >= 0);
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal((await call('GET', '/v1/faststore/keys/short')).status, 404);

  const badTtl = await call('PUT', '/v1/faststore/keys/bad', { value: 1, ttlSeconds: -1 });
  assert.equal(badTtl.status, 400);

  const deleted = await call('DELETE', '/v1/faststore/keys/session:1');
  assert.equal(deleted.json.deleted, true);
  assert.equal((await call('GET', '/v1/faststore/keys/session:1')).status, 404);
});

test('counters, expiry and type safety', async () => {
  const inc = await call('POST', '/v1/faststore/keys/hits/incr', { by: 3 });
  assert.equal(inc.status, 200);
  assert.equal(inc.json.value, 3);
  assert.equal((await call('POST', '/v1/faststore/keys/hits/incr', { by: 2 })).json.value, 5);

  const expire = await call('POST', '/v1/faststore/keys/hits/expire', { ttlSeconds: 60 });
  assert.equal(expire.status, 200);
  assert.ok((await call('GET', '/v1/faststore/keys/hits/ttl')).json.ttlSeconds > 0);
  await call('POST', '/v1/faststore/keys/hits/expire', { ttlSeconds: 0 });
  assert.equal((await call('GET', '/v1/faststore/keys/hits/ttl')).json.ttlSeconds, -1);

  await call('PUT', '/v1/faststore/keys/text', { value: 'abc' });
  const notNumber = await call('POST', '/v1/faststore/keys/text/incr', { by: 1 });
  assert.equal(notNumber.status, 400);
  assert.equal(notNumber.json.error, 'not_a_number');

  await call('PUT', '/v1/faststore/hashes/h', { values: { a: 1 } });
  const wrong = await call('POST', '/v1/faststore/keys/h/incr', { by: 1 });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.error, 'wrong_type');
});

test('batch operations and key scanning', async () => {
  const batch = await call('POST', '/v1/faststore/batch', {
    operations: [
      { op: 'set', key: 'n:a', value: 1 },
      { op: 'set', key: 'n:b', value: 2 },
      { op: 'get', key: 'n:a' },
      { op: 'incr', key: 'n:a', by: 4 },
      { op: 'delete', key: 'n:b' },
      { op: 'wat', key: 'n:c' },
    ],
  });
  assert.equal(batch.status, 200);
  assert.equal(batch.json.results.length, 6);
  assert.equal(batch.json.results[0].ok, true);
  assert.equal(batch.json.results[2].value, 1);
  assert.equal(batch.json.results[3].value, 5);
  assert.equal(batch.json.results[4].deleted, true);
  assert.equal(batch.json.results[5].ok, false);
  assert.equal(batch.json.ok, false);

  for (let i = 1; i <= 5; i += 1) {
    await call('PUT', `/v1/faststore/keys/x:${i}`, { value: i });
  }
  const page1 = await call('GET', '/v1/faststore/keys?prefix=x:&limit=2');
  assert.equal(page1.status, 200);
  assert.deepEqual(page1.json.keys.map((k: any) => k.key), ['x:1', 'x:2']);
  assert.ok(page1.json.cursor);
  const page2 = await call('GET', `/v1/faststore/keys?prefix=x:&limit=2&cursor=${page1.json.cursor}`);
  assert.deepEqual(page2.json.keys.map((k: any) => k.key), ['x:3', 'x:4']);
  const page3 = await call('GET', `/v1/faststore/keys?prefix=x:&limit=2&cursor=${page2.json.cursor}`);
  assert.deepEqual(page3.json.keys.map((k: any) => k.key), ['x:5']);
  assert.equal(page3.json.cursor, null);

  const stats = await call('GET', '/v1/faststore/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.json.keys, 6);
  assert.equal(stats.json.byType.string, 6);

  const bad = await call('POST', '/v1/faststore/batch', { operations: [] });
  assert.equal(bad.status, 400);
});

test('hashes: fields, counters and type checks', async () => {
  const created = await call('PUT', '/v1/faststore/hashes/users:1', { values: { name: 'Alice', age: 30 } });
  assert.equal(created.status, 201);

  const field = await call('GET', '/v1/faststore/hashes/users:1/name');
  assert.equal(field.status, 200);
  assert.equal(field.json.value, 'Alice');

  const all = await call('GET', '/v1/faststore/hashes/users:1');
  assert.deepEqual(all.json.values, { name: 'Alice', age: 30 });

  const inc = await call('POST', '/v1/faststore/hashes/users:1/incr', { field: 'age', by: 2 });
  assert.equal(inc.json.value, 32);
  assert.equal((await call('GET', '/v1/faststore/hashes/users:1/age')).json.value, 32);

  const removed = await call('DELETE', '/v1/faststore/hashes/users:1/name');
  assert.equal(removed.json.deleted, true);
  assert.equal((await call('GET', '/v1/faststore/hashes/users:1/name')).status, 404);

  const nx = await call('PUT', '/v1/faststore/hashes/users:1', { values: { x: 1 }, ifNotExists: true });
  assert.equal(nx.status, 409);

  await call('PUT', '/v1/faststore/keys/plain', { value: 'x' });
  const wrong = await call('GET', '/v1/faststore/hashes/plain');
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.error, 'wrong_type');
});

test('lists: push, range, pop and trim', async () => {
  const push = await call('POST', '/v1/faststore/lists/queue/push', { values: [1, 2], side: 'right' });
  assert.equal(push.json.length, 2);
  await call('POST', '/v1/faststore/lists/queue/push', { values: [0], side: 'left' });

  const got = await call('GET', '/v1/faststore/lists/queue');
  assert.deepEqual(got.json.values, [0, 1, 2]);
  assert.equal(got.json.length, 3);

  const popped = await call('POST', '/v1/faststore/lists/queue/pop', { side: 'left', count: 2 });
  assert.deepEqual(popped.json.values, [0, 1]);
  assert.equal(popped.json.length, 1);

  await call('POST', '/v1/faststore/lists/queue/trim', { start: 0, stop: 0 });
  assert.deepEqual((await call('GET', '/v1/faststore/lists/queue')).json.values, [2]);

  const last = await call('POST', '/v1/faststore/lists/queue/pop', { side: 'right' });
  assert.deepEqual(last.json.values, [2]);
  assert.equal(last.json.length, 0);
  assert.deepEqual((await call('GET', '/v1/faststore/lists/queue')).json.values, []);
});

test('sets: add, contains, members and remove', async () => {
  const added = await call('POST', '/v1/faststore/sets/tags/add', { members: ['a', 'b', 'a'] });
  assert.equal(added.json.added, 2);
  assert.equal(added.json.card, 2);

  assert.equal((await call('POST', '/v1/faststore/sets/tags/contains', { member: 'a' })).json.contains, true);
  assert.equal((await call('POST', '/v1/faststore/sets/tags/contains', { member: 'c' })).json.contains, false);
  assert.deepEqual((await call('GET', '/v1/faststore/sets/tags')).json.members, ['a', 'b']);
  assert.equal((await call('GET', '/v1/faststore/sets/tags/card')).json.card, 2);

  const removed = await call('POST', '/v1/faststore/sets/tags/remove', { members: ['a', 'z'] });
  assert.equal(removed.json.removed, 1);
  assert.equal(removed.json.card, 1);
});

test('sorted sets: scores, ranges, ranks and increments', async () => {
  const added = await call('POST', '/v1/faststore/zsets/scores/add', {
    members: [{ member: 'a', score: 1 }, { member: 'b', score: 2 }, { member: 'c', score: 2 }],
  });
  assert.equal(added.json.added, 3);

  const asc = await call('GET', '/v1/faststore/zsets/scores?withScores=true');
  assert.deepEqual(asc.json.members.map((m: any) => m.member), ['a', 'b', 'c']);
  const desc = await call('GET', '/v1/faststore/zsets/scores?rev=true&withScores=true');
  assert.deepEqual(desc.json.members.map((m: any) => m.member), ['c', 'b', 'a']);

  assert.equal((await call('POST', '/v1/faststore/zsets/scores/score', { member: 'b' })).json.score, 2);
  assert.equal((await call('POST', '/v1/faststore/zsets/scores/rank', { member: 'a' })).json.rank, 0);
  assert.equal((await call('POST', '/v1/faststore/zsets/scores/rank', { member: 'a', rev: true })).json.rank, 2);

  const inc = await call('POST', '/v1/faststore/zsets/scores/incr', { member: 'a', by: 5 });
  assert.equal(inc.json.score, 6);
  assert.equal((await call('POST', '/v1/faststore/zsets/scores/rank', { member: 'a' })).json.rank, 2);

  const updated = await call('POST', '/v1/faststore/zsets/scores/add', { members: [{ member: 'b', score: 5 }] });
  assert.equal(updated.json.added, 0);
  assert.equal(updated.json.card, 3);

  const removed = await call('POST', '/v1/faststore/zsets/scores/remove', { members: ['b'] });
  assert.equal(removed.json.removed, 1);
  assert.equal((await call('GET', '/v1/faststore/zsets/scores/card')).json.card, 2);
});

test('distributed locks: acquire, release, extend and wait', async () => {
  const first = await call('POST', '/v1/faststore/locks/job/acquire', { ttlSeconds: 30, token: 't1' });
  assert.equal(first.json.acquired, true);

  const second = await call('POST', '/v1/faststore/locks/job/acquire', { ttlSeconds: 30, token: 't2' });
  assert.equal(second.json.acquired, false);

  assert.equal((await call('POST', '/v1/faststore/locks/job/release', { token: 't2' })).json.released, false);
  assert.equal((await call('POST', '/v1/faststore/locks/job/extend', { token: 't2', ttlSeconds: 30 })).json.extended, false);
  assert.equal((await call('POST', '/v1/faststore/locks/job/extend', { token: 't1', ttlSeconds: 60 })).json.extended, true);
  assert.equal((await call('POST', '/v1/faststore/locks/job/release', { token: 't1' })).json.released, true);

  const again = await call('POST', '/v1/faststore/locks/job/acquire', { ttlSeconds: 30, token: 't2' });
  assert.equal(again.json.acquired, true);

  const started = Date.now();
  const waited = await call('POST', '/v1/faststore/locks/job/acquire', { ttlSeconds: 30, token: 't3', waitMs: 120 });
  assert.equal(waited.json.acquired, false);
  assert.ok(Date.now() - started >= 100);

  await call('POST', '/v1/faststore/locks/job/release', { token: 't2' });
});

test('authentication and validation', async () => {
  const anon = await call('GET', '/v1/faststore/keys', undefined, { 'x-synapsedx-anon': '1' } as any);
  assert.equal(anon.status, 401);

  const platformMissing = await call('GET', '/v1/faststore/keys', undefined, {} as any);
  assert.equal(platformMissing.status, 400);
  assert.equal(platformMissing.json.error, 'tenant_required');

  const platformOk = await call('GET', '/v1/faststore/keys', undefined, { 'x-synapsedx-tenant': 'admin' } as any);
  assert.equal(platformOk.status, 200);

  const missing = await call('GET', '/v1/faststore/keys/absent');
  assert.equal(missing.status, 404);

  const badCursor = await call('GET', '/v1/faststore/keys?cursor=nope');
  assert.equal(badCursor.status, 400);

  const badBatch = await call('POST', '/v1/faststore/batch', { operations: {} });
  assert.equal(badBatch.status, 400);
});
