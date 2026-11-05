// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Tenant-scoped HITL approvals with requester-cannot-approve enforcement. */
import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, CheckCircle2, XCircle, CheckSquare } from 'lucide-react';
import { api } from '../../lib/api';
import { can } from '../../lib/rbac';
import { relativeTime, statusLabel, statusTone, parseJsonObject } from '../../lib/format';
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
import type { ApprovalDto } from '../../types';
import { cn } from '../../lib/utils';

const STATUS_TABS = ['pending', 'approved', 'rejected', 'cancelled'] as const;
type ApprovalStatus = (typeof STATUS_TABS)[number];

interface ApprovalList {
  items?: ApprovalDto[];
  total?: number;
}

function NewApprovalModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const push = useToastStore((state) => state.push);
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
    const title = str('title').trim();
    const module = str('module').trim();
    const action = str('action').trim();
    if (!title || !module || !action) {
      setError('Title, module and action are required.');
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = parseJsonObject(str('payload') || '{}', 'payload');
    } catch (failure) {
      setError((failure as Error).message);
      return;
    }
    const approverRoles = str('approverRoles').split(',').map((item) => item.trim()).filter(Boolean);
    const dueAt = str('dueAt').trim();
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/capabilities/approvals', {
        title,
        module,
        action,
        approverRoles,
        requiredApprovals: Number(str('requiredApprovals') || 1),
        ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
        payload,
      });
      push('Approval request created.');
      onCreated();
      onClose();
    } catch (failure) {
      setError((failure as Error)?.message || 'The approval request could not be created.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New approval request"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" form="approval-form" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create request'}
          </Button>
        </>
      }
    >
      <form id="approval-form" onSubmit={onSubmit} className="grid gap-4">
        <Field label="Title" required>
          <input name="title" className={inputClassName} placeholder="Approve dispatch for incident 42" required autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Module" required>
            <input name="module" className={inputClassName} placeholder="sos.dispatch" required />
          </Field>
          <Field label="Action" required>
            <input name="action" className={inputClassName} placeholder="dispatch.assign" required />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Approver roles" help="Comma-separated; leave empty for any management role.">
            <input name="approverRoles" className={inputClassName} defaultValue="moderator" placeholder="moderator,admin" />
          </Field>
          <Field label="Required approvals">
            <input name="requiredApprovals" type="number" min={1} className={inputClassName} defaultValue={1} />
          </Field>
        </div>
        <Field label="Due at">
          <input name="dueAt" type="datetime-local" className={inputClassName} />
        </Field>
        <Field label="Payload (JSON object)">
          <textarea name="payload" rows={5} className={`${inputClassName} font-mono`} defaultValue="{}" />
        </Field>
        <ModalError message={error} />
      </form>
    </Modal>
  );
}

function DecisionModal({
  approval,
  decision,
  onClose,
  onDone,
}: {
  approval: ApprovalDto | null;
  decision: 'approve' | 'reject' | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const push = useToastStore((state) => state.push);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rejecting = decision === 'reject';

  useEffect(() => {
    setNote('');
    setError(null);
  }, [approval, decision]);

  if (!approval || !decision) return null;

  const submit = async () => {
    const trimmed = note.trim();
    if (rejecting && trimmed.length < 3) {
      setError('A reason is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/capabilities/approvals/${encodeURIComponent(approval.id)}/decide`, {
        decision,
        ...(trimmed ? { note: trimmed } : {}),
      });
      push(rejecting ? 'Approval rejected.' : 'Approval recorded.');
      onDone();
      onClose();
    } catch (failure) {
      setError((failure as Error)?.message || 'The decision could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(approval)}
      onClose={onClose}
      title={`${rejecting ? 'Reject' : 'Approve'} ${approval.title}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={rejecting ? 'danger' : 'primary'} onClick={() => void submit()} disabled={busy}>
            {busy ? 'Working…' : rejecting ? 'Reject' : 'Approve'}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-slate-600">
        {rejecting
          ? 'The requester sees this note in the audit trail.'
          : 'Approval is recorded with your principal and timestamp.'}
      </p>
      <div className="mt-3">
        <Field label={rejecting ? 'Reason (required)' : 'Note'}>
          <textarea className={inputClassName} rows={4} value={note} onChange={(event) => setNote(event.target.value)} autoFocus />
        </Field>
      </div>
      <div className="mt-3"><ModalError message={error} /></div>
    </Modal>
  );
}

export function ApprovalsPage() {
  const context = useAuthStore((state) => state.context);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ApprovalStatus>('pending');
  const [formOpen, setFormOpen] = useState(false);
  const [decisionFor, setDecisionFor] = useState<ApprovalDto | null>(null);
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);

  const canRead = can(context, 'approvals:read');
  const canWrite = can(context, 'approvals:write');

  const list = useQuery({
    queryKey: ['approvals', status],
    enabled: canRead,
    queryFn: () => api.get<ApprovalList>(`/v1/capabilities/approvals?status=${encodeURIComponent(status)}`),
    retry: false,
  });
  const items = list.data?.items ?? [];
  const currentUser = context?.user?.id;

  if (!canRead) {
    return (
      <Card className="p-6">
        <p className="text-sm font-semibold text-red-700">Your role cannot read approvals.</p>
      </Card>
    );
  }

  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['approvals'] });
  };

  return (
    <Card>
      <CardHeader
        eyebrow="HUMAN IN THE LOOP"
        title="Approvals"
        description="One tenant-scoped decision trail for dispatch, budget, publication and other high-risk actions. Requesters cannot approve their own request."
        actions={canWrite ? <Button variant="primary" data-action="new-approval" onClick={() => setFormOpen(true)}><Plus size={16} /> New approval</Button> : null}
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3">
        <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Approval lanes">
          {STATUS_TABS.map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={status === value}
              data-action="approval-tab"
              data-id={value}
              onClick={() => setStatus(value)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition-colors',
                status === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
              )}
            >
              {statusLabel(value)}
            </button>
          ))}
        </div>
      </div>

      {list.isLoading ? (
        <div className="grid gap-3 px-5 py-6">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : list.isError ? (
        <div className="px-5 py-8">
          <EmptyState
            title="Approvals could not be loaded"
            message={(list.error as Error)?.message}
            action={<Button variant="primary" onClick={() => void list.refetch()}>Retry</Button>}
          />
        </div>
      ) : items.length === 0 ? (
        <div className="px-5 py-8">
          <EmptyState icon={<CheckSquare size={26} />} title="No approvals in this lane" message="Requests appear here as soon as an operator files one." />
        </div>
      ) : (
        <TableShell>
          <Thead>
            <Th>Request</Th>
            <Th>Requester</Th>
            <Th>Approvals</Th>
            <Th>Status</Th>
            <Th>Created</Th>
            <Th>Due</Th>
            <Th>Actions</Th>
          </Thead>
          <tbody>
            {items.map((approval) => {
              const approvals = (approval.decisions ?? []).filter((item) => item.decision === 'approve').length;
              const ownRequest = approval.requester === currentUser;
              const decidable = approval.status === 'pending' && canWrite && !ownRequest;
              return (
                <Tr key={approval.id}>
                  <Td>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">{approval.title}</p>
                      <p className="font-mono text-[11px] text-slate-400">{approval.module} · {approval.action}</p>
                    </div>
                  </Td>
                  <Td className="font-mono text-xs">{approval.requester}</Td>
                  <Td className="font-mono text-xs">{approvals} / {approval.requiredApprovals}</Td>
                  <Td><Pill tone={statusTone(approval.status)}>{statusLabel(approval.status)}</Pill></Td>
                  <Td className="font-mono text-xs text-slate-500">{relativeTime(approval.createdAt)}</Td>
                  <Td className="font-mono text-xs text-slate-500">{approval.dueAt ? relativeTime(approval.dueAt) : '—'}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      {decidable ? (
                        <>
                          <button type="button" data-action="approval-approve" onClick={() => { setDecisionFor(approval); setDecision('approve'); }} className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100">
                            <CheckCircle2 size={12} /> Approve
                          </button>
                          <button type="button" data-action="approval-reject" onClick={() => { setDecisionFor(approval); setDecision('reject'); }} className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100">
                            <XCircle size={12} /> Reject
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-slate-400">{ownRequest ? 'Your request' : 'No action'}</span>
                      )}
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </TableShell>
      )}

      <NewApprovalModal open={formOpen} onClose={() => setFormOpen(false)} onCreated={done} />
      <DecisionModal approval={decisionFor} decision={decision} onClose={() => { setDecisionFor(null); setDecision(null); }} onDone={done} />
    </Card>
  );
}
