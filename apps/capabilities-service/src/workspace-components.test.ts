// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWidgets,
  workspaceLimits,
  buildBundle,
  parseBundle,
  type WorkspacePluginRecord,
} from './workspace-plugins';
import { api, startHarness } from './testing/harness';
const limits = workspaceLimits();
test('new visual components survive portable build/import without losing configuration', () => {
  const widgets = parseWidgets(
    [
      { id: 'heading', type: 'heading', title: 'Welcome', text: 'Team workspace', width: 'full' },
      {
        id: 'navigation',
        type: 'navigation',
        title: 'Navigate',
        links: [
          { label: 'Tasks', target: 'module:tasks' },
          { label: 'Projects', target: 'page:our-projects' },
        ],
      },
      { id: 'progress', type: 'progress', title: 'Progress', value: 72 },
      { id: 'capability', type: 'capability', title: 'Tasks', module: 'tasks', width: 'full' },
    ],
    'dx',
    limits,
  );
  const plugin = {
    product: 'dx',
    name: 'Team',
    slug: 'team-workspace',
    audience: 'member',
    roles: ['viewer'],
    widgets,
  } as WorkspacePluginRecord;
  const bundle = buildBundle(plugin, new Map());
  assert.deepEqual(parseBundle(bundle, limits).plugin.widgets, widgets);
});
test('new components reject executable links, extra data bindings, unknown modules and invalid values', () => {
  const invalid = [
    {
      id: 'nav',
      type: 'navigation',
      title: 'Go',
      links: [{ label: 'Go', target: 'javascript:alert(1)' }],
    },
    {
      id: 'nav',
      type: 'navigation',
      title: 'Go',
      links: [{ label: 'Go', target: 'https://example.com' }],
    },
    {
      id: 'nav',
      type: 'navigation',
      title: 'Go',
      links: [{ label: 'Go', target: 'page:good', token: 'hidden' }],
    },
    { id: 'value', type: 'progress', title: 'Value', value: 101 },
    { id: 'heading', type: 'heading', title: 'Title', text: 'Hello', resource: 'assets' },
  ];
  for (const widget of invalid) assert.throws(() => parseWidgets([widget], 'dx', limits));
  assert.throws(() =>
    parseWidgets(
      [{ id: 'tasks', type: 'capability', title: 'Tasks', module: 'unknown' }],
      'city',
      limits,
    ),
  );
});
test('shared task board reads existing project tasks with pagination, tenant isolation and auth', async () => {
  const h = await startHarness();
  try {
    const project = await api(h, '/v1/capabilities/projects', {
      method: 'POST',
      token: 'user-token',
      body: { name: 'Team project', startDate: '2026-11-01', endDate: '2026-12-01' },
    });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const id = project.body.project.id;
    await api(h, `/v1/capabilities/projects/${id}/tasks`, {
      method: 'POST',
      token: 'user-token',
      body: { title: 'First task' },
    });
    const board = await api(h, '/v1/capabilities/project-tasks?limit=1', { token: 'user-token' });
    assert.equal(board.status, 200);
    assert.equal(board.body.items[0].title, 'First task');
    const outsider = await api(h, '/v1/capabilities/project-tasks', { token: 'other-token' });
    assert.equal(outsider.body.items.length, 0);
    const outsiderAdmin = await api(h, '/v1/capabilities/project-tasks', {
      token: 'other-admin-token',
    });
    assert.equal(outsiderAdmin.body.items.length, 0);
    assert.equal((await api(h, '/v1/capabilities/project-tasks')).status, 401);
  } finally {
    await h.close();
  }
});

test('Studio code is versioned data, round-trips with local widget bindings and never evaluates in DX', async () => {
  const code = { html: '<button data-event="run">Run</button>', css: 'button { color: teal }', javascript: 'throw new Error("must never evaluate on server")', inputs: ['rows'], actions: ['submit'], height: 300 };
  const widgets = [
    { id: 'rows', type: 'table', title: 'Assets', resource: 'assets', columns: ['name'] },
    { id: 'submit', type: 'form', title: 'Create asset', resource: 'assets', action: 'create', fields: [{name:'name',label:'Name',type:'text'}] },
    { id: 'custom', type: 'code', title: 'Custom view', code },
  ];
  const parsed = parseWidgets(widgets,'city',limits);
  const bundle = buildBundle({product:'city',name:'Existing City',slug:'existing-city',audience:'member',roles:['technician'],widgets:parsed} as WorkspacePluginRecord);
  assert.deepEqual(parseBundle(bundle,limits).plugin.widgets[2].code,code);
  for (const patch of [{inputs:['foreign-widget']},{actions:['rows']},{inputs:['rows','rows']},{height:1201},{javascript:'x'.repeat(32769)},{html:'x'.repeat(32768),css:'x'.repeat(32768),javascript:'x'},{url:'https://example.com'},{javascript:4}]) {
    assert.throws(()=>parseWidgets([...widgets.slice(0,2),{...widgets[2],code:{...code,...patch}}],'city',limits));
  }
  const h=await startHarness();
  try {
    const path='/v1/capabilities/workspaces/plugins';
    const created=await api(h,path,{method:'POST',token:'admin-token',body:{product:'city',name:'Existing City',slug:'existing-city',audience:'member',roles:['technician'],widgets}});
    assert.equal(created.status,201,JSON.stringify(created.body));
    const updated=await api(h,`${path}/${created.body.id}`,{method:'PUT',token:'admin-token',body:{version:created.body.version,widgets:[...widgets.slice(0,2),{...widgets[2],code:{...code,css:'button { color: blue }'}}]}});
    assert.equal(updated.status,200,JSON.stringify(updated.body));
    assert.equal(updated.body.id,created.body.id);
    assert.equal(updated.body.widgets[2].code.css,'button { color: blue }');
    const invalid=await api(h,`${path}/${created.body.id}`,{method:'PUT',token:'admin-token',body:{version:updated.body.version,product:'sos'}});
    assert.equal(invalid.status,400);
    const member=await api(h,`${path}/${created.body.id}`,{method:'PUT',token:'user-token',body:{version:updated.body.version,name:'Changed'}});
    assert.equal(member.status,403);
  } finally { await h.close(); }
});
