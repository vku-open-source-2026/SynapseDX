// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { datasetRow, safeText } from './escape.js';

const $ = (id) => document.getElementById(id);
const formatCount = (value) => Number.isFinite(value) ? value.toLocaleString() : '—';

async function json(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const code = body?.error?.code ? ` (${body.error.code})` : '';
    throw new Error(`${response.status} ${response.statusText}${code}`);
  }
  return body;
}

function renderDatasets(items) {
  const list = $('dataset-list');
  if (!items.length) {
    list.textContent = '';
    const row = document.createElement('div');
    row.className = 'loading-row';
    row.textContent = 'No datasets published yet. Domain services create them on first use.';
    list.append(row);
    $('dataset-count').textContent = '0';
    return;
  }
  $('dataset-count').textContent = formatCount(items.length);
  // Values are escaped by datasetRow before interpolation.
  list.innerHTML = items.map((item) => datasetRow(item)).join('');
}

function renderHealth(health) {
  const status = health?.status === 'ok' ? 'Healthy' : health?.status === 'degraded' ? 'Degraded' : 'Down';
  $('health-status').textContent = status;
  const dependencies = Array.isArray(health?.dependencies) ? health.dependencies : [];
  const unhealthy = dependencies.filter((dependency) => dependency.status !== 'ok');
  $('event-status').textContent = unhealthy.length ? 'Degraded' : 'Connected';
  const upstream = health?.upstream || {};
  $('event-detail').textContent = upstream?.dependencies?.length
    ? `SynapseOne · ${upstream.dependencies.length} dependencies checked`
    : 'Tier chain connected';
}

async function load() {
  try {
    const health = await json('/health');
    renderHealth(health);
  } catch (error) {
    $('health-status').textContent = 'Offline';
    $('event-detail').textContent = safeText(error.message);
  }
  try {
    const datasets = await json('/v1/capabilities/datasets?limit=100');
    renderDatasets(Array.isArray(datasets) ? datasets : []);
  } catch (error) {
    const list = $('dataset-list');
    list.textContent = '';
    const row = document.createElement('div');
    row.className = 'loading-row';
    row.textContent = `Catalog unavailable: ${safeText(error.message)}`;
    list.append(row);
  }
  $('last-checked').textContent = `Checked ${new Date().toLocaleTimeString()}`;
}

void escapeHtml;
$('refresh-datasets').addEventListener('click', load);
load();
