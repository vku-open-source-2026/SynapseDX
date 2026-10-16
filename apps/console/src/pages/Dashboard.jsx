/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBoxes,
  faBolt,
  faBuilding,
  faChartSimple,
  faCircleCheck,
  faCircleXmark,
  faClockRotateLeft,
  faListCheck,
  faRotate,
  faUsers,
} from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { api, baseUrl } from '../lib/api.js';
import { ScopeBar, useScope } from '../components/Scope.jsx';
import { Badge, Btn, Card, Empty, Err, PageTitle, Skeleton, StatValue } from '../components/ui.jsx';

const SERVICE_DEFS = [
  { key: 'gateway', label: 'Gateway', hint: 'Single entry point · auth + rate-limit + /ready' },
  { key: 'iam', label: 'IAM', hint: 'Orgs · users · roles · policies · keys' },
  { key: 'workflow', label: 'Workflow', hint: 'Templates · runs · webhooks + cron' },
  { key: 'ai', label: 'AI', hint: 'Docs chatbot + agent endpoint' },
];

const EXEC_WINDOW = 20;

function matchUpstream(upstreams, key) {
  const list = Array.isArray(upstreams) ? upstreams : [];
  const hit = list.find((u) => String(u?.name || '').toLowerCase().includes(key));
  return hit || null;
}

function fmtTime(t) {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function asList(v) {
  if (Array.isArray(v)) return v;
  if (Array.isArray(v?.data)) return v.data;
  return null;
}

function execStatus(x) {
  return String(x?.status || x?.mode || '').toLowerCase();
}

export default function Dashboard() {
  const { headers } = useAuth();
  const scope = useScope();
  // One loading + one error state per block: a dead workflow-service must not
  // wipe the IAM inventory, and each block explains its own failure inline.
  const [ready, setReady] = useState(null);
  const [readyLoading, setReadyLoading] = useState(true);
  const [readyErr, setReadyErr] = useState(null);
  const [inv, setInv] = useState({ orgs: 0, accounts: null, users: null, workflows: null, active: null });
  const [invLoading, setInvLoading] = useState(true);
  const [invErr, setInvErr] = useState(null);
  const [runs, setRuns] = useState({ total: null, success: 0, error: 0, waiting: 0, items: [] });
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsErr, setRunsErr] = useState(null);
  const [recent, setRecent] = useState([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [actErr, setActErr] = useState(null);

  const loadReady = useCallback(async () => {
    setReadyErr(null);
    setReadyLoading(true);
    try {
      const r = await fetch(`${baseUrl()}/ready`);
      if (!r.ok) throw new Error(`gateway /ready → HTTP ${r.status}`);
      setReady(await r.json());
    } catch (e) {
      setReady(null);
      setReadyErr(e);
    } finally {
      setReadyLoading(false);
    }
  }, []);

  const loadInventory = useCallback(async () => {
    setInvErr(null);
    setInvLoading(true);
    try {
      const orgId = scope.orgId || null;
      // allSettled: users failing must not hide the workflow count and vice versa.
      const [uR, fR] = await Promise.allSettled([
        orgId ? api.users(orgId, headers) : Promise.resolve(null),
        api.workflows(headers),
      ]);
      const firstErr = [uR, fR].find((r) => r.status === 'rejected');
      setInvErr(firstErr ? firstErr.reason : null);
      const flows = fR.status === 'fulfilled' ? asList(fR.value) : null;
      setInv({
        // Orgs/accounts come from the shared scope so the header picker and
        // this page can never disagree. 0 is honest (loaded but empty);
        // null means unknown (no org selected / fetch failed).
        orgs: scope.orgs.length,
        accounts: scope.orgId ? scope.accounts.length : null,
        users: orgId ? (uR.status === 'fulfilled' ? asList(uR.value)?.length ?? null : null) : null,
        workflows: flows ? flows.length : null,
        active: flows ? flows.filter((w) => w?.active).length : null,
      });
    } catch (e) {
      setInvErr(e);
    } finally {
      setInvLoading(false);
    }
  }, [headers, scope.orgId, scope.orgs.length, scope.accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadRuns = useCallback(async () => {
    setRunsErr(null);
    setRunsLoading(true);
    try {
      const items = asList(await api.executions({ limit: EXEC_WINDOW }, headers)) || [];
      const success = items.filter((x) => execStatus(x) === 'success').length;
      const error = items.filter((x) => execStatus(x) === 'error').length;
      const waiting = items.filter((x) => execStatus(x) === 'waiting').length;
      setRuns({ total: items.length, success, error, waiting, items: items.slice(0, 5) });
    } catch (e) {
      setRuns({ total: null, success: 0, error: 0, waiting: 0, items: [] });
      setRunsErr(e);
    } finally {
      setRunsLoading(false);
    }
  }, [headers]);

  const loadActivity = useCallback(async () => {
    setActErr(null);
    setRecentLoading(true);
    try {
      const audit = await api.audit(8, undefined, headers);
      setRecent(Array.isArray(audit) ? audit : []);
    } catch (e) {
      setRecent([]);
      setActErr(e);
    } finally {
      setRecentLoading(false);
    }
  }, [headers]);

  // Reload runs every probe; scope/header changes re-filter inventory + runs.
  const load = useCallback(() => {
    loadReady();
    loadInventory();
    loadRuns();
    loadActivity();
  }, [loadReady, loadInventory, loadRuns, loadActivity]);

  useEffect(() => {
    load();
  }, [load]);

  const busy = readyLoading || invLoading || runsLoading || recentLoading;
  const curOrg = scope.orgs.find((o) => o.id === scope.orgId);
  const curAcc = scope.accounts.find((a) => a.id === scope.accountId);
  const aggregate = ready?.status || null;
  const aggregateTone = aggregate === 'ready' ? 'green' : readyErr ? 'red' : 'amber';

  const rate = runs.total ? Math.round((100 * runs.success) / runs.total) : null;

  const cards = [
    { icon: faBuilding, label: 'ORGANIZATIONS', value: inv.orgs, to: '/orgs', hint: inv.orgs ? `${inv.orgs} total` : 'None yet — create one' },
    { icon: faBoxes, label: 'ACCOUNTS', value: inv.accounts, to: '/accounts', hint: scope.orgId ? `in ${curOrg?.slug || 'org'}` : 'Pick an organization' },
    { icon: faUsers, label: 'USERS', value: inv.users, to: '/users', hint: scope.orgId ? `in ${curOrg?.slug || 'org'}` : 'Pick an organization' },
    {
      icon: faBolt,
      label: 'WORKFLOWS',
      value: inv.workflows,
      to: '/workflows',
      hint: inv.workflows == null ? 'Engine unreachable?' : `${inv.active ?? 0} active of ${inv.workflows}`,
    },
    { icon: faClockRotateLeft, label: 'RECENT EXECUTIONS', value: runs.total, to: '/workflows', hint: `Last ${EXEC_WINDOW} runs` },
  ];

  return (
    <>
      <PageTitle
        title="Dashboard"
        sub="Tier-1 PaaS cluster status"
        right={
          <Btn onClick={load} kind="secondary" disabled={busy}>
            <FontAwesomeIcon icon={faRotate} spin={busy} className="mr-2" />
            {busy ? 'Reloading…' : 'Reload'}
          </Btn>
        }
      />
      {scope.scopeErr && <Err e={scope.scopeErr} />}
      <ScopeBar scope={scope} />

      {/* Inventory — 1 col @360px, 2 cols @640px, 3 @lg, 5 @xl (1280px). */}
      {invErr && <Err e={invErr} />}
      <section aria-label="Inventory" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 mb-6">
        {cards.map((c, i) => (
          <Card key={c.label} className="min-w-0">
            <div className="flex items-center gap-2 text-normal-text text-xs mb-2 tracking-wide">
              <FontAwesomeIcon icon={c.icon} aria-hidden="true" />
              <span className="truncate">{c.label}</span>
            </div>
            <StatValue loading={i < 4 ? invLoading : runsLoading} value={c.value} />
            <div className="mt-2 flex items-center justify-between gap-2 min-w-0">
              <span className="text-xs text-normal-text truncate">{(i < 4 ? invLoading : runsLoading) ? '…' : c.hint}</span>
              <Link to={c.to} className="text-xs text-main-blue whitespace-nowrap hover:underline">
                Manage →
              </Link>
            </div>
          </Card>
        ))}
      </section>

      {/* Service health — aggregate + per-service probes from gateway /ready. */}
      <section aria-label="Service health" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <Card className="min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold text-main-text">Gateway</h3>
            {readyLoading ? (
              <Skeleton className="h-5 w-16" />
            ) : (
              <Badge tone={aggregateTone}>{aggregate || 'unreachable'}</Badge>
            )}
          </div>
          <p className="text-xs text-normal-text mt-2 break-all">{baseUrl()}</p>
          <p className="text-xs text-normal-text mt-1">
            {readyLoading ? 'Probing /ready…' : readyErr ? 'Gateway is unreachable — is the stack up?' : 'Aggregate of all upstreams below'}
          </p>
          {readyErr && !readyLoading && (
            <button onClick={loadReady} className="mt-2 text-xs text-main-blue hover:underline">
              Retry probe
            </button>
          )}
        </Card>
        {SERVICE_DEFS.slice(1).map((s) => {
          const u = matchUpstream(ready?.upstreams, s.key);
          return (
            <Card key={s.key} className="min-w-0">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-main-text capitalize">{s.label}</h3>
                {readyLoading ? (
                  <Skeleton className="h-5 w-5 !rounded-full" />
                ) : (
                  <FontAwesomeIcon
                    icon={u?.ok ? faCircleCheck : faCircleXmark}
                    title={u ? (u.ok ? 'OK' : 'Unreachable') : 'No probe data'}
                    className={u?.ok ? 'text-emerald-500 text-xl' : 'text-red-500 text-xl'}
                  />
                )}
              </div>
              <p className="text-xs text-normal-text mt-2">
                {readyLoading ? (
                  'Probing…'
                ) : u ? (
                  u.ok ? (
                    <>OK · {u.ms}ms · HTTP {u.status}</>
                  ) : (
                    'Unreachable'
                  )
                ) : readyErr ? (
                  'No probe data — gateway unreachable'
                ) : (
                  'No probe data from /ready'
                )}
              </p>
              <p className="text-xs text-normal-text mt-1 truncate">{s.hint}</p>
            </Card>
          );
        })}
      </section>

      {/* Workflow health — stack @360/768px, split @1024px+. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card className="min-w-0">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="font-semibold text-main-text flex items-center gap-2">
              <FontAwesomeIcon icon={faChartSimple} className="text-normal-text" aria-hidden="true" />
              Workflow health
            </h3>
            <Link to="/workflows" className="text-xs text-main-blue whitespace-nowrap hover:underline">
              Open workflows →
            </Link>
          </div>
          {runsErr && <Err e={runsErr} />}
          {runsLoading ? (
            <div className="space-y-2" aria-label="Loading workflow health">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-2.5 w-full !rounded-full" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : runs.total == null ? (
            <Empty text="Execution stats unavailable — is workflow-service up?" />
          ) : (
            <>
              <p className="text-sm text-main-text">
                Active workflows{' '}
                <strong className="tabular-nums">{invLoading ? '…' : inv.active ?? '—'}</strong>
                <span className="text-normal-text"> of {invLoading ? '…' : inv.workflows ?? '—'}</span>
              </p>
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-normal-text">Success rate · last {EXEC_WINDOW} runs</span>
                  <span className="font-semibold text-main-text tabular-nums">{rate == null ? '—' : `${rate}%`}</span>
                </div>
                <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden" role="progressbar" aria-valuenow={rate ?? 0} aria-valuemin={0} aria-valuemax={100}>
                  <div
                    className="h-full bg-gradient-to-r from-main-start to-main-end rounded-full transition-all"
                    style={{ width: `${rate ?? 0}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-normal-text tabular-nums">
                  <span className="text-emerald-600 font-medium">{runs.success} ok</span>
                  {' · '}
                  <span className="text-red-500 font-medium">{runs.error} failed</span>
                  {' · '}
                  {runs.waiting} waiting
                </p>
              </div>
            </>
          )}
        </Card>
        <Card className="min-w-0">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="font-semibold text-main-text">Recent executions</h3>
            <Link to="/workflows" className="text-xs text-main-blue whitespace-nowrap hover:underline">
              All runs →
            </Link>
          </div>
          {runsLoading ? (
            <ul className="space-y-2" aria-label="Loading recent executions">
              {[0, 1, 2, 3, 4].map((i) => (
                <li key={i} className="flex items-center gap-2">
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-20" />
                </li>
              ))}
            </ul>
          ) : runs.items.length ? (
            <ul className="space-y-2 text-xs">
              {runs.items.map((x) => {
                const st = execStatus(x);
                return (
                  <li key={x.id} className="flex items-center gap-2 min-w-0">
                    <Badge tone={st === 'success' ? 'green' : st === 'error' ? 'red' : 'gray'}>
                      {(x.status || x.mode || '?').toString().toUpperCase()}
                    </Badge>
                    <span className="font-mono text-main-text whitespace-nowrap">{String(x.id).slice(0, 8)}…</span>
                    <span className="ml-auto text-normal-text whitespace-nowrap">{x.startedAt ? fmtTime(x.startedAt) : '—'}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty
              text={runsErr ? 'Could not load executions' : 'No executions yet — execute a workflow to see runs here'}
              action={
                <Link to="/workflows" className="px-3 py-1.5 rounded-2xl bg-background text-xs text-main-text hover:text-main-blue">
                  Open workflows
                </Link>
              }
            />
          )}
        </Card>
      </div>

      {/* Activity + shortcuts — stack @360/768px, split @1024px+. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="min-w-0">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="font-semibold text-main-text">Recent activity</h3>
            <Link to="/audit" className="text-xs text-main-blue whitespace-nowrap hover:underline">
              Full log →
            </Link>
          </div>
          {actErr && <Err e={actErr} />}
          {recentLoading ? (
            <ul className="space-y-2" aria-label="Loading recent activity">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="flex items-center gap-2">
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-20" />
                </li>
              ))}
            </ul>
          ) : recent.length ? (
            <ul className="space-y-2 text-xs">
              {recent.map((a) => (
                <li key={a.id} className="flex items-center gap-2 min-w-0">
                  <Badge tone={a.decision ? 'green' : 'red'}>{a.decision ? 'ALLOW' : 'DENY'}</Badge>
                  <span className="font-mono text-main-text truncate">{a.action}</span>
                  <span className="hidden sm:inline font-mono text-normal-text truncate max-w-40">{a.resource}</span>
                  <span className="ml-auto text-normal-text whitespace-nowrap">{fmtTime(a.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              text={actErr ? 'Could not load audit records' : scope.orgId ? 'No audit records yet — authorize calls will appear here' : 'Pick an organization to see activity'}
              action={
                <Link to="/authorize" className="px-3 py-1.5 rounded-2xl bg-background text-xs text-main-text hover:text-main-blue">
                  Open authorize simulator
                </Link>
              }
            />
          )}
        </Card>
        <div className="flex flex-col gap-4 min-w-0">
          <Card className="min-w-0">
            <h3 className="font-semibold text-main-text mb-1">Current context</h3>
            <p className="text-lg font-semibold text-main-text truncate">
              {curOrg?.slug || '—'} <span className="text-normal-text font-normal">/ {curAcc?.slug || '—'}</span>
            </p>
            <p className="text-xs text-normal-text mt-1">
              Changing the picker above (or in the header) re-filters every page instantly.
            </p>
          </Card>
          <Card className="min-w-0">
            <h3 className="font-semibold text-main-text mb-3 flex items-center gap-2">
              <FontAwesomeIcon icon={faListCheck} className="text-normal-text" aria-hidden="true" />
              Admin shortcuts
            </h3>
            <div className="flex flex-wrap gap-2 text-sm">
              {[
                ['/orgs', 'Organizations'],
                ['/accounts', 'Accounts'],
                ['/users', 'Users'],
                ['/workflows', 'Workflows'],
                ['/authorize', 'Authorize simulator'],
                ['/audit', 'Audit log'],
                ['/api-docs', 'API Docs'],
              ].map(([to, label]) => (
                <Link key={to} to={to} className="px-3 py-1.5 rounded-2xl bg-background text-main-text hover:text-main-blue">
                  {label}
                </Link>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
