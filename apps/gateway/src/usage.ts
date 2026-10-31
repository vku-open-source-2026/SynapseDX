/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Gateway request telemetry: every proxied request becomes one usage event,
 * buffered in memory and flushed to IAM in small batches. Best-effort by
 * design — a dead analytics sink must never affect live traffic.
 */
import './env-compat';

export interface UsageEvent {
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
  error: string | null;
}

const MAX_BUFFER = 2000;
const MAX_BATCH = 200;
const FLUSH_INTERVAL_MS = 5000;
const POST_TIMEOUT_MS = 3000;

const FEATURE_ROUTES: Array<[prefix: string, feature: string]> = [
  ['/v1/auth', 'auth'],
  ['/v1/orgs', 'iam'],
  ['/v1/accounts', 'iam'],
  ['/v1/roles', 'iam'],
  ['/v1/users', 'iam'],
  ['/v1/service-accounts', 'iam'],
  ['/v1/policies', 'iam'],
  ['/v1/keys', 'iam'],
  ['/v1/authorize', 'iam'],
  ['/v1/audit', 'iam'],
  ['/v1/workflows', 'workflows'],
  ['/v1/templates', 'workflows'],
  ['/v1/executions', 'workflows'],
  ['/v1/credentials', 'workflows'],
  ['/webhook', 'workflows'],
  ['/v1/ai', 'ai'],
  ['/v1/lds', 'lds'],
  ['/v1/base', 'base'],
  ['/v1/faststore', 'faststore'],
  ['/v1/queue', 'queue'],
  ['/v1/usage', 'usage'],
];

/** Map a routing-table path to a stable product feature key. */
export function featureForRoute(routePath: string): string {
  for (const [prefix, feature] of FEATURE_ROUTES) {
    if (routePath === prefix || routePath.startsWith(prefix + '/')) return feature;
  }
  const seg = routePath.split('/').filter(Boolean)[1] || '';
  return /^[a-z0-9-]{1,64}$/.test(seg) ? seg : 'other';
}

/** Dashboard reads must not inflate their own counters. */
export function isUsageExcluded(pathname: string): boolean {
  return pathname === '/v1/usage' || pathname.startsWith('/v1/usage/');
}

export function isUsageTelemetryEnabled(): boolean {
  return (process.env.USAGE_TELEMETRY || 'true') !== 'false';
}

let buffer: UsageEvent[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;
let lastWarn = 0;

function iamIngestUrl(): string {
  const base = (process.env.IAM_SERVICE_URL || 'http://iam:4001').replace(/\/$/, '');
  return `${base}/v1/usage/ingest`;
}

function warnOnce(msg: string): void {
  const now = Date.now();
  if (now - lastWarn < 60_000) return;
  lastWarn = now;
  console.warn(`[gateway][usage] ${msg}`);
}

async function postBatch(events: UsageEvent[]): Promise<void> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), POST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.SYNAPSEONE_INTERNAL_SECRET) {
      headers['x-synapseone-internal'] = process.env.SYNAPSEONE_INTERNAL_SECRET;
    }
    const res = await fetch(iamIngestUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ events }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`IAM ingest HTTP ${res.status}`);
  } finally {
    clearTimeout(to);
  }
}

/** Flush at most one batch; on failure the events are put back (bounded). */
export function flushUsageNow(): Promise<void> {
  if (flushing) return flushing;
  if (!isUsageTelemetryEnabled() || buffer.length === 0) return Promise.resolve();

  const batch = buffer.splice(0, MAX_BATCH);
  flushing = postBatch(batch)
    .catch((e: any) => {
      buffer = batch.concat(buffer).slice(0, MAX_BUFFER);
      warnOnce(`flush failed (${e?.message || e}); keeping ${buffer.length} buffered event(s)`);
    })
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

export function enqueueUsage(event: UsageEvent): void {
  if (!isUsageTelemetryEnabled()) return;
  buffer.push(event);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
  if (buffer.length >= MAX_BATCH) void flushUsageNow();
}

export function startUsageTelemetry(): void {
  if (!isUsageTelemetryEnabled() || timer) return;
  timer = setInterval(() => {
    void flushUsageNow();
  }, FLUSH_INTERVAL_MS);
  timer.unref?.();
}

/** Test/dev helper: stop the timer and discard buffered events. */
export function resetUsageTelemetry(): void {
  if (timer) clearInterval(timer);
  timer = null;
  buffer = [];
  flushing = null;
}

export function usageBufferSize(): number {
  return buffer.length;
}
