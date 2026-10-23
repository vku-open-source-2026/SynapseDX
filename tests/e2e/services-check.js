/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 *
 * End-to-end check for the v0.5 services (SynapseBase, Synapse Faststore,
 * SynapseQueue) through the gateway and the JavaScript SDK. Requires a
 * running gateway and Redis/Postgres (the Docker stack is enough).
 *
 *   SYNAPSEDX_BASE_URL=http://localhost:8080 node tests/e2e/services-check.js
 */
const assert = require('node:assert/strict');
const { SynapseDXClient } = require('../../sdks/sdk-js/dist/index.js');

const baseUrl = process.env.SYNAPSEDX_BASE_URL || 'http://localhost:8080';
const stamp = Date.now().toString(36);

async function main() {
  const c = new SynapseDXClient({ baseUrl });
  const login = await c.iam.login(`svc-e2e-${stamp}@acme.local`);
  c.setToken(login.accessToken);

  // ---- SynapseBase: collection, mapping, CRUD, query, counter, batch, feed ----
  const collection = `svc${stamp}`;
  const created = await c.base.createCollection({
    name: collection,
    description: 'e2e services-check',
    mapping: {
      fields: {
        name: { path: 'profile.name', type: 'string', required: true },
        capacity: { path: 'profile.capacity', type: 'number' },
      },
    },
  });
  assert.equal(created.name, collection);
  assert.equal((await c.base.collectionStats(collection)).documents, 0);

  const doc = await c.base.createDocument(collection, {
    id: 'park-1',
    object: { name: 'Central', capacity: 10 },
  });
  assert.equal(doc.data.profile.name, 'Central');
  assert.equal((await c.base.getDocument(collection, 'park-1', { as: 'object' })).object.name, 'Central');
  assert.equal((await c.base.listDocuments(collection)).length, 1);
  assert.equal((await c.base.collectionStats(collection)).documents, 1);

  const query = await c.base.queryDocuments(collection, {
    where: { capacity: { gte: 5 } },
    orderBy: [{ field: 'name', direction: 'asc' }],
    as: 'object',
  });
  assert.equal(query.total, 1);
  assert.equal(query.items[0].object.name, 'Central');

  const inc = await c.base.increment(collection, 'park-1', { field: 'profile.capacity', by: 5 });
  assert.equal(inc.data.profile.capacity, 15);

  const batch = await c.base.batch(collection, [
    { op: 'create', id: 'park-2', object: { name: 'North', capacity: 8 } },
    { op: 'update', id: 'park-2', object: { capacity: 9 } },
  ]);
  assert.equal(batch.ok, true, JSON.stringify(batch));
  assert.equal((await c.base.queryDocuments(collection, { as: 'object' })).total, 2);

  const changes = await c.base.changes(collection, {
    since: '1970-01-01T00:00:00.000Z',
    as: 'object',
  });
  assert.equal(changes.changes.find((ch) => ch.id === 'park-2').object.capacity, 9);

  await c.base.deleteDocument(collection, 'park-2');
  await c.base.deleteCollection(collection);

  // ---- SynapseBase Vector Store ----
  const vecCol = `vec${stamp}`;
  await c.base.createCollection({
    name: vecCol,
    description: 'e2e vector-search check',
    mapping: {
      fields: {
        title: { path: 'title', type: 'string', required: true },
        category: { path: 'category', type: 'string' },
        embedding: { path: 'embedding', type: 'vector', dimension: 3, metric: 'cosine' },
      },
    },
  });

  await c.base.createDocument(vecCol, {
    id: 'doc-ai',
    object: { title: 'Artificial Intelligence Guide', category: 'ai', embedding: [1, 0, 0] },
  });
  await c.base.createDocument(vecCol, {
    id: 'doc-data',
    object: { title: 'Database Internals', category: 'data', embedding: [0, 1, 0] },
  });
  await c.base.createDocument(vecCol, {
    id: 'doc-both',
    object: { title: 'Vector Databases in AI', category: 'ai', embedding: [0.7071, 0.7071, 0] },
  });

  const vResults = await c.base.vectorSearch(vecCol, {
    field: 'embedding',
    vector: [1, 0, 0],
    limit: 2,
    includeVector: true,
  });
  assert.equal(vResults.items.length, 2);
  assert.equal(vResults.items[0].id, 'doc-ai');
  assert.ok(vResults.items[0].similarity >= 0.99);
  assert.equal(vResults.items[1].id, 'doc-both');

  // Hybrid vector search (filter where category = 'data')
  const vFiltered = await c.base.vectorSearch(vecCol, {
    field: 'embedding',
    vector: [1, 0, 0],
    where: { category: { eq: 'data' } },
    limit: 5,
  });
  assert.equal(vFiltered.items.length, 1);
  assert.equal(vFiltered.items[0].id, 'doc-data');

  await c.base.deleteCollection(vecCol);
  console.log('E2E_BASE_OK');

  // ---- Synapse Faststore: strings/TTL, counter, hash, list, set, zset, lock ----
  const key = `svc:${stamp}`;
  await c.faststore.set(key, { hello: 'world' }, { ttlSeconds: 120 });
  const got = await c.faststore.get(key);
  assert.deepEqual(got.value, { hello: 'world' });
  assert.ok(got.ttlSeconds > 0 && got.ttlSeconds <= 120);
  assert.ok((await c.faststore.ttl(key)).ttlSeconds > 0);
  assert.ok((await c.faststore.listKeys({ prefix: key })).keys.some((k) => k.key === key));

  const counter = `${key}:counter`;
  assert.equal((await c.faststore.incr(counter, { by: 3 })).value, 3);

  const hash = `${key}:hash`;
  await c.faststore.hashSet(hash, { name: 'Alice', visits: 1 });
  assert.equal((await c.faststore.hashGetField(hash, 'name')).value, 'Alice');
  assert.equal((await c.faststore.hashIncr(hash, 'visits', { by: 2 })).value, 3);
  assert.equal((await c.faststore.hashLength(hash)).length, 2);

  const list = `${key}:list`;
  await c.faststore.listPush(list, ['a', 'b'], { side: 'right' });
  assert.deepEqual((await c.faststore.listRange(list)).values, ['a', 'b']);
  assert.equal((await c.faststore.listLength(list)).length, 2);

  const set = `${key}:set`;
  await c.faststore.setAdd(set, ['a', 'b']);
  assert.equal((await c.faststore.setContains(set, 'a')).contains, true);
  assert.equal((await c.faststore.setCard(set)).card, 2);

  const zset = `${key}:zset`;
  await c.faststore.zsetAdd(zset, [
    { member: 'a', score: 1 },
    { member: 'b', score: 2 },
  ]);
  assert.equal((await c.faststore.zsetScore(zset, 'b')).score, 2);
  assert.equal((await c.faststore.zsetCard(zset)).card, 2);

  const lockName = `svc-${stamp}-lock`;
  const lock = await c.faststore.lockAcquire(lockName, { ttlSeconds: 30 });
  assert.equal(lock.acquired, true);
  assert.equal((await c.faststore.lockExtend(lockName, lock.token, { ttlSeconds: 60 })).extended, true);
  assert.equal((await c.faststore.lockRelease(lockName, lock.token)).released, true);

  for (const k of [key, counter, hash, list, set, zset]) await c.faststore.delete(k);
  console.log('E2E_FASTSTORE_OK');

  // ---- SynapseQueue: publish/dedupe/batch, consume/ack/nack, dead/replay ----
  const queue = `svc${stamp}`;
  const config = await c.queue.createQueue(queue, { maxAttempts: 3, visibilityTimeoutSeconds: 30 });
  assert.equal(config.name, queue);
  assert.equal((await c.queue.getQueue(queue)).stats.pending, 0);

  const first = await c.queue.publish(queue, { task: 'ok' }, { dedupeKey: `dedupe:${stamp}` });
  assert.equal(first.duplicate, false);
  assert.equal((await c.queue.publish(queue, { task: 'ok' }, { dedupeKey: `dedupe:${stamp}` })).duplicate, true);

  const published = await c.queue.publishBatch(queue, [
    { payload: { task: 'b1' } },
    { payload: { task: 'b2' } },
  ]);
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.equal((await c.queue.peek(queue, { limit: 10 })).count, 3);

  const consumed = await c.queue.consume(queue, { maxMessages: 2, consumer: 'e2e' });
  assert.equal(consumed.count, 2);
  const [m1, m2] = consumed.messages;
  assert.equal((await c.queue.heartbeat(queue, m1.receipt, { visibilityTimeoutSeconds: 60 })).ok, true);
  assert.equal((await c.queue.ack(queue, m1.receipt)).ok, true);
  const nack = await c.queue.nack(queue, m2.receipt, { requeue: true, delaySeconds: 0 });
  assert.ok(['pending', 'retry'].includes(nack.state), JSON.stringify(nack));

  const next = await c.queue.consume(queue, { maxMessages: 10, consumer: 'e2e' });
  assert.equal(next.count, 2, JSON.stringify(next));
  const toDead = next.messages.find((m) => m.payload.task === 'b1') || next.messages[0];
  await c.queue.nack(queue, toDead.receipt, { requeue: false, error: 'e2e-dead' });
  const dead = await c.queue.deadLetters(queue, { limit: 10 });
  assert.equal(dead.count, 1, JSON.stringify(dead));
  assert.equal((await c.queue.replayDead(queue, dead.messages[0].id, { resetAttempts: true })).ok, true);
  assert.ok((await c.queue.queueStats(queue)).replayed >= 1);

  await c.queue.purgeQueue(queue);
  await c.queue.deleteQueue(queue);
  console.log('E2E_QUEUE_OK');
  console.log('E2E_SERVICES_OK');
}

main().catch((err) => {
  console.error('E2E_SERVICES_FAILED', err && err.stack ? err.stack : err);
  process.exit(1);
});
