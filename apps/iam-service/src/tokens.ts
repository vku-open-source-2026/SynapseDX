/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Token management: JWT access tokens + opaque refresh tokens + API keys.
 */
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { ensureTables, getDb, useDb, __mem, hashSecret, hashCandidates } from './db';
import { apiKeys, refreshTokens } from './schema';

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

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

export async function storeRefresh(userId: string, hash: string, expiresAt: Date): Promise<void> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    await db.insert(refreshTokens).values({ userId, tokenHash: hash, expiresAt });
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
    const db = getDb()!;
    await ensureTables();
    const rows = await db.select({
      userId: refreshTokens.userId,
      expiresAt: refreshTokens.expiresAt,
      revokedAt: refreshTokens.revokedAt,
    }).from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1);
    const row = rows[0];
    if (!row || row.revokedAt) return null;
    if (new Date(row.expiresAt).getTime() < Date.now()) return null;
    return { user_id: row.userId };
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
      const db = getDb()!;
      await ensureTables();
      await db.update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(refreshTokens.tokenHash, hash), isNull(refreshTokens.revokedAt)));
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
    const db = getDb()!;
    await ensureTables();
    const rows = await db.update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(
        eq(refreshTokens.tokenHash, hash),
        isNull(refreshTokens.revokedAt),
        sql`${refreshTokens.expiresAt} > now()`,
      ))
      .returning({ userId: refreshTokens.userId });
    return rows[0] ? { user_id: rows[0].userId } : null;
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
      const db = getDb()!;
      await ensureTables();
      try {
        const rows = await db.select({ userId: refreshTokens.userId })
          .from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1);
        if (rows[0]) return { user_id: rows[0].userId };
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
    const db = getDb()!;
    await ensureTables();
    const rows = await db.update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length;
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
    const db = getDb()!;
    await ensureTables();
    const rows = await db.insert(apiKeys).values({
      accountId,
      userId,
      keyPrefix: prefix,
      keyHash: hash,
      name,
      scopes,
      expiresAt,
    }).returning({ id: apiKeys.id });
    return { id: rows[0].id, value: raw, prefix };
  }
  const id = randomUUID();
  __mem.apiKeys.set(hash, { id, account_id: accountId, user_id: userId, key_prefix: prefix, name, scopes, expires_at: expiresAt?.toISOString() || null, revoked_at: null, created_at: new Date().toISOString() });
  return { id, value: raw, prefix };
}

/** Thu hồi API key theo id (trả về false nếu không tồn tại). */
export async function revokeApiKey(id: string): Promise<boolean> {
  if (useDb()) {
    const db = getDb()!;
    await ensureTables();
    const rows = await db.update(apiKeys)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    return rows.length > 0;
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
    const db = getDb()!;
    await ensureTables();
    const rows = await db.select({ accountId: apiKeys.accountId }).from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    return rows[0] ? { account_id: rows[0].accountId } : null;
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
    const db = getDb()!;
    await ensureTables();
    const rows = await db.select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    }).from(apiKeys)
      .where(eq(apiKeys.accountId, accountId))
      .orderBy(desc(apiKeys.createdAt))
      .limit(500);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes || [],
      expires_at: iso(r.expiresAt),
      revoked_at: iso(r.revokedAt),
      created_at: iso(r.createdAt),
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
    const db = getDb()!;
    await ensureTables();
    const rows = await db.select({
      accountId: apiKeys.accountId,
      scopes: apiKeys.scopes,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
    }).from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
    const row = rows[0];
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) return null;
    return { account_id: row.accountId, scopes: row.scopes || [] };
  }
  const rec = __mem.apiKeys.get(hash);
  if (!rec || rec.revoked_at) return null;
  if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) return null;
  return { account_id: rec.account_id, scopes: rec.scopes || [] };
}
