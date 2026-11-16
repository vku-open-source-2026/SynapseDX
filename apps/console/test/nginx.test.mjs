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

test('console nginx keeps the capability event stream unbuffered', () => {
  const stream = config.match(/location = \/v1\/capabilities\/events\/stream \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(stream);
  assert.match(stream, /proxy_buffering off;/);
  assert.match(stream, /proxy_read_timeout 35m;/);
  assert.match(stream, /Last-Event-ID \$http_last_event_id;/);
  assert.match(config, /location \/v1\/[\s\S]*Last-Event-ID \$http_last_event_id;/);
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

test('only the opaque Studio worker document permits evaluated code and denies network and framing children', () => {
  const sandbox = config.match(/location = \/studio-sandbox\.html \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(sandbox);
  assert.match(sandbox,/script-src 'sha256-[A-Za-z0-9+/=]+' 'unsafe-eval'/);
  assert.match(sandbox,/connect-src 'none'/);
  assert.match(sandbox,/worker-src blob:/);
  assert.match(sandbox,/sandbox allow-scripts/);
  assert.match(sandbox,/frame-src 'none'/);
  assert.match(sandbox,/frame-ancestors 'self'/);
  assert.doesNotMatch(sandbox,/allow-same-origin|allow-top-navigation|script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(config.replace(sandbox,''),/unsafe-eval/);
});

test('sandbox bootstrap source matches both its CSP hash and subresource integrity', async () => {
  const {createHash} = await import('node:crypto');
  const hash = createHash('sha256').update(readFileSync(resolve(here,'../public/studio-sandbox.js'))).digest('base64');
  const html=readFileSync(resolve(here,'../public/studio-sandbox.html'),'utf8');
  assert.ok(config.includes(`script-src 'sha256-${hash}'`));
  assert.ok(html.includes(`integrity="sha256-${hash}"`));
});
