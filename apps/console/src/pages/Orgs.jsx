/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Table } from '../components/ui.jsx';

export default function Orgs() {
  const { headers } = useAuth();
  const [orgs, setOrgs] = useState([]);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');

  const load = () => api.orgs(headers).then(setOrgs).catch(setErr);
  useEffect(load, []);

  const create = async (e) => {
    e.preventDefault();
    try {
      await api.createOrg(slug, name);
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
      <PageTitle title="Organizations" sub="Root tenants — like AWS Organizations" right={<Btn onClick={() => setOpen(true)}>+ New</Btn>} />
      <Err e={err} />
      <Card>
        {orgs.length ? (
          <Table head={['Slug', 'Display name', 'ID']}>
            {orgs.map((o) => (
              <tr key={o.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">{o.slug}</td>
                <td className="py-2 pr-4">{o.display_name}</td>
                <td className="py-2 pr-4 text-xs text-normal-text font-mono">{o.id?.slice(0, 8)}…</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty />
        )}
      </Card>
      <p className="mt-3 text-xs text-normal-text">
        <Badge>Tip</Badge> Pick an org on the Accounts page to see its accounts.
      </p>
      {open && (
        <Modal title="New organization" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Slug (unique)">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme" />
            </Field>
            <Field label="Display name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ACME Corp" />
            </Field>
            <Btn type="submit">Create</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
