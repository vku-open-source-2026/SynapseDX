// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Query-parameter parsing and pagination envelopes. */
import { Request } from 'express';
import { apiError } from './errors';

export interface Pagination {
  limit: number;
  offset: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
}

function single(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
  return value === undefined || value === null ? undefined : String(value);
}

function integerParam(value: string | undefined, name: 'limit' | 'offset', fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d{1,9}$/.test(value)) {
    throw apiError(400, name === 'limit' ? 'invalid_limit' : 'invalid_offset', `${name} must be a non-negative integer`);
  }
  return Number(value);
}

/** Reject invalid pagination instead of silently clamping it. */
export function parsePagination(req: Request, maxPageSize: number): Pagination {
  const limit = integerParam(single(req.query.limit), 'limit', 100);
  const offset = integerParam(single(req.query.offset), 'offset', 0);
  const cursor = single(req.query.cursor);
  if (limit < 1 || limit > maxPageSize) {
    throw apiError(400, 'invalid_limit', `limit must be an integer 1..${maxPageSize}`, { max: maxPageSize });
  }
  if (offset < 0) throw apiError(400, 'invalid_offset', 'offset must be >= 0');
  if (cursor && offset > 0) {
    throw apiError(400, 'pagination_both_offset_and_cursor', 'use either cursor or offset, not both');
  }
  if (cursor !== undefined && cursor !== '' && !/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    throw apiError(400, 'invalid_cursor', 'cursor is not valid');
  }
  return { limit, offset, ...(cursor ? { cursor } : {}) };
}

export function booleanParam(value: unknown): boolean | undefined {
  const raw = single(value);
  if (raw === undefined || raw === '') return undefined;
  if (/^(true|1)$/i.test(raw)) return true;
  if (/^(false|0)$/i.test(raw)) return false;
  throw apiError(400, 'invalid_request', 'expected a boolean query parameter');
}

export function stringParam(value: unknown, maxLength = 200): string | undefined {
  const raw = single(value);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

export function page<T>(items: T[], total: number, pagination: Pagination, nextCursor: string | null = null): Page<T> {
  return { items, total, limit: pagination.limit, offset: pagination.offset, nextCursor };
}

export function setPageHeaders(
  res: import('express').Response,
  value: { total: number; limit: number; offset: number; nextCursor?: string | null },
): void {
  res.setHeader('x-total-count', String(value.total));
  res.setHeader('x-limit', String(value.limit));
  res.setHeader('x-offset', String(value.offset));
  if (value.nextCursor) res.setHeader('x-next-cursor', value.nextCursor);
}
