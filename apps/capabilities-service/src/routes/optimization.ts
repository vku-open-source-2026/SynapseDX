// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Generic resource-to-demand assignment endpoint.
 *
 * This is a pure computation: it requires a verified caller (the result can
 * reveal operational resource capacity) but deliberately does not require a
 * write scope, because it persists no capability data. The only side effect is
 * an audit projection with counts; the request payload is never copied into
 * audit.
 *
 * SOS dispatch maps its own resources/demands onto this contract and remains
 * responsible for applying any assignment through its reviewed workflow. The
 * endpoint does not mutate dispatch state.
 */
import { Express } from 'express';
import { authenticate, requireAuthenticated } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { optimizeAssignments, OPTIMIZATION_LIMITS } from '../optimization';
import { correlationIdOf, recordAudit, serviceClient } from '../platform';

export const OPTIMIZATION_BODY_LIMIT_BYTES = 256 * 1024;

export function registerOptimizationRoutes(app: Express, config: ServiceConfig): void {
  app.post('/v1/capabilities/optimization/assign', handler(async (req, res) => {
    const caller = await authenticate(req, config, true);
    const principal = requireAuthenticated(caller);

    const declaredLength = Number(req.header('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > OPTIMIZATION_BODY_LIMIT_BYTES) {
      throw apiError(413, 'payload_too_large', 'optimization request bodies are limited to 256 KB');
    }
    const body = req.body === undefined ? {} : req.body;
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > OPTIMIZATION_BODY_LIMIT_BYTES) {
      throw apiError(413, 'payload_too_large', 'optimization request bodies are limited to 256 KB');
    }

    const result = optimizeAssignments(body);
    const client = serviceClient(config);
    await recordAudit(client, config, {
      actor: principal.subject,
      tenant: principal.tenantKey,
      action: 'optimization.assign',
      correlationId: correlationIdOf(req),
      details: {
        resourceCount: Array.isArray(body?.resources) ? body.resources.length : 0,
        demandCount: result.demandCount,
        assignedCount: result.assignedCount,
        unassignedCount: result.unassigned.length,
        resourceSlots: result.resourceSlots,
      },
    });

    res.setHeader('cache-control', 'no-store');
    res.status(200).json({
      ...result,
      at: new Date().toISOString(),
      limits: {
        maxResources: OPTIMIZATION_LIMITS.maxResources,
        maxDemands: OPTIMIZATION_LIMITS.maxDemands,
        maxSlots: OPTIMIZATION_LIMITS.maxSlots,
        maxCost: OPTIMIZATION_LIMITS.maxCost,
      },
    });
  }));
}
