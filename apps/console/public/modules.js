// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * H/P/D/I business-module views for the SynapseDX console. The module receives
 * the shell's state/api/render helpers so it can stay a pure view layer.
 */

export const MODULE_TABS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'people', label: 'People & KPIs' },
  { id: 'projects', label: 'Projects' },
  { id: 'forms', label: 'Forms & process' },
  { id: 'reports', label: 'Reports' },
  { id: 'quality', label: 'Data quality' },
  { id: 'ocr', label: 'OCR queue' },
  { id: 'agents', label: 'Agents' },
  { id: 'assistant', label: 'Assistant' },
];

function empty(text) {
  return `<div class="empty-state"><div class="empty-icon">◇</div><p class="muted">${text}</p></div>`;
}

function header(title, description, actions = '') {
  return `<div class="panel-heading"><div><p class="eyebrow">CAPABILITY MODULE</p><h2>${title}</h2>` +
    `<p class="muted">${description}</p></div><div class="row-actions">${actions}</div></div>`;
}

export async function renderModules(ctx) {
  const { state, setView, escapeHtml } = ctx;
  const tab = MODULE_TABS.some((item) => item.id === state.moduleTab) ? state.moduleTab : 'inbox';
  state.moduleTab = tab;
  const body = await moduleBody(ctx, tab);
  setView(
    `<section class="panel">` +
    header('Business capability modules', 'H-P-D-I modules share tenant scoping, audit and Tier-1 persistence. Each lane only loads what your role can open.') +
    `<div class="tabs">${MODULE_TABS.map((item) => `<button class="tab${item.id === tab ? ' active' : ''}" type="button" data-action="module-tab" data-id="${item.id}">${escapeHtml(item.label)}</button>`).join('')}</div>` +
    `<div id="module-body">${body}</div></section>`
  );
}

async function moduleBody(ctx, tab) {
  if (tab === 'inbox') return inbox(ctx);
  if (tab === 'workspace') return workspace(ctx);
  if (tab === 'people') return people(ctx);
  if (tab === 'projects') return projects(ctx);
  if (tab === 'forms') return forms(ctx);
  if (tab === 'reports') return reports(ctx);
  if (tab === 'quality') return quality(ctx);
  if (tab === 'ocr') return ocr(ctx);
  if (tab === 'agents') return agents(ctx);
  return assistant(ctx);
}

async function inbox(ctx) {
  const { api, dataTable, actionButton, badge, relativeTime, escapeHtml } = ctx;
  const [result, prefs] = await Promise.all([
    api.get('/v1/capabilities/inbox'),
    api.get('/v1/capabilities/notification-preferences'),
  ]);
  const items = Array.isArray(result?.items) ? result.items : [];
  const rows = items.map((item) => (
    `<tr><td><div class="dataset-name"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.module)}</small></div></td>` +
    `<td>${badge(item.status)}</td><td class="mono">${escapeHtml(relativeTime(item.createdAt))}</td>` +
    `<td><div class="row-actions">${item.status !== 'read' ? actionButton('inbox-read', item.id, 'Mark read') : ''}` +
    `${item.status !== 'archived' ? actionButton('inbox-archive', item.id, 'Archive') : ''}</div></td></tr>`
  ));
  const pref = prefs?.preferences || {};
  return header('Inbox and mentions', `${result?.unread || 0} unread · preferences are tenant-scoped and respected by fan-out.`,
    `<button class="ghost-button" type="button" data-action="prefs-toggle">${pref.muted ? 'Unmute' : 'Mute'} delivery</button>`) +
    dataTable(['Item', 'Status', 'Created', 'Actions'], rows.length ? rows : [], { empty: 'No inbox items yet. Mentions and assignments arrive here.' }) +
    `<div class="split-grid" class="mt-4"><article class="panel compact"><p class="eyebrow">PREFERENCES</p><h2>${pref.muted ? 'Muted' : 'Delivering'}</h2>` +
    `<p class="muted">Channels: ${escapeHtml((pref.channels || ['inbox']).join(', '))} · digest: ${escapeHtml(pref.digest || 'instant')}</p></article>` +
    `<article class="panel compact"><p class="eyebrow">MENTIONS</p><h2>Comments create inbox items</h2><p class="muted">Muted or quiet-hour recipients keep the item but skip external delivery.</p></article></div>`;
}

async function workspace(ctx) {
  const { api, escapeHtml, previewJson } = ctx;
  const result = await api.get('/v1/capabilities/workspaces');
  const workspaces = Array.isArray(result?.items) ? result.items : [];
  if (!workspaces.length) return header('Workspace and wiki', 'PARA folders, versioned pages, backlinks and attachments.') +
    empty('No workspace yet. Create one through POST /v1/capabilities/workspaces.');
  const pages = await Promise.all(workspaces.slice(0, 8).map((ws) =>
    api.get(`/v1/capabilities/workspaces/${encodeURIComponent(ws.id)}/pages`).catch(() => ({ items: [] }))));
  return header('Workspace and wiki', 'PARA folders, versioned pages, backlinks and attachments.') +
    `<div class="dataset-list">${workspaces.slice(0, 8).map((ws, index) => {
      const items = pages[index]?.items || [];
      return `<article class="dataset-card"><div><strong>${escapeHtml(ws.name)}</strong>` +
        `<small>${escapeHtml(ws.para)} · ${escapeHtml(ws.visibility)} · ${items.length} page${items.length === 1 ? '' : 's'}</small></div>` +
        `<span class="pill neutral">${escapeHtml(ws.owner)}</span></article>` +
        (items.length ? `<div class="dataset-list">${items.slice(0, 6).map((page) => `<div class="dataset-row"><div><strong>${escapeHtml(page.title)}</strong><small>${escapeHtml(page.folder)} · v${page.versions?.length || 0} history</small></div><span class="pill ${page.attachments?.length ? 'ok' : 'neutral'}">${page.attachments?.length || 0} files</span></div>`).join('')}</div>` : '');
    }).join('')}</div>`;
}

async function people(ctx) {
  const { api, dataTable, escapeHtml } = ctx;
  const [directory, kpis] = await Promise.all([
    api.get('/v1/capabilities/people'),
    api.get('/v1/capabilities/kpis'),
  ]);
  const personRows = (directory?.items || []).slice(0, 50).map((person) => (
    `<tr><td><div class="dataset-name"><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.email || person.subject)}</small></div></td>` +
    `<td class="mono">${escapeHtml(person.manager || '—')}</td><td>${escapeHtml(person.title || '—')}</td></tr>`
  ));
  const kpiRows = (kpis?.items || []).slice(0, 50).map((kpi) => {
    const pct = Math.max(0, Math.min(100, Math.round((kpi.progress || 0) * 100)));
    return `<tr><td><div class="dataset-name"><strong>${escapeHtml(kpi.name)}</strong><small>${escapeHtml(kpi.period)}</small></div></td>` +
      `<td>${escapeHtml(String(kpi.latestValue ?? '—'))} / ${escapeHtml(String(kpi.target))}</td>` +
      `<td><span class="pill ${pct >= 100 ? 'ok' : pct >= 50 ? 'warn' : 'neutral'}">${pct}%</span></td></tr>`;
  });
  return header('People, goals and timesheets', 'Directory entries link to verified IAM subjects; KPI progress comes only from check-ins.') +
    `<div class="split-grid"><article class="panel compact"><p class="eyebrow">DIRECTORY</p><h2>People</h2>` +
    dataTable(['Person', 'Manager', 'Title'], personRows.length ? personRows : [], { empty: 'No people linked yet.' }) + `</article>` +
    `<article class="panel compact"><p class="eyebrow">KPIS</p><h2>Goal progress</h2>` +
    dataTable(['KPI', 'Value', 'Progress'], kpiRows.length ? kpiRows : [], { empty: 'No KPI check-ins yet.' }) + `</article></div>`;
}

async function projects(ctx) {
  const { api, dataTable, badge, escapeHtml } = ctx;
  const [result, capacity] = await Promise.all([
    api.get('/v1/capabilities/projects'),
    api.get('/v1/capabilities/project-capacity').catch(() => ({ items: [] })),
  ]);
  const rows = (result?.items || []).slice(0, 50).map((project) => (
    `<tr><td><div class="dataset-name"><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.program || 'portfolio')}</small></div></td>` +
    `<td>${escapeHtml(project.startDate?.slice(0, 10) || '—')} → ${escapeHtml(project.endDate?.slice(0, 10) || '—')}</td>` +
    `<td>${badge(project.gates?.some((gate) => gate.status !== 'approved') ? 'pending' : 'approved')}</td>` +
    `<td>${escapeHtml(String(project.stage || 1))}</td></tr>`
  ));
  const capacityRows = (capacity?.items || []).slice(0, 50).map((row) => (
    `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(String(row.hours))}h</td>` +
    `<td><span class="pill ${row.overAllocated ? 'bad' : 'ok'}">${row.overAllocated ? 'Over-allocated' : 'Within capacity'}</span></td></tr>`
  ));
  return header('Projects and portfolio', 'Dependencies reject cycles, stage gates use HITL and capacity is derived from approved timesheets.') +
    dataTable(['Project', 'Dates', 'Gates', 'Stage'], rows.length ? rows : [], { empty: 'No projects yet.' }) +
    `<div class="panel compact" class="mt-4"><p class="eyebrow">CAPACITY</p><h2>Allocation</h2>` +
    dataTable(['Person', 'Approved hours', 'Signal'], capacityRows.length ? capacityRows : [], { empty: 'No approved timesheets yet.' }) + `</div>`;
}

async function forms(ctx) {
  const { api, dataTable, badge, actionButton, escapeHtml } = ctx;
  const [formResult, processResult, instanceResult] = await Promise.all([
    api.get('/v1/capabilities/forms'),
    api.get('/v1/capabilities/processes'),
    api.get('/v1/capabilities/process-instances').catch(() => ({ items: [] })),
  ]);
  const formRows = (formResult?.items || []).slice(0, 50).map((form) => (
    `<tr><td><div class="dataset-name"><strong>${escapeHtml(form.name)}</strong><small>v${form.version} · ${(form.schema?.required || []).length} required</small></div></td>` +
    `<td>${badge(form.published ? 'published' : 'draft')}</td>` +
    `<td><div class="row-actions">${actionButton('form-preview', form.id, 'Preview')}</div></td></tr>`
  ));
  const processRows = (processResult?.items || []).slice(0, 50).map((process) => (
    `<tr><td><div class="dataset-name"><strong>${escapeHtml(process.name)}</strong><small>v${process.version} · ${process.nodes?.length || 0} nodes</small></div></td>` +
    `<td>${badge(process.published ? 'published' : 'draft')}</td>` +
    `<td><div class="row-actions">${actionButton('process-inspect', process.id, 'Inspect')}</div></td></tr>`
  ));
  const running = (instanceResult?.items || []).filter((instance) => instance.status === 'running');
  return header('Forms and process', 'Versioned JSON-schema forms and process definitions; running instances keep their start version.') +
    `<div class="split-grid"><article class="panel compact"><p class="eyebrow">FORMS</p><h2>Form builder</h2>` +
    dataTable(['Form', 'Status', ''], formRows.length ? formRows : [], { empty: 'No forms yet.' }) + `</article>` +
    `<article class="panel compact"><p class="eyebrow">PROCESSES</p><h2>Process inspector</h2>` +
    dataTable(['Process', 'Status', ''], processRows.length ? processRows : [], { empty: 'No process definitions yet.' }) + `</article></div>` +
    `<p class="muted" class="mt-3">${running.length} running instance${running.length === 1 ? '' : 's'}.</p>`;
}

async function reports(ctx) {
  const { api, dataTable, actionButton, escapeHtml } = ctx;
  const [reportResult, dashboardResult] = await Promise.all([
    api.get('/v1/capabilities/reports'),
    api.get('/v1/capabilities/dashboards').catch(() => ({ items: [] })),
  ]);
  const rows = (reportResult?.items || []).slice(0, 50).map((report) => (
    `<tr><td><div class="dataset-name"><strong>${escapeHtml(report.name)}</strong><small>${escapeHtml(report.kind)} · ${escapeHtml(report.datasetId || 'no dataset')}</small></div></td>` +
    `<td>${escapeHtml(report.schedule?.cron || 'manual')}</td>` +
    `<td><div class="row-actions">${actionButton('report-run', report.id, 'Run')}${actionButton('report-export', report.id, 'Export CSV')}</div></td></tr>`
  ));
  const dashboardRows = (dashboardResult?.items || []).slice(0, 50).map((dashboard) => (
    `<tr><td>${escapeHtml(dashboard.name)}</td><td>${dashboard.widgets?.length || 0} widgets</td>` +
    `<td><div class="row-actions">${actionButton('dashboard-open', dashboard.id, 'Open')}</div></td></tr>`
  ));
  return header('Reports and dashboards', 'Saved queries are permission-checked on every run; exports are idempotent and audited.') +
    dataTable(['Report', 'Schedule', ''], rows.length ? rows : [], { empty: 'No reports yet.' }) +
    `<div class="panel compact" class="mt-4"><p class="eyebrow">DASHBOARDS</p><h2>Decision views</h2>` +
    dataTable(['Dashboard', 'Widgets', ''], dashboardRows.length ? dashboardRows : [], { empty: 'No dashboards yet.' }) + `</div>`;
}

async function quality(ctx) {
  const { api, escapeHtml, previewJson } = ctx;
  const datasets = await api.get('/v1/capabilities/datasets?limit=1');
  const dataset = datasets?.[0];
  if (!dataset) return header('Data contracts and quality', 'Schema compatibility, quality rules and lineage.') + empty('No dataset yet.');
  const slug = encodeURIComponent(dataset.slug || dataset.id);
  const [contract, qualityResult] = await Promise.all([
    api.get(`/v1/capabilities/datasets/${slug}/contract`).catch(() => ({ contract: null })),
    api.get(`/v1/capabilities/datasets/${slug}/quality`).catch(() => ({ latest: null })),
  ]);
  const value = contract?.contract;
  const latest = qualityResult?.latest;
  return header('Data contracts and quality', `Dataset: ${escapeHtml(dataset.name || dataset.slug)}. Contract versions and the latest quality run.`) +
    `<div class="split-grid"><article class="panel compact"><p class="eyebrow">CONTRACT</p><h2>${value ? `v${value.version} · ${escapeHtml(value.compatibility)}` : 'No contract'}</h2>` +
    `<p class="muted">${value ? `${Object.keys(value.schema?.properties || value.schema || {}).length} fields · license ${escapeHtml(value.license || '—')}` : 'Publish a contract to pin schema, owner, SLA and retention.'}</p>` +
    `${value ? `<pre class="json-preview">${escapeHtml(previewJson(value.schema, 400))}</pre>` : ''}</article>` +
    `<article class="panel compact"><p class="eyebrow">QUALITY</p><h2>${latest ? `${escapeHtml(latest.status)} · ${latest.failed} failed` : 'No run yet'}</h2>` +
    `<p class="muted">${latest ? `${latest.checked} records checked` : 'Run quality rules before publishing when a gate is configured.'}</p></article></div>`;
}

async function ocr(ctx) {
  const { api, dataTable, actionButton, badge, escapeHtml } = ctx;
  const result = await api.get('/v1/capabilities/ocr/jobs');
  const jobs = (result?.items || []).slice(0, 50);
  if (!jobs.length) return header('OCR correction queue', 'Low-confidence fields pause for a human decision before becoming records.') +
    empty('No OCR jobs yet. Upload a document through POST /v1/capabilities/ocr/jobs.');
  return header('OCR correction queue', 'Low-confidence fields pause for a human decision before becoming records.') +
    jobs.map((job) => `<article class="panel compact"><div class="panel-heading"><div><p class="eyebrow">${escapeHtml(job.status)}</p><h2>${escapeHtml(job.fileId)}</h2>` +
      `<p class="muted">${job.redacted ? 'PII redacted' : 'PII not redacted'} · ${job.fields?.length || 0} fields</p></div>` +
      `<div class="row-actions"><button class="ghost-button" type="button" data-action="ocr-redact" data-id="${escapeHtml(job.id)}">Redact PII</button></div></div>` +
      dataTable(['Field', 'Value', 'Confidence', 'Status', ''], (job.fields || []).map((item) => (
        `<tr><td>${escapeHtml(item.name)}</td><td class="mono">${escapeHtml(String(item.value))}</td>` +
        `<td>${Math.round((item.confidence || 0) * 100)}%</td><td>${badge(item.status)}</td>` +
        `<td><div class="row-actions">${item.status === 'pending' ? actionButton('ocr-approve', `${job.id}:${item.name}`, 'Approve') + actionButton('ocr-reject', `${job.id}:${item.name}`, 'Reject', { variant: 'bad' }) : ''}</div></td></tr>`
      )), { empty: 'No fields extracted.' }) + `</article>`).join('');
}

async function agents(ctx) {
  const { api, dataTable, actionButton, badge, relativeTime, escapeHtml } = ctx;
  const [agentResult, runResult] = await Promise.all([
    api.get('/v1/capabilities/agents'),
    api.get('/v1/capabilities/agent-runs').catch(() => ({ items: [] })),
  ]);
  const agentRows = (agentResult?.items || []).slice(0, 50).map((agent) => (
    `<tr><td><div class="dataset-name"><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.model)} · ${escapeHtml(agent.promptVersion)}</small></div></td>` +
    `<td class="mono">${escapeHtml((agent.tools || []).join(', '))}</td><td>${badge(agent.riskTier)}</td>` +
    `<td><div class="row-actions">${actionButton('agent-kill', agent.id, 'Kill switch', { variant: 'bad' })}</div></td></tr>`
  ));
  const runRows = (runResult?.items || []).slice(0, 30).map((run) => (
    `<tr><td class="mono">${escapeHtml(run.agentId?.slice(0, 8) || '—')}</td><td>${badge(run.status)}</td>` +
    `<td>${run.costUsd ? `$${Number(run.costUsd).toFixed(6)}` : '—'}</td><td class="mono">${escapeHtml(relativeTime(run.createdAt))}</td></tr>`
  ));
  return header('Agent registry and traces', 'Tool allowlists are deny-by-default; high-risk runs pause for HITL and every trace is redacted.') +
    dataTable(['Agent', 'Tools', 'Risk', ''], agentRows.length ? agentRows : [], { empty: 'No agents registered yet.' }) +
    `<div class="panel compact" class="mt-4"><p class="eyebrow">RUNS</p><h2>Recent traces</h2>` +
    dataTable(['Agent', 'Status', 'Cost', 'When'], runRows.length ? runRows : [], { empty: 'No agent runs yet.' }) + `</div>`;
}

async function assistant(ctx) {
  const { api, escapeHtml } = ctx;
  const usage = await api.get('/v1/capabilities/rag/usage').catch(() => ({ queries: 0, costUsd: 0, noAnswer: 0 }));
  return header('Grounded assistant', 'Answers cite only sources the caller can open; prompt-injection patterns are refused.') +
    `<form id="rag-form" class="toolbar"><input id="rag-question" class="input" placeholder="Ask a question about accessible workspace, datasets or files…" aria-label="Question" />` +
    `<button class="primary-button" type="submit">Ask <span>→</span></button></form>` +
    `<div id="rag-answer" class="panel compact" class="mt-4"><p class="muted">Answers will appear here with numbered citations.</p></div>` +
    `<p class="muted" class="mt-3">${usage.queries || 0} queries · $${Number(usage.costUsd || 0).toFixed(6)} metered · ${usage.noAnswer || 0} no-answer paths</p>`;
}

export function bindModules(ctx) {
  const { state, $ } = ctx;
  if (state.moduleTab !== 'assistant') return;
  const form = $('rag-form');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const question = String($('rag-question')?.value || '').trim();
    if (question) ask(ctx, question);
  });
}

async function ask(ctx, question) {
  const { api, $, escapeHtml } = ctx;
  const target = $('rag-answer');
  if (target) target.innerHTML = '<p class="muted">Retrieving accessible sources…</p>';
  try {
    const result = await api.post('/v1/capabilities/rag/query', { question });
    if (!target) return;
    target.innerHTML = `<p class="eyebrow">ANSWER</p><h2>${result.noAnswer ? 'No grounded answer' : `Confidence ${Math.round((result.confidence || 0) * 100)}%`}</h2>` +
      `<p>${escapeHtml(result.answer)}</p>` +
      (result.citations?.length ? `<div class="permission-list">${result.citations.map((citation) => `<span class="permission">[${citation.index}] ${escapeHtml(citation.title)}</span>`).join('')}</div>` : '');
  } catch (error) {
    if (target) target.innerHTML = `<p class="form-error">${escapeHtml(error.message || 'The assistant is unavailable.')}</p>`;
  }
}

/** Handle module-specific actions; returns true when the action was consumed. */
export async function handleModuleAction(ctx, action, id) {
  const { api, render, showToast, openModal, confirmModal, field, previewJson, relativeTime, escapeHtml, dataTable, closeModal } = ctx;
  if (action === 'module-tab') {
    ctx.state.moduleTab = id;
    await render();
    return true;
  }
  if (action === 'prefs-toggle') {
    const current = await api.get('/v1/capabilities/notification-preferences');
    await api.put('/v1/capabilities/notification-preferences', { ...current.preferences, muted: !current.preferences?.muted });
    await render();
    showToast(current.preferences?.muted ? 'Delivery unmuted.' : 'Delivery muted.');
    return true;
  }
  if (action === 'inbox-read' || action === 'inbox-archive') {
    await api.post(`/v1/capabilities/inbox/${encodeURIComponent(id)}/${action === 'inbox-read' ? 'read' : 'archive'}`);
    await render();
    return true;
  }
  if (action === 'report-run') {
    const result = await api.post(`/v1/capabilities/reports/${encodeURIComponent(id)}/run`, {});
    openModal({
      title: result.report?.name || 'Report result', hideSubmit: true,
      body: `<p class="muted">${result.total} matching row${result.total === 1 ? '' : 's'} · generated ${escapeHtml(relativeTime(result.generatedAt))}</p>` +
        `<pre class="json-preview" class="scroll-preview">${escapeHtml(previewJson(result.rows, 4000))}</pre>`,
    });
    return true;
  }
  if (action === 'report-export') {
    const result = await api.post(`/v1/capabilities/reports/${encodeURIComponent(id)}/export`, { format: 'csv', idempotencyKey: `console-${Date.now()}` });
    const blob = new Blob([result.content || ''], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `report-${id}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast('CSV export generated.');
    return true;
  }
  if (action === 'dashboard-open') {
    const result = await api.get(`/v1/capabilities/dashboards/${encodeURIComponent(id)}/data`);
    openModal({
      title: result.dashboard?.name || 'Dashboard', hideSubmit: true,
      body: result.widgets.map((widget) => `<div class="panel compact"><p class="eyebrow">${escapeHtml(widget.report?.kind || 'widget')}</p><h2>${escapeHtml(widget.title || widget.report?.name || widget.reportId)}</h2>` +
        (widget.error ? `<p class="form-error">${escapeHtml(widget.error)}</p>` : `<pre class="json-preview" class="scroll-widget">${escapeHtml(previewJson(widget.rows, 2000))}</pre>`) + `</div>`).join('') || '<p class="muted">No widgets.</p>',
    });
    return true;
  }
  if (action === 'form-preview') {
    const result = await api.get(`/v1/capabilities/forms/${encodeURIComponent(id)}`);
    const form = result.form;
    const fields = Object.entries(form.schema?.properties || {}).map(([key, config]) => (
      `<label class="field"><span>${escapeHtml(config.title || key)}${(form.schema.required || []).includes(key) ? ' *' : ''}</span>` +
      `<input class="input" placeholder="${escapeHtml(config.type || 'string')}" ${config.readOnly ? 'readonly' : ''} />` +
      `${config.visibleWhen ? `<small>Visible when ${escapeHtml(config.visibleWhen.field)} = ${escapeHtml(String(config.visibleWhen.equals))}</small>` : ''}</label>`
    )).join('');
    openModal({ title: `Form preview · ${form.name}`, hideSubmit: true, body: fields || '<p class="muted">This schema has no fields.</p>' });
    return true;
  }
  if (action === 'process-inspect') {
    const result = await api.get('/v1/capabilities/processes');
    const process = (result.items || []).find((item) => item.id === id);
    if (!process) { showToast('Process not found', 'bad'); return true; }
    const nodes = (process.nodes || []).map((node) => `<tr><td class="mono">${escapeHtml(node.id)}</td><td>${escapeHtml(node.type)}</td><td class="mono">${escapeHtml(previewJson(node.config || node, 200))}</td></tr>`);
    openModal({ title: `Process inspector · ${process.name}`, hideSubmit: true, body: `<p class="muted">Version ${process.version} · ${escapeHtml(String(process.slaMinutes || 'no'))} minute SLA</p>` + dataTable(['Node', 'Type', 'Config'], nodes, { empty: 'No nodes.' }) });
    return true;
  }
  if (action === 'ocr-redact') {
    await api.post(`/v1/capabilities/ocr/jobs/${encodeURIComponent(id)}/redact`, {});
    await render();
    showToast('PII redacted across pages and extracted fields.');
    return true;
  }
  if (action === 'ocr-approve' || action === 'ocr-reject') {
    const [jobId, fieldName] = String(id).split(':');
    if (action === 'ocr-approve') {
      const result = await api.get(`/v1/capabilities/ocr/jobs/${encodeURIComponent(jobId)}`);
      const current = (result.job?.fields || []).find((item) => item.name === fieldName);
      openModal({
        title: `Approve ${fieldName}`,
        body: field('Corrected value', 'value', current?.value || '', { required: true }),
        submitLabel: 'Approve field',
        onSubmit: async (form) => {
          const data = new FormData(form);
          await api.post(`/v1/capabilities/ocr/jobs/${encodeURIComponent(jobId)}/fields/${encodeURIComponent(fieldName)}/correct`, { value: String(data.get('value') || ''), decision: 'approve' });
          closeModal(false);
          await render();
          showToast('Field approved.');
        },
      });
      return true;
    }
    if (!(await confirmModal({ title: `Reject ${fieldName}?`, message: 'The field stays out of the generated record and remains in the audit trail.', label: 'Reject field', danger: true }))) return true;
    await api.post(`/v1/capabilities/ocr/jobs/${encodeURIComponent(jobId)}/fields/${encodeURIComponent(fieldName)}/correct`, { decision: 'reject' });
    await render();
    showToast('Field rejected.');
    return true;
  }
  if (action === 'agent-kill') {
    if (!(await confirmModal({ title: 'Enable the agent kill switch?', message: 'New runs stop immediately and every paused run is cancelled for this tenant.', label: 'Enable kill switch', danger: true }))) return true;
    await api.post(`/v1/capabilities/agents/${encodeURIComponent(id)}/kill-switch`, { enabled: true });
    await render();
    showToast('Agent kill switch enabled.');
    return true;
  }
  return false;
}
