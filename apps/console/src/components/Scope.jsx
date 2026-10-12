/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';

const ORG_KEY = 'synapsedx.console.org';
const ACC_KEY = 'synapsedx.console.acc';

export function useScope() {
  const { headers } = useAuth();
  const [orgs, setOrgs] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [orgId, setOrgId] = useState(() => localStorage.getItem(ORG_KEY) || '');
  const [accountId, setAccountId] = useState(() => localStorage.getItem(ACC_KEY) || '');

  useEffect(() => {
    api.orgs(headers).then(setOrgs).catch(() => undefined);
  }, [headers]);

  useEffect(() => {
    if (!orgId) {
      setAccounts([]);
      return;
    }
    localStorage.setItem(ORG_KEY, orgId);
    api.accounts(orgId, headers).then(setAccounts).catch(() => undefined);
  }, [orgId, headers]);

  useEffect(() => {
    if (accountId) localStorage.setItem(ACC_KEY, accountId);
  }, [accountId]);

  useEffect(() => {
    if (orgs.length && !orgs.find((o) => o.id === orgId)) setOrgId(orgs[0].id);
  }, [orgs]);

  useEffect(() => {
    if (accounts.length && !accounts.find((a) => a.id === accountId)) setAccountId(accounts[0].id);
  }, [accounts]);

  return { orgs, accounts, orgId, setOrgId, accountId, setAccountId };
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
