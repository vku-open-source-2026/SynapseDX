// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Health/readiness probe semantics.
 *
 * A fresh Tier-2 deployment has no capability collections yet (they are created
 * on the first write), so the readiness probe must not report the whole tier as
 * down (HTTP 503) before the first dataset exists. A rejected credential or a
 * timeout must still fail the probe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SynapseOneError } from '@synapseone/sdk';
import { baseDatasetsProbe, probeDependency } from './routes/health';

const client = {} as any;

test('a lazily created collection does not make readiness fail', async () => {
  const fakeClient = {
    base: { queryDocuments: async () => { throw new SynapseOneError('collection not found', { status: 404 }); } },
  } as any;
  const result = await probeDependency(baseDatasetsProbe(), fakeClient, 50);
  assert.equal(result.status, 'ok');
  assert.equal(result.error, undefined);
});

test('a real Tier-1 failure still fails the base probe', async () => {
  const fakeClient = {
    base: { queryDocuments: async () => { throw new SynapseOneError('forbidden', { status: 403 }); } },
  } as any;
  const result = await probeDependency(baseDatasetsProbe(), fakeClient, 50);
  assert.equal(result.status, 'down');
  assert.equal(result.error, 'credential_rejected');
});

test('a rejected upstream credential fails the critical probe', async () => {
  const result = await probeDependency({
    name: 'base',
    critical: true,
    run: async () => { throw new SynapseOneError('unauthorized', { status: 401 }); },
  }, client, 50);
  assert.equal(result.status, 'down');
  assert.equal(result.error, 'credential_rejected');
});

test('a hung dependency is reported as a timeout', async () => {
  const result = await probeDependency({
    name: 'base',
    critical: true,
    run: () => new Promise<void>(() => { /* never settles */ }),
  }, client, 10);
  assert.equal(result.status, 'down');
  assert.equal(result.error, 'timeout');
});

test('a non-critical failure only degrades readiness', async () => {
  const result = await probeDependency({
    name: 'stream',
    critical: false,
    run: async () => { throw new SynapseOneError('upstream exploded', { status: 500 }); },
  }, client, 50);
  assert.equal(result.status, 'degraded');
  assert.equal(result.error, 'upstream_500');
});
