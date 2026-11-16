// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Import a portable workflow bundle or snapshot an existing Tier-1 workflow. */
import { useRef, useState } from 'react';
import { FileJson, Upload } from 'lucide-react';
import { Button, inputClassName } from '../ui';

export function WorkflowImportPanel({
  busy,
  onImportBundle,
  onImportWorkflow,
}: {
  busy: boolean;
  onImportBundle: (text: string) => Promise<void>;
  onImportWorkflow: (workflowId: string, name: string) => Promise<void>;
}) {
  const [bundleText, setBundleText] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const importBundle = async () => {
    setError(null);
    if (!bundleText.trim()) {
      setError('Choose a bundle file or paste the exported JSON first.');
      return;
    }
    try {
      await onImportBundle(bundleText);
      setBundleText('');
    } catch (failure) {
      setError((failure as Error).message || 'The workflow bundle could not be imported.');
    }
  };

  const importWorkflow = async () => {
    setError(null);
    if (!workflowId.trim()) {
      setError('A Tier-1 workflow id is required.');
      return;
    }
    try {
      await onImportWorkflow(workflowId.trim(), name.trim());
      setWorkflowId('');
      setName('');
    } catch (failure) {
      setError((failure as Error).message || 'The Tier-1 workflow could not be snapshotted.');
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      setBundleText(await file.text());
    } catch {
      setError('The selected file could not be read.');
    }
  };

  return (
    <div className="grid gap-4 border-t border-slate-100 px-5 py-4 dark:border-[#1f2c40] lg:grid-cols-2">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <FileJson size={16} />
          Import exported bundle
        </div>
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          Accepts <code>synapsedx-workflow-artifact</code> v1 JSON. Credentials are scrubbed
          server-side; the artifact is created as a saved DX-managed workflow.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => { void pickFile(event.target.files?.[0]); }}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload size={14} /> Choose file
          </Button>
          <Button type="button" variant="primary" onClick={() => void importBundle()} disabled={busy || !bundleText.trim()}>
            Import bundle
          </Button>
        </div>
        <textarea
          value={bundleText}
          onChange={(event) => setBundleText(event.target.value)}
          className={`${inputClassName} min-h-[92px] font-mono text-xs`}
          placeholder='{"format":"synapsedx-workflow-artifact","formatVersion":1,"workflow":{...}}'
          spellCheck={false}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <Upload size={16} />
          Snapshot a Tier-1 workflow
        </div>
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          Reads the current graph with the caller&apos;s credential, then clones it into a new
          organization technical-identity workflow with owner-only access. The legacy
          workflow is never modified or re-stamped.
        </p>
        <input
          value={workflowId}
          onChange={(event) => setWorkflowId(event.target.value)}
          className={inputClassName}
          placeholder="Tier-1 workflow id"
          spellCheck={false}
        />
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={inputClassName}
          placeholder="Artifact name (optional)"
        />
        <Button type="button" onClick={() => void importWorkflow()} disabled={busy || !workflowId.trim()}>
          Import existing workflow
        </Button>
      </div>

      {error ? (
        <p role="alert" className="lg:col-span-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
