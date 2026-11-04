// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { createGateway } from './index';

interface Upstream {
  base: string;
  requests: Array<{ method: string; url: string; headers: Record<string, string>; body: Buffer }>;
  close(): Promise<void>;
  hang: boolean;
  healthy: boolean;
}

async function startUpstream(): Promise<Upstream> {
  const state = {
    hang: false,
    healthy: true,
    requests: [] as Array<{ method: string; url: string; headers: Record<string, string>; body: Buffer }>,
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[key] = value;
      state.requests.push({ method: req.method || 'GET', url: req.url || '/', headers, body: Buffer.concat(chunks) });
      if (state.hang) return;
      if (req.url === '/health' || req.url === '/ready') {
        const body = JSON.stringify({ status: state.healthy ? 'ok' : 'down', dependencies: [{ name: 'base', status: 'ok' }] });
        res.writeHead(state.healthy ? 200 : 503, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-total-count': '2',
        'x-lds-license': 'CC-BY-4.0',
        'x-correlation-id': headers['x-correlation-id'] || '',
      });
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        echoed: headers['if-match'] || null,
        idempotency: headers['idempotency-key'] || null,
        apiKey: headers['x-api-key'] || null,
        tenant: headers['x-synapseone-tenant'] || null,
        product: headers['x-synapsedx-product'] || null,
        bytes: Buffer.concat(chunks).length,
        content: Buffer.concat(chunks).toString('utf8'),
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    requests: state.requests,
    get hang() { return state.hang; },
    set hang(value: boolean) { state.hang = value; },
    get healthy() { return state.healthy; },
    set healthy(value: boolean) { state.healthy = value; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as Upstream;
}

async function startGateway(options: { upstream: string; timeoutMs?: number; corsOrigins?: string[] }) {
  const app = createGateway({ upstream: options.upstream, timeoutMs: options.timeoutMs ?? 5000, corsOrigins: options.corsOrigins });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('forwards credentials, conditional/idempotency headers and raw bodies', async () => {
  const upstream = await startUpstream();
  const gateway = await startGateway({ upstream: upstream.base });
  try {
    const body = Buffer.from([0, 1, 2, 3, 255]);
    const response = await fetch(`${gateway.base}/v1/capabilities/datasets`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'if-match': '"7"',
        'idempotency-key': 'op-12345678',
        'x-api-key': 'key-1',
        'x-synapseone-tenant': 'acct-a',
        'x-synapsedx-product': 'sos',
        'x-correlation-id': 'corr-42',
      },
      body,
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.bytes, body.length);
    assert.equal(payload.echoed, '"7"');
    assert.equal(payload.idempotency, 'op-12345678');
    assert.equal(payload.apiKey, 'key-1');
    assert.equal(payload.tenant, 'acct-a');
    assert.equal(payload.product, 'sos');
    assert.equal(payload.url, '/v1/capabilities/datasets');
    assert.equal(response.headers.get('x-total-count'), '2');
    assert.equal(response.headers.get('x-lds-license'), 'CC-BY-4.0');
    assert.equal(response.headers.get('x-correlation-id'), 'corr-42');
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('a hanging upstream returns 504 within the configured timeout', async () => {
  const upstream = await startUpstream();
  const gateway = await startGateway({ upstream: upstream.base, timeoutMs: 150 });
  try {
    upstream.hang = true;
    const started = Date.now();
    const response = await fetch(`${gateway.base}/v1/capabilities/datasets`);
    assert.equal(response.status, 504);
    const body = await response.json() as any;
    assert.equal(body.error.code, 'upstream_timeout');
    assert.ok(Date.now() - started < 2000);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('CORS answers both Tier-3 origins and exposes write headers', async () => {
  const upstream = await startUpstream();
  const gateway = await startGateway({ upstream: upstream.base });
  try {
    for (const origin of ['https://synapsecity.sbs', 'https://sos.synapsecity.sbs']) {
      const response = await fetch(`${gateway.base}/v1/capabilities/datasets`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'DELETE' },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.match(String(response.headers.get('access-control-allow-methods')), /DELETE/);
      assert.match(String(response.headers.get('access-control-allow-headers')), /if-match/);
      assert.match(String(response.headers.get('vary')), /Origin/i);
    }
    const unknown = await fetch(`${gateway.base}/v1/capabilities/datasets`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(unknown.headers.get('access-control-allow-origin'), null);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('health and readiness expose upstream dependency state', async () => {
  const upstream = await startUpstream();
  const gateway = await startGateway({ upstream: upstream.base });
  try {
    const healthy = await fetch(`${gateway.base}/health`);
    assert.equal(healthy.status, 200);
    const healthBody = await healthy.json() as any;
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.dependencies[0].name, 'capabilities');

    upstream.healthy = false;
    const degraded = await fetch(`${gateway.base}/ready`);
    assert.equal(degraded.status, 503);
    assert.equal((await degraded.json() as any).status, 'degraded');
  } finally {
    await gateway.close();
    await upstream.close();
  }
});

test('unknown routes return the JSON error envelope', async () => {
  const upstream = await startUpstream();
  const gateway = await startGateway({ upstream: upstream.base });
  try {
    const response = await fetch(`${gateway.base}/not-a-route`);
    assert.equal(response.status, 404);
    const body = await response.json() as any;
    assert.equal(body.error.code, 'route_not_found');
    assert.ok(body.error.requestId);
  } finally {
    await gateway.close();
    await upstream.close();
  }
});
