// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Management-plane projection for the capability console.
 *
 * The console is intentionally thin: every role decision and every mutation is
 * enforced here. Roles are derived from the verified Tier-1 principal, never
 * from a client-supplied field. Moderation is an optional review lane; it does
 * not replace the existing publish/revoke state machine.
 */
import { Express, Request } from 'express';
import {
  CallerPrincipal, credentialClient, hasReadScope, hasWriteScope, isAdmin, isModerator,
  requireAuthenticated,
} from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { validateDatasetId } from '../ids';
import { parsePagination, setPageHeaders, stringParam } from '../pagination';
import {
  AuditRecord, COLLECTIONS, DatasetRecord, correlationIdOf, queryDocuments, recordAudit,
} from '../platform';
import { saveDataset } from '../publication';
import { loadManagementSettings, saveManagementSettings } from '../settings';
import {
  accessibleDataset, expectedVersion, readContext, requireVersionMatch, writeContext,
} from './shared';

export type ManagementRole = 'admin' | 'operator' | 'moderator' | 'manager' | 'viewer';

const READ_PERMISSIONS = ['summary:read', 'datasets:read', 'records:read'] as const;
const OPERATOR_PERMISSIONS = [
  ...READ_PERMISSIONS, 'datasets:write', 'datasets:delete', 'records:write',
  'events:read', 'events:flush', 'audit:read',
] as const;
const MODERATOR_PERMISSIONS = [
  ...READ_PERMISSIONS, 'moderation:read', 'moderation:write',
  'events:read', 'audit:read', 'usage:read',
] as const;
const MANAGER_PERMISSIONS = [
  ...READ_PERMISSIONS, 'events:read', 'audit:read', 'usage:read', 'settings:read',
] as const;
const ADMIN_PERMISSIONS = [
  ...new Set([
    ...OPERATOR_PERMISSIONS, ...MODERATOR_PERMISSIONS, ...MANAGER_PERMISSIONS,
    'users:read', 'settings:write', 'audit:export',
  ]),
] as const;

/** Roles are additive: a moderator may also be a manager, an admin is all. */
export function managementRoles(principal?: CallerPrincipal): ManagementRole[] {
  if (!principal) return [];
  if (isAdmin(principal)) return ['admin'];
  const roles = new Set<ManagementRole>();
  if (hasWriteScope(principal)) roles.add('operator');
  if (isModerator(principal)) roles.add('moderator');
  if (hasReadScope(principal)) roles.add('manager');
  if (!roles.size) roles.add('viewer');
  return [...roles];
}

export function managementPermissions(principal?: CallerPrincipal): string[] {
  if (!principal) return [];
  const roles = managementRoles(principal);
  if (roles.includes('admin')) return [...ADMIN_PERMISSIONS];
  const permissions = new Set<string>(READ_PERMISSIONS);
  if (roles.includes('operator')) for (const value of OPERATOR_PERMISSIONS) permissions.add(value);
  if (roles.includes('moderator')) for (const value of MODERATOR_PERMISSIONS) permissions.add(value);
  if (roles.includes('manager')) for (const value of MANAGER_PERMISSIONS) permissions.add(value);
  if (!roles.length) permissions.clear();
  return [...permissions];
}

function requireModerator(principal: CallerPrincipal): void {
  if (!isModerator(principal)) {
    throw apiError(403, 'moderation_forbidden', 'this action requires the synapsedx:moderator role');
  }
}

function requireReviewReader(principal: CallerPrincipal): void {
  if (!isModerator(principal) && !hasWriteScope(principal) && !hasReadScope(principal)) {
    throw apiError(403, 'insufficient_scope', 'the review queue requires a verified management role');
  }
}

function tenantFilter(principal: CallerPrincipal): Record<string, unknown> | undefined {
  if (isAdmin(principal)) return undefined;
  return { or: [{ tenant: principal.tenantKey }, { tenant: { exists: false } }] };
}

function reviewBody(req: Request): { note?: string } {
  const body = (req.body || {}) as Record<string, unknown>;
  const raw = body.note ?? body.reviewNote;
  if (raw === undefined || raw === null) return {};
  const note = String(raw).trim();
  if (note.length > 2000) throw apiError(400, 'invalid_request', 'review note is too long');
  return { note };
}

function requireReviewerNote(note: string | undefined, action: 'reject'): string {
  if (!note || note.length < 3) {
    throw apiError(400, 'review_note_required', `a review note is required to ${action} a dataset`);
  }
  return note;
}

async function loadForReview(req: Request, config: ServiceConfig, mode: 'read' | 'write') {
  const context = mode === 'write' ? await writeContext(req, config) : await readContext(req, config);
  const { caller, client } = context;
  const principal = requireAuthenticated(caller);
  const id = validateDatasetId(req.params.id);
  const found = await accessibleDataset(client, id, caller, 'metadata');
  return { ...context, principal, dataset: found.data, version: found.document.version, id };
}

async function saveReview(
  req: Request,
  config: ServiceConfig,
  changes: Partial<Pick<DatasetRecord, 'reviewStatus' | 'reviewSubmittedAt' | 'reviewedBy' | 'reviewedAt' | 'reviewNote'>>,
): Promise<DatasetRecord> {
  const context = await loadForReview(req, config, 'read');
  const body = (req.body || {}) as Record<string, unknown>;
  const requestedVersion = expectedVersion(req, body);
  requireVersionMatch(requestedVersion, context.version, 'dataset');
  const now = new Date().toISOString();
  const updated: DatasetRecord = {
    ...context.dataset,
    ...changes,
    updatedAt: now,
  };
  const saved = await saveDataset(context.client, updated, context.version);
  return saved.data;
}

export function registerManagementRoutes(app: Express, config: ServiceConfig): void {
  app.get('/v1/capabilities/management/context', handler(async (req, res) => {
    const { caller, principal } = await readContext(req, config);
    const verified = requireAuthenticated(caller);
    const roles = managementRoles(verified);
    const permissions = managementPermissions(verified);
    let profile: any = {};
    if (caller.credential?.kind === 'bearer') {
      try {
        profile = await credentialClient(config, caller.credential).iam.me();
      } catch {
        // Identity enrichment is best-effort; authorization still comes from
        // the credential that was already verified by authenticate().
      }
    }
    res.setHeader('cache-control', 'no-store');
    res.json({
      user: {
        id: verified.subject,
        kind: verified.kind || verified.type,
        ...(profile?.user?.email || profile?.email ? { email: String(profile?.user?.email || profile?.email) } : {}),
        ...(profile?.user?.displayName || profile?.displayName
          ? { displayName: String(profile?.user?.displayName || profile?.displayName) }
          : {}),
      },
      tenant: verified.tenantKey,
      ...(verified.org ? { org: verified.org } : {}),
      ...(verified.account ? { account: verified.account } : {}),
      roles,
      permissions,
      auth: { kind: verified.type, scopes: verified.scopes },
    });
  }));

  app.get('/v1/capabilities/management/summary', handler(async (req, res) => {
    const { caller, client } = await readContext(req, config);
    const verified = requireAuthenticated(caller);
    const base = tenantFilter(verified);
    const statuses = ['draft', 'published', 'revoked'] as const;
    const counts: Record<string, number> = {};
    for (const status of statuses) {
      const where = base ? { and: [base, { status }] } : { status };
      const result = await queryDocuments<DatasetRecord>(client, COLLECTIONS.datasets, { where, limit: 1 });
      counts[status] = result.total;
    }
    const pendingWhere = base
      ? { and: [base, { reviewStatus: 'pending' }] }
      : { reviewStatus: 'pending' };
    const pending = await queryDocuments<DatasetRecord>(client, COLLECTIONS.datasets, {
      where: pendingWhere, limit: 1,
    });
    const datasetSample = await queryDocuments<DatasetRecord>(client, COLLECTIONS.datasets, {
      ...(base ? { where: base } : {}),
      limit: 500,
    });
    const pendingEvents = datasetSample.items.reduce((sum, item) => sum + (item.data.pendingEvents?.length || 0), 0);
    const roles = managementRoles(verified);
    const permissions = managementPermissions(verified);
    const canReadAudit = permissions.includes('audit:read');
    const audit = canReadAudit
      ? await queryDocuments<AuditRecord>(client, COLLECTIONS.audit, {
        ...(base ? { where: base } : {}),
        orderBy: { field: 'at', direction: 'desc' },
        limit: 8,
      })
      : { items: [] as Array<{ data: AuditRecord }> };
    res.setHeader('cache-control', 'no-store');
    res.json({
      generatedAt: new Date().toISOString(),
      datasets: {
        total: counts.draft + counts.published + counts.revoked,
        draft: counts.draft,
        published: counts.published,
        revoked: counts.revoked,
        pendingReview: pending.total,
      },
      pendingEvents,
      recentAudit: audit.items.map((item) => item.data),
      roles,
      permissions,
    });
  }));

  app.get('/v1/capabilities/management/settings', handler(async (req, res) => {
    const { caller, client } = await readContext(req, config);
    const verified = requireAuthenticated(caller);
    if (!managementPermissions(verified).includes('settings:read')) {
      throw apiError(403, 'insufficient_scope', 'settings require a manager or administrator role');
    }
    const settings = await loadManagementSettings(client, verified.tenantKey);
    res.setHeader('cache-control', 'no-store');
    res.json({ settings });
  }));

  app.patch('/v1/capabilities/management/settings', handler(async (req, res) => {
    const { caller, client } = await writeContext(req, config);
    const verified = requireAuthenticated(caller);
    if (!isAdmin(verified)) {
      throw apiError(403, 'insufficient_scope', 'only an administrator can change management settings');
    }
    const body = (req.body || {}) as Record<string, unknown>;
    if (typeof body.requireReview !== 'boolean') {
      throw apiError(400, 'invalid_request', 'requireReview must be a boolean');
    }
    const settings = await saveManagementSettings(client, verified.tenantKey, {
      requireReview: body.requireReview,
      updatedBy: verified.subject,
    });
    await recordAudit(client, config, {
      actor: verified.subject,
      tenant: verified.tenantKey,
      action: 'settings.update',
      correlationId: correlationIdOf(req),
      details: { requireReview: settings.requireReview },
    });
    res.json({ settings });
  }));

  app.get('/v1/capabilities/management/review-queue', handler(async (req, res) => {
    const { caller, client } = await readContext(req, config);
    const verified = requireAuthenticated(caller);
    requireReviewReader(verified);
    const pagination = parsePagination(req, config.maxPageSize);
    const status = stringParam(req.query.status, 32) || 'pending';
    if (!['pending', 'approved', 'rejected', 'all'].includes(status)) {
      throw apiError(400, 'invalid_request', 'status must be pending, approved, rejected or all');
    }
    const base = tenantFilter(verified);
    const where = status === 'all'
      ? base
      : base
        ? { and: [base, { reviewStatus: status }] }
        : { reviewStatus: status };
    const result = await queryDocuments<DatasetRecord>(client, COLLECTIONS.datasets, {
      ...(where ? { where } : {}),
      orderBy: { field: 'updatedAt', direction: 'desc' },
      limit: pagination.limit,
      offset: pagination.offset,
    });
    setPageHeaders(res, {
      total: result.total, limit: pagination.limit, offset: pagination.offset, nextCursor: result.nextCursor,
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

  app.post('/v1/capabilities/management/datasets/:id/submit-review', handler(async (req, res) => {
    const { caller, principal, client } = await writeContext(req, config);
    const verified = requireAuthenticated(caller);
    const id = validateDatasetId(req.params.id);
    const found = await accessibleDataset(client, id, caller, 'write');
    if (!found.data.public) {
      throw apiError(409, 'dataset_not_public', 'only public datasets enter the publication review lane');
    }
    if (found.data.status === 'published') {
      throw apiError(409, 'already_published', 'a published dataset is already visible; revoke it before re-review');
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const version = expectedVersion(req, body);
    requireVersionMatch(version, found.document.version, 'dataset');
    const now = new Date().toISOString();
    const note = reviewBody(req).note;
    const updated: DatasetRecord = {
      ...found.data,
      reviewStatus: 'pending',
      reviewSubmittedAt: now,
      reviewedBy: undefined,
      reviewedAt: undefined,
      reviewNote: note,
      updatedAt: now,
    };
    const saved = await saveDataset(client, updated, found.document.version);
    await recordAudit(client, config, {
      actor: verified.subject,
      tenant: verified.tenantKey,
      action: 'dataset.review.submit',
      datasetId: id,
      correlationId: correlationIdOf(req),
      ...(note ? { details: { note } } : {}),
    });
    res.json(saved.data);
  }));

  app.post('/v1/capabilities/management/datasets/:id/approve', handler(async (req, res) => {
    const context = await loadForReview(req, config, 'read');
    const verified = requireAuthenticated(context.caller);
    requireModerator(verified);
    if (context.dataset.reviewStatus !== 'pending') {
      throw apiError(409, 'review_not_pending', 'this dataset is not awaiting review');
    }
    const note = reviewBody(req).note;
    const reviewedAt = new Date().toISOString();
    const saved = await saveReview(req, config, {
      reviewStatus: 'approved',
      reviewedBy: verified.subject,
      reviewedAt,
      reviewNote: note,
    });
    await recordAudit(context.client, config, {
      actor: verified.subject,
      tenant: verified.tenantKey,
      action: 'dataset.review.approve',
      datasetId: context.id,
      correlationId: correlationIdOf(req),
      ...(note ? { details: { note } } : {}),
    });
    res.json(saved);
  }));

  app.post('/v1/capabilities/management/datasets/:id/reject', handler(async (req, res) => {
    const context = await loadForReview(req, config, 'read');
    const verified = requireAuthenticated(context.caller);
    requireModerator(verified);
    if (context.dataset.reviewStatus !== 'pending') {
      throw apiError(409, 'review_not_pending', 'this dataset is not awaiting review');
    }
    const note = requireReviewerNote(reviewBody(req).note, 'reject');
    const reviewedAt = new Date().toISOString();
    const saved = await saveReview(req, config, {
      reviewStatus: 'rejected',
      reviewedBy: verified.subject,
      reviewedAt,
      reviewNote: note,
    });
    await recordAudit(context.client, config, {
      actor: verified.subject,
      tenant: verified.tenantKey,
      action: 'dataset.review.reject',
      datasetId: context.id,
      correlationId: correlationIdOf(req),
      details: { note },
    });
    res.json(saved);
  }));
}
