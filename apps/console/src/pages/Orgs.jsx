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
      <PageTitle title="Organizations" sub="Tenant gốc — như AWS Organization" right={<Btn onClick={() => setOpen(true)}>+ Tạo</Btn>} />
      <Err e={err} />
      <Card>
        {orgs.length ? (
          <Table head={['Slug', 'Tên hiển thị', 'ID']}>
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
        <Badge>Tip</Badge> Chọn org ở trang Accounts để xem account bên trong.
      </p>
      {open && (
        <Modal title="Tạo Organization" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Slug (duy nhất)">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme" />
            </Field>
            <Field label="Tên hiển thị">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ACME Corp" />
            </Field>
            <Btn type="submit">Tạo</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
