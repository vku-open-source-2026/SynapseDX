/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * CLI offline tests — no platform needed (help/version/errors only).
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'synapsedx.js');

function run(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// Stub "gateway": records the last request, answers canned JSON.
let last = {};
let stubBase = '';
let stub;
before(
  () =>
    new Promise((resolve) => {
      stub = http
        .createServer((req, res) => {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            last = { method: req.method, path: req.url, body: body ? JSON.parse(body) : null };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
          });
        })
        .listen(0, '127.0.0.1', () => {
          stubBase = `http://127.0.0.1:${stub.address().port}`;
          resolve();
        });
    }),
);
after(() => new Promise((resolve) => stub.close(() => resolve())));

describe('synapsedx cli offline', () => {
  it('--version exits 0', async () => {
    const r = await run('--version');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /synapsedx v\d+\.\d+\.\d+/);
  });

  it('help lists commands', async () => {
    const r = await run('help');
    assert.equal(r.code, 0);
    for (const cmd of ['login', 'refresh', 'logout-all', 'verify', 'orgs', 'users', 'authz', 'workflows', 'executions', 'templates', 'audit', 'keys', 'sa', 'credentials', 'call', 'webhook', 'lds']) {
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

  it('workflows create without template/file explains usage', async () => {
    const r = await run('workflows', 'create');
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /--template|--file/);
  });

  it('workflows create --file posts definition body', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 'def.json');
    fs.writeFileSync(f, JSON.stringify({ nodes: [], connections: {} }));
    const r = await run('--base', stubBase, 'workflows', 'create', '--file', f, '--name', 'w1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/workflows');
    assert.equal(last.body.name, 'w1');
    assert.deepEqual(last.body.definition, { nodes: [], connections: {} });
  });

  it('workflows update PUTs name/definition', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 'def.json');
    fs.writeFileSync(f, JSON.stringify({ nodes: [{ type: 'x' }], connections: {} }));
    const r = await run('--base', stubBase, 'workflows', 'update', 'w1', '--name', 'w2', '--file', f);
    assert.equal(r.code, 0);
    assert.equal(last.method, 'PUT');
    assert.equal(last.path, '/v1/workflows/w1');
    assert.equal(last.body.name, 'w2');
    assert.deepEqual(last.body.definition, { nodes: [{ type: 'x' }], connections: {} });
  });

  it('workflows update without flags explains usage', async () => {
    const r = await run('workflows', 'update', 'w1');
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /--name|--file/);
  });

  it('workflows delete hits the workflow path', async () => {
    const r = await run('--base', stubBase, 'workflows', 'delete', 'w1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'DELETE');
    assert.equal(last.path, '/v1/workflows/w1');
  });

  it('detach/assign/unassign hit the right paths', async () => {
    let r = await run('--base', stubBase, 'detach', 'r1', 'p1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'DELETE');
    assert.equal(last.path, '/v1/roles/r1/policies/p1');
    r = await run('--base', stubBase, 'assign', 'u1', 'r1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/users/u1/assign');
    r = await run('--base', stubBase, 'unassign', 'u1', 'r1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'DELETE');
    assert.equal(last.path, '/v1/users/u1/roles/r1');
  });

  it('keys list hits the account keys path', async () => {
    const r = await run('--base', stubBase, 'keys', 'list', 'a1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/accounts/a1/keys');
  });

  it('users create + policies hit encoded paths', async () => {
    const r = await run('--base', stubBase, 'users', 'create', 'org1', 'a@b.c', 'A');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/orgs/org1/users');
    assert.equal(last.body.email, 'a@b.c');
    const r2 = await run('--base', stubBase, 'users', 'policies', 'u 1');
    assert.equal(r2.code, 0);
    assert.equal(last.path, '/v1/users/u%201/policies');
  });

  it('workflows test-run posts definition+input', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 'def.json');
    fs.writeFileSync(f, JSON.stringify({ nodes: [], connections: {} }));
    const r = await run('--base', stubBase, 'workflows', 'test-run', '--file', f, '--input', '{"value":21}');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/workflows/test-run');
    assert.deepEqual(last.body, { definition: { nodes: [], connections: {} }, input: { value: 21 } });
  });

  it('workflows test-run without --file explains usage', async () => {
    const r = await run('workflows', 'test-run');
    assert.equal(r.code, 2);
    assert.match(r.stderr + r.stdout, /--file/);
  });

  it('workflows exec passes --data payload through', async () => {
    const r = await run('--base', stubBase, 'workflows', 'exec', 'w1', '--data', '{"value":21}');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/workflows/w1/execute');
    assert.deepEqual(last.body, { value: 21 });
  });

  it('workflows exec reads payload from --file', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 'in.json');
    fs.writeFileSync(f, JSON.stringify({ value: 42 }));
    const r = await run('--base', stubBase, 'workflows', 'exec', 'w1', '--file', f);
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/workflows/w1/execute');
    assert.deepEqual(last.body, { value: 42 });
  });

  it('executions list builds the allowlisted query', async () => {
    const r = await run('--base', stubBase, 'executions', 'list', '--limit', '20', '--offset', '20', '--workflow-id', 'w1', '--status', 'success', '--include-data');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.ok(last.path.startsWith('/v1/executions?'), last.path);
    for (const q of ['limit=20', 'offset=20', 'workflowId=w1', 'status=success', 'includeData=true']) {
      assert.ok(last.path.includes(q), `${q} in ${last.path}`);
    }
  });

  it('executions <id> supports --include-data', async () => {
    const r = await run('--base', stubBase, 'executions', 'e1', '--include-data');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/executions/e1?includeData=true');
  });

  it('webhook posts to /webhook/:path', async () => {
    const r = await run('--base', stubBase, 'webhook', 'transform', '--data', '{"value":21}');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/webhook/transform');
    assert.deepEqual(last.body, { value: 21 });
  });

  it('help mentions test-run and webhook', async () => {
    const r = await run('help');
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('test-run'), 'test-run in help');
    assert.ok(r.stdout.includes('webhook'), 'webhook in help');
  });

  it('credentials create posts name/type/secret', async () => {
    const r = await run('--base', stubBase, 'credentials', 'create', 'a1', '--name', 'stripe-live', '--type', 'bearer', '--secret', 's3cr3t');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/accounts/a1/credentials');
    assert.deepEqual(last.body, { name: 'stripe-live', type: 'bearer', secret: 's3cr3t' });
  });

  it('credentials create reads secret from file and rejects bad type', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 'sec.txt');
    fs.writeFileSync(f, 'file-secret\n');
    const r = await run('--base', stubBase, 'credentials', 'create', 'a1', '--name', 'x', '--secret-file', f);
    assert.equal(r.code, 0);
    assert.equal(last.body.secret, 'file-secret');
    assert.equal(last.body.type, 'bearer');
    const bad = await run('--base', stubBase, 'credentials', 'create', 'a1', '--name', 'x', '--type', 'nope', '--secret', 's');
    assert.equal(bad.code, 1);
    assert.match(bad.stderr + bad.stdout, /--type/);
  });

  it('credentials list/get/delete/rotate hit the right paths', async () => {
    let r = await run('--base', stubBase, 'credentials', 'list', 'a1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/accounts/a1/credentials');
    r = await run('--base', stubBase, 'credentials', 'get', 'c1');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/credentials/c1');
    r = await run('--base', stubBase, 'credentials', 'rotate', 'c1', '--secret', 'n3w');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/credentials/c1/rotate');
    assert.deepEqual(last.body, { secret: 'n3w' });
    r = await run('--base', stubBase, 'credentials', 'delete', 'c1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'DELETE');
    assert.equal(last.path, '/v1/credentials/c1');
  });

  it('call passes method/path/body through', async () => {
    const r = await run('--base', stubBase, 'call', 'POST', '/v1/accounts/a1/credentials', '--data', '{"name":"x"}');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/accounts/a1/credentials');
    assert.deepEqual(last.body, { name: 'x' });
    const bad = await run('--base', stubBase, 'call', 'FETCH', '/v1/x');
    assert.equal(bad.code, 1);
  });

  it('help mentions credentials and call', async () => {
    const r = await run('help');
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('credentials'), 'credentials in help');
    assert.ok(r.stdout.includes('call'), 'call in help');
  });

  it('unreachable base exits 1 with synapsedx error', async () => {
    const r = await run('--base', 'http://127.0.0.1:1', 'orgs');
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /network|HTTP/);
  });
});
