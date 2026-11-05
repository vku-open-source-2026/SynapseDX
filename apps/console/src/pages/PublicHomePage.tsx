// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Database, ShieldCheck, Radio, ArrowRight, ArrowUpRight } from 'lucide-react';
import { PublicHeader } from '../components/PublicHeader';
import { PublicFooter } from '../components/PublicFooter';
import { api } from '../lib/api';
import { statusTone, statusLabel } from '../lib/format';
import type { DatasetDto } from '../types';
import { Button, Card, Pill } from '../components/ui';

/** Public, anonymous landing page with the published catalog preview. */
export function PublicHomePage() {
  const navigate = useNavigate();
  const { data: datasets } = useQuery({
    queryKey: ['public-datasets'],
    queryFn: () => api.get<DatasetDto[]>('/v1/capabilities/datasets?limit=6').catch(() => [] as DatasetDto[]),
    retry: false,
  });
  const publicDatasets = (datasets ?? []).filter((dataset) => dataset.public && dataset.status === 'published');

  return (
    <div className="flex min-h-full flex-col bg-[#f4f8fd] text-slate-900">
      <PublicHeader />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-12 sm:px-6 lg:py-16">
        <section className="grid gap-10 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-blue-700">
              TIER 2 · PUBLIC CAPABILITY SERVICES
            </p>
            <h1 className="mt-3 text-4xl font-bold leading-[1.15] tracking-tight sm:text-5xl">
              One contract for every domain product.
            </h1>
            <p className="mt-4 max-w-xl text-lg leading-7 text-slate-600">
              SynapseDX packages open city, emergency and infrastructure capabilities behind a stable,
              tenant-scoped API — datasets, records, publication, review and audit are one audited contract.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={() => void navigate({ to: '/login' })} className="px-5 py-3 text-base">
                Sign in to operate the layer <ArrowRight size={18} />
              </Button>
              <a
                href="#public-catalog"
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-3 text-base font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
              >
                Explore public datasets
              </a>
            </div>
            <dl className="mt-8 grid max-w-md grid-cols-3 gap-4 text-sm">
              <div>
                <dt className="text-2xl font-bold text-slate-900">Tier 2</dt>
                <dd className="text-slate-500">for products</dd>
              </div>
              <div>
                <dt className="text-2xl font-bold text-slate-900">Tier 1</dt>
                <dd className="text-slate-500">for persistence</dd>
              </div>
              <div>
                <dt className="text-2xl font-bold text-slate-900">100%</dt>
                <dd className="text-slate-500">audited</dd>
              </div>
            </dl>
          </div>

          <Card className="relative overflow-hidden p-0">
            <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-5 py-3">
              <div className="flex items-center gap-2">
                <Database size={16} className="text-slate-400" />
                <span className="text-sm font-semibold text-slate-700">Live capability catalog</span>
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">published</span>
            </div>
            <div className="divide-y divide-slate-100">
              {publicDatasets.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-slate-500">
                  No public datasets are published yet.
                </div>
              ) : (
                publicDatasets.map((dataset) => (
                  <div key={dataset.id} className="flex items-start justify-between gap-4 px-5 py-4">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-800">{dataset.name || dataset.id}</p>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {dataset.description || `${dataset.entityType || 'Entity'} dataset`}
                      </p>
                    </div>
                    <Pill tone={statusTone(dataset.status)}>{statusLabel(dataset.status)}</Pill>
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center justify-between bg-slate-50 px-5 py-3 text-[11px] text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck size={14} className="text-emerald-500" /> Moderator-approved publication
              </span>
              <a
                className="inline-flex items-center gap-1 font-semibold text-blue-700 hover:text-blue-600"
                href="https://github.com/vku-open-source-2026/SynapseDX"
                target="_blank"
                rel="noreferrer"
              >
                How it works <ArrowUpRight size={12} />
              </a>
            </div>
          </Card>
        </section>

        <section id="public-catalog" className="mt-14 grid gap-4 md:grid-cols-3">
          {[
            {
              icon: <Database size={18} />,
              title: 'Datasets & records',
              text: 'Register datasets, manage records and import 1–100 at a time with per-row error reporting.',
            },
            {
              icon: <ShieldCheck size={18} />,
              title: 'Human-in-the-loop',
              text: 'Peer review, publish approval and tenant-scoped decisions with a full audit trail.',
            },
            {
              icon: <Radio size={18} />,
              title: 'Events & outbox',
              text: 'At-least-once delivery with bounded replay; every mutation is recorded in Tier-1.',
            },
          ].map((feature) => (
            <Card key={feature.title} className="p-5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                {feature.icon}
              </div>
              <h2 className="mt-3 text-base font-semibold text-slate-900">{feature.title}</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">{feature.text}</p>
            </Card>
          ))}
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
