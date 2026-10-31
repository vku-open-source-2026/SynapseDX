/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBars, faRightToBracket, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../lib/auth.jsx';
import { appDashboardUrl, appLoginUrl, isCanonicalAppHost } from '../lib/site.js';

const LINKS = [
  { to: '/', label: 'Home' },
  { to: '/api-docs', label: 'API Docs' },
  { to: '/docs', label: 'Docs' },
];

export default function PublicHeader() {
  const [open, setOpen] = useState(false);
  const { auth } = useAuth();
  // Multi-domain: web chinh (@) redirect Dang nhap/Console ve canonical app (cloud.*) theo env.
  const offSite = !isCanonicalAppHost();
  const authHref = auth ? appDashboardUrl() : appLoginUrl();
  const authLabel = auth ? 'Console' : 'Sign in';
  const authMobileLabel = auth ? 'Open Console' : 'Sign in';
  return (
    <header className="fixed z-50 top-0 left-0 w-full bg-white/70 backdrop-blur-md shadow-sm">
      <div className="flex items-center justify-between px-4 mx-auto max-w-6xl h-16">
        <Link
          to="/"
          className="text-xl font-semibold bg-gradient-to-b from-main-start to-main-end bg-clip-text text-transparent"
        >
          synapseone
        </Link>
        <nav className="hidden md:flex items-center gap-1 text-sm">
          {LINKS.map((l) => (
            <Link key={l.to} to={l.to} className="px-3 py-1.5 text-normal-text hover:text-main-blue">
              {l.label}
            </Link>
          ))}
          {offSite ? (
            <a
              href={authHref}
              className="ml-2 px-4 py-1.5 rounded-2xl text-white font-medium bg-gradient-to-b from-main-start to-main-end"
            >
              <FontAwesomeIcon icon={faRightToBracket} className="mr-1" />
              {authLabel}
            </a>
          ) : (
            <Link
              to={auth ? '/dashboard' : '/login'}
              className="ml-2 px-4 py-1.5 rounded-2xl text-white font-medium bg-gradient-to-b from-main-start to-main-end"
            >
              <FontAwesomeIcon icon={faRightToBracket} className="mr-1" />
              {authLabel}
            </Link>
          )}
        </nav>
        <button onClick={() => setOpen(!open)} className="md:hidden text-xl text-normal-text">
          <FontAwesomeIcon icon={open ? faXmark : faBars} />
        </button>
      </div>
      {open && (
        <div className="md:hidden bg-white border-t border-slate-100 px-4 py-2 shadow-md">
          {LINKS.map((l) => (
            <Link key={l.to} to={l.to} onClick={() => setOpen(false)} className="block py-2 text-main-text text-sm">
              {l.label}
            </Link>
          ))}
          {offSite ? (
            <a
              href={authHref}
              onClick={() => setOpen(false)}
              className="block py-2 text-sm font-medium text-main-blue"
            >
              {authMobileLabel}
            </a>
          ) : (
            <Link
              to={auth ? '/dashboard' : '/login'}
              onClick={() => setOpen(false)}
              className="block py-2 text-sm font-medium text-main-blue"
            >
              {authMobileLabel}
            </Link>
          )}
        </div>
      )}
    </header>
  );
}
