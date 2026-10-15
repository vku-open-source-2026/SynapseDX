/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// Guard against API-catalog drift: the Console try-it catalog
// (apps/console/src/lib/endpoints.js), the AI agent catalog
// (apps/ai-service/src/catalog.ts) and the reference (docs/api.md)
// must describe the same endpoints. Run: node tools/catalog-check.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function jsEntries(path) {
  const src = readFileSync(join(root, path), 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/method:\s*'([^']+)'\s*,\s*path:\s*'([^']+)'/g)) {
    out.add(`${m[1]} ${m[2].split('?')[0]}`);
  }
  return out;
}

let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`catalog-check: ${msg}`);
};

const endpoints = jsEntries('apps/console/src/lib/endpoints.js');
const agentCatalog = jsEntries('apps/ai-service/src/catalog.ts');

for (const e of endpoints) {
  if (!agentCatalog.has(e)) fail(`in endpoints.js but missing from ai catalog.ts: ${e}`);
}
for (const e of agentCatalog) {
  if (!endpoints.has(e)) fail(`in ai catalog.ts but missing from endpoints.js: ${e}`);
}

// Every catalogued endpoint must be documented (query strings aside).
const apiMd = readFileSync(join(root, 'docs/api.md'), 'utf8');
for (const e of new Set([...endpoints, ...agentCatalog])) {
  const [, path] = e.split(' ');
  const bare = path.replace(/:[A-Za-z0-9_]+/g, ':param');
  const documented =
    apiMd.includes(path) ||
    [...apiMd.matchAll(/`(GET|POST|PUT|DELETE)?\s*(\/v1\/\S*?)(?:\s|\{|`)/g)].some(
      (m) => m[2].replace(/:[A-Za-z0-9_]+/g, ':param') === bare,
    );
  if (!documented) fail(`catalogued but undocumented in docs/api.md: ${e}`);
}

if (failed) process.exit(1);
console.log(`catalog-check: OK (${endpoints.size} endpoints in sync, all documented)`);
