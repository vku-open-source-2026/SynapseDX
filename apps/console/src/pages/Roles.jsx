/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Btn, Card, Empty, Err, Field, InlineLoader, Input, Modal, PageTitle, Table, TableSkeleton } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

export default function Roles() {
  const { headers } = useAuth();
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [slug, setSlug] = useState('');

  const load = async () => {
    if (!scope.accountId) {
      setRows([]);
      setLoaded(true);
      return;
    }
    setErr(null);
    try {
      const v = await api.roles(scope.accountId, headers);
      setRows(Array.isArray(v) ? v : []);
    } catch (e) {
      setErr(e);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
  }, [scope.accountId, headers]);

  useEffect(() => {
    setExpanded(null);
    setAttached(null);
  }, [scope.accountId]);

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.createRole(scope.accountId, slug, headers);
      setOpen(false);
      setSlug('');
      load();
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    if (deleting) return;
    if (!window.confirm('Delete this role?')) return;
    setDeleting(id);
    setErr(null);
    try {
      await api.deleteRole(id, headers);
      if (expanded === id) setExpanded(null);
      load();
    } catch (e) {
      setErr(e);
    } finally {
      setDeleting(null);
    }
  };

  const [policies, setPolicies] = useState([]);
  const [attachRole, setAttachRole] = useState('');
  const [attachPolicy, setAttachPolicy] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [attached, setAttached] = useState(null);
  // Sequence guard: rapid expand A→B must not let A's slow response
  // overwrite B's list (same pattern as Scope provider).
  const attSeq = useRef(0);
  // In-flight detach key (`roleId:policyId`) — per-item busy so concurrent
  // detaches on other rows stay enabled; double-clicks on one button block.
  const [detaching, setDetaching] = useState(null);

  useEffect(() => {
    if (!scope.accountId) {
      setPolicies([]);
      return;
    }
    setAttachRole('');
    setAttachPolicy('');
    api.policies(scope.accountId, headers).then((v) => setPolicies(Array.isArray(v) ? v : [])).catch(() => setPolicies([]));
  }, [scope.accountId, headers]);

  const doAttach = async (e) => {
    e.preventDefault();
    if (!attachRole || !attachPolicy || busy) return;
    setBusy(true);
    setErr(null);
    const my = attSeq.current;
    try {
      await api.attach(attachRole, attachPolicy, headers);
      if (expanded === attachRole) {
        const v = await api.rolePolicies(attachRole, headers);
        if (attSeq.current === my) setAttached(Array.isArray(v) ? v : []);
      }
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const expand = async (id) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    const my = ++attSeq.current;
    setExpanded(id);
    setAttached(null);
    try {
      const v = await api.rolePolicies(id, headers);
      if (attSeq.current === my) setAttached(Array.isArray(v) ? v : []);
    } catch (ex) {
      if (attSeq.current === my) {
        setAttached([]);
        setErr(ex);
      }
    }
  };

  const doDetach = async (roleId, policyId) => {
    const key = `${roleId}:${policyId}`;
    if (detaching) return;
    if (!window.confirm('Detach this policy?')) return;
    setDetaching(key);
    setErr(null);
    const my = attSeq.current;
    try {
      await api.detach(roleId, policyId, headers);
      setAttached(null);
      const v = await api.rolePolicies(roleId, headers);
      if (attSeq.current === my && expanded === roleId) setAttached(Array.isArray(v) ? v : []);
    } catch (e) {
      setErr(e);
    } finally {
      setDetaching(null);
    }
  };

  return (
    <>
      <PageTitle title="Roles" sub="Assigned to users, policies attached (like AWS IAM roles)" right={<Btn onClick={() => setOpen(true)}>+ New</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} />
      {scope.accountId && rows.length > 0 && policies.length > 0 && (
        <Card className="mb-4">
          <form onSubmit={doAttach} className="flex flex-wrap items-end gap-2">
            <Field label="Role">
              <select value={attachRole} onChange={(e) => setAttachRole(e.target.value)} className="px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white outline-none">
                <option value="">— pick —</option>
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>{r.slug}</option>
                ))}
              </select>
            </Field>
            <Field label="Policy">
              <select value={attachPolicy} onChange={(e) => setAttachPolicy(e.target.value)} className="px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white outline-none">
                <option value="">— pick —</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>{p.slug}</option>
                ))}
              </select>
            </Field>
            <Btn type="submit" disabled={busy || !attachRole || !attachPolicy}>Attach</Btn>
          </form>
        </Card>
      )}
      <Card>
        {!loaded ? (
          <TableSkeleton rows={5} cols={3} />
        ) : rows.length ? (
          <Table head={['Slug', 'ID', 'Policies', '']}>
            {rows.map((r) => (
              <React.Fragment key={r.id}>
                <tr className="border-t border-slate-100">
                  <td className="py-2 pr-4 font-medium text-main-text">{r.slug}</td>
                  <td className="py-2 pr-4 text-xs text-normal-text font-mono">{r.id?.slice(0, 8)}…</td>
                  <td className="py-2 pr-4">
                    <button onClick={() => expand(r.id)} className="text-xs text-main-blue">{expanded === r.id ? 'Hide policies' : 'Policies'}</button>
                  </td>
                  <td className="py-2 text-right">
                    <button onClick={() => remove(r.id)} disabled={deleting === r.id} className="text-xs text-red-500 disabled:opacity-50">
                      {deleting === r.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </td>
                </tr>
                {expanded === r.id && (
                  <tr>
                    <td colSpan={4} className="pb-3">
                      {attached === null ? (
                        <InlineLoader />
                      ) : attached.length ? (
                        <ul className="space-y-1">
                          {attached.map((p) => (
                            <li key={p.id} className="flex items-center gap-2 text-xs bg-background rounded-xl px-3 py-1.5">
                              <span className="font-mono text-main-text">{p.slug}</span>
                              <button
                                onClick={() => doDetach(r.id, p.id)}
                                disabled={detaching === `${r.id}:${p.id}`}
                                className="ml-auto text-red-500 disabled:opacity-50"
                              >
                                {detaching === `${r.id}:${p.id}` ? 'Detaching…' : 'Detach'}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-normal-text">No policies attached</p>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </Table>
        ) : (
          <Empty text={scope.accountId ? 'No roles yet' : 'Pick an account to see its roles'} />
        )}
      </Card>
      {open && (
        <Modal title="New role" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Slug">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="etl-runner" />
            </Field>
            <Btn type="submit" loading={busy}>Create</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
