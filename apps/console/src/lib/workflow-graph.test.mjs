/*
 * Copyright 2026 SynapseDX Contributors
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
