/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Usage analytics HTTP tests — memory backend, real Express app.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';

let base = '';
let server: Server | null = null;
let token = '';
let orgId = '';
let accountId = '';
let userId = '';

before(
  () =>
    new Promise<void>((resolve) => {
      const app = createApp();
      server = app.listen(0, '127.0.0.1', () => {
        const a = server!.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        resolve();
      });
    }),
);

after(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function call(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: r.status, data };
}

function rangeQs(extra = ''): string {
  const to = new Date(Date.now() + 60_000).toISOString();
  const from = new Date(Date.now() - 60 * 60_000).toISOString();
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`;
}

describe('usage analytics', () => {
  it('bootstraps a caller + account', async () => {
    const login = await call('POST', '/v1/auth/login', { email: 'usage@acme.local', orgSlug: 'acme' });
    assert.equal(login.status, 200);
    token = login.data.accessToken;
    userId = login.data.user.id;
    const orgs = await call('GET', '/v1/orgs', undefined, { Authorization: `Bearer ${token}` });
    orgId = orgs.data[0].id;
    const accs = await call('GET', `/v1/orgs/${orgId}/accounts`, undefined, { Authorization: `Bearer ${token}` });
    accountId = accs.data[0].id;
    assert.ok(orgId && accountId && userId);
  });

  it('rejects malformed ingest batches', async () => {
    const bad = await call('POST', '/v1/usage/ingest', {
      events: [{ feature: 'workflows', route: '/v1/workflows', method: 'GET', status: 999, durationMs: 1 }],
    });
    assert.equal(bad.status, 400);
    const empty = await call('POST', '/v1/usage/ingest', { events: [] });
    assert.equal(empty.status, 400);
  });

  it('ingests events and builds a tenant-scoped summary', async () => {
    const ingest = await call('POST', '/v1/usage/ingest', {
      events: [
        {
          createdAt: new Date().toISOString(),
          requestId: 'req-1',
          feature: 'workflows',
          route: '/v1/workflows',
          method: 'GET',
          path: '/v1/workflows',
          status: 200,
          durationMs: 10,
          authKind: 'user',
          orgId,
          accountId,
          userId,
        },
        {
          createdAt: new Date().toISOString(),
          requestId: 'req-2',
          feature: 'workflows',
          route: '/v1/executions',
          method: 'POST',
          path: '/v1/executions',
          status: 500,
          durationMs: 30,
          authKind: 'user',
          orgId,
          userId,
          error: 'upstream_unavailable',
        },
        {
          createdAt: new Date().toISOString(),
          requestId: 'req-3',
          feature: 'base',
          route: '/v1/base',
          method: 'PUT',
          path: '/v1/base/collections/orders',
          status: 404,
          durationMs: 5,
          authKind: 'apikey',
          // No org claim: IAM must resolve it from the account row.
          accountId,
        },
      ],
    });
    assert.equal(ingest.status, 202);
    assert.equal(ingest.data.accepted, 3);

    const summary = await call(
      'GET',
      `/v1/usage/summary?${rangeQs()}`,
      undefined,
      { Authorization: `Bearer ${token}` },
    );
    assert.equal(summary.status, 200);
    assert.equal(summary.data.totals.requests, 3);
    assert.equal(summary.data.totals.success, 1);
    assert.equal(summary.data.totals.clientErrors, 1);
    assert.equal(summary.data.totals.serverErrors, 1);
    assert.equal(summary.data.totals.uniqueUsers, 1);
    assert.equal(summary.data.totals.uniqueAccounts, 1);
    assert.equal(summary.data.features.length, 2);
    const workflows = summary.data.features.find((f: any) => f.feature === 'workflows');
    assert.equal(workflows.requests, 2);
    assert.equal(workflows.errorRate, 50);
    assert.equal(summary.data.topRoutes.length, 3);
    assert.ok(Array.isArray(summary.data.series) && summary.data.series.length > 0);

    const events = await call(
      'GET',
      `/v1/usage/events?${rangeQs('&feature=workflows&limit=1')}`,
      undefined,
      { Authorization: `Bearer ${token}` },
    );
    assert.equal(events.status, 200);
    assert.equal(events.data.total, 2);
    assert.equal(events.data.items.length, 1);
    assert.equal(events.data.items[0].feature, 'workflows');

    const search = await call(
      'GET',
      `/v1/usage/events?${rangeQs('&q=orders')}`,
      undefined,
      { Authorization: `Bearer ${token}` },
    );
    assert.equal(search.status, 200);
    assert.equal(search.data.total, 1);
    assert.equal(search.data.items[0].feature, 'base');
  });

  it('does not leak another tenant usage', async () => {
    const other = await call('POST', '/v1/auth/login', { email: 'iso@other.local', orgSlug: 'usage-other' });
    assert.equal(other.status, 200);
    const summary = await call(
      'GET',
      `/v1/usage/summary?${rangeQs()}`,
      undefined,
      { Authorization: `Bearer ${other.data.accessToken}` },
    );
    assert.equal(summary.status, 200);
    assert.equal(summary.data.totals.requests, 0);
    assert.deepEqual(summary.data.features, []);
  });

  it('validates query parameters', async () => {
    const h = { Authorization: `Bearer ${token}` };
    assert.equal((await call('GET', '/v1/usage/summary?from=nope&to=nope', undefined, h)).status, 400);
    assert.equal((await call('GET', '/v1/usage/summary?statusClass=9xx', undefined, h)).status, 400);
    assert.equal((await call('GET', '/v1/usage/events?limit=999', undefined, h)).status, 400);
    assert.equal((await call('GET', '/v1/usage/events?accountId=other', undefined, h)).status, 400);
  });
});
