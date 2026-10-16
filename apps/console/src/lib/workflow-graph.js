/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// Pure workflow-graph operations for the visual drag-and-drop editor.
// No DOM, no React — fully unit-tested (workflow-graph.test.mjs).
// Data model served by workflow-service (local engine):
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
  const rawConns = d.connections;
  const connections = rawConns && typeof rawConns === 'object' && !Array.isArray(rawConns) ? rawConns : {};
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

function outgoingFlatLocal(from, connections) {
  const g = connections?.[from];
  const main = g?.main;
  if (!Array.isArray(main)) return [];
  const out = [];
  for (const branch of main) {
    if (!Array.isArray(branch)) continue;
    for (const e of branch) {
      if (e && typeof e.node === 'string') out.push(e.node);
    }
  }
  return out;
}

/** Cycle detection mirroring workflow-service engine.detectCycle (message-synced). */
export function detectCycle(nodes, connections) {
  const byName = new Map((nodes || []).map((n) => [n.name, n]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const n of nodes || []) color.set(n.name, WHITE);
  const stack = [];
  function dfs(u) {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of outgoingFlatLocal(u, connections || {})) {
      if (!byName.has(v)) continue;
      if (color.get(v) === GRAY) {
        return `cycle detected: ${[...stack, v].join(' -> ')}`;
      }
      if (color.get(v) === WHITE) {
        const r = dfs(v);
        if (r) return r;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return null;
  }
  for (const n of nodes || []) {
    if (color.get(n.name) === WHITE) {
      const r = dfs(n.name);
      if (r) return r;
    }
  }
  return null;
}

/** Structural validation before save (server re-validates SSRF + size).
 *  Messages are synced with workflow-service validateDefinition for the
 *  structural subset (duplicate / self-loop / dangling / cycle). */
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
  const cyc = detectCycle(nodes, connections || {});
  if (cyc) return cyc;
  // Dangling (isolated) nodes: in a multi-node graph every node should be
  // wired to something — otherwise its output is silently dropped.
  if (nodes.length > 1) {
    const touched = new Set();
    for (const [from, groups] of Object.entries(connections || {})) {
      const mains = groups?.main;
      if (!Array.isArray(mains)) continue;
      let hasEdge = false;
      for (const branch of mains) {
        for (const e of Array.isArray(branch) ? branch : []) {
          if (e && typeof e.node === 'string' && names.has(e.node)) {
            touched.add(e.node);
            hasEdge = true;
          }
        }
      }
      if (hasEdge) touched.add(from);
    }
    for (const n of nodes) {
      if (!touched.has(n.name)) return `dangling node '${n.name}' has no connections`;
    }
  }
  return null;
}

function cloneConnections(connections) {
  const out = {};
  for (const [from, groups] of Object.entries(connections || {})) {
    const mains = groups && typeof groups === 'object' && Array.isArray(groups.main) ? groups.main : [];
    // Keep branch slots (including empties — an `if` true/false slot is
    // meaningful even when unwired); drop only fully-empty groups.
    const kept = mains.map((branch) => (Array.isArray(branch) ? branch.filter((e) => e && typeof e === 'object') : []));
    if (kept.some((branch) => branch.length > 0)) out[from] = { main: kept };
  }
  return out;
}

/** Would adding fromName -> toName create a cycle? (preview for tooltip/disable). */
export function wouldCycle(nodes, connections, fromName, toName) {
  if (!fromName || !toName) return false;
  if (fromName === toName) return true;
  const names = new Set((nodes || []).map((n) => n.name));
  if (!names.has(fromName) || !names.has(toName)) return false;
  const trial = cloneConnections(connections);
  const mains = (trial[fromName] && trial[fromName].main) || [];
  const exists = mains.some((branch) => branch.some((e) => e.node === toName));
  if (!exists) {
    mains.push([{ node: toName, type: 'main', index: 0 }]);
    trial[fromName] = { main: mains };
  }
  return detectCycle(nodes, trial) !== null;
}

export const IF_TYPE = 'n8n-nodes-base.if';
/** Branch index contract for If nodes: main[0] = true, main[1] = false. */
export const IF_BRANCH_TRUE = 0;
export const IF_BRANCH_FALSE = 1;
export function ifBranchLabel(i) {
  return i === 0 ? 'true' : i === 1 ? 'false' : `out ${i}`;
}

/** Add an edge fromName -> toName.
 *  For `if` sources the branch slot is positional (main[0]=true,
 *  main[1]=false), so callers must pass { branch } explicitly — otherwise
 *  a reconnect silently swaps true/false. For other sources each call
 *  appends a new fan-out branch (engine runs every branch). No-op when the
 *  exact edge already exists. */
export function connect(connections, fromName, toName, opts) {
  if (!fromName || !toName || fromName === toName) return cloneConnections(connections);
  const branch = opts && typeof opts.branch === 'number' ? opts.branch : undefined;
  const out = cloneConnections(connections);
  const mains = (out[fromName] && out[fromName].main) || [];
  const exists = mains.some((b) => b.some((e) => e.node === toName));
  if (exists) {
    if (out[fromName]) out[fromName] = { main: mains };
    else if (mains.length) out[fromName] = { main: mains };
    return out;
  }
  if (branch !== undefined) {
    const idx = Math.max(0, Math.min(branch, 1));
    while (mains.length <= idx) mains.push([]);
    mains[idx] = [...mains[idx], { node: toName, type: 'main', index: 0 }];
    out[fromName] = { main: mains };
    return out;
  }
  mains.push([{ node: toName, type: 'main', index: 0 }]);
  out[fromName] = { main: mains };
  return out;
}

/** Remove the edge fromName -> toName.
 *  For `if` sources pass { preserveSlots: true } so the surviving branch
 *  keeps its true/false index — collapsing would silently swap branches.
 *  Otherwise emptied branches/groups are dropped. */
export function disconnect(connections, fromName, toName, opts) {
  const preserve = !!(opts && opts.preserveSlots);
  const out = cloneConnections(connections);
  if (!out[fromName]) return out;
  const mains = out[fromName].main
    .map((branch) => branch.filter((e) => e.node !== toName));
  const kept = preserve ? mains : mains.filter((branch) => branch.length > 0);
  if (kept.some((b) => b.length > 0)) out[fromName] = { main: kept };
  else delete out[fromName];
  return out;
}

/** Remove a node by name + every edge touching it. Returns { nodes, connections }.
 *  Branch slots of surviving `if` sources are preserved (see disconnect). */
export function removeNode(nodes, connections, name) {
  const byName = new Map((nodes || []).map((n) => [n.name, n]));
  const kept = nodes.filter((n) => n.name !== name);
  const out = cloneConnections(connections);
  delete out[name];
  for (const from of Object.keys(out)) {
    const preserve = byName.get(from)?.type === IF_TYPE;
    const mains = out[from].main
      .map((branch) => branch.filter((e) => e.node !== name));
    const keptBranches = preserve ? mains : mains.filter((branch) => branch.length > 0);
    if (keptBranches.some((b) => b.length > 0)) out[from] = { main: keptBranches };
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
  return listEdgesWithBranches(connections).map(({ from, to }) => ({ from, to }));
}

/** Edge list with branch slots: [{ from, to, branch }]. For `if` sources
 *  branch 0 = true, 1 = false (engine contract). */
export function listEdgesWithBranches(connections) {
  const edges = [];
  for (const [from, groups] of Object.entries(connections || {})) {
    const mains = (groups && groups.main) || [];
    mains.forEach((branch, bi) => {
      for (const e of Array.isArray(branch) ? branch : []) {
        if (e && typeof e.node === 'string') edges.push({ from, to: e.node, branch: bi });
      }
    });
  }
  return edges;
}

/** Non-blocking warnings: `if` nodes missing a true/false branch silently
 *  drop runs down the unwired side (engine treats it as terminal). */
export function ifWarnings(nodes, connections) {
  const out = [];
  const byName = new Map((nodes || []).map((n) => [n.name, n]));
  for (const [from, groups] of Object.entries(connections || {})) {
    if (byName.get(from)?.type !== IF_TYPE) continue;
    const mains = Array.isArray(groups?.main) ? groups.main : [];
    const hasTrue = (mains[0] || []).some((e) => e && typeof e.node === 'string');
    const hasFalse = (mains[1] || []).some((e) => e && typeof e.node === 'string');
    if (!hasTrue || !hasFalse) {
      const missing = [!hasTrue && 'true', !hasFalse && 'false'].filter(Boolean).join(' + ');
      out.push(`if node '${from}' has no ${missing} branch — runs down that side stop at '${from}'`);
    }
  }
  // If sources with no outgoing edges at all.
  for (const n of nodes || []) {
    if (n?.type === IF_TYPE && !connections?.[n.name]) {
      out.push(`if node '${n.name}' has no branches wired — both sides stop at '${n.name}'`);
    }
  }
  return out;
}

/** True when the type is one the local engine + palette know about. */
export function isKnownType(type) {
  return NODE_TYPES.some((t) => t.type === type);
}

/** Curated local-engine node types for the palette (free-form type still allowed). */
export const NODE_TYPES = [
  { type: 'n8n-nodes-base.webhook', label: 'Webhook', hint: 'Trigger via HTTP POST/GET — starts the run with the request body', category: 'triggers', placeholder: 'Receives {"hello":"world"} → passes it downstream' },
  { type: 'n8n-nodes-base.cron', label: 'Schedule', hint: 'Trigger on a timer — fires with {scheduledAt}', category: 'triggers', placeholder: 'Every 24h → fetches and transforms' },
  { type: 'n8n-nodes-base.manualTrigger', label: 'Manual', hint: 'Trigger by hand — run from Console with any JSON input', category: 'triggers', placeholder: 'Click Execute with {"value": 21}' },
  { type: 'n8n-nodes-base.httpRequest', label: 'HTTP Request', hint: 'Call a public API — GET/POST with headers + JSON body', category: 'actions', placeholder: 'GET https://api.example.com/health' },
  { type: 'n8n-nodes-base.code', label: 'Code', hint: 'Run sandboxed JavaScript — $input in, return value out', category: 'actions', placeholder: 'return { doubled: ($input.value ?? 0) * 2 }' },
  { type: 'n8n-nodes-base.set', label: 'Set', hint: 'Add/overwrite fields — supports {{ $json.x }} templating', category: 'actions', placeholder: 'Set tag = processed, keep the rest' },
  { type: 'n8n-nodes-base.if', label: 'If', hint: 'Branch on a condition — output 0 = true, output 1 = false', category: 'logic', placeholder: '$input.value > 10 → Big / Small' },
  { type: 'n8n-nodes-base.noOp', label: 'NoOp', hint: 'Do nothing — passes input through (useful log point)', category: 'utils', placeholder: 'Passthrough for debugging' },
];

/** Palette groups in display order. */
export const NODE_CATEGORIES = [
  { id: 'triggers', label: 'Triggers', blurb: 'How a run starts (pick one)' },
  { id: 'actions', label: 'Actions', blurb: 'Do work: fetch, transform, set fields' },
  { id: 'logic', label: 'Logic', blurb: 'Branch the flow' },
  { id: 'utils', label: 'Utils', blurb: 'Helpers' },
];

export function nodesByCategory() {
  return NODE_CATEGORIES.map((c) => ({ ...c, items: NODE_TYPES.filter((t) => t.category === c.id) }));
}

/** Known-good typeVersions (local engine contract, see
 *  workflow-service buildTemplate); unknown types default to 1. */
const TYPE_VERSIONS = {
  'n8n-nodes-base.webhook': 2,
  'n8n-nodes-base.cron': 1,
  'n8n-nodes-base.manualTrigger': 1,
  'n8n-nodes-base.httpRequest': 4.2,
  'n8n-nodes-base.code': 1,
  'n8n-nodes-base.set': 1,
  'n8n-nodes-base.if': 1,
  'n8n-nodes-base.noOp': 1,
};

/** Verified example parameters (local engine contract, see
 *  workflow-service buildTemplate + engine.ts) — one click to start from
 *  something that actually executes. Every palette type has an entry. */
export const EXAMPLE_PARAMS = {
  'n8n-nodes-base.webhook': { path: 'my-hook', httpMethod: 'POST' },
  'n8n-nodes-base.cron': { rule: { interval: [{ field: 'hours', hoursInterval: 24 }] } },
  'n8n-nodes-base.manualTrigger': {},
  'n8n-nodes-base.httpRequest': { url: 'https://api.example.com/health', method: 'GET' },
  'n8n-nodes-base.code': { code: 'return { ...$input, doubled: ($input.value ?? 0) * 2, at: $now };' },
  'n8n-nodes-base.if': { condition: '$input.value > 10' },
  'n8n-nodes-base.set': { values: { tag: 'processed' } },
  'n8n-nodes-base.noOp': {},
};

/** Sample test-run input suggested from the entry (trigger) node. */
export const SAMPLE_INPUTS = {
  'n8n-nodes-base.webhook': { hello: 'world' },
  'n8n-nodes-base.cron': { scheduledAt: '2026-01-01T00:00:00.000Z' },
  'n8n-nodes-base.manualTrigger': { value: 21 },
  default: { value: 21 },
};

export function sampleInputFor(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const trig = list.find((n) => n && typeof n.type === 'string' && /webhook|cron|manualTrigger/.test(n.type));
  const t = trig?.type || '';
  if (SAMPLE_INPUTS[t]) return { ...SAMPLE_INPUTS[t] };
  return { ...SAMPLE_INPUTS.default };
}

function cloneJson(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

export function makeNode(type, x = 0, y = 0) {
  const found = NODE_TYPES.find((t) => t.type === type);
  const node = {
    id: uid(),
    name: (found ? found.label : 'Node').replace(/[^A-Za-z0-9]+/g, '') || 'Node',
    type,
    typeVersion: TYPE_VERSIONS[type] || 1,
    position: [Math.round(x), Math.round(y)],
    // Pre-fill a runnable example so a dropped node executes without setup.
    parameters: cloneJson(EXAMPLE_PARAMS[type] || {}),
  };
  // webhook identity: mint a webhookId like buildTemplate does.
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

/** First webhook trigger path declared by a node list (for URL display). */
export function webhookPathOf(nodes) {
  for (const n of nodes || []) {
    if (n?.type !== 'n8n-nodes-base.webhook') continue;
    const p = String(n?.parameters?.path || '').replace(/^\/+|\/+$/g, '');
    if (p) return p;
  }
  return null;
}

function cronIntervalMsLocal(parameters) {
  const p = parameters || {};
  for (const key of ['intervalMs', 'interval', 'everyMs']) {
    const v = Number(p[key]);
    if (Number.isFinite(v) && v >= 10000) return v;
  }
  if (typeof p.cronExpression === 'string' && p.cronExpression.trim()) {
    const c = p.cronExpression.trim();
    if (c === '@hourly') return 3600_000;
    if (c === '@daily') return 24 * 3600_000;
    const m = c.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (m) return Math.max(1, parseInt(m[1], 10)) * 60_000;
    return null;
  }
  const rule = p.rule?.interval;
  if (Array.isArray(rule)) {
    for (const item of rule) {
      const field = String(item?.field || '').toLowerCase();
      if (field === 'seconds' && Number(item.secondsInterval) > 0) return Number(item.secondsInterval) * 1000;
      if (field === 'minutes' && Number(item.minutesInterval) > 0) return Number(item.minutesInterval) * 60_000;
      if (field === 'hours' && Number(item.hoursInterval) > 0) return Number(item.hoursInterval) * 3600_000;
      if (field === 'days' && Number(item.daysInterval) > 0) return Number(item.daysInterval) * 86400_000;
    }
  }
  if (Number(p.hoursInterval) > 0) return Number(p.hoursInterval) * 3600_000;
  if (Number(p.minutesInterval) > 0) return Number(p.minutesInterval) * 60_000;
  if (Number(p.secondsInterval) > 0) return Number(p.secondsInterval) * 1000;
  return null;
}

/** Human-readable cron summary + next run (for the Schedule form). */
export function describeCron(parameters) {
  const wall = nextWallClockRun(parameters || {}, Date.now());
  if (wall) {
    return { text: `Daily at ${wall.label}${wall.tz === 'UTC' ? '' : ` (${wall.tz})`}`, nextRun: wall.at };
  }
  const ms = cronIntervalMsLocal(parameters || {});
  if (!ms) return { text: 'No schedule detected — set an interval or cron expression.', nextRun: null };
  const mins = Math.round(ms / 60000);
  const text = mins >= 60 && mins % 60 === 0 ? `Every ${mins / 60}h` : mins >= 1440 && mins % 1440 === 0 ? `Every ${mins / 1440}d` : `Every ${mins}m`;
  return { text, nextRun: new Date(Date.now() + ms).toISOString() };
}

function validTimezoneLocal(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function wallClockExprs(parameters) {
  const out = [];
  if (typeof parameters.cronExpression === 'string' && parameters.cronExpression.trim()) out.push(parameters.cronExpression.trim());
  const rule = parameters?.rule?.interval;
  if (Array.isArray(rule)) {
    for (const item of rule) {
      if (String(item?.field || '').toLowerCase() === 'cron' && typeof item.cronExpression === 'string' && item.cronExpression.trim()) {
        out.push(item.cronExpression.trim());
      }
    }
  }
  return out;
}

/** Next wall-clock fire for "M H * * *" / "@daily", or null. */
export function nextWallClockRun(parameters, fromMs) {
  const now = typeof fromMs === 'number' ? fromMs : Date.now();
  const tz = validTimezoneLocal(parameters.timezone) ? parameters.timezone : 'UTC';
  let best = null;
  for (const e of wallClockExprs(parameters)) {
    let h = null;
    let m = 0;
    if (e === '@daily') { h = 0; m = 0; }
    else {
      const mt = e.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
      if (!mt) continue;
      m = Number(mt[1]); h = Number(mt[2]);
      if (m > 59 || h > 23) continue;
    }
    for (let day = 0; day < 3; day++) {
      let wall = null;
      try {
        wall = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now + day * 86400_000));
      } catch {
        break;
      }
      const [y, mo, d] = wall.split('-').map(Number);
      const base = Date.UTC(y, mo - 1, d, h, m);
      let fire = base;
      try {
        const dtf = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
        for (let i = 0; i < 2; i++) {
          const parts = Object.fromEntries(dtf(0).formatToParts(new Date(fire)).map((x) => [x.type, x.value]));
          const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) === 24 ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second));
          fire = base - (asUtc - fire);
        }
      } catch {
        break;
      }
      if (fire > now && (!best || fire < best.at)) {
        best = { at: new Date(fire).toISOString(), label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, tz };
        break;
      }
    }
  }
  return best;
}
