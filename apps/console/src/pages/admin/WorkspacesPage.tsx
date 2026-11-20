// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * /admin/workspaces — organization plugin builder. Admin-only at the API
 * boundary; this page never treats a hidden button as authorization.
 */
import { useEffect, useMemo, useState } from "react";
import { useBlocker, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  LayoutTemplate,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { Button, Card, Pill, Skeleton } from "../../components/ui";
import { ModalError } from "../../components/Modal";
import { BuilderPanel } from "./workspaces/BuilderPanel";
import { InstallPanel } from "./workspaces/InstallPanel";
import { MembersPanel } from "./workspaces/MembersPanel";
import { TokensPanel } from "./workspaces/TokensPanel";
import { catalogProducts, type WorkspaceProduct } from "../../lib/workspaces";
import { fetchCatalog, fetchPlugins } from "../../lib/workspacesApi";

type Tab = "builder" | "install" | "members" | "tokens";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "builder", label: "Builder" },
  { id: "install", label: "Organization install" },
  { id: "members", label: "Members & roles" },
  { id: "tokens", label: "Runtime tokens" },
];

function errorText(error: unknown): string {
  const value = error as { message?: string; code?: string };
  const message =
    value?.message || "The capability service refused the request.";
  return value?.code ? `${message} (${value.code})` : message;
}

export function WorkspacesPage() {
  const [dirty, setDirty] = useState(false);
  const canLeave = () =>
    !dirty || window.confirm("Discard unsaved changes to this draft?");
  const [tab, setTab] = useState<Tab>("builder");
  const search = useSearch({ from: "/admin/workspaces" });
  const navigate = useNavigate();
  const product: WorkspaceProduct = search.product ?? "city";
  const setProduct = (value: WorkspaceProduct) =>
    void navigate({
      to: "/admin/workspaces",
      search: { product: value, plugin: undefined },
    });

  // Guard against silent draft loss: switching Studio tabs or the workspace
  // product already confirms, but an in-app route change (sidebar link) used to
  // unmount the builder and discard an unsaved draft. Search-only changes
  // (page/plugin selection) are the builder's own navigation and stay unblocked.
  const blocker = useBlocker({
    withResolver: true,
    shouldBlockFn: ({ current, next }) =>
      dirty && current.pathname !== next.pathname,
  });
  useEffect(() => {
    if (blocker.status !== "blocked") return;
    if (window.confirm("Discard unsaved changes to this draft?"))
      blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  const catalogQuery = useQuery({
    queryKey: ["workspace-catalog"],
    queryFn: fetchCatalog,
    retry: false,
    staleTime: 60_000,
  });
  const pluginsQuery = useQuery({
    queryKey: ["workspace-plugins", product],
    queryFn: () => fetchPlugins(product),
    retry: false,
  });

  const catalog = catalogQuery.data ?? null;
  const products = useMemo(
    () => catalogProducts(catalog).map((item) => item.product),
    [catalog],
  );

  useEffect(() => {
    if (catalog && !products.includes(product) && products[0])
      setProduct(products[0]);
  }, [products, product]);

  const refresh = () => {
    void catalogQuery.refetch();
    void pluginsQuery.refetch();
  };

  const needsCatalog = tab === "builder" || tab === "install";

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-20 rounded-2xl border border-dx-line bg-dx-surface shadow-sm">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <LayoutTemplate size={20} className="text-indigo-500" />
          <h1 className="mr-2 text-sm font-semibold text-dx-fg">
            Workspace Studio
          </h1>
          <div
            className="flex flex-wrap gap-1"
            role="tablist"
            aria-label="Studio sections"
          >
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => {
                  if (item.id === tab || canLeave()) {
                    setDirty(false);
                    setTab(item.id);
                  }
                }}
                className={
                  tab === item.id
                    ? "rounded-lg bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                    : "rounded-lg px-3 py-2 text-xs text-dx-muted hover:bg-dx-subtle"
                }
              >
                {item.label}
              </button>
            ))}
          </div>
          <label className="ml-auto flex items-center gap-2 text-xs text-dx-muted">
            Workspace
            <select
              className="rounded-lg border border-dx-line bg-dx-subtle px-3 py-2 text-xs font-medium text-dx-fg"
              value={product}
              onChange={(event) => {
                if (canLeave()) {
                  setDirty(false);
                  setProduct(event.target.value as WorkspaceProduct);
                }
              }}
            >
              {products.map((item) => (
                <option key={item} value={item}>
                  {item === "dx"
                    ? "Capability templates"
                    : item === "city"
                      ? "SynapseCity"
                      : "SynapseCity SOS"}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="ghost"
            aria-label="Refresh Studio"
            onClick={refresh}
            disabled={catalogQuery.isFetching || pluginsQuery.isFetching}
          >
            <RefreshCw size={13} />
          </Button>
          <a
            href="/admin/modules"
            className="hidden 2xl:block text-xs font-medium text-dx-muted hover:text-indigo-500"
          >
            H-D-P-I catalog
          </a>
          <a
            href={
              product === "dx"
                ? "/admin/modules"
                : `/workspace?product=${product}`
            }
            className="flex items-center gap-2 rounded-lg border border-dx-line px-3 py-2 text-xs font-semibold"
          >
            <ExternalLink size={13} /> Open workspace
          </a>
        </div>
        {tab === "builder" && (
          <div
            id="workspace-studio-controls"
            aria-label="Studio plugin controls"
          />
        )}
      </div>

      {catalog && tab !== "builder" ? (
        <details className="rounded-xl border border-dx-line bg-dx-surface">
          <summary className="cursor-pointer px-4 py-3 text-xs text-dx-muted">
            Workflow connection details
          </summary>
          <Card className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Workflow execution readiness
                </p>
                <div className="mt-2 space-y-1.5 text-xs leading-5 text-slate-600 dark:text-slate-300">
                  <p>
                    <Pill
                      tone={catalog.workflowExecution?.ready ? "ok" : "warn"}
                    >
                      SDK:{" "}
                      {catalog.workflowExecution?.ready
                        ? "ready"
                        : "gate closed"}
                    </Pill>{" "}
                    {catalog.workflowExecution?.requirement}
                  </p>
                  <p>
                    <Pill
                      tone={catalog.workflowOrgReadiness?.ready ? "ok" : "warn"}
                    >
                      org identity:{" "}
                      {catalog.workflowOrgReadiness?.ready
                        ? "verified"
                        : catalog.workflowOrgReadiness?.reason ||
                          "not reported"}
                    </Pill>{" "}
                    {catalog.workflowOrgReadiness?.requirement}
                  </p>
                  {!catalog.workflowExecution?.ready ||
                  !catalog.workflowOrgReadiness?.ready ? (
                    <p className="text-amber-700 dark:text-amber-300">
                      Forms can be designed and saved, but members cannot submit
                      until the deployment operator closes these gates. This
                      console cannot set secrets or grant roles.
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
        </details>
      ) : null}

      {needsCatalog && catalogQuery.isError ? (
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <ShieldAlert
              size={20}
              className="mt-0.5 shrink-0 text-amber-600"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Workspace administration is protected
              </p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {errorText(catalogQuery.error)}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Plugin, member, token and install management require a
                Tier-1-verified organization administrator. The capability
                service bootstraps that administrator's org membership on the
                first admin request; this console cannot grant itself access.
              </p>
              <Button
                className="mt-3"
                variant="ghost"
                onClick={() => void catalogQuery.refetch()}
              >
                Retry catalog
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {tab === "builder" ? (
        pluginsQuery.isError ? (
          <Card className="p-5">
            <ModalError message={errorText(pluginsQuery.error)} />
            <Button
              className="mt-3"
              variant="primary"
              onClick={() => void pluginsQuery.refetch()}
            >
              Retry plugins
            </Button>
          </Card>
        ) : catalogQuery.isLoading || pluginsQuery.isLoading ? (
          <Skeleton className="h-[420px] w-full" />
        ) : (
          <BuilderPanel
            key={product}
            requestedPluginId={search.plugin}
            onSelected={(id) =>
              void navigate({
                to: "/admin/workspaces",
                search: { product, plugin: id || undefined },
                replace: true,
              })
            }
            product={product}
            catalog={catalog}
            plugins={pluginsQuery.data ?? []}
            loading={pluginsQuery.isFetching}
            onDirtyChange={setDirty}
            onChanged={() => {
              void pluginsQuery.refetch();
            }}
          />
        )
      ) : null}

      {tab === "install" ? (
        pluginsQuery.isError ? (
          <Card className="p-5">
            <ModalError message={errorText(pluginsQuery.error)} />
            <Button
              className="mt-3"
              variant="primary"
              onClick={() => void pluginsQuery.refetch()}
            >
              Retry plugins
            </Button>
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

      {tab === "members" ? (
        <MembersPanel catalog={catalog} onChanged={refresh} />
      ) : null}
      {tab === "tokens" ? (
        <TokensPanel product={product} catalog={catalog} onChanged={refresh} />
      ) : null}
    </div>
  );
}
