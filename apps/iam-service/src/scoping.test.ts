/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Cross-tenant scoping: attach/assign/SA-mint must not bleed across
 * accounts/orgs. Runs against the in-memory DB (no DATABASE_URL here).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from './index';
import { verifyAccess } from './tokens';

describe('iam cross-tenant scoping', () => {
  let base = '';
  let server: Server | null = null;
  const saved: Record<string, string | undefined> = {};
  const H = (token: string) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'x-synapseone-internal': 'test-secret-123',
  });

  async function post(path: string, body: any, token: string) {
    const r = await fetch(base + path, { method: 'POST', headers: H(token), body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  }

  let token = '';
  let token2 = '';
  let org1 = '';
  let acc1 = '';
  let acc2 = '';
  let user1 = '';
  let user2 = '';
  let role1 = '';
  let pol1 = '';
  let role2 = '';
  let pol2 = '';
  let org2 = '';
  let accX = '';
  let roleX = '';

  before(
    () =>
      new Promise<void>((resolve, reject) => {
        for (const k of ['SYNAPSEONE_INTERNAL_SECRET', 'NODE_ENV', 'DATABASE_URL', 'IAM_ALLOW_DEV_LOGIN']) {
          saved[k] = process.env[k];
        }
        process.env.SYNAPSEONE_INTERNAL_SECRET = 'test-secret-123';
        delete process.env.DATABASE_URL;
        delete process.env.NODE_ENV;
        (async () => {
          const app = createApp();
          server = app.listen(0, '127.0.0.1', async () => {
            try {
              const a = server!.address();
              base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
              const login = await post('/v1/auth/login', { email: 'scope@test.local', orgSlug: 'scopeorg' }, '');
              assert.equal(login.status, 200);
              token = login.json.accessToken;
              user1 = login.json.user.id;
              org1 = login.json.user.org_id;
              const mk = async (path: string, body: any) => {
                const r = await post(path, body, token);
                assert.equal(r.status, 201, `${path} → ${r.status} ${JSON.stringify(r.json)}`);
                return r.json;
              };
              acc1 = (await mk(`/v1/orgs/${org1}/accounts`, { slug: 'a1', displayName: 'A1' })).id;
              acc2 = (await mk(`/v1/orgs/${org1}/accounts`, { slug: 'a2', displayName: 'A2' })).id;
              const adminDoc = { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] };
              role1 = (await mk(`/v1/accounts/${acc1}/roles`, { slug: 'r1' })).id;
              pol1 = (await mk(`/v1/accounts/${acc1}/policies`, { slug: 'p1', document: adminDoc })).id;
              role2 = (await mk(`/v1/accounts/${acc2}/roles`, { slug: 'r2' })).id;
              pol2 = (await mk(`/v1/accounts/${acc2}/policies`, { slug: 'p2', document: adminDoc })).id;
              const login2 = await post('/v1/auth/login', { email: 'other@test.local', orgSlug: 'otherorg' }, '');
              assert.equal(login2.status, 200);
              token2 = login2.json.accessToken;
              user2 = login2.json.user.id;
              org2 = login2.json.user.org_id;
              const mk2 = async (path: string, body: any) => {
                const r = await post(path, body, token2);
                assert.equal(r.status, 201, `${path} → ${r.status} ${JSON.stringify(r.json)}`);
                return r.json;
              };
              accX = (await mk2(`/v1/orgs/${org2}/accounts`, { slug: 'x', displayName: 'X Org' })).id;
              roleX = (await mk2(`/v1/accounts/${accX}/roles`, { slug: 'rx' })).id;
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        })().catch(reject);
      }),
  );

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('attach same-account policy → ok', async () => {
    const r = await post(`/v1/roles/${role1}/attach`, { policyId: pol1 }, token);
    assert.equal(r.status, 200);
  });

  it('detach removes the grant (verified via effective policies)', async () => {
    await post(`/v1/roles/${role1}/attach`, { policyId: pol1 }, token);
    const before = await post(`/v1/users/${user1}/assign`, { roleId: role1 }, token);
    assert.equal(before.status, 200);
    const eff1 = await (await fetch(`${base}/v1/users/${user1}/policies`, { headers: H(token) })).json();
    assert.ok(eff1.length >= 1);
    const det = await fetch(`${base}/v1/roles/${role1}/policies/${pol1}`, { method: 'DELETE', headers: H(token) });
    assert.equal(det.status, 200);
    const eff2 = await (await fetch(`${base}/v1/users/${user1}/policies`, { headers: H(token) })).json();
    assert.deepEqual(eff2, []);
    const ghost = await fetch(`${base}/v1/roles/${role1}/policies/00000000-0000-4000-8000-000000000000`, { method: 'DELETE', headers: H(token) });
    assert.equal(ghost.status, 404);
    const foreign = await fetch(`${base}/v1/roles/${role1}/policies/${pol1}`, { method: 'DELETE', headers: H(token2) });
    assert.equal(foreign.status, 403);
    // role policies listing mirrors attach/detach
    await post(`/v1/roles/${role1}/attach`, { policyId: pol1 }, token);
    const listed = await (await fetch(`${base}/v1/roles/${role1}/policies`, { headers: H(token) })).json();
    assert.deepEqual(listed.map((p: any) => p.id), [pol1]);
    const ghostList = await fetch(`${base}/v1/roles/00000000-0000-4000-8000-000000000000/policies`, { headers: H(token) });
    assert.equal(ghostList.status, 404);
  });

  it('attach cross-account policy → 403 cross_account', async () => {
    const r = await post(`/v1/roles/${role1}/attach`, { policyId: pol2 }, token);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'cross_account');
  });

  it('assign same-org role → ok', async () => {
    const r = await post(`/v1/users/${user1}/assign`, { roleId: role1 }, token);
    assert.equal(r.status, 200);
  });

  it('unassign removes the grant, foreign caller → 403', async () => {
    const un = await fetch(`${base}/v1/users/${user1}/roles/${role1}`, { method: 'DELETE', headers: H(token) });
    assert.equal(un.status, 200);
    const eff = await (await fetch(`${base}/v1/users/${user1}/policies`, { headers: H(token) })).json();
    assert.deepEqual(eff, []);
    await post(`/v1/users/${user1}/assign`, { roleId: role1 }, token);
    const foreign = await fetch(`${base}/v1/users/${user1}/roles/${role1}`, { method: 'DELETE', headers: H(token2) });
    assert.equal(foreign.status, 403);
    const bad = await fetch(`${base}/v1/users/not-a-uuid/roles/${role1}`, { method: 'DELETE', headers: H(token) });
    assert.equal(bad.status, 400);
    const roles = await (await fetch(`${base}/v1/users/${user1}/roles`, { headers: H(token) })).json();
    assert.deepEqual(roles.map((r: any) => r.id), [role1]);
    const ghostRoles = await fetch(`${base}/v1/users/00000000-0000-4000-8000-000000000000/roles`, { headers: H(token) });
    assert.equal(ghostRoles.status, 404);
  });

  it('assign role from another org → 403 cross_org', async () => {
    const r = await post(`/v1/users/${user1}/assign`, { roleId: roleX }, token);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'cross_org');
  });

  it('mint SA token for own account → ok, other-org account → 403', async () => {
    const mkSa = async (acc: string, tok: string) => {
      const r = await post(`/v1/accounts/${acc}/service-accounts`, { slug: `sa-${acc.slice(0, 4)}` }, tok);
      assert.equal(r.status, 201);
      return r.json.id;
    };
    const sa1 = await mkSa(acc1, token);
    const ok = await post(`/v1/service-accounts/${sa1}/token`, {}, token);
    assert.equal(ok.status, 200);
    assert.ok(ok.json.accessToken);
    // #8: an omitted scopes list falls back to the caller's own scopes — a
    // user JWT holds none, so the minted token must not carry wildcards.
    assert.deepEqual(verifyAccess(ok.json.accessToken).scopes, []);
    const saX = await mkSa(accX, token2);
    const denied = await post(`/v1/service-accounts/${saX}/token`, {}, token);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'forbidden');
  });

  it('fresh user (no roles) mints/lists in own org via org fallback, not in others', async () => {
    const fresh = await post('/v1/auth/login', { email: 'fresh@test.local', orgSlug: 'scopeorg' }, '');
    assert.equal(fresh.status, 200);
    const ft = fresh.json.accessToken;
    const sa = await post(`/v1/accounts/${acc1}/service-accounts`, { slug: 'sa-fresh' }, ft);
    assert.equal(sa.status, 201);
    const mint = await post(`/v1/service-accounts/${sa.json.id}/token`, {}, ft);
    assert.equal(mint.status, 200, JSON.stringify(mint.json));
    const list = await fetch(`${base}/v1/accounts/${acc1}/keys`, { headers: H(ft) });
    assert.equal(list.status, 200);
    const saX = await post(`/v1/accounts/${accX}/service-accounts`, { slug: 'sa-freshx' }, token2);
    assert.equal(saX.status, 201);
    const deniedMint = await post(`/v1/service-accounts/${saX.json.id}/token`, {}, ft);
    assert.equal(deniedMint.status, 403);
    const deniedList = await fetch(`${base}/v1/accounts/${accX}/keys`, { headers: H(ft) });
    assert.equal(deniedList.status, 403);
  });

  it('key creation validates userId', async () => {
    const bad = await post(`/v1/accounts/${acc1}/keys`, { name: 'k', userId: 'nope' }, token);
    assert.equal(bad.status, 400);
    const ghost = await post(`/v1/accounts/${acc1}/keys`, { name: 'k', userId: '00000000-0000-4000-8000-000000000000' }, token);
    assert.equal(ghost.status, 404);
    const ok = await post(`/v1/accounts/${acc1}/keys`, { name: 'k', userId: user1 }, token);
    assert.equal(ok.status, 201);
  });

  it('malformed key id → 400, refresh without body → 400', async () => {
    const r = await fetch(`${base}/v1/keys/not-a-uuid`, { method: 'DELETE', headers: H(token) });
    assert.equal(r.status, 400);
    const r2 = await post('/v1/auth/refresh', {}, token);
    assert.equal(r2.status, 400);
    assert.equal(r2.json.error, 'invalid_refresh_token');
  });

  it('oversized body beyond parser limit → 413 (not 500)', async () => {
    const r = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${'x'.repeat(2 * 1024 * 1024)}@y.co` }),
    });
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error, 'payload_too_large');
  });

  it('creates under a ghost parent → 404 (no orphans)', async () => {    const ghost = '00000000-0000-4000-8000-000000000000';
    const cases: Array<[string, any, string]> = [
      [`/v1/orgs/${ghost}/accounts`, { slug: 'x', displayName: 'Xx' }, 'org_not_found'],
      [`/v1/orgs/${ghost}/users`, { email: 'g@g.co' }, 'org_not_found'],
      [`/v1/accounts/${ghost}/roles`, { slug: 'x' }, 'account_not_found'],
      [`/v1/accounts/${ghost}/policies`, { slug: 'x', document: { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] } }, 'account_not_found'],
      [`/v1/accounts/${ghost}/keys`, { name: 'x' }, 'account_not_found'],
      [`/v1/accounts/${ghost}/service-accounts`, { slug: 'x' }, 'account_not_found'],
    ];
    for (const [path, body, code] of cases) {
      const r = await post(path, body, token);
      assert.equal(r.status, 404, `${path} → ${r.status}`);
      assert.equal(r.json.error, code, path);
    }
  });

  it('foreign caller cannot write in another tenant → 403', async () => {
    const adminDoc = { Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] };
    // create role/policy/SA/key in org1's account with org2's token
    assert.equal((await post(`/v1/accounts/${acc1}/roles`, { slug: 'evil' }, token2)).status, 403);
    assert.equal((await post(`/v1/accounts/${acc1}/policies`, { slug: 'evil', document: adminDoc }, token2)).status, 403);
    assert.equal((await post(`/v1/accounts/${acc1}/keys`, { name: 'evil' }, token2)).status, 403);
    assert.equal((await post(`/v1/accounts/${acc1}/service-accounts`, { slug: 'evil' }, token2)).status, 403);
    assert.equal((await post(`/v1/orgs/${org1}/accounts`, { slug: 'evil', displayName: 'Evil' }, token2)).status, 403);
    assert.equal((await post(`/v1/orgs/${org1}/users`, { email: 'evil@x.co' }, token2)).status, 403);
    // attach/assign/delete within org1 with org2's token
    assert.equal((await post(`/v1/roles/${role1}/attach`, { policyId: pol1 }, token2)).status, 403);
    assert.equal((await post(`/v1/users/${user1}/assign`, { roleId: role1 }, token2)).status, 403);
    const delRole = await fetch(`${base}/v1/roles/${role1}`, { method: 'DELETE', headers: H(token2) });
    assert.equal(delRole.status, 403);
    const delPol = await fetch(`${base}/v1/policies/${pol1}`, { method: 'DELETE', headers: H(token2) });
    assert.equal(delPol.status, 403);
  });

  it('foreign caller cannot revoke another tenant key → 403', async () => {
    const created = await post(`/v1/accounts/${acc1}/keys`, { name: 'victim' }, token);
    assert.equal(created.status, 201);
    const del = await fetch(`${base}/v1/keys/${created.json.id}`, { method: 'DELETE', headers: H(token2) });
    assert.equal(del.status, 403);
    // owner can still revoke
    const own = await fetch(`${base}/v1/keys/${created.json.id}`, { method: 'DELETE', headers: H(token) });
    assert.equal(own.status, 200);
  });

  it('cross-tenant reads are denied (#7)', async () => {
    // Org listing only ever shows the caller's own org.
    const orgs1: any = await (await fetch(`${base}/v1/orgs`, { headers: H(token) })).json();
    assert.deepEqual(orgs1.map((o: any) => o.id), [org1]);
    const orgs2: any = await (await fetch(`${base}/v1/orgs`, { headers: H(token2) })).json();
    assert.deepEqual(orgs2.map((o: any) => o.id), [org2]);
    // Org-scoped reads: own → 200, foreign → 403.
    assert.equal((await fetch(`${base}/v1/orgs/${org1}/accounts`, { headers: H(token) })).status, 200);
    assert.equal((await fetch(`${base}/v1/orgs/${org1}/users`, { headers: H(token) })).status, 200);
    assert.equal((await fetch(`${base}/v1/orgs/${org2}/accounts`, { headers: H(token) })).status, 403);
    assert.equal((await fetch(`${base}/v1/orgs/${org2}/users`, { headers: H(token) })).status, 403);
    // Account-scoped reads.
    assert.equal((await fetch(`${base}/v1/accounts/${acc1}/roles`, { headers: H(token) })).status, 200);
    assert.equal((await fetch(`${base}/v1/accounts/${acc1}/policies`, { headers: H(token) })).status, 200);
    assert.equal((await fetch(`${base}/v1/accounts/${acc1}/service-accounts`, { headers: H(token) })).status, 200);
    assert.equal((await fetch(`${base}/v1/accounts/${accX}/roles`, { headers: H(token) })).status, 403);
    assert.equal((await fetch(`${base}/v1/accounts/${accX}/policies`, { headers: H(token) })).status, 403);
    assert.equal((await fetch(`${base}/v1/accounts/${accX}/service-accounts`, { headers: H(token) })).status, 403);
    // Role → policies (full policy documents are tenant data).
    assert.equal((await fetch(`${base}/v1/roles/${role1}/policies`, { headers: H(token) })).status, 200);
    assert.equal((await fetch(`${base}/v1/roles/${roleX}/policies`, { headers: H(token) })).status, 403);
    // User → policies/roles.
    assert.equal((await fetch(`${base}/v1/users/${user1}/policies`, { headers: H(token) })).status, 200);
    assert.equal((await fetch(`${base}/v1/users/${user1}/roles`, { headers: H(token) })).status, 200);
    assert.equal((await fetch(`${base}/v1/users/${user2}/policies`, { headers: H(token) })).status, 403);
    assert.equal((await fetch(`${base}/v1/users/${user2}/roles`, { headers: H(token) })).status, 403);
  });

  it('audit rows are tenant-scoped (#7)', async () => {
    const tag = `leak-${Date.now()}`;
    const dry = { documents: [{ Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: tag, Resource: '*' }] }], action: tag, resource: '*' };
    assert.equal((await post('/v1/authorize/dry-run', dry, token)).status, 200);
    const mine: any = await (await fetch(`${base}/v1/audit?limit=200`, { headers: H(token) })).json();
    assert.ok(mine.some((r: any) => r.action === tag), 'own dry-run row visible');
    const theirs: any = await (await fetch(`${base}/v1/audit?limit=200`, { headers: H(token2) })).json();
    assert.ok(!theirs.some((r: any) => r.action === tag), 'foreign dry-run rows hidden');
    // Authorize rows follow the target user's org (here: org1).
    assert.equal((await post('/v1/authorize', { userId: user1, action: tag, resource: '*' }, token)).status, 200);
    const mine2: any = await (await fetch(`${base}/v1/audit?limit=200`, { headers: H(token) })).json();
    assert.ok(mine2.some((r: any) => r.action === tag && r.actor_id === user1));
    const theirs2: any = await (await fetch(`${base}/v1/audit?limit=200`, { headers: H(token2) })).json();
    assert.ok(!theirs2.some((r: any) => r.action === tag));
  });

  it('attach/assign malformed ids → 400 (not 404)', async () => {
    assert.equal((await post(`/v1/roles/${role1}/attach`, { policyId: 'nope' }, token)).json.error, 'invalid_policyId');
    assert.equal((await post(`/v1/roles/${role1}/attach`, { policyId: 123 }, token)).status, 400);
    assert.equal((await post(`/v1/users/${user1}/assign`, { roleId: 'nope' }, token)).json.error, 'invalid_roleId');
  });

  it('limited API key cannot mint wildcard SA token (derived scopes, no stamp)', async () => {
    const kk = await post(`/v1/accounts/${acc1}/keys`, { name: 'limited', scopes: ['workflow:Execute'] }, token);
    assert.equal(kk.status, 201);
    const KH = { 'Content-Type': 'application/json', 'X-API-Key': kk.json.apiKey, 'x-synapseone-internal': 'test-secret-123' };
    const sa = await post(`/v1/accounts/${acc1}/service-accounts`, { slug: 'sa-scope' }, token);
    assert.equal(sa.status, 201);
    const wild = await fetch(`${base}/v1/service-accounts/${sa.json.id}/token`, {
      method: 'POST', headers: KH, body: JSON.stringify({ scopes: ['*'] }),
    });
    assert.equal(wild.status, 403);
    assert.equal((await wild.json()).error, 'scope_escalation');
    const narrow = await fetch(`${base}/v1/service-accounts/${sa.json.id}/token`, {
      method: 'POST', headers: KH, body: JSON.stringify({ scopes: ['workflow:Execute'] }),
    });
    assert.equal(narrow.status, 200);
    assert.deepEqual(verifyAccess((await narrow.json()).accessToken).scopes, ['workflow:Execute']);
    // Omitted body → delegate the caller's own scopes (never widened).
    const omitted = await fetch(`${base}/v1/service-accounts/${sa.json.id}/token`, {
      method: 'POST', headers: KH, body: JSON.stringify({}),
    });
    assert.equal(omitted.status, 200);
    assert.deepEqual(verifyAccess((await omitted.json()).accessToken).scopes, ['workflow:Execute']);
  });

  it('minting scopes the caller does not hold → 403 scope_escalation (#8)', async () => {
    const fresh = await post('/v1/auth/login', { email: 'scoper@test.local', orgSlug: 'scopeorg' }, '');
    assert.equal(fresh.status, 200);
    const ft = fresh.json.accessToken;
    const sa = await post(`/v1/accounts/${acc1}/service-accounts`, { slug: 'sa-scope-fresh' }, ft);
    assert.equal(sa.status, 201);
    // Explicit requested scopes must be a subset of the caller's authority: a
    // role-less user JWT has none.
    const explicit = await post(`/v1/service-accounts/${sa.json.id}/token`, { scopes: ['workflow:Execute'] }, ft);
    assert.equal(explicit.status, 403);
    assert.equal(explicit.json.error, 'scope_escalation');
    const wild = await post(`/v1/service-accounts/${sa.json.id}/token`, { scopes: ['*'] }, ft);
    assert.equal(wild.status, 403);
    assert.equal(wild.json.error, 'scope_escalation');
    // Omitted scopes stay allowed (console compatibility) but yield no authority.
    const ok = await post(`/v1/service-accounts/${sa.json.id}/token`, {}, ft);
    assert.equal(ok.status, 200);
    assert.deepEqual(verifyAccess(ok.json.accessToken).scopes, []);
  });

  it('foreign-org account key list → 403 forbidden', async () => {
    const r = await fetch(`${base}/v1/accounts/${accX}/keys`, { headers: H(token) });
    assert.equal(r.status, 403);
    const own = await fetch(`${base}/v1/accounts/${acc1}/keys`, { headers: H(token) });
    assert.equal(own.status, 200);
  });

  it('key list shows metadata (never secrets), revoke flips status', async () => {
    const created = await post(`/v1/accounts/${acc1}/keys`, { name: 'list-me' }, token);
    assert.equal(created.status, 201);
    const listed = await (await fetch(`${base}/v1/accounts/${acc1}/keys`, { headers: H(token) })).json();
    const mine = (listed as any[]).find((k) => k.id === created.json.id);
    assert.ok(mine, 'created key appears in list');
    assert.equal(mine.name, 'list-me');
    assert.ok(typeof mine.prefix === 'string' && mine.prefix.length > 0);
    assert.ok(!('apiKey' in mine) && !('key_hash' in mine) && !('value' in mine), 'no secret material leaked');
    assert.equal(mine.revoked_at, null);
    const del = await fetch(`${base}/v1/keys/${created.json.id}`, { method: 'DELETE', headers: H(token) });
    assert.equal(del.status, 200);
    const relisted = await (await fetch(`${base}/v1/accounts/${acc1}/keys`, { headers: H(token) })).json();
    const after = (relisted as any[]).find((k) => k.id === created.json.id);
    assert.ok(after.revoked_at, 'revoked key stays listed with revoked_at set');
  });
  it('gateway-stamped tenant headers are honored when the secret is set', async () => {
    // Same valid Bearer credential, but gateway-stamped for org2's account:
    // stamped identity wins (this is the prod path through the gateway).
    const stamped = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-synapseone-internal': 'test-secret-123',
      'x-synapseone-account': accX,
      'x-synapseone-org': org2,
      'x-synapseone-kind': 'user',
    };
    const list = await fetch(`${base}/v1/accounts/${accX}/keys`, { headers: stamped });
    assert.equal(list.status, 200);
    const mk = await fetch(`${base}/v1/accounts/${accX}/roles`, {
      method: 'POST',
      headers: stamped,
      body: JSON.stringify({ slug: 'stamped-role' }),
    });
    assert.equal(mk.status, 201);
  });

  it('stamped headers are ignored without the secret (no spoofing in dev)', async () => {
    const savedSecret = process.env.SYNAPSEONE_INTERNAL_SECRET;
    delete process.env.SYNAPSEONE_INTERNAL_SECRET;
    const app2 = createApp();
    const srv: Server = await new Promise((resolve) => {
      const s = app2.listen(0, '127.0.0.1', () => resolve(s as unknown as Server));
    });
    try {
      const addr = srv.address();
      const b2 = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      // Attacker presents a VALID credential but spoofs org2's tenant headers.
      const spoofed = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-synapseone-account': accX,
        'x-synapseone-org': org2,
      };
      const list = await fetch(`${b2}/v1/accounts/${accX}/keys`, { headers: spoofed });
      assert.equal(list.status, 403);
    } finally {
      if (savedSecret !== undefined) process.env.SYNAPSEONE_INTERNAL_SECRET = savedSecret;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
  it('audit decision filter', async () => {
    const dry = { documents: [{ Version: '2026-01-01', Statement: [{ Effect: 'Allow', Action: 'a', Resource: '*' }] }], action: 'a', resource: '*' };
    assert.equal((await post('/v1/authorize/dry-run', dry, token)).status, 200);
    const dryDeny = { documents: [{ Version: '2026-01-01', Statement: [{ Effect: 'Deny', Action: 'a', Resource: '*' }] }], action: 'a', resource: '*' };
    assert.equal((await post('/v1/authorize/dry-run', dryDeny, token)).status, 200);
    const all = await (await fetch(`${base}/v1/audit?limit=50`, { headers: H(token) })).json();
    assert.ok(all.length >= 2);
    const allows = await (await fetch(`${base}/v1/audit?limit=50&allowed=true`, { headers: H(token) })).json();
    assert.ok(allows.length >= 1 && allows.every((r: any) => r.decision === true));
    const denies = await (await fetch(`${base}/v1/audit?limit=50&allowed=false`, { headers: H(token) })).json();
    assert.ok(denies.length >= 1 && denies.every((r: any) => r.decision === false));
    const bad = await fetch(`${base}/v1/audit?allowed=maybe`, { headers: H(token) });
    assert.equal(bad.status, 400);
  });
});

describe('audit retention purge', () => {
  it('removes only rows older than the cutoff', async () => {
    const { purgeAudit, logAudit, listAudit, __mem, useDb, getPool } = await import('./db');
    if (useDb()) {
      // Postgres branch: insert a genuinely old row, purge, verify gone.
      const pool = getPool()!;
      const old = new Date(Date.now() - 40 * 86400000).toISOString();
      await pool.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, resource, decision, context, created_at)
         VALUES ('t','pg-old','a','*',true,'{}',$1)`,
        [old],
      );
      assert.equal(await purgeAudit(30), 1);
      const rows = await listAudit(50);
      assert.ok(!rows.some((r: any) => r.actor_id === 'pg-old'));
    } else {
      (__mem as any).audit = [];
      const old = { actor_type: 't', actor_id: 'old', action: 'a', resource: '*', decision: true, created_at: new Date(Date.now() - 40 * 86400000).toISOString() };
      const fresh = { actor_type: 't', actor_id: 'new', action: 'a', resource: '*', decision: true, created_at: new Date().toISOString() };
      ((__mem as any).audit as any[]).push(old, fresh);
      assert.equal(await purgeAudit(30), 1);
      const rows = await listAudit(50);
      assert.ok(rows.some((r: any) => r.actor_id === 'new'));
      assert.ok(!rows.some((r: any) => r.actor_id === 'old'));
    }
    await logAudit({ actor_type: 't', actor_id: 'x', action: 'a', resource: '*', decision: false });
  });

  it('non-positive input is a no-op', async () => {
    const { purgeAudit } = await import('./db');
    assert.equal(await purgeAudit(0), 0);
    assert.equal(await purgeAudit(-5), 0);
    assert.equal(await purgeAudit(Number.NaN), 0);
  });
});
