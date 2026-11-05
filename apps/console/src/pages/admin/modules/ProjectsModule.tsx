// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Projects lane: portfolio, stage gates (HITL) and timesheet-derived capacity. */
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, EmptyState, Pill, TableShell, Thead, Th, Td, Tr } from '../../../components/ui';
import { api } from '../../../lib/api';

interface ProjectItem {
  id: string;
  name: string;
  program?: string;
  startDate?: string;
  endDate?: string;
  stage?: number;
  gates?: Array<{ status: string }>;
}
interface CapacityRow {
  name: string;
  hours?: number;
  overAllocated?: boolean;
}

export function ProjectsModule() {
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ items?: ProjectItem[] }>('/v1/capabilities/projects'),
    retry: false,
  });
  const capacity = useQuery({
    queryKey: ['project-capacity'],
    queryFn: () => api.get<{ items?: CapacityRow[] }>('/v1/capabilities/project-capacity').catch(() => ({ items: [] as CapacityRow[] })),
    retry: false,
  });

  const rows = (projects.data?.items ?? []).slice(0, 50);
  const capacityRows = (capacity.data?.items ?? []).slice(0, 50);

  return (
    <section className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">CAPABILITY MODULE</p>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Projects and portfolio</h2>
        <p className="text-sm text-slate-500">Dependencies reject cycles, stage gates use HITL and capacity is derived from approved timesheets.</p>
      </div>

      <Card className="overflow-hidden">
        {projects.isLoading ? (
          <div className="grid gap-3 px-5 py-6"><div className="h-12 animate-pulse rounded-xl bg-slate-100" /></div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-6"><EmptyState title="No projects yet" message="Create a program to start tracking the portfolio." /></div>
        ) : (
          <TableShell>
            <Thead>
              <Th>Project</Th>
              <Th>Dates</Th>
              <Th>Gates</Th>
              <Th>Stage</Th>
            </Thead>
            <tbody>
              {rows.map((project) => {
                const gatePending = project.gates?.some((gate) => gate.status !== 'approved');
                return (
                  <Tr key={project.id}>
                    <Td>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900">{project.name}</p>
                        <p className="text-xs text-slate-400">{project.program || 'portfolio'}</p>
                      </div>
                    </Td>
                    <Td className="font-mono text-xs">
                      {project.startDate?.slice(0, 10) || '—'} → {project.endDate?.slice(0, 10) || '—'}
                    </Td>
                    <Td>
                      <Pill tone={gatePending ? 'warn' : 'ok'}>{gatePending ? 'HITL pending' : 'Approved'}</Pill>
                    </Td>
                    <Td className="font-mono text-xs">{project.stage || 1}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader eyebrow="CAPACITY" title="Allocation" description="Approved timesheet hours per person." />
        {capacity.isLoading ? (
          <div className="grid gap-3 px-5 py-6"><div className="h-12 animate-pulse rounded-xl bg-slate-100" /></div>
        ) : capacityRows.length === 0 ? (
          <div className="px-5 pb-6 text-sm text-slate-500">No approved timesheets yet.</div>
        ) : (
          <TableShell>
            <Thead>
              <Th>Person</Th>
              <Th>Approved hours</Th>
              <Th>Signal</Th>
            </Thead>
            <tbody>
              {capacityRows.map((row, index) => (
                <Tr key={index}>
                  <Td className="font-medium text-slate-800">{row.name}</Td>
                  <Td className="font-mono text-xs">{row.hours ?? 0}h</Td>
                  <Td>
                    <Pill tone={row.overAllocated ? 'bad' : 'ok'}>
                      {row.overAllocated ? 'Over-allocated' : 'Within capacity'}
                    </Pill>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>
    </section>
  );
}
