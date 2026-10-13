/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { api, baseUrl } from '../lib/api.js';
import { Btn, Err, Field, Input } from '../components/ui.jsx';

export default function Login() {
  const [email, setEmail] = useState('demo@acme.local');
  const [org, setOrg] = useState('acme');
  const [apiKey, setApiKey] = useState('');
  const [mode, setMode] = useState('email');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const { auth, login, loginWithKey } = useAuth();
  const nav = useNavigate();

  if (auth) return <Navigate to="/dashboard" replace />;

  const submitSso = async () => {
    setErr(null);
    setBusy(true);
    try {
      const start = await api.oidcStart(org || 'acme');
      window.location.href = start.authorizeUrl;
    } catch (ex) {
      setErr(ex);
      setBusy(false);
    }
  };
  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === 'email') await login(email, org || 'acme');
      else {
        if (!apiKey) throw new Error('Enter an API key');
        loginWithKey(apiKey);
      }
      nav('/dashboard', { replace: true });
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-md p-8 w-full max-w-md">
        <h1 className="text-3xl font-semibold text-center bg-gradient-to-b from-main-start to-main-end bg-clip-text text-transparent">
          SynapseDX Console
        </h1>
        <p className="text-center text-normal-text text-sm mt-2 mb-6">
          Tier-1 PaaS admin · Gateway <span className="text-main-blue">{baseUrl()}</span>
        </p>
        <div className="flex gap-2 mb-5">
          {['email', 'apikey'].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 py-2 rounded-2xl text-sm font-medium ${
                mode === m ? 'bg-gradient-to-b from-main-start to-main-end text-white' : 'bg-background text-normal-text'
              }`}
            >
              {m === 'email' ? 'Email (dev/OIDC)' : 'API Key'}
            </button>
          ))}
        </div>
        <Err e={err} />
        <form onSubmit={submit}>
          {mode === 'email' ? (
            <>
              <Field label="Email">
                <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="demo@acme.local" />
              </Field>
              <Field label="Organization slug">
                <Input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="acme" />
              </Field>
            </>
          ) : (
            <Field label="X-API-Key (synapsedx_...)">
              <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="synapsedx_..." />
            </Field>
          )}
          <Btn type="submit" disabled={busy} className="w-full">
            <span className="block w-full text-center">{busy ? 'Signing in…' : 'Sign in'}</span>
          </Btn>
        </form>
        <div className="flex items-center gap-3 my-4">
          <div className="flex-1 h-px bg-slate-200" />
          <span className="text-xs text-normal-text">or</span>
          <div className="flex-1 h-px bg-slate-200" />
        </div>
        <button
          type="button"
          onClick={submitSso}
          disabled={busy}
          className="w-full py-2.5 rounded-2xl text-sm font-medium bg-background text-main-text disabled:opacity-50"
        >
          {busy ? 'Redirecting…' : 'Continue with SSO'}
        </button>
        <p className="text-xs text-normal-text mt-4 text-center">
          Email sign-in is for development · Production uses SSO (Authentik/Keycloak) or API keys.
          <br />
          <Link to="/welcome" className="text-main-blue">About synapsedx</Link>
          {' · '}
          <Link to="/api-docs" className="text-main-blue">API Docs</Link>
        </p>
      </div>
    </div>
  );
}
