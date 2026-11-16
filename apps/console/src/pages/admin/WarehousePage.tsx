// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Manager data studio: warehouse datasets, SQL templates, saved reports and
 * published dashboards. Tier-1 runs the SQL; Tier-2 scopes and snapshots.
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Database, Play, Plus, RefreshCw, Send, Table2, Pause, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useToastStore } from '../../stores/toastStore';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Pill,
  inputClassName,
  selectClassName,
} from '../../components/ui';

interface Column { name: string; type: string }
interface Dataset {
  id: string;
  name: string;
  description?: string;
  mode: 'batch' | 'stream';
  streamTopic?: string | null;
  rowCount: number;
  columns: Column[];
}
interface Template {
  id: string;
  name: string;
  mode: 'batch' | 'stream';
  description: string;
  sqlTemplate?: string;
}
interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  durationMs: number;
}
interface Report {
  id: string;
  name: string;
  description?: string;
  sql: string;
  visibility: 'private' | 'published';
  shareId?: string;
}
interface Dashboard {
  id: string;
  name: string;
  description?: string;
  visibility: 'private' | 'published';
  shareId?: string;
  widgets: Array<{ id: string; reportId: string; title?: string }>;
}
interface UseCase {
  id: string;
  name: string;
  description: string;
  datasets: string[];
  queries: Array<{ name: string; sql: string }>;
}
interface DashboardRun {
  dashboard: Dashboard;
  widgets: Array<{
    widget: { id: string; title?: string };
    report: { id: string; name: string };
    result: QueryResult;
  }>;
}
interface Job {
  id: string;
  name: string;
  mode: 'batch' | 'stream';
  status: string;
  targetDatasetId: string;
  streamTopic?: string | null;
  lastError?: string | null;
}

const DEFAULT_SQL = "SELECT city, count(*) AS incidents, avg(severity) AS avg_severity\nFROM city_incidents\nGROUP BY city\nORDER BY incidents DESC";

function ResultTable({ result }: { result: QueryResult }) {
  if (!result?.columns?.length) return <EmptyState title="No rows" message="The query returned no columns." />;
  return (
    <div className="overflow-auto rounded-xl border border-slate-200 dark:border-[#26354d]">
      <table className="min-w-full text-left text-xs">
        <thead className="bg-slate-50 text-slate-500 dark:bg-[#142136] dark:text-slate-400">
          <tr>
            {result.columns.map((column) => (
              <th key={column} className="whitespace-nowrap px-3 py-2 font-semibold">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-[#1f2c40]">
          {result.rows.slice(0, 50).map((row, index) => (
            <tr key={index} className="text-slate-700 dark:text-slate-200">
              {result.columns.map((column) => (
                <td key={column} className="max-w-[18rem] truncate px-3 py-2 font-mono">
                  {typeof row[column] === 'object' ? JSON.stringify(row[column]) : String(row[column] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500 dark:border-[#1f2c40] dark:text-slate-400">
        {result.rowCount} row(s) · {result.durationMs} ms
      </p>
    </div>
  );
}

export function WarehousePage() {
  const queryClient = useQueryClient();
  const push = useToastStore((state) => state.push);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [templateId, setTemplateId] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [reportName, setReportName] = useState('');
  const [dashboardRun, setDashboardRun] = useState<DashboardRun | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showDatasetForm, setShowDatasetForm] = useState(false);
  const [datasetForm, setDatasetForm] = useState({
    id: '',
    name: '',
    description: '',
    mode: 'batch' as 'batch' | 'stream',
    streamTopic: '',
    columns: '[\n  {"name":"value","type":"number"}\n]',
  });

  const status = useQuery({ queryKey: ['warehouse', 'status'], queryFn: () => api.get<any>('/v1/capabilities/warehouse/status') });
  const datasets = useQuery({ queryKey: ['warehouse', 'datasets'], queryFn: () => api.get<{ items: Dataset[] }>('/v1/capabilities/warehouse/datasets') });
  const templates = useQuery({ queryKey: ['warehouse', 'templates'], queryFn: () => api.get<{ items: Template[] }>('/v1/capabilities/warehouse/templates') });
  const workflowTemplates = useQuery({ queryKey: ['warehouse', 'workflow-templates'], queryFn: () => api.get<{ items: Array<{ name: string; description: string }> }>('/v1/capabilities/warehouse/workflow-templates') });
  const useCases = useQuery({ queryKey: ['warehouse', 'use-cases'], queryFn: () => api.get<{ items: UseCase[] }>('/v1/capabilities/warehouse/use-cases') });
  const reports = useQuery({ queryKey: ['warehouse', 'reports'], queryFn: () => api.get<{ items: Report[] }>('/v1/capabilities/warehouse/reports') });
  const dashboards = useQuery({ queryKey: ['warehouse', 'dashboards'], queryFn: () => api.get<{ items: Dashboard[] }>('/v1/capabilities/warehouse/dashboards') });
  const jobs = useQuery({ queryKey: ['warehouse', 'jobs'], queryFn: () => api.get<{ items: Job[] }>('/v1/capabilities/warehouse/jobs') });

  const template = useMemo(
    () => templates.data?.items.find((item) => item.id === templateId),
    [templates.data, templateId],
  );

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['warehouse'] });
  };

  const runQuery = async () => {
    if (busy) return;
    setBusy('query');
    try {
      const next = await api.post<QueryResult>('/v1/capabilities/warehouse/query', { sql, limit: 200 });
      setResult(next);
      push(`Query returned ${next.rowCount} row(s).`);
    } catch (error) {
      push((error as Error).message || 'Query failed.');
    } finally {
      setBusy(null);
    }
  };

  const seed = async (id: string) => {
    if (busy) return;
    setBusy(`seed:${id}`);
    try {
      await api.post(`/v1/capabilities/warehouse/use-cases/${encodeURIComponent(id)}/seed`);
      push('Use case data is ready.');
      await refresh();
    } catch (error) {
      push((error as Error).message || 'Could not seed the use case.');
    } finally {
      setBusy(null);
    }
  };

  const saveReport = async () => {
    if (busy || !sql.trim()) return;
    setBusy('save');
    try {
      await api.post('/v1/capabilities/warehouse/reports', {
        name: reportName.trim() || `Saved query ${new Date().toLocaleString()}`,
        sql,
        limit: 200,
      });
      setReportName('');
      push('Report saved.');
      await refresh();
    } catch (error) {
      push((error as Error).message || 'Could not save the report.');
    } finally {
      setBusy(null);
    }
  };

  const runReport = async (id: string) => {
    if (busy) return;
    setBusy(`report:${id}`);
    try {
      const response = await api.post<{ result: QueryResult }>(`/v1/capabilities/warehouse/reports/${encodeURIComponent(id)}/run`);
      setResult(response.result);
      push('Report executed.');
    } catch (error) {
      push((error as Error).message || 'Could not run the report.');
    } finally {
      setBusy(null);
    }
  };

  const publishReport = async (id: string) => {
    if (busy) return;
    setBusy(`publish:${id}`);
    try {
      const published = await api.post<Report>(`/v1/capabilities/warehouse/reports/${encodeURIComponent(id)}/publish`);
      push(published.shareId ? `Published snapshot: ${published.shareId.slice(0, 8)}…` : 'Published.');
      await refresh();
    } catch (error) {
      push((error as Error).message || 'Could not publish the report.');
    } finally {
      setBusy(null);
    }
  };

  const instantiateWorkflow = async (template: string) => {
    if (busy) return;
    setBusy(`workflow:${template}`);
    try {
      const created = await api.post<any>(`/v1/capabilities/warehouse/workflow-templates/${encodeURIComponent(template)}/instantiate`, {});
      push(created?.id ? `Workflow ${created.id.slice(0, 8)}… created.` : 'Workflow created.');
    } catch (error) {
      push((error as Error).message || 'Could not create the workflow.');
    } finally {
      setBusy(null);
    }
  };

  const createDataset = async () => {
    if (busy) return;
    let columns: Column[];
    try {
      columns = JSON.parse(datasetForm.columns) as Column[];
      if (!Array.isArray(columns) || !columns.length) throw new Error('columns must be a non-empty array');
    } catch (error) {
      push(`Invalid columns JSON: ${(error as Error).message}`);
      return;
    }
    setBusy('dataset:create');
    try {
      await api.post('/v1/capabilities/warehouse/datasets', {
        ...(datasetForm.id.trim() ? { id: datasetForm.id.trim() } : {}),
        name: datasetForm.name.trim(),
        ...(datasetForm.description.trim() ? { description: datasetForm.description.trim() } : {}),
        mode: datasetForm.mode,
        ...(datasetForm.mode === 'stream' && datasetForm.streamTopic.trim()
          ? { streamTopic: datasetForm.streamTopic.trim() }
          : {}),
        columns,
      });
      push('Dataset created.');
      setShowDatasetForm(false);
      setDatasetForm({ id: '', name: '', description: '', mode: 'batch', streamTopic: '', columns: '[\n  {"name":"value","type":"number"}\n]' });
      await refresh();
    } catch (error) {
      push((error as Error).message || 'Could not create the dataset.');
    } finally {
      setBusy(null);
    }
  };

  const deleteDataset = async (id: string) => {
    if (busy || !window.confirm(`Delete dataset "${id}" and all its jobs?`)) return;
    setBusy(`dataset:delete:${id}`);
    try {
      await api.del(`/v1/capabilities/warehouse/datasets/${encodeURIComponent(id)}`);
      push('Dataset deleted.');
      await refresh();
    } catch (error) {
      push((error as Error).message || 'Could not delete the dataset.');
    } finally {
      setBusy(null);
    }
  };

  const jobAction = async (id: string, action: 'run' | 'pause' | 'resume' | 'delete') => {
    if (busy) return;
    if (action === 'delete' && !window.confirm(`Delete job "${id}"?`)) return;
    setBusy(`job:${action}:${id}`);
    try {
      const path = `/v1/capabilities/warehouse/jobs/${encodeURIComponent(id)}${action === 'delete' ? '' : `/${action}`}`;
      if (action === 'delete') await api.del(path);
      else await api.post(path);
      push(`Job ${action === 'delete' ? 'deleted' : action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'started'}.`);
      await refresh();
    } catch (error) {
      push((error as Error).message || `Could not ${action} the job.`);
    } finally {
      setBusy(null);
    }
  };

  const deleteReport = async (id: string) => {
    if (busy || !window.confirm('Delete this report?')) return;
    setBusy(`report:delete:${id}`);
    try {
      await api.del(`/v1/capabilities/warehouse/reports/${encodeURIComponent(id)}`);
      push('Report deleted.');
      await refresh();
    } catch (error) {
      push((error as Error).message || 'Could not delete the report.');
    } finally {
      setBusy(null);
    }
  };

  const createDashboard = async () => {
    if (busy) return;
    const name = window.prompt('Dashboard name:');
    if (!name || !name.trim()) return;
    const available = reports.data?.items || [];
    if (!available.length) {
      push('Save at least one report before creating a dashboard.');
      return;
    }
    setBusy('dashboard:create');
    try {
      await api.post('/v1/capabilities/warehouse/dashboards', {
        name: name.trim(),
        widgets: available.map((report, index) => ({
          reportId: report.id,
          title: report.name,
          x: 0,
          y: index * 4,
          w: 12,
          h: 4,
        })).slice(0, 12),
      });
      push('Dashboard created.');
      await refresh();
    } catch (error) {
      push((error as Error).message || 'Could not create the dashboard.');
    } finally {
      setBusy(null);
    }
  };

  const deleteDashboard = async (id: string) => {
    if (busy || !window.confirm('Delete this dashboard?')) return;
    setBusy(`dashboard:delete:${id}`);
    try {
      await api.del(`/v1/capabilities/warehouse/dashboards/${encodeURIComponent(id)}`);
      push('Dashboard deleted.');
      await refresh();
    } catch (error) {
      push((error as Error).message || 'Could not delete the dashboard.');
    } finally {
      setBusy(null);
    }
  };

  const runDashboard = async (id: string) => {    if (busy) return;
    setBusy(`dashboard:${id}`);
    try {
      setDashboardRun(await api.post<DashboardRun>(`/v1/capabilities/warehouse/dashboards/${encodeURIComponent(id)}/run`));
      push('Dashboard refreshed.');
    } catch (error) {
      push((error as Error).message || 'Could not run the dashboard.');
    } finally {
      setBusy(null);
    }
  };

  const publishDashboard = async (id: string) => {
    if (busy) return;
    setBusy(`publish-dashboard:${id}`);
    try {
      const published = await api.post<Dashboard>(`/v1/capabilities/warehouse/dashboards/${encodeURIComponent(id)}/publish`);
      push(published.shareId ? `Dashboard published: ${published.shareId.slice(0, 8)}…` : 'Dashboard published.');
      await refresh();
    } catch (error) {
      push((error as Error).message || 'Could not publish the dashboard.');
    } finally {
      setBusy(null);
    }
  };

  const statusTone = status.data?.status === 'ok' ? 'ok' : 'warn';

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          eyebrow="Tier 2 · data studio"
          title="Synapse Warehouse"
          description="Run governed SQL over Tier-1 OLAP datasets, save manager reports and publish immutable snapshots for Tier-3 sites."
          actions={
            <>
              <Pill tone={statusTone}>{status.data?.status || 'checking'}</Pill>
              <Button variant="ghost" onClick={() => void refresh()} disabled={Boolean(busy)}>
                <RefreshCw size={14} /> Refresh
              </Button>
            </>
          }
        />
        <div className="grid gap-3 px-5 py-4 md:grid-cols-3">
          <div className="rounded-xl border border-slate-200 p-3 dark:border-[#26354d]">
            <p className="text-xs text-slate-500 dark:text-slate-400">Datasets</p>
            <p className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{datasets.data?.items.length ?? 0}</p>
          </div>
          <div className="rounded-xl border border-slate-200 p-3 dark:border-[#26354d]">
            <p className="text-xs text-slate-500 dark:text-slate-400">Saved reports</p>
            <p className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{reports.data?.items.length ?? 0}</p>
          </div>
          <div className="rounded-xl border border-slate-200 p-3 dark:border-[#26354d]">
            <p className="text-xs text-slate-500 dark:text-slate-400">Dashboards</p>
            <p className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{dashboards.data?.items.length ?? 0}</p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader eyebrow="Use cases" title="Start from a working ETL + dashboard" description="Seed a tenant-scoped demo: datasets, batch/stream ETL, reports and a manager dashboard." />
        <div className="grid gap-3 px-5 py-4 lg:grid-cols-3">
          {(useCases.data?.items || []).map((useCase) => (
            <div key={useCase.id} className="flex flex-col gap-2 rounded-xl border border-slate-200 p-4 dark:border-[#26354d]">
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{useCase.name}</p>
              <p className="flex-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{useCase.description}</p>
              <div className="flex flex-wrap gap-1">
                {useCase.datasets.map((dataset) => <Pill key={dataset} tone="neutral">{dataset}</Pill>)}
              </div>
              <Button variant="primary" onClick={() => void seed(useCase.id)} disabled={Boolean(busy)}>
                <Plus size={14} /> {busy === `seed:${useCase.id}` ? 'Seeding…' : 'Seed use case'}
              </Button>
            </div>
          ))}
          {useCases.isLoading ? <p className="text-sm text-slate-500">Loading use cases…</p> : null}
        </div>
      </Card>

      <Card>
        <CardHeader
          eyebrow="SynapseFlow"
          title="ETL workflow templates"
          description="Tier-1 owns batch/stream orchestration. Instantiate a template here, then edit the graph in SynapseFlow."
        />
        <div className="grid gap-3 px-5 py-4 lg:grid-cols-3">
          {(workflowTemplates.data?.items || []).map((template) => (
            <div key={template.name} className="flex flex-col gap-2 rounded-xl border border-slate-200 p-4 dark:border-[#26354d]">
              <p className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">{template.name}</p>
              <p className="flex-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{template.description}</p>
              <Button variant="ghost" onClick={() => void instantiateWorkflow(template.name)} disabled={Boolean(busy)}>
                <Plus size={14} /> {busy === `workflow:${template.name}` ? 'Creating…' : 'Create workflow'}
              </Button>
            </div>
          ))}
          {!workflowTemplates.data?.items?.length ? <p className="text-sm text-slate-500 dark:text-slate-400">No ETL workflow templates advertised by Tier 1.</p> : null}
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader
            eyebrow="SQL"
            title="Query studio"
            description="Only read-only SELECT/WITH statements are accepted. Tier 1 blocks file access and DDL."
            actions={<Button variant="primary" onClick={() => void runQuery()} disabled={Boolean(busy)}><Play size={14} /> Run</Button>}
          />
          <div className="space-y-3 px-5 py-4">
            <select
              className={selectClassName}
              value={templateId}
              onChange={(event) => {
                const next = event.target.value;
                setTemplateId(next);
                const found = templates.data?.items.find((item) => item.id === next);
                if (found?.sqlTemplate) setSql(found.sqlTemplate);
              }}
            >
              <option value="">Blank query / choose a template</option>
              {(templates.data?.items || []).map((item) => (
                <option key={item.id} value={item.id}>{item.name} ({item.mode})</option>
              ))}
            </select>
            {template ? <p className="text-xs text-slate-500 dark:text-slate-400">{template.description}</p> : null}
            <textarea
              className={`${inputClassName} min-h-[220px] font-mono text-xs leading-5`}
              value={sql}
              onChange={(event) => setSql(event.target.value)}
              spellCheck={false}
            />
            <div className="flex flex-wrap gap-2">
              <input
                className={`${inputClassName} max-w-xs`}
                placeholder="Report name"
                value={reportName}
                onChange={(event) => setReportName(event.target.value)}
              />
              <Button variant="ghost" onClick={() => void saveReport()} disabled={Boolean(busy)}>
                <Send size={14} /> Save as report
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            eyebrow="Datasets"
            title="Warehouse tables"
            description="Tier-1 DuckDB tables in this tenant."
            actions={
              <Button variant="ghost" onClick={() => setShowDatasetForm((value) => !value)} disabled={Boolean(busy)}>
                <Plus size={14} /> New dataset
              </Button>
            }
          />
          {showDatasetForm ? (
            <div className="space-y-2 border-b border-slate-100 px-5 py-4 dark:border-[#1f2c40]">
              <div className="grid gap-2 md:grid-cols-2">
                <input className={inputClassName} placeholder="id (optional; slug)" value={datasetForm.id} onChange={(event) => setDatasetForm((value) => ({ ...value, id: event.target.value }))} />
                <input className={inputClassName} placeholder="name" value={datasetForm.name} onChange={(event) => setDatasetForm((value) => ({ ...value, name: event.target.value }))} />
                <input className={inputClassName} placeholder="description (optional)" value={datasetForm.description} onChange={(event) => setDatasetForm((value) => ({ ...value, description: event.target.value }))} />
                <select className={selectClassName} value={datasetForm.mode} onChange={(event) => setDatasetForm((value) => ({ ...value, mode: event.target.value as 'batch' | 'stream' }))}>
                  <option value="batch">batch</option>
                  <option value="stream">stream</option>
                </select>
                {datasetForm.mode === 'stream' ? (
                  <input className={inputClassName} placeholder="stream topic" value={datasetForm.streamTopic} onChange={(event) => setDatasetForm((value) => ({ ...value, streamTopic: event.target.value }))} />
                ) : null}
              </div>
              <textarea
                className={`${inputClassName} min-h-[90px] font-mono text-xs`}
                value={datasetForm.columns}
                onChange={(event) => setDatasetForm((value) => ({ ...value, columns: event.target.value }))}
                spellCheck={false}
              />
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => void createDataset()} disabled={Boolean(busy) || !datasetForm.name.trim()}>
                  <Plus size={14} /> Create dataset
                </Button>
                <Button variant="ghost" onClick={() => setShowDatasetForm(false)} disabled={Boolean(busy)}>Cancel</Button>
              </div>
            </div>
          ) : null}
          <div className="space-y-2 px-5 py-4">
            {(datasets.data?.items || []).map((dataset) => (
              <div key={dataset.id} className="rounded-xl border border-slate-200 p-3 dark:border-[#26354d]">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Database size={14} className="text-cyan-600" />
                    <span className="font-mono text-xs font-semibold text-slate-800 dark:text-slate-100">{dataset.id}</span>
                  </div>
                  <div className="flex gap-1">
                    <Pill tone={dataset.mode === 'stream' ? 'warn' : 'neutral'}>{dataset.mode}</Pill>
                    <Pill tone="ok">{dataset.rowCount} rows</Pill>
                    <Button variant="ghost" onClick={() => void deleteDataset(dataset.id)} disabled={Boolean(busy)}>
                      <Trash2 size={13} className="text-red-500" />
                    </Button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {dataset.name}{dataset.streamTopic ? ` · topic ${dataset.streamTopic}` : ''}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {dataset.columns.slice(0, 8).map((column) => (
                    <span key={column.name} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {column.name}:{column.type}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {!datasets.data?.items.length ? <EmptyState icon={<Database size={18} />} title="No datasets yet" message="Seed a use case or create a dataset through the API." /> : null}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          eyebrow="ETL jobs"
          title="Batch and stream jobs"
          description="Run, pause, resume or delete Tier-1 materialization jobs."
          actions={<Button variant="ghost" onClick={() => void refresh()} disabled={Boolean(busy)}><RefreshCw size={14} /> Refresh</Button>}
        />
        <div className="space-y-2 px-5 py-4">
          {(jobs.data?.items || []).map((job) => (
            <div key={job.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 dark:border-[#26354d]">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{job.name}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {job.id} · {job.mode} → {job.targetDatasetId}
                  {job.streamTopic ? ` · ${job.streamTopic}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Pill tone={job.status === 'running' ? 'ok' : job.status === 'paused' ? 'warn' : 'neutral'}>{job.status}</Pill>
                {job.mode === 'batch' ? (
                  <Button variant="ghost" onClick={() => void jobAction(job.id, 'run')} disabled={Boolean(busy)}><Play size={13} /> Run</Button>
                ) : job.status === 'paused' ? (
                  <Button variant="ghost" onClick={() => void jobAction(job.id, 'resume')} disabled={Boolean(busy)}><RotateCcw size={13} /> Resume</Button>
                ) : (
                  <Button variant="ghost" onClick={() => void jobAction(job.id, 'pause')} disabled={Boolean(busy)}><Pause size={13} /> Pause</Button>
                )}
                <Button variant="ghost" onClick={() => void jobAction(job.id, 'delete')} disabled={Boolean(busy)}>
                  <Trash2 size={13} className="text-red-500" />
                </Button>
              </div>
            </div>
          ))}
          {!jobs.data?.items?.length ? <EmptyState icon={<Play size={18} />} title="No jobs" message="Create an ETL job from a use case or stream template." /> : null}
        </div>
      </Card>

      {result ? (
        <Card>
          <CardHeader eyebrow="Result" title="Query output" actions={<Pill tone="neutral">{result.rowCount} rows</Pill>} />
          <div className="px-5 py-4"><ResultTable result={result} /></div>
        </Card>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader eyebrow="Reports" title="Saved manager reports" description="Run now or publish a snapshot for Tier 3." />
          <div className="space-y-2 px-5 py-4">
            {(reports.data?.items || []).map((report) => (
              <div key={report.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 dark:border-[#26354d]">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{report.name}</p>
                  <p className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">{report.sql.slice(0, 110)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Pill tone={report.visibility === 'published' ? 'ok' : 'neutral'}>{report.visibility}</Pill>
                  <Button variant="ghost" onClick={() => void runReport(report.id)} disabled={Boolean(busy)}><Play size={13} /> Run</Button>
                  <Button variant="ok" onClick={() => void publishReport(report.id)} disabled={Boolean(busy)}>Publish</Button>
                  <Button variant="ghost" onClick={() => void deleteReport(report.id)} disabled={Boolean(busy)}>
                    <Trash2 size={13} className="text-red-500" />
                  </Button>
                </div>
              </div>
            ))}
            {!reports.data?.items.length ? <EmptyState icon={<Table2 size={18} />} title="No reports" message="Run a query and save it as a report." /> : null}
          </div>
        </Card>

        <Card>
          <CardHeader
            eyebrow="Dashboards"
            title="Manager dashboards"
            description="A dashboard is a small set of reports; publish stores the snapshots."
            actions={<Button variant="ghost" onClick={() => void createDashboard()} disabled={Boolean(busy)}><Plus size={14} /> New dashboard</Button>}
          />
          <div className="space-y-2 px-5 py-4">
            {(dashboards.data?.items || []).map((dashboard) => (
              <div key={dashboard.id} className="rounded-xl border border-slate-200 p-3 dark:border-[#26354d]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{dashboard.name}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{dashboard.widgets.length} widget(s)</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={dashboard.visibility === 'published' ? 'ok' : 'neutral'}>{dashboard.visibility}</Pill>
                    <Button variant="ghost" onClick={() => void runDashboard(dashboard.id)} disabled={Boolean(busy)}><BarChart3 size={13} /> Run</Button>
                    <Button variant="ok" onClick={() => void publishDashboard(dashboard.id)} disabled={Boolean(busy)}>Publish</Button>
                    <Button variant="ghost" onClick={() => void deleteDashboard(dashboard.id)} disabled={Boolean(busy)}>
                      <Trash2 size={13} className="text-red-500" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {!dashboards.data?.items.length ? <EmptyState icon={<BarChart3 size={18} />} title="No dashboards" message="Seed the city operations use case to get one." /> : null}
          </div>
        </Card>
      </div>

      {dashboardRun ? (
        <Card>
          <CardHeader eyebrow="Dashboard" title={dashboardRun.dashboard.name} description="Latest snapshots from the reports in this dashboard." />
          <div className="grid gap-4 px-5 py-4 lg:grid-cols-2">
            {dashboardRun.widgets.map((widget) => (
              <div key={widget.widget.id} className="rounded-xl border border-slate-200 p-3 dark:border-[#26354d]">
                <p className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{widget.widget.title || widget.report.name}</p>
                <ResultTable result={widget.result} />
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
