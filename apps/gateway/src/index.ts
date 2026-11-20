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
  // Server-only workspace runtime credential; not advertised in browser CORS.
  'x-workspace-token',
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

/*
 * Upstream policy, kept in parity with apps/gateway/src/main.rs
 * (`is_private_host`/`validate_upstream`) and the capabilities-service
 * `isPrivateHost()`: loopback, RFC1918/CGNAT/link-local/metadata, IPv6
 * ULA/link-local, internal DNS suffixes, Docker service names and non-HTTPS
 * targets never belong in a production upstream URL. The policy is strict in
 * every mode; ALLOW_LOCAL_DEPENDENCIES=true is the documented escape for a
 * trusted container network (docker-compose.yml) and tests.
 */
const PRIVATE_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.corp',
  '.lan',
  '.home.arpa',
  '.svc',
  '.consul',
  '.cluster.local',
  '.docker.internal',
];

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const [a, b, c] = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  if (![a, b, c].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    // Not a valid dotted quad; treat it as a name and let the caller decide.
    return false;
  }
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24 documentation
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Expand an IPv6 literal to eight 16-bit groups (null when invalid). */
function ipv6Groups(input: string): number[] | null {
  const value = input.split('%')[0];
  if (!value.includes(':')) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    const items = part.split(':');
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.includes('.')) {
        // Embedded IPv4 is only legal in the last group.
        if (index !== items.length - 1) return null;
        const v4 = item.split('.').map(Number);
        if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
      out.push(parseInt(item, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...new Array<number>(fill).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

function ipv4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

function isPrivateIpv6(groups: number[]): boolean {
  const firstFiveZero = groups.slice(0, 5).every((group) => group === 0);
  if (groups.every((group) => group === 0)) return true; // ::
  if (firstFiveZero && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return true; // ::1
  if (groups.slice(0, 6).every((group) => group === 0) && (groups[6] !== 0 || groups[7] !== 0)) {
    // Deprecated IPv4-compatible ::a.b.c.d
    return true;
  }
  if (firstFiveZero && groups[5] === 0xffff) {
    return isPrivateIpv4(ipv4FromGroups(groups[6], groups[7])); // ::ffff:a.b.c.d
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return isPrivateIpv4(ipv4FromGroups(groups[6], groups[7])); // NAT64 64:ff9b::/96
  }
  if (groups[0] === 0x100 && groups.slice(1, 4).every((group) => group === 0)) {
    return true; // 100::/64 discard-only
  }
  if (groups[0] === 0x2001 && groups[1] === 0xdb8) return true; // documentation 2001:db8::/32
  if (groups[0] === 0x2002) {
    return isPrivateIpv4(ipv4FromGroups(groups[1], groups[2])); // 6to4 embeds IPv4
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  for (const suffix of PRIVATE_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateIpv4(host);
  if (host.includes(':')) {
    const groups = ipv6Groups(host);
    if (!groups) return true; // malformed IPv6 literal: never a public dependency
    return isPrivateIpv6(groups);
  }
  // A hostname without a dot is a Docker/Kubernetes/compose service name; it can
  // resolve only inside the private network (e.g. `capabilities`, `postgres`).
  return !host.includes('.');
}

export interface GatewayOptions {
  upstream?: string;
  timeoutMs?: number;
  corsOrigins?: string[];
  /** Explicit escape for trusted container networks/tests; defaults to ALLOW_LOCAL_DEPENDENCIES. */
  allowLocal?: boolean;
}

export function assertUpstream(value: string, allowLocal = process.env.ALLOW_LOCAL_DEPENDENCIES === 'true'): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`CAPABILITIES_SERVICE_URL is not an absolute URL: ${value}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('CAPABILITIES_SERVICE_URL must be an HTTP(S) URL');
  }
  if (url.username || url.password) {
    throw new Error('CAPABILITIES_SERVICE_URL must not contain credentials');
  }
  if (url.hash) {
    throw new Error('CAPABILITIES_SERVICE_URL must not contain a fragment');
  }
  if (!url.hostname) {
    throw new Error('CAPABILITIES_SERVICE_URL must include a host');
  }
  if (isPrivateHost(url.hostname) && !allowLocal) {
    throw new Error('CAPABILITIES_SERVICE_URL may not point to a private/loopback/internal host (set ALLOW_LOCAL_DEPENDENCIES=true only for a trusted container network or tests)');
  }
  if (url.protocol !== 'https:' && !allowLocal) {
    throw new Error('CAPABILITIES_SERVICE_URL must use HTTPS outside tests');
  }
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
  const upstream = assertUpstream(
    options.upstream ?? process.env.CAPABILITIES_SERVICE_URL ?? 'http://capabilities:8082',
    options.allowLocal,
  );
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
  // Validation happens here (mirroring main.rs `fn main`), not at import time:
  // importing the gateway module must not construct or validate an upstream.
  createGateway().listen(port, () => console.log(`[synapsedx-gateway] listening on :${port}`));
}
