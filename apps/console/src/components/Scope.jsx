/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';

const ORG_KEY = 'synapseone.console.org';
const ACC_KEY = 'synapseone.console.acc';

const ScopeCtx = createContext(null);

function readStored(key) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. — selection just won't persist */
  }
}

// Single shared scope for the whole console (Google-Cloud-style project
// picker lives in the header; every page reads the same selection, so a
// change in the header instantly re-filters all pages).
export function ScopeProvider({ children }) {
  const { headers } = useAuth();
  const [orgs, setOrgs] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [orgId, setOrgIdRaw] = useState(() => readStored(ORG_KEY));
  const [accountId, setAccountIdRaw] = useState(() => readStored(ACC_KEY));
  const [scopeErr, setScopeErr] = useState(null);
  const seq = useRef(0);

  const setOrgId = (id) => {
    writeStored(ORG_KEY, id);
    setOrgIdRaw(id);
  };
  const setAccountId = (id) => {
    writeStored(ACC_KEY, id);
    setAccountIdRaw(id);
  };

  useEffect(() => {
    let live = true;
    setScopeErr(null);
    api
      .orgs(headers)
      .then((v) => {
        if (live) setOrgs(Array.isArray(v) ? v : []);
      })
      .catch((e) => {
        if (live) {
          setOrgs([]);
          setScopeErr(e);
        }
      });
    return () => {
      live = false;
    };
  }, [headers]);

  useEffect(() => {
    if (!orgId) {
      setAccounts([]);
      return;
    }
    const my = ++seq.current;
    let live = true;
    api
      .accounts(orgId, headers)
      .then((v) => {
        if (live && seq.current === my) setAccounts(Array.isArray(v) ? v : []);
      })
      .catch((e) => {
        if (live && seq.current === my) {
          setAccounts([]);
          setScopeErr(e);
        }
      });
    return () => {
      live = false;
    };
  }, [orgId, headers]);

  // Stored selection may point at a deleted org/account — fall back to first.
  useEffect(() => {
    if (orgs.length && !orgs.find((o) => o.id === orgId)) setOrgId(orgs[0].id);
  }, [orgs]);
  useEffect(() => {
    if (accounts.length && !accounts.find((a) => a.id === accountId)) setAccountId(accounts[0].id);
  }, [accounts]);

  return (
    <ScopeCtx.Provider value={{ orgs, accounts, orgId, setOrgId, accountId, setAccountId, scopeErr }}>
      {children}
    </ScopeCtx.Provider>
  );
}

export function useScope() {
  const v = useContext(ScopeCtx);
  if (!v) throw new Error('useScope must be used inside <ScopeProvider>');
  return v;
}

export function ScopeBar({ scope, showAccount = true }) {
  const sel = 'px-3 py-2 rounded-2xl border border-slate-200 text-sm bg-white outline-none';
  return (
    <div className="flex flex-wrap gap-2 mb-4">
      <select value={scope.orgId} onChange={(e) => scope.setOrgId(e.target.value)} className={sel}>
        <option value="">— Organization —</option>
        {scope.orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.slug}
          </option>
        ))}
      </select>
      {showAccount && (
        <select value={scope.accountId} onChange={(e) => scope.setAccountId(e.target.value)} className={sel}>
          <option value="">— Account —</option>
          {scope.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.slug}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
