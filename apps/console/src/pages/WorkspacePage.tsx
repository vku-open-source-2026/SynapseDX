// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Authenticated Tier-2 member workspace. This page is intentionally NOT behind
 * the management-admin shell: any verified organization member (volunteer,
 * technician, responder, operator, manager, admin) can open it, and the server
 * decides which published pages are visible from stored membership roles.
 */
import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, LayoutTemplate, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { SiteToggles } from '../components/SiteToggles';
import { Toaster } from '../components/Toaster';
import { RuntimeWidgetCard } from '../components/workspaces/RuntimeWidgetCard';
import { Button, Card, EmptyState, Pill, Skeleton } from '../components/ui';
import { useAuthStore } from '../stores/authStore';
import { fetchInstalled, fetchWorkflowReadiness } from '../lib/workspacesApi';
import { formReasonMessage, type InstalledPlugin, type WorkspaceProduct } from '../lib/workspaces';

const PRODUCT_LABELS: Record<WorkspaceProduct, string> = { city: 'SynapseCity', sos: 'SynapseCity SOS' };

function WorkspaceHeader({ onSignOut }: { onSignOut: () => void }) {
  return (
    <header className="sticky top-0 z-40 border-b border-dx-line bg-dx-surface/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <a href="/workspace" aria-label="SynapseDX workspace">
          <BrandMark />
        </a>
        <div className="flex items-center gap-2">
          <a
            href="/"
            className="hidden rounded-lg px-3 py-1.5 text-sm text-dx-muted transition-colors hover:text-dx-fg sm:block"
          >
            Public catalog
          </a>
          <SiteToggles />
          <button
            type="button"
            onClick={onSignOut}
            className="inline-flex items-center gap-1.5 rounded-full border border-dx-line px-3 py-1.5 text-sm font-semibold text-dx-fg transition hover:bg-dx-subtle"
          >
            <LogOut size={15} aria-hidden="true" /> Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

function PageList({
  pages,
  onOpen,
}: {
  pages: InstalledPlugin[];
  onOpen: (plugin: InstalledPlugin) => void;
}) {
  if (pages.length === 0) {
    return (
      <EmptyState
        icon={<LayoutTemplate size={20} />}
        title="No pages for this product"
        message="Your organization may not have installed a page for this product and your membership roles."
      />
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {pages.map((plugin) => (
        <Card key={plugin.id} className="flex flex-col p-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 text-sm font-semibold text-slate-900 dark:text-slate-100">{plugin.name}</h3>
            <Pill tone={plugin.audience === 'admin' ? 'warn' : 'ok'}>{plugin.audience}</Pill>
          </div>
          <p className="mt-1 flex-1 text-xs text-slate-500 dark:text-slate-400">
            {plugin.widgets.length} widget(s) · published v{plugin.publishedVersion}
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {(plugin.installationRoles?.length ? plugin.installationRoles : plugin.roles).slice(0, 6).map((role) => (
              <span
                key={role}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                {role}
              </span>
            ))}
          </div>
          <Button variant="primary" className="mt-3" onClick={() => onOpen(plugin)}>
            Open page
          </Button>
        </Card>
      ))}
    </div>
  );
}

function PageRenderer({
  plugin,
  cacheScope,
  formUnavailableReason,
  onBack,
}: {
  plugin: InstalledPlugin;
  cacheScope: string;
  formUnavailableReason?: string | null;
  onBack: () => void;
}) {
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-dx-accent hover:underline"
      >
        <ArrowLeft size={15} aria-hidden="true" /> All pages
      </button>
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {PRODUCT_LABELS[plugin.product]} · {plugin.audience} page
            </p>
            <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              {plugin.name}
            </h1>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Published v{plugin.publishedVersion}
              {plugin.publishedAt ? ` · ${new Date(plugin.publishedAt).toLocaleString()}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-1">
            {(plugin.installationRoles?.length ? plugin.installationRoles : plugin.roles).map((role) => (
              <Pill key={role} tone="neutral">{role}</Pill>
            ))}
          </div>
        </div>
      </Card>
      {plugin.widgets.length === 0 ? (
        <EmptyState title="This page has no widgets" message="Ask your organization administrator to publish a layout." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {plugin.widgets.map((widget) => (
            <RuntimeWidgetCard
              key={widget.id}
              installedId={plugin.id}
              widget={widget}
              cacheScope={cacheScope}
              formUnavailableReason={formUnavailableReason}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkspacePage() {
  const navigate = useNavigate();
  const session = useAuthStore((state) => state.session);
  const logout = useAuthStore((state) => state.logout);
  const [product, setProduct] = useState<WorkspaceProduct>('city');
  const [openId, setOpenId] = useState<string | null>(null);
  const cacheScope = session?.obtainedAt ?? 'anonymous';

  const installed = useQuery({
    queryKey: ['workspace-installed', cacheScope],
    queryFn: fetchInstalled,
    enabled: Boolean(session),
    retry: false,
  });
  const readiness = useQuery({
    queryKey: ['workflow-readiness', cacheScope],
    queryFn: fetchWorkflowReadiness,
    enabled: Boolean(session),
    retry: false,
    staleTime: 60_000,
  });
  const formUnavailableReason =
    readiness.data && !readiness.data.pluginFormsCanSubmit
      ? readiness.data.workflowExecution.requirement
      : null;

  const pages = installed.data ?? [];
  const productPages = useMemo(() => pages.filter((item) => item.product === product), [pages, product]);
  const openPlugin = openId ? pages.find((item) => item.id === openId) ?? null : null;
  const orgGateReason = useMemo(() => {
    for (const plugin of pages) {
      for (const widget of plugin.widgets) {
        if (
          widget.type === 'form' &&
          widget.canSubmitReason &&
          widget.canSubmitReason !== 'ready' &&
          widget.canSubmitReason !== 'workflow_sdk_release_required'
        ) {
          return formReasonMessage(widget.canSubmitReason);
        }
      }
    }
    return null;
  }, [pages]);
  const displayGateReason = formUnavailableReason ?? orgGateReason;

  useEffect(() => {
    if (!installed.data || installed.data.length === 0) return;
    if (installed.data.some((item) => item.product === product)) return;
    const firstProduct = installed.data[0]?.product;
    if (firstProduct) setProduct(firstProduct);
  }, [installed.data, product]);

  if (!session) {
    return <Navigate to="/login" search={{ redirect: '/workspace' }} />;
  }

  const signOut = async () => {
    await logout();
    void navigate({ to: '/login' });
  };

  const counts: Record<WorkspaceProduct, number> = {
    city: pages.filter((item) => item.product === 'city').length,
    sos: pages.filter((item) => item.product === 'sos').length,
  };

  return (
    <div className="flex min-h-full flex-col bg-dx-bg text-dx-fg">
      <WorkspaceHeader onSignOut={() => void signOut()} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-dx-accent">Tier 2 · member workspace</p>
            <h1 className="mt-0.5 text-2xl font-semibold tracking-tight">Your organization pages</h1>
            <p className="mt-1 max-w-2xl text-sm text-dx-muted">
              Pages installed by your organization and visible to your membership roles. Access is decided by the
              capability service, not by this browser.
            </p>
          </div>
          <Button variant="ghost" onClick={() => void installed.refetch()} disabled={installed.isFetching}>
            <RefreshCw size={14} className={installed.isFetching ? 'animate-spin' : undefined} /> Refresh
          </Button>
        </div>

        {displayGateReason ? (
          <Card className="mb-4 border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">Form actions are unavailable</p>
            <p className="mt-1 text-xs leading-5 text-amber-800 dark:text-amber-300">{displayGateReason}</p>
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
              Read-only pages and data widgets remain available. No submission is attempted while this gate is closed.
            </p>
          </Card>
        ) : null}

        <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Product pages">
          {(Object.keys(PRODUCT_LABELS) as WorkspaceProduct[]).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={product === item}
              onClick={() => {
                setProduct(item);
                setOpenId(null);
              }}
              className={
                product === item
                  ? 'rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-1.5 text-sm font-semibold text-white'
                  : 'rounded-full border border-dx-line bg-dx-surface px-4 py-1.5 text-sm font-semibold text-dx-muted hover:text-dx-fg'
              }
            >
              {PRODUCT_LABELS[item]} <span className="ml-1 opacity-80">({counts[item]})</span>
            </button>
          ))}
        </div>

        {installed.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-40 w-full" />
            ))}
          </div>
        ) : installed.isError ? (
          <Card className="p-6">
            <p role="alert" className="text-sm font-semibold text-red-700 dark:text-red-300">
              Your workspace could not be loaded.
            </p>
            <p className="mt-1 text-sm text-dx-muted">{(installed.error as Error).message}</p>
            <div className="mt-4 flex gap-2">
              <Button variant="primary" onClick={() => void installed.refetch()}>Retry</Button>
              <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
            </div>
          </Card>
        ) : openPlugin ? (
          <PageRenderer
            plugin={openPlugin}
            cacheScope={cacheScope}
            formUnavailableReason={formUnavailableReason}
            onBack={() => setOpenId(null)}
          />
        ) : (
          <PageList pages={productPages} onOpen={(plugin) => setOpenId(plugin.id)} />
        )}

        <p className="mt-6 flex items-center gap-1.5 text-xs text-dx-muted">
          <ShieldCheck size={14} aria-hidden="true" />
          Installation, role matching, data access and form execution are enforced by the Tier-2 capability service.
        </p>
      </main>
      <footer className="border-t border-dx-line bg-dx-surface px-5 py-3 text-xs text-dx-muted">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <span>SynapseDX · Tier 2</span>
          <a href="/health" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-dx-fg">
            /health
          </a>
        </div>
      </footer>
      <Toaster />
    </div>
  );
}
