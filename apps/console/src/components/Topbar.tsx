// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useLocation } from '@tanstack/react-router';
import { RadioTower } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getHealth } from '../lib/api';
import { roleLabel, type ManagementContext } from '../lib/rbac';
import { cn } from '../lib/utils';

const PAGE_META: Array<{ prefix: string; eyebrow: string; title: string }> = [
  { prefix: '/admin/datasets', eyebrow: 'CAPABILITY CATALOG', title: 'Datasets and publication' },
  { prefix: '/admin/records', eyebrow: 'RECORD PIPELINE', title: 'Records and projections' },
  { prefix: '/admin/moderation', eyebrow: 'PEER REVIEW', title: 'Publication moderation' },
  { prefix: '/admin/approvals', eyebrow: 'HUMAN IN THE LOOP', title: 'Approvals' },
  { prefix: '/admin/modules', eyebrow: 'H · P · D · I CAPABILITIES', title: 'Business modules' },
  { prefix: '/admin/team', eyebrow: 'ACCESS CONTROL', title: 'Team and roles' },
  { prefix: '/admin/events', eyebrow: 'EVENT BUS', title: 'Events and outbox' },
  { prefix: '/admin/audit', eyebrow: 'GOVERNANCE', title: 'Audit and usage' },
  { prefix: '/admin/settings', eyebrow: 'SESSION', title: 'Console settings' },
  { prefix: '/admin', eyebrow: 'TIER 2 · CAPABILITY CONTROL PLANE', title: 'Operate the open-data layer' },
];

function HealthPill() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
    refetchInterval: 60_000,
    retry: false,
    staleTime: 30_000,
  });
  const unhealthy = (data?.dependencies ?? []).filter((dependency) => dependency.status !== 'ok');
  if (isLoading) {
    return <span className="hidden text-xs text-slate-400 sm:block">Checking the tier chain…</span>;
  }
  const degraded = isError || unhealthy.length > 0 || data?.status !== 'ok';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold',
        degraded
          ? 'border-amber-300 bg-amber-50 text-amber-800'
          : 'border-emerald-200 bg-emerald-50 text-emerald-700',
      )}
      title={degraded ? 'One or more dependencies need attention' : 'Tier chain healthy'}
    >
      <RadioTower size={14} />
      {degraded ? 'Tier chain degraded' : 'Tier chain healthy'}
    </span>
  );
}

export function Topbar({ context }: { context: ManagementContext | null }) {
  const { pathname } = useLocation();
  const match = PAGE_META.find((item) => pathname.startsWith(item.prefix)) ?? PAGE_META[PAGE_META.length - 1];
  const email = context?.user?.email || 'Public visitor';

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-[#f4f8fd]/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between gap-4 px-5 pl-14 lg:pl-5">
        <div className="min-w-0">
          <p className="hidden text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400 md:block">
            {match.eyebrow}
          </p>
          <h1 id="page-title" className="truncate text-base font-semibold tracking-tight text-slate-900 md:text-lg">
            {match.title}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <HealthPill />
          <span className="role-badge hidden items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-800 sm:inline-flex">
            {roleLabel(context)}
          </span>
          <span className="hidden text-xs text-slate-400 xl:block">{email}</span>
        </div>
      </div>
    </header>
  );
}
