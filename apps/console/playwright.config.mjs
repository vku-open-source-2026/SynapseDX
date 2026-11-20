// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { defineConfig, devices } from '@playwright/test';

const PREVIEW_PORT = 4173;
function isPreviewTarget() {
  const base = String(process.env.PLAYWRIGHT_BASE_URL || '').trim().replace(/\/+$/, '');
  return base === '' || base === `http://127.0.0.1:${PREVIEW_PORT}` || base === `http://localhost:${PREVIEW_PORT}`;
}
// Make the target-based skip explicit on preview runs (#87): the two
// CSP/sandbox security checks in test/e2e/workspace-studio.spec.mjs only see
// the real sandbox behaviour behind the production nginx headers.
if (isPreviewTarget()) {
  console.log(
    '[playwright] target is the plain Vite preview: the CSP/sandbox security checks in ' +
    'test/e2e/workspace-studio.spec.mjs will be skipped (they require the production nginx CSP on /studio-sandbox.html)',
  );
}

export default defineConfig({
  testDir: './test/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // CI runners are slower than the production verification host; keep one
  // worker and one retry so a transient navigation/render delay is not a red
  // release gate.
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['line']] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4173',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
