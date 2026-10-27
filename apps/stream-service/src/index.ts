/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseStream — Tenant-scoped distributed event streaming log with pluggable engines.
 * Production default: Redis Streams (Redis 7). Dev/Test: In-memory fallback.
 */

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { timingSafeEqual } from 'crypto';
import { StreamError, TopicConfig, PublishInput } from './types';
import { getStreamEngine, closeStreamEngine } from './engines';

dotenv.config();

const PORT = Number(process.env.PORT || process.env.STREAM_PORT || 4009);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.6.1';
  } catch {
    return '0.6.1';
  }
})();

const IS_PROD = process.env.NODE_ENV === 'production';
const MAX_PAYLOAD_BYTES = Math.min(Math.max(Number(process.env.STREAM_MAX_PAYLOAD_BYTES || 262144), 1024), 2 * 1024 * 1024);
const MAX_BATCH = 100;
const TOPIC_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const GROUP_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export interface Principal {
  sub: string;
  org?: string;
  account?: string;
  kind?: string;
}

export interface Caller {
  kind: 'anon' | 'principal' | 'platform';
  principal: Principal | null;
}

export function principalFromHeaders(req: express.Request): Principal | null {
  const h = (n: string): string => {
    const v = req.headers[n];
    return (Array.isArray(v) ? v[0] : v || '').trim();
  };
  const clean = (v: string): string | undefined => (v && v.length <= 128 ? v : undefined);

  const user = h('x-synapsedx-user');
  if (user) {
    if (user.length > 128) return null;
    return {
      sub: user,
      org: clean(h('x-synapsedx-org')),
      account: clean(h('x-synapsedx-account')),
      kind: clean(h('x-synapsedx-kind')),
    };
  }

  const kind = clean(h('x-synapsedx-kind'));
  const account = clean(h('x-synapsedx-account'));
  const org = clean(h('x-synapsedx-org'));
  if (kind || account || org) {
    return {
      sub: account ? `apikey:${account}` : `${kind || 'principal'}:unknown`,
      org,
      account,
      kind: kind || 'apikey',
    };
  }

  return null;
}

export function resolveCaller(req: express.Request): Caller {
  const p = principalFromHeaders(req);
  if (p) return { kind: 'principal', principal: p };
  const raw = req.headers['x-synapsedx-anon'];
  const anon = (Array.isArray(raw) ? raw[0] : raw) === '1';
  return anon ? { kind: 'anon', principal: null } : { kind: 'platform', principal: null };
}

export function resolveTenant(req: express.Request, caller: Caller): string {
  const p = caller.principal;
  if (p?.org) return `org:${p.org}`;
  if (p?.account) return `account:${p.account}`;
  if (p?.sub) return `user:${p.sub}`;

  // Platform internal calls can specify tenant
  const explicit = (req.headers['x-synapsedx-tenant'] || req.query.tenant || '') as string;
  if (explicit && /^[A-Za-z0-9_:-]{1,128}$/.test(explicit)) {
    return explicit;
  }
  return 'default';
}

function verifyInternal(req: express.Request): boolean {
  const secret = process.env.SYNAPSEDX_INTERNAL_SECRET;
  if (!secret) return true; // dev mode
  const h = req.headers['x-synapsedx-internal'];
  const val = (Array.isArray(h) ? h[0] : h || '').trim();
  if (!val || val.length !== secret.length) return false;
  try {
    return timingSafeEqual(Buffer.from(val), Buffer.from(secret));
  } catch {
    return false;
  }
}

export function createApp(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('dev'));
  }

  // Health and Metrics
  app.get('/health', async (_req, res) => {
    try {
      const engine = await getStreamEngine();
      res.json({
        service: 'stream',
        status: 'ok',
        version: VERSION,
        engine: engine.name,
        time: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(503).json({ service: 'stream', status: 'degraded', error: e?.message || e });
    }
  });

  app.get('/metrics', async (_req, res) => {
    try {
      const engine = await getStreamEngine();
      res.setHeader('content-type', 'text/plain; version=0.0.4');
      res.send(
        `# HELP synapsedx_stream_up Service up status\n` +
        `# TYPE synapsedx_stream_up gauge\n` +
        `synapsedx_stream_up 1\n` +
        `# HELP synapsedx_stream_engine Active backend engine\n` +
        `# TYPE synapsedx_stream_engine gauge\n` +
        `synapsedx_stream_engine{engine="${engine.name}"} 1\n`
      );
    } catch {
      res.status(503).send('synapsedx_stream_up 0\n');
    }
  });

  // Auth & Internal Verification Middleware for /v1/*
  app.use('/v1', (req, res, next) => {
    if (IS_PROD && !verifyInternal(req)) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal secret' });
    }
    const caller = resolveCaller(req);
    if (caller.kind === 'anon') {
      return res.status(401).json({ error: 'unauthorized', message: 'Authentication required for streaming operations' });
    }
    (req as any).caller = caller;
    (req as any).tenant = resolveTenant(req, caller);
    next();
  });

  // --- Topics Management ---

  app.get('/v1/stream/topics', async (req, res) => {
    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      const topics = await engine.listTopics(tenant);
      res.json({ topics });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  app.put('/v1/stream/topics/:topic', async (req, res) => {
    const topicName = req.params.topic;
    if (!TOPIC_RE.test(topicName)) {
      return res.status(400).json({ error: 'invalid', message: 'Topic name must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$' });
    }
    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      const body = req.body || {};
      const topic = await engine.createTopic(tenant, topicName, {
        maxLen: body.maxLen !== undefined ? Number(body.maxLen) : undefined,
        minId: body.minId ? String(body.minId) : undefined,
        retentionMs: body.retentionMs !== undefined ? Number(body.retentionMs) : undefined,
      });
      res.status(201).json({ topic });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  app.get('/v1/stream/topics/:topic', async (req, res) => {
    const topicName = req.params.topic;
    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      const topic = await engine.getTopic(tenant, topicName);
      if (!topic) {
        return res.status(404).json({ error: 'not_found', message: `Topic '${topicName}' not found` });
      }
      res.json({ topic });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  app.delete('/v1/stream/topics/:topic', async (req, res) => {
    const topicName = req.params.topic;
    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      const deleted = await engine.deleteTopic(tenant, topicName);
      res.json({ deleted });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  app.get('/v1/stream/topics/:topic/stats', async (req, res) => {
    const topicName = req.params.topic;
    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      const stats = await engine.topicStats(tenant, topicName);
      res.json({ stats });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  // --- Publish Events ---

  app.post('/v1/stream/topics/:topic/events', async (req, res) => {
    const topicName = req.params.topic;
    if (!TOPIC_RE.test(topicName)) {
      return res.status(400).json({ error: 'invalid', message: 'Invalid topic name' });
    }
    const body = req.body;
    if (!body || body.payload === undefined) {
      return res.status(400).json({ error: 'invalid', message: 'Missing payload in request body' });
    }
    const serialized = JSON.stringify(body.payload);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      return res.status(413).json({ error: 'payload_too_large', message: `Payload exceeds limit of ${MAX_PAYLOAD_BYTES} bytes` });
    }

    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      const input: PublishInput = {
        payload: body.payload,
        key: body.key ? String(body.key) : undefined,
        headers: body.headers && typeof body.headers === 'object' ? body.headers : undefined,
        id: body.id ? String(body.id) : undefined,
      };
      const event = await engine.publish(tenant, topicName, input);
      res.status(201).json({ event });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  app.post('/v1/stream/topics/:topic/events:batch', async (req, res) => {
    const topicName = req.params.topic;
    if (!TOPIC_RE.test(topicName)) {
      return res.status(400).json({ error: 'invalid', message: 'Invalid topic name' });
    }
    const eventsInput = req.body?.events;
    if (!Array.isArray(eventsInput) || !eventsInput.length) {
      return res.status(400).json({ error: 'invalid', message: 'Expected non-empty array under events field' });
    }
    if (eventsInput.length > MAX_BATCH) {
      return res.status(400).json({ error: 'invalid', message: `Batch size exceeds maximum of ${MAX_BATCH}` });
    }

    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      const inputs: PublishInput[] = eventsInput.map((b: any) => ({
        payload: b.payload,
        key: b.key ? String(b.key) : undefined,
        headers: b.headers && typeof b.headers === 'object' ? b.headers : undefined,
        id: b.id ? String(b.id) : undefined,
      }));
      const events = await engine.publishBatch(tenant, topicName, inputs);
      res.status(201).json({ events, count: events.length });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  // --- Read (Raw stream / non-destructive fanout) ---

  app.post('/v1/stream/topics/:topic/read', async (req, res) => {
    const topicName = req.params.topic;
    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      const body = req.body || {};
      const events = await engine.read(tenant, topicName, {
        fromId: body.fromId ? String(body.fromId) : undefined,
        count: body.count ? Math.min(Number(body.count), 1000) : 100,
        blockMs: body.blockMs ? Number(body.blockMs) : undefined,
      });
      res.json({ events, count: events.length });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  // --- Historical Range Query (Time-series / Replay) ---

  app.get('/v1/stream/topics/:topic/range', async (req, res) => {
    const topicName = req.params.topic;
    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      const start = req.query.start ? String(req.query.start) : '-';
      const end = req.query.end ? String(req.query.end) : '+';
      const count = req.query.count ? Math.min(Number(req.query.count), 1000) : 100;

      const events = await engine.range(tenant, topicName, { start, end, count });
      res.json({ events, count: events.length });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  // --- Consumer Groups ---

  app.put('/v1/stream/topics/:topic/groups/:group', async (req, res) => {
    const { topic: topicName, group: groupName } = req.params;
    if (!GROUP_RE.test(groupName)) {
      return res.status(400).json({ error: 'invalid', message: 'Invalid group name' });
    }
    const startId = req.body?.startId ? String(req.body.startId) : '$';

    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      await engine.createGroup(tenant, topicName, groupName, startId);
      res.status(201).json({ group: groupName, topic: topicName, startId });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  app.delete('/v1/stream/topics/:topic/groups/:group', async (req, res) => {
    const { topic: topicName, group: groupName } = req.params;
    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      const destroyed = await engine.destroyGroup(tenant, topicName, groupName);
      res.json({ destroyed });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  app.post('/v1/stream/topics/:topic/groups/:group/read', async (req, res) => {
    const { topic: topicName, group: groupName } = req.params;
    const body = req.body || {};
    const consumer = String(body.consumer || 'default-worker');
    const count = body.count ? Math.min(Number(body.count), 100) : 10;
    const blockMs = body.blockMs ? Number(body.blockMs) : undefined;
    const autoAck = !!body.autoAck;

    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      const events = await engine.readGroup(tenant, topicName, groupName, {
        consumer,
        count,
        blockMs,
        autoAck,
      });
      res.json({ events, count: events.length });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  app.post('/v1/stream/topics/:topic/groups/:group/ack', async (req, res) => {
    const { topic: topicName, group: groupName } = req.params;
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'invalid', message: 'Expected array of message ids under ids field' });
    }

    try {
      const engine = await getStreamEngine();
      const tenant = (req as any).tenant;
      const acked = await engine.ack(tenant, topicName, groupName, ids.map(String));
      res.json({ acked });
    } catch (e: any) {
      handleError(res, e);
    }
  });

  return app;
}

function handleError(res: express.Response, e: any): void {
  if (e instanceof StreamError) {
    const code = e.code;
    let status = 400;
    if (code === 'not_found') status = 404;
    else if (code === 'conflict') status = 409;
    else if (code === 'storage_unavailable') status = 503;
    res.status(status).json({ error: code, message: e.message });
    return;
  }
  const msg = String(e?.message || e || 'internal error');
  res.status(500).json({ error: 'internal_error', message: msg });
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[stream] SynapseStream service v${VERSION} listening on port ${PORT}`);
  });
}
