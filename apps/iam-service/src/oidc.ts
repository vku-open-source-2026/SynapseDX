/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Real OIDC Authorization Code flow (Authentik / Keycloak / any OIDC IdP).
 * No extra dependencies: discovery + token exchange over fetch, ID-token
 * signature verification via JWKS + node:crypto JWK import + jsonwebtoken.
 */
import jwt from 'jsonwebtoken';
import { createHmac, randomBytes, createPublicKey, timingSafeEqual } from 'crypto';
import { getJwtSecret } from './tokens';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  provider: string;
}

export function oidcSettings(): OidcSettings {
  return {
    issuer: (process.env.OIDC_ISSUER || 'http://authentik-server:9000/application/o/synapsedx/').replace(/\/*$/, '/'),
    clientId: process.env.OIDC_CLIENT_ID || 'synapsedx-platform',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    redirectUri: process.env.OIDC_REDIRECT_URI || 'http://localhost:4001/v1/auth/oidc/callback',
    provider: process.env.OIDC_PROVIDER || 'authentik',
  };
}

export class OidcError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    const text = await r.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    if (!r.ok) {
      const detail =
        typeof body === 'object' && body
          ? String((body as any).error_description || (body as any).error || r.status).slice(0, 200)
          : String(r.status);
      throw new OidcError('oidc_upstream_error', `IdP request failed (${detail})`, 502);
    }
    return body;
  } catch (e: any) {
    if (e instanceof OidcError) throw e;
    throw new OidcError('oidc_unreachable', `IdP unreachable: ${e?.message || e}`, 502);
  } finally {
    clearTimeout(to);
  }
}

// ---------- signed state (CSRF/replay protection for the SPA round-trip) ----------

const STATE_TTL_MS = 10 * 60 * 1000;

function b64u(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

/** state = base64url({org,t,n}).hmac — HMAC key is the IAM JWT secret. */
export function signState(org: string): string {
  const payload = b64u({ org, t: Date.now(), n: randomBytes(16).toString('hex') });
  const sig = createHmac('sha256', getJwtSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifyState(state: string): { org: string } {
  const parts = String(state || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new OidcError('oidc_bad_state', 'Invalid OIDC state (format).', 400);
  }
  const want = createHmac('sha256', getJwtSecret()).update(parts[0]).digest();
  let got: Buffer;
  try {
    got = Buffer.from(parts[1], 'hex');
  } catch {
    throw new OidcError('oidc_bad_state', 'Invalid OIDC state (signature).', 400);
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new OidcError('oidc_bad_state', 'Invalid OIDC state (signature).', 400);
  }
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new OidcError('oidc_bad_state', 'Invalid OIDC state (payload).', 400);
  }
  if (typeof payload.org !== 'string' || !/^[a-z0-9-]{1,64}$/.test(payload.org)) {
    throw new OidcError('oidc_bad_state', 'Invalid OIDC state (org).', 400);
  }
  if (typeof payload.t !== 'number' || Date.now() - payload.t > STATE_TTL_MS || payload.t > Date.now() + 60_000) {
    throw new OidcError('oidc_state_expired', 'OIDC state expired — restart login.', 400);
  }
  return { org: payload.org };
}

// ---------- discovery + JWKS (short-TTL caches) ----------

interface CacheEntry {
  at: number;
  value: any;
}
let discovery: CacheEntry | null = null;
const jwksCache = new Map<string, { at: number; value: any }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function discover(issuer: string): Promise<any> {
  if (discovery && Date.now() - discovery.at < CACHE_TTL_MS && discovery.value.__issuer === issuer) {
    return discovery.value;
  }
  const url = `${issuer}.well-known/openid-configuration`;
  let doc: any;
  try {
    doc = await fetchJson(url, { headers: { Accept: 'application/json' } }, 10_000);
  } catch (e: any) {
    if (e instanceof OidcError) {
      throw new OidcError('oidc_discovery_failed', e.message, e.status);
    }
    throw e;
  }
  if (!doc || typeof doc !== 'object' || !doc.token_endpoint || !doc.jwks_uri || !doc.authorization_endpoint) {
    throw new OidcError('oidc_discovery_failed', 'IdP discovery document is missing endpoints.', 502);
  }
  // Pin the issuer we configured: prevents an attacker-controlled discovery doc
  // from redirecting the exchange at a rogue token endpoint mid-flight.
  if (typeof doc.issuer === 'string' && doc.issuer.replace(/\/*$/, '/') !== issuer) {
    throw new OidcError('oidc_issuer_mismatch', 'IdP issuer mismatch (possible misconfiguration).', 502);
  }
  doc.__issuer = issuer;
  discovery = { at: Date.now(), value: doc };
  return doc;
}

async function getJwks(jwksUri: string): Promise<any[]> {
  const hit = jwksCache.get(jwksUri);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const doc: any = await fetchJson(jwksUri, { headers: { Accept: 'application/json' } }, 10_000);
  if (!doc || !Array.isArray(doc.keys)) {
    throw new OidcError('oidc_jwks_failed', 'IdP JWKS document has no keys.', 502);
  }
  jwksCache.set(jwksUri, { at: Date.now(), value: doc.keys });
  return doc.keys;
}

/** Test hook: drop cached discovery/JWKS (unit tests point at a stub IdP). */
export function __clearOidcCache(): void {
  discovery = null;
  jwksCache.clear();
}

// ---------- ID-token verification ----------

const ALLOWED_ALGS = new Set(['RS256', 'RS384', 'RS512', 'ES256', 'ES384']);

export interface VerifiedIdentity {
  org: string;
  email: string;
  sub: string;
  displayName: string;
}

async function verifyIdToken(idToken: string, doc: any, clientId: string, issuer: string): Promise<any> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new OidcError('oidc_bad_id_token', 'Malformed ID token.', 502);
  let header: any;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new OidcError('oidc_bad_id_token', 'Malformed ID token header.', 502);
  }
  // Never accept symmetric or unsigned IdP tokens: the IdP must prove itself
  // with an asymmetric key from its own JWKS.
  if (!ALLOWED_ALGS.has(header.alg) || !header.kid) {
    throw new OidcError('oidc_bad_id_token', 'ID token must be asymmetrically signed (RS*/ES*) with a kid.', 502);
  }
  const keys = await getJwks(doc.jwks_uri);
  const jwk = keys.find((k: any) => k.kid === header.kid && (k.kty === 'RSA' || k.kty === 'EC'));
  if (!jwk) throw new OidcError('oidc_unknown_kid', 'ID token key not found in IdP JWKS.', 502);
  let pem: string;
  try {
    pem = createPublicKey({ key: jwk, format: 'jwk' }).export({ format: 'pem', type: 'spki' }) as string;
  } catch {
    throw new OidcError('oidc_bad_jwk', 'IdP JWK could not be imported.', 502);
  }
  try {
    return jwt.verify(idToken, pem, { algorithms: [header.alg], issuer, audience: clientId });
  } catch (e: any) {
    throw new OidcError('oidc_bad_id_token', `ID token verification failed: ${e?.message || e}`, 502);
  }
}

// ---------- full exchange ----------

export async function exchangeCode(code: string, state: string): Promise<VerifiedIdentity> {
  const { org } = verifyState(state);
  if (!code || typeof code !== 'string' || code.length > 4096) {
    throw new OidcError('oidc_code_required', 'Authorization `code` is required.', 400);
  }
  const cfg = oidcSettings();
  if (!cfg.clientSecret) {
    throw new OidcError(
      'oidc_not_configured',
      'OIDC_CLIENT_SECRET is not set — configure the IdP client first.',
      501,
    );
  }
  const doc = await discover(cfg.issuer);
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const tok: any = await fetchJson(
    doc.token_endpoint,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: params.toString() },
    15_000,
  );
  if (!tok || typeof tok.id_token !== 'string') {
    throw new OidcError('oidc_token_failed', 'IdP did not return an ID token.', 502);
  }
  const claims: any = await verifyIdToken(tok.id_token, doc, cfg.clientId, cfg.issuer);
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new OidcError('oidc_no_email', 'IdP did not release an email claim (check client scopes).', 502);
  }
  const sub = String(claims.sub || '').slice(0, 320) || email;
  const displayName = String(claims.name || claims.preferred_username || email).slice(0, 200);
  return { org, email, sub, displayName };
}
