// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
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
  PanelLeftClose,
  PanelLeftOpen,
  X,
  LogOut,
  Globe,
  BookOpen,
  LayoutTemplate,
  Workflow,
  Briefcase,
} from "lucide-react";
import { useAuthStore } from "../stores/authStore";
import { cn } from "../lib/utils";
import { navigationFor, primaryRole, type NavItem } from "../lib/rbac";
import { useI18n } from "../lib/i18n-context";
import { BrandMark } from "./BrandMark";

const ICONS: Record<
  NavItem["icon"],
  React.ComponentType<{ size?: number; className?: string }>
> = {
  dashboard: LayoutDashboard,
  datasets: Database,
  warehouse: BarChart3,
  records: Table2,
  moderation: Scale,
  modules: LayoutGrid,
  approvals: CheckCircle2,
  team: Users,
  events: Radio,
  workspaces: LayoutTemplate,
  workflows: Workflow,
  audit: ScrollText,
  settings: Settings,
};

const PATH_PREFIX: Record<NavItem["view"], string> = {
  overview: "/admin",
  datasets: "/admin/datasets",
  warehouse: "/admin/warehouse",
  records: "/admin/records",
  moderation: "/admin/moderation",
  approvals: "/admin/approvals",
  modules: "/admin/modules",
  team: "/admin/team",
  events: "/admin/events",
  workspaces: "/admin/workspaces",
  workflows: "/admin/workflows",
  audit: "/admin/audit",
  settings: "/admin/settings",
};

function initialsOf(email?: string): string {
  const source = (email || "DX").trim();
  return source.slice(0, 2).toUpperCase();
}

const SECONDARY_LINK =
  "flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-slate-400 transition-colors hover:bg-slate-800/70 hover:text-white";

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { m } = useI18n();
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return (
        localStorage.getItem("synapsedx.admin.sidebar-collapsed") === "true"
      );
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "synapsedx.admin.sidebar-collapsed",
        String(collapsed),
      );
    } catch {
      /* Navigation still works when browser storage is unavailable. */
    }
  }, [collapsed]);
  const labelClass = collapsed ? "lg:sr-only" : undefined;
  const secondaryClass = cn(
    SECONDARY_LINK,
    collapsed && "lg:justify-center lg:px-0",
  );
  const { context, session, logout } = useAuthStore();
  const items = navigationFor(context);
  const role = primaryRole(context);
  const roleText = role
    ? ((m.shell.roles as Record<string, string>)[role] ?? role)
    : m.shell.publicRole;

  const logoutNow = async () => {
    await logout();
    void navigate({ to: "/login" });
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
        {isMobileOpen ? (
          <X size={20} aria-hidden="true" />
        ) : (
          <Menu size={20} aria-hidden="true" />
        )}
      </button>

      <div
        id="admin-sidebar"
        data-collapsed={collapsed}
        className={cn(
          "fixed inset-y-0 left-0 z-[55] flex w-[264px] shrink-0 flex-col border-r border-slate-800 bg-slate-900 text-slate-300 transition-[width,transform] duration-200 motion-reduce:transition-none dark:border-[#1a2638] dark:bg-[#0b1322]",
          "lg:static lg:z-auto lg:flex lg:translate-x-0",
          collapsed ? "lg:w-[72px]" : "lg:w-[264px]",
          isMobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        <div
          className={cn(
            "flex h-16 shrink-0 items-center border-b border-slate-800 px-5 dark:border-[#1a2638]",
            collapsed && "lg:px-[18px]",
          )}
        >
          <Link to="/admin" onClick={() => setIsMobileOpen(false)}>
            <BrandMark onDark wordmarkClassName={labelClass} />
          </Link>
        </div>

        <div className="hidden shrink-0 px-3 pt-2 lg:block">
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? m.shell.expandNav : m.shell.collapseNav}
            title={collapsed ? m.shell.expandNav : m.shell.collapseNav}
            aria-expanded={!collapsed}
            aria-controls="primary-nav"
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium text-slate-400 hover:bg-slate-800/70 hover:text-white",
              collapsed && "justify-center px-0",
            )}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
            <span className={labelClass}>{m.shell.collapseNav}</span>
          </button>
        </div>

        <nav
          id="primary-nav"
          aria-label={m.shell.sections}
          className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3 scrollbar-thin"
        >
          {items.map((item) => {
            const Icon = ICONS[item.icon];
            const to = item.href ?? PATH_PREFIX[item.view];
            const active =
              item.view === "overview"
                ? location.pathname === "/admin" ||
                  location.pathname === "/admin/"
                : location.pathname.startsWith(to);
            const content = (
              <>
                <Icon size={17} className="shrink-0" />
                <span className={cn("min-w-0 flex-1 truncate", labelClass)}>
                  {m.shell.nav[item.view] ?? item.label}
                </span>
              </>
            );
            const className = cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              collapsed && "lg:justify-center lg:px-0",
              active
                ? "bg-gradient-to-r from-cyan-500/90 to-blue-600 text-white shadow-md shadow-blue-950/40"
                : "text-slate-300 hover:bg-slate-800/70 hover:text-white",
            );
            return item.href ? (
              <a
                key={item.view}
                href={item.href}
                onClick={() => setIsMobileOpen(false)}
                title={m.shell.nav[item.view] ?? item.label}
                aria-label={m.shell.nav[item.view] ?? item.label}
                data-nav={item.view}
                aria-current={active ? "page" : undefined}
                className={className}
              >
                {content}
              </a>
            ) : (
              <Link
                key={item.view}
                to={to}
                onClick={() => setIsMobileOpen(false)}
                title={m.shell.nav[item.view] ?? item.label}
                aria-label={m.shell.nav[item.view] ?? item.label}
                data-nav={item.view}
                aria-current={active ? "page" : undefined}
                className={className}
              >
                {content}
              </Link>
            );
          })}
          <div className="mt-3 border-t border-slate-800 pt-3 dark:border-[#1a2638]">
            <a
              href="/workspace"
              className={secondaryClass}
              aria-label={m.shell.workspaceLink}
              title={m.shell.workspaceLink}
            >
              <Briefcase size={15} className="shrink-0" aria-hidden="true" />{" "}
              <span className={labelClass}>{m.shell.workspaceLink}</span>
            </a>
            <a
              href="/"
              className={secondaryClass}
              aria-label={m.shell.publicCatalog}
              title={m.shell.publicCatalog}
            >
              <Globe size={15} className="shrink-0" aria-hidden="true" />{" "}
              <span className={labelClass}>{m.shell.publicCatalog}</span>
            </a>
            <a
              href="/docs"
              className={secondaryClass}
              aria-label={m.shell.apiRef}
              title={m.shell.apiRef}
            >
              <BookOpen size={15} className="shrink-0" aria-hidden="true" />{" "}
              <span className={labelClass}>{m.shell.apiRef}</span>
            </a>
          </div>
        </nav>

        <div className="border-t border-slate-800 p-3 dark:border-[#1a2638]">
          <div
            className={cn(
              "flex items-center gap-2.5 rounded-xl bg-slate-800/60 p-3 dark:bg-[#121d30]",
              collapsed && "lg:flex-col lg:gap-2 lg:p-1",
            )}
          >
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-cyan-500 to-blue-600 text-xs font-bold text-white"
              title={context?.user?.email}
            >
              {initialsOf(context?.user?.email)}
            </div>
            <div className={cn("min-w-0 flex-1", collapsed && "lg:hidden")}>
              <p className="truncate text-xs font-semibold text-white">
                {context?.user?.email ||
                  (session ? m.shell.signedIn : m.shell.session)}
              </p>
              <p className="truncate text-[11px] font-medium text-slate-400">
                {roleText}
              </p>
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
