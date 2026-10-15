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
    assert.deepEqual(w.connections, []);
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
  });
});
