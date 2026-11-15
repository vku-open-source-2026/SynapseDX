// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Tier-2 EOP plan routes.
 *
 * Plans are tenant-scoped Tier-1 Base documents. The routes apply optimistic
 * concurrency (document version / If-Match), lifecycle guards and task
 * dependency guards; they never execute a plan or own SOS dispatch policy.
 */
import { Express, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { SynapseOneClient, SynapseOneError } from '@synapseone/sdk';
import { CallerPrincipal, isAdmin, isTenantAdmin } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { assertBodyIsObject, handler } from '../http';
import { parsePagination, setPageHeaders, stringParam } from '../pagination';
import {
  COLLECTIONS, correlationIdOf, getDocumentOrNull, queryDocuments, recordAudit,
} from '../platform';
import {
  PlanRecord, PlanStatus, PlanTaskStatus,
  assertPlanTransition, assertTaskTransition, buildPlanBrief, countPlanTasks,
  findPlanTask, generatePlanDraft, incompleteDependencies,
  isPlanStatus, isPlanTaskStatus, normalizePlanInput, parsePlanDraftRequest,
  validateOptionalPlanText, validatePlanContext, validatePlanObjective, validatePlanTitle,
  withComputedDueDates,
} from '../plans';
import {
  authenticatedReadContext, expectedVersion, requireVersionMatch, writeContext,
} from './shared';

interface LoadedPlan {
  plan: PlanRecord;
  version: number;
}

async function loadPlan(
  client: SynapseOneClient,
  principal: CallerPrincipal,
  id: string,
): Promise<LoadedPlan> {
  const document = await getDocumentOrNull<PlanRecord>(client, COLLECTIONS.plans, id);
  if (!document || (!isAdmin(principal) && document.data.tenant !== principal.tenantKey)) {
    throw apiError(404, 'plan_not_found', 'plan not found');
  }
  return { plan: document.data, version: document.version };
}

async function savePlan(
  client: SynapseOneClient,
  plan: PlanRecord,
  version: number,
): Promise<LoadedPlan> {
  try {
    const saved = await client.base.updateDocument(COLLECTIONS.plans, plan.id, {
      data: plan as unknown as Record<string, unknown>,
      ifVersion: version,
    });
    if (!saved.data) throw new Error('Tier-1 returned no plan data');
    return { plan: saved.data as unknown as PlanRecord, version: saved.version };
  } catch (error) {
    if (error instanceof SynapseOneError && error.status === 409) {
      throw apiError(409, 'version_conflict', 'the plan was modified by another request');
    }
    throw error;
  }
}

function sendPlan(res: Response, plan: PlanRecord, version: number): void {
  res.setHeader('etag', `"${version}"`);
  res.setHeader('cache-control', 'no-store');
  res.json({ plan, version });
}

function updatableFields(body: Record<string, unknown>): string[] {
  return ['title', 'objective', 'eventId', 'severity', 'context'].filter((field) => field in body);
}

function planMutationBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return assertBodyIsObject(value);
}

async function audit(
  client: SynapseOneClient,
  config: ServiceConfig,
  req: Request,
  principal: CallerPrincipal,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  await recordAudit(client, config, {
    actor: principal.subject,
    tenant: principal.tenantKey,
    action,
    correlationId: correlationIdOf(req),
    details,
  });
}

export function registerPlanRoutes(app: Express, config: ServiceConfig): void {
  // ---------------------------------------------------------------- draft AI
  // Registered before the item routes; this endpoint never persists a plan.
  app.post('/v1/capabilities/plans/draft', handler(async (req, res) => {
    const { client } = await writeContext(req, config);
    const request = parsePlanDraftRequest(assertBodyIsObject(req.body || {}));
    const result = await generatePlanDraft(client, request);
    res.setHeader('cache-control', 'no-store');
    res.json(result);
  }));

  // ---------------------------------------------------------------- create
  app.post('/v1/capabilities/plans', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const input = normalizePlanInput(assertBodyIsObject(req.body || {}));
    const now = new Date().toISOString();
    const plan: PlanRecord = {
      id: randomUUID(),
      tenant: principal.tenantKey,
      createdBy: principal.subject,
      createdAt: now,
      updatedAt: now,
      title: input.title,
      objective: input.objective,
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.severity ? { severity: input.severity } : {}),
      status: 'draft',
      ...(input.context ? { context: input.context } : {}),
      phases: input.phases,
    };
    const created = await client.base.createDocument(COLLECTIONS.plans, {
      id: plan.id,
      data: plan as unknown as Record<string, unknown>,
    });
    await audit(client, config, req, principal, 'plan.create', {
      planId: plan.id,
      phases: plan.phases.length,
      tasks: countPlanTasks(plan),
    });
    res.setHeader('location', `/v1/capabilities/plans/${plan.id}`);
    res.status(201);
    sendPlan(res, plan, created.version);
  }));

  // ---------------------------------------------------------------- list
  app.get('/v1/capabilities/plans', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const pagination = parsePagination(req, 200);
    const status = stringParam(req.query.status, 32);
    if (status && !isPlanStatus(status)) {
      throw apiError(400, 'invalid_request', 'status must be draft, active, paused, completed or archived');
    }
    const tenant = stringParam(req.query.tenant, 128);
    const where: Record<string, unknown> = {};
    if (isAdmin(principal)) {
      if (tenant) where.tenant = tenant;
    } else {
      // A tenant filter can never widen access for an organization-scoped caller.
      where.tenant = principal.tenantKey;
    }
    if (status) where.status = status;
    const result = await queryDocuments<PlanRecord>(client, COLLECTIONS.plans, {
      ...(Object.keys(where).length ? { where } : {}),
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: pagination.limit,
      offset: pagination.offset,
      ...(pagination.cursor ? { cursor: pagination.cursor } : {}),
    });
    setPageHeaders(res, {
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
      nextCursor: result.nextCursor,
    });
    res.setHeader('cache-control', 'no-store');
    res.json({
      items: result.items.map((item) => item.data),
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
      nextCursor: result.nextCursor,
    });
  }));

  // ---------------------------------------------------------------- read
  app.get('/v1/capabilities/plans/:id', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { plan, version } = await loadPlan(client, principal, String(req.params.id));
    sendPlan(res, plan, version);
  }));

  // ---------------------------------------------------------------- update metadata
  app.patch('/v1/capabilities/plans/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = assertBodyIsObject(req.body || {});
    const { plan, version } = await loadPlan(client, principal, String(req.params.id));
    if (plan.status !== 'draft') {
      throw apiError(409, 'invalid_transition', 'only a draft plan can be edited', {
        status: plan.status,
      });
    }
    requireVersionMatch(expectedVersion(req, body), version, 'plan');
    const allowed = new Set(['title', 'objective', 'eventId', 'severity', 'context', 'ifVersion', 'version']);
    const unknown = Object.keys(body).filter((field) => !allowed.has(field));
    if (unknown.length) {
      throw apiError(400, 'invalid_request', `unsupported plan fields: ${unknown.join(', ')}`);
    }
    const fields = updatableFields(body);
    if (!fields.length) throw apiError(400, 'invalid_request', 'no updatable fields were supplied');

    const next: PlanRecord = { ...plan, updatedAt: new Date().toISOString() };
    if ('title' in body) next.title = validatePlanTitle(body.title);
    if ('objective' in body) next.objective = validatePlanObjective(body.objective);
    if ('eventId' in body) {
      const eventId = validateOptionalPlanText(body.eventId, 'eventId', 128);
      if (eventId) next.eventId = eventId;
      else delete next.eventId;
    }
    if ('severity' in body) {
      const severity = validateOptionalPlanText(body.severity, 'severity', 32);
      if (severity) next.severity = severity;
      else delete next.severity;
    }
    if ('context' in body) {
      const context = validatePlanContext(body.context);
      if (context) next.context = context;
      else delete next.context;
    }
    const saved = await savePlan(client, next, version);
    await audit(client, config, req, principal, 'plan.update', {
      planId: next.id,
      fields,
    });
    sendPlan(res, saved.plan, saved.version);
  }));

  // ---------------------------------------------------------------- activate
  app.post('/v1/capabilities/plans/:id/activate', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { plan, version } = await loadPlan(client, principal, String(req.params.id));
    requireVersionMatch(expectedVersion(req, planMutationBody(req.body)), version, 'plan');
    if (plan.status === 'active') {
      // Activation is idempotent: retries must not move the due dates.
      sendPlan(res, plan, version);
      return;
    }
    assertPlanTransition(plan.status, 'active');
    const now = new Date().toISOString();
    const next = withComputedDueDates({
      ...plan,
      status: 'active',
      activatedAt: now,
      updatedAt: now,
    }, now);
    const saved = await savePlan(client, next, version);
    await audit(client, config, req, principal, 'plan.activate', {
      planId: next.id,
      from: plan.status,
      to: 'active',
    });
    sendPlan(res, saved.plan, saved.version);
  }));

  // ---------------------------------------------------------------- pause / complete / archive
  const transitions: Array<{
    action: 'pause' | 'complete' | 'archive';
    to: PlanStatus;
    audit: string;
  }> = [
    { action: 'pause', to: 'paused', audit: 'plan.pause' },
    { action: 'complete', to: 'completed', audit: 'plan.complete' },
    { action: 'archive', to: 'archived', audit: 'plan.archive' },
  ];

  for (const transition of transitions) {
    app.post(`/v1/capabilities/plans/:id/${transition.action}`, handler(async (req, res) => {
      const { principal, client } = await writeContext(req, config);
      const { plan, version } = await loadPlan(client, principal, String(req.params.id));
      requireVersionMatch(expectedVersion(req, planMutationBody(req.body)), version, 'plan');
      assertPlanTransition(plan.status, transition.to);
      const now = new Date().toISOString();
      const next: PlanRecord = {
        ...plan,
        status: transition.to,
        updatedAt: now,
        ...(transition.to === 'completed' ? { completedAt: now } : {}),
      };
      const saved = await savePlan(client, next, version);
      await audit(client, config, req, principal, transition.audit, {
        planId: next.id,
        from: plan.status,
        to: transition.to,
      });
      sendPlan(res, saved.plan, saved.version);
    }));
  }

  // ---------------------------------------------------------------- task status
  app.post('/v1/capabilities/plans/:id/tasks/:taskId/status', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const body = assertBodyIsObject(req.body || {});
    const status = String(body.status ?? '') as PlanTaskStatus;
    if (!isPlanTaskStatus(status)) {
      throw apiError(400, 'invalid_request', 'status must be pending, in_progress, done, blocked or skipped');
    }
    if (body.override !== undefined && typeof body.override !== 'boolean') {
      throw apiError(400, 'invalid_request', 'override must be a boolean');
    }
    const override = body.override === true;
    if (override && !isTenantAdmin(principal)) {
      throw apiError(403, 'admin_required', 'only an organization or deployment administrator may override task dependencies');
    }
    const note = body.note === undefined ? undefined : String(body.note).trim();
    if (note !== undefined && note.length > 2000) {
      throw apiError(400, 'invalid_request', 'note must be at most 2000 characters');
    }
    const assignee = body.assignee === undefined ? undefined : String(body.assignee).trim();
    if (assignee !== undefined && assignee.length > 128) {
      throw apiError(400, 'invalid_request', 'assignee must be at most 128 characters');
    }

    const { plan, version } = await loadPlan(client, principal, String(req.params.id));
    requireVersionMatch(expectedVersion(req, body), version, 'plan');
    if (plan.status !== 'active' && plan.status !== 'paused') {
      throw apiError(409, 'invalid_transition', 'tasks can only change while the plan is active or paused', {
        status: plan.status,
      });
    }
    const taskId = String(req.params.taskId);
    const found = findPlanTask(plan, taskId);
    if (!found) throw apiError(404, 'plan_task_not_found', 'plan task not found');
    const task = found.task;
    if (task.status === status) {
      // Idempotent retry: do not reset completedAt or append duplicate notes.
      sendPlan(res, plan, version);
      return;
    }
    assertTaskTransition(task.status, status);

    let missing: string[] = [];
    let overrideApplied = false;
    if (status === 'in_progress' || status === 'done') {
      missing = incompleteDependencies(plan, task);
      if (missing.length) {
        if (!override) {
          throw apiError(409, 'dependency_incomplete', 'all dependent tasks must be done first', {
            taskId: task.id,
            missing,
          });
        }
        overrideApplied = true;
      }
    }

    const now = new Date().toISOString();
    let notes = task.notes;
    if (note !== undefined) notes = note || undefined;
    if (overrideApplied) {
      const marker = `[override: ${missing.join(', ')} not done; approved by ${principal.subject} at ${now}]`;
      notes = notes ? `${notes}\n${marker}` : marker;
    }
    const nextTask = {
      ...task,
      status,
      ...(assignee !== undefined ? { assignee: assignee || undefined } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(status === 'done' || status === 'skipped' ? { completedAt: now } : {}),
    };
    const next: PlanRecord = {
      ...plan,
      updatedAt: now,
      phases: plan.phases.map((phase) => (phase.id === found.phase.id
        ? {
            ...phase,
            tasks: phase.tasks.map((entry) => (entry.id === task.id ? nextTask : entry)),
          }
        : phase)),
    };
    const saved = await savePlan(client, next, version);
    await audit(client, config, req, principal, 'plan.task_status', {
      planId: plan.id,
      taskId: task.id,
      from: task.status,
      to: status,
      ...(overrideApplied ? { override: true, missing } : {}),
    });
    sendPlan(res, saved.plan, saved.version);
  }));

  // ---------------------------------------------------------------- grounded brief
  app.post('/v1/capabilities/plans/:id/brief', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const body = planMutationBody(req.body);
    const focus = validateOptionalPlanText(body.focus, 'focus', 500);
    const { plan } = await loadPlan(client, principal, String(req.params.id));
    const result = await buildPlanBrief(client, plan, { ...(focus ? { focus } : {}) });
    res.setHeader('cache-control', 'no-store');
    res.json(result);
  }));
}
