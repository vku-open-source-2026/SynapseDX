// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi } from '../public/api.js';
import { can, canOpenView, navigationFor, primaryRole, roleLabel } from '../public/rbac.js';
import {
  parseJsonObject, previewJson, statusClass, statusLabel,
} from '../public/format.js';

const operator = {
  roles: ['operator', 'manager'],
  permissions: ['summary:read', 'datasets:read', 'datasets:write', 'records:read', 'records:write', 'events:read', 'events:flush', 'audit:read', 'settings:read'],
};
const moderator = {
  roles: ['moderator', 'manager'],
  permissions: ['summary:read', 'datasets:read', 'records:read', 'moderation:read', 'moderation:write', 'audit:read'],
};
const admin = {
  roles: ['admin'],
  permissions: ['summary:read', 'datasets:read', 'datasets:write', 'records:read', 'records:write', 'moderation:read', 'moderation:write', 'events:read', 'events:flush', 'audit:read', 'users:read', 'settings:write'],
};

test('navigation is permission-driven and public visitors only see the catalog', () => {
  assert.deepEqual(navigationFor(null).map((item) => item.view), ['overview', 'datasets']);
  assert.deepEqual(navigationFor(operator).map((item) => item.view), ['overview', 'datasets', 'records', 'events', 'audit', 'settings']);
  assert.deepEqual(navigationFor(moderator).map((item) => item.view), ['overview', 'datasets', 'records', 'moderation', 'audit']);
  assert.deepEqual(navigationFor(admin).map((item) => item.view), ['overview', 'datasets', 'records', 'moderation', 'team', 'events', 'audit', 'settings']);
  assert.equal(canOpenView(operator, 'moderation'), false);
  assert.equal(canOpenView(moderator, 'moderation'), true);
  assert.equal(can(admin, 'users:read'), true);
  assert.equal(can(operator, 'moderation:write'), false);
});

test('role labels prefer the strongest management role', () => {
  assert.equal(primaryRole(admin), 'admin');
  assert.equal(primaryRole(moderator), 'moderator');
  assert.equal(primaryRole(operator), 'operator');
  assert.equal(primaryRole(null), null);
  assert.equal(roleLabel(admin), 'Administrator');
  assert.equal(roleLabel(null), 'Public');
});

test('formatting helpers keep status semantics and JSON validation', () => {
  assert.equal(statusLabel('pending'), 'Pending review');
  assert.equal(statusClass('published'), 'ok');
  assert.equal(statusClass('rejected'), 'bad');
  assert.equal(statusClass('draft'), 'neutral');
  assert.equal(previewJson({ a: 1 }), '{"a":1}');
  assert.equal(previewJson({ a: 'x'.repeat(200) }, 20).endsWith('…'), true);
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.throws(() => parseJsonObject('[]'), /JSON object/);
  assert.throws(() => parseJsonObject('{'), /valid JSON/);
});

test('api client attaches the bearer token, serializes JSON and surfaces the error envelope', async () => {
  const calls = [];
  const api = createApi({
    getToken: () => 'session-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(await api.get('/v1/capabilities/datasets'), { ok: true });
  assert.equal(calls[0].options.headers.authorization, 'Bearer session-token');
  await api.post('/v1/capabilities/datasets', { name: 'x' });
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers['content-type'], 'application/json');
  assert.equal(calls[1].options.body, '{"name":"x"}');

  const failing = createApi({
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'moderation_forbidden', message: 'no', requestId: 'r1' } }), { status: 403 }),
  });
  await assert.rejects(failing.post('/x', {}), (error) => {
    assert.equal(error instanceof ApiError, true);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'moderation_forbidden');
    assert.equal(error.requestId, 'r1');
    return true;
  });
});

test('api client invokes the unauthorized hook before throwing', async () => {
  let unauthorized = 0;
  const api = createApi({
    onUnauthorized: () => { unauthorized += 1; },
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'sign in' } }), { status: 401 }),
  });
  await assert.rejects(api.get('/x'), (error) => error.status === 401);
  assert.equal(unauthorized, 1);
});
