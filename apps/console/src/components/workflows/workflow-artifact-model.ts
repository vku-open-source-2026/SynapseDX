// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Pure helpers for the DX workflow artifact editor. JSON-only: the browser
 * parses and validates data, it never evaluates imported workflow code.
 */

export interface WorkflowGraph {
  nodes: Array<Record<string, unknown>>;
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export interface WorkflowArtifactSummary {
  id: string;
  tenant?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  description?: string;
  slug?: string;
  revision: number;
  workflowId: string;
  active: boolean;
  managedBy?: 'technical' | 'user';
  accessMode?: 'owner-only' | 'legacy' | 'unsupported';
  protected?: boolean;
  checksum: string;
  credentialRedactions: string[];
  versionCount: number;
  nodeCount: number;
  syncState?: 'ready' | 'pending' | 'failed';
  syncError?: string;
  lastExecutedAt?: string;
  version: number;
}

export interface WorkflowArtifact extends Omit<WorkflowArtifactSummary, 'nodeCount'> {
  nodes: Array<Record<string, unknown>>;
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export interface WorkflowArtifactPage {
  items: WorkflowArtifactSummary[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
}

export interface WorkflowArtifactExport {
  format: 'synapsedx-workflow-artifact';
  formatVersion: 1;
  artifact: { name: string; description?: string; slug?: string; revision: number };
  workflow: WorkflowGraph;
  checksum: string;
  deployedChecksum?: string;
  portableChecksum?: string;
  credentialBindingCount?: number;
  credentialRedactions: string[];
  redacted: boolean;
  synchronised: boolean;
  exportedAt: string;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafeJson(value: unknown, path = 'document', depth = 0): void {
  if (depth > 40 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeJson(entry, `${path}[${index}]`, depth + 1));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) throw new Error(`${path} contains the reserved key ${key}`);
    assertSafeJson(entry, `${path}.${key}`, depth + 1);
  }
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Parse an editable workflow source into a graph the backend accepts. */
export function parseWorkflowSource(text: string): WorkflowGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Workflow source must be valid JSON');
  }
  const root = plainObject(parsed, 'Workflow source');
  assertSafeJson(root, 'workflow');
  const graphInput = root.workflow && typeof root.workflow === 'object' && !Array.isArray(root.workflow)
    ? root.workflow
    : root;
  const graph = plainObject(graphInput, 'workflow');
  if (!Array.isArray(graph.nodes)) throw new Error('workflow.nodes must be an array');
  if (graph.nodes.length < 1 || graph.nodes.length > 50) {
    throw new Error('workflow.nodes must contain 1..50 nodes');
  }
  const names = new Set<string>();
  graph.nodes.forEach((node, index) => {
    const record = plainObject(node, `workflow.nodes[${index}]`);
    const name = String(record.name ?? '').trim();
    if (!name) throw new Error(`workflow.nodes[${index}].name is required`);
    if (names.has(name)) throw new Error(`duplicate node name '${name}'`);
    names.add(name);
    if (typeof record.type !== 'string' || !record.type.trim()) {
      throw new Error(`workflow.nodes['${name}'].type is required`);
    }
    if (record.parameters !== undefined) plainObject(record.parameters, `workflow.nodes['${name}'].parameters`);
  });
  const connections = graph.connections === undefined ? {} : plainObject(graph.connections, 'workflow.connections');
  const settings = graph.settings === undefined ? {} : plainObject(graph.settings, 'workflow.settings');
  return {
    nodes: graph.nodes as Array<Record<string, unknown>>,
    connections,
    settings,
  };
}

/** Parse the optional execution payload (must be a JSON object). */
export function parseExecutePayload(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('Execution payload must be valid JSON');
  }
  const payload = plainObject(parsed, 'Execution payload');
  assertSafeJson(payload, 'payload');
  return payload;
}

/** Build the graph JSON shown in the editor. */
export function formatWorkflowSource(artifact: Pick<WorkflowArtifact, 'nodes' | 'connections' | 'settings'>): string {
  return JSON.stringify({
    nodes: artifact.nodes,
    connections: artifact.connections,
    settings: artifact.settings,
  }, null, 2);
}

export function downloadFileName(name: string): string {
  const base = String(name || 'workflow')
    .replace(/\.json$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'workflow';
  return `${base}.synapsedx-workflow.json`;
}

export function shortChecksum(checksum: string | undefined): string {
  if (!checksum) return '—';
  return checksum.length > 12 ? `${checksum.slice(0, 12)}…` : checksum;
}

export function exportMatchesArtifact(exported: WorkflowArtifactExport, artifact: WorkflowArtifactSummary): boolean {
  return exported.checksum === artifact.checksum;
}
