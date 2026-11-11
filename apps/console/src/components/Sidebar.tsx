// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import {
  LayoutDashboard,
  Database,
  BarChart3,
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
  LogOut,
  Globe,
  BookOpen,
} from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { cn } from '../lib/utils';
import { navigationFor, primaryRole, type NavItem } from '../lib/rbac';
import { useI18n } from '../lib/i18n-context';
import { API_DOCS } from '../lib/site';
import { BrandMark } from './BrandMark';

const ICONS: Record<NavItem['icon'], React.ComponentType<{ size?: number; className?: string }>> = {
  dashboard: LayoutDashboard,
  datasets: Database,
  warehouse: BarChart3,
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
  warehouse: '/admin/warehouse',
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

const SECONDARY_LINK =
  'flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-slate-400 transition-colors hover:bg-slate-800/70 hover:text-white';

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { m } = useI18n();
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const { context, session, logout } = useAuthStore();
  const items = navigationFor(context);
  const role = primaryRole(context);
  const roleText = role ? (m.shell.roles as Record<string, string>)[role] ?? role : m.shell.publicRole;

  const logoutNow = async () => {
    await logout();
    void navigate({ to: '/login' });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsMobileOpen((value) => !value)}
        aria-label={m.shell.toggleNav}
        aria-expanded={isMobileOpen}
        className="fixed left-3 top-3.5 z-[60] inline-flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white shadow-lg lg:hidden"
      >
        {isMobileOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
      </button>

      <div
        className={cn(
          'fixed inset-y-0 left-0 z-[55] flex w-[264px] flex-col border-r border-slate-800 bg-slate-900 text-slate-300 transition-transform duration-200 dark:border-[#1a2638] dark:bg-[#0b1322]',
          'lg:static lg:z-auto lg:flex lg:translate-x-0',
          isMobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        <div className="flex h-16 items-center border-b border-slate-800 px-5 dark:border-[#1a2638]">
          <Link to="/admin" onClick={() => setIsMobileOpen(false)}>
            <BrandMark onDark />
          </Link>
        </div>

        <nav id="primary-nav" aria-label={m.shell.sections} className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3 scrollbar-thin">
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
                    ? 'bg-gradient-to-r from-cyan-500/90 to-blue-600 text-white shadow-md shadow-blue-950/40'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white',
                )}
              >
                <Icon size={17} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{m.shell.nav[item.view] ?? item.label}</span>
              </Link>
            );
          })}
          <div className="mt-3 border-t border-slate-800 pt-3 dark:border-[#1a2638]">
            <a href="/" className={SECONDARY_LINK}>
              <Globe size={15} aria-hidden="true" /> {m.shell.publicCatalog}
            </a>
            <a href={API_DOCS} target="_blank" rel="noreferrer" className={SECONDARY_LINK}>
              <BookOpen size={15} aria-hidden="true" /> {m.shell.apiRef}
            </a>
          </div>
        </nav>

        <div className="border-t border-slate-800 p-3 dark:border-[#1a2638]">
          <div className="flex items-center gap-2.5 rounded-xl bg-slate-800/60 p-3 dark:bg-[#121d30]">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-cyan-500 to-blue-600 text-xs font-bold text-white">
              {initialsOf(context?.user?.email)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-white">
                {context?.user?.email || (session ? m.shell.signedIn : m.shell.session)}
              </p>
              <p className="truncate text-[11px] font-medium text-slate-400">{roleText}</p>
            </div>
            <button
              type="button"
              onClick={() => void logoutNow()}
              aria-label={m.shell.signOut}
              title={m.shell.signOut}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-700 hover:text-white"
            >
              <LogOut size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {isMobileOpen ? (
        <button
          type="button"
          aria-label={m.shell.closeNav}
          className="fixed inset-0 z-[50] bg-slate-950/50 lg:hidden"
          onClick={() => setIsMobileOpen(false)}
        />
      ) : null}
    </>
  );
}
