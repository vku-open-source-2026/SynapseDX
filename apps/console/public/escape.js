// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** HTML escaping helpers shared by the static console (unit-tested). */

const ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape a value for safe interpolation into HTML markup. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ENTITIES[character]);
}

/** Render a dataset row without trusting any dataset-provided string. */
export function datasetRow(item) {
  const name = escapeHtml(item.name || item.slug || item.id);
  const description = escapeHtml(item.description || item.entityType || 'Capability dataset');
  const slug = escapeHtml(item.slug || item.id);
  const status = escapeHtml(item.status || 'draft');
  const version = escapeHtml(item.schemaVersion || '1.0.0');
  return `<div class="dataset-row"><div class="dataset-name"><strong>${name}</strong><small>${description}</small></div><span class="mono">${slug}</span><span class="pill">${status}</span><span class="mono">${version}</span></div>`;
}

export function safeText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
}
