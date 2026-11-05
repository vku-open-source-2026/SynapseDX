// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * P-layer business modules: people/KPIs/timesheets (#36), forms and process
 * definitions (#37), projects/portfolio with HITL stage gates (#38).
 */
import { Express } from 'express';
import { isAdmin, hasWriteScope } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import {
  COLLECTIONS, correlationIdOf, getDocumentOrNull, queryDocuments, recordAudit,
} from '../platform';
import { authenticatedReadContext, writeContext } from './shared';
import {
  createScoped, dateValue, getScoped, listScoped, newId, nowIso,
  objectValue, optionalString, requiredString, stringArray, updateScoped,
} from './module-helpers';

interface PersonRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  subject: string; name: string; email?: string; orgUnitId?: string; manager?: string; title?: string;
}
interface KpiRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  name: string; owner: string; period: string; start: number; target: number; unit?: string;
}
interface KpiCheckinRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  kpiId: string; value: number; note?: string; at: string;
}
interface TimesheetRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  personId: string; period: string; entries: Array<{ projectId?: string; date: string; hours: number; note?: string }>;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  approvalId?: string; submittedAt?: string; decidedAt?: string; decidedBy?: string; note?: string;
}
interface FormRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  name: string; description?: string; version: number; schema: Record<string, any>;
  published: boolean; versions: Array<{ version: number; schema: Record<string, any>; changelog?: string; at: string; by: string }>;
}
interface ProcessRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  name: string; version: number; published: boolean; nodes: any[]; connections: Record<string, any>;
  slaMinutes?: number; versions: Array<{ version: number; nodes: any[]; connections: Record<string, any>; at: string }>;
}
interface ProcessInstanceRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  processId: string; processVersion: number; status: 'running' | 'completed' | 'cancelled';
  currentNode: string; history: Array<{ node: string; at: string; by?: string; action?: string }>;
  input: Record<string, any>; assignee?: string;
}
interface ProjectRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  name: string; program?: string; startDate: string; endDate: string; budget?: number;
  stage: number; gates: Array<{ id: string; name: string; order: number; approverRoles: string[]; status: 'pending' | 'submitted' | 'approved' | 'rejected'; approvalId?: string }>;
}
interface ProjectTaskRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  projectId: string; title: string; assignee?: string; startDate?: string; endDate?: string;
  estimateHours?: number; status: 'todo' | 'doing' | 'done';
}
interface DependencyRecord {
  id: string; tenant: string; createdBy: string; createdAt: string; updatedAt: string;
  projectId: string; from: string; to: string;
}
interface ApprovalLike {
  id: string; tenant: string; title: string; module: string; action: string; entityType?: string; entityId?: string;
  requester: string; approverRoles: string[]; requiredApprovals: number; status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decisions: Array<{ actor: string; decision: 'approve' | 'reject'; note?: string; at: string }>;
  createdAt: string; updatedAt: string;
}

function validatePeriod(period: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw apiError(400, 'invalid_request', 'period must be YYYY-MM');
  return period;
}

function validateSchema(schema: Record<string, any>): void {
  if (schema.type !== 'object' || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    throw apiError(400, 'invalid_request', 'form schema must be an object schema with properties');
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((x: any) => typeof x !== 'string'))) {
    throw apiError(400, 'invalid_request', 'schema.required must be an array of property names');
  }
}

/** Small JSON-schema subset: type/required/enum/min/max/pattern plus
 *  `visibleWhen` conditional fields (hidden fields are not required). */
function validateFormValues(schema: Record<string, any>, values: Record<string, any>): string[] {
  const errors: string[] = [];
  const properties = schema.properties || {};
  const visible = (key: string): boolean => {
    const config = properties[key]?.visibleWhen;
    if (!config || typeof config !== 'object') return true;
    return values[config.field] === config.equals;
  };
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (!visible(key)) continue;
    const value = values[key];
    if (value === undefined || value === null || value === '') errors.push(`${key} is required`);
  }
  for (const [key, config] of Object.entries<Record<string, any>>(properties)) {
    if (!visible(key)) continue;
    const value = values[key];
    if ((value === undefined || value === null || value === '') && config.visibleWhen && typeof config.visibleWhen === 'object') {
      errors.push(`${key} is required`);
      continue;
    }
    if (value === undefined || value === null) continue;
    const type = config.type;
    if (type === 'string' && typeof value !== 'string') errors.push(`${key} must be a string`);
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`${key} must be a number`);
    if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${key} must be a boolean`);
    if (type === 'array' && !Array.isArray(value)) errors.push(`${key} must be an array`);
    if (Array.isArray(config.enum) && !config.enum.includes(value)) errors.push(`${key} must be one of ${config.enum.join(', ')}`);
    if (typeof value === 'number') {
      if (typeof config.minimum === 'number' && value < config.minimum) errors.push(`${key} must be ≥${config.minimum}`);
      if (typeof config.maximum === 'number' && value > config.maximum) errors.push(`${key} must be ≤${config.maximum}`);
    }
    if (typeof value === 'string' && typeof config.pattern === 'string') {
      try { if (!new RegExp(config.pattern).test(value)) errors.push(`${key} does not match the required pattern`); } catch { /* ignore invalid pattern */ }
    }
  }
  return errors;
}

function hasCycle(tasks: string[], dependencies: Array<{ from: string; to: string }>): boolean {
  const graph = new Map<string, string[]>();
  for (const id of tasks) graph.set(id, []);
  for (const dep of dependencies) graph.get(dep.from)?.push(dep.to);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) || []) if (visit(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return tasks.some((id) => visit(id));
}

export function registerPeopleProcessRoutes(app: Express, config: ServiceConfig): void {
  // ================= People / KPIs / timesheets =================
  app.post('/v1/capabilities/people', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const person = await createScoped(client, COLLECTIONS.people, principal, {
      subject: requiredString(b.subject, 'subject', 1, 128),
      name: requiredString(b.name, 'name', 1, 200),
      email: optionalString(b.email, 'email', 320),
      orgUnitId: optionalString(b.orgUnitId, 'orgUnitId', 128),
      manager: optionalString(b.manager, 'manager', 128),
      title: optionalString(b.title, 'title', 160),
    } as any) as unknown as PersonRecord;
    res.status(201).json({ person });
  }));

  app.get('/v1/capabilities/people', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { items } = await listScoped<PersonRecord>(client, COLLECTIONS.people, principal, { limit: 1000 });
    const visible = isAdmin(principal) ? items : items.filter((person) =>
      person.subject === principal.subject || person.manager === principal.subject);
    res.json({ items: visible, total: visible.length });
  }));

  app.post('/v1/capabilities/org-units', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const unit = await createScoped(client, COLLECTIONS.orgUnits, principal, {
      name: requiredString(b.name, 'name', 1, 160),
      parentId: optionalString(b.parentId, 'parentId', 128),
      manager: optionalString(b.manager, 'manager', 128),
    } as any);
    res.status(201).json({ orgUnit: unit });
  }));

  app.get('/v1/capabilities/org-units', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { items } = await listScoped(client, COLLECTIONS.orgUnits, principal, { limit: 500 });
    res.json({ items, total: items.length });
  }));

  app.post('/v1/capabilities/kpis', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const start = Number(b.start ?? 0);
    const target = Number(b.target);
    if (!Number.isFinite(start) || !Number.isFinite(target) || target === start) {
      throw apiError(400, 'invalid_request', 'start and target must be finite numbers and differ');
    }
    const kpi = await createScoped(client, COLLECTIONS.kpis, principal, {
      name: requiredString(b.name, 'name', 1, 200),
      owner: optionalString(b.owner, 'owner', 128) || principal.subject,
      period: requiredString(b.period, 'period', 1, 32),
      start, target, unit: optionalString(b.unit, 'unit', 32),
    } as any) as unknown as KpiRecord;
    res.status(201).json({ kpi });
  }));

  app.get('/v1/capabilities/kpis', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { items } = await listScoped<KpiRecord>(client, COLLECTIONS.kpis, principal, { limit: 500 });
    const checkins = await queryDocuments<KpiCheckinRecord>(client, COLLECTIONS.kpiCheckins, { where: { tenant: principal.tenantKey }, limit: 5000 });
    const withProgress = items.map((kpi) => {
      const latest = checkins.items.map((item) => item.data).filter((c) => c.kpiId === kpi.id)
        .sort((a, b) => b.at.localeCompare(a.at))[0];
      const progress = latest ? Math.max(0, Math.min(2, (latest.value - kpi.start) / (kpi.target - kpi.start))) : 0;
      return { ...kpi, latestValue: latest?.value ?? null, progress: Number(progress.toFixed(4)), checkedInAt: latest?.at ?? null };
    });
    res.json({ items: withProgress, total: withProgress.length });
  }));

  app.post('/v1/capabilities/kpis/:id/checkins', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: kpi } = await getScoped<KpiRecord>(client, COLLECTIONS.kpis, String(req.params.id), principal, 'kpi_not_found');
    const b = (req.body || {}) as Record<string, unknown>;
    const value = Number(b.value);
    if (!Number.isFinite(value)) throw apiError(400, 'invalid_request', 'value must be a finite number');
    const checkin = await createScoped(client, COLLECTIONS.kpiCheckins, principal, {
      kpiId: kpi.id, value, note: optionalString(b.note, 'note', 2000), at: dateValue(b.at, 'at') || nowIso(),
    } as any) as unknown as KpiCheckinRecord;
    const progress = Math.max(0, Math.min(2, (value - kpi.start) / (kpi.target - kpi.start)));
    res.status(201).json({ checkin, progress: Number(progress.toFixed(4)) });
  }));

  app.post('/v1/capabilities/timesheets', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const personId = requiredString(b.personId, 'personId', 1, 128);
    const { record: person } = await getScoped<PersonRecord>(client, COLLECTIONS.people, personId, principal, 'person_not_found');
    if (!isAdmin(principal) && person.subject !== principal.subject && person.manager !== principal.subject) {
      throw apiError(403, 'forbidden', 'only the person or their manager may submit a timesheet');
    }
    const period = validatePeriod(requiredString(b.period, 'period', 7, 7));
    const existing = await queryDocuments<TimesheetRecord>(client, COLLECTIONS.timesheets, {
      where: { tenant: principal.tenantKey, personId, period }, limit: 10,
    });
    if (existing.items.some((item) => item.data.status === 'approved')) {
      throw apiError(409, 'period_locked', 'this period is already approved and locked');
    }
    if (existing.items.some((item) => item.data.status === 'submitted')) {
      throw apiError(409, 'timesheet_pending', 'a timesheet for this period is already awaiting approval');
    }
    const entries = Array.isArray(b.entries) ? b.entries.slice(0, 200).map((entry: any) => {
      const date = dateValue(entry?.date, 'entry.date');
      const hours = Number(entry?.hours);
      if (!date || !Number.isFinite(hours) || hours <= 0 || hours > 24) throw apiError(400, 'invalid_request', 'each entry needs a valid date and 0<hours≤24');
      return { date, hours, ...(entry.projectId ? { projectId: String(entry.projectId) } : {}), ...(entry.note ? { note: String(entry.note).slice(0, 500) } : {}) };
    }) : [];
    if (!entries.length) throw apiError(400, 'invalid_request', 'entries[] is required');
    const timesheet = await createScoped(client, COLLECTIONS.timesheets, principal, {
      personId, period, entries, status: 'draft',
    } as any) as unknown as TimesheetRecord;
    res.status(201).json({ timesheet });
  }));

  app.post('/v1/capabilities/timesheets/:id/submit', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record } = await getScoped<TimesheetRecord>(client, COLLECTIONS.timesheets, String(req.params.id), principal, 'timesheet_not_found');
    if (record.status !== 'draft' && record.status !== 'rejected') throw apiError(409, 'invalid_transition', 'only draft or rejected timesheets can be submitted');
    const personDoc = await getDocumentOrNull<PersonRecord>(client, COLLECTIONS.people, record.personId);
    const approver = personDoc?.data.manager;
    const now = nowIso();
    const approval: ApprovalLike = {
      id: newId(), tenant: principal.tenantKey, title: `Timesheet ${record.period}`, module: 'people.timesheet',
      action: 'timesheet.approve', entityType: 'timesheet', entityId: record.id, requester: principal.subject,
      approverRoles: approver ? [approver] : ['manager'], requiredApprovals: 1, status: 'pending', decisions: [],
      createdAt: now, updatedAt: now,
    };
    await client.base.createDocument(COLLECTIONS.approvals, { id: approval.id, data: approval as unknown as Record<string, unknown> });
    const updated = await updateScoped(client, COLLECTIONS.timesheets, record.id, principal, {
      status: 'submitted', approvalId: approval.id, submittedAt: now,
    } as any);
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'people.timesheet.submit',
      correlationId: correlationIdOf(req), details: { timesheetId: record.id, approvalId: approval.id },
    });
    res.status(202).json({ timesheet: updated, approval });
  }));

  app.post('/v1/capabilities/timesheets/:id/decide', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { record } = await getScoped<TimesheetRecord>(client, COLLECTIONS.timesheets, String(req.params.id), principal, 'timesheet_not_found');
    if (record.status !== 'submitted' || !record.approvalId) throw apiError(409, 'invalid_transition', 'timesheet is not awaiting approval');
    if (record.createdBy === principal.subject) throw apiError(403, 'self_approval_forbidden', 'the submitter cannot approve their own timesheet');
    const approvalDoc = await getDocumentOrNull<ApprovalLike>(client, COLLECTIONS.approvals, record.approvalId);
    if (!approvalDoc || approvalDoc.data.status !== 'pending') throw apiError(409, 'approval_not_pending', 'approval is no longer pending');
    if (!isAdmin(principal) && !hasWriteScope(principal) && approvalDoc.data.approverRoles.length
      && !approvalDoc.data.approverRoles.includes(principal.subject)) {
      throw apiError(403, 'approver_role_required', 'you do not hold an approver role');
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const decision = String(body.decision || '').toLowerCase();
    if (!['approve', 'reject'].includes(decision)) throw apiError(400, 'invalid_request', 'decision must be approve or reject');
    const note = optionalString(body.note, 'note', 2000);
    const now = nowIso();
    const approval = {
      ...approvalDoc.data,
      status: decision === 'approve' ? 'approved' : 'rejected',
      decisions: [...approvalDoc.data.decisions, { actor: principal.subject, decision: decision as 'approve' | 'reject', ...(note ? { note } : {}), at: now }],
      updatedAt: now,
    };
    await client.base.updateDocument(COLLECTIONS.approvals, approval.id, { data: approval as unknown as Record<string, unknown> });
    const updated = await updateScoped(client, COLLECTIONS.timesheets, record.id, principal, {
      status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: now, decidedBy: principal.subject, ...(note ? { note } : {}),
    } as any);
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'people.timesheet.decide',
      correlationId: correlationIdOf(req), details: { timesheetId: record.id, decision },
    });
    res.json({ timesheet: updated, approval });
  }));

  app.get('/v1/capabilities/timesheets', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const where: Record<string, unknown> = {};
    if (req.query.personId) where.personId = String(req.query.personId);
    if (req.query.period) where.period = validatePeriod(String(req.query.period));
    if (req.query.status) where.status = String(req.query.status);
    const { items } = await listScoped<TimesheetRecord>(client, COLLECTIONS.timesheets, principal, { where, limit: 1000 });
    const people = await queryDocuments<PersonRecord>(client, COLLECTIONS.people, { where: { tenant: principal.tenantKey }, limit: 2000 });
    const personById = new Map(people.items.map((item) => [item.data.id, item.data]));
    const visible = isAdmin(principal) ? items : items.filter((ts) => {
      const person = personById.get(ts.personId);
      return ts.createdBy === principal.subject || person?.subject === principal.subject || person?.manager === principal.subject;
    });
    res.json({ items: visible, total: visible.length });
  }));

  // ================= Forms / processes =================
  app.post('/v1/capabilities/forms', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const schema = objectValue(b.schema, 'schema', 200_000);
    validateSchema(schema);
    const form = await createScoped(client, COLLECTIONS.forms, principal, {
      name: requiredString(b.name, 'name', 1, 200), description: optionalString(b.description, 'description', 1000),
      version: 1, schema, published: b.published === true, versions: [],
    } as any) as unknown as FormRecord;
    res.status(201).json({ form });
  }));

  app.get('/v1/capabilities/forms', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { items } = await listScoped<FormRecord>(client, COLLECTIONS.forms, principal, { limit: 500 });
    res.json({ items, total: items.length });
  }));

  app.get('/v1/capabilities/forms/:id', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { record } = await getScoped<FormRecord>(client, COLLECTIONS.forms, String(req.params.id), principal, 'form_not_found');
    res.json({ form: record });
  }));

  app.post('/v1/capabilities/forms/:id/versions', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: form } = await getScoped<FormRecord>(client, COLLECTIONS.forms, String(req.params.id), principal, 'form_not_found');
    const b = (req.body || {}) as Record<string, unknown>;
    const schema = objectValue(b.schema, 'schema', 200_000);
    validateSchema(schema);
    const versions = [...(form.versions || []), { version: form.version, schema: form.schema, changelog: optionalString(b.changelog, 'changelog', 500), at: nowIso(), by: principal.subject }].slice(-50);
    const updated = await updateScoped(client, COLLECTIONS.forms, form.id, principal, {
      schema, version: form.version + 1, versions, published: b.published === true ? true : form.published,
    } as any);
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'process.form.version',
      correlationId: correlationIdOf(req), details: { formId: form.id, version: form.version + 1 },
    });
    res.status(201).json({ form: updated });
  }));

  app.post('/v1/capabilities/forms/:id/validate', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { record: form } = await getScoped<FormRecord>(client, COLLECTIONS.forms, String(req.params.id), principal, 'form_not_found');
    const values = objectValue((req.body || {}).values, 'values', 200_000);
    const errors = validateFormValues(form.schema, values);
    res.json({ valid: errors.length === 0, errors, version: form.version });
  }));

  app.post('/v1/capabilities/processes', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const nodes = Array.isArray(b.nodes) ? b.nodes : [];
    if (!nodes.length || nodes.length > 100) throw apiError(400, 'invalid_request', 'nodes must contain 1..100 entries');
    const validTypes = new Set(['start', 'userTask', 'decision', 'timer', 'end']);
    for (const node of nodes) {
      if (!node || typeof node !== 'object' || !validTypes.has(String(node.type)) || !String(node.id || '').trim()) {
        throw apiError(400, 'invalid_request', 'each process node needs id and type start|userTask|decision|timer|end');
      }
    }
    const process = await createScoped(client, COLLECTIONS.processes, principal, {
      name: requiredString(b.name, 'name', 1, 200), version: 1,
      published: b.published === true, nodes,
      connections: objectValue(b.connections, 'connections', 100_000),
      slaMinutes: b.slaMinutes === undefined ? undefined : Number(b.slaMinutes), versions: [],
    } as any) as unknown as ProcessRecord;
    res.status(201).json({ process });
  }));

  app.get('/v1/capabilities/processes', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { items } = await listScoped<ProcessRecord>(client, COLLECTIONS.processes, principal, { limit: 500 });
    res.json({ items, total: items.length });
  }));

  app.post('/v1/capabilities/processes/:id/versions', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: process } = await getScoped<ProcessRecord>(client, COLLECTIONS.processes, String(req.params.id), principal, 'process_not_found');
    const b = (req.body || {}) as Record<string, unknown>;
    const nodes = Array.isArray(b.nodes) ? b.nodes : process.nodes;
    const versions = [...(process.versions || []), { version: process.version, nodes: process.nodes, connections: process.connections, at: nowIso() }].slice(-50);
    const updated = await updateScoped(client, COLLECTIONS.processes, process.id, principal, {
      nodes, connections: b.connections ? objectValue(b.connections, 'connections', 100_000) : process.connections,
      version: process.version + 1, versions, published: b.published === true ? true : process.published,
    } as any);
    res.status(201).json({ process: updated });
  }));

  app.post('/v1/capabilities/processes/:id/start', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: process } = await getScoped<ProcessRecord>(client, COLLECTIONS.processes, String(req.params.id), principal, 'process_not_found');
    if (!process.published) throw apiError(409, 'process_not_published', 'publish the process before starting it');
    const b = (req.body || {}) as Record<string, unknown>;
    const start = process.nodes.find((node) => node.type === 'start');
    if (!start) throw apiError(400, 'invalid_process', 'process has no start node');
    const input = objectValue(b.input, 'input', 100_000);
    const assignment = b.assignment && typeof b.assignment === 'object' ? b.assignment as Record<string, unknown> : {};
    const mode = String(assignment.mode || 'user');
    let assignee: string | undefined;
    if (mode === 'user') assignee = optionalString(assignment.value, 'assignment.value', 128);
    else if (mode === 'role') assignee = `role:${requiredString(assignment.value, 'assignment.value', 1, 128)}`;
    else if (mode === 'expression') assignee = String(input[String(assignment.value || '')] || '') || undefined;
    else if (mode === 'roundRobin') {
      const staff = stringArray(assignment.candidates, 'assignment.candidates', 100);
      assignee = staff.length ? staff[0] : undefined;
    }
    const instance = await createScoped(client, COLLECTIONS.processInstances, principal, {
      processId: process.id, processVersion: process.version, status: 'running', currentNode: String(start.id),
      input, history: [{ node: String(start.id), at: nowIso(), by: principal.subject, action: 'start' }],
      ...(assignee ? { assignee } : {}),
    } as any) as unknown as ProcessInstanceRecord;
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'process.instance.start',
      correlationId: correlationIdOf(req), details: { processId: process.id, instanceId: instance.id, version: process.version },
    });
    res.status(201).json({ instance });
  }));

  app.post('/v1/capabilities/process-instances/:id/transition', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: instance } = await getScoped<ProcessInstanceRecord>(client, COLLECTIONS.processInstances, String(req.params.id), principal, 'instance_not_found');
    if (instance.status !== 'running') throw apiError(409, 'invalid_transition', 'process instance is not running');
    const { record: process } = await getScoped<ProcessRecord>(client, COLLECTIONS.processes, instance.processId, principal, 'process_not_found');
    const b = (req.body || {}) as Record<string, unknown>;
    const action = String(b.action || 'complete');
    const allowed = Array.isArray((process.connections as any)?.[instance.currentNode]?.main)
      ? ((process.connections as any)[instance.currentNode].main as Array<Array<{ node: string }>>)
      : [];
    const target = action === 'cancel' ? 'end' : String(b.node || allowed.flat()[0]?.node || '');
    if (!target) throw apiError(409, 'invalid_transition', 'no valid transition from the current node');
    const known = process.nodes.some((node) => String(node.id) === target);
    if (!known) throw apiError(409, 'invalid_transition', `unknown target node '${target}'`);
    const legal = action === 'cancel' || allowed.flat().some((edge) => edge.node === target);
    if (!legal) throw apiError(409, 'invalid_transition', `'${target}' is not reachable from '${instance.currentNode}'`);
    const isEnd = process.nodes.find((node) => String(node.id) === target)?.type === 'end';
    const updated = await updateScoped(client, COLLECTIONS.processInstances, instance.id, principal, {
      currentNode: target,
      status: action === 'cancel' || isEnd ? (action === 'cancel' ? 'cancelled' : 'completed') : 'running',
      history: [...instance.history, { node: target, at: nowIso(), by: principal.subject, action }],
    } as any);
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: `process.instance.${action}`,
      correlationId: correlationIdOf(req), details: { instanceId: instance.id, from: instance.currentNode, to: target },
    });
    res.json({ instance: updated });
  }));

  app.get('/v1/capabilities/process-instances', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const where: Record<string, unknown> = {};
    if (req.query.processId) where.processId = String(req.query.processId);
    if (req.query.status) where.status = String(req.query.status);
    const { items } = await listScoped<ProcessInstanceRecord>(client, COLLECTIONS.processInstances, principal, { where, limit: 1000 });
    res.json({ items, total: items.length });
  }));

  // ================= Projects =================
  app.post('/v1/capabilities/projects', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const b = (req.body || {}) as Record<string, unknown>;
    const startDate = dateValue(b.startDate, 'startDate');
    const endDate = dateValue(b.endDate, 'endDate');
    if (!startDate || !endDate) throw apiError(400, 'invalid_request', 'startDate and endDate are required');
    if (new Date(startDate).getTime() > new Date(endDate).getTime()) throw apiError(400, 'invalid_request', 'startDate must be before endDate');
    const project = await createScoped(client, COLLECTIONS.projects, principal, {
      name: requiredString(b.name, 'name', 1, 200), program: optionalString(b.program, 'program', 200),
      startDate, endDate, budget: b.budget === undefined ? undefined : Number(b.budget),
      stage: 1, gates: [],
    } as any) as unknown as ProjectRecord;
    res.status(201).json({ project });
  }));

  app.get('/v1/capabilities/projects', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { items } = await listScoped<ProjectRecord>(client, COLLECTIONS.projects, principal, { limit: 500 });
    res.json({ items, total: items.length });
  }));

  app.get('/v1/capabilities/projects/:id', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { record: project } = await getScoped<ProjectRecord>(client, COLLECTIONS.projects, String(req.params.id), principal, 'project_not_found');
    const tasks = await queryDocuments<ProjectTaskRecord>(client, COLLECTIONS.projectTasks, { where: { tenant: principal.tenantKey, projectId: project.id }, limit: 1000 });
    const dependencies = await queryDocuments<DependencyRecord>(client, COLLECTIONS.projectDependencies, { where: { tenant: principal.tenantKey, projectId: project.id }, limit: 1000 });
    const milestones = await queryDocuments(client, COLLECTIONS.milestones, { where: { tenant: principal.tenantKey, projectId: project.id }, limit: 500 });
    const raid = await queryDocuments(client, COLLECTIONS.raid, { where: { tenant: principal.tenantKey, projectId: project.id }, limit: 500 });
    res.json({
      project, tasks: tasks.items.map((item) => item.data), dependencies: dependencies.items.map((item) => item.data),
      milestones: milestones.items.map((item) => item.data), raid: raid.items.map((item) => item.data),
    });
  }));

  app.patch('/v1/capabilities/projects/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: project } = await getScoped<ProjectRecord>(client, COLLECTIONS.projects, String(req.params.id), principal, 'project_not_found');
    const b = (req.body || {}) as Record<string, unknown>;
    const startDate = b.startDate !== undefined ? dateValue(b.startDate, 'startDate') : project.startDate;
    const endDate = b.endDate !== undefined ? dateValue(b.endDate, 'endDate') : project.endDate;
    if (!startDate || !endDate || new Date(startDate).getTime() > new Date(endDate).getTime()) {
      throw apiError(400, 'invalid_request', 'startDate must be before endDate');
    }
    if (b.stage !== undefined) {
      const nextStage = Number(b.stage);
      if (!Number.isInteger(nextStage) || nextStage < 1) throw apiError(400, 'invalid_request', 'stage must be a positive integer');
      const blocking = (project.gates || []).find((gate) => gate.order < nextStage && gate.status !== 'approved');
      if (blocking) throw apiError(409, 'stage_gate_blocked', `stage gate '${blocking.name}' must be approved first`);
    }
    const updated = await updateScoped(client, COLLECTIONS.projects, project.id, principal, {
      ...(b.name !== undefined ? { name: requiredString(b.name, 'name', 1, 200) } : {}),
      ...(b.program !== undefined ? { program: optionalString(b.program, 'program', 200) } : {}),
      ...(b.startDate !== undefined ? { startDate } : {}),
      ...(b.endDate !== undefined ? { endDate } : {}),
      ...(b.budget !== undefined ? { budget: Number(b.budget) } : {}),
      ...(b.stage !== undefined ? { stage: Number(b.stage) } : {}),
    } as any);
    res.json({ project: updated });
  }));

  app.post('/v1/capabilities/projects/:id/tasks', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: project } = await getScoped<ProjectRecord>(client, COLLECTIONS.projects, String(req.params.id), principal, 'project_not_found');
    const b = (req.body || {}) as Record<string, unknown>;
    const startDate = dateValue(b.startDate, 'startDate');
    const endDate = dateValue(b.endDate, 'endDate');
    if (startDate && endDate && new Date(startDate).getTime() > new Date(endDate).getTime()) {
      throw apiError(400, 'invalid_request', 'task startDate must be before endDate');
    }
    const task = await createScoped(client, COLLECTIONS.projectTasks, principal, {
      projectId: project.id, title: requiredString(b.title, 'title', 1, 240),
      assignee: optionalString(b.assignee, 'assignee', 128), startDate, endDate,
      estimateHours: b.estimateHours === undefined ? undefined : Number(b.estimateHours),
      status: ['todo', 'doing', 'done'].includes(String(b.status)) ? String(b.status) : 'todo',
    } as any) as unknown as ProjectTaskRecord;
    res.status(201).json({ task });
  }));

  app.patch('/v1/capabilities/project-tasks/:id', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: task } = await getScoped<ProjectTaskRecord>(client, COLLECTIONS.projectTasks, String(req.params.id), principal, 'task_not_found');
    const b = (req.body || {}) as Record<string, unknown>;
    const updated = await updateScoped(client, COLLECTIONS.projectTasks, task.id, principal, {
      ...(b.title !== undefined ? { title: requiredString(b.title, 'title', 1, 240) } : {}),
      ...(b.assignee !== undefined ? { assignee: optionalString(b.assignee, 'assignee', 128) } : {}),
      ...(b.status !== undefined && ['todo', 'doing', 'done'].includes(String(b.status)) ? { status: String(b.status) } : {}),
      ...(b.estimateHours !== undefined ? { estimateHours: Number(b.estimateHours) } : {}),
    } as any);
    res.json({ task: updated });
  }));

  app.post('/v1/capabilities/projects/:id/dependencies', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: project } = await getScoped<ProjectRecord>(client, COLLECTIONS.projects, String(req.params.id), principal, 'project_not_found');
    const b = (req.body || {}) as Record<string, unknown>;
    const from = requiredString(b.from, 'from', 1, 128);
    const to = requiredString(b.to, 'to', 1, 128);
    if (from === to) throw apiError(400, 'invalid_request', 'a task cannot depend on itself');
    const tasks = await queryDocuments<ProjectTaskRecord>(client, COLLECTIONS.projectTasks, { where: { tenant: principal.tenantKey, projectId: project.id }, limit: 5000 });
    const ids = tasks.items.map((item) => item.data.id);
    if (!ids.includes(from) || !ids.includes(to)) throw apiError(400, 'invalid_request', 'from and to must be tasks in this project');
    const existing = await queryDocuments<DependencyRecord>(client, COLLECTIONS.projectDependencies, { where: { tenant: principal.tenantKey, projectId: project.id }, limit: 5000 });
    const deps = [...existing.items.map((item) => item.data), { from, to }];
    if (hasCycle(ids, deps.map((d) => ({ from: d.from, to: d.to })))) {
      throw apiError(409, 'dependency_cycle', 'this dependency would create a cycle');
    }
    const dependency = await createScoped(client, COLLECTIONS.projectDependencies, principal, { projectId: project.id, from, to } as any) as unknown as DependencyRecord;
    res.status(201).json({ dependency });
  }));

  app.post('/v1/capabilities/projects/:id/raid', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: project } = await getScoped<ProjectRecord>(client, COLLECTIONS.projects, String(req.params.id), principal, 'project_not_found');
    const b = (req.body || {}) as Record<string, unknown>;
    const item = await createScoped(client, COLLECTIONS.raid, principal, {
      projectId: project.id, kind: ['risk', 'assumption', 'issue', 'dependency'].includes(String(b.kind)) ? String(b.kind) : 'risk',
      title: requiredString(b.title, 'title', 1, 240), description: optionalString(b.description, 'description', 4000),
      severity: ['low', 'medium', 'high', 'critical'].includes(String(b.severity)) ? String(b.severity) : 'medium',
      status: 'open',
    } as any);
    res.status(201).json({ item });
  }));

  app.post('/v1/capabilities/projects/:id/gates', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: project } = await getScoped<ProjectRecord>(client, COLLECTIONS.projects, String(req.params.id), principal, 'project_not_found');
    const b = (req.body || {}) as Record<string, unknown>;
    const order = Number(b.order);
    if (!Number.isInteger(order) || order < 1) throw apiError(400, 'invalid_request', 'order must be a positive integer');
    const gate = {
      id: newId(), name: requiredString(b.name, 'name', 1, 200), order,
      approverRoles: stringArray(b.approverRoles, 'approverRoles', 10), status: 'pending' as const,
    };
    const gates = [...(project.gates || []), gate].sort((a, b2) => a.order - b2.order);
    const updated = await updateScoped(client, COLLECTIONS.projects, project.id, principal, { gates } as any);
    res.status(201).json({ gate, project: updated });
  }));

  app.post('/v1/capabilities/projects/:id/gates/:gateId/submit', handler(async (req, res) => {
    const { principal, client } = await writeContext(req, config);
    const { record: project } = await getScoped<ProjectRecord>(client, COLLECTIONS.projects, String(req.params.id), principal, 'project_not_found');
    const gate = project.gates.find((item) => item.id === req.params.gateId);
    if (!gate) throw apiError(404, 'gate_not_found', 'stage gate not found');
    if (gate.status !== 'pending' && gate.status !== 'rejected') throw apiError(409, 'invalid_transition', 'gate is not pending');
    const now = nowIso();
    const approval: ApprovalLike = {
      id: newId(), tenant: principal.tenantKey, title: `Stage gate: ${gate.name}`, module: 'projects.gate',
      action: 'gate.approve', entityType: 'project', entityId: project.id, requester: principal.subject,
      approverRoles: gate.approverRoles, requiredApprovals: 1, status: 'pending', decisions: [], createdAt: now, updatedAt: now,
    };
    await client.base.createDocument(COLLECTIONS.approvals, { id: approval.id, data: approval as unknown as Record<string, unknown> });
    const gates = project.gates.map((item) => item.id === gate.id ? { ...item, status: 'submitted' as const, approvalId: approval.id } : item);
    const updated = await updateScoped(client, COLLECTIONS.projects, project.id, principal, { gates } as any);
    res.status(202).json({ project: updated, approval });
  }));

  app.post('/v1/capabilities/projects/:id/gates/:gateId/decide', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const { record: project } = await getScoped<ProjectRecord>(client, COLLECTIONS.projects, String(req.params.id), principal, 'project_not_found');
    const gate = project.gates.find((item) => item.id === req.params.gateId);
    if (!gate || !gate.approvalId) throw apiError(404, 'gate_not_found', 'gate has no pending approval');
    const approvalDoc = await getDocumentOrNull<ApprovalLike>(client, COLLECTIONS.approvals, gate.approvalId);
    if (!approvalDoc || approvalDoc.data.status !== 'pending') throw apiError(409, 'approval_not_pending', 'approval is no longer pending');
    if (approvalDoc.data.requester === principal.subject) throw apiError(403, 'self_approval_forbidden', 'the requester cannot approve their own gate');
    const b = (req.body || {}) as Record<string, unknown>;
    const decision = String(b.decision || '').toLowerCase();
    if (!['approve', 'reject'].includes(decision)) throw apiError(400, 'invalid_request', 'decision must be approve or reject');
    const now = nowIso();
    const approval = {
      ...approvalDoc.data, status: decision === 'approve' ? 'approved' : 'rejected',
      decisions: [...approvalDoc.data.decisions, { actor: principal.subject, decision: decision as 'approve' | 'reject', at: now, ...(b.note ? { note: String(b.note).slice(0, 2000) } : {}) }],
      updatedAt: now,
    };
    await client.base.updateDocument(COLLECTIONS.approvals, approval.id, { data: approval as unknown as Record<string, unknown> });
    const gates = project.gates.map((item) => item.id === gate.id ? { ...item, status: decision === 'approve' ? 'approved' as const : 'rejected' as const } : item);
    const updated = await updateScoped(client, COLLECTIONS.projects, project.id, principal, { gates } as any);
    await recordAudit(client, config, {
      actor: principal.subject, tenant: principal.tenantKey, action: 'projects.gate.decide',
      correlationId: correlationIdOf(req), details: { projectId: project.id, gateId: gate.id, decision },
    });
    res.json({ project: updated, approval });
  }));

  app.get('/v1/capabilities/project-capacity', handler(async (req, res) => {
    const { principal, client } = await authenticatedReadContext(req, config);
    const week = String(req.query.week || '');
    if (week && !/^\d{4}-W\d{2}$/.test(week)) throw apiError(400, 'invalid_request', 'week must be YYYY-Www');
    const people = await queryDocuments<PersonRecord>(client, COLLECTIONS.people, { where: { tenant: principal.tenantKey }, limit: 2000 });
    const timesheets = await queryDocuments<TimesheetRecord>(client, COLLECTIONS.timesheets, { where: { tenant: principal.tenantKey }, limit: 5000 });
    const personById = new Map(people.items.map((item) => [item.data.id, item.data]));
    const allocation = new Map<string, { personId: string; name: string; hours: number; projects: Record<string, number> }>();
    for (const sheet of timesheets.items.map((item) => item.data)) {
      if (sheet.status !== 'approved') continue;
      for (const entry of sheet.entries) {
        const key = sheet.personId;
        const current = allocation.get(key) || { personId: key, name: personById.get(key)?.name || key, hours: 0, projects: {} };
        current.hours += entry.hours;
        if (entry.projectId) current.projects[entry.projectId] = (current.projects[entry.projectId] || 0) + entry.hours;
        allocation.set(key, current);
      }
    }
    const items = [...allocation.values()].map((row) => ({ ...row, overAllocated: row.hours > 40 }));
    res.json({ week: week || 'all', items, overAllocated: items.filter((i) => i.overAllocated).length });
  }));
}
