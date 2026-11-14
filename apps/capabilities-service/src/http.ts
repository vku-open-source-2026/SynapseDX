// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** HTTP boundary helpers: CORS, correlation ids, security headers and JSON 404/405. */
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ServiceConfig } from './config';
import { apiError, envelope, logError, resolveError } from './errors';

export const ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
export const ALLOWED_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'idempotency-key',
  'if-match',
  'if-none-match',
  'x-api-key',
  'x-correlation-id',
  'x-request-id',
  'x-idempotency-key',
  'x-synapseone-tenant',
  'x-synapsedx-product',
  'x-checksum-sha256',
].join(',');
export const EXPOSED_HEADERS = [
  'etag',
  'link',
  'retry-after',
  'x-correlation-id',
  'x-request-id',
  'x-total-count',
  'x-limit',
  'x-offset',
  'x-next-cursor',
  'x-event-status',
  'x-lds-license',
  'x-lds-datasource',
  'x-lds-total',
  'x-lds-context',
  'x-checksum-sha256',
  'content-disposition',
  'cache-control',
].join(',');

function appendVary(res: Response, value: string): void {
  const current = String(res.getHeader('vary') || '');
  const parts = current.split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === value.toLowerCase())) parts.push(value);
  res.setHeader('vary', parts.join(', '));
}

/** Shared CORS implementation for the capabilities service and the gateway. */
export function applyCors(req: Request, res: Response, origins: string[]): void {
  const origin = req.header('origin');
  appendVary(res, 'Origin');
  if (origin && origins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
  }
  res.setHeader('access-control-allow-methods', ALLOWED_METHODS);
  res.setHeader('access-control-allow-headers', ALLOWED_HEADERS);
  res.setHeader('access-control-expose-headers', EXPOSED_HEADERS);
  res.setHeader('access-control-max-age', '600');
}

export function corsMiddleware(config: ServiceConfig): RequestHandler {
  return (req, res, next) => {
    applyCors(req, res, config.corsOrigins);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

export function securityMiddleware(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    next();
  };
}

export function correlationMiddleware(): RequestHandler {
  return (req, res, next) => {
    const incoming = (req.header('x-correlation-id') || req.header('x-request-id') || '').trim();
    const correlationId = incoming && /^[\x20-\x7E]{1,200}$/.test(incoming) ? incoming : randomUUID();
    req.synapseDxRequestId = correlationId;
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('x-request-id', correlationId);
    next();
  };
}

/** Wrap an async handler so rejected promises reach the error middleware. */
export function handler(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function errorMiddleware() {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const requestId = req.synapseDxRequestId || randomUUID();
    if (!res.headersSent) {
      logError(error, requestId, req.method, req.path);
      const resolved = resolveError(error, requestId);
      if (resolved.status === 401) res.setHeader('www-authenticate', 'Bearer realm="synapsedx"');
      res.status(resolved.status).json(resolved.body);
      return;
    }
    console.error(`[synapsedx] ${requestId} response already sent for ${req.method} ${req.path}`);
  };
}

export interface KnownRoute {
  pattern: RegExp;
  methods: string[];
}

/** Route table used only to answer 405 with an Allow header (see #19). */
export const KNOWN_ROUTES: KnownRoute[] = [
  { pattern: /^\/health$/, methods: ['GET'] },
  { pattern: /^\/ready$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/health$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/ready$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/datasets$/, methods: ['GET', 'POST'] },
  { pattern: /^\/v1\/capabilities\/datasets\/[^/]+$/, methods: ['GET', 'PATCH', 'DELETE'] },
  { pattern: /^\/v1\/capabilities\/datasets\/[^/]+\/publish$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/datasets\/[^/]+\/revoke$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/datasets\/[^/]+\/entities$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/datasets\/[^/]+\/records$/, methods: ['GET', 'POST'] },
  { pattern: /^\/v1\/capabilities\/datasets\/[^/]+\/records\/query$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/datasets\/[^/]+\/records\/bulk$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/datasets\/[^/]+\/records\/purge-expired$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/datasets\/[^/]+\/records\/[^/]+$/, methods: ['GET', 'PATCH', 'DELETE'] },
  { pattern: /^\/v1\/capabilities\/events$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/events\/outbox\/flush$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/auth\/(login|refresh|logout|logout-all|register|password-reset|password\/change|password\/forgot|password\/reset|email\/verify|email\/verify\/request|exchange)$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/auth\/me$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/auth\/sessions$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/auth\/sessions\/[^/]+$/, methods: ['DELETE'] },
  { pattern: /^\/v1\/capabilities\/auth\/oidc\/(config|start)$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/auth\/oidc\/callback$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/ai\/(chat|embeddings|decision|route)$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/ai\/status$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/files$/, methods: ['POST', 'GET'] },
  { pattern: /^\/v1\/capabilities\/files\/quota$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/files\/[^/]+$/, methods: ['GET', 'DELETE'] },
  { pattern: /^\/v1\/capabilities\/files\/[^/]+\/content$/, methods: ['GET', 'PUT'] },
  { pattern: /^\/v1\/capabilities\/files\/[^/]+\/complete$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/files\/[^/]+\/presign$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/notifications$/, methods: ['POST', 'GET'] },
  { pattern: /^\/v1\/capabilities\/notifications\/(send|unsubscribe)$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/notifications\/templates$/, methods: ['GET', 'POST'] },
  { pattern: /^\/v1\/capabilities\/notifications\/templates\/[^/]+$/, methods: ['GET', 'PATCH', 'DELETE'] },
  { pattern: /^\/v1\/capabilities\/notifications\/preferences\/[^/]+$/, methods: ['GET', 'PUT'] },
  { pattern: /^\/v1\/capabilities\/notifications\/[^/]+$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/notifications\/[^/]+\/cancel$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/geo\/(autocomplete|geocode|reverse|place)$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/jobs$/, methods: ['GET', 'POST'] },
  { pattern: /^\/v1\/capabilities\/jobs\/kinds$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/jobs\/lease$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/jobs\/[^/]+$/, methods: ['GET', 'PATCH', 'DELETE'] },
  { pattern: /^\/v1\/capabilities\/jobs\/[^/]+\/run$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/jobs\/[^/]+\/runs$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/jobs\/[^/]+\/runs\/[^/]+\/(heartbeat|complete)$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/audit$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/usage$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/usage\/events$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/catalog$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/plugins$/, methods: ['GET', 'POST'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/plugins\/[^/]+$/, methods: ['GET', 'PUT'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/plugins\/[^/]+\/(publish|unpublish|provision)$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/plugins\/[^/]+\/revisions$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/plugins\/[^/]+\/export$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/plugins\/[^/]+\/install$/, methods: ['POST', 'DELETE'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/installed$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/installed\/[^/]+$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/installed\/[^/]+\/widgets\/[^/]+\/data$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/installed\/[^/]+\/widgets\/[^/]+\/execute$/, methods: ['POST'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/members$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/members\/[^/]+$/, methods: ['PUT'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/tokens$/, methods: ['GET', 'POST'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/tokens\/[^/]+$/, methods: ['DELETE'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/runtime\/(city|sos)$/, methods: ['GET'] },
  { pattern: /^\/v1\/capabilities\/workspaces\/import$/, methods: ['POST'] },
];

export function notFoundMiddleware() {
  return (req: Request, res: Response): void => {
    const known = KNOWN_ROUTES.find((route) => route.pattern.test(req.path));
    const requestId = req.synapseDxRequestId || randomUUID();
    if (known && !known.methods.includes(req.method)) {
      res.setHeader('allow', known.methods.concat('OPTIONS').join(', '));
      res.status(405).json(envelope('method_not_allowed', 'Method not allowed for this route', requestId));
      return;
    }
    res.status(404).json(envelope('route_not_found', 'Route not found', requestId));
  };
}

export function assertBodyIsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'invalid_request', 'request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}
