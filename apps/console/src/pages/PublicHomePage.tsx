// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Database, ShieldCheck, Radio, ArrowRight, ArrowUpRight } from 'lucide-react';
import { PublicHeader } from '../components/PublicHeader';
import { PublicFooter } from '../components/PublicFooter';
import { FeatureGrid } from '../components/FeatureGrid';
import { H2, PRIMARY_BTN, SECONDARY_BTN } from '../components/public-styles';
import { api } from '../lib/api';
import { useI18n, fill } from '../lib/i18n-context';
import { REPO } from '../lib/site';
import type { DatasetDto } from '../types';

const FEATURE_ICONS = [Database, ShieldCheck, Radio];

/** Public, anonymous landing page with the published catalog preview. */
export function PublicHomePage() {
  const { m } = useI18n();
  const h = m.home;
  const { data: datasets, isLoading } = useQuery({
    queryKey: ['public-datasets'],
    queryFn: () => api.get<DatasetDto[]>('/v1/capabilities/datasets?limit=6').catch(() => [] as DatasetDto[]),
    retry: false,
  });
  const publicDatasets = (datasets ?? []).filter((dataset) => dataset.public && dataset.status === 'published');

  return (
    <div className="flex min-h-full flex-col bg-dx-bg text-dx-fg">
      <PublicHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-20 pt-14 sm:px-6 lg:pt-20">
        <section className="grid gap-12 lg:grid-cols-[1.05fr_1fr] lg:items-center">
          <div className="min-w-0">
            <p className="text-sm font-medium text-dx-accent">{h.tierLine}</p>
            <h1 className="mt-3 text-4xl font-semibold leading-[1.1] tracking-tight text-balance sm:text-5xl">{h.title}</h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-dx-muted text-pretty">{h.lead}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link to="/login" className={PRIMARY_BTN}>
                {h.cta} <ArrowRight size={18} aria-hidden="true" />
              </Link>
              <a href="#public-catalog" className={SECONDARY_BTN}>
                {h.explore}
              </a>
            </div>
            <dl className="mt-10 grid max-w-md grid-cols-3 divide-x divide-dx-line border-y border-dx-line">
              {h.stats.map((stat) => (
                <div key={stat.label} className="px-4 py-3 first:pl-0">
                  <dt className="whitespace-nowrap text-xl font-semibold tracking-tight text-dx-fg">{stat.value}</dt>
                  <dd className="whitespace-nowrap text-sm text-dx-muted">{stat.label}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div id="public-catalog" className="min-w-0 scroll-mt-24 overflow-hidden rounded-2xl border border-dx-line bg-dx-surface shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-dx-line bg-dx-subtle px-5 py-3">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2" aria-hidden="true">
                  <span className="status-dot absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <h2 className="text-sm font-semibold text-dx-fg">{h.catalogTitle}</h2>
              </div>
              <span className="hidden whitespace-nowrap font-mono text-[11px] text-dx-muted sm:inline">GET /v1/capabilities/datasets</span>
            </div>
            <ul className="divide-y divide-dx-line">
              {isLoading ? (
                Array.from({ length: 3 }).map((_, index) => (
                  <li key={index} className="px-5 py-4" aria-hidden="true">
                    <div className="h-4 w-2/3 animate-pulse rounded bg-dx-subtle" />
                    <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-dx-subtle" />
                  </li>
                ))
              ) : publicDatasets.length === 0 ? (
                <li className="px-5 py-10 text-center text-sm text-dx-muted">{h.catalogEmpty}</li>
              ) : (
                publicDatasets.map((dataset) => (
                  <li key={dataset.id} className="flex items-start justify-between gap-4 px-5 py-4">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-dx-fg">{dataset.name || dataset.id}</p>
                      <p className="mt-0.5 truncate text-sm text-dx-muted">
                        {dataset.description || fill(h.catalogEntity, { type: dataset.entityType || 'Entity' })}
                      </p>
                    </div>
                    <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-900">
                      {h.published}
                    </span>
                  </li>
                ))
              )}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-dx-line bg-dx-subtle px-5 py-3 text-xs text-dx-muted">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck size={14} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" /> {h.catalogFoot}
              </span>
              <a
                className="inline-flex items-center gap-1 font-semibold text-dx-accent hover:underline"
                href={REPO}
                target="_blank"
                rel="noreferrer"
              >
                {h.howItWorks} <ArrowUpRight size={13} aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>

        <section className="mt-24">
          <h2 className={H2}>{h.featuresTitle}</h2>
          <FeatureGrid items={h.features} icons={FEATURE_ICONS} />
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
