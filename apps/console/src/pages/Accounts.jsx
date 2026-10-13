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
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');

  const load = async () => {
    if (!scope.orgId) {
      setRows([]);
      return;
    }
    try {
      setRows(await api.accounts(scope.orgId, headers));
    } catch (e) {
      setErr(e);
    }
  };

  useEffect(() => {
    load();
  }, [scope.orgId]);

  const create = async (e) => {
    e.preventDefault();
    try {
      await api.createAccount(scope.orgId, slug, name);
      setOpen(false);
      setSlug('');
      setName('');
      load();
    } catch (ex) {
      setErr(ex);
    }
  };

  return (
    <>
      <PageTitle title="Accounts" sub="Environments in an org: prod, staging… (like AWS Accounts)" right={<Btn onClick={() => setOpen(true)}>+ New</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} showAccount={false} />
      <Card>
        {rows.length ? (
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
          <Empty text="Pick an organization to see its accounts" />
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
            <Btn type="submit">Create</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
