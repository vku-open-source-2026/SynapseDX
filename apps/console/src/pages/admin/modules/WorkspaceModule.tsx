// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Workspace lane: PARA folders, pages and backlinks. */
import { useQuery } from '@tanstack/react-query';
import { BookOpen, FileText, FolderOpen } from 'lucide-react';
import { api } from '../../../lib/api';
import { Card, Chip, EmptyState, Pill } from '../../../components/ui';

interface WorkspaceItem {
  id: string;
  name: string;
  para?: string;
  visibility?: string;
  owner?: string;
}
interface PageItem {
  id: string;
  title: string;
  folder?: string;
  versions?: unknown[];
  attachments?: unknown[];
}

export function WorkspaceModule() {
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<{ items?: WorkspaceItem[] }>('/v1/capabilities/workspaces'),
    retry: false,
  });
  const items = (workspaces.data?.items ?? []).slice(0, 8);

  const pages = useQuery({
    queryKey: ['workspaces', 'pages', items.map((item) => item.id).join(',')],
    enabled: items.length > 0,
    queryFn: () =>
      Promise.all(
        items.map((item) =>
          api.get<{ items?: PageItem[] }>(`/v1/capabilities/workspaces/${encodeURIComponent(item.id)}/pages`).catch(() => ({ items: [] as PageItem[] })),
        ),
      ),
    retry: false,
  });
  const pageSets = pages.data ?? [];

  return (
    <section className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">CAPABILITY MODULE</p>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Workspace and wiki</h2>
        <p className="text-sm text-slate-500">PARA folders, versioned pages, backlinks and attachments.</p>
      </div>

      {workspaces.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
      ) : workspaces.isError ? (
        <EmptyState
          title="Workspaces could not be loaded"
          message={(workspaces.error as Error)?.message}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={26} />}
          title="No workspace yet"
          message="Create one through POST /v1/capabilities/workspaces."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {items.map((ws, index) => {
            const wsPages = (pageSets[index]?.items ?? []).slice(0, 6);
            return (
              <Card key={ws.id} className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                      <BookOpen size={18} />
                    </div>
                    <div>
                      <p className="font-semibold text-slate-900">{ws.name}</p>
                      <p className="text-xs text-slate-500">{ws.para || 'para'} · {ws.visibility || 'private'} · {wsPages.length} page{wsPages.length === 1 ? '' : 's'}</p>
                    </div>
                  </div>
                  {ws.owner ? <Chip>{ws.owner}</Chip> : null}
                </div>
                {wsPages.length > 0 ? (
                  <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-100">
                    {wsPages.map((page) => (
                      <li key={page.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                        <span className="flex min-w-0 items-center gap-2 text-slate-700">
                          <FileText size={14} className="shrink-0 text-slate-400" />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{page.title}</span>
                            <span className="block truncate text-[11px] text-slate-400">{page.folder || 'root'} · v{page.versions?.length || 0} history</span>
                          </span>
                        </span>
                        <Pill tone={page.attachments?.length ? 'ok' : 'neutral'}>{page.attachments?.length || 0} files</Pill>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
