// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { datasetRow, escapeHtml, safeText } from '../public/escape.js';

test('escapeHtml neutralizes dataset-controlled markup', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHtml("O'Brien & Sons"), 'O&#39;Brien &amp; Sons');
  assert.equal(escapeHtml(undefined), '');
});

test('datasetRow escapes every dataset field (stored XSS regression)', () => {
  const row = datasetRow({
    id: 'x',
    slug: '<script>alert(1)</script>',
    name: '<img onerror="alert(2)">',
    description: '</div><script>alert(3)</script>',
    status: '"><svg onload=alert(4)>',
    schemaVersion: '<b>1</b>',
  });
  assert.equal(row.includes('<script>'), false);
  assert.equal(row.includes('<img'), false);
  assert.equal(row.includes('<svg'), false);
  assert.match(row, /&lt;script&gt;/);
  assert.match(row, /&lt;img onerror=&quot;alert\(2\)&quot;&gt;/);
});

test('safeText removes control characters from rendered errors', () => {
  assert.equal(safeText('a\u0000b\nc'), 'a b c');
});
