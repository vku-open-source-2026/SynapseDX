// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Shared route guards: authentication, tenancy and version preconditions. */
import { Request } from 'express';
import { SynapseOneClient } from '@synapseone/sdk';
import {
  Caller, CallerPrincipal, assertWriteScope, authenticate, canAccessDataset, canReadPrivateDatasetData, hasWriteScope,
  isAdmin, isTenantAdmin, isMachineCredential, hasReadScope, requireAuthenticated,
} from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { DatasetRecord, serviceClient } from '../platform';
import { DatasetDocument, loadDataset } from '../publication';
import { workspaceAccess } from '../workspace-access';

const COMMON_ROUTES = /^\/v1\/capabilities\/(?:comments|inbox|notification-preferences|workspaces|pages|page-search|people|org-units|kpis|kpi-checkins|timesheets|forms|processes|process-instances|projects|project-tasks|milestones|raid|project-dependencies|project-capacity|reports|dashboards|report-runs|report-schedules|contracts|quality|lineage|ocr|agents|agent-runs|rag|assistant|approvals|files)(?:\/|$)/;

async function scopeCommonContext(req: Request, caller: Caller, client: SynapseOneClient): Promise<void> {
  if (!caller.principal) return;
  if (!isMachineCredential(caller.principal) && !isTenantAdmin(caller.principal)) {
    const grants = await workspaceAccess(client, caller.principal.org || caller.principal.tenantKey, { ...caller.principal, subject: caller.principal.userId || caller.principal.subject });
    caller.principal = { ...caller.principal, workspaceProducts: Object.keys(grants).filter(app => grants[app as 'city' | 'sos']?.length) };
  }
  if (!COMMON_ROUTES.test(req.path)) return;
  const principal = caller.principal;
  const app = req.header('x-workspace-app');
  if (!app) {
    if (!isTenantAdmin(principal) && !isMachineCredential(principal) && !hasReadScope(principal) && !hasWriteScope(principal)) throw apiError(403, 'app_context_required', 'common capabilities require an application context');
    return;
  }
  if (app !== 'city' && app !== 'sos') throw apiError(400, 'invalid_request', 'unknown workspace app');
  const grants = await workspaceAccess(client, principal.org || principal.tenantKey, { ...principal, subject: principal.userId || principal.subject });
  if (!grants[app]?.length && !isMachineCredential(principal)) throw apiError(403, 'forbidden', 'this account is not a member of this app');
  const roles = grants[app] || [];
  const manager = principal.isDxAdmin === true || roles.some(role => role === 'admin' || role === 'manager');
  if (!['GET', 'HEAD'].includes(req.method) && /\/(?:people|org-units|kpis|agents|contracts|quality|processes)(?:\/|$)/.test(req.path) && !manager) throw apiError(403, 'forbidden', 'this action requires an app manager');
  const scopes = [...principal.scopes];
  if (roles.some(role => role !== 'viewer') && !scopes.includes('write')) scopes.push('write');
  if (manager && !scopes.includes('synapsedx:manager')) scopes.push('synapsedx:manager');
  caller.principal = { ...principal, scopes, sourceScopes: principal.scopes, workspaceApp: app, sourceTenantKey: principal.org || principal.tenantKey, tenantKey: `${principal.org || principal.tenantKey}:common:${app}` };
}

export interface ReadContext {
  caller: Caller;
  client: SynapseOneClient;
  principal?: CallerPrincipal;
}

export interface AuthenticatedReadContext extends ReadContext {
  principal: CallerPrincipal;
}

export interface WriteContext extends ReadContext {
  caller: Caller;
  principal: CallerPrincipal;
  client: SynapseOneClient;
}

/** Any caller (anonymous allowed). Private reads are filtered per route. */
export async function readContext(req: Request, config: ServiceConfig): Promise<ReadContext> {
  const caller = await authenticate(req, config, false);
  const client = serviceClient(config);
  await scopeCommonContext(req, caller, client);
  return {
    caller,
    client,
    ...(caller.principal ? { principal: caller.principal } : {}),
  };
}

/** Verified caller for read endpoints that must not be anonymous. */
export async function authenticatedReadContext(req: Request, config: ServiceConfig): Promise<AuthenticatedReadContext> {
  const context = await readContext(req, config);
  if (!context.caller.authenticated || !context.principal) {
    throw apiError(401, 'unauthorized', 'a verified credential is required');
  }
  return context as AuthenticatedReadContext;
}

/** Verified caller with a write-capable credential. */
export async function writeContext(req: Request, config: ServiceConfig): Promise<WriteContext> {
  const caller = await authenticate(req, config, true);
  const client = serviceClient(config);
  await scopeCommonContext(req, caller, client);
  const principal = requireAuthenticated(caller);
  assertWriteScope(principal);
  return { caller, principal, client };
}

export function canReadRecords(dataset: DatasetRecord, caller: Caller): boolean {
  if (!caller.authenticated || !caller.principal) return false;
  if (isAdmin(caller.principal)) return true;
  if (!canAccessDataset(dataset, caller)) return false;
  // Published public projections stay open to any authenticated caller.
  if (dataset.public === true && dataset.status === 'published') return true;
  if (dataset.tenant && dataset.tenant !== (caller.principal.sourceTenantKey || caller.principal.tenantKey)) return false;
  if (!dataset.tenant) {
    // Legacy tenancy-less document: exact verified owner only.
    return !!dataset.owner && dataset.owner === caller.principal.subject;
  }
  return canReadPrivateDatasetData(dataset, caller.principal);
}

/**
 * Write authorization is **distinct** from read visibility. In particular a
 * public published dataset is readable by everyone but writable only inside its
 * own tenant (or by a deployment admin); otherwise an organization-B operator
 * could mutate organization-A's public data.
 */
export function canWriteDataset(dataset: DatasetRecord, caller: Caller): boolean {
  const principal = caller.principal;
  if (!caller.authenticated || !principal) return false;
  if (isAdmin(principal)) return true;
  if (/^(city|sos)-/.test(dataset.id) && !isTenantAdmin(principal) && !isMachineCredential(principal)) return false;
  if (!dataset.tenant) {
    // Legacy tenancy-less document: the exact verified owner may keep writing,
    // never "any role". Cross-tenant access requires an explicit migration.
    return !!dataset.owner && dataset.owner === principal.subject && hasWriteScope(principal);
  }
  if (dataset.tenant !== principal.tenantKey) return false;
  return hasWriteScope(principal);
}

/**
 * Whether the caller may see *unpublished* rows of this dataset (drafts).
 * Anonymous and plain-member readers of a public projection must only ever see
 * published rows.
 */
export function canReadRecordDrafts(dataset: DatasetRecord, caller: Caller): boolean {
  const principal = caller.principal;
  if (!caller.authenticated || !principal) return false;
  if (isAdmin(principal) || isTenantAdmin(principal)) return true;
  if (!dataset.tenant) return !!dataset.owner && dataset.owner === principal.subject;
  if (dataset.tenant !== principal.tenantKey) return false;
  return canReadPrivateDatasetData(dataset, principal);
}

/** Explicit route-level dataset visibility decision (never leaks existence). */
export function assertCanReadDataset(dataset: DatasetRecord, caller: Caller): void {
  if (!canAccessDataset(dataset, caller)) throw apiError(404, 'dataset_not_found', 'dataset not found');
  if (!caller.authenticated && !(dataset.public && dataset.status === 'published')) {
    throw apiError(404, 'dataset_not_found', 'dataset not found');
  }
}

export function assertCanReadRecords(dataset: DatasetRecord, caller: Caller): void {
  if (!canReadRecords(dataset, caller)) throw apiError(404, 'dataset_not_found', 'dataset not found');
}

export function assertCanWriteDataset(dataset: DatasetRecord, caller: Caller): void {
  if (!canWriteDataset(dataset, caller)) throw apiError(404, 'dataset_not_found', 'dataset not found');
}

/**
 * Resolve a dataset and enforce access. `mode` selects the record/metadata
 * boundary: private records always require tenancy even for public datasets.
 */
export async function accessibleDataset(
  client: SynapseOneClient,
  id: string,
  caller: Caller,
  mode: 'metadata' | 'records' | 'write',
): Promise<DatasetDocument> {
  const found = await loadDataset(client, id);
  if (!found) throw apiError(404, 'dataset_not_found', 'dataset not found');
  const product = id.startsWith('city-') ? 'city' : id.startsWith('sos-') ? 'sos' : null;
  const principal = caller.principal;
  if (product && principal && !isMachineCredential(principal) && !isTenantAdmin(principal)) {
    // Anonymous/public projection endpoints remain public. Authenticated product
    // source data requires an app grant; user API keys inherit that same gate.
    const subject = principal.userId || principal.subject;
    const grants = await workspaceAccess(client, principal.org || principal.tenantKey, { ...principal, subject });
    if (!grants[product]?.length) throw apiError(404, 'dataset_not_found', 'dataset not found');
    if (mode === 'write') throw apiError(403, 'workspace_action_required', 'product mutations require an authorized workspace action');
  }
  if (mode === 'write') assertCanWriteDataset(found.data, caller);
  else if (mode === 'records') assertCanReadRecords(found.data, caller);
  else assertCanReadDataset(found.data, caller);
  return found;
}

/** Parse `If-Match: "<n>"` (or a bare integer) into a document version. */
export function parseIfMatch(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (raw === '*' || raw === '') return undefined;
  const match = raw.match(/^(?:W\/)?"?(\d{1,12})"?$/);
  if (!match) throw apiError(400, 'invalid_request', 'If-Match must be a document version');
  return Number(match[1]);
}

/** Client-visible precondition from If-Match or a JSON body field. */
export function expectedVersion(req: Request, body?: Record<string, unknown>): number | undefined {
  const fromHeader = parseIfMatch(req.header('if-match'));
  const raw = body?.ifVersion ?? body?.version;
  let fromBody: number | undefined;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) throw apiError(400, 'invalid_request', 'ifVersion must be a non-negative integer');
    fromBody = parsed;
  }
  if (fromHeader !== undefined && fromBody !== undefined && fromHeader !== fromBody) {
    throw apiError(400, 'invalid_request', 'If-Match and ifVersion disagree');
  }
  return fromHeader ?? fromBody;
}

export function setVersionHeaders(res: import('express').Response, version: number | undefined): void {
  if (version === undefined) return;
  res.setHeader('etag', `"${version}"`);
  res.setHeader('x-dataset-version', String(version));
}

export function requireVersionMatch(requested: number | undefined, current: number, resource: string): void {
  if (requested === undefined) return;
  if (requested !== current) {
    throw apiError(409, 'version_conflict', `${resource} was modified by another request`, { currentVersion: current });
  }
}
