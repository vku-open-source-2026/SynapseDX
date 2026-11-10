// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { api, apiBinary, startHarness } from './testing/harness';
import { COLLECTIONS } from './platform';

test('file capability uploads/downloads binary data with metadata, checksum and tenant isolation', async () => {
  const harness = await startHarness();
  try {
    const created = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token',
      body: { filename: 'evidence.png', contentType: 'image/png', datasetId: 'incidents', recordId: 'INC_1' },
    });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal(created.body.upload.method, 'PUT');
    assert.equal(created.body.datasetId, 'incidents');

    const bytes = Buffer.from('not-really-a-png-but-binary\x00\x01\x02');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const upload = await api(harness, `/v1/capabilities/files/${id}/content`, {
      method: 'PUT', token: 'user-token',
      headers: { 'content-type': 'image/png', 'x-checksum-sha256': checksum },
      buffer: bytes,
    });
    assert.equal(upload.status, 200);
    assert.equal(upload.body.size, bytes.length);
    assert.equal(upload.body.checksumSha256, checksum);
    assert.ok(harness.fake.ocsBuckets.has('synapsedx-files'));
    assert.ok([...harness.fake.storage.keys()].some((key) => key.startsWith('synapsedx-files|')));

    const metadata = await api(harness, `/v1/capabilities/files/${id}`, { token: 'user-token' });
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.filename, 'evidence.png');
    assert.equal(metadata.body.size, bytes.length);
    assert.equal(metadata.body.checksumSha256, checksum);

    const download = await apiBinary(harness, `/v1/capabilities/files/${id}/content`, { token: 'user-token' });
    assert.equal(download.status, 200);
    assert.deepEqual(download.body, bytes);
    assert.equal(download.headers.get('content-type'), 'image/png');
    assert.equal(download.headers.get('x-checksum-sha256'), checksum);

    // GeoJSON/CSV uploads are raw bytes even though their MIME type is JSON.
    const geojson = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token', body: { filename: 'layer.geojson', contentType: 'application/json' },
    });
    assert.equal(geojson.status, 201);
    const geojsonBytes = Buffer.from('{"type":"FeatureCollection","features":[]}');
    const geojsonUpload = await api(harness, `/v1/capabilities/files/${geojson.body.id}/content`, {
      method: 'PUT', token: 'user-token',
      headers: { 'content-type': 'application/json' }, buffer: geojsonBytes,
    });
    assert.equal(geojsonUpload.status, 200);
    assert.equal(geojsonUpload.body.size, geojsonBytes.length);
    const geojsonDownload = await apiBinary(harness, `/v1/capabilities/files/${geojson.body.id}/content`, { token: 'user-token' });
    assert.deepEqual(geojsonDownload.body, geojsonBytes);

    const list = await api(harness, '/v1/capabilities/files', { token: 'user-token' });
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 2);
    assert.ok(list.body.items.some((item: any) => item.id === id));

    const quota = await api(harness, '/v1/capabilities/files/quota', { token: 'user-token' });
    assert.equal(quota.status, 200);
    assert.equal(quota.body.usedBytes, bytes.length + geojsonBytes.length);
    assert.ok(quota.body.quotaBytes > quota.body.usedBytes);

    const crossTenant = await api(harness, `/v1/capabilities/files/${id}`, { token: 'other-token' });
    assert.equal(crossTenant.status, 404);
    assert.equal(crossTenant.body.error.code, 'file_not_found');
    const crossDownload = await apiBinary(harness, `/v1/capabilities/files/${id}/content`, { token: 'other-token' });
    assert.equal(crossDownload.status, 404);

    const deleted = await api(harness, `/v1/capabilities/files/${id}`, { method: 'DELETE', token: 'user-token' });
    assert.equal(deleted.status, 204);
    const gone = await api(harness, `/v1/capabilities/files/${id}`, { token: 'user-token' });
    assert.equal(gone.status, 404);
    assert.equal(harness.fake.storage.size, 1);
  } finally {
    await harness.close();
  }
});

test('a 10 MB binary upload goes through Tier-2 with a verifiable checksum', async () => {
  const harness = await startHarness();
  try {
    const created = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token',
      body: { filename: 'large.bin', contentType: 'application/octet-stream', size: 10 * 1024 * 1024 },
    });
    assert.equal(created.status, 201);
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x5a);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const upload = await api(harness, `/v1/capabilities/files/${created.body.id}/content`, {
      method: 'PUT', token: 'user-token',
      headers: { 'content-type': 'application/octet-stream', 'x-checksum-sha256': checksum },
      buffer: bytes,
    });
    assert.equal(upload.status, 200);
    assert.equal(upload.body.size, bytes.length);
    assert.equal(upload.body.checksumSha256, checksum);
    const download = await apiBinary(harness, `/v1/capabilities/files/${created.body.id}/content`, { token: 'user-token' });
    assert.equal(download.status, 200);
    assert.equal(download.body.length, bytes.length);
    assert.equal(createHash('sha256').update(download.body).digest('hex'), checksum);
  } finally {
    await harness.close();
  }
});

test('file capability enforces checksum, MIME, quota and idempotency rules', async () => {
  const harness = await startHarness({
    SYNAPSEDX_FILES_ALLOWED_TYPES: 'image/png',
    SYNAPSEDX_FILES_MAX_BYTES: '1024',
    SYNAPSEDX_FILES_QUOTA_BYTES: '1024',
  });
  try {
    const wrongType = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token', body: { filename: 'notes.txt', contentType: 'text/plain' },
    });
    assert.equal(wrongType.status, 415);
    assert.equal(wrongType.body.error.code, 'file_type_not_allowed');

    const tooLarge = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token', body: { filename: 'huge.png', contentType: 'image/png', size: 5000 },
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.body.error.code, 'file_too_large');

    const quota = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token', body: { filename: 'ok.png', contentType: 'image/png', size: 1024 },
    });
    assert.equal(quota.status, 201);
    const overQuota = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token', body: { filename: 'second.png', contentType: 'image/png', size: 512 },
    });
    assert.equal(overQuota.status, 413);
    assert.equal(overQuota.body.error.code, 'quota_exceeded');

    const idempotentBody = { filename: 'idem.png', contentType: 'image/png' };
    const first = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token', body: idempotentBody,
      headers: { 'idempotency-key': 'file-create-0001' },
    });
    assert.equal(first.status, 201);
    const replay = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token', body: idempotentBody,
      headers: { 'idempotency-key': 'file-create-0001' },
    });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.id, first.body.id);

    const id = first.body.id;
    const badChecksum = await api(harness, `/v1/capabilities/files/${id}/content`, {
      method: 'PUT', token: 'user-token',
      headers: { 'content-type': 'image/png', 'x-checksum-sha256': '0'.repeat(64) },
      buffer: Buffer.from('abc'),
    });
    assert.equal(badChecksum.status, 400);
    assert.equal(badChecksum.body.error.code, 'invalid_request');
  } finally {
    await harness.close();
  }
});

test('presigned URLs are exposed only when the Tier-1 backend supports them', async () => {
  const fsBackend = await startHarness();
  try {
    const created = await api(fsBackend, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token', body: { filename: 'a.png', contentType: 'image/png' },
    });
    const presign = await api(fsBackend, `/v1/capabilities/files/${created.body.id}/presign`, {
      method: 'POST', token: 'user-token', body: { method: 'GET' },
    });
    assert.equal(presign.status, 501);
    assert.equal(presign.body.error.code, 'presign_unsupported');
  } finally {
    await fsBackend.close();
  }

  const s3Backend = await startHarness({}, { storagePresign: true });
  try {
    const created = await api(s3Backend, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token', body: { filename: 'a.png', contentType: 'image/png' },
    });
    const presign = await api(s3Backend, `/v1/capabilities/files/${created.body.id}/presign`, {
      method: 'POST', token: 'user-token', body: { method: 'PUT', expiresIn: 600 },
    });
    assert.equal(presign.status, 200);
    assert.equal(presign.body.method, 'PUT');
    assert.match(presign.body.url, /^https:\/\/s3\.example\//);
    assert.match(presign.body.completeUrl, /\/complete$/);

    const bytes = Buffer.from('presigned-body');
    const upload = await api(s3Backend, `/v1/capabilities/files/${created.body.id}/content`, {
      method: 'PUT', token: 'user-token', headers: { 'content-type': 'image/png' }, buffer: bytes,
    });
    assert.equal(upload.status, 200);
    const complete = await api(s3Backend, `/v1/capabilities/files/${created.body.id}/complete`, {
      method: 'POST', token: 'user-token', body: { size: bytes.length },
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.size, bytes.length);
  } finally {
    await s3Backend.close();
  }
});

test('public release files are readable anonymously only when explicitly published', async () => {
  const harness = await startHarness({}, { storagePresign: true });
  try {
    const denied = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token',
      body: { filename: 'release.apk', contentType: 'application/vnd.android.package-archive', public: true },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'insufficient_scope');

    const created = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'admin-token',
      body: {
        id: 'synapsecity-android-0.1.0',
        filename: 'SynapseCity-0.1.0-release.apk',
        contentType: 'application/vnd.android.package-archive',
        public: true,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.public, true);
    assert.match(created.body.publicUrl, /^\/v1\/capabilities\/public\/files\//);

    const bytes = Buffer.from('android-release-bytes');
    const upload = await api(harness, `/v1/capabilities/files/${created.body.id}/content`, {
      method: 'PUT', token: 'admin-token',
      headers: { 'content-type': 'application/vnd.android.package-archive' }, buffer: bytes,
    });
    assert.equal(upload.status, 200);

    const anonymous = await api(harness, `/v1/capabilities/public/files/${created.body.id}`);
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.body.filename, 'SynapseCity-0.1.0-release.apk');

    const download = await apiBinary(harness, `/v1/capabilities/public/files/${created.body.id}/content`);
    assert.equal(download.status, 200);
    assert.deepEqual(download.body, bytes);
    assert.match(download.headers.get('content-disposition') || '', /SynapseCity-0\.1\.0-release\.apk/);

    const privateCreated = await api(harness, '/v1/capabilities/files', {
      method: 'POST', token: 'user-token', body: { filename: 'private.bin', contentType: 'application/octet-stream' },
    });
    const privatePublic = await api(harness, `/v1/capabilities/public/files/${privateCreated.body.id}`);
    assert.equal(privatePublic.status, 404);
  } finally {
    await harness.close();
  }
});

test('legacy default-bucket files are lazily migrated to SynapseOCS', async () => {
  const harness = await startHarness();
  try {
    const bytes = Buffer.from('legacy-object');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const storageKey = 'synapsedx/files/acct-a/legacy-1/legacy.txt';
    const now = new Date().toISOString();
    harness.fake.storage.set(`account:service-account|${storageKey}`, {
      tenant: 'account:service-account', key: storageKey, body: bytes, contentType: 'text/plain',
      etag: checksum.slice(0, 32), checksumSha256: checksum, createdAt: now, updatedAt: now,
    });
    const collection = harness.fake.collections.get(COLLECTIONS.files) ?? new Map();
    harness.fake.collections.set(COLLECTIONS.files, collection);
    collection.set('legacy-1', {
      id: 'legacy-1', version: 1, createdAt: now, updatedAt: now,
      data: {
        id: 'legacy-1', tenant: 'acct-a', owner: 'user-1', filename: 'legacy.txt',
        contentType: 'text/plain', size: bytes.length, checksumSha256: checksum,
        storageKey, createdAt: now, updatedAt: now,
      },
    });

    const download = await apiBinary(harness, '/v1/capabilities/files/legacy-1/content', { token: 'user-token' });
    assert.equal(download.status, 200);
    assert.deepEqual(download.body, bytes);
    assert.ok([...harness.fake.storage.keys()].some((key) => key.startsWith('synapsedx-files|') && key.includes(storageKey)));
    const metadata = collection.get('legacy-1');
    assert.equal((metadata?.data as any).ocsBucket, 'synapsedx-files');
  } finally {
    await harness.close();
  }
});
