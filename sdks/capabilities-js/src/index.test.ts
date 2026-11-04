// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilitiesClient } from './index';

test('defaults to the public SynapseDX domain', () => {
  const client = new CapabilitiesClient();
  assert.equal((client as any).http.baseUrl, 'https://synapsedx.sbs');
});

test('rejects localhost as a runtime dependency', () => {
  assert.throws(() => new CapabilitiesClient({ baseUrl: 'http://localhost:8082' }), /local dependency URL/);
});

test('dataset updates use PATCH and send the requested license', async () => {
  const original = globalThis.fetch;
  let capturedUrl = '';
  let capturedMethod = '';
  let capturedBody = '';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedMethod = String(init?.method || 'GET');
    capturedBody = String(init?.body || '');
    return new Response(JSON.stringify({ id: 'city-assets', license: 'PDDL-1.0', status: 'published' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const client = new CapabilitiesClient({ baseUrl: 'https://synapsedx.sbs' });
    const updated = await client.datasets.update('city-assets', { license: 'PDDL-1.0' });
    assert.equal(capturedUrl, 'https://synapsedx.sbs/v1/capabilities/datasets/city-assets');
    assert.equal(capturedMethod, 'PATCH');
    assert.deepEqual(JSON.parse(capturedBody), { license: 'PDDL-1.0' });
    assert.equal(updated.license, 'PDDL-1.0');
  } finally {
    globalThis.fetch = original;
  }
});
