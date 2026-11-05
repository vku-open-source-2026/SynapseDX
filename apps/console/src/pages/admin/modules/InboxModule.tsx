// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Inbox lane: mentions, assignments and delivery preferences. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, BellRing, Archive, CheckCheck, Inbox } from 'lucide-react';
import { api } from '../../../lib/api';
import { relativeTime, statusLabel, statusTone } from '../../../lib/format';
import { useToastStore } from '../../../stores/toastStore';
import { Button, EmptyState, Pill, TableShell, Thead, Th, Td, Tr } from '../../../components/ui';

interface InboxItem {
  id: string;
  title: string;
  module: string;
  status: string;
  createdAt: string;
}
interface InboxResponse {
  items?: InboxItem[];
  unread?: number;
}
interface Preferences {
  subject?: string;
  channels?: string[];
  muted?: boolean;
  digest?: string;
}

export function InboxModule() {
  const queryClient = useQueryClient();
  const push = useToastStore((state) => state.push);

  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api.get<InboxResponse>('/v1/capabilities/inbox'),
    retry: false,
  });
  const prefs = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: () => api.get<{ preferences: Preferences }>('/v1/capabilities/notification-preferences'),
    retry: false,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['inbox'] });

  const mark = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'read' | 'archive' }) =>
      api.post(`/v1/capabilities/inbox/${encodeURIComponent(id)}/${action}`),
    onSuccess: invalidate,
    onError: (failure: Error) => push(failure?.message || 'The inbox item could not be updated.', 'bad'),
  });

  const toggleMute = useMutation({
    mutationFn: async () => {
      const current = await api.get<{ preferences: Preferences }>('/v1/capabilities/notification-preferences');
      return api.put('/v1/capabilities/notification-preferences', {
        ...current.preferences,
        muted: !current.preferences?.muted,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
      push(prefs.data?.preferences?.muted ? 'Delivery unmuted.' : 'Delivery muted.');
    },
    onError: (failure: Error) => push(failure?.message || 'The preference could not be saved.', 'bad'),
  });

  const items = inbox.data?.items ?? [];
  const unread = inbox.data?.unread ?? 0;
  const preference = prefs.data?.preferences ?? {};

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">CAPABILITY MODULE</p>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Inbox and mentions</h2>
          <p className="text-sm text-slate-500">{unread} unread · preferences are tenant-scoped and respected by fan-out.</p>
        </div>
        <Button variant="ghost" onClick={() => toggleMute.mutate()} disabled={toggleMute.isPending}>
          {preference.muted ? <BellRing size={15} /> : <BellOff size={15} />}
          {preference.muted ? 'Unmute delivery' : 'Mute delivery'}
        </Button>
      </div>

      {inbox.isLoading ? (
        <div className="grid gap-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : inbox.isError ? (
        <EmptyState
          title="The inbox could not be loaded"
          message={(inbox.error as Error)?.message}
          action={<Button variant="primary" onClick={() => void inbox.refetch()}>Retry</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Inbox size={26} />}
          title="No inbox items yet"
          message="Mentions and assignments arrive here."
        />
      ) : (
        <TableShell>
          <Thead>
            <Th>Item</Th>
            <Th>Status</Th>
            <Th>Created</Th>
            <Th>Actions</Th>
          </Thead>
          <tbody>
            {items.map((item) => (
              <Tr key={item.id}>
                <Td>
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900">{item.title}</p>
                    <p className="text-xs text-slate-400">{item.module}</p>
                  </div>
                </Td>
                <Td><Pill tone={statusTone(item.status)}>{statusLabel(item.status)}</Pill></Td>
                <Td className="font-mono text-xs text-slate-500">{relativeTime(item.createdAt)}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    {item.status !== 'read' ? (
                      <button type="button" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50" onClick={() => mark.mutate({ id: item.id, action: 'read' })}>
                        <CheckCheck size={13} /> Mark read
                      </button>
                    ) : null}
                    {item.status !== 'archived' ? (
                      <button type="button" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100" onClick={() => mark.mutate({ id: item.id, action: 'archive' })}>
                        <Archive size={13} /> Archive
                      </button>
                    ) : null}
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </TableShell>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Preferences</p>
          <h3 className="mt-0.5 text-base font-semibold text-slate-900">{preference.muted ? 'Muted' : 'Delivering'}</h3>
          <p className="mt-1 text-sm text-slate-500">
            Channels: {(preference.channels ?? ['inbox']).join(', ')} · digest: {preference.digest || 'instant'}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Mentions</p>
          <h3 className="mt-0.5 text-base font-semibold text-slate-900">Comments create inbox items</h3>
          <p className="mt-1 text-sm text-slate-500">
            Muted or quiet-hour recipients keep the item but skip external delivery.
          </p>
        </div>
      </div>
    </section>
  );
}
