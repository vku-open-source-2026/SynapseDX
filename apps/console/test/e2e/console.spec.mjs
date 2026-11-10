// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { test, expect } from '@playwright/test';

const SESSION_KEY = 'synapsedx.console.session.v1';
const ALL = [
  'summary:read', 'datasets:read', 'records:read', 'datasets:write', 'datasets:delete',
  'records:write', 'events:read', 'events:flush', 'audit:read', 'moderation:read',
  'moderation:write', 'usage:read', 'settings:read', 'users:read', 'settings:write',
  'approvals:read', 'approvals:write',
];

const contexts = {
  admin: { user: { id: 'admin-1', email: 'admin@example.com' }, tenant: 'org:demo', roles: ['admin'], permissions: ALL, auth: { kind: 'jwt', scopes: ['*'] } },
  operator: {
    user: { id: 'op-1', email: 'operator@example.com' }, tenant: 'org:demo', roles: ['operator', 'manager'],
    permissions: ['summary:read', 'datasets:read', 'records:read', 'datasets:write', 'datasets:delete', 'records:write', 'events:read', 'events:flush', 'audit:read', 'approvals:read', 'approvals:write'],
    auth: { kind: 'jwt', scopes: ['write'] },
  },
  moderator: {
    user: { id: 'mod-1', email: 'moderator@example.com' }, tenant: 'org:demo', roles: ['moderator', 'manager'],
    permissions: ['summary:read', 'datasets:read', 'records:read', 'moderation:read', 'moderation:write', 'events:read', 'audit:read', 'usage:read', 'settings:read', 'approvals:read', 'approvals:write'],
    auth: { kind: 'jwt', scopes: ['synapsedx:moderator', 'read'] },
  },
  manager: {
    user: { id: 'mgr-1', email: 'manager@example.com' }, tenant: 'org:demo', roles: ['manager'],
    permissions: ['summary:read', 'datasets:read', 'records:read', 'events:read', 'audit:read', 'usage:read', 'settings:read', 'approvals:read', 'approvals:write'],
    auth: { kind: 'jwt', scopes: ['read'] },
  },
};

const datasets = [
  { id: 'city-assets', name: 'City assets', slug: 'city-assets', entityType: 'CityAsset', license: 'PDDL-1.0', status: 'draft', public: true, reviewStatus: 'pending', updatedAt: '2026-11-04T10:00:00Z' },
  { id: 'city-incidents', name: 'City incidents', slug: 'city-incidents', entityType: 'CityIncident', license: 'PDDL-1.0', status: 'published', public: true, reviewStatus: 'approved', updatedAt: '2026-11-04T11:00:00Z' },
  { id: 'sos-events', name: 'SOS events', slug: 'sos-events', entityType: 'EmergencyEvent', license: 'CC-BY-4.0', status: 'revoked', public: false, reviewStatus: 'none', updatedAt: '2026-11-04T12:00:00Z' },
];

async function mockApi(page, context) {
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', dependencies: [] } }));
  await page.route('**/v1/capabilities/management/context', (route) => route.fulfill({ json: context }));
  let requireReview = false;
  await page.route('**/v1/capabilities/approvals**', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 201, json: { approval: { id: 'approval-1', status: 'pending' } } });
    }
    return route.fulfill({
      json: {
        items: [{ id: 'approval-1', title: 'Approve dispatch', module: 'sos.dispatch', action: 'dispatch.assign', requester: 'operator@example.com', requiredApprovals: 1, status: 'pending', decisions: [], createdAt: '2026-11-04T11:00:00Z', dueAt: '2026-11-05T11:00:00Z' }],
        total: 1,
      },
    });
  });
  await page.route('**/v1/capabilities/management/team**', (route) => {
    if (route.request().method() === 'POST') return route.fulfill({ json: { ok: true } });
    return route.fulfill({
      json: {
        org: 'org-a', account: 'acct-a',
        accounts: [{ id: 'acct-a', slug: 'prod', displayName: 'Prod' }],
        members: [
          { id: 'user-1', email: 'admin@example.com', displayName: 'Admin', roles: [{ id: 'role-admin', slug: 'admin' }] },
          { id: 'user-2', email: 'operator@example.com', displayName: 'Operator', roles: [] },
        ],
        roles: [{ id: 'role-admin', slug: 'admin' }, { id: 'role-operator', slug: 'operator' }],
        policies: [{ id: 'policy-1', name: 'read-only' }],
      },
    });
  });
  await page.route('**/v1/capabilities/management/settings', (route) => {
    if (route.request().method() === 'PATCH') requireReview = true;
    return route.fulfill({ json: { settings: { requireReview } } });
  });
  await page.route('**/v1/capabilities/management/summary', (route) => route.fulfill({
    json: {
      generatedAt: '2026-11-04T12:00:00Z',
      datasets: { total: 3, draft: 1, published: 1, revoked: 1, pendingReview: 1 },
      pendingEvents: 2,
      recentAudit: [{ id: 'a1', at: '2026-11-04T11:00:00Z', actor: 'operator@example.com', action: 'dataset.review.submit', datasetId: 'city-assets' }],
      roles: context.roles,
      permissions: context.permissions,
    },
  }));
  await page.route('**/v1/capabilities/management/review-queue**', (route) => route.fulfill({
    json: { items: datasets.filter((dataset) => dataset.reviewStatus === 'pending'), total: 1 },
  }));
  await page.route('**/v1/capabilities/datasets**', (route) => {
    const method = route.request().method();
    if (method === 'GET' && route.request().url().includes('limit=6')) {
      return route.fulfill({ json: datasets.filter((dataset) => dataset.status === 'published') });
    }
    if (method === 'GET') return route.fulfill({ json: datasets });
    return route.fulfill({ status: 201, json: { id: 'new-dataset' } });
  });
  await page.route('**/v1/capabilities/datasets/*/records**', (route) => route.fulfill({
    json: { items: [{ id: 'r1', data: { name: 'Asset A' }, version: 1, published: true, updatedAt: '2026-11-04T11:00:00Z' }], total: 1 },
  }));
  await page.route('**/v1/capabilities/events?**', (route) => route.fulfill({
    json: { items: [{ id: 'e1', event: { type: 'dataset.published', datasetId: 'city-incidents', at: '2026-11-04T11:00:00Z', correlationId: 'c1' } }], nextCursor: 'c1' },
  }));
  await page.route('**/v1/capabilities/audit?**', (route) => route.fulfill({
    json: { items: [{ id: 'a1', at: '2026-11-04T11:00:00Z', actor: 'operator@example.com', action: 'dataset.review.submit', datasetId: 'city-assets' }], total: 1 },
  }));
  await page.route('**/v1/capabilities/usage', (route) => route.fulfill({ json: { totals: { requests: 10, errors: 1 }, window: '24h' } }));
  await page.route('**/v1/capabilities/inbox', (route) => route.fulfill({ json: { items: [], total: 0, unread: 0 } }));
  await page.route('**/v1/capabilities/notification-preferences', (route) => route.fulfill({
    json: { preferences: { subject: 'admin-1', channels: ['inbox'], muted: false, digest: 'instant' } },
  }));
  await page.route('**/v1/capabilities/workspaces', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/v1/capabilities/workspaces/*/pages', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/v1/capabilities/people', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/v1/capabilities/kpis', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/v1/capabilities/projects', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/v1/capabilities/project-capacity', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/v1/capabilities/forms', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/v1/capabilities/processes', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/v1/capabilities/process-instances', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/v1/capabilities/reports', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/v1/capabilities/dashboards', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/v1/capabilities/datasets?limit=1', (route) => route.fulfill({ json: datasets.slice(0, 1) }));
  await page.route('**/v1/capabilities/ocr/jobs', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/v1/capabilities/agents', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/v1/capabilities/agent-runs', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/v1/capabilities/rag/usage', (route) => route.fulfill({ json: { queries: 0, tokens: 0, costUsd: 0, noAnswer: 0 } }));
}

async function openAs(page, role, path = '/admin') {
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify({ accessToken: 'playwright-token', refreshToken: '', obtainedAt: new Date().toISOString() }));
    void value;
  }, { key: SESSION_KEY, value: role });
  await mockApi(page, contexts[role]);
  await page.goto(path);
  await expect(page.locator('#page-title')).toBeVisible();
}

test('public visitor sees the catalog but no management navigation', async ({ page }) => {
  await mockApi(page, { roles: [], permissions: [], user: { id: 'anon' }, tenant: 'public', auth: { kind: 'none', scopes: [] } });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'One contract for every domain product.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
  await expect(page.locator('[data-nav]')).toHaveCount(0);
});

test('manager is read-only and cannot open moderation or create datasets', async ({ page }) => {
  await openAs(page, 'manager');
  await expect(page.locator('.role-badge')).toHaveText('Manager');
  await expect(page.locator('[data-nav="records"]')).toBeVisible();
  await expect(page.locator('[data-nav="audit"]')).toBeVisible();
  await expect(page.locator('[data-nav="moderation"]')).toHaveCount(0);
  await page.click('[data-nav="datasets"]');
  await expect(page.locator('[data-nav="datasets"]')).toBeVisible();
  await expect(page.locator('[data-action="new-dataset"]')).toHaveCount(0);
  await expect(page.locator('[data-action="edit-dataset"]')).toHaveCount(0);
  await expect(page.locator('[data-action="publish-dataset"]')).toHaveCount(0);
});

test('operator can mutate datasets and records but cannot moderate', async ({ page }) => {
  await openAs(page, 'operator');
  await expect(page.locator('.role-badge')).toHaveText('Operator');
  await expect(page.locator('[data-nav="moderation"]')).toHaveCount(0);
  await page.click('[data-nav="datasets"]');
  await expect(page.locator('[data-action="new-dataset"]')).toBeVisible();
  await expect(page.locator('[data-action="edit-dataset"]')).toHaveCount(3);
  await expect(page.locator('[data-action="publish-dataset"]')).toHaveCount(2);
  await expect(page.locator('[data-action="delete-dataset"]')).toHaveCount(3);
  await expect(page.locator('[data-nav="settings"]')).toHaveCount(0);
});

test('moderator can review but cannot edit or publish datasets', async ({ page }) => {
  await openAs(page, 'moderator');
  await expect(page.locator('.role-badge')).toHaveText('Moderator');
  await expect(page.locator('[data-nav="moderation"]')).toBeVisible();
  await page.click('[data-nav="datasets"]');
  await expect(page.locator('[data-action="new-dataset"]')).toHaveCount(0);
  await expect(page.locator('[data-action="edit-dataset"]')).toHaveCount(0);
  await page.click('[data-nav="moderation"]');
  await expect(page.locator('[data-action="approve-review"]')).toHaveCount(1);
  await expect(page.locator('[data-action="reject-review"]')).toHaveCount(1);
  await page.check('[data-review-select="city-assets"]');
  await expect(page.locator('[data-action="bulk-review"][data-id="approve"]')).toBeEnabled();
  await expect(page.locator('[data-action="bulk-review"][data-id="reject"]')).toBeEnabled();
});

test('administrator sees every management lane and action', async ({ page }) => {
  await openAs(page, 'admin');
  await expect(page.locator('.role-badge')).toHaveText('Administrator');
  for (const view of ['datasets', 'records', 'moderation', 'approvals', 'modules', 'team', 'events', 'audit', 'settings']) {
    await expect(page.locator(`[data-nav="${view}"]`)).toBeVisible();
  }
  await page.click('[data-nav="datasets"]');
  await expect(page.locator('[data-action="new-dataset"]')).toBeVisible();
  await expect(page.locator('[data-action="publish-dataset"]')).toHaveCount(2);
  await expect(page.locator('[data-action="revoke-dataset"]')).toHaveCount(1);
  await page.click('[data-nav="approvals"]');
  await expect(page.locator('[data-action="approval-approve"]')).toHaveCount(1);
  await page.click('[data-nav="team"]');
  await expect(page.locator('[data-action="assign-role"]')).toHaveCount(2);
  await expect(page.getByText('read-only')).toBeVisible();
});

test('administrator can change the publication review policy', async ({ page }) => {
  await openAs(page, 'admin', '/admin/settings');
  const toggle = page.locator('#require-review');
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.click('[data-action="save-settings"]');
  await expect(page.getByText('Publication policy saved.')).toBeVisible();
  await expect(page.getByText('Review required')).toBeVisible();
});

test('login form exchanges credentials and opens the administrator overview', async ({ page }) => {
  await page.route('**/v1/capabilities/auth/login', (route) => route.fulfill({
    status: 200,
    json: { accessToken: 'playwright-token', refreshToken: 'refresh' },
  }));
  await mockApi(page, contexts.admin);
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).first().click();
  await expect(page).toHaveURL(/\/login/);
  await page.fill('input[name="email"]', 'admin@example.com');
  await page.fill('input[name="password"]', 'secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.role-badge')).toHaveText('Administrator');
  await expect(page.getByRole('heading', { name: 'Govern the capability layer with evidence.' })).toBeVisible();
});

test('business modules expose every H/P/D/I lane with empty states', async ({ page }) => {
  await openAs(page, 'admin', '/admin/modules');
  await expect(page.locator('[data-action="module-tab"]')).toHaveCount(10);
  for (const lane of ['inbox', 'workspace', 'people', 'projects', 'forms', 'reports', 'quality', 'ocr', 'agents', 'assistant']) {
    await expect(page.locator(`[data-action="module-tab"][data-id="${lane}"]`)).toBeVisible();
  }
  await expect(page.getByText('No inbox items yet')).toBeVisible();
  await page.click('[data-action="module-tab"][data-id="assistant"]');
  await expect(page.locator('#rag-form')).toBeVisible();
  await page.click('[data-action="module-tab"][data-id="reports"]');
  await expect(page.getByText('No reports yet')).toBeVisible();
});

test('mobile layout keeps navigation and the catalog usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAs(page, 'admin');
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.click('[data-nav="datasets"]');
  await expect(page.locator('#dataset-search')).toBeVisible();
});

test('OCR lane uploads an image, runs the engine and lists the job', async ({ page }) => {
  await openAs(page, 'admin', '/admin/modules');
  const calls = [];
  const job = {
    id: 'job-1', fileId: 'file-1', status: 'needs_correction', source: 'engine',
    engine: { name: 'tesseract', languages: 'vie+eng', durationMs: 407 },
    fields: [
      { name: 'Họ và tên', value: 'Nguyễn Thị Bình', confidence: 0.97, status: 'auto' },
      { name: 'Số tiền', value: '1.25O.000', confidence: 0.4, status: 'pending' },
    ],
  };
  let created = false;
  await page.route('**/v1/capabilities/files', (route) => {
    calls.push(`POST files ${route.request().postDataJSON().contentType}`);
    return route.fulfill({ status: 201, json: { id: 'file-1', upload: { method: 'PUT', url: '/v1/capabilities/files/file-1/content' } } });
  });
  await page.route('**/v1/capabilities/files/file-1/content', (route) => {
    calls.push(`${route.request().method()} content ${route.request().headers()['content-type']}`);
    return route.fulfill({ json: { id: 'file-1', size: 4 } });
  });
  await page.route('**/v1/capabilities/ocr/jobs', (route) => {
    if (route.request().method() === 'POST') {
      calls.push(`POST ocr ${route.request().postDataJSON().fileId}`);
      created = true;
      return route.fulfill({ status: 201, json: { job } });
    }
    return route.fulfill({ json: { items: created ? [job] : [], total: created ? 1 : 0 } });
  });
  await page.click('[data-action="module-tab"][data-id="ocr"]');
  await expect(page.getByText('No OCR jobs yet')).toBeVisible();
  await page.setInputFiles('#ocr-file', { name: 'phieu.png', mimeType: 'image/png', buffer: Buffer.from('fake') });
  await page.getByRole('button', { name: 'Read image' }).click();
  await expect(page.getByText('OCR read 2 fields; 1 need review.')).toBeVisible();
  await expect(page.getByText('tesseract vie+eng · 407 ms')).toBeVisible();
  await expect(page.getByText('Nguyễn Thị Bình')).toBeVisible();
  expect(calls).toEqual(['POST files image/png', 'PUT content image/png', 'POST ocr file-1']);
});

test('assistant shows whether the answer was written by the LLM and how it was retrieved', async ({ page }) => {
  await openAs(page, 'admin', '/admin/modules');
  await page.route('**/v1/capabilities/rag/query', (route) => route.fulfill({
    json: {
      answer: 'Rào chắn được dựng khi nước sông vượt 4,2 mét [1].', noAnswer: false, confidence: 0.8,
      citations: [{ index: 1, title: 'Quy trình ứng phó' }], generator: 'llm', retrieval: 'local/hash-48', model: 'liquid/lfm-2.5-2.6b:free',
    },
  }));
  await page.click('[data-action="module-tab"][data-id="assistant"]');
  await page.fill('#rag-question', 'Khi nào dựng rào chắn lũ?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.getByTestId('rag-provenance')).toHaveText('Written by liquid/lfm-2.5-2.6b:free from the cited sources · retrieval: keyword + hash');
  await expect(page.getByText('[1] Quy trình ứng phó')).toBeVisible();
});
