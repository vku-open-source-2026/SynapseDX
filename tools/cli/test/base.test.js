/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * synapseone base command tests — stub gateway, no platform needed.
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'synapseone.js');

function run(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function tmpJson(name, value) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-base-')), name);
  fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value));
  return f;
}

let last = {};
let failure = null;
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
            if (failure) {
              res.statusCode = failure.status;
              res.end(JSON.stringify(failure.body));
              failure = null;
              return;
            }
            // Mock responses for base endpoints
            if (req.url === '/v1/base/collections') {
              if (req.method === 'GET') {
                res.end(JSON.stringify([{ id: 'c1', name: 'kb', description: 'Docs', updatedAt: '2026-01-01' }]));
                return;
              }
              if (req.method === 'POST') {
                res.statusCode = 201;
                res.end(JSON.stringify({ id: 'c1', ...last.body }));
                return;
              }
            }
            if (req.url === '/v1/base/collections/kb') {
              if (req.method === 'GET') {
                res.end(JSON.stringify({ id: 'c1', name: 'kb', description: 'Docs' }));
                return;
              }
              if (req.method === 'DELETE') {
                res.end(JSON.stringify({ ok: true }));
                return;
              }
            }
            if (req.url.startsWith('/v1/base/collections/kb/documents')) {
              if (req.method === 'GET') {
                if (req.url.includes('/documents/doc1')) {
                  res.end(JSON.stringify({ id: 'doc1', version: 1, data: { title: 'Doc 1' } }));
                  return;
                }
                res.end(JSON.stringify({ items: [{ id: 'doc1', version: 1, createdAt: 't', updatedAt: 't' }] }));
                return;
              }
              if (req.method === 'POST') {
                res.statusCode = 201;
                res.end(JSON.stringify({ id: last.body.id || 'doc-new', version: 1 }));
                return;
              }
              if (req.method === 'DELETE') {
                res.end(JSON.stringify({ ok: true }));
                return;
              }
            }
            if (req.url === '/v1/base/collections/kb/vector-search') {
              res.end(JSON.stringify({
                items: [
                  { id: 'doc1', similarity: 0.98, distance: 0.02 },
                  { id: 'doc2', similarity: 0.85, distance: 0.15 },
                ],
                total: 2,
                limit: 10,
                metric: 'cosine',
              }));
              return;
            }
            if (req.url === '/v1/base/collections/kb/query') {
              res.end(JSON.stringify({
                items: [{ id: 'doc1', similarity: 0.98, version: 1, createdAt: 't' }],
                total: 1,
              }));
              return;
            }
            if (req.url === '/v1/inference/embeddings') {
              res.end(JSON.stringify({
                data: [{ embedding: [0.1, 0.2, 0.3] }],
              }));
              return;
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: { message: 'not found' } }));
          });
        })
        .listen(0, '127.0.0.1', () => {
          stubBase = `http://127.0.0.1:${stub.address().port}`;
          resolve();
        });
    }),
);

after(() => new Promise((resolve) => stub.close(resolve)));

describe('synapseone base', () => {
  it('base without a subcommand explains usage', async () => {
    const r = await run('--base', stubBase, 'base');
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('usage: synapseone base'));
  });

  it('base collections list fetches collections', async () => {
    const r = await run('--base', stubBase, 'base', 'collections', 'list');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/base/collections');
    assert.ok(r.stdout.includes('kb'));
  });

  it('base collections create sends name, description and mapping', async () => {
    const mapping = { fields: { vec: { path: 'embedding', type: 'vector', dimension: 3 } } };
    const r = await run(
      '--base', stubBase,
      'base', 'collections', 'create', 'kb',
      '--description', 'Knowledge base',
      '--mapping', JSON.stringify(mapping),
    );
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/base/collections');
    assert.deepEqual(last.body, {
      name: 'kb',
      description: 'Knowledge base',
      mapping,
    });
  });

  it('base collections get and delete hit proper endpoints', async () => {
    let r = await run('--base', stubBase, 'base', 'collections', 'get', 'kb');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/base/collections/kb');

    r = await run('--base', stubBase, 'base', 'collections', 'delete', 'kb');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'DELETE');
    assert.equal(last.path, '/v1/base/collections/kb');
  });

  it('base documents list handles limit/offset/as query params', async () => {
    const r = await run('--base', stubBase, 'base', 'documents', 'list', 'kb', '--limit', '5', '--offset', '10', '--as', 'object');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.ok(last.path.includes('/v1/base/collections/kb/documents?'));
    assert.ok(last.path.includes('limit=5'));
    assert.ok(last.path.includes('offset=10'));
    assert.ok(last.path.includes('as=object'));
  });

  it('base documents insert sends body from --data', async () => {
    const doc = { title: 'Hello', embedding: [0.1, 0.2, 0.3] };
    const r = await run('--base', stubBase, 'base', 'documents', 'insert', 'kb', '--id', 'doc1', '--data', JSON.stringify(doc));
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/base/collections/kb/documents');
    assert.deepEqual(last.body, { id: 'doc1', ...doc });
  });

  it('base documents get and delete hit document paths', async () => {
    let r = await run('--base', stubBase, 'base', 'documents', 'get', 'kb', 'doc1', '--as', 'data');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/base/collections/kb/documents/doc1?as=data');

    r = await run('--base', stubBase, 'base', 'documents', 'delete', 'kb', 'doc1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'DELETE');
    assert.equal(last.path, '/v1/base/collections/kb/documents/doc1');
  });

  it('base vector-search executes vector query with raw vector', async () => {
    const r = await run(
      '--base', stubBase,
      'base', 'vector-search', 'kb',
      '--vector', '[0.1, 0.2, 0.3]',
      '--limit', '5',
      '--metric', 'cosine',
      '--where', '{"category":"tech"}',
    );
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/base/collections/kb/vector-search');
    assert.deepEqual(last.body, {
      vector: [0.1, 0.2, 0.3],
      limit: 5,
      metric: 'cosine',
      where: { category: 'tech' },
    });
    assert.ok(r.stdout.includes('doc1'));
    assert.ok(r.stdout.includes('0.98'));
  });

  it('base vector-search auto-embeds text query via inference service', async () => {
    const r = await run(
      '--base', stubBase,
      'base', 'vector-search', 'kb',
      '--query', 'guide to neural search',
      '--limit', '3',
    );
    assert.equal(r.code, 0);
    // Verified it hits vector-search with the embedding returned from /v1/inference/embeddings
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/base/collections/kb/vector-search');
    assert.deepEqual(last.body.vector, [0.1, 0.2, 0.3]);
    assert.equal(last.body.limit, 3);
  });

  it('base query sends query specification', async () => {
    const q = { where: { title: { eq: 'Doc 1' } } };
    const r = await run('--base', stubBase, 'base', 'query', 'kb', '--data', JSON.stringify(q));
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/base/collections/kb/query');
    assert.deepEqual(last.body, q);
  });

  it('help mentions base command', async () => {
    const r = await run('help');
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('base'), 'base mentioned in help');
    assert.ok(r.stdout.includes('vector-search'), 'vector-search mentioned in help');
  });
});
