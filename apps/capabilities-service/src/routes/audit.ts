// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Audit and usage projection.
 *
 * Tier-2 records mutation audit entries in a Tier-1 Base collection; API usage
 * and IAM audit are projected from Tier-1 IAM (the credential-scoped source of
 * truth). Tier-3 never calls Tier-1 directly.
 */
import { Express } from 'express';
import { isAdmin } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { parsePagination, setPageHeaders, stringParam } from '../pagination';
import { AuditRecord, COLLECTIONS, queryDocuments } from '../platform';
import { readContext } from './shared';

function usageFilter(req: import('express').Request): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  for (const key of ['from', 'to', 'feature', 'accountId', 'actor', 'method', 'q'] as const) {
    const value = stringParam(req.query[key], 200);
    if (value !== undefined) filter[key] = value;
  }
  const status = stringParam(req.query.status, 8);
  if (status !== undefined) {
    const parsed = Number(status);
    if (!Number.isInteger(parsed)) throw apiError(400, 'invalid_request', 'status must be an integer');
    filter.status = parsed;
  }
  return filter;
}

export function registerAuditRoutes(app: Express, config: ServiceConfig): void {
  app.get('/v1/capabilities/audit', handler(async (req, res) => {
    const { caller, principal, client } = await readContext(req, config);
    if (!caller.authenticated || !principal) throw apiError(401, 'unauthorized', 'audit queries require a verified credential');
    const pagination = parsePagination(req, config.maxPageSize);
    const action = stringParam(req.query.action, 64);
    const datasetId = stringParam(req.query.datasetId, 80);
    const recordId = stringParam(req.query.recordId, 256);
    const actor = stringParam(req.query.actor, 256);
    const conditions: Record<string, unknown>[] = [];
    if (!isAdmin(principal)) conditions.push({ tenant: principal.tenantKey });
    if (action) conditions.push({ action });
    if (datasetId) conditions.push({ datasetId });
    if (recordId) conditions.push({ recordId });
    if (actor) conditions.push({ actor });
    const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : { and: conditions };
    const result = await queryDocuments<AuditRecord>(client, COLLECTIONS.audit, {
      ...(where ? { where } : {}),
      orderBy: { field: 'at', direction: 'desc' },
      limit: pagination.limit,
      offset: pagination.offset,
    });
    setPageHeaders(res, { total: result.total, limit: pagination.limit, offset: pagination.offset, nextCursor: result.nextCursor });
    res.json({
      items: result.items.map((item) => item.data),
      total: result.total,
      limit: pagination.limit,
      offset: pagination.offset,
      nextCursor: result.nextCursor,
    });
  }));

  app.get('/v1/capabilities/usage', handler(async (req, res) => {
    const { caller, client } = await readContext(req, config);
    if (!caller.authenticated) throw apiError(401, 'unauthorized', 'usage queries require a verified credential');
    const summary = await client.iam.usageSummary(usageFilter(req) as any);
    res.setHeader('cache-control', 'no-store');
    res.json(summary);
  }));

  app.get('/v1/capabilities/usage/events', handler(async (req, res) => {
    const { caller, client } = await readContext(req, config);
    if (!caller.authenticated) throw apiError(401, 'unauthorized', 'usage queries require a verified credential');
    const pagination = parsePagination(req, config.maxPageSize);
    const events = await client.iam.usageEvents({
      ...usageFilter(req),
      limit: pagination.limit,
      offset: pagination.offset,
    } as any);
    res.setHeader('cache-control', 'no-store');
    res.json(events);
  }));
}
