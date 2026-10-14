/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Table } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

export default function Keys() {
  const { headers } = useAuth();
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('console');
  const [created, setCreated] = useState(null);
  const loadSeq = useRef(0);

  const load = async () => {
    if (!scope.accountId) {
      setRows([]);
      setLoaded(true);
      return;
    }
    const my = ++loadSeq.current;
    setErr(null);
    try {
      const v = await api.listKeys(scope.accountId, headers);
      if (loadSeq.current === my) setRows(Array.isArray(v) ? v : []);
    } catch (e) {
      if (loadSeq.current === my) setErr(e);
    } finally {
      if (loadSeq.current === my) setLoaded(true);
    }
  };

  useEffect(() => {
    load();
  }, [scope.accountId, headers]);

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!scope.accountId) {
      setErr(new Error('Pick an account before creating a key'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const k = await api.createKey(scope.accountId, name, headers);
      setCreated(k);
      setOpen(false);
      load();
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id) => {
    if (!window.confirm('Revoke this key? Calls using it will start failing.')) return;
    try {
      await api.revokeKey(id, headers);
      setCreated(null);
      load();
    } catch (e) {
      setErr(e);
    }
  };

  useEffect(() => {
    setErr(null);
  }, [scope.accountId]);

  return (
    <>
      <PageTitle title="API Keys" sub="Long-lived synapsedx_* keys — shown only once at creation" right={<Btn onClick={() => setOpen(true)}>+ New key</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} />
      <Card>
        <p className="text-sm text-normal-text mb-3">
          Keys belong to account <b className="text-main-text">{scope.accounts.find((a) => a.id === scope.accountId)?.slug || '—'}</b>.
          Only id/prefix metadata is listed — secret values are shown once at creation.
        </p>
        {!loaded ? (
          <Empty text="Loading…" />
        ) : !scope.accountId ? (
          <Empty text="Pick an account first" />
        ) : rows.length ? (
          <Table head={['Name', 'Prefix', 'Expires', 'Status', '']}>
            {rows.map((k) => (
              <tr key={k.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">{k.name}</td>
                <td className="py-2 pr-4 text-xs text-normal-text font-mono">{k.prefix}…</td>
                <td className="py-2 pr-4 text-xs text-normal-text">
                  {k.expires_at ? new Date(k.expires_at).toLocaleDateString() : 'never'}
                </td>
                <td className="py-2 pr-4">
                  <Badge tone={k.revoked_at ? 'gray' : 'green'}>{k.revoked_at ? 'revoked' : 'live'}</Badge>
                </td>
                <td className="py-2 text-right">
                  {!k.revoked_at && (
                    <button onClick={() => revoke(k.id)} className="text-xs text-red-500">Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="No keys yet" />
        )}
      </Card>
      {created && (
        <Modal title="New API key (save it now!)" onClose={() => setCreated(null)}>
          <Code data={{ id: created.id, prefix: created.prefix, apiKey: created.apiKey }} />
        </Modal>
      )}
      {open && (
        <Modal title="New API key" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Key name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Btn type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create'}</Btn>
          </form>
        </Modal>
      )}
      <p className="mt-3 text-xs text-normal-text">
        <Badge>Tip</Badge> Enable <code>GATEWAY_VERIFY_APIKEY=true</code> for centralized gateway key verification.
      </p>
    </>
  );
}
