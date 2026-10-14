/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Table } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

export default function Users() {
  const { headers } = useAuth();
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    if (!scope.orgId) {
      setRows([]);
      setLoaded(true);
      return;
    }
    setErr(null);
    api.users(scope.orgId, headers).then((v) => setRows(Array.isArray(v) ? v : [])).catch(setErr).finally(() => setLoaded(true));
  }, [scope.orgId, headers]);

  const create = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.createUser(scope.orgId, email, displayName || undefined, headers);
      setOpen(false);
      setEmail('');
      setDisplayName('');
      api.users(scope.orgId, headers).then((v) => setRows(Array.isArray(v) ? v : [])).catch(setErr);
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageTitle title="Users" sub="Shadow users federated from Authentik/Keycloak (email + OIDC sub)" right={<Btn onClick={() => setOpen(true)}>+ New</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} showAccount={false} />
      <Card>
        {!loaded ? (
          <Empty text="Loading…" />
        ) : rows.length ? (
          <Table head={['Email', 'Name', 'OIDC sub', 'Roles']}>
            {rows.map((u) => (
              <Row key={u.id} u={u} headers={headers} />
            ))}
          </Table>
        ) : (
          <Empty text={scope.orgId ? 'No users yet' : 'Pick an organization to see its users'} />
        )}
      </Card>
      {open && (
        <Modal title="New user" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Email">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="a@acme.local" />
            </Field>
            <Field label="Display name (optional)">
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Alice" />
            </Field>
            <Btn type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create'}</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}

function Row({ u, headers }) {
  const [n, setN] = useState(null);
  useEffect(() => {
    let live = true;
    api.userPolicies(u.id, headers).then((p) => live && setN(Array.isArray(p) ? p.length : 0)).catch(() => live && setN(0));
    return () => {
      live = false;
    };
  }, [u.id, headers]);
  return (
    <tr className="border-t border-slate-100">
      <td className="py-2 pr-4 font-medium text-main-text">{u.email}</td>
      <td className="py-2 pr-4">{u.display_name || '—'}</td>
      <td className="py-2 pr-4 text-xs text-normal-text font-mono">{u.external_sub?.slice(0, 18) || '—'}</td>
      <td className="py-2 pr-4">
        {n === null ? <span className="text-xs text-normal-text">…</span> : <Badge tone={n ? 'blue' : 'gray'}>{n} policies</Badge>}
      </td>
    </tr>
  );
}
