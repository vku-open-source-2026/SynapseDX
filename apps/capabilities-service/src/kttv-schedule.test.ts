// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { kttvWorkflowDefinition } from './kttv-schedule';

test('KTTV schedule runs inline and calls the public trigger', () => {
  const definition = kttvWorkflowDefinition({
    publicUrl: 'https://synapsedx.sbs',
    kttvScheduleEverySeconds: 1800,
    serviceApiKey: 'test-only',
  } as any, 'credential-1');
  assert.deepEqual((definition as any).settings.execution, { mode: 'inline' });
  const trigger = (definition as any).nodes.find((node: any) => node.name === 'Trigger KTTV crawler');
  assert.equal(trigger.parameters.url, 'https://synapsedx.sbs/v1/capabilities/crawlers/kttv/trigger');
  assert.equal(trigger.parameters.auth.credentialId, 'credential-1');
  assert.deepEqual(trigger.parameters.auth.allowedOrigins, ['https://synapsedx.sbs']);
  assert.equal(trigger.parameters.retry.attempts, 2);
});
