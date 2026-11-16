// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Axios client with the stable Tier-2 error envelope and a bearer token hook. */
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';

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
      obtainedAt:
        typeof parsed.obtainedAt === 'string' ? parsed.obtainedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  sessionListener?.(session);
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  sessionListener?.(null);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(
    status: number,
    code: string | undefined,
    message: string | undefined,
    details?: unknown,
    requestId?: string,
  ) {
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
  const axiosError = error as AxiosError<{
    error?: { code?: string; message?: string; details?: unknown; requestId?: string };
  }>;
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

// Refresh uses a separate client: a rejected refresh must never recurse.
httpClient.interceptors.request.use((config) => {
  if (typeof location !== 'undefined' && location.pathname === '/workspace') {
    const product = new URLSearchParams(location.search).get('product');
    if (product === 'city' || product === 'sos') config.headers.set('X-Workspace-App', product);
  }
  return config;
});

export const refreshClient = axios.create({ baseURL: '/', timeout: 15_000 });
let sessionListener: ((session: StoredSession | null) => void) | null = null;
export function setSessionListener(listener: typeof sessionListener): void {
  sessionListener = listener;
}
let refreshFlight: Promise<StoredSession> | null = null;

function rejectSession(): never {
  onUnauthorized?.();
  throw new ApiError(401, 'session_expired', 'Your session has expired. Please sign in again.');
}

export function refreshSession(expectedToken: string): Promise<StoredSession> {
  if (refreshFlight) return refreshFlight;
  const refresh = async (): Promise<StoredSession> => {
    const current = loadSession();
    if (!current) throw new ApiError(401, 'signed_out', 'You have signed out.');
    // A different tab/request may already have rotated the token.
    if (current.accessToken !== expectedToken) return current;
    if (!current.refreshToken) return rejectSession();
    try {
      const { data } = await refreshClient.post('/v1/capabilities/auth/refresh', {
        refreshToken: current.refreshToken,
      });
      const accessToken = data.accessToken || data.access_token;
      const refreshToken = data.refreshToken || data.refresh_token;
      if (
        typeof accessToken !== 'string' ||
        !accessToken ||
        typeof refreshToken !== 'string' ||
        !refreshToken
      ) {
        throw new ApiError(502, 'invalid_refresh_response', 'The session could not be renewed.');
      }
      const latest = loadSession();
      // Never resurrect a logged-out session or overwrite another login.
      if (!latest || latest.refreshToken !== current.refreshToken) {
        throw new ApiError(401, 'session_changed', 'The active session has changed.');
      }
      const next = { ...current, accessToken, refreshToken };
      saveSession(next);
      return next;
    } catch (error) {
      const failure = normalizeError(error);
      if (
        [400, 401, 403].includes(failure.status) &&
        loadSession()?.refreshToken === current.refreshToken
      )
        return rejectSession();
      // Outages and rate limits preserve the refresh token for a later retry.
      throw failure;
    }
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const flight: Promise<StoredSession> = Promise.resolve(
    locks ? locks.request('synapsedx-session-refresh', refresh) : refresh(),
  )
    .then((session) => session)
    .finally(() => {
      refreshFlight = null;
    });
  refreshFlight = flight;
  return flight;
}

function expiresSoon(token: string): boolean {
  try {
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof claims.exp === 'number' && claims.exp * 1000 < Date.now() + 60_000;
  } catch {
    return false;
  }
}

type RetryConfig = InternalAxiosRequestConfig & { sessionRetried?: boolean };
function isAuthRequest(url?: string): boolean {
  return Boolean(url?.startsWith('/v1/capabilities/auth/'));
}
httpClient.interceptors.request.use(async (config) => {
  let session = loadSession();
  if (session?.refreshToken && !isAuthRequest(config.url) && expiresSoon(session.accessToken)) {
    session = await refreshSession(session.accessToken);
  }
  if (session?.accessToken) config.headers.set('authorization', `Bearer ${session.accessToken}`);
  return config;
});

httpClient.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    const normalized = normalizeError(error);
    const config = (error as AxiosError).config as RetryConfig | undefined;
    if (normalized.status === 401 && config && !isAuthRequest(config.url)) {
      if (config.sessionRetried) {
        const sentToken = String(config.headers.get('authorization') || '').replace(/^Bearer /, '');
        if (loadSession()?.accessToken === sentToken) onUnauthorized?.();
      } else {
        const session = loadSession();
        if (session?.refreshToken) {
          const sentToken = String(config.headers.get('authorization') || '').replace(
            /^Bearer /,
            '',
          );
          const renewed = await refreshSession(sentToken);
          config.sessionRetried = true;
          config.headers.set('authorization', `Bearer ${renewed.accessToken}`);
          return httpClient.request(config);
        }
        onUnauthorized?.();
      }
    }
    throw normalized;
  },
);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === SESSION_KEY) sessionListener?.(loadSession());
  });
}
