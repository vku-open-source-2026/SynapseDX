/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Table } from '../components/ui.jsx';

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
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDef, setEditDef] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const selSeq = useRef(0);
  const selRef = useRef(null);

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
      setFlows({ note: 'n8n API key not configured (see docs/quickstart.md, N8N section)' });
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

  const list = Array.isArray(flows) ? flows : flows?.data || [];

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
    setExecInput('{}');
    try {
      const [d, e] = await Promise.all([
        api.workflow(id, headers),
        api.executions({ workflowId: id, limit: 20 }, headers).catch(() => ({ data: [] })),
      ]);
      if (selSeq.current !== my) return; // stale: user already picked another workflow
      setDetail(d);
      const items = Array.isArray(e) ? e : e?.data || [];
      setExecs(items);
    } catch (ex) {
      if (selSeq.current === my) setDetailErr(ex);
    }
  };

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
    try {
      const e = await api.executions({ workflowId: sel, limit: 20 }, headers);
      setExecs(Array.isArray(e) ? e : e?.data || []);
    } catch {
      /* executions refresh is best-effort */
    }
  };

  const removeWorkflow = async () => {
    if (!sel || actionBusy) return;
    if (!window.confirm(`Delete workflow "${detail?.name || sel}" on n8n?`)) return;
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

  const showExecution = async (id) => {
    if (execDetail?.id === id) {
      setExecDetail(null);
      return;
    }
    const wf = sel;
    try {
      const e = await api.execution(id, headers);
      if (selRef.current !== wf) return; // stale workflow context
      setExecDetail({ id, ...e });
    } catch (ex) {
      if (selRef.current === wf) setDetailErr(ex);
    }
  };

  const openEditor = () => {
    if (!detail) return;
    setEditName(detail.name || '');
    setEditDef(JSON.stringify({ nodes: detail.nodes || [], connections: detail.connections || {} }, null, 2));
    setDetailErr(null);
    setEditOpen(true);
  };

  const saveEditor = async (e) => {
    e.preventDefault();
    if (editBusy) return;
    let definition;
    try {
      definition = editDef.trim() ? JSON.parse(editDef) : undefined;
    } catch {
      setDetailErr(new Error('Definition is not valid JSON'));
      return;
    }
    setEditBusy(true);
    try {
      await api.updateWorkflow(sel, { name: editName, definition }, headers);
      setEditOpen(false);
      const d = await api.workflow(sel, headers);
      setDetail(d);
      load();
    } catch (ex) {
      setDetailErr(ex);
    } finally {
      setEditBusy(false);
    }
  };

  return (
    <>
      <PageTitle title="Workflows" sub="External n8n engine via workflow-service — click a workflow to interact" right={<Btn onClick={() => setOpen(true)}>+ From template</Btn>} />
      <Err e={err} />
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <h3 className="font-semibold text-main-text mb-2">Built-in templates ({templates.length})</h3>
          {!tplLoaded ? (
            <Empty text="Loading…" />
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
          <h3 className="font-semibold text-main-text mb-2">Workflows on n8n</h3>
          {flows === null ? (
            <Empty text="Loading…" />
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
          </div>
          <Err e={detailErr} />
          {!detail && !detailErr && <Empty text="Loading…" />}
          {detail && (
            <>
              <div className="flex flex-wrap gap-2 mb-3">
                <button
                  onClick={toggleActive}
                  disabled={actionBusy}
                  className="px-4 py-1.5 rounded-2xl text-xs font-medium bg-slate-100 text-main-text hover:text-main-blue disabled:opacity-50"
                >
                  {actionBusy ? '…' : detail.active ? 'Deactivate' : 'Activate'}
                </button>
                <button
                  onClick={openEditor}
                  className="px-4 py-1.5 rounded-2xl text-xs font-medium bg-slate-100 text-main-text hover:text-main-blue"
                >
                  Edit definition
                </button>
                <button
                  onClick={removeWorkflow}
                  disabled={actionBusy}
                  className="px-4 py-1.5 rounded-2xl text-xs font-medium bg-red-500/10 text-red-500 disabled:opacity-50"
                >
                  Delete
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
                className="px-4 py-1.5 rounded-2xl text-xs font-medium text-white bg-gradient-to-b from-main-start to-main-end disabled:opacity-50 mb-1"
              >
                {actionBusy ? 'Running…' : 'Execute'}
              </button>
              <p className="text-[11px] text-normal-text mb-3">Execute fires the webhook trigger — the workflow must be Active with a webhook node (cron-etl has none).</p>
              {actionOut && (
                <div className="mb-3">
                  <Badge tone="blue">{actionOut.label}</Badge>
                  <div className="mt-1">
                    <Code data={actionOut.body} />
                  </div>
                </div>
              )}
              <h4 className="font-semibold text-main-text text-sm mb-2">Recent executions ({execs.length})</h4>
              {execs.length ? (
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
              ) : (
                <Empty text="No executions yet" />
              )}
              {execDetail && (
                <div className="mt-2">
                  <Code data={execDetail} />
                </div>
              )}
            </>
          )}
        </Card>
      )}
      {editOpen && (
        <Modal title={`Edit ${detail?.name || 'workflow'}`} onClose={() => setEditOpen(false)}>
          <form onSubmit={saveEditor}>
            <Field label="Name">
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </Field>
            <Field label="Definition JSON ({nodes, connections})">
              <textarea
                value={editDef}
                onChange={(e) => setEditDef(e.target.value)}
                rows={14}
                spellCheck={false}
                className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono outline-none focus:border-main-blue"
              />
            </Field>
            <p className="text-[11px] text-normal-text mb-3">The server validates SSRF + size before saving to n8n.</p>
            <Btn type="submit" disabled={editBusy}>{editBusy ? 'Saving…' : 'Save to n8n'}</Btn>
          </form>
        </Modal>
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
            <Btn type="submit" disabled={createBusy}>{createBusy ? 'Creating…' : 'Create on n8n'}</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
