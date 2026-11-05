// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Axios client with the stable Tier-2 error envelope and a bearer token hook. */
import axios, { AxiosError } from 'axios';

export const SESSION_KEY = 'synapsedx.console.session.v1';

export interface StoredSession {
  accessToken: string;
  refreshToken?: string;
  obtainedAt: string;
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null;
    return {
      accessToken: parsed.accessToken,
      ...(parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
      obtainedAt: typeof parsed.obtainedAt === 'string' ? parsed.obtainedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, code: string | undefined, message: string | undefined, details?: unknown, requestId?: string) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'request_failed';
    this.details = details;
    this.requestId = requestId;
  }
}

function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const axiosError = error as AxiosError<{ error?: { code?: string; message?: string; details?: unknown; requestId?: string } }>;
  const response = axiosError?.response;
  if (!response) {
    return new ApiError(0, 'network_error', 'the control plane is unreachable');
  }
  const envelope = response.data?.error;
  return new ApiError(
    response.status,
    envelope?.code,
    envelope?.message || response.statusText,
    envelope?.details,
    envelope?.requestId || (response.headers?.['x-request-id'] as string | undefined),
  );
}

export const httpClient = axios.create({
  baseURL: '/',
  headers: { accept: 'application/json' },
});

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

httpClient.interceptors.request.use((config) => {
  const session = loadSession();
  if (session?.accessToken) {
    config.headers.set('authorization', `Bearer ${session.accessToken}`);
  }
  return config;
});

httpClient.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    const normalized = normalizeError(error);
    if (normalized.status === 401 && onUnauthorized) onUnauthorized();
    return Promise.reject(normalized);
  },
);
