// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Audit trail + usage accounting with server-side filters. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, Filter, ScrollText } from 'lucide-react';
import { api } from '../../lib/api';
import { can } from '../../lib/rbac';
import { formatNumber, relativeTime } from '../../lib/format';
import { useAuthStore } from '../../stores/authStore';
import {
  Button, Card, CardHeader, EmptyState, KpiCard,
  TableShell, Thead, Th, Td, Tr, inputClassName,
} from '../../components/ui';
import type { AuditEntryDto } from '../../types';

interface AuditResponse {
  items?: AuditEntryDto[];
  total?: number;
}
interface UsageResponse {
  totals?: { requests?: number; errors?: number };
  window?: string;
}

export function AuditPage() {
  const context = useAuthStore((state) => state.context);
  const readable = can(context, 'audit:read');
  const [applied, setApplied] = useState({ action: '', actor: '', datasetId: '' });
  const [draft, setDraft] = useState(applied);

  const query = new URLSearchParams({ limit: '100' });
  for (const [key, value] of Object.entries(applied)) {
    if (value) query.set(key, value);
  }

  const audit = useQuery({
    queryKey: ['audit', applied],
    enabled: readable,
    queryFn: () => api.get<AuditResponse>(`/v1/capabilities/audit?${query.toString()}`),
    retry: false,
  });
  const usage = useQuery({
    queryKey: ['usage'],
    enabled: readable,
    queryFn: () => api.get<UsageResponse>('/v1/capabilities/usage').catch(() => null),
    retry: false,
  });

  if (!readable) {
    return (
      <Card className="p-6">
        <p className="text-sm font-semibold text-red-700">Your role cannot read the audit trail.</p>
      </Card>
    );
  }

  const items = audit.data?.items ?? [];
  const totals = usage.data?.totals ?? {};
  const usageWindow = usage.data?.window || 'current';

  return (
    <div className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Audit metrics">
        <KpiCard label="Audit entries" value={formatNumber(audit.data?.total || items.length)} icon={<ScrollText size={18} />} />
        <KpiCard label="API requests" value={formatNumber(totals.requests || 0)} icon={<Activity size={18} />} />
        <KpiCard label="Usage errors" value={formatNumber(totals.errors || 0)} icon={<AlertTriangle size={18} />} />
        <KpiCard label="Usage window" value={usageWindow} icon={<Filter size={18} />} />
      </section>

      <Card className="overflow-hidden">
        <CardHeader eyebrow="GOVERNANCE" title="Mutation audit" />
        <form
          className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied({
              action: draft.action.trim(),
              actor: draft.actor.trim(),
              datasetId: draft.datasetId.trim(),
            });
          }}
        >
          <input className={`${inputClassName} max-w-44`} name="action" placeholder="Action (e.g. dataset.review)" value={draft.action} onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value }))} />
          <input className={`${inputClassName} max-w-40`} name="actor" placeholder="Actor" value={draft.actor} onChange={(event) => setDraft((current) => ({ ...current, actor: event.target.value }))} />
          <input className={`${inputClassName} max-w-40`} name="datasetId" placeholder="Dataset id" value={draft.datasetId} onChange={(event) => setDraft((current) => ({ ...current, datasetId: event.target.value }))} />
          <Button type="submit" variant="ghost">Apply filters</Button>
        </form>

        {audit.isLoading ? (
          <div className="grid gap-3 px-5 py-6">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-12 animate-pulse rounded-xl bg-slate-100" />
            ))}
          </div>
        ) : audit.isError ? (
          <div className="px-5 py-8">
            <EmptyState
              title="The audit trail could not be loaded"
              message={(audit.error as Error)?.message}
              action={<Button variant="primary" onClick={() => void audit.refetch()}>Retry</Button>}
            />
          </div>
        ) : items.length === 0 ? (
          <div className="px-5 py-8">
            <EmptyState title="No audit entries match these filters" message="Every mutation is recorded with actor, action and correlation id." />
          </div>
        ) : (
          <TableShell>
            <Thead>
              <Th>When</Th>
              <Th>Actor</Th>
              <Th>Action</Th>
              <Th>Dataset</Th>
              <Th>Record</Th>
              <Th>Correlation</Th>
            </Thead>
            <tbody>
              {items.map((item) => (
                <Tr key={item.id}>
                  <Td className="font-mono text-xs text-slate-500">{relativeTime(item.at)}</Td>
                  <Td>{item.actor || '—'}</Td>
                  <Td><span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">{item.action || '—'}</span></Td>
                  <Td className="font-mono text-xs">{item.datasetId || '—'}</Td>
                  <Td className="font-mono text-xs">{item.recordId || '—'}</Td>
                  <Td className="font-mono text-xs text-slate-500">{item.correlationId || '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
}
