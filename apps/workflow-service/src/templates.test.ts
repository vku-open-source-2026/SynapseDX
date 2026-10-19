/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildTemplate, listTemplates, createApp, findWebhookPath, validateDefinition, workflowRunPrincipal } from './index';
import { isBlockedUrl } from './engine';
import { __clearMem } from './store';

describe('workflow templates', () => {
  it('lists built-in templates', () => {
    assert.ok(listTemplates().length >= 4);
    const names = listTemplates().map((t) => t.name);
    for (const n of ['webhook-to-log', 'cron-etl', 'iam-webhook', 'code-transform']) {
      assert.ok(names.includes(n), n);
    }
  });
  it('builds known templates', () => {
    for (const t of listTemplates()) {
      const def: any = buildTemplate(t.name, 'demo');
      assert.ok(def.nodes.length >= 2, t.name);
      assert.ok(def.connections, t.name);
    }
  });
  it('unknown template returns null', () => {
    assert.equal(buildTemplate('nope'), null);
  });
  it('automated (webhook/cron) runs act as the workflow tenant principal', () => {
    assert.deepEqual(workflowRunPrincipal({ org_id: 'tenant-a', owner_sub: 'u1', run_as: null }), { sub: 'u1', org: 'tenant-a', account: undefined, kind: 'workflow' });
    assert.equal(workflowRunPrincipal({ org_id: 't', run_as: 'svc-1' })!.sub, 'svc-1');
    assert.deepEqual(workflowRunPrincipal({ org_id: null, account_id: 'acc-2', owner_sub: 'u2', run_as: null }), { sub: 'u2', org: undefined, account: 'acc-2', kind: 'workflow' });
    assert.equal(workflowRunPrincipal({ org_id: null, account_id: null, owner_sub: null, run_as: null }), null);
  });
  it('ships valid examples (CI: examples/n8n-templates pass validateDefinition)', () => {
    // Locate the repo examples dir from either src/ (ts-node) or dist/.
    let dir = '';
    let cur = path.resolve(__dirname);
    for (let i = 0; i < 5; i++) {
      const cand = path.join(cur, 'examples', 'n8n-templates');
      if (fs.existsSync(cand)) { dir = cand; break; }
      cur = path.dirname(cur);
    }
    assert.ok(dir, 'examples/n8n-templates found');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 2, 'example files present');
    for (const f of files) {
      const def = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      assert.equal(validateDefinition(def), null, `${f} must be saveable`);
    }
  });
});

describe('self-call allowlist (P0-1)', () => {
  const OLD = process.env.SYNAPSEDX_SELF_BASE_URLS;
  after(() => {
    if (OLD === undefined) delete process.env.SYNAPSEDX_SELF_BASE_URLS;
    else process.env.SYNAPSEDX_SELF_BASE_URLS = OLD;
  });
  const selfDef = (url: string) => ({
    nodes: [
      { name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
      { name: 'H', type: 'n8n-nodes-base.httpRequest', parameters: { url, method: 'GET' } },
    ],
    connections: { Start: { main: [[{ node: 'H' }]] } },
  });
  it('blocks first-party hosts by default', () => {
    delete process.env.SYNAPSEDX_SELF_BASE_URLS;
    assert.equal(isBlockedUrl('http://gateway:8080/v1/orgs'), true);
    assert.match(validateDefinition(selfDef('http://gateway:8080/v1/orgs'))!, /blocked internal/);
  });
  it('allowlisted origins pass save-time and runtime guards', () => {
    process.env.SYNAPSEDX_SELF_BASE_URLS = 'http://gateway:8080, http://iam:4001';
    assert.equal(isBlockedUrl('http://gateway:8080/v1/orgs'), false);
    assert.equal(isBlockedUrl('http://iam:4001/health'), false);
    assert.equal(validateDefinition(selfDef('http://gateway:8080/v1/orgs')), null);
    // Not a prefix loophole: other ports stay blocked.
    assert.equal(isBlockedUrl('http://gateway:9999/v1/orgs'), true);
  });
  it('rejects definitions with no trigger node (silent-dead-workflow guard)', () => {
    const dead = {
      nodes: [
        { name: 'C', type: 'code', parameters: { code: 'return $input;' } },
        { name: 'S', type: 'set', parameters: { values: { a: 1 } } },
      ],
      connections: { C: { main: [[{ node: 'S' }]] } },
    };
    assert.match(String(validateDefinition(dead)), /trigger node/);
    // webhook + manualTrigger + cron all satisfy the requirement
    for (const type of ['n8n-nodes-base.webhook', 'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.cron']) {
      const def = {
        nodes: [
          { name: 'T', type, parameters: type === 'n8n-nodes-base.cron' ? { intervalMs: 15000 } : type === 'n8n-nodes-base.webhook' ? { path: 'p' } : {} },
          { name: 'S', type: 'set', parameters: { values: { a: 1 } } },
        ],
        connections: { T: { main: [[{ node: 'S' }]] } },
      };
      assert.equal(validateDefinition(def), null, type);
    }
  });
});

describe('workflow internal gate', () => {
  let base = '';
  let server: Server | null = null;
  before(
    () =>
      new Promise<void>((resolve) => {
        process.env.SYNAPSEDX_INTERNAL_SECRET = 'test-secret-123';
        __clearMem();
        const app = createApp();
        server = app.listen(0, '127.0.0.1', () => {
          const a = server!.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
      }),
  );
  after(() => {
    delete process.env.SYNAPSEDX_INTERNAL_SECRET;
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('health stays public + carries security headers', async () => {
    const r = await fetch(base + '/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    const body: any = await r.json();
    assert.equal(body.engine, 'local');
  });
  it('direct /v1/* without internal secret is rejected', async () => {
    const r = await fetch(base + '/v1/templates');
    assert.equal(r.status, 401);
  });
  it('gateway credential passes the gate', async () => {
    const r = await fetch(base + '/v1/templates', { headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(r.status, 200);
    assert.ok((await r.json()).length >= 4);
  });
  it('malformed JSON body is 400 invalid_json, not 500', async () => {
    const r = await fetch(base + '/v1/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' },
      body: '{"name":broken',
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_json');
  });
  it('explicit null name passes validation (local engine creates 201)', async () => {
    // Python SDK serializes missing name as null — must not 400.
    const r = await fetch(base + '/v1/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' },
      body: JSON.stringify({ template: 'webhook-to-log', name: null }),
    });
    assert.equal(r.status, 201);
    const body: any = await r.json();
    assert.ok(body.id);
  });
});

describe('findWebhookPath', () => {
  const hook = (path: unknown) => ({ nodes: [{ type: 'n8n-nodes-base.webhook', parameters: { path } }, { type: 'n8n-nodes-base.noOp', parameters: {} }] });
  it('returns the first webhook trigger path', () => {
    assert.equal(findWebhookPath(hook('synapsedx-event')), 'synapsedx-event');
  });
  it('returns null without webhook nodes or nodes array', () => {
    assert.equal(findWebhookPath({ nodes: [{ type: 'n8n-nodes-base.cron', parameters: {} }] }), null);
    assert.equal(findWebhookPath({}), null);
    assert.equal(findWebhookPath(null), null);
  });
  it('rejects traversal, overlong and exotic paths', () => {
    assert.equal(findWebhookPath(hook('../secret')), null);
    assert.equal(findWebhookPath(hook('a'.repeat(129))), null);
    assert.equal(findWebhookPath(hook('x?y=z')), null);
    assert.equal(findWebhookPath(hook('')), null);
  });
});

describe('execute validation (local engine)', () => {
  let base = '';
  let server: Server | null = null;
  before(
    () =>
      new Promise<void>((resolve) => {
        process.env.SYNAPSEDX_INTERNAL_SECRET = 'test-secret-123';
        const app = createApp();
        server = app.listen(0, '127.0.0.1', () => {
          const a = server!.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
      }),
  );
  after(() => {
    delete process.env.SYNAPSEDX_INTERNAL_SECRET;
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('CRLF id is 400', async () => {
    const r = await fetch(`${base}/v1/workflows/${encodeURIComponent('a\r\nb')}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' },
      body: '{}',
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_id');
  });
  it('oversized execute body is 400', async () => {
    const r = await fetch(`${base}/v1/workflows/x/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' },
      body: JSON.stringify({ big: 'x'.repeat(300 * 1024) }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'payload_too_large');
  });
  it('oversized execute body beyond parser limit → 413 (not 500)', async () => {
    const r = await fetch(`${base}/v1/workflows/x/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' },
      body: JSON.stringify({ big: 'x'.repeat(3 * 1024 * 1024) }),
    });
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error, 'payload_too_large');
  });
});

describe('update + id validation (local engine)', () => {
  let base = '';
  let server: Server | null = null;
  before(
    () =>
      new Promise<void>((resolve) => {
        process.env.SYNAPSEDX_INTERNAL_SECRET = 'test-secret-123';
        const app = createApp();
        server = app.listen(0, '127.0.0.1', () => {
          const a = server!.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
      }),
  );
  after(() => {
    delete process.env.SYNAPSEDX_INTERNAL_SECRET;
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });
  const H = { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' };

  it('PUT with CRLF id is 400', async () => {
    const r = await fetch(`${base}/v1/workflows/${encodeURIComponent('a\r\nb')}`, { method: 'PUT', headers: H, body: JSON.stringify({ name: 'x' }) });
    assert.equal(r.status, 400);
  });
  it('PUT with empty body is 400', async () => {
    // need a real workflow id: create one first
    const c = await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'webhook-to-log', name: 'put-empty' }) });
    assert.equal(c.status, 201);
    const wf: any = await c.json();
    const r = await fetch(`${base}/v1/workflows/${wf.id}`, { method: 'PUT', headers: H, body: JSON.stringify({}) });
    assert.equal(r.status, 400);
  });
  it('PUT with SSRF definition is 400', async () => {
    const c = await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'webhook-to-log', name: 'put-ssrf' }) });
    const wf: any = await c.json();
    const r = await fetch(`${base}/v1/workflows/${wf.id}`, {
      method: 'PUT', headers: H,
      body: JSON.stringify({ definition: { nodes: [{ name: 'H', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'http://169.254.169.254/latest' } }] } }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_definition');
  });
  it('POST with both template and definition is 400', async () => {
    const r = await fetch(`${base}/v1/workflows`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ template: 'webhook-to-log', definition: { nodes: [] } }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'ambiguous_source');
  });
  it('POST with cyclic definition is 400 cycle', async () => {
    const r = await fetch(`${base}/v1/workflows`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        name: 'cyc',
        definition: {
          nodes: [
            { name: 'A', type: 'n8n-nodes-base.noOp', parameters: {} },
            { name: 'B', type: 'n8n-nodes-base.noOp', parameters: {} },
          ],
          connections: {
            A: { main: [[{ node: 'B', type: 'main', index: 0 }]] },
            B: { main: [[{ node: 'A', type: 'main', index: 0 }]] },
          },
        },
      }),
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, /cycle/i);
  });
  it('GET workflow with oversized id is 400', async () => {
    const r = await fetch(`${base}/v1/workflows/${'x'.repeat(200)}`, { headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(r.status, 400);
  });
  it('executions with non-numeric limit is 400', async () => {
    const r = await fetch(`${base}/v1/executions?limit=abc`, { headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(r.status, 400);
  });
  it('executions list returns envelope + paginates locally', async () => {
    const r = await fetch(`${base}/v1/executions?limit=5&offset=00`, { headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(r.status, 200);
    const body: any = await r.json();
    assert.ok(Array.isArray(body.data));
  });
  it('DELETE workflow with CRLF id is 400', async () => {
    const r = await fetch(`${base}/v1/workflows/${encodeURIComponent('a\rb')}`, {
      method: 'DELETE',
      headers: { 'x-synapsedx-internal': 'test-secret-123' },
    });
    assert.equal(r.status, 400);
  });
});

describe('local CRUD + execute + executions', () => {
  let base = '';
  let server: Server | null = null;
  before(
    () =>
      new Promise<void>((resolve) => {
        process.env.SYNAPSEDX_INTERNAL_SECRET = 'test-secret-123';
        __clearMem();
        const app = createApp();
        server = app.listen(0, '127.0.0.1', () => {
          const a = server!.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
      }),
  );
  after(() => {
    delete process.env.SYNAPSEDX_INTERNAL_SECRET;
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });
  const H = { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' };

  it('full lifecycle: create -> get -> activate -> execute -> executions -> delete', async () => {
    const c = await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'code-transform', name: 'e2e-local' }) });
    assert.equal(c.status, 201);
    const wf: any = await c.json();
    assert.ok(wf.id);
    assert.equal(wf.active, false);

    const g = await fetch(`${base}/v1/workflows/${wf.id}`, { headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(g.status, 200);

    const act = await fetch(`${base}/v1/workflows/${wf.id}/activate`, { method: 'POST', headers: H, body: '{}' });
    assert.equal(act.status, 200);
    assert.equal((await act.json()).active, true);

    // code-transform doubles value: 8 -> 16 -> big branch
    const ex = await fetch(`${base}/v1/workflows/${wf.id}/execute`, { method: 'POST', headers: H, body: JSON.stringify({ value: 8 }) });
    assert.equal(ex.status, 200);
    const out: any = await ex.json();
    assert.equal(out.ok, true);
    assert.equal(out.output.tag, 'big');
    assert.equal(out.output.doubled, 16);
    assert.ok(out.executionId);

    const small = await fetch(`${base}/v1/workflows/${wf.id}/execute`, { method: 'POST', headers: H, body: JSON.stringify({ value: 2 }) });
    const smallOut: any = await small.json();
    assert.equal(smallOut.output.tag, 'small');

    const list = await fetch(`${base}/v1/executions?workflowId=${wf.id}&limit=10`, { headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(list.status, 200);
    const listed: any = await list.json();
    assert.ok(listed.data.length >= 2);

    const one = await fetch(`${base}/v1/executions/${out.executionId}?includeData=true`, { headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(one.status, 200);
    const oneBody: any = await one.json();
    assert.ok(Array.isArray(oneBody.nodeRuns));
    assert.ok(oneBody.nodeRuns.length >= 4);

    const del = await fetch(`${base}/v1/workflows/${wf.id}`, { method: 'DELETE', headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(del.status, 200);
    const gone = await fetch(`${base}/v1/workflows/${wf.id}`, { headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(gone.status, 404);
  });

  it('inactive workflow still executes manually (no 409)', async () => {
    const c = await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'webhook-to-log', name: 'inactive-run' }) });
    const wf: any = await c.json();
    const ex = await fetch(`${base}/v1/workflows/${wf.id}/execute`, { method: 'POST', headers: H, body: JSON.stringify({ hello: 'world' }) });
    assert.equal(ex.status, 200);
    assert.equal((await ex.json()).ok, true);
  });
});

describe('validation: names, webhooks, cron, conflicts (m5/M7/M8)', () => {
  let base = '';
  let server: Server | null = null;
  before(
    () =>
      new Promise<void>((resolve) => {
        process.env.SYNAPSEDX_INTERNAL_SECRET = 'test-secret-123';
        __clearMem();
        const app = createApp();
        server = app.listen(0, '127.0.0.1', () => {
          const a = server!.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
      }),
  );
  after(() => {
    delete process.env.SYNAPSEDX_INTERNAL_SECRET;
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });
  const H = { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' };
  const postDef = (name: string, definition: any) =>
    fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ name, definition }) });

  it('nameless nodes are rejected (m5)', async () => {
    const r = await postDef('noname', { nodes: [{ type: 'n8n-nodes-base.noOp', parameters: {} }], connections: {} });
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, /name/);
  });
  it('bad webhook path/method rejected (M7)', async () => {
    const badPath = await postDef('badpath', {
      nodes: [{ name: 'W', type: 'n8n-nodes-base.webhook', parameters: { path: '../x', httpMethod: 'POST' } }],
      connections: {},
    });
    assert.equal(badPath.status, 400);
    assert.match((await badPath.json()).message, /webhook path/);
    const badMethod = await postDef('badmethod', {
      nodes: [{ name: 'W', type: 'n8n-nodes-base.webhook', parameters: { path: 'ok-path', httpMethod: 'BREW' } }],
      connections: {},
    });
    assert.equal(badMethod.status, 400);
    assert.match((await badMethod.json()).message, /httpMethod/);
  });
  it('sub-10s cron and bad expressions rejected (M8)', async () => {
    const fast = await postDef('fast', {
      nodes: [{ name: 'C', type: 'n8n-nodes-base.cron', parameters: { rule: { interval: [{ field: 'seconds', secondsInterval: 5 }] } } }],
      connections: {},
    });
    assert.equal(fast.status, 400);
    assert.match((await fast.json()).message, /10s/);
    const badExpr = await postDef('badexpr', {
      nodes: [{ name: 'C', type: 'n8n-nodes-base.cron', parameters: { cronExpression: '*/7 1,2 * * 1' } }],
      connections: {},
    });
    assert.equal(badExpr.status, 400);
    assert.match((await badExpr.json()).message, /cronExpression/);
  });
  it('nested internal URLs are caught (m4 deep scan)', async () => {
    const r = await postDef('nested', {
      nodes: [{ name: 'H', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://api.example.com/x', method: 'GET', headers: { cb: 'http://169.254.169.254/x' } } }],
      connections: {},
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, /blocked internal/);
  });
  it('public s3-style hosts are NOT blocked (m4 overblock fix)', async () => {
    const r = await postDef('s3ok', {
      nodes: [
        { name: 'Start', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        { name: 'H', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://s3.amazonaws.com/bucket/key', method: 'GET' } },
      ],
      connections: { Start: { main: [[{ node: 'H' }]] } },
    });
    assert.equal(r.status, 201);
  });
  it('duplicate webhook path blocked at activate with 409 (M7)', async () => {
    const mk = (nm: string, path: string) => postDef(nm, {
      nodes: [
        { name: 'W', type: 'n8n-nodes-base.webhook', parameters: { path, httpMethod: 'POST' } },
        { name: 'L', type: 'n8n-nodes-base.noOp', parameters: {} },
      ],
      connections: { W: { main: [[{ node: 'L' }]] } },
    });
    const c1: any = await (await mk('w1', 'clash-path')).json();
    const c2: any = await (await mk('w2', 'clash-path')).json();
    assert.equal(await (await fetch(`${base}/v1/workflows/${c1.id}/activate`, { method: 'POST', headers: H, body: '{}' })).status, 200);
    const clash = await fetch(`${base}/v1/workflows/${c2.id}/activate`, { method: 'POST', headers: H, body: '{}' });
    assert.equal(clash.status, 409);
    assert.equal((await clash.json()).error, 'webhook_path_conflict');
  });
  it('template webhook paths are uniquified (no dup on double create)', async () => {
    const a: any = await (await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'webhook-to-log', name: 't1' }) })).json();
    const b: any = await (await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'webhook-to-log', name: 't2' }) })).json();
    const pa = a.nodes.find((n: any) => n.type === 'n8n-nodes-base.webhook')?.parameters?.path;
    const pb = b.nodes.find((n: any) => n.type === 'n8n-nodes-base.webhook')?.parameters?.path;
    assert.ok(pa && pb && pa !== pb);
  });
  it('synapsedx-self-check template builds, validates and saves (first-party demo)', async () => {
    const names: string[] = listTemplates().map((t) => t.name);
    assert.ok(names.includes('synapsedx-self-check'));
    const def: any = buildTemplate('synapsedx-self-check', 'self');
    assert.ok(def.nodes.some((n: any) => n.type === 'synapsedx.api'));
    assert.equal(validateDefinition({ nodes: def.nodes, connections: def.connections }), null);
    const bad = validateDefinition({ nodes: [{ name: 'S', type: 'synapsedx.api', parameters: { resource: 'nope', operation: 'list' } }] });
    assert.match(bad || '', /unknown resource/);
    const c = await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'synapsedx-self-check', name: 'self-run' }) });
    assert.equal(c.status, 201);
  });
  it('github-push-to-log template builds, verifies GitHub-style HMAC and normalizes', async () => {
    const names: string[] = listTemplates().map((t) => t.name);
    assert.ok(names.includes('github-push-to-log'));
    const def: any = buildTemplate('github-push-to-log', 'gh');
    const hook = def.nodes.find((n: any) => n.type === 'n8n-nodes-base.webhook');
    assert.equal(hook.parameters.auth.mode, 'hmac-sha256');
    assert.equal(hook.parameters.auth.header, 'x-hub-signature-256');
    // Template ships without a credential (user adds their GitHub secret):
    // create works (templates trusted), activate must demand the credential.
    const c = await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'github-push-to-log', name: 'gh-run' }) });
    assert.equal(c.status, 201);
    const wf: any = await c.json();
    // Normalize logic runs standalone via test-run with a push sample.
    const push = { ref: 'refs/heads/main', repository: { full_name: 'acme/demo' }, pusher: { name: 'dev' }, commits: [{ message: 'fix: x' }] };
    const t = await fetch(`${base}/v1/workflows/test-run`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        definition: { nodes: def.nodes.filter((n: any) => n.name !== 'GitHubPush'), connections: { Normalize: def.connections.Normalize } },
        input: push,
      }),
    });
    assert.equal(t.status, 200);
    const out: any = await t.json();
    assert.equal(out.output.repo, 'acme/demo');
    assert.equal(out.output.count, 1);
    assert.equal(out.output.source, 'github');
    void wf;
  });
  it('manual-starter template builds and runs (m12)', async () => {
    const names: string[] = listTemplates().map((t) => t.name);
    assert.ok(names.includes('manual-starter'));
    const def: any = buildTemplate('manual-starter', 'ms');
    assert.ok(def.nodes.length >= 3);
    const c = await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'manual-starter', name: 'ms-run' }) });
    assert.equal(c.status, 201);
    const wf: any = await c.json();
    const ex = await fetch(`${base}/v1/workflows/${wf.id}/execute`, { method: 'POST', headers: H, body: JSON.stringify({ value: 5 }) });
    assert.equal(ex.status, 200);
    assert.equal((await ex.json()).output.doubled, 10);
  });
  it('test-run attaches to workflowId + filters by triggeredBy (M10)', async () => {
    const c: any = await (await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'manual-starter', name: 'tr' }) })).json();
    const t = await fetch(`${base}/v1/workflows/test-run`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ workflowId: c.id, definition: { nodes: [{ name: 'M', type: 'n8n-nodes-base.manualTrigger', parameters: {} }], connections: {} }, input: {} }),
    });
    assert.equal(t.status, 200);
    const listed: any = await (await fetch(`${base}/v1/executions?workflowId=${c.id}&triggeredBy=test`, { headers: { 'x-synapsedx-internal': 'test-secret-123' } })).json();
    assert.ok(listed.data.length >= 1);
    assert.equal(listed.data[0].triggeredBy, 'test');
    const bad = await fetch(`${base}/v1/executions?triggeredBy=nope`, { headers: { 'x-synapsedx-internal': 'test-secret-123' } });
    assert.equal(bad.status, 400);
  });
});

describe('credentials, webhook hardening, tenant, revision, metrics (P0/P2)', () => {
  let base = '';
  let server: Server | null = null;
  before(
    () =>
      new Promise<void>((resolve) => {
        process.env.SYNAPSEDX_INTERNAL_SECRET = 'test-secret-123';
        __clearMem();
        const app = createApp();
        server = app.listen(0, '127.0.0.1', () => {
          const a = server!.address();
          base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
          resolve();
        });
      }),
  );
  after(() => {
    delete process.env.SYNAPSEDX_INTERNAL_SECRET;
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });
  const H = { 'Content-Type': 'application/json', 'x-synapsedx-internal': 'test-secret-123' };
  const P = (extra: Record<string, string> = {}) => ({ ...H, ...extra });

  it('credentials CRUD hides secrets + enforces account scope (P0-4)', async () => {
    const c = await fetch(`${base}/v1/credentials`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ accountId: 'acc-1', name: 'api', kind: 'bearer', secret: 'tok-123' }),
    });
    assert.equal(c.status, 201);
    const cred: any = await c.json();
    assert.ok(cred.id && !('secret' in cred) && !('secret_enc' in cred));
    const dup = await fetch(`${base}/v1/credentials`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ accountId: 'acc-1', name: 'api', kind: 'bearer', secret: 'other' }),
    });
    assert.equal(dup.status, 409);
    // Cross-account caller is refused.
    const cross = await fetch(`${base}/v1/credentials`, {
      method: 'POST',
      headers: P({ 'x-synapsedx-user': 'u1', 'x-synapsedx-account': 'acc-2', 'x-synapsedx-org': 'o1' }),
      body: JSON.stringify({ accountId: 'acc-1', name: 'x', kind: 'bearer', secret: 's' }),
    });
    assert.equal(cross.status, 403);
    const list: any = await (await fetch(`${base}/v1/credentials?accountId=acc-1`, { headers: H })).json();
    assert.equal(list.data.length, 1);
    assert.ok(!JSON.stringify(list).includes('tok-123'));
    const del = await fetch(`${base}/v1/credentials/${cred.id}`, { method: 'DELETE', headers: H });
    assert.equal(del.status, 200);
  });

  it('httpRequest auth.credentialId shape validated at save (P1-16)', async () => {
    const r = await fetch(`${base}/v1/workflows`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        name: 'badauth',
        definition: { nodes: [{ name: 'H', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://api.example.com/x', auth: {} } }], connections: {} },
      }),
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, /credentialId/);
  });

  it('webhook secret-header auth: 401 without, 200 with, 409 replay, 429 flood (P0-5)', async () => {
    const cred: any = await (await fetch(`${base}/v1/credentials`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ accountId: 'acc-w', name: 'wh', kind: 'bearer', secret: 'shhh' }),
    })).json();
    const def = {
      nodes: [
        { name: 'W', type: 'n8n-nodes-base.webhook', parameters: { path: 'guarded', httpMethod: 'POST', auth: { mode: 'secret-header', credentialId: cred.id }, rateLimit: { rpm: 4 }, idempotency: { header: 'x-delivery', ttlSeconds: 3600 } } },
        { name: 'L', type: 'n8n-nodes-base.noOp', parameters: {} },
      ],
      connections: { W: { main: [[{ node: 'L' }]] } },
    };
    const c: any = await (await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'guarded', definition: def }) })).json();
    await fetch(`${base}/v1/workflows/${c.id}/activate`, { method: 'POST', headers: H, body: '{}' });
    const authed = { 'Content-Type': 'application/json', 'x-webhook-secret': 'shhh' };
    const noAuth = await fetch(`${base}/webhook/guarded`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noAuth.status, 401);
    const first = await fetch(`${base}/webhook/guarded`, { method: 'POST', headers: { ...authed, 'x-delivery': 'd1' }, body: '{}' });
    assert.equal(first.status, 200);
    const replay = await fetch(`${base}/webhook/guarded`, { method: 'POST', headers: { ...authed, 'x-delivery': 'd1' }, body: '{}' });
    assert.equal(replay.status, 409);
    // rpm=4 (the earlier 401 already consumed one slot): two more fresh keys
    // pass, the next fresh call is over budget.
    assert.equal((await fetch(`${base}/webhook/guarded`, { method: 'POST', headers: { ...authed, 'x-delivery': 'd2' }, body: '{}' })).status, 200);
    assert.equal((await fetch(`${base}/webhook/guarded`, { method: 'POST', headers: { ...authed, 'x-delivery': 'd3' }, body: '{}' })).status, 429);
  });

  it('webhook HMAC auth verifies the raw body (P0-5)', async () => {
    const crypto = require('crypto');
    const cred: any = await (await fetch(`${base}/v1/credentials`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ accountId: 'acc-h', name: 'hm', kind: 'hmac', secret: 'hmac-key' }),
    })).json();
    const def = {
      nodes: [
        { name: 'W', type: 'n8n-nodes-base.webhook', parameters: { path: 'hmac-hook', httpMethod: 'POST', auth: { mode: 'hmac-sha256', credentialId: cred.id } } },
        { name: 'L', type: 'n8n-nodes-base.noOp', parameters: {} },
      ],
      connections: { W: { main: [[{ node: 'L' }]] } },
    };
    const c: any = await (await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'hmac-wf', definition: def }) })).json();
    await fetch(`${base}/v1/workflows/${c.id}/activate`, { method: 'POST', headers: H, body: '{}' });
    const body = JSON.stringify({ a: 1 });
    const sig = crypto.createHmac('sha256', 'hmac-key').update(Buffer.from(body)).digest('hex');
    const good = await fetch(`${base}/webhook/hmac-hook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': sig }, body });
    assert.equal(good.status, 200);
    const bad = await fetch(`${base}/webhook/hmac-hook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': 'deadbeef' }, body });
    assert.equal(bad.status, 401);
  });

  it('webhook accepts GitHub-style X-Hub-Signature-256 (sha256= prefix)', async () => {
    const crypto = require('crypto');
    const cred: any = await (await fetch(`${base}/v1/credentials`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ accountId: 'acc-gh', name: 'gh-secret', kind: 'hmac', secret: 'github-secret' }),
    })).json();
    const def = {
      nodes: [
        { name: 'W', type: 'n8n-nodes-base.webhook', parameters: { path: 'gh-push-test', httpMethod: 'POST', auth: { mode: 'hmac-sha256', header: 'x-hub-signature-256', credentialId: cred.id } } },
        { name: 'L', type: 'n8n-nodes-base.noOp', parameters: {} },
      ],
      connections: { W: { main: [[{ node: 'L' }]] } },
    };
    const c: any = await (await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'gh-wf', definition: def }) })).json();
    await fetch(`${base}/v1/workflows/${c.id}/activate`, { method: 'POST', headers: H, body: '{}' });
    const body = JSON.stringify({ ref: 'refs/heads/main', commits: [] });
    const sig = 'sha256=' + crypto.createHmac('sha256', 'github-secret').update(Buffer.from(body)).digest('hex');
    const good = await fetch(`${base}/webhook/gh-push-test`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body });
    assert.equal(good.status, 200);
    const bad = await fetch(`${base}/webhook/gh-push-test`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' }, body });
    assert.equal(bad.status, 401);
  });

  it('tenant binding, cross-tenant 404s and revision++ (P0-3/P2)', async () => {
    const mine: any = await (await fetch(`${base}/v1/workflows`, {
      method: 'POST',
      headers: P({ 'x-synapsedx-user': 'u1', 'x-synapsedx-org': 'acme', 'x-synapsedx-account': 'prod' }),
      body: JSON.stringify({ template: 'manual-starter', name: 'tenant-wf' }),
    })).json();
    assert.equal(mine.orgId, 'acme');
    assert.equal(mine.accountId, 'prod');
    assert.equal(mine.owner, 'u1');
    assert.equal(mine.revision, 1);
    // Another org cannot see it.
    const peek = await fetch(`${base}/v1/workflows/${mine.id}`, {
      headers: P({ 'x-synapsedx-user': 'u2', 'x-synapsedx-org': 'other' }),
    });
    assert.equal(peek.status, 404);
    // ...nor plant workflows into a foreign org.
    const plant = await fetch(`${base}/v1/workflows`, {
      method: 'POST',
      headers: P({ 'x-synapsedx-user': 'u2', 'x-synapsedx-org': 'other' }),
      body: JSON.stringify({ template: 'manual-starter', name: 'plant', orgId: 'acme' }),
    });
    assert.equal(plant.status, 403);
    // Update bumps revision.
    const upd: any = await (await fetch(`${base}/v1/workflows/${mine.id}`, {
      method: 'PUT',
      headers: P({ 'x-synapsedx-user': 'u1', 'x-synapsedx-org': 'acme' }),
      body: JSON.stringify({ name: 'tenant-wf-2' }),
    })).json();
    assert.equal(upd.revision, 2);
    // Execute records principal + actor.
    const ex: any = await (await fetch(`${base}/v1/workflows/${mine.id}/execute`, {
      method: 'POST',
      headers: P({ 'Content-Type': 'application/json', 'x-synapsedx-user': 'u1', 'x-synapsedx-org': 'acme' }),
      body: JSON.stringify({ value: 4 }),
    })).json();
    const one: any = await (await fetch(`${base}/v1/executions/${ex.executionId}?includeData=true`, { headers: H })).json();
    assert.equal(one.actor, `workflow:${mine.id} principal:u1`);
    assert.equal(one.principal?.sub, 'u1');
  });

  it('execution payloads mask secret-looking keys (P0-4)', async () => {
    const c: any = await (await fetch(`${base}/v1/workflows`, { method: 'POST', headers: H, body: JSON.stringify({ template: 'manual-starter', name: 'mask' }) })).json();
    const ex: any = await (await fetch(`${base}/v1/workflows/${c.id}/execute`, {
      method: 'POST', headers: H, body: JSON.stringify({ value: 1, password: 'hunter2', nested: { apiKey: 'k' } }),
    })).json();
    const one: any = await (await fetch(`${base}/v1/executions/${ex.executionId}?includeData=true`, { headers: H })).json();
    const dump = JSON.stringify(one);
    assert.ok(!dump.includes('hunter2'));
    assert.equal(one.input.password, '***');
  });

  it('/metrics exposes run counters (P2)', async () => {
    const r = await fetch(`${base}/metrics`, { headers: H });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(text.includes('synapsedx_workflow_runs_total'));
    assert.ok(text.includes('synapsedx_workflow_webhook_rejected_total'));
  });
});
