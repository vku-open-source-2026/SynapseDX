// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Generic human-in-the-loop approvals.
 *
 * A request is tenant-scoped, has an explicit approver role set and a required
 * approval count, and records every decision. It does not execute domain
 * effects itself; the caller applies the approved action and keeps its own
 * domain state. Publication review remains a separate dataset lane.
 */
import { Express } from 'express';
import { randomUUID } from 'crypto';
import { SynapseOneClient, SynapseOneError } from '@synapseone/sdk';
import { CallerPrincipal, hasReadScope, hasWriteScope, isAdmin, isModerator, requireAuthenticated } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import {
  COLLECTIONS, correlationIdOf, getDocumentOrNull, queryDocuments, recordAudit,
} from '../platform';
import { managementRoles } from './management';
import { readContext, writeContext } from './shared';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ApprovalDecision {
  actor: string;
  decision: 'approve' | 'reject';
  note?: string;
  at: string;
}

export interface ApprovalRecord {
  id: string;
  tenant: string;
  title: string;
  module: string;
  action: string;
  entityType?: string;
  entityId?: string;
  payload?: Record<string, unknown>;
  requester: string;
  approverRoles: string[];
  requiredApprovals: number;
  status: ApprovalStatus;
  decisions: ApprovalDecision[];
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
}

function actorRoles(principal: CallerPrincipal): Set<string> {
  const roles = new Set<string>(managementRoles(principal));
  for (const scope of principal.scopes) roles.add(scope.toLowerCase());
  if (isAdmin(principal)) roles.add('admin');
  if (isModerator(principal)) roles.add('moderator');
  if (hasWriteScope(principal)) roles.add('operator');
  if (hasReadScope(principal)) roles.add('manager');
  return roles;
}

function canSee(principal: CallerPrincipal, approval: ApprovalRecord): boolean {
  return isAdmin(principal) || approval.tenant === principal.tenantKey;
}

function validateString(value: unknown, name: string, min: number, max: number): string {
  const text = String(value ?? '').trim();
  if (text.length < min || text.length > max) {
    throw apiError(400, 'invalid_request', `${name} must be ${min}..${max} characters`);
  }
  return text;
}

function validateStringArray(value: unknown, name: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw apiError(400, 'invalid_request', `${name} must be an array of 1..${max} non-empty strings`);
  }
  return [...new Set(value.map((item) => String(item).trim().toLowerCase()))];
}

function asApproval(document: { version: number; data: unknown }): { approval: ApprovalRecord; version: number } {
  return { approval: document.data as ApprovalRecord, version: document.version };
}

async function loadApproval(client: SynapseOneClient, id: string): Promise<{ approval: ApprovalRecord; version: number }> {
  const document = await getDocumentOrNull<ApprovalRecord>(client, COLLECTIONS.approvals, id);
  if (!document) throw apiError(404, 'approval_not_found', 'approval not found');
  return asApproval(document);
}

async function saveApproval(
  client: SynapseOneClient,
  approval: ApprovalRecord,
  version: number,
): Promise<ApprovalRecord> {
  try {
    const saved = await client.base.updateDocument(COLLECTIONS.approvals, approval.id, {
      data: approval as unknown as Record<string, unknown>,
      ifVersion: version,
    });
    return saved.data as unknown as ApprovalRecord;
  } catch (error) {
    if (error instanceof SynapseOneError && error.status === 409) {
      throw apiError(409, 'version_conflict', 'the approval was modified by another request');
    }
    throw error;
  }
}

export function registerApprovalRoutes(app: Express, config: ServiceConfig): void {
  app.post('/v1/capabilities/approvals', handler(async (req, res) => {
    const { caller, principal, client } = await writeContext(req, config);
    const verified = requireAuthenticated(caller);
    const body = (req.body || {}) as Record<string, unknown>;
    const title = validateString(body.title, 'title', 3, 200);
    const module = validateString(body.module, 'module', 1, 64);
    const action = validateString(body.action, 'action', 1, 128);
    const approverRoles = validateStringArray(body.approverRoles, 'approverRoles', 10);
    const requiredApprovals = body.requiredApprovals === undefined ? 1 : Number(body.requiredApprovals);
    if (!Number.isInteger(requiredApprovals) || requiredApprovals < 1 || requiredApprovals > 10) {
      throw apiError(400, 'invalid_request', 'requiredApprovals must be an integer 1..10');
    }
    if (body.dueAt !== undefined) {
      const due = new Date(String(body.dueAt));
      if (!Number.isFinite(due.getTime())) throw apiError(400, 'invalid_request', 'dueAt must be an ISO timestamp');
    }
    const payload = body.payload === undefined ? undefined : body.payload;
    if (payload !== undefined && (typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 16_384)) {
      throw apiError(400, 'invalid_request', 'payload must be a JSON object up to 16 KB');
    }
    const now = new Date().toISOString();
    const approval: ApprovalRecord = {
      id: randomUUID(),
      tenant: verified.tenantKey,
      title,
      module,
      action,
      ...(body.entityType !== undefined ? { entityType: String(body.entityType).slice(0, 64) } : {}),
      ...(body.entityId !== undefined ? { entityId: String(body.entityId).slice(0, 256) } : {}),
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      requester: verified.subject,
      approverRoles,
      requiredApprovals,
      status: 'pending',
      decisions: [],
      ...(body.dueAt !== undefined ? { dueAt: new Date(String(body.dueAt)).toISOString() } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await client.base.createDocument(COLLECTIONS.approvals, {
      id: approval.id,
      data: approval as unknown as Record<string, unknown>,
    });
    await recordAudit(client, config, {
      actor: verified.subject,
      tenant: verified.tenantKey,
      action: 'approval.create',
      correlationId: correlationIdOf(req),
      details: { module, action, requiredApprovals, approverRoles },
    });
    res.setHeader('location', `/v1/capabilities/approvals/${approval.id}`);
    res.status(201).json({ approval });
  }));

  app.get('/v1/capabilities/approvals', handler(async (req, res) => {
    const { caller, principal, client } = await readContext(req, config);
    const verified = requireAuthenticated(caller);
    const status = String(req.query.status || '').trim();
    if (status && !['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      throw apiError(400, 'invalid_request', 'status must be pending, approved, rejected or cancelled');
    }
    const mine = String(req.query.mine || '').trim();
    if (mine && !['requester', 'approver'].includes(mine)) {
      throw apiError(400, 'invalid_request', 'mine must be requester or approver');
    }
    const module = String(req.query.module || '').trim();
    const where: Record<string, unknown> = {};
    if (!isAdmin(verified)) where.tenant = verified.tenantKey;
    if (status) where.status = status;
    if (module) where.module = module;
    const result = await queryDocuments<ApprovalRecord>(client, COLLECTIONS.approvals, {
      ...(Object.keys(where).length ? { where } : {}),
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 1000,
    });
    const roles = actorRoles(verified);
    let items = result.items.map((item) => item.data);
    if (mine === 'requester') items = items.filter((item) => item.requester === verified.subject);
    if (mine === 'approver') {
      items = items.filter((item) => item.status === 'pending'
        && (item.approverRoles.length === 0 || isAdmin(verified)
          || item.approverRoles.some((role) => roles.has(role.toLowerCase()))));
    }
    res.setHeader('cache-control', 'no-store');
    res.json({ items, total: items.length });
  }));

  app.get('/v1/capabilities/approvals/:id', handler(async (req, res) => {
    const { caller, principal, client } = await readContext(req, config);
    const verified = requireAuthenticated(caller);
    const { approval, version } = await loadApproval(client, String(req.params.id));
    if (!canSee(verified, approval)) throw apiError(404, 'approval_not_found', 'approval not found');
    res.setHeader('etag', `"${version}"`);
    res.setHeader('cache-control', 'no-store');
    res.json({ approval, version });
  }));

  app.post('/v1/capabilities/approvals/:id/decide', handler(async (req, res) => {
    const { caller, client } = await readContext(req, config);
    const verified = requireAuthenticated(caller);
    const { approval, version } = await loadApproval(client, String(req.params.id));
    if (!canSee(verified, approval)) throw apiError(404, 'approval_not_found', 'approval not found');
    if (approval.status !== 'pending') throw apiError(409, 'approval_not_pending', 'this approval is no longer pending');
    const body = (req.body || {}) as Record<string, unknown>;
    const decision = String(body.decision || '').toLowerCase();
    if (!['approve', 'reject'].includes(decision)) throw apiError(400, 'invalid_request', 'decision must be approve or reject');
    if (approval.requester === verified.subject) {
      throw apiError(403, 'self_approval_forbidden', 'the requester cannot decide their own approval');
    }
    const roles = actorRoles(verified);
    if (approval.approverRoles.length && !isAdmin(verified)
      && !approval.approverRoles.some((role) => roles.has(role.toLowerCase()))) {
      throw apiError(403, 'approver_role_required', 'this approval requires one of the configured approver roles', {
        approverRoles: approval.approverRoles,
      });
    }
    if (approval.decisions.some((item) => item.actor === verified.subject)) {
      throw apiError(409, 'duplicate_decision', 'this principal already decided this approval');
    }
    const note = body.note === undefined ? '' : String(body.note).trim();
    if (note.length > 2000) throw apiError(400, 'invalid_request', 'note is too long');
    const now = new Date().toISOString();
    const decisions = [...approval.decisions, {
      actor: verified.subject,
      decision: decision as 'approve' | 'reject',
      ...(note ? { note } : {}),
      at: now,
    }];
    const approvals = decisions.filter((item) => item.decision === 'approve').length;
    const next: ApprovalRecord = {
      ...approval,
      decisions,
      status: decision === 'reject' ? 'rejected' : approvals >= approval.requiredApprovals ? 'approved' : 'pending',
      updatedAt: now,
    };
    const saved = await saveApproval(client, next, version);
    await recordAudit(client, config, {
      actor: verified.subject,
      tenant: verified.tenantKey,
      action: 'approval.decide',
      correlationId: correlationIdOf(req),
      details: { approvalId: approval.id, decision, status: saved.status },
    });
    res.json({ approval: saved });
  }));

  app.post('/v1/capabilities/approvals/:id/cancel', handler(async (req, res) => {
    const { caller, client } = await readContext(req, config);
    const verified = requireAuthenticated(caller);
    const { approval, version } = await loadApproval(client, String(req.params.id));
    if (!canSee(verified, approval)) throw apiError(404, 'approval_not_found', 'approval not found');
    if (approval.requester !== verified.subject && !isAdmin(verified)) {
      throw apiError(403, 'cancel_forbidden', 'only the requester or an administrator can cancel');
    }
    if (approval.status !== 'pending') throw apiError(409, 'approval_not_pending', 'this approval is no longer pending');
    const saved = await saveApproval(client, { ...approval, status: 'cancelled', updatedAt: new Date().toISOString() }, version);
    await recordAudit(client, config, {
      actor: verified.subject,
      tenant: verified.tenantKey,
      action: 'approval.cancel',
      correlationId: correlationIdOf(req),
      details: { approvalId: approval.id },
    });
    res.json({ approval: saved });
  }));
}
