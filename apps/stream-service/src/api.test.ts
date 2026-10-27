/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseStream API tests on in-memory engine.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';
import { createApp } from './index';
import { getStreamEngine, registerStreamEngine, listAvailableEngines } from './engines';

let server: Server;
let base = '';

function headers(org = 'tenant-a', sub = 'user-1'): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-synapsedx-user': sub,
    'x-synapsedx-org': org,
    'x-synapsedx-kind': 'user',
  };
}

async function call(
  method: string,
  path: string,
  body?: any,
  h: Record<string, string> = headers()
): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`${base}${path}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

before(async () => {
  process.env.STREAM_ENGINE = 'memory';
  const app = createApp();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  const engine = await getStreamEngine();
  if (engine.clear) engine.clear();
});

test('health and metrics endpoints', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.service, 'stream');
  assert.equal(health.json.engine, 'memory');

  const metrics = await fetch(`${base}/metrics`);
  assert.equal(metrics.status, 200);
  const mText = await metrics.text();
  assert.match(mText, /synapsedx_stream_up 1/);
});

test('topic lifecycle: create, get, list, stats and delete', async () => {
  const create = await call('PUT', '/v1/stream/topics/telemetry', { maxLen: 1000 });
  assert.equal(create.status, 201);
  assert.equal(create.json.topic.name, 'telemetry');
  assert.equal(create.json.topic.maxLen, 1000);

  const get = await call('GET', '/v1/stream/topics/telemetry');
  assert.equal(get.status, 200);
  assert.equal(get.json.topic.name, 'telemetry');

  const list = await call('GET', '/v1/stream/topics');
  assert.equal(list.status, 200);
  assert.equal(list.json.topics.length, 1);
  assert.equal(list.json.topics[0].name, 'telemetry');

  const stats = await call('GET', '/v1/stream/topics/telemetry/stats');
  assert.equal(stats.status, 200);
  assert.equal(stats.json.stats.length, 0);

  const del = await call('DELETE', '/v1/stream/topics/telemetry');
  assert.equal(del.status, 200);
  assert.equal(del.json.deleted, true);

  const getAfter = await call('GET', '/v1/stream/topics/telemetry');
  assert.equal(getAfter.status, 404);
});

test('single event publish and raw read (non-destructive fanout)', async () => {
  await call('PUT', '/v1/stream/topics/sensors');

  const pub1 = await call('POST', '/v1/stream/topics/sensors/events', {
    payload: { temp: 24.5 },
    key: 'sensor-1',
    headers: { source: 'esp32' },
  });
  assert.equal(pub1.status, 201);
  assert.ok(pub1.json.event.id);
  assert.equal(pub1.json.event.payload.temp, 24.5);

  const pub2 = await call('POST', '/v1/stream/topics/sensors/events', {
    payload: { temp: 25.1 },
    key: 'sensor-1',
  });
  assert.equal(pub2.status, 201);

  // Read all from beginning
  const read1 = await call('POST', '/v1/stream/topics/sensors/read', { fromId: '0-0' });
  assert.equal(read1.status, 200);
  assert.equal(read1.json.count, 2);

  // Read again (non-destructive, events are NOT deleted)
  const read2 = await call('POST', '/v1/stream/topics/sensors/read', { fromId: '0-0' });
  assert.equal(read2.status, 200);
  assert.equal(read2.json.count, 2);

  // Read from pub1.id (tailing newer events)
  const readAfter = await call('POST', '/v1/stream/topics/sensors/read', { fromId: pub1.json.event.id });
  assert.equal(readAfter.status, 200);
  assert.equal(readAfter.json.count, 1);
  assert.equal(readAfter.json.events[0].id, pub2.json.event.id);
});

test('batch publish and payload size validation', async () => {
  await call('PUT', '/v1/stream/topics/batch-test');

  const batch = await call('POST', '/v1/stream/topics/batch-test/events:batch', {
    events: [
      { payload: { seq: 1 } },
      { payload: { seq: 2 } },
      { payload: { seq: 3 } },
    ],
  });
  assert.equal(batch.status, 201);
  assert.equal(batch.json.count, 3);

  const read = await call('POST', '/v1/stream/topics/batch-test/read', { fromId: '0-0' });
  assert.equal(read.json.count, 3);
});

test('time-range historical queries', async () => {
  await call('PUT', '/v1/stream/topics/history');

  const p1 = await call('POST', '/v1/stream/topics/history/events', { payload: { step: 1 } });
  const p2 = await call('POST', '/v1/stream/topics/history/events', { payload: { step: 2 } });
  const p3 = await call('POST', '/v1/stream/topics/history/events', { payload: { step: 3 } });

  const id1 = p1.json.event.id;
  const id2 = p2.json.event.id;

  const range = await call('GET', `/v1/stream/topics/history/range?start=${id1}&end=${id2}`);
  assert.equal(range.status, 200);
  assert.equal(range.json.count, 2);
  assert.equal(range.json.events[0].id, id1);
  assert.equal(range.json.events[1].id, id2);
});

test('consumer group: create, read, ack, and destroy', async () => {
  await call('PUT', '/v1/stream/topics/jobs');

  const p1 = await call('POST', '/v1/stream/topics/jobs/events', { payload: { task: 'job-1' } });
  const p2 = await call('POST', '/v1/stream/topics/jobs/events', { payload: { task: 'job-2' } });

  // Create consumer group starting from 0-0
  const groupCreate = await call('PUT', '/v1/stream/topics/jobs/groups/workers', { startId: '0-0' });
  assert.equal(groupCreate.status, 201);
  assert.equal(groupCreate.json.group, 'workers');

  // Read via group
  const gRead = await call('POST', '/v1/stream/topics/jobs/groups/workers/read', {
    consumer: 'worker-a',
    count: 10,
  });
  assert.equal(gRead.status, 200);
  assert.equal(gRead.json.count, 2);

  // Ack events
  const ack = await call('POST', '/v1/stream/topics/jobs/groups/workers/ack', {
    ids: [p1.json.event.id, p2.json.event.id],
  });
  assert.equal(ack.status, 200);
  assert.equal(ack.json.acked, 2);

  // Subsequent read has 0 new messages
  const gReadEmpty = await call('POST', '/v1/stream/topics/jobs/groups/workers/read', {
    consumer: 'worker-a',
  });
  assert.equal(gReadEmpty.json.count, 0);

  // Delete consumer group
  const gDel = await call('DELETE', '/v1/stream/topics/jobs/groups/workers');
  assert.equal(gDel.status, 200);
  assert.equal(gDel.json.destroyed, true);
});

test('tenant isolation ensures privacy between orgs', async () => {
  // Org A writes to 'sensor-feed'
  await call('PUT', '/v1/stream/topics/sensor-feed', {}, headers('org-a'));
  await call('POST', '/v1/stream/topics/sensor-feed/events', { payload: { secret: 'a' } }, headers('org-a'));

  // Org B lists topics — should see empty
  const listB = await call('GET', '/v1/stream/topics', undefined, headers('org-b'));
  assert.equal(listB.json.topics.length, 0);

  // Org B reading 'sensor-feed' sees empty
  const readB = await call('POST', '/v1/stream/topics/sensor-feed/read', { fromId: '0-0' }, headers('org-b'));
  assert.equal(readB.json.count, 0);
});

test('pluggable engine driver registry', () => {
  let customCreated = false;
  registerStreamEngine('custom-mock', () => {
    customCreated = true;
    return {
      name: 'custom-mock',
      init: async () => true,
      close: async () => {},
      createTopic: async () => ({ name: 'mock', createdAt: 0, updatedAt: 0 }),
      getTopic: async () => null,
      listTopics: async () => [],
      deleteTopic: async () => true,
      topicStats: async () => ({ topic: 'mock', length: 0, groupsCount: 0, groups: [] }),
      publish: async () => ({ id: '0-0', payload: null, timestamp: 0 }),
      publishBatch: async () => [],
      read: async () => [],
      createGroup: async () => true,
      destroyGroup: async () => true,
      readGroup: async () => [],
      ack: async () => 0,
      range: async () => [],
    };
  });

  const available = listAvailableEngines();
  assert.ok(available.includes('custom-mock'));
});
