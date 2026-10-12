/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, authStore } from './api.js';

const AuthCtx = createContext(null);
// NOTE(security): session lives in localStorage so a reload keeps you logged in.
// That makes it readable by any JS on this origin — keep the console origin clean
// (strict CSP at the reverse proxy, patched deps) and prefer short JWT TTL +
// refresh rotation. Never put tokens in URLs (they leak via history/logs).
const KEY = 'synapsedx.console.auth';

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (auth) localStorage.setItem(KEY, JSON.stringify(auth));
    else localStorage.removeItem(KEY);
  }, [auth]);

  // Wire the api-level session hook: silent refresh persists the rotated pair,
  // dead refresh drops the session (pages re-render to login).
  useEffect(() => {
    authStore.get = () => {
      try {
        return JSON.parse(localStorage.getItem(KEY) || 'null');
      } catch {
        return null;
      }
    };
    authStore.set = (patch) => {
      const cur = authStore.get() || {};
      const next = { ...cur, ...patch };
      localStorage.setItem(KEY, JSON.stringify(next));
      setAuth(next);
    };
    authStore.clear = () => setAuth(null);
  }, []);

  const headers = useMemo(
    () => (auth?.token ? { token: auth.token } : auth?.apiKey ? { apiKey: auth.apiKey } : {}),
    [auth],
  );

  const login = useCallback(async (email, orgSlug) => {
    const r = await api.login(email, orgSlug || 'acme');
    setAuth({ token: r.accessToken, refreshToken: r.refreshToken, user: r.user, email: r.user?.email });
    return r;
  }, []);

  const loginWithKey = useCallback((apiKey) => setAuth({ apiKey }), []);
  // Server-side logout: revoke the refresh token so it can't be reused after
  // the browser session is gone (best-effort — local state clears regardless).
  const logout = useCallback(() => {
    const rt = auth?.refreshToken;
    setAuth(null);
    if (rt) api.logoutServer(rt);
  }, [auth?.refreshToken]);

  return (
    <AuthCtx.Provider value={{ auth, headers, login, loginWithKey, logout, setAuth }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
