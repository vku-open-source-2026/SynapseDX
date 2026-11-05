// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import {
  parseJsonObject,
  previewJson,
  statusLabel,
  statusTone,
  relativeTime,
} from '../src/lib/format';

describe('format helpers', () => {
  it('keeps status semantics', () => {
    expect(statusLabel('pending')).toBe('Pending review');
    expect(statusLabel('published')).toBe('Published');
    expect(statusTone('published')).toBe('ok');
    expect(statusTone('rejected')).toBe('bad');
    expect(statusTone('draft')).toBe('neutral');
  });

  it('previews JSON with a hard limit', () => {
    expect(previewJson({ a: 1 })).toBe('{"a":1}');
    expect(previewJson({ a: 'x'.repeat(200) }, 20).endsWith('…')).toBe(true);
  });

  it('validates JSON objects strictly', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJsonObject('[]')).toThrow(/JSON object/);
    expect(() => parseJsonObject('{')).toThrow(/valid JSON/);
  });

  it('renders relative time without crashing on bad input', () => {
    expect(relativeTime('not-a-date')).toBe('—');
    expect(relativeTime(undefined)).toBe('—');
  });
});
