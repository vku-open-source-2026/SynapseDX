// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import {
  downloadFileName,
  exportMatchesArtifact,
  formatWorkflowSource,
  parseExecutePayload,
  parseWorkflowSource,
  shortChecksum,
} from '../src/components/workflows/workflow-artifact-model';

const graph = {
  nodes: [
    { name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
    { name: 'Notify', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://api.example.com' } },
  ],
  connections: { Manual: { main: [[{ node: 'Notify', type: 'main', index: 0 }]] } },
  settings: { timezone: 'Asia/Ho_Chi_Minh' },
};

describe('workflow artifact source editor helpers', () => {
  it('parses a valid workflow graph and keeps the JSON shape', () => {
    expect(parseWorkflowSource(JSON.stringify(graph))).toEqual(graph);
    expect(parseWorkflowSource(JSON.stringify({ workflow: graph }))).toEqual(graph);
  });

  it('rejects invalid or unsafe sources without executing them', () => {
    expect(() => parseWorkflowSource('{')).toThrow(/valid JSON/);
    expect(() => parseWorkflowSource(JSON.stringify([]))).toThrow(/JSON object/);
    expect(() => parseWorkflowSource(JSON.stringify({ connections: {} }))).toThrow(/nodes/);
    expect(() => parseWorkflowSource(JSON.stringify({
      ...graph,
      nodes: [...graph.nodes, { ...graph.nodes[0] }],
    }))).toThrow(/duplicate node name/);
    expect(() => parseWorkflowSource(JSON.stringify({
      ...graph,
      nodes: Array.from({ length: 51 }, (_, index) => ({ name: `N${index}`, type: 'n8n-nodes-base.set' })),
    }))).toThrow(/1\.\.50/);
    const polluted = JSON.parse('{"__proto__":{"polluted":true},"nodes":[]}');
    expect(() => parseWorkflowSource(JSON.stringify(polluted))).toThrow(/reserved key/);
  });

  it('parses the optional execution payload as an object', () => {
    expect(parseExecutePayload('')).toEqual({});
    expect(parseExecutePayload('{"incidentId":"INC-1"}')).toEqual({ incidentId: 'INC-1' });
    expect(() => parseExecutePayload('[1,2]')).toThrow(/JSON object/);
    expect(() => parseExecutePayload('nope')).toThrow(/valid JSON/);
  });

  it('builds safe download names and short checksums', () => {
    expect(downloadFileName('City dispatch / nightly')).toBe('City-dispatch-nightly.synapsedx-workflow.json');
    expect(downloadFileName('workflow.json')).toBe('workflow.synapsedx-workflow.json');
    expect(downloadFileName('')).toBe('workflow.synapsedx-workflow.json');
    expect(shortChecksum('abcdef0123456789')).toBe('abcdef012345…');
    expect(shortChecksum('abc')).toBe('abc');
    expect(shortChecksum(undefined)).toBe('—');
  });

  it('formats the editor source and detects export drift', () => {
    const formatted = formatWorkflowSource({
      nodes: graph.nodes,
      connections: graph.connections,
      settings: graph.settings,
    });
    expect(JSON.parse(formatted)).toEqual(graph);
    const artifact = { checksum: 'abc' } as any;
    expect(exportMatchesArtifact({ checksum: 'abc' } as any, artifact)).toBe(true);
    expect(exportMatchesArtifact({ checksum: 'def' } as any, artifact)).toBe(false);
  });
});
