/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faHouse,
  faBuilding,
  faBoxes,
  faUsers,
  faUserShield,
  faScroll,
  faKey,
  faRobot,
  faListCheck,
  faFlask,
  faBook,
  faCode,
} from '@fortawesome/free-solid-svg-icons';

const CORE_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: faHouse, match: (p) => p.startsWith('/dashboard') },
  { to: '/orgs', label: 'Organizations', icon: faBuilding, match: (p) => p.startsWith('/orgs') },
  { to: '/accounts', label: 'Accounts', icon: faBoxes, match: (p) => p.startsWith('/accounts') },
  { to: '/users', label: 'Users', icon: faUsers, match: (p) => p.startsWith('/users') },
  { to: '/roles', label: 'Roles', icon: faUserShield, match: (p) => p.startsWith('/roles') },
  { to: '/policies', label: 'Policies', icon: faScroll, match: (p) => p.startsWith('/policies') },
  { to: '/keys', label: 'API Keys', icon: faKey, match: (p) => p.startsWith('/keys') },
  { to: '/service-accounts', label: 'Service Accts', icon: faRobot, match: (p) => p.startsWith('/service-accounts') },
  { to: '/authorize', label: 'Authorize', icon: faFlask, match: (p) => p.startsWith('/authorize') },
  { to: '/audit', label: 'Audit Log', icon: faListCheck, match: (p) => p.startsWith('/audit') },
];

const DOC_ITEMS = [
  { to: '/api-docs', label: 'API Docs', icon: faCode, match: (p) => p.startsWith('/api-docs') },
  { to: '/docs', label: 'Docs', icon: faBook, match: (p) => p.startsWith('/docs') },
];

export default function Sidebar() {
  const { pathname } = useLocation();
  return (
    <aside
      aria-label="Core Navigation"
      className="fixed left-3 xl:left-5 top-0 h-screen w-64 xl:w-72 hidden lg:flex flex-col items-center z-30"
    >
      <Link to="/">
        <h1 className="my-6 mt-8 ml-2 text-2xl font-semibold bg-gradient-to-b from-main-start to-main-end bg-clip-text text-transparent">
          SynapseOne Console
        </h1>
      </Link>
      <nav className="w-full bg-white rounded-3xl py-4 px-3 flex flex-col text-normal-text shadow-md max-h-[82vh] overflow-y-auto">
        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Core Platform
        </div>
        {CORE_ITEMS.map((it) => {
          const active = it.match(pathname);
          return (
            <Link
              key={it.to}
              to={it.to}
              className={`flex items-center px-4 py-2 my-0.5 rounded-2xl text-sm transition-colors ${
                active ? 'text-main-blue bg-main-blue/10 font-medium' : 'hover:bg-background'
              }`}
            >
              <FontAwesomeIcon icon={it.icon} className="mr-3 w-4" />
              {it.label}
            </Link>
          );
        })}

        <div className="my-2 border-t border-slate-100" />

        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Docs &amp; References
        </div>
        {DOC_ITEMS.map((it) => {
          const active = it.match(pathname);
          return (
            <Link
              key={it.to}
              to={it.to}
              className={`flex items-center px-4 py-2 my-0.5 rounded-2xl text-sm transition-colors ${
                active ? 'text-main-blue bg-main-blue/10 font-medium' : 'hover:bg-background'
              }`}
            >
              <FontAwesomeIcon icon={it.icon} className="mr-3 w-4" />
              {it.label}
            </Link>
          );
        })}
      </nav>
      <p className="mt-4 text-xs text-normal-text">Tier-1 PaaS · Apache-2.0</p>
    </aside>
  );
}
