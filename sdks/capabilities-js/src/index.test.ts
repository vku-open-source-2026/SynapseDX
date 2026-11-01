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
