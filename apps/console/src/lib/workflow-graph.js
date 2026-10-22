/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// Pure workflow-graph operations for the visual drag-and-drop editor.
// No DOM, no React — fully unit-tested (workflow-graph.test.mjs).
// Data model served by workflow-service (local engine):
//   nodes: [{ id, name, type, typeVersion?, position: [x, y], parameters: {...} }]
//   connections: { [fromName]: { main: [[{ node: toName, type, index }]] } }
//
// Auxiliary ports:
//   targetPort "tools"  -> the source node becomes a callable tool of an AI Agent
//   targetPort "model"  -> the source node supplies the AI Agent model/core config
// Auxiliary edges are NOT part of the execution DAG: they never run as normal
// flow, never create cycles and never count as an entry path.

export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Port carried by an edge (tools/model), or null for a normal flow edge. */
export function edgeTargetPort(e) {
  if (!e || typeof e !== 'object') return null;
  const p = e.targetPort || (typeof e.type === 'string' && e.type !== 'main' ? e.type : null);
  return p === 'tools' || p === 'model' ? p : null;
}

export function isAuxEdge(e) {
  return edgeTargetPort(e) !== null;
}

/** Normalize a stored definition into an editable { name, nodes, connections }. */
export function normalizeWorkflow(detail) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const usedIds = new Set();
  const nodes = Array.isArray(d.nodes)
    ? d.nodes.map((n) => normalizeNode(n, usedIds)).filter(Boolean)
    : [];
  const rawConns = d.connections;
  const connections = rawConns && typeof rawConns === 'object' && !Array.isArray(rawConns) ? rawConns : {};
  return { name: typeof d.name === 'string' ? d.name : '', nodes, connections };
}

function normalizeNode(n, usedIds) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  const { id, name, type, typeVersion, position, parameters, webhookId, ...rest } = n;
  const pos = Array.isArray(position) && position.length >= 2 ? [Number(position[0]) || 0, Number(position[1]) || 0] : [0, 0];
  let nextId = typeof id === 'string' && id ? id : uid();
  if (usedIds && usedIds.has(nextId)) nextId = uid();
  usedIds?.add(nextId);
  return {
    // Pass through anything we don't model (credentials, disabled, notes,
    // retryOnFail, …) so an editor save never silently strips node config.
    ...rest,
    id: nextId,
    name: typeof name === 'string' && name ? name : 'Node',
    type: typeof type === 'string' && type ? type : 'n8n-nodes-base.noOp',
    typeVersion: typeof typeVersion === 'number' ? typeVersion : 1,
    position: pos,
    parameters: parameters && typeof parameters === 'object' ? parameters : {},
    ...(typeof webhookId === 'string' ? { webhookId } : {}),
  };
}

function cloneJson(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

function flowEdgesOf(connections) {
  const out = [];
  for (const [from, groups] of Object.entries(connections || {})) {
    const mains = groups && typeof groups === 'object' && Array.isArray(groups.main) ? groups.main : [];
    mains.forEach((branch, bi) => {
      for (const e of Array.isArray(branch) ? branch : []) {
        if (e && typeof e.node === 'string' && !isAuxEdge(e)) out.push({ from, to: e.node, branch: bi, edge: e });
      }
    });
  }
  return out;
}

function outgoingFlatLocal(from, connections) {
  const g = connections?.[from];
  const main = g?.main;
  if (!Array.isArray(main)) return [];
  const out = [];
  for (const branch of main) {
    if (!Array.isArray(branch)) continue;
    for (const e of branch) {
      if (e && typeof e.node === 'string' && !isAuxEdge(e)) out.push(e.node);
    }
  }
  return out;
}

/** Cycle detection over the *execution* graph (tool/model sockets ignored). */
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

/** Source nodes wired into an auxiliary port (tools/model). */
export function auxSourceNames(connections) {
  const out = new Set();
  for (const [from, groups] of Object.entries(connections || {})) {
    const mains = groups && typeof groups === 'object' && Array.isArray(groups.main) ? groups.main : [];
    for (const branch of mains) {
      for (const e of Array.isArray(branch) ? branch : []) {
        if (e && typeof e.node === 'string' && isAuxEdge(e)) out.add(from);
      }
    }
  }
  return out;
}

/** Tool edges pointing at an agent: [{ from, to }]. */
export function toolEdgesForAgent(connections, agentName) {
  const out = [];
  for (const [from, groups] of Object.entries(connections || {})) {
    const mains = groups && typeof groups === 'object' && Array.isArray(groups.main) ? groups.main : [];
    for (const branch of mains) {
      for (const e of Array.isArray(branch) ? branch : []) {
        if (e && e.node === agentName && edgeTargetPort(e) === 'tools') out.push({ from, to: agentName });
      }
    }
  }
  return out;
}

export function modelEdgeForAgent(connections, agentName) {
  for (const [from, groups] of Object.entries(connections || {})) {
    const mains = groups && typeof groups === 'object' && Array.isArray(groups.main) ? groups.main : [];
    for (const branch of mains) {
      for (const e of Array.isArray(branch) ? branch : []) {
        if (e && e.node === agentName && edgeTargetPort(e) === 'model') return { from, to: agentName };
      }
    }
  }
  return null;
}

/** Structural validation before save (server re-validates SSRF + size).
 *  Messages are synced with workflow-service validateDefinition for the
 *  structural subset (duplicate / self-loop / dangling / cycle / branches). */
export function validateGraph(nodes, connections, opts = {}) {
  if (!Array.isArray(nodes)) return 'nodes must be an array';
  if (nodes.length > 50) return 'too many nodes (max 50)';
  const names = new Set();
  const byName = new Map();
  for (const n of nodes) {
    if (!n || typeof n !== 'object') return 'every node must be an object';
    if (typeof n.name !== 'string' || !n.name) return 'every node needs a name';
    if (names.has(n.name)) return `duplicate node name '${n.name}'`;
    names.add(n.name);
    byName.set(n.name, n);
    if (typeof n.type !== 'string' || !n.type) return `node '${n.name}' needs a type`;
    if (!Array.isArray(n.position) || n.position.length < 2) return `node '${n.name}' needs position [x, y]`;
  }
  if (connections !== undefined && (typeof connections !== 'object' || connections === null || Array.isArray(connections))) {
    return 'connections must be an object';
  }
  const auxSources = auxSourceNames(connections || {});
  const flowTouched = new Set();
  const modelTargets = new Map();
  for (const [from, groups] of Object.entries(connections || {})) {
    if (!names.has(from)) return `connection from unknown node '${from}'`;
    const mains = groups && typeof groups === 'object' ? groups.main : undefined;
    if (mains !== undefined && !Array.isArray(mains)) return `connections['${from}'].main must be an array`;
    (mains || []).forEach((branch, bi) => {
      for (const edge of Array.isArray(branch) ? branch : []) {
        if (!edge || typeof edge !== 'object' || !names.has(edge.node)) {
          return; // reported below
        }
        if (edge.node === from) return; // reported below
        const port = edgeTargetPort(edge);
        if (port && !isAiAgentType(byName.get(edge.node)?.type)) {
          return; // reported below
        }
        if (!port) {
          flowTouched.add(from);
          flowTouched.add(edge.node);
        }
      }
    });
  }
  for (const [from, groups] of Object.entries(connections || {})) {
    const mains = groups && typeof groups === 'object' ? groups.main : [];
    for (let bi = 0; bi < (mains || []).length; bi++) {
      const branch = Array.isArray(mains[bi]) ? mains[bi] : [];
      for (const edge of branch) {
        if (!edge || typeof edge !== 'object' || !names.has(edge.node)) {
          return `connection from '${from}' points at unknown node '${edge && edge.node}'`;
        }
        if (edge.node === from) return `self-loop on '${from}' is not allowed`;
        const port = edgeTargetPort(edge);
        if (port && !isAiAgentType(byName.get(edge.node)?.type)) {
          return `'${from}' -> '${edge.node}': ${port} socket can only target an AI Agent`;
        }
        if (port === 'tools' && isAiAgentType(byName.get(from)?.type) && from === edge.node) {
          return `agent '${from}' cannot use itself as a tool`;
        }
        if (port === 'model') {
          if (!isModelType(byName.get(from)?.type)) {
            return `'${from}' -> '${edge.node}': Model socket needs a Model Core source`;
          }
          modelTargets.set(edge.node, (modelTargets.get(edge.node) || 0) + 1);
        }
        if (!port) {
          const src = byName.get(from);
          if (isIfType(src?.type) && bi > 1) return `if node '${from}' has only true/false outputs (branch ${bi} is invalid)`;
          if (isDecisionType(src?.type)) {
            const routes = decisionRoutes(src?.parameters || {});
            if (bi >= routes.length) return `decision node '${from}' has ${routes.length} route(s) but an edge is on branch ${bi}`;
          }
        }
      }
    }
  }
  for (const [agent, count] of modelTargets) {
    if (count > 1) return `AI Agent '${agent}' has more than one model source connected`;
  }
  const cyc = detectCycle(nodes, connections || {});
  if (cyc) return cyc;
  // Dangling nodes: every node must either be wired into the execution graph
  // or be a tool/model source for an agent (configuration-only node).
  if (nodes.length > 1) {
    for (const n of nodes) {
      if (!flowTouched.has(n.name) && !auxSources.has(n.name)) return `dangling node '${n.name}' has no connections`;
    }
  }
  // Decision configuration sanity.
  for (const n of nodes) {
    if (!isDecisionType(n.type)) continue;
    const routes = decisionRoutes(n.parameters || {});
    if (!routes.length) return `decision node '${n.name}' needs at least one route`;
    if (routes.length > 20) return `decision node '${n.name}' supports at most 20 routes`;
    const names = routes.map((r) => r.name);
    if (new Set(names).size !== names.length) return `decision node '${n.name}': route names must be unique`;
    const fb = Number(n.parameters?.fallbackBranch);
    if (Number.isFinite(fb) && (fb < 0 || fb >= routes.length)) {
      return `decision node '${n.name}': fallbackBranch ${fb} is outside 0..${routes.length - 1}`;
    }
  }
  if (opts.requireTrigger === true && nodes.length > 0) {
    if (!nodes.some((n) => isTriggerType(n.type))) {
      return 'add a trigger node (Webhook, Schedule or Manual) — a workflow without a trigger cannot run';
    }
  }
  return null;
}

function pruneEmpty(out) {
  for (const [from, groups] of Object.entries(out)) {
    if (!groups || typeof groups !== 'object') continue;
    const mains = Array.isArray(groups.main) ? groups.main.filter((b) => Array.isArray(b) && b.length > 0) : undefined;
    if (mains) {
      if (mains.length) groups.main = mains;
      else delete groups.main;
    }
    if (!Object.keys(groups).length) delete out[from];
  }
  return out;
}

function cloneConnections(connections) {
  const out = {};
  for (const [from, groups] of Object.entries(connections || {})) {
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue;
    const next = {};
    for (const [group, value] of Object.entries(groups)) {
      if (Array.isArray(value)) {
        next[group] = value.map((branch) =>
          Array.isArray(branch) ? branch.filter((e) => e && typeof e === 'object').map((e) => ({ ...e })) : [],
        );
      } else {
        next[group] = cloneJson(value);
      }
    }
    out[from] = next;
  }
  return out;
}

/** Would adding fromName -> toName create a cycle? Tool/model edges never do. */
export function wouldCycle(nodes, connections, fromName, toName, opts = {}) {
  if (!fromName || !toName) return false;
  if (fromName === toName) return true;
  if (opts.targetPort) return false; // auxiliary sockets are not execution edges
  const names = new Set((nodes || []).map((n) => n.name));
  if (!names.has(fromName) || !names.has(toName)) return false;
  const trial = cloneConnections(connections);
  const mains = (trial[fromName] && trial[fromName].main) || [];
  const exists = mains.some((branch) => branch.some((e) => e.node === toName && !isAuxEdge(e)));
  if (!exists) {
    mains.push([{ node: toName, type: 'main', index: 0 }]);
    trial[fromName] = { ...(trial[fromName] || {}), main: mains };
  }
  return detectCycle(nodes, trial) !== null;
}

export const IF_TYPE = 'n8n-nodes-base.if';
export function isIfType(t) {
  return t === 'if' || t === 'n8n-nodes-base.if' || t === IF_TYPE || t === 'synapsedx.if';
}
export function isDecisionType(t) {
  return (
    t === 'decision' ||
    t === 'decision.route' ||
    t === 'synapseflow.decision' ||
    t === 'synapsedx.decision' ||
    t === 'n8n-nodes-base.decision'
  );
}
export function isAiAgentType(t) {
  return (
    t === 'ai.agent' ||
    t === 'synapseflow.aiAgent' ||
    t === 'synapsedx.aiAgent' ||
    t === 'agent' ||
    t === 'n8n-nodes-base.aiAgent'
  );
}
export function isModelType(t) {
  return t === 'synapseflow.model' || t === 'synapsedx.model';
}
export function isBranchingType(t) {
  return isIfType(t) || isDecisionType(t);
}
export function isWebhookType(t) {
  return t === 'webhook' || t === 'n8n-nodes-base.webhook' || t === 'synapsedx.webhook';
}
export function isCronType(t) {
  return t === 'cron' || t === 'n8n-nodes-base.cron' || t === 'synapsedx.cron';
}
export function isManualType(t) {
  return t === 'manualTrigger' || t === 'n8n-nodes-base.manualTrigger' || t === 'synapsedx.manualTrigger';
}
export function isTriggerType(t) {
  return isWebhookType(t) || isCronType(t) || isManualType(t);
}
export function isCodeType(t) {
  return t === 'code' || t === 'n8n-nodes-base.code' || t === 'synapsedx.code';
}
export function isHttpType(t) {
  return t === 'httpRequest' || t === 'n8n-nodes-base.httpRequest' || t === 'synapsedx.httpRequest';
}
export function isSetType(t) {
  return t === 'set' || t === 'n8n-nodes-base.set' || t === 'synapsedx.set';
}
export function isNoOpType(t) {
  return t === 'noOp' || t === 'n8n-nodes-base.noOp' || t === 'synapsedx.noOp';
}
export function isIntegrationType(t) {
  return INTEGRATION_SERVICES[t] !== undefined || t === 'synapsedx.api';
}
/** Branch index contract for If nodes: main[0] = true, main[1] = false. */
export const IF_BRANCH_TRUE = 0;
export const IF_BRANCH_FALSE = 1;
export function ifBranchLabel(i) {
  return i === 0 ? 'true' : i === 1 ? 'false' : `out ${i}`;
}

/** Stable route list for a Decision node. Supports array choices/routes and
 *  object maps (object values are human descriptions for the SLM). */
export function decisionRoutes(params) {
  const p = params && typeof params === 'object' ? params : {};
  const take = (value) => {
    if (Array.isArray(value)) {
      return value
        .map((v) => (v && typeof v === 'object' ? { name: String(v.name ?? v.route ?? v.value ?? ''), description: String(v.description ?? v.desc ?? '') } : { name: String(v ?? ''), description: '' }))
        .filter((r) => r.name);
    }
    if (value && typeof value === 'object') {
      return Object.entries(value)
        .map(([name, description]) => ({ name, description: String(description ?? '') }))
        .filter((r) => r.name);
    }
    return [];
  };
  let routes = take(p.choices);
  if (!routes.length) routes = take(p.routes);
  return routes.length ? routes : [
    { name: 'route_0', description: '' },
    { name: 'route_1', description: '' },
  ];
}

/** Add an edge. Edge identity is (from, to, branch slot, target port):
 *  - IF/Decision sources must pass { branch } so slots stay positional.
 *  - Tool/model sockets must pass { targetPort: 'tools'|'model' }.
 *  No-op when the exact edge already exists. */
export function connect(connections, fromName, toName, opts) {
  if (!fromName || !toName || fromName === toName) return cloneConnections(connections);
  const branch = opts && typeof opts.branch === 'number' ? opts.branch : undefined;
  const targetPort = opts && typeof opts.targetPort === 'string' ? opts.targetPort : undefined;
  const out = cloneConnections(connections);
  const groups = out[fromName] && typeof out[fromName] === 'object' ? out[fromName] : {};
  const mains = Array.isArray(groups.main) ? groups.main : [];
  const sameEdge = (e) => e && e.node === toName && (edgeTargetPort(e) || undefined) === (targetPort || undefined);
  const exists = branch !== undefined
    ? (mains[branch] || []).some(sameEdge)
    : mains.some((b) => Array.isArray(b) && b.some(sameEdge));
  if (exists) {
    if (mains.length) out[fromName] = { ...groups, main: mains };
    return out;
  }
  const edgeObj = { node: toName, type: targetPort || 'main', index: 0, ...(targetPort ? { targetPort } : {}) };
  if (branch !== undefined) {
    const idx = Math.max(0, branch);
    while (mains.length <= idx) mains.push([]);
    mains[idx] = [...mains[idx], edgeObj];
  } else if (mains.length) {
    // Non-branching sources fan out from their single main output.
    mains[0] = [...mains[0], edgeObj];
  } else {
    mains.push([edgeObj]);
  }
  out[fromName] = { ...groups, main: mains };
  return out;
}

/** Remove an edge.
 *  - { branch } removes only that slot (IF/Decision keep their slot layout).
 *  - { targetPort } removes only that socket edge.
 *  - Without targetPort: removes flow edges only (never tool/model sockets).
 *  Branching sources keep empty slots when { preserveSlots: true } so routes
 *  never shift silently. */
export function disconnect(connections, fromName, toName, opts) {
  const branch = opts && typeof opts.branch === 'number' ? opts.branch : undefined;
  const targetPort = opts && typeof opts.targetPort === 'string' ? opts.targetPort : undefined;
  const preserve = !!(opts && opts.preserveSlots);
  const out = cloneConnections(connections);
  if (!out[fromName]) return out;
  const mains = (out[fromName].main || []).map((b) => (Array.isArray(b) ? b : []));
  // Flow-edge removal must never silently remove a tool/model socket edge
  // that happens to share the same source and target.
  const matches = (e) => e && e.node === toName && (targetPort ? edgeTargetPort(e) === targetPort : !edgeTargetPort(e));
  let next;
  if (branch !== undefined) {
    next = mains.map((b, i) => (i === branch ? b.filter((e) => !matches(e)) : b));
  } else {
    next = mains.map((b) => b.filter((e) => !matches(e)));
  }
  const kept = preserve ? next : next.filter((b) => b.length > 0);
  if (kept.some((b) => b.length > 0)) out[fromName] = { ...out[fromName], main: kept };
  else delete out[fromName];
  if (out[fromName] && !Object.keys(out[fromName]).length) delete out[fromName];
  return out;
}

/** Remove a node by name + every edge touching it (flow and auxiliary).
 *  Branch slots of surviving branching sources are preserved. */
export function removeNode(nodes, connections, name) {
  const byName = new Map((nodes || []).map((n) => [n.name, n]));
  const kept = nodes.filter((n) => n.name !== name);
  const out = cloneConnections(connections);
  delete out[name];
  for (const from of Object.keys(out)) {
    const preserve = isBranchingType(byName.get(from)?.type);
    const groups = out[from];
    for (const [group, value] of Object.entries(groups)) {
      if (!Array.isArray(value)) continue;
      const mains = value.map((branch) => (Array.isArray(branch) ? branch.filter((e) => e.node !== name) : []));
      const keptBranches = preserve ? mains : mains.filter((b) => b.length > 0);
      if (keptBranches.some((b) => b.length > 0)) groups[group] = keptBranches;
      else delete groups[group];
    }
    if (!Object.keys(groups).length) delete out[from];
  }
  return { nodes: kept, connections: out };
}

/** Rename a node + rewrite every connection reference (all groups). Throws on collision. */
export function renameNode(nodes, connections, from, to) {
  if (!to || from === to) return { nodes, connections };
  if (!nodes.some((n) => n.name === from)) return { nodes, connections };
  if (nodes.some((n) => n.name === to)) throw new Error(`duplicate node name '${to}'`);
  const nextNodes = nodes.map((n) => (n.name === from ? { ...n, name: to } : n));
  const out = {};
  for (const [key, groups] of Object.entries(cloneConnections(connections))) {
    const nextGroups = {};
    for (const [group, value] of Object.entries(groups)) {
      if (Array.isArray(value)) {
        nextGroups[group] = value.map((branch) =>
          branch.map((e) => (e.node === from ? { ...e, node: to } : e)),
        );
      } else {
        nextGroups[group] = value;
      }
    }
    out[key === from ? to : key] = nextGroups;
  }
  return { nodes: nextNodes, connections: out };
}

/** Flat edge list for rendering (aux edges included): [{ from, to }]. */
export function listEdges(connections) {
  return listEdgesWithBranches(connections).map(({ from, to }) => ({ from, to }));
}

/** Edge list with branch slots + auxiliary port: [{ from, to, branch, targetPort? }]. */
export function listEdgesWithBranches(connections) {
  const edges = [];
  for (const [from, groups] of Object.entries(connections || {})) {
    const mains = (groups && groups.main) || [];
    mains.forEach((branch, bi) => {
      for (const e of Array.isArray(branch) ? branch : []) {
        if (e && typeof e.node === 'string') {
          const tp = edgeTargetPort(e);
          edges.push({
            from,
            to: e.node,
            branch: bi,
            ...(tp ? { targetPort: tp } : {}),
          });
        }
      }
    });
  }
  return edges;
}

/** Non-blocking warnings for branch nodes (missing/unwired routes). */
export function ifWarnings(nodes, connections) {
  const out = [];
  const byName = new Map((nodes || []).map((n) => [n.name, n]));
  for (const [from, groups] of Object.entries(connections || {})) {
    if (!isIfType(byName.get(from)?.type)) continue;
    const mains = Array.isArray(groups?.main) ? groups.main : [];
    const hasTrue = (mains[0] || []).some((e) => e && typeof e.node === 'string' && !isAuxEdge(e));
    const hasFalse = (mains[1] || []).some((e) => e && typeof e.node === 'string' && !isAuxEdge(e));
    if (!hasTrue || !hasFalse) {
      const missing = [!hasTrue && 'true', !hasFalse && 'false'].filter(Boolean).join(' + ');
      out.push(`If node '${from}' has no ${missing} branch — runs down that side stop at '${from}'`);
    }
  }
  for (const n of nodes || []) {
    if (isIfType(n?.type) && !connections?.[n.name]) {
      out.push(`If node '${n.name}' has no branches wired — both sides stop at '${n.name}'`);
    }
  }
  return out;
}

export function decisionWarnings(nodes, connections) {
  const out = [];
  for (const n of nodes || []) {
    if (!isDecisionType(n?.type)) continue;
    const routes = decisionRoutes(n.parameters || {});
    const mains = Array.isArray(connections?.[n.name]?.main) ? connections[n.name].main : [];
    routes.forEach((r, i) => {
      if (!(mains[i] || []).some((e) => e && typeof e.node === 'string' && !isAuxEdge(e))) {
        out.push(`Decision '${n.name}': route ${i} “${r.name}” is not wired — it stops this run`);
      }
    });
    const fb = Number(n.parameters?.fallbackBranch);
    if (Number.isFinite(fb) && (fb < 0 || fb >= routes.length)) {
      out.push(`Decision '${n.name}': fallback branch ${fb} is outside 0..${routes.length - 1}`);
    }
  }
  return out;
}

export function graphWarnings(nodes, connections) {
  return [...ifWarnings(nodes, connections), ...decisionWarnings(nodes, connections)];
}

/** True when the type is one the local engine + palette know about. */
export function isKnownType(type) {
  if (NODE_TYPES.some((t) => t.type === type)) return true;
  return [
    'webhook', 'cron', 'manualTrigger', 'httpRequest', 'code', 'set', 'if', 'noOp', 'synapsedx.api',
    'decision', 'decision.route', 'synapseflow.decision', 'synapsedx.decision', 'n8n-nodes-base.decision',
    'ai.agent', 'synapseflow.aiAgent', 'synapsedx.aiAgent', 'agent', 'n8n-nodes-base.aiAgent',
    'synapseflow.model', 'synapsedx.model',
  ].includes(type);
}

/** Icon name mapping for UI canvas badges and palette icons. */
export const NODE_ICON_MAP = {
  'n8n-nodes-base.webhook': 'bolt',
  webhook: 'bolt',
  'n8n-nodes-base.cron': 'clock',
  cron: 'clock',
  'n8n-nodes-base.manualTrigger': 'play',
  manualTrigger: 'play',
  'n8n-nodes-base.httpRequest': 'globe',
  httpRequest: 'globe',
  'n8n-nodes-base.code': 'code',
  code: 'code',
  'n8n-nodes-base.set': 'sliders',
  set: 'sliders',
  'n8n-nodes-base.if': 'code-branch',
  if: 'code-branch',
  'synapsedx.api': 'cube',
  'synapseflow.aiAgent': 'robot',
  'ai.agent': 'robot',
  'synapseflow.decision': 'brain',
  decision: 'brain',
  'synapseflow.model': 'microchip',
  'synapsedx.iam': 'shield',
  'synapsedx.base': 'database',
  'synapsedx.faststore': 'bolt',
  'synapsedx.queue': 'inbox',
  'synapsedx.lds': 'diagram-project',
  'synapsedx.inference': 'microchip',
  'synapsedx.flow': 'diagram-project',
  'n8n-nodes-base.noOp': 'circle-dot',
  noOp: 'circle-dot',
};

/** First-party service nodes are split per service (palette + engine). */
export const INTEGRATION_SERVICES = {
  'synapsedx.iam': 'IAM',
  'synapsedx.base': 'Base',
  'synapsedx.faststore': 'Faststore',
  'synapsedx.queue': 'Queue',
  'synapsedx.lds': 'LDS',
  'synapsedx.inference': 'Inference',
  'synapsedx.flow': 'Flow',
};

/** Curated local-engine node types for the palette (free-form type still allowed). */
export const NODE_TYPES = [
  { type: 'n8n-nodes-base.webhook', label: 'Webhook', hint: 'Trigger via HTTP request — starts the run with the body', category: 'triggers', placeholder: 'Receives {"hello":"world"} → passes it downstream' },
  { type: 'n8n-nodes-base.cron', label: 'Schedule', hint: 'Trigger on a timer — fires with {scheduledAt}', category: 'triggers', placeholder: 'Every 24h → fetches and transforms' },
  { type: 'n8n-nodes-base.manualTrigger', label: 'Manual', hint: 'Trigger by hand — run from Console with any JSON input', category: 'triggers', placeholder: 'Click Execute with {"value": 21}' },
  { type: 'synapseflow.aiAgent', label: 'AI Agent', hint: 'Autonomous agent with built-in tools + any workflow node wired into its Tools socket', category: 'ai', placeholder: 'Prompt: "Triage this ticket using the knowledge base"' },
  { type: 'synapseflow.decision', label: 'Decision Engine', hint: 'Multi-route classification with Decision-2.0-Eos-0.8B — one output port per route', category: 'ai', placeholder: 'Routes: billing / technical / account / sales' },
  { type: 'synapseflow.model', label: 'Model Core', hint: 'Model provider config for an AI Agent — wire into its Model socket', category: 'ai', placeholder: 'Synapse Inference · liquid/lfm-2.5-2.6b:free' },
  { type: 'n8n-nodes-base.httpRequest', label: 'HTTP Request', hint: 'Call a public API — GET/POST with headers + JSON body', category: 'actions', placeholder: 'GET https://api.example.com/health' },
  { type: 'n8n-nodes-base.code', label: 'Code', hint: 'Run sandboxed JavaScript — $input in, return value out', category: 'actions', placeholder: 'return { doubled: ($input.value ?? 0) * 2 }' },
  { type: 'n8n-nodes-base.set', label: 'Set Fields', hint: 'Add/overwrite fields — supports {{ $json.x }} templating', category: 'actions', placeholder: 'Set tag = processed, keep the rest' },
  { type: 'n8n-nodes-base.if', label: 'If / Branch', hint: 'Two outputs — true (top) and false (bottom)', category: 'logic', placeholder: '$input.value > 10 → Big / Small' },
  { type: 'synapsedx.iam', label: 'Synapse IAM', hint: 'Identity & authorization: orgs, users, roles, policies, permissions, audit', category: 'integrations', placeholder: 'authorize.check for user + action' },
  { type: 'synapsedx.base', label: 'SynapseBase', hint: 'JSON document store: query, insert, fetch and delete documents', category: 'integrations', placeholder: 'Query support_kb where category = billing' },
  { type: 'synapsedx.faststore', label: 'Faststore', hint: 'Ultra-fast cache/KV: get, set with TTL, counters, hashes', category: 'integrations', placeholder: 'GET session:42 or SET with 1h TTL' },
  { type: 'synapsedx.queue', label: 'SynapseQueue', hint: 'Reliable message queue: publish, consume, ack', category: 'integrations', placeholder: 'Publish ticket.escalated to support-jobs' },
  { type: 'synapsedx.lds', label: 'SynapseLDS', hint: 'Linked Data Store (NGSI-LD): datasources, records, entities', category: 'integrations', placeholder: 'Publish a smart-city observation' },
  { type: 'synapsedx.inference', label: 'Synapse Inference', hint: 'LLM chat, embeddings, decision evaluation and semantic routing', category: 'integrations', placeholder: 'Route a query or generate an embedding' },
  { type: 'synapsedx.flow', label: 'SynapseFlow', hint: 'Workflows & execution history — list, inspect or run another workflow', category: 'integrations', placeholder: 'Run workflow "enrichment" with this payload' },
  { type: 'n8n-nodes-base.noOp', label: 'NoOp', hint: 'Do nothing — passes input through (useful log point)', category: 'utils', placeholder: 'Passthrough for debugging' },
];

/** Palette groups in display order. */
export const NODE_CATEGORIES = [
  { id: 'triggers', label: 'Triggers', blurb: 'How a run starts (pick one)' },
  { id: 'ai', label: 'AI & Agents', blurb: 'Agents, decision routing and model cores' },
  { id: 'actions', label: 'Actions', blurb: 'Do work: fetch, transform, set fields' },
  { id: 'logic', label: 'Logic', blurb: 'Branch the flow' },
  { id: 'integrations', label: 'SynapseDX Services', blurb: 'First-party services (run as you)' },
  { id: 'utils', label: 'Utils', blurb: 'Helpers' },
];

export function nodesByCategory() {
  return NODE_CATEGORIES.map((c) => ({ ...c, items: NODE_TYPES.filter((t) => t.category === c.id) }));
}

/** Known-good typeVersions (local engine contract). */
const TYPE_VERSIONS = {
  webhook: 2,
  'n8n-nodes-base.webhook': 2,
  cron: 1,
  'n8n-nodes-base.cron': 1,
  manualTrigger: 1,
  'n8n-nodes-base.manualTrigger': 1,
  httpRequest: 4.2,
  'n8n-nodes-base.httpRequest': 4.2,
  code: 1,
  'n8n-nodes-base.code': 1,
  set: 1,
  'n8n-nodes-base.set': 1,
  if: 1,
  'n8n-nodes-base.if': 1,
  'synapsedx.api': 1,
  'synapseflow.aiAgent': 1,
  'ai.agent': 1,
  'synapseflow.decision': 1,
  decision: 1,
  'synapseflow.model': 1,
  'synapsedx.model': 1,
  'synapsedx.iam': 1,
  'synapsedx.base': 1,
  'synapsedx.faststore': 1,
  'synapsedx.queue': 1,
  'synapsedx.lds': 1,
  'synapsedx.inference': 1,
  'synapsedx.flow': 1,
  noOp: 1,
  'n8n-nodes-base.noOp': 1,
};

/** Built-in AI Agent tools. Keep in sync with workflow-service TOOL ids. */
export const AGENT_TOOLS = [
  { id: 'synapsebase_query', label: 'SynapseBase', group: 'Data', icon: '🗄️', desc: 'Query, get, create or delete documents in SynapseBase' },
  { id: 'faststore_cache', label: 'Faststore Cache', group: 'Data', icon: '⚡', desc: 'Get/set/incr/delete cache values, hashes and TTLs' },
  { id: 'code_sandbox', label: 'JS Sandbox', group: 'Logic', icon: '💻', desc: 'Execute dynamic JavaScript calculations in an isolated sandbox' },
  { id: 'logic_calculator', label: 'Calculator', group: 'Logic', icon: '🔢', desc: 'Evaluate arithmetic expressions safely' },
  { id: 'decision_eval', label: 'Decision Engine', group: 'AI', icon: '🧠', desc: 'Classify intent / choose a route with Decision-2.0-Eos-0.8B' },
  { id: 'inference_chat', label: 'Inference Chat', group: 'AI', icon: '✨', desc: 'Ask the Synapse inference LLM a focused sub-question' },
  { id: 'queue_publish', label: 'SynapseQueue', group: 'Services', icon: '📬', desc: 'Publish, list, consume or ack queue messages' },
  { id: 'iam_check_permission', label: 'IAM Check', group: 'Services', icon: '🛡️', desc: 'Verify whether a user may perform an action on a resource' },
  { id: 'workflow_run', label: 'Run Workflow', group: 'Flow', icon: '🚀', desc: 'Execute another SynapseFlow workflow and use its output' },
  { id: 'workflow_list', label: 'List Workflows', group: 'Flow', icon: '📋', desc: 'Discover workflows available to this run' },
  { id: 'lds_publish', label: 'SynapseLDS', group: 'Services', icon: '🌐', desc: 'List datasources, publish records or get entities' },
  { id: 'http_request', label: 'HTTP Request', group: 'Network', icon: '🔗', desc: 'Call an allowlisted public REST endpoint (SSRF guarded)' },
];
export const DEFAULT_AGENT_TOOLS = [
  'synapsebase_query', 'faststore_cache', 'code_sandbox', 'logic_calculator',
  'decision_eval', 'queue_publish', 'iam_check_permission', 'http_request',
];
export const KNOWN_AGENT_TOOL_IDS = new Set(AGENT_TOOLS.map((t) => t.id));

/** Verified example parameters (local engine contract) — one click to start
 *  from something that actually executes. Every palette type has an entry. */
export const EXAMPLE_PARAMS = {
  webhook: { path: 'my-hook', httpMethod: 'POST' },
  'n8n-nodes-base.webhook': { path: 'my-hook', httpMethod: 'POST' },
  cron: { rule: { interval: [{ field: 'hours', hoursInterval: 24 }] } },
  'n8n-nodes-base.cron': { rule: { interval: [{ field: 'hours', hoursInterval: 24 }] } },
  manualTrigger: {},
  'n8n-nodes-base.manualTrigger': {},
  httpRequest: { url: 'https://api.example.com/health', method: 'GET' },
  'n8n-nodes-base.httpRequest': { url: 'https://api.example.com/health', method: 'GET' },
  code: { code: 'return { ...$input, doubled: ($input.value ?? 0) * 2, at: $now };' },
  'n8n-nodes-base.code': { code: 'return { ...$input, doubled: ($input.value ?? 0) * 2, at: $now };' },
  if: { condition: '$input.value > 10' },
  'n8n-nodes-base.if': { condition: '$input.value > 10' },
  'synapseflow.decision': {
    input: '={{ $json.query || $json.text || $json.message }}',
    choices: {
      billing: 'billing, invoices, refunds, payments',
      technical: 'bugs, errors, API, outages, technical problems',
      account: 'login, password, profile, permissions',
      sales: 'pricing, plans, purchase, upgrade',
    },
    instruction: 'Route the request to the team best equipped to handle it.',
    fallbackBranch: 3,
    minConfidence: 0.35,
  },
  decision: {
    input: '={{ $json.query || $json.text || $json.message }}',
    choices: {
      billing: 'billing, invoices, refunds, payments',
      technical: 'bugs, errors, API, outages, technical problems',
      account: 'login, password, profile, permissions',
      sales: 'pricing, plans, purchase, upgrade',
    },
    instruction: 'Route the request to the team best equipped to handle it.',
    fallbackBranch: 3,
    minConfidence: 0.35,
  },
  'synapseflow.aiAgent': {
    core: 'synapse-inference',
    model: 'liquid/lfm-2.5-2.6b:free',
    systemPrompt: 'You are an autonomous AI Agent in SynapseFlow. Use the available tools to retrieve data or take actions, then answer concisely and accurately.',
    userPrompt: '={{ $json.query || $json.message || "Analyze the input and execute the next steps" }}',
    tools: [...DEFAULT_AGENT_TOOLS],
    maxSteps: 6,
    temperature: 0.2,
  },
  'ai.agent': {
    core: 'synapse-inference',
    model: 'liquid/lfm-2.5-2.6b:free',
    systemPrompt: 'You are an autonomous AI Agent in SynapseFlow. Use the available tools to retrieve data or take actions, then answer concisely and accurately.',
    userPrompt: '={{ $json.query || $json.message || "Analyze the input and execute the next steps" }}',
    tools: [...DEFAULT_AGENT_TOOLS],
    maxSteps: 6,
    temperature: 0.2,
  },
  'synapseflow.model': { core: 'synapse-inference', model: 'liquid/lfm-2.5-2.6b:free' },
  'synapsedx.model': { core: 'synapse-inference', model: 'liquid/lfm-2.5-2.6b:free' },
  'synapsedx.api': { resource: 'orgs', operation: 'list', input: {} },
  'synapsedx.iam': { operation: 'orgs.list', input: {} },
  'synapsedx.base': { operation: 'query-documents', input: { collection: 'documents', where: {}, limit: 10 } },
  'synapsedx.faststore': { operation: 'get', input: { key: 'demo-key' } },
  'synapsedx.queue': { operation: 'publish', input: { queue: 'demo-queue', payload: { hello: 'world' } } },
  'synapsedx.lds': { operation: 'list-datasources', input: {} },
  'synapsedx.inference': { operation: 'route', input: { input: '={{ $json.query }}', choices: { support: 'support question', billing: 'billing question' }, instruction: 'Pick a department' } },
  'synapsedx.flow': { operation: 'workflows.list', input: {} },
  set: { values: { tag: 'processed' } },
  'n8n-nodes-base.set': { values: { tag: 'processed' } },
  noOp: {},
  'n8n-nodes-base.noOp': {},
};

/** Sample test-run input suggested from the entry (trigger) node. */
export const SAMPLE_INPUTS = {
  webhook: { hello: 'world' },
  'n8n-nodes-base.webhook': { hello: 'world' },
  cron: { scheduledAt: '2026-01-01T00:00:00.000Z' },
  'n8n-nodes-base.cron': { scheduledAt: '2026-01-01T00:00:00.000Z' },
  manualTrigger: { value: 21 },
  'n8n-nodes-base.manualTrigger': { value: 21 },
  default: { value: 21 },
};

/** Minimal GitHub push payload (ref/repository/pusher/commits). */
export const GITHUB_PUSH_SAMPLE = {
  ref: 'refs/heads/main',
  repository: { full_name: 'acme/demo' },
  pusher: { name: 'dev' },
  commits: [{ id: 'abc123', message: 'fix: typo' }, { id: 'def456', message: 'feat: api' }],
};

export function sampleInputFor(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const trig = list.find((n) => n && typeof n.type === 'string' && /webhook|cron|manualTrigger/.test(n.type));
  if (isWebhookType(trig?.type) && String(trig.parameters?.path || '').includes('github')) {
    return { ...GITHUB_PUSH_SAMPLE };
  }
  const t = trig?.type || '';
  if (SAMPLE_INPUTS[t]) return { ...SAMPLE_INPUTS[t] };
  return { ...SAMPLE_INPUTS.default };
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
  if (isWebhookType(type)) node.webhookId = uid();
  return node;
}

/** Unique display name (Node, Node 2, …) within the canvas. */
export function uniqueName(nodes, base) {
  const taken = new Set((nodes || []).map((n) => n.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

/** First webhook trigger path declared by a node list (for URL display). */
export function webhookPathOf(nodes) {
  for (const n of nodes || []) {
    if (!isWebhookType(n?.type)) continue;
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
