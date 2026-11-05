// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Capability event feed (stream-backed, at-least-once). */
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Radio } from 'lucide-react';
import { api } from '../../lib/api';
import { can } from '../../lib/rbac';
import { relativeTime } from '../../lib/format';
import { useAuthStore } from '../../stores/authStore';
import {
  Button, Card, CardHeader, EmptyState,
  TableShell, Thead, Th, Td, Tr,
} from '../../components/ui';

interface FeedEvent {
  id?: string;
  event?: {
    type?: string;
    datasetId?: string;
    recordId?: string;
    correlationId?: string;
    at?: string;
  };
}

export function EventsPage() {
  const context = useAuthStore((state) => state.context);
  const readable = can(context, 'events:read');

  const feed = useQuery({
    queryKey: ['events'],
    enabled: readable,
    queryFn: () => api.get<{ items?: FeedEvent[]; nextCursor?: string }>('/v1/capabilities/events?limit=100'),
    retry: false,
  });
  const items = feed.data?.items ?? [];

  if (!readable) {
    return (
      <Card className="p-6">
        <p className="text-sm font-semibold text-red-700">Your role cannot read the event feed.</p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        eyebrow="EVENT FEED"
        title="Capability events"
        description={`Stream-backed, at-least-once. Cursor ${feed.data?.nextCursor || '—'}.`}
        actions={
          <Button variant="ghost" onClick={() => void feed.refetch()} aria-label="Refresh events">
            <RefreshCw size={15} /> Refresh
          </Button>
        }
      />
      {feed.isLoading ? (
        <div className="grid gap-3 px-5 py-6">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : feed.isError ? (
        <div className="px-5 py-8">
          <EmptyState
            title="The event feed could not be loaded"
            message={(feed.error as Error)?.message}
            action={<Button variant="primary" onClick={() => void feed.refetch()}>Retry</Button>}
          />
        </div>
      ) : items.length === 0 ? (
        <div className="px-5 py-8">
          <EmptyState icon={<Radio size={26} />} title="No events have been emitted yet" message="Mutations published to the capability layer appear here at-least-once." />
        </div>
      ) : (
        <TableShell>
          <Thead>
            <Th>When</Th>
            <Th>Type</Th>
            <Th>Dataset</Th>
            <Th>Record</Th>
            <Th>Correlation</Th>
          </Thead>
          <tbody>
            {items.map((item, index) => {
              const event = item.event ?? {};
              return (
                <Tr key={item.id ?? index}>
                  <Td className="font-mono text-xs text-slate-500">{relativeTime(event.at)}</Td>
                  <Td><span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">{event.type || '—'}</span></Td>
                  <Td className="font-mono text-xs">{event.datasetId || '—'}</Td>
                  <Td className="font-mono text-xs">{event.recordId || '—'}</Td>
                  <Td className="font-mono text-xs text-slate-500">{event.correlationId || '—'}</Td>
                </Tr>
              );
            })}
          </tbody>
        </TableShell>
      )}
    </Card>
  );
}
