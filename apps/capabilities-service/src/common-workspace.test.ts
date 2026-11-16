// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, startHarness } from './testing/harness';
import { COLLECTIONS } from './platform';
import { workspaceDocId } from './workspace-plugins';

async function grant(h: Awaited<ReturnType<typeof startHarness>>, subject: string, productRoles: Record<string, string[]>) {
  const response = await api(h, `/v1/capabilities/workspaces/members/${subject}`, { method: 'PUT', token: 'admin-token', body: { productRoles } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

test('Common workspace isolates projects, tasks, wiki and inbox between apps, even for a member of both', async () => {
  const h = await startHarness();
  try {
    await grant(h, 'member-1', { city: ['manager'], sos: ['manager'] });
    await grant(h, 'moderator-1', { city: ['volunteer'], sos: ['volunteer'] });
    const request = (path: string, app: string, method = 'GET', body?: unknown) => api(h, `/v1/capabilities/${path}`, { token: 'member-token', method, headers: { 'X-Workspace-App': app }, ...(body ? { body } : {}) });
    const project = await request('projects', 'city', 'POST', { name: 'City road team', startDate: '2026-11-01', endDate: '2026-12-01' });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const projectId = project.body.project.id;
    const task = await request(`projects/${projectId}/tasks`, 'city', 'POST', { title: 'City only task' });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    assert.equal((await request('project-tasks', 'city')).body.items.length, 1);
    assert.equal((await request('project-tasks', 'sos')).body.items.length, 0);
    assert.equal((await request(`projects/${projectId}`, 'sos')).status, 404);
    assert.equal((await request(`project-tasks/${task.body.task.id}`, 'sos', 'PATCH', { status: 'done' })).status, 404);
    const ws = await request('workspaces', 'city', 'POST', { name: 'City knowledge', para: 'areas' });
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const page = await request(`workspaces/${ws.body.workspace.id}/pages`, 'city', 'POST', { title: 'Inspection handbook', markdown: 'City procedure' });
    assert.equal(page.status, 201, JSON.stringify(page.body));
    const pageId = page.body.page.id;
    assert.equal((await request(`pages/${pageId}`, 'city')).status, 200);
    assert.equal((await request(`pages/${pageId}`, 'sos')).status, 404);
    assert.equal((await request(`pages/${pageId}`, 'sos', 'PUT', { markdown: 'wrong app' })).status, 404);
    assert.equal((await request('page-search?q=Inspection', 'sos')).body.items.length, 0);
    const comment = await request('comments', 'city', 'POST', { module: 'workspace', entityType: 'page', entityId: pageId, body: 'City review', mentions: ['moderator-1'] });
    assert.equal(comment.status, 201, JSON.stringify(comment.body));
    assert.equal((await api(h, '/v1/capabilities/inbox', { token:'moderator-token', headers:{'X-Workspace-App':'city'} })).body.items.length, 1);
    assert.equal((await api(h, '/v1/capabilities/inbox', { token:'moderator-token', headers:{'X-Workspace-App':'sos'} })).body.items.length, 0);
    assert.equal((await api(h, '/v1/capabilities/projects', { token: 'member-token' })).status, 403);
    // Revocation applies to the API as well as the app switcher.
    await grant(h, 'member-1', { city: ['manager'] });
    assert.equal((await request('projects', 'sos')).status, 403);
    assert.equal((await request('projects', 'other')).status, 400);
    assert.equal((await api(h, '/v1/capabilities/management/settings', { token: 'member-token', headers: { 'X-Workspace-App': 'city' } })).status, 403);
  } finally { await h.close(); }
});

test('legacy global roles and self-asserted app admin cannot grant another app or organization administration', async () => {
  const h = await startHarness();
  try {
    const id = workspaceDocId('ws-member', 'org-a', 'member-1');
    h.fake.collections.set(COLLECTIONS.workspaceMembers, new Map([[id, { id, version: 1, data: { id, tenant: 'org-a', subject: 'member-1', roles: ['admin', 'manager'] } } as any]]));
    assert.deepEqual((await api(h, '/v1/capabilities/workspaces/access', { token: 'member-token' })).body.products, []);
    await grant(h, 'member-1', { city: ['admin'] });
    const access = await api(h, '/v1/capabilities/workspaces/access', { token: 'member-token' });
    assert.deepEqual(access.body.products, ['city']);
    assert.equal(access.body.isOrganizationAdmin, false);
    const denied = await api(h, '/v1/capabilities/workspaces/members/member-1', { method: 'PUT', token: 'member-token', body: { productRoles: { sos: ['admin'] } } });
    assert.equal(denied.status, 403);
    assert.equal((await api(h, '/v1/capabilities/projects', { token: 'member-token', headers: { 'X-Workspace-App': 'sos' } })).status, 403);
    const legacy = await api(h, '/v1/capabilities/workspaces/members/member-1', { method: 'PUT', token: 'admin-token', body: { roles: ['admin'] } });
    assert.equal(legacy.status, 400);
  } finally { await h.close(); }
});

test('private product dataset metadata and raw mutations cannot bypass an app grant', async () => {
  const h = await startHarness();
  try {
    for (const id of ['city-incidents', 'sos-dispatch-orders']) {
      const result = await api(h, '/v1/capabilities/datasets', { method: 'POST', token: 'admin-token', body: { slug: id, name: id, entityType: 'Record', license: 'LicenseRef-Proprietary', public: false } });
      assert.equal(result.status, 201, JSON.stringify(result.body));
    }
    await grant(h, 'user-1', { city: ['manager'] });
    const list = await api(h, '/v1/capabilities/datasets?limit=1', { token: 'user-token' });
    assert.deepEqual(list.body.map((row: any) => row.id), ['city-incidents']);
    assert.equal(list.headers.get('x-total-count'), '1');
    assert.equal((await api(h, '/v1/capabilities/datasets/sos-dispatch-orders', { token: 'user-token' })).status, 404);
    assert.equal((await api(h, '/v1/capabilities/datasets/city-incidents/records', { method: 'POST', token: 'user-token', body: { data: { title: 'bypass' } } })).status, 403);
    assert.equal((await api(h, '/v1/capabilities/datasets/sos-dispatch-orders/contract', { token: 'user-token' })).status, 404);
    assert.equal((await api(h, '/v1/capabilities/datasets', { method: 'POST', token: 'user-token', body: { slug: 'sos-hidden', name: 'bypass' } })).status, 403);
  } finally { await h.close(); }
});

test('Common CRUD authority never broadens a plain member into private product-data reader', async()=>{
 const h=await startHarness();
 try {
  const dataset=await api(h,'/v1/capabilities/datasets',{method:'POST',token:'admin-token',body:{slug:'city-budgets',name:'Private budgets',entityType:'Budget',license:'LicenseRef-Proprietary',public:false}});
  assert.equal(dataset.status,201);
  await grant(h,'member-1',{city:['volunteer']});
  const report=await api(h,'/v1/capabilities/reports',{method:'POST',token:'member-token',headers:{'X-Workspace-App':'city'},body:{name:'Attempted budget report',datasetId:'city-budgets',kind:'table',query:{}}});
  assert.equal(report.status,201,JSON.stringify(report.body));
  const run=await api(h,`/v1/capabilities/reports/${report.body.report.id}/run`,{method:'POST',token:'member-token',headers:{'X-Workspace-App':'city'},body:{}});
  assert.equal(run.status,404,'App-scoped write was used as source dataset read authority');
  assert.equal((await api(h,'/v1/capabilities/datasets/city-budgets/records',{token:'member-token',headers:{'X-Workspace-App':'city'}})).status,404);
 }finally{await h.close();}
});
