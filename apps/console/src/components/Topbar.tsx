// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useLocation } from '@tanstack/react-router';
import { RadioTower } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getHealth } from '../lib/api';
import { primaryRole, type ManagementContext } from '../lib/rbac';
import { useI18n } from '../lib/i18n-context';
import type { Messages } from '../locales/vi';
import { cn } from '../lib/utils';
import { SiteToggles } from './SiteToggles';

type PageKey = keyof Messages['shell']['pages'];

const PAGE_PREFIX: Array<{ prefix: string; key: PageKey }> = [
  { prefix: '/admin/datasets', key: 'datasets' },
  { prefix: '/admin/records', key: 'records' },
  { prefix: '/admin/moderation', key: 'moderation' },
  { prefix: '/admin/approvals', key: 'approvals' },
  { prefix: '/admin/modules', key: 'modules' },
  { prefix: '/admin/team', key: 'team' },
  { prefix: '/admin/events', key: 'events' },
  { prefix: '/admin/audit', key: 'audit' },
  { prefix: '/admin/settings', key: 'settings' },
  { prefix: '/admin', key: 'overview' },
];

function HealthPill() {
  const { m } = useI18n();
  const h = m.shell.health;
  const { data, isLoading, isError } = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
    refetchInterval: 60_000,
    retry: false,
    staleTime: 30_000,
  });
  const unhealthy = (data?.dependencies ?? []).filter((dependency) => dependency.status !== 'ok');
  if (isLoading) {
    return <span className="hidden whitespace-nowrap text-xs text-dx-muted sm:block">{h.checking}</span>;
  }
  const degraded = isError || unhealthy.length > 0 || data?.status !== 'ok';
  return (
    <span
      className={cn(
        'hidden items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-semibold sm:inline-flex',
        degraded
          ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300'
          : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300',
      )}
      title={degraded ? h.degradedTitle : h.healthyTitle}
    >
      <RadioTower size={14} aria-hidden="true" />
      {degraded ? h.degraded : h.healthy}
    </span>
  );
}

export function Topbar({ context }: { context: ManagementContext | null }) {
  const { pathname } = useLocation();
  const { m } = useI18n();
  const match = PAGE_PREFIX.find((item) => pathname.startsWith(item.prefix)) ?? PAGE_PREFIX[PAGE_PREFIX.length - 1];
  const email = context?.user?.email || m.shell.publicVisitor;
  const role = primaryRole(context);
  const roleText = role ? (m.shell.roles as Record<string, string>)[role] ?? role : m.shell.publicRole;

  return (
    <header className="sticky top-0 z-40 border-b border-dx-line bg-dx-surface/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between gap-3 px-5 pl-14 lg:pl-5">
        <h1 id="page-title" className="min-w-0 truncate text-base font-semibold tracking-tight text-dx-fg md:text-lg">
          {m.shell.pages[match.key]}
        </h1>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <HealthPill />
          <span className="role-badge hidden items-center whitespace-nowrap rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-800 sm:inline-flex dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-200">
            {roleText}
          </span>
          <span className="hidden max-w-[200px] truncate text-xs text-dx-muted xl:block">{email}</span>
          <SiteToggles />
        </div>
      </div>
    </header>
  );
}
