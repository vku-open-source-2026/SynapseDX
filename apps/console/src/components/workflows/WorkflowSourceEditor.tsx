// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * JSON source editor for a saved workflow artifact. It edits data only; the
 * page forwards the JSON to DX, which validates it and delegates execution to
 * Tier-1. No imported code is evaluated in the browser.
 */
import { Download, Play, Power, RefreshCw, Save, ShieldAlert } from 'lucide-react';
import { relativeTime } from '../../lib/format';
import { Button, Pill, inputClassName } from '../ui';
import { shortChecksum, type WorkflowArtifact } from './workflow-artifact-model';

export function WorkflowSourceEditor({
  artifact,
  source,
  onSourceChange,
  executePayload,
  onExecutePayloadChange,
  runResult,
  busy,
  onSave,
  onDownload,
  onExecute,
  onReconcile,
  onToggleActive,
}: {
  artifact: WorkflowArtifact;
  source: string;
  onSourceChange: (value: string) => void;
  executePayload: string;
  onExecutePayloadChange: (value: string) => void;
  runResult: unknown;
  busy: boolean;
  onSave: () => void;
  onDownload: () => void;
  onExecute: () => void;
  onReconcile: () => void;
  onToggleActive: () => void;
}) {
  const needsReconcile = artifact.syncState === 'pending' || artifact.syncState === 'failed';
  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">{artifact.name}</h2>
            <Pill tone={needsReconcile ? 'bad' : artifact.active ? 'ok' : 'neutral'}>
              {needsReconcile ? artifact.syncState : artifact.active ? 'active' : 'inactive'}
            </Pill>
            <Pill tone={artifact.protected ? 'ok' : 'warn'}>
              {artifact.protected ? 'owner-only' : 'legacy unprotected'}
            </Pill>
            <Pill tone="neutral">rev {artifact.revision}</Pill>
          </div>
          <p className="mt-1 font-mono text-[11px] text-slate-500 dark:text-slate-400">
            Tier-1 workflow {artifact.workflowId} · checksum {shortChecksum(artifact.checksum)} · updated {relativeTime(artifact.updatedAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onDownload} disabled={busy}>
            <Download size={14} /> Download export
          </Button>
          <Button type="button" onClick={onToggleActive} disabled={busy || needsReconcile}>
            <Power size={14} /> {artifact.active ? 'Deactivate' : 'Activate'}
          </Button>
          <Button type="button" variant="ok" onClick={onSave} disabled={busy || needsReconcile}>
            <Save size={14} /> Save revision
          </Button>
        </div>
      </div>

      {artifact.syncError ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
          {artifact.syncError}
        </p>
      ) : null}

      {!artifact.protected ? (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          This artifact still points at a legacy user-owned Tier-1 workflow. It cannot be bound to a
          plugin until it is re-imported as a protected clone and owned by the organization technical identity.
        </p>
      ) : null}

      {artifact.credentialRedactions.length ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <ShieldAlert size={15} className="mt-0.5 shrink-0" />
          <span>
            {artifact.credentialRedactions.length} credential value(s) were redacted before saving/export.
            Re-enter credentials as Tier-1 credential references; plaintext values are never stored here.
          </span>
        </div>
      ) : null}

      {needsReconcile ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <span>This artifact is {artifact.syncState}. Editing and execution are blocked until reconciled.</span>
          <Button type="button" variant="danger" onClick={onReconcile} disabled={busy}>
            <RefreshCw size={14} /> Reconcile from Tier-1
          </Button>
        </div>
      ) : null}

      <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Workflow graph / code (JSON)
      </label>
      <textarea
        value={source}
        onChange={(event) => onSourceChange(event.target.value)}
        className={`${inputClassName} min-h-[360px] font-mono text-xs leading-5`}
        spellCheck={false}
        disabled={needsReconcile}
      />

      <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Execution payload (JSON object)
          <textarea
            value={executePayload}
            onChange={(event) => onExecutePayloadChange(event.target.value)}
            className={`${inputClassName} mt-1 min-h-[92px] font-mono text-xs`}
            placeholder='{"incidentId":"INC-42"}'
            spellCheck={false}
            disabled={needsReconcile}
          />
        </label>
        <Button type="button" variant="primary" onClick={onExecute} disabled={busy || needsReconcile}>
          <Play size={14} /> Execute in Tier-1
        </Button>
      </div>

      {runResult !== null && runResult !== undefined ? (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Execution result</p>
          <pre className="max-h-64 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 dark:border-[#26354d] dark:bg-[#0d1626] dark:text-slate-200">
            {JSON.stringify(runResult, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
