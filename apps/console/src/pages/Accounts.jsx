/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Table } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

export default function Accounts() {
  const { headers } = useAuth();
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');

  const load = async () => {
    if (!scope.orgId) {
      setRows([]);
      setLoaded(true);
      return;
    }
    setErr(null);
    try {
      const v = await api.accounts(scope.orgId, headers);
      setRows(Array.isArray(v) ? v : []);
    } catch (e) {
      setErr(e);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
  }, [scope.orgId, headers]);

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.createAccount(scope.orgId, slug, name, headers);
      setOpen(false);
      setSlug('');
      setName('');
      load();
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageTitle title="Accounts" sub="Environments in an org: prod, staging… (like AWS Accounts)" right={<Btn onClick={() => setOpen(true)}>+ New</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} showAccount={false} />
      <Card>
        {!loaded ? (
          <Empty text="Loading…" />
        ) : rows.length ? (
          <Table head={['Slug', 'Display name', 'ID']}>
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">{a.slug}</td>
                <td className="py-2 pr-4">{a.display_name}</td>
                <td className="py-2 pr-4 text-xs text-normal-text font-mono">{a.id?.slice(0, 8)}…</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text={scope.orgId ? 'No accounts yet' : 'Pick an organization to see its accounts'} />
        )}
      </Card>
      {open && (
        <Modal title="New account" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Slug (unique in the org)">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="prod" />
            </Field>
            <Field label="Display name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production" />
            </Field>
            <Btn type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create'}</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
