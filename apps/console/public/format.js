// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Formatting helpers kept free of DOM access so they can be unit-tested. */

export function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function relativeTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const units = [
    ['year', 31536000], ['month', 2592000], ['day', 86400],
    ['hour', 3600], ['minute', 60], ['second', 1],
  ];
  const [unit, size] = units.find(([, size]) => abs >= size) || ['second', 1];
  const amount = Math.round(seconds / size);
  try {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(amount, unit);
  } catch {
    return formatDate(value);
  }
}

export function statusLabel(status) {
  const labels = {
    draft: 'Draft', published: 'Published', revoked: 'Revoked',
    pending: 'Pending review', approved: 'Approved', rejected: 'Rejected', none: 'Not submitted',
  };
  return labels[String(status || '').toLowerCase()] || String(status || '—');
}

export function statusClass(status) {
  const value = String(status || '').toLowerCase();
  if (['published', 'approved'].includes(value)) return 'ok';
  if (['pending'].includes(value)) return 'warn';
  if (['revoked', 'rejected'].includes(value)) return 'bad';
  return 'neutral';
}

export function previewJson(value, max = 96) {
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  if (text === undefined) text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function parseJsonObject(text, field = 'data') {
  let value;
  try { value = JSON.parse(text); } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}
