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
 * tenant (org/account/subject, org-first like Tier-1 Base) that created them,
 * and private reads/writes are scoped to that tenant. No Tier-2 database or key
 * store is added.
 *
 * ## Administrator model (security-critical)
 *
 * Tier-1 stamps **every** ordinary user access token with `scopes: ['*']`
 * ("org-member authority"), and any member can mint an API key carrying scopes
 * up to its own authority. A `*` scope (on a user token *or* on an API key) is
 * therefore **not** evidence of administration, and using it as one makes every
 * member/volunteer a cross-tenant administrator. Two distinct levels exist:
 *
 * - **Organization administrator** (`principal.isDxAdmin`, `isTenantAdmin()`):
 *   manages workspaces, teams, settings and approvals of **its own tenant
 *   only**. Verified from `GET /v1/auth/me` (`user.is_org_admin === true`) with
 *   the caller's own bearer token, or from the operator bootstrap list
 *   `SYNAPSEDX_ADMIN_SUBJECTS`. Never grants cross-tenant reads.
 * - **Deployment administrator** (`isAdmin()`): the only principal allowed to
 *   bypass tenant scoping (e.g. platform projections). It is granted solely by
 *   server configuration: a bootstrap subject, or the configured process
 *   service credential (`SYNAPSEONE_API_KEY` / `SYNAPSEONE_TOKEN`) presented on
 *   the request. No scope, wildcard key or org-admin flag can grant it.
 *
 * All decisions come from verified IAM data or server configuration, never from
 * request bodies, headers, or token fields the caller can choose. Setting
 * `SYNAPSEDX_RESOLVE_ORG_ADMIN=false` disables the IAM lookup and relies on the
 * bootstrap list (documented bootstrap requirement).
 */
import { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
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
  /** Verified IAM email claim (informational only — never used for authorization). */
  email?: string;
  /**
   * Verified Tier-1 user id that owns an API key (`user_id` in
   * `GET /v1/auth/verify`). Absent for account-level keys. A user-bound key is
   * self-mintable by an ordinary member, so its scopes are the member's own
   * authority, never machine/operator authority.
   */
  userId?: string;
  scopes: string[];
  /** Tier-1 claim kind (`user`, `service-account`, ...), when present. */
  kind?: string;
  /**
   * True when the caller administers **its own organization** (Tier-1 IAM
   * `user.is_org_admin`) or is an operator bootstrap administrator. Never grants
   * cross-tenant access; never derived from a caller-supplied value.
   */
  isDxAdmin?: boolean;
  /**
   * True only for the configured process credential (`SYNAPSEONE_API_KEY` /
   * `SYNAPSEONE_TOKEN`) presented by the caller. This is the only automatic
   * deployment-wide authority.
   */
  isServiceCredential?: boolean;
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
    const org = body.org || body.org_id ? String(body.org || body.org_id) : undefined;
    const userId = body.user_id ? String(body.user_id) : undefined;
    const scopes = scopesOf(body.scopes);
    return {
      type: 'apikey',
      // A user-bound key acts for its verified owner, so ownership comparisons
      // match that user's session. Account-level keys are machine identities.
      subject: userId || `apikey:${account || fallbackTenant || 'unknown'}`,
      // Tier-1 tenancy is org-first (Base resolves org → account → user); keep
      // the same precedence so a key and an org user share one tenant.
      tenantKey: tenantKeyOf(org || account || fallbackTenant),
      ...(org ? { org } : {}),
      ...(account ? { account } : {}),
      ...(userId ? { userId } : {}),
      scopes,
    };
  }
  const claims = (body.claims || body) as Record<string, any>;
  const subject = String(claims.sub || claims.userId || claims.user_id || '');
  const org = claims.org ? String(claims.org) : undefined;
  const account = claims.account ? String(claims.account) : undefined;
  const email = claims.email ? String(claims.email).trim().toLowerCase() : undefined;
  // Tier-1 Base resolves the tenant as org → account → user → explicit platform
  // tenant. Match that order: a delegated token carrying both an org and an
  // account must land in the same tenant as the user's own session, otherwise
  // the same organization's data splits across two tenant keys.
  const tenantKey = tenantKeyOf(org || account || subject || fallbackTenant);
  return {
    type: 'jwt',
    subject: subject || `subject:${tenantKey}`,
    tenantKey,
    ...(org ? { org } : {}),
    ...(account ? { account } : {}),
    ...(email ? { email } : {}),
    ...(claims.kind ? { kind: String(claims.kind) } : {}),
    scopes: scopesOf(claims.scopes),
  };
}

/**
 * Operator-configured bootstrap administrators (`SYNAPSEDX_ADMIN_SUBJECTS`).
 *
 * Values are **verified Tier-1 user subject ids** only. Email must not be used:
 * a JWT email is not proof of ownership (self-registration can produce an
 * unverified email), so matching an email here would let anybody who registers
 * the operator's email address become a deployment administrator. The subject
 * compared here always comes from the verified IAM payload.
 */
export function adminBootstrapEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.SYNAPSEDX_ADMIN_SUBJECTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function isBootstrappedAdmin(principal: CallerPrincipal, env: NodeJS.ProcessEnv = process.env): boolean {
  const subject = principal.subject.trim().toLowerCase();
  if (!subject) return false;
  return adminBootstrapEntries(env).some((entry) => entry === subject);
}

function orgAdminLookupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.SYNAPSEDX_RESOLVE_ORG_ADMIN ?? 'true').trim().toLowerCase() !== 'false';
}

/**
 * Delegated-token trust gate (default: **closed**).
 *
 * Tier-1 `POST /v1/auth/exchange` currently accepts a *user-bound* self-minted
 * API key (`resolveServiceIdentity` never inspects `rec.user_id`), so an
 * ordinary member can bypass DX entirely and mint a delegated token for any
 * user — including its organization administrator — with arbitrary explicit
 * scopes (`scopesSubset` returns true when the caller holds `*`). Until the
 * Tier-1 service-credential gate and exchange audit are deployed, a delegated
 * token is not evidence of trusted machine delegation, so DX refuses it.
 *
 * Enable `SYNAPSEDX_TRUST_DELEGATED_TOKENS=true` only after:
 * 1. Tier-1 exchange rejects user-bound API keys (requires account-level key or
 *    service-account token),
 * 2. Tier-1 exchange writes an audit row for the acting credential, and
 * 3. this deployment has verified the fix (product keys are account-level).
 */
function delegatedTokensTrusted(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.SYNAPSEDX_TRUST_DELEGATED_TOKENS ?? '').trim());
}

let orgAdminLookupWarned = false;

/**
 * Confirm that the caller administers its own organization. Only the caller's
 * own bearer token is used, so Tier-1 decides membership; a lookup failure
 * degrades to "not an administrator" (fail closed) without failing the request,
 * because the credential itself was already verified.
 *
 * The response must positively bind to this principal: the same user id, the
 * exact claimed organization, and a literal `is_org_admin === true`. A payload
 * with a missing org or a different user id is never accepted.
 */
async function resolveOrgAdmin(
  config: ServiceConfig,
  credential: CallerCredential,
  principal: CallerPrincipal,
): Promise<boolean> {
  if (!principal.org || !principal.subject) return false;
  if (!orgAdminLookupEnabled()) return false;
  try {
    const me = (await credentialClient(config, credential).iam.me()) as any;
    const user = (me && me.user) || {};
    // `publicUser()` in Tier-1 IAM exposes `is_org_admin`.
    return user.is_org_admin === true
      && String(user.id || '') === principal.subject
      && String(user.org_id || '') === principal.org;
  } catch (error) {
    if (!orgAdminLookupWarned) {
      orgAdminLookupWarned = true;
      console.warn(`[synapsedx] organization-admin lookup failed; user sessions keep member privileges: ${(error as Error).message}`);
    }
    return false;
  }
}

/** Constant-time comparison of two opaque credential strings. */
function sameCredential(presented: string, configured: string | undefined): boolean {
  if (!presented || !configured) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(configured).digest();
  return timingSafeEqual(a, b);
}

/**
 * The request carries the process service credential (`SYNAPSEONE_API_KEY` as
 * `X-API-Key` or `SYNAPSEONE_TOKEN` as `Bearer`). This is an operator secret, so
 * it — and only it — carries deployment-wide technical authority.
 */
export function isConfiguredServiceCredential(
  config: ServiceConfig,
  credential: CallerCredential,
): boolean {
  if (credential.kind === 'api-key') return sameCredential(credential.value, config.serviceApiKey);
  return sameCredential(credential.value, config.serviceToken);
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
  if (principal.kind === 'delegated' && !delegatedTokensTrusted()) {
    // Dependency gate: see delegatedTokensTrusted(). 403 (not 401) so product
    // clients can fall back to the user-scoped login token instead of looping.
    throw apiError(403, 'delegated_trust_required', 'delegated tokens are not trusted by this deployment until the Tier-1 exchange gate is released', {
      dependency: 'synapseone-iam-exchange',
      enable: 'SYNAPSEDX_TRUST_DELEGATED_TOKENS=true after the Tier-1 fix',
    });
  }
  if (isConfiguredServiceCredential(config, credential)) {
    principal.isServiceCredential = true;
    principal.isDxAdmin = true;
  } else if (principal.type === 'jwt' && (principal.kind === 'user' || principal.kind === undefined)) {
    // Organization administration is org-scoped: it is verified through IAM and
    // never widens tenant access beyond the caller's own organization.
    if (isBootstrappedAdmin(principal) || (await resolveOrgAdmin(config, credential, principal))) {
      principal.isDxAdmin = true;
    }
  }
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

/**
 * Deployment-wide administrator: the only principal allowed to bypass tenant
 * scoping. Granted only by operator configuration — the bootstrap subject list
 * or the configured process service credential. No scope (`*` included), API
 * key, organization-admin flag or claim can grant it, because an ordinary
 * organization member can mint wildcard keys in Tier-1 IAM.
 */
export function isAdmin(principal: CallerPrincipal): boolean {
  return principal.isServiceCredential === true || isBootstrappedAdmin(principal);
}

/**
 * Organization administrator: manages teams, settings, approvals and workspace
 * pages **inside its own tenant**. This is the check for tenant-scoped
 * administration; it must never be used to widen data access across tenants.
 */
export function isTenantAdmin(principal: CallerPrincipal): boolean {
  return isAdmin(principal) || principal.isDxAdmin === true;
}

/**
 * A credential minted by an operator for machine use: an account-level API key
 * (`user_id` absent; Tier-1 requires a step-up/org-admin sensitive mutation to
 * mint one) or a service-account token (same requirement).
 *
 * Everything else — end-user sessions, **user-bound API keys** that a member can
 * mint for itself, and delegated tokens (self-mintable exchange) — carries only
 * explicit-scope/member authority, never wildcard authority.
 */
export function isMachineCredential(principal: CallerPrincipal): boolean {
  if (principal.type === 'apikey') return !principal.userId;
  return principal.kind === 'service-account';
}

/**
 * A credential may mutate capability data.
 *
 * Wildcard authority belongs to operator-minted machine credentials only:
 * Tier-1 stamps `*` on every ordinary user token, and a member can mint an API
 * key (or request any scope it already holds) bound to its own user id, so
 * neither may become an operator. Explicit `write`/`synapsedx:operator` scopes
 * remain supported for operator-configured machine credentials.
 */
export function hasWriteScope(principal: CallerPrincipal): boolean {
  if (isTenantAdmin(principal)) return true;
  if (isMachineCredential(principal)) {
    if (!principal.scopes.length) return true; // legacy full-access machine key
    if (principal.scopes.some((scope) => scope.trim() === '*')) return true;
    return explicitWriteScopes(principal.scopes);
  }
  // A user-bound API key is self-minted by an ordinary member: its scopes are
  // not evidence of any capability grant.
  if (principal.type === 'apikey') return false;
  // End-user sessions and delegated tokens need an explicit write role; the
  // wildcard is member authority and is never counted here.
  return explicitWriteScopes(principal.scopes);
}

function explicitWriteScopes(scopes: string[]): boolean {
  return scopes.some((scope) => {
    const value = scope.toLowerCase();
    return (
      value === 'write' ||
      value === 'synapsedx:operator' ||
      /(^|:)write$/i.test(value) ||
      /(^|:)admin$/i.test(value)
    );
  });
}

/** A credential may read tenant-scoped management data. */
export function hasReadScope(principal: CallerPrincipal): boolean {
  if (hasWriteScope(principal)) return true;
  if (isMachineCredential(principal) && principal.scopes.some((scope) => scope.trim() === '*')) return true;
  // User-bound keys have no capability authority; end-user and delegated
  // credentials need an explicit read role.
  if (principal.type === 'apikey') return false;
  return principal.scopes.some((scope) => {
    const value = scope.toLowerCase();
    return value === '*:read' || value === 'read' || value === 'synapsedx:manager' || /(^|:)read$/i.test(value);
  });
}

/** A credential may review/approve capability metadata. */
export function isModerator(principal: CallerPrincipal): boolean {
  if (isTenantAdmin(principal)) return true;
  if (principal.type === 'apikey' && !isMachineCredential(principal)) return false;
  return principal.scopes.some((scope) => {
    const value = scope.toLowerCase();
    return value === 'synapsedx:moderator' || value === 'moderator' || value.endsWith(':moderator');
  });
}

/** Read-only API keys cannot mutate capability data. */
export function assertWriteScope(principal: CallerPrincipal): void {
  if (!hasWriteScope(principal)) {
    throw apiError(403, 'insufficient_scope', 'this credential is read-only');
  }
}

/** Dataset visibility for the verified caller. */
export function canAccessDataset(
  dataset: { tenant?: string; owner?: string; public?: boolean; status?: string },
  caller: Caller,
): boolean {
  if (dataset.public === true && dataset.status === 'published') return true;
  if (!caller.authenticated || !caller.principal) return false;
  if (isAdmin(caller.principal)) return true;
  // Legacy documents written before tenancy was recorded have no tenant. They
  // are only reachable by their exact verified owner (or a deployment admin);
  // any role or same-org assumption would be a cross-tenant hole.
  if (!dataset.tenant) return !!dataset.owner && dataset.owner === caller.principal.subject;
  return dataset.tenant === caller.principal.tenantKey;
}

/**
 * Private dataset *data* access inside an already-verified tenant.
 *
 * Sharing an organization is not a data role: a plain member/volunteer token
 * (`scopes: ['*']`) must not enumerate every private business dataset of its
 * organization. Data is reachable through the owner, an explicit dataset
 * viewer, an explicit capability role, or organization administration — the
 * workspace runtime instead uses the server-side service credential after its
 * own persisted membership check.
 */
export function canReadPrivateDatasetData(
  dataset: { owner?: string; viewers?: string[] },
  principal: CallerPrincipal,
): boolean {
  if (isTenantAdmin(principal)) return true;
  if (dataset.owner && dataset.owner === principal.subject) return true;
  if (Array.isArray(dataset.viewers) && dataset.viewers.includes(principal.subject)) return true;
  return hasWriteScope(principal) || hasReadScope(principal);
}
