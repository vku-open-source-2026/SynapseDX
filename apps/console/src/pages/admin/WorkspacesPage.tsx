// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * /admin/workspaces — organization plugin builder. Admin-only at the API
 * boundary; this page never treats a hidden button as authorization.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, LayoutTemplate, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button, Card, CardHeader, Pill, Skeleton } from '../../components/ui';
import { ModalError } from '../../components/Modal';
import { BuilderPanel } from './workspaces/BuilderPanel';
import { InstallPanel } from './workspaces/InstallPanel';
import { MembersPanel } from './workspaces/MembersPanel';
import { TokensPanel } from './workspaces/TokensPanel';
import { catalogProducts, type WorkspaceProduct } from '../../lib/workspaces';
import { fetchCatalog, fetchPlugins } from '../../lib/workspacesApi';

type Tab = 'builder' | 'install' | 'members' | 'tokens';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'builder', label: 'Builder' },
  { id: 'install', label: 'Organization install' },
  { id: 'members', label: 'Members & roles' },
  { id: 'tokens', label: 'Runtime tokens' },
];

function errorText(error: unknown): string {
  const value = error as { message?: string; code?: string };
  const message = value?.message || 'The capability service refused the request.';
  return value?.code ? `${message} (${value.code})` : message;
}

export function WorkspacesPage() {
  const [tab, setTab] = useState<Tab>('builder');
  const [product, setProduct] = useState<WorkspaceProduct>('city');

  const catalogQuery = useQuery({
    queryKey: ['workspace-catalog'],
    queryFn: fetchCatalog,
    retry: false,
    staleTime: 60_000,
  });
  const pluginsQuery = useQuery({
    queryKey: ['workspace-plugins', product],
    queryFn: () => fetchPlugins(product),
    retry: false,
  });

  const catalog = catalogQuery.data ?? null;
  const products = useMemo(() => catalogProducts(catalog).map((item) => item.product), [catalog]);

  useEffect(() => {
    if (!products.includes(product) && products[0]) setProduct(products[0]);
  }, [products, product]);

  const refresh = () => {
    void catalogQuery.refetch();
    void pluginsQuery.refetch();
  };

  const needsCatalog = tab === 'builder' || tab === 'install';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          eyebrow="Tier 2 · workspace plugins"
          title="Visual workspace builder"
          description="Design admin and member pages for City and SOS, install published snapshots for your organization, assign membership roles and manage scoped runtime tokens."
          actions={
            <>
              <a
                href="/workspace"
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 dark:border-[#26354d] dark:bg-[#142136] dark:text-slate-200 dark:hover:bg-[#1a2840]"
              >
                <ExternalLink size={14} /> Member workspace
              </a>
              <Button variant="ghost" onClick={refresh} disabled={catalogQuery.isFetching || pluginsQuery.isFetching}>
                <RefreshCw size={14} /> Refresh
              </Button>
            </>
          }
        />
        <div className="flex flex-wrap items-center gap-2 px-5 py-3">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={
                tab === item.id
                  ? 'rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-1.5 text-sm font-semibold text-white'
                  : 'rounded-full border border-slate-200 bg-white px-4 py-1.5 text-sm font-semibold text-slate-600 hover:text-slate-900 dark:border-[#26354d] dark:bg-[#142136] dark:text-slate-300 dark:hover:text-white'
              }
            >
              {item.label}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <LayoutTemplate size={14} aria-hidden="true" />
            {catalog ? `${catalog.products.length} product(s) in catalog` : 'Catalog unavailable'}
          </span>
        </div>
        {(tab === 'builder' || tab === 'install') ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3 dark:border-[#1f2c40]">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Product</span>
            {products.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setProduct(item)}
                aria-pressed={product === item}
                className={
                  product === item
                    ? 'rounded-full border border-sky-300 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-800 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-200'
                    : 'rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-[#26354d] dark:text-slate-300 dark:hover:bg-[#142136]'
                }
              >
                {item}
              </button>
            ))}
            {catalog ? (
              <Pill tone={catalog.mutation.formExecution ? 'ok' : 'warn'}>
                forms: {catalog.mutation.formExecution ? 'workflow execution' : 'disabled'}
              </Pill>
            ) : null}
          </div>
        ) : null}
      </Card>

      {catalog ? (
        <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Workflow execution readiness
              </p>
              <div className="mt-2 space-y-1.5 text-xs leading-5 text-slate-600 dark:text-slate-300">
                <p>
                  <Pill tone={catalog.workflowExecution?.ready ? 'ok' : 'warn'}>
                    SDK: {catalog.workflowExecution?.ready ? 'ready' : 'gate closed'}
                  </Pill>{' '}
                  {catalog.workflowExecution?.requirement}
                </p>
                <p>
                  <Pill tone={catalog.workflowOrgReadiness?.ready ? 'ok' : 'warn'}>
                    org identity: {catalog.workflowOrgReadiness?.ready ? 'verified' : catalog.workflowOrgReadiness?.reason || 'not reported'}
                  </Pill>{' '}
                  {catalog.workflowOrgReadiness?.requirement}
                </p>
                {!catalog.workflowExecution?.ready || !catalog.workflowOrgReadiness?.ready ? (
                  <p className="text-amber-700 dark:text-amber-300">
                    Forms can be designed and saved, but members cannot submit until the deployment operator closes
                    these gates. This console cannot set secrets or grant roles.
                  </p>
                ) : null}
              </div>
            </div>
            <a
              href="/admin/workflows"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 dark:border-[#26354d] dark:bg-[#142136] dark:text-slate-200 dark:hover:bg-[#1a2840]"
            >
              Open workflow artifacts
            </a>
          </div>
        </Card>
      ) : null}

      {needsCatalog && catalogQuery.isError ? (
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <ShieldAlert size={20} className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Workspace administration is protected</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{errorText(catalogQuery.error)}</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Plugin, member, token and install management require a Tier-1-verified organization administrator.
                The capability service bootstraps that administrator's org membership on the first admin request; this
                console cannot grant itself access.
              </p>
              <Button className="mt-3" variant="ghost" onClick={() => void catalogQuery.refetch()}>Retry catalog</Button>
            </div>
          </div>
        </Card>
      ) : null}

      {tab === 'builder' ? (
        pluginsQuery.isError ? (
          <Card className="p-5">
            <ModalError message={errorText(pluginsQuery.error)} />
            <Button className="mt-3" variant="primary" onClick={() => void pluginsQuery.refetch()}>Retry plugins</Button>
          </Card>
        ) : catalogQuery.isLoading || pluginsQuery.isLoading ? (
          <Skeleton className="h-[420px] w-full" />
        ) : (
          <BuilderPanel
            key={product}
            product={product}
            catalog={catalog}
            plugins={pluginsQuery.data ?? []}
            loading={pluginsQuery.isFetching}
            onChanged={() => {
              void pluginsQuery.refetch();
            }}
          />
        )
      ) : null}

      {tab === 'install' ? (
        pluginsQuery.isError ? (
          <Card className="p-5">
            <ModalError message={errorText(pluginsQuery.error)} />
            <Button className="mt-3" variant="primary" onClick={() => void pluginsQuery.refetch()}>Retry plugins</Button>
          </Card>
        ) : (
          <InstallPanel
            key={product}
            product={product}
            catalog={catalog}
            plugins={pluginsQuery.data ?? []}
            loading={pluginsQuery.isLoading}
            onChanged={() => {
              void pluginsQuery.refetch();
            }}
          />
        )
      ) : null}

      {tab === 'members' ? <MembersPanel catalog={catalog} onChanged={refresh} /> : null}
      {tab === 'tokens' ? (
        <TokensPanel product={product} catalog={catalog} onChanged={refresh} />
      ) : null}
    </div>
  );
}
