// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const config = readFileSync(resolve(here, '../nginx.conf'), 'utf8');

test('nginx.conf uses only nginx comments', () => {
  for (const line of config.split('\n')) {
    assert.equal(/^\s*\/\//.test(line), false, `invalid nginx comment: ${line}`);
  }
  assert.match(config, /^# SPDX-License-Identifier: Apache-2\.0/m);
});

test('console nginx proxies the API and health to the gateway', () => {
  assert.match(config, /location = \/health[\s\S]*proxy_pass \$gateway\/health;/);
  assert.match(config, /location \/v1\/[\s\S]*proxy_pass \$gateway\$request_uri;/);
  assert.match(config, /resolver 127\.0\.0\.11/);
});

test('console nginx sends a strict self-only CSP and permissions policy', () => {
  assert.match(config, /Content-Security-Policy[^;]*default-src 'self'/);
  assert.match(config, /script-src 'self'/);
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(config, /connect-src 'self'/);
  assert.match(config, /Permissions-Policy[^;]*geolocation=\(\)/);
});

test('console nginx falls back to the SPA entrypoint', () => {
  assert.match(config, /try_files \$uri \$uri\/ \/index\.html;/);
});
