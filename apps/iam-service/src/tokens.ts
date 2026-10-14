/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Token management: JWT access tokens + opaque refresh tokens + API keys.
 */
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'crypto';
import { query, useDb, __mem, hashSecret, hashCandidates } from './db';

/** Fail fast on weak/default JWT secrets in production; warn loudly in dev. */
function jwtSecret(): string {
  const s = process.env.IAM_JWT_SECRET || '';
  const weak = !s || s.includes('change_me') || s.length < 32;
  if (weak) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[iam] IAM_JWT_SECRET must be set to a random value ≥32 chars in production');
    }
    console.warn('[iam][security] WARNING: IAM_JWT_SECRET is default/weak — dev only. Set a random ≥32-char secret before exposing anything.');
  }
  return s || 'change_me_super_secret_32chars_min';
}

const JWT_SECRET = jwtSecret();

/** Shared HMAC/JWT secret (also signs OIDC `state`; see oidc.ts). */
export function getJwtSecret(): string {
  return JWT_SECRET;
}

function ttl(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(raw)) {
    console.warn(`[iam][security] ${name} is not a number — using default ${fallback}`);
    return fallback;
  }
  return Math.min(Math.max(Math.floor(raw), min), max);
}

// Clamp TTLs so a garbage env can't produce NaN/negative expiries (login 500s,
// immortal tokens, or instantly-dead refresh).
const ACCESS_TTL = ttl('IAM_JWT_EXPIRES_IN', 3600, 60, 86400);
const REFRESH_TTL = ttl('IAM_REFRESH_EXPIRES_IN', 2592000, 3600, 315360000);

/** Thời điểm hết hạn refresh token mới (dùng REFRESH_TTL, mặc định 30 ngày). */
export function refreshExpiry(): Date {
  return new Date(Date.now() + REFRESH_TTL * 1000);
}

export interface AccessClaims {
  sub: string; // user id
  email?: string;
  org?: string; // org id
  account?: string; // account id
  scopes?: string[];
  kind?: string;
}

export function signAccess(claims: AccessClaims): { token: string; expiresIn: number } {
  const token = jwt.sign({ ...claims, iss: 'synapsedx-iam', kind: claims.kind || 'user' }, JWT_SECRET, { expiresIn: ACCESS_TTL });
  return { token, expiresIn: ACCESS_TTL };
}

export function verifyAccess(token: string): AccessClaims {
  return jwt.verify(token, JWT_SECRET, { issuer: 'synapsedx-iam', algorithms: ['HS256'] }) as AccessClaims;
}

export function newRefreshToken(): { value: string; hash: string } {
  const value = 'synapsedx_rt_' + randomBytes(32).toString('base64url');
  return { value, hash: hashSecret(value) };
}

/** Resolve a presented refresh token to its stored hash (peppered or legacy). */
function refreshHashes(value: string): string[] {
  return hashCandidates(value);
}

export async function storeRefresh(userId: string, hash: string, expiresAt: Date): Promise<void> {
  if (useDb()) {
    await query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [userId, hash, expiresAt.toISOString()]);
    return;
  }
  __mem.refresh.set(hash, { user_id: userId, expires_at: expiresAt.toISOString(), revoked_at: null });
}

export async function consumeRefresh(value: string): Promise<{ user_id: string } | null> {
  for (const hash of refreshHashes(value)) {
    const hit = await consumeRefreshByHash(hash);
    if (hit) return hit;
  }
  return null;
}

async function consumeRefreshByHash(hash: string): Promise<{ user_id: string } | null> {
  if (useDb()) {
    const r = await query('SELECT user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash=$1', [hash]);
    const row = r.rows[0];
    if (!row || row.revoked_at) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    return { user_id: row.user_id };
  }
  const rec = __mem.refresh.get(hash);
  if (!rec || rec.revoked_at) return null;
  if (new Date(rec.expires_at).getTime() < Date.now()) return null;
  return { user_id: rec.user_id };
}

/** Thu hồi refresh token (dùng khi rotate hoặc logout). Thu hồi mọi candidate hash (peppered + legacy). */
export async function revokeRefresh(value: string): Promise<void> {
  for (const hash of refreshHashes(value)) {
    if (useDb()) {
      await query('UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [hash]);
    } else {
      const rec = __mem.refresh.get(hash);
      if (rec && !rec.revoked_at) rec.revoked_at = new Date().toISOString();
    }
  }
}

/**
 * Tiêu thụ + thu hồi NGUYÊN TỬ (1 câu lệnh / 1 tick): 2 request song song
 * dùng cùng RT thì chỉ 1 thành công — chống replay tuyệt đối.
 */
export async function consumeAndRevokeRefresh(value: string): Promise<{ user_id: string } | null> {
  for (const hash of refreshHashes(value)) {
    const hit = await consumeAndRevokeByHash(hash);
    if (hit) return hit;
  }
  return null;
}

async function consumeAndRevokeByHash(hash: string): Promise<{ user_id: string } | null> {
  if (useDb()) {
    const r = await query(
      `UPDATE refresh_tokens SET revoked_at=now()
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [hash],
    );
    return r.rows[0] ? { user_id: r.rows[0].user_id } : null;
  }
  const rec = __mem.refresh.get(hash);
  if (!rec || rec.revoked_at) return null;
  if (new Date(rec.expires_at).getTime() < Date.now()) return null;
  rec.revoked_at = new Date().toISOString();
  return { user_id: rec.user_id };
}

/** Lookup owner of a refresh token even if revoked/expired (reuse-detection). */
export async function findRefreshOwner(value: string): Promise<{ user_id: string } | null> {
  for (const hash of refreshHashes(value)) {
    if (useDb()) {
      try {
        const r = await query('SELECT user_id FROM refresh_tokens WHERE token_hash=$1', [hash]);
        if (r.rows[0]) return { user_id: r.rows[0].user_id };
      } catch { /* ignore */ }
    } else {
      const rec = __mem.refresh.get(hash);
      if (rec) return { user_id: rec.user_id };
    }
  }
  return null;
}

/** Thu hồi TẤT CẢ refresh token của user (mất thiết bị). Trả về số token bị thu hồi. */
export async function revokeAllRefresh(userId: string): Promise<number> {
  if (useDb()) {
    const r = await query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL RETURNING id', [userId]);
    return r.rows.length;
  }
  let n = 0;
  for (const rec of __mem.refresh.values()) {
    if (rec.user_id === userId && !rec.revoked_at) {
      rec.revoked_at = new Date().toISOString();
      n++;
    }
  }
  return n;
}

export async function createApiKeyRecord(accountId: string, userId: string | null, name: string, scopes: string[], expiresAt: Date | null): Promise<{ id: string; value: string; prefix: string }> {
  const raw = 'synapsedx_' + randomBytes(24).toString('base64url');
  const prefix = raw.slice(0, 12);
  const hash = hashSecret(raw);
  if (useDb()) {
    const r = await query(
      'INSERT INTO api_keys (account_id, user_id, key_prefix, key_hash, name, scopes, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [accountId, userId, prefix, hash, name, scopes, expiresAt ? expiresAt.toISOString() : null],
    );
    return { id: r.rows[0].id, value: raw, prefix };
  }
  const id = randomUUID();
  __mem.apiKeys.set(hash, { id, account_id: accountId, user_id: userId, key_prefix: prefix, name, scopes, expires_at: expiresAt?.toISOString() || null, revoked_at: null, created_at: new Date().toISOString() });
  return { id, value: raw, prefix };
}

/** Thu hồi API key theo id (trả về false nếu không tồn tại). */
export async function revokeApiKey(id: string): Promise<boolean> {
  if (useDb()) {
    const r = await query('UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id', [id]);
    return r.rows.length > 0;
  }
  for (const rec of __mem.apiKeys.values()) {
    if (rec.id === id && !rec.revoked_at) {
      rec.revoked_at = new Date().toISOString();
      return true;
    }
  }
  return false;
}

/** Lookup by id for tenant-scoped revoke (safe fields only). */
export async function findApiKeyById(id: string): Promise<{ account_id: string } | null> {
  if (useDb()) {
    const r = await query('SELECT account_id FROM api_keys WHERE id=$1', [id]);
    return r.rows[0] || null;
  }
  for (const rec of __mem.apiKeys.values()) {
    if (rec.id === id) return { account_id: rec.account_id };
  }
  return null;
}

/** Safe key listing (id/prefix/metadata only — hashes and secret values NEVER leave the server). */
export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string | null;
}

export async function listApiKeys(accountId: string): Promise<ApiKeyInfo[]> {
  if (useDb()) {
    const r = await query(
      'SELECT id, name, key_prefix AS prefix, scopes, expires_at, revoked_at, created_at FROM api_keys WHERE account_id=$1 ORDER BY created_at DESC LIMIT 500',
      [accountId],
    );
    return r.rows.map((x) => ({
      id: x.id,
      name: x.name,
      prefix: x.prefix,
      scopes: x.scopes || [],
      expires_at: x.expires_at ? new Date(x.expires_at).toISOString() : null,
      revoked_at: x.revoked_at ? new Date(x.revoked_at).toISOString() : null,
      created_at: x.created_at ? new Date(x.created_at).toISOString() : null,
    }));
  }
  return [...__mem.apiKeys.values()]
    .filter((rec) => rec.account_id === accountId)
    .slice(0, 500)
    .map((rec) => ({
      id: rec.id,
      name: rec.name,
      prefix: rec.key_prefix,
      scopes: rec.scopes || [],
      expires_at: rec.expires_at || null,
      revoked_at: rec.revoked_at || null,
      created_at: rec.created_at || null,
    }));
}

export async function verifyApiKey(raw: string): Promise<{ account_id: string; scopes: string[] } | null> {
  if (!raw || typeof raw !== 'string' || raw.length > 512) return null;
  // Thử peppered hash trước, legacy sau (rotation-safe cho key cũ).
  for (const hash of hashCandidates(raw)) {
    const hit = await verifyApiKeyByHash(hash);
    if (hit) return hit;
  }
  return null;
}

async function verifyApiKeyByHash(hash: string): Promise<{ account_id: string; scopes: string[] } | null> {
  if (useDb()) {
    const r = await query('SELECT account_id, scopes, expires_at, revoked_at FROM api_keys WHERE key_hash=$1', [hash]);
    const row = r.rows[0];
    if (!row || row.revoked_at) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    return { account_id: row.account_id, scopes: row.scopes || [] };
  }
  const rec = __mem.apiKeys.get(hash);
  if (!rec || rec.revoked_at) return null;
  if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) return null;
  return { account_id: rec.account_id, scopes: rec.scopes || [] };
}
