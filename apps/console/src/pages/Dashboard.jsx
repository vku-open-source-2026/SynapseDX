/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBuilding, faBolt, faCircleCheck, faCircleXmark, faRotate } from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { api, baseUrl } from '../lib/api.js';
import { useScope } from '../components/Scope.jsx';
import { Badge, Card, Empty, Err, PageTitle } from '../components/ui.jsx';

export default function Dashboard() {
  const { headers } = useAuth();
  const scope = useScope();
  const [ready, setReady] = useState(null);
  const [err, setErr] = useState(null);
  const [stats, setStats] = useState({ orgs: null, workflows: null });
  const [recent, setRecent] = useState([]);

  const load = async () => {
    setErr(null);
    try {
      const r = await fetch(`${baseUrl()}/ready`);
      setReady(await r.json());
    } catch (e) {
      setErr(e);
    }
    try {
      const [orgs, flows, audit] = await Promise.all([
        api.orgs(headers).catch(() => null),
        api.workflows(headers).catch(() => null),
        api.audit(5, undefined, headers).catch(() => []),
      ]);
      setStats({
        orgs: Array.isArray(orgs) ? orgs.length : null,
        workflows: Array.isArray(flows) ? flows.length : flows?.data?.length ?? null,
      });
      setRecent(Array.isArray(audit) ? audit : []);
    } catch (e) {
      setErr(e);
    }
  };

  useEffect(() => {
    load();
  }, [headers]);

  const curOrg = scope.orgs.find((o) => o.id === scope.orgId)?.slug || '—';
  const curAcc = scope.accounts.find((a) => a.id === scope.accountId)?.slug || '—';

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
      {scope.scopeErr && <Err e={scope.scopeErr} />}
      <div className="grid md:grid-cols-4 gap-4 mb-6">
        <Card>
          <div className="flex items-center gap-2 text-normal-text text-xs mb-1">
            <FontAwesomeIcon icon={faBuilding} /> ORGANIZATIONS
          </div>
          <p className="text-3xl font-semibold text-main-text">{stats.orgs ?? '…'}</p>
          <Link to="/orgs" className="text-xs text-main-blue">Manage →</Link>
        </Card>
        <Card>
          <div className="flex items-center gap-2 text-normal-text text-xs mb-1">
            <FontAwesomeIcon icon={faBolt} /> WORKFLOWS
          </div>
          <p className="text-3xl font-semibold text-main-text">{stats.workflows ?? '…'}</p>
          <Link to="/workflows" className="text-xs text-main-blue">Manage →</Link>
        </Card>
        <Card>
          <div className="text-xs text-normal-text mb-1">CURRENT CONTEXT</div>
          <p className="text-lg font-semibold text-main-text truncate">{curOrg} <span className="text-normal-text font-normal">/ {curAcc}</span></p>
          <p className="text-xs text-normal-text mt-1">Switch it in the header (top right) or on the Accounts page</p>
        </Card>
        <Card>
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-main-text">Gateway</h3>
            <Badge tone={ready?.status === 'ready' ? 'green' : 'amber'}>{ready?.status || '…'}</Badge>
          </div>
          <p className="text-xs text-normal-text mt-2 break-all">{baseUrl()}</p>
        </Card>
      </div>
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
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Recent activity</h3>
          {recent.length ? (
            <ul className="space-y-2 text-xs">
              {recent.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <Badge tone={a.decision ? 'green' : 'red'}>{a.decision ? 'ALLOW' : 'DENY'}</Badge>
                  <span className="font-mono text-main-text truncate">{a.action}</span>
                  <span className="ml-auto text-normal-text whitespace-nowrap">
                    {(() => { const d = new Date(a.created_at); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(); })()}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty text="No audit records yet" />
          )}
        </Card>
        <Card>
          <h3 className="font-semibold text-main-text mb-3">Admin shortcuts</h3>
          <div className="flex flex-wrap gap-2 text-sm">
            <Link to="/orgs" className="px-3 py-1.5 rounded-2xl bg-background hover:text-main-blue">Organizations</Link>
            <Link to="/workflows" className="px-3 py-1.5 rounded-2xl bg-background hover:text-main-blue">Workflows</Link>
            <Link to="/authorize" className="px-3 py-1.5 rounded-2xl bg-background hover:text-main-blue">Authorize simulator</Link>
            <Link to="/audit" className="px-3 py-1.5 rounded-2xl bg-background hover:text-main-blue">Audit log</Link>
            <Link to="/api-docs" className="px-3 py-1.5 rounded-2xl bg-background hover:text-main-blue">API Docs</Link>
          </div>
        </Card>
      </div>
    </>
  );
}
