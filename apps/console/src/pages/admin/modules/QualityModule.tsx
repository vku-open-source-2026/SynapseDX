// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Data quality lane: contract versions and the latest quality run for the first dataset. */
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Card, EmptyState, Pill } from '../../../components/ui';
import { previewJson } from '../../../lib/format';
import { api } from '../../../lib/api';
import type { DatasetDto } from '../../../types';

interface Contract {
  version?: string | number;
  compatibility?: string;
  license?: string;
  schema?: Record<string, unknown>;
}
interface QualityRun {
  status?: string;
  failed?: number;
  checked?: number;
}

export function QualityModule() {
  const datasets = useQuery({
    queryKey: ['datasets', 'first'],
    queryFn: () => api.get<DatasetDto[]>('/v1/capabilities/datasets?limit=1'),
    retry: false,
  });
  const dataset = datasets.data?.[0];
  const slug = dataset ? encodeURIComponent(dataset.slug || dataset.id) : '';

  const contract = useQuery({
    queryKey: ['contract', slug],
    enabled: Boolean(slug),
    queryFn: () => api.get<{ contract: Contract | null }>(`/v1/capabilities/datasets/${slug}/contract`).catch(() => ({ contract: null })),
    retry: false,
  });
  const quality = useQuery({
    queryKey: ['quality', slug],
    enabled: Boolean(slug),
    queryFn: () => api.get<{ latest: QualityRun | null }>(`/v1/capabilities/datasets/${slug}/quality`).catch(() => ({ latest: null })),
    retry: false,
  });

  const value = contract.data?.contract;
  const latest = quality.data?.latest;
  const fieldCount = value?.schema ? Object.keys((value.schema as { properties?: object }).properties ?? value.schema).length : 0;

  return (
    <section className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">CAPABILITY MODULE</p>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Data contracts and quality</h2>
        <p className="text-sm text-slate-500">
          {dataset ? `Dataset: ${dataset.name || dataset.slug}. Contract versions and the latest quality run.` : 'Schema compatibility, quality rules and lineage.'}
        </p>
      </div>

      {datasets.isLoading ? (
        <div className="h-32 animate-pulse rounded-2xl bg-slate-100" />
      ) : !dataset ? (
        <EmptyState
          title="No dataset yet"
          message="Create a dataset before contracts and quality rules can run."
          action={<Link to="/admin/datasets" className="inline-flex items-center rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500">Open catalog</Link>}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Contract</p>
            <h3 className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900">
              {value ? `v${value.version ?? 1} · ${value.compatibility || 'n/a'}` : 'No contract'}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              {value
                ? `${fieldCount} fields · license ${value.license || '—'}`
                : 'Publish a contract to pin schema, owner, SLA and retention.'}
            </p>
            {value ? (
              <pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-slate-950 p-3 font-mono text-[11px] text-slate-100">
                {previewJson(value.schema, 800)}
              </pre>
            ) : null}
          </Card>
          <Card className="p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Quality</p>
            <h3 className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900">
              {latest ? `${latest.status ?? 'unknown'} · ${latest.failed ?? 0} failed` : 'No run yet'}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              {latest
                ? `${latest.checked ?? 0} records checked`
                : 'Run quality rules before publishing when a gate is configured.'}
            </p>
            {latest ? (
              <div className="mt-3">
                <Pill tone={(latest.failed ?? 0) === 0 ? 'ok' : 'warn'}>
                  {(latest.failed ?? 0) === 0 ? 'All records pass' : `${latest.failed} record(s) need attention`}
                </Pill>
              </div>
            ) : null}
          </Card>
        </div>
      )}
    </section>
  );
}
