// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Caller authentication for the Tier-2 boundary.
 *
 * A caller must present a Tier-1-verifiable credential (`Authorization: Bearer`
 * or `X-API-Key`). Tier-2 verifies it with `iam.verify()` using *that* credential
 * only; the process service key is never a fallback for an unknown caller.
 *
 * Authorization is derived from the verified principal: datasets carry the
 * tenant (account/org/subject) that created them, and private reads/writes are
 * scoped to that tenant. No Tier-2 database or key store is added.
 */
import { Request } from 'express';
import { SynapseOneClient, SynapseOneError } from '@synapseone/sdk';
import { ServiceConfig } from './config';
import { apiError } from './errors';

declare module 'express-serve-static-core' {
  interface Request {
    synapseDxRequestId?: string;
    synapseDxCaller?: Caller;
  }
}

export interface CallerCredential {
  kind: 'bearer' | 'api-key';
  value: string;
}

export interface CallerPrincipal {
  type: 'jwt' | 'apikey';
  subject: string;
  tenantKey: string;
  org?: string;
  account?: string;
  scopes: string[];
  /** Tier-1 claim kind (`user`, `service-account`, ...), when present. */
  kind?: string;
}

export interface Caller {
  authenticated: boolean;
  credential?: CallerCredential;
  principal?: CallerPrincipal;
}

export function readCredential(req: Request): CallerCredential | undefined {
  const authorization = req.header('authorization') || '';
  if (/^Bearer\s+/i.test(authorization)) {
    const value = authorization.replace(/^Bearer\s+/i, '').trim();
    if (value) return { kind: 'bearer', value };
  }
  const apiKey = (req.header('x-api-key') || '').trim();
  if (apiKey) return { kind: 'api-key', value: apiKey };
  return undefined;
}

export function credentialClient(config: ServiceConfig, credential: CallerCredential): SynapseOneClient {
  return new SynapseOneClient({
    baseUrl: config.tier1BaseUrl,
    ...(credential.kind === 'bearer' ? { token: credential.value } : { apiKey: credential.value }),
    ...(config.serviceTenant ? { tenant: config.serviceTenant } : {}),
    timeoutMs: config.requestTimeoutMs,
  });
}

function tenantKeyOf(value: string | undefined): string {
  return String(value || 'anonymous').replace(/[^A-Za-z0-9_.@:-]/g, '_').slice(0, 128);
}

function scopesOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value) return value.split(/[\s,]+/).filter(Boolean);
  return [];
}

/** Interpret the `iam.verify()` payload (JWT or API-key forms). */
export function principalFromVerify(payload: unknown, fallbackTenant?: string): CallerPrincipal {
  const body = (payload || {}) as Record<string, any>;
  if (body.valid === false) throw apiError(401, 'invalid_credential', 'credential is not valid');
  if (body.type === 'apikey' || body.account_id) {
    const account = body.account_id ? String(body.account_id) : undefined;
    const scopes = scopesOf(body.scopes);
    return {
      type: 'apikey',
      subject: `apikey:${account || fallbackTenant || 'unknown'}`,
      tenantKey: tenantKeyOf(account || fallbackTenant),
      ...(account ? { account } : {}),
      scopes,
    };
  }
  const claims = (body.claims || body) as Record<string, any>;
  const subject = String(claims.sub || claims.userId || claims.user_id || '');
  const org = claims.org ? String(claims.org) : undefined;
  const account = claims.account ? String(claims.account) : undefined;
  const tenantKey = tenantKeyOf(account || org || subject || fallbackTenant);
  return {
    type: 'jwt',
    subject: subject || `subject:${tenantKey}`,
    tenantKey,
    ...(org ? { org } : {}),
    ...(account ? { account } : {}),
    ...(claims.kind ? { kind: String(claims.kind) } : {}),
    scopes: scopesOf(claims.scopes),
  };
}

/**
 * Verify the request credential (once per request) and cache the result.
 * Throws 401 when a credential is present but invalid, 503 when IAM cannot be
 * reached, and 401 `unauthorized` when `required` and no credential is present.
 */
export async function authenticate(req: Request, config: ServiceConfig, required: boolean): Promise<Caller> {
  if (req.synapseDxCaller) {
    if (required && !req.synapseDxCaller.authenticated) {
      throw apiError(401, 'unauthorized', 'a verified Tier-1 bearer token or API key is required');
    }
    return req.synapseDxCaller;
  }
  const credential = readCredential(req);
  if (!credential) {
    const anonymous: Caller = { authenticated: false };
    req.synapseDxCaller = anonymous;
    if (required) {
      throw apiError(401, 'unauthorized', 'a verified Tier-1 bearer token or API key is required');
    }
    return anonymous;
  }
  if (!config.hasServiceCredential && config.authMode === 'required') {
    // Verification itself only needs the caller credential; this flag is about
    // the platform credential used for data access. Fail readably rather than
    // letting every write collapse into an opaque upstream error.
    console.warn('[synapsedx] no SYNAPSEONE_API_KEY/SYNAPSEONE_TOKEN configured; platform data operations will fail');
  }
  let payload: unknown;
  try {
    payload = await credentialClient(config, credential).iam.verify();
  } catch (error) {
    if (error instanceof SynapseOneError && (error.status === 401 || error.status === 403)) {
      throw apiError(401, 'invalid_credential', 'credential was rejected by SynapseOne');
    }
    throw apiError(503, 'authentication_unavailable', 'the identity provider is unavailable');
  }
  const principal = principalFromVerify(payload, config.serviceTenant);
  const caller: Caller = { authenticated: true, credential, principal };
  req.synapseDxCaller = caller;
  return caller;
}

export function requireAuthenticated(caller: Caller): CallerPrincipal {
  if (!caller.authenticated || !caller.principal) {
    throw apiError(401, 'unauthorized', 'a verified Tier-1 bearer token or API key is required');
  }
  return caller.principal;
}

export function isAdmin(principal: CallerPrincipal): boolean {
  return principal.scopes.some((scope) => scope === '*' || scope === 'synapsedx:admin' || scope === 'admin');
}

/** Read-only API keys cannot mutate capability data. */
export function assertWriteScope(principal: CallerPrincipal): void {
  if (isAdmin(principal)) return;
  if (!principal.scopes.length) return; // Tier-1 keys without explicit scopes are full-access keys
  const writable = principal.scopes.some((scope) => (
    scope === '*' ||
    scope.toLowerCase() === 'write' ||
    /(^|:)write$/i.test(scope) ||
    /(^|:)admin$/i.test(scope)
  ));
  if (!writable) throw apiError(403, 'insufficient_scope', 'this credential is read-only');
}

/** Dataset visibility for the verified caller. */
export function canAccessDataset(
  dataset: { tenant?: string; owner?: string; public?: boolean; status?: string },
  caller: Caller,
): boolean {
  if (dataset.public === true && dataset.status === 'published') return true;
  if (!caller.authenticated || !caller.principal) return false;
  if (isAdmin(caller.principal)) return true;
  // Legacy datasets written before tenancy was recorded stay reachable for
  // authenticated callers; the next write stamps the tenant.
  if (!dataset.tenant) return true;
  return dataset.tenant === caller.principal.tenantKey;
}
