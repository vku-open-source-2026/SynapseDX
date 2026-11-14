// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Organization installation management for published workspace plugins. */
import { useMemo, useState } from 'react';
import { DownloadCloud, PowerOff, RefreshCw } from 'lucide-react';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Pill,
  Skeleton,
} from '../../../components/ui';
import { Modal, ModalError } from '../../../components/Modal';
import { toast } from '../../../stores/toastStore';
import type { WorkspaceCatalog, WorkspacePlugin, WorkspaceProduct } from '../../../lib/workspaces';
import { catalogRoles } from '../../../lib/workspaces';
import { installPlugin, uninstallPlugin } from '../../../lib/workspacesApi';

function errorText(error: unknown): string {
  const value = error as { message?: string; code?: string };
  const message = value?.message || 'The capability service refused the request.';
  return value?.code ? `${message} (${value.code})` : message;
}

export function InstallPanel({
  product,
  plugins,
  catalog,
  loading,
  onChanged,
}: {
  product: WorkspaceProduct;
  plugins: WorkspacePlugin[];
  catalog: WorkspaceCatalog | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const published = useMemo(() => plugins.filter((plugin) => plugin.status === 'published'), [plugins]);
  const catalogRoleSet = useMemo(() => new Set(catalogRoles(catalog, product)), [catalog, product]);

  const [target, setTarget] = useState<WorkspacePlugin | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WorkspacePlugin | null>(null);

  const openInstall = (plugin: WorkspacePlugin) => {
    setTarget(plugin);
    setRoles(plugin.roles);
    setError(null);
  };

  const confirmInstall = async () => {
    if (!target || busy) return;
    setBusy(target.id);
    setError(null);
    try {
      await installPlugin(target.id, roles.length === target.roles.length ? undefined : roles);
      toast('Plugin installed for the organization.');
      setTarget(null);
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  const confirmUninstall = async () => {
    if (!removing || busy) return;
    setBusy(removing.id);
    try {
      await uninstallPlugin(removing.id);
      toast('Plugin uninstalled for the organization.');
      setRemoving(null);
      onChanged();
    } catch (failure) {
      toast(errorText(failure), 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          eyebrow={`${product.toUpperCase()} · organization install`}
          title="Installed pages"
          description="An organization administrator installs a published snapshot for the whole organization. Members then see the role-filtered pages in /workspace."
          actions={
            <>
              <Button variant="ghost" onClick={() => onChanged()} disabled={Boolean(busy)}>
                <RefreshCw size={14} /> Refresh
              </Button>
              <a
                href="/workspace"
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 dark:border-[#26354d] dark:bg-[#142136] dark:text-slate-200 dark:hover:bg-[#1a2840]"
              >
                Open member workspace
              </a>
            </>
          }
        />
        <div className="px-5 py-3 text-xs text-slate-500 dark:text-slate-400">
          <p>
            Installation metadata comes from the admin plugin list (<span className="font-mono">installed</span> /
            <span className="font-mono"> installedRoles</span>). The member list
            (<span className="font-mono">GET /installed</span>) is role-filtered and is not used to infer organization
            installation state.
          </p>
        </div>
      </Card>

      {loading ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      ) : published.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            title="No published plugins"
            message="Publish a plugin in the builder before installing it for the organization."
          />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {published.map((plugin) => {
            return (
              <Card key={plugin.id} className="flex flex-col p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{plugin.name}</h3>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {plugin.product} · {plugin.audience} · published v{plugin.publishedVersion}
                    </p>
                  </div>
                  {plugin.installed ? <Pill tone="ok">installed</Pill> : <Pill tone="neutral">not installed</Pill>}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {(plugin.installedRoles?.length ? plugin.installedRoles : plugin.roles).map((role) => (
                    <span
                      key={role}
                      className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    >
                      {role}
                    </span>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="primary" onClick={() => openInstall(plugin)} disabled={Boolean(busy)}>
                    <DownloadCloud size={14} /> {plugin.installed ? 'Update install roles' : 'Install for organization'}
                  </Button>
                  <Button variant="danger" onClick={() => setRemoving(plugin)} disabled={Boolean(busy) || !plugin.installed}>
                    <PowerOff size={14} /> Uninstall
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        title={target ? `Install ${target.name}` : 'Install plugin'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTarget(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void confirmInstall()} disabled={Boolean(busy)}>
              {busy ? 'Installing…' : 'Install'}
            </Button>
          </>
        }
      >
        {target ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Installation is organization-wide. Role narrowing can only select roles published by this plugin; the
              capability service rejects anything else.
            </p>
            <fieldset>
              <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">Installation roles</legend>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Leave all selected to use the published roles unchanged.
              </p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {target.roles.map((role) => (
                  <label
                    key={role}
                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 dark:border-[#26354d] dark:text-slate-200"
                  >
                    <input
                      type="checkbox"
                      checked={roles.includes(role)}
                      onChange={(event) =>
                        setRoles(
                          event.target.checked
                            ? [...roles, role]
                            : roles.filter((item) => item !== role),
                        )
                      }
                    />
                    {role}
                    {!catalogRoleSet.has(role) ? <span className="text-amber-600">*</span> : null}
                  </label>
                ))}
              </div>
            </fieldset>
            <ModalError message={error} />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={Boolean(removing)}
        title="Uninstall plugin"
        message={
          removing
            ? `Remove ${removing.name} from this organization? Members immediately lose access in /workspace. The plugin draft and published snapshot are kept.`
            : undefined
        }
        label="Uninstall"
        danger
        busy={Boolean(busy)}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void confirmUninstall()}
      />
    </div>
  );
}
