/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBars, faBuilding, faBoxes, faUser, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { useScope } from './Scope.jsx';

const PICK = 'px-2 py-1.5 rounded-2xl border border-slate-200 text-xs bg-white outline-none max-w-36 truncate';

function ScopePicks({ scope, onDone }) {
  return (
    <>
      <span className="inline-flex items-center gap-1 text-normal-text" title="Organization">
        <FontAwesomeIcon icon={faBuilding} size="xs" />
        <select value={scope.orgId} onChange={(e) => { scope.setOrgId(e.target.value); onDone?.(); }} className={PICK}>
          <option value="">Org…</option>
          {scope.orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.slug}
            </option>
          ))}
        </select>
      </span>
      <span className="inline-flex items-center gap-1 text-normal-text" title="Account">
        <FontAwesomeIcon icon={faBoxes} size="xs" />
        <select value={scope.accountId} onChange={(e) => { scope.setAccountId(e.target.value); onDone?.(); }} className={PICK}>
          <option value="">Account…</option>
          {scope.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.slug}
            </option>
          ))}
        </select>
      </span>
    </>
  );
}

export default function Topbar() {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const { auth, headers, logout } = useAuth();
  const scope = useScope();
  const { pathname } = useLocation();
  if (pathname === '/login') return null;

  const logoutAll = async () => {
    setMenu(false);
    try {
      const rt = auth?.refreshToken;
      if (rt) await api.logoutAll(rt);
    } catch {
      /* best-effort — local session clears regardless */
    }
    logout();
  };

  const email = auth?.email || (auth?.apiKey ? 'API key ••••' : '');

  return (
    <>
      <header className="lg:hidden fixed z-50 top-0 left-0 w-full bg-white/80 backdrop-blur-md shadow-sm">
        <div className="flex items-center justify-between px-4 h-14">
          <Link to="/" className="font-semibold bg-gradient-to-b from-main-start to-main-end bg-clip-text text-transparent">
            SynapseDX Console
          </Link>
          <button onClick={() => setOpen(!open)} className="text-xl text-normal-text">
            <FontAwesomeIcon icon={open ? faXmark : faBars} />
          </button>
        </div>
      </header>
      <div className="hidden lg:flex fixed top-0 right-0 p-4 z-40 items-center gap-2">
        <ScopePicks scope={scope} />
        <div className="relative">
          <button
            onClick={() => setMenu(!menu)}
            title={email}
            className="flex items-center gap-2 pl-2 pr-1 py-1 rounded-2xl bg-white shadow-md text-normal-text hover:text-main-blue"
          >
            <span className="text-xs max-w-44 truncate">{email}</span>
            <span className="w-7 h-7 rounded-full bg-background flex items-center justify-center">
              <FontAwesomeIcon icon={faUser} size="xs" />
            </span>
          </button>
          {menu && (
            <div className="absolute right-0 mt-2 w-52 bg-white rounded-2xl shadow-xl p-2 text-sm" onMouseLeave={() => setMenu(false)}>
              <div className="px-3 py-2 text-xs text-normal-text truncate">{email}</div>
              <button onClick={() => { setMenu(false); logout(); }} className="w-full text-left px-3 py-2 rounded-xl hover:bg-background text-main-text">
                Sign out
              </button>
              {auth?.refreshToken && (
                <button onClick={logoutAll} className="w-full text-left px-3 py-2 rounded-xl hover:bg-background text-red-500">
                  Sign out all sessions
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {open && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/30 pt-14" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-b-3xl p-4 mx-3 shadow-md max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex flex-col gap-2 pb-3 mb-2 border-b border-slate-100">
              <ScopePicks scope={scope} onDone={() => setOpen(false)} />
            </div>
            <Link to="/dashboard" onClick={() => setOpen(false)} className="block py-2 text-main-text">
              Dashboard
            </Link>
            {['orgs', 'accounts', 'users', 'roles', 'policies', 'keys', 'service-accounts', 'workflows', 'authorize', 'audit', 'api-docs', 'docs'].map(
              (r) => (
                <Link key={r} to={`/${r}`} onClick={() => setOpen(false)} className="block py-2 text-main-text capitalize">
                  {r.replace('-', ' ')}
                </Link>
              ),
            )}
            <button onClick={() => { logout(); setOpen(false); }} className="block py-2 text-red-500">
              Sign out
            </button>
            {auth?.refreshToken && (
              <button onClick={() => { logoutAll(); setOpen(false); }} className="block py-2 text-red-500">
                Sign out all sessions
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
