// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Publication moderation: review queue with single and bulk decisions. */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X, Scale } from 'lucide-react';
import { api } from '../../lib/api';
import { can } from '../../lib/rbac';
import { relativeTime, statusLabel, statusTone } from '../../lib/format';
import { useAuthStore } from '../../stores/authStore';
import { useToastStore } from '../../stores/toastStore';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Pill,
  TableShell,
  Thead,
  Th,
  Td,
  Tr,
  inputClassName,
} from '../../components/ui';
import { Modal, ModalError } from '../../components/Modal';
import type { DatasetDto } from '../../types';
import { cn } from '../../lib/utils';

const STATUS_TABS = ['pending', 'approved', 'rejected', 'all'] as const;
type ReviewStatus = (typeof STATUS_TABS)[number];

interface ReviewQueue {
  items?: DatasetDto[];
  total?: number;
}

function ReviewDecisionModal({
  dataset,
  decision,
  onClose,
  onDone,
}: {
  dataset: DatasetDto | null;
  decision: 'approve' | 'reject' | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const push = useToastStore((state) => state.push);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rejecting = decision === 'reject';

  useEffect(() => {
    setNote('');
    setError(null);
  }, [dataset, decision]);

  if (!dataset || !decision) return null;

  const submit = async () => {
    const trimmed = note.trim();
    if (rejecting && trimmed.length < 3) {
      setError('A reason is required to reject a dataset.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/v1/capabilities/management/datasets/${encodeURIComponent(dataset.id)}/${decision}`,
        trimmed ? { note: trimmed } : {},
      );
      push(rejecting ? 'Dataset rejected with a review note.' : 'Dataset approved.');
      onDone();
      onClose();
    } catch (failure) {
      setError((failure as Error)?.message || 'The review decision could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(dataset)}
      onClose={onClose}
      title={rejecting ? `Reject ${dataset.name || dataset.id}` : `Approve ${dataset.name || dataset.id}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={rejecting ? 'danger' : 'primary'} onClick={() => void submit()} disabled={busy}>
            {busy ? 'Working…' : rejecting ? 'Reject dataset' : 'Approve dataset'}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-slate-600">
        {rejecting
          ? 'The operator will see this note and can revise the dataset before resubmitting it.'
          : 'Approval records the review decision. An operator still owns the publish action.'}
      </p>
      <div className="mt-3">
        <Field label={rejecting ? 'Reason (required)' : 'Review note'}>
          <textarea className={inputClassName} rows={4} value={note} onChange={(event) => setNote(event.target.value)} autoFocus />
        </Field>
      </div>
      <div className="mt-3"><ModalError message={error} /></div>
    </Modal>
  );
}

export function ModerationPage() {
  const context = useAuthStore((state) => state.context);
  const queryClient = useQueryClient();
  const push = useToastStore((state) => state.push);
  const [status, setStatus] = useState<ReviewStatus>('pending');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [decisionFor, setDecisionFor] = useState<DatasetDto | null>(null);
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [bulkDecision, setBulkDecision] = useState<'approve' | 'reject' | null>(null);
  const [bulkNote, setBulkNote] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const readable = can(context, 'moderation:read');
  const canDecide = status === 'pending' && can(context, 'moderation:write');

  const queue = useQuery({
    queryKey: ['review-queue', status],
    enabled: readable,
    queryFn: () => api.get<ReviewQueue>(`/v1/capabilities/management/review-queue?status=${encodeURIComponent(status)}&limit=100`),
    retry: false,
  });
  const items = queue.data?.items ?? [];

  useEffect(() => {
    setSelected(new Set());
  }, [status, items.length]);

  const selectedInView = useMemo(
    () => items.filter((item) => selected.has(item.id)),
    [items, selected],
  );

  if (!readable) {
    return (
      <Card className="p-6">
        <p className="text-sm font-semibold text-red-700">Your role cannot open the review queue.</p>
      </Card>
    );
  }

  const done = () => {
    setSelected(new Set());
    void queryClient.invalidateQueries({ queryKey: ['review-queue'] });
    void queryClient.invalidateQueries({ queryKey: ['datasets'] });
    void queryClient.invalidateQueries({ queryKey: ['management/summary'] });
  };

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(items.map((item) => item.id)) : new Set());
  };
  const toggleOne = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const runBulk = async () => {
    const ids = [...selected];
    if (!bulkDecision || ids.length === 0) return;
    const note = bulkNote.trim();
    if (bulkDecision === 'reject' && note.length < 3) {
      setBulkError('A reason is required to reject datasets.');
      return;
    }
    setBulkBusy(true);
    setBulkError(null);
    let ok = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        await api.post(`/v1/capabilities/management/datasets/${encodeURIComponent(id)}/${bulkDecision}`, note ? { note } : {});
        ok += 1;
      } catch (failure) {
        errors.push(`${id}: ${(failure as Error)?.message || 'failed'}`);
      }
    }
    push(`${ok} dataset(s) ${bulkDecision === 'reject' ? 'rejected' : 'approved'}${errors.length ? `; ${errors.length} skipped` : ''}.`, errors.length ? 'warn' : 'ok');
    setBulkBusy(false);
    setBulkDecision(null);
    setBulkNote('');
    done();
  };

  return (
    <Card>
      <CardHeader
        eyebrow="PEER REVIEW"
        title="Publication moderation"
        description="Operators submit public drafts; moderators approve or reject the metadata. Publication remains an operator action."
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3">
        <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Review lanes">
          {STATUS_TABS.map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={status === value}
              data-action="review-tab"
              data-id={value}
              onClick={() => setStatus(value)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                status === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
              )}
            >
              {value === 'all' ? 'All' : statusLabel(value).replace(' review', '')}
            </button>
          ))}
        </div>
        {canDecide ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600">
              <input
                type="checkbox"
                aria-label="Select all"
                data-review-all
                className="h-4 w-4 accent-blue-600"
                checked={items.length > 0 && selectedInView.length === items.length}
                onChange={(event) => toggleAll(event.target.checked)}
              />
              Select all
            </label>
            <span className="text-xs text-slate-500">{selectedInView.length} selected</span>
            <Button variant="primary" className="!px-3 !py-1.5 text-xs" data-action="bulk-review" data-id="approve" disabled={!selectedInView.length} onClick={() => { setBulkDecision('approve'); setBulkNote(''); setBulkError(null); }}>
              <Check size={14} /> Approve selected
            </Button>
            <Button variant="danger" className="!px-3 !py-1.5 text-xs" data-action="bulk-review" data-id="reject" disabled={!selectedInView.length} onClick={() => { setBulkDecision('reject'); setBulkNote(''); setBulkError(null); }}>
              <X size={14} /> Reject selected
            </Button>
          </div>
        ) : null}
      </div>

      {queue.isLoading ? (
        <div className="grid gap-3 px-5 py-6">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : queue.isError ? (
        <div className="px-5 py-8">
          <EmptyState
            title="The review queue could not be loaded"
            message={(queue.error as Error)?.message}
            action={<Button variant="primary" onClick={() => void queue.refetch()}>Retry</Button>}
          />
        </div>
      ) : items.length === 0 ? (
        <div className="px-5 py-8">
          <EmptyState icon={<Scale size={26} />} title="No datasets in this review lane" message="Submissions appear here as soon as operators request review." />
        </div>
      ) : (
        <TableShell>
          <Thead>
            {canDecide ? <Th><span className="sr-only">Select</span></Th> : null}
            <Th>Dataset</Th>
            <Th>Status</Th>
            <Th>Review</Th>
            <Th>Submitted</Th>
            <Th>Note</Th>
            <Th>Actions</Th>
          </Thead>
          <tbody>
            {items.map((dataset) => (
              <Tr key={dataset.id}>
                {canDecide ? (
                  <Td>
                    <input
                      type="checkbox"
                      data-review-select={dataset.id}
                      aria-label={`Select ${dataset.name || dataset.id}`}
                      className="h-4 w-4 accent-blue-600"
                      checked={selected.has(dataset.id)}
                      onChange={(event) => toggleOne(dataset.id, event.target.checked)}
                    />
                  </Td>
                ) : null}
                <Td>
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900">{dataset.name || dataset.id}</p>
                    <p className="font-mono text-[11px] text-slate-400">{dataset.id}</p>
                  </div>
                </Td>
                <Td><Pill tone={statusTone(dataset.status)}>{statusLabel(dataset.status)}</Pill></Td>
                <Td><Pill tone={statusTone(dataset.reviewStatus)}>{statusLabel(dataset.reviewStatus)}</Pill></Td>
                <Td className="font-mono text-xs text-slate-500">{relativeTime(dataset.reviewSubmittedAt)}</Td>
                <Td className="max-w-48 truncate text-xs text-slate-500">{dataset.reviewNote || '—'}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    {canDecide ? (
                      <>
                        <button type="button" data-action="approve-review" onClick={() => { setDecisionFor(dataset); setDecision('approve'); }} className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100">
                          <Check size={12} /> Approve
                        </button>
                        <button type="button" data-action="reject-review" onClick={() => { setDecisionFor(dataset); setDecision('reject'); }} className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100">
                          <X size={12} /> Reject
                        </button>
                      </>
                    ) : null}
                    {can(context, 'records:read') ? (
                      <a href={`/admin/records?dataset=${encodeURIComponent(dataset.id)}`} className="text-[11px] font-semibold text-blue-700 hover:underline">Records</a>
                    ) : null}
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </TableShell>
      )}

      <ReviewDecisionModal
        dataset={decisionFor}
        decision={decision}
        onClose={() => { setDecisionFor(null); setDecision(null); }}
        onDone={done}
      />
      <Modal
        open={Boolean(bulkDecision)}
        onClose={() => !bulkBusy && setBulkDecision(null)}
        title={`${bulkDecision === 'reject' ? 'Reject' : 'Approve'} ${selectedInView.length} dataset(s)`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkDecision(null)} disabled={bulkBusy}>Cancel</Button>
            <Button variant={bulkDecision === 'reject' ? 'danger' : 'primary'} onClick={() => void runBulk()} disabled={bulkBusy}>
              {bulkBusy ? 'Working…' : bulkDecision === 'reject' ? 'Reject selected' : 'Approve selected'}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-slate-600">
          {bulkDecision === 'reject'
            ? 'The same reason is recorded for every selected dataset. Items that are no longer pending are skipped and reported.'
            : 'Approval records one decision per dataset and keeps the individual audit trail.'}
        </p>
        <div className="mt-3">
          <Field label={bulkDecision === 'reject' ? 'Reason (required)' : 'Review note'}>
            <textarea className={inputClassName} rows={4} value={bulkNote} onChange={(event) => setBulkNote(event.target.value)} autoFocus />
          </Field>
        </div>
        <div className="mt-3"><ModalError message={bulkError} /></div>
      </Modal>
    </Card>
  );
}
