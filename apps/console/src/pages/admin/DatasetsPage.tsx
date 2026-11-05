// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Datasets catalog: list, filter, create/edit, publication and outbox recovery. */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Database, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { can } from '../../lib/rbac';
import { statusLabel, statusTone } from '../../lib/format';
import { useAuthStore } from '../../stores/authStore';
import { useToastStore } from '../../stores/toastStore';
import {
  ActionMenu,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Field,
  MenuButton,
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
import type { DatasetDto } from '../../types';

function invalidateCatalog(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['datasets'] });
  void queryClient.invalidateQueries({ queryKey: ['management/summary'] });
}

function DatasetFormModal({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: DatasetDto | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const push = useToastStore((state) => state.push);
  const editing = Boolean(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const str = (name: string) => String(form.get(name) || '');
    const payload: Record<string, unknown> = {
      name: str('name').trim(),
      entityType: str('entityType').trim(),
      license: str('license').trim(),
      description: str('description').trim(),
      schemaVersion: str('schemaVersion').trim() || '1.0.0',
      public: form.get('public') === 'on',
    };
    const licenseUrl = str('licenseUrl').trim();
    if (licenseUrl) payload.licenseUrl = licenseUrl;
    const retention = str('retentionDays').trim();
    if (retention) payload.retentionDays = Number(retention);
    if (!payload.name || !payload.entityType || !payload.license) {
      setError('Name, entity type and license are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await api.patch(`/v1/capabilities/datasets/${encodeURIComponent(initial!.id)}`, payload);
        push('Dataset updated.');
      } else {
        const slug = str('slug').trim();
        if (slug) payload.slug = slug;
        await api.post('/v1/capabilities/datasets', payload);
        push('Dataset created as a draft.');
      }
      invalidateCatalog(queryClient);
      onClose();
    } catch (failure) {
      setError((failure as Error)?.message || 'The dataset could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${initial?.name || initial?.id}` : 'New dataset'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" form="dataset-form" type="submit" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create dataset'}
          </Button>
        </>
      }
    >
      <form id="dataset-form" onSubmit={onSubmit} className="grid gap-4">
        {!editing ? (
          <Field label="Slug" help="Lower-case id used in URLs and entity ids. Leave empty to generate one.">
            <input name="slug" className={inputClassName} placeholder="city-incidents" />
          </Field>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <input name="name" className={inputClassName} defaultValue={initial?.name ?? ''} required />
          </Field>
          <Field label="Entity type" required help="NGSI-LD entity type exposed on the public projection.">
            <input name="entityType" className={inputClassName} defaultValue={initial?.entityType ?? 'Incident'} required />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="License" required help="SPDX or LicenseRef identifier.">
            <input name="license" className={inputClassName} defaultValue={initial?.license ?? 'CC-BY-4.0'} required />
          </Field>
          <Field label="License URL">
            <input name="licenseUrl" type="url" className={inputClassName} defaultValue={initial?.licenseUrl ?? ''} placeholder="https://…" />
          </Field>
        </div>
        <Field label="Description">
          <textarea name="description" rows={3} className={inputClassName} defaultValue={initial?.description ?? ''} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Schema version">
            <input name="schemaVersion" className={inputClassName} defaultValue={initial?.schemaVersion ?? '1.0.0'} placeholder="1.0.0" />
          </Field>
          <Field label="Retention days">
            <input name="retentionDays" type="number" min={0} className={inputClassName} defaultValue={initial?.retentionDays ?? ''} placeholder="optional" />
          </Field>
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <input type="checkbox" name="public" className="mt-0.5 h-4 w-4 accent-blue-600" defaultChecked={initial?.public === true} />
          <span className="text-sm text-slate-700">
            <span className="font-semibold">Public dataset</span>
            <span className="mt-0.5 block text-xs text-slate-500">
              Public datasets can be published after a moderator approves the review lane.
            </span>
          </span>
        </label>
        <ModalError message={error} />
      </form>
    </Modal>
  );
}

function SubmitReviewModal({
  dataset,
  onClose,
}: {
  dataset: DatasetDto | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const push = useToastStore((state) => state.push);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (dataset) {
      setNote('');
      setError(null);
    }
  }, [dataset]);

  if (!dataset) return null;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/capabilities/management/datasets/${encodeURIComponent(dataset.id)}/submit-review`, note.trim() ? { note: note.trim() } : {});
      push('Dataset submitted for peer review.');
      invalidateCatalog(queryClient);
      onClose();
    } catch (failure) {
      setError((failure as Error)?.message || 'The dataset could not be submitted.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={Boolean(dataset)}
      onClose={onClose}
      title={`Submit ${dataset.name || dataset.id} for review`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Submitting…' : 'Submit for review'}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-slate-600">
        A moderator will review the license, schema and public projection before the dataset is eligible for publication.
      </p>
      <Field label="Note for the moderator">
        <textarea className={inputClassName} rows={4} value={note} onChange={(event) => setNote(event.target.value)} placeholder="optional context" />
      </Field>
      <div className="mt-3"><ModalError message={error} /></div>
    </Modal>
  );
}

export function DatasetsPage() {
  const context = useAuthStore((state) => state.context);
  const queryClient = useQueryClient();
  const push = useToastStore((state) => state.push);
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { new?: string };
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DatasetDto | null>(null);
  const [reviewFor, setReviewFor] = useState<DatasetDto | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; message: string; label?: string; danger?: boolean; run: () => Promise<void> } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const datasetsQuery = useQuery({
    queryKey: ['datasets'],
    queryFn: () => api.get<DatasetDto[]>('/v1/capabilities/datasets?limit=200'),
    retry: false,
  });
  const datasets = datasetsQuery.data ?? [];

  useEffect(() => {
    if (search?.new === '1') {
      setFormOpen(true);
      void navigate({ to: '/admin/datasets', search: {} as never, replace: true });
    }
    // Only react to the explicit ?new=1 marker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search?.new]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return datasets.filter((dataset) => {
      const haystack = `${dataset.name || ''} ${dataset.id || ''} ${dataset.slug || ''} ${dataset.entityType || ''}`.toLowerCase();
      const matchesQuery = !q || haystack.includes(q);
      const matchesStatus = !statusFilter || dataset.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [datasets, query, statusFilter]);

  const canWrite = can(context, 'datasets:write');
  const canReadRecords = can(context, 'records:read');
  const canDelete = can(context, 'datasets:delete');
  const canFlush = can(context, 'events:flush');

  const view = datasetsQuery.isLoading ? 'loading' : datasetsQuery.isError ? 'error' : 'ready';

  const doAction = (
    title: string,
    message: string,
    label: string,
    danger: boolean,
    run: () => Promise<void>,
  ) => setConfirm({ title, message, label, danger, run });

  const publishDataset = (dataset: DatasetDto) =>
    doAction(
      `Publish ${dataset.name || dataset.id}?`,
      'The public NGSI-LD projection will be created or refreshed. Private records stay private.',
      'Publish',
      false,
      async () => {
        await api.post(`/v1/capabilities/datasets/${encodeURIComponent(dataset.id)}/publish`);
        push('Dataset published.');
        invalidateCatalog(queryClient);
      },
    );

  const revokeDataset = (dataset: DatasetDto) =>
    doAction(
      `Revoke ${dataset.name || dataset.id}?`,
      'The public datasource and entities will be deleted. Records remain in the private store.',
      'Revoke',
      true,
      async () => {
        await api.post(`/v1/capabilities/datasets/${encodeURIComponent(dataset.id)}/revoke`);
        push('Dataset revoked.');
        invalidateCatalog(queryClient);
      },
    );

  const deleteDataset = (dataset: DatasetDto) =>
    doAction(
      `Delete ${dataset.name || dataset.id}?`,
      'The dataset and all of its records will be permanently deleted. This cannot be undone.',
      'Delete forever',
      true,
      async () => {
        await api.del(`/v1/capabilities/datasets/${encodeURIComponent(dataset.id)}?purgeRecords=true`);
        push('Dataset deleted.');
        invalidateCatalog(queryClient);
      },
    );

  const flushDataset = (dataset: DatasetDto) =>
    doAction(
      `Flush outbox for ${dataset.name || dataset.id}?`,
      'Queued events for this dataset will be delivered immediately.',
      'Flush events',
      false,
      async () => {
        const result = await api.post<{ pending?: number }>(`/v1/capabilities/events/outbox/flush?datasetId=${encodeURIComponent(dataset.id)}`);
        push(result?.pending ? `${result.pending} event(s) still pending.` : 'Outbox flushed.', result?.pending ? 'warn' : 'ok');
        invalidateCatalog(queryClient);
      },
    );

  const confirmRun = async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    try {
      await confirm.run();
      setConfirm(null);
    } catch (failure) {
      push((failure as Error)?.message || 'The action failed.', 'bad');
    } finally {
      setConfirmBusy(false);
    }
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader
        eyebrow="CAPABILITY CATALOG"
        title="Datasets"
        description="Register, review, publish and revoke the datasets exposed by the capability layer."
        actions={
          <>
            <Button variant="ghost" onClick={() => void datasetsQuery.refetch()} aria-label="Refresh datasets">
              <RefreshCw size={15} />
            </Button>
            {canWrite ? (
              <Button variant="primary" data-action="new-dataset" onClick={() => setFormOpen(true)}>
                <Plus size={16} /> New dataset
              </Button>
            ) : null}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3">
        <div className="relative min-w-[220px] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            id="dataset-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, slug, entity type…"
            aria-label="Search datasets"
            className={`${inputClassName} pl-9`}
          />
        </div>
        <select
          id="dataset-status"
          aria-label="Filter by status"
          className={`${selectClassName} w-40`}
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="revoked">Revoked</option>
        </select>
        <span className="text-xs font-medium text-slate-500">{filtered.length} visible</span>
      </div>

      {view === 'loading' ? (
        <div className="grid gap-3 px-5 py-6">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : view === 'error' ? (
        <div className="px-5 py-8">
          <EmptyState
            title="Datasets could not be loaded"
            message={(datasetsQuery.error as Error)?.message || 'The capability service did not respond.'}
            action={<Button variant="primary" onClick={() => void datasetsQuery.refetch()}>Retry</Button>}
          />
        </div>
      ) : datasets.length === 0 ? (
        <div className="px-5 py-8">
          <EmptyState
            icon={<Database size={28} />}
            title="No datasets visible"
            message={context ? 'Create the first dataset for this tenant, or ask an operator to grant access.' : 'No public datasets have been published yet.'}
            action={canWrite ? <Button variant="primary" onClick={() => setFormOpen(true)}><Plus size={16} /> New dataset</Button> : undefined}
          />
        </div>
      ) : (
        <TableShell>
          <Thead>
            <Th>Dataset</Th>
            <Th>Entity type</Th>
            <Th>License</Th>
            <Th>Status</Th>
            <Th>Review</Th>
            <Th>Actions</Th>
          </Thead>
          <tbody>
            {filtered.map((dataset) => {
              const review = dataset.reviewStatus && dataset.reviewStatus !== 'none' ? dataset.reviewStatus : 'none';
              const pendingCount = dataset.pendingEvents?.length ?? 0;
              return (
                <Tr key={dataset.id}>
                  <Td>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">{dataset.name || dataset.id}</p>
                      <p className="font-mono text-[11px] text-slate-400">{dataset.id}</p>
                      {dataset.description ? <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{dataset.description}</p> : null}
                    </div>
                  </Td>
                  <Td className="font-mono text-xs">{dataset.entityType || '—'}</Td>
                  <Td className="font-mono text-xs">{dataset.license || '—'}</Td>
                  <Td><Pill tone={statusTone(dataset.status)}>{statusLabel(dataset.status)}</Pill></Td>
                  <Td><Pill tone={statusTone(review === 'none' ? undefined : review)}>{statusLabel(review)}</Pill></Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      {canReadRecords ? (
                        <a href={`/admin/records?dataset=${encodeURIComponent(dataset.id)}`} data-action="view-records" className="text-xs font-semibold text-blue-700 hover:underline">Records</a>
                      ) : null}
                      {canWrite || (canFlush && pendingCount > 0) || canDelete ? (
                        <ActionMenu>
                          {canWrite ? (
                            <>
                              <MenuButton data-action="edit-dataset" onClick={() => { setEditing(dataset); setFormOpen(true); }}>Edit</MenuButton>
                              {dataset.status !== 'published' ? (
                                <MenuButton variant="ok" data-action="publish-dataset" onClick={() => publishDataset(dataset)}>Publish</MenuButton>
                              ) : (
                                <MenuButton variant="warn" data-action="revoke-dataset" onClick={() => revokeDataset(dataset)}>Revoke</MenuButton>
                              )}
                              {dataset.public && dataset.status !== 'published' && review !== 'pending' ? (
                                <MenuButton data-action="submit-review" onClick={() => setReviewFor(dataset)}>Submit review</MenuButton>
                              ) : null}
                            </>
                          ) : null}
                          {canFlush && pendingCount > 0 ? (
                            <MenuButton data-action="flush-events" onClick={() => flushDataset(dataset)}>Flush {pendingCount} event{pendingCount === 1 ? '' : 's'}</MenuButton>
                          ) : null}
                          {canDelete ? <MenuButton variant="danger" data-action="delete-dataset" onClick={() => deleteDataset(dataset)}>Delete</MenuButton> : null}
                        </ActionMenu>
                      ) : (
                        <span className="text-xs text-slate-400">Read only</span>
                      )}
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </TableShell>
      )}

      <DatasetFormModal open={formOpen} initial={editing} onClose={() => { setFormOpen(false); setEditing(null); }} />
      <SubmitReviewModal dataset={reviewFor} onClose={() => setReviewFor(null)} />
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title ?? ''}
        message={confirm?.message}
        label={confirm?.label}
        danger={confirm?.danger}
        busy={confirmBusy}
        onCancel={() => !confirmBusy && setConfirm(null)}
        onConfirm={() => void confirmRun()}
      />
    </Card>
  );
}
