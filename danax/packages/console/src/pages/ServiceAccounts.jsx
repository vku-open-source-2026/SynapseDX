import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Btn, Card, Code, Empty, Err, Field, Input, Modal, PageTitle, Table } from '../components/ui.jsx';
import { ScopeBar, useScope } from '../components/Scope.jsx';

export default function ServiceAccounts() {
  const { headers } = useAuth();
  const scope = useScope();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [token, setToken] = useState(null);

  const load = async () => {
    if (!scope.accountId) {
      setRows([]);
      return;
    }
    try {
      setRows(await api.serviceAccounts(scope.accountId, headers));
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
      await api.createSA(scope.accountId, slug, headers);
      setOpen(false);
      setSlug('');
      load();
    } catch (ex) {
      setErr(ex);
    }
  };

  const issue = async (id) => {
    try {
      setToken(await api.saToken(id, headers));
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <PageTitle title="Service Accounts" sub="Identity cho máy (JWT kind=service-account)" right={<Btn onClick={() => setOpen(true)}>+ Tạo</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} />
      <Card>
        {rows.length ? (
          <Table head={['Slug', 'ID', '']}>
            {rows.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">{s.slug}</td>
                <td className="py-2 pr-4 text-xs text-normal-text font-mono">{s.id?.slice(0, 8)}…</td>
                <td className="py-2 text-right">
                  <button onClick={() => issue(s.id)} className="text-xs text-main-blue">Cấp token</button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="Chọn account để xem service accounts" />
        )}
      </Card>
      {open && (
        <Modal title="Tạo Service Account" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Slug">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="etl-worker" />
            </Field>
            <Btn type="submit">Tạo</Btn>
          </form>
        </Modal>
      )}
      {token && (
        <Modal title="Service token (lưu ngay!)" onClose={() => setToken(null)}>
          <Code data={token} />
        </Modal>
      )}
    </>
  );
}
