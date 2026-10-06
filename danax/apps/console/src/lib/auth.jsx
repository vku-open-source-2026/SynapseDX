import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const AuthCtx = createContext(null);
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
  const logout = useCallback(() => setAuth(null), []);

  return (
    <AuthCtx.Provider value={{ auth, headers, login, loginWithKey, logout, setAuth }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
