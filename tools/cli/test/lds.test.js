/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * lds command tests — stub gateway, no platform needed.
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
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-lds-')), name);
  fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value));
  return f;
}

// Stub gateway: records the last request, answers canned LDS payloads, and can
// serve a one-shot error override (set `failure` right before running the CLI).
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
            res.end(JSON.stringify(canned(req.method, String(req.url).split('?')[0])));
          });
        })
        .listen(0, '127.0.0.1', () => {
          stubBase = `http://127.0.0.1:${stub.address().port}`;
          resolve();
        });
    }),
);
after(() => new Promise((resolve) => stub.close(() => resolve())));

function canned(method, p) {
  if (method === 'GET' && p === '/v1/lds/licenses') {
    return [{ id: 'CC-BY-4.0', name: 'Creative Commons Attribution 4.0 International', url: 'https://creativecommons.org/licenses/by/4.0/', openData: true }];
  }
  if (method === 'GET' && p === '/v1/lds/datasources') {
    return [{ id: 'ds_1', slug: 'buildings', name: 'Buildings', entityType: 'Building', license: 'CC-BY-4.0', defaultVisibility: 'internal' }];
  }
  if (method === 'GET' && p === '/v1/lds/datasources/ds_1') {
    return { id: 'ds_1', slug: 'buildings', name: 'Buildings', entityType: 'Building', license: 'CC-BY-4.0', defaultVisibility: 'internal' };
  }
  if (method === 'GET' && p === '/v1/lds/datasources/ds_1/attributes') {
    return [{ name: 'name', ngsiLdType: 'Property', visibility: 'public' }];
  }
  if (method === 'GET' && p === '/v1/lds/datasources/ds_1/entities') {
    return [{ id: 'urn:ngsi-ld:Building:1', type: 'Building', name: { type: 'Property', value: 'HQ' } }];
  }
  if (method === 'GET' && p === '/v1/lds/datasources/ds_1/entities/urn%3Angsi-ld%3ABuilding%3A1') {
    return { id: 'urn:ngsi-ld:Building:1', type: 'Building', '@context': 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld' };
  }
  if (method === 'GET' && p === '/v1/lds/datasources/ds_1/stats') {
    return { id: 'ds_1', slug: 'buildings', records: 3, attributes: { public: 1, restricted: 0, internal: 0 }, lastIngestAt: null };
  }
  return { ok: true };
}

describe('synapseone lds', () => {
  it('lds without a subcommand explains usage', async () => {
    const r = await run('lds');
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /usage/);
  });

  it('lds licenses GETs the catalog and prints a table', async () => {
    const r = await run('--base', stubBase, 'lds', 'licenses');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/lds/licenses');
    assert.match(r.stdout, /^id\tname\topenData$/m);
    assert.ok(r.stdout.includes('CC-BY-4.0'), r.stdout);
  });

  it('lds datasources list maps --org/--account to orgId/accountId query', async () => {
    const r = await run('--base', stubBase, 'lds', 'datasources', 'list', '--org', 'o1', '--account', 'a1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/lds/datasources?orgId=o1&accountId=a1');
    assert.ok(r.stdout.includes('Buildings'), r.stdout);
  });

  it('lds datasources list without filters has no query string', async () => {
    const r = await run('--base', stubBase, 'lds', 'datasources', 'list');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/lds/datasources');
  });

  it('lds datasources create posts the full body', async () => {
    const r = await run(
      '--base', stubBase, 'lds', 'datasources', 'create',
      '--name', 'Air quality', '--entity-type', 'AirQualityObserved', '--license', 'CC-BY-4.0',
      '--slug', 'air-quality', '--context', 'https://example.org/ctx.jsonld',
      '--context-url=https://example.org/ctx2.jsonld', '--contexts', 'https://example.org/ctx3.jsonld',
      '--visibility', 'public', '--description', 'stations',
    );
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/lds/datasources');
    assert.deepEqual(last.body, {
      name: 'Air quality',
      entityType: 'AirQualityObserved',
      license: 'CC-BY-4.0',
      slug: 'air-quality',
      contexts: ['https://example.org/ctx.jsonld', 'https://example.org/ctx2.jsonld', 'https://example.org/ctx3.jsonld'],
      defaultVisibility: 'public',
      description: 'stations',
    });
  });

  it('--context k=v keeps its authz meaning (urls only feed lds contexts)', async () => {
    const r = await run('--base', stubBase, 'lds', 'datasources', 'update', 'ds_1', '--context', 'team=etl');
    assert.equal(r.code, 1); // k=v is not a contexts patch — update still needs a real field
    assert.match(r.stderr + r.stdout, /update needs/);
    const bad = await run('--base', stubBase, 'lds', 'datasources', 'create', '--name', 'x', '--entity-type', 'X', '--license', 'MIT', '--context', 'nope');
    assert.equal(bad.code, 1);
    assert.match(bad.stderr + bad.stdout, /want k=v/);
  });

  it('lds datasources create requires --name/--entity-type/--license', async () => {
    const r = await run('--base', stubBase, 'lds', 'datasources', 'create', '--name', 'x', '--entity-type', 'X');
    assert.equal(r.code, 2);
    assert.match(r.stderr + r.stdout, /license/);
  });

  it('lds datasources create rejects a bad --visibility', async () => {
    const r = await run('--base', stubBase, 'lds', 'datasources', 'create', '--name', 'x', '--entity-type', 'X', '--license', 'MIT', '--visibility', 'nope');
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /--visibility/);
  });

  it('lds datasources get fetches one datasource', async () => {
    const r = await run('--base', stubBase, 'lds', 'datasources', 'get', 'ds_1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/lds/datasources/ds_1');
    assert.match(r.stdout, /entityType: Building/);
  });

  it('lds datasources update PATCHes only supplied fields', async () => {
    const r = await run('--base', stubBase, 'lds', 'datasources', 'update', 'ds_1', '--license', 'MIT', '--name', 'Renamed');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'PATCH');
    assert.equal(last.path, '/v1/lds/datasources/ds_1');
    assert.deepEqual(last.body, { name: 'Renamed', license: 'MIT' });
  });

  it('lds datasources update without flags explains usage', async () => {
    const r = await run('--base', stubBase, 'lds', 'datasources', 'update', 'ds_1');
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /--name|--license/);
  });

  it('lds datasources delete DELETEs the datasource', async () => {
    const r = await run('--base', stubBase, 'lds', 'datasources', 'delete', 'ds_1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'DELETE');
    assert.equal(last.path, '/v1/lds/datasources/ds_1');
  });

  it('lds attributes list GETs the registry', async () => {
    const r = await run('--base', stubBase, 'lds', 'attributes', 'list', 'ds_1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/lds/datasources/ds_1/attributes');
    assert.ok(r.stdout.includes('ngsiLdType'), r.stdout);
  });

  it('lds attributes set PUTs a bare --data array', async () => {
    const r = await run('--base', stubBase, 'lds', 'attributes', 'set', 'ds_1', '--data', '[{"name":"pm25","ngsiLdType":"Property","visibility":"public"}]');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'PUT');
    assert.equal(last.path, '/v1/lds/datasources/ds_1/attributes');
    assert.deepEqual(last.body, { attributes: [{ name: 'pm25', ngsiLdType: 'Property', visibility: 'public' }] });
  });

  it('lds attributes set reads --file and accepts the {attributes:[...]} envelope', async () => {
    const f = tmpJson('attrs.json', { attributes: [{ name: 'pm10' }] });
    const r = await run('--base', stubBase, 'lds', 'attributes', 'set', 'ds_1', '--file', f);
    assert.equal(r.code, 0);
    assert.deepEqual(last.body, { attributes: [{ name: 'pm10' }] });
  });

  it('lds attributes set rejects a non-array payload', async () => {
    const r = await run('--base', stubBase, 'lds', 'attributes', 'set', 'ds_1', '--data', '{"nope":true}');
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /attributes/);
  });

  it('lds attributes set without a payload exits 2', async () => {
    const r = await run('lds', 'attributes', 'set', 'ds_1');
    assert.equal(r.code, 2);
    assert.match(r.stderr + r.stdout, /--file|--data/);
  });

  it('lds ingest posts one record from --data', async () => {
    const rec = { id: 'station-42', type: 'AirQualityObserved', pm25: 12 };
    const r = await run('--base', stubBase, 'lds', 'ingest', 'ds_1', '--data', JSON.stringify(rec));
    assert.equal(r.code, 0);
    assert.equal(last.method, 'POST');
    assert.equal(last.path, '/v1/lds/datasources/ds_1/records');
    assert.deepEqual(last.body, rec);
  });

  it('lds ingest reads a record from --file', async () => {
    const rec = { id: 'station-7', type: 'AirQualityObserved', pm10: 3 };
    const f = tmpJson('record.json', rec);
    const r = await run('--base', stubBase, 'lds', 'ingest', 'ds_1', '--file', f);
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/lds/datasources/ds_1/records');
    assert.deepEqual(last.body, rec);
  });

  it('lds entities builds the allowlisted query and prints NGSI-LD JSON', async () => {
    const r = await run('--base', stubBase, 'lds', 'entities', 'ds_1', '--limit', '5', '--offset', '10', '--visibility', 'public');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/lds/datasources/ds_1/entities?limit=5&offset=10&visibility=public');
    const doc = JSON.parse(r.stdout);
    assert.equal(doc[0].id, 'urn:ngsi-ld:Building:1');
  });

  it('lds entities rejects a bad --visibility', async () => {
    const r = await run('--base', stubBase, 'lds', 'entities', 'ds_1', '--visibility', 'internal');
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /public\|restricted/);
  });

  it('lds entity prints one NGSI-LD document as JSON', async () => {
    const r = await run('--base', stubBase, 'lds', 'entity', 'ds_1', 'urn:ngsi-ld:Building:1');
    assert.equal(r.code, 0);
    assert.equal(last.path, '/v1/lds/datasources/ds_1/entities/urn%3Angsi-ld%3ABuilding%3A1');
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.id, 'urn:ngsi-ld:Building:1');
    assert.ok(doc['@context'].includes('ngsi-ld-core-context'));
  });

  it('lds entity requires both ids', async () => {
    const r = await run('lds', 'entity', 'ds_1');
    assert.equal(r.code, 2);
    assert.match(r.stderr + r.stdout, /entity-id/);
  });

  it('lds stats fetches datasource stats', async () => {
    const r = await run('--base', stubBase, 'lds', 'stats', 'ds_1');
    assert.equal(r.code, 0);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, '/v1/lds/datasources/ds_1/stats');
    assert.match(r.stdout, /records: 3/);
  });

  it('lds --json prints raw JSON for datasources list', async () => {
    const r = await run('--base', stubBase, '--json', 'lds', 'datasources', 'list');
    assert.equal(r.code, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].id, 'ds_1');
  });

  it('400 reserved_attribute surfaces a clear error', async () => {
    failure = { status: 400, body: { error: 'reserved_attribute', message: 'reserved attribute name(s) cannot be registered: modifiedAt — map them via sourceField instead', reserved: ['modifiedAt'] } };
    const r = await run('--base', stubBase, 'lds', 'attributes', 'set', 'ds_1', '--data', '[{"name":"modifiedAt"}]');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /reserved_attribute/);
    assert.match(r.stderr, /modifiedAt/);
  });

  it('404 surfaces the API message', async () => {
    failure = { status: 404, body: { error: 'not_found', message: 'datasource not found' } };
    const r = await run('--base', stubBase, 'lds', 'datasources', 'get', 'missing');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HTTP 404/);
    assert.match(r.stderr, /datasource not found/);
  });

  it('404 on entity ingest mentions not found', async () => {
    failure = { status: 404, body: { error: 'not_found', message: 'entity not found' } };
    const r = await run('--base', stubBase, 'lds', 'entity', 'ds_1', 'urn:ngsi-ld:Building:404');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not found/);
  });

  it('help lists lds with datasources/entities usage', async () => {
    const r = await run('help');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /lds\s+SynapseLDS/);
    assert.ok(r.stdout.includes('lds datasources create'), 'usage in help');
    assert.ok(r.stdout.includes('lds entities'), 'entities usage in help');
  });
});
