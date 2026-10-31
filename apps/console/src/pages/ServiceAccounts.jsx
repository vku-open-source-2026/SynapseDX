/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Spinner, Table, TableSkeleton } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

export default function ServiceAccounts() {
  const { headers } = useAuth();
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slug, setSlug] = useState('');
  const [token, setToken] = useState(null);
  const [minting, setMinting] = useState(null);

  const load = async () => {
    if (!scope.accountId) {
      setRows([]);
      setLoaded(true);
      return;
    }
    setErr(null);
    try {
      const v = await api.serviceAccounts(scope.accountId, headers);
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
      await api.createSA(scope.accountId, slug, headers);
      setOpen(false);
      setSlug('');
      load();
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const issue = async (id) => {
    if (minting) return;
    setMinting(id);
    try {
      setToken(await api.saToken(id, headers));
    } catch (e) {
      setErr(e);
    } finally {
      setMinting(null);
    }
  };

  return (
    <>
      <PageTitle title="Service Accounts" sub="Machine identity (kind=service-account JWTs)" right={<Btn onClick={() => setOpen(true)}>+ New</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} />
      <Card>
        {!loaded ? (
          <TableSkeleton rows={4} cols={3} />
        ) : rows.length ? (
          <Table head={['Slug', 'ID', '']}>
            {rows.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">{s.slug}</td>
                <td className="py-2 pr-4 text-xs text-normal-text font-mono">{s.id?.slice(0, 8)}…</td>
                <td className="py-2 text-right">
                  <button onClick={() => issue(s.id)} disabled={minting === s.id} className="text-xs text-main-blue disabled:opacity-50 inline-flex items-center gap-1.5">
                    {minting === s.id && <Spinner size="xs" />}
                    {minting === s.id ? 'Minting…' : 'Mint token'}
                  </button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text={scope.accountId ? 'No service accounts yet' : 'Pick an account to see its service accounts'} />
        )}
      </Card>
      {open && (
        <Modal title="New service account" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Slug">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="etl-worker" />
            </Field>
            <Btn type="submit" loading={busy}>Create</Btn>
          </form>
        </Modal>
      )}
      {token && (
        <Modal title="Service token (save it now!)" onClose={() => setToken(null)}>
          <Code data={token} />
        </Modal>
      )}
    </>
  );
}
