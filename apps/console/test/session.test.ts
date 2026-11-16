// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import {
  clearSession,
  httpClient,
  loadSession,
  refreshClient,
  saveSession,
  setUnauthorizedHandler,
} from '../src/lib/httpClient';
const response = (config: InternalAxiosRequestConfig, data: unknown, status = 200) => ({
  config,
  data,
  status,
  statusText: '',
  headers: {},
});
const reject = (config: InternalAxiosRequestConfig, status: number) =>
  Promise.reject(
    new AxiosError('Rejected', undefined, config, undefined, response(config, {}, status)),
  );
let unauthorized = vi.fn();
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  unauthorized = vi.fn(() => clearSession());
  setUnauthorizedHandler(unauthorized);
  saveSession({ accessToken: 'old', refreshToken: 'refresh-old', obtainedAt: '2026-11-01' });
});
describe('persistent refreshing session', () => {
  it('coalesces concurrent 401s, rotates both tokens, and preserves the workspace scope', async () => {
    const refresh = vi.fn(async (config: InternalAxiosRequestConfig) =>
      response(config, { accessToken: 'new', refreshToken: 'refresh-new' }),
    );
    refreshClient.defaults.adapter = refresh;
    httpClient.defaults.adapter = async (config) =>
      config.headers.get('authorization') === 'Bearer new'
        ? response(config, { ok: true })
        : reject(config, 401);
    await Promise.all([
      httpClient.get('/v1/data'),
      httpClient.get('/v1/data'),
      httpClient.get('/v1/data'),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(loadSession()).toEqual({
      accessToken: 'new',
      refreshToken: 'refresh-new',
      obtainedAt: '2026-11-01',
    });
    expect(unauthorized).not.toHaveBeenCalled();
  });
  it('refreshes an expired JWT before making the protected request', async () => {
    saveSession({
      ...loadSession()!,
      accessToken: `e30.${btoa(JSON.stringify({ exp: 1 }))}.signature`,
    });
    refreshClient.defaults.adapter = async (config) =>
      response(config, { access_token: 'new', refresh_token: 'new-refresh' });
    const request = vi.fn(async (config: InternalAxiosRequestConfig) => response(config, {}));
    httpClient.defaults.adapter = request;
    await httpClient.get('/v1/data');
    expect(request.mock.calls[0][0].headers.get('authorization')).toBe('Bearer new');
  });
  it('keeps a usable refresh token through a temporary upstream outage', async () => {
    refreshClient.defaults.adapter = (config) => reject(config, 503);
    httpClient.defaults.adapter = (config) => reject(config, 401);
    await expect(httpClient.get('/v1/data')).rejects.toMatchObject({ status: 503 });
    expect(loadSession()?.refreshToken).toBe('refresh-old');
    expect(unauthorized).not.toHaveBeenCalled();
  });
  it('clears a rejected refresh and does not loop after a rejected retry', async () => {
    refreshClient.defaults.adapter = (config) => reject(config, 401);
    httpClient.defaults.adapter = (config) => reject(config, 401);
    await expect(httpClient.get('/v1/data')).rejects.toMatchObject({ status: 401 });
    expect(loadSession()).toBeNull();
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
  it('does not resurrect a session after sign-out during refresh', async () => {
    refreshClient.defaults.adapter = async (config) => {
      clearSession();
      return response(config, { accessToken: 'new', refreshToken: 'rotated' });
    };
    httpClient.defaults.adapter = (config) => reject(config, 401);
    await expect(httpClient.get('/v1/data')).rejects.toMatchObject({ code: 'session_changed' });
    expect(loadSession()).toBeNull();
  });
  it('does not run refresh for failed login credentials', async () => {
    const refresh = vi.fn();
    refreshClient.defaults.adapter = refresh;
    httpClient.defaults.adapter = (config) => reject(config, 401);
    await expect(httpClient.post('/v1/capabilities/auth/login', {})).rejects.toMatchObject({
      status: 401,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(unauthorized).not.toHaveBeenCalled();
  });
});
