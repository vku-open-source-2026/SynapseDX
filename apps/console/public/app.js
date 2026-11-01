// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
const $ = (id) => document.getElementById(id);
const formatCount = (value) => Number.isFinite(value) ? value.toLocaleString() : '—';
async function json(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}
function renderDatasets(items) {
  const list = $('dataset-list');
  if (!items.length) { list.innerHTML = '<div class="loading-row">No datasets published yet. Domain services create them on first use.</div>'; $('dataset-count').textContent = '0'; return; }
  $('dataset-count').textContent = formatCount(items.length);
  list.innerHTML = items.map((item) => `<div class="dataset-row"><div class="dataset-name"><strong>${item.name || item.slug || item.id}</strong><small>${item.description || item.entityType || 'Capability dataset'}</small></div><span class="mono">${item.slug || item.id}</span><span class="pill">${item.status || 'ready'}</span><span class="mono">${item.schemaVersion || '1.0.0'}</span></div>`).join('');
}
async function load() {
  try {
    const health = await json('/health');
    $('health-status').textContent = health.status === 'ok' ? 'Healthy' : 'Degraded';
    $('event-status').textContent = health.upstream?.tier1 ? 'Connected' : 'Ready';
    $('event-detail').textContent = health.upstream?.tier1Url ? `SynapseOne · ${health.upstream.tier1Url}` : 'Tier chain connected';
  } catch (error) { $('health-status').textContent = 'Offline'; $('event-detail').textContent = error.message; }
  try {
    const datasets = await json('/v1/capabilities/datasets?limit=100');
    renderDatasets(Array.isArray(datasets) ? datasets : []);
  } catch (error) { $('dataset-list').innerHTML = `<div class="loading-row">Catalog unavailable: ${error.message}</div>`; }
  $('last-checked').textContent = `Checked ${new Date().toLocaleTimeString()}`;
}
$('refresh-datasets').addEventListener('click', load);
load();
