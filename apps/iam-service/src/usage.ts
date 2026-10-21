/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Request/feature usage store: batched ingest from the gateway, tenant-scoped
 * summary + raw event queries, and retention. Works on Postgres (Drizzle) with
 * the same in-memory fallback used by the rest of IAM.
 */
import { randomUUID } from 'crypto';
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { ensureTables, getDb, useDb, __mem } from './db';
import { accounts, usageEvents, users } from './schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEATURE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const METHOD_RE = /^[A-Z]{1,16}$/;
const AUTH_KINDS = new Set(['user', 'service-account', 'apikey', 'anonymous', 'unauthenticated', 'unknown']);
const MAX_RANGE_DAYS = 366;

export interface UsageEventInput {
  createdAt?: string | Date;
  requestId?: string;
  feature?: string;
  route?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  authKind?: string;
  orgId?: string | null;
  accountId?: string | null;
  userId?: string | null;
  error?: string | null;
}

export interface UsageEventRow {
  id: string;
  createdAt: string;
  requestId: string;
  feature: string;
  route: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  authKind: string;
  orgId: string | null;
  accountId: string | null;
  userId: string | null;
  userEmail?: string | null;
  error: string | null;
}

export interface UsageFilter {
  orgId: string;
  from: Date;
  to: Date;
  feature?: string;
  accountId?: string;
  method?: string;
  status?: number;
  statusClass?: number;
  actor?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface UsageTotals {
  requests: number;
  success: number;
  clientErrors: number;
  serverErrors: number;
  errorRate: number;
  avgMs: number;
  p95Ms: number;
  uniqueUsers: number;
  uniqueAccounts: number;
  lastRequestAt: string | null;
}

export interface UsageFeatureStat {
  feature: string;
  requests: number;
  success: number;
  clientErrors: number;
  serverErrors: number;
  errorRate: number;
  avgMs: number;
  p95Ms: number;
  lastRequestAt: string | null;
  share: number;
}

export interface UsageSeriesPoint {
  ts: string;
  requests: number;
  errors: number;
  avgMs: number;
}

export interface UsageSummary {
  from: string;
  to: string;
  bucketSeconds: number;
  totals: UsageTotals;
  features: UsageFeatureStat[];
  series: UsageSeriesPoint[];
  statusClasses: Array<{ class: string; count: number }>;
  authKinds: Array<{ kind: string; requests: number }>;
  topRoutes: Array<{
    feature: string;
    route: string;
    method: string;
    requests: number;
    errors: number;
    avgMs: number;
  }>;
}

interface NormalizedEvent {
  createdAt: Date;
  requestId: string;
  feature: string;
  route: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  authKind: string;
  orgId: string | null;
  accountId: string | null;
  userId: string | null;
  error: string | null;
}

function clean(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, max);
}

function uuidOrNull(value: unknown): string | null {
  const s = String(value ?? '');
  return UUID_RE.test(s) ? s : null;
}

function intInRange(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function eventDate(value: unknown, now: number): Date {
  const d = value instanceof Date ? value : new Date(String(value ?? ''));
  const t = d.getTime();
  if (!Number.isFinite(t)) return new Date(now);
  // Gateway flushes within seconds; clamp hostile clock skew to the valid window.
  if (t > now + 5 * 60_000 || t < now - MAX_RANGE_DAYS * 86_400_000) return new Date(now);
  return d;
}

function normalizeEvent(input: UsageEventInput, now = Date.now()): NormalizedEvent | null {
  const status = intInRange(input.status, 100, 599);
  const durationMs = intInRange(input.durationMs, 0, 3_600_000);
  if (status === null || durationMs === null) return null;

  const feature = clean(input.feature, 64).toLowerCase();
  const method = clean(input.method, 16).toUpperCase();
  const route = clean(input.route, 200);
  if (!FEATURE_RE.test(feature) || !METHOD_RE.test(method) || !route.startsWith('/')) return null;

  const authKind = AUTH_KINDS.has(String(input.authKind)) ? String(input.authKind) : 'unknown';
  const error = input.error == null ? null : clean(input.error, 500) || null;

  return {
    createdAt: eventDate(input.createdAt, now),
    requestId: clean(input.requestId, 128),
    feature,
    route,
    method,
    path: clean(String(input.path ?? '').split('?')[0], 2000),
    status,
    durationMs,
    authKind,
    orgId: uuidOrNull(input.orgId),
    accountId: uuidOrNull(input.accountId),
    userId: uuidOrNull(input.userId),
    error,
  };
}

function dateIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function percentile95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx];
}

/** `%`/`_` in a user search must stay literal in ILIKE patterns. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function bucketSecondsFor(from: Date, to: Date): number {
  const span = Math.max(0, (to.getTime() - from.getTime()) / 1000);
  if (span <= 2 * 60 * 60) return 300;
  if (span <= 24 * 60 * 60) return 60 * 60;
  if (span <= 7 * 86_400) return 6 * 60 * 60;
  if (span <= 60 * 86_400) return 86_400;
  return 7 * 86_400;
}

function dbConditions(f: UsageFilter): SQL | undefined {
  const conds: SQL[] = [
    eq(usageEvents.orgId, f.orgId),
    gte(usageEvents.createdAt, f.from),
    lte(usageEvents.createdAt, f.to),
  ];
  if (f.feature) conds.push(eq(usageEvents.feature, f.feature));
  if (f.accountId) conds.push(eq(usageEvents.accountId, f.accountId));
  if (f.method) conds.push(eq(usageEvents.method, f.method));
  if (f.actor) conds.push(eq(usageEvents.userId, f.actor));
  if (f.status !== undefined) conds.push(eq(usageEvents.status, f.status));
  if (f.statusClass) {
    conds.push(gte(usageEvents.status, f.statusClass * 100));
    conds.push(lt(usageEvents.status, (f.statusClass + 1) * 100));
  }
  if (f.q) {
    const pattern = `%${escapeLike(f.q)}%`;
    const hit = or(ilike(usageEvents.path, pattern), ilike(usageEvents.requestId, pattern));
    if (hit) conds.push(hit);
  }
  return and(...conds);
}

function memoryMatch(f: UsageFilter, e: UsageEventRow): boolean {
  const t = new Date(e.createdAt).getTime();
  if (!Number.isFinite(t) || t < f.from.getTime() || t > f.to.getTime()) return false;
  if (f.feature && e.feature !== f.feature) return false;
  if (f.accountId && e.accountId !== f.accountId) return false;
  if (f.method && e.method !== f.method) return false;
  if (f.actor && e.userId !== f.actor) return false;
  if (f.status !== undefined && e.status !== f.status) return false;
  if (f.statusClass && Math.floor(e.status / 100) !== f.statusClass) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!e.path.toLowerCase().includes(q) && !e.requestId.toLowerCase().includes(q)) return false;
  }
  return true;
}

function memoryOrgForAccount(accountId: string | null): string | null {
  if (!accountId) return null;
  const acc = [...__mem.accounts.values()].find((a) => a.id === accountId);
  return acc?.org_id || null;
}

/** Persist a batch of gateway events. Returns the number of accepted rows. */
export async function ingestUsageEvents(events: UsageEventInput[]): Promise<number> {
  const now = Date.now();
  const rows = events
    .map((e) => normalizeEvent(e, now))
    .filter((e): e is NormalizedEvent => !!e)
    .slice(0, 500);
  if (!rows.length) return 0;

  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    // API-key traffic carries an account but no org claim: resolve it from the
    // account row so the event still lands in the tenant dashboard.
    const missing = [...new Set(rows.filter((r) => !r.orgId && r.accountId).map((r) => r.accountId!))];
    if (missing.length) {
      const accs = await db
        .select({ id: accounts.id, orgId: accounts.orgId })
        .from(accounts)
        .where(inArray(accounts.id, missing));
      const byId = new Map(accs.map((a) => [a.id, a.orgId]));
      for (const r of rows) if (!r.orgId && r.accountId) r.orgId = byId.get(r.accountId) || null;
    }
    await db.insert(usageEvents).values(
      rows.map((r) => ({
        createdAt: r.createdAt,
        requestId: r.requestId,
        feature: r.feature,
        route: r.route,
        method: r.method,
        path: r.path,
        status: r.status,
        durationMs: r.durationMs,
        authKind: r.authKind,
        orgId: r.orgId,
        accountId: r.accountId,
        userId: r.userId,
        error: r.error,
      })),
    );
    return rows.length;
  }

  for (const r of rows) {
    __mem.usage.push({
      id: randomUUID(),
      createdAt: r.createdAt.toISOString(),
      requestId: r.requestId,
      feature: r.feature,
      route: r.route,
      method: r.method,
      path: r.path,
      status: r.status,
      durationMs: r.durationMs,
      authKind: r.authKind,
      orgId: r.orgId || memoryOrgForAccount(r.accountId),
      accountId: r.accountId,
      userId: r.userId,
      userEmail: r.userId ? __mem.users.get(r.userId)?.email || null : null,
      error: r.error,
    });
  }
  // Dev/test fallback: bounded ring so a long-lived process cannot leak memory.
  if (__mem.usage.length > 50_000) __mem.usage.splice(0, __mem.usage.length - 50_000);
  return rows.length;
}

export async function listUsageEvents(
  f: UsageFilter,
): Promise<{ total: number; items: UsageEventRow[] }> {
  const limit = Math.min(Math.max(Math.floor(Number(f.limit) || 50), 1), 200);
  const offset = Math.min(Math.max(Math.floor(Number(f.offset) || 0), 0), 100_000);

  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const where = dbConditions(f);
    const countRows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(usageEvents)
      .where(where);
    const rows = await db
      .select({
        id: usageEvents.id,
        createdAt: usageEvents.createdAt,
        requestId: usageEvents.requestId,
        feature: usageEvents.feature,
        route: usageEvents.route,
        method: usageEvents.method,
        path: usageEvents.path,
        status: usageEvents.status,
        durationMs: usageEvents.durationMs,
        authKind: usageEvents.authKind,
        orgId: usageEvents.orgId,
        accountId: usageEvents.accountId,
        userId: usageEvents.userId,
        userEmail: users.email,
        error: usageEvents.error,
      })
      .from(usageEvents)
      .leftJoin(users, eq(usageEvents.userId, users.id))
      .where(where)
      .orderBy(desc(usageEvents.createdAt), desc(usageEvents.id))
      .limit(limit)
      .offset(offset);
    return {
      total: Number(countRows[0]?.total) || 0,
      items: rows.map((r) => ({
        ...r,
        createdAt: dateIso(r.createdAt) || new Date(0).toISOString(),
        userEmail: r.userEmail ?? null,
      })),
    };
  }

  const filtered = (__mem.usage as UsageEventRow[])
    .filter((e) => e.orgId === f.orgId && memoryMatch(f, e))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    total: filtered.length,
    items: filtered.slice(offset, offset + limit).map((e) => ({
      ...e,
      userEmail: e.userId ? __mem.users.get(e.userId)?.email || e.userEmail || null : null,
    })),
  };
}

function fillSeries(
  from: Date,
  to: Date,
  bucketSeconds: number,
  points: Map<number, { requests: number; errors: number; avgSum: number }>,
): UsageSeriesPoint[] {
  const bucketMs = bucketSeconds * 1000;
  const start = Math.floor(from.getTime() / bucketMs) * bucketMs;
  const end = to.getTime();
  const out: UsageSeriesPoint[] = [];
  for (let t = start; t <= end && out.length < 1000; t += bucketMs) {
    const hit = points.get(t);
    const requests = hit?.requests || 0;
    out.push({
      ts: new Date(t).toISOString(),
      requests,
      errors: hit?.errors || 0,
      avgMs: requests ? round2((hit?.avgSum || 0) / requests) : 0,
    });
  }
  return out;
}

export async function usageSummary(f: UsageFilter): Promise<UsageSummary> {
  const bucketSeconds = bucketSecondsFor(f.from, f.to);

  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const where = dbConditions(f);

    const totalsRows = await db
      .select({
        requests: sql<number>`count(*)::int`,
        success: sql<number>`count(*) filter (where ${usageEvents.status} < 400)::int`,
        clientErrors: sql<number>`count(*) filter (where ${usageEvents.status} >= 400 and ${usageEvents.status} < 500)::int`,
        serverErrors: sql<number>`count(*) filter (where ${usageEvents.status} >= 500)::int`,
        avgMs: sql<number>`coalesce(avg(${usageEvents.durationMs}), 0)::float`,
        p95Ms: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${usageEvents.durationMs}), 0)::float`,
        uniqueUsers: sql<number>`count(distinct ${usageEvents.userId})::int`,
        uniqueAccounts: sql<number>`count(distinct ${usageEvents.accountId})::int`,
        lastRequestAt: sql<Date | null>`max(${usageEvents.createdAt})`,
      })
      .from(usageEvents)
      .where(where);
    const t = totalsRows[0];
    const requests = Number(t?.requests) || 0;
    const clientErrors = Number(t?.clientErrors) || 0;
    const serverErrors = Number(t?.serverErrors) || 0;

    const featureRows = await db
      .select({
        feature: usageEvents.feature,
        requests: sql<number>`count(*)::int`,
        success: sql<number>`count(*) filter (where ${usageEvents.status} < 400)::int`,
        clientErrors: sql<number>`count(*) filter (where ${usageEvents.status} >= 400 and ${usageEvents.status} < 500)::int`,
        serverErrors: sql<number>`count(*) filter (where ${usageEvents.status} >= 500)::int`,
        avgMs: sql<number>`coalesce(avg(${usageEvents.durationMs}), 0)::float`,
        p95Ms: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${usageEvents.durationMs}), 0)::float`,
        lastRequestAt: sql<Date | null>`max(${usageEvents.createdAt})`,
      })
      .from(usageEvents)
      .where(where)
      .groupBy(usageEvents.feature)
      .orderBy(desc(sql`count(*)`));

    const statusRows = await db
      .select({
        bucket: sql<number>`floor(${usageEvents.status} / 100)::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .where(where)
      .groupBy(sql`floor(${usageEvents.status} / 100)`)
      .orderBy(sql`floor(${usageEvents.status} / 100)`);

    const authRows = await db
      .select({
        kind: usageEvents.authKind,
        requests: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .where(where)
      .groupBy(usageEvents.authKind)
      .orderBy(desc(sql`count(*)`));

    const routeRows = await db
      .select({
        feature: usageEvents.feature,
        route: usageEvents.route,
        method: usageEvents.method,
        requests: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where ${usageEvents.status} >= 400)::int`,
        avgMs: sql<number>`coalesce(avg(${usageEvents.durationMs}), 0)::float`,
      })
      .from(usageEvents)
      .where(where)
      .groupBy(usageEvents.feature, usageEvents.route, usageEvents.method)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    // Postgres cannot match `GROUP BY` to the selected expression when a
    // duplicated fragment gets distinct placeholder numbers ($1/$2 vs
    // $6/$7), which made this query fail with "must appear in the GROUP BY
    // clause" on real Postgres. Group/order by the output column position
    // instead of repeating the parameterized expression.
    const bucketExpr = sql<Date>`to_timestamp(floor(extract(epoch from ${usageEvents.createdAt}) / ${bucketSeconds}) * ${bucketSeconds})`;
    const seriesRows = await db
      .select({
        bucket: bucketExpr,
        requests: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where ${usageEvents.status} >= 400)::int`,
        avgMs: sql<number>`coalesce(avg(${usageEvents.durationMs}), 0)::float`,
      })
      .from(usageEvents)
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const points = new Map<number, { requests: number; errors: number; avgSum: number }>();
    for (const s of seriesRows) {
      const when = s.bucket instanceof Date ? s.bucket.getTime() : new Date(s.bucket).getTime();
      if (!Number.isFinite(when)) continue;
      const req = Number(s.requests) || 0;
      points.set(when, {
        requests: req,
        errors: Number(s.errors) || 0,
        avgSum: (Number(s.avgMs) || 0) * req,
      });
    }

    return {
      from: f.from.toISOString(),
      to: f.to.toISOString(),
      bucketSeconds,
      totals: {
        requests,
        success: Number(t?.success) || 0,
        clientErrors,
        serverErrors,
        errorRate: requests ? round2(((clientErrors + serverErrors) * 100) / requests) : 0,
        avgMs: round2(Number(t?.avgMs) || 0),
        p95Ms: round2(Number(t?.p95Ms) || 0),
        uniqueUsers: Number(t?.uniqueUsers) || 0,
        uniqueAccounts: Number(t?.uniqueAccounts) || 0,
        lastRequestAt: dateIso(t?.lastRequestAt),
      },
      features: featureRows.map((r) => {
        const req = Number(r.requests) || 0;
        const client = Number(r.clientErrors) || 0;
        const server = Number(r.serverErrors) || 0;
        return {
          feature: r.feature,
          requests: req,
          success: Number(r.success) || 0,
          clientErrors: client,
          serverErrors: server,
          errorRate: req ? round2(((client + server) * 100) / req) : 0,
          avgMs: round2(Number(r.avgMs) || 0),
          p95Ms: round2(Number(r.p95Ms) || 0),
          lastRequestAt: dateIso(r.lastRequestAt),
          share: requests ? round2((req * 100) / requests) : 0,
        };
      }),
      series: fillSeries(f.from, f.to, bucketSeconds, points),
      statusClasses: statusRows.map((r) => ({ class: `${Number(r.bucket)}xx`, count: Number(r.count) || 0 })),
      authKinds: authRows.map((r) => ({ kind: r.kind, requests: Number(r.requests) || 0 })),
      topRoutes: routeRows.map((r) => ({
        feature: r.feature,
        route: r.route,
        method: r.method,
        requests: Number(r.requests) || 0,
        errors: Number(r.errors) || 0,
        avgMs: round2(Number(r.avgMs) || 0),
      })),
    };
  }

  // ---- in-memory fallback (dev/test) ----
  const events = (__mem.usage as UsageEventRow[]).filter(
    (e) => e.orgId === f.orgId && memoryMatch(f, e),
  );
  const requests = events.length;
  const success = events.filter((e) => e.status < 400).length;
  const clientErrors = events.filter((e) => e.status >= 400 && e.status < 500).length;
  const serverErrors = events.filter((e) => e.status >= 500).length;
  const durations = events.map((e) => e.durationMs);
  const last = events.reduce<string | null>(
    (acc, e) => (!acc || e.createdAt > acc ? e.createdAt : acc),
    null,
  );

  const group = <T>(key: (e: UsageEventRow) => T) => {
    const map = new Map<T, UsageEventRow[]>();
    for (const e of events) {
      const k = key(e);
      const list = map.get(k);
      if (list) list.push(e);
      else map.set(k, [e]);
    }
    return map;
  };

  const features: UsageFeatureStat[] = [...group((e) => e.feature).entries()]
    .map(([feature, list]) => {
      const req = list.length;
      const client = list.filter((e) => e.status >= 400 && e.status < 500).length;
      const server = list.filter((e) => e.status >= 500).length;
      return {
        feature,
        requests: req,
        success: list.filter((e) => e.status < 400).length,
        clientErrors: client,
        serverErrors: server,
        errorRate: req ? round2(((client + server) * 100) / req) : 0,
        avgMs: round2(list.reduce((sum, e) => sum + e.durationMs, 0) / req),
        p95Ms: percentile95(list.map((e) => e.durationMs)),
        lastRequestAt: list.reduce<string | null>(
          (acc, e) => (!acc || e.createdAt > acc ? e.createdAt : acc),
          null,
        ),
        share: requests ? round2((req * 100) / requests) : 0,
      };
    })
    .sort((a, b) => b.requests - a.requests);

  const points = new Map<number, { requests: number; errors: number; avgSum: number }>();
  const bucketMs = bucketSeconds * 1000;
  for (const e of events) {
    const t = new Date(e.createdAt).getTime();
    const when = Math.floor(t / bucketMs) * bucketMs;
    const hit = points.get(when) || { requests: 0, errors: 0, avgSum: 0 };
    hit.requests++;
    if (e.status >= 400) hit.errors++;
    hit.avgSum += e.durationMs;
    points.set(when, hit);
  }

  const statusMap = group((e) => Math.floor(e.status / 100));
  const authMap = group((e) => e.authKind);
  const routeMap = group((e) => `${e.feature}\u0000${e.route}\u0000${e.method}`);

  return {
    from: f.from.toISOString(),
    to: f.to.toISOString(),
    bucketSeconds,
    totals: {
      requests,
      success,
      clientErrors,
      serverErrors,
      errorRate: requests ? round2(((clientErrors + serverErrors) * 100) / requests) : 0,
      avgMs: requests ? round2(events.reduce((sum, e) => sum + e.durationMs, 0) / requests) : 0,
      p95Ms: percentile95(durations),
      uniqueUsers: new Set(events.map((e) => e.userId).filter(Boolean)).size,
      uniqueAccounts: new Set(events.map((e) => e.accountId).filter(Boolean)).size,
      lastRequestAt: last,
    },
    features,
    series: fillSeries(f.from, f.to, bucketSeconds, points),
    statusClasses: [...statusMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([cls, list]) => ({ class: `${cls}xx`, count: list.length })),
    authKinds: [...authMap.entries()]
      .map(([kind, list]) => ({ kind, requests: list.length }))
      .sort((a, b) => b.requests - a.requests),
    topRoutes: [...routeMap.values()]
      .map((list) => {
        const [feature, route, method] = `${list[0].feature}\u0000${list[0].route}\u0000${list[0].method}`.split('\u0000');
        return {
          feature,
          route,
          method,
          requests: list.length,
          errors: list.filter((e) => e.status >= 400).length,
          avgMs: round2(list.reduce((sum, e) => sum + e.durationMs, 0) / list.length),
        };
      })
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 10),
  };
}

/** Retention purge for usage rows (batched on Postgres). */
export async function purgeUsage(olderThanDays: number, batch = 1000): Promise<number> {
  if (!(olderThanDays > 0) || !Number.isFinite(olderThanDays)) return 0;
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const lim = Math.min(Math.max(Math.floor(batch) || 1000, 1), 10_000);

  if (useDb()) {
    await ensureTables();
    const db = getDb()!;
    const ids = await db
      .select({ id: usageEvents.id })
      .from(usageEvents)
      .where(lt(usageEvents.createdAt, cutoff))
      .limit(lim);
    if (!ids.length) return 0;
    const removed = await db
      .delete(usageEvents)
      .where(inArray(usageEvents.id, ids.map((x) => x.id)))
      .returning({ id: usageEvents.id });
    return removed.length;
  }

  const before = __mem.usage.length;
  __mem.usage = (__mem.usage as UsageEventRow[]).filter(
    (e) => new Date(e.createdAt).getTime() >= cutoff.getTime(),
  );
  return before - __mem.usage.length;
}
