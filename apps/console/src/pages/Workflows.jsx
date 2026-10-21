/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Code, Empty, Err, Field, Input, ListSkeleton, Modal, PageTitle, Spinner, Table, TableSkeleton } from '../components/ui.jsx';
import WorkflowEditor from '../components/WorkflowEditor.jsx';
import { uid, webhookPathOf, describeCron, isWebhookType, isCronType } from '../lib/workflow-graph.js';

export default function Workflows() {
  const { headers } = useAuth();
  const [flows, setFlows] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [tplLoaded, setTplLoaded] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [tpl, setTpl] = useState('webhook-to-log');
  const [name, setName] = useState('console-demo');
  const [createBusy, setCreateBusy] = useState(false);
  // Selected workflow interaction
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState(null);
  const [execInput, setExecInput] = useState('{}');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionOut, setActionOut] = useState(null);
  const [execs, setExecs] = useState([]);
  const [execDetail, setExecDetail] = useState(null);
  const [execMore, setExecMore] = useState(false);
  const [execBusy, setExecBusy] = useState(false);
  const [execStatus, setExecStatus] = useState('');
  const EXEC_PAGE = 20;

  const execQuery = (id, offset) => ({
    workflowId: id,
    limit: EXEC_PAGE,
    ...(offset ? { offset } : {}),
    ...(execStatus ? { status: execStatus } : {}),
  });

  const reloadExecs = async (id) => {
    try {
      const e = await api.executions(execQuery(id, 0), headers);
      const items = Array.isArray(e) ? e : e?.data || [];
      setExecs(items);
      setExecMore(items.length >= EXEC_PAGE);
    } catch {
      /* executions refresh is best-effort */
    }
  };
  const [visualOpen, setVisualOpen] = useState(false);
  const [expandedNode, setExpandedNode] = useState(null);
  const selSeq = useRef(0);
  const selRef = useRef(null);

  // Webhook trigger + cron summary for the detail header (M7/M8).
  const webhookTrigger = (() => {
    if (!detail || !Array.isArray(detail.nodes)) return null;
    for (const n of detail.nodes) {
      if (!isWebhookType(n?.type)) continue;
      const path = webhookPathOf([n]);
      if (!path) continue;
      const raw = String(n?.parameters?.httpMethod || 'POST').toUpperCase();
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(raw) ? raw : 'POST';
      return { path, method };
    }
    return null;
  })();
  const cronSummary = (() => {
    if (!detail || !Array.isArray(detail.nodes)) return null;
    const cron = detail.nodes.find((n) => isCronType(n?.type));
    if (!cron) return null;
    try {
      const d = describeCron(cron.parameters || {});
      return d.nextRun ? d : { ...d, nextRun: null };
    } catch {
      return null;
    }
  })();

  const load = async () => {
    try {
      const t = await api.templates(headers);
      setTemplates(Array.isArray(t) ? t : []);
    } catch (e) {
      setErr(e);
    } finally {
      setTplLoaded(true);
    }
    try {
      setFlows(await api.workflows(headers));
    } catch {
      setFlows({ note: 'workflow engine unreachable (is workflow-service up?)' });
    }
  };

  useEffect(() => {
    load();
  }, [headers]);

  const create = async (e) => {
    e.preventDefault();
    if (createBusy) return;
    setCreateBusy(true);
    setErr(null);
    try {
      await api.createWorkflow(tpl, name, headers);
      setOpen(false);
      load();
    } catch (ex) {
      setErr(ex);
    } finally {
      setCreateBusy(false);
    }
  };

  const createBlank = async () => {
    if (createBusy) return;
    setCreateBusy(true);
    setErr(null);
    try {
      const taken = new Set(list.map((w) => w.name));
      let nm = 'untitled';
      for (let i = 2; taken.has(nm); i++) nm = `untitled ${i}`;
      const w = await api.createWorkflowRaw(nm, { nodes: [], connections: {} }, headers);
      await load();
      if (w && w.id) {
        await select(w.id);
        setVisualOpen(true);
      }
    } catch (ex) {
      setErr(ex);
    } finally {
      setCreateBusy(false);
    }
  };

  const list = Array.isArray(flows) ? flows : flows?.data || [];

  // P2: file import/export — portable JSON {name, nodes, connections, settings}.
  const importRef = useRef(null);
  const exportWorkflow = () => {
    if (!detail) return;
    const doc = { name: detail.name, nodes: detail.nodes || [], connections: detail.connections || {}, settings: detail.settings || {} };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(detail.name || 'workflow').replace(/[^A-Za-z0-9._-]+/g, '-')}.workflow.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const importWorkflow = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || createBusy) return;
    setCreateBusy(true);
    setErr(null);
    try {
      const raw = JSON.parse(await f.text());
      const doc = raw?.definition || raw;
      if (!doc || !Array.isArray(doc.nodes)) throw new Error('File must contain {name?, nodes[], connections?}');
      const taken = new Set(list.map((w) => w.name));
      let nm = String(raw?.name || doc.name || f.name.replace(/\.workflow\.json$|\.json$/, '') || 'imported').slice(0, 200);
      if (taken.has(nm)) {
        let i = 2;
        while (taken.has(`${nm} (${i})`)) i++;
        nm = `${nm} (${i})`;
      }
      const w = await api.createWorkflowRaw(nm, { nodes: doc.nodes, connections: doc.connections || {}, settings: doc.settings || {} }, headers);
      await load();
      if (w?.id) select(w.id);
    } catch (ex) {
      setErr(ex);
    } finally {
      setCreateBusy(false);
    }
  };

  const select = async (id) => {
    if (sel === id) {
      setSel(null);
      selRef.current = null;
      setDetail(null);
      return;
    }
    const my = ++selSeq.current;
    selRef.current = id;
    setSel(id);
    setDetail(null);
    setDetailErr(null);
    setActionOut(null);
    setExecDetail(null);
    setExecs([]);
    setExecMore(false);
    setExecStatus('');
    setExecInput('{}');
    try {
      const [d, e] = await Promise.all([
        api.workflow(id, headers),
        api.executions({ workflowId: id, limit: EXEC_PAGE }, headers).catch(() => ({ data: [] })),
      ]);
      if (selSeq.current !== my) return; // stale: user already picked another workflow
      setDetail(d);
      const items = Array.isArray(e) ? e : e?.data || [];
      setExecs(items);
      setExecMore(items.length >= EXEC_PAGE);
    } catch (ex) {
      if (selSeq.current === my) setDetailErr(ex);
    }
  };

  const loadMoreExecs = async () => {
    if (!sel || execBusy) return;
    setExecBusy(true);
    try {
      const e = await api.executions(execQuery(sel, execs.length), headers);
      const items = Array.isArray(e) ? e : e?.data || [];
      setExecs((xs) => [...xs, ...items]);
      setExecMore(items.length >= EXEC_PAGE);
    } catch (ex) {
      setDetailErr(ex);
    } finally {
      setExecBusy(false);
    }
  };

  const applyExecStatus = (v) => {
    setExecStatus(v);
    setExecDetail(null);
    setExecs([]);
  };

  useEffect(() => {
    if (!sel) return;
    reloadExecs(sel);
  }, [execStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const doAction = async (fn, label) => {
    if (!sel || actionBusy) return null;
    const id = sel;
    setActionBusy(true);
    setDetailErr(null);
    try {
      const r = await fn();
      if (selRef.current !== id) return r; // user moved on — don't paint stale detail
      setActionOut({ label, body: r });
      const d = await api.workflow(id, headers);
      if (selRef.current !== id) return r;
      setDetail(d);
      load();
      return r;
    } catch (ex) {
      if (selRef.current === id) setDetailErr(ex);
      return null;
    } finally {
      setActionBusy(false);
    }
  };

  const toggleActive = () =>
    doAction(
      () => (detail?.active ? api.deactivateWorkflow(sel, headers) : api.activateWorkflow(sel, headers)),
      detail?.active ? 'Deactivated' : 'Activated',
    );

  const execute = async () => {
    let input = {};
    try {
      input = execInput.trim() ? JSON.parse(execInput) : {};
    } catch {
      setDetailErr(new Error('Execute input is not valid JSON'));
      return;
    }
    const r = await doAction(() => api.executeWorkflow(sel, input, headers), 'Executed');
    if (!r) return;
    reloadExecs(sel);
    // Pull the fresh execution so per-node input/output shows immediately.
    if (r.executionId) showExecution(r.executionId);
  };

  const removeWorkflow = async () => {
    if (!sel || actionBusy) return;
    if (!window.confirm(`Delete workflow "${detail?.name || sel}"?`)) return;
    setActionBusy(true);
    setDetailErr(null);
    try {
      await api.deleteWorkflow(sel, headers);
      setSel(null);
      selRef.current = null;
      setDetail(null);
      load();
    } catch (ex) {
      setDetailErr(ex);
    } finally {
      setActionBusy(false);
    }
  };

  const duplicateWorkflow = async () => {
    if (!detail || actionBusy) return;
    setActionBusy(true);
    setDetailErr(null);
    try {
      // Fresh node ids, webhookIds AND a free trigger path: the copy shares
      // nothing addressable with the original (the engine keys some execution
      // mapping off node ids; two active workflows must share neither ids
      // nor webhook path, or routing is ambiguous).
      // Sibling paths are scanned so duplicate-of-duplicate gets -copy-2, ….
      // The copy's trigger URL changes — the UI names it "<name> copy".
      let siblingPaths = new Set();
      try {
        const all = await api.workflows(headers);
        const list = Array.isArray(all) ? all : all?.data || [];
        for (const w of list) {
          const nodes = w.id === sel && detail ? detail.nodes : w.nodes;
          for (const n of nodes || []) {
            const p = n?.parameters?.path;
            if (isWebhookType(n?.type) && typeof p === 'string' && p) siblingPaths.add(p);
          }
        }
      } catch {
        /* path scan is best-effort; worst case the suffix may collide */
      }
      const freshPath = (p) => {
        if (typeof p !== 'string' || !p) return p;
        let cand = `${p}-copy`;
        for (let i = 2; siblingPaths.has(cand); i++) cand = `${p}-copy-${i}`;
        siblingPaths.add(cand);
        return cand;
      };
      const nodes = (detail.nodes || []).map((n) => {
        if (!n || typeof n !== 'object') return n;
        const copy = { ...n, id: uid() };
        if (isWebhookType(copy.type)) {
          const params = { ...((copy.parameters || {})) };
          params.path = freshPath(params.path);
          copy.webhookId = uid();
          copy.parameters = params;
        }
        return copy;
      });
      // The copy starts inactive with the same schedule (m10): an active
      // cron duplicate would otherwise double-fire. Settings carry over so
      // timezone/notes survive the copy.
      const copy = await api.createWorkflowRaw(
        `${detail.name || 'workflow'} copy`.slice(0, 200),
        { nodes, connections: detail.connections || {}, settings: detail.settings || {} },
        headers,
      );
      load();
      if (copy && copy.id) select(copy.id);
    } catch (ex) {
      setDetailErr(ex);
    } finally {
      setActionBusy(false);
    }
  };

  const showExecution = async (id) => {
    if (execDetail?.id === id) {
      setExecDetail(null);
      setExpandedNode(null);
      return;
    }
    const wf = sel;
    try {
      // includeData carries node input/output for debugging runs.
      const e = await api.executionWithData(id, headers).catch(() => api.execution(id, headers));
      if (selRef.current !== wf) return; // stale workflow context
      setExecDetail({ id, ...e });
    } catch (ex) {
      if (selRef.current === wf) setDetailErr(ex);
    }
  };

  const openVisualEditor = () => {
    if (!detail) return;
    setDetailErr(null);
    setVisualOpen(true);
  };

  const onEditorSaved = async () => {
    setVisualOpen(false);
    try {
      const d = await api.workflow(sel, headers);
      setDetail(d);
      load();
    } catch (ex) {
      setDetailErr(ex);
    }
  };

  return (
    <>
      <PageTitle title="Workflows" sub="Local engine via workflow-service — click a workflow to interact" right={<><Btn onClick={createBlank} disabled={createBusy}>+ Blank</Btn> <Btn onClick={() => setOpen(true)}>+ From template</Btn> <Btn onClick={() => importRef.current?.click()} disabled={createBusy}>Import</Btn><input ref={importRef} type="file" accept="application/json,.json" onChange={importWorkflow} className="hidden" aria-label="Import workflow JSON" /></>} />
      <Err e={err} />
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <h3 className="font-semibold text-main-text mb-2">Built-in templates ({templates.length})</h3>
          {!tplLoaded ? (
            <TableSkeleton rows={3} cols={2} />
          ) : templates.length ? (
            <Table head={['Name', 'Description']}>
              {templates.map((t) => (
                <tr key={t.name} className="border-t border-slate-100">
                  <td className="py-2 pr-4 font-medium text-main-text font-mono text-xs">{t.name}</td>
                  <td className="py-2 pr-4 text-xs">{t.description}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty />
          )}
        </Card>
        <Card>
          <h3 className="font-semibold text-main-text mb-2">Workflows</h3>
          {flows === null ? (
            <ListSkeleton rows={4} />
          ) : list.length ? (
            <Table head={['Name', 'Active']}>
              {list.map((w) => (
                <tr
                  key={w.id}
                  onClick={() => select(w.id)}
                  className={`border-t border-slate-100 cursor-pointer hover:bg-background ${sel === w.id ? 'bg-main-blue/5' : ''}`}
                >
                  <td className="py-2 pr-4 font-medium text-main-text">{w.name}</td>
                  <td className="py-2 pr-4">
                    <Badge tone={w.active ? 'green' : 'gray'}>{w.active ? 'active' : 'off'}</Badge>
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty text={flows?.note || 'No workflows yet'} />
          )}
        </Card>
      </div>
      {sel && (
        <Card className="mt-4">
          <h3 className="font-semibold text-main-text mb-1">
            {detail?.name || 'Workflow'} <span className="font-mono text-xs text-normal-text">{sel}</span>
          </h3>
          <div className="mb-3">
            {detail && <Badge tone={detail.active ? 'green' : 'gray'}>{detail.active ? 'active' : 'off'}</Badge>}
            {detail?.nodes && <span className="ml-2 text-xs text-normal-text">{detail.nodes.length} nodes</span>}
            {detail?.revision && <span className="ml-2 text-xs text-normal-text" title="Bumped on every save">rev {detail.revision}</span>}
            {(detail?.orgId || detail?.accountId) && (
              <span className="ml-2 text-xs text-normal-text" title={`Tenant binding${detail?.owner ? ` · owner ${detail.owner}` : ''}${detail?.runAs ? ` · runs as ${detail.runAs}` : ''}`}>
                {detail.orgId || ''}{detail.orgId && detail.accountId ? ' / ' : ''}{detail.accountId || ''}
              </span>
            )}
            {webhookTrigger && (
              <span className="ml-2 text-xs text-normal-text inline-flex items-center gap-1 flex-wrap" title={detail.active ? 'Live — external systems can call this (no auth)' : 'Activate the workflow to make this URL live'}>
                <code className="font-mono text-main-text">{webhookTrigger.method} /webhook/{webhookTrigger.path}</code>
                {!detail.active && <span>(dormant — activate to serve)</span>}
                <WebhookCopy path={webhookTrigger.path} />
                {detail.active && <WebhookPing path={webhookTrigger.path} method={webhookTrigger.method} onDone={(r) => setActionOut({ label: 'Webhook ping', body: r })} />}
              </span>
            )}
            {cronSummary && (
              <span className="ml-2 text-xs text-normal-text" title={cronSummary.nextRun ? `Next run ≈ ${cronSummary.nextRun}` : undefined}>
                ⏱ {cronSummary.text}
              </span>
            )}
          </div>
          <Err e={detailErr} />
          {!detail && !detailErr && <ListSkeleton rows={5} />}
          {detail && (
            <>
              <div className="flex flex-wrap gap-2 mb-3">
                <button
                  onClick={toggleActive}
                  disabled={actionBusy}
                  className="px-4 py-1.5 rounded-2xl text-xs font-medium bg-slate-100 text-main-text hover:text-main-blue disabled:opacity-60 disabled:cursor-wait inline-flex items-center gap-1.5"
                >
                  {actionBusy && <Spinner size="xs" />}
                  {actionBusy ? 'Working…' : detail.active ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  onClick={openVisualEditor}
                  className="px-4 py-1.5 rounded-2xl text-xs font-medium text-white bg-gradient-to-b from-main-start to-main-end"
                >
                  Open editor
                </button>
                <button
                  onClick={removeWorkflow}
                  disabled={actionBusy}
                  className="px-4 py-1.5 rounded-2xl text-xs font-medium bg-red-500/10 text-red-500 disabled:opacity-50"
                >
                  Delete
                </button>
                <button
                  onClick={duplicateWorkflow}
                  disabled={actionBusy}
                  className="px-4 py-1.5 rounded-2xl text-xs font-medium bg-slate-100 text-main-text hover:text-main-blue disabled:opacity-50"
                >
                  Duplicate
                </button>
                <button
                  onClick={exportWorkflow}
                  className="px-4 py-1.5 rounded-2xl text-xs font-medium bg-slate-100 text-main-text hover:text-main-blue"
                  title="Download this workflow as a portable JSON file"
                >
                  Export
                </button>
              </div>
              <Field label="Execute input (JSON)">
                <textarea
                  value={execInput}
                  onChange={(e) => setExecInput(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder="{}"
                  className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono outline-none"
                />
              </Field>
              <button
                onClick={execute}
                disabled={actionBusy}
                className="px-4 py-1.5 rounded-2xl text-xs font-medium text-white bg-gradient-to-b from-main-start to-main-end disabled:opacity-60 disabled:cursor-wait mb-1 inline-flex items-center gap-1.5"
              >
                {actionBusy && <Spinner size="xs" className="sdx-spinner-on-dark" />}
                {actionBusy ? 'Running…' : 'Execute'}
              </button>
              <p className="text-[11px] text-normal-text mb-3">Execute runs the DAG now with this input — any trigger type, active or not. Activate only gates cron + public webhooks.</p>
              {actionOut && (
                <div className="mb-3">
                  <Badge tone="blue">{actionOut.label}</Badge>
                  <div className="mt-1">
                    <Code data={actionOut.body} />
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2 mb-2">
                <h4 className="font-semibold text-main-text text-sm">Recent executions ({execs.length})</h4>
                <select value={execStatus} onChange={(e) => applyExecStatus(e.target.value)} title="Filter by status" className="ml-auto px-2 py-1 rounded-xl border border-slate-200 text-xs bg-white outline-none">
                  <option value="">All statuses</option>
                  <option value="success">Success</option>
                  <option value="error">Error</option>
                  <option value="running">Running</option>
                </select>
              </div>
              {execs.length ? (
                <>
                <Table head={['ID', 'Status', 'Started']}>
                  {execs.map((x) => (
                    <tr key={x.id} onClick={() => showExecution(x.id)} className="border-t border-slate-100 cursor-pointer hover:bg-background">
                      <td className="py-2 pr-4 font-mono text-xs text-main-text">{String(x.id).slice(0, 8)}…</td>
                      <td className="py-2 pr-4">
                        <Badge tone={x.status === 'success' ? 'green' : x.status === 'error' ? 'red' : 'gray'}>
                          {x.status || x.mode || '?'}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-xs text-normal-text">{x.startedAt || '—'}</td>
                    </tr>
                  ))}
                </Table>
                {execMore && (
                  <button onClick={loadMoreExecs} disabled={execBusy} className="mt-2 px-4 py-1.5 rounded-2xl text-xs font-medium bg-slate-100 text-main-text hover:text-main-blue disabled:opacity-60 disabled:cursor-wait inline-flex items-center gap-1.5">
                    {execBusy && <Spinner size="xs" />}
                    {execBusy ? 'Loading…' : 'Load more'}
                  </button>
                )}
                </>
              ) : (
                <Empty text="No executions yet" />
              )}
              {execDetail && (
                <div className="mt-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge tone={execDetail.status === 'success' ? 'green' : execDetail.status === 'error' ? 'red' : 'gray'}>
                      {execDetail.status || '?'}
                    </Badge>
                    {execDetail.triggeredBy && <span className="text-[11px] text-normal-text">via {execDetail.triggeredBy}</span>}
                    {execDetail.error && <span className="text-[11px] text-red-500 break-words">{execDetail.error}</span>}
                  </div>
                  {Array.isArray(execDetail.nodeRuns) && execDetail.nodeRuns.length > 0 ? (
                    <Table head={['Node', 'Type', 'Status', 'Time']}>
                      {execDetail.nodeRuns.map((r, i) => (
                        <React.Fragment key={`${r.node}:${i}`}>
                          <tr onClick={() => setExpandedNode(expandedNode === `${r.node}:${i}` ? null : `${r.node}:${i}`)} className="border-t border-slate-100 cursor-pointer hover:bg-background">
                            <td className="py-2 pr-4 font-medium text-main-text text-xs">{r.node}</td>
                            <td className="py-2 pr-4 font-mono text-[11px] text-normal-text">{String(r.type || '').split('.').pop()}</td>
                            <td className="py-2 pr-4">
                              <Badge tone={r.status === 'success' ? 'green' : r.status === 'error' ? 'red' : 'amber'}>
                                {r.status || '?'}
                              </Badge>
                            </td>
                            <td className="py-2 pr-4 text-xs text-normal-text">{r.durationMs}ms</td>
                          </tr>
                          {expandedNode === `${r.node}:${i}` && (
                            <tr className="border-t border-slate-100">
                              <td colSpan={4} className="py-2 pr-4">
                                {r.error && <p className="text-[11px] text-red-500 mb-1 break-words">{r.error}</p>}
                                <div className="grid md:grid-cols-2 gap-2">
                                  <div>
                                    <p className="text-[10px] font-medium text-normal-text mb-0.5">input</p>
                                    <Code data={r.input} />
                                  </div>
                                  <div>
                                    <p className="text-[10px] font-medium text-normal-text mb-0.5">output</p>
                                    <Code data={r.output} />
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                    </Table>
                  ) : (
                    <Code data={execDetail} />
                  )}
                </div>
              )}
            </>
          )}
        </Card>
      )}
      {visualOpen && detail && (
        <WorkflowEditor
          workflowId={sel}
          initial={detail}
          headers={headers}
          onClose={() => setVisualOpen(false)}
          onSaved={onEditorSaved}
        />
      )}
      {open && (
        <Modal title="Create workflow from template" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Template">
              <select value={tpl} onChange={(e) => setTpl(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
                {templates.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Workflow name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Btn type="submit" loading={createBusy}>Create</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}

function WebhookCopy({ path }) {
  const [copied, setCopied] = useState(false);
  const url = `/webhook/${path}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={copy} title={`Copy ${url} (call the workflow-service origin, e.g. http://localhost:4002${url})`} className="px-2 py-0.5 rounded-xl bg-slate-100 text-main-text hover:text-main-blue font-medium">
      {copied ? 'Copied ✓' : 'Copy URL'}
    </button>
  );
}

function WebhookPing({ path, method, onDone }) {
  const [busy, setBusy] = useState(false);
  const ping = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Same-origin /webhook/* only works when the edge proxies it (dev vite
      // does not by default) — the catch block says exactly where to curl.
      const r = await fetch(`/webhook/${path}`, {
        method: method === 'GET' ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({ ping: true }),
      });
      const text = await r.text();
      let body = text;
      try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      onDone?.({ status: r.status, body });
    } catch (e) {
      onDone?.({ error: `Ping failed (is /webhook/* routed here? Direct curl: curl -X POST <workflow-origin>/webhook/${path} -d '{"ping":true}')`, detail: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button onClick={ping} disabled={busy} title="Fire a {} ping at this webhook path (needs /webhook/* routed to workflow-service)" className="px-2 py-0.5 rounded-xl bg-main-blue/10 text-main-blue font-medium disabled:opacity-60 disabled:cursor-wait inline-flex items-center gap-1.5">
      {busy && <Spinner size="xs" />}
      {busy ? 'Pinging…' : 'Send test ping'}
    </button>
  );
}
