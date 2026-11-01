// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server';

test('advertises the Tier-2 boundary without a local dependency', async () => {
  const server = createServer().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/v1/capabilities`);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.tier, 2);
  assert.ok(String(body.dependencies.tier1).startsWith('https://'));
  server.close();
});

