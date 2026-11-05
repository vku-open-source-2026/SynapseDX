// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Forms lane: versioned JSON-schema forms and the process inspector. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, Network } from 'lucide-react';
import { api } from '../../../lib/api';
import { Card, CardHeader, EmptyState, Pill, TableShell, Thead, Th, Td, Tr } from '../../../components/ui';
import { Modal } from '../../../components/Modal';

interface FormItem {
  id: string;
  name: string;
  version?: number;
  published?: boolean;
  schema?: { properties?: Record<string, { title?: string; type?: string; readOnly?: boolean }>; required?: string[] };
}
interface ProcessNode {
  id: string;
  type: string;
  config?: unknown;
}
interface ProcessItem {
  id: string;
  name: string;
  version?: number;
  published?: boolean;
  nodes?: ProcessNode[];
  slaMinutes?: number;
}

export function FormsModule() {
  const forms = useQuery({
    queryKey: ['forms'],
    queryFn: () => api.get<{ items?: FormItem[] }>('/v1/capabilities/forms'),
    retry: false,
  });
  const processes = useQuery({
    queryKey: ['processes'],
    queryFn: () => api.get<{ items?: ProcessItem[] }>('/v1/capabilities/processes'),
    retry: false,
  });
  const instances = useQuery({
    queryKey: ['process-instances'],
    queryFn: () => api.get<{ items?: Array<{ status: string }> }>('/v1/capabilities/process-instances').catch(() => ({ items: [] })),
    retry: false,
  });

  const formRows = (forms.data?.items ?? []).slice(0, 50);
  const processRows = (processes.data?.items ?? []).slice(0, 50);
  const running = (instances.data?.items ?? []).filter((instance) => instance.status === 'running').length;

  const [previewFormId, setPreviewFormId] = useState<string | null>(null);
  const [inspectProcessId, setInspectProcessId] = useState<string | null>(null);

  const previewQuery = useQuery({
    queryKey: ['forms', previewFormId],
    enabled: Boolean(previewFormId),
    queryFn: () => api.get<{ form: FormItem }>(`/v1/capabilities/forms/${encodeURIComponent(previewFormId!)}`),
    retry: false,
  });
  const preview = previewQuery.data?.form;
  const requiredKeys = new Set(preview?.schema?.required ?? []);

  const inspected = (processes.data?.items ?? []).find((item) => item.id === inspectProcessId) ?? null;

  return (
    <section className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">CAPABILITY MODULE</p>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Forms and process</h2>
        <p className="text-sm text-slate-500">Versioned JSON-schema forms and process definitions; running instances keep their start version.</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader eyebrow="FORMS" title="Form builder" />
          {forms.isLoading ? (
            <div className="grid gap-3 px-5 py-6"><div className="h-12 animate-pulse rounded-xl bg-slate-100" /></div>
          ) : formRows.length === 0 ? (
            <div className="px-5 pb-6"><EmptyState title="No forms yet" message="Define the first form schema to get started." /></div>
          ) : (
            <TableShell>
              <Thead><Th>Form</Th><Th>Status</Th><Th /></Thead>
              <tbody>
                {formRows.map((form) => (
                  <Tr key={form.id}>
                    <Td>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900">{form.name}</p>
                        <p className="text-xs text-slate-400">v{form.version ?? 1} · {(form.schema?.required ?? []).length} required</p>
                      </div>
                    </Td>
                    <Td><Pill tone={form.published ? 'ok' : 'neutral'}>{form.published ? 'Published' : 'Draft'}</Pill></Td>
                    <Td>
                      <button
                        type="button"
                        data-action="form-preview"
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        onClick={() => setPreviewFormId(form.id)}
                      >
                        <Eye size={12} /> Preview
                      </button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader eyebrow="PROCESSES" title="Process inspector" />
          {processes.isLoading ? (
            <div className="grid gap-3 px-5 py-6"><div className="h-12 animate-pulse rounded-xl bg-slate-100" /></div>
          ) : processRows.length === 0 ? (
            <div className="px-5 pb-6"><EmptyState title="No process definitions yet" message="Processes orchestrate HITL gates across lanes." /></div>
          ) : (
            <TableShell>
              <Thead><Th>Process</Th><Th>Status</Th><Th /></Thead>
              <tbody>
                {processRows.map((process) => (
                  <Tr key={process.id}>
                    <Td>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900">{process.name}</p>
                        <p className="text-xs text-slate-400">v{process.version ?? 1} · {process.nodes?.length ?? 0} nodes</p>
                      </div>
                    </Td>
                    <Td><Pill tone={process.published ? 'ok' : 'neutral'}>{process.published ? 'Published' : 'Draft'}</Pill></Td>
                    <Td>
                      <button
                        type="button"
                        data-action="process-inspect"
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        onClick={() => setInspectProcessId(process.id)}
                      >
                        <Network size={12} /> Inspect
                      </button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>
      </div>
      <p className="text-xs text-slate-500">{running} running instance{running === 1 ? '' : 's'}.</p>

      <Modal
        open={Boolean(previewFormId)}
        onClose={() => setPreviewFormId(null)}
        title={preview ? `Form preview · ${preview.name}` : 'Form preview'}
        eyebrow="FORM PREVIEW"
      >
        {previewQuery.isLoading ? <div className="h-24 animate-pulse rounded-xl bg-slate-100" /> : preview ? (
          <form className="grid gap-3" onSubmit={(event) => event.preventDefault()}>
            {Object.entries(preview.schema?.properties ?? {}).map(([key, config]) => (
              <label key={key} className="block text-sm font-medium text-slate-700">
                {config?.title || key}
                {requiredKeys.has(key) ? <span className="text-red-500"> *</span> : null}
                <input
                  className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 shadow-sm"
                  placeholder={config?.type || 'string'}
                  readOnly={Boolean(config?.readOnly)}
                />
              </label>
            ))}
            {Object.keys(preview.schema?.properties ?? {}).length === 0 ? (
              <p className="text-sm text-slate-500">This schema has no fields.</p>
            ) : null}
          </form>
        ) : <p className="text-sm text-slate-500">The form could not be loaded.</p>}
      </Modal>

      <Modal
        open={Boolean(inspectProcessId)}
        onClose={() => setInspectProcessId(null)}
        title={inspected ? `Process inspector · ${inspected.name}` : 'Process inspector'}
        eyebrow="PROCESS"
        wide
      >
        {inspected ? (
          <>
            <p className="text-sm text-slate-500">Version {inspected.version ?? 1} · {inspected.slaMinutes ?? 'no'} minute SLA</p>
            <TableShell>
              <Thead><Th>Node</Th><Th>Type</Th><Th>Config</Th></Thead>
              <tbody>
                {(inspected.nodes ?? []).map((node) => (
                  <Tr key={node.id}>
                    <Td className="font-mono text-xs">{node.id}</Td>
                    <Td>{node.type}</Td>
                    <Td className="max-w-xs truncate font-mono text-[11px] text-slate-500">{JSON.stringify(node.config ?? {})}</Td>
                  </Tr>
                ))}
                {(inspected.nodes ?? []).length === 0 ? (
                  <Tr><Td colSpan={3} className="px-4 py-4 text-center text-sm text-slate-500">No nodes.</Td></Tr>
                ) : null}
              </tbody>
            </TableShell>
          </>
        ) : (
          <p className="text-sm text-slate-500">The process could not be found.</p>
        )}
      </Modal>
    </section>
  );
}
