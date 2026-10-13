#!/usr/bin/env node
/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * license-check — zero-dependency copyleft gate + SBOM for npm workspaces.
 * Walks every workspace's node_modules (npm-hoisted aware), reads each
 * package.json `license`, fails on copyleft (GPL/AGPL/CPAL/EUPL/OSL) unless
 * explicitly allow-listed. Emits sbom.json ({name, version, license, path}).
 *
 * Usage: node tools/license-check.cjs [--sbom out.json] [--allow pkg@range,...]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const sbomOut = args.includes('--sbom') ? args[args.indexOf('--sbom') + 1] : null;
const allowIdx = args.indexOf('--allow');
const ALLOW = new Set(
  (allowIdx >= 0 ? args[allowIdx + 1] : '').split(',').map((s) => s.trim()).filter(Boolean),
);

// Strong copyleft + source-available / ethical / non-compete licenses:
// FAIL the gate (incompatible with Apache-2.0 distribution, or not OSI-approved).
// NOTE: this gate only sees the npm tree — Python/Go/images are audited
// separately (see THIRD-PARTY.md). Keep this list in sync with that file.
const FORBIDDEN = [/^GPL/i, /AGPL/i, /CPAL/i, /EUPL/i, /SSPL/i, /RSAL/i, /BUSL/i, /Sustainable Use/i, /Hippocratic/i, /Ethical/i, /Commons Clause/i, /Commons-Clause/i, /Elastic License/i, /PolyForm/i, /Prosperity/i, /NC-/i, /NonCommercial/i];
// Weak/file-level copyleft (LGPL/MPL/EPL/CDDL/OSL): tolerated as runtime
// dependencies, but flagged for a human to review (static linking, patches…).
const REVIEW = [/^LGPL/i, /MPL/i, /EPL/i, /CDDL/i, /OSL/i];

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function licenseOf(pkg) {
  if (!pkg) return 'UNKNOWN';
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ');
  }
  if (Array.isArray(pkg.license)) return pkg.license.join(' OR ');
  return 'UNKNOWN';
}

// Resolve the installed package set by walking node_modules directly
// (npm-hoisted aware, no subprocess needed): root + every workspace's own dir,
// recursing into nested node_modules (dedup conflicts) with a visited-set.
function listPkgs(nm, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(nm, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) {
      let scoped = [];
      try {
        scoped = fs.readdirSync(path.join(nm, e.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of scoped) {
        if (s.isDirectory()) out.push(path.join(nm, e.name, s.name));
      }
    } else {
      out.push(path.join(nm, e.name));
    }
  }
}

function installedDirs() {
  const roots = new Set([path.join(ROOT, 'node_modules')]);
  const ws = readJson(path.join(ROOT, 'package.json'))?.workspaces || [];
  for (const pattern of ws) {
    // workspaces entries are like "apps/*" — expand one level, no glob dep.
    const base = path.join(ROOT, pattern.replace(/\/\*$/, ''));
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      roots.add(path.join(base, e.name, 'node_modules'));
    }
  }
  const dirs = [];
  const visited = new Set();
  const queue = [...roots];
  while (queue.length) {
    const nm = queue.shift();
    if (visited.has(nm)) continue;
    visited.add(nm);
    const before = dirs.length;
    listPkgs(nm, dirs);
    // Recurse into nested node_modules of newly found packages.
    for (let i = before; i < dirs.length; i++) {
      queue.push(path.join(dirs[i], 'node_modules'));
    }
  }
  return dirs;
}

function main() {
  const dirs = installedDirs();
  const seen = new Map(); // key name@version -> {name, version, license, path}
  for (const d of dirs) {
    if (path.resolve(d) === ROOT) continue; // the monorepo root itself (private, Apache-2.0)
    const pkg = readJson(path.join(d, 'package.json'));
    if (!pkg || !pkg.name) continue;
    const key = `${pkg.name}@${pkg.version || '?'}`;
    if (!seen.has(key)) seen.set(key, { name: pkg.name, version: pkg.version || '?', license: licenseOf(pkg), path: path.relative(ROOT, d) });
  }
  const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  const violations = rows.filter(
    (r) => FORBIDDEN.some((re) => re.test(r.license)) && !ALLOW.has(`${r.name}@${r.version}`) && !ALLOW.has(r.name),
  );
  const summary = {};
  for (const r of rows) summary[r.license] = (summary[r.license] || 0) + 1;
  console.log(`license-check: ${rows.length} installed packages (incl. dev)`);
  console.log(JSON.stringify(summary, null, 2));
  if (sbomOut) {
    fs.writeFileSync(sbomOut, JSON.stringify({ generated: new Date().toISOString(), packages: rows }, null, 2));
    console.log(`SBOM written to ${sbomOut}`);
  }
  if (violations.length) {
    console.error('FORBIDDEN licenses found:');
    for (const v of violations) console.error(`  ${v.name}@${v.version}: ${v.license} (${v.path})`);
    process.exit(1);
  }
  const review = rows.filter(
    (r) => REVIEW.some((re) => re.test(r.license)) && !ALLOW.has(`${r.name}@${r.version}`) && !ALLOW.has(r.name),
  );
  if (review.length) {
    console.error(`NOTICE: ${review.length} weak-copyleft packages (allowed, review on upgrade):`);
    for (const u of review) console.error(`  ${u.name}@${u.version}: ${u.license} (${u.path})`);
  }
  const unknown = rows.filter((r) => r.license === 'UNKNOWN');
  if (unknown.length) {
    console.error(`WARNING: ${unknown.length} packages with UNKNOWN license (review manually):`);
    for (const u of unknown.slice(0, 20)) console.error(`  ${u.name}@${u.version} (${u.path})`);
  }
  console.log('license-check: OK (no copyleft)');
}

main();
