/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Table } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

export default function Roles() {
  const { headers } = useAuth();
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
    if (!window.confirm('Delete this role?')) return;
    try {
      await api.deleteRole(id, headers);
      load();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <PageTitle title="Roles" sub="Assigned to users, policies attached (like AWS IAM roles)" right={<Btn onClick={() => setOpen(true)}>+ New</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} />
      <Card>
        {!loaded ? (
          <Empty text="Loading…" />
        ) : rows.length ? (
          <Table head={['Slug', 'ID', '']}>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">{r.slug}</td>
                <td className="py-2 pr-4 text-xs text-normal-text font-mono">{r.id?.slice(0, 8)}…</td>
                <td className="py-2 text-right">
                  <button onClick={() => remove(r.id)} className="text-xs text-red-500">Delete</button>
                </td>
              </tr>
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
            <Btn type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create'}</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
