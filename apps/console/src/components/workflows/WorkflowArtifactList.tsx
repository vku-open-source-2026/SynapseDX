// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Saved workflow artifact list (metadata only; graphs load on selection). */
import { Workflow } from 'lucide-react';
import { relativeTime } from '../../lib/format';
import { Pill, Skeleton, TableShell, Td, Th, Thead, Tr } from '../ui';
import type { WorkflowArtifactSummary } from './workflow-artifact-model';

function stateTone(artifact: WorkflowArtifactSummary): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (artifact.syncState === 'failed') return 'bad';
  if (artifact.syncState === 'pending') return 'warn';
  return artifact.active ? 'ok' : 'neutral';
}

function stateLabel(artifact: WorkflowArtifactSummary): string {
  if (artifact.syncState === 'failed') return 'needs reconcile';
  if (artifact.syncState === 'pending') return 'updating';
  return artifact.active ? 'active' : 'inactive';
}

export function WorkflowArtifactList({
  items,
  total,
  loading,
  selectedId,
  onSelect,
}: {
  items: WorkflowArtifactSummary[];
  total: number;
  loading: boolean;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (!items.length) {
    return (
      <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
        <Workflow className="text-slate-300 dark:text-slate-600" size={28} />
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">No saved workflow artifacts</p>
        <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
          Import an exported workflow bundle or snapshot a Tier-1 workflow above.
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-between px-4 py-2 text-xs text-slate-500 dark:text-slate-400">
        <span>{total} artifact{total === 1 ? '' : 's'}</span>
        <span>Graphs load on selection</span>
      </div>
      <TableShell>
        <Thead>
          <Th>Workflow</Th>
          <Th>State</Th>
          <Th>Rev</Th>
          <Th>Nodes</Th>
          <Th>Secrets</Th>
          <Th>Updated</Th>
        </Thead>
        <tbody>
          {items.map((artifact) => (
            <Tr
              key={artifact.id}
              className={selectedId === artifact.id ? 'bg-sky-50/70 dark:bg-sky-950/30' : undefined}
            >
              <Td>
                <button
                  type="button"
                  className="text-left"
                  onClick={() => onSelect(artifact.id)}
                >
                  <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">{artifact.name}</span>
                  <span className="block max-w-[320px] truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
                    {artifact.workflowId}
                  </span>
                </button>
              </Td>
              <Td><Pill tone={stateTone(artifact)}>{stateLabel(artifact)}</Pill></Td>
              <Td className="font-mono text-xs">{artifact.revision}</Td>
              <Td className="font-mono text-xs">{artifact.nodeCount}</Td>
              <Td className="font-mono text-xs">{artifact.credentialRedactions.length}</Td>
              <Td className="text-xs text-slate-500 dark:text-slate-400">{relativeTime(artifact.updatedAt)}</Td>
            </Tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  );
}
