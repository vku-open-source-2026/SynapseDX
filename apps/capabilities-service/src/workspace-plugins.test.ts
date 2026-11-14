// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Security regression tests for organization-installed workspace plugins.
 *
 * Covers: verified org-admin gate (wildcard user tokens are not admins),
 * organization auto-membership, tenant isolation, draft vs immutable published
 * snapshot, installation + server-side member roles, runtime token lifecycle,
 * strict widget/bundle validation, dataset allowlist + tenant scoping, workflow
 * artifact pins and export/import rebinding.
 */
import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { api, createDataset, Harness, startHarness } from './testing/harness';
import { COLLECTIONS } from './platform';
import { checksumOf } from './workspace-plugins';
import { workflowGraphChecksum } from './routes/workflow-artifacts';

const WORKFLOW_ARTIFACTS = 'synapsedx_capability_workflow_artifacts';
const ARTIFACT_DEFINITION = {
  nodes: [{ name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0] }],
  connections: {},
  settings: {},
};
const ARTIFACT_CHECKSUM = workflowGraphChecksum(ARTIFACT_DEFINITION);
const CITY_TEXT_PLUGIN = {
  product: 'city',
  name: 'Volunteer desk',
  slug: 'volunteer-desk',
  audience: 'member',
  roles: ['volunteer'],
  widgets: [{ id: 'intro', type: 'text', title: 'Welcome', text: 'Read your tasks below.' }],
};

describe('workspace plugin routes', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });
  afterEach(async () => {
    await harness.close();
  });
  const admin = (method: string, path: string, body?: unknown, token = 'admin-token') =>
    api(harness, path, { method, token, ...(body === undefined ? {} : { body }) });

  async function createPlugin(overrides: Record<string, unknown> = {}, token = 'admin-token') {
    return api(harness, '/v1/capabilities/workspaces/plugins', {
      method: 'POST', token, body: { ...CITY_TEXT_PLUGIN, ...overrides },
    });
  }

  async function publishedInstalled(overrides: Record<string, unknown> = {}, roles: string[] = ['volunteer']) {
    const created = await createPlugin(overrides);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;
    const published = await admin('POST', `/v1/capabilities/workspaces/plugins/${id}/publish`);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const installed = await admin('POST', `/v1/capabilities/workspaces/plugins/${id}/install`, { roles });
    assert.equal(installed.status, 201, JSON.stringify(installed.body));
    return { id, plugin: published.body };
  }

  function seedArtifact(overrides: Record<string, unknown> = {}) {
    const id = String(overrides.id || 'artifact-0001');
    const now = new Date().toISOString();
    const data = {
      id,
      tenant: 'org-a',
      revision: 1,
      checksum: ARTIFACT_CHECKSUM,
      workflowId: 'wf-1',
      name: 'Incident intake',
      slug: 'incident-intake',
      createdBy: 'admin-1',
      createdAt: now,
      updatedAt: now,
      managedBy: 'technical',
      settings: { access: { mode: 'owner-only' } },
      ...overrides,
    };
    let collection = harness.fake.collections.get(WORKFLOW_ARTIFACTS);
    if (!collection) {
      collection = new Map();
      harness.fake.collections.set(WORKFLOW_ARTIFACTS, collection);
    }
    collection.set(id, { id, version: 1, data, createdAt: now, updatedAt: now } as any);
    // The fake Tier-1 workflow engine must know the id and the reviewed graph.
    const workflowId = String(data.workflowId);
    if (workflowId) {
      harness.fake.workflows.set(workflowId, {
        id: workflowId, name: String(data.name || workflowId), definition: ARTIFACT_DEFINITION, active: true,
      });
    }
    return data;
  }

  function seedUnownedDataset(id: string) {
    let collection = harness.fake.collections.get(COLLECTIONS.datasets);
    if (!collection) {
      collection = new Map();
      harness.fake.collections.set(COLLECTIONS.datasets, collection);
    }
    const now = new Date().toISOString();
    const data = {
      id, slug: id, name: id, entityType: 'Test', license: 'LicenseRef-Proprietary', public: false,
      schemaVersion: '1.0.0', status: 'draft', createdAt: now, updatedAt: now,
    };
    collection.set(id, { id, version: 1, data, createdAt: now, updatedAt: now } as any);
  }

  test('only a verified IAM organization admin manages plugins (wildcard member token is not admin)', async () => {
    const catalog = await admin('GET', '/v1/capabilities/workspaces/catalog');
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
    const city = catalog.body.products.find((product: any) => product.product === 'city');
    assert.deepEqual(city.roles, ['admin', 'manager', 'technician', 'volunteer']);
    assert.equal(city.resources.find((resource: any) => resource.key === 'incidents').dataset, 'city-incidents');
    const sos = catalog.body.products.find((product: any) => product.product === 'sos');
    assert.deepEqual(sos.roles, ['admin', 'manager', 'operator', 'responder', 'volunteer']);
    // Form execution is gated by the published SDK revision-pin capability.
    assert.equal(catalog.body.mutation.formExecution, catalog.body.workflowExecution.ready);
    assert.equal(typeof catalog.body.workflowExecution.minimumVersion, 'string');
    assert.equal(catalog.body.mutation.directDatasetWrites, false);

    // Tier-1 user tokens carry `*` for member authority; that is not org admin.
    const wildcardMember = await admin('GET', '/v1/capabilities/workspaces/catalog', undefined, 'member-token');
    assert.equal(wildcardMember.status, 403);
    assert.equal(wildcardMember.body.error.code, 'admin_required');

    const nonAdmin = await admin('GET', '/v1/capabilities/workspaces/plugins?product=city', undefined, 'user-token');
    assert.equal(nonAdmin.status, 403);

    const apiKey = await api(harness, '/v1/capabilities/workspaces/catalog', { apiKey: 'service-key' });
    assert.equal(apiKey.status, 403);
    assert.equal(apiKey.body.error.code, 'user_token_required');

    const anonymous = await api(harness, '/v1/capabilities/workspaces/catalog');
    assert.equal(anonymous.status, 401);

    // The org-admin decision is resolved through the published SDK IAM `me()`
    // call with the caller's own bearer, never the service credential.
    const meCalls = harness.fake.requests.filter((entry) => entry.path === '/v1/auth/me');
    assert.ok(meCalls.length >= 2);
    assert.ok(meCalls.every((entry) => /^Bearer /.test(entry.headers.authorization || '')
      && entry.headers['x-api-key'] === undefined), JSON.stringify(meCalls.map((entry) => entry.headers.authorization)));
    assert.ok(meCalls.some((entry) => entry.headers.authorization === 'Bearer admin-token'));
    assert.ok(meCalls.some((entry) => entry.headers.authorization === 'Bearer member-token'));
  });

  test('a verified org admin is bootstrapped into the member table without a second manual grant', async () => {
    // The first admin-plane call creates the admin's membership row.
    const catalog = await admin('GET', '/v1/capabilities/workspaces/catalog');
    assert.equal(catalog.status, 200);
    const memberCollection = harness.fake.collections.get(COLLECTIONS.workspaceMembers);
    const adminRows = [...(memberCollection?.values() || [])].filter((item: any) => item.data.subject === 'admin-1');
    assert.equal(adminRows.length, 1);
    assert.deepEqual((adminRows[0] as any).data.roles, ['admin']);
    assert.equal((adminRows[0] as any).data.updatedBy, 'system:iam-org-admin');

    const installed = await admin('GET', '/v1/capabilities/workspaces/installed');
    assert.equal(installed.status, 200);
    assert.deepEqual(installed.body.items, []);
    const members = await admin('GET', '/v1/capabilities/workspaces/members');
    assert.equal(members.status, 200);
    const self = members.body.items.find((item: any) => item.subject === 'admin-1');
    assert.deepEqual(self.roles, ['admin']);
    assert.equal(self.updatedBy, 'system:iam-org-admin');
  });

  test('plugin schema rejects markup, mixed-product resources, duplicates and unknown keys', async () => {
    const markup = await createPlugin({ widgets: [{ id: 'intro', type: 'text', title: 'Hello', text: '<script>alert(1)</script>' }] });
    assert.equal(markup.status, 400);
    assert.equal(markup.body.error.code, 'invalid_widget');

    // Backend plain-text policy matches the console/bundle gate: no URLs or
    // non-http schemes anywhere in user-visible text.
    for (const text of ['see https://example.test/x', 'mailto:ops@example.test', 'file:///etc/passwd', 'javascript:alert(1)']) {
      const rejected = await createPlugin({ widgets: [{ id: 'intro', type: 'text', title: 'Hello', text }] });
      assert.equal(rejected.status, 400, text);
      assert.equal(rejected.body.error.code, 'invalid_widget');
    }
    const urlTitle = await createPlugin({
      widgets: [{ id: 'intro', type: 'text', title: 'Visit https://example.test', text: 'ok' }],
    });
    assert.equal(urlTitle.status, 400);
    const urlName = await createPlugin({ name: 'Plugin at https://example.test' });
    assert.equal(urlName.status, 400);

    const mixed = await createPlugin({ widgets: [{ id: 'events', type: 'metric', title: 'Events', resource: 'events' }] });
    assert.equal(mixed.status, 400);
    assert.equal(mixed.body.error.code, 'resource_not_allowed');

    const duplicate = await createPlugin({
      widgets: [
        { id: 'same', type: 'text', title: 'A', text: 'a' },
        { id: 'same', type: 'text', title: 'B', text: 'b' },
      ],
    });
    assert.equal(duplicate.status, 400);

    const unknown = await createPlugin({
      widgets: [{ id: 'intro', type: 'text', title: 'Hello', text: 'ok', javascriptUrl: 'https://evil.test' }],
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'invalid_plugin');

    const tooMany = await createPlugin({
      widgets: Array.from({ length: 41 }, (_, index) => ({ id: `w${index}`, type: 'text', title: 'x', text: 'x' })),
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error.code, 'widget_limit_exceeded');

    const badResource = await createPlugin({
      widgets: [{ id: 'incidents', type: 'table', title: 'Incidents', resource: 'https://evil.test', columns: ['id'] }],
    });
    assert.equal(badResource.status, 400);

    const publicRole = await createPlugin({ roles: ['citizen'] });
    assert.equal(publicRole.status, 400);
    assert.equal(publicRole.body.error.code, 'invalid_role');

    const formNoFields = await createPlugin({
      widgets: [{ id: 'intake', type: 'form', title: 'Intake', resource: 'incidents', fields: [] }],
    });
    assert.equal(formNoFields.status, 400);

    // Strict generic action vocabulary: create|update|delete|execute only.
    const badAction = await createPlugin({
      slug: 'bad-action',
      widgets: [{
        id: 'intake', type: 'form', title: 'Intake', resource: 'incidents', action: 'assign',
        fields: [{ name: 'summary', label: 'Summary', type: 'text' }],
      }],
    });
    assert.equal(badAction.status, 400);
    assert.equal(badAction.body.error.code, 'invalid_widget');

    const actionOnText = await createPlugin({
      slug: 'text-action',
      widgets: [{ id: 'note', type: 'text', title: 'Note', text: 'x', action: 'delete' }],
    });
    assert.equal(actionOnText.status, 400);

    const updateAction = await createPlugin({
      slug: 'update-form',
      widgets: [{
        id: 'edit', type: 'form', title: 'Edit incident', resource: 'incidents', action: 'update',
        fields: [{ name: 'summary', label: 'Summary', type: 'text', required: true }],
      }],
    });
    assert.equal(updateAction.status, 201, JSON.stringify(updateAction.body));
    assert.equal(updateAction.body.widgets[0].action, 'update');

    const executeAction = await createPlugin({
      slug: 'execute-form',
      widgets: [{
        id: 'run', type: 'form', title: 'Run action', resource: 'incidents', action: 'execute',
        fields: [{ name: 'target', label: 'Target', type: 'text', required: true }],
      }],
    });
    assert.equal(executeAction.status, 201);
    assert.equal(executeAction.body.widgets[0].action, 'execute');

    const clientPins = await createPlugin({
      widgets: [{
        id: 'intake', type: 'form', title: 'Intake', resource: 'incidents',
        fields: [{ name: 'summary', label: 'Summary', type: 'text' }],
        workflowArtifactId: 'artifact-0001', workflowArtifactRevision: 1,
      }],
    });
    assert.equal(clientPins.status, 400);
    assert.equal(clientPins.body.error.code, 'invalid_widget');

    const sourced = await createPlugin({
      slug: 'sourced-plugin',
      source: {
        repository: 'https://github.com/vku-open-source-2026/SynapseCity',
        path: 'plugins/city/volunteer-desk.json',
        revision: 'abc123',
      },
    });
    assert.equal(sourced.status, 201, JSON.stringify(sourced.body));
    const exportedSource = await admin('GET', `/v1/capabilities/workspaces/plugins/${sourced.body.id}/export?draft=1`);
    assert.equal(exportedSource.body.source.path, 'plugins/city/volunteer-desk.json');
  });

  test('published consumers keep the immutable snapshot while the draft changes', async () => {
    const { id } = await publishedInstalled();
    // The organization admin is also a volunteer for this test organization.
    await admin('PUT', '/v1/capabilities/workspaces/members/admin-1', { roles: ['admin', 'volunteer'] });
    const draft = await admin('PUT', `/v1/capabilities/workspaces/plugins/${id}`, {
      version: 1,
      widgets: [{ id: 'intro', type: 'text', title: 'Welcome', text: 'Draft v2 only.' }],
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    assert.equal(draft.body.version, 2);

    const installed = await admin('GET', '/v1/capabilities/workspaces/installed');
    assert.equal(installed.status, 200);
    assert.equal(installed.body.items[0].version, 1);
    assert.equal(installed.body.items[0].widgets[0].text, 'Read your tasks below.');

    const current = await admin('GET', `/v1/capabilities/workspaces/plugins/${id}`);
    assert.equal(current.body.version, 2);
    assert.equal(current.body.widgets[0].text, 'Draft v2 only.');
    assert.equal(current.body.installed, true);
    assert.deepEqual(current.body.installedRoles, ['volunteer']);

    const stale = await admin('PUT', `/v1/capabilities/workspaces/plugins/${id}`, { version: 1, name: 'Stale write' });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'version_conflict');
    assert.equal(stale.body.error.details.currentVersion, 2);

    const republished = await admin('POST', `/v1/capabilities/workspaces/plugins/${id}/publish`);
    assert.equal(republished.status, 200);
    const after = await admin('GET', '/v1/capabilities/workspaces/installed');
    assert.equal(after.body.items[0].version, 2);
    assert.equal(after.body.items[0].widgets[0].text, 'Draft v2 only.');
  });

  test('member workspace requires server-stored roles and never management admin', async () => {
    const { id } = await publishedInstalled();

    // No membership row yet: the member sees nothing, without an error.
    const before = await admin('GET', '/v1/capabilities/workspaces/installed', undefined, 'member-token');
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.items, []);

    const assigned = await admin('PUT', '/v1/capabilities/workspaces/members/member-1', { roles: ['volunteer'] });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));

    const visible = await admin('GET', '/v1/capabilities/workspaces/installed', undefined, 'member-token');
    assert.equal(visible.status, 200);
    assert.equal(visible.body.total, 1);
    assert.deepEqual(visible.body.items[0].roles, ['volunteer']);
    assert.equal(visible.body.items[0].widgets[0].canSubmit, false);

    // Wrong role loses access without another install.
    await admin('PUT', '/v1/capabilities/workspaces/members/member-1', { roles: ['manager'] });
    const hidden = await admin('GET', '/v1/capabilities/workspaces/installed', undefined, 'member-token');
    assert.equal(hidden.body.total, 0);

    // Members cannot manage.
    // (member-token now has manager, still not an organization admin)
    const installAttempt = await admin('POST', `/v1/capabilities/workspaces/plugins/${id}/install`, {}, 'member-token');
    assert.equal(installAttempt.status, 403);
    const memberWrite = await admin('PUT', '/v1/capabilities/workspaces/members/member-1', { roles: ['admin'] }, 'member-token');
    assert.equal(memberWrite.status, 403);
    assert.equal((await admin('GET', '/v1/capabilities/workspaces/members', undefined, 'member-token')).status, 403);

    // Uninstall removes it for every member.
    assert.equal((await admin('DELETE', `/v1/capabilities/workspaces/plugins/${id}/install`)).status, 204);
    await admin('PUT', '/v1/capabilities/workspaces/members/member-1', { roles: ['volunteer'] });
    const afterUninstall = await admin('GET', '/v1/capabilities/workspaces/installed', undefined, 'member-token');
    assert.equal(afterUninstall.body.total, 0);
  });

  test('an organization install is visible to every assigned member, not one user', async () => {
    const { id } = await publishedInstalled();
    assert.equal((await admin('PUT', '/v1/capabilities/workspaces/members/member-1', { roles: ['volunteer'] })).status, 200);
    assert.equal((await admin('PUT', '/v1/capabilities/workspaces/members/viewer-1', { roles: ['volunteer'] })).status, 200);

    const memberView = await admin('GET', '/v1/capabilities/workspaces/installed', undefined, 'member-token');
    const secondView = await admin('GET', '/v1/capabilities/workspaces/installed', undefined, 'viewer-token');
    assert.equal(memberView.body.total, 1);
    assert.equal(secondView.body.total, 1, JSON.stringify(secondView.body));
    assert.equal(secondView.body.items[0].id, id);

    // Least privilege: a volunteer cannot install/uninstall or change roles.
    assert.equal((await admin('POST', `/v1/capabilities/workspaces/plugins/${id}/install`, {}, 'viewer-token')).status, 403);
    assert.equal((await admin('DELETE', `/v1/capabilities/workspaces/plugins/${id}/install`, undefined, 'viewer-token')).status, 403);
    assert.equal((await admin('PUT', '/v1/capabilities/workspaces/members/viewer-1', { roles: ['admin'] }, 'viewer-token')).status, 403);

    // Uninstall is organization-wide.
    assert.equal((await admin('DELETE', `/v1/capabilities/workspaces/plugins/${id}/install`)).status, 204);
    assert.equal((await admin('GET', '/v1/capabilities/workspaces/installed', undefined, 'member-token')).body.total, 0);
    assert.equal((await admin('GET', '/v1/capabilities/workspaces/installed', undefined, 'viewer-token')).body.total, 0);
  });

  test('admin audience pages are gated by an admin-tier membership role', async () => {
    const { id } = await publishedInstalled({ audience: 'admin', roles: ['manager'], slug: 'ops-board', name: 'Ops board' }, ['manager']);
    await admin('PUT', '/v1/capabilities/workspaces/members/member-1', { roles: ['volunteer'] });
    const volunteer = await admin('GET', `/v1/capabilities/workspaces/installed/${id}`, undefined, 'member-token');
    assert.equal(volunteer.status, 404);

    await admin('PUT', '/v1/capabilities/workspaces/members/member-1', { roles: ['manager'] });
    const manager = await admin('GET', `/v1/capabilities/workspaces/installed/${id}`, undefined, 'member-token');
    assert.equal(manager.status, 200);
    assert.equal(manager.body.audience, 'admin');
  });

  test('tenant isolation: another organization cannot read, install or export the plugin', async () => {
    const { id } = await publishedInstalled();
    for (const path of [
      `/v1/capabilities/workspaces/plugins/${id}`,
      `/v1/capabilities/workspaces/plugins/${id}/export`,
    ]) {
      const response = await admin('GET', path, undefined, 'other-admin-token');
      assert.equal(response.status, 404, path);
      assert.equal(response.body.error.code, 'plugin_not_found');
    }
    assert.equal((await admin('POST', `/v1/capabilities/workspaces/plugins/${id}/install`, {}, 'other-admin-token')).status, 404);
    assert.equal((await admin('PUT', `/v1/capabilities/workspaces/plugins/${id}`, { version: 1 }, 'other-admin-token')).status, 404);

    // The other organization's install list stays empty.
    const otherInstalled = await admin('GET', '/v1/capabilities/workspaces/installed', undefined, 'other-admin-token');
    assert.deepEqual(otherInstalled.body.items, []);
    // And its token list does not contain the first org's tokens.
    await admin('POST', '/v1/capabilities/workspaces/tokens', { product: 'city', name: 'org-a token' });
    const otherTokens = await admin('GET', '/v1/capabilities/workspaces/tokens', undefined, 'other-admin-token');
    assert.equal(otherTokens.body.items.length, 0);
  });

  test('runtime tokens are one-time-visible, hashed, scoped, expiring and revocable', async () => {
    const { id } = await publishedInstalled();
    await publishedInstalled({ slug: 'org-a-draft', name: 'Draft only' });
    const draftOnly = await createPlugin({ slug: 'org-a-draft-2', name: 'Never published' });
    assert.equal(draftOnly.status, 201);

    // An org-b published plugin must never appear in an org-a token feed.
    const orgB = await createPlugin({ slug: 'org-b-plugin', name: 'Org B plugin' }, 'other-admin-token');
    assert.equal(orgB.status, 201, JSON.stringify(orgB.body));
    await admin('POST', `/v1/capabilities/workspaces/plugins/${orgB.body.id}/publish`, undefined, 'other-admin-token');

    const created = await admin('POST', '/v1/capabilities/workspaces/tokens', { product: 'city', name: 'renderer', expiresInDays: 2 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const token = created.body.token;
    assert.match(token, /^wsp_[A-Za-z0-9_-]{43}$/);
    assert.equal(created.body.tokenHash, undefined);
    assert.equal(created.body.tokenPrefix, token.slice(0, 12));

    const listed = await admin('GET', '/v1/capabilities/workspaces/tokens');
    assert.equal(listed.status, 200);
    assert.equal(JSON.stringify(listed.body).includes(token), false);
    assert.equal(JSON.stringify(listed.body).toLowerCase().includes('tokenhash'), false);
    const tokenId = listed.body.items[0].id;

    const runtime = await api(harness, '/v1/capabilities/workspaces/runtime/city', {
      headers: { 'x-workspace-token': token },
    });
    assert.equal(runtime.status, 200, JSON.stringify(runtime.body));
    assert.equal(runtime.body.total, 2); // published volunteer desk + org-a-draft (published by helper)
    assert.equal(runtime.body.items.some((item: any) => item.slug === 'org-b-plugin'), false);
    assert.equal(runtime.body.items.some((item: any) => item.slug === 'org-a-draft-2'), false);
    assert.equal(runtime.body.items[0].widgets[0].canSubmit, false);
    assert.equal(runtime.body.items[0].widgets[0].workflowArtifactRevision, undefined);

    // A runtime token never authenticates management.
    const manage = await api(harness, '/v1/capabilities/workspaces/plugins?product=city', {
      headers: { 'x-workspace-token': token },
    });
    assert.equal(manage.status, 401);
    const install = await api(harness, `/v1/capabilities/workspaces/plugins/${id}/install`, {
      method: 'POST', headers: { 'x-workspace-token': token }, body: {},
    });
    assert.equal(install.status, 401);

    // Wrong product.
    const wrongProduct = await api(harness, '/v1/capabilities/workspaces/runtime/sos', {
      headers: { 'x-workspace-token': token },
    });
    assert.equal(wrongProduct.status, 401);

    // Expired token (mutate the stored metadata directly to simulate time).
    const tokens = harness.fake.collections.get(COLLECTIONS.workspaceTokens)!;
    const stored = tokens.get(tokenId) as any;
    tokens.set(tokenId, { ...stored, data: { ...stored.data, expiresAt: new Date(Date.now() - 1000).toISOString() } });
    const expired = await api(harness, '/v1/capabilities/workspaces/runtime/city', {
      headers: { 'x-workspace-token': token },
    });
    assert.equal(expired.status, 401);
    tokens.set(tokenId, stored);

    // Revocation.
    assert.equal((await admin('DELETE', `/v1/capabilities/workspaces/tokens/${tokenId}`)).status, 204);
    const revoked = await api(harness, '/v1/capabilities/workspaces/runtime/city', {
      headers: { 'x-workspace-token': token },
    });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.body.error.code, 'token_invalid');

    const noToken = await api(harness, '/v1/capabilities/workspaces/runtime/city');
    assert.equal(noToken.status, 401);
  });

  test('widget data is bound to the exact product dataset allowlist with tenant scope', async () => {
    await createDataset(harness, { slug: 'city-incidents', name: 'Incidents', public: true });
    await api(harness, '/v1/capabilities/datasets/city-incidents/records', {
      method: 'POST', token: 'user-token',
      body: { data: { status: 'open', severity: 'high', internalNote: 'do-not-leak' } },
    });
    await api(harness, '/v1/capabilities/datasets/city-incidents/records', {
      method: 'POST', token: 'user-token',
      body: { data: { status: 'closed', severity: 'low' } },
    });

    const { id } = await publishedInstalled({
      slug: 'incident-widgets',
      widgets: [
        { id: 'count', type: 'metric', title: 'Open', resource: 'incidents' },
        { id: 'list', type: 'table', title: 'List', resource: 'incidents', columns: ['status', 'severity'] },
      ],
    });
    await admin('PUT', '/v1/capabilities/workspaces/members/member-1', { roles: ['volunteer'] });

    const metric = await admin('GET', `/v1/capabilities/workspaces/installed/${id}/widgets/count/data`, undefined, 'member-token');
    assert.equal(metric.status, 200, JSON.stringify(metric.body));
    assert.equal(metric.body.count, 2);

    const table = await admin('GET', `/v1/capabilities/workspaces/installed/${id}/widgets/list/data`, undefined, 'member-token');
    assert.equal(table.status, 200);
    assert.equal(table.body.total, 2);
    assert.deepEqual(table.body.columns, ['status', 'severity']);
    assert.equal(JSON.stringify(table.body.items).includes('internalNote'), false);
    assert.equal(JSON.stringify(table.body.items).includes('do-not-leak'), false);

    // A dataset owned by another organization is invisible.
    await createDataset(harness, { slug: 'city-assets', name: 'Assets', public: true }, { token: 'other-token' });
    const crossTenant = await publishedInstalled({
      slug: 'asset-widget', name: 'Assets',
      widgets: [{ id: 'assets', type: 'metric', title: 'Assets', resource: 'assets' }],
    });
    const blocked = await admin('GET', `/v1/capabilities/workspaces/installed/${crossTenant.id}/widgets/assets/data`, undefined, 'member-token');
    assert.equal(blocked.status, 404);
    assert.equal(blocked.body.error.code, 'widget_data_unavailable');

    // Forms are not readable as data.
    seedArtifact();
    const formPlugin = await publishedInstalled({
      slug: 'intake-form', name: 'Intake',
      widgets: [{
        id: 'intake', type: 'form', title: 'Intake', resource: 'incidents', action: 'create',
        workflowArtifactId: 'artifact-0001',
        fields: [{ name: 'summary', label: 'Summary', type: 'textarea', required: true }],
      }],
    });
    const formData = await admin('GET', `/v1/capabilities/workspaces/installed/${formPlugin.id}/widgets/intake/data`, undefined, 'member-token');
    assert.equal(formData.status, 400);
    assert.equal(formData.body.error.code, 'mutation_not_supported');
  });

  test('dataset readiness is verify-only: no org admin can claim unowned or foreign data', async () => {
    await createDataset(harness, { slug: 'city-incidents', name: 'Incidents', public: true });
    await createDataset(harness, { slug: 'city-reports', name: 'Reports', public: false, license: 'LicenseRef-Proprietary' });
    const created = await createPlugin({
      slug: 'ready-plugin',
      widgets: [
        { id: 'count', type: 'metric', title: 'Incidents', resource: 'incidents' },
        { id: 'reports', type: 'metric', title: 'Reports', resource: 'reports' },
      ],
    });
    assert.equal(created.status, 201);
    const ready = await admin('POST', `/v1/capabilities/workspaces/plugins/${created.body.id}/provision`);
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    assert.equal(ready.body.ready, true);
    assert.equal(ready.body.bound, 2);
    assert.ok(ready.body.items.every((item: any) => item.status === 'ready'));

    // Hostile org admin: a legacy dataset with no tenant is NOT claimable.
    seedUnownedDataset('city-assets');
    const hostile = await createPlugin({
      slug: 'hostile-claim',
      widgets: [{ id: 'assets', type: 'metric', title: 'Assets', resource: 'assets' }],
    }, 'other-admin-token');
    assert.equal(hostile.status, 201, JSON.stringify(hostile.body));
    const datasetCollection = harness.fake.collections.get(COLLECTIONS.datasets)!;
    const before = JSON.stringify((datasetCollection.get('city-assets') as any).data);
    const claimed = await admin('POST', `/v1/capabilities/workspaces/plugins/${hostile.body.id}/provision`, undefined, 'other-admin-token');
    assert.equal(claimed.status, 409);
    assert.equal(claimed.body.error.code, 'dataset_provisioning_failed');
    assert.equal(claimed.body.error.details.ready, false);
    assert.equal(claimed.body.error.details.items[0].status, 'unowned');
    const after = JSON.stringify((datasetCollection.get('city-assets') as any).data);
    assert.equal(after, before);
    assert.equal((datasetCollection.get('city-assets') as any).data.tenant, undefined);

    // A dataset owned by org-b is not readable or claimable by org-a.
    await createDataset(harness, { slug: 'city-budgets', name: 'Budgets', public: false, license: 'LicenseRef-Proprietary' }, { token: 'other-token' });
    const takeover = await createPlugin({
      slug: 'takeover',
      widgets: [{ id: 'budgets', type: 'metric', title: 'Budgets', resource: 'budgets' }],
    });
    const refused = await admin('POST', `/v1/capabilities/workspaces/plugins/${takeover.body.id}/provision`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.details.items[0].status, 'other_tenant');
    const budgets = datasetCollection.get('city-budgets') as any;
    assert.equal(budgets.data.tenant, 'org-b');

    // A missing dataset is reported, not created.
    const missingPlugin = await createPlugin({
      slug: 'missing-dataset',
      widgets: [{ id: 'maint', type: 'metric', title: 'Maintenance', resource: 'maintenance' }],
    });
    const missing = await admin('POST', `/v1/capabilities/workspaces/plugins/${missingPlugin.body.id}/provision`);
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error.details.items[0].status, 'missing');
  });

  test('workflow forms are gated until the SDK supports atomic revision pinning', async () => {
    seedArtifact();
    const { id } = await publishedInstalled({
      slug: 'intake',
      widgets: [{
        id: 'report', type: 'form', title: 'Report incident', resource: 'incidents', action: 'create',
        workflowArtifactId: 'artifact-0001',
        fields: [
          { name: 'summary', label: 'Summary', type: 'textarea', required: true },
          { name: 'severity', label: 'Severity', type: 'number' },
        ],
      }],
    });
    await admin('PUT', '/v1/capabilities/workspaces/members/member-1', { roles: ['volunteer'] });

    const catalog = await admin('GET', '/v1/capabilities/workspaces/catalog');
    const readiness = catalog.body.workflowExecution;
    assert.deepEqual(catalog.body.actionTypes, ['create', 'update', 'delete', 'execute']);
    assert.equal(catalog.body.workflowOrgReadiness.ready, true);

    const visible = await admin('GET', `/v1/capabilities/workspaces/installed/${id}`, undefined, 'member-token');
    assert.equal(visible.status, 200);
    // The server-owned pins are stored in the snapshot but never exposed.
    assert.equal(visible.body.widgets[0].workflowArtifactRevision, undefined);
    assert.equal(visible.body.widgets[0].workflowArtifactChecksum, undefined);
    assert.equal(visible.body.widgets[0].canSubmit, readiness.ready);
    if (!readiness.ready) {
      assert.equal(visible.body.widgets[0].canSubmitReason, 'workflow_sdk_release_required');
    }

    const snapshotCollection = harness.fake.collections.get(COLLECTIONS.workspacePluginSnapshots)!;
    const snapshot = [...snapshotCollection.values()].find((item: any) => item.data.pluginId === id) as any;
    assert.equal(snapshot.data.widgets[0].workflowArtifactRevision, 1);
    assert.equal(snapshot.data.widgets[0].workflowArtifactChecksum, ARTIFACT_CHECKSUM);

    const flat = await admin('POST', `/v1/capabilities/workspaces/installed/${id}/widgets/report/execute`, {
      summary: 'Broken lamp',
    }, 'member-token');
    assert.equal(flat.status, 400);
    assert.equal(flat.body.error.code, 'invalid_request');

    const injected = await admin('POST', `/v1/capabilities/workspaces/installed/${id}/widgets/report/execute`, {
      values: { summary: 'Broken lamp', severity: 2, internalNote: 'sneaky' },
    }, 'member-token');
    assert.equal(injected.status, 400);
    assert.equal(injected.body.error.code, 'invalid_request');

    const missing = await admin('POST', `/v1/capabilities/workspaces/installed/${id}/widgets/report/execute`, {
      values: { severity: 2 },
    }, 'member-token');
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'field_required');

    const executed = await admin('POST', `/v1/capabilities/workspaces/installed/${id}/widgets/report/execute`, {
      values: { summary: 'Broken lamp', severity: 2 },
    }, 'member-token');
    if (!readiness.ready) {
      // Truthful refusal: the installed published SDK cannot pass expectedRevision.
      assert.equal(executed.status, 503, JSON.stringify(executed.body));
      assert.equal(executed.body.error.code, 'dependency_unavailable');
      assert.equal(executed.body.error.details.sdkReleaseRequired, true);
      assert.equal(executed.body.error.details.canSubmit, false);
      assert.equal(harness.fake.executions.length, 0);
    } else {
      assert.equal(executed.status, 200, JSON.stringify(executed.body));
      assert.equal(harness.fake.executions.length, 1);
    }

    // Editing the artifact invalidates the published pin before any execution.
    const artifacts = harness.fake.collections.get(WORKFLOW_ARTIFACTS)!;
    const stored = artifacts.get('artifact-0001') as any;
    artifacts.set('artifact-0001', { ...stored, data: { ...stored.data, revision: 2, checksum: 'b'.repeat(64) } });
    const stale = await admin('GET', `/v1/capabilities/workspaces/installed/${id}`, undefined, 'member-token');
    assert.equal(stale.body.widgets[0].canSubmit, false);
    const changed = await admin('POST', `/v1/capabilities/workspaces/installed/${id}/widgets/report/execute`, {
      values: { summary: 'Broken lamp' },
    }, 'member-token');
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'workflow_artifact_changed');
    artifacts.set('artifact-0001', stored);

    // An unbound form stays read-only and never reports fake success.
    const readOnly = await publishedInstalled({
      slug: 'read-only-form',
      widgets: [{
        id: 'form', type: 'form', title: 'Read only', resource: 'incidents', action: 'create',
        fields: [{ name: 'summary', label: 'Summary', type: 'text', required: true }],
      }],
    });
    const refused = await admin('POST', `/v1/capabilities/workspaces/installed/${readOnly.id}/widgets/form/execute`, {
      values: { summary: 'hello' },
    }, 'member-token');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'mutation_not_supported');
    assert.equal(refused.body.error.details.reason, 'no_workflow_artifact');
  });

  test('a form cannot bind a workflow artifact owned by another organization', async () => {
    seedArtifact({ tenant: 'org-b' });
    const created = await createPlugin({
      slug: 'cross-org-form',
      widgets: [{
        id: 'form', type: 'form', title: 'Cross org', resource: 'incidents', action: 'create',
        workflowArtifactId: 'artifact-0001',
        fields: [{ name: 'summary', label: 'Summary', type: 'text', required: true }],
      }],
    });
    assert.equal(created.status, 409);
    assert.equal(created.body.error.code, 'workflow_artifact_not_found');
  });

  test('export strips internal bindings/pins and import creates a draft with explicit rebinding', async () => {
    seedArtifact();
    const { id } = await publishedInstalled({
      slug: 'exported-intake',
      widgets: [{
        id: 'form', type: 'form', title: 'Intake', resource: 'incidents', action: 'create',
        workflowArtifactId: 'artifact-0001',
        fields: [{ name: 'summary', label: 'Summary', type: 'text', required: true }],
      }],
    });
    const exported = await admin('GET', `/v1/capabilities/workspaces/plugins/${id}/export`);
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    const bundle = exported.body;
    assert.equal(bundle.format, 'synapsedx-plugin');
    assert.equal(bundle.formatVersion, 1);
    assert.equal(bundle.checksum, checksumOf(bundle.plugin));
    const serialized = JSON.stringify(bundle);
    for (const forbidden of ['workflowArtifactId', 'workflowArtifactRevision', 'workflowArtifactChecksum', 'tenant', 'token', 'installedAt']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(bundle.plugin.widgets[0].workflowRef, { name: 'Incident intake', slug: 'incident-intake', checksum: ARTIFACT_CHECKSUM });
    assert.deepEqual(Object.keys(bundle.plugin).sort(), ['audience', 'name', 'product', 'roles', 'slug', 'widgets']);

    // Import without the referenced artifact fails loudly.
    const noArtifact = await admin('POST', '/v1/capabilities/workspaces/import', bundle, 'other-admin-token');
    assert.equal(noArtifact.status, 409);
    assert.equal(noArtifact.body.error.code, 'workflow_artifact_not_found');

    // Rebind to the other organization's artifact with the same portable ref.
    seedArtifact({ id: 'artifact-b001', tenant: 'org-b', revision: 3, checksum: ARTIFACT_CHECKSUM });
    const imported = await admin('POST', '/v1/capabilities/workspaces/import', bundle, 'other-admin-token');
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.status, 'draft');
    assert.equal(imported.body.installed, false);
    assert.equal(imported.body.widgets[0].workflowArtifactId, 'artifact-b001');

    // Draft import is never installed or published automatically.
    const installedB = await admin('GET', '/v1/capabilities/workspaces/installed', undefined, 'other-admin-token');
    assert.deepEqual(installedB.body.items, []);

    const duplicate = await admin('POST', '/v1/capabilities/workspaces/import', bundle, 'other-admin-token');
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'plugin_slug_exists');
  });

  test('build produces a reproducible Tier-3 artifact from the published snapshot only', async () => {
    const { id } = await publishedInstalled({ slug: 'build-ready' });

    // Editing the draft after publication must not leak into the build.
    const draft = await admin('PUT', `/v1/capabilities/workspaces/plugins/${id}`, {
      version: 1,
      slug: 'build-ready-draft',
      widgets: [{ id: 'intro', type: 'text', title: 'Draft', text: 'Draft-only content.' }],
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));

    const built = await admin('GET', `/v1/capabilities/workspaces/plugins/${id}/build?download=1`);
    assert.equal(built.status, 200, JSON.stringify(built.body));
    assert.equal(built.body.plugin.widgets[0].text, 'Read your tasks below.');
    assert.deepEqual(built.body.source, {
      repository: 'https://github.com/vku-open-source-2026/SynapseCity',
      path: 'plugins/build-ready.plugin.json',
    });
    assert.equal(built.body.checksum, checksumOf(built.body.plugin));
    assert.equal(built.headers.get('x-synapsedx-build-version'), '1');
    assert.equal(built.headers.get('x-synapsedx-build-checksum'), built.body.checksum);
    assert.match(built.headers.get('content-disposition') || '', /build-ready\.plugin\.json"?$/);

    // Export defaults to the published snapshot; ?draft=1 remains the explicit
    // authoring view and is the only path that returns unpublished content.
    const exported = await admin('GET', `/v1/capabilities/workspaces/plugins/${id}/export`);
    assert.equal(exported.body.plugin.widgets[0].text, 'Read your tasks below.');
    const draftExport = await admin('GET', `/v1/capabilities/workspaces/plugins/${id}/export?draft=1`);
    assert.equal(draftExport.body.plugin.widgets[0].text, 'Draft-only content.');

    const sos = await createPlugin({
      product: 'sos',
      slug: 'sos-build-ready',
      roles: ['responder'],
    });
    assert.equal(sos.status, 201, JSON.stringify(sos.body));
    const sosPublished = await admin('POST', `/v1/capabilities/workspaces/plugins/${sos.body.id}/publish`);
    assert.equal(sosPublished.status, 200, JSON.stringify(sosPublished.body));
    const sosBuild = await admin('GET', `/v1/capabilities/workspaces/plugins/${sos.body.id}/build`);
    assert.equal(sosBuild.status, 200, JSON.stringify(sosBuild.body));
    assert.equal(sosBuild.body.source.repository, 'https://github.com/vku-open-source-2026/SynapseCitySOS');
    assert.equal(sosBuild.body.source.path, 'plugins/sos-build-ready.plugin.json');

    // Unpublishing makes the old snapshot historical: export falls back to the
    // draft and build refuses until the plugin is published again.
    const unpublished = await admin('POST', `/v1/capabilities/workspaces/plugins/${id}/unpublish`, {
      version: draft.body.version,
    });
    assert.equal(unpublished.status, 200, JSON.stringify(unpublished.body));
    const afterUnpublish = await admin('GET', `/v1/capabilities/workspaces/plugins/${id}/export`);
    assert.equal(afterUnpublish.status, 409);
    assert.equal(afterUnpublish.body.error.code, 'plugin_not_published');
    const afterUnpublishDraft = await admin('GET', `/v1/capabilities/workspaces/plugins/${id}/export?draft=1`);
    assert.equal(afterUnpublishDraft.body.plugin.widgets[0].text, 'Draft-only content.');
    const buildAfterUnpublish = await admin('GET', `/v1/capabilities/workspaces/plugins/${id}/build`);
    assert.equal(buildAfterUnpublish.status, 409);
    assert.equal(buildAfterUnpublish.body.error.code, 'plugin_not_published');
  });

  test('build refuses drafts and provenance that cannot belong to the product repository', async () => {
    const draft = await createPlugin({ slug: 'build-draft-only' });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const unpublished = await admin('GET', `/v1/capabilities/workspaces/plugins/${draft.body.id}/build`);
    assert.equal(unpublished.status, 409);
    assert.equal(unpublished.body.error.code, 'plugin_not_published');
    const draftSyncExport = await admin('GET', `/v1/capabilities/workspaces/plugins/${draft.body.id}/export`);
    assert.equal(draftSyncExport.status, 409);
    assert.equal(draftSyncExport.body.error.code, 'plugin_not_published');
    const explicitDraftExport = await admin('GET', `/v1/capabilities/workspaces/plugins/${draft.body.id}/export?draft=1`);
    assert.equal(explicitDraftExport.status, 200, JSON.stringify(explicitDraftExport.body));

    const foreign = await createPlugin({
      slug: 'build-foreign-source',
      source: {
        repository: 'https://github.com/vku-open-source-2026/SynapseCitySOS',
        path: 'plugins/build-foreign-source.plugin.json',
      },
    });
    assert.equal(foreign.status, 201, JSON.stringify(foreign.body));
    const foreignPublished = await admin('POST', `/v1/capabilities/workspaces/plugins/${foreign.body.id}/publish`);
    assert.equal(foreignPublished.status, 200, JSON.stringify(foreignPublished.body));
    const foreignBuild = await admin('GET', `/v1/capabilities/workspaces/plugins/${foreign.body.id}/build`);
    assert.equal(foreignBuild.status, 409);
    assert.equal(foreignBuild.body.error.code, 'source_not_syncable');

    const legacyPath = await createPlugin({
      slug: 'build-legacy-path',
      source: {
        repository: 'https://github.com/vku-open-source-2026/SynapseCity',
        path: 'plugins/not-tracked.json',
      },
    });
    assert.equal(legacyPath.status, 201, JSON.stringify(legacyPath.body));
    const legacyPublished = await admin('POST', `/v1/capabilities/workspaces/plugins/${legacyPath.body.id}/publish`);
    assert.equal(legacyPublished.status, 200, JSON.stringify(legacyPublished.body));
    const legacyBuild = await admin('GET', `/v1/capabilities/workspaces/plugins/${legacyPath.body.id}/build`);
    assert.equal(legacyBuild.status, 409);
    assert.equal(legacyBuild.body.error.code, 'source_not_syncable');
  });

  test('import validation rejects tampered checksums, extra metadata and unsafe provenance', async () => {
    seedArtifact();
    const { id } = await publishedInstalled({ slug: 'bundle-source' });
    const exported = await admin('GET', `/v1/capabilities/workspaces/plugins/${id}/export`);
    const bundle = exported.body;

    const tampered = { ...bundle, checksum: `sha256:${'0'.repeat(64)}` };
    const mismatch = await admin('POST', '/v1/capabilities/workspaces/import', tampered);
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, 'bundle_checksum_mismatch');

    const smuggle = {
      ...bundle,
      plugin: { ...bundle.plugin, tenant: 'org-b', token: 'wsp_leak' },
      checksum: undefined,
    };
    delete (smuggle as any).checksum;
    const extra = await admin('POST', '/v1/capabilities/workspaces/import', smuggle);
    assert.equal(extra.status, 400);
    assert.equal(extra.body.error.code, 'invalid_plugin');

    const unsafeSource = {
      ...bundle,
      source: { repository: 'http://gitlab.example/x/y', path: 'plugins/x.json' },
      checksum: undefined,
    };
    delete (unsafeSource as any).checksum;
    const badSource = await admin('POST', '/v1/capabilities/workspaces/import', unsafeSource);
    assert.equal(badSource.status, 400);
    assert.equal(badSource.body.error.code, 'invalid_source');

    const traversal = {
      ...bundle,
      source: { repository: 'https://github.com/vku-open-source-2026/SynapseCity', path: '../../etc/passwd' },
      checksum: undefined,
    };
    delete (traversal as any).checksum;
    assert.equal((await admin('POST', '/v1/capabilities/workspaces/import', traversal)).status, 400);

    const wrongFormat = { ...bundle, format: 'other' };
    const format = await admin('POST', '/v1/capabilities/workspaces/import', wrongFormat);
    assert.equal(format.status, 400);
    assert.equal(format.body.error.code, 'invalid_bundle');

    // Import applies the same plain-text URL policy as the console.
    const urlBundle = JSON.parse(JSON.stringify(bundle));
    urlBundle.plugin.widgets = [{ id: 'intro', type: 'text', title: 'Link', text: 'https://example.test' }];
    delete urlBundle.checksum;
    const urlRejected = await admin('POST', '/v1/capabilities/workspaces/import', urlBundle);
    assert.equal(urlRejected.status, 400);
    assert.equal(urlRejected.body.error.code, 'invalid_widget');
  });

  test('the plugin API never shadows the legacy PARA workspace endpoints', async () => {
    // Legacy collaboration endpoints still answer.
    const legacy = await api(harness, '/v1/capabilities/workspaces', { token: 'user-token' });
    assert.equal(legacy.status, 200);
    assert.ok(Array.isArray(legacy.body.items));

    const catalog = await api(harness, '/v1/capabilities/workspaces/catalog', { token: 'admin-token' });
    assert.equal(catalog.status, 200);
    assert.ok(Array.isArray(catalog.body.products));

    const installed = await api(harness, '/v1/capabilities/workspaces/installed', { token: 'member-token' });
    assert.equal(installed.status, 200);
    assert.ok(Array.isArray(installed.body.items));

    // /members exists (403 for a member, not a 404 route miss).
    const members = await api(harness, '/v1/capabilities/workspaces/members', { token: 'member-token' });
    assert.equal(members.status, 403);
    assert.equal(members.body.error.code, 'admin_required');
  });

  test('lifecycle actions are audited without token material', async () => {
    const { id } = await publishedInstalled();
    await admin('POST', `/v1/capabilities/workspaces/plugins/${id}/unpublish`);
    const created = await admin('POST', '/v1/capabilities/workspaces/tokens', { product: 'city', name: 'audit token' });
    await admin('DELETE', `/v1/capabilities/workspaces/tokens/${created.body.id}`);

    const audit = await api(harness, '/v1/capabilities/audit?limit=200', { token: 'admin-token' });
    assert.equal(audit.status, 200);
    const actions = audit.body.items.map((item: any) => item.action);
    for (const action of ['workspace.plugin.create', 'workspace.plugin.publish', 'workspace.plugin.install', 'workspace.plugin.unpublish', 'workspace.token.create', 'workspace.token.revoke']) {
      assert.ok(actions.includes(action), action);
    }
    const serialized = JSON.stringify(audit.body);
    assert.equal(serialized.includes(created.body.token), false);
    assert.equal(serialized.toLowerCase().includes('tokenhash'), false);
  });
});
