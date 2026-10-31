/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// Offline tests for the visual-editor graph operations (pure logic, no DOM).
// Run: node --test src/lib/*.test.mjs (Node 18+).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorkflow,
  validateGraph,
  connect,
  disconnect,
  removeNode,
  renameNode,
  listEdges,
  makeNode,
  uniqueName,
  NODE_TYPES,
} from './workflow-graph.js';

const N = (name, extra = {}) => ({ id: `id-${name}`, name, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], parameters: {}, ...extra });

describe('normalizeWorkflow', () => {
  it('fills defaults for ragged nodes', () => {
    const w = normalizeWorkflow({ name: 'w', nodes: [{ name: 'A' }, null, { name: 'B', position: [10, 'x'] }], connections: null });
    assert.equal(w.name, 'w');
    assert.equal(w.nodes.length, 2);
    assert.deepEqual(w.nodes[1].position, [10, 0]);
    assert.ok(w.nodes[0].id.length > 0);
    assert.deepEqual(w.connections, {});
  });
  it('preserves extended node fields (credentials, disabled, notes)', () => {
    const w = normalizeWorkflow({
      nodes: [{ id: 'a', name: 'W', type: 'n8n-nodes-base.webhook', position: [0, 0], parameters: {}, webhookId: 'wid-1', credentials: { http: { id: 'c1' } }, disabled: true, notes: 'hi' }],
      connections: {},
    });
    assert.deepEqual(w.nodes[0].credentials, { http: { id: 'c1' } });
    assert.equal(w.nodes[0].disabled, true);
    assert.equal(w.nodes[0].notes, 'hi');
  });
  it('tolerates garbage input', () => {
    assert.deepEqual(normalizeWorkflow(null), { name: '', nodes: [], connections: {} });
    assert.deepEqual(normalizeWorkflow({}).nodes, []);
  });
});

describe('validateGraph', () => {
  it('accepts a well-formed graph', () => {
    const err = validateGraph([N('A'), N('B')], { A: { main: [[{ node: 'B', type: 'main', index: 0 }]] } });
    assert.equal(err, null);
  });
  it('rejects duplicates, dangling edges, bad shapes', () => {
    assert.match(validateGraph([N('A'), N('A')], {}), /duplicate/);
    assert.match(validateGraph([N('A')], { A: { main: [[{ node: 'Ghost' }]] } }), /unknown node/);
    assert.match(validateGraph([N('A')], { Ghost: { main: [] } }), /unknown node 'Ghost'/);
    assert.match(validateGraph('nope', {}), /array/);
    assert.match(validateGraph(Array.from({ length: 51 }, (_, i) => N(`n${i}`)), {}), /max 50/);
  });
});

describe('connect / disconnect', () => {
  it('adds edges idempotently and drops empties', () => {
    let c = connect({}, 'A', 'B');
    assert.deepEqual(listEdges(c), [{ from: 'A', to: 'B' }]);
    c = connect(c, 'A', 'B');
    assert.deepEqual(listEdges(c), [{ from: 'A', to: 'B' }]);
    c = connect(c, 'A', 'A');
    assert.deepEqual(listEdges(c), [{ from: 'A', to: 'B' }], 'no self loops');
    c = disconnect(c, 'A', 'B');
    assert.deepEqual(c, {}, 'emptied group removed');
    assert.deepEqual(disconnect(c, 'A', 'B'), {});
  });
});

describe('removeNode', () => {
  it('removes the node and every touching edge', () => {
    const nodes = [N('A'), N('B'), N('C')];
    const conns = { A: { main: [[{ node: 'B' }], [{ node: 'C' }]] }, B: { main: [[{ node: 'C' }]] } };
    const r = removeNode(nodes, conns, 'B');
    assert.deepEqual(r.nodes.map((n) => n.name), ['A', 'C']);
    assert.deepEqual(listEdges(r.connections), [{ from: 'A', to: 'C' }]);
  });
});

describe('renameNode', () => {
  it('rewrites outgoing keys and incoming refs', () => {
    const nodes = [N('A'), N('B')];
    const conns = { A: { main: [[{ node: 'B' }]] }, B: { main: [[{ node: 'A' }]] } };
    const r = renameNode(nodes, conns, 'A', 'Z');
    assert.deepEqual(r.nodes.map((n) => n.name), ['Z', 'B']);
    assert.deepEqual(listEdges(r.connections).sort((a, b) => a.from.localeCompare(b.from)), [
      { from: 'B', to: 'Z' },
      { from: 'Z', to: 'B' },
    ]);
  });
  it('throws on collision and no-ops on identity', () => {
    assert.throws(() => renameNode([N('A'), N('B')], {}, 'A', 'B'), /duplicate/);
    const nodes = [N('A')];
    assert.equal(renameNode(nodes, {}, 'A', 'A').nodes, nodes);
  });
});

describe('palette helpers', () => {
  it('makeNode scaffolds known and unknown types', () => {
    const w = makeNode('n8n-nodes-base.webhook', 120, 80);
    assert.equal(w.name, 'Webhook');
    assert.deepEqual(w.position, [120, 80]);
    assert.equal(w.typeVersion, 2);
    assert.ok(typeof w.webhookId === 'string' && w.webhookId.length > 0);
    assert.equal(makeNode('n8n-nodes-base.httpRequest').typeVersion, 4.2);
    assert.equal(makeNode('custom.thing').typeVersion, 1);
    assert.equal(makeNode('custom.thing').type, 'custom.thing');
  });
  it('uniqueName avoids collisions', () => {
    assert.equal(uniqueName([N('Node')], 'Node'), 'Node 2');
    assert.equal(uniqueName([N('Node'), N('Node 2')], 'Node'), 'Node 3');
    assert.equal(uniqueName([], 'Node'), 'Node');
  });
  it('palette covers the templates we ship', () => {
    const types = new Set(NODE_TYPES.map((t) => t.type));
    for (const t of ['n8n-nodes-base.webhook', 'n8n-nodes-base.cron', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.noOp']) {
      assert.ok(types.has(t), t);
    }
  });
});

describe('round-trips and edge preservation', () => {
  it('normalizeWorkflow preserves webhookId', () => {
    const w = normalizeWorkflow({
      nodes: [{ id: 'a', name: 'W', type: 'n8n-nodes-base.webhook', position: [0, 0], parameters: {}, webhookId: 'wid-1' }],
      connections: {},
    });
    assert.equal(w.nodes[0].webhookId, 'wid-1');
  });

  it('tolerates non-object connections and coerces positions', () => {
    const w = normalizeWorkflow({ nodes: [{ name: 'A', position: ['10', 'x'], typeVersion: 'v', parameters: null }], connections: [] });
    assert.deepEqual(w.nodes[0].position, [10, 0]);
    assert.equal(w.nodes[0].typeVersion, 1);
    assert.deepEqual(w.connections, {}, 'array connections coerce to {}');
  });

  it('preserves edge fields through ops', () => {
    const conns = { A: { main: [[{ node: 'B', type: 'main', index: 3, extra: 1 }]] } };
    const afterConnect = connect(conns, 'A', 'C');
    assert.deepEqual(afterConnect.A.main[0][0], { node: 'B', type: 'main', index: 3, extra: 1 });
    const r = renameNode([N('A'), N('B'), N('C')], afterConnect, 'B', 'Z');
    assert.deepEqual(r.connections.A.main[0][0], { node: 'Z', type: 'main', index: 3, extra: 1 });
  });

  it('disconnect removes the target from every branch', () => {
    const conns = { A: { main: [[{ node: 'B' }, { node: 'C' }], [{ node: 'B' }]] } };
    const out = disconnect(conns, 'A', 'B');
    assert.deepEqual(listEdges(out), [{ from: 'A', to: 'C' }]);
  });

  it('rename of a nonexistent node is a clean no-op', () => {
    const nodes = [N('A')];
    const r = renameNode(nodes, {}, 'Ghost', 'Z');
    assert.equal(r.nodes, nodes);
    assert.deepEqual(r.connections, {});
  });

  it('rejects self-loops (JSON import path)', () => {
    assert.match(validateGraph([N('A')], { A: { main: [[{ node: 'A' }]] } }), /self-loop/);
  });

  it('makeNode rounds positions and falls back cleanly', () => {
    const n = makeNode('custom.thing', 10.6, 20.4);
    assert.deepEqual(n.position, [11, 20]);
    assert.ok(n.id.length > 0);
    const w1 = makeNode('n8n-nodes-base.webhook');
    const w2 = makeNode('n8n-nodes-base.webhook');
    assert.notEqual(w1.webhookId, w2.webhookId);
  });
});

describe('EXAMPLE_PARAMS', () => {
  it('covers builders with verified shapes', async () => {
    const { EXAMPLE_PARAMS } = await import('./workflow-graph.js');
    assert.ok(EXAMPLE_PARAMS['n8n-nodes-base.webhook'].path);
    assert.equal(EXAMPLE_PARAMS['n8n-nodes-base.webhook'].httpMethod, 'POST');
    assert.ok(EXAMPLE_PARAMS['n8n-nodes-base.httpRequest'].url);
    assert.ok(EXAMPLE_PARAMS['n8n-nodes-base.cron'].rule);
    assert.ok(EXAMPLE_PARAMS['n8n-nodes-base.code'].code);
    assert.ok(EXAMPLE_PARAMS['n8n-nodes-base.set'].values);
    assert.ok(EXAMPLE_PARAMS['n8n-nodes-base.if'].condition);
  });
});

describe('if branch slots (B1)', () => {
  it('connect with explicit branch keeps true/false indices', async () => {
    const { connect: c, disconnect: d } = await import('./workflow-graph.js');
    // Reconnect the false side: must land in main[1], not a new branch.
    let conns = { Check: { main: [[{ node: 'Big' }]] } };
    conns = c(conns, 'Check', 'Small', { branch: 1 });
    assert.deepEqual(conns.Check.main, [[{ node: 'Big' }], [{ node: 'Small', type: 'main', index: 0 }]]);
    // Reconnect the true side into a hole keeps slot 0.
    conns = d(conns, 'Check', 'Big', { preserveSlots: true });
    assert.deepEqual(conns.Check.main, [[], [{ node: 'Small', type: 'main', index: 0 }]]);
    conns = c(conns, 'Check', 'Big', { branch: 0 });
    assert.equal(conns.Check.main[0][0].node, 'Big');
    assert.equal(conns.Check.main[1][0].node, 'Small');
  });
  it('disconnect without preserveSlots collapses (non-if)', async () => {
    const { disconnect: d } = await import('./workflow-graph.js');
    assert.deepEqual(d({ A: { main: [[{ node: 'B' }]] } }, 'A', 'B'), {});
  });
  it('removeNode preserves surviving if slots', async () => {
    const { removeNode: rm } = await import('./workflow-graph.js');
    const ifN = (name) => ({ id: `id-${name}`, name, type: 'n8n-nodes-base.if', typeVersion: 1, position: [0, 0], parameters: {} });
    const nodes = [ifN('Check'), N('Big'), N('Small')];
    const conns = { Check: { main: [[{ node: 'Big' }], [{ node: 'Small' }]] } };
    const r = rm(nodes, conns, 'Big');
    assert.deepEqual(r.connections.Check.main, [[], [{ node: 'Small' }]]);
  });
  it('ifWarnings flags missing branches', async () => {
    const { ifWarnings } = await import('./workflow-graph.js');
    const ifN = (name) => ({ id: `id-${name}`, name, type: 'n8n-nodes-base.if', typeVersion: 1, position: [0, 0], parameters: {} });
    assert.equal(ifWarnings([ifN('C'), N('B')], { C: { main: [[{ node: 'B' }]] } }).length, 1);
    assert.match(ifWarnings([ifN('C'), N('B')], { C: { main: [[{ node: 'B' }]] } })[0], /false/);
    assert.deepEqual(ifWarnings([ifN('C'), N('A'), N('B')], { C: { main: [[{ node: 'A' }], [{ node: 'B' }]] } }), []);
  });
  it('listEdgesWithBranches reports slots; listEdges stays flat', async () => {
    const { listEdgesWithBranches, listEdges: le } = await import('./workflow-graph.js');
    const conns = { C: { main: [[{ node: 'A' }], [{ node: 'B' }]] } };
    assert.deepEqual(listEdgesWithBranches(conns), [
      { from: 'C', to: 'A', branch: 0 },
      { from: 'C', to: 'B', branch: 1 },
    ]);
    assert.deepEqual(le(conns), [{ from: 'C', to: 'A' }, { from: 'C', to: 'B' }]);
  });
  it('isKnownType + cycle detection (B2/B4)', async () => {
    const { isKnownType, detectCycle, validateGraph: vg } = await import('./workflow-graph.js');
    assert.equal(isKnownType('n8n-nodes-base.if'), true);
    assert.equal(isKnownType('custom.thing'), false);
    const nodes = [N('A'), N('B')];
    assert.match(detectCycle(nodes, { A: { main: [[{ node: 'B' }]] }, B: { main: [[{ node: 'A' }]] } }), /cycle detected/);
    assert.match(vg(nodes, { A: { main: [[{ node: 'B' }]] }, B: { main: [[{ node: 'A' }]] } }), /cycle detected/);
    assert.equal(detectCycle(nodes, { A: { main: [[{ node: 'B' }]] } }), null);
  });
  it('validateGraph flags dangling nodes', async () => {
    const { validateGraph: vg } = await import('./workflow-graph.js');
    assert.equal(vg([N('A'), N('B')], { A: { main: [[{ node: 'B' }]] } }), null);
    // Add an isolated C — every node in a multi-node graph must be wired.
    assert.match(vg([N('A'), N('B'), N('C')], { A: { main: [[{ node: 'B' }]] } }), /dangling node 'C'/);
  });
  it('nextWallClockRun matches the engine across timezones (P2)', async () => {
    const { nextWallClockRun, describeCron } = await import('./workflow-graph.js');
    const from = Date.UTC(2026, 9, 15, 18, 30, 0);
    const next = nextWallClockRun({ cronExpression: '30 9 * * *', timezone: 'Asia/Ho_Chi_Minh' }, from);
    assert.equal(next.at, '2026-10-16T02:30:00.000Z');
    assert.match(describeCron({ cronExpression: '30 9 * * *', timezone: 'Asia/Ho_Chi_Minh' }).text, /Daily at 09:30/);
    assert.equal(nextWallClockRun({ cronExpression: '*/5 * * * *' }, from), null);
  });
});

describe('github sample input', () => {
  it('suggests a push payload for github webhook paths', async () => {
    const { sampleInputFor } = await import('./workflow-graph.js');
    const s = sampleInputFor([{ name: 'W', type: 'n8n-nodes-base.webhook', parameters: { path: 'github-push' } }]);
    assert.equal(s.repository.full_name, 'acme/demo');
    assert.ok(Array.isArray(s.commits));
    const plain = sampleInputFor([{ name: 'W', type: 'n8n-nodes-base.webhook', parameters: { path: 'my-hook' } }]);
    assert.equal(plain.hello, 'world');
  });
});

describe('agent tool/model sockets', () => {
  const agent = (name) => ({ id: `id-${name}`, name, type: 'synapseflow.aiAgent', position: [0, 0], parameters: {} });
  const model = (name) => ({ id: `id-${name}`, name, type: 'synapseflow.model', position: [0, 0], parameters: {} });

  it('tool and model edges are auxiliary and never create execution cycles', async () => {
    const { connect: c, detectCycle, validateGraph: vg, toolEdgesForAgent, modelEdgeForAgent } = await import('./workflow-graph.js');
    const nodes = [N('Hook', { type: 'n8n-nodes-base.webhook' }), agent('Agent'), N('KB', { type: 'synapseone.base' }), model('Model'), N('Done')];
    let conns = c({}, 'Hook', 'Agent');
    conns = c(conns, 'KB', 'Agent', { targetPort: 'tools' });
    conns = c(conns, 'Model', 'Agent', { targetPort: 'model' });
    conns = c(conns, 'Agent', 'Done');
    assert.deepEqual(toolEdgesForAgent(conns, 'Agent'), [{ from: 'KB', to: 'Agent' }]);
    assert.deepEqual(modelEdgeForAgent(conns, 'Agent'), { from: 'Model', to: 'Agent' });
    assert.equal(vg(nodes, conns), null);
    // A flow edge back to the tool source plus an aux edge back to the agent
    // must still be a DAG: sockets are configuration, not execution.
    const auxCycle = { Agent: { main: [[{ node: 'KB', type: 'main', index: 0 }]] }, KB: { main: [[{ node: 'Agent', type: 'tools', index: 0, targetPort: 'tools' }]] } };
    assert.equal(detectCycle([agent('Agent'), N('KB')], auxCycle), null);
  });

  it('validates aux targets and only one model source', async () => {
    const { validateGraph: vg } = await import('./workflow-graph.js');
    const nodes = [N('Hook', { type: 'n8n-nodes-base.webhook' }), agent('Agent'), N('KB', { type: 'synapseone.base' }), model('M1'), model('M2')];
    const badTarget = { Hook: { main: [[{ node: 'Agent' }]] }, KB: { main: [[{ node: 'Hook', type: 'tools', targetPort: 'tools' }]] } };
    assert.match(vg(nodes, badTarget), /can only target an AI Agent/);
    const twoModels = {
      Hook: { main: [[{ node: 'Agent' }]] },
      M1: { main: [[{ node: 'Agent', type: 'model', targetPort: 'model' }]] },
      M2: { main: [[{ node: 'Agent', type: 'model', targetPort: 'model' }]] },
    };
    assert.match(vg(nodes, twoModels), /more than one model source/);
    const badModelSource = {
      Hook: { main: [[{ node: 'Agent' }]] },
      KB: { main: [[{ node: 'Agent', type: 'model', targetPort: 'model' }]] },
    };
    assert.match(vg(nodes, badModelSource), /Model Core source/);
  });

  it('normal flow fan-out stays in the single main slot', async () => {
    const { connect: c, listEdgesWithBranches } = await import('./workflow-graph.js');
    let conns = c({}, 'A', 'B');
    conns = c(conns, 'A', 'C');
    assert.equal(conns.A.main.length, 1);
    assert.deepEqual(listEdgesWithBranches(conns).map((e) => e.branch), [0, 0]);
  });
});

describe('decision routes', () => {
  const decision = (name, choices = { billing: 'billing issues', technical: 'technical issues' }) => ({
    id: `id-${name}`, name, type: 'synapseflow.decision', position: [0, 0], parameters: { choices },
  });

  it('reads object and array choices and keeps branch order', async () => {
    const { decisionRoutes, validateGraph: vg, connect: c } = await import('./workflow-graph.js');
    assert.deepEqual(decisionRoutes({ choices: { billing: 'money', technical: 'bugs' } }).map((r) => r.name), ['billing', 'technical']);
    assert.deepEqual(decisionRoutes({ choices: [{ name: 'a', description: 'A' }, 'b'] }).map((r) => r.name), ['a', 'b']);
    const nodes = [N('Hook', { type: 'n8n-nodes-base.webhook' }), decision('D'), N('B'), N('T')];
    let conns = c({}, 'Hook', 'D');
    conns = c(conns, 'D', 'B', { branch: 0 });
    conns = c(conns, 'D', 'T', { branch: 1 });
    assert.equal(vg(nodes, conns), null);
    assert.match(vg(nodes, c(conns, 'D', 'B', { branch: 2 })), /has 2 route/);
  });

  it('warns when a decision route is unwired', async () => {
    const { decisionWarnings, graphWarnings } = await import('./workflow-graph.js');
    const nodes = [decision('D'), N('B')];
    const conns = { D: { main: [[{ node: 'B' }]] } };
    assert.match(decisionWarnings(nodes, conns)[0], /technical/);
    assert.ok(graphWarnings(nodes, conns).length >= 1);
  });
});

describe('first-party integration palette', () => {
  it('ships every split service as a draggable node with example params', async () => {
    const { INTEGRATION_SERVICES, NODE_TYPES: types, EXAMPLE_PARAMS: examples, makeNode: mk, isIntegrationType } = await import('./workflow-graph.js');
    const byType = new Set(types.map((t) => t.type));
    for (const type of Object.keys(INTEGRATION_SERVICES)) {
      assert.ok(byType.has(type), `${type} missing from palette`);
      assert.ok(isIntegrationType(type));
      assert.ok(examples[type], `${type} missing example params`);
      assert.ok(mk(type).typeVersion >= 1);
    }
  });
});

describe('edge identity on shared source/target pairs', () => {
  it('disconnect without targetPort removes only the flow edge', async () => {
    const { connect: c, disconnect: d, listEdgesWithBranches } = await import('./workflow-graph.js');
    let conns = c({}, 'KB', 'Agent');
    conns = c(conns, 'KB', 'Agent', { targetPort: 'tools' });
    assert.equal(listEdgesWithBranches(conns).length, 2);
    conns = d(conns, 'KB', 'Agent');
    const left = listEdgesWithBranches(conns);
    assert.equal(left.length, 1);
    assert.equal(left[0].targetPort, 'tools');
    conns = d(conns, 'KB', 'Agent', { targetPort: 'tools' });
    assert.equal(listEdgesWithBranches(conns).length, 0);
  });
});
