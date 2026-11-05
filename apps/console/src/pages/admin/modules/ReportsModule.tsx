// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Reports lane: saved queries, runs, CSV export and dashboards. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play, FileDown, LayoutDashboard } from 'lucide-react';
import { api } from '../../../lib/api';
import { relativeTime, previewJson } from '../../../lib/format';
import { useToastStore } from '../../../stores/toastStore';
import { Card, CardHeader, EmptyState, TableShell, Thead, Th, Td, Tr } from '../../../components/ui';
import { Modal } from '../../../components/Modal';

interface ReportItem {
  id: string;
  name: string;
  kind?: string;
  datasetId?: string;
  schedule?: { cron?: string } | null;
}
interface DashboardItem {
  id: string;
  name: string;
  widgets?: unknown[];
}
interface Widget {
  title?: string;
  reportId?: string;
  report?: { kind?: string; name?: string };
  error?: string;
  rows?: unknown;
}
interface ReportRunResult {
  report?: { name?: string };
  total?: number;
  generatedAt?: string;
  rows?: unknown;
}

export function ReportsModule() {
  const push = useToastStore((state) => state.push);
  const reports = useQuery({
    queryKey: ['reports'],
    queryFn: () => api.get<{ items?: ReportItem[] }>('/v1/capabilities/reports'),
    retry: false,
  });
  const dashboards = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => api.get<{ items?: DashboardItem[] }>('/v1/capabilities/dashboards').catch(() => ({ items: [] as DashboardItem[] })),
    retry: false,
  });

  const reportRows = (reports.data?.items ?? []).slice(0, 50);
  const dashboardRows = (dashboards.data?.items ?? []).slice(0, 50);

  const [runResult, setRunResult] = useState<ReportRunResult | null>(null);
  const [runBusy, setRunBusy] = useState<string | null>(null);
  const [openDashboard, setOpenDashboard] = useState<string | null>(null);
  const [dashboardData, setDashboardData] = useState<{ dashboard?: { name?: string }; widgets?: Widget[] } | null>(null);
  const [dashboardBusy, setDashboardBusy] = useState(false);

  const runReport = async (report: ReportItem) => {
    setRunBusy(report.id);
    try {
      const result = await api.post<ReportRunResult>(`/v1/capabilities/reports/${encodeURIComponent(report.id)}/run`, {});
      setRunResult(result);
    } catch (failure) {
      push((failure as Error)?.message || 'The report could not be run.', 'bad');
    } finally {
      setRunBusy(null);
    }
  };

  const exportReport = async (report: ReportItem) => {
    setRunBusy(report.id);
    try {
      const result = await api.post<{ content?: string }>(`/v1/capabilities/reports/${encodeURIComponent(report.id)}/export`, {
        format: 'csv',
        idempotencyKey: `console-${Date.now()}`,
      });
      const blob = new Blob([result?.content || ''], { type: 'text/csv' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `report-${report.id}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
      push('CSV export generated.');
    } catch (failure) {
      push((failure as Error)?.message || 'The export could not be generated.', 'bad');
    } finally {
      setRunBusy(null);
    }
  };

  const openDashboardData = async (dashboard: DashboardItem) => {
    setOpenDashboard(dashboard.id);
    setDashboardBusy(true);
    setDashboardData(null);
    try {
      const result = await api.get<{ dashboard?: { name?: string }; widgets?: Widget[] }>(
        `/v1/capabilities/dashboards/${encodeURIComponent(dashboard.id)}/data`,
      );
      setDashboardData(result);
    } catch (failure) {
      push((failure as Error)?.message || 'The dashboard could not be loaded.', 'bad');
      setDashboardData({ dashboard: { name: dashboard.name }, widgets: [] });
    } finally {
      setDashboardBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">CAPABILITY MODULE</p>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Reports and dashboards</h2>
        <p className="text-sm text-slate-500">Saved queries are permission-checked on every run; exports are idempotent and audited.</p>
      </div>

      <Card className="overflow-hidden">
        {reports.isLoading ? (
          <div className="grid gap-3 px-5 py-6"><div className="h-12 animate-pulse rounded-xl bg-slate-100" /></div>
        ) : reportRows.length === 0 ? (
          <div className="px-5 py-6"><EmptyState title="No reports yet" message="Ask the capability team to register a saved query." /></div>
        ) : (
          <TableShell>
            <Thead><Th>Report</Th><Th>Schedule</Th><Th /></Thead>
            <tbody>
              {reportRows.map((report) => (
                <Tr key={report.id}>
                  <Td>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">{report.name}</p>
                      <p className="text-xs text-slate-400">{report.kind} · {report.datasetId || 'no dataset'}</p>
                    </div>
                  </Td>
                  <Td className="font-mono text-xs">{report.schedule?.cron || 'manual'}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        data-action="report-run"
                        disabled={runBusy === report.id}
                        onClick={() => void runReport(report)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        <Play size={12} /> Run
                      </button>
                      <button
                        type="button"
                        data-action="report-export"
                        disabled={runBusy === report.id}
                        onClick={() => void exportReport(report)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        <FileDown size={12} /> Export CSV
                      </button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader eyebrow="DASHBOARDS" title="Decision views" />
        {dashboardRows.length === 0 ? (
          <div className="px-5 pb-6 text-sm text-slate-500">No dashboards yet.</div>
        ) : (
          <TableShell>
            <Thead><Th>Dashboard</Th><Th>Widgets</Th><Th /></Thead>
            <tbody>
              {dashboardRows.map((dashboard) => (
                <Tr key={dashboard.id}>
                  <Td className="font-medium text-slate-800">{dashboard.name}</Td>
                  <Td className="font-mono text-xs">{dashboard.widgets?.length ?? 0}</Td>
                  <Td>
                    <button
                      type="button"
                      data-action="dashboard-open"
                      onClick={() => void openDashboardData(dashboard)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <LayoutDashboard size={12} /> Open
                    </button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Modal
        open={Boolean(runResult)}
        onClose={() => setRunResult(null)}
        title={runResult?.report?.name || 'Report result'}
        eyebrow="REPORT"
        wide
      >
        <p className="text-sm text-slate-500">
          {runResult?.total ?? 0} matching row{runResult?.total === 1 ? '' : 's'} · generated {relativeTime(runResult?.generatedAt)}
        </p>
        <pre className="mt-3 max-h-96 overflow-auto rounded-xl bg-slate-950 p-4 font-mono text-[11px] leading-5 text-slate-100">
          {previewJson(runResult?.rows, 4000)}
        </pre>
      </Modal>

      <Modal
        open={Boolean(openDashboard)}
        onClose={() => setOpenDashboard(null)}
        title={dashboardData?.dashboard?.name || 'Dashboard'}
        eyebrow="DASHBOARD"
        wide
      >
        {dashboardBusy ? (
          <div className="h-32 animate-pulse rounded-xl bg-slate-100" />
        ) : (dashboardData?.widgets ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">No widgets.</p>
        ) : (
          <div className="space-y-3">
            {(dashboardData?.widgets ?? []).map((widget, index) => (
              <div key={index} className="rounded-2xl border border-slate-200 bg-white p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">{widget.report?.kind || 'widget'}</p>
                <h3 className="mt-0.5 text-base font-semibold text-slate-900">{widget.title || widget.report?.name || widget.reportId}</h3>
                {widget.error ? (
                  <p className="mt-1 text-sm text-red-700">{widget.error}</p>
                ) : (
                  <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-[11px] text-slate-600">
                    {previewJson(widget.rows, 2000)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </section>
  );
}
