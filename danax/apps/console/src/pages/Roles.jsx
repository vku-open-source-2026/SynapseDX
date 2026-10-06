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
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');

  const load = async () => {
    if (!scope.accountId) {
      setRows([]);
      return;
    }
    try {
      setRows(await api.roles(scope.accountId, headers));
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
      await api.createRole(scope.accountId, slug, headers);
      setOpen(false);
      setSlug('');
      load();
    } catch (ex) {
      setErr(ex);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Xóa role này?')) return;
    try {
      await api.deleteRole(id, headers);
      load();
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <PageTitle title="Roles" sub="Gán cho user, đính kèm policy (như AWS IAM Role)" right={<Btn onClick={() => setOpen(true)}>+ Tạo</Btn>} />
      <Err e={err} />
      <ScopeBar scope={scope} />
      <Card>
        {rows.length ? (
          <Table head={['Slug', 'ID', '']}>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 font-medium text-main-text">{r.slug}</td>
                <td className="py-2 pr-4 text-xs text-normal-text font-mono">{r.id?.slice(0, 8)}…</td>
                <td className="py-2 text-right">
                  <button onClick={() => remove(r.id)} className="text-xs text-red-500">Xóa</button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="Chọn account để xem roles" />
        )}
      </Card>
      {open && (
        <Modal title="Tạo Role" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Slug">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="etl-runner" />
            </Field>
            <Btn type="submit">Tạo</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
