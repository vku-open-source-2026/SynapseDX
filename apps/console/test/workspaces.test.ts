// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import {
  catalogMutation,
  catalogResources,
  catalogRoles,
  formDisabledReason,
  formReasonMessage,
  installedWidgetDataPath,
  installedWidgetExecutePath,
  isFormWritable,
  isSafePlainText,
  isSafeWorkflowArtifactId,
  moveItem,
  parseInstalledList,
  parseMembers,
  parsePlugin,
  parsePluginBundle,
  parseTokens,
  parseWidgetData,
  parseWorkflowArtifacts,
  parseWorkflowReadiness,
  parseWorkspaceCatalog,
  safeCellText,
  toWriteWidget,
  tokenStatus,
  validatePluginDraft,
  validateWidget,
  type RuntimeWidget,
  type WorkspaceCatalog,
  type WorkspacePlugin,
} from '../src/lib/workspaces';

const catalogPayload = {
  products: [
    {
      product: 'city',
      roles: ['admin', 'manager', 'technician', 'volunteer'],
      publicRoles: ['citizen'],
      resources: [{ key: 'assets', path: '/v1/assets', dataset: 'city-assets' }],
      widgetTypes: ['text', 'metric', 'table', 'form'],
      actionTypes: ['create', 'update', 'delete', 'execute'],
    },
    {
      product: 'sos',
      roles: ['admin', 'manager', 'operator', 'responder', 'volunteer'],
      publicRoles: ['citizen'],
      resources: [{ key: 'events', path: '/v1/emergency/events', dataset: 'sos-emergency-events' }],
      widgetTypes: ['text', 'metric', 'table', 'form'],
      actionTypes: ['create', 'update', 'delete', 'execute'],
    },
  ],
  widgetTypes: ['text', 'metric', 'table', 'form'],
  actionTypes: ['create', 'update', 'delete', 'execute'],
  audiences: ['admin', 'member'],
  mutation: {
    formExecution: false,
    formRequiresWorkflowArtifact: true,
    directDatasetWrites: false,
    reason: 'Plugin workflow execution requires the published @synapseone/sdk >=0.9.1',
  },
  workflowExecution: {
    ready: false,
    installedVersion: '0.9.0',
    minimumVersion: '0.9.1',
    requirement: 'Plugin workflow execution requires the published @synapseone/sdk >=0.9.1',
    canSubmit: false,
  },
  workflowOrgReadiness: {
    ready: false,
    reason: 'workflow_technical_identity_missing',
    requirement: 'No SYNAPSEDX_WORKFLOW_API_KEYS entry for this organization',
    configured: false,
    verified: false,
  },
  limits: {
    maxWidgets: 40,
    maxFields: 30,
    maxColumns: 20,
    maxTextLength: 4000,
    maxPluginsPerOrg: 100,
    tokenDefaultDays: 90,
    tokenMaxDays: 365,
    widgetDataMaxRows: 100,
  },
  roles: ['admin', 'manager', 'technician', 'operator', 'responder', 'volunteer'],
};

const catalog: WorkspaceCatalog = parseWorkspaceCatalog(catalogPayload);

const textWidget = { id: 'text-1', type: 'text', title: 'Welcome', text: 'Plain instructions.' };
const formWidget = {
  id: 'form-1',
  type: 'form',
  title: 'Report an issue',
  resource: 'assets',
  action: 'create',
  workflowArtifactId: 'artifact_1234',
  fields: [{ name: 'notes', label: 'Notes', type: 'textarea', required: true }],
};

const plugin: WorkspacePlugin = {
  id: 'plugin-1',
  product: 'city',
  name: 'City team page',
  slug: 'city-team',
  audience: 'member',
  roles: ['volunteer'],
  widgets: [textWidget],
  status: 'draft',
  version: 1,
  installed: false,
  createdAt: '2026-11-14T00:00:00Z',
  updatedAt: '2026-11-14T00:00:00Z',
};

const bundleFormWidget = {
  id: 'form-1',
  type: 'form',
  title: 'Report an issue',
  resource: 'assets',
  action: 'create',
  workflowRef: { name: 'Create asset', slug: 'create-asset' },
  fields: [{ name: 'notes', label: 'Notes', type: 'textarea', required: true }],
};

const bundle = {
  format: 'synapsedx-plugin',
  formatVersion: 1,
  plugin: {
    product: 'city',
    name: 'City team page',
    slug: 'city-team',
    audience: 'member',
    roles: ['volunteer'],
    widgets: [textWidget, bundleFormWidget],
  },
  source: {
    repository: 'https://github.com/VKU-VIC/synapsecity',
    path: 'plugins/city-team.json',
    revision: 'abc1234',
  },
  checksum: `sha256:${'a'.repeat(64)}`,
};

describe('plain-text and widget safety', () => {
  it('accepts inert text and rejects markup and script/data schemes', () => {
    expect(isSafePlainText('Team update: 3 assets need review.')).toBe(true);
    expect(isSafePlainText('See https://example.test/report for the source note.')).toBe(true);
    expect(isSafePlainText('<script>alert(1)</script>')).toBe(false);
    expect(isSafePlainText('javascript:alert(1)')).toBe(false);
    expect(isSafePlainText('data:text/html;base64,AAAA')).toBe(false);
  });

  it('validates each safe widget type and rejects unknown keys', () => {
    expect(validateWidget(textWidget)).toEqual([]);
    expect(validateWidget({ ...textWidget, text: '<img src=x>' })).not.toEqual([]);
    expect(validateWidget({ id: 'metric-1', type: 'metric', title: 'Assets', resource: 'assets' })).toEqual([]);
    expect(validateWidget({ id: 'table-1', type: 'table', title: 'Assets', resource: 'assets', columns: ['id', 'status'] })).toEqual([]);
    expect(validateWidget(formWidget)).toEqual([]);
    expect(validateWidget({ ...formWidget, action: 'update' })).toEqual([]);
    expect(validateWidget({ ...formWidget, action: 'delete' })).toEqual([]);
    expect(validateWidget({ ...formWidget, action: 'execute' })).toEqual([]);
    expect(validateWidget({ ...formWidget, action: 'patch' })).not.toEqual([]);
    expect(validateWidget({ ...formWidget, workflowArtifactId: 'https://evil.test/x' })).not.toEqual([]);
    expect(validateWidget({ ...textWidget, html: '<b>x</b>' })).not.toEqual([]);
    expect(validateWidget({ ...textWidget, resource: 'assets' })).not.toEqual([]);
  });

  it('rejects public roles, unknown roles and duplicate widget ids', () => {
    expect(validatePluginDraft(plugin, { allowedRoles: catalogRoles(catalog, 'city') })).toEqual([]);
    expect(validatePluginDraft({ ...plugin, roles: ['citizen'] })).not.toEqual([]);
    expect(
      validatePluginDraft({ ...plugin, roles: ['responder'] }, { allowedRoles: catalogRoles(catalog, 'city') }),
    ).not.toEqual([]);
    expect(
      validatePluginDraft({ ...plugin, widgets: [textWidget, { ...textWidget, title: 'Again' }] }),
    ).not.toEqual([]);
    expect(isSafeWorkflowArtifactId('artifact_1234')).toBe(true);
    expect(isSafeWorkflowArtifactId('../artifact')).toBe(false);
  });
});

describe('portable bundle validation', () => {
  it('accepts the exact export shape and keeps it unchanged for checksum verification', () => {
    const result = parsePluginBundle(bundle);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bundle).toBe(bundle);
    expect(
      parsePluginBundle({
        ...bundle,
        plugin: { ...bundle.plugin, widgets: [{ ...bundleFormWidget, action: 'execute' }] },
      }).ok,
    ).toBe(true);
    expect(
      parsePluginBundle({
        ...bundle,
        plugin: {
          ...bundle.plugin,
          widgets: [{ ...textWidget, text: 'See https://example.test/report for details.' }],
        },
      }).ok,
    ).toBe(true);
  });

  it('rejects server state, wrong format versions and malformed checksums', () => {
    expect(parsePluginBundle({ ...bundle, tenant: 'org:demo' }).ok).toBe(false);
    expect(parsePluginBundle({ ...bundle, formatVersion: 2 }).ok).toBe(false);
    expect(parsePluginBundle({ ...bundle, checksum: 'sha256:short' }).ok).toBe(false);
    expect(
      parsePluginBundle({
        ...bundle,
        plugin: { ...bundle.plugin, id: 'plugin-1', status: 'published' },
      }).ok,
    ).toBe(false);
  });

  it('rejects non-GitHub provenance, traversal paths and unsafe text', () => {
    expect(
      parsePluginBundle({
        ...bundle,
        source: { repository: 'https://evil.test/repo', path: 'plugins/a.json' },
      }).ok,
    ).toBe(false);
    expect(
      parsePluginBundle({
        ...bundle,
        source: { repository: 'https://github.com/a/b', path: '../escape.json' },
      }).ok,
    ).toBe(false);
    expect(
      parsePluginBundle({
        ...bundle,
        plugin: { ...bundle.plugin, widgets: [{ ...textWidget, text: 'javascript:alert(1)' }] },
      }).ok,
    ).toBe(false);
    expect(
      parsePluginBundle({
        ...bundle,
        plugin: { ...bundle.plugin, widgets: [formWidget] },
      }).ok,
    ).toBe(false);
  });
});

describe('catalog and strict response parsing', () => {
  it('parses the documented catalog exactly', () => {
    expect(catalogRoles(catalog, 'city')).toEqual(['admin', 'manager', 'technician', 'volunteer']);
    expect(catalogResources(catalog, 'city').map((item) => item.key)).toEqual(['assets']);
    expect(catalogMutation(catalog).formExecution).toBe(false);
    expect(catalogMutation(catalog).directDatasetWrites).toBe(false);
    expect(catalogMutation(catalog).formRequiresWorkflowArtifact).toBe(true);
    expect(catalog.workflowExecution?.requirement).toContain('@synapseone/sdk');
    expect(catalog.actionTypes).toEqual(['create', 'update', 'delete', 'execute']);
    expect(catalog.workflowOrgReadiness?.reason).toBe('workflow_technical_identity_missing');
    expect(() => parseWorkspaceCatalog({ products: [{ product: 'city' }] })).toThrow();
    expect(() =>
      parseWorkspaceCatalog({
        ...catalogPayload,
        products: [{ ...catalogPayload.products[0], resources: [{ key: 'https://evil.test' }] }],
      }),
    ).toThrow();
  });

  it('parses plugin and installed snapshots with canSubmit authorization', () => {
    const parsed = parsePlugin({
      ...plugin,
      publishedVersion: 1,
      publishedAt: '2026-11-14T01:00:00Z',
    });
    expect(parsed.id).toBe('plugin-1');

    const installed = parseInstalledList({
      items: [
        {
          id: 'plugin-1',
          product: 'city',
          name: 'City team page',
          slug: 'city-team',
          audience: 'member',
          roles: ['volunteer'],
          widgets: [{ ...formWidget, canSubmit: true }],
          version: 2,
          publishedVersion: 2,
          publishedAt: '2026-11-14T01:00:00Z',
          checksum: `sha256:${'b'.repeat(64)}`,
          installationRoles: ['volunteer'],
        },
      ],
    });
    expect(installed[0].id).toBe('plugin-1');
    expect(installed[0].widgets[0].canSubmit).toBe(true);
    const denied = parseInstalledList({
      items: [
        {
          ...installed[0],
          widgets: [
            {
              ...formWidget,
              action: 'update',
              canSubmit: false,
              canSubmitReason: 'workflow_technical_identity_missing',
            },
          ],
        },
      ],
    });
    expect(denied[0].widgets[0].action).toBe('update');
    expect(denied[0].widgets[0].canSubmitReason).toBe('workflow_technical_identity_missing');
    expect(() => parseInstalledList({ items: [{ ...installed[0], id: undefined }] })).toThrow();
  });

  it('parses members, tokens and workflow artifacts strictly', () => {
    expect(
      parseMembers({ items: [{ subject: 'user-1', roles: ['volunteer'], updatedAt: '2026-11-14T00:00:00Z' }] })[0],
    ).toMatchObject({ subject: 'user-1', roles: ['volunteer'] });

    const tokens = parseTokens({
      items: [
        {
          id: 'token-1',
          product: 'sos',
          name: 'Edge deploy',
          tokenPrefix: 'wsp_abcdefg',
          createdAt: '2026-11-14T00:00:00Z',
          expiresAt: '2027-02-12T00:00:00Z',
        },
      ],
    });
    expect(tokenStatus(tokens[0])).toBe('active');
    expect(tokenStatus({ ...tokens[0], revokedAt: '2026-11-14T02:00:00Z' })).toBe('revoked');

    const artifacts = parseWorkflowArtifacts({
      items: [
        { id: 'artifact_1234', name: 'Create asset', active: true, revision: 3, nodeCount: 4, syncState: 'pending' },
      ],
    });
    expect(artifacts[0]).toMatchObject({ id: 'artifact_1234', active: true, revision: 3, syncState: 'pending' });

    const readiness = parseWorkflowReadiness({
      workflowExecution: {
        ready: false,
        installedVersion: '0.9.0',
        minimumVersion: '0.9.1',
        requirement: 'Upgrade @synapseone/sdk',
        canSubmit: false,
      },
      pluginFormsCanSubmit: false,
      directManagementExecute: true,
    });
    expect(readiness.pluginFormsCanSubmit).toBe(false);
    expect(readiness.workflowExecution.requirement).toContain('@synapseone/sdk');
    expect(() => parseWorkflowReadiness({ pluginFormsCanSubmit: true })).toThrow();
  });
});

describe('runtime widgets, data and forms', () => {
  it('parses the documented widget data responses strictly', () => {
    const metric = parseWidgetData(
      {
        widgetId: 'metric-1',
        type: 'metric',
        title: 'Assets',
        resource: 'assets',
        count: 12,
        generatedAt: '2026-11-14T00:00:00Z',
      },
      'metric',
    );
    expect(metric).toEqual({ rows: [], total: 12, columns: [] });

    const table = parseWidgetData(
      {
        widgetId: 'table-1',
        type: 'table',
        title: 'Assets',
        resource: 'assets',
        items: [{ id: 'a1', status: 'open' }],
        total: 12,
        columns: ['id', 'status'],
        limit: 50,
        offset: 0,
        generatedAt: '2026-11-14T00:00:00Z',
      },
      'table',
    );
    expect(table.total).toBe(12);
    expect(table.rows).toHaveLength(1);
    expect(table.columns).toEqual(['id', 'status']);

    expect(() => parseWidgetData({ type: 'table', total: 1 }, 'table')).toThrow();
    expect(() => parseWidgetData({ type: 'table', items: [], total: 'many' }, 'table')).toThrow();
    expect(() => parseWidgetData({ type: 'metric', count: -1 }, 'metric')).toThrow();
    expect(() => parseWidgetData({ type: 'metric', count: 1 }, 'table')).toThrow();
  });

  it('renders values as inert text', () => {
    expect(safeCellText('<b>hello</b>')).toBe('<b>hello</b>');
    expect(safeCellText(null)).toBe('—');
    expect(safeCellText({ a: 1 })).toBe('{"a":1}');
  });

  it('enables a form only for canSubmit + a bound workflow artifact', () => {
    const bound: RuntimeWidget = { ...formWidget, canSubmit: true } as RuntimeWidget;
    expect(isFormWritable(bound)).toBe(true);
    expect(formDisabledReason(bound)).toBeNull();
    expect(isFormWritable({ ...formWidget } as RuntimeWidget)).toBe(false);
    expect(isFormWritable({ ...formWidget, action: 'create' } as RuntimeWidget)).toBe(false);
    expect(isFormWritable({ ...formWidget, canSubmit: true, workflowArtifactId: undefined } as RuntimeWidget)).toBe(false);
    expect(formDisabledReason({ ...formWidget, canSubmit: true, workflowArtifactId: undefined } as RuntimeWidget)).toMatch(
      /workflow artifact/i,
    );
    expect(formReasonMessage('workflow_technical_identity_missing')).toContain('SYNAPSEDX_WORKFLOW_API_KEYS');
    expect(formReasonMessage('workflow_technical_identity_missing')).toContain(
      '(workflow_technical_identity_missing)',
    );
    expect(formReasonMessage('workflow_sdk_release_required', 'global requirement')).toBe(
      'global requirement (workflow_sdk_release_required)',
    );
    expect(formReasonMessage('ready')).toBeNull();
  });

  it('builds encoded runtime paths and strips server-only fields before save', () => {
    expect(installedWidgetDataPath('plugin/1', 'table 1')).toBe(
      '/v1/capabilities/workspaces/installed/plugin%2F1/widgets/table%201/data',
    );
    expect(installedWidgetExecutePath('plugin-1', 'form-1')).toBe(
      '/v1/capabilities/workspaces/installed/plugin-1/widgets/form-1/execute',
    );
    const writable = {
      ...formWidget,
      action: 'execute',
      canSubmit: true,
      canSubmitReason: 'should not be written',
      workflowArtifactRevision: 3,
      workflowArtifactChecksum: `sha256:${'c'.repeat(64)}`,
    } as RuntimeWidget;
    const write = toWriteWidget(writable);
    expect('canSubmit' in write).toBe(false);
    expect('canSubmitReason' in write).toBe(false);
    expect('workflowArtifactRevision' in write).toBe(false);
    expect('workflowArtifactChecksum' in write).toBe(false);
    expect(write.action).toBe('execute');
    expect(write.workflowArtifactId).toBe('artifact_1234');
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });
});
