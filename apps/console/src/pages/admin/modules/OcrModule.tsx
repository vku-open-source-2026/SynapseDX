// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** OCR correction lane: low-confidence fields pause for a human decision. */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ScanText, Check, X } from 'lucide-react';
import { api } from '../../../lib/api';
import { statusLabel, statusTone } from '../../../lib/format';
import { useToastStore } from '../../../stores/toastStore';
import {
  Button, Card, CardHeader, ConfirmDialog, EmptyState, Field, Pill,
  TableShell, Thead, Th, Td, Tr, inputClassName,
} from '../../../components/ui';
import { Modal } from '../../../components/Modal';

interface OcrField {
  name: string;
  value: string | number;
  confidence?: number;
  status: string;
}
interface OcrJob {
  id: string;
  fileId: string;
  status: string;
  redacted?: boolean;
  fields?: OcrField[];
}

export function OcrModule() {
  const queryClient = useQueryClient();
  const push = useToastStore((state) => state.push);
  const jobs = useQuery({
    queryKey: ['ocr-jobs'],
    queryFn: () => api.get<{ items?: OcrJob[] }>('/v1/capabilities/ocr/jobs'),
    retry: false,
  });
  const items = (jobs.data?.items ?? []).slice(0, 50);

  const [approve, setApprove] = useState<{ jobId: string; fieldName: string; current?: string } | null>(null);
  const [approveValue, setApproveValue] = useState('');
  const [approveBusy, setApproveBusy] = useState(false);
  const [reject, setReject] = useState<{ jobId: string; fieldName: string } | null>(null);
  const [rejectBusy, setRejectBusy] = useState(false);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['ocr-jobs'] });

  const redact = useMutation({
    mutationFn: (jobId: string) => api.post(`/v1/capabilities/ocr/jobs/${encodeURIComponent(jobId)}/redact`, {}),
    onSuccess: () => {
      invalidate();
      push('PII redacted across pages and extracted fields.');
    },
    onError: (failure: Error) => push(failure?.message || 'The job could not be redacted.', 'bad'),
  });

  useEffect(() => {
    if (approve) setApproveValue(approve.current ?? '');
  }, [approve]);

  const submitApprove = async () => {
    if (!approve || !approveValue.trim()) return;
    setApproveBusy(true);
    try {
      await api.post(
        `/v1/capabilities/ocr/jobs/${encodeURIComponent(approve.jobId)}/fields/${encodeURIComponent(approve.fieldName)}/correct`,
        { value: approveValue.trim(), decision: 'approve' },
      );
      push('Field approved.');
      setApprove(null);
      invalidate();
    } catch (failure) {
      push((failure as Error)?.message || 'The field could not be approved.', 'bad');
    } finally {
      setApproveBusy(false);
    }
  };

  const submitReject = async () => {
    if (!reject) return;
    setRejectBusy(true);
    try {
      await api.post(
        `/v1/capabilities/ocr/jobs/${encodeURIComponent(reject.jobId)}/fields/${encodeURIComponent(reject.fieldName)}/correct`,
        { decision: 'reject' },
      );
      push('Field rejected.');
      setReject(null);
      invalidate();
    } catch (failure) {
      push((failure as Error)?.message || 'The field could not be rejected.', 'bad');
    } finally {
      setRejectBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">CAPABILITY MODULE</p>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">OCR correction queue</h2>
        <p className="text-sm text-slate-500">Low-confidence fields pause for a human decision before becoming records.</p>
      </div>

      {jobs.isLoading ? (
        <div className="h-32 animate-pulse rounded-2xl bg-slate-100" />
      ) : jobs.isError ? (
        <EmptyState
          title="OCR jobs could not be loaded"
          message={(jobs.error as Error)?.message}
          action={<Button variant="primary" onClick={() => void jobs.refetch()}>Retry</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ScanText size={26} />}
          title="No OCR jobs yet"
          message="Upload a document through POST /v1/capabilities/ocr/jobs."
        />
      ) : (
        items.map((job) => (
          <Card key={job.id} className="overflow-hidden">
            <CardHeader
              eyebrow={job.status.toUpperCase()}
              title={job.fileId}
              description={`${job.redacted ? 'PII redacted' : 'PII not redacted'} · ${job.fields?.length ?? 0} fields`}
              actions={
                <Button variant="ghost" onClick={() => redact.mutate(job.id)} disabled={redact.isPending}>
                  <ShieldCheck size={15} /> Redact PII
                </Button>
              }
            />
            <TableShell>
              <Thead><Th>Field</Th><Th>Value</Th><Th>Confidence</Th><Th>Status</Th><Th /></Thead>
              <tbody>
                {(job.fields ?? []).map((field) => (
                  <Tr key={field.name}>
                    <Td className="font-medium text-slate-800">{field.name}</Td>
                    <Td className="max-w-40 truncate font-mono text-xs">{String(field.value ?? '')}</Td>
                    <Td className="font-mono text-xs">{Math.round((field.confidence || 0) * 100)}%</Td>
                    <Td><Pill tone={statusTone(field.status)}>{statusLabel(field.status)}</Pill></Td>
                    <Td>
                      {field.status === 'pending' ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            data-action="ocr-approve"
                            className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
                            onClick={() => setApprove({ jobId: job.id, fieldName: field.name, current: String(field.value ?? '') })}
                          >
                            <Check size={12} /> Approve
                          </button>
                          <button
                            type="button"
                            data-action="ocr-reject"
                            className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100"
                            onClick={() => setReject({ jobId: job.id, fieldName: field.name })}
                          >
                            <X size={12} /> Reject
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">Decided</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableShell>
          </Card>
        ))
      )}

      <Modal
        open={Boolean(approve)}
        onClose={() => setApprove(null)}
        title={approve ? `Approve ${approve.fieldName}` : 'Approve field'}
        eyebrow="OCR"
        footer={
          <>
            <Button variant="ghost" onClick={() => setApprove(null)} disabled={approveBusy}>Cancel</Button>
            <Button variant="primary" onClick={() => void submitApprove()} disabled={approveBusy || !approveValue.trim()}>
              {approveBusy ? 'Saving…' : 'Approve field'}
            </Button>
          </>
        }
      >
        <Field label="Corrected value" required>
          <input className={inputClassName} value={approveValue} onChange={(event) => setApproveValue(event.target.value)} required autoFocus />
        </Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(reject)}
        title={reject ? `Reject ${reject.fieldName}?` : 'Reject field'}
        message="The field stays out of the generated record and remains in the audit trail."
        label="Reject field"
        danger
        busy={rejectBusy}
        onCancel={() => setReject(null)}
        onConfirm={() => void submitReject()}
      />
    </section>
  );
}
