/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBars, faXmark, faRightFromBracket } from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';

export default function Topbar() {
  const [open, setOpen] = useState(false);
  const { auth, logout } = useAuth();
  const { pathname } = useLocation();
  if (pathname === '/login') return null;

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
      <div className="hidden lg:flex fixed top-0 right-0 p-4 z-40 items-center gap-3">
        <span className="text-xs text-normal-text max-w-56 truncate">{auth?.email || auth?.apiKey?.slice(0, 16) || ''}</span>
        <button
          onClick={logout}
          title="Sign out"
          className="w-9 h-9 rounded-full bg-white shadow-md text-normal-text hover:text-red-500"
        >
          <FontAwesomeIcon icon={faRightFromBracket} />
        </button>
      </div>
      {open && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/30 pt-14" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-b-3xl p-4 mx-3 shadow-md" onClick={(e) => e.stopPropagation()}>
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
          </div>
        </div>
      )}
    </>
  );
}
