import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Card, Empty, Err, Input, PageTitle, Table } from '../components/ui.jsx';

export default function Audit() {
  const { headers } = useAuth();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [actor, setActor] = useState('');

  const load = async () => {
    try {
      setRows(await api.audit(100, actor || undefined, headers));
    } catch (e) {
      setErr(e);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <PageTitle title="Audit Log" sub="Mọi authorize decision, mới nhất trước" />
      <Err e={err} />
      <div className="flex gap-2 mb-4">
        <Input placeholder="Lọc theo actor id (user)…" value={actor} onChange={(e) => setActor(e.target.value)} />
        <button onClick={load} className="px-4 py-2 rounded-2xl bg-slate-100 text-sm text-main-text">
          Lọc
        </button>
      </div>
      <Card>
        {rows.length ? (
          <Table head={['Thời gian', 'Actor', 'Action', 'Resource', 'Quyết định']}>
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 text-xs whitespace-nowrap">{new Date(a.created_at).toLocaleString()}</td>
                <td className="py-2 pr-4 text-xs font-mono">{a.actor_type}:{String(a.actor_id).slice(0, 8)}</td>
                <td className="py-2 pr-4 text-xs font-mono">{a.action}</td>
                <td className="py-2 pr-4 text-xs font-mono max-w-48 truncate">{a.resource}</td>
                <td className="py-2 pr-4">
                  <Badge tone={a.decision ? 'green' : 'red'}>{a.decision ? 'ALLOW' : 'DENY'}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="Chưa có bản ghi audit" />
        )}
      </Card>
    </>
  );
}
