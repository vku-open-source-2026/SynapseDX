/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Offline tests for the split service SDKs — local mock gateway, no platform.
 *
 * Covers the base/faststore/queue namespaces, the typed BaseCollection
 * object<->data mapping, tenant headers and the deprecated flat wrappers.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  BaseCollection,
  BaseDocument,
  BaseQueryResult,
  SynapseDXClient,
  SynapseDXError,
  dataToObject,
  objectToData,
} from './index';

let base = '';
let lastHeaders: Record<string, string | string[] | undefined> = {};
let lastPath = '';
let lastMethod = '';
let lastBody = '';

function payload(method: string, path: string, body: any): unknown {
  const p = path.split('?')[0];
  if (method === 'GET' && (p === '/v1/base/collections' || p === '/v1/lds/licenses')) return [];
  if (method === 'GET' && p === '/v1/base/collections/parks/documents') {
    return [{
      id: 'd1',
      data: { profile: { name: 'Central', capacity: 10 } },
      version: 1,
      createdAt: 't',
      updatedAt: 't',
    }];
  }
  if (method === 'GET' && p === '/v1/base/collections/parks/documents/d1') {
    return {
      id: 'd1',
      object: { name: 'Central', capacity: 10 },
      data: { profile: { name: 'Central', capacity: 10 } },
      version: 3,
      createdAt: 't',
      updatedAt: 't',
      collection: 'parks',
    };
  }
  if (p.endsWith('/query')) {
    return {
      items: [{
        id: 'p1',
        version: 1,
        data: { profile: { name: 'Central', capacity: 10 } },
        object: { name: 'Central', capacity: 10 },
        createdAt: 't',
        updatedAt: 't',
      }],
      total: 1,
      limit: 100,
      offset: 0,
      nextCursor: 'abc',
    };
  }
  if (p.endsWith('/changes')) {
    return { changes: [], nextSince: '2026-01-01T00:00:00.000Z', hasMore: false };
  }
  if (method !== 'GET' && p.startsWith('/v1/base/collections/parks/documents') && !p.endsWith(':batch')) {
    return {
      id: 'p1',
      data: { profile: { name: 'Central', capacity: 10 } },
      version: 1,
      createdAt: 't',
      updatedAt: 't',
    };
  }
  if (method === 'GET' && p === '/v1/faststore/keys') {
    return { keys: [], cursor: null, truncated: false };
  }
  if (method === 'GET' && p.startsWith('/v1/faststore/keys/') && !p.endsWith('/ttl')) {
    return { key: 'user:1', type: 'string', value: 'v', ttlSeconds: 60 };
  }
  if (p.endsWith('/ttl')) return { key: 'user:1', ttlSeconds: 42 };
  if (method === 'GET' && p === '/v1/queue/queues') return [];
  if (p.endsWith('/consume')) {
    return {
      queue: 'emails',
      count: 1,
      visibilityTimeoutSeconds: 30,
      messages: [{
        id: 'm1',
        payload: { to: 'a@b.c' },
        attempts: 1,
        maxAttempts: 5,
        publishedAt: 't',
        receipt: 'r1',
        leaseExpiresAt: 't2',
      }],
    };
  }
  if (p.endsWith('/ack')) {
    if (body && Array.isArray(body.receipts)) {
      return {
        queue: 'emails',
        results: body.receipts.map((r: string) => ({ ok: true, receipt: r, id: 'm1' })),
        ok: true,
      };
    }
    return { ok: true, queue: 'emails', receipt: body?.receipt, id: 'm1' };
  }
  if (p.endsWith('/nack')) {
    return { ok: true, queue: 'emails', id: 'm1', state: 'ready', attempts: 2 };
  }
  if (p.endsWith('/heartbeat')) {
    return { ok: true, queue: 'emails', receipt: 'r1', leaseExpiresAt: 't3', visibilityTimeoutSeconds: 30 };
  }
  if (method === 'GET' && (p.endsWith('/messages') || p.endsWith('/dead'))) {
    return { queue: 'emails', count: 0, messages: [] };
  }
  if (p.endsWith('/replay')) {
    return { ok: true, queue: 'emails', message: { id: 'm1', attempts: 0 } };
  }
  return { ok: true };
}

before(
  () =>
    new Promise<void>((resolve) => {
      const server = http.createServer((req, res) => {
        lastHeaders = { ...req.headers };
        lastPath = req.url || '';
        lastMethod = req.method || '';
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          lastBody = raw;
          let parsed: any;
          try {
            parsed = raw ? JSON.parse(raw) : undefined;
          } catch {
            parsed = undefined;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload(req.method || '', req.url || '', parsed)));
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const a = server.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        // Keep the server alive for the whole suite; node exits when tests end.
        (server as any).unref();
        resolve();
      });
    }),
);

after(() => {
  /* server is unref'd so the test runner can exit cleanly */
});

describe('service facade', () => {
  it('exposes every service namespace and the baseUrl getter', () => {
    const c = new SynapseDXClient({ baseUrl: 'http://localhost:8080/' });
    assert.equal(c.baseUrl, 'http://localhost:8080');
    for (const name of ['iam', 'workflow', 'lds', 'base', 'faststore', 'queue'] as const) {
      assert.ok(c[name], name);
    }
    assert.ok(c.base.collection('parks') instanceof BaseCollection);
  });

  it('deprecated wrappers warn and forward to the service namespace', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    const messages: string[] = [];
    const original = process.emitWarning;
    (process as any).emitWarning = (warning: string | Error) => {
      messages.push(typeof warning === 'string' ? warning : warning.message);
    };
    try {
      await c.listTemplates();
      assert.equal(lastPath, '/v1/templates');
      await c.ldsLicenses();
      assert.equal(lastPath, '/v1/lds/licenses');
    } finally {
      (process as any).emitWarning = original;
    }
    assert.ok(messages.some((m) => m.includes('client.workflow.listTemplates()')), String(messages));
    assert.ok(messages.some((m) => m.includes('client.lds.licenses()')), String(messages));
  });
});

describe('SynapseBase', () => {
  it('collection lifecycle paths and bodies', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.base.createCollection({
      name: 'parks',
      description: 'city parks',
      mapping: { name: 'profile.name' },
    });
    assert.equal(lastPath, '/v1/base/collections');
    assert.equal(lastMethod, 'POST');
    assert.deepEqual(JSON.parse(lastBody), {
      name: 'parks',
      description: 'city parks',
      mapping: { name: 'profile.name' },
    });

    await c.base.updateCollection('parks', { name: 'parks2', description: null });
    assert.equal(lastMethod, 'PATCH');
    assert.equal(lastPath, '/v1/base/collections/parks');
    assert.deepEqual(JSON.parse(lastBody), { name: 'parks2', description: null });

    await c.base.getCollection('parks');
    assert.equal(lastPath, '/v1/base/collections/parks');
    await c.base.collectionStats('parks');
    assert.equal(lastPath, '/v1/base/collections/parks/stats');
    await c.base.deleteCollection('parks');
    assert.equal(lastMethod, 'DELETE');
  });

  it('documents accept exactly one of data or object', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.base.createDocument('parks', { object: { name: 'Central' }, id: 'p1' });
    assert.equal(lastPath, '/v1/base/collections/parks/documents');
    assert.deepEqual(JSON.parse(lastBody), { object: { name: 'Central' }, id: 'p1' });

    await c.base.createDocument('parks', { data: { profile: { name: 'Central' } } });
    assert.deepEqual(JSON.parse(lastBody), { data: { profile: { name: 'Central' } } });

    assert.throws(() => c.base.createDocument('parks', {}), /exactly one of data or object/);
    assert.throws(
      () => c.base.createDocument('parks', { data: {}, object: {} }),
      /exactly one of data or object/,
    );

    await c.base.getDocument('parks', 'p1', { as: 'object' });
    assert.equal(lastPath, '/v1/base/collections/parks/documents/p1?as=object');

    await c.base.setDocument('parks', 'p1', { data: { a: 1 }, ifVersion: 2, merge: true });
    assert.equal(lastMethod, 'PUT');
    assert.deepEqual(JSON.parse(lastBody), { data: { a: 1 }, ifVersion: 2, merge: true });

    await c.base.updateDocument('parks', 'p1', {
      data: { b: 2 },
      unset: ['profile.old'],
      ifVersion: 3,
    });
    assert.equal(lastMethod, 'PATCH');
    assert.deepEqual(JSON.parse(lastBody), {
      data: { b: 2 },
      unset: ['profile.old'],
      ifVersion: 3,
    });
    assert.throws(() => c.base.updateDocument('parks', 'p1', {}), /provide data\/object/);

    await c.base.deleteDocument('parks', 'p1', { ifVersion: 2 });
    assert.equal(lastPath, '/v1/base/collections/parks/documents/p1?ifVersion=2');
    assert.equal(lastMethod, 'DELETE');
  });

  it('query, increment, batch and changes', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    const result = await c.base.queryDocuments('parks', {
      where: { status: 'active' },
      orderBy: [{ field: 'name', direction: 'desc' }],
      limit: 10,
      offset: 5,
      select: ['name'],
      as: 'object',
    });
    assert.equal(lastPath, '/v1/base/collections/parks/query');
    assert.deepEqual(JSON.parse(lastBody), {
      as: 'object',
      where: { status: 'active' },
      orderBy: [{ field: 'name', direction: 'desc' }],
      limit: 10,
      offset: 5,
      select: ['name'],
    });
    assert.equal(result.total, 1);
    assert.equal(result.nextCursor, 'abc');

    await c.base.increment('parks', 'p1', { field: 'counter', by: 3, ifVersion: 2 });
    assert.equal(lastPath, '/v1/base/collections/parks/documents/p1/increment');
    assert.deepEqual(JSON.parse(lastBody), { field: 'counter', by: 3, ifVersion: 2 });

    const ops = [{ op: 'create', object: { name: 'x' } }];
    await c.base.batch('parks', ops);
    assert.equal(lastPath, '/v1/base/collections/parks/documents:batch');
    assert.deepEqual(JSON.parse(lastBody), { operations: ops });

    const out = await c.base.changes('parks', {
      since: '2026-01-01T00:00:00Z',
      limit: 50,
      as: 'object',
    });
    const changedPath: string = lastPath;
    assert.ok(changedPath.startsWith('/v1/base/collections/parks/changes?'), changedPath);
    assert.ok(changedPath.includes('since=2026-01-01T00%3A00%3A00Z'), changedPath);
    assert.ok(changedPath.includes('limit=50'), changedPath);
    assert.ok(changedPath.includes('as=object'), changedPath);
    assert.equal(out.nextSince, '2026-01-01T00:00:00.000Z');

    await c.base.listDocuments('parks', { limit: 10, offset: 20 });
    assert.equal(lastPath, '/v1/base/collections/parks/documents?limit=10&offset=20');
  });

  it('mapping helpers project both directions', () => {
    const data = { profile: { name: 'Central', capacity: 10 } };
    const mapping = {
      name: 'profile.name',
      capacity: { path: 'profile.capacity', type: 'number' as const },
    };
    assert.deepEqual(dataToObject(data, mapping), { name: 'Central', capacity: 10 });
    assert.deepEqual(objectToData({ name: 'Central' }, mapping), { profile: { name: 'Central' } });
    assert.deepEqual(dataToObject(data), data);
    assert.deepEqual(objectToData({ any: 1 }), { any: 1 });
  });

  it('typed BaseCollection converts models, writes objects and reads data', async () => {
    class Park {
      constructor(readonly name: string, readonly capacity: number) {}
    }
    const c = new SynapseDXClient({ baseUrl: base });
    const col = c.base.collection<Park>('parks', {
      model: (obj) => new Park(String(obj.name), Number(obj.capacity)),
      mapping: { name: 'profile.name', capacity: 'profile.capacity' },
    });

    assert.deepEqual({ ...col.toObject(new Park('Central', 10)) }, { name: 'Central', capacity: 10 });
    assert.deepEqual(col.fromObject({ name: 'Central', capacity: 10 }), new Park('Central', 10));
    assert.deepEqual(col.fromData({ profile: { name: 'Central', capacity: 10 } }), new Park('Central', 10));

    const created = await col.create(new Park('Central', 10), { id: 'p1' });
    assert.deepEqual(JSON.parse(lastBody), {
      object: { name: 'Central', capacity: 10 },
      id: 'p1',
    });
    assert.deepEqual(created, new Park('Central', 10));

    const fetched = await col.get('d1');
    assert.equal(lastPath, '/v1/base/collections/parks/documents/d1?as=object');
    assert.deepEqual(fetched, new Park('Central', 10));

    const listed = await col.list({ limit: 5 });
    assert.equal(lastPath, '/v1/base/collections/parks/documents?limit=5');
    assert.deepEqual(listed, [new Park('Central', 10)]);

    const queried: BaseQueryResult<Park> = await col.query({ where: { name: 'Central' } });
    assert.equal(JSON.parse(lastBody).as, 'object');
    assert.deepEqual(queried.items, [new Park('Central', 10)]);

    const updated = await col.update('d1', new Park('Central', 11), { unset: ['profile.old'] });
    assert.deepEqual(JSON.parse(lastBody), {
      object: { name: 'Central', capacity: 11 },
      unset: ['profile.old'],
    });
    assert.deepEqual(updated, new Park('Central', 10));

    assert.throws(() => col.create(), /exactly one of value or data/);
    assert.throws(
      () => col.create(new Park('x', 1), { data: { name: 'x' } }),
      /exactly one of value or data/,
    );

    const raw: BaseDocument = await col.getDocument('d1', 'data');
    assert.equal(lastPath, '/v1/base/collections/parks/documents/d1?as=data');
    assert.ok(raw.data);
  });
});

describe('Synapse Faststore', () => {
  it('key/value bodies and the tenant header', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    c.setTenant('acme');
    await c.faststore.set('user:1', { a: 1 }, { ttlSeconds: 60, ifNotExists: true });
    assert.equal(lastPath, '/v1/faststore/keys/user%3A1');
    assert.equal(lastMethod, 'PUT');
    assert.equal(lastHeaders['x-synapsedx-tenant'], 'acme');
    assert.deepEqual(JSON.parse(lastBody), {
      value: { a: 1 },
      ttlSeconds: 60,
      ifNotExists: true,
    });

    const got: any = await c.faststore.get('user:1');
    assert.equal(got.value, 'v');
    await c.faststore.expire('user:1', 30);
    assert.equal(lastPath, '/v1/faststore/keys/user%3A1/expire');
    assert.deepEqual(JSON.parse(lastBody), { ttlSeconds: 30 });

    await c.faststore.incr('counter', { by: 2 });
    assert.deepEqual(JSON.parse(lastBody), { by: 2 });
    const ttl: any = await c.faststore.ttl('user:1');
    assert.equal(ttl.ttlSeconds, 42);

    await c.faststore.listKeys({ prefix: 'user:', limit: 5, cursor: '10' });
    assert.equal(lastPath, '/v1/faststore/keys?prefix=user%3A&limit=5&cursor=10');

    const ops = [{ op: 'set', key: 'a', value: 1 }];
    await c.faststore.batch(ops);
    assert.deepEqual(JSON.parse(lastBody), { operations: ops });

    await c.faststore.delete('user:1');
    assert.equal(lastMethod, 'DELETE');
    c.setTenant(undefined);
  });

  it('collections and locks', async () => {
    const c = new SynapseDXClient({ baseUrl: base });

    await c.faststore.hashSet('h1', { a: 1 }, { ttlSeconds: 10 });
    assert.equal(lastPath, '/v1/faststore/hashes/h1');
    assert.deepEqual(JSON.parse(lastBody), { values: { a: 1 }, ttlSeconds: 10 });
    await c.faststore.hashGetField('h1', 'a');
    assert.equal(lastPath, '/v1/faststore/hashes/h1/a');
    await c.faststore.hashIncr('h1', 'a', { by: 2 });
    assert.equal(lastPath, '/v1/faststore/hashes/h1/incr');
    assert.deepEqual(JSON.parse(lastBody), { field: 'a', by: 2 });
    await c.faststore.hashLength('h1');
    assert.equal(lastPath, '/v1/faststore/hashes/h1/length');
    await c.faststore.hashDeleteField('h1', 'a');
    assert.equal(lastMethod, 'DELETE');
    assert.equal(lastPath, '/v1/faststore/hashes/h1/a');

    await c.faststore.listPush('l1', ['x', 'y'], { side: 'left' });
    assert.deepEqual(JSON.parse(lastBody), { values: ['x', 'y'], side: 'left' });
    await c.faststore.listPop('l1', { side: 'right', count: 2 });
    assert.deepEqual(JSON.parse(lastBody), { side: 'right', count: 2 });
    await c.faststore.listRange('l1', 0, -1);
    assert.equal(lastPath, '/v1/faststore/lists/l1?start=0&stop=-1');
    await c.faststore.listTrim('l1', 0, 9);
    assert.deepEqual(JSON.parse(lastBody), { start: 0, stop: 9 });

    await c.faststore.setAdd('s1', ['a'], { ttlSeconds: 5 });
    assert.deepEqual(JSON.parse(lastBody), { members: ['a'], ttlSeconds: 5 });
    await c.faststore.setContains('s1', 'a');
    assert.deepEqual(JSON.parse(lastBody), { member: 'a' });
    await c.faststore.setRemove('s1', ['a']);
    assert.deepEqual(JSON.parse(lastBody), { members: ['a'] });
    await c.faststore.setCard('s1');
    assert.equal(lastPath, '/v1/faststore/sets/s1/card');

    await c.faststore.zsetAdd('z1', [{ member: 'a', score: 2 }]);
    assert.deepEqual(JSON.parse(lastBody), { members: [{ member: 'a', score: 2 }] });
    await c.faststore.zsetRange('z1', { start: 0, stop: -1, rev: true, withScores: true });
    assert.equal(lastPath, '/v1/faststore/zsets/z1?start=0&stop=-1&rev=true&withScores=true');
    await c.faststore.zsetIncr('z1', 'a', { by: 1.5 });
    assert.deepEqual(JSON.parse(lastBody), { member: 'a', by: 1.5 });
    await c.faststore.zsetRank('z1', 'a', { rev: true });
    assert.deepEqual(JSON.parse(lastBody), { member: 'a', rev: true });

    await c.faststore.lockAcquire('job', { ttlSeconds: 60, waitMs: 500, token: 'tok' });
    assert.equal(lastPath, '/v1/faststore/locks/job/acquire');
    assert.deepEqual(JSON.parse(lastBody), { waitMs: 500, ttlSeconds: 60, token: 'tok' });
    await c.faststore.lockExtend('job', 'tok', { ttlSeconds: 60 });
    assert.deepEqual(JSON.parse(lastBody), { token: 'tok', ttlSeconds: 60 });
    await c.faststore.lockRelease('job', 'tok');
    assert.deepEqual(JSON.parse(lastBody), { token: 'tok' });
  });
});

describe('SynapseQueue', () => {
  it('queue config and publish', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.queue.createQueue('emails', { maxAttempts: 7, visibilityTimeoutSeconds: 45 });
    assert.equal(lastPath, '/v1/queue/queues/emails');
    assert.equal(lastMethod, 'PUT');
    assert.deepEqual(JSON.parse(lastBody), { maxAttempts: 7, visibilityTimeoutSeconds: 45 });

    await c.queue.listQueues();
    assert.equal(lastPath, '/v1/queue/queues');

    await c.queue.publish(
      'emails',
      { to: 'a@b.c' },
      {
        delaySeconds: 30,
        maxAttempts: 3,
        headers: { trace: 't1' },
        id: 'm1',
        dedupeKey: 'welcome:a@b.c',
      },
    );
    assert.equal(lastPath, '/v1/queue/queues/emails/messages');
    assert.deepEqual(JSON.parse(lastBody), {
      payload: { to: 'a@b.c' },
      delaySeconds: 30,
      maxAttempts: 3,
      headers: { trace: 't1' },
      id: 'm1',
      dedupeKey: 'welcome:a@b.c',
    });

    const msgs = [{ payload: 1 }, { payload: 2, dedupeKey: 'k' }];
    await c.queue.publishBatch('emails', msgs);
    assert.equal(lastPath, '/v1/queue/queues/emails/messages:batch');
    assert.deepEqual(JSON.parse(lastBody), { messages: msgs });

    await c.queue.queueStats('emails');
    assert.equal(lastPath, '/v1/queue/queues/emails/stats');
    await c.queue.purgeQueue('emails');
    assert.equal(lastPath, '/v1/queue/queues/emails/purge');
    await c.queue.deleteQueue('emails');
    assert.equal(lastMethod, 'DELETE');
  });

  it('consume, ack, nack and heartbeat', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    const out = await c.queue.consume('emails', {
      maxMessages: 5,
      visibilityTimeoutSeconds: 20,
      consumer: 'w1',
    });
    assert.equal(lastPath, '/v1/queue/queues/emails/consume');
    assert.deepEqual(JSON.parse(lastBody), {
      maxMessages: 5,
      visibilityTimeoutSeconds: 20,
      consumer: 'w1',
    });
    assert.equal(out.count, 1);
    const receipt = out.messages[0].receipt;
    assert.equal(receipt, 'r1');

    await c.queue.ack('emails', receipt);
    assert.deepEqual(JSON.parse(lastBody), { receipt: 'r1' });
    await c.queue.ackMany('emails', ['r1', 'r2']);
    assert.deepEqual(JSON.parse(lastBody), { receipts: ['r1', 'r2'] });

    await c.queue.nack('emails', 'r1', { requeue: false, delaySeconds: 5, error: 'boom' });
    assert.equal(lastPath, '/v1/queue/queues/emails/nack');
    assert.deepEqual(JSON.parse(lastBody), {
      receipt: 'r1',
      requeue: false,
      delaySeconds: 5,
      error: 'boom',
    });

    await c.queue.heartbeat('emails', 'r1', { visibilityTimeoutSeconds: 60 });
    assert.deepEqual(JSON.parse(lastBody), {
      receipt: 'r1',
      visibilityTimeoutSeconds: 60,
    });
  });

  it('inspection and dead letters', async () => {
    const c = new SynapseDXClient({ baseUrl: base });
    await c.queue.peek('emails', { limit: 10, ready: true });
    assert.equal(lastPath, '/v1/queue/queues/emails/messages?limit=10&ready=true');
    await c.queue.deadLetters('emails', { limit: 5 });
    assert.equal(lastPath, '/v1/queue/queues/emails/dead?limit=5');
    await c.queue.replayDead('emails', 'm1', { delaySeconds: 0, resetAttempts: true });
    assert.equal(lastPath, '/v1/queue/queues/emails/dead/m1/replay');
    assert.deepEqual(JSON.parse(lastBody), { delaySeconds: 0, resetAttempts: true });
    await c.queue.deleteDead('emails', 'm1');
    assert.equal(lastMethod, 'DELETE');
    assert.equal(lastPath, '/v1/queue/queues/emails/dead/m1');
  });
});

describe('Synapse Inference Engine', () => {
  it('covers health, chat, embeddings, decision and routing paths', async () => {
    const hits: Array<{ method: string; path: string; body: unknown }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        hits.push({
          method: req.method || 'GET',
          path: req.url || '/',
          body: raw ? JSON.parse(raw) : null,
        });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/v1/inference/health') {
          res.end(JSON.stringify({ status: 'ok', service: 'inference' }));
        } else if (req.url === '/v1/inference/chat/completions') {
          res.end(JSON.stringify({ id: 'chat-1', choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
        } else if (req.url === '/v1/inference/embeddings') {
          res.end(JSON.stringify({ object: 'list', data: [{ index: 0, embedding: [0.1, 0.2] }] }));
        } else if (req.url === '/v1/inference/decision') {
          res.end(JSON.stringify({ model: 'decision-0.8B', results: { team: { best_choice: 'support' } } }));
        } else if (req.url === '/v1/inference/decision/route') {
          res.end(JSON.stringify({ best_choice: 'workflow', confidence: 0.95 }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'not_found' }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const a = server.address();
    const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    try {
      const c = new SynapseDXClient({ baseUrl: url });
      const h = await c.inference.health();
      assert.equal(h.service, 'inference');

      const chat = await c.inference.chat([{ role: 'user', content: 'ping' }]);
      assert.equal(chat.choices[0].message.content, 'pong');

      const emb = await c.inference.embeddings('hello');
      assert.equal(emb.data.length, 1);

      const dec = await c.inference.decision('test state', { team: { type: 'choice', instructions: 'pick' } });
      assert.equal(dec.results.team.best_choice, 'support');

      const r = await c.inference.route('run workflow', { workflow: 'DAGs', iam: 'Users' });
      assert.equal(r.best_choice, 'workflow');

      assert.equal(hits.length, 5);
      assert.equal(hits[0].path, '/v1/inference/health');
      assert.equal(hits[1].path, '/v1/inference/chat/completions');
      assert.equal(hits[2].path, '/v1/inference/embeddings');
      assert.equal(hits[3].path, '/v1/inference/decision');
      assert.equal(hits[4].path, '/v1/inference/decision/route');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('error mapping', () => {
  it('carries status and parsed body', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'boom' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const a = server.address();
    const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    try {
      const c = new SynapseDXClient({ baseUrl: url });
      await assert.rejects(
        () => c.base.getCollection('parks'),
        (err: unknown) => {
          assert.ok(err instanceof SynapseDXError);
          assert.equal(err.status, 404);
          assert.deepEqual(err.body, { error: 'boom' });
          assert.match(String(err.message), /synapsedx 404/);
          return true;
        },
      );
      assert.equal(await c.faststore.exists('missing'), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
