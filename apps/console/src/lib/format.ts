// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Formatting helpers kept free of DOM access so they can be unit-tested. */

export function formatNumber(value: unknown): string {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
}

export function formatDate(value: unknown): string {
  if (!value) return '—';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(value: unknown): string {
  if (!value) return '—';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  const [unit, size] = units.find(([, size]) => abs >= size) ?? ['second', 1];
  const amount = Math.round(seconds / size);
  try {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(amount, unit);
  } catch {
    return formatDate(value);
  }
}

export type StatusTone = 'ok' | 'warn' | 'bad' | 'neutral';

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  published: 'Published',
  revoked: 'Revoked',
  pending: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  none: 'Not submitted',
};

export function statusLabel(status: unknown): string {
  const key = String(status || '').toLowerCase();
  return STATUS_LABELS[key] ?? (String(status || '—') || '—');
}

export function statusTone(status: unknown): StatusTone {
  const value = String(status || '').toLowerCase();
  if (['published', 'approved', 'ok', 'completed'].includes(value)) return 'ok';
  if (['pending', 'running'].includes(value)) return 'warn';
  if (['revoked', 'rejected', 'failed', 'bad'].includes(value)) return 'bad';
  return 'neutral';
}

export function previewJson(value: unknown, max = 96): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function parseJsonObject(text: string, field = 'data'): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}
