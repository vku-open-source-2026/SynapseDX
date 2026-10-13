/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleCheck, faCircleXmark, faRotate } from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { baseUrl } from '../lib/api.js';
import { Badge, Card, Empty, Err, PageTitle } from '../components/ui.jsx';

export default function Dashboard() {
  const { headers } = useAuth();
  const [ready, setReady] = useState(null);
  const [err, setErr] = useState(null);

  const load = async () => {
    setErr(null);
    try {
      const r = await fetch(`${baseUrl()}/ready`);
      setReady(await r.json());
    } catch (e) {
      setErr(e);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <PageTitle
        title="Dashboard"
        sub="Tier-1 PaaS cluster status"
        right={
          <button onClick={load} className="text-normal-text hover:text-main-blue" title="Reload">
            <FontAwesomeIcon icon={faRotate} />
          </button>
        }
      />
      <Err e={err} />
      <div className="grid md:grid-cols-3 gap-4 mb-6">
        {(ready?.upstreams || []).map((u) => (
          <Card key={u.name}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-main-text capitalize">{u.name}</h3>
              <FontAwesomeIcon
                icon={u.ok ? faCircleCheck : faCircleXmark}
                className={u.ok ? 'text-emerald-500 text-xl' : 'text-red-500 text-xl'}
              />
            </div>
            <p className="text-xs text-normal-text mt-2">
              {u.ok ? `OK · ${u.ms}ms · HTTP ${u.status}` : 'Unreachable'}
            </p>
          </Card>
        ))}
        <Card>
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-main-text">Gateway</h3>
            <Badge tone={ready?.status === 'ready' ? 'green' : 'amber'}>{ready?.status || '…'}</Badge>
          </div>
          <p className="text-xs text-normal-text mt-2 break-all">{baseUrl()}</p>
        </Card>
      </div>
      <Card>
        <h3 className="font-semibold text-main-text mb-3">Admin shortcuts</h3>
        {ready ? (
          <div className="flex flex-wrap gap-2 text-sm">
            <Link to="/orgs" className="px-3 py-1.5 rounded-2xl bg-background hover:text-main-blue">Organizations</Link>
            <Link to="/workflows" className="px-3 py-1.5 rounded-2xl bg-background hover:text-main-blue">Workflows</Link>
            <Link to="/authorize" className="px-3 py-1.5 rounded-2xl bg-background hover:text-main-blue">Authorize simulator</Link>
            <Link to="/audit" className="px-3 py-1.5 rounded-2xl bg-background hover:text-main-blue">Audit log</Link>
          </div>
        ) : (
          <Empty text="Loading status…" />
        )}
      </Card>
    </>
  );
}
