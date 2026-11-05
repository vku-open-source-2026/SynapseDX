// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Database, CheckCircle2, Scale, RadioTower, ArrowRight, Boxes } from 'lucide-react';
import { api, getHealth } from '../../lib/api';
import { can, roleLabel } from '../../lib/rbac';
import { formatNumber, relativeTime } from '../../lib/format';
import { useAuthStore } from '../../stores/authStore';
import { Button, Card, Chip, KpiCard, TableShell, Thead, Th, Td, Tr } from '../../components/ui';
import type { ManagementSummaryDto } from '../../types';

export function OverviewPage() {
  const navigate = useNavigate();
  const context = useAuthStore((state) => state.context);
  const summary = useQuery({
    queryKey: ['management/summary'],
    queryFn: () => api.get<ManagementSummaryDto>('/v1/capabilities/management/summary'),
    retry: false,
  });
  const health = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
    retry: false,
    staleTime: 30_000,
  });

  if (summary.isError) {
    const message = (summary.error as Error)?.message || 'Could not load the summary.';
    return (
      <Card className="p-6">
        <p className="text-sm font-semibold text-red-700">{message}</p>
        <div className="mt-3 flex gap-2">
          <Button variant="primary" onClick={() => void summary.refetch()}>Retry</Button>
        </div>
      </Card>
    );
  }

  const data = summary.data;
  const dependencies = health.data?.dependencies ?? [];
  const unhealthy = dependencies.filter((dependency) => dependency.status !== 'ok');
  const metrics = data?.datasets;
  const recentAudit = (data?.recentAudit ?? []).slice(0, 6);
  const canWriteDatasets = can(context, 'datasets:write');

  return (
    <div className="space-y-6">
      <section
        className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-blue-700 via-blue-600 to-cyan-500 p-6 text-white shadow-lg sm:p-8"
        aria-label="Capability overview hero"
      >
        <div className="pointer-events-none absolute -right-10 -top-10 h-56 w-56 rounded-full border border-white/15" />
        <div className="pointer-events-none absolute -right-24 top-16 h-56 w-56 rounded-full border border-white/10" />
        <div className="pointer-events-none absolute -right-28 top-48 h-56 w-56 rounded-full border border-white/5" />
        <div className="relative flex flex-wrap items-center justify-between gap-6">
          <div className="max-w-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-cyan-100/90">
              {roleLabel(context).toUpperCase()} WORKSPACE
            </p>
            <h1 className="mt-2 text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
              Govern the capability layer with evidence.
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-blue-50/90">
              Datasets, records, publication, review and audit are one contract. Every mutation is
              tenant-scoped and recorded in Tier-1.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {canWriteDatasets ? (
                <Button
                  variant="primary"
                  className="!bg-white !text-blue-800 hover:!bg-blue-50"
                  onClick={() => void navigate({ to: '/admin/datasets', search: { new: '1' } as never })}
                >
                  New dataset <ArrowRight size={16} />
                </Button>
              ) : null}
              <Link to="/admin/audit" className="inline-flex items-center gap-1.5 text-sm font-semibold text-white/90 underline-offset-4 hover:underline">
                Open audit trail <ArrowRight size={14} />
              </Link>
            </div>
          </div>
          <div className="hidden h-28 w-28 shrink-0 items-center justify-center rounded-3xl border border-white/25 bg-white/10 backdrop-blur md:flex">
            <Boxes size={64} strokeWidth={1.4} className="text-white/90" />
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Key metrics">
        <KpiCard label="Datasets" value={formatNumber(metrics?.total)} icon={<Database size={18} />} hint="Registered" />
        <KpiCard label="Published" value={formatNumber(metrics?.published)} icon={<CheckCircle2 size={18} />} hint="Live on the public projection" />
        <KpiCard label="Awaiting review" value={formatNumber(metrics?.pendingReview)} icon={<Scale size={18} />} hint="Moderator queue" />
        <KpiCard
          label="Tier chain"
          value={unhealthy.length ? 'Degraded' : 'Connected'}
          icon={<RadioTower size={18} />}
          hint={unhealthy.length ? `${unhealthy.length} dependencies need attention` : 'Tier chain healthy'}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="border-b border-slate-100 px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Tenant context</p>
            <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900">
              {data?.roles?.join(' · ') || 'No role'}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Tenant <code className="rounded bg-slate-100 px-1">{context?.tenant || '—'}</code> · account{' '}
              <code className="rounded bg-slate-100 px-1">{context?.account || '—'}</code>
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 px-5 py-4">
            {(data?.permissions ?? []).slice(0, 10).map((permission) => (
              <Chip key={permission}>{permission}</Chip>
            ))}
            {!data?.permissions?.length ? <p className="text-sm text-slate-500">No permissions projected.</p> : null}
          </div>
        </Card>

        <Card className="flex flex-col">
          <div className="border-b border-slate-100 px-5 py-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Outbox</p>
            <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900">
              {formatNumber(data?.pendingEvents ?? 0)} pending event{data?.pendingEvents === 1 ? '' : 's'}
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              Queue delivery is at-least-once. Pending items stay in the dataset outbox and can be replayed by an operator.
            </p>
          </div>
          <div className="mt-auto px-5 py-4">
            <Link to="/admin/events" className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-700 hover:text-blue-600">
              Inspect event feed <ArrowRight size={14} />
            </Link>
          </div>
        </Card>
      </section>

      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Recent mutations</p>
            <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900">Audit trail</h2>
          </div>
          <Link to="/admin/audit" className="text-sm font-semibold text-blue-700 hover:text-blue-600">
            View all →
          </Link>
        </div>
        {recentAudit.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No mutations recorded yet.</p>
        ) : (
          <TableShell>
            <Thead>
              <Th>When</Th>
              <Th>Actor</Th>
              <Th>Action</Th>
              <Th>Dataset</Th>
            </Thead>
            <tbody>
              {recentAudit.map((item) => (
                <Tr key={item.id}>
                  <Td className="font-mono text-xs text-slate-500">{relativeTime(item.at)}</Td>
                  <Td>{item.actor || '—'}</Td>
                  <Td>
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">
                      {item.action || '—'}
                    </span>
                  </Td>
                  <Td className="font-mono text-xs">{item.datasetId || '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
}
