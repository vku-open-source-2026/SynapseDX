// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Real engines behind the I-layer: file-backed OCR (#43) and Tier-1 RAG (#45). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, api, startHarness } from './testing/harness';
import { parseTesseractTsv } from './ocr';
import { COLLECTIONS } from './platform';

const TSV_HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

function word(line: number, n: number, left: number, conf: number, text: string): string {
  return ['5', '1', '1', '1', String(line), String(n), String(left), String(line * 40), '60', '20', String(conf), text].join('\t');
}

/** A stand-in `tesseract` binary: checks its arguments, drains stdin, prints TSV. */
function fakeTesseract(rows: string[], exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-tesseract-'));
  const bin = join(dir, 'tesseract');
  const tsv = [TSV_HEADER, ...rows].join('\n');
  writeFileSync(bin, [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    "if (args[0] !== 'stdin' || args[1] !== 'stdout' || !args.includes('tsv')) { console.error('bad args ' + args.join(' ')); process.exit(2); }",
    "if (process.env.OMP_THREAD_LIMIT !== '1') { console.error('threads not limited'); process.exit(3); }",
    'let n = 0; process.stdin.on("data", (c) => { n += c.length; });',
    `process.stdin.on("end", () => { if (!n) { console.error("empty stdin"); process.exit(4); } process.stdout.write(${JSON.stringify(tsv)}, () => process.exit(${exitCode})); });`,
  ].join('\n'));
  chmodSync(bin, 0o755);
  return bin;
}

async function uploadFile(harness: Harness, contentType: string, bytes: Buffer, token = 'user-token'): Promise<string> {
  const created = await api(harness, '/v1/capabilities/files', {
    method: 'POST', token, body: { filename: 'scan', contentType },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const upload = await api(harness, `/v1/capabilities/files/${created.body.id}/content`, {
    method: 'PUT', token,
    headers: { 'content-type': contentType, 'x-checksum-sha256': createHash('sha256').update(bytes).digest('hex') },
    buffer: bytes,
  });
  assert.equal(upload.status, 200, JSON.stringify(upload.body));
  return created.body.id;
}

test('TSV parsing groups words into lines with bbox and confidence', () => {
  const pages = parseTesseractTsv([
    TSV_HEADER,
    '1\t1\t0\t0\t0\t0\t0\t0\t800\t600\t-1\t',
    word(1, 1, 10, 96, 'Họ'), word(1, 2, 80, 94, 'tên:'), word(1, 3, 150, 90, 'Nguyễn'), word(1, 4, 220, 92, 'An'),
    word(2, 1, 10, 40, 'Số'), word(2, 2, 80, 30, 'tiền:'), word(2, 3, 150, 20, '1.2OO'),
  ].join('\n'));
  assert.equal(pages.length, 1);
  assert.equal(pages[0].lines?.length, 2);
  assert.equal(pages[0].lines?.[0].text, 'Họ tên: Nguyễn An');
  assert.deepEqual(pages[0].lines?.[0].bbox, [10, 40, 280, 60]);
  assert.equal(pages[0].lines?.[0].confidence, 0.93);
  assert.equal(pages[0].text, 'Họ tên: Nguyễn An\nSố tiền: 1.2OO');
});

test('OCR jobs read the stored image and run the engine; low-confidence lines queue for review', async () => {
  const bin = fakeTesseract([
    word(1, 1, 10, 96, 'Họ'), word(1, 2, 80, 94, 'tên:'), word(1, 3, 150, 90, 'Nguyễn'), word(1, 4, 220, 92, 'An'),
    word(2, 1, 10, 40, 'Số'), word(2, 2, 80, 30, 'tiền:'), word(2, 3, 150, 20, '1.2OO'),
  ]);
  const harness = await startHarness({ SYNAPSEDX_TESSERACT_BIN: bin });
  try {
    const fileId = await uploadFile(harness, 'image/png', Buffer.from('\x89PNG fake image bytes'));
    const job = await api(harness, '/v1/capabilities/ocr/jobs', { method: 'POST', token: 'user-token', body: { fileId } });
    assert.equal(job.status, 201, JSON.stringify(job.body));
    assert.equal(job.body.job.source, 'engine');
    assert.equal(job.body.job.engine.name, 'tesseract');
    assert.equal(job.body.job.engine.languages, 'vie+eng');
    const [name, amount] = job.body.job.fields;
    assert.equal(name.name, 'Họ tên');
    assert.equal(name.value, 'Nguyễn An');
    assert.equal(name.status, 'auto');
    assert.deepEqual(name.bbox, [10, 40, 280, 60]);
    assert.equal(amount.name, 'Số tiền');
    assert.equal(amount.status, 'pending');
    assert.equal(job.body.job.status, 'needs_correction');

    // Another tenant cannot OCR this file.
    const foreign = await api(harness, '/v1/capabilities/ocr/jobs', { method: 'POST', token: 'other-token', body: { fileId } });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error.code, 'file_not_found');

    // Redaction also covers the per-line text kept for provenance.
    const phoneBin = fakeTesseract([word(1, 1, 10, 95, 'SĐT:'), word(1, 2, 80, 95, '0905123456')]);
    const harness2 = await startHarness({ SYNAPSEDX_TESSERACT_BIN: phoneBin });
    try {
      const id2 = await uploadFile(harness2, 'image/jpeg', Buffer.from('jpeg bytes'));
      const job2 = await api(harness2, '/v1/capabilities/ocr/jobs', { method: 'POST', token: 'user-token', body: { fileId: id2 } });
      assert.equal(job2.status, 201, JSON.stringify(job2.body));
      const redacted = await api(harness2, `/v1/capabilities/ocr/jobs/${job2.body.job.id}/redact`, { method: 'POST', token: 'user-token', body: {} });
      assert.equal(redacted.status, 200);
      assert.ok(!JSON.stringify(redacted.body.job).includes('0905123456'));
    } finally {
      await harness2.close();
    }
  } finally {
    await harness.close();
  }
});

test('OCR rejects non-images, reports a missing engine and honours the off switch', async () => {
  const harness = await startHarness({ SYNAPSEDX_TESSERACT_BIN: join(tmpdir(), 'definitely-missing-tesseract') });
  try {
    const pdf = await uploadFile(harness, 'application/pdf', Buffer.from('%PDF-1.7'));
    const unsupported = await api(harness, '/v1/capabilities/ocr/jobs', { method: 'POST', token: 'user-token', body: { fileId: pdf } });
    assert.equal(unsupported.status, 415);
    assert.equal(unsupported.body.error.code, 'ocr_unsupported_type');

    const png = await uploadFile(harness, 'image/png', Buffer.from('png'));
    const missing = await api(harness, '/v1/capabilities/ocr/jobs', { method: 'POST', token: 'user-token', body: { fileId: png } });
    assert.equal(missing.status, 503);
    assert.equal(missing.body.error.code, 'ocr_engine_unavailable');

    // Client-supplied text still works without any engine.
    const text = await api(harness, '/v1/capabilities/ocr/jobs', { method: 'POST', token: 'user-token', body: { fileId: png, text: 'Mã hồ sơ: HS-001' } });
    assert.equal(text.status, 201, JSON.stringify(text.body));
    assert.equal(text.body.job.source, 'client_text');
    assert.equal(text.body.job.fields[0].name, 'Mã hồ sơ');
  } finally {
    await harness.close();
  }
  const off = await startHarness({ SYNAPSEDX_OCR_ENGINE: 'off' });
  try {
    const png = await uploadFile(off, 'image/png', Buffer.from('png'));
    const disabled = await api(off, '/v1/capabilities/ocr/jobs', { method: 'POST', token: 'user-token', body: { fileId: png } });
    assert.equal(disabled.status, 503);
  } finally {
    await off.close();
  }
});

const VI_DOC = 'Rào chắn lũ được dựng khi mực nước sông vượt 4,2 mét.';

test('RAG ranks with Tier-1 embeddings when the model is real (cross-language match)', async () => {
  const harness = await startHarness({ FAKE_TIER1_EMBEDDING_REAL: 'true' });
  try {
    const doc = await api(harness, '/v1/capabilities/rag/documents', {
      method: 'POST', token: 'user-token', body: { title: 'Quy trình ứng phó', sourceId: 'eop-vi', text: VI_DOC },
    });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    assert.equal(doc.body.embeddingModel, 'tier1/fake-minilm');
    const chunks = [...(harness.fake.collections.get(COLLECTIONS.ragChunks)?.values() || [])] as any[];
    assert.equal(chunks[0].data.embeddingModel, 'tier1/fake-minilm');

    // No shared keyword: only meaning connects the English question to the Vietnamese source.
    const answer = await api(harness, '/v1/capabilities/rag/query', {
      method: 'POST', token: 'user-token', body: { question: 'When are flood barriers deployed?' },
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.noAnswer, false);
    assert.equal(answer.body.retrieval, 'tier1/fake-minilm');
    assert.equal(answer.body.citations[0].sourceId, 'eop-vi');

    // Unrelated question stays below the semantic threshold.
    const unrelated = await api(harness, '/v1/capabilities/rag/query', {
      method: 'POST', token: 'user-token', body: { question: 'Who signs the budget?' },
    });
    assert.equal(unrelated.body.noAnswer, true);
  } finally {
    await harness.close();
  }
});

test('RAG falls back to the local hash when Tier-1 embeddings are mock', async () => {
  const harness = await startHarness({ FAKE_TIER1_EMBEDDING_MOCK: 'true' });
  try {
    const before = harness.fake.embeddingCalls;
    const doc = await api(harness, '/v1/capabilities/rag/documents', {
      method: 'POST', token: 'user-token', body: { title: 'Quy trình ứng phó', sourceId: 'eop-vi', text: VI_DOC },
    });
    assert.equal(doc.body.embeddingModel, 'local/hash-48');
    assert.equal(harness.fake.embeddingCalls, before, 'mock embeddings must not be requested');

    const cross = await api(harness, '/v1/capabilities/rag/query', {
      method: 'POST', token: 'user-token', body: { question: 'When are flood barriers deployed?' },
    });
    assert.equal(cross.body.noAnswer, true);
    assert.equal(cross.body.retrieval, 'local/hash-48');

    // Vietnamese keywords with diacritics now match whole tokens.
    const vi = await api(harness, '/v1/capabilities/rag/query', {
      method: 'POST', token: 'user-token', body: { question: 'Khi nào dựng rào chắn lũ?', generate: false },
    });
    assert.equal(vi.body.noAnswer, false, JSON.stringify(vi.body));
    assert.match(vi.body.answer, /4,2 mét/);
    assert.equal(vi.body.generator, 'extractive');
  } finally {
    await harness.close();
  }
});

test('RAG accepts an LLM answer only when its citations point at retrieved sources', async () => {
  const good = await startHarness({ FAKE_TIER1_CHAT_REPLY: 'Rào chắn được dựng khi nước sông vượt 4,2 mét [1].' });
  try {
    await api(good, '/v1/capabilities/rag/documents', {
      method: 'POST', token: 'user-token', body: { title: 'Quy trình ứng phó', sourceId: 'eop-vi', text: VI_DOC },
    });
    const answer = await api(good, '/v1/capabilities/rag/query', {
      method: 'POST', token: 'user-token', body: { question: 'Khi nào dựng rào chắn lũ?' },
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.generator, 'llm');
    assert.equal(answer.body.answer, 'Rào chắn được dựng khi nước sông vượt 4,2 mét [1].');
    const prompt = good.fake.chatRequests.at(-1) as any;
    assert.match(prompt.messages[0].content, /ONLY the numbered sources/);
    assert.match(prompt.messages[1].content, /\[1\] \(Quy trình ứng phó\)/);
    assert.equal(prompt.max_tokens, 400);

    const skipped = await api(good, '/v1/capabilities/rag/query', {
      method: 'POST', token: 'user-token', body: { question: 'Khi nào dựng rào chắn lũ?', generate: false },
    });
    assert.equal(skipped.body.generator, 'extractive');
  } finally {
    await good.close();
  }

  const bad = await startHarness({ FAKE_TIER1_CHAT_REPLY: 'It happens at 9 metres [7].' });
  try {
    await api(bad, '/v1/capabilities/rag/documents', {
      method: 'POST', token: 'user-token', body: { title: 'Quy trình ứng phó', sourceId: 'eop-vi', text: VI_DOC },
    });
    const answer = await api(bad, '/v1/capabilities/rag/query', {
      method: 'POST', token: 'user-token', body: { question: 'Khi nào dựng rào chắn lũ?' },
    });
    assert.equal(answer.body.generator, 'extractive');
    assert.match(answer.body.answer, /4,2 mét\. \[1\]/);
  } finally {
    await bad.close();
  }
});
