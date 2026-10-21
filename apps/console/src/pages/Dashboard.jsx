/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  faUsers,
  faKey,
  faRobot,
  faLink,
  faFilter,
  faArrowsRotate,
  faMagnifyingGlass,
  faCircleExclamation,
  faArrowTrendUp,
  faChartLine,
  faEye,
  faCopy,
  faCheck,
  faLayerGroup,
  faChevronLeft,
  faChevronRight,
  faServer,
} from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { api, baseUrl } from '../lib/api.js';
import { ScopeBar, useScope } from '../components/Scope.jsx';
import {
  Badge,
  Btn,
  Card,
  Code,
  Empty,
  Err,
  Modal,
  PageTitle,
  Skeleton,
  StatValue,
} from '../components/ui.jsx';

const SERVICE_DEFS = [
  { key: 'gateway', label: 'Gateway', hint: 'Single entry point · auth + rate-limit + telemetry' },
  { key: 'iam', label: 'IAM', hint: 'Orgs · users · roles · policies · keys · usage' },
  { key: 'workflow', label: 'Workflow', hint: 'Templates · runs · webhooks + cron' },
  { key: 'ai', label: 'AI', hint: 'Docs chatbot + agent endpoint' },
  { key: 'lds', label: 'Linked Data', hint: 'NGSI-LD datasources & licensed entities' },
  { key: 'base', label: 'SynapseBase', hint: 'Document collections & query engine' },
  { key: 'faststore', label: 'Faststore', hint: 'Low-latency key-value & tenant cache' },
  { key: 'queue', label: 'SynapseQueue', hint: 'Message queues, worker jobs & dead-letters' },
];

const FEATURE_META = {
  all: { label: 'All Features', icon: faLayerGroup, color: 'text-main-blue' },
  iam: { label: 'IAM & Security', icon: faUsers, hint: 'Orgs, accounts, users, roles, policies, keys' },
  workflows: { label: 'SynapseFlow', icon: faBolt, hint: 'Autonomous agents, decision routing, templates, graph runs' },
  ai: { label: 'AI Assistant', icon: faRobot, hint: 'Documentation chatbot & automated agent' },
  lds: { label: 'SynapseLDS', icon: faLink, hint: 'Linked Data datasources, NGSI-LD & licenses' },
  base: { label: 'SynapseBase', icon: faBoxes, hint: 'Document collections, queries & change feed' },
  faststore: { label: 'Faststore', icon: faBolt, hint: 'Low-latency key-value cache & distributed locks' },
  queue: { label: 'SynapseQueue', icon: faListCheck, hint: 'Message queues, worker jobs & dead-letters' },
  auth: { label: 'Auth & Session', icon: faKey, hint: 'User login, token refresh, OIDC & verification' },
  usage: { label: 'Telemetry', icon: faChartSimple, hint: 'Usage metrics & request logging' },
};

const TIME_RANGES = [
  { id: '1h', label: '1 hour', ms: 3600 * 1000 },
  { id: '24h', label: '24 hours', ms: 24 * 3600 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 3600 * 1000 },
  { id: '30d', label: '30 days', ms: 30 * 24 * 3600 * 1000 },
];

const EXEC_WINDOW = 20;
const EVENTS_LIMIT = 20;

function matchUpstream(upstreams, key) {
  const list = Array.isArray(upstreams) ? upstreams : [];
  const hit = list.find((u) => String(u?.name || '').toLowerCase().includes(key));
  return hit || null;
}

function fmtTime(t) {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function fmtRelative(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = Date.now();
  const diff = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (Number.isNaN(diff)) return '—';
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function fmtNumber(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString();
}

function fmtMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1) return '< 1 ms';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

function latencyTone(ms) {
  if (ms == null) return 'text-normal-text';
  if (ms < 100) return 'text-emerald-600 font-medium';
  if (ms < 500) return 'text-amber-500 font-medium';
  return 'text-red-500 font-medium';
}

function methodBadgeTone(method) {
  const m = String(method || '').toUpperCase();
  if (m === 'GET') return 'blue';
  if (m === 'POST') return 'green';
  if (m === 'PUT' || m === 'PATCH') return 'amber';
  if (m === 'DELETE') return 'red';
  return 'gray';
}

function statusBadgeTone(status) {
  const s = Number(status) || 0;
  if (s >= 200 && s < 300) return 'green';
  if (s >= 300 && s < 400) return 'blue';
  if (s >= 400 && s < 500) return 'amber';
  if (s >= 500) return 'red';
  return 'gray';
}

function asList(v) {
  if (Array.isArray(v)) return v;
  if (Array.isArray(v?.data)) return v.data;
  return null;
}

// Fresh telemetry window [now - rangeMs, now], computed at fetch time so a
// reload always ends at the current moment instead of a frozen mount time.
function usageWindow(rangeMs) {
  const to = new Date();
  return { from: new Date(to.getTime() - rangeMs).toISOString(), to: to.toISOString() };
}

function execStatus(x) {
  return String(x?.status || x?.mode || '').toLowerCase();
}

export default function Dashboard() {
  const { headers } = useAuth();
  const scope = useScope();

  // Active view tab: 'usage' (Usage & Requests) or 'system' (Cluster Health & Inventory)
  const [activeTab, setActiveTab] = useState('usage');

  // Usage telemetry filters
  const [timeRange, setTimeRange] = useState('24h');
  const [featureFilter, setFeatureFilter] = useState('all');
  const [statusClassFilter, setStatusClassFilter] = useState('all');
  const [methodFilter, setMethodFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Pagination for events table
  const [offset, setOffset] = useState(0);

  // Modal inspection of a specific request
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [copiedId, setCopiedId] = useState(false);

  // Telemetry data states
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryErr, setSummaryErr] = useState(null);

  const [eventsData, setEventsData] = useState({ total: 0, items: [] });
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsErr, setEventsErr] = useState(null);

  // System & cluster status states
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

  // Debounce search query input (300ms)
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Selected window length. The actual [from, to] bounds are computed inside
  // each fetch so a reload always covers the freshest slice of telemetry.
  const rangeMs = (TIME_RANGES.find((r) => r.id === timeRange) || TIME_RANGES[1]).ms;

  // Fetch Usage Summary
  const loadUsageSummary = useCallback(async () => {
    if (!scope.orgId) {
      setSummary(null);
      setSummaryLoading(false);
      return;
    }
    setSummaryErr(null);
    setSummaryLoading(true);
    try {
      // Telemetry is org-wide: the per-account picker does not scope usage
      // (login JWTs carry only an org claim, so filtering by account would
      // hide every user-session request).
      const params = usageWindow(rangeMs);
      if (featureFilter !== 'all') params.feature = featureFilter;
      if (statusClassFilter !== 'all') params.statusClass = statusClassFilter;
      if (methodFilter !== 'all') params.method = methodFilter;
      if (debouncedSearch.trim()) params.q = debouncedSearch.trim();

      const res = await api.usageSummary(params, headers);
      setSummary(res);
    } catch (e) {
      setSummary(null);
      setSummaryErr(e);
    } finally {
      setSummaryLoading(false);
    }
  }, [scope.orgId, rangeMs, featureFilter, statusClassFilter, methodFilter, debouncedSearch, headers]);

  // Fetch Usage Events
  const loadUsageEvents = useCallback(async () => {
    if (!scope.orgId) {
      setEventsData({ total: 0, items: [] });
      setEventsLoading(false);
      return;
    }
    setEventsErr(null);
    setEventsLoading(true);
    try {
      const params = {
        ...usageWindow(rangeMs),
        limit: EVENTS_LIMIT,
        offset,
      };
      if (featureFilter !== 'all') params.feature = featureFilter;
      if (statusClassFilter !== 'all') params.statusClass = statusClassFilter;
      if (methodFilter !== 'all') params.method = methodFilter;
      if (debouncedSearch.trim()) params.q = debouncedSearch.trim();

      const res = await api.usageEvents(params, headers);
      setEventsData(res || { total: 0, items: [] });
    } catch (e) {
      setEventsData({ total: 0, items: [] });
      setEventsErr(e);
    } finally {
      setEventsLoading(false);
    }
  }, [scope.orgId, rangeMs, featureFilter, statusClassFilter, methodFilter, debouncedSearch, offset, headers]);

  // Load cluster system health
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
      const [uR, fR] = await Promise.allSettled([
        orgId ? api.users(orgId, headers) : Promise.resolve(null),
        api.workflows(headers),
      ]);
      const firstErr = [uR, fR].find((r) => r.status === 'rejected');
      setInvErr(firstErr ? firstErr.reason : null);
      const flows = fR.status === 'fulfilled' ? asList(fR.value) : null;
      setInv({
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
  }, [headers, scope.orgId, scope.orgs.length, scope.accounts.length]);

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

  // Overall refresh triggers both telemetry and cluster info
  const loadAll = useCallback(() => {
    loadUsageSummary();
    loadUsageEvents();
    loadReady();
    loadInventory();
    loadRuns();
    loadActivity();
  }, [loadUsageSummary, loadUsageEvents, loadReady, loadInventory, loadRuns, loadActivity]);

  useEffect(() => {
    loadUsageSummary();
  }, [loadUsageSummary]);

  useEffect(() => {
    loadUsageEvents();
  }, [loadUsageEvents]);

  useEffect(() => {
    loadReady();
    loadInventory();
    loadRuns();
    loadActivity();
  }, [loadReady, loadInventory, loadRuns, loadActivity]);

  const isBusy = summaryLoading || eventsLoading || readyLoading || invLoading || runsLoading || recentLoading;

  const curOrg = scope.orgs.find((o) => o.id === scope.orgId);
  const curAcc = scope.accounts.find((a) => a.id === scope.accountId);

  // Cluster aggregate status
  const aggregate = ready?.status || null;
  const aggregateTone = aggregate === 'ready' ? 'green' : readyErr ? 'red' : 'amber';
  const workflowSuccessRate = runs.total ? Math.round((100 * runs.success) / runs.total) : null;

  // Usage summary totals
  const totals = summary?.totals || {
    requests: 0,
    success: 0,
    clientErrors: 0,
    serverErrors: 0,
    errorRate: 0,
    avgMs: 0,
    p95Ms: 0,
    uniqueUsers: 0,
    uniqueAccounts: 0,
    lastRequestAt: null,
  };

  const totalReq = totals.requests;
  const totalErrors = totals.clientErrors + totals.serverErrors;
  const successPercent = totalReq > 0 ? ((totals.success / totalReq) * 100).toFixed(1) : '100.0';
  const successTone = totals.errorRate === 0 ? 'green' : totals.errorRate < 5 ? 'amber' : 'red';

  // Feature stats list
  const featureStats = summary?.features || [];

  // Series points for timeline chart
  const series = summary?.series || [];
  const maxSeriesReq = useMemo(() => {
    if (!series.length) return 1;
    return Math.max(1, ...series.map((s) => s.requests || 0));
  }, [series]);

  // Pagination bounds
  const totalEvents = eventsData.total || 0;
  const currentStart = totalEvents > 0 ? offset + 1 : 0;
  const currentEnd = Math.min(offset + EVENTS_LIMIT, totalEvents);
  const hasPrev = offset > 0;
  const hasNext = offset + EVENTS_LIMIT < totalEvents;

  const resetFilters = () => {
    setFeatureFilter('all');
    setStatusClassFilter('all');
    setMethodFilter('all');
    setSearchQuery('');
    setOffset(0);
  };

  const hasActiveFilters = featureFilter !== 'all' || statusClassFilter !== 'all' || methodFilter !== 'all' || searchQuery.trim() !== '';

  const copyRequestId = async (id) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    } catch {
      /* best effort */
    }
  };

  return (
    <>
      <PageTitle
        title="Dashboard"
        sub={
          activeTab === 'usage'
            ? 'Organization-wide usage analytics, feature statistics & request telemetry'
            : 'Tier-1 PaaS cluster status, services & inventory'
        }
        right={
          <div className="flex flex-wrap items-center gap-2">
            {/* View Tab Selector */}
            <div className="bg-slate-100 p-1 rounded-2xl flex items-center text-xs font-medium">
              <button
                type="button"
                onClick={() => setActiveTab('usage')}
                className={`px-3 py-1.5 rounded-xl transition-all ${
                  activeTab === 'usage'
                    ? 'bg-white text-main-blue shadow-sm font-semibold'
                    : 'text-normal-text hover:text-main-text'
                }`}
              >
                <FontAwesomeIcon icon={faChartSimple} className="mr-1.5" />
                Usage & Requests
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('system')}
                className={`px-3 py-1.5 rounded-xl transition-all ${
                  activeTab === 'system'
                    ? 'bg-white text-main-blue shadow-sm font-semibold'
                    : 'text-normal-text hover:text-main-text'
                }`}
              >
                <FontAwesomeIcon icon={faServer} className="mr-1.5" />
                System & Health
              </button>
            </div>

            <Btn onClick={loadAll} kind="secondary" loading={isBusy}>
              <FontAwesomeIcon icon={faArrowsRotate} className={isBusy ? 'animate-spin' : ''} />
              <span>Reload</span>
            </Btn>
          </div>
        }
      />

      {scope.scopeErr && <Err e={scope.scopeErr} />}
      <ScopeBar scope={scope} />

      {/* ======================================================== */}
      {/* TAB 1: USAGE & REQUESTS TELEMETRY                         */}
      {/* ======================================================== */}
      {activeTab === 'usage' && (
        <div className="space-y-6">
          {!scope.orgId ? (
            <Card>
              <Empty
                text="Please select an organization in the picker above to inspect usage statistics and request logs."
                action={
                  <Link to="/orgs" className="px-4 py-2 rounded-2xl bg-gradient-to-b from-main-start to-main-end text-white text-sm font-medium">
                    Pick or Create Organization
                  </Link>
                }
              />
            </Card>
          ) : (
            <>
              {summaryErr && <Err e={summaryErr} />}

              {/* Time Range & Filtering Toolbar */}
              <Card className="min-w-0 !p-4">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  {/* Time Range Selector */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-normal-text mr-1">Time Range:</span>
                    {TIME_RANGES.map((r) => {
                      const active = timeRange === r.id;
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => {
                            setTimeRange(r.id);
                            setOffset(0);
                          }}
                          className={`px-3 py-1 rounded-2xl text-xs font-medium transition-all ${
                            active
                              ? 'bg-main-blue text-white shadow-sm'
                              : 'bg-background text-normal-text hover:text-main-text hover:bg-slate-200'
                          }`}
                        >
                          {r.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Filter controls */}
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Feature Dropdown */}
                    <select
                      value={featureFilter}
                      onChange={(e) => {
                        setFeatureFilter(e.target.value);
                        setOffset(0);
                      }}
                      className="px-3 py-1 rounded-2xl border border-slate-200 text-xs text-main-text bg-white outline-none focus:border-main-blue"
                    >
                      <option value="all">All Features</option>
                      <option value="iam">IAM & Security</option>
                      <option value="workflows">SynapseFlow</option>
                      <option value="ai">AI Assistant</option>
                      <option value="lds">SynapseLDS</option>
                      <option value="base">SynapseBase</option>
                      <option value="faststore">Faststore</option>
                      <option value="queue">SynapseQueue</option>
                      <option value="auth">Auth & Session</option>
                    </select>

                    {/* Status Class Dropdown */}
                    <select
                      value={statusClassFilter}
                      onChange={(e) => {
                        setStatusClassFilter(e.target.value);
                        setOffset(0);
                      }}
                      className="px-3 py-1 rounded-2xl border border-slate-200 text-xs text-main-text bg-white outline-none focus:border-main-blue"
                    >
                      <option value="all">All Statuses</option>
                      <option value="2xx">2xx Success</option>
                      <option value="3xx">3xx Redirection</option>
                      <option value="4xx">4xx Client Error</option>
                      <option value="5xx">5xx Server Error</option>
                    </select>

                    {/* Method Dropdown */}
                    <select
                      value={methodFilter}
                      onChange={(e) => {
                        setMethodFilter(e.target.value);
                        setOffset(0);
                      }}
                      className="px-3 py-1 rounded-2xl border border-slate-200 text-xs text-main-text bg-white outline-none focus:border-main-blue"
                    >
                      <option value="all">All Methods</option>
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                      <option value="DELETE">DELETE</option>
                      <option value="PATCH">PATCH</option>
                    </select>

                    {/* Search Input */}
                    <div className="relative">
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search path or ID..."
                        className="w-44 px-3 py-1 pl-7 rounded-2xl border border-slate-200 text-xs text-main-text outline-none focus:border-main-blue"
                      />
                      <FontAwesomeIcon
                        icon={faMagnifyingGlass}
                        className="absolute left-2.5 top-2 text-[10px] text-normal-text"
                      />
                    </div>

                    {hasActiveFilters && (
                      <button
                        type="button"
                        onClick={resetFilters}
                        className="px-2.5 py-1 text-xs text-red-500 hover:underline font-medium"
                      >
                        Reset filters
                      </button>
                    )}
                  </div>
                </div>

                <p className="mt-3 pt-3 border-t border-slate-100 text-[11px] text-normal-text flex items-start gap-1.5">
                  <FontAwesomeIcon icon={faLayerGroup} className="text-main-blue mt-0.5" />
                  <span>
                    Usage is aggregated across all accounts in this organization — the account picker
                    above does not filter request telemetry.
                  </span>
                </p>
              </Card>

              {/* KPI Stat Cards (5 metrics) */}
              <section aria-label="Usage KPI Metrics" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
                {/* 1. Total Requests */}
                <Card className="min-w-0">
                  <div className="flex items-center gap-2 text-normal-text text-xs mb-2 tracking-wide font-medium">
                    <FontAwesomeIcon icon={faBolt} className="text-main-blue" />
                    <span>TOTAL REQUESTS</span>
                  </div>
                  <StatValue loading={summaryLoading} value={fmtNumber(totalReq)} />
                  <div className="mt-2 text-xs text-normal-text truncate">
                    {summaryLoading ? '…' : `${fmtNumber(totals.success)} ok · ${fmtNumber(totalErrors)} errors`}
                  </div>
                </Card>

                {/* 2. Success Rate */}
                <Card className="min-w-0">
                  <div className="flex items-center justify-between text-normal-text text-xs mb-2 tracking-wide font-medium">
                    <div className="flex items-center gap-2">
                      <FontAwesomeIcon icon={faCircleCheck} className="text-emerald-500" />
                      <span>SUCCESS RATE</span>
                    </div>
                    {!summaryLoading && totalReq > 0 && (
                      <Badge tone={successTone}>{`${successPercent}%`}</Badge>
                    )}
                  </div>
                  <StatValue loading={summaryLoading} value={totalReq > 0 ? `${successPercent}%` : '—'} />
                  <div className="mt-2 text-xs text-normal-text truncate">
                    {summaryLoading ? '…' : `${totals.errorRate}% error rate`}
                  </div>
                </Card>

                {/* 3. Avg Latency & P95 */}
                <Card className="min-w-0">
                  <div className="flex items-center gap-2 text-normal-text text-xs mb-2 tracking-wide font-medium">
                    <FontAwesomeIcon icon={faClockRotateLeft} className="text-amber-500" />
                    <span>AVG LATENCY</span>
                  </div>
                  <StatValue loading={summaryLoading} value={totalReq > 0 ? fmtMs(totals.avgMs) : '—'} />
                  <div className="mt-2 text-xs text-normal-text truncate">
                    {summaryLoading ? '…' : `P95: ${fmtMs(totals.p95Ms)}`}
                  </div>
                </Card>

                {/* 4. Active Actors */}
                <Card className="min-w-0">
                  <div className="flex items-center gap-2 text-normal-text text-xs mb-2 tracking-wide font-medium">
                    <FontAwesomeIcon icon={faUsers} className="text-main-blue" />
                    <span>ACTIVE ACTORS</span>
                  </div>
                  <StatValue loading={summaryLoading} value={totalReq > 0 ? fmtNumber(totals.uniqueUsers) : '—'} />
                  <div className="mt-2 text-xs text-normal-text truncate">
                    {summaryLoading ? '…' : `Across ${fmtNumber(totals.uniqueAccounts)} account(s)`}
                  </div>
                </Card>

                {/* 5. Last Activity */}
                <Card className="min-w-0">
                  <div className="flex items-center gap-2 text-normal-text text-xs mb-2 tracking-wide font-medium">
                    <FontAwesomeIcon icon={faArrowTrendUp} className="text-emerald-500" />
                    <span>LAST REQUEST</span>
                  </div>
                  <p className="text-2xl font-semibold text-main-text truncate">
                    {summaryLoading ? '…' : totals.lastRequestAt ? fmtRelative(totals.lastRequestAt) : 'None'}
                  </p>
                  <div className="mt-2 text-xs text-normal-text truncate">
                    {totals.lastRequestAt ? fmtTime(totals.lastRequestAt) : 'No requests in window'}
                  </div>
                </Card>
              </section>

              {/* Request Volume Timeline (Activity Histogram) */}
              <Card className="min-w-0">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
                  <div>
                    <h3 className="font-semibold text-main-text flex items-center gap-2">
                      <FontAwesomeIcon icon={faChartLine} className="text-main-blue" />
                      Request Activity Timeline
                    </h3>
                    <p className="text-xs text-normal-text mt-0.5">
                      Request throughput and error distribution over time
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-normal-text">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm bg-gradient-to-r from-main-start to-main-end inline-block" />
                      <span>Successful</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm bg-red-500 inline-block" />
                      <span>Errors</span>
                    </div>
                  </div>
                </div>

                {summaryLoading ? (
                  <div className="h-32 flex items-center justify-center">
                    <Skeleton className="h-28 w-full" />
                  </div>
                ) : series.length === 0 || totalReq === 0 ? (
                  <div className="h-28 flex flex-col items-center justify-center border border-dashed border-slate-200 rounded-2xl text-center">
                    <p className="text-xs text-normal-text">No request activity captured in this time window.</p>
                    <p className="text-[11px] text-normal-text mt-1">Make API calls via Gateway to see live throughput bars here.</p>
                  </div>
                ) : (
                  <div className="mt-2">
                    <div className="h-36 w-full flex items-end gap-1 px-1 pt-4 pb-2 bg-background rounded-2xl overflow-x-auto">
                      {series.map((pt, idx) => {
                        const count = pt.requests || 0;
                        const errors = pt.errors || 0;
                        const successCount = Math.max(0, count - errors);

                        // Percent of max height (up to 100px)
                        const totalPct = count > 0 ? Math.max(6, Math.min(100, Math.round((count / maxSeriesReq) * 100))) : 0;
                        const errorPct = count > 0 && errors > 0 ? Math.max(4, Math.round((errors / count) * totalPct)) : 0;
                        const successPct = Math.max(0, totalPct - errorPct);

                        const timeLabel = new Date(pt.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                        return (
                          <div
                            key={pt.ts || idx}
                            className="flex-1 min-w-[12px] max-w-[28px] h-full flex flex-col justify-end items-center group relative cursor-pointer"
                          >
                            {/* Hover Tooltip */}
                            <div className="opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity absolute bottom-full mb-2 z-30 bg-slate-500 text-white text-[11px] rounded-xl px-2.5 py-1.5 whitespace-nowrap shadow-md">
                              <p className="font-semibold">{new Date(pt.ts).toLocaleString()}</p>
                              <p className="mt-0.5">{count} request(s) · {errors} error(s)</p>
                              {count > 0 && <p className="text-slate-200">{fmtMs(pt.avgMs)} avg latency</p>}
                            </div>

                            {/* Bar Stack */}
                            <div className="w-full flex flex-col justify-end rounded-t-sm overflow-hidden" style={{ height: `${totalPct}%` }}>
                              {errorPct > 0 && (
                                <div className="w-full bg-red-500 transition-all" style={{ height: `${errorPct}%` }} />
                              )}
                              {successPct > 0 && (
                                <div className="w-full bg-gradient-to-t from-main-end to-main-start transition-all" style={{ height: `${successPct}%` }} />
                              )}
                            </div>
                            <span className="text-[9px] text-normal-text mt-1 hidden sm:inline select-none truncate">
                              {idx % Math.ceil(series.length / 8) === 0 ? timeLabel : ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </Card>

              {/* Feature Usage Breakdown Table */}
              <Card className="min-w-0">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="font-semibold text-main-text flex items-center gap-2">
                      <FontAwesomeIcon icon={faLayerGroup} className="text-main-blue" />
                      Feature Usage Breakdown
                    </h3>
                    <p className="text-xs text-normal-text mt-0.5">
                      Request distribution, latency, and error rates across SynapseDX platform capabilities
                    </p>
                  </div>
                  {featureFilter !== 'all' && (
                    <div className="flex items-center gap-2">
                      <Badge tone="blue">Filter: {FEATURE_META[featureFilter]?.label || featureFilter}</Badge>
                      <button
                        type="button"
                        onClick={() => setFeatureFilter('all')}
                        className="text-xs text-normal-text hover:text-main-text"
                      >
                        Clear
                      </button>
                    </div>
                  )}
                </div>

                {summaryLoading ? (
                  <div className="space-y-3">
                    {[0, 1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : featureStats.length === 0 ? (
                  <Empty text="No feature telemetry recorded in this time range" />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs font-semibold text-normal-text border-b border-slate-100">
                          <th className="py-2.5 pr-4">Feature</th>
                          <th className="py-2.5 pr-4">Traffic Share</th>
                          <th className="py-2.5 pr-4">Requests</th>
                          <th className="py-2.5 pr-4">Errors</th>
                          <th className="py-2.5 pr-4">Error Rate</th>
                          <th className="py-2.5 pr-4">Avg Latency</th>
                          <th className="py-2.5 pr-4">P95 Latency</th>
                          <th className="py-2.5 pr-4">Last Active</th>
                          <th className="py-2.5 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {featureStats.map((f) => {
                          const meta = FEATURE_META[f.feature] || {
                            label: f.feature,
                            icon: faBoxes,
                            hint: 'Platform capability',
                          };
                          const isFiltered = featureFilter === f.feature;
                          const errs = (f.clientErrors || 0) + (f.serverErrors || 0);

                          return (
                            <tr
                              key={f.feature}
                              className={`hover:bg-background/80 transition-colors ${
                                isFiltered ? 'bg-main-blue/5' : ''
                              }`}
                            >
                              <td className="py-3 pr-4 whitespace-nowrap">
                                <div className="flex items-center gap-2">
                                  <div className="w-7 h-7 rounded-xl bg-slate-100 flex items-center justify-center text-main-blue shrink-0">
                                    <FontAwesomeIcon icon={meta.icon} />
                                  </div>
                                  <div>
                                    <span className="font-semibold text-main-text">{meta.label}</span>
                                    <p className="text-[11px] text-normal-text font-mono">{f.feature}</p>
                                  </div>
                                </div>
                              </td>

                              {/* Traffic Share with progress bar */}
                              <td className="py-3 pr-4 whitespace-nowrap min-w-[130px]">
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                                    <div
                                      className="h-full bg-gradient-to-r from-main-start to-main-end rounded-full"
                                      style={{ width: `${Math.min(100, Math.max(4, f.share || 0))}%` }}
                                    />
                                  </div>
                                  <span className="font-mono text-normal-text tabular-nums">{f.share || 0}%</span>
                                </div>
                              </td>

                              <td className="py-3 pr-4 font-mono font-medium text-main-text tabular-nums whitespace-nowrap">
                                {fmtNumber(f.requests)}
                              </td>

                              <td className="py-3 pr-4 font-mono tabular-nums whitespace-nowrap">
                                <span className={errs > 0 ? 'text-red-500 font-medium' : 'text-normal-text'}>
                                  {fmtNumber(errs)}
                                </span>
                              </td>

                              <td className="py-3 pr-4 whitespace-nowrap">
                                <Badge tone={f.errorRate === 0 ? 'green' : f.errorRate < 5 ? 'amber' : 'red'}>
                                  {f.errorRate}%
                                </Badge>
                              </td>

                              <td className={`py-3 pr-4 font-mono tabular-nums whitespace-nowrap ${latencyTone(f.avgMs)}`}>
                                {fmtMs(f.avgMs)}
                              </td>

                              <td className="py-3 pr-4 font-mono tabular-nums text-normal-text whitespace-nowrap">
                                {fmtMs(f.p95Ms)}
                              </td>

                              <td className="py-3 pr-4 text-normal-text whitespace-nowrap">
                                {f.lastRequestAt ? fmtRelative(f.lastRequestAt) : '—'}
                              </td>

                              <td className="py-3 text-right whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setFeatureFilter(f.feature);
                                    setOffset(0);
                                  }}
                                  className="text-xs text-main-blue hover:underline font-medium"
                                >
                                  {isFiltered ? 'Filtering' : 'Filter requests →'}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              {/* 2-Column: Top Endpoints & Traffic Breakdown */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Top Routes */}
                <Card className="min-w-0">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-main-text">Top API Endpoints</h3>
                    <span className="text-xs text-normal-text">By request volume</span>
                  </div>
                  {summaryLoading ? (
                    <div className="space-y-2">
                      {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-8 w-full" />
                      ))}
                    </div>
                  ) : (summary?.topRoutes || []).length === 0 ? (
                    <Empty text="No route data recorded yet" />
                  ) : (
                    <div className="space-y-2">
                      {(summary?.topRoutes || []).slice(0, 8).map((r, i) => (
                        <div
                          key={`${r.feature}-${r.route}-${r.method}-${i}`}
                          onClick={() => {
                            setSearchQuery(r.route);
                            setOffset(0);
                          }}
                          className="flex items-center justify-between p-2 rounded-2xl bg-background/70 hover:bg-background cursor-pointer text-xs transition-colors"
                          title="Click to filter request logs by this route"
                        >
                          <div className="flex items-center gap-2 min-w-0 mr-2">
                            <Badge tone={methodBadgeTone(r.method)}>{r.method}</Badge>
                            <span className="font-mono text-main-text truncate">{r.route}</span>
                            <span className="text-[10px] text-normal-text font-mono px-1.5 py-0.5 rounded-md bg-white border border-slate-200">
                              {r.feature}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 shrink-0 text-right font-mono tabular-nums">
                            <span className="text-main-text font-medium">{fmtNumber(r.requests)} reqs</span>
                            {r.errors > 0 ? (
                              <span className="text-red-500 font-medium">{r.errors} err</span>
                            ) : (
                              <span className="text-emerald-600">0 err</span>
                            )}
                            <span className="text-normal-text">{fmtMs(r.avgMs)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                {/* Status Classes & Auth Methods */}
                <div className="flex flex-col gap-4 min-w-0">
                  {/* Status Breakdown */}
                  <Card className="min-w-0">
                    <h3 className="font-semibold text-main-text mb-3">Status Code Distribution</h3>
                    {summaryLoading ? (
                      <Skeleton className="h-10 w-full" />
                    ) : (
                      <div className="space-y-2 text-xs">
                        {['2xx', '3xx', '4xx', '5xx'].map((cls) => {
                          const hit = (summary?.statusClasses || []).find((s) => s.class === cls);
                          const count = hit?.count || 0;
                          const pct = totalReq > 0 ? Math.round((count / totalReq) * 100) : 0;
                          const tone = cls === '2xx' ? 'green' : cls === '3xx' ? 'blue' : cls === '4xx' ? 'amber' : 'red';

                          return (
                            <div key={cls} className="flex items-center gap-3">
                              <span className="w-10 font-mono font-semibold text-main-text">{cls}</span>
                              <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all ${
                                    tone === 'green'
                                      ? 'bg-emerald-500'
                                      : tone === 'blue'
                                        ? 'bg-main-blue'
                                        : tone === 'amber'
                                          ? 'bg-amber-400'
                                          : 'bg-red-500'
                                  }`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="w-16 text-right font-mono text-normal-text tabular-nums">
                                {fmtNumber(count)} ({pct}%)
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </Card>

                  {/* Auth Kinds */}
                  <Card className="min-w-0">
                    <h3 className="font-semibold text-main-text mb-3">Caller Authentication Methods</h3>
                    {summaryLoading ? (
                      <Skeleton className="h-10 w-full" />
                    ) : (
                      <div className="flex flex-wrap gap-2 text-xs">
                        {(summary?.authKinds || []).map((ak) => (
                          <div
                            key={ak.kind}
                            className="px-3 py-1.5 rounded-2xl bg-background flex items-center gap-2 font-mono text-main-text"
                          >
                            <span className="capitalize">{ak.kind}</span>
                            <span className="font-semibold text-main-blue">{fmtNumber(ak.requests)}</span>
                          </div>
                        ))}
                        {(summary?.authKinds || []).length === 0 && (
                          <span className="text-xs text-normal-text">No authentication records</span>
                        )}
                      </div>
                    )}
                  </Card>
                </div>
              </div>

              {/* ======================================================== */}
              {/* REQUEST EXPLORER TABLE & DETAILS                          */}
              {/* ======================================================== */}
              <Card className="min-w-0">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                  <div>
                    <h3 className="font-semibold text-main-text flex items-center gap-2">
                      <FontAwesomeIcon icon={faListCheck} className="text-main-blue" />
                      Request Explorer & Detailed Logs
                    </h3>
                    <p className="text-xs text-normal-text mt-0.5">
                      Live request logs proxied by edge gateway with complete latency & actor telemetry
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-normal-text font-mono">
                      Showing {currentStart}–{currentEnd} of {fmtNumber(totalEvents)}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={!hasPrev || eventsLoading}
                        onClick={() => setOffset(Math.max(0, offset - EVENTS_LIMIT))}
                        className="px-2.5 py-1 rounded-xl bg-background text-main-text hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                      >
                        <FontAwesomeIcon icon={faChevronLeft} />
                      </button>
                      <button
                        type="button"
                        disabled={!hasNext || eventsLoading}
                        onClick={() => setOffset(offset + EVENTS_LIMIT)}
                        className="px-2.5 py-1 rounded-xl bg-background text-main-text hover:bg-slate-200 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                      >
                        <FontAwesomeIcon icon={faChevronRight} />
                      </button>
                    </div>
                  </div>
                </div>

                {eventsErr && <Err e={eventsErr} />}

                {eventsLoading ? (
                  <div className="space-y-2">
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <Skeleton key={i} className="h-10 w-full" />
                    ))}
                  </div>
                ) : eventsData.items.length === 0 ? (
                  <Empty
                    text={hasActiveFilters ? 'No requests match your current filters' : 'No requests recorded in this time range'}
                    action={
                      hasActiveFilters ? (
                        <Btn kind="secondary" onClick={resetFilters}>
                          Reset Filters
                        </Btn>
                      ) : undefined
                    }
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs font-semibold text-normal-text border-b border-slate-100">
                          <th className="py-2.5 pr-4">Time</th>
                          <th className="py-2.5 pr-4">Method</th>
                          <th className="py-2.5 pr-4">Path</th>
                          <th className="py-2.5 pr-4">Feature</th>
                          <th className="py-2.5 pr-4">Status</th>
                          <th className="py-2.5 pr-4">Duration</th>
                          <th className="py-2.5 pr-4">Caller</th>
                          <th className="py-2.5 text-right">Details</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {eventsData.items.map((e) => (
                          <tr
                            key={e.id}
                            onClick={() => setSelectedEvent(e)}
                            className="hover:bg-background/80 transition-colors cursor-pointer group"
                          >
                            <td className="py-2.5 pr-4 whitespace-nowrap text-normal-text" title={fmtTime(e.createdAt)}>
                              {fmtRelative(e.createdAt)}
                            </td>

                            <td className="py-2.5 pr-4 whitespace-nowrap">
                              <Badge tone={methodBadgeTone(e.method)}>{e.method}</Badge>
                            </td>

                            <td className="py-2.5 pr-4 font-mono text-main-text max-w-xs truncate" title={e.path}>
                              {e.path}
                            </td>

                            <td className="py-2.5 pr-4 whitespace-nowrap">
                              <span className="text-[11px] font-mono text-normal-text px-2 py-0.5 rounded-full bg-slate-100">
                                {e.feature}
                              </span>
                            </td>

                            <td className="py-2.5 pr-4 whitespace-nowrap">
                              <Badge tone={statusBadgeTone(e.status)}>{e.status}</Badge>
                            </td>

                            <td className={`py-2.5 pr-4 font-mono tabular-nums whitespace-nowrap ${latencyTone(e.durationMs)}`}>
                              {fmtMs(e.durationMs)}
                            </td>

                            <td className="py-2.5 pr-4 max-w-44 truncate text-normal-text" title={e.userEmail || e.authKind}>
                              {e.userEmail || (
                                <span className="font-mono text-[11px] text-normal-text capitalize">
                                  {e.authKind}
                                </span>
                              )}
                            </td>

                            <td className="py-2.5 text-right whitespace-nowrap">
                              <button
                                type="button"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  setSelectedEvent(e);
                                }}
                                className="px-2 py-1 rounded-xl bg-background hover:bg-slate-200 text-main-blue font-medium transition-colors"
                              >
                                <FontAwesomeIcon icon={faEye} className="mr-1" />
                                Details
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      )}

      {/* ======================================================== */}
      {/* TAB 2: SYSTEM HEALTH & CLUSTER INVENTORY                  */}
      {/* ======================================================== */}
      {activeTab === 'system' && (
        <div className="space-y-6">
          {/* Inventory summary cards */}
          {invErr && <Err e={invErr} />}
          <section aria-label="Inventory" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            {[
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
              { icon: faClockRotateLeft, label: 'RECENT RUNS', value: runs.total, to: '/workflows', hint: `Last ${EXEC_WINDOW} runs` },
            ].map((c, i) => (
              <Card key={c.label} className="min-w-0">
                <div className="flex items-center gap-2 text-normal-text text-xs mb-2 tracking-wide font-medium">
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

          {/* Service health — all 8 platform services probed from /ready */}
          <section aria-label="Service health" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <Card className="min-w-0">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-semibold text-main-text">Gateway</h3>
                {readyLoading ? (
                  <Skeleton className="h-5 w-16" />
                ) : (
                  <Badge tone={aggregateTone}>{aggregate || 'unreachable'}</Badge>
                )}
              </div>
              <p className="text-xs text-normal-text mt-2 break-all font-mono">{baseUrl()}</p>
              <p className="text-xs text-normal-text mt-1">
                {readyLoading ? 'Probing /ready…' : readyErr ? 'Gateway is unreachable — is stack up?' : 'Aggregate status of all platform services'}
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
                      'No probe data'
                    ) : (
                      'No probe data from /ready'
                    )}
                  </p>
                  <p className="text-xs text-normal-text mt-1 truncate">{s.hint}</p>
                </Card>
              );
            })}
          </section>

          {/* Workflow health + recent runs */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="min-w-0">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h3 className="font-semibold text-main-text flex items-center gap-2">
                  <FontAwesomeIcon icon={faChartSimple} className="text-normal-text" aria-hidden="true" />
                  Workflow Engine Health
                </h3>
                <Link to="/workflows" className="text-xs text-main-blue whitespace-nowrap hover:underline">
                  Open workflows →
                </Link>
              </div>
              {runsErr && <Err e={runsErr} />}
              {runsLoading ? (
                <div className="space-y-2">
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
                      <span className="font-semibold text-main-text tabular-nums">{workflowSuccessRate == null ? '—' : `${workflowSuccessRate}%`}</span>
                    </div>
                    <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden" role="progressbar">
                      <div
                        className="h-full bg-gradient-to-r from-main-start to-main-end rounded-full transition-all"
                        style={{ width: `${workflowSuccessRate ?? 0}%` }}
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
                <h3 className="font-semibold text-main-text">Recent Workflow Executions</h3>
                <Link to="/workflows" className="text-xs text-main-blue whitespace-nowrap hover:underline">
                  All runs →
                </Link>
              </div>
              {runsLoading ? (
                <ul className="space-y-2">
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

          {/* Activity audit & context */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="min-w-0">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h3 className="font-semibold text-main-text">Recent Audit Activity</h3>
                <Link to="/audit" className="text-xs text-main-blue whitespace-nowrap hover:underline">
                  Full log →
                </Link>
              </div>
              {actErr && <Err e={actErr} />}
              {recentLoading ? (
                <ul className="space-y-2">
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
                  text={actErr ? 'Could not load audit records' : scope.orgId ? 'No audit records yet' : 'Pick an organization to see activity'}
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
                <h3 className="font-semibold text-main-text mb-1">Current Tenant Context</h3>
                <p className="text-lg font-semibold text-main-text truncate">
                  {curOrg?.slug || '—'} <span className="text-normal-text font-normal">/ {curAcc?.slug || '—'}</span>
                </p>
                <p className="text-xs text-normal-text mt-1">
                  Changing the picker above re-filters telemetry, security policies, and inventory in real-time.
                </p>
              </Card>

              <Card className="min-w-0">
                <h3 className="font-semibold text-main-text mb-3 flex items-center gap-2">
                  <FontAwesomeIcon icon={faListCheck} className="text-normal-text" aria-hidden="true" />
                  Quick Console Shortcuts
                </h3>
                <div className="flex flex-wrap gap-2 text-sm">
                  {[
                    ['/orgs', 'Organizations'],
                    ['/accounts', 'Accounts'],
                    ['/users', 'Users'],
                    ['/workflows', 'SynapseFlow'],
                    ['/lds', 'Linked Data'],
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
        </div>
      )}

      {/* ======================================================== */}
      {/* MODAL: DETAILED REQUEST INSPECTION                        */}
      {/* ======================================================== */}
      {selectedEvent && (
        <Modal title="Request Telemetry Details" onClose={() => setSelectedEvent(null)}>
          <div className="space-y-4 text-xs">
            {/* Top overview badge bar */}
            <div className="flex flex-wrap items-center gap-2 pb-3 border-b border-slate-100">
              <Badge tone={methodBadgeTone(selectedEvent.method)}>{selectedEvent.method}</Badge>
              <Badge tone={statusBadgeTone(selectedEvent.status)}>{selectedEvent.status}</Badge>
              <span className="font-mono font-semibold text-main-text break-all text-sm">
                {selectedEvent.path}
              </span>
            </div>

            {/* Error callout if present */}
            {(selectedEvent.error || selectedEvent.status >= 400) && (
              <div className="p-3 rounded-2xl bg-red-500/10 text-red-600 flex items-start gap-2">
                <FontAwesomeIcon icon={faCircleExclamation} className="mt-0.5" />
                <div className="min-w-0">
                  <p className="font-semibold">Request Error</p>
                  <p className="font-mono mt-0.5 break-all">{selectedEvent.error || `HTTP ${selectedEvent.status}`}</p>
                </div>
              </div>
            )}

            {/* Metadata Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-2xl bg-background">
              <div>
                <span className="text-normal-text block">Request ID</span>
                <div className="flex items-center gap-2 mt-0.5 font-mono text-main-text font-medium truncate">
                  <span className="truncate">{selectedEvent.requestId}</span>
                  <button
                    type="button"
                    onClick={() => copyRequestId(selectedEvent.requestId)}
                    className="text-main-blue hover:opacity-80"
                    title="Copy Request ID"
                  >
                    <FontAwesomeIcon icon={copiedId ? faCheck : faCopy} />
                  </button>
                </div>
              </div>

              <div>
                <span className="text-normal-text block">Timestamp</span>
                <span className="font-mono text-main-text mt-0.5 block">
                  {fmtTime(selectedEvent.createdAt)}
                </span>
              </div>

              <div>
                <span className="text-normal-text block">Platform Feature</span>
                <span className="font-medium text-main-text mt-0.5 block">
                  {FEATURE_META[selectedEvent.feature]?.label || selectedEvent.feature} ({selectedEvent.feature})
                </span>
              </div>

              <div>
                <span className="text-normal-text block">Duration (Latency)</span>
                <span className={`font-mono font-semibold mt-0.5 block ${latencyTone(selectedEvent.durationMs)}`}>
                  {fmtMs(selectedEvent.durationMs)}
                </span>
              </div>

              <div>
                <span className="text-normal-text block">Caller Auth Method</span>
                <span className="font-mono text-main-text capitalize mt-0.5 block">
                  {selectedEvent.authKind}
                </span>
              </div>

              <div>
                <span className="text-normal-text block">User / Actor</span>
                <span className="font-mono text-main-text mt-0.5 block truncate" title={selectedEvent.userEmail || selectedEvent.userId || ''}>
                  {selectedEvent.userEmail || selectedEvent.userId || '—'}
                </span>
              </div>

              <div>
                <span className="text-normal-text block">Tenant Organization</span>
                <span className="font-mono text-main-text mt-0.5 block truncate">
                  {selectedEvent.orgId || '—'}
                </span>
              </div>

              <div>
                <span className="text-normal-text block">Account ID</span>
                <span className="font-mono text-main-text mt-0.5 block truncate">
                  {selectedEvent.accountId || '—'}
                </span>
              </div>
            </div>

            {/* Raw JSON inspection */}
            <div>
              <span className="text-xs font-semibold text-normal-text block mb-1">Raw Telemetry Event Record</span>
              <Code data={selectedEvent} wrap />
            </div>

            <div className="pt-2 flex justify-end">
              <Btn kind="secondary" onClick={() => setSelectedEvent(null)}>
                Close
              </Btn>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
