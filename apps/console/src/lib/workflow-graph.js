/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// Pure workflow-graph operations for the visual drag-and-drop editor.
// No DOM, no React — fully unit-tested (workflow-graph.test.mjs).
// Data model mirrors n8n definitions as served by workflow-service:
//   nodes: [{ id, name, type, typeVersion?, position: [x, y], parameters: {...} }]
//   connections: { [fromName]: { main: [[{ node: toName, type, index }]] } }

export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalize a stored definition into an editable { name, nodes, connections }. */
export function normalizeWorkflow(detail) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const nodes = Array.isArray(d.nodes) ? d.nodes.map(normalizeNode).filter(Boolean) : [];
  const connections = d.connections && typeof d.connections === 'object' ? d.connections : {};
  return { name: typeof d.name === 'string' ? d.name : '', nodes, connections };
}

function normalizeNode(n) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  const { id, name, type, typeVersion, position, parameters, webhookId, ...rest } = n;
  const pos = Array.isArray(position) && position.length >= 2 ? [Number(position[0]) || 0, Number(position[1]) || 0] : [0, 0];
  return {
    // Pass through anything we don't model (credentials, disabled, notes,
    // retryOnFail, …) so an editor save never silently strips node config.
    ...rest,
    id: typeof id === 'string' && id ? id : uid(),
    name: typeof name === 'string' && name ? name : 'Node',
    type: typeof type === 'string' && type ? type : 'n8n-nodes-base.noOp',
    typeVersion: typeof typeVersion === 'number' ? typeVersion : 1,
    position: pos,
    parameters: parameters && typeof parameters === 'object' ? parameters : {},
    ...(typeof webhookId === 'string' ? { webhookId } : {}),
  };
}

/** Structural validation before save (server re-validates SSRF + size). */
export function validateGraph(nodes, connections) {
  if (!Array.isArray(nodes)) return 'nodes must be an array';
  if (nodes.length > 50) return 'too many nodes (max 50)';
  const names = new Set();
  for (const n of nodes) {
    if (!n || typeof n !== 'object') return 'every node must be an object';
    if (typeof n.name !== 'string' || !n.name) return 'every node needs a name';
    if (names.has(n.name)) return `duplicate node name '${n.name}'`;
    names.add(n.name);
    if (typeof n.type !== 'string' || !n.type) return `node '${n.name}' needs a type`;
    if (!Array.isArray(n.position) || n.position.length < 2) return `node '${n.name}' needs position [x, y]`;
  }
  if (connections !== undefined && (typeof connections !== 'object' || connections === null || Array.isArray(connections))) {
    return 'connections must be an object';
  }
  for (const [from, groups] of Object.entries(connections || {})) {
    if (!names.has(from)) return `connection from unknown node '${from}'`;
    const mains = groups && typeof groups === 'object' ? groups.main : undefined;
    if (mains !== undefined && !Array.isArray(mains)) return `connections['${from}'].main must be an array`;
    for (const branch of mains || []) {
      for (const edge of Array.isArray(branch) ? branch : []) {
        if (!edge || typeof edge !== 'object' || !names.has(edge.node)) {
          return `connection from '${from}' points at unknown node '${edge && edge.node}'`;
        }
        if (edge.node === from) return `self-loop on '${from}' is not allowed`;
      }
    }
  }
  return null;
}

function cloneConnections(connections) {
  const out = {};
  for (const [from, groups] of Object.entries(connections || {})) {
    const mains = groups && typeof groups === 'object' && Array.isArray(groups.main) ? groups.main : [];
    const kept = mains
      .map((branch) => (Array.isArray(branch) ? branch.filter((e) => e && typeof e === 'object') : []))
      .filter((branch) => branch.length > 0);
    if (kept.length > 0) out[from] = { main: kept };
  }
  return out;
}

/** Add an edge fromName -> toName (main output 0). No-op when it exists. */
export function connect(connections, fromName, toName) {
  if (!fromName || !toName || fromName === toName) return cloneConnections(connections);
  const out = cloneConnections(connections);
  const mains = (out[fromName] && out[fromName].main) || [];
  const exists = mains.some((branch) => branch.some((e) => e.node === toName));
  if (!exists) {
    mains.push([{ node: toName, type: 'main', index: 0 }]);
    out[fromName] = { main: mains };
  }
  return out;
}

/** Remove the edge fromName -> toName (drops emptied branches/groups). */
export function disconnect(connections, fromName, toName) {
  const out = cloneConnections(connections);
  if (!out[fromName]) return out;
  const mains = out[fromName].main
    .map((branch) => branch.filter((e) => e.node !== toName))
    .filter((branch) => branch.length > 0);
  if (mains.length > 0) out[fromName] = { main: mains };
  else delete out[fromName];
  return out;
}

/** Remove a node by name + every edge touching it. Returns { nodes, connections }. */
export function removeNode(nodes, connections, name) {
  const kept = nodes.filter((n) => n.name !== name);
  const out = cloneConnections(connections);
  delete out[name];
  for (const from of Object.keys(out)) {
    const mains = out[from].main
      .map((branch) => branch.filter((e) => e.node !== name))
      .filter((branch) => branch.length > 0);
    if (mains.length > 0) out[from] = { main: mains };
    else delete out[from];
  }
  return { nodes: kept, connections: out };
}

/** Rename a node + rewrite every connection reference. Throws on collision. */
export function renameNode(nodes, connections, from, to) {
  if (!to || from === to) return { nodes, connections };
  if (!nodes.some((n) => n.name === from)) return { nodes, connections };
  if (nodes.some((n) => n.name === to)) throw new Error(`duplicate node name '${to}'`);
  const nextNodes = nodes.map((n) => (n.name === from ? { ...n, name: to } : n));
  const out = {};
  for (const [key, groups] of Object.entries(cloneConnections(connections))) {
    const mains = (groups.main || []).map((branch) =>
      branch.map((e) => (e.node === from ? { ...e, node: to } : e)),
    );
    out[key === from ? to : key] = { main: mains };
  }
  return { nodes: nextNodes, connections: out };
}

/** Flat edge list for rendering: [{ from, to }]. */
export function listEdges(connections) {
  const edges = [];
  for (const [from, groups] of Object.entries(connections || {})) {
    for (const branch of (groups && groups.main) || []) {
      for (const e of Array.isArray(branch) ? branch : []) {
        if (e && typeof e.node === 'string') edges.push({ from, to: e.node });
      }
    }
  }
  return edges;
}

/** Curated n8n node types for the palette (free-form type still allowed). */
export const NODE_TYPES = [
  { type: 'n8n-nodes-base.webhook', label: 'Webhook', hint: 'Trigger via HTTP' },
  { type: 'n8n-nodes-base.cron', label: 'Schedule', hint: 'Trigger on a timer' },
  { type: 'n8n-nodes-base.manualTrigger', label: 'Manual', hint: 'Trigger by hand' },
  { type: 'n8n-nodes-base.httpRequest', label: 'HTTP Request', hint: 'Call an API' },
  { type: 'n8n-nodes-base.code', label: 'Code', hint: 'Run JavaScript' },
  { type: 'n8n-nodes-base.set', label: 'Set', hint: 'Set fields' },
  { type: 'n8n-nodes-base.if', label: 'If', hint: 'Branch on condition' },
  { type: 'n8n-nodes-base.noOp', label: 'NoOp', hint: 'Do nothing (log)' },
];

/** Known-good typeVersions (mirrored from real n8n definitions, see
 *  workflow-service buildTemplate); unknown types default to 1. */
const TYPE_VERSIONS = {
  'n8n-nodes-base.webhook': 2,
  'n8n-nodes-base.cron': 1,
  'n8n-nodes-base.httpRequest': 4.2,
  'n8n-nodes-base.noOp': 1,
};

/** Verified example parameters (taken from real n8n definitions, see
 *  workflow-service buildTemplate) — one click to start from something
 *  that actually executes. Types without an entry start empty. */
export const EXAMPLE_PARAMS = {
  'n8n-nodes-base.webhook': { path: 'my-hook', httpMethod: 'POST' },
  'n8n-nodes-base.cron': { rule: { interval: [{ field: 'hours', hoursInterval: 24 }] } },
  'n8n-nodes-base.httpRequest': { url: 'https://api.example.com/health', method: 'GET' },
};
export function makeNode(type, x = 0, y = 0) {
  const found = NODE_TYPES.find((t) => t.type === type);
  const node = {
    id: uid(),
    name: (found ? found.label : 'Node').replace(/[^A-Za-z0-9]+/g, '') || 'Node',
    type,
    typeVersion: TYPE_VERSIONS[type] || 1,
    position: [Math.round(x), Math.round(y)],
    parameters: {},
  };
  // n8n keys webhook registration off webhookId — mint one like buildTemplate.
  if (type === 'n8n-nodes-base.webhook') node.webhookId = uid();
  return node;
}

/** Unique display name (Node, Node 2, …) within the canvas. */
export function uniqueName(nodes, base) {
  const taken = new Set(nodes.map((n) => n.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}
