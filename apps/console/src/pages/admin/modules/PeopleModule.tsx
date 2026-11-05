// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** People lane: directory linked to verified IAM subjects and KPI progress. */
import { useQuery } from '@tanstack/react-query';
import { Card, EmptyState, Pill, TableShell, Thead, Th, Td, Tr, CardHeader } from '../../../components/ui';
import { api } from '../../../lib/api';

interface Person {
  id?: string;
  name: string;
  email?: string;
  subject?: string;
  manager?: string;
  title?: string;
}
interface Kpi {
  id?: string;
  name: string;
  period?: string;
  progress?: number;
  latestValue?: number | null;
  target?: number;
}

export function PeopleModule() {
  const people = useQuery({
    queryKey: ['people'],
    queryFn: () => api.get<{ items?: Person[] }>('/v1/capabilities/people'),
    retry: false,
  });
  const kpis = useQuery({
    queryKey: ['kpis'],
    queryFn: () => api.get<{ items?: Kpi[] }>('/v1/capabilities/kpis'),
    retry: false,
  });

  const personRows = (people.data?.items ?? []).slice(0, 50);
  const kpiRows = (kpis.data?.items ?? []).slice(0, 50);

  return (
    <section className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">CAPABILITY MODULE</p>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">People, goals and timesheets</h2>
        <p className="text-sm text-slate-500">Directory entries link to verified IAM subjects; KPI progress comes only from check-ins.</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader eyebrow="DIRECTORY" title="People" />
          {people.isLoading ? (
            <div className="grid gap-3 px-5 py-6"><div className="h-12 animate-pulse rounded-xl bg-slate-100" /></div>
          ) : personRows.length === 0 ? (
            <div className="px-5 pb-6"><EmptyState title="No people linked yet" message="Link directory entries to verified Tier-1 IAM subjects." /></div>
          ) : (
            <TableShell>
              <Thead>
                <Th>Person</Th>
                <Th>Manager</Th>
                <Th>Title</Th>
              </Thead>
              <tbody>
                {personRows.map((person, index) => (
                  <Tr key={person.id ?? index}>
                    <Td>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900">{person.name}</p>
                        <p className="truncate text-xs text-slate-400">{person.email || person.subject}</p>
                      </div>
                    </Td>
                    <Td className="font-mono text-xs">{person.manager || '—'}</Td>
                    <Td>{person.title || '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader eyebrow="KPIS" title="Goal progress" />
          {kpis.isLoading ? (
            <div className="grid gap-3 px-5 py-6"><div className="h-12 animate-pulse rounded-xl bg-slate-100" /></div>
          ) : kpiRows.length === 0 ? (
            <div className="px-5 pb-6"><EmptyState title="No KPI check-ins yet" message="Check-ins close the progress loop for each goal." /></div>
          ) : (
            <TableShell>
              <Thead>
                <Th>KPI</Th>
                <Th>Value</Th>
                <Th>Progress</Th>
              </Thead>
              <tbody>
                {kpiRows.map((kpi, index) => {
                  const pct = Math.max(0, Math.min(100, Math.round((kpi.progress || 0) * 100)));
                  const tone = pct >= 100 ? 'ok' : pct >= 50 ? 'warn' : 'neutral';
                  return (
                    <Tr key={kpi.id ?? index}>
                      <Td>
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-slate-900">{kpi.name}</p>
                          <p className="text-xs text-slate-400">{kpi.period || ''}</p>
                        </div>
                      </Td>
                      <Td className="font-mono text-xs">{kpi.latestValue ?? '—'} / {kpi.target ?? '—'}</Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-blue-600" style={{ width: `${pct}%` }} />
                          </div>
                          <Pill tone={tone}>{pct}%</Pill>
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </TableShell>
          )}
        </Card>
      </div>
    </section>
  );
}
