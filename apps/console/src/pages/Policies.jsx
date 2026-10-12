/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Table } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

const SAMPLE = JSON.stringify(
  {
    Version: '2026-01-01',
    Statement: [
      { Effect: 'Allow', Action: ['workflow:Execute'], Resource: '*' },
      { Effect: 'Deny', Action: ['iam:*'], Resource: '*' },
    ],
  },
  null,
  2,
);

export default function Policies() {
  const { headers } = useAuth();
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(null);
  const [slug, setSlug] = useState('');
  const [doc, setDoc] = useState(SAMPLE);

  const load = async () => {
    if (!scope.accountId) {
      setRows([]);
      return;
    }
    try {
      setRows(await api.policies(scope.accountId, headers));
    } catch (e) {
      setErr(e);
    }
  };

  useEffect(() => {
    load();
  }, [scope.accountId]);

  const create = async (e) => {
    e.preventDefault();
    try {
      await api.createPolicy(scope.accountId, slug, JSON.parse(doc), headers);
      setOpen(false);
      setSlug('');
      load();
    } catch (ex) {
      setErr(ex);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Xóa policy này?')) return;
    try {
      await api.deletePolicy(id, headers);
      load();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <PageTitle title="Policies" sub="JSON AWS-style: Allow/Deny + Action/Resource + Condition" right={<Btn onClick={() => setOpen(true)}>+ Tạo</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} />
      <Card>
        {rows.length ? (
          <Table head={['Slug', 'Statements', '', '']}>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">{p.slug}</td>
                <td className="py-2 pr-4">{p.document?.Statement?.length || 0}</td>
                <td className="py-2 pr-4">
                  <button onClick={() => setView(p)} className="text-xs text-main-blue">Xem JSON</button>
                </td>
                <td className="py-2 text-right">
                  <button onClick={() => remove(p.id)} className="text-xs text-red-500">Xóa</button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="Chọn account để xem policies" />
        )}
      </Card>
      {open && (
        <Modal title="Tạo Policy" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Slug">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="run-only" />
            </Field>
            <Field label="Document JSON">
              <textarea value={doc} onChange={(e) => setDoc(e.target.value)} rows={12} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono outline-none focus:border-main-blue" />
            </Field>
            <Btn type="submit">Tạo</Btn>
          </form>
        </Modal>
      )}
      {view && (
        <Modal title={`Policy ${view.slug}`} onClose={() => setView(null)}>
          <Code data={view.document} />
        </Modal>
      )}
    </>
  );
}
