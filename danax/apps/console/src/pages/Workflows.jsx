import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Empty, Err, Field, Input, Modal, PageTitle, Table } from '../components/ui.jsx';

export default function Workflows() {
  const { headers } = useAuth();
  const [flows, setFlows] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [tpl, setTpl] = useState('webhook-to-log');
  const [name, setName] = useState('console-demo');

  const load = async () => {
    try {
      setTemplates(await api.templates(headers));
    } catch (e) {
      setErr(e);
    }
    try {
      setFlows(await api.workflows(headers));
    } catch {
      setFlows({ note: 'n8n chưa cấu hình API key (xem docs/quickstart.md mục N8N)' });
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async (e) => {
    e.preventDefault();
    try {
      await api.createWorkflow(tpl, name, headers);
      setOpen(false);
      load();
    } catch (ex) {
      setErr(ex);
    }
  };

  const list = Array.isArray(flows) ? flows : flows?.data || [];

  return (
    <>
      <PageTitle title="Workflows" sub="n8n engine ngoài qua workflow-service" right={<Btn onClick={() => setOpen(true)}>+ Từ template</Btn>} />
      <Err e={err} />
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <h3 className="font-semibold text-main-text mb-2">Built-in templates ({templates.length})</h3>
          {templates.length ? (
            <Table head={['Name', 'Mô tả']}>
              {templates.map((t) => (
                <tr key={t.name} className="border-t border-slate-100">
                  <td className="py-2 pr-4 font-medium text-main-text font-mono text-xs">{t.name}</td>
                  <td className="py-2 pr-4 text-xs">{t.description}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty />
          )}
        </Card>
        <Card>
          <h3 className="font-semibold text-main-text mb-2">Workflows trên n8n</h3>
          {flows === null ? (
            <Empty text="Đang tải…" />
          ) : list.length ? (
            <Table head={['Name', 'Active']}>
              {list.map((w) => (
                <tr key={w.id} className="border-t border-slate-100">
                  <td className="py-2 pr-4 font-medium text-main-text">{w.name}</td>
                  <td className="py-2 pr-4">
                    <Badge tone={w.active ? 'green' : 'gray'}>{w.active ? 'active' : 'off'}</Badge>
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty text={flows?.note || 'Chưa có workflow'} />
          )}
        </Card>
      </div>
      {open && (
        <Modal title="Tạo workflow từ template" onClose={() => setOpen(false)}>
          <form onSubmit={create}>
            <Field label="Template">
              <select value={tpl} onChange={(e) => setTpl(e.target.value)} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white">
                {templates.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tên workflow">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Btn type="submit">Tạo trên n8n</Btn>
          </form>
        </Modal>
      )}
    </>
  );
}
