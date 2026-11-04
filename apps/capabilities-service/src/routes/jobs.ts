// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Scheduled work: two execution contracts behind one job API.
 *
 * - `executor: "workflow"` (default) creates a Tier-1 cron workflow; Tier-1
 *   owns the schedule and execution history.
 * - `executor: "runner"` is a Tier-3-runner contract: Tier-2 owns the schedule
 *   projection (`nextRunAt`) and an idempotent lease in Tier-1 Faststore; the
 *   Tier-3 product polls `POST /jobs/lease`, executes its domain handler
 *   (`vndms.ingest`, `hazard.expire`, `report.generate`, ...) and reports
 *   completion. No Tier-2 process runs a timer or stores work in memory.
 *
 * Both contracts share tenant scoping, run-now and observable run history.
 */
import { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { SynapseOneError } from '@synapseone/sdk';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { booleanParam, parsePagination, setPageHeaders } from '../pagination';
import {
  COLLECTIONS, JobRecord, JobSchedule, claimIdempotency, correlationIdOf, ensureCollections,
  getDocumentOrNull, idempotencyKeyOf, queryDocuments, recordAudit, requestFingerprint,
} from '../platform';
import { authenticatedReadContext, writeContext } from './shared';

const CRON_RE = /^(\S+\s+){4}\S+$|^@(hourly|daily|weekly|monthly)$/;
const MAX_LEASE_SECONDS = 3600;
const MAX_BACKOFF_SECONDS = 300;

export type JobExecutor = 'workflow' | 'runner';
export type JobRunStatus = 'queued' | 'leased' | 'succeeded' | 'failed' | 'dead' | 'cancelled' | 'expired';

export interface JobRunRecord {
  id: string;
  jobId: string;
  tenant: string;
  kind: string;
  status: JobRunStatus;
  attempt: number;
  triggeredBy: 'schedule' | 'manual' | 'retry';
  scheduledFor: string;
  /** Per-run payload override supplied by run-now; else the job payload. */
  payloadOverride?: Record<string, unknown>;
  leaseToken?: string;
  leaseExpiresAt?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobKindSpec {
  description: string;
  fields: Record<string, string>;
}

/** Built-in Tier-3 runnable job kinds. Unknown custom kinds remain allowed. */
export const JOB_KIND_CATALOG: Record<string, JobKindSpec> = {
  'vndms.ingest': {
    description: 'Fetch the VNDMS hazard feed, persist new hazards and publish ingest status.',
    fields: {
      url: 'required string (public HTTPS feed)',
      district: 'optional string',
      format: 'optional json|xml (default json)',
      since: 'optional ISO-8601 timestamp',
    },
  },
  'hazard.expire': {
    description: 'Expire hazards whose TTL elapsed and emit the hazard.expired event.',
    fields: {
      ttlMinutes: 'optional integer 1..259200 (default 1440)',
      dryRun: 'optional boolean',
    },
  },
  'report.generate': {
    description: 'Generate a city/SOS report artifact and store it through the files capability.',
    fields: {
      reportType: 'required string (e.g. daily-summary, incident-aar)',
      format: 'optional pdf|csv|json (default json)',
      datasetId: 'optional dataset id',
      fileId: 'optional pre-created files id',
    },
  },
  generic: { description: 'Custom product job; Tier-3 owns payload semantics.', fields: {} },
};

function parseSchedule(body: Record<string, unknown>, existing?: JobSchedule): JobSchedule {
  const raw = body.schedule;
  if (raw === undefined) {
    if (existing) return existing;
    throw apiError(400, 'field_required', 'schedule is required', { field: 'schedule' });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw apiError(400, 'invalid_request', 'schedule must be an object with cron or everySeconds');
  }
  const schedule = raw as Record<string, unknown>;
  const hasCron = schedule.cron !== undefined;
  const hasEvery = schedule.everySeconds !== undefined;
  if (hasCron === hasEvery) {
    throw apiError(400, 'invalid_request', 'schedule must set exactly one of cron or everySeconds');
  }
  if (hasCron) {
    const cron = String(schedule.cron).trim();
    if (!CRON_RE.test(cron)) throw apiError(400, 'invalid_request', 'schedule.cron must be a 5-field cron expression or @hourly/@daily');
    return { cron };
  }
  const everySeconds = Number(schedule.everySeconds);
  if (!Number.isInteger(everySeconds) || everySeconds < 10 || everySeconds > 2592000) {
    throw apiError(400, 'invalid_request', 'schedule.everySeconds must be an integer 10..2592000');
  }
  return { everySeconds };
}

/** Minimal cron matcher: `*`, step (`*` + `/n`), `a`, `a-b`, comma lists. UTC. */
function cronFieldMatch(field: string, value: number): boolean {
  return field.split(',').some((part) => {
    const token = part.trim();
    if (!token) return false;
    if (token === '*') return true;
    const step = token.match(/^\*\/(\d{1,3})$/);
    if (step) return Number(step[1]) > 0 && value % Number(step[1]) === 0;
    const range = token.match(/^(\d{1,3})-(\d{1,3})(?:\/(\d{1,3}))?$/);
    if (range) {
      const [min, max, every] = [Number(range[1]), Number(range[2]), Number(range[3] || 1)];
      return every > 0 && value >= min && value <= max && (value - min) % every === 0;
    }
    return /^\d{1,3}$/.test(token) && Number(token) === value;
  });
}

function cronExpression(schedule: JobSchedule): string | undefined {
  if (schedule.cron) return schedule.cron;
  return undefined;
}

function presetCron(expr: string): string | undefined {
  if (expr === '@hourly') return '0 * * * *';
  if (expr === '@daily') return '0 0 * * *';
  if (expr === '@weekly') return '0 0 * * 0';
  if (expr === '@monthly') return '0 0 1 * *';
  return undefined;
}

/** Next scheduled instant (UTC) for a supported cron/interval schedule. */
export function nextRunAt(schedule: JobSchedule, from: Date = new Date()): string {
  if (schedule.everySeconds) {
    return new Date(from.getTime() + schedule.everySeconds * 1000).toISOString();
  }
  const expr = cronExpression(schedule);
  if (!expr) return new Date(from.getTime() + 3600_000).toISOString();
  const normalized = presetCron(expr) || expr;
  const parts = normalized.trim().split(/\s+/);
  if (parts.length !== 5) return new Date(from.getTime() + 3600_000).toISOString();
  const [minute, hour, dom, month, dow] = parts;
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 3600 * 1000;
  for (let time = start.getTime(); time < limit; time += 60_000) {
    const date = new Date(time);
    if (!cronFieldMatch(minute, date.getUTCMinutes())) continue;
    if (!cronFieldMatch(hour, date.getUTCHours())) continue;
    if (!cronFieldMatch(dom, date.getUTCDate())) continue;
    if (!cronFieldMatch(month, date.getUTCMonth() + 1)) continue;
    if (!cronFieldMatch(dow, date.getUTCDay())) continue;
    return date.toISOString();
  }
  return new Date(from.getTime() + 3600_000).toISOString();
}

function workflowDefinition(job: { name: string; schedule: JobSchedule }, workflowId: string) {
  const parameters = job.schedule.cron
    ? { cronExpression: job.schedule.cron }
    : { rule: { interval: [{ field: 'seconds', secondsInterval: job.schedule.everySeconds }] } };
  return {
    nodes: [{
      id: `schedule-${workflowId}`,
      name: 'Schedule',
      type: 'n8n-nodes-base.cron',
      typeVersion: 1,
      position: [200, 300],
      parameters,
    }],
    connections: {},
  };
}

function workflowIdOf(payload: any): string {
  return String(payload?.id || payload?.workflowId || payload?.workflow?.id || '');
}

function validateRunnerPayload(kind: string, payload: Record<string, unknown> | undefined): void {
  const spec = JOB_KIND_CATALOG[kind];
  if (!spec) {
    // Custom kinds are allowed; the catalog is advisory.
    return;
  }
  if (!payload) return;
  if (kind === 'vndms.ingest') {
    if (payload.url !== undefined && !/^https:\/\//i.test(String(payload.url))) {
      throw apiError(400, 'invalid_request', 'vndms.ingest payload.url must be a public HTTPS URL');
    }
    if (payload.format !== undefined && !['json', 'xml'].includes(String(payload.format).toLowerCase())) {
      throw apiError(400, 'invalid_request', 'vndms.ingest payload.format must be json|xml');
    }
  }
  if (kind === 'hazard.expire') {
    if (payload.ttlMinutes !== undefined) {
      const ttl = Number(payload.ttlMinutes);
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 259200) {
        throw apiError(400, 'invalid_request', 'hazard.expire payload.ttlMinutes must be an integer 1..259200');
      }
    }
  }
  if (kind === 'report.generate') {
    if (payload.format !== undefined && !['pdf', 'csv', 'json'].includes(String(payload.format).toLowerCase())) {
      throw apiError(400, 'invalid_request', 'report.generate payload.format must be pdf|csv|json');
    }
  }
}

function executorOf(raw: unknown): JobExecutor {
  const value = String(raw || 'workflow').toLowerCase();
  if (value !== 'workflow' && value !== 'runner') {
    throw apiError(400, 'invalid_request', 'executor must be workflow|runner');
  }
  return value;
}

function leaseKey(tenant: string, jobId: string): string {
  return `synapsedx:job-lease:${tenant}:${jobId}`;
}

function jobRunView(run: JobRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    jobId: run.jobId,
    kind: run.kind,
    status: run.status,
    attempt: run.attempt,
    triggeredBy: run.triggeredBy,
    scheduledFor: run.scheduledFor,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.summary !== undefined ? { summary: run.summary } : {}),
    ...(run.error ? { error: run.error } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function canAccessJob(job: JobRecord, principal: { tenantKey: string; scopes: string[] }): boolean {
  return principal.scopes.includes('*') || principal.scopes.includes('synapsedx:admin') || !job.tenant || job.tenant === principal.tenantKey;
}

async function loadJob(client: any, id: string): Promise<JobRecord> {
  const job = await getDocumentOrNull<JobRecord>(client, COLLECTIONS.jobs, id);
  if (!job) throw apiError(404, 'job_not_found', 'job not found');
  return job.data;
}

async function nextQueuedRun(client: any, jobId: string): Promise<JobRunRecord | null> {
  const result = await queryDocuments<JobRunRecord>(client, COLLECTIONS.jobRuns, {
    where: [{ field: 'jobId', op: 'eq', value: jobId }, { field: 'status', op: 'eq', value: 'queued' }],
    orderBy: { field: 'scheduledFor', direction: 'asc' },
    limit: 1,
  });
  return result.items[0]?.data || null;
}

async function putRun(client: any, run: JobRunRecord, version?: number): Promise<void> {
  try {
    await client.base.updateDocument(COLLECTIONS.jobRuns, run.id, {
      data: run as unknown as Record<string, unknown>,
      ...(version ? { ifVersion: version } : {}),
    });
  } catch (error) {
    if (error instanceof SynapseOneError && error.status === 404) {
      await client.base.createDocument(COLLECTIONS.jobRuns, { id: run.id, data: run as unknown as Record<string, unknown> });
      return;
    }
    throw error;
  }
}

async function updateJob(client: any, job: JobRecord, patch: Partial<JobRecord>): Promise<JobRecord> {
  const updated: JobRecord = { ...job, ...patch, updatedAt: new Date().toISOString() };
  try {
    await client.base.updateDocument(COLLECTIONS.jobs, job.id, { data: updated as unknown as Record<string, unknown> });
  } catch (error) {
    if (error instanceof SynapseOneError && (error.status === 409 || error.status === 404)) {
      const current = await getDocumentOrNull<JobRecord>(client, COLLECTIONS.jobs, job.id);
      if (current?.version) {
        await client.base.updateDocument(COLLECTIONS.jobs, job.id, {
          data: { ...current.data, ...patch, updatedAt: updated.updatedAt } as unknown as Record<string, unknown>,
          ifVersion: current.version,
        });
      }
    } else {
      throw error;
    }
  }
  return updated;
}

async function runProjection(client: any, workflowId: string, limit: number, offset: number) {
  const executions = await client.workflow.listExecutions({ workflowId, limit, offset });
  const list = Array.isArray(executions) ? executions : [];
  return list.map((execution: any) => ({
    id: String(execution.id),
    status: String(execution.status || 'unknown'),
    triggeredBy: execution.triggeredBy || execution.triggered_by,
    startedAt: execution.startedAt || execution.started_at,
    finishedAt: execution.finishedAt || execution.finished_at,
    attempt: Number(execution.attempt || 1),
    lastError: execution.error ?? null,
    summary: execution.output ?? null,
  }));
}

export function registerJobRoutes(app: Express, config: ServiceConfig): void {
  app.get('/v1/capabilities/jobs/kinds', handler(async (req, res) => {
    await authenticatedReadContext(req, config);
    res.json({
      items: Object.entries(JOB_KIND_CATALOG).map(([kind, spec]) => ({ kind, ...spec })),
      runnerContract: {
        lease: 'POST /v1/capabilities/jobs/lease',
        heartbeat: 'POST /v1/capabilities/jobs/:id/runs/:runId/heartbeat',
        complete: 'POST /v1/capabilities/jobs/:id/runs/:runId/complete',
      },
    });
  }));

  app.get('/v1/capabilities/jobs', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const pagination = parsePagination(req, config.maxPageSize);
    const where = principal.scopes.includes('*') || principal.scopes.includes('synapsedx:admin')
      ? undefined
      : { or: [{ tenant: principal.tenantKey }, { tenant: { exists: false } }] };
    const result = await queryDocuments<JobRecord>(client, COLLECTIONS.jobs, {
      ...(where ? { where } : {}),
      orderBy: { field: 'id', direction: 'asc' },
      limit: pagination.limit,
      offset: pagination.offset,
    });
    setPageHeaders(res, { total: result.total, limit: pagination.limit, offset: pagination.offset, nextCursor: result.nextCursor });
    res.json({ items: result.items.map((item) => item.data), total: result.total, limit: pagination.limit, offset: pagination.offset, nextCursor: result.nextCursor });
  }));

  app.post('/v1/capabilities/jobs', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const name = String(body.name || '').trim();
    if (!name) throw apiError(400, 'field_required', 'name is required', { field: 'name' });
    const schedule = parseSchedule(body);
    const executor = executorOf(body.executor);
    const kind = String(body.kind || 'generic').trim().slice(0, 64) || 'generic';
    const payload = body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : undefined;
    if (executor === 'runner') validateRunnerPayload(kind, payload);
    const idempotencyKey = idempotencyKeyOf(req);
    const claim = await claimIdempotency(
      client, config, principal.tenantKey, idempotencyKey,
      requestFingerprint('POST', req.path, body),
    );
    if (claim?.replay) {
      res.status(claim.replay.status).json(claim.replay.body);
      return;
    }
    let workflowId = '';
    let activated = false;
    try {
      await ensureCollections(client);
      const id = String(body.id || name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || randomUUID();
      const now = new Date().toISOString();
      if (executor === 'workflow') {
        const created = await client.workflow.createWorkflow(name, workflowDefinition({ name, schedule }, randomUUID()));
        workflowId = workflowIdOf(created);
        if (!workflowId) throw apiError(503, 'dependency_unavailable', 'SynapseOne did not return a workflow id', { dependency: 'synapseone-workflow' });
      }
      const job: JobRecord = {
        id,
        name,
        kind,
        executor,
        schedule,
        ...(payload ? { payload } : {}),
        ...(body.datasetId ? { datasetId: String(body.datasetId) } : {}),
        enabled: body.enabled !== false,
        workflowId,
        tenant: principal.tenantKey,
        ...(executor === 'runner' ? {
          nextRunAt: body.enabled === false ? undefined : nextRunAt(schedule),
          timeoutSeconds: body.timeoutSeconds === undefined ? 300 : Math.min(Math.max(Number(body.timeoutSeconds) || 300, 10), 3600),
          maxAttempts: body.maxAttempts === undefined ? 3 : Math.min(Math.max(Number(body.maxAttempts) || 3, 1), 10),
          lastStatus: 'never',
        } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await client.base.createDocument(COLLECTIONS.jobs, { id, data: job as unknown as Record<string, unknown> });
      if (executor === 'workflow' && job.enabled) {
        await client.workflow.activateWorkflow(workflowId);
        activated = true;
      }
      await recordAudit(client, config, {
        actor: principal.subject, tenant: principal.tenantKey, action: 'job.create',
        datasetId: job.datasetId, correlationId: correlationIdOf(req), details: { id, workflowId, executor, enabled: job.enabled },
      });
      res.status(201).json(job);
      await claim?.complete(201, job);
    } catch (error) {
      if (workflowId && !activated) {
        try { await client.workflow.deleteWorkflow(workflowId); } catch { /* best effort */ }
      } else if (workflowId && activated) {
        try { await client.workflow.deactivateWorkflow(workflowId); } catch { /* best effort */ }
      }
      await claim?.release();
      throw error;
    }
  }));

  app.get('/v1/capabilities/jobs/:id', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const job = await loadJob(client, String(req.params.id));
    if (!canAccessJob(job, principal)) throw apiError(404, 'job_not_found', 'job not found');
    res.json(job);
  }));

  app.patch('/v1/capabilities/jobs/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const id = String(req.params.id);
    const found = await getDocumentOrNull<JobRecord>(client, COLLECTIONS.jobs, id);
    if (!found || !canAccessJob(found.data, principal)) throw apiError(404, 'job_not_found', 'job not found');
    const job = found.data;
    const body = (req.body || {}) as Record<string, unknown>;
    if (body.executor !== undefined && executorOf(body.executor) !== job.executor) {
      throw apiError(409, 'illegal_transition', 'executor cannot be changed after creation');
    }
    const schedule = body.schedule !== undefined ? parseSchedule(body, job.schedule) : job.schedule;
    const updated: JobRecord = {
      ...job,
      ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
      ...(body.kind !== undefined ? { kind: String(body.kind).slice(0, 64) } : {}),
      ...(body.payload !== undefined ? { payload: body.payload as Record<string, unknown> } : {}),
      ...(body.datasetId !== undefined ? { datasetId: String(body.datasetId) } : {}),
      schedule,
      ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
      ...(body.timeoutSeconds !== undefined ? { timeoutSeconds: Math.min(Math.max(Number(body.timeoutSeconds) || 300, 10), 3600) } : {}),
      ...(body.maxAttempts !== undefined ? { maxAttempts: Math.min(Math.max(Number(body.maxAttempts) || 3, 1), 10) } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (job.executor === 'runner') {
      validateRunnerPayload(updated.kind, updated.payload);
      if (!updated.enabled) updated.nextRunAt = undefined;
      else if (body.schedule !== undefined || (body.enabled === true && !job.enabled)) updated.nextRunAt = nextRunAt(schedule);
      else updated.nextRunAt = job.nextRunAt;
    } else if (body.schedule !== undefined) {
      await client.workflow.updateWorkflow(job.workflowId, { definition: workflowDefinition(updated, job.workflowId) });
    }
    if (job.executor === 'workflow' && updated.enabled !== job.enabled) {
      if (updated.enabled) await client.workflow.activateWorkflow(updated.workflowId);
      else await client.workflow.deactivateWorkflow(updated.workflowId);
    }
    try {
      await client.base.updateDocument(COLLECTIONS.jobs, id, { data: updated as unknown as Record<string, unknown>, ifVersion: found.version });
    } catch (error) {
      if (error instanceof SynapseOneError && error.status === 409) {
        throw apiError(409, 'version_conflict', 'the job was modified by another request');
      }
      throw error;
    }
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'job.update',
      datasetId: updated.datasetId, correlationId: correlationIdOf(req), details: { enabled: updated.enabled },
    });
    res.json(updated);
  }));

  app.delete('/v1/capabilities/jobs/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const id = String(req.params.id);
    const found = await getDocumentOrNull<JobRecord>(client, COLLECTIONS.jobs, id);
    if (!found || !canAccessJob(found.data, principal)) throw apiError(404, 'job_not_found', 'job not found');
    if (found.data.executor === 'workflow') {
      try { await client.workflow.deactivateWorkflow(found.data.workflowId); } catch { /* already inactive */ }
      try { await client.workflow.deleteWorkflow(found.data.workflowId); } catch { /* history may be retained */ }
    } else {
      const runs = await queryDocuments<JobRunRecord>(client, COLLECTIONS.jobRuns, {
        where: { jobId: id }, limit: 500,
      });
      for (const run of runs.items) {
        if (['queued', 'leased'].includes(run.data.status)) {
          await putRun(client, { ...run.data, status: 'cancelled', updatedAt: new Date().toISOString() }, run.version);
        }
      }
      try { await client.faststore.delete(leaseKey(found.data.tenant || principal.tenantKey, id)); } catch { /* lease expires */ }
    }
    await client.base.deleteDocument(COLLECTIONS.jobs, id);
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'job.delete',
      datasetId: found.data.datasetId, correlationId: correlationIdOf(req), details: { id },
    });
    res.status(204).end();
  }));

  app.get('/v1/capabilities/jobs/:id/runs', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const id = String(req.params.id);
    const job = await loadJob(client, id);
    if (!canAccessJob(job, principal)) throw apiError(404, 'job_not_found', 'job not found');
    const pagination = parsePagination(req, config.maxPageSize);
    if (job.executor === 'runner') {
      const result = await queryDocuments<JobRunRecord>(client, COLLECTIONS.jobRuns, {
        where: [{ field: 'jobId', op: 'eq', value: id }, { field: 'tenant', op: 'eq', value: job.tenant || principal.tenantKey }],
        orderBy: { field: 'createdAt', direction: 'desc' },
        limit: pagination.limit,
        offset: pagination.offset,
      });
      res.json({
        items: result.items.map((item) => jobRunView(item.data)),
        total: result.total,
        limit: pagination.limit,
        offset: pagination.offset,
        nextCursor: result.nextCursor,
      });
      return;
    }
    const runs = await runProjection(client, job.workflowId, pagination.limit, pagination.offset);
    res.json({ items: runs, limit: pagination.limit, offset: pagination.offset, nextCursor: null });
  }));

  app.post('/v1/capabilities/jobs/:id/run', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const id = String(req.params.id);
    const job = await loadJob(client, id);
    if (!canAccessJob(job, principal)) throw apiError(404, 'job_not_found', 'job not found');
    if (!job.enabled) throw apiError(409, 'illegal_transition', 'the job is disabled');

    if (job.executor === 'runner') {
      const existing = await nextQueuedRun(client, id);
      const now = new Date().toISOString();
      const run: JobRunRecord = existing || {
        id: randomUUID(),
        jobId: id,
        tenant: job.tenant || principal.tenantKey,
        kind: job.kind,
        status: 'queued',
        attempt: 1,
        triggeredBy: 'manual',
        scheduledFor: now,
        createdAt: now,
        updatedAt: now,
      };
      if (!existing) {
        await ensureCollections(client);
        const body = (req.body || {}) as Record<string, unknown>;
        if (body.payload && typeof body.payload === 'object') {
          run.payloadOverride = body.payload as Record<string, unknown>;
        }
        await client.base.createDocument(COLLECTIONS.jobRuns, { id: run.id, data: run as unknown as Record<string, unknown> });
      }
      await recordAudit(client, config, {
        actor: principal.subject, tenant: principal.tenantKey, action: 'job.run',
        datasetId: job.datasetId, correlationId: correlationIdOf(req), details: { id, runId: run.id, mode: 'runner' },
      });
      res.status(202).json({
        runId: run.id,
        status: run.status,
        jobId: id,
        ...(existing ? { deduplicated: true } : {}),
        leaseEndpoint: '/v1/capabilities/jobs/lease',
      });
      return;
    }

    const lockKey = `synapsedx:job-lock:${principal.tenantKey}:${id}`;
    try {
      await client.faststore.set(lockKey, { at: new Date().toISOString() }, { ifNotExists: true, ttlSeconds: 120 });
    } catch (error) {
      if (error instanceof SynapseOneError && (error.status === 400 || error.status === 409)) {
        throw apiError(409, 'job_run_in_progress', 'a run of this job is already in progress');
      }
      throw apiError(503, 'dependency_unavailable', 'the job lease store is unavailable', { dependency: 'synapseone-faststore' });
    }
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const result = await client.workflow.executeWorkflow(job.workflowId, {
        ...(job.payload || {}), ...(body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : {}),
      });
      await recordAudit(client, config, {
        actor: principal.subject, tenant: principal.tenantKey, action: 'job.run',
        datasetId: job.datasetId, correlationId: correlationIdOf(req), details: { id },
      });
      res.json(result as unknown as Record<string, unknown>);
    } finally {
      try { await client.faststore.delete(lockKey); } catch { /* lease expires */ }
    }
  }));

  // ---- Tier-3 runner contract ----
  app.post('/v1/capabilities/jobs/lease', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = (req.body || {}) as Record<string, unknown>;
    const runnerId = String(body.runnerId || '').trim().slice(0, 120);
    if (!runnerId) throw apiError(400, 'field_required', 'runnerId is required', { field: 'runnerId' });
    const limit = body.limit === undefined ? 5 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw apiError(400, 'invalid_limit', 'limit must be 1..50');
    const leaseSeconds = body.leaseSeconds === undefined ? 60 : Number(body.leaseSeconds);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > MAX_LEASE_SECONDS) {
      throw apiError(400, 'invalid_request', `leaseSeconds must be an integer 10..${MAX_LEASE_SECONDS}`);
    }
    const kinds = Array.isArray(body.kinds) ? body.kinds.map(String) : undefined;
    await ensureCollections(client);
    const now = new Date();
    const jobs = await queryDocuments<JobRecord>(client, COLLECTIONS.jobs, {
      where: { tenant: principal.tenantKey },
      orderBy: { field: 'id', direction: 'asc' },
      limit: 200,
    });
    const leases: Array<Record<string, unknown>> = [];
    for (const item of jobs.items) {
      if (leases.length >= limit) break;
      const job = item.data;
      if (job.executor !== 'runner' || !job.enabled) continue;
      if (kinds && !kinds.includes(job.kind)) continue;
      // Reclaim a run whose runner stopped heartbeating before it blocks the job.
      const leased = await queryDocuments<JobRunRecord>(client, COLLECTIONS.jobRuns, {
        where: [{ field: 'jobId', op: 'eq', value: job.id }, { field: 'status', op: 'eq', value: 'leased' }],
        limit: 5,
      });
      for (const entry of leased.items) {
        if (!entry.data.leaseExpiresAt || new Date(entry.data.leaseExpiresAt).getTime() >= now.getTime()) continue;
        const exhausted = entry.data.attempt >= (job.maxAttempts || 3);
        await putRun(client, {
          ...entry.data,
          status: exhausted ? 'dead' : 'queued',
          attempt: exhausted ? entry.data.attempt : entry.data.attempt + 1,
          triggeredBy: 'retry',
          ...(exhausted ? { error: 'lease expired' } : {}),
          updatedAt: now.toISOString(),
        }, entry.version);
        try { await client.faststore.delete(leaseKey(principal.tenantKey, job.id)); } catch { /* expires */ }
      }
      const queued = await nextQueuedRun(client, job.id);
      const due = queued || (job.nextRunAt && new Date(job.nextRunAt).getTime() <= now.getTime());
      if (!due) continue;
      const token = randomUUID();
      try {
        await client.faststore.set(leaseKey(principal.tenantKey, job.id), { runnerId, token, at: now.toISOString() }, {
          ifNotExists: true, ttlSeconds: leaseSeconds,
        });
      } catch (error) {
        if (error instanceof SynapseOneError && (error.status === 400 || error.status === 409)) continue;
        throw apiError(503, 'dependency_unavailable', 'the job lease store is unavailable', { dependency: 'synapseone-faststore' });
      }
      const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
      const run: JobRunRecord = {
        ...(queued || {
          id: randomUUID(), jobId: job.id, tenant: job.tenant || principal.tenantKey,
          kind: job.kind, status: 'queued', attempt: 1, triggeredBy: 'schedule',
          scheduledFor: now.toISOString(), createdAt: now.toISOString(),
        }),
        status: 'leased',
        leaseToken: token,
        leaseExpiresAt,
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      try {
        await putRun(client, run);
      } catch (error) {
        try { await client.faststore.delete(leaseKey(principal.tenantKey, job.id)); } catch { /* lease expires */ }
        throw error;
      }
      await updateJob(client, job, {
        nextRunAt: job.schedule ? nextRunAt(job.schedule, now) : job.nextRunAt,
      });
      leases.push({
        jobId: job.id,
        runId: run.id,
        kind: job.kind,
        payload: run.payloadOverride || job.payload || {},
        attempt: run.attempt,
        leaseToken: token,
        leaseExpiresAt,
        timeoutSeconds: job.timeoutSeconds || 300,
      });
    }
    res.json({ leases, runnerId, count: leases.length });
  }));

  app.post('/v1/capabilities/jobs/:id/runs/:runId/heartbeat', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const id = String(req.params.id);
    const job = await loadJob(client, id);
    if (!canAccessJob(job, principal)) throw apiError(404, 'job_not_found', 'job not found');
    const runId = String(req.params.runId);
    const found = await getDocumentOrNull<JobRunRecord>(client, COLLECTIONS.jobRuns, runId);
    if (!found || found.data.jobId !== id) throw apiError(404, 'job_run_not_found', 'job run not found');
    const token = String((req.body || {}).leaseToken || '');
    if (!token || found.data.leaseToken !== token) throw apiError(409, 'job_lease_invalid', 'the lease token is invalid');
    const leaseSeconds = Math.min(Math.max(Number((req.body || {}).leaseSeconds) || 60, 10), MAX_LEASE_SECONDS);
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    await client.faststore.set(leaseKey(principal.tenantKey, id), { token, at: new Date().toISOString() }, { ttlSeconds: leaseSeconds });
    const updated: JobRunRecord = { ...found.data, leaseExpiresAt, updatedAt: new Date().toISOString() };
    await putRun(client, updated, found.version);
    res.json({ runId, leaseExpiresAt });
  }));

  app.post('/v1/capabilities/jobs/:id/runs/:runId/complete', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const id = String(req.params.id);
    const job = await loadJob(client, id);
    if (!canAccessJob(job, principal)) throw apiError(404, 'job_not_found', 'job not found');
    const runId = String(req.params.runId);
    const found = await getDocumentOrNull<JobRunRecord>(client, COLLECTIONS.jobRuns, runId);
    if (!found || found.data.jobId !== id) throw apiError(404, 'job_run_not_found', 'job run not found');
    const body = (req.body || {}) as Record<string, unknown>;
    const token = String(body.leaseToken || '');
    if (!token || found.data.leaseToken !== token) throw apiError(409, 'job_lease_invalid', 'the lease token is invalid');
    const status = String(body.status || '').toLowerCase();
    if (!['succeeded', 'failed', 'dead'].includes(status)) {
      throw apiError(400, 'invalid_request', 'status must be succeeded|failed|dead');
    }
    const now = new Date();
    const finished: JobRunRecord = {
      ...found.data,
      status: status as JobRunStatus,
      finishedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.error !== undefined ? { error: String(body.error).slice(0, 2000) } : {}),
    };
    let retry = false;
    let retryAt: string | undefined;
    if (status === 'failed') {
      const maxAttempts = job.maxAttempts || 3;
      if (finished.attempt < maxAttempts) {
        retry = true;
        retryAt = new Date(now.getTime() + Math.min(MAX_BACKOFF_SECONDS, 10 * finished.attempt) * 1000).toISOString();
        const nextRun: JobRunRecord = {
          id: randomUUID(),
          jobId: id,
          tenant: job.tenant || principal.tenantKey,
          kind: job.kind,
          status: 'queued',
          attempt: finished.attempt + 1,
          triggeredBy: 'retry',
          scheduledFor: retryAt,
          ...(finished.payloadOverride ? { payloadOverride: finished.payloadOverride } : {}),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        await client.base.createDocument(COLLECTIONS.jobRuns, { id: nextRun.id, data: nextRun as unknown as Record<string, unknown> });
      }
    }
    if (status === 'failed' && !retry) finished.status = 'dead';
    await putRun(client, finished, found.version);
    try { await client.faststore.delete(leaseKey(principal.tenantKey, id)); } catch { /* lease expires */ }
    await updateJob(client, job, {
      lastRunAt: now.toISOString(),
      lastStatus: finished.status,
      ...(finished.error ? { lastError: finished.error } : {}),
      ...(retryAt ? { nextRunAt: retryAt } : {}),
    });
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: `job.${status}`,
      datasetId: job.datasetId, correlationId: correlationIdOf(req), details: { id, runId, retry },
    });
    res.json({ run: jobRunView(finished), retry, ...(retryAt ? { retryAt } : {}) });
  }));

  void booleanParam;
}
