/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * OIDC callback page: the IdP redirects here with ?code&state (or ?error).
 * The single-use code is POSTed to the API for exchange — tokens never
 * appear in the URL, so nothing leaks via history or logs.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { Err } from '../components/ui.jsx';

export default function OidcCallback() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { loginWithOidc } = useAuth();
  const [err, setErr] = useState(null);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const idpError = params.get('error');
    if (idpError) {
      setErr(new Error(`Sign-in was not completed (${idpError}${params.get('error_description') ? `: ${params.get('error_description')}` : ''}). Please try again.`));
      return;
    }
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) {
      setErr(new Error('Missing authorization code. Start again from the login page.'));
      return;
    }
    loginWithOidc(code, state).then(
      () => nav('/dashboard', { replace: true }),
      (ex) => setErr(ex),
    );
  }, [params, loginWithOidc, nav]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-md p-8 w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold bg-gradient-to-b from-main-start to-main-end bg-clip-text text-transparent">
          Signing you in…
        </h1>
        <Err e={err} />
        {!err && <p className="text-sm text-normal-text mt-3">Exchanging the sign-in code with the server.</p>}
        {err && (
          <p className="text-sm mt-4">
            <Link to="/login" className="text-main-blue">Back to login</Link>
          </p>
        )}
      </div>
    </div>
  );
}
