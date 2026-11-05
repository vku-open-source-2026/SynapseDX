// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Records pipeline: pick a dataset, browse/create/bulk-import/edit/delete records. */
import React, { useEffect, useMemo, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Upload, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { can } from '../../lib/rbac';
import { previewJson, relativeTime, parseJsonObject } from '../../lib/format';
import { useAuthStore } from '../../stores/authStore';
import { useToastStore } from '../../stores/toastStore';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Field,
  Pill,
  TableShell,
  Thead,
  Th,
  Td,
  Tr,
  inputClassName,
  selectClassName,
} from '../../components/ui';
import { Modal, ModalError } from '../../components/Modal';
import type { DatasetDto, RecordDto } from '../../types';

function RecordFormModal({
  open,
  dataset,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  dataset: DatasetDto | null;
  initial: RecordDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const push = useToastStore((state) => state.push);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [payload, setPayload] = useState('{}');
  const [recordId, setRecordId] = useState('');
  const [publish, setPublish] = useState(true);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setRecordId(initial?.id ?? '');
    setPayload(JSON.stringify(initial?.data ?? {}, null, 2));
    setPublish(initial?.published !== false);
  }, [open, initial]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !dataset) return;
    let data: Record<string, unknown>;
    try {
      data = parseJsonObject(payload, 'data');
    } catch (failure) {
      setError((failure as Error).message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (initial) {
        await api.patch(`/v1/capabilities/datasets/${encodeURIComponent(dataset.id)}/records/${encodeURIComponent(initial.id)}`, {
          data,
          ifVersion: initial.version,
        });
        push('Record updated.');
      } else {
        const id = recordId.trim();
        await api.post(`/v1/capabilities/datasets/${encodeURIComponent(dataset.id)}/records`, {
          ...(id ? { id } : {}),
          data,
          ...(dataset.status === 'published' ? { publish } : {}),
        });
        push('Record created.');
      }
      onSaved();
      onClose();
    } catch (failure) {
      setError((failure as Error)?.message || 'The record could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? `Edit record ${initial.id}` : 'New record'}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" form="record-form" type="submit" disabled={busy || !dataset}>
            {busy ? 'Saving…' : initial ? 'Save record' : 'Create record'}
          </Button>
        </>
      }
    >
      <form id="record-form" onSubmit={submit} className="grid gap-4">
        {!initial ? (
          <Field label="Record id" help="Generated when empty.">
            <input className={inputClassName} value={recordId} onChange={(event) => setRecordId(event.target.value)} placeholder="asset-001" />
          </Field>
        ) : null}
        <Field label="Data (JSON object)" required help="Stored under the record data envelope. Publication follows the dataset unless overridden.">
          <textarea className={`${inputClassName} font-mono`} rows={12} value={payload} onChange={(event) => setPayload(event.target.value)} required />
        </Field>
        {dataset?.status === 'published' ? (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={publish} onChange={(event) => setPublish(event.target.checked)} />
            Publish this record to the public projection
          </label>
        ) : null}
        <ModalError message={error} />
      </form>
    </Modal>
  );
}

function BulkImportModal({
  open,
  dataset,
  onClose,
  onSaved,
}: {
  open: boolean;
  dataset: DatasetDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const push = useToastStore((state) => state.push);
  const [raw, setRaw] = useState('[\n  { "data": { "name": "Example" } }\n]');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !dataset) return;
    let entries: unknown;
    try {
      entries = JSON.parse(raw);
    } catch {
      setError('records must be valid JSON');
      return;
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      setError('records must be a non-empty JSON array');
      return;
    }
    if (entries.length > 100) {
      setError('at most 100 records per import');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ total?: number; errors?: unknown[] }>(`/v1/capabilities/datasets/${encodeURIComponent(dataset.id)}/records/bulk`, { records: entries });
      push(`Imported ${result?.total ?? 0} record(s)${result?.errors?.length ? `; ${result.errors.length} failed` : ''}.`, result?.errors?.length ? 'warn' : 'ok');
      onSaved();
      onClose();
    } catch (failure) {
      setError((failure as Error)?.message || 'The bulk import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Bulk import records"
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" form="bulk-form" type="submit" disabled={busy || !dataset}>
            {busy ? 'Importing…' : 'Import records'}
          </Button>
        </>
      }
    >
      <form id="bulk-form" onSubmit={submit} className="grid gap-4">
        <Field label="Records (JSON array, max 100)" required help="Each item may contain id, data and publish. Errors are reported per index.">
          <textarea className={`${inputClassName} font-mono`} rows={14} value={raw} onChange={(event) => setRaw(event.target.value)} required />
        </Field>
        <ModalError message={error} />
      </form>
    </Modal>
  );
}

export function RecordsPage() {
  const context = useAuthStore((state) => state.context);
  const queryClient = useQueryClient();
  const push = useToastStore((state) => state.push);
  const search = useSearch({ strict: false }) as { dataset?: string };

  const readable = can(context, 'records:read');
  const writable = can(context, 'records:write');

  const datasetsQuery = useQuery({
    queryKey: ['datasets'],
    queryFn: () => api.get<DatasetDto[]>('/v1/capabilities/datasets?limit=200'),
    retry: false,
    enabled: readable,
  });
  const datasets = datasetsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<string>('');

  useEffect(() => {
    if (!datasets.length) return;
    const fromQuery = search?.dataset && datasets.some((dataset) => dataset.id === search.dataset) ? search.dataset : undefined;
    setSelectedId((current) => current || fromQuery || datasets[0].id);
  }, [datasets, search?.dataset]);

  const selected = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedId) ?? null,
    [datasets, selectedId],
  );

  const recordsQuery = useQuery({
    queryKey: ['records', selectedId],
    enabled: readable && Boolean(selectedId),
    queryFn: () =>
      api.get<{ items?: RecordDto[]; total?: number }>(
        `/v1/capabilities/datasets/${encodeURIComponent(selectedId)}/records?limit=100&orderBy=updatedAt:desc`,
      ),
    retry: false,
  });
  const items = recordsQuery.data?.items ?? [];

  const [recordFormOpen, setRecordFormOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<RecordDto | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [deleteFor, setDeleteFor] = useState<RecordDto | null>(null);
  const [busy, setBusy] = useState(false);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['records', selectedId] });
    void queryClient.invalidateQueries({ queryKey: ['datasets'] });
    void queryClient.invalidateQueries({ queryKey: ['management/summary'] });
  };

  if (!readable) {
    return (
      <Card className="p-6">
        <p className="text-sm font-semibold text-red-700">Your role cannot read records.</p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        eyebrow="RECORD PIPELINE"
        title={selected?.name || 'Records and projections'}
        description={selected ? `${selected.entityType || 'Entity'} · ${recordsQuery.data?.total ?? items.length} record(s) · latest 100` : 'Pick a dataset to browse its records.'}
        actions={
          <div className="flex items-center gap-2">
            {selected ? <Pill tone={selected.status === 'published' ? 'ok' : selected.status === 'revoked' ? 'bad' : 'neutral'}>{selected.status || 'draft'}</Pill> : null}
            <Button variant="ghost" onClick={() => void recordsQuery.refetch()} aria-label="Refresh records"><RefreshCw size={15} /></Button>
            {writable && selected ? (
              <>
                <Button variant="ghost" onClick={() => setBulkOpen(true)}><Upload size={15} /> Bulk import</Button>
                <Button variant="primary" onClick={() => { setEditingRecord(null); setRecordFormOpen(true); }}><Plus size={16} /> New record</Button>
              </>
            ) : null}
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3">
        <select
          id="record-dataset"
          aria-label="Choose dataset"
          className={`${selectClassName} max-w-sm`}
          value={selectedId}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {datasets.map((dataset) => (
            <option key={dataset.id} value={dataset.id}>
              {dataset.name || dataset.id} ({dataset.status || 'draft'})
            </option>
          ))}
        </select>
        {datasetsQuery.isLoading ? <span className="text-xs text-slate-400">Loading datasets…</span> : null}
        {!datasets.length && !datasetsQuery.isLoading ? (
          <span className="text-xs text-slate-400">No datasets yet — create one first.</span>
        ) : null}
      </div>

      {datasets.length === 0 && !datasetsQuery.isLoading ? (
        <div className="px-5 py-8">
          <EmptyState title="No datasets yet" message="Create a dataset before adding records." />
        </div>
      ) : recordsQuery.isLoading ? (
        <div className="grid gap-3 px-5 py-6">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : recordsQuery.isError ? (
        <div className="px-5 py-8">
          <EmptyState
            title="Records could not be loaded"
            message={(recordsQuery.error as Error)?.message}
            action={<Button variant="primary" onClick={() => void recordsQuery.refetch()}>Retry</Button>}
          />
        </div>
      ) : (
        <TableShell>
          <Thead>
            <Th>Record</Th>
            <Th>Data</Th>
            <Th>Version</Th>
            <Th>Published</Th>
            <Th>Updated</Th>
            <Th>Actions</Th>
          </Thead>
          <tbody>
            {items.map((record) => (
              <Tr key={record.id}>
                <Td className="font-mono text-xs">{record.id}</Td>
                <Td>
                  <code className="block max-w-md truncate rounded-md bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-600">
                    {previewJson(record.data, 120)}
                  </code>
                </Td>
                <Td className="font-mono text-xs">{record.version ?? '—'}</Td>
                <Td>
                  {record.published === false
                    ? <Pill tone="warn">Withheld</Pill>
                    : <Pill tone="ok">Inherited</Pill>}
                </Td>
                <Td className="font-mono text-xs text-slate-500">{relativeTime(record.updatedAt)}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    {writable ? (
                      <>
                        <button
                          type="button"
                          className="text-xs font-semibold text-blue-700 hover:underline"
                          onClick={() => { setEditingRecord(record); setRecordFormOpen(true); }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete record ${record.id}`}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                          onClick={() => setDeleteFor(record)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-slate-400">Read only</span>
                    )}
                  </div>
                </Td>
              </Tr>
            ))}
            {items.length === 0 ? (
              <Tr>
                <Td colSpan={6} className="px-5 py-6 text-center text-sm text-slate-500">
                  No records in this dataset yet.
                </Td>
              </Tr>
            ) : null}
          </tbody>
        </TableShell>
      )}

      <RecordFormModal
        open={recordFormOpen}
        dataset={selected}
        initial={editingRecord}
        onClose={() => setRecordFormOpen(false)}
        onSaved={invalidate}
      />
      <BulkImportModal
        open={bulkOpen}
        dataset={selected}
        onClose={() => setBulkOpen(false)}
        onSaved={invalidate}
      />
      <ConfirmDialog
        open={Boolean(deleteFor)}
        title={`Delete record ${deleteFor?.id}?`}
        message="The record and its public entity will be removed."
        label="Delete record"
        danger
        busy={busy}
        onCancel={() => setDeleteFor(null)}
        onConfirm={() => {
          if (!deleteFor) return;
          setBusy(true);
          api.del(`/v1/capabilities/datasets/${encodeURIComponent(selectedId)}/records/${encodeURIComponent(deleteFor.id)}`)
            .then(() => {
              push('Record deleted.');
              invalidate();
              setDeleteFor(null);
            })
            .catch((failure: Error) => push(failure?.message || 'The record could not be deleted.', 'bad'))
            .finally(() => setBusy(false));
        }}
      />
    </Card>
  );
}
