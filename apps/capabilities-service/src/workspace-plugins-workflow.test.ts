// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Workflow-bound form execution with the minimum published SDK capability.
 *
 * The deployed dependency here is `@synapseone/sdk` 0.9.0, so the workflow
 * capability (correctly) refuses plugin execution until 0.9.1. This file
 * simulates that deployment upgrade in an isolated test process so the real
 * helper path — protected technical artifact, revision/checksum pin, live
 * Tier-1 graph check, per-org technical identity — is exercised.
 *
 * It also proves that generic non-create actions (`update`/`delete`/`execute`)
 * cannot bypass role, installation, tenant, protection or drift checks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Simulate the published SDK release the deployment is gated on.
const sdkPackagePath = require.resolve('@synapseone/sdk/package.json');
const sdkPackage = require(sdkPackagePath) as { version?: string };
sdkPackage.version = '0.9.1';

import { api, Harness, startHarness } from './testing/harness';
import { COLLECTIONS } from './platform';
import { workflowGraphChecksum } from './routes/workflow-artifacts';

const WORKFLOW_ARTIFACTS = 'synapsedx_capability_workflow_artifacts';
const ORG_KEY = 'workflow-org-key';
const DEFINITION = {
  nodes: [{ name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0] }],
  connections: {},
  settings: { access: { mode: 'owner-only' } },
};
const CHECKSUM = workflowGraphChecksum(DEFINITION);

interface Fixture {
  harness: Harness;
  artifacts: Map<string, any>;
}

async function fixture(options: { withOrgKey?: boolean; protectedArtifact?: boolean } = {}): Promise<Fixture> {
  const harness = await startHarness(options.withOrgKey === false
    ? { SYNAPSEDX_WORKFLOW_API_KEYS: undefined }
    : {});
  const now = new Date().toISOString();
  const artifacts = new Map<string, any>();
  harness.fake.collections.set(WORKFLOW_ARTIFACTS, artifacts);
  artifacts.set('artifact-0001', {
    id: 'artifact-0001',
    version: 1,
    createdAt: now,
    updatedAt: now,
    data: {
      id: 'artifact-0001', tenant: 'org-a', revision: 1, workflowRevision: 1, checksum: CHECKSUM,
      workflowId: 'wf-1', name: 'Incident intake', slug: 'incident-intake',
      createdBy: 'admin-1', createdAt: now, updatedAt: now,
      managedBy: options.protectedArtifact === false ? 'user' : 'technical',
      settings: options.protectedArtifact === false ? {} : { access: { mode: 'owner-only' } },
    },
  });
  harness.fake.workflows.set('wf-1', { id: 'wf-1', name: 'Incident intake', definition: DEFINITION, active: true });
  return { harness, artifacts };
}

async function setupPlugin(harness: Harness, action: string, protectedArtifact = true) {
  const created = await api(harness, '/v1/capabilities/workspaces/plugins', {
    method: 'POST', token: 'admin-token',
    body: {
      product: 'city', name: 'Intake', slug: `intake-${action}`, audience: 'member', roles: ['volunteer'],
      widgets: [{
        id: 'report', type: 'form', title: 'Incident action', resource: 'incidents', action,
        workflowArtifactId: 'artifact-0001',
        fields: [
          { name: 'summary', label: 'Summary', type: 'textarea', required: true },
          { name: 'severity', label: 'Severity', type: 'number' },
        ],
      }],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  const published = await api(harness, `/v1/capabilities/workspaces/plugins/${id}/publish`, { method: 'POST', token: 'admin-token' });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal((await api(harness, `/v1/capabilities/workspaces/plugins/${id}/install`, {
    method: 'POST', token: 'admin-token', body: { roles: ['volunteer'] },
  })).status, 201);
  assert.equal((await api(harness, '/v1/capabilities/workspaces/members/member-1', {
    method: 'PUT', token: 'admin-token', body: { roles: ['volunteer'] },
  })).status, 200);
  return id;
}

test('a non-create action executes only through the protected pinned artifact', async () => {
  const { harness, artifacts } = await fixture();
  try {
    const id = await setupPlugin(harness, 'update');
    const catalog = await api(harness, '/v1/capabilities/workspaces/catalog', { token: 'admin-token' });
    assert.equal(catalog.body.workflowExecution.ready, true);
    assert.equal(catalog.body.workflowOrgReadiness.ready, true);
    assert.deepEqual(catalog.body.actionTypes, ['create', 'update', 'delete', 'execute']);

    const installed = await api(harness, `/v1/capabilities/workspaces/installed/${id}`, { token: 'member-token' });
    assert.equal(installed.status, 200);
    assert.equal(installed.body.widgets[0].action, 'update');
    assert.equal(installed.body.widgets[0].canSubmit, true);
    assert.equal(installed.body.widgets[0].canSubmitReason, 'ready');
    assert.equal(installed.body.widgets[0].workflowArtifactRevision, undefined);
    assert.equal(installed.body.widgets[0].workflowArtifactChecksum, undefined);

    const executed = await api(harness, `/v1/capabilities/workspaces/installed/${id}/widgets/report/execute`, {
      method: 'POST', token: 'member-token',
      body: { values: { summary: 'Broken lamp', severity: 2 } },
    });
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(executed.body.artifactRevision, 1);
    assert.equal(harness.fake.executions.length, 1);

    const request = harness.fake.requests.find((entry) => entry.path === '/v1/workflows/wf-1/execute');
    assert.ok(request, 'Tier-1 workflow execute was called');
    // Execution uses the per-org technical identity, never the member bearer.
    assert.equal(request!.headers['x-api-key'], ORG_KEY);
    assert.equal(request!.headers.authorization, undefined);
    assert.equal((request!.body as any).action, 'update');
    assert.deepEqual((request!.body as any).fields, { summary: 'Broken lamp', severity: 2 });
    assert.equal((request!.body as any).expectedRevision, undefined);
    assert.equal((request!.body as any).expectedChecksum, undefined);

    // Live graph drift: the artifact and pins are unchanged but Tier-1 was
    // edited outside DX; execution is refused and the form disables.
    harness.fake.workflows.set('wf-1', {
      id: 'wf-1', name: 'Incident intake',
      definition: {
        ...DEFINITION,
        nodes: [...DEFINITION.nodes, { name: 'Unreviewed', type: 'n8n-nodes-base.noop', typeVersion: 1, position: [1, 1] }],
      },
      active: true,
    });
    const drift = await api(harness, `/v1/capabilities/workspaces/installed/${id}/widgets/report/execute`, {
      method: 'POST', token: 'member-token', body: { values: { summary: 'Broken lamp' } },
    });
    assert.equal(drift.status, 409, JSON.stringify(drift.body));
    assert.equal(drift.body.error.code, 'artifact_out_of_sync');
    assert.equal(harness.fake.executions.length, 1);

    // Artifact-record drift.
    harness.fake.workflows.set('wf-1', { id: 'wf-1', name: 'Incident intake', definition: DEFINITION, active: true });
    artifacts.set('artifact-0001', {
      ...artifacts.get('artifact-0001'),
      data: { ...artifacts.get('artifact-0001').data, revision: 2, checksum: 'b'.repeat(64) },
    });
    const changed = await api(harness, `/v1/capabilities/workspaces/installed/${id}/widgets/report/execute`, {
      method: 'POST', token: 'member-token', body: { values: { summary: 'Broken lamp' } },
    });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'workflow_artifact_changed');
    const staleView = await api(harness, `/v1/capabilities/workspaces/installed/${id}`, { token: 'member-token' });
    assert.equal(staleView.body.widgets[0].canSubmit, false);
    assert.equal(staleView.body.widgets[0].canSubmitReason, 'workflow_artifact_revision_mismatch');

    // A repository build/export must not launder the newer artifact checksum
    // into a "reviewed" bundle; both fail closed until a republish.
    for (const action of ['export', 'build']) {
      const staleArtifact = await api(harness, `/v1/capabilities/workspaces/plugins/${id}/${action}`, { token: 'admin-token' });
      assert.equal(staleArtifact.status, 409, `${action}: ${JSON.stringify(staleArtifact.body)}`);
      assert.equal(staleArtifact.body.error.code, 'artifact_out_of_sync');
    }

    // Runtime tokens can read the layout but never submit it.
    const token = await api(harness, '/v1/capabilities/workspaces/tokens', {
      method: 'POST', token: 'admin-token', body: { product: 'city', name: 'renderer' },
    });
    const runtime = await api(harness, '/v1/capabilities/workspaces/runtime/city', {
      headers: { 'x-workspace-token': token.body.token },
    });
    assert.equal(runtime.status, 200);
    assert.equal(runtime.body.items[0].widgets[0].canSubmit, false);
    assert.equal(runtime.body.items[0].widgets[0].canSubmitReason, 'runtime_token_read_only');
  } finally {
    await harness.close();
  }
});

test('a globally ready SDK never implies per-organization action readiness', async () => {
  const { harness } = await fixture({ withOrgKey: false });
  try {
    const id = await setupPlugin(harness, 'delete');
    const catalog = await api(harness, '/v1/capabilities/workspaces/catalog', { token: 'admin-token' });
    assert.equal(catalog.body.workflowExecution.ready, true);
    assert.equal(catalog.body.workflowOrgReadiness.ready, false);
    assert.equal(catalog.body.workflowOrgReadiness.reason, 'workflow_technical_identity_missing');

    const installed = await api(harness, `/v1/capabilities/workspaces/installed/${id}`, { token: 'member-token' });
    assert.equal(installed.status, 200);
    assert.equal(installed.body.widgets[0].canSubmit, false);
    assert.equal(installed.body.widgets[0].canSubmitReason, 'workflow_technical_identity_missing');

    const executed = await api(harness, `/v1/capabilities/workspaces/installed/${id}/widgets/report/execute`, {
      method: 'POST', token: 'member-token', body: { values: { summary: 'Remove me' } },
    });
    assert.equal(executed.status, 503, JSON.stringify(executed.body));
    assert.equal(executed.body.error.code, 'dependency_unavailable');
    assert.equal(executed.body.error.details.technicalIdentity, false);
    assert.equal(harness.fake.executions.length, 0);
  } finally {
    await harness.close();
  }
});

test('non-create actions cannot bypass role, tenant or artifact-protection checks', async () => {
  // Unprotected artifact: binding is rejected at create/publish time.
  {
    const { harness } = await fixture({ protectedArtifact: false });
    try {
      const created = await api(harness, '/v1/capabilities/workspaces/plugins', {
        method: 'POST', token: 'admin-token',
        body: {
          product: 'city', name: 'Unsafe', slug: 'unsafe-form', audience: 'member', roles: ['volunteer'],
          widgets: [{
            id: 'run', type: 'form', title: 'Run', resource: 'incidents', action: 'execute',
            workflowArtifactId: 'artifact-0001',
            fields: [{ name: 'target', label: 'Target', type: 'text', required: true }],
          }],
        },
      });
      assert.equal(created.status, 409, JSON.stringify(created.body));
      assert.equal(created.body.error.code, 'workflow_not_protected');
    } finally {
      await harness.close();
    }
  }

  const { harness, artifacts } = await fixture();
  try {
    const id = await setupPlugin(harness, 'execute');

    // Missing membership role: installation is invisible and execution 404s.
    await api(harness, '/v1/capabilities/workspaces/members/member-1', {
      method: 'PUT', token: 'admin-token', body: { roles: ['manager'] },
    });
    const hidden = await api(harness, `/v1/capabilities/workspaces/installed/${id}`, { token: 'member-token' });
    assert.equal(hidden.status, 404);
    const noRole = await api(harness, `/v1/capabilities/workspaces/installed/${id}/widgets/report/execute`, {
      method: 'POST', token: 'member-token', body: { values: { summary: 'x' } },
    });
    assert.equal(noRole.status, 404);
    assert.equal(harness.fake.executions.length, 0);

    // Another organization can never see or run it.
    const otherOrg = await api(harness, `/v1/capabilities/workspaces/installed/${id}/widgets/report/execute`, {
      method: 'POST', token: 'other-token', body: { values: { summary: 'x' } },
    });
    assert.equal(otherOrg.status, 404);

    // The artifact loses protection after publishing: the layout disables and
    // execution is refused before any Tier-1 call.
    await api(harness, '/v1/capabilities/workspaces/members/member-1', {
      method: 'PUT', token: 'admin-token', body: { roles: ['volunteer'] },
    });
    artifacts.set('artifact-0001', {
      ...artifacts.get('artifact-0001'),
      data: { ...artifacts.get('artifact-0001').data, managedBy: 'user', settings: {} },
    });
    const unprotectedView = await api(harness, `/v1/capabilities/workspaces/installed/${id}`, { token: 'member-token' });
    assert.equal(unprotectedView.body.widgets[0].canSubmit, false);
    assert.equal(unprotectedView.body.widgets[0].canSubmitReason, 'workflow_artifact_not_protected');
    const unprotected = await api(harness, `/v1/capabilities/workspaces/installed/${id}/widgets/report/execute`, {
      method: 'POST', token: 'member-token', body: { values: { summary: 'x' } },
    });
    assert.equal(unprotected.status, 409);
    assert.equal(unprotected.body.error.code, 'workflow_not_protected');
    assert.equal(harness.fake.executions.length, 0);
  } finally {
    await harness.close();
  }
});
