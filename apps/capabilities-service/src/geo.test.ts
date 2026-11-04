// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, IncomingMessage, Server } from 'node:http';
import { api, startHarness } from './testing/harness';

async function startProvider(handler: (req: IncomingMessage, url: URL) => { status?: number; body: unknown; headers?: Record<string, string> }): Promise<{ base: string; close(): Promise<void>; requests: Array<{ path: string; headers: Record<string, string>; query: URLSearchParams }> }> {
  const requests: Array<{ path: string; headers: Record<string, string>; query: URLSearchParams }> = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://provider');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[key] = value;
    requests.push({ path: url.pathname, headers, query: url.searchParams });
    const result = handler(req, url);
    const text = JSON.stringify(result.body);
    res.writeHead(result.status || 200, {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...(result.headers || {}),
    });
    res.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requests,
  };
}

test('the geocoder adapter is provider-neutral, keeps the key server-side and normalizes results', async () => {
  const provider = await startProvider((_req, url) => ({ body: { results: [{ id: 'p1', label: 'Hai Chau', address: 'Hai Chau, Da Nang', lat: 16.06, lon: 108.22 }] } }));
  const harness = await startHarness({
    SYNAPSEDX_GEOCODER_PROVIDER: 'generic',
    SYNAPSEDX_GEOCODER_BASE_URL: provider.base,
    SYNAPSEDX_GEOCODER_API_KEY: 'provider-secret',
  });
  try {
    const autocomplete = await api(harness, '/v1/capabilities/geo/autocomplete?q=Hai%20Chau&limit=3', { token: 'user-token' });
    assert.equal(autocomplete.status, 200);
    assert.equal(autocomplete.body.provider, 'generic');
    assert.equal(autocomplete.body.items[0].label, 'Hai Chau');
    assert.equal(autocomplete.body.items[0].lat, 16.06);
    assert.equal(provider.requests[0].headers['x-api-key'], 'provider-secret');
    assert.equal(provider.requests[0].query.get('q'), 'Hai Chau');
    assert.equal(JSON.stringify(autocomplete.body).includes('provider-secret'), false);

    const geocode = await api(harness, '/v1/capabilities/geo/geocode?address=Hai%20Chau', { token: 'user-token' });
    assert.equal(geocode.status, 200);
    assert.match(provider.requests[1].path, /^\/geocode$/);

    const reverse = await api(harness, '/v1/capabilities/geo/reverse?lat=16.06&lon=108.22', { token: 'user-token' });
    assert.equal(reverse.status, 200);
    assert.equal(provider.requests[2].query.get('lat'), '16.06');
    assert.equal(provider.requests[2].query.get('lng'), '108.22');

    const place = await api(harness, '/v1/capabilities/geo/place?id=p1', { token: 'user-token' });
    assert.equal(place.status, 200);
    assert.equal(place.body.result.id, 'p1');
    assert.equal(provider.requests[3].query.get('refid'), 'p1');

    const missing = await api(harness, '/v1/capabilities/geo/reverse?lat=abc&lon=1', { token: 'user-token' });
    assert.equal(missing.status, 400);
  } finally {
    await harness.close();
    await provider.close();
  }
});

test('the VietMap preset maps its endpoint/query conventions and normalizes provider fields', async () => {
  const provider = await startProvider((_req, url) => {
    if (url.pathname === '/autocomplete/v4') {
      return { body: [{ ref_id: 'vm-1', display: 'Hai Chau, Da Nang', name: 'Hai Chau', boundaries: [{ full_name: 'Da Nang' }] }] };
    }
    return { body: { display: 'Hai Chau', lat: 16.06, lng: 108.22 } };
  });
  const harness = await startHarness({
    SYNAPSEDX_GEOCODER_PROVIDER: 'vietmap',
    SYNAPSEDX_GEOCODER_BASE_URL: provider.base,
    SYNAPSEDX_GEOCODER_API_KEY: 'vietmap-secret',
  });
  try {
    const autocomplete = await api(harness, '/v1/capabilities/geo/autocomplete?q=Hai%20Chau', { token: 'user-token' });
    assert.equal(autocomplete.status, 200);
    assert.equal(autocomplete.body.provider, 'vietmap');
    assert.equal(autocomplete.body.items[0].id, 'vm-1');
    assert.equal(autocomplete.body.items[0].label, 'Hai Chau, Da Nang');
    assert.equal(autocomplete.body.items[0].address, 'Da Nang');
    assert.equal(provider.requests[0].path, '/autocomplete/v4');
    assert.equal(provider.requests[0].query.get('apikey'), 'vietmap-secret');
    assert.equal(provider.requests[0].query.get('text'), 'Hai Chau');

    const reverse = await api(harness, '/v1/capabilities/geo/reverse?lat=16.06&lon=108.22', { token: 'user-token' });
    assert.equal(reverse.status, 200);
    assert.equal(provider.requests[1].path, '/reverse/v4');
    assert.equal(reverse.body.items[0].lat, 16.06);
    assert.equal(reverse.body.items[0].lon, 108.22);
  } finally {
    await harness.close();
    await provider.close();
  }
});

test('provider rate limits surface as a typed 429 with retry information', async () => {
  const provider = await startProvider(() => ({ status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '30' } } as any));
  const harness = await startHarness({
    SYNAPSEDX_GEOCODER_PROVIDER: 'generic',
    SYNAPSEDX_GEOCODER_BASE_URL: provider.base,
    SYNAPSEDX_GEOCODER_API_KEY: 'provider-secret',
  });
  try {
    const response = await api(harness, '/v1/capabilities/geo/autocomplete?q=Hanoi', { token: 'user-token' });
    assert.equal(response.status, 429);
    assert.equal(response.body.error.code, 'rate_limited');
    assert.equal(response.body.error.details.retryAfter, '30');
  } finally {
    await harness.close();
    await provider.close();
  }
});

test('provider failures become a typed 503 without leaking the provider body', async () => {
  const provider = await startProvider(() => ({ status: 500, body: { error: 'provider exploded', secret: 'x' } }));
  const harness = await startHarness({
    SYNAPSEDX_GEOCODER_PROVIDER: 'generic',
    SYNAPSEDX_GEOCODER_BASE_URL: provider.base,
    SYNAPSEDX_GEOCODER_API_KEY: 'provider-secret',
  });
  try {
    const response = await api(harness, '/v1/capabilities/geo/geocode?address=Hanoi', { token: 'user-token' });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'geocoder_unavailable');
    assert.equal(response.body.error.details.providerStatus, 500);
    assert.equal(JSON.stringify(response.body).includes('provider exploded'), false);
  } finally {
    await harness.close();
    await provider.close();
  }
});
