// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * SynapseDX public gateway.
 *
 * The gateway is a transparent HTTPS boundary in front of the capabilities
 * service: it forwards the caller credential and conditional/idempotency
 * headers, streams request bodies (including binary) unchanged, enforces an
 * upstream timeout, and answers CORS for both Tier-3 origins.
 */
import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

export const DEFAULT_CORS_ORIGINS = [
  'https://synapsecity.sbs',
  'https://sos.synapsecity.sbs',
  'https://synapsedx.sbs',
  'https://cloud.synapsedx.sbs',
];

/** Request headers forwarded to the capabilities service. */
export const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'idempotency-key',
  'if-match',
  'if-none-match',
  'traceparent',
  'x-api-key',
  'x-correlation-id',
  'x-idempotency-key',
  'x-request-id',
  'x-synapseone-tenant',
  'x-synapsedx-product',
  'x-checksum-sha256',
];

/** Response headers copied back to the caller. */
export const FORWARDED_RESPONSE_HEADERS = [
  'cache-control',
  'content-disposition',
  'content-type',
  'etag',
  'link',
  'location',
  'retry-after',
  'www-authenticate',
  'x-correlation-id',
  'x-event-status',
  'x-lds-context',
  'x-lds-datasource',
  'x-lds-license',
  'x-lds-total',
  'x-limit',
  'x-next-cursor',
  'x-offset',
  'x-request-id',
  'x-total-count',
];

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

export interface GatewayOptions {
  upstream?: string;
  timeoutMs?: number;
  corsOrigins?: string[];
}

export function assertUpstream(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`CAPABILITIES_SERVICE_URL is not an absolute URL: ${value}`); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|127\.0\.0\.1|::1)$/i.test(host) && process.env.ALLOW_LOCAL_DEPENDENCIES !== 'true' && process.env.NODE_ENV === 'production') {
    throw new Error('CAPABILITIES_SERVICE_URL may not point to localhost in production');
  }
  if (url.protocol !== 'https:' && !/^https?:$/.test(url.protocol)) throw new Error('CAPABILITIES_SERVICE_URL must be an HTTP(S) URL');
  return value.replace(/\/+$/, '');
}

function parseOrigins(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const raw of [env.CORS_ORIGINS, env.CORS_ORIGIN]) {
    if (!raw) continue;
    for (const origin of raw.split(',')) {
      const trimmed = origin.trim().replace(/\/+$/, '');
      if (trimmed && !values.includes(trimmed)) values.push(trimmed);
    }
  }
  return values.length ? values : [...DEFAULT_CORS_ORIGINS];
}

function appendVary(res: Response, value: string): void {
  const current = String(res.getHeader('vary') || '');
  const parts = current.split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === value.toLowerCase())) parts.push(value);
  res.setHeader('vary', parts.join(', '));
}

function applyCors(req: Request, res: Response, origins: string[]): void {
  const origin = req.header('origin');
  appendVary(res, 'Origin');
  if (origin && origins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', [
    'accept', 'authorization', 'content-type', 'idempotency-key', 'if-match', 'if-none-match',
    'x-api-key', 'x-correlation-id', 'x-request-id', 'x-idempotency-key',
    'x-synapseone-tenant', 'x-synapsedx-product', 'x-checksum-sha256',
  ].join(','));
  res.setHeader('access-control-expose-headers', [
    'etag', 'link', 'retry-after', 'www-authenticate', 'x-correlation-id', 'x-request-id',
    'x-total-count', 'x-limit', 'x-offset', 'x-next-cursor', 'x-event-status',
    'x-lds-license', 'x-lds-datasource', 'x-lds-total', 'x-lds-context',
    'x-checksum-sha256', 'content-disposition', 'cache-control',
  ].join(','));
  res.setHeader('access-control-max-age', '600');
}

export function createGateway(options: GatewayOptions = {}): express.Express {
  const upstream = assertUpstream(options.upstream ?? process.env.CAPABILITIES_SERVICE_URL ?? 'http://capabilities:8082');
  const timeoutMs = options.timeoutMs ?? Number(process.env.UPSTREAM_TIMEOUT_MS || 30000);
  const corsOrigins = options.corsOrigins ?? parseOrigins(process.env);

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    applyCors(req, res, corsOrigins);
    if (req.method === 'OPTIONS') return res.status(204).end();
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    const incoming = (req.header('x-correlation-id') || req.header('x-request-id') || '').trim();
    const correlationId = incoming && /^[\x20-\x7E]{1,200}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('x-request-id', correlationId);
    (req as Request & { correlationId?: string }).correlationId = correlationId;
    next();
  });
  // Never parse the body: proxy the exact bytes (binary uploads included).
  app.use(express.raw({ type: '*/*', limit: '25mb' }));

  const callUpstream = async (
    req: Request,
    path: string,
    body: Buffer | undefined,
  ): Promise<globalThis.Response> => {
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.header(name);
      if (value !== undefined) headers.set(name, value);
    }
    headers.set('x-correlation-id', String(res_correlationId(req)));
    headers.set('x-request-id', String(res_correlationId(req)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${upstream}${path}`, {
        method: req.method,
        headers,
        ...(body && body.length && !['GET', 'HEAD'].includes(req.method) ? { body: new Uint8Array(body) } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });
    } finally {
      clearTimeout(timer);
    }
  };

  function res_correlationId(req: Request): string {
    return req.header('x-correlation-id') || (req as Request & { correlationId?: string }).correlationId || randomUUID();
  }

  const proxy = async (req: Request, res: Response): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await callUpstream(req, req.originalUrl, Buffer.isBuffer(req.body) ? req.body : undefined);
      res.status(response.status);
      response.headers.forEach((value, name) => {
        if (HOP_BY_HOP.has(name.toLowerCase()) && !(req.method === 'HEAD' && name.toLowerCase() === 'content-length')) return;
        if (FORWARDED_RESPONSE_HEADERS.includes(name.toLowerCase()) || name.toLowerCase().startsWith('x-')) {
          res.setHeader(name, value);
        }
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      res.send(buffer);
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError';
      res.status(aborted ? 504 : 502).json({
        error: {
          code: aborted ? 'upstream_timeout' : 'upstream_unavailable',
          message: aborted ? 'the capabilities service did not respond in time' : 'the capabilities service is unavailable',
          requestId: res_correlationId(req),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  };

  app.get('/health', async (req, res) => {
    const correlationId = res_correlationId(req);
    res.setHeader('x-correlation-id', correlationId);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: globalThis.Response;
      try {
        response = await fetch(`${upstream}/health`, {
          headers: { 'x-correlation-id': correlationId },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await response.text();
      let upstreamBody: unknown = null;
      try { upstreamBody = text ? JSON.parse(text) : null; } catch { upstreamBody = { raw: text.slice(0, 200) }; }
      res.status(response.status).json({
        status: response.ok ? (upstreamBody as any)?.status || 'ok' : 'degraded',
        service: 'synapsedx-gateway',
        dependencies: [{ name: 'capabilities', status: response.ok ? 'ok' : 'down', critical: true }],
        upstream: upstreamBody,
        time: new Date().toISOString(),
      });
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError';
      res.status(503).json({
        status: 'down',
        service: 'synapsedx-gateway',
        dependencies: [{ name: 'capabilities', status: 'down', critical: true, error: aborted ? 'timeout' : 'unreachable' }],
        time: new Date().toISOString(),
      });
    }
  });

  app.get('/ready', async (req, res) => {
    const correlationId = res_correlationId(req);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: globalThis.Response;
      try {
        response = await fetch(`${upstream}/ready`, {
          headers: { 'x-correlation-id': correlationId },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await response.text();
      let upstreamBody: unknown = null;
      try { upstreamBody = text ? JSON.parse(text) : null; } catch { upstreamBody = { raw: text.slice(0, 200) }; }
      res.status(response.ok ? 200 : 503).json({
        status: response.ok ? 'ready' : 'degraded',
        service: 'synapsedx-gateway',
        dependencies: [{ name: 'capabilities', status: response.ok ? 'ok' : 'down', critical: true }],
        upstream: upstreamBody,
        time: new Date().toISOString(),
      });
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError';
      res.status(503).json({
        status: 'degraded',
        service: 'synapsedx-gateway',
        dependencies: [{ name: 'capabilities', status: 'down', critical: true, error: aborted ? 'timeout' : 'unreachable' }],
        time: new Date().toISOString(),
      });
    }
  });

  app.use('/v1/capabilities', (req, res, next) => { proxy(req, res).catch(next); });
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: { code: 'route_not_found', message: 'Route not found', requestId: res_correlationId(req) },
    });
  });
  app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    res.status(502).json({
      error: { code: 'capabilities_upstream_unavailable', message: 'the capabilities service is unavailable', requestId: res_correlationId(req) },
    });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  createGateway().listen(port, () => console.log(`[synapsedx-gateway] listening on :${port}`));
}

export const app = createGateway();
