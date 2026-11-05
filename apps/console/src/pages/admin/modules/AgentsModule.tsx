// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Agents lane: registry, tool allowlists, runs and the kill switch. */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Power } from 'lucide-react';
import { api } from '../../../lib/api';
import { relativeTime, statusLabel, statusTone } from '../../../lib/format';
import { useToastStore } from '../../../stores/toastStore';
import {
  Button, Card, CardHeader, ConfirmDialog, EmptyState, Pill,
  TableShell, Thead, Th, Td, Tr,
} from '../../../components/ui';

interface AgentItem {
  id: string;
  name: string;
  model?: string;
  promptVersion?: string;
  tools?: string[];
  riskTier?: string;
}
interface AgentRun {
  id?: string;
  agentId?: string;
  status: string;
  costUsd?: number;
  createdAt?: string;
}

export function AgentsModule() {
  const queryClient = useQueryClient();
  const push = useToastStore((state) => state.push);
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ items?: AgentItem[] }>('/v1/capabilities/agents'),
    retry: false,
  });
  const runs = useQuery({
    queryKey: ['agent-runs'],
    queryFn: () => api.get<{ items?: AgentRun[] }>('/v1/capabilities/agent-runs').catch(() => ({ items: [] as AgentRun[] })),
    retry: false,
  });

  const agentRows = (agents.data?.items ?? []).slice(0, 50);
  const runRows = (runs.data?.items ?? []).slice(0, 30);
  const [killFor, setKillFor] = useState<AgentItem | null>(null);
  const [busy, setBusy] = useState(false);

  const confirmKill = async () => {
    if (!killFor) return;
    setBusy(true);
    try {
      await api.post(`/v1/capabilities/agents/${encodeURIComponent(killFor.id)}/kill-switch`, { enabled: true });
      push('Agent kill switch enabled.');
      setKillFor(null);
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['agent-runs'] });
    } catch (failure) {
      push((failure as Error)?.message || 'The kill switch could not be enabled.', 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">CAPABILITY MODULE</p>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Agent registry and traces</h2>
        <p className="text-sm text-slate-500">Tool allowlists are deny-by-default; high-risk runs pause for HITL and every trace is redacted.</p>
      </div>

      <Card className="overflow-hidden">
        {agents.isLoading ? (
          <div className="grid gap-3 px-5 py-6"><div className="h-12 animate-pulse rounded-xl bg-slate-100" /></div>
        ) : agents.isError ? (
          <div className="px-5 py-6"><EmptyState title="Agents could not be loaded" message={(agents.error as Error)?.message} action={<Button variant="primary" onClick={() => void agents.refetch()}>Retry</Button>} /></div>
        ) : agentRows.length === 0 ? (
          <div className="px-5 py-6"><EmptyState icon={<Bot size={26} />} title="No agents registered yet" message="Register an agent with an explicit tool allowlist." /></div>
        ) : (
          <TableShell>
            <Thead><Th>Agent</Th><Th>Tools</Th><Th>Risk</Th><Th /></Thead>
            <tbody>
              {agentRows.map((agent) => (
                <Tr key={agent.id}>
                  <Td>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">{agent.name}</p>
                      <p className="text-xs text-slate-400">{agent.model} · {agent.promptVersion}</p>
                    </div>
                  </Td>
                  <Td className="max-w-56 truncate font-mono text-xs">{(agent.tools ?? []).join(', ')}</Td>
                  <Td><Pill tone={agent.riskTier === 'high' ? 'bad' : agent.riskTier === 'medium' ? 'warn' : 'neutral'}>{agent.riskTier || 'low'}</Pill></Td>
                  <Td>
                    <button
                      type="button"
                      data-action="agent-kill"
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100"
                      onClick={() => setKillFor(agent)}
                    >
                      <Power size={12} /> Kill switch
                    </button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader eyebrow="RUNS" title="Recent traces" />
        {runRows.length === 0 ? (
          <div className="px-5 pb-6 text-sm text-slate-500">No agent runs yet.</div>
        ) : (
          <TableShell>
            <Thead><Th>Agent</Th><Th>Status</Th><Th>Cost</Th><Th>When</Th></Thead>
            <tbody>
              {runRows.map((run, index) => (
                <Tr key={run.id ?? index}>
                  <Td className="font-mono text-xs">{run.agentId?.slice(0, 8) || '—'}</Td>
                  <Td><Pill tone={statusTone(run.status)}>{statusLabel(run.status)}</Pill></Td>
                  <Td className="font-mono text-xs">{run.costUsd ? `$${Number(run.costUsd).toFixed(6)}` : '—'}</Td>
                  <Td className="font-mono text-xs text-slate-500">{relativeTime(run.createdAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(killFor)}
        title="Enable the agent kill switch?"
        message="New runs stop immediately and every paused run is cancelled for this tenant."
        label="Enable kill switch"
        danger
        busy={busy}
        onCancel={() => setKillFor(null)}
        onConfirm={() => void confirmKill()}
      />
    </section>
  );
}
