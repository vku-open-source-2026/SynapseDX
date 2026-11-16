// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { test, expect } from '@playwright/test';

for (const target of ['/admin/workspaces', '/workspace?product=city', '/workspace?product=sos', '/workspace?product=dx&module=tasks']) {
  test(`signed-out direct navigation preserves ${target}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(target);
    await expect(page.locator('input[type="password"]')).toBeVisible();
    const url = new URL(page.url());
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('redirect')).toBe(target);
    expect(errors).toEqual([]);
  });
}
