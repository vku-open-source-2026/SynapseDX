// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import {
  LayoutDashboard,
  Database,
  Table2,
  Scale,
  LayoutGrid,
  CheckCircle2,
  Users,
  Radio,
  ScrollText,
  Settings,
  Menu,
  X,
  Boxes,
  LogOut,
  ExternalLink,
} from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { cn } from '../lib/utils';
import { navigationFor, primaryRole, ROLE_LABELS, type NavItem } from '../lib/rbac';

const ICONS: Record<NavItem['icon'], React.ComponentType<{ size?: number; className?: string }>> = {
  dashboard: LayoutDashboard,
  datasets: Database,
  records: Table2,
  moderation: Scale,
  modules: LayoutGrid,
  approvals: CheckCircle2,
  team: Users,
  events: Radio,
  audit: ScrollText,
  settings: Settings,
};

const PATH_PREFIX: Record<NavItem['view'], string> = {
  overview: '/admin',
  datasets: '/admin/datasets',
  records: '/admin/records',
  moderation: '/admin/moderation',
  approvals: '/admin/approvals',
  modules: '/admin/modules',
  team: '/admin/team',
  events: '/admin/events',
  audit: '/admin/audit',
  settings: '/admin/settings',
};

function initialsOf(email?: string): string {
  const source = (email || 'DX').trim();
  return source.slice(0, 2).toUpperCase();
}

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const { context, session, logout } = useAuthStore();
  const items = navigationFor(context);

  const logoutNow = async () => {
    await logout();
    void navigate({ to: '/login' });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsMobileOpen((value) => !value)}
        aria-label="Toggle navigation"
        className="fixed left-4 top-4 z-[60] rounded-lg bg-slate-900/95 p-2 text-white shadow-lg lg:hidden"
      >
        {isMobileOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      <div
        className={cn(
          'fixed inset-y-0 left-0 z-[55] flex w-[268px] flex-col border-r border-slate-800 bg-slate-900 text-slate-300 transition-transform duration-200',
          'lg:static lg:z-auto lg:flex lg:translate-x-0',
          isMobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        <div className="border-b border-slate-800 px-5 py-5">
          <Link to="/admin" className="flex items-center gap-3" onClick={() => setIsMobileOpen(false)}>
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 text-white shadow-lg shadow-blue-950/40">
              <Boxes size={22} strokeWidth={2.2} />
            </span>
            <span className="leading-tight">
              <span className="block text-[15px] font-bold tracking-tight text-white">SynapseDX</span>
              <span className="block text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                Capability control plane
              </span>
            </span>
          </Link>
        </div>

        <nav id="primary-nav" aria-label="Console sections" className="flex-1 space-y-1 overflow-y-auto px-3 py-3 scrollbar-thin">
          {items.map((item) => {
            const Icon = ICONS[item.icon];
            const to = PATH_PREFIX[item.view];
            const active =
              item.view === 'overview'
                ? location.pathname === '/admin' || location.pathname === '/admin/'
                : location.pathname.startsWith(to);
            return (
              <Link
                key={item.view}
                to={to}
                onClick={() => setIsMobileOpen(false)}
                data-nav={item.view}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  active
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-950/30'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white',
                )}
              >
                <Icon size={17} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {active ? <span className="h-1.5 w-1.5 rounded-full bg-white/80" /> : null}
              </Link>
            );
          })}
          <div className="pt-2">
            <a
              href="/"
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium text-slate-500 transition-colors hover:text-slate-200"
            >
              <ExternalLink size={14} /> Public catalog
            </a>
            <a
              href="https://github.com/vku-open-source-2026/SynapseDX/blob/main/docs/API.md"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium text-slate-500 transition-colors hover:text-slate-200"
            >
              <ExternalLink size={14} /> API reference ↗
            </a>
          </div>
        </nav>

        <div className="border-t border-slate-800 p-3">
          <div className="rounded-xl bg-slate-800/60 p-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-blue-500 to-cyan-400 text-xs font-bold text-white">
                {initialsOf(context?.user?.email)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-white">
                  {context?.user?.email || (session ? 'Signed in' : 'Session')}
                </p>
                <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  {primaryRole(context) ? ROLE_LABELS[primaryRole(context)!] : 'Public'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void logoutNow()}
                aria-label="Sign out"
                title="Sign out"
                className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-700 hover:text-white"
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {isMobileOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-[50] bg-slate-950/50 lg:hidden"
          onClick={() => setIsMobileOpen(false)}
        />
      ) : null}
    </>
  );
}
