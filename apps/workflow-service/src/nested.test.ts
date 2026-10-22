/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// Nested workflow execution must be useful (agent workflow_run / SynapseFlow
// execute) but strictly bounded. Recursion is stopped by AsyncLocalStorage so
// concurrent workflows don't share a counter.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { synapsedxCall } from './index';
import { __clearMem, createWorkflowRec, updateWorkflowRec } from './store';

describe('nested workflow execution', () => {
  it('executes another workflow and returns its output', async () => {
    __clearMem();
    const child = await createWorkflowRec({
      name: 'child',
      nodes: [
        { name: 'Start', type: 'manualTrigger', parameters: {} },
        { name: 'Set', type: 'n8n-nodes-base.set', parameters: { values: { childRan: true, echo: '={{ $json.value }}' } } },
      ],
      connections: { Start: { main: [[{ node: 'Set' }]] } },
    });
    const parent = await createWorkflowRec({
      name: 'parent',
      nodes: [
        { name: 'Start', type: 'manualTrigger', parameters: {} },
        {
          name: 'Call',
          type: 'synapsedx.flow',
          parameters: { operation: 'workflows.execute', input: { id: child.id, input: '={{ $json }}' } },
        },
      ],
      connections: { Start: { main: [[{ node: 'Call' }]] } },
    });
    const res: any = await synapsedxCall('workflows', 'execute', { id: parent.id, input: { value: 42 } }, null);
    assert.equal(res.ok, true);
    // The parent's output is the SynapseFlow node's result wrapper.
    assert.equal(res.output.output.childRan, true);
    assert.equal(res.output.output.echo, 42);
    assert.ok(res.executionId);
  });

  it('stops recursive self-execution at the nesting limit', async () => {
    __clearMem();
    const rec = await createWorkflowRec({ name: 'recursive', nodes: [], connections: {} });
    await updateWorkflowRec(rec.id, {
      nodes: [
        { name: 'Start', type: 'manualTrigger', parameters: {} },
        {
          name: 'CallSelf',
          type: 'synapsedx.flow',
          parameters: { operation: 'workflows.execute', input: { id: rec.id, input: { tick: 1 } } },
        },
      ],
      connections: { Start: { main: [[{ node: 'CallSelf' }]] } },
    });
    await assert.rejects(
      () => synapsedxCall('workflows', 'execute', { id: rec.id, input: {} }, null),
      /nesting limit \(3\)/,
    );
  });
});
