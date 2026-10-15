/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Card, Empty, Err, Input, PageTitle, Table } from '../components/ui.jsx';

export default function Audit() {
  const { headers } = useAuth();
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [actor, setActor] = useState('');
  const [decision, setDecision] = useState('');

  const load = async () => {
    setErr(null);
    try {
      const v = await api.audit(100, actor || undefined, headers, decision === '' ? undefined : decision === 'allow');
      setRows(Array.isArray(v) ? v : []);
    } catch (e) {
      setErr(e);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
  }, [headers]);

  const fmtTime = (t) => {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  };

  return (
    <>
      <PageTitle title="Audit Log" sub="Every authorize decision, newest first" />
      <Err e={err} />
      <div className="flex gap-2 mb-4">
        <Input placeholder="Filter by actor id (user)…" value={actor} onChange={(e) => setActor(e.target.value)} />
        <select value={decision} onChange={(e) => setDecision(e.target.value)} className="px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white outline-none" title="Decision">
          <option value="">All decisions</option>
          <option value="allow">Allow only</option>
          <option value="deny">Deny only</option>
        </select>
        <button onClick={load} className="px-4 py-2 rounded-2xl bg-slate-100 text-sm text-main-text">
          Filter
        </button>
      </div>
      <Card>
        {!loaded ? (
          <Empty text="Loading…" />
        ) : rows.length ? (
          <Table head={['Time', 'Actor', 'Action', 'Resource', 'Decision']}>
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-slate-100">
                <td className="py-2 pr-4 text-xs whitespace-nowrap">{fmtTime(a.created_at)}</td>
                <td className="py-2 pr-4 text-xs font-mono">{a.actor_type || '?'}:{a.actor_id ? String(a.actor_id).slice(0, 8) : '—'}</td>
                <td className="py-2 pr-4 text-xs font-mono">{a.action}</td>
                <td className="py-2 pr-4 text-xs font-mono max-w-48 truncate">{a.resource}</td>
                <td className="py-2 pr-4">
                  <Badge tone={a.decision ? 'green' : 'red'}>{a.decision ? 'ALLOW' : 'DENY'}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="No audit records yet" />
        )}
      </Card>
    </>
  );
}
