// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { test, expect } from '@playwright/test';

const SESSION_KEY = 'synapsedx.console.session.v1';
const ALL = [
  'summary:read', 'datasets:read', 'records:read', 'datasets:write', 'datasets:delete',
  'records:write', 'events:read', 'events:flush', 'audit:read', 'moderation:read',
  'moderation:write', 'usage:read', 'settings:read', 'users:read', 'settings:write',
];

const contexts = {
  admin: { user: { id: 'admin-1', email: 'admin@example.com' }, tenant: 'org:demo', roles: ['admin'], permissions: ALL, auth: { kind: 'jwt', scopes: ['*'] } },
  operator: {
    user: { id: 'op-1', email: 'operator@example.com' }, tenant: 'org:demo', roles: ['operator', 'manager'],
    permissions: ['summary:read', 'datasets:read', 'records:read', 'datasets:write', 'datasets:delete', 'records:write', 'events:read', 'events:flush', 'audit:read'],
    auth: { kind: 'jwt', scopes: ['write'] },
  },
  moderator: {
    user: { id: 'mod-1', email: 'moderator@example.com' }, tenant: 'org:demo', roles: ['moderator', 'manager'],
    permissions: ['summary:read', 'datasets:read', 'records:read', 'moderation:read', 'moderation:write', 'events:read', 'audit:read', 'usage:read', 'settings:read'],
    auth: { kind: 'jwt', scopes: ['synapsedx:moderator', 'read'] },
  },
  manager: {
    user: { id: 'mgr-1', email: 'manager@example.com' }, tenant: 'org:demo', roles: ['manager'],
    permissions: ['summary:read', 'datasets:read', 'records:read', 'events:read', 'audit:read', 'usage:read', 'settings:read'],
    auth: { kind: 'jwt', scopes: ['read'] },
  },
};

const datasets = [
  { id: 'city-assets', name: 'City assets', entityType: 'CityAsset', license: 'PDDL-1.0', status: 'draft', public: true, reviewStatus: 'pending', updatedAt: '2026-11-04T10:00:00Z' },
  { id: 'city-incidents', name: 'City incidents', entityType: 'CityIncident', license: 'PDDL-1.0', status: 'published', public: true, reviewStatus: 'approved', updatedAt: '2026-11-04T11:00:00Z' },
  { id: 'sos-events', name: 'SOS events', entityType: 'EmergencyEvent', license: 'CC-BY-4.0', status: 'revoked', public: false, reviewStatus: 'none', updatedAt: '2026-11-04T12:00:00Z' },
];

async function mockApi(page, context) {
  await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', dependencies: [] } }));
  await page.route('**/v1/capabilities/management/context', (route) => route.fulfill({ json: context }));
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
  await page.route('**/v1/capabilities/management/review-queue**', (route) => route.fulfill({ json: { items: datasets.filter((d) => d.reviewStatus === 'pending'), total: 1 } }));
  await page.route('**/v1/capabilities/datasets?limit=200', (route) => route.fulfill({ json: datasets }));
  await page.route('**/v1/capabilities/datasets?limit=6', (route) => route.fulfill({ json: datasets.filter((d) => d.status === 'published') }));
  await page.route('**/v1/capabilities/datasets/*/records?**', (route) => route.fulfill({
    json: { items: [{ id: 'r1', data: { name: 'Asset A' }, version: 1, published: true, updatedAt: '2026-11-04T11:00:00Z' }], total: 1 },
  }));
  await page.route('**/v1/capabilities/events?limit=100', (route) => route.fulfill({
    json: { items: [{ id: 'e1', event: { type: 'dataset.published', datasetId: 'city-incidents', at: '2026-11-04T11:00:00Z', correlationId: 'c1' } }], nextCursor: 'c1' },
  }));
  await page.route('**/v1/capabilities/audit?**', (route) => route.fulfill({
    json: { items: [{ id: 'a1', at: '2026-11-04T11:00:00Z', actor: 'operator@example.com', action: 'dataset.review.submit', datasetId: 'city-assets' }], total: 1 },
  }));
  await page.route('**/v1/capabilities/usage', (route) => route.fulfill({ json: { totals: { requests: 10, errors: 1 }, window: '24h' } }));
}

async function openAs(page, role, hash = '#overview') {
  await page.addInitScript(({ key, value }) => {
    sessionStorage.setItem(key, JSON.stringify({ accessToken: 'playwright-token', refreshToken: '', obtainedAt: new Date().toISOString() }));
    void value;
  }, { key: SESSION_KEY, value: role });
  await mockApi(page, contexts[role]);
  await page.goto(`/${hash}`);
  await expect(page.locator('#page-title')).toBeVisible();
}

test('public visitor sees the catalog but no management navigation', async ({ page }) => {
  await mockApi(page, { roles: [], permissions: [], user: { id: 'anon' }, tenant: 'public', auth: { kind: 'none', scopes: [] } });
  await page.goto('/');
  await expect(page.getByText('One contract for every domain product.')).toBeVisible();
  await expect(page.locator('#session-box [data-action="login"]')).toBeVisible();
  await expect(page.locator('[data-nav="records"]')).toHaveCount(0);
  await expect(page.locator('[data-nav="moderation"]')).toHaveCount(0);
});

test('manager is read-only and cannot open moderation or create datasets', async ({ page }) => {
  await openAs(page, 'manager');
  await expect(page.locator('.role-badge')).toHaveText('Manager');
  await expect(page.locator('[data-nav="records"]')).toBeVisible();
  await expect(page.locator('[data-nav="audit"]')).toBeVisible();
  await expect(page.locator('[data-nav="moderation"]')).toHaveCount(0);
  await page.click('[data-nav="datasets"]');
  await expect(page.locator('#dataset-table tbody tr')).toHaveCount(3);
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
});

test('administrator sees every management lane and action', async ({ page }) => {
  await openAs(page, 'admin');
  await expect(page.locator('.role-badge')).toHaveText('Administrator');
  for (const view of ['datasets', 'records', 'moderation', 'events', 'audit', 'settings']) {
    await expect(page.locator(`[data-nav="${view}"]`)).toBeVisible();
  }
  await page.click('[data-nav="datasets"]');
  await expect(page.locator('[data-action="new-dataset"]')).toBeVisible();
  await expect(page.locator('[data-action="publish-dataset"]')).toHaveCount(2);
  await expect(page.locator('[data-action="revoke-dataset"]')).toHaveCount(1);
});

test('login form exchanges credentials and opens the administrator overview', async ({ page }) => {
  await page.route('**/v1/capabilities/auth/login', (route) => route.fulfill({ json: { accessToken: 'playwright-token', refreshToken: 'refresh' } }));
  await mockApi(page, contexts.admin);
  await page.goto('/');
  await page.click('[data-action="login"]');
  await page.fill('input[name="email"]', 'admin@example.com');
  await page.fill('input[name="password"]', 'secret');
  await page.click('#modal-form button[type="submit"]');
  await expect(page.locator('.role-badge')).toHaveText('Administrator');
  await expect(page.getByText('Govern the capability layer with evidence.')).toBeVisible();
});

test('mobile layout keeps navigation and the overview usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAs(page, 'admin');
  await expect(page.locator('#primary-nav')).toBeVisible();
  await expect(page.locator('.metric-card').first()).toBeVisible();
  await page.click('[data-nav="datasets"]');
  await expect(page.locator('#dataset-search')).toBeVisible();
});
