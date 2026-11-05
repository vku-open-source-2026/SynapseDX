// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Session state for the management console, backed by localStorage. */
import { create } from 'zustand';
import {
  clearSession,
  loadSession,
  saveSession,
  setUnauthorizedHandler,
  type StoredSession,
} from '../lib/httpClient';
import { api } from '../lib/api';
import type { ManagementContext } from '../lib/rbac';
import type { LoginResponse } from '../types';

export type AuthStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

interface AuthState {
  session: StoredSession | null;
  context: ManagementContext | null;
  status: AuthStatus;
  error?: string;
  login: (email: string, password: string, orgSlug?: string) => Promise<ManagementContext>;
  fetchContext: () => Promise<ManagementContext | null>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: loadSession(),
  context: null,
  status: 'idle',
  error: undefined,

  login: async (email, password, orgSlug) => {
    const result = await api.post<LoginResponse>('/v1/capabilities/auth/login', {
      email,
      password,
      ...(orgSlug ? { orgSlug } : {}),
    });
    const accessToken = result.accessToken || result.access_token;
    const refreshToken = result.refreshToken || result.refresh_token;
    if (!accessToken) throw new Error('The identity service did not return an access token.');
    const session: StoredSession = {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      obtainedAt: new Date().toISOString(),
    };
    saveSession(session);
    set({ session, status: 'loading', error: undefined });
    const context = await get().fetchContext();
    if (!context) throw new Error('The session could not be verified by the capability service.');
    return context;
  },

  fetchContext: async () => {
    const session = loadSession();
    if (!session) {
      set({ context: null, status: 'idle' });
      return null;
    }
    set({ session, status: 'loading', error: undefined });
    try {
      const context = await api.get<ManagementContext>('/v1/capabilities/management/context');
      set({ context, status: 'ready' });
      return context;
    } catch (error) {
      if ((error as { status?: number }).status === 401) {
        clearSession();
        set({ session: null, context: null, status: 'idle' });
        return null;
      }
      set({ context: null, status: 'unavailable', error: (error as Error).message });
      return null;
    }
  },

  logout: async () => {
    const session = loadSession();
    try {
      if (session?.refreshToken) {
        await api.post('/v1/capabilities/auth/logout', { refreshToken: session.refreshToken });
      }
    } catch {
      // Local logout must still work when the API cannot be reached.
    }
    clearSession();
    set({ session: null, context: null, status: 'idle' });
  },

  logoutAll: async () => {
    const session = loadSession();
    if (!session?.refreshToken) {
      throw new Error('No refresh token is available for this session.');
    }
    await api.post('/v1/capabilities/auth/logout-all', { refreshToken: session.refreshToken });
    clearSession();
    set({ session: null, context: null, status: 'idle' });
  },
}));

setUnauthorizedHandler(() => {
  clearSession();
  useAuthStore.setState({ session: null, context: null, status: 'idle' });
});
