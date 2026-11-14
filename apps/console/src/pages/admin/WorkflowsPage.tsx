// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * DX admin workflow artifact studio: import/export Tier-1 workflow code,
 * edit the JSON graph, keep revisions and execute through Tier-1. Credentials
 * are scrubbed server-side; the browser never evaluates imported code.
 */
import { useCallback, useEffect, useState } from 'react';
import { Workflow } from 'lucide-react';
import { httpClient } from '../../lib/httpClient';
import { useToastStore } from '../../stores/toastStore';
import { Card, CardHeader, EmptyState } from '../../components/ui';
import { WorkflowImportPanel } from '../../components/workflows/WorkflowImportPanel';
import { WorkflowArtifactList } from '../../components/workflows/WorkflowArtifactList';
import { WorkflowSourceEditor } from '../../components/workflows/WorkflowSourceEditor';
import {
  downloadFileName,
  formatWorkflowSource,
  parseExecutePayload,
  parseWorkflowSource,
  type WorkflowArtifact,
  type WorkflowArtifactExport,
  type WorkflowArtifactPage,
  type WorkflowArtifactSummary,
} from '../../components/workflows/workflow-artifact-model';

const BASE = '/v1/capabilities/workflow-artifacts';

interface WorkflowReadiness {
  pluginFormsCanSubmit: boolean;
  workflowExecution: {
    ready: boolean;
    installedVersion: string | null;
    minimumVersion: string;
    requirement: string;
  };
  workflowTechnicalIdentity?: {
    ready: boolean;
    org: string;
    configured: boolean;
    verified: boolean;
    accountId?: string;
    reason?: string;
    requirement: string;
  };
  workflowCredentialDestinationProtection?: {
    ready: boolean;
    admittedByEngine: boolean;
    engineMarker: number | null;
    reason?: string;
    requirement: string;
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The workflow request failed.';
}

export function WorkflowsPage() {
  const push = useToastStore((state) => state.push);
  const [items, setItems] = useState<WorkflowArtifactSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [artifact, setArtifact] = useState<WorkflowArtifact | null>(null);
  const [source, setSource] = useState('');
  const [executePayload, setExecutePayload] = useState('{}');
  const [runResult, setRunResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<WorkflowReadiness | null>(null);

  const loadList = useCallback(async () => {
    const response = await httpClient.get<WorkflowArtifactPage>(BASE, { params: { limit: 100 } });
    setItems(response.data.items);
    setTotal(response.data.total);
  }, []);

  const select = useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await httpClient.get<WorkflowArtifact>(`${BASE}/${encodeURIComponent(id)}`);
      setSelectedId(id);
      setArtifact(response.data);
      setSource(formatWorkflowSource(response.data));
      setRunResult(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const response = await httpClient.get<WorkflowArtifactPage>(BASE, { params: { limit: 100 } });
        if (cancelled) return;
        setItems(response.data.items);
        setTotal(response.data.total);
        try {
          const ready = await httpClient.get<WorkflowReadiness>(`${BASE}/readiness`);
          if (!cancelled) setReadiness(ready.data);
        } catch {
          /* readiness is advisory for the management page */
        }
      } catch (failure) {
        if (!cancelled) setError(messageOf(failure));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, []);

  const importBundle = async (text: string) => {
    setBusy(true);
    setError(null);
    try {
      let bundle: unknown;
      try {
        bundle = JSON.parse(text);
      } catch {
        throw new Error('Bundle must be valid JSON.');
      }
      const response = await httpClient.post<WorkflowArtifact>(`${BASE}/import`, bundle);
      await loadList();
      setSelectedId(response.data.id);
      setArtifact(response.data);
      setSource(formatWorkflowSource(response.data));
      setRunResult(null);
      push('Workflow bundle imported.');
    } catch (failure) {
      setError(messageOf(failure));
      throw failure;
    } finally {
      setBusy(false);
    }
  };

  const importWorkflow = async (workflowId: string, name: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await httpClient.post<WorkflowArtifact>(`${BASE}/import`, {
        workflowId,
        clone: true,
        ...(name ? { name } : {}),
      });
      await loadList();
      setSelectedId(response.data.id);
      setArtifact(response.data);
      setSource(formatWorkflowSource(response.data));
      setRunResult(null);
      push('Tier-1 workflow snapshotted.');
    } catch (failure) {
      setError(messageOf(failure));
      throw failure;
    } finally {
      setBusy(false);
    }
  };

  const save = async (activate?: boolean) => {
    if (!artifact) return;
    setBusy(true);
    setError(null);
    try {
      const definition = parseWorkflowSource(source);
      const response = await httpClient.put<WorkflowArtifact>(`${BASE}/${encodeURIComponent(artifact.id)}`, {
        version: artifact.version,
        definition,
        ...(activate === undefined ? {} : { activate }),
      });
      setArtifact(response.data);
      setSource(formatWorkflowSource(response.data));
      await loadList();
      push(activate === undefined ? 'Workflow revision saved.' : activate ? 'Workflow activated.' : 'Workflow deactivated.');
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async () => {
    if (!artifact) return;
    setBusy(true);
    setError(null);
    try {
      const response = await httpClient.put<WorkflowArtifact>(`${BASE}/${encodeURIComponent(artifact.id)}`, {
        version: artifact.version,
        activate: !artifact.active,
      });
      setArtifact(response.data);
      setSource(formatWorkflowSource(response.data));
      await loadList();
      push(response.data.active ? 'Workflow activated.' : 'Workflow deactivated.');
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!artifact) return;
    setBusy(true);
    setError(null);
    try {
      const response = await httpClient.get<WorkflowArtifactExport>(
        `${BASE}/${encodeURIComponent(artifact.id)}/export`,
      );
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadFileName(response.data.artifact?.name || artifact.name);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      push(response.data.redacted ? 'Exported with redacted credentials.' : 'Workflow exported.', response.data.redacted ? 'warn' : 'ok');
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!artifact) return;
    setBusy(true);
    setError(null);
    try {
      const payload = parseExecutePayload(executePayload);
      const response = await httpClient.post<{ execution: unknown }>(`${BASE}/${encodeURIComponent(artifact.id)}/execute`, { payload });
      setRunResult(response.data.execution);
      push('Execution requested from Tier-1.');
      const refreshed = await httpClient.get<WorkflowArtifact>(`${BASE}/${encodeURIComponent(artifact.id)}`);
      setArtifact(refreshed.data);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async () => {
    if (!artifact) return;
    setBusy(true);
    setError(null);
    try {
      const response = await httpClient.post<WorkflowArtifact>(
        `${BASE}/${encodeURIComponent(artifact.id)}/reconcile`,
        { version: artifact.version },
      );
      setArtifact(response.data);
      setSource(formatWorkflowSource(response.data));
      await loadList();
      push('Artifact reconciled from the Tier-1 workflow.');
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          eyebrow="Workflow capability"
          title="Workflow artifacts"
          description="Manage exported Tier-1 workflow graphs and code from DX. Execution, queueing and tenant authorization stay in SynapseOne."
        />
        {readiness && !readiness.pluginFormsCanSubmit ? (
          <div className="mx-5 mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <span className="font-semibold">Plugin form execution is gated. </span>
            {readiness.workflowExecution.requirement}.{' '}
            {readiness.workflowTechnicalIdentity && !readiness.workflowTechnicalIdentity.ready
              ? `${readiness.workflowTechnicalIdentity.requirement}. `
              : ''}
            {readiness.workflowCredentialDestinationProtection && !readiness.workflowCredentialDestinationProtection.ready
              ? `${readiness.workflowCredentialDestinationProtection.requirement}. `
              : ''}
            Plugin workflow submissions fail closed with HTTP 503; management import/export stays available.
          </div>
        ) : null}
        <WorkflowImportPanel
          busy={busy}
          onImportBundle={importBundle}
          onImportWorkflow={importWorkflow}
        />
        {error ? (
          <p role="alert" className="mx-5 mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
            {error}
          </p>
        ) : null}
      </Card>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Card className="overflow-hidden">
          <CardHeader
            eyebrow="Saved artifacts"
            title="Organization workflows"
            description="Tenant-scoped; owners and DX admins can edit. Members use published plugins."
          />
          <WorkflowArtifactList
            items={items}
            total={total}
            loading={loading}
            selectedId={selectedId}
            onSelect={(id) => { void select(id).catch((failure) => setError(messageOf(failure))); }}
          />
        </Card>

        <Card className="overflow-hidden">
          {artifact ? (
            <WorkflowSourceEditor
              artifact={artifact}
              source={source}
              onSourceChange={setSource}
              executePayload={executePayload}
              onExecutePayloadChange={setExecutePayload}
              runResult={runResult}
              busy={busy}
              onSave={() => void save()}
              onDownload={() => void download()}
              onExecute={() => void execute()}
              onReconcile={() => void reconcile()}
              onToggleActive={() => void toggleActive()}
            />
          ) : (
            <div className="p-5">
              <EmptyState
                icon={<Workflow size={28} />}
                title="Select a workflow artifact"
                message="Choose an artifact on the left to view its exported graph, download it, save a revision or execute it through Tier-1."
              />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
