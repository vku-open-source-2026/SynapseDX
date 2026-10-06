/*
 * Copyright 2026 danax Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * CLI offline tests — no platform needed (help/version/errors only).
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'danax.js');

function run(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe('danax cli offline', () => {
  it('--version exits 0', async () => {
    const r = await run('--version');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /danax v\d+\.\d+\.\d+/);
  });

  it('help lists commands', async () => {
    const r = await run('help');
    assert.equal(r.code, 0);
    for (const cmd of ['login', 'orgs', 'authz', 'workflows', 'audit', 'keys', 'sa']) {
      assert.ok(r.stdout.includes(cmd), cmd);
    }
  });

  it('unknown command exits 2', async () => {
    const r = await run('nope-nope');
    assert.equal(r.code, 2);
  });

  it('missing arg exits 2', async () => {
    const r = await run('attach', 'only-one');
    assert.equal(r.code, 2);
  });

  it('unreachable base exits 1 with danax error', async () => {
    const r = await run('--base', 'http://127.0.0.1:1', 'orgs');
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /network|HTTP/);
  });
});
