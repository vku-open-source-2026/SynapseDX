// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * SynapseDX Tier-2 capability control plane.
 *
 * A dependency-free management SPA for administrators, operators, moderators
 * and managers. Every action is authorized again by the capabilities service;
 * hiding a button is a usability aid, never a security boundary.
 */
import { ApiError, createApi } from './api.js';
import { escapeHtml } from './escape.js';
import { can, canOpenView, navigationFor, primaryRole, roleLabel } from './rbac.js';
import {
  formatNumber, parseJsonObject, previewJson, relativeTime, statusClass, statusLabel,
} from './format.js';

const SESSION_KEY = 'synapsedx.console.session.v1';
const $ = (id) => document.getElementById(id);
const state = {
  session: loadSession(),
  context: null,
  view: 'overview',
  datasets: [],
  selectedDataset: null,
  reviewStatus: 'pending',
  auditQuery: {},
};

const VIEW_META = {
  overview: { eyebrow: 'TIER 2 · CAPABILITY CONTROL PLANE', title: 'Operate the open-data layer' },
  datasets: { eyebrow: 'CAPABILITY CATALOG', title: 'Datasets and publication' },
  records: { eyebrow: 'RECORD PIPELINE', title: 'Records and projections' },
  moderation: { eyebrow: 'PEER REVIEW', title: 'Publication moderation' },
  events: { eyebrow: 'EVENT BUS', title: 'Events and outbox' },
  audit: { eyebrow: 'GOVERNANCE', title: 'Audit and usage' },
  settings: { eyebrow: 'SESSION', title: 'Console settings' },
};

const api = createApi({
  getToken: () => state.session?.accessToken || null,
  onUnauthorized: () => {
    clearSession();
    showToast('Your session expired. Sign in again.', 'warn');
    render();
  },
});

/* -------------------------------------------------------------------------- *
 * Session and shell
 * -------------------------------------------------------------------------- */

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.accessToken ? parsed : null;
  } catch {
    return null;
  }
}

function saveSession(next) {
  state.session = next;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
}

function clearSession() {
  state.session = null;
  state.context = null;
  sessionStorage.removeItem(SESSION_KEY);
}

function renderShell() {
  const meta = VIEW_META[state.view] || VIEW_META.overview;
  $('page-eyebrow').textContent = meta.eyebrow;
  $('page-title').textContent = meta.title;
  const items = navigationFor(state.context);
  $('primary-nav').innerHTML = items.map((item) => (
    `<a class="nav-link${item.view === state.view ? ' active' : ''}" href="#${escapeHtml(item.view)}" data-nav="${escapeHtml(item.view)}">` +
    `<span>${escapeHtml(item.icon)}</span>${escapeHtml(item.label)}</a>`
  )).join('');
  renderSessionBox();
}

function renderSessionBox() {
  const box = $('session-box');
  if (!state.context) {
    box.innerHTML = '<button class="primary-button" type="button" data-action="login">Sign in <span>→</span></button>';
    return;
  }
  const role = primaryRole(state.context);
  const user = state.context.user || {};
  const label = user.displayName || user.email || user.id || 'verified principal';
  box.innerHTML =
    `<div class="session-user">` +
    `<span class="role-badge role-${escapeHtml(role || 'viewer')}">${escapeHtml(roleLabel(state.context))}</span>` +
    `<span class="session-name">${escapeHtml(label)}</span>` +
    `<button class="ghost-button" type="button" data-action="logout">Sign out</button>` +
    `</div>`;
}

async function refreshContext() {
  if (!state.session) {
    state.context = null;
    return null;
  }
  try {
    state.context = await api.get('/v1/capabilities/management/context');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) clearSession();
    else showToast(error.message || 'Could not load the session context', 'bad');
    state.context = null;
  }
  return state.context;
}

async function boot() {
  await refreshContext();
  const route = location.hash.replace(/^#/, '') || 'overview';
  state.view = canOpenView(state.context, route) ? route : 'overview';
  renderShell();
  await render();
  window.addEventListener('hashchange', async () => {
    const next = location.hash.replace(/^#/, '') || 'overview';
    if (!canOpenView(state.context, next)) {
      showToast('Your role cannot open that section.', 'warn');
      location.hash = '#overview';
      return;
    }
    state.view = next;
    renderShell();
    await render();
  });
  setInterval(updateBoundary, 60_000);
  updateBoundary();
}

function updateBoundary() {
  fetch('/health', { headers: { accept: 'application/json' } })
    .then((response) => response.json())
    .then((health) => {
      const ok = health?.status === 'ok';
      $('boundary-dot').className = `status-dot ${ok ? '' : 'degraded'}`;
      $('boundary-label').textContent = ok ? 'Tier chain healthy' : 'Tier chain degraded';
    })
    .catch(() => {
      $('boundary-dot').className = 'status-dot degraded';
      $('boundary-label').textContent = 'Tier chain offline';
    });
}

/* -------------------------------------------------------------------------- *
 * Rendering primitives
 * -------------------------------------------------------------------------- */

function setView(html) {
  $('view').innerHTML = html;
  $('last-checked').textContent = `Checked ${new Date().toLocaleTimeString()}`;
}

function loadingPanel(label = 'Loading…') {
  return `<section class="panel"><div class="loading-row">${escapeHtml(label)}</div></section>`;
}

function errorPanel(error, retryView = state.view) {
  const status = error instanceof ApiError ? error.status : 0;
  const code = error?.code ? `<span class="mono">${escapeHtml(error.code)}</span>` : '';
  const login = status === 401
    ? '<button class="primary-button" type="button" data-action="login">Sign in <span>→</span></button>'
    : `<button class="ghost-button" type="button" data-action="retry" data-id="${escapeHtml(retryView)}">Retry</button>`;
  return `<section class="panel error-panel"><p class="eyebrow">REQUEST FAILED</p>` +
    `<h2>${escapeHtml(error?.message || 'The control plane returned an error')}</h2>` +
    `<p class="muted">${code}</p>${login}</section>`;
}

function emptyState(title, message, action = '') {
  return `<section class="panel empty-state"><div class="empty-icon">◇</div>` +
    `<h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(message)}</p>${action}</section>`;
}

function metricCard(icon, tone, value, label) {
  return `<article class="metric-card"><span class="metric-icon ${escapeHtml(tone)}">${escapeHtml(icon)}</span>` +
    `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div></article>`;
}

function badge(value) {
  return `<span class="pill ${statusClass(value)}">${escapeHtml(statusLabel(value))}</span>`;
}

function dataTable(headers, rows, { id = '', empty = 'No rows.' } = {}) {
  if (!rows.length) return `<div class="loading-row">${escapeHtml(empty)}</div>`;
  return `<div class="table-wrap"><table class="data-table"${id ? ` id="${escapeHtml(id)}"` : ''}>` +
    `<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table></div>`;
}

function actionButton(action, id, label, { variant = '', title = '' } = {}) {
  return `<button class="table-action ${escapeHtml(variant)}" type="button" data-action="${escapeHtml(action)}" data-id="${escapeHtml(id)}"` +
    `${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</button>`;
}

function toast(message, kind = 'ok') {
  const root = $('toast-root');
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.textContent = message;
  root.append(item);
  setTimeout(() => item.remove(), 4200);
}

function showToast(message, kind = 'ok') {
  toast(message, kind);
}

/* -------------------------------------------------------------------------- *
 * Router
 * -------------------------------------------------------------------------- */

async function render() {
  if (!canOpenView(state.context, state.view)) state.view = 'overview';
  renderShell();
  setView(loadingPanel());
  try {
    if (state.view === 'overview') await renderOverview();
    else if (state.view === 'datasets') await renderDatasets();
    else if (state.view === 'records') await renderRecords();
    else if (state.view === 'moderation') await renderModeration();
    else if (state.view === 'events') await renderEvents();
    else if (state.view === 'audit') await renderAudit();
    else if (state.view === 'settings') await renderSettings();
  } catch (error) {
    setView(errorPanel(error));
  }
}

/* -------------------------------------------------------------------------- *
 * Overview
 * -------------------------------------------------------------------------- */

async function renderOverview() {
  if (!state.context) return renderPublicOverview();
  const [summary, health] = await Promise.allSettled([
    api.get('/v1/capabilities/management/summary'),
    api.get('/health'),
  ]);
  if (summary.status === 'rejected') throw summary.reason;
  const data = summary.value;
  const healthValue = health.status === 'fulfilled' ? health.value : null;
  const dependencies = Array.isArray(healthValue?.dependencies) ? healthValue.dependencies : [];
  const unhealthy = dependencies.filter((dependency) => dependency.status !== 'ok');
  const auditRows = (data.recentAudit || []).slice(0, 6).map((item) => (
    `<tr><td class="mono">${escapeHtml(relativeTime(item.at))}</td>` +
    `<td>${escapeHtml(item.actor || '—')}</td>` +
    `<td><span class="audit-action">${escapeHtml(item.action || '—')}</span></td>` +
    `<td class="mono">${escapeHtml(item.datasetId || '—')}</td></tr>`
  ));
  setView(
    `<section class="hero-card"><div><span class="hero-kicker">${escapeHtml(roleLabel(state.context).toUpperCase())} WORKSPACE</span>` +
    `<h2>Govern the capability layer with evidence.</h2>` +
    `<p>Datasets, records, publication, review and audit are one contract. Every mutation is tenant-scoped and recorded in Tier-1.</p>` +
    `<div class="hero-actions">${can(state.context, 'datasets:write') ? '<button class="primary-button" type="button" data-action="new-dataset">New dataset <span>→</span></button>' : ''}` +
    `<a class="text-link" href="#audit">Open audit trail</a></div></div>` +
    `<div class="hero-orbit" aria-hidden="true"><span class="orbit orbit-one"></span><span class="orbit orbit-two"></span><span class="orbit-core">DX</span></div></section>` +
    `<section class="metric-grid">` +
    metricCard('◈', 'cyan', formatNumber(data.datasets.total), 'Registered datasets') +
    metricCard('✓', 'green', formatNumber(data.datasets.published), 'Published') +
    metricCard('⚖', 'violet', formatNumber(data.datasets.pendingReview), 'Awaiting review') +
    metricCard('⌁', 'amber', unhealthy.length ? 'Degraded' : 'Connected', unhealthy.length ? `${unhealthy.length} dependencies need attention` : 'Tier chain healthy') +
    `</section>` +
    `<section class="split-grid"><article class="panel compact"><p class="eyebrow">TENANT CONTEXT</p><h2>${escapeHtml(data.roles.join(' · ') || 'No role')}</h2>` +
    `<p class="muted">Tenant <code>${escapeHtml(state.context.tenant || '—')}</code> · account <code>${escapeHtml(state.context.account || '—')}</code></p>` +
    `<div class="permission-list">${(data.permissions || []).slice(0, 10).map((permission) => `<span class="permission">${escapeHtml(permission)}</span>`).join('')}</div></article>` +
    `<article class="panel compact"><p class="eyebrow">OUTBOX</p><h2>${formatNumber(data.pendingEvents)} pending event${data.pendingEvents === 1 ? '' : 's'}</h2>` +
    `<p class="muted">Queue delivery is at-least-once. Pending items are retained in the dataset outbox and can be replayed by an operator.</p>` +
    `<a class="text-link" href="#events">Inspect event feed →</a></article></section>` +
    `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">RECENT MUTATIONS</p><h2>Audit trail</h2></div><a class="ghost-button" href="#audit">View all</a></div>` +
    (auditRows.length ? dataTable(['When', 'Actor', 'Action', 'Dataset'], auditRows) : '<div class="loading-row">No mutations recorded yet.</div>') +
    `</section>`
  );
}

async function renderPublicOverview() {
  let datasets = [];
  try {
    datasets = await api.get('/v1/capabilities/datasets?limit=6');
  } catch {
    datasets = [];
  }
  setView(
    `<section class="hero-card"><div><span class="hero-kicker">PUBLIC CAPABILITY CATALOG</span>` +
    `<h2>One contract for every domain product.</h2>` +
    `<p>SynapseDX exposes datasets, records, publication and events through a stable API. Sign in with your Tier-1 IAM account to operate the layer.</p>` +
    `<div class="hero-actions"><button class="primary-button" type="button" data-action="login">Sign in <span>→</span></button>` +
    `<a class="text-link" href="#datasets">Explore public datasets</a></div></div>` +
    `<div class="hero-orbit" aria-hidden="true"><span class="orbit orbit-one"></span><span class="orbit orbit-two"></span><span class="orbit-core">DX</span></div></section>` +
    `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">PUBLIC DATASETS</p><h2>Latest published capability sets</h2></div>` +
    `<a class="ghost-button" href="#datasets">View catalog</a></div>` +
    (datasets.length ? `<div class="dataset-list">${datasets.map((dataset) => publicDatasetCard(dataset)).join('')}</div>` : '<div class="loading-row">No public datasets are published yet.</div>') +
    `</section>`
  );
}

function publicDatasetCard(dataset) {
  return `<a class="dataset-card" href="#datasets"><div><strong>${escapeHtml(dataset.name || dataset.id)}</strong>` +
    `<small>${escapeHtml(dataset.description || `${dataset.entityType || 'Entity'} dataset`)}</small></div>` +
    `<span class="pill ${statusClass(dataset.status)}">${escapeHtml(statusLabel(dataset.status))}</span></a>`;
}

/* -------------------------------------------------------------------------- *
 * Datasets
 * -------------------------------------------------------------------------- */

async function renderDatasets() {
  const items = await api.get('/v1/capabilities/datasets?limit=200');
  state.datasets = Array.isArray(items) ? items : [];
  if (!state.datasets.length) {
    setView(emptyState(
      'No datasets visible',
      state.context ? 'Create the first dataset for this tenant, or ask an operator to grant access.' : 'No public datasets have been published yet.',
      can(state.context, 'datasets:write') ? '<button class="primary-button" type="button" data-action="new-dataset">New dataset <span>→</span></button>' : ''
    ));
    return;
  }
  setView(
    `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">CAPABILITY CATALOG</p><h2>Datasets</h2></div>` +
    (can(state.context, 'datasets:write') ? '<button class="primary-button" type="button" data-action="new-dataset">New dataset <span>→</span></button>' : '') +
    `</div><div class="toolbar"><input id="dataset-search" class="input" type="search" placeholder="Search name, slug, entity type…" aria-label="Search datasets" />` +
    `<select id="dataset-status" class="input" aria-label="Filter by status"><option value="">All statuses</option><option value="draft">Draft</option><option value="published">Published</option><option value="revoked">Revoked</option></select>` +
    `<span class="muted" id="dataset-count">${state.datasets.length} visible</span></div>` +
    `<div id="dataset-table">${dataTable(['Dataset', 'Entity type', 'License', 'Status', 'Review', 'Actions'], state.datasets.map(datasetRow), { empty: 'No datasets match.' })}</div></section>`
  );
  bindDatasetFilters();
}

function datasetRow(dataset) {
  const id = escapeHtml(dataset.id);
  const review = dataset.reviewStatus && dataset.reviewStatus !== 'none' ? dataset.reviewStatus : 'none';
  const actions = [];
  if (can(state.context, 'records:read')) actions.push(actionButton('view-records', dataset.id, 'Records'));
  if (can(state.context, 'datasets:write')) {
    actions.push(actionButton('edit-dataset', dataset.id, 'Edit'));
    if (dataset.status !== 'published') actions.push(actionButton('publish-dataset', dataset.id, 'Publish', { variant: 'ok' }));
    else actions.push(actionButton('revoke-dataset', dataset.id, 'Revoke', { variant: 'warn' }));
    if (dataset.public && dataset.status !== 'published' && review !== 'pending') {
      actions.push(actionButton('submit-review', dataset.id, 'Submit review'));
    }
  }
  if (can(state.context, 'events:flush') && (dataset.pendingEvents?.length || 0) > 0) {
    actions.push(actionButton('flush-events', dataset.id, `Flush ${dataset.pendingEvents.length}`));
  }
  if (can(state.context, 'datasets:delete')) actions.push(actionButton('delete-dataset', dataset.id, 'Delete', { variant: 'bad' }));
  return `<tr data-id="${id}" data-name="${escapeHtml(`${dataset.name || ''} ${dataset.id || ''} ${dataset.entityType || ''}`.toLowerCase())}" data-status="${escapeHtml(dataset.status || '')}">` +
    `<td><div class="dataset-name"><strong>${escapeHtml(dataset.name || dataset.id)}</strong><small class="mono">${id}</small>` +
    `${dataset.description ? `<small>${escapeHtml(dataset.description)}</small>` : ''}</div></td>` +
    `<td class="mono">${escapeHtml(dataset.entityType || '—')}</td>` +
    `<td><span class="mono">${escapeHtml(dataset.license || '—')}</span></td>` +
    `<td>${badge(dataset.status)}</td><td>${badge(review)}</td>` +
    `<td><div class="row-actions">${actions.join('') || '<span class="muted">Read only</span>'}</div></td></tr>`;
}

function bindDatasetFilters() {
  const search = $('dataset-search');
  const status = $('dataset-status');
  if (!search || !status) return;
  const apply = () => {
    const query = search.value.trim().toLowerCase();
    const wanted = status.value;
    let visible = 0;
    for (const row of document.querySelectorAll('#dataset-table tbody tr')) {
      const matchesName = !query || (row.dataset.name || '').includes(query);
      const matchesStatus = !wanted || row.dataset.status === wanted;
      row.hidden = !(matchesName && matchesStatus);
      if (!row.hidden) visible += 1;
    }
    $('dataset-count').textContent = `${visible} visible`;
  };
  search.addEventListener('input', apply);
  status.addEventListener('change', apply);
}

/* -------------------------------------------------------------------------- *
 * Records
 * -------------------------------------------------------------------------- */

async function renderRecords() {
  if (!can(state.context, 'records:read')) {
    setView(errorPanel({ status: 403, code: 'insufficient_scope', message: 'Your role cannot read records.' }));
    return;
  }
  const datasets = await api.get('/v1/capabilities/datasets?limit=200');
  state.datasets = Array.isArray(datasets) ? datasets : [];
  if (!state.datasets.length) {
    setView(emptyState('No datasets yet', 'Create a dataset before adding records.'));
    return;
  }
  if (!state.selectedDataset || !state.datasets.some((dataset) => dataset.id === state.selectedDataset)) {
    state.selectedDataset = state.datasets[0].id;
  }
  const dataset = state.datasets.find((item) => item.id === state.selectedDataset);
  const records = await api.get(`/v1/capabilities/datasets/${encodeURIComponent(state.selectedDataset)}/records?limit=100&orderBy=updatedAt:desc`);
  const items = Array.isArray(records?.items) ? records.items : [];
  const rows = items.map(recordRow).join('');
  setView(
    `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">RECORD PIPELINE</p><h2>${escapeHtml(dataset?.name || state.selectedDataset)}</h2>` +
    `<p class="muted">${escapeHtml(dataset?.entityType || 'Entity')} · ${records?.total ?? items.length} record(s) · dataset ${badge(dataset?.status)}</p></div>` +
    `<div class="row-actions">${can(state.context, 'records:write') ? '<button class="primary-button" type="button" data-action="new-record">New record <span>→</span></button><button class="ghost-button" type="button" data-action="bulk-records">Bulk import</button>' : ''}</div></div>` +
    `<div class="toolbar"><select id="record-dataset" class="input" aria-label="Choose dataset">${state.datasets.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === state.selectedDataset ? ' selected' : ''}>${escapeHtml(item.name || item.id)} (${escapeHtml(item.status || 'draft')})</option>`).join('')}</select>` +
    `<button class="ghost-button" type="button" data-action="retry" data-id="records">Refresh</button>` +
    `<span class="muted">Latest 100 records</span></div>` +
    dataTable(['Record', 'Data', 'Version', 'Published', 'Updated', 'Actions'], items.map(recordRow), { empty: 'No records in this dataset yet.' }) +
    `</section>`
  );
  $('record-dataset')?.addEventListener('change', (event) => {
    state.selectedDataset = event.target.value;
    render();
  });
}

function recordRow(record) {
  const actions = [];
  if (can(state.context, 'records:write')) {
    actions.push(actionButton('edit-record', record.id, 'Edit'));
    actions.push(actionButton('delete-record', record.id, 'Delete', { variant: 'bad' }));
  }
  return `<tr><td class="mono">${escapeHtml(record.id)}</td>` +
    `<td><code class="json-preview">${escapeHtml(previewJson(record.data, 120))}</code></td>` +
    `<td class="mono">${escapeHtml(record.version ?? '—')}</td>` +
    `<td>${record.published === false ? '<span class="pill warn">Withheld</span>' : '<span class="pill ok">Inherited</span>'}</td>` +
    `<td class="mono">${escapeHtml(relativeTime(record.updatedAt))}</td>` +
    `<td><div class="row-actions">${actions.join('') || '<span class="muted">Read only</span>'}</div></td></tr>`;
}

/* -------------------------------------------------------------------------- *
 * Moderation
 * -------------------------------------------------------------------------- */

async function renderModeration() {
  if (!can(state.context, 'moderation:read')) {
    setView(errorPanel({ status: 403, code: 'moderation_forbidden', message: 'Your role cannot open the review queue.' }));
    return;
  }
  const result = await api.get(`/v1/capabilities/management/review-queue?status=${encodeURIComponent(state.reviewStatus)}&limit=100`);
  const items = Array.isArray(result?.items) ? result.items : [];
  const tabs = ['pending', 'approved', 'rejected', 'all'].map((value) => (
    `<button class="tab${state.reviewStatus === value ? ' active' : ''}" type="button" data-action="review-tab" data-id="${value}">${escapeHtml(statusLabel(value === 'all' ? 'All' : value))}</button>`
  )).join('');
  const rows = items.map((dataset) => {
    const actions = [];
    if (state.reviewStatus === 'pending' && can(state.context, 'moderation:write')) {
      actions.push(actionButton('approve-review', dataset.id, 'Approve', { variant: 'ok' }));
      actions.push(actionButton('reject-review', dataset.id, 'Reject', { variant: 'bad' }));
    }
    if (can(state.context, 'records:read')) actions.push(actionButton('view-records', dataset.id, 'Records'));
    return `<tr><td><div class="dataset-name"><strong>${escapeHtml(dataset.name || dataset.id)}</strong><small class="mono">${escapeHtml(dataset.id)}</small></div></td>` +
      `<td>${badge(dataset.status)}</td><td>${badge(dataset.reviewStatus)}</td>` +
      `<td class="mono">${escapeHtml(relativeTime(dataset.reviewSubmittedAt))}</td>` +
      `<td>${escapeHtml(dataset.reviewNote || '—')}</td>` +
      `<td><div class="row-actions">${actions.join('') || '<span class="muted">Read only</span>'}</div></td></tr>`;
  }).join('');
  setView(
    `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">PEER REVIEW</p><h2>Publication moderation</h2>` +
    `<p class="muted">Operators submit public drafts; moderators approve or reject the metadata. Publication remains an operator action.</p></div></div>` +
    `<div class="tabs">${tabs}</div>` +
    dataTable(['Dataset', 'Status', 'Review', 'Submitted', 'Note', 'Actions'], rows.length ? [rows] : [], { empty: 'No datasets in this review lane.' }) +
    `</section>`
  );
}

/* -------------------------------------------------------------------------- *
 * Events
 * -------------------------------------------------------------------------- */

async function renderEvents() {
  const feed = await api.get('/v1/capabilities/events?limit=100');
  const items = Array.isArray(feed?.items) ? feed.items : [];
  const rows = items.map((item) => {
    const event = item.event || {};
    return `<tr><td class="mono">${escapeHtml(relativeTime(event.at))}</td>` +
      `<td><span class="audit-action">${escapeHtml(event.type || '—')}</span></td>` +
      `<td class="mono">${escapeHtml(event.datasetId || '—')}</td>` +
      `<td class="mono">${escapeHtml(event.recordId || '—')}</td>` +
      `<td class="mono">${escapeHtml(event.correlationId || '—')}</td></tr>`;
  }).join('');
  setView(
    `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">EVENT FEED</p><h2>Capability events</h2>` +
    `<p class="muted">Stream-backed, at-least-once. Cursor <code>${escapeHtml(feed?.nextCursor || '—')}</code>.</p></div>` +
    `<button class="ghost-button" type="button" data-action="retry" data-id="events">Refresh</button></div>` +
    dataTable(['When', 'Type', 'Dataset', 'Record', 'Correlation'], rows.length ? [rows] : [], { empty: 'No events have been emitted yet.' }) +
    `</section>`
  );
}

/* -------------------------------------------------------------------------- *
 * Audit and usage
 * -------------------------------------------------------------------------- */

async function renderAudit() {
  const query = new URLSearchParams({ limit: '100' });
  for (const [key, value] of Object.entries(state.auditQuery)) {
    if (value) query.set(key, value);
  }
  const [audit, usage] = await Promise.allSettled([
    api.get(`/v1/capabilities/audit?${query.toString()}`),
    api.get('/v1/capabilities/usage'),
  ]);
  if (audit.status === 'rejected') throw audit.reason;
  const items = Array.isArray(audit.value?.items) ? audit.value.items : [];
  const usageValue = usage.status === 'fulfilled' ? usage.value : null;
  const usageTotals = usageValue?.totals || {};
  const rows = items.map((item) => (
    `<tr><td class="mono">${escapeHtml(relativeTime(item.at))}</td>` +
    `<td>${escapeHtml(item.actor || '—')}</td>` +
    `<td><span class="audit-action">${escapeHtml(item.action || '—')}</span></td>` +
    `<td class="mono">${escapeHtml(item.datasetId || '—')}</td>` +
    `<td class="mono">${escapeHtml(item.recordId || '—')}</td>` +
    `<td class="mono">${escapeHtml(item.correlationId || '—')}</td></tr>`
  )).join('');
  setView(
    `<section class="metric-grid">` +
    metricCard('◎', 'cyan', formatNumber(audit.value?.total || items.length), 'Audit entries') +
    metricCard('↗', 'violet', formatNumber(usageTotals.requests || 0), 'API requests') +
    metricCard('⧉', 'amber', formatNumber(usageTotals.errors || 0), 'Usage errors') +
    metricCard('⌁', 'green', usageValue?.window || 'current', 'Usage window') +
    `</section>` +
    `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">GOVERNANCE</p><h2>Mutation audit</h2></div></div>` +
    `<form id="audit-filter" class="toolbar"><input class="input" name="action" placeholder="Action (e.g. dataset.review)" value="${escapeHtml(state.auditQuery.action || '')}" />` +
    `<input class="input" name="actor" placeholder="Actor" value="${escapeHtml(state.auditQuery.actor || '')}" />` +
    `<input class="input" name="datasetId" placeholder="Dataset id" value="${escapeHtml(state.auditQuery.datasetId || '')}" />` +
    `<button class="ghost-button" type="submit">Apply filters</button></form>` +
    dataTable(['When', 'Actor', 'Action', 'Dataset', 'Record', 'Correlation'], rows.length ? [rows] : [], { empty: 'No audit entries match these filters.' }) +
    `</section>`
  );
  $('audit-filter')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    state.auditQuery = {
      action: String(form.get('action') || '').trim(),
      actor: String(form.get('actor') || '').trim(),
      datasetId: String(form.get('datasetId') || '').trim(),
    };
    render();
  });
}

/* -------------------------------------------------------------------------- *
 * Settings
 * -------------------------------------------------------------------------- */

async function renderSettings() {
  const health = await api.get('/health').catch(() => null);
  const context = state.context || {};
  const scopes = context.auth?.scopes || [];
  setView(
    `<section class="split-grid"><article class="panel"><p class="eyebrow">VERIFIED PRINCIPAL</p><h2>${escapeHtml(context.user?.email || context.user?.id || '—')}</h2>` +
    `<p class="muted">Roles: ${escapeHtml((context.roles || []).join(', ') || 'none')}</p>` +
    `<dl class="kv"><dt>Tenant</dt><dd class="mono">${escapeHtml(context.tenant || '—')}</dd>` +
    `<dt>Account</dt><dd class="mono">${escapeHtml(context.account || '—')}</dd>` +
    `<dt>Organization</dt><dd class="mono">${escapeHtml(context.org || '—')}</dd>` +
    `<dt>Credential</dt><dd class="mono">${escapeHtml(context.auth?.kind || '—')}</dd></dl>` +
    `<p class="eyebrow">SCOPES</p><div class="permission-list">${scopes.length ? scopes.map((scope) => `<span class="permission">${escapeHtml(scope)}</span>`).join('') : '<span class="muted">Scope-less Tier-1 key</span>'}</div></article>` +
    `<article class="panel"><p class="eyebrow">DEPENDENCIES</p><h2>${health?.status === 'ok' ? 'Tier chain healthy' : 'Tier chain degraded'}</h2>` +
    `<p class="muted">The console reads the public boundary only. Tier-1 details stay behind the capabilities API.</p>` +
    `<dl class="kv"><dt>Gateway</dt><dd>${health?.status === 'ok' ? '<span class="pill ok">OK</span>' : '<span class="pill bad">Check</span>'}</dd>` +
    `<dt>API base</dt><dd class="mono">${escapeHtml(location.origin)}</dd>` +
    `<dt>Docs</dt><dd><a class="text-link" href="https://github.com/vku-open-source-2026/SynapseDX/blob/main/docs/API.md" target="_blank" rel="noreferrer">API reference ↗</a></dd></dl>` +
    `<div class="row-actions"><button class="ghost-button" type="button" data-action="logout-all">Sign out all sessions</button>` +
    `<button class="ghost-button" type="button" data-action="logout">Sign out</button></div></article></section>` +
    `<section class="panel"><p class="eyebrow">ROLE MODEL</p><h2>Management roles</h2>` +
    `<div class="role-grid"><div><strong>Administrator</strong><p class="muted">Full control, tenant settings and role visibility.</p></div>` +
    `<div><strong>Operator</strong><p class="muted">Datasets, records, publication and outbox recovery.</p></div>` +
    `<div><strong>Moderator</strong><p class="muted">Peer review, approval/rejection and audit review.</p></div>` +
    `<div><strong>Manager</strong><p class="muted">Read-only dashboards, audit and usage reporting.</p></div></div></section>`
  );
}

/* -------------------------------------------------------------------------- *
 * Modal helpers
 * -------------------------------------------------------------------------- */

let activeModal = null;
let escapeKeyHandler = null;

function closeModal(cancelled = false) {
  const root = $('modal-root');
  const modal = activeModal;
  activeModal = null;
  root.hidden = true;
  root.innerHTML = '';
  if (escapeKeyHandler) document.removeEventListener('keydown', escapeKeyHandler);
  escapeKeyHandler = null;
  if (cancelled && typeof modal?.onCancel === 'function') modal.onCancel();
}

function openModal({ title, body, submitLabel = 'Save', danger = false, hideSubmit = false, onSubmit, onCancel }) {
  const root = $('modal-root');
  activeModal = { onSubmit, onCancel };
  root.hidden = false;
  root.innerHTML =
    `<div class="modal-backdrop" data-modal-close></div>` +
    `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">` +
    `<header class="modal-header"><div><p class="eyebrow">CONTROL PLANE</p><h2 id="modal-title">${escapeHtml(title)}</h2></div>` +
    `<button class="icon-button" type="button" data-modal-close aria-label="Close">×</button></header>` +
    `<form id="modal-form" novalidate>${body}` +
    `<p class="form-error" id="modal-error" role="alert" hidden></p>` +
    `<footer class="modal-footer"><button class="ghost-button" type="button" data-modal-close>Cancel</button>` +
    `${hideSubmit ? '' : `<button class="primary-button${danger ? ' danger' : ''}" type="submit">${escapeHtml(submitLabel)}</button>`}</footer></form></section>`;
  root.querySelectorAll('[data-modal-close]').forEach((element) => {
    element.addEventListener('click', () => closeModal(true));
  });
  escapeKeyHandler = (event) => {
    if (event.key === 'Escape') closeModal(true);
  };
  document.addEventListener('keydown', escapeKeyHandler);
  const form = $('modal-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('modal-error');
    error.hidden = true;
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      await onSubmit?.(form);
    } catch (failure) {
      error.textContent = failure?.message || 'The request failed.';
      error.hidden = false;
    } finally {
      if (submit) submit.disabled = false;
    }
  });
  const first = form.querySelector('input, textarea, select, button');
  first?.focus();
}

function confirmModal({ title, message, label = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    openModal({
      title,
      body: `<p class="confirm-copy">${escapeHtml(message)}</p>`,
      submitLabel: label,
      danger,
      onSubmit: async () => {
        settled = true;
        closeModal(false);
        resolve(true);
      },
      onCancel: () => {
        if (!settled) resolve(false);
      },
    });
  });
}

function field(label, name, value = '', { type = 'text', required = false, placeholder = '', help = '', readonly = false } = {}) {
  return `<label class="field"><span>${escapeHtml(label)}${required ? ' *' : ''}</span>` +
    `<input class="input" name="${escapeHtml(name)}" type="${escapeHtml(type)}" value="${escapeHtml(value)}"` +
    `${required ? ' required' : ''}${readonly ? ' readonly' : ''}${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ''} />` +
    `${help ? `<small>${escapeHtml(help)}</small>` : ''}</label>`;
}

function textareaField(label, name, value = '', { required = false, rows = 10, placeholder = '', help = '' } = {}) {
  return `<label class="field"><span>${escapeHtml(label)}${required ? ' *' : ''}</span>` +
    `<textarea class="input mono" name="${escapeHtml(name)}" rows="${rows}"${required ? ' required' : ''}` +
    `${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ''}>${escapeHtml(value)}</textarea>` +
    `${help ? `<small>${escapeHtml(help)}</small>` : ''}</label>`;
}

function checkboxField(label, name, checked = false, help = '') {
  return `<label class="checkbox"><input type="checkbox" name="${escapeHtml(name)}"${checked ? ' checked' : ''} />` +
    `<span>${escapeHtml(label)}</span></label>${help ? `<small class="field-help">${escapeHtml(help)}</small>` : ''}`;
}

async function openLoginModal() {
  openModal({
    title: 'Sign in to SynapseDX',
    body: `<p class="muted">Use your Tier-1 IAM account. In production, passwords and sessions are handled by the identity service; the console never stores them.</p>` +
      field('Email', 'email', '', { type: 'email', required: true, placeholder: 'operator@example.com' }) +
      field('Password', 'password', '', { type: 'password', required: true, placeholder: '••••••••' }) +
      field('Organization slug', 'orgSlug', '', { placeholder: 'optional when the deployment is bound', help: 'Leave empty if the Tier-2 deployment is bound to one organization.' }),
    submitLabel: 'Sign in',
    hideSubmit: false,
    onSubmit: async (form) => {
      const data = new FormData(form);
      const email = String(data.get('email') || '').trim();
      const password = String(data.get('password') || '');
      const orgSlug = String(data.get('orgSlug') || '').trim();
      if (!email || !password) throw new Error('Email and password are required.');
      const result = await api.post('/v1/capabilities/auth/login', {
        email, password, ...(orgSlug ? { orgSlug } : {}),
      });
      const accessToken = result?.accessToken || result?.access_token;
      const refreshToken = result?.refreshToken || result?.refresh_token;
      if (!accessToken) throw new Error('The identity service did not return an access token.');
      saveSession({ accessToken, refreshToken, obtainedAt: new Date().toISOString() });
      await refreshContext();
      if (!state.context) throw new Error('The session could not be verified by the capability service.');
      closeModal(false);
      state.view = 'overview';
      location.hash = '#overview';
      renderShell();
      await render();
      showToast(`Signed in as ${state.context.user?.email || state.context.user?.id || 'operator'}.`);
    },
  });
}

function openDatasetForm(dataset = null) {
  const editing = Boolean(dataset);
  openModal({
    title: editing ? `Edit ${dataset.name || dataset.id}` : 'New dataset',
    body: (!editing ? field('Slug', 'slug', dataset?.id || '', { placeholder: 'city-incidents', help: 'Lower-case id used in URLs and NGSI-LD entity ids.' }) : '') +
      field('Name', 'name', dataset?.name || '', { required: true }) +
      field('Entity type', 'entityType', dataset?.entityType || 'Incident', { required: true, help: 'NGSI-LD entity type exposed on the public projection.' }) +
      field('License', 'license', dataset?.license || 'CC-BY-4.0', { required: true, help: 'SPDX or LicenseRef identifier from the Tier-1 catalog.' }) +
      field('License URL', 'licenseUrl', dataset?.licenseUrl || '', { type: 'url', placeholder: 'https://…' }) +
      textareaField('Description', 'description', dataset?.description || '', { rows: 3 }) +
      field('Schema version', 'schemaVersion', dataset?.schemaVersion || '1.0.0', { placeholder: '1.0.0' }) +
      field('Retention days', 'retentionDays', dataset?.retentionDays ?? '', { type: 'number', placeholder: 'optional' }) +
      checkboxField('Public dataset', 'public', dataset?.public === true, 'Public datasets can be published to SynapseLDS after a moderator approves the review lane.'),
    submitLabel: editing ? 'Save changes' : 'Create dataset',
    onSubmit: async (form) => {
      const data = new FormData(form);
      const payload = {
        name: String(data.get('name') || '').trim(),
        entityType: String(data.get('entityType') || '').trim(),
        license: String(data.get('license') || '').trim(),
        description: String(data.get('description') || '').trim(),
        schemaVersion: String(data.get('schemaVersion') || '').trim() || '1.0.0',
        public: data.get('public') === 'on',
      };
      const licenseUrl = String(data.get('licenseUrl') || '').trim();
      if (licenseUrl) payload.licenseUrl = licenseUrl;
      const retention = String(data.get('retentionDays') || '').trim();
      if (retention) payload.retentionDays = Number(retention);
      if (!editing) {
        const slug = String(data.get('slug') || '').trim();
        if (slug) payload.slug = slug;
      }
      if (editing) {
        await api.patch(`/v1/capabilities/datasets/${encodeURIComponent(dataset.id)}`, payload);
        showToast('Dataset updated.');
      } else {
        await api.post('/v1/capabilities/datasets', payload);
        showToast('Dataset created as a draft.');
      }
      closeModal(false);
      await render();
    },
  });
}

function openRecordForm(record = null) {
  const dataset = state.datasets.find((item) => item.id === state.selectedDataset);
  const editing = Boolean(record);
  openModal({
    title: editing ? `Edit record ${record.id}` : 'New record',
    body: field('Record id', 'recordId', record?.id || '', { placeholder: 'generated when empty', readonly: editing }) +
      textareaField('Data (JSON object)', 'data', JSON.stringify(record?.data || {}, null, 2), {
        required: true, rows: 14, help: 'Stored under the record data envelope. Publication follows the dataset unless overridden.',
      }) +
      (dataset?.status === 'published' ? checkboxField('Publish this record', 'publish', record?.published !== false, 'Only applies while the dataset is public and published.') : ''),
    submitLabel: editing ? 'Save record' : 'Create record',
    onSubmit: async (form) => {
      const data = new FormData(form);
      const payload = parseJsonObject(String(data.get('data') || ''), 'data');
      if (editing) {
        await api.patch(`/v1/capabilities/datasets/${encodeURIComponent(state.selectedDataset)}/records/${encodeURIComponent(record.id)}`, {
          data: payload,
          ifVersion: record.version,
        });
        showToast('Record updated.');
      } else {
        const id = String(data.get('recordId') || '').trim();
        await api.post(`/v1/capabilities/datasets/${encodeURIComponent(state.selectedDataset)}/records`, {
          ...(id ? { id } : {}),
          data: payload,
          ...(dataset?.status === 'published' ? { publish: data.get('publish') === 'on' } : {}),
        });
        showToast('Record created.');
      }
      closeModal(false);
      await render();
    },
  });
}

function openBulkForm() {
  openModal({
    title: 'Bulk import records',
    body: textareaField('Records (JSON array, max 100)', 'records', '[\n  { "data": { "name": "Example" } }\n]', {
      required: true, rows: 16, help: 'Each item may contain id, data and publish. Errors are reported per index.',
    }),
    submitLabel: 'Import records',
    onSubmit: async (form) => {
      const raw = String(new FormData(form).get('records') || '');
      let entries;
      try { entries = JSON.parse(raw); } catch { throw new Error('records must be valid JSON'); }
      if (!Array.isArray(entries) || !entries.length) throw new Error('records must be a non-empty JSON array');
      if (entries.length > 100) throw new Error('at most 100 records per import');
      const result = await api.post(`/v1/capabilities/datasets/${encodeURIComponent(state.selectedDataset)}/records/bulk`, { records: entries });
      closeModal(false);
      await render();
      showToast(`Imported ${result?.total ?? 0} record(s)${result?.errors?.length ? `; ${result.errors.length} failed` : ''}.`, result?.errors?.length ? 'warn' : 'ok');
    },
  });
}

function openReviewModal(dataset, decision) {
  const rejecting = decision === 'reject';
  openModal({
    title: rejecting ? `Reject ${dataset.name || dataset.id}` : `Approve ${dataset.name || dataset.id}`,
    body: `<p class="muted">${rejecting
      ? 'The operator will see this note and can revise the dataset before resubmitting it.'
      : 'Approval records the review decision. An operator still owns the publish action.'}</p>` +
      textareaField(rejecting ? 'Reason (required)' : 'Review note', 'note', '', { required: rejecting, rows: 4 }),
    submitLabel: rejecting ? 'Reject dataset' : 'Approve dataset',
    danger: rejecting,
    onSubmit: async (form) => {
      const note = String(new FormData(form).get('note') || '').trim();
      if (rejecting && note.length < 3) throw new Error('A reason is required to reject a dataset.');
      await api.post(`/v1/capabilities/management/datasets/${encodeURIComponent(dataset.id)}/${decision}`, { ...(note ? { note } : {}) });
      closeModal(false);
      await render();
      showToast(rejecting ? 'Dataset rejected with a review note.' : 'Dataset approved.');
    },
  });
}

function openSubmitReviewModal(dataset) {
  openModal({
    title: `Submit ${dataset.name || dataset.id} for review`,
    body: `<p class="muted">A moderator will review the license, schema and public projection before the dataset is eligible for publication.</p>` +
      textareaField('Note for the moderator', 'note', '', { rows: 4, placeholder: 'optional context' }),
    submitLabel: 'Submit for review',
    onSubmit: async (form) => {
      const note = String(new FormData(form).get('note') || '').trim();
      await api.post(`/v1/capabilities/management/datasets/${encodeURIComponent(dataset.id)}/submit-review`, { ...(note ? { note } : {}) });
      closeModal(false);
      await render();
      showToast('Dataset submitted for peer review.');
    },
  });
}

/* -------------------------------------------------------------------------- *
 * Actions
 * -------------------------------------------------------------------------- */

async function findDataset(id) {
  return state.datasets.find((dataset) => dataset.id === id) || await api.get(`/v1/capabilities/datasets/${encodeURIComponent(id)}`);
}

async function handleAction(action, id) {
  if (action === 'login') return openLoginModal();
  if (action === 'logout') {
    try {
      if (state.session?.refreshToken) await api.post('/v1/capabilities/auth/logout', { refreshToken: state.session.refreshToken });
    } catch { /* local logout must still work */ }
    clearSession();
    renderShell();
    await render();
    showToast('Signed out.');
    return;
  }
  if (action === 'logout-all') {
    if (!state.session?.refreshToken) throw new Error('No refresh token is available for this session.');
    if (!(await confirmModal({ title: 'Sign out all sessions?', message: 'This revokes every refresh token for the account.', label: 'Sign out all', danger: true }))) return;
    await api.post('/v1/capabilities/auth/logout-all', { refreshToken: state.session.refreshToken });
    clearSession();
    renderShell();
    await render();
    showToast('All sessions revoked.');
    return;
  }
  if (action === 'retry') {
    state.view = id || state.view;
    return render();
  }
  if (action === 'new-dataset') return openDatasetForm();
  if (action === 'edit-dataset') return openDatasetForm(await findDataset(id));
  if (action === 'submit-review') return openSubmitReviewModal(await findDataset(id));
  if (action === 'review-tab') {
    state.reviewStatus = id;
    return render();
  }
  if (action === 'approve-review') return openReviewModal(await findDataset(id), 'approve');
  if (action === 'reject-review') return openReviewModal(await findDataset(id), 'reject');
  if (action === 'view-records') {
    state.selectedDataset = id;
    if (state.view === 'records') return render();
    location.hash = '#records';
    return;
  }
  if (action === 'publish-dataset') {
    const dataset = await findDataset(id);
    if (!(await confirmModal({ title: `Publish ${dataset.name || id}?`, message: 'The public NGSI-LD projection will be created or refreshed. Private records stay private.', label: 'Publish', danger: false }))) return;
    await api.post(`/v1/capabilities/datasets/${encodeURIComponent(id)}/publish`);
    await render();
    showToast('Dataset published.');
    return;
  }
  if (action === 'revoke-dataset') {
    const dataset = await findDataset(id);
    if (!(await confirmModal({ title: `Revoke ${dataset.name || id}?`, message: 'The public datasource and entities will be deleted. Records remain in the private store.', label: 'Revoke', danger: true }))) return;
    await api.post(`/v1/capabilities/datasets/${encodeURIComponent(id)}/revoke`);
    await render();
    showToast('Dataset revoked.');
    return;
  }
  if (action === 'delete-dataset') {
    const dataset = await findDataset(id);
    if (!(await confirmModal({ title: `Delete ${dataset.name || id}?`, message: 'The dataset and all of its records will be permanently deleted. This cannot be undone.', label: 'Delete forever', danger: true }))) return;
    await api.del(`/v1/capabilities/datasets/${encodeURIComponent(id)}?purgeRecords=true`);
    await render();
    showToast('Dataset deleted.');
    return;
  }
  if (action === 'flush-events') {
    const result = await api.post(`/v1/capabilities/events/outbox/flush?datasetId=${encodeURIComponent(id)}`);
    await render();
    showToast(result?.pending ? `${result.pending} event(s) still pending.` : 'Outbox flushed.');
    return;
  }
  if (action === 'new-record') return openRecordForm();
  if (action === 'bulk-records') return openBulkForm();
  if (action === 'edit-record') {
    const record = await api.get(`/v1/capabilities/datasets/${encodeURIComponent(state.selectedDataset)}/records/${encodeURIComponent(id)}`);
    return openRecordForm(record);
  }
  if (action === 'delete-record') {
    if (!(await confirmModal({ title: `Delete record ${id}?`, message: 'The record and its public entity will be removed.', label: 'Delete record', danger: true }))) return;
    await api.del(`/v1/capabilities/datasets/${encodeURIComponent(state.selectedDataset)}/records/${encodeURIComponent(id)}`);
    await render();
    showToast('Record deleted.');
  }
}

document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-nav]');
  if (nav) {
    event.preventDefault();
    location.hash = `#${nav.dataset.nav}`;
    return;
  }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  event.preventDefault();
  target.disabled = true;
  try {
    await handleAction(target.dataset.action, target.dataset.id);
  } catch (error) {
    showToast(error?.message || 'The action failed.', 'bad');
  } finally {
    target.disabled = false;
  }
});

void boot();
