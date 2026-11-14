// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, createDataset, startHarness } from './testing/harness';
import { redactCredentialFields } from './routes/auth';
import { COLLECTIONS } from './platform';

test('proxied identity payloads never carry password material', () => {
  const payload = {
    accessToken: 'a',
    user: { id: 'u1', email: 'admin@example.com', password_hash: 'scrypt$16384$8$1$salt$hash', nested: [{ passwordHash: 'x' }] },
  };
  const clean = redactCredentialFields(payload);
  assert.equal(clean.user.email, 'admin@example.com');
  assert.equal(clean.user.id, 'u1');
  assert.ok(!JSON.stringify(clean).includes('scrypt$'));
  assert.ok(!JSON.stringify(clean).includes('password'));
  // Original payload is not mutated.
  assert.equal(payload.user.password_hash.startsWith('scrypt$'), true);
});

test('anonymous callers see only published public datasets', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'public-dataset', name: 'Public', public: true });
    await createDataset(harness, { slug: 'private-dataset', name: 'Private', public: false, license: 'LicenseRef-Proprietary' });
    const publish = await api(harness, '/v1/capabilities/datasets/public-dataset/publish', { method: 'POST', token: 'user-token' });
    assert.equal(publish.status, 200);

    const list = await api(harness, '/v1/capabilities/datasets');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((item: any) => item.id), ['public-dataset']);
    assert.equal(list.headers.get('x-total-count'), '1');

    const privateRead = await api(harness, '/v1/capabilities/datasets/private-dataset');
    assert.equal(privateRead.status, 404);
    assert.equal(privateRead.body.error.code, 'dataset_not_found');

    const privateCreate = await api(harness, '/v1/capabilities/datasets/private-dataset/records', {
      method: 'POST', body: { data: { secret: true } },
    });
    assert.equal(privateCreate.status, 401);
    assert.equal(privateCreate.body.error.code, 'unauthorized');
  } finally {
    await harness.close();
  }
});

test('writes require a write-capable credential and never fall back to the service key', async () => {
  const harness = await startHarness();
  try {
    await createDataset(harness);
    const noCredential = await api(harness, '/v1/capabilities/datasets', {
      method: 'POST',
      body: { slug: 'x', name: 'X', entityType: 'Thing', license: 'CC0-1.0' },
    });
    assert.equal(noCredential.status, 401);

    const readOnly = await api(harness, '/v1/capabilities/datasets', {
      method: 'POST', apiKey: 'read-key',
      body: { slug: 'x', name: 'X', entityType: 'Thing', license: 'CC0-1.0' },
    });
    assert.equal(readOnly.status, 403);
    assert.equal(readOnly.body.error.code, 'insufficient_scope');

    const invalid = await api(harness, '/v1/capabilities/datasets', {
      method: 'POST', token: 'not-a-token',
      body: { slug: 'x', name: 'X', entityType: 'Thing', license: 'CC0-1.0' },
    });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.body.error.code, 'invalid_credential');
  } finally {
    await harness.close();
  }
});

test('tenants cannot read or write each other private datasets', async () => {
  const harness = await startHarness();
  try {
    const created = await createDataset(harness, { slug: 'tenant-a', name: 'Tenant A', public: false, license: 'LicenseRef-Proprietary' });
    assert.equal(created.status, 201);
    assert.equal(created.body.tenant, 'org-a');

    const ownerRead = await api(harness, '/v1/capabilities/datasets/tenant-a', { token: 'user-token' });
    assert.equal(ownerRead.status, 200);

    const otherRead = await api(harness, '/v1/capabilities/datasets/tenant-a', { token: 'other-token' });
    assert.equal(otherRead.status, 404);

    const otherWrite = await api(harness, '/v1/capabilities/datasets/tenant-a/records', {
      method: 'POST', token: 'other-token', body: { data: { x: 1 } },
    });
    assert.equal(otherWrite.status, 404);

    const ownList = await api(harness, '/v1/capabilities/datasets', { token: 'user-token' });
    assert.equal(ownList.body.length, 1);
    const otherList = await api(harness, '/v1/capabilities/datasets', { token: 'other-token' });
    assert.equal(otherList.body.length, 0);
  } finally {
    await harness.close();
  }
});

test('CORS echoes both Tier-3 origins and rejects unknown origins', async () => {  const harness = await startHarness();
  try {
    for (const origin of ['https://synapsecity.sbs', 'https://sos.synapsecity.sbs']) {
      const response = await api(harness, '/v1/capabilities/datasets', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.match(String(response.headers.get('access-control-allow-methods')), /DELETE/);
      assert.match(String(response.headers.get('access-control-allow-headers')), /idempotency-key/);
      assert.match(String(response.headers.get('access-control-allow-headers')), /if-match/);
      assert.match(String(response.headers.get('vary') || ''), /Origin/i);
    }
    const unknown = await api(harness, '/v1/capabilities/datasets', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    assert.equal(unknown.headers.get('access-control-allow-origin'), null);
  } finally {
    await harness.close();
  }
});

/* ------------------------------------------------------------------------- *
 * Administrator model regression tests
 *
 * Tier-1 user tokens carry `scopes: ['*']`, and any member can mint API keys
 * with their own authority, so neither may be read as administration. Only a
 * verified organization administrator (IAM `is_org_admin`) or a
 * server-configured deployment administrator may administer; the former must
 * stay inside its own tenant.
 * ------------------------------------------------------------------------- */

async function seedTwoTenants(harness: Awaited<ReturnType<typeof startHarness>>) {
  const own = await createDataset(harness, { slug: 'tenant-a', name: 'Tenant A', public: false, license: 'LicenseRef-Proprietary' });
  assert.equal(own.status, 201);
  const foreign = await createDataset(
    harness,
    { slug: 'tenant-b', name: 'Tenant B', public: false, license: 'LicenseRef-Proprietary' },
    { token: 'other-token' },
  );
  assert.equal(foreign.status, 201);
  return { own: own.body, foreign: foreign.body };
}

test('an organization member (wildcard user token) is not an administrator', async () => {
  const harness = await startHarness();
  try {
    assert.equal(harness.fake.tokens.has('member-token'), true);
    await seedTwoTenants(harness);

    const list = await api(harness, '/v1/capabilities/datasets', { token: 'member-token' });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((item: any) => item.id), ['tenant-a']);

    const foreignRead = await api(harness, '/v1/capabilities/datasets/tenant-b', { token: 'member-token' });
    assert.equal(foreignRead.status, 404);

    const foreignRecords = await api(harness, '/v1/capabilities/datasets/tenant-b/records', { token: 'member-token' });
    assert.equal(foreignRecords.status, 404);

    const team = await api(harness, '/v1/capabilities/management/team', { token: 'member-token' });
    assert.equal(team.status, 403);
    assert.equal(team.body.error.code, 'insufficient_scope');

    const settingsWrite = await api(harness, '/v1/capabilities/management/settings', {
      method: 'PATCH', token: 'member-token', body: { requireReview: true },
    });
    assert.equal(settingsWrite.status, 403);
  } finally {
    await harness.close();
  }
});

test('a member cannot write capability data or read private records with a wildcard token', async () => {
  const harness = await startHarness();
  try {
    const dataset = await createDataset(harness, {
      slug: 'private-ops', name: 'Private ops', public: false, license: 'LicenseRef-Proprietary',
    });
    assert.equal(dataset.status, 201);

    const record = await api(harness, '/v1/capabilities/datasets/private-ops/records', {
      method: 'POST', token: 'user-token', body: { data: { plate: 'ABC-123', owner: 'secret' } },
    });
    assert.equal(record.status, 201);

    // Volunteer/member with only `scopes: ['*']`: no generic write, no private read.
    const writeDataset = await api(harness, '/v1/capabilities/datasets', {
      method: 'POST', token: 'member-token',
      body: { slug: 'member-write', name: 'Member write', entityType: 'Thing', license: 'CC0-1.0' },
    });
    assert.equal(writeDataset.status, 403);
    assert.equal(writeDataset.body.error.code, 'insufficient_scope');

    const writeRecord = await api(harness, '/v1/capabilities/datasets/private-ops/records', {
      method: 'POST', token: 'member-token', body: { data: { tampered: true } },
    });
    assert.equal(writeRecord.status, 403);

    const readRecords = await api(harness, '/v1/capabilities/datasets/private-ops/records', { token: 'member-token' });
    assert.equal(readRecords.status, 404);

    // The tenant administrator and the server-side runtime credential keep access.
    const adminRead = await api(harness, '/v1/capabilities/datasets/private-ops/records', { token: 'admin-token' });
    assert.equal(adminRead.status, 200);
    assert.equal(adminRead.body.total, 1);

    const runtimeRead = await api(harness, '/v1/capabilities/datasets/private-ops/records', { apiKey: 'service-key' });
    assert.equal(runtimeRead.status, 200);
    assert.equal(runtimeRead.body.total, 1);
  } finally {
    await harness.close();
  }
});

test('public published projections stay readable for members and anonymous callers', async () => {  const harness = await startHarness();
  try {
    await createDataset(harness, { slug: 'public-data', name: 'Public data', public: true });
    const publish = await api(harness, '/v1/capabilities/datasets/public-data/publish', { method: 'POST', token: 'user-token' });
    assert.equal(publish.status, 200);
    const record = await api(harness, '/v1/capabilities/datasets/public-data/records', {
      method: 'POST', token: 'user-token', body: { data: { name: 'open' }, publish: true },
    });
    assert.equal(record.status, 201);

    const memberRead = await api(harness, '/v1/capabilities/datasets/public-data/records?publishedOnly=true', { token: 'member-token' });
    assert.equal(memberRead.status, 200);
    assert.equal(memberRead.body.total, 1);

    const anonymousEntities = await api(harness, '/v1/capabilities/datasets/public-data/entities');
    assert.equal(anonymousEntities.status, 200);
  } finally {
    await harness.close();
  }
});

test('a verified organization admin administers its tenant but cannot cross tenants', async () => {
  const harness = await startHarness();
  try {
    await seedTwoTenants(harness);

    const team = await api(harness, '/v1/capabilities/management/team', { token: 'admin-token' });
    assert.equal(team.status, 200);

    const context = await api(harness, '/v1/capabilities/management/context', { token: 'admin-token' });
    assert.deepEqual(context.body.roles, ['admin']);

    const list = await api(harness, '/v1/capabilities/datasets', { token: 'admin-token' });
    assert.deepEqual(list.body.map((item: any) => item.id), ['tenant-a']);

    const foreignRead = await api(harness, '/v1/capabilities/datasets/tenant-b', { token: 'admin-token' });
    assert.equal(foreignRead.status, 404);

    const foreignRecords = await api(harness, '/v1/capabilities/datasets/tenant-b/records', { token: 'admin-token' });
    assert.equal(foreignRecords.status, 404);
  } finally {
    await harness.close();
  }
});

test('a self-mintable explicit admin scope does not grant administration', async () => {
  const harness = await startHarness();
  try {
    await seedTwoTenants(harness);
    // `dx-admin-token` carries scopes: ['synapsedx:admin'] but is not a verified
    // IAM org administrator: an ordinary member can mint such a key in Tier-1.
    const team = await api(harness, '/v1/capabilities/management/team', { token: 'dx-admin-token' });
    assert.equal(team.status, 403);
    const list = await api(harness, '/v1/capabilities/datasets', { token: 'dx-admin-token' });
    assert.deepEqual(list.body.map((item: any) => item.id), ['tenant-a']);
  } finally {
    await harness.close();
  }
});

test('only the configured deployment administrators bypass tenant scoping', async () => {
  const bootstrap = await startHarness({ SYNAPSEDX_ADMIN_SUBJECTS: 'member-1' });
  try {
    await seedTwoTenants(bootstrap);
    const list = await api(bootstrap, '/v1/capabilities/datasets', { token: 'member-token' });
    assert.deepEqual(list.body.map((item: any) => item.id).sort(), ['tenant-a', 'tenant-b']);
    const foreignRead = await api(bootstrap, '/v1/capabilities/datasets/tenant-b', { token: 'member-token' });
    assert.equal(foreignRead.status, 200);
    const team = await api(bootstrap, '/v1/capabilities/management/team', { token: 'member-token' });
    assert.equal(team.status, 200);
  } finally {
    await bootstrap.close();
  }

  const service = await startHarness();
  try {
    await seedTwoTenants(service);
    // The process service credential is a server-side secret, so it keeps
    // deployment-wide technical authority. A wildcard *user* token does not.
    const list = await api(service, '/v1/capabilities/datasets', { apiKey: 'service-key' });
    assert.deepEqual(list.body.map((item: any) => item.id).sort(), ['tenant-a', 'tenant-b']);
  } finally {
    await service.close();
  }
});

test('the org-admin lookup can be disabled, leaving only server configuration', async () => {
  const harness = await startHarness({ SYNAPSEDX_RESOLVE_ORG_ADMIN: 'false' });
  try {
    await seedTwoTenants(harness);
    const team = await api(harness, '/v1/capabilities/management/team', { token: 'admin-token' });
    assert.equal(team.status, 403);
    const list = await api(harness, '/v1/capabilities/datasets', { token: 'admin-token' });
    assert.deepEqual(list.body.map((item: any) => item.id), ['tenant-a']);
  } finally {
    await harness.close();
  }
});

test('org-first tenancy keeps delegated service tokens inside the user tenant', async () => {
  // The dependency gate is enabled here so the tenancy mapping can be tested.
  const harness = await startHarness({ SYNAPSEDX_TRUST_DELEGATED_TOKENS: 'true' });
  try {
    await seedTwoTenants(harness);

    // user-token and delegated-token share org-a but carry different accounts;
    // Tier-1 Base resolves tenant org-first, so they must see the same data.
    const viaDelegation = await api(harness, '/v1/capabilities/datasets/tenant-a', { token: 'delegated-token' });
    assert.equal(viaDelegation.status, 200);

    const created = await createDataset(harness, {
      slug: 'delegated-write', name: 'Delegated write', public: false, license: 'LicenseRef-Proprietary',
    }, { token: 'delegated-token' });
    assert.equal(created.status, 201);
    assert.equal(created.body.tenant, 'org-a');

    const ownerRead = await api(harness, '/v1/capabilities/datasets/delegated-write', { token: 'user-token' });
    assert.equal(ownerRead.status, 200);

    const foreignRead = await api(harness, '/v1/capabilities/datasets/delegated-write', { token: 'other-token' });
    assert.equal(foreignRead.status, 404);
  } finally {
    await harness.close();
  }
});

test('a self-minted user-bound API key has only member authority', async () => {
  const harness = await startHarness();
  try {
    // Created by an operator-minted machine key, so the tenant matches the key's
    // account and the denial below is about authority, not tenancy.
    const dataset = await api(harness, '/v1/capabilities/datasets', {
      method: 'POST', apiKey: 'account-key',
      body: { slug: 'ops-data', name: 'Ops data', entityType: 'Thing', license: 'LicenseRef-Proprietary' },
    });
    assert.equal(dataset.status, 201);

    // Wildcard and even `synapsedx:admin` scopes on a user-bound key are the
    // member's own authority: Tier-1 lets a member mint such a key.
    for (const apiKey of ['user-key', 'user-admin-key']) {
      const write = await api(harness, '/v1/capabilities/datasets/ops-data/records', {
        method: 'POST', apiKey, body: { data: { via: apiKey } },
      });
      assert.equal(write.status, 403, `${apiKey} must not write capability data`);

      const read = await api(harness, '/v1/capabilities/datasets/ops-data/records', { apiKey });
      assert.equal(read.status, 404, `${apiKey} must not read private records`);

      const exchange = await api(harness, '/v1/capabilities/auth/exchange', {
        method: 'POST', apiKey, body: { userId: 'user-1' },
      });
      assert.equal(exchange.status, 403, `${apiKey} must not mint delegated tokens`);
      assert.equal(exchange.body.error.code, 'exchange_forbidden');
    }
  } finally {
    await harness.close();
  }
});

test('operator-minted account-level keys keep machine authority', async () => {
  const harness = await startHarness();
  try {
    const dataset = await api(harness, '/v1/capabilities/datasets', {
      method: 'POST', apiKey: 'account-key',
      body: { slug: 'machine-ops', name: 'Machine ops', entityType: 'Thing', license: 'LicenseRef-Proprietary' },
    });
    assert.equal(dataset.status, 201);

    const write = await api(harness, '/v1/capabilities/datasets/machine-ops/records', {
      method: 'POST', apiKey: 'account-key', body: { data: { via: 'account-key' } },
    });
    assert.equal(write.status, 201);

    const read = await api(harness, '/v1/capabilities/datasets/machine-ops/records', { apiKey: 'account-key' });
    assert.equal(read.status, 200);

    // A machine key with the explicit exchange capability may delegate.
    const exchange = await api(harness, '/v1/capabilities/auth/exchange', {
      method: 'POST', apiKey: 'exchange-key', body: { userId: 'user-1' },
    });
    assert.equal(exchange.status, 201);
    assert.equal(exchange.body.delegated, true);
  } finally {
    await harness.close();
  }
});

test('legacy tenantless datasets are not reachable by any role (migration-gated)', async () => {
  const harness = await startHarness();
  try {
    const now = new Date().toISOString();
    const legacy = {
      id: 'legacy-no-tenant', slug: 'legacy-no-tenant', name: 'Legacy', entityType: 'Thing',
      license: 'PDDL-1.0', public: false, schemaVersion: '1.0.0', status: 'published',
      createdAt: now, updatedAt: now,
      // No `tenant` and no `owner`: production has 16 datasets like this.
    };
    await harness.fake.collections.get(COLLECTIONS.datasets)?.set(legacy.id, { id: legacy.id, data: legacy, version: 1, createdAt: now, updatedAt: now });
    if (!harness.fake.collections.get(COLLECTIONS.datasets)?.has(legacy.id)) {
      const map = new Map<string, any>();
      map.set(legacy.id, { id: legacy.id, data: legacy, version: 1, createdAt: now, updatedAt: now });
      harness.fake.collections.set(COLLECTIONS.datasets, map);
    }

    for (const token of ['admin-token', 'user-token']) {
      const read = await api(harness, '/v1/capabilities/datasets/legacy-no-tenant/records', { token });
      assert.equal(read.status, 404, `${token} must not read an unowned legacy dataset`);
      const write = await api(harness, '/v1/capabilities/datasets/legacy-no-tenant/records', {
        method: 'POST', token, body: { data: { x: 1 } },
      });
      assert.equal(write.status, 404, `${token} must not write an unowned legacy dataset`);
    }

    // A product machine key from any account is also refused.
    const machineRead = await api(harness, '/v1/capabilities/datasets/legacy-no-tenant/records', { apiKey: 'account-key' });
    assert.equal(machineRead.status, 404);

    // Only the deployment administrator (operator secret) may inspect it, and
    // an ownership migration must assign tenant/owner explicitly (CAS), never
    // hand it to whoever asks first.
    const deploymentRead = await api(harness, '/v1/capabilities/datasets/legacy-no-tenant/records', { apiKey: 'service-key' });
    assert.equal(deploymentRead.status, 200);
  } finally {
    await harness.close();
  }
});

test('delegated tokens fail closed until the Tier-1 exchange gate is released', async () => {
  const harness = await startHarness();
  try {
    // Tier-1 still accepts user-bound self-minted keys for /v1/auth/exchange, so
    // a delegated token could be minted by an ordinary member for any user of
    // the organization. The default deployment must refuse it.
    const read = await api(harness, '/v1/capabilities/datasets', { token: 'delegated-token' });
    assert.equal(read.status, 403);
    assert.equal(read.body.error.code, 'delegated_trust_required');
    assert.equal(read.body.error.details.dependency, 'synapseone-iam-exchange');

    const write = await api(harness, '/v1/capabilities/datasets', {
      method: 'POST', token: 'writer-delegated-token',
      body: { slug: 'x', name: 'X', entityType: 'Thing', license: 'CC0-1.0' },
    });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'delegated_trust_required');
  } finally {
    await harness.close();
  }
});

test('a delegated wildcard is not an implicit write grant', async () => {
  const harness = await startHarness({ SYNAPSEDX_TRUST_DELEGATED_TOKENS: 'true' });
  try {
    await createDataset(harness, { slug: 'machine-data', name: 'Machine data', public: false, license: 'LicenseRef-Proprietary' });

    // Explicit `write` delegation works for the product backend ...
    const explicitWrite = await api(harness, '/v1/capabilities/datasets/machine-data/records', {
      method: 'POST', token: 'delegated-token', body: { data: { source: 'city-service' } },
    });
    assert.equal(explicitWrite.status, 201);

    // ... but a wildcard delegation does not silently become an operator.
    const wildcardWrite = await api(harness, '/v1/capabilities/datasets/machine-data/records', {
      method: 'POST', token: 'writer-delegated-token', body: { data: { source: 'wildcard' } },
    });
    assert.equal(wildcardWrite.status, 403);

    // A member token never gets operator authority from its wildcard.
    const memberWrite = await api(harness, '/v1/capabilities/datasets/machine-data/records', {
      method: 'POST', token: 'member-token', body: { data: { source: 'browser' } },
    });
    assert.equal(memberWrite.status, 403);
  } finally {
    await harness.close();
  }
});
