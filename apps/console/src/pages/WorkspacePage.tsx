// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Building2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Compass,
  FileText,
  LayoutGrid,
  LogOut,
  Menu,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { BrandMark } from "../components/BrandMark";
import { SiteToggles } from "../components/SiteToggles";
import { Toaster } from "../components/Toaster";
import { WorkspaceNavigation } from "../components/workspaces/WorkspaceNavigation";
import { OperationalPage } from "../components/workspaces/OperationalPage";
import {
  CapabilityModule,
  MODULE_CATALOG,
} from "../components/workspaces/CapabilityModule";
import { Card, EmptyState, Skeleton } from "../components/ui";
import { useAuthStore } from "../stores/authStore";
import { fetchInstalled, fetchWorkspaceAccess } from "../lib/workspacesApi";
import { cn } from "../lib/utils";

const APPS = {
  city: {
    name: "SynapseCity",
    label: "Infrastructure operations",
    short: "C",
    color: "bg-teal-500",
    ink: "text-teal-600",
    intro: "A city that keeps moving.",
    description:
      "Infrastructure, field work and the people who keep it running.",
  },
  sos: {
    name: "SynapseCity SOS",
    label: "Emergency operations",
    short: "S",
    color: "bg-orange-500",
    ink: "text-orange-600",
    intro: "Every decision, coordinated.",
    description:
      "A shared operational picture for your emergency response team.",
  },
};
export function WorkspacePage() {
  const navigate = useNavigate(),
    search = useSearch({ from: "/workspace" });
  const session = useAuthStore((state) => state.session),
    context = useAuthStore((state) => state.context),
    fetchContext = useAuthStore((state) => state.fetchContext),
    logout = useAuthStore((state) => state.logout);
  const [mobile, setMobile] = useState(false),
    [switcher, setSwitcher] = useState(false);
  const scope = session?.obtainedAt || "anonymous";
  const access = useQuery({
    queryKey: ["workspace-access", scope],
    queryFn: fetchWorkspaceAccess,
    enabled: !!session,
    retry: false,
    staleTime: 0,
  });
  const installed = useQuery({
    queryKey: ["workspace-installed", scope],
    queryFn: fetchInstalled,
    enabled:
      !!session &&
      !!access.data?.products.some(
        (product) => product === "city" || product === "sos",
      ),
    retry: false,
  });
  useEffect(() => {
    if (session && !context) void fetchContext();
  }, [session?.obtainedAt]);
  const apps = (access.data?.products || []).filter(
    (app): app is "city" | "sos" => app === "city" || app === "sos",
  );
  const app =
    search.product === "city" || search.product === "sos"
      ? search.product
      : apps[0];
  const granted = !!app && apps.includes(app);
  const pages = (installed.data || []).filter((page) => page.product === app);
  const common = pages.find((page) => page.slug === `${app}-common-workspace`);
  const page = search.page
    ? pages.find((page) => page.slug === search.page)
    : pages.find((page) =>
        /operations-overview|command-overview/.test(page.slug),
      );
  const isCommon = page?.id === common?.id;
  const modules = MODULE_CATALOG.filter(
    (module) =>
      access.data?.modules.includes(module.id) &&
      common?.widgets.some(
        (widget) =>
          widget.module === module.id ||
          widget.links?.some(
            (link) =>
              link.target === `module:${module.id}` ||
              link.target === `section:${module.id}`,
          ),
      ),
  );
  const selectedModule = isCommon
    ? modules.find((module) => module.id === (search.section || search.module))
    : undefined;
  const theme = app ? APPS[app] : APPS.city;
  const go = (product: "city" | "sos", slug?: string, module?: string) => {
    setMobile(false);
    setSwitcher(false);
    void navigate({
      to: "/workspace",
      search: { product, page: slug, module, section: module },
    });
  };
  useEffect(() => {
    if (search.product !== app && app && granted)
      go(app, search.page, search.section || search.module);
  }, [search.product, app, granted]);
  if (access.isLoading || (granted && installed.isLoading))
    return (
      <main className="mx-auto max-w-6xl space-y-4 p-8">
        <Skeleton className="h-16 w-64" />
        <Skeleton className="h-96 w-full" />
      </main>
    );
  if (access.isError)
    return (
      <main className="mx-auto max-w-2xl p-8">
        <EmptyState
          title="Workspace unavailable"
          message={access.error.message}
        />
        <button
          className="mt-4 text-sm text-teal-600"
          onClick={() => void access.refetch()}
        >
          Try again
        </button>
      </main>
    );
  if (!granted)
    return (
      <main className="mx-auto mt-20 max-w-xl p-8">
        <ShieldCheck className="mb-4 text-teal-600" size={30} />
        <h1 className="text-2xl font-semibold">App access required</h1>
        <p className="mt-3 text-sm leading-6 text-dx-muted">
          Your account has no membership in this app. Ask your organization
          administrator to grant access to the correct app.
        </p>
        <div className="mt-5 flex gap-3">
          {apps.map((item) => (
            <button
              key={item}
              onClick={() => go(item)}
              className="rounded-lg border border-dx-line px-4 py-2 text-sm"
            >
              Open {APPS[item].name}
            </button>
          ))}
          <button
            onClick={() => void logout().then(() => navigate({ to: "/login" }))}
            className="text-sm text-dx-muted"
          >
            Sign out
          </button>
        </div>
      </main>
    );
  return (
    <div className="flex min-h-screen bg-[#f5f7f9] text-dx-fg dark:bg-dx-bg">
      {mobile ? (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-slate-950/50 lg:hidden"
          onClick={() => setMobile(false)}
        />
      ) : null}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[248px] flex-col border-r border-dx-line bg-dx-surface lg:sticky lg:top-0 lg:h-screen lg:shrink-0",
          mobile ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        <div className="flex h-[76px] items-center justify-between px-6">
          <BrandMark />
          <button
            aria-label="Close navigation"
            className="lg:hidden"
            onClick={() => setMobile(false)}
          >
            <X size={18} />
          </button>
        </div>
        <div className="relative px-3">
          <button
            onClick={() => setSwitcher(!switcher)}
            aria-expanded={switcher}
            className="flex w-full items-center gap-3 rounded-xl border border-dx-line bg-dx-subtle/60 p-3 text-left"
          >
            <span
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-xl text-base font-bold text-white",
                theme.color,
              )}
            >
              {theme.short}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold">{theme.name}</span>
              <span className="mt-1 block text-[10px] text-dx-muted">
                {theme.label}
              </span>
            </span>
            {apps.length > 1 ? <ChevronDown size={14} /> : null}
          </button>
          {switcher && apps.length > 1 ? (
            <div className="absolute left-3 right-3 top-full z-10 mt-1 rounded-xl border border-dx-line bg-dx-surface p-2 shadow-lg">
              {apps.map((item) => (
                <button
                  key={item}
                  className="block w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-dx-subtle"
                  onClick={() => go(item)}
                >
                  {APPS[item].name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <nav
          aria-label="App navigation"
          className="mt-6 flex-1 space-y-1 overflow-y-auto px-3"
        >
          <p className="px-3 pb-2 text-[9px] font-semibold uppercase tracking-[.18em] text-dx-muted">
            Operations
          </p>
          <button
            onClick={() => go(app)}
            className={cn(
              "workspace-nav-item",
              !search.page && "workspace-nav-active",
            )}
          >
            <LayoutGrid size={15} />
            Overview
          </button>
          {pages
            .filter(
              (item) =>
                item.id !== common?.id &&
                !/operations-overview|command-overview/.test(item.slug),
            )
            .map((item) => (
              <button
                key={item.id}
                aria-current={page?.id === item.id ? "page" : undefined}
                onClick={() => go(app, item.slug)}
                className={cn(
                  "workspace-nav-item",
                  page?.id === item.id && "workspace-nav-active",
                )}
              >
                <FileText size={14} />
                <span className="truncate">
                  {item.name.replace(/^City |^Emergency /, "")}
                </span>
              </button>
            ))}
          {common ? (
            <>
              <div className="mx-3 my-5 border-t border-dx-line" />
              <p className="px-3 pb-2 text-[9px] font-semibold uppercase tracking-[.18em] text-dx-muted">
                Team collaboration
              </p>
              <button
                aria-current={isCommon && !selectedModule ? "page" : undefined}
                onClick={() => go(app, common.slug)}
                className={cn(
                  "workspace-nav-item",
                  isCommon && !selectedModule && "workspace-nav-active",
                )}
              >
                <Compass size={15} />
                Common workspace
              </button>
              {modules.map((module) => (
                <button
                  key={module.id}
                  onClick={() => go(app, common.slug, module.id)}
                  aria-current={
                    selectedModule?.id === module.id ? "page" : undefined
                  }
                  className={cn(
                    "workspace-nav-item pl-9",
                    selectedModule?.id === module.id && "workspace-nav-active",
                  )}
                >
                  {module.label}
                </button>
              ))}
            </>
          ) : null}
        </nav>
        <div className="border-t border-dx-line p-3">
          {access.data?.isOrganizationAdmin ? (
            <>
              <a href="/admin" className="workspace-nav-item">
                <ShieldCheck size={15} />
                Administration
                <ArrowUpRight size={12} className="ml-auto" />
              </a>
              {page ? (
                <a
                  href={`/admin/workspaces?product=${page.product}&plugin=${encodeURIComponent(page.id)}`}
                  className="workspace-nav-item"
                >
                  <ArrowUpRight size={15} />
                  Edit in Studio
                </a>
              ) : null}
            </>
          ) : null}
          <a href="/docs" className="workspace-nav-item">
            <CircleHelp size={15} />
            Help & documentation
          </a>
          <div className="mt-2 flex items-center gap-2 rounded-xl bg-dx-subtle/70 p-3">
            <span
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-bold text-white",
                theme.color,
              )}
            >
              {(context?.user?.email || "ME").slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11px] font-semibold">
                {context?.user?.displayName ||
                  context?.user?.email ||
                  "Your account"}
              </p>
              <p className="mt-0.5 text-[9px] text-dx-muted">
                {(access.data?.productRoles[app] || []).join(" · ")}
              </p>
            </div>
            <button
              aria-label="Sign out"
              onClick={() =>
                void logout().then(() => navigate({ to: "/login" }))
              }
            >
              <LogOut size={14} className="text-dx-muted" />
            </button>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-dx-line bg-dx-surface/95 px-4 backdrop-blur lg:px-8">
          <button
            aria-label="Open navigation"
            className="lg:hidden"
            onClick={() => setMobile(true)}
          >
            <Menu size={20} />
          </button>
          <Building2 size={14} className="hidden text-dx-muted sm:block" />
          <span className="text-xs text-dx-muted">{theme.name}</span>
          <ChevronRight size={12} className="text-dx-muted" />
          <span className="truncate text-xs font-medium">
            {selectedModule?.label || page?.name || "Overview"}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden items-center gap-1.5 text-[10px] text-dx-muted sm:flex">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  installed.isError ? "bg-amber-500" : "bg-teal-500",
                )}
              />
              {installed.isError
                ? "Connection issue"
                : installed.isFetching
                  ? "Updating"
                  : "Workspace ready"}
            </span>
            <button
              aria-label="Refresh workspace"
              onClick={() => {
                void installed.refetch();
                void access.refetch();
              }}
              className="rounded-lg p-2 hover:bg-dx-subtle"
            >
              <RefreshCw
                size={14}
                className={installed.isFetching ? "animate-spin" : ""}
              />
            </button>
            <SiteToggles />
          </div>
        </header>
        <main className="mx-auto max-w-[1560px] space-y-6 px-4 py-6 sm:px-8 sm:py-8">
          {installed.isLoading ? (
            <Skeleton className="h-96 w-full" />
          ) : installed.isError ? (
            <Card className="p-6">
              <p role="alert">{installed.error.message}</p>
              <button onClick={() => void installed.refetch()}>
                Try again
              </button>
            </Card>
          ) : search.page && !page ? (
            <EmptyState
              title="Page unavailable"
              message="This page is not installed for your app or your role cannot access it."
            />
          ) : selectedModule &&
            !common?.widgets.some(
              (widget) => widget.section === selectedModule.id,
            ) ? (
            <>
              <div>
                <p
                  className={cn(
                    "text-[10px] font-semibold uppercase tracking-[.16em]",
                    theme.ink,
                  )}
                >
                  {theme.name} · Common workspace
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight">
                  {selectedModule.label}
                </h1>
                <p className="mt-2 text-sm text-dx-muted">
                  Your {theme.name} team’s work, in one place.
                </p>
              </div>
              <CapabilityModule
                key={app + selectedModule.id}
                module={selectedModule.id}
                product={app}
              />
            </>
          ) : (search.module || search.section) &&
            !page?.widgets.some(
              (widget) => widget.section === (search.section || search.module),
            ) ? (
            <EmptyState
              title="Tool unavailable"
              message="This tool is not part of the Common workspace installed for your app."
            />
          ) : page ? (
            <WorkspaceNavigation.Provider
              value={pages.map((item) => item.slug)}
            >
              <OperationalPage
                key={page.id}
                plugin={page}
                cacheScope={scope}
                modules={modules.map((module) => module.id)}
                section={search.section || search.module}
              />
            </WorkspaceNavigation.Provider>
          ) : (
            <>
              <section className="relative overflow-hidden rounded-2xl bg-[#132b35] p-7 text-white sm:p-9">
                <span className="text-[10px] font-semibold uppercase tracking-[.18em] text-teal-300">
                  {theme.label}
                </span>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight">
                  {theme.intro}
                </h1>
                <p className="mt-3 max-w-xl text-sm leading-6 text-slate-300">
                  {theme.description}
                </p>
                <div className="mt-6 flex items-center gap-2 text-xs text-slate-300">
                  <span className="h-2 w-2 rounded-full bg-teal-400" />
                  {pages.length} workspaces available to your account
                </div>
              </section>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {pages.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => go(app, item.slug)}
                    className="group rounded-xl border border-dx-line bg-dx-surface p-5 text-left shadow-sm transition hover:border-teal-400"
                  >
                    <span className="flex items-center justify-between">
                      <FileText size={18} className={theme.ink} />
                      <ArrowUpRight size={15} className="text-dx-muted" />
                    </span>
                    <h2 className="mt-5 text-sm font-semibold">{item.name}</h2>
                    <p className="mt-2 text-xs leading-5 text-dx-muted">
                      {item.widgets.find((widget) => widget.type === "heading")
                        ?.text || "Open your team’s operational workspace."}
                    </p>
                  </button>
                ))}
              </div>
              {!pages.length ? (
                <EmptyState
                  title="No pages available"
                  message="Ask your app administrator to install the workspaces for your role."
                />
              ) : null}
            </>
          )}
        </main>
        <footer className="px-8 pb-5 text-[10px] text-dx-muted">
          {theme.name} · Organization workspace
        </footer>
      </div>
      <Toaster />
    </div>
  );
}
