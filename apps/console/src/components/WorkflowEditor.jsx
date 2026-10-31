/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faPlus,
  faXmark,
  faMagnifyingGlassPlus,
  faMagnifyingGlassMinus,
  faTrash,
  faUndo,
  faRedo,
  faBolt,
  faClock,
  faPlay,
  faGlobe,
  faCode,
  faSliders,
  faCodeBranch,
  faCube,
  faRobot,
  faBrain,
  faCircleDot,
  faMicrochip,
  faDatabase,
  faShieldHalved,
  faInbox,
  faDiagramProject,
  faGears,
  faArrowsUpDownLeftRight,
} from '@fortawesome/free-solid-svg-icons';
import { api } from '../lib/api.js';
import { Badge, Btn, Err } from './ui.jsx';
import CodeEditor, { CodeDocs } from './CodeEditor.jsx';
import { checkJSSyntax } from '../lib/code-highlight.js';
import {
  normalizeWorkflow,
  validateGraph,
  connect,
  disconnect,
  removeNode,
  renameNode,
  listEdgesWithBranches,
  makeNode,
  uniqueName,
  nodesByCategory,
  NODE_TYPES,
  sampleInputFor,
  describeCron,
  graphWarnings,
  isKnownType,
  wouldCycle,
  IF_TYPE,
  ifBranchLabel,
  isDecisionType,
  isIfType,
  isAiAgentType,
  isModelType,
  isIntegrationType,
  decisionRoutes,
  edgeTargetPort,
  toolEdgesForAgent,
  modelEdgeForAgent,
  AGENT_TOOLS,
  DEFAULT_AGENT_TOOLS,
  EXAMPLE_PARAMS,
} from '../lib/workflow-graph.js';

const NODE_W = 204;
const NODE_H = 72;
const AGENT_W = 260;
const AGENT_H = 154;
const MODEL_W = 212;
const MODEL_H = 70;

/** Node geometry. Decision cards grow so every route has a real output port. */
function nodeDims(n) {
  const t = n?.type;
  if (isAiAgentType(t)) return { w: AGENT_W, h: AGENT_H };
  if (isModelType(t)) return { w: MODEL_W, h: MODEL_H };
  if (isDecisionType(t)) {
    const routes = decisionRoutes(n?.parameters || {}).length;
    return { w: 238, h: 46 + routes * 26 + 8 };
  }
  return { w: NODE_W, h: NODE_H };
}

const NODE_ICONS = {
  'n8n-nodes-base.webhook': { icon: faBolt, color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200' },
  webhook: { icon: faBolt, color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200' },
  'n8n-nodes-base.cron': { icon: faClock, color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200' },
  cron: { icon: faClock, color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200' },
  'n8n-nodes-base.manualTrigger': { icon: faPlay, color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200' },
  manualTrigger: { icon: faPlay, color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200' },
  'synapseflow.aiAgent': { icon: faRobot, color: 'text-purple-600', bg: 'bg-purple-50 border-purple-200' },
  'ai.agent': { icon: faRobot, color: 'text-purple-600', bg: 'bg-purple-50 border-purple-200' },
  'synapseflow.decision': { icon: faBrain, color: 'text-indigo-600', bg: 'bg-indigo-50 border-indigo-200' },
  decision: { icon: faBrain, color: 'text-indigo-600', bg: 'bg-indigo-50 border-indigo-200' },
  'synapseflow.model': { icon: faMicrochip, color: 'text-indigo-600', bg: 'bg-indigo-50 border-indigo-200' },
  'synapseone.model': { icon: faMicrochip, color: 'text-indigo-600', bg: 'bg-indigo-50 border-indigo-200' },
  'synapseone.iam': { icon: faShieldHalved, color: 'text-rose-600', bg: 'bg-rose-50 border-rose-200' },
  'synapseone.base': { icon: faDatabase, color: 'text-cyan-700', bg: 'bg-cyan-50 border-cyan-200' },
  'synapseone.faststore': { icon: faBolt, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200' },
  'synapseone.queue': { icon: faInbox, color: 'text-orange-600', bg: 'bg-orange-50 border-orange-200' },
  'synapseone.lds': { icon: faDiagramProject, color: 'text-teal-700', bg: 'bg-teal-50 border-teal-200' },
  'synapseone.inference': { icon: faMicrochip, color: 'text-fuchsia-600', bg: 'bg-fuchsia-50 border-fuchsia-200' },
  'synapseone.flow': { icon: faGears, color: 'text-blue-600', bg: 'bg-blue-50 border-blue-200' },
  'n8n-nodes-base.httpRequest': { icon: faGlobe, color: 'text-sky-600', bg: 'bg-sky-50 border-sky-200' },
  httpRequest: { icon: faGlobe, color: 'text-sky-600', bg: 'bg-sky-50 border-sky-200' },
  'n8n-nodes-base.code': { icon: faCode, color: 'text-blue-600', bg: 'bg-blue-50 border-blue-200' },
  code: { icon: faCode, color: 'text-blue-600', bg: 'bg-blue-50 border-blue-200' },
  'n8n-nodes-base.set': { icon: faSliders, color: 'text-teal-600', bg: 'bg-teal-50 border-teal-200' },
  set: { icon: faSliders, color: 'text-teal-600', bg: 'bg-teal-50 border-teal-200' },
  'n8n-nodes-base.if': { icon: faCodeBranch, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200' },
  if: { icon: faCodeBranch, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200' },
  'synapseone.api': { icon: faCube, color: 'text-rose-600', bg: 'bg-rose-50 border-rose-200' },
  'n8n-nodes-base.noOp': { icon: faCircleDot, color: 'text-slate-500', bg: 'bg-slate-50 border-slate-200' },
  noOp: { icon: faCircleDot, color: 'text-slate-500', bg: 'bg-slate-50 border-slate-200' },
};

// Visual drag-and-drop editor for a workflow definition (our own code —
// own code, no external UI). Persists through PUT /v1/workflows/:id.
export default function WorkflowEditor({ workflowId, initial, headers, onClose, onSaved }) {
  const norm = useMemo(() => normalizeWorkflow(initial), [workflowId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [name, setName] = useState(norm.name);
  const [nodes, setNodes] = useState(norm.nodes);
  const [connections, setConnections] = useState(norm.connections);
  const [tab, setTab] = useState('visual');
  const [jsonText, setJsonText] = useState(() => JSON.stringify({ nodes: norm.nodes, connections: norm.connections }, null, 2));
  const [sel, setSel] = useState(null); // node name | { edge: { from, to } } | null
  const [pendingFrom, setPendingFrom] = useState(null);
  const [pendingBranch, setPendingBranch] = useState(null); // null | 0 (true) | 1 (false) for If sources
  const [palQuery, setPalQuery] = useState('');
  const [quickToolNode, setQuickToolNode] = useState(null);
  const clearPending = () => { setPendingFrom(null); setPendingBranch(null); setQuickToolNode(null); setWireCursor(null); wireRef.current = null; };
  const [view, setView] = useState({ x: 40, y: 40, k: 1 });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [paramsText, setParamsText] = useState('');
  const [paramsErr, setParamsErr] = useState(null);
  const [showAdvJson, setShowAdvJson] = useState(false);
  const [testInput, setTestInput] = useState('{}');
  const [testBusy, setTestBusy] = useState(false);
  const [testOut, setTestOut] = useState(null);
  const [testHist, setTestHist] = useState(() => {
    try {
      const raw = localStorage.getItem(`synapseone.testrun.${workflowId}`);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, 5) : [];
    } catch {
      return [];
    }
  });
  const [expandedRuns, setExpandedRuns] = useState({});
  const boxRef = useRef(null);
  const dragRef = useRef(null);
  const wireRef = useRef(null);
  const suppressClickRef = useRef(false);
  const [wireCursor, setWireCursor] = useState(null);
  const [dropActive, setDropActive] = useState(false);
  const [paletteDrag, setPaletteDrag] = useState(null);
  const draftKey = `synapseone.editor.${workflowId}`;
  // Autosave drafts: a session expiry mid-edit must never eat work.
  // Draft restores explicitly via banner (never silently).
  const [draft, setDraft] = useState(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || typeof d !== 'object' || !Array.isArray(d.nodes)) return null;
      if (JSON.stringify({ name: norm.name, nodes: norm.nodes, connections: norm.connections }) === JSON.stringify({ name: d.name, nodes: d.nodes, connections: d.connections })) return null;
      return { ...d, savedAt: typeof d.savedAt === 'number' ? d.savedAt : Date.now() };
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ name, nodes, connections, savedAt: Date.now() }));
    } catch {
      /* storage full/blocked — editing still works, just no draft */
    }
  }, [name, nodes, connections, draftKey]);
  const clearDraft = () => {
    try {
      localStorage.removeItem(draftKey);
    } catch { /* ignore */ }
    setDraft(null);
  };
  // Undo history (snapshots before each committed change, capped).
  const past = useRef([]);
  const future = useRef([]);
  // Bump to re-render header buttons whose enabled state reads the refs.
  const [, setHistRev] = useState(0);
  const snapshotOf = () => JSON.parse(JSON.stringify({ name, nodes, connections }));
  const checkpoint = () => {
    past.current.push(snapshotOf());
    if (past.current.length > 50) past.current.shift();
    future.current = [];
    setHistRev((v) => v + 1);
  };

  const snapshot = useMemo(
    () => JSON.stringify({ name: norm.name, nodes: norm.nodes, connections: norm.connections }),
    [norm],
  );
  const visualDirty = snapshot !== JSON.stringify({ name, nodes, connections });
  // JSON-tab edits live only in jsonText until staged — compare against what
  // the tab was last synced from so Save enables and close() warns.
  const jsonSynced = JSON.stringify({ nodes, connections }, null, 2);
  const dirty = visualDirty || (tab === 'json' && jsonText !== jsonSynced);

  const selNode = typeof sel === 'string' ? nodes.find((n) => n.name === sel) || null : null;
  const selEdge = sel && typeof sel === 'object' ? (sel.edge || sel) : null;
  const [paramsRev, setParamsRev] = useState(0);

  // Live structural validation — blocks Save with a tooltip (synced with
  // workflow-service validateDefinition: duplicate / self-loop / dangling / cycle).
  const graphErr = useMemo(() => validateGraph(nodes, connections, { requireTrigger: true }), [nodes, connections]);
  const saveBlocked = graphErr || paramsErr ? (graphErr || paramsErr) : null;

  const syncJsonTab = (ns, conns) => {
    // Don't clobber dirty JSON typing — only resync a clean tab.
    if (tab === 'json' && jsonText !== JSON.stringify({ nodes, connections }, null, 2)) return;
    setJsonText(JSON.stringify({ nodes: ns, connections: conns }, null, 2));
  };

  const undo = () => {
    // Skip phantom entries (focus-checkpoints with no actual change).
    let prev = past.current.pop();
    const cur = JSON.stringify({ name, nodes, connections });
    while (prev && JSON.stringify(prev) === cur) prev = past.current.pop();
    setHistRev((v) => v + 1);
    if (!prev) return;
    future.current.push(JSON.parse(cur));
    setName(prev.name);
    setNodes(prev.nodes);
    setConnections(prev.connections);
    setSel(null);
    setParamsRev((v) => v + 1);
    syncJsonTab(prev.nodes, prev.connections);
  };
  const redo = () => {
    const next = future.current.pop();
    setHistRev((v) => v + 1);
    if (!next) return;
    past.current.push(snapshotOf());
    setName(next.name);
    setNodes(next.nodes);
    setConnections(next.connections);
    setSel(null);
    setParamsRev((v) => v + 1);
    syncJsonTab(next.nodes, next.connections);
  };

  useEffect(() => {
    if (selNode) {
      setParamsText(JSON.stringify(selNode.parameters || {}, null, 2));
      setParamsErr(null);
      setShowAdvJson(false);
    } else {
      // Leaving a node clears its params error — it must never block a save
      // from an unrelated selection with a stale message.
      setParamsErr(null);
    }
  }, [sel, paramsRev]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      const typing = /INPUT|TEXTAREA|SELECT/.test(tag);
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        undo();
        return;
      }
      if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z' && !typing) ||
          ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing)) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === 'Escape' && !typing) {
        if (quickToolNode) setQuickToolNode(null);
        else if (pendingFrom) clearPending();
        else if (sel) setSel(null);
        else close();
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
        e.preventDefault();
        if (typeof sel === 'string') {
          const n = nodes.find((x) => x.name === sel);
          if (n && window.confirm(`Delete node "${n.name}" and all its connections?`)) {
            checkpoint();
            const r = removeNode(nodes, connections, n.name);
            setNodes(r.nodes);
            setConnections(r.connections);
            setSel(null);
          }
        } else if (selEdge) {
          checkpoint();
          const src = nodes.find((n) => n.name === selEdge.from);
          setConnections((c) => disconnect(c, selEdge.from, selEdge.to, {
            ...(typeof selEdge.branch === 'number' ? { branch: selEdge.branch } : {}),
            ...(selEdge.targetPort ? { targetPort: selEdge.targetPort } : {}),
            preserveSlots: isIfType(src?.type) || isDecisionType(src?.type),
          }));
          setSel(null);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const close = () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    clearDraft();
    onClose();
  };

  // ----- canvas interactions -----
  const toWorld = (cx, cy) => {
    const r = boxRef.current.getBoundingClientRect();
    return [(cx - r.left - view.x) / view.k, (cy - r.top - view.y) / view.k];
  };

  const onBoxPointerDown = (e) => {
    if (e.button !== 0) return;
    // Only the canvas background starts a pan. Nodes and wires stop propagation.
    if (e.target !== e.currentTarget) return;
    dragRef.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onBoxPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    const movedNow = Math.abs(dx) + Math.abs(dy) > 3;
    const startedMoving = !d.moved && movedNow;
    if (movedNow) d.moved = true;
    if (d.kind === 'pan') {
      setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    } else if (d.kind === 'node') {
      if (startedMoving) checkpoint();
      const kk = d.k || view.k;
      const nx = Math.round(d.wx + dx / kk);
      const ny = Math.round(d.wy + dy / kk);
      setNodes((ns) => ns.map((n) => (n.name === d.name ? { ...n, position: [nx, ny] } : n)));
    }
  };

  const onBoxPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.kind === 'pan' && !d.moved) {
      setSel(null);
      clearPending();
      setQuickToolNode(null);
    }
  };

  const onNodePointerDown = (e, node) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragRef.current = { kind: 'node', name: node.name, sx: e.clientX, sy: e.clientY, wx: node.position[0], wy: node.position[1], k: view.k, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onNodePointerUp = (e, node) => {
    const d = dragRef.current;
    if (d && d.kind === 'node' && !d.moved) {
      // Click a node body while a wire is pending = connect to its main input.
      if (pendingFrom && pendingFrom !== node.name) completeConnection(pendingFrom, node.name, 'in', pendingBranch);
      else {
        setSel(node.name);
        clearPending();
      }
    }
  };

  const onWheelZoom = (e) => {
    e.preventDefault();
    // Trackpad horizontal scroll / swipe is panning, not zooming (pinch sends ctrlKey).
    if (!e.ctrlKey && Math.abs(e.deltaX) >= Math.abs(e.deltaY)) {
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      return;
    }
    const r = boxRef.current.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    setView((v) => {
      const k2 = Math.min(2, Math.max(0.25, v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      const wx = (mx - v.x) / v.k;
      const wy = (my - v.y) / v.k;
      return { k: k2, x: mx - wx * k2, y: my - wy * k2 };
    });
  };

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheelZoom, { passive: false });
    return () => el.removeEventListener('wheel', onWheelZoom);
  }, []);

  // ----- graph edits -----
  const addNodeAt = (type, wx, wy) => {
    checkpoint();
    const n = makeNode(type, wx, wy);
    n.name = uniqueName(nodes, n.name);
    setNodes((ns) => [...ns, n]);
    setSel(n.name);
    setErr(null);
    return n;
  };

  const addNode = (type) => {
    if (!boxRef.current) return;
    const el = boxRef.current;
    const r = el.getBoundingClientRect();
    const dims = nodeDims({ type });
    // Cascade near the visible centre so repeated clicks never stack exactly.
    const offset = (nodes.length % 6) * 26;
    const wx = (r.width / 2 - (dims.w * view.k) / 2 - view.x) / view.k + offset;
    const wy = (r.height / 2 - (dims.h * view.k) / 2 - view.y) / view.k + offset;
    addNodeAt(type, wx, wy);
  };

  const onPaletteDragStart = (e, type) => {
    setPaletteDrag(type);
    try {
      e.dataTransfer.setData('application/x-synapseflow-node', type);
      e.dataTransfer.setData('text/plain', type);
      e.dataTransfer.effectAllowed = 'copy';
    } catch {
      /* older browsers: click still works */
    }
  };

  const onCanvasDragOver = (e) => {
    const types = e.dataTransfer?.types || [];
    const carriesNode = paletteDrag || Array.from(types).includes('application/x-synapseflow-node');
    if (!carriesNode) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropActive) setDropActive(true);
  };

  const onCanvasDrop = (e) => {
    e.preventDefault();
    setDropActive(false);
    const type = e.dataTransfer.getData('application/x-synapseflow-node') || paletteDrag;
    setPaletteDrag(null);
    if (!type) return;
    const dims = nodeDims({ type });
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    addNodeAt(type, Math.round(wx - dims.w / 2), Math.round(wy - dims.h / 2));
  };

  const beginWire = (e, node, side, branch) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    wireRef.current = {
      from: node.name,
      side,
      branch: typeof branch === 'number' ? branch : undefined,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
    };
    suppressClickRef.current = false;
  };

  const completeConnection = (fromName, targetName, targetKind, branch, selectEdge = true) => {
    const src = nodes.find((n) => n.name === fromName);
    const target = nodes.find((n) => n.name === targetName);
    if (!src || !target) return;
    if (fromName === targetName) {
      setErr(new Error('A node cannot connect to itself.'));
      return;
    }
    const targetPort = targetKind === 'tools' || targetKind === 'model' ? targetKind : undefined;
    if (targetPort && !isAiAgentType(target.type)) {
      setErr(new Error(`${targetPort === 'tools' ? 'Tools' : 'Model'} sockets only exist on AI Agents.`));
      return;
    }
    if (targetPort === 'model' && !isModelType(src.type)) {
      setErr(new Error('The Model socket needs a Model Core node as its source (synapseflow.model).'));
      return;
    }
    let branchToUse = branch;
    if (!targetPort && isIfType(src.type) && branchToUse !== 0 && branchToUse !== 1) {
      setErr(new Error(`Pick the true or false output port on '${fromName}' before wiring.`));
      return;
    }
    if (!targetPort && isDecisionType(src.type)) {
      const routes = decisionRoutes(src.parameters || {});
      if (typeof branchToUse !== 'number' || branchToUse < 0 || branchToUse >= routes.length) {
        setErr(new Error(`Pick one of the ${routes.length} route ports on '${fromName}' before wiring.`));
        return;
      }
    }
    if (wouldCycle(nodes, connections, fromName, targetName, { targetPort })) {
      setErr(new Error(`Connecting '${fromName}' → '${targetName}' would close a cycle — refused.`));
      return;
    }
    checkpoint();
    let next = connections;
    if (targetPort === 'model') {
      // A model socket accepts exactly one source; wiring a new one replaces it.
      const existing = modelEdgeForAgent(next, targetName);
      if (existing) {
        next = disconnect(next, existing.from, targetName, { targetPort: 'model' });
      }
    }
    next = connect(next, fromName, targetName, {
      ...(typeof branchToUse === 'number' ? { branch: branchToUse } : {}),
      ...(targetPort ? { targetPort } : {}),
    });
    setConnections(next);
    clearPending();
    setErr(null);
    // Wiring from inside the inspector should keep editing that agent; direct
    // canvas wiring selects the new edge so Delete/Remove acts on it.
    if (selectEdge) {
      setSel({ edge: { from: fromName, to: targetName, branch: branchToUse, ...(targetPort ? { targetPort } : {}) } });
    }
  };

  const onPortClick = (e, node, side, branch) => {
    e.stopPropagation();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (side === 'out') {
      if (pendingFrom === node.name && pendingBranch === (typeof branch === 'number' ? branch : null)) {
        clearPending();
        return;
      }
      setPendingFrom(node.name);
      setPendingBranch(typeof branch === 'number' ? branch : null);
      setWireCursor(null);
      setSel(null);
      return;
    }
    if (pendingFrom && pendingFrom !== node.name) {
      completeConnection(pendingFrom, node.name, side, pendingBranch);
    } else if (!pendingFrom) {
      setSel(node.name);
    }
  };

  // Global pointer tracking powers drag-to-connect without stealing pointer
  // capture from ports. A short click still works as click-source → click-target.
  useEffect(() => {
    const onMove = (e) => {
      const w = wireRef.current;
      if (!w) return;
      if (!w.moved && Math.abs(e.clientX - w.sx) + Math.abs(e.clientY - w.sy) > 5) {
        w.moved = true;
        setPendingFrom(w.from);
        setPendingBranch(typeof w.branch === 'number' ? w.branch : null);
      }
      if (w.moved) {
        setWireCursor(toWorld(e.clientX, e.clientY));
      }
    };
    const onUp = (e) => {
      const w = wireRef.current;
      wireRef.current = null;
      if (!w || !w.moved) return;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const portEl = hit && hit.closest ? hit.closest('[data-wire-target]') : null;
      const nodeEl = !portEl && hit && hit.closest ? hit.closest('[data-node]') : null;
      if (portEl) {
        const targetName = portEl.getAttribute('data-wire-target');
        const targetKind = portEl.getAttribute('data-wire-kind') || 'in';
        completeConnection(w.from, targetName, targetKind, w.branch);
      } else if (nodeEl) {
        // Dropping anywhere on a card is a forgiving hit target for the main
        // flow input. Sockets still require an explicit drop on the socket.
        const targetName = nodeEl.getAttribute('data-node');
        if (targetName && targetName !== w.from) completeConnection(w.from, targetName, 'in', w.branch);
        else clearPending();
      } else {
        clearPending();
      }
      setWireCursor(null);
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [nodes, connections, view.x, view.y, view.k]); // eslint-disable-line react-hooks/exhaustive-deps

  const removeAuxEdge = (fromName, agentName, targetPort) => {
    checkpoint();
    const src = nodes.find((n) => n.name === fromName);
    const preserveSlots = isIfType(src?.type) || isDecisionType(src?.type);
    setConnections((c) => disconnect(c, fromName, agentName, { targetPort, preserveSlots }));
    // Keep the agent inspector open after unlinking a tool/model.
    setSel(agentName);
  };

  const removeDecisionRoute = (nodeName, index) => {
    const node = nodes.find((n) => n.name === nodeName);
    if (!node) return;
    const routes = decisionRoutes(node.parameters || {});
    if (routes.length <= 1) {
      setErr(new Error('A Decision Engine needs at least one route.'));
      return;
    }
    const oldFb = Number.isFinite(Number(node.parameters?.fallbackBranch)) ? Number(node.parameters.fallbackBranch) : 0;
    const nextRoutes = routes.filter((_, i) => i !== index);
    const nextFb = Math.min(nextRoutes.length - 1, Math.max(0, oldFb > index ? oldFb - 1 : oldFb));
    checkpoint();
    const mains = connections?.[nodeName]?.main;
    let nextConnections = connections;
    if (Array.isArray(mains)) {
      const branches = mains.map((b) => (Array.isArray(b) ? b.slice() : []));
      const removedEdges = branches[index] || [];
      branches.splice(index, 1);
      if (removedEdges.length) {
        while (branches.length <= nextFb) branches.push([]);
        const seen = new Set(branches[nextFb].map((e) => `${e?.node}:${e?.targetPort || e?.type || 'main'}`));
        for (const e of removedEdges) {
          const k = `${e?.node}:${e?.targetPort || e?.type || 'main'}`;
          if (e?.node && !seen.has(k)) { branches[nextFb].push(e); seen.add(k); }
        }
      }
      const groups = { ...(connections?.[nodeName] || {}), main: branches };
      nextConnections = { ...connections, [nodeName]: groups };
    }
    setConnections(nextConnections);
    const choices = Object.fromEntries(nextRoutes.map((r) => [r.name, r.description || r.name]));
    setNodes((ns) => ns.map((n) => (n.name === nodeName ? { ...n, parameters: { ...(n.parameters || {}), choices, routes: undefined, fallbackBranch: nextFb } } : n)));
    setSel(nodeName);
  };

  const moveDecisionRoute = (nodeName, index, direction) => {
    const node = nodes.find((n) => n.name === nodeName);
    if (!node) return;
    const routes = decisionRoutes(node.parameters || {});
    const j = index + direction;
    if (j < 0 || j >= routes.length) return;
    checkpoint();
    const nextRoutes = routes.slice();
    [nextRoutes[index], nextRoutes[j]] = [nextRoutes[j], nextRoutes[index]];
    let nextFb = Number.isFinite(Number(node.parameters?.fallbackBranch)) ? Number(node.parameters.fallbackBranch) : 0;
    if (nextFb === index) nextFb = j;
    else if (nextFb === j) nextFb = index;
    const mains = connections?.[nodeName]?.main;
    let nextConnections = connections;
    if (Array.isArray(mains)) {
      const branches = mains.map((b) => (Array.isArray(b) ? b.slice() : []));
      while (branches.length < nextRoutes.length) branches.push([]);
      [branches[index], branches[j]] = [branches[j], branches[index]];
      nextConnections = { ...connections, [nodeName]: { ...(connections?.[nodeName] || {}), main: branches } };
    }
    setConnections(nextConnections);
    const choices = Object.fromEntries(nextRoutes.map((r) => [r.name, r.description || r.name]));
    setNodes((ns) => ns.map((n) => (n.name === nodeName ? { ...n, parameters: { ...(n.parameters || {}), choices, routes: undefined, fallbackBranch: nextFb } } : n)));
  };

  const updateDecisionRoutes = (nodeName, nextRoutes) => {
    // Used for add/rename/description edits. Branch positions stay stable.
    checkpoint();
    const choices = Object.fromEntries(nextRoutes.map((r, i) => [r.name || `route_${i}`, r.description || r.name || `route_${i}`]));
    setNodes((ns) => ns.map((n) => {
      if (n.name !== nodeName) return n;
      const routes = decisionRoutes(n.parameters || {});
      const fb = Number.isFinite(Number(n.parameters?.fallbackBranch)) ? Math.min(routes.length - 1, Math.max(0, Number(n.parameters.fallbackBranch))) : 0;
      return { ...n, parameters: { ...(n.parameters || {}), choices, routes: undefined, fallbackBranch: Math.min(fb, nextRoutes.length - 1) } };
    }));
  };

  const applyRename = (to) => {
    if (!selNode || !to.trim() || to.trim() === selNode.name) return;
    try {
      checkpoint();
      const r = renameNode(nodes, connections, selNode.name, to.trim());
      setNodes(r.nodes);
      setConnections(r.connections);
      setSel(to.trim());
      setErr(null);
    } catch (ex) {
      setErr(ex);
    }
  };

  const applyDeleteNode = () => {
    if (!selNode) return;
    if (!window.confirm(`Delete node "${selNode.name}" and all its connections?`)) return;
    checkpoint();
    const r = removeNode(nodes, connections, selNode.name);
    setNodes(r.nodes);
    setConnections(r.connections);
    setSel(null);
    clearPending();
  };

  const patchParams = (patch) => {
    if (!selNode) return;
    checkpoint();
    const next = { ...(selNode.parameters || {}), ...patch };
    setNodes((ns) => ns.map((n) => (n.name === selNode.name ? { ...n, parameters: next } : n)));
    setParamsText(JSON.stringify(next, null, 2));
    setParamsErr(null);
  };

  const applyParams = (text) => {
    setParamsText(text);
    if (!selNode) return;
    try {
      const v = text.trim() ? JSON.parse(text) : {};
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('params must be a JSON object');
      setParamsErr(null);
      setNodes((ns) => ns.map((n) => (n.name === selNode.name ? { ...n, parameters: v } : n)));
    } catch (ex) {
      setParamsErr(ex.message || 'Invalid JSON');
    }
  };

  // ----- save -----
  const collect = () => {
    if (tab === 'json') {
      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        throw new Error('Definition is not valid JSON');
      }
      // An empty/missing nodes array would wipe the workflow — reject here
      // (validateGraph tolerates [] for canvas-built states).
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes)) {
        throw new Error('Definition needs a nodes array');
      }
      const w = normalizeWorkflow({ name, nodes: parsed.nodes, connections: parsed.connections });
      return w;
    }
    if (paramsErr) throw new Error(`Node params invalid${selNode ? ` ("${selNode.name}")` : ''}: ${paramsErr}`);
    return { name, nodes, connections };
  };

  const save = async (e) => {
    e?.preventDefault();
    if (busy) return;
    setErr(null);
    let w;
    try {
      w = collect();
    } catch (ex) {
      setErr(ex);
      return;
    }
    const vErr = validateGraph(w.nodes, w.connections, { requireTrigger: true });
    if (vErr) {
      setErr(new Error(vErr));
      return;
    }
    setBusy(true);
    try {
      const updated = await api.updateWorkflow(workflowId, { name: w.name, definition: { nodes: w.nodes, connections: w.connections } }, headers);
      clearDraft();
      onSaved?.(updated);
      onClose();
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  const fillSampleInput = () => {
    setTestInput(JSON.stringify(sampleInputFor(nodes), null, 2));
  };

  const pushHist = (entry) => {
    setTestHist((hs) => {
      const next = [entry, ...hs].slice(0, 5);
      try {
        localStorage.setItem(`synapseone.testrun.${workflowId}`, JSON.stringify(next));
      } catch { /* ignore */ }
      return next;
    });
  };

  const doTestRun = async () => {
    if (testBusy) return;
    let input = {};
    try {
      input = testInput.trim() ? JSON.parse(testInput) : {};
    } catch {
      setErr(new Error('Test input is not valid JSON'));
      return;
    }
    let def;
    try {
      def = collect();
    } catch (ex) {
      setErr(ex);
      return;
    }
    const vErr = validateGraph(def.nodes, def.connections);
    if (vErr) {
      setErr(new Error(vErr));
      return;
    }
    // Fail fast on broken Code nodes instead of a wasted round-trip.
    for (const n of def.nodes || []) {
      if (n?.type !== 'n8n-nodes-base.code' && n?.type !== 'code') continue;
      const src = n?.parameters?.code ?? n?.parameters?.jsCode ?? '';
      const chk = checkJSSyntax(typeof src === 'string' ? src : '');
      if (!chk.ok) {
        setErr(new Error(`Code node "${n.name}" has a syntax error: ${chk.error}`));
        setSel(n.name);
        return;
      }
    }
    setTestBusy(true);
    setErr(null);
    try {
      const r = await api.testRun({ nodes: def.nodes, connections: def.connections }, input, headers, workflowId);
      setTestOut(r);
      setExpandedRuns({});
      pushHist({ at: new Date().toISOString(), input, ok: !!r?.ok, status: r?.ok ? 'success' : 'error' });
    } catch (ex) {
      // A failed run still returns nodeRuns/output (HTTP 500). Keep them so
      // the inspector can show which node failed instead of only a red toast.
      const body = ex && typeof ex === 'object' ? ex.body : null;
      if (body && typeof body === 'object' && (Array.isArray(body.nodeRuns) || body.output !== undefined)) {
        setTestOut({ ...body, ok: false });
        setExpandedRuns({});
      } else {
        setTestOut(null);
      }
      setErr(ex);
      pushHist({ at: new Date().toISOString(), input, ok: false, status: 'error' });
    } finally {
      setTestBusy(false);
    }
  };

  const edges = listEdgesWithBranches(connections);
  const warnings = useMemo(() => graphWarnings(nodes, connections), [nodes, connections]);
  const port = (n, side, branch) => {
    const [x, y] = n.position;
    const dims = nodeDims(n);
    if (side === 'tools') return { x: x + 46, y: y + dims.h };
    if (side === 'model') return { x: x + dims.w - 46, y: y + dims.h };
    if (side === 'in') return { x, y: y + dims.h / 2 };
    if (isIfType(n.type)) {
      return { x: x + dims.w, y: y + (branch === 1 ? dims.h * 0.68 : dims.h * 0.32) };
    }
    if (isDecisionType(n.type)) {
      const routes = decisionRoutes(n.parameters || {});
      const i = typeof branch === 'number' ? Math.min(Math.max(0, branch), routes.length - 1) : 0;
      return { x: x + dims.w, y: y + 46 + i * 26 + 13 };
    }
    return { x: x + dims.w, y: y + dims.h / 2 };
  };
  const edgePath = (a, b, targetPort) => {
    if (targetPort === 'tools' || targetPort === 'model') {
      const x1 = a.x;
      const y1 = a.y;
      const x2 = b.x;
      const y2 = b.y;
      const bend = Math.max(44, Math.abs(y2 - y1) * 0.35);
      return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
    }
    const dx = Math.max(44, Math.abs(b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  };
  // Switching back to visual stages the JSON (parsed + validated) into the
  // canvas state; a broken document stays on the JSON tab with an error.
  const switchTab = (next) => {
    setErr(null);
    if (tab === 'json' && next === 'json') return; // re-click must not wipe dirty typing
    if (tab === 'json' && next === 'visual') {
      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        setErr(new Error('Definition is not valid JSON'));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes)) {
        setErr(new Error('Definition needs a nodes array'));
        return;
      }
      checkpoint();
      const w = normalizeWorkflow({ name, nodes: parsed.nodes, connections: parsed.connections });
      setNodes(w.nodes);
      setConnections(w.connections);
    }
    if (next === 'json') {
      setJsonText(JSON.stringify({ nodes, connections }, null, 2));
    }
    setTab(next);
  };

  const zoomBy = (factor) => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const mx = r.width / 2;
    const my = r.height / 2;
    setView((v) => {
      const k2 = Math.min(2, Math.max(0.25, v.k * factor));
      const wx = (mx - v.x) / v.k;
      const wy = (my - v.y) / v.k;
      return { k: k2, x: mx - wx * k2, y: my - wy * k2 };
    });
  };

  const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
  const runStatusByNode = useMemo(() => {
    const m = {};
    for (const r of testOut?.nodeRuns || []) m[r.node] = r.status;
    return m;
  }, [testOut]);

  const zoomToFit = () => {
    const el = boxRef.current;
    if (!el || nodes.length === 0) {
      setView({ x: 40, y: 40, k: 1 });
      return;
    }
    const r = el.getBoundingClientRect();
    const xs = nodes.map((n) => n.position[0]);
    const ys = nodes.map((n) => n.position[1]);
    const minX = Math.min(...xs) - 60;
    const minY = Math.min(...ys) - 60;
    const maxX = Math.max(...nodes.map((n) => n.position[0] + nodeDims(n).w));
    const maxY = Math.max(...nodes.map((n) => n.position[1] + nodeDims(n).h));
    const w = maxX + 60 - minX;
    const h = maxY + 60 - minY;
    const k = Math.min(1.5, Math.max(0.25, Math.min(r.width / w, r.height / h)));
    setView({ k, x: (r.width - w * k) / 2 - minX * k, y: (r.height - h * k) / 2 - minY * k });
  };

  // Fit all nodes on open (after layout).
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    const t = requestAnimationFrame(() => zoomToFit());
    return () => cancelAnimationFrame(t);
  }, []);

  const saveTitle = saveBlocked ? String(saveBlocked) : (dirty ? 'Save changes (Ctrl+S)' : 'No changes to save');
  const grouped = nodesByCategory();
  const testInputOk = useMemo(() => {
    try {
      JSON.parse(testInput.trim() ? testInput : '{}');
      return true;
    } catch {
      return false;
    }
  }, [testInput]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex flex-col" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="bg-white shadow-xl flex-1 m-2 sm:m-4 rounded-3xl overflow-hidden flex flex-col">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100 flex-wrap">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={() => checkpoint()}
            placeholder="Workflow name"
            className="font-semibold text-main-text text-sm outline-none border-b border-dashed border-slate-200 focus:border-main-blue px-1 max-w-[40vw]"
          />
          {dirty && <Badge tone="amber">Unsaved</Badge>}
          {graphErr && <Badge tone="red">{graphErr}</Badge>}
          <div className="ml-auto flex items-center gap-1">
            <button onClick={undo} disabled={past.current.length === 0} title="Undo (Ctrl+Z)" className="w-8 h-8 rounded-full text-normal-text hover:text-main-blue disabled:opacity-30">
              <FontAwesomeIcon icon={faUndo} size="xs" />
            </button>
            <button onClick={redo} disabled={future.current.length === 0} title="Redo (Ctrl+Shift+Z)" className="w-8 h-8 rounded-full text-normal-text hover:text-main-blue disabled:opacity-30">
              <FontAwesomeIcon icon={faRedo} size="xs" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => switchTab('visual')} className={`px-3 py-1.5 rounded-2xl text-xs font-medium ${tab === 'visual' ? 'bg-main-blue/10 text-main-blue' : 'bg-slate-100 text-main-text'}`}>Visual</button>
            <button onClick={() => switchTab('json')} className={`px-3 py-1.5 rounded-2xl text-xs font-medium ${tab === 'json' ? 'bg-main-blue/10 text-main-blue' : 'bg-slate-100 text-main-text'}`}>JSON</button>
            <span title={saveTitle}>
              <Btn onClick={save} loading={busy} disabled={!dirty || !!saveBlocked}>Save</Btn>
            </span>
            <button onClick={close} title="Close" className="text-normal-text hover:text-main-blue text-lg leading-none px-1">
              <FontAwesomeIcon icon={faXmark} />
            </button>
          </div>
        </div>
        <Err e={err} />
        {graphErr && (
          <div className="mx-4 mt-2 px-3 py-2 rounded-2xl bg-red-500/10 text-red-600 text-xs">
            Save blocked: {graphErr} — fix the graph (connect isolated nodes, remove self-loops/cycles/duplicates) to continue.
          </div>
        )}
        {warnings.length > 0 && (
          <div className="mx-4 mt-2 px-3 py-2 rounded-2xl bg-amber-400/15 text-amber-700 text-xs">
            {warnings.map((w) => <p key={w}>{w}</p>)}
          </div>
        )}
        {draft && (
          <div className="mx-4 mt-2 px-3 py-2 rounded-2xl bg-amber-400/15 text-amber-700 text-xs flex items-center gap-2">
            <span>Unsaved draft from {new Date(draft.savedAt).toLocaleString()}.</span>
            <button
              onClick={() => { checkpoint(); setName(draft.name || ''); setNodes(draft.nodes || []); setConnections(draft.connections || {}); setSel(null); clearDraft(); }}
              className="ml-auto px-3 py-1 rounded-xl bg-white shadow-sm font-medium"
            >
              Restore
            </button>
            <button onClick={clearDraft} className="px-3 py-1 rounded-xl hover:underline">Discard</button>
          </div>
        )}
        <div className="flex-1 flex min-h-0 overflow-x-auto">
          {tab === 'visual' ? (
          <div className="w-48 shrink-0 border-r border-slate-100 p-2 overflow-y-auto">
            <p className="text-[11px] font-medium text-normal-text px-1 mb-1">ADD NODE</p>
            <p className="text-[10px] leading-snug text-normal-text/80 px-1 mb-1.5">Drag onto the canvas, or click to place it in view.</p>
            <input
              value={palQuery}
              onChange={(e) => setPalQuery(e.target.value)}
              placeholder="Search nodes…"
              aria-label="Search node palette"
              className="w-full px-2 py-1.5 mb-1 rounded-xl border border-slate-200 text-xs outline-none focus:border-main-blue"
            />
            {grouped.map((g) => {
              const items = g.items.filter((t) => {
                const q = palQuery.trim().toLowerCase();
                if (!q) return true;
                return `${t.label} ${t.type} ${t.hint || ''}`.toLowerCase().includes(q);
              });
              if (!items.length) return null;
              return (
              <div key={g.id} className="mb-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-normal-text px-1 mt-1" title={g.blurb}>{g.label}</p>
                {items.map((t) => {
                  const meta = NODE_ICONS[t.type] || { icon: faCircleDot, color: 'text-slate-500', bg: 'bg-slate-50 border-slate-200' };
                  return (
                    <button
                      key={t.type}
                      draggable
                      onDragStart={(e) => onPaletteDragStart(e, t.type)}
                      onDragEnd={() => { setPaletteDrag(null); setDropActive(false); }}
                      onClick={() => addNode(t.type)}
                      title={`${t.hint}\n${t.placeholder || ''}\n\nDrag onto the canvas or click to add`}
                      className="w-full text-left px-2 py-1.5 rounded-xl hover:bg-background active:bg-main-blue/5 text-xs text-main-text flex items-center gap-2 group transition-colors cursor-grab active:cursor-grabbing"
                    >
                      <span className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 border ${meta.bg} ${meta.color} group-hover:scale-105 transition-transform`}>
                        <FontAwesomeIcon icon={meta.icon} size="xs" />
                      </span>
                      <span className="truncate font-medium">{t.label}</span>
                      <FontAwesomeIcon icon={faArrowsUpDownLeftRight} className="ml-auto text-[8px] text-slate-300 group-hover:text-main-blue" />
                    </button>
                  );
                })}
              </div>
              );
            })}
            {palQuery.trim() && grouped.every((g) => !g.items.filter((t) => `${t.label} ${t.type} ${t.hint || ''}`.toLowerCase().includes(palQuery.trim().toLowerCase())).length) && (
              <p className="text-[11px] text-normal-text px-1">No node matches “{palQuery.trim()}”.</p>
            )}
          </div>
          ) : (
          <div className="w-44 shrink-0 border-r border-slate-100 p-2 overflow-y-auto">
            <p className="text-[11px] text-normal-text px-1">Edit the JSON directly, then Save — or switch back to Visual to stage it onto the canvas.</p>
          </div>
          )}
          {tab === 'visual' ? (
            <div
              ref={boxRef}
              onPointerDown={onBoxPointerDown}
              onPointerMove={onBoxPointerMove}
              onPointerUp={onBoxPointerUp}
              onDragOver={onCanvasDragOver}
              onDragLeave={(e) => { if (e.target === e.currentTarget) setDropActive(false); }}
              onDrop={onCanvasDrop}
              className={`flex-1 relative overflow-hidden touch-none select-none min-w-[320px] transition-shadow ${dropActive ? 'ring-2 ring-inset ring-main-blue/60' : ''}`}
              style={{ backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)', backgroundSize: `${24 * view.k}px ${24 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px`, cursor: pendingFrom ? 'crosshair' : dropActive ? 'copy' : 'default' }}
            >
              <svg className="absolute inset-0 w-full h-full pointer-events-none">
                <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                  {edges.map((e, i) => {
                    const a = byName[e.from];
                    const b = byName[e.to];
                    if (!a || !b) return null;
                    const targetPort = e.targetPort || edgeTargetPort(e) || (b && isAiAgentType(b.type) && e.type !== 'main' ? e.type : undefined);
                    const active = selEdge && selEdge.from === e.from && selEdge.to === e.to &&
                      (selEdge.branch ?? null) === (e.branch ?? null) &&
                      (selEdge.targetPort || null) === (targetPort || null);
                    const pa = port(a, 'out', e.branch);
                    const pb = port(b, targetPort === 'tools' ? 'tools' : targetPort === 'model' ? 'model' : 'in');
                    const isIf = isIfType(a.type);
                    const isDec = isDecisionType(a.type);
                    const isToolEdge = targetPort === 'tools';
                    const isModelEdge = targetPort === 'model';
                    let branchLabel = '';
                    let branchColor = '#4FACFE';
                    if (isToolEdge) {
                      branchLabel = '🛠 Tool';
                      branchColor = '#9333ea';
                    } else if (isModelEdge) {
                      branchLabel = '🧠 Model';
                      branchColor = '#4f46e5';
                    } else if (isIf && (e.branch === 0 || e.branch === 1)) {
                      branchLabel = ifBranchLabel(e.branch);
                      branchColor = e.branch === 0 ? '#059669' : '#dc2626';
                    } else if (isDec && typeof e.branch === 'number') {
                      const routes = decisionRoutes(a.parameters || {});
                      branchLabel = routes[e.branch] ? `${routes[e.branch].name} (${e.branch})` : `route ${e.branch}`;
                      branchColor = '#6366f1';
                    }
                    let strokeColor = '#94a3b8';
                    let strokeDash = undefined;
                    if (active) {
                      strokeColor = '#ef4444';
                    } else if (pendingFrom === e.from && (pendingBranch ?? null) === (e.branch ?? null)) {
                      strokeColor = '#4FACFE';
                    } else if (isToolEdge) {
                      strokeColor = '#a855f7';
                      strokeDash = `${4 / view.k} ${3 / view.k}`;
                    } else if (isModelEdge) {
                      strokeColor = '#6366f1';
                      strokeDash = `${4 / view.k} ${3 / view.k}`;
                    }
                    const d = edgePath(pa, pb, targetPort);
                    return (
                      <g key={`${e.from}→${e.to}:${e.branch}:${targetPort || ''}:${i}`}>
                        <path d={d} fill="none" stroke="transparent" strokeWidth={16 / view.k} className="pointer-events-auto cursor-pointer" onClick={(ev) => { ev.stopPropagation(); setSel({ edge: e }); }} />
                        <path
                          d={d}
                          fill="none"
                          stroke={strokeColor}
                          strokeWidth={active ? 3 / view.k : 2 / view.k}
                          strokeDasharray={strokeDash}
                          className="pointer-events-none"
                        />
                        {branchLabel && (
                          <text
                            x={(pa.x + pb.x) / 2}
                            y={(pa.y + pb.y) / 2 - 6 / view.k}
                            textAnchor="middle"
                            fontSize={10 / view.k}
                            fontWeight="700"
                            fill={branchColor}
                            stroke="white"
                            strokeWidth={3 / view.k}
                            paintOrder="stroke"
                            className="pointer-events-none"
                          >
                            {branchLabel}
                          </text>
                        )}
                      </g>
                    );
                  })}
                  {pendingFrom && byName[pendingFrom] && (() => {
                    const pa = port(byName[pendingFrom], 'out', pendingBranch);
                    const pb = wireCursor || { x: pa.x + 54, y: pa.y + 18 };
                    const d = edgePath(pa, pb, undefined);
                    return (
                      <>
                        <path d={d} fill="none" stroke="#4FACFE" strokeWidth={2.5 / view.k} strokeDasharray={`${6 / view.k} ${4 / view.k}`} className="pointer-events-none" />
                        <circle cx={pa.x} cy={pa.y} r={7 / view.k} fill="#4FACFE" stroke="white" strokeWidth={2 / view.k} className="pointer-events-none" />
                        {wireCursor && <circle cx={wireCursor.x} cy={wireCursor.y} r={4 / view.k} fill="#4FACFE" className="pointer-events-none" />}
                      </>
                    );
                  })()}
                </g>
              </svg>
              {nodes.map((n) => {
                const st = runStatusByNode[n.name];
                const known = isKnownType(n.type);
                const disabled = n.disabled === true;
                const isAgent = isAiAgentType(n.type);
                const isDecision = isDecisionType(n.type);
                const isIf = isIfType(n.type);
                const dims = nodeDims(n);
                const border = sel === n.name
                  ? 'border-main-blue ring-2 ring-main-blue/20'
                  : isAgent
                  ? 'border-purple-300 ring-1 ring-purple-100 hover:border-purple-400'
                  : isDecision
                  ? 'border-indigo-300 ring-1 ring-indigo-100 hover:border-indigo-400'
                  : st === 'success'
                  ? 'border-emerald-400'
                  : st === 'error'
                  ? 'border-red-400'
                  : 'border-slate-200';
                const iconMeta = NODE_ICONS[n.type] || { icon: faCircleDot, color: 'text-slate-500', bg: 'bg-slate-50 border-slate-200' };
                const ps = 14;
                const off = -ps / 2;
                const routes = isDecision ? decisionRoutes(n.parameters || {}) : [];
                const agentToolsList = Array.isArray(n.parameters?.tools) ? n.parameters.tools : DEFAULT_AGENT_TOOLS;
                const canvasTools = isAgent ? toolEdgesForAgent(connections, n.name).map((e) => e.from) : [];
                const modelSource = isAgent ? modelEdgeForAgent(connections, n.name) : null;
                const modelSourceNode = modelSource ? nodes.find((x) => x.name === modelSource.from) : null;
                const subtitle = isModelType(n.type)
                  ? (n.parameters?.model || n.parameters?.core || 'model core')
                  : isIntegrationType(n.type)
                  ? (n.parameters?.operation || 'choose an operation')
                  : isDecision
                  ? `${routes.length} route${routes.length === 1 ? '' : 's'}`
                  : isIf
                  ? 'true / false branch'
                  : String(n.type).split('.').pop();
                const totalTools = agentToolsList.length + canvasTools.length;

                return (
                <div
                  key={n.id}
                  data-node={n.name}
                  onPointerDown={(e) => onNodePointerDown(e, n)}
                  onPointerUp={(e) => onNodePointerUp(e, n)}
                  title={disabled ? `${n.name} (disabled — skipped at run time)` : n.name}
                  className={`absolute rounded-2xl border-2 bg-white shadow-sm ${border} ${disabled ? 'opacity-50 border-dashed' : ''} hover:shadow-md transition-shadow`}
                  style={{ left: n.position[0] * view.k + view.x, top: n.position[1] * view.k + view.y, width: dims.w * view.k, height: dims.h * view.k, fontSize: 12 * view.k }}
                >
                  {isAgent ? (
                    <div className="flex flex-col h-full p-2.5 justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="rounded-xl flex items-center justify-center shrink-0 border bg-purple-50 border-purple-200 text-purple-600" style={{ width: 24 * view.k, height: 24 * view.k, fontSize: 11 * view.k }}>
                            <FontAwesomeIcon icon={faRobot} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="font-bold text-main-text truncate leading-tight flex items-center gap-1" style={{ fontSize: 12 * view.k }}>
                              <span>{disabled ? '⏸ ' : ''}{n.name}</span>
                              {st === 'success' && <span className="text-emerald-500 font-bold">✓</span>}
                              {st === 'error' && <span className="text-red-500 font-bold">✗</span>}
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                              <span className="px-1.5 py-0.2 rounded-full text-[9px] font-semibold bg-purple-100 text-purple-700 truncate" style={{ fontSize: 9 * view.k }}>
                                {(modelSourceNode?.parameters?.core || n.parameters?.core || 'synapse-inference') === 'synapse-inference' ? 'Synapse Engine' : 'External API'}
                              </span>
                              <span className="text-normal-text truncate font-mono text-[9px]" style={{ fontSize: 9 * view.k }} title={modelSource ? `Model source: ${modelSource.from}` : 'No Model socket wired — uses this agent\'s inline model config'}>
                                {modelSourceNode?.parameters?.model || n.parameters?.model || 'lfm-2.5-2.6b'}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="my-1 border-t border-b border-purple-100 py-1 bg-purple-50/40 rounded-xl px-1.5">
                        <div className="flex items-center justify-between mb-1 gap-1">
                          <span className="font-semibold text-purple-900 tracking-tight truncate" style={{ fontSize: 10 * view.k }}>
                            🛠 Tools &amp; data ({totalTools})
                          </span>
                          <button
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setQuickToolNode(quickToolNode === n.name ? null : n.name);
                            }}
                            onPointerDown={(ev) => ev.stopPropagation()}
                            className="px-1.5 py-0.5 rounded-md bg-purple-600 text-white font-medium hover:bg-purple-700 shadow-xs shrink-0"
                            style={{ fontSize: 9 * view.k }}
                            title="Toggle built-in tools. To expose a canvas node as a tool, wire it into the purple Tools socket at the bottom."
                          >
                            + Tools
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1 max-h-[42px] overflow-hidden">
                          {agentToolsList.slice(0, 3).map((tId) => {
                            const tMeta = AGENT_TOOLS.find((x) => x.id === tId);
                            return (
                              <span key={tId} className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-md bg-white border border-purple-200 text-purple-800 font-medium truncate" style={{ fontSize: 9 * view.k }} title={tMeta?.desc || tId}>
                                <span>{tMeta?.icon || '⚙️'}</span>
                                <span className="truncate max-w-[66px]">{tMeta?.label?.split(' ')[0] || tId}</span>
                              </span>
                            );
                          })}
                          {canvasTools.slice(0, 3).map((name) => (
                            <span key={`node:${name}`} className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-md bg-purple-600/10 border border-purple-300 text-purple-900 font-semibold truncate" style={{ fontSize: 9 * view.k }} title={`Canvas node "${name}" is exposed to the agent as a callable tool`}>
                              <span>🧩</span><span className="truncate max-w-[66px]">{name}</span>
                            </span>
                          ))}
                          {totalTools > 6 && <span className="px-1 py-0.2 rounded-md bg-purple-200/60 text-purple-900 font-semibold" style={{ fontSize: 9 * view.k }}>+{totalTools - 6}</span>}
                          {totalTools === 0 && <span className="text-slate-400 italic" style={{ fontSize: 9 * view.k }}>No tools — wire one below</span>}
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-normal-text px-1 gap-1" style={{ fontSize: 9 * view.k }}>
                        <span
                          data-wire-target={n.name}
                          data-wire-kind="tools"
                          onClick={(e) => onPortClick(e, n, 'tools')}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="flex items-center gap-1 font-medium text-purple-700 truncate cursor-pointer hover:underline"
                          title="Tools socket — drop any canvas node here (or click after picking an output) to expose it as a callable tool"
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-purple-500 inline-block" /> Tools socket
                        </span>
                        <span
                          data-wire-target={n.name}
                          data-wire-kind="model"
                          onClick={(e) => onPortClick(e, n, 'model')}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="flex items-center gap-1 font-medium text-indigo-700 truncate cursor-pointer hover:underline"
                          title={modelSource ? `Model from ${modelSource.from}` : 'Model socket — drop a Model Core node here to override the inline model'}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full inline-block ${modelSource ? 'bg-indigo-500' : 'bg-slate-300'}`} /> {modelSource ? modelSource.from : 'Model socket'}
                        </span>
                      </div>

                      {quickToolNode === n.name && (
                        <div
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          className="absolute z-30 bg-white rounded-2xl shadow-2xl border border-purple-200 p-3 w-72 text-left"
                          style={{ left: 0, top: dims.h * view.k + 8 }}
                        >
                          <div className="flex items-center justify-between pb-1.5 border-b border-slate-100 mb-2">
                            <span className="font-bold text-xs text-purple-900 flex items-center gap-1">🛠 Built-in tools</span>
                            <button onClick={() => setQuickToolNode(null)} className="w-5 h-5 rounded-full hover:bg-slate-100 text-slate-500 text-xs flex items-center justify-center font-bold">×</button>
                          </div>
                          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                            {AGENT_TOOLS.map((t) => {
                              const isPlugged = agentToolsList.includes(t.id);
                              return (
                                <label
                                  key={t.id}
                                  onClick={() => {
                                    checkpoint();
                                    const next = isPlugged ? agentToolsList.filter((x) => x !== t.id) : [...agentToolsList, t.id];
                                    setNodes((ns) => ns.map((x) => (x.name === n.name ? { ...x, parameters: { ...(x.parameters || {}), tools: next } } : x)));
                                  }}
                                  className={`flex items-start gap-1.5 p-1.5 rounded-xl border text-[11px] cursor-pointer transition-colors ${isPlugged ? 'bg-purple-50 border-purple-300 text-purple-900' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                                >
                                  <input type="checkbox" checked={isPlugged} onChange={() => {}} className="mt-0.5 rounded text-purple-600" />
                                  <div className="min-w-0 flex-1 leading-tight">
                                    <div className="font-semibold flex items-center gap-1"><span>{t.icon}</span><span className="truncate">{t.label}</span></div>
                                    <div className="text-[9px] text-slate-500 mt-0.5 leading-snug">{t.desc}</div>
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                          <p className="text-[9px] text-normal-text mt-2 leading-snug">For a node on the canvas: drag from its output dot into this agent&apos;s purple <b>Tools</b> socket below.</p>
                        </div>
                      )}
                    </div>
                  ) : isDecision ? (
                    <div className="flex flex-col h-full min-w-0">
                      <div className="flex items-center gap-2 min-w-0" style={{ height: 46 * view.k, padding: `${6 * view.k}px ${8 * view.k}px` }}>
                        <span className={`rounded-lg flex items-center justify-center shrink-0 border ${iconMeta.bg} ${iconMeta.color}`} style={{ width: 22 * view.k, height: 22 * view.k, fontSize: 10 * view.k }}>
                          <FontAwesomeIcon icon={iconMeta.icon} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-main-text truncate leading-tight" style={{ fontSize: 12 * view.k }}>{disabled ? '⏸ ' : ''}{n.name}{st === 'success' ? ' ✓' : st === 'error' ? ' ✗' : ''}</div>
                          <div className="text-normal-text truncate" style={{ fontSize: 9 * view.k }}>Decision Engine · {routes.length} routes</div>
                        </div>
                      </div>
                      <div className="flex-1 min-h-0">
                        {routes.map((r, idx) => (
                          <div key={`${r.name}:${idx}`} title={r.description || r.name} className="flex items-center gap-1.5 px-2 pr-5 min-w-0" style={{ height: 26 * view.k }}>
                            <span className="rounded-md bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center shrink-0" style={{ fontSize: 8 * view.k, width: 15 * view.k, height: 15 * view.k }}>{idx}</span>
                            <span className="font-medium text-main-text truncate" style={{ fontSize: 10 * view.k }}>{r.name}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 p-2 h-full min-w-0">
                      <span className={`rounded-xl flex items-center justify-center shrink-0 border ${iconMeta.bg} ${iconMeta.color}`} style={{ width: 27 * view.k, height: 27 * view.k, fontSize: 12 * view.k }}>
                        <FontAwesomeIcon icon={iconMeta.icon} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-main-text truncate leading-tight" style={{ fontSize: 12 * view.k }}>
                          {disabled ? '⏸ ' : ''}{n.name}{st === 'success' ? ' ✓' : st === 'error' ? ' ✗' : ''}
                        </div>
                        <div className={`text-normal-text truncate leading-tight mt-0.5 ${known ? '' : 'underline decoration-wavy decoration-amber-500'}`} style={{ fontSize: 9.5 * view.k }} title={known ? String(n.type) : `${n.type} — unknown type: the engine passes it through as skipped`}>
                          {subtitle}{known ? '' : ' ⚠'}
                        </div>
                        {isIf && (
                          <div className="flex gap-2 mt-0.5" style={{ fontSize: 8.5 * view.k }}>
                            <span className="text-emerald-600 font-bold">true ↑</span><span className="text-red-500 font-bold">false ↓</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {isAgent ? (
                    <>
                      <button
                        onClick={(e) => onPortClick(e, n, 'in')}
                        onPointerDown={(e) => e.stopPropagation()}
                        data-wire-target={n.name}
                        data-wire-kind="in"
                        title="Flow input — receive data from the previous node"
                        aria-label={`Flow input of ${n.name}`}
                        className="absolute rounded-full bg-white border-2 border-slate-300 hover:border-main-blue hover:scale-110 transition-transform shadow-sm z-10"
                        style={{ left: off, top: '50%', marginTop: off, width: ps, height: ps }}
                      />
                      <button
                        onClick={(e) => onPortClick(e, n, 'out')}
                        onPointerDown={(e) => beginWire(e, n, 'out', undefined)}
                        title="Flow output — click, then click a target input"
                        aria-label={`Flow output of ${n.name}`}
                        className={`absolute rounded-full border-2 hover:scale-110 transition-transform shadow-sm z-10 ${pendingFrom === n.name && pendingBranch === null ? 'bg-main-blue border-main-blue ring-2 ring-main-blue/30' : 'bg-white border-slate-300 hover:border-main-blue'}`}
                        style={{ right: off, top: '50%', marginTop: off, width: ps, height: ps }}
                      />
                      <button
                        onClick={(e) => onPortClick(e, n, 'tools')}
                        onPointerDown={(e) => e.stopPropagation()}
                        data-wire-target={n.name}
                        data-wire-kind="tools"
                        title="Tools socket — wire any canvas node here to expose it as a callable agent tool"
                        aria-label={`Tools socket of ${n.name}`}
                        className="absolute rounded-full bg-purple-500 border-2 border-white hover:border-purple-300 hover:scale-125 transition-transform shadow-md ring-2 ring-purple-400/50 z-10"
                        style={{ left: 46 * view.k + off, bottom: off, width: ps + 2, height: ps + 2 }}
                      />
                      <button
                        onClick={(e) => onPortClick(e, n, 'model')}
                        onPointerDown={(e) => e.stopPropagation()}
                        data-wire-target={n.name}
                        data-wire-kind="model"
                        title="Model socket — wire a Model Core node here to override the inline model"
                        aria-label={`Model socket of ${n.name}`}
                        className="absolute rounded-full bg-indigo-500 border-2 border-white hover:border-indigo-300 hover:scale-125 transition-transform shadow-md ring-2 ring-indigo-400/50 z-10"
                        style={{ right: 46 * view.k + off, bottom: off, width: ps + 2, height: ps + 2 }}
                      />
                    </>
                  ) : (
                    <>
                      <button
                        onClick={(e) => onPortClick(e, n, 'in')}
                        onPointerDown={(e) => e.stopPropagation()}
                        data-wire-target={n.name}
                        data-wire-kind="in"
                        title="Flow input — click after picking an output to connect"
                        aria-label={`Flow input of ${n.name}`}
                        className="absolute rounded-full bg-white border-2 border-slate-300 hover:border-main-blue hover:scale-110 transition-transform z-10"
                        style={{ left: off, top: '50%', marginTop: off, width: ps, height: ps }}
                      />
                      {isDecision ? routes.map((r, idx) => (
                        <button
                          key={`${r.name}:${idx}`}
                          onClick={(e) => onPortClick(e, n, 'out', idx)}
                          onPointerDown={(e) => beginWire(e, n, 'out', idx)}
                          title={`Route ${idx}: ${r.name} — click, then click a target input`}
                          aria-label={`Route ${idx} ${r.name} output of ${n.name}`}
                          className={`absolute rounded-full border-2 hover:scale-125 transition-transform shadow-sm z-10 ${pendingFrom === n.name && pendingBranch === idx ? 'bg-indigo-600 border-indigo-600 ring-2 ring-indigo-300' : 'bg-white border-indigo-400 hover:border-indigo-600'}`}
                          style={{ right: off, top: 46 * view.k + idx * 26 * view.k + 13 * view.k - ps / 2, width: ps, height: ps }}
                        />
                      )) : isIf ? [0, 1].map((idx) => (
                        <button
                          key={idx}
                          onClick={(e) => onPortClick(e, n, 'out', idx)}
                          onPointerDown={(e) => beginWire(e, n, 'out', idx)}
                          title={`${idx === 0 ? 'True' : 'False'} output — click, then click a target input`}
                          aria-label={`${idx === 0 ? 'True' : 'False'} output of ${n.name}`}
                          className={`absolute rounded-full border-2 hover:scale-125 transition-transform shadow-sm z-10 ${pendingFrom === n.name && pendingBranch === idx ? 'ring-2 ring-main-blue/30' : ''} ${idx === 0 ? 'bg-white border-emerald-500' : 'bg-white border-red-500'}`}
                          style={{ right: off, top: dims.h * (idx === 0 ? 0.32 : 0.68) * view.k - ps / 2, width: ps, height: ps }}
                        />
                      )) : (
                        <button
                          onClick={(e) => onPortClick(e, n, 'out')}
                          onPointerDown={(e) => beginWire(e, n, 'out', undefined)}
                          title="Flow output — click, then click a target input (or drag)"
                          aria-label={`Flow output of ${n.name}`}
                          className={`absolute rounded-full border-2 hover:scale-110 transition-transform shadow-sm z-10 ${pendingFrom === n.name && pendingBranch === null ? 'bg-main-blue border-main-blue ring-2 ring-main-blue/30' : 'bg-white border-slate-300 hover:border-main-blue'}`}
                          style={{ right: off, top: '50%', marginTop: off, width: ps, height: ps }}
                        />
                      )}
                    </>
                  )}
                </div>
                );
              })}
              <div className="absolute bottom-3 right-3 flex gap-1">
                <button onClick={() => zoomBy(1.2)} title="Zoom in" aria-label="Zoom in" className="w-8 h-8 rounded-full bg-white shadow-md text-normal-text"><FontAwesomeIcon icon={faMagnifyingGlassPlus} size="xs" /></button>
                <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out" aria-label="Zoom out" className="w-8 h-8 rounded-full bg-white shadow-md text-normal-text"><FontAwesomeIcon icon={faMagnifyingGlassMinus} size="xs" /></button>
                <button onClick={zoomToFit} title="Fit all nodes" aria-label="Fit all nodes" className="h-8 px-3 rounded-full bg-white shadow-md text-normal-text text-xs">Fit</button>
              </div>
              {nodes.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-6">
                  <div className="max-w-sm text-center rounded-3xl bg-white/90 shadow-md px-5 py-4">
                    <p className="text-sm font-semibold text-main-text">Empty canvas</p>
                    <p className="text-xs text-normal-text mt-1">Drag a node here from the palette — start with a trigger (Webhook, Schedule or Manual), then wire it to an action, AI Agent, or Decision Engine. Every node ships with a runnable example.</p>
                  </div>
                </div>
              )}
              {dropActive && (
                <div className="absolute inset-3 rounded-3xl border-2 border-dashed border-main-blue/60 bg-main-blue/5 pointer-events-none flex items-center justify-center">
                  <span className="px-4 py-2 rounded-2xl bg-white shadow text-main-blue text-sm font-semibold">Drop to add “{NODE_TYPES.find((t) => t.type === paletteDrag)?.label || 'node'}”</span>
                </div>
              )}
              <div className="absolute bottom-3 left-3 flex items-center gap-2 pointer-events-none">
                <span className="px-2 py-1 rounded-xl bg-white/90 shadow-sm text-[10px] text-normal-text">{nodes.length} nodes · {edges.length} wires</span>
                <span className="px-2 py-1 rounded-xl bg-white/90 shadow-sm text-[10px] text-normal-text hidden sm:inline">Drag palette → canvas · drag ports to wire · scroll to zoom</span>
              </div>
              {pendingFrom && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-2xl bg-main-blue text-white text-xs shadow-md flex items-center gap-2 max-w-[92%] flex-wrap">
                  {(() => {
                    const src = byName[pendingFrom];
                    const branchText = isIfType(src?.type)
                      ? (pendingBranch === 0 ? ' (true branch)' : pendingBranch === 1 ? ' (false branch)' : '')
                      : isDecisionType(src?.type) && typeof pendingBranch === 'number'
                      ? ` (route ${pendingBranch}: ${decisionRoutes(src.parameters || {})[pendingBranch]?.name || ''})`
                      : '';
                    return <span>Connecting “{pendingFrom}”{branchText} — click a target input/socket, or drag onto it. Esc cancels.</span>;
                  })()}
                  <button onClick={(e) => { e.stopPropagation(); clearPending(); }} className="px-2 py-0.5 rounded-xl bg-white/20 font-semibold hover:bg-white/30">Cancel</button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 p-3 overflow-auto">
              <textarea
                value={jsonText}
                onFocus={() => checkpoint()}
                onChange={(e) => setJsonText(e.target.value)}
                rows={24}
                spellCheck={false}
                className="w-full h-full min-h-[50vh] px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono outline-none focus:border-main-blue"
              />
            </div>
          )}
          <div className="w-72 shrink-0 border-l border-slate-100 p-3 overflow-y-auto">
            {selNode ? (
              <>
                <p className="text-[11px] font-medium text-normal-text mb-2">NODE</p>
                <label className="block text-xs text-normal-text mb-1">Name</label>
                <input
                  defaultValue={selNode.name}
                  key={selNode.id + selNode.name}
                  onBlur={(e) => applyRename(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  className="w-full px-2 py-1.5 rounded-xl border border-slate-200 text-xs outline-none mb-2"
                />
                <label className="block text-xs text-normal-text mb-1">Type</label>
                <input value={selNode.type} disabled className="w-full px-2 py-1.5 rounded-xl border border-slate-100 bg-background text-xs text-normal-text font-mono mb-2" title="Node type (fixed after creation)" />
                <label className="flex items-center gap-1.5 text-xs text-normal-text mb-2" title="Disabled nodes are skipped at run time but keep data flowing">
                  <input
                    type="checkbox"
                    checked={selNode.disabled === true}
                    onChange={(e) => { checkpoint(); const v = e.target.checked; setNodes((ns) => ns.map((n) => (n.name === selNode.name ? { ...n, disabled: v || undefined } : n))); }}
                  />
                  Disabled (skip at run time)
                </label>
                <NodeForm
                  node={selNode}
                  onPatch={patchParams}
                  workflowId={workflowId}
                  headers={headers}
                  nodes={nodes}
                  connections={connections}
                  onDecisionRoutes={updateDecisionRoutes}
                  onRemoveDecisionRoute={removeDecisionRoute}
                  onMoveDecisionRoute={moveDecisionRoute}
                  onRemoveAuxEdge={removeAuxEdge}
                  onConnectTool={(from, agent) => completeConnection(from, agent, 'tools', undefined, false)}
                  onConnectModel={(from, agent) => completeConnection(from, agent, 'model', undefined, false)}
                />
                <details className="mt-2">
                  <summary className="text-[11px] text-normal-text cursor-pointer hover:text-main-blue">Advanced JSON</summary>
                  {selNode && EXAMPLE_PARAMS[selNode.type] && (
                    <button
                      onClick={() => { checkpoint(); const v = JSON.parse(JSON.stringify(EXAMPLE_PARAMS[selNode.type])); setNodes((ns) => ns.map((n) => (n.name === selNode.name ? { ...n, parameters: v } : n))); setParamsText(JSON.stringify(v, null, 2)); setParamsErr(null); }}
                      className="my-1 px-2 py-1 rounded-xl text-[11px] bg-main-blue/10 text-main-blue"
                    >
                      Fill example
                    </button>
                  )}
                  <textarea
                    value={paramsText}
                    onFocus={() => checkpoint()}
                    onChange={(e) => applyParams(e.target.value)}
                    rows={8}
                    spellCheck={false}
                    className="w-full px-2 py-1.5 rounded-xl border border-slate-200 text-xs font-mono outline-none mb-1"
                  />
                  {paramsErr && <p className="text-[11px] text-red-500 mb-2">{paramsErr}</p>}
                </details>
                <button onClick={applyDeleteNode} className="mt-2 px-3 py-1.5 rounded-2xl text-xs font-medium bg-red-500/10 text-red-500">
                  <FontAwesomeIcon icon={faTrash} size="xs" /> Delete node
                </button>
              </>
            ) : selEdge ? (
              <>
                <p className="text-[11px] font-medium text-normal-text mb-2">CONNECTION</p>
                <p className="text-xs font-mono text-main-text mb-1 break-all">{selEdge.from} → {selEdge.to}</p>
                <p className="text-[11px] text-normal-text mb-3">
                  {selEdge.targetPort === 'tools' ? 'Tools socket (node becomes an agent tool)' : selEdge.targetPort === 'model' ? 'Model socket (provides model/core config)' : typeof selEdge.branch === 'number' ? (isIfType(nodes.find((n) => n.name === selEdge.from)?.type) ? `Branch: ${ifBranchLabel(selEdge.branch)}` : `Route branch ${selEdge.branch}`) : 'Main flow'}
                </p>
                <button
                  onClick={() => {
                    checkpoint();
                    const src = nodes.find((n) => n.name === selEdge.from);
                    setConnections((c) => disconnect(c, selEdge.from, selEdge.to, {
                      ...(typeof selEdge.branch === 'number' ? { branch: selEdge.branch } : {}),
                      ...(selEdge.targetPort ? { targetPort: selEdge.targetPort } : {}),
                      preserveSlots: isIfType(src?.type) || isDecisionType(src?.type),
                    }));
                    setSel(null);
                  }}
                  className="px-3 py-1.5 rounded-2xl text-xs font-medium bg-red-500/10 text-red-500"
                >
                  <FontAwesomeIcon icon={faTrash} size="xs" /> Remove connection
                </button>
              </>
            ) : (
              <p className="text-xs text-normal-text">Click a node to inspect · drag to move · click an output dot, then an input dot, to connect · drag the background to pan · scroll to zoom.</p>
            )}
            <div className="mt-4 pt-3 border-t border-slate-100">
              <p className="text-[11px] font-medium text-normal-text mb-1">TEST RUN (no save)</p>
              <div className="flex gap-1 mb-1">
                <button onClick={fillSampleInput} title="Fill input matching the entry trigger node" className="px-2 py-1 rounded-xl text-[11px] bg-slate-100 text-main-text hover:text-main-blue">Fill sample</button>
                {testHist.length > 0 && <span className="text-[11px] text-normal-text self-center">{testHist.length} recent</span>}
              </div>
              <textarea
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                rows={2}
                spellCheck={false}
                placeholder='{"value": 21}'
                aria-label="Test run input (JSON)"
                className={`w-full px-2 py-1.5 rounded-xl border text-xs font-mono outline-none mb-1 ${testInputOk ? 'border-slate-200' : 'border-red-400'}`}
              />
              {!testInputOk && <p className="text-[11px] text-red-500 mb-1">Input is not valid JSON.</p>}
              <button
                onClick={doTestRun}
                disabled={testBusy || !testInputOk}
                title={!testInputOk ? 'Fix the JSON input first' : graphErr ? `Fix graph first: ${graphErr}` : 'Run the current canvas without saving'}
                className="px-3 py-1.5 rounded-2xl text-xs font-medium text-white bg-gradient-to-b from-main-start to-main-end disabled:opacity-60 disabled:cursor-wait inline-flex items-center gap-1.5"
              >
                {testBusy && <span className="sdx-spinner h-3.5 w-3.5 border-2 sdx-spinner-on-dark" />}
                {testBusy ? 'Running…' : 'Test run'}
              </button>
              {testOut && (
                <div className="mt-2">
                  <Badge tone={testOut.ok ? 'green' : 'red'}>{testOut.ok ? 'OK' : 'Error'}</Badge>
                  {testOut.error && <p className="text-[11px] text-red-500 mt-1 break-words">{testOut.error}</p>}
                  <div className="mt-1 max-h-32 overflow-auto">
                    <pre className="text-[11px] font-mono whitespace-pre-wrap break-all">{JSON.stringify(testOut.output ?? testOut, null, 2).slice(0, 2000)}</pre>
                  </div>
                  {Array.isArray(testOut.nodeRuns) && testOut.nodeRuns.length > 0 && (
                    <div className="mt-2">
                      <p className="text-[11px] font-medium text-normal-text mb-1">NODES ({testOut.nodeRuns.length})</p>
                      {testOut.nodeRuns.map((r, i) => (
                        <div key={`${r.node}:${i}`} className="mb-1 rounded-xl border border-slate-100 overflow-hidden">
                          <button
                            onClick={() => setExpandedRuns((m) => ({ ...m, [`${r.node}:${i}`]: !m[`${r.node}:${i}`] }))}
                            className="w-full flex items-center gap-1.5 px-2 py-1 text-left text-[11px]"
                          >
                            <span className={`inline-block w-2 h-2 rounded-full ${r.status === 'success' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                            <span className="font-medium text-main-text truncate">{r.node}</span>
                            <span className="text-normal-text ml-auto">{r.durationMs}ms</span>
                          </button>
                          {expandedRuns[`${r.node}:${i}`] && (
                            <NodeRunDetailView r={r} />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {testHist.length > 0 && (
                    <div className="mt-2">
                      <p className="text-[11px] font-medium text-normal-text mb-1">HISTORY</p>
                      {testHist.map((h, i) => (
                        <button
                          key={`${h.at}:${i}`}
                          onClick={() => setTestInput(JSON.stringify(h.input, null, 2))}
                          title="Restore this test input"
                          className="w-full text-left px-2 py-1 rounded-xl hover:bg-background text-[11px] text-normal-text flex gap-1.5"
                        >
                          <span className={`inline-block w-2 h-2 rounded-full mt-1 ${h.ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
                          <span className="truncate">{new Date(h.at).toLocaleTimeString()} · {h.status}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function NodeRunDetailView({ r }) {
  const agent = r.output?.agent;
  const isAgent = Boolean(agent);
  const isDecision = Boolean(r.output?.decision || r.output?.route);

  return (
    <div className="px-2 pb-2 space-y-2 text-left">
      {r.error && <p className="text-[11px] text-red-500 break-words">{r.error}</p>}

      {isAgent && (
        <div className="rounded-xl border border-purple-200 bg-purple-50/50 p-2.5 space-y-2">
          {/* AI Agent badge & metadata */}
          <div className="flex items-center justify-between flex-wrap gap-1">
            <span className="text-xs font-bold text-purple-900 flex items-center gap-1.5">
              <span>🤖</span>
              <span>AI Agent Execution</span>
            </span>
            <span className="text-[9px] px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 font-mono font-medium">
              {agent.core} · {agent.steps_count ?? agent.steps ?? 0} {(agent.steps_count ?? agent.steps ?? 0) === 1 ? 'step' : 'steps'}
            </span>
          </div>

          <div className="text-[10px] text-purple-700 font-mono flex items-center gap-1">
            <span className="text-slate-400">Model:</span>
            <span className="font-semibold">{agent.model}</span>
          </div>

          {/* Synthesized Agent Response */}
          {agent.response && (
            <div className="bg-white rounded-xl p-2 border border-purple-200 shadow-2xs">
              <p className="text-[10px] font-bold text-purple-900 mb-1 flex items-center gap-1">
                💬 Agent Response / Trả lời:
              </p>
              <div className="text-[11px] text-slate-800 whitespace-pre-wrap font-sans leading-relaxed">
                {agent.response}
              </div>
            </div>
          )}

          {/* Tool Execution Steps */}
          {Array.isArray(agent.actions_taken) && agent.actions_taken.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-[10px] font-bold text-purple-900 uppercase tracking-wide">
                🛠️ Pluggable Tools Executed ({agent.actions_taken.length}):
              </p>
              {agent.actions_taken.map((act, actIdx) => {
                const tMeta = AGENT_TOOLS.find((x) => x.id === act.tool);
                return (
                  <div key={actIdx} className="bg-white rounded-xl p-2 border border-slate-200 text-[10px]">
                    <div className="flex items-center justify-between mb-1 pb-1 border-b border-slate-100">
                      <span className="font-bold text-purple-800 flex items-center gap-1">
                        <span>{tMeta?.icon || '⚙️'}</span>
                        <span>Step {act.step || actIdx + 1}: {tMeta?.label || act.tool}</span>
                      </span>
                      <span className="text-[9px] text-slate-400 font-mono">tool: {act.tool}</span>
                    </div>
                    {(act.args !== undefined || act.action_input !== undefined) && (
                      <div className="mt-1">
                        <span className="text-slate-500 font-medium text-[9px]">Input arguments:</span>
                        <pre className="text-[9px] font-mono whitespace-pre-wrap break-all bg-slate-50 p-1.5 rounded-lg mt-0.5 max-h-28 overflow-auto border border-slate-100">
                          {JSON.stringify(act.args ?? act.action_input, null, 2)}
                        </pre>
                      </div>
                    )}
                    {act.result !== undefined && (
                      <div className="mt-1.5">
                        <span className="text-emerald-600 font-medium text-[9px]">Tool output result:</span>
                        <pre className="text-[9px] font-mono whitespace-pre-wrap break-all bg-emerald-50/60 p-1.5 rounded-lg mt-0.5 max-h-28 overflow-auto border border-emerald-100">
                          {JSON.stringify(act.result, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-[10px] text-slate-500 italic bg-white p-1.5 rounded-lg border border-purple-100">
              Agent answered directly without needing external tools in this run.
            </div>
          )}
        </div>
      )}

      {isDecision && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-2 space-y-1">
          <p className="text-[11px] font-bold text-indigo-900 flex items-center gap-1">
            🧠 Decision Engine Classification
          </p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-indigo-700">Selected Route:</span>
            <span className="px-2 py-0.5 rounded-md bg-indigo-600 text-white font-bold text-[10px]">
              {r.output?.route || r.output?.decision?.route || 'route'}
            </span>
            {r.output?.decision?.branch !== undefined && (
              <span className="text-[9px] text-indigo-600 font-mono">branch {r.output.decision.branch}</span>
            )}
            {Number.isFinite(Number(r.output?.decision?.confidence)) && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white border border-indigo-200 text-indigo-700 font-mono">
                confidence {Math.round(Number(r.output.decision.confidence) * 100)}%
              </span>
            )}
            {r.output?.decision?.fallback === true && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">fallback</span>
            )}
          </div>
        </div>
      )}

      {/* Raw JSON Details (always accessible) */}
      <details className="mt-1">
        <summary className="text-[10px] text-normal-text cursor-pointer hover:text-main-blue font-medium">
          {isAgent ? 'Raw JSON (input & output protocol)' : 'Data details'}
        </summary>
        <div className="mt-1 space-y-1">
          <p className="text-[10px] text-normal-text">input</p>
          <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-background rounded-lg p-1.5 max-h-32 overflow-auto">
            {JSON.stringify(r.input, null, 2)?.slice(0, 1500)}
          </pre>
          <p className="text-[10px] text-normal-text">output</p>
          <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-background rounded-lg p-1.5 max-h-32 overflow-auto">
            {JSON.stringify(r.output, null, 2)?.slice(0, 1500)}
          </pre>
        </div>
      </details>
    </div>
  );
}

function rowInputCls() {
  return 'w-full px-2 py-1.5 rounded-xl border border-slate-200 text-xs outline-none';
}

function NodeForm({
  node, onPatch, workflowId, headers, nodes, connections,
  onDecisionRoutes, onRemoveDecisionRoute, onMoveDecisionRoute, onRemoveAuxEdge,
  onConnectTool, onConnectModel,
}) {
  const p = node.parameters || {};
  switch (node.type) {
    case 'code':
    case 'n8n-nodes-base.code':
      return <CodeForm params={p} onPatch={onPatch} />;
    case 'httpRequest':
    case 'n8n-nodes-base.httpRequest':
      return <HttpForm params={p} onPatch={onPatch} headers={headers} />;
    case 'set':
    case 'n8n-nodes-base.set':
      return <SetForm params={p} onPatch={onPatch} />;
    case 'if':
    case 'n8n-nodes-base.if':
      return <IfForm params={p} onPatch={onPatch} />;
    case 'decision':
    case 'decision.route':
    case 'synapseflow.decision':
    case 'synapseone.decision':
    case 'n8n-nodes-base.decision':
      return (
        <DecisionForm
          params={p}
          onPatch={onPatch}
          nodeName={node.name}
          connections={connections}
          onRoutesChange={(routes) => onDecisionRoutes?.(node.name, routes)}
          onRemoveRoute={(index) => onRemoveDecisionRoute?.(node.name, index)}
          onMoveRoute={(index, dir) => onMoveDecisionRoute?.(node.name, index, dir)}
        />
      );
    case 'ai.agent':
    case 'synapseflow.aiAgent':
    case 'synapseone.aiAgent':
    case 'agent':
    case 'n8n-nodes-base.aiAgent':
      return (
        <AiAgentForm
          params={p}
          onPatch={onPatch}
          headers={headers}
          nodeName={node.name}
          nodes={nodes}
          connections={connections}
          onRemoveAuxEdge={onRemoveAuxEdge}
          onConnectTool={(from) => onConnectTool?.(from, node.name)}
          onConnectModel={(from) => onConnectModel?.(from, node.name)}
        />
      );
    case 'synapseflow.model':
    case 'synapseone.model':
      return <ModelForm params={p} onPatch={onPatch} />;
    case 'synapseone.iam':
    case 'synapseone.base':
    case 'synapseone.faststore':
    case 'synapseone.queue':
    case 'synapseone.lds':
    case 'synapseone.inference':
    case 'synapseone.flow':
      return <IntegrationForm type={node.type} params={p} onPatch={onPatch} />;
    case 'synapseone.api':
      return <SynapseOneApiForm params={p} onPatch={onPatch} />;
    case 'webhook':
    case 'n8n-nodes-base.webhook':
      return <WebhookForm params={p} onPatch={onPatch} headers={headers} />;
    case 'cron':
    case 'n8n-nodes-base.cron':
      return <CronForm params={p} onPatch={onPatch} />;
    default:
      return <p className="text-[11px] text-normal-text">No extra fields for this node — use Advanced JSON below if needed.</p>;
  }
}

function CodeForm({ params, onPatch }) {
  const code = typeof params.code === 'string' ? params.code : typeof params.jsCode === 'string' ? params.jsCode : '';
  return (
    <div className="space-y-2">
      <CodeEditor
        value={code}
        onChange={(v) => onPatch({ code: v })}
        placeholder="return { ...$input, doubled: ($input.value ?? 0) * 2 };"
        example="return { ...$input, doubled: ($input.value ?? 0) * 2, at: $now };"
        docs={<CodeDocs />}
      />
      <RetryTimeout params={params} onPatch={onPatch} kinds="code" />
    </div>
  );
}

/** Account-scoped credential picker (P0-4): nodes store only the
 *  credentialId — secrets never touch node params or the browser history. */
function CredentialPicker({ headers, value, onChange, allowKinds }) {
  const [accountId, setAccountId] = useState(() => {
    try { return localStorage.getItem('synapseone.credAccount') || ''; } catch { return ''; }
  });
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [nm, setNm] = useState('');
  const [kind, setKind] = useState((allowKinds && allowKinds[0]) || 'bearer');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const kinds = allowKinds || ['bearer', 'api-key', 'basic', 'hmac'];

  const load = async (acc) => {
    setErr(null);
    try {
      const r = await api.credentials(acc || undefined, headers);
      const list = Array.isArray(r) ? r : r?.data || [];
      setItems(list);
    } catch (e) {
      setItems(null);
      setErr(e);
    }
  };
  useEffect(() => { load(accountId); }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveAcc = (v) => {
    setAccountId(v);
    try { localStorage.setItem('synapseone.credAccount', v); } catch { /* ignore */ }
  };
  const create = async () => {
    if (busy || !nm.trim() || !secret) return;
    setBusy(true);
    setErr(null);
    try {
      const c = await api.createCredential(accountId, nm.trim(), kind, secret, headers);
      setNm('');
      setSecret('');
      setShowNew(false);
      await load(accountId);
      if (c?.id) onChange(c.id);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id) => {
    if (!window.confirm('Delete this credential? Nodes referencing it will fail at run time.')) return;
    try {
      await api.deleteCredential(id, headers);
      if (value === id) onChange(undefined);
      await load(accountId);
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div>
      <label className="block text-xs text-normal-text mb-1">Credential (secret stays server-side)</label>
      <input
        value={accountId}
        onChange={(e) => saveAcc(e.target.value)}
        placeholder="account id (blank in dev)"
        aria-label="Credential account id"
        className={`${rowInputCls()} font-mono mb-1`}
      />
      <div className="flex gap-1">
        <select
          value={value || ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={`${rowInputCls()} font-mono`}
          title="Nodes store only this id"
        >
          <option value="">— none (no auth) —</option>
          {(items || []).map((c) => (
            <option key={c.id} value={c.id}>{c.name} [{c.kind}]</option>
          ))}
        </select>
        <button onClick={() => setShowNew((v) => !v)} title="Create a credential" className="px-2 py-1 rounded-xl text-[11px] bg-slate-100 shrink-0">New</button>
      </div>
      {err && <p className="text-[11px] text-red-500 mt-1 break-words">{err.message || String(err)}</p>}
      {value && <p className="text-[11px] text-normal-text mt-1 font-mono break-all">id: {value}</p>}
      {items && value && !items.some((c) => c.id === value) && (
        <p className="text-[11px] text-amber-600 mt-1">Referenced id is not in this account — runs will fail until fixed.</p>
      )}
      {showNew && (
        <div className="mt-1 rounded-xl border border-slate-200 p-2 space-y-1">
          <input value={nm} onChange={(e) => setNm(e.target.value)} placeholder="name (unique per account)" aria-label="Credential name" className={rowInputCls()} />
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={rowInputCls()} aria-label="Credential kind">
            {kinds.map((k) => <option key={k} value={k}>{k}{k === 'basic' ? ' ({username,password} JSON)' : ''}</option>)}
          </select>
          <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={kind === 'basic' ? '{"username":"u","password":"p"}' : 'secret value'} type="password" autoComplete="new-password" aria-label="Credential secret" className={`${rowInputCls()} font-mono`} />
          <button onClick={create} disabled={busy || !nm.trim() || !secret || !accountId} title={!accountId ? 'Enter the account id first' : 'Save encrypted server-side'} className="px-2 py-1 rounded-xl text-[11px] bg-main-blue/10 text-main-blue disabled:opacity-60 disabled:cursor-wait inline-flex items-center gap-1.5">
            {busy && <span className="sdx-spinner h-3 w-3 border-2" />}
            {busy ? 'Saving…' : 'Save credential'}
          </button>
        </div>
      )}
      {(items || []).length > 0 && (
        <div className="mt-1">
          {items.map((c) => (
            <div key={c.id} className="flex items-center gap-1 text-[11px] text-normal-text">
              <span className="font-mono truncate">{c.name} [{c.kind}]</span>
              <button onClick={() => remove(c.id)} title={`Delete ${c.name}`} className="ml-auto text-red-500 px-1">×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Per-node retry/timeout inputs (P2): httpRequest + code. */
function RetryTimeout({ params, onPatch, kinds }) {
  const retry = params.retry && typeof params.retry === 'object' ? params.retry : {};
  const setRetry = (k, v) => {
    const next = { ...retry };
    if (v === '' || v === undefined) delete next[k];
    else next[k] = v;
    onPatch({ retry: Object.keys(next).length ? next : undefined });
  };
  return (
    <div className="rounded-xl border border-slate-100 p-2">
      <p className="text-[11px] font-medium text-normal-text mb-1">RELIABILITY</p>
      <div className="flex gap-1">
        <label className="flex-1 text-[11px] text-normal-text">Attempts (1–5)
          <input value={retry.attempts ?? ''} onChange={(e) => setRetry('attempts', e.target.value === '' ? undefined : Math.min(5, Math.max(1, Number(e.target.value) || 1)))} type="number" min="1" max="5" className={rowInputCls()} />
        </label>
        <label className="flex-1 text-[11px] text-normal-text">Retry delay ms
          <input value={retry.delayMs ?? ''} onChange={(e) => setRetry('delayMs', e.target.value === '' ? undefined : Math.max(0, Number(e.target.value) || 0))} type="number" min="0" className={rowInputCls()} />
        </label>
        <label className="flex-1 text-[11px] text-normal-text">Timeout ms
          <input value={params.timeoutMs ?? ''} onChange={(e) => onPatch({ timeoutMs: e.target.value === '' ? undefined : Number(e.target.value) || undefined })} type="number" min="1000" placeholder={kinds === 'code' ? '5000' : '15000'} className={rowInputCls()} />
        </label>
      </div>
    </div>
  );
}

function HttpForm({ params, onPatch, headers }) {
  const headersObj = params.headers && typeof params.headers === 'object' && !Array.isArray(params.headers) ? params.headers : {};
  const rows = Object.entries(headersObj);
  const setHeader = (k, v) => {
    const next = { ...headersObj };
    if (!k) return;
    next[k] = v;
    onPatch({ headers: next });
  };
  const delHeader = (k) => {
    const next = { ...headersObj };
    delete next[k];
    onPatch({ headers: next });
  };
  const auth = params.auth && typeof params.auth === 'object' ? params.auth : {};
  const setAuth = (k, v) => {
    const next = { ...auth };
    if (v === undefined || v === '') delete next[k];
    else next[k] = v;
    onPatch({ auth: Object.keys(next).length ? next : undefined });
  };
  const body = typeof params.body === 'string' ? params.body : params.body !== undefined ? JSON.stringify(params.body, null, 2) : '';
  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs text-normal-text mb-1">URL (public https, or allowlisted self origin)</label>
        <input value={params.url || ''} onChange={(e) => onPatch({ url: e.target.value })} placeholder="https://api.example.com/health" className={rowInputCls()} />
      </div>
      <div>
        <label className="block text-xs text-normal-text mb-1">Method</label>
        <select value={params.method || 'GET'} onChange={(e) => onPatch({ method: e.target.value })} className={rowInputCls()}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div className="rounded-xl border border-slate-100 p-2">
        <p className="text-[11px] font-medium text-normal-text mb-1">AUTH (credential id only — never paste secrets here)</p>
        <CredentialPicker headers={headers} value={auth.credentialId} onChange={(id) => setAuth('credentialId', id)} />
        {auth.credentialId && (
          <label className="block text-[11px] text-normal-text mt-1">Custom header name (api-key kind only)
            <input value={auth.header || ''} onChange={(e) => setAuth('header', e.target.value)} placeholder="X-API-Key" className={`${rowInputCls()} font-mono mt-0.5`} />
          </label>
        )}
      </div>
      <div>
        <label className="block text-xs text-normal-text mb-1">Headers</label>
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-1 mb-1">
            <input value={k} disabled className={`${rowInputCls()} font-mono`} title="Header name (delete + re-add to rename)" />
            <input value={String(v)} onChange={(e) => setHeader(k, e.target.value)} placeholder="avoid secrets — use Auth above" className={rowInputCls()} />
            <button onClick={() => delHeader(k)} title="Remove header" className="px-2 text-red-500">×</button>
          </div>
        ))}
        <HeaderAdder onAdd={setHeader} />
      </div>
      <div>
        <label className="block text-xs text-normal-text mb-1">Body (POST/PUT/PATCH — JSON or template)</label>
        <textarea value={body} onChange={(e) => onPatch({ body: e.target.value })} rows={3} spellCheck={false} placeholder='{"key": "={{ $json.value }}"}' className="w-full px-2 py-1.5 rounded-xl border border-slate-200 text-xs font-mono outline-none" />
      </div>
      <RetryTimeout params={params} onPatch={onPatch} kinds="http" />
    </div>
  );
}

function HeaderAdder({ onAdd }) {
  const [k, setK] = useState('');
  const [v, setV] = useState('');
  return (
    <div className="flex gap-1">
      <input value={k} onChange={(e) => setK(e.target.value)} placeholder="X-Token" className={rowInputCls()} />
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="value" className={rowInputCls()} />
      <button
        onClick={() => { if (k.trim()) { onAdd(k.trim(), v); setK(''); setV(''); } }}
        className="px-2 py-1 rounded-xl text-[11px] bg-slate-100"
      >
        Add
      </button>
    </div>
  );
}

function SetForm({ params, onPatch }) {
  const values = params.values && typeof params.values === 'object' && !Array.isArray(params.values) ? params.values : {};
  const rows = Object.entries(values);
  const setRow = (k, v) => onPatch({ values: { ...values, [k]: v } });
  const delRow = (k) => {
    const next = { ...values };
    delete next[k];
    onPatch({ values: next });
  };
  const [nk, setNk] = useState('');
  const [nv, setNv] = useState('');
  return (
    <div>
      <label className="block text-xs text-normal-text mb-1">Fields (merged over input — supports ={'{{'} $json.x {'}}'})</label>
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-1 mb-1">
          <input value={k} disabled className={`${rowInputCls()} font-mono`} title="Field name (delete + re-add to rename)" />
          <input value={typeof v === 'string' ? v : JSON.stringify(v)} onChange={(e) => setRow(k, e.target.value)} placeholder="value or ={{ $json.x }}" className={`${rowInputCls()} font-mono`} />
          <button onClick={() => delRow(k)} title="Remove field" className="px-2 text-red-500">×</button>
        </div>
      ))}
      <div className="flex gap-1">
        <input value={nk} onChange={(e) => setNk(e.target.value)} placeholder="newKey" className={rowInputCls()} />
        <input value={nv} onChange={(e) => setNv(e.target.value)} placeholder='value or ={{ $json.x }}' className={`${rowInputCls()} font-mono`} />
        <button onClick={() => { if (nk.trim()) { setRow(nk.trim(), nv); setNk(''); setNv(''); } }} className="px-2 py-1 rounded-xl text-[11px] bg-slate-100">Add</button>
      </div>
    </div>
  );
}

const SYNAPSEONE_API = {
  // IAM
  orgs: { ops: ['list'], fields: { list: [] }, hint: 'All organizations you can see' },
  users: { ops: ['list'], fields: { list: ['orgId'] }, hint: 'Users in an org (orgId required)' },
  roles: { ops: ['list'], fields: { list: ['accountId'] }, hint: 'Roles in an account' },
  policies: { ops: ['list'], fields: { list: ['accountId'] }, hint: 'Policies in an account' },
  authorize: { ops: ['check'], fields: { check: ['userId', 'action', 'resource'] }, hint: 'Ask: may this user do this action?' },
  audit: { ops: ['query'], fields: { query: ['limit'] }, hint: 'Recent authorize decisions (limit 1..200)' },
  keys: { ops: ['list'], fields: { list: ['accountId'] }, hint: 'API key metadata (never secrets)' },
  'service-accounts': { ops: ['list'], fields: { list: ['accountId'] }, hint: 'Machine identities in an account' },
  // Workflows & Flow
  workflows: { ops: ['list', 'get'], fields: { list: [], get: ['id'] }, hint: 'SynapseFlow: workflows you can access' },
  executions: { ops: ['list', 'get'], fields: { list: [], get: ['id'] }, hint: 'SynapseFlow: run history' },
  templates: { ops: ['list', 'get'], fields: { list: [], get: ['name'] }, hint: 'SynapseFlow: starters' },
  // Sub-services
  base: {
    ops: ['list-collections', 'create-document', 'get-document', 'query-documents', 'vector-search', 'delete-document'],
    fields: {
      'list-collections': [],
      'create-document': ['collection'],
      'get-document': ['collection', 'id'],
      'query-documents': ['collection'],
      'vector-search': ['collection'],
      'delete-document': ['collection', 'id'],
    },
    hint: 'SynapseBase: JSON document database',
  },
  faststore: {
    ops: ['get', 'set', 'incr', 'delete', 'hash-get', 'hash-set'],
    fields: {
      get: ['key'],
      set: ['key', 'value'],
      incr: ['key'],
      delete: ['key'],
      'hash-get': ['key'],
      'hash-set': ['key', 'values'],
    },
    hint: 'Synapse Faststore: ultra-fast in-memory cache and key-value store',
  },
  queue: {
    ops: ['list', 'publish', 'consume', 'ack'],
    fields: {
      list: [],
      publish: ['queue', 'payload'],
      consume: ['queue'],
      ack: ['queue', 'receipt'],
    },
    hint: 'SynapseQueue: reliable message queue with delayed delivery and receipts',
  },
  inference: {
    ops: ['chat', 'embeddings', 'decision', 'route'],
    fields: {
      chat: ['messages'],
      embeddings: ['input'],
      decision: ['state', 'questions'],
      route: ['input', 'choices'],
    },
    hint: 'Synapse Inference Engine: LLMs, embeddings, and Decision-2.0-Eos-0.8B SLMs',
  },
  lds: {
    ops: ['list-datasources', 'publish-record', 'get-entity'],
    fields: {
      'list-datasources': [],
      'publish-record': ['datasourceId'],
      'get-entity': ['datasourceId', 'entityId'],
    },
    hint: 'SynapseLDS: Linked Data Store (NGSI-LD / smart data models)',
  },
};

function AiAgentForm({ params, onPatch, nodeName, nodes, connections, onRemoveAuxEdge, onConnectTool, onConnectModel }) {
  const core = params.core || 'synapse-inference';
  const model = params.model || (core === 'synapse-inference' ? 'liquid/lfm-2.5-2.6b:free' : 'gpt-4o-mini');
  const tools = Array.isArray(params.tools) ? params.tools : DEFAULT_AGENT_TOOLS;
  const maxSteps = Number(params.maxSteps) || 6;
  const canvasTools = nodeName ? toolEdgesForAgent(connections || {}, nodeName).map((e) => e.from) : [];
  const modelSource = nodeName ? modelEdgeForAgent(connections || {}, nodeName) : null;
  const modelNode = modelSource ? (nodes || []).find((n) => n.name === modelSource.from) : null;
  const toolCandidates = (nodes || []).filter((n) => n.name !== nodeName && !canvasTools.includes(n.name) && !isAiAgentType(n.type) && !isModelType(n.type));
  const modelCandidates = (nodes || []).filter((n) => isModelType(n.type));

  const toggleTool = (toolId) => {
    const next = tools.includes(toolId) ? tools.filter((t) => t !== toolId) : [...tools, toolId];
    onPatch({ tools: next });
  };

  return (
    <div className="space-y-3">
      <div className="p-2.5 rounded-xl bg-purple-50 border border-purple-200 text-[11px] text-purple-900 leading-snug">
        <p className="font-bold mb-1">🤖 Autonomous AI Agent</p>
        <p className="text-purple-800 text-[10px]">Native tool calling is enabled. Wire any canvas node — SynapseBase, Faststore, IAM, HTTP, Code, Decision — into the <b>Tools</b> socket and the model can call it. A <b>Model Core</b> wired into the Model socket overrides the inline model below.</p>
      </div>

      <div>
        <label className="block text-xs font-semibold text-main-text mb-1">Core AI Engine</label>
        <select
          value={core}
          onChange={(e) => {
            const nextCore = e.target.value;
            onPatch({
              core: nextCore,
              model: nextCore === 'synapse-inference' ? 'liquid/lfm-2.5-2.6b:free' : 'gpt-4o-mini',
              baseUrl: nextCore === 'synapse-inference' ? undefined : 'https://api.openai.com/v1',
            });
          }}
          className={rowInputCls()}
        >
          <option value="synapse-inference">Synapse Inference Engine (default)</option>
          <option value="openai-compatible">OpenAI-compatible API (custom provider)</option>
        </select>
      </div>

      <div>
        <label className="block text-xs text-normal-text mb-1">Model {modelNode && <span className="text-indigo-600">— overridden by “{modelNode.name}”</span>}</label>
        <input value={model} onChange={(e) => onPatch({ model: e.target.value })} placeholder={core === 'synapse-inference' ? 'liquid/lfm-2.5-2.6b:free' : 'gpt-4o-mini'} className={`${rowInputCls()} font-mono`} />
        {modelNode && <p className="text-[10px] text-indigo-600 mt-0.5 font-mono">socket: {modelNode.parameters?.core || 'synapse-inference'} · {modelNode.parameters?.model || 'default'}</p>}
      </div>

      {core === 'openai-compatible' && (
        <>
          <div>
            <label className="block text-xs text-normal-text mb-1">Base URL</label>
            <input value={params.baseUrl || 'https://api.openai.com/v1'} onChange={(e) => onPatch({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" className={`${rowInputCls()} font-mono`} />
          </div>
          <div>
            <label className="block text-xs text-normal-text mb-1">API Key</label>
            <input type="password" value={params.apiKey || ''} onChange={(e) => onPatch({ apiKey: e.target.value })} placeholder="sk-..." className={`${rowInputCls()} font-mono`} />
          </div>
        </>
      )}

      <div>
        <label className="block text-xs text-normal-text mb-1">User prompt / task</label>
        <textarea value={params.userPrompt || params.prompt || ''} onChange={(e) => onPatch({ userPrompt: e.target.value, prompt: undefined })} placeholder="={{ $json.message || 'Analyze the input and take the next step' }}" rows={3} className={`${rowInputCls()} font-mono`} />
        <p className="text-[10px] text-normal-text mt-0.5">Supports ={'{{'} $json.field {'}}'} expressions and workflow data.</p>
      </div>

      <div>
        <label className="block text-xs text-normal-text mb-1">System prompt / instructions</label>
        <textarea value={params.systemPrompt || ''} onChange={(e) => onPatch({ systemPrompt: e.target.value })} placeholder="You are an autonomous agent. Use tools to retrieve real data before answering." rows={3} className={rowInputCls()} />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-xs font-semibold text-main-text">Built-in tools ({tools.length}/{AGENT_TOOLS.length})</label>
          <div className="flex gap-1.5 text-[10px]">
            <button onClick={() => onPatch({ tools: AGENT_TOOLS.map((t) => t.id) })} className="text-purple-600 hover:underline font-medium">Select all</button>
            <span className="text-slate-300">·</span>
            <button onClick={() => onPatch({ tools: [] })} className="text-slate-500 hover:underline">Clear</button>
          </div>
        </div>
        <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
          {AGENT_TOOLS.map((tool) => {
            const active = tools.includes(tool.id);
            return (
              <label key={tool.id} onClick={() => toggleTool(tool.id)} className={`flex items-start gap-2 p-1.5 rounded-xl border text-xs cursor-pointer transition-colors ${active ? 'bg-purple-50/50 border-purple-200 text-main-text shadow-2xs' : 'bg-white border-slate-200 text-normal-text opacity-70 hover:opacity-100'}`}>
                <input type="checkbox" checked={active} onChange={() => {}} className="mt-0.5 rounded text-purple-600 focus:ring-purple-500" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-[11px] leading-tight flex items-center gap-1.5">
                    <span>{tool.icon}</span><span className="font-semibold">{tool.label}</span>
                    <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-slate-100 text-slate-600 ml-auto">{tool.group}</span>
                  </div>
                  <div className="text-[10px] text-normal-text leading-tight mt-0.5">{tool.desc}</div>
                </div>
              </label>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-purple-200 bg-purple-50/40 p-2">
        <div className="flex items-center justify-between gap-1 mb-1">
          <label className="text-xs font-semibold text-purple-900">Canvas tools ({canvasTools.length})</label>
          {toolCandidates.length > 0 && (
            <select
              value=""
              onChange={(e) => { if (e.target.value) onConnectTool?.(e.target.value); }}
              className="px-1.5 py-1 rounded-lg border border-purple-200 text-[10px] bg-white max-w-[130px]"
              title="Expose another canvas node as a tool"
            >
              <option value="">+ wire node…</option>
              {toolCandidates.map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
            </select>
          )}
        </div>
        {canvasTools.length === 0 ? (
          <p className="text-[10px] text-purple-800/80 leading-snug">Drag a node&apos;s output into the purple <b>Tools</b> socket under this card, or pick a node above. Node tools receive the model&apos;s arguments as <code>$json</code>.</p>
        ) : (
          <div className="space-y-1">
            {canvasTools.map((from) => (
              <div key={from} className="flex items-center gap-1.5 px-1.5 py-1 rounded-lg bg-white border border-purple-200 text-[11px]">
                <span>🧩</span><span className="font-medium truncate">{from}</span>
                <button onClick={() => onRemoveAuxEdge?.(from, nodeName, 'tools')} className="ml-auto text-red-500 px-1" title="Disconnect this tool">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-2">
        <div className="flex items-center justify-between gap-1 mb-1">
          <label className="text-xs font-semibold text-indigo-900">Model socket</label>
          {modelCandidates.length > 0 && (
            <select value="" onChange={(e) => { if (e.target.value) onConnectModel?.(e.target.value); }} className="px-1.5 py-1 rounded-lg border border-indigo-200 text-[10px] bg-white max-w-[150px]" title="Wire a model source">
              <option value="">+ wire model…</option>
              {modelCandidates.map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
            </select>
          )}
        </div>
        {modelNode ? (
          <div className="flex items-center gap-1.5 px-1.5 py-1 rounded-lg bg-white border border-indigo-200 text-[11px]">
            <span>🧠</span><span className="font-medium truncate">{modelNode.name}</span>
            <span className="text-[9px] text-normal-text truncate">{modelNode.parameters?.model || ''}</span>
            <button onClick={() => onRemoveAuxEdge?.(modelNode.name, nodeName, 'model')} className="ml-auto text-red-500 px-1" title="Disconnect model source">×</button>
          </div>
        ) : (
          <p className="text-[10px] text-indigo-800/80 leading-snug">Optional. Wire a <b>Model Core</b> into the indigo <b>Model</b> socket to centralize model/provider configuration.</p>
        )}
      </div>

      <div>
        <label className="block text-xs text-normal-text mb-1">Max tool iterations</label>
        <input type="number" min={1} max={12} value={maxSteps} onChange={(e) => onPatch({ maxSteps: Math.min(12, Math.max(1, parseInt(e.target.value, 10) || 6)) })} className={rowInputCls()} />
      </div>
      <div>
        <label className="block text-xs text-normal-text mb-1">Temperature</label>
        <input type="number" min={0} max={2} step={0.1} value={params.temperature ?? 0.2} onChange={(e) => onPatch({ temperature: Math.min(2, Math.max(0, Number(e.target.value))) })} className={rowInputCls()} />
      </div>
    </div>
  );
}

function DecisionForm({ params, onPatch, nodeName, connections, onRoutesChange, onRemoveRoute, onMoveRoute }) {
  const routes = decisionRoutes(params);
  const [draft, setDraft] = useState(() => routes.map((r) => ({ ...r })));
  const sig = JSON.stringify(routes);
  useEffect(() => {
    setDraft(routes.map((r) => ({ ...r })));
  }, [nodeName, sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const wiredBranches = Array.isArray(connections?.[nodeName]?.main)
    ? connections[nodeName].main.map((b) => (Array.isArray(b) ? b.filter((e) => !edgeTargetPort(e)).length : 0))
    : [];

  const commitRows = (rows) => {
    const clean = rows.map((r, i) => ({ name: String(r.name || `route_${i}`).trim(), description: String(r.description || '') }));
    setDraft(clean);
    onRoutesChange?.(clean);
  };
  const rename = (i, value) => {
    const name = value.trim();
    if (!name) { setDraft(routes.map((r) => ({ ...r }))); return; }
    if (draft.some((r, idx) => idx !== i && r.name === name)) {
      setDraft(routes.map((r) => ({ ...r })));
      return;
    }
    commitRows(draft.map((r, idx) => (idx === i ? { ...r, name } : r)));
  };
  const describe = (i, value) => commitRows(draft.map((r, idx) => (idx === i ? { ...r, description: value } : r)));
  const add = () => {
    if (draft.length >= 20) return;
    let i = draft.length;
    let name = `route_${i}`;
    const used = new Set(draft.map((r) => r.name));
    while (used.has(name)) name = `route_${++i}`;
    const next = [...draft, { name, description: '' }];
    setDraft(next);
    onRoutesChange?.(next);
  };
  const remove = (i) => {
    if (draft.length <= 1) return;
    setDraft(draft.filter((_, idx) => idx !== i));
    onRemoveRoute?.(i);
  };
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= draft.length) return;
    const next = draft.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
    onMoveRoute?.(i, dir);
  };
  const fb = Number.isFinite(Number(params.fallbackBranch)) ? Math.min(routes.length - 1, Math.max(0, Number(params.fallbackBranch))) : 0;

  return (
    <div className="space-y-3">
      <div className="p-2 rounded-xl bg-indigo-50 border border-indigo-100 text-[11px] text-indigo-900 leading-tight">
        Powered by <b>Decision-2.0-Eos-0.8B</b>. Each route has its own output port on the canvas. Edges stay attached to a route when you rename it; adding/removing/reordering remaps branches safely.
      </div>

      <div>
        <label className="block text-xs text-normal-text mb-1">Input text to evaluate</label>
        <input value={params.input || ''} onChange={(e) => onPatch({ input: e.target.value })} placeholder="={{ $json.query || $json.text || $json.message }}" className={`${rowInputCls()} font-mono`} />
      </div>

      <div>
        <label className="block text-xs text-normal-text mb-1">Instruction / context</label>
        <input value={params.instruction || ''} onChange={(e) => onPatch({ instruction: e.target.value })} placeholder="Route this request to the most suitable team" className={rowInputCls()} />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-xs font-semibold text-main-text">Routes ({draft.length})</label>
          <button onClick={add} disabled={draft.length >= 20} title={draft.length >= 20 ? 'Decision Engine supports at most 20 routes' : 'Add another route'} className="px-2 py-1 rounded-lg text-[10px] font-semibold bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-40">+ Add route</button>
        </div>
        <div className="space-y-1.5">
          {draft.map((r, i) => (
            <div key={i} className={`rounded-xl border p-1.5 ${wiredBranches[i] ? 'border-emerald-200 bg-emerald-50/30' : 'border-slate-200 bg-white'}`}>
              <div className="flex items-center gap-1">
                <span className="w-5 h-5 rounded-md bg-indigo-100 text-indigo-700 text-[9px] font-bold flex items-center justify-center shrink-0">{i}</span>
                <input
                  defaultValue={r.name}
                  key={`${nodeName}:${i}:${r.name}`}
                  onBlur={(e) => rename(i, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  className="flex-1 min-w-0 px-1.5 py-1 rounded-lg border border-slate-200 text-[11px] font-medium outline-none focus:border-indigo-400"
                  placeholder="route name"
                />
                <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up" className="w-5 h-5 rounded text-[10px] text-slate-500 hover:bg-slate-100 disabled:opacity-25">↑</button>
                <button onClick={() => move(i, 1)} disabled={i === draft.length - 1} title="Move down" className="w-5 h-5 rounded text-[10px] text-slate-500 hover:bg-slate-100 disabled:opacity-25">↓</button>
                <button onClick={() => remove(i)} disabled={draft.length <= 1} title="Remove route (its wires move to the fallback route)" className="w-5 h-5 rounded text-[10px] text-red-500 hover:bg-red-50 disabled:opacity-25">×</button>
              </div>
              <input
                defaultValue={r.description}
                key={`${nodeName}:${i}:desc:${r.description}`}
                onBlur={(e) => describe(i, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                className="w-full mt-1 px-1.5 py-1 rounded-lg border border-slate-100 text-[10px] text-normal-text outline-none focus:border-indigo-300"
                placeholder="What belongs in this route? (used by the SLM)"
              />
              <p className="text-[9px] mt-0.5 text-right">
                <span className={wiredBranches[i] ? 'text-emerald-600' : 'text-amber-600'}>{wiredBranches[i] ? `output ${i}: wired` : `output ${i}: not wired yet`}</span>
              </p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs text-normal-text mb-1">Fallback route</label>
        <select value={fb} onChange={(e) => onPatch({ fallbackBranch: Number(e.target.value) })} className={rowInputCls()}>
          {routes.map((r, i) => <option key={`${r.name}:${i}`} value={i}>{i} — {r.name}</option>)}
        </select>
        <p className="text-[10px] text-normal-text mt-0.5">Used when the model is uncertain or returns an unknown route.</p>
      </div>

      <div>
        <label className="block text-xs text-normal-text mb-1">Minimum confidence: {Math.round((Number(params.minConfidence) || 0) * 100)}%</label>
        <input type="range" min={0} max={1} step={0.05} value={params.minConfidence ?? 0} onChange={(e) => onPatch({ minConfidence: Number(e.target.value) })} className="w-full accent-indigo-600" />
        <p className="text-[10px] text-normal-text mt-0.5">Below this threshold the route falls back automatically. 0 accepts every prediction.</p>
      </div>
    </div>
  );
}

function ModelForm({ params, onPatch }) {
  const core = params.core || 'synapse-inference';
  const model = params.model || (core === 'synapse-inference' ? 'liquid/lfm-2.5-2.6b:free' : 'gpt-4o-mini');
  return (
    <div className="space-y-3">
      <div className="p-2 rounded-xl bg-indigo-50 border border-indigo-100 text-[11px] text-indigo-900">
        Wire this <b>Model Core</b> into an AI Agent&apos;s <b>Model</b> socket to provide its model/provider settings.
      </div>
      <div>
        <label className="block text-xs text-normal-text mb-1">Engine</label>
        <select value={core} onChange={(e) => onPatch({ core: e.target.value, model: e.target.value === 'synapse-inference' ? 'liquid/lfm-2.5-2.6b:free' : 'gpt-4o-mini' })} className={rowInputCls()}>
          <option value="synapse-inference">Synapse Inference Engine</option>
          <option value="openai-compatible">OpenAI-compatible API</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-normal-text mb-1">Model</label>
        <input value={model} onChange={(e) => onPatch({ model: e.target.value })} className={`${rowInputCls()} font-mono`} />
      </div>
      {core === 'openai-compatible' && (
        <>
          <div>
            <label className="block text-xs text-normal-text mb-1">Base URL</label>
            <input value={params.baseUrl || ''} onChange={(e) => onPatch({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" className={`${rowInputCls()} font-mono`} />
          </div>
          <div>
            <label className="block text-xs text-normal-text mb-1">API key</label>
            <input type="password" value={params.apiKey || ''} onChange={(e) => onPatch({ apiKey: e.target.value })} className={`${rowInputCls()} font-mono`} />
          </div>
        </>
      )}
    </div>
  );
}

const INTEGRATION_UI = {
  'synapseone.iam': {
    label: 'Synapse IAM', hint: 'Identity & authorization. Operation names are prefixed with the resource.',
    operations: [
      { op: 'orgs.list', required: [], optional: [] },
      { op: 'users.list', required: ['orgId'], optional: [] },
      { op: 'roles.list', required: ['accountId'], optional: [] },
      { op: 'policies.list', required: ['accountId'], optional: [] },
      { op: 'authorize.check', required: ['userId', 'action', 'resource'], optional: [] },
      { op: 'audit.query', required: [], optional: ['limit'] },
      { op: 'keys.list', required: ['accountId'], optional: [] },
      { op: 'service-accounts.list', required: ['accountId'], optional: [] },
    ],
  },
  'synapseone.base': {
    label: 'SynapseBase', hint: 'JSON document store.',
    operations: [
      { op: 'list-collections', required: [], optional: [] },
      { op: 'query-documents', required: ['collection'], optional: ['where', 'limit', 'orderBy'] },
      { op: 'vector-search', required: ['collection'], optional: ['query', 'vector', 'limit', 'where', 'field', 'metric'] },
      { op: 'get-document', required: ['collection', 'id'], optional: [] },
      { op: 'create-document', required: ['collection'], optional: ['id', 'data'] },
      { op: 'delete-document', required: ['collection', 'id'], optional: [] },
    ],
  },
  'synapseone.faststore': {
    label: 'Faststore', hint: 'Low-latency cache and key/value store.',
    operations: [
      { op: 'get', required: ['key'], optional: [] },
      { op: 'set', required: ['key', 'value'], optional: ['ttlSeconds'] },
      { op: 'incr', required: ['key'], optional: ['by'] },
      { op: 'delete', required: ['key'], optional: [] },
      { op: 'hash-get', required: ['key'], optional: [] },
      { op: 'hash-set', required: ['key', 'values'], optional: [] },
    ],
  },
  'synapseone.queue': {
    label: 'SynapseQueue', hint: 'Reliable message queue.',
    operations: [
      { op: 'list', required: [], optional: ['queue'] },
      { op: 'publish', required: ['queue', 'payload'], optional: ['priority', 'delaySeconds'] },
      { op: 'consume', required: ['queue'], optional: ['maxMessages', 'consumer'] },
      { op: 'ack', required: ['queue', 'receipt'], optional: [] },
    ],
  },
  'synapseone.lds': {
    label: 'SynapseLDS', hint: 'Linked Data Store (NGSI-LD).',
    operations: [
      { op: 'list-datasources', required: [], optional: [] },
      { op: 'publish-record', required: ['datasourceId'], optional: ['record'] },
      { op: 'get-entity', required: ['datasourceId', 'entityId'], optional: [] },
    ],
  },
  'synapseone.inference': {
    label: 'Synapse Inference', hint: 'LLM chat, embeddings and semantic routing.',
    operations: [
      { op: 'chat', required: ['messages'], optional: ['model', 'temperature', 'max_tokens', 'tools'] },
      { op: 'embeddings', required: ['input'], optional: ['model'] },
      { op: 'decision', required: ['state', 'questions'], optional: [] },
      { op: 'route', required: ['input', 'choices'], optional: ['instruction'] },
    ],
  },
  'synapseone.flow': {
    label: 'SynapseFlow', hint: 'Workflows and execution history. Operation names are prefixed with the resource.',
    operations: [
      { op: 'workflows.list', required: [], optional: [] },
      { op: 'workflows.get', required: ['id'], optional: [] },
      { op: 'workflows.execute', required: ['id'], optional: ['input'] },
      { op: 'executions.list', required: [], optional: ['workflowId', 'limit'] },
      { op: 'executions.get', required: ['id'], optional: [] },
      { op: 'templates.list', required: [], optional: [] },
      { op: 'templates.get', required: ['name'], optional: [] },
    ],
  },
};

const JSON_INPUT_FIELDS = new Set(['where', 'orderBy', 'data', 'values', 'payload', 'record', 'messages', 'choices', 'state', 'questions', 'input', 'tools', 'value', 'questions', 'by', 'vector']);

function defaultIntegrationInput(type, op) {
  const defaults = {
    'synapseone.base': { collection: 'documents', id: '={{ $json.id }}', data: '={{ $json }}', where: {}, limit: 10, query: '={{ $json.query }}', vector: '={{ $json.embedding }}' },
    'synapseone.faststore': { key: '={{ $json.key }}', value: '={{ $json.value }}', ttlSeconds: 3600, by: 1 },
    'synapseone.queue': { queue: 'demo-queue', payload: '={{ $json }}', maxMessages: 10, consumer: 'workflow', receipt: '={{ $json.receipt }}' },
    'synapseone.iam': { orgId: '={{ $json.orgId }}', accountId: '={{ $json.accountId }}', userId: '={{ $json.userId }}', action: 'read', resource: 'support_ticket', limit: 50 },
    'synapseone.lds': { datasourceId: '={{ $json.datasourceId }}', entityId: '={{ $json.entityId }}', record: '={{ $json }}' },
    'synapseone.inference': { messages: [{ role: 'user', content: '={{ $json.query }}' }], input: '={{ $json.query }}', model: 'liquid/lfm-2.5-2.6b:free', choices: { support: 'support request', billing: 'billing question' }, state: {}, questions: [], instruction: 'Choose the best route' },
    'synapseone.flow': { id: '={{ $json.id }}', name: '{{ $json.name }}', workflowId: '={{ $json.workflowId }}', input: '={{ $json }}', limit: 20 },
  };
  const d = defaults[type] || {};
  const spec = INTEGRATION_UI[type];
  const operation = spec?.operations.find((o) => o.op === op);
  const out = {};
  // Prefill required fields plus any optional field we know a safe default
  // for. This keeps common config (query limits, TTLs, record payloads) out
  // of the way while still leaving every optional field editable.
  for (const f of operation?.required || []) out[f] = d[f] !== undefined ? d[f] : `={{ $json.${f} }}`;
  for (const f of operation?.optional || []) if (d[f] !== undefined && out[f] === undefined) out[f] = d[f];
  return out;
}

function IntegrationForm({ type, params, onPatch }) {
  const spec = INTEGRATION_UI[type] || { label: type, hint: '', operations: [] };
  const operation = spec.operations.find((o) => o.op === params.operation) || spec.operations[0];
  const input = params.input && typeof params.input === 'object' && !Array.isArray(params.input) ? params.input : {};
  const fields = operation ? [...operation.required, ...operation.optional] : [];
  const [extraKey, setExtraKey] = useState('');
  const [extraVal, setExtraVal] = useState('');
  const [advText, setAdvText] = useState(() => JSON.stringify(input, null, 2));
  const [advErr, setAdvErr] = useState(null);
  const inputSig = JSON.stringify(input);
  useEffect(() => { setAdvText(JSON.stringify(input, null, 2)); setAdvErr(null); }, [params.operation, inputSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const setField = (name, value) => {
    const next = { ...input, [name]: value };
    if (value === undefined) delete next[name];
    onPatch({ input: next });
  };
  const commitField = (name, text, json) => {
    if (!text.trim()) { const next = { ...input }; delete next[name]; onPatch({ input: next }); return; }
    if (!json) { setField(name, text); return; }
    try {
      setField(name, JSON.parse(text));
    } catch {
      // Primitive values (e.g. Faststore value="hello") are valid too.
      if (/^[\[{]/.test(text.trim())) { setField(name, text); return; }
      setField(name, text);
    }
  };
  const chooseOperation = (op) => {
    onPatch({ operation: op, input: defaultIntegrationInput(type, op) });
  };
  const extraFields = Object.keys(input).filter((k) => !fields.includes(k));
  return (
    <div className="space-y-3">
      <div className="p-2 rounded-xl bg-sky-50 border border-sky-100 text-[11px] text-sky-900 leading-tight">
        <b>{spec.label}</b> — {spec.hint} Runs as the current user through the gateway; no secrets needed.
      </div>
      <div>
        <label className="block text-xs text-normal-text mb-1">Operation</label>
        <select value={operation?.op || ''} onChange={(e) => chooseOperation(e.target.value)} className={rowInputCls()}>
          {spec.operations.map((o) => <option key={o.op} value={o.op}>{o.op}</option>)}
        </select>
      </div>
      {operation && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-normal-text">Input</p>
          {fields.map((f) => {
            const json = JSON_INPUT_FIELDS.has(f);
            return (
              <label key={f} className="block text-[11px] text-normal-text">
                <span className="flex items-center gap-1 mb-0.5"><span className="font-mono">{f}</span>{operation.required.includes(f) && <span className="text-red-500">*</span>}{json && <span className="text-[9px] text-slate-400">JSON</span>}</span>
                <IntegrationField name={f} value={input[f]} json={json} onCommit={(text) => commitField(f, text, json)} />
              </label>
            );
          })}
          {!fields.length && <p className="text-[11px] text-normal-text">This operation needs no input.</p>}
          {extraFields.length > 0 && (
            <div>
              <p className="text-[10px] text-normal-text mt-2 mb-1">Extra fields</p>
              {extraFields.map((f) => (
                <div key={f} className="flex items-center gap-1 mb-1">
                  <span className="flex-1 text-[10px] font-mono truncate">{f}</span>
                  <button onClick={() => setField(f, undefined)} className="text-red-500 px-1 text-[11px]" title="Remove field">×</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-1">
            <input value={extraKey} onChange={(e) => setExtraKey(e.target.value)} placeholder="extra field" className={`${rowInputCls()} font-mono`} />
            <input value={extraVal} onChange={(e) => setExtraVal(e.target.value)} placeholder="value / JSON" className={`${rowInputCls()} font-mono`} />
            <button
              onClick={() => { if (extraKey.trim()) { let v = extraVal; try { v = JSON.parse(extraVal); } catch { /* string */ } setField(extraKey.trim(), v); setExtraKey(''); setExtraVal(''); } }}
              className="px-2 py-1 rounded-xl text-[11px] bg-slate-100 shrink-0"
            >Add</button>
          </div>
        </div>
      )}
      <details>
        <summary className="text-[11px] text-normal-text cursor-pointer hover:text-main-blue">Advanced input JSON</summary>
        <textarea
          value={advText}
          onChange={(e) => { setAdvText(e.target.value); setAdvErr(null); }}
          onBlur={() => {
            try {
              const v = advText.trim() ? JSON.parse(advText) : {};
              if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Input must be a JSON object');
              onPatch({ input: v });
              setAdvErr(null);
            } catch (ex) { setAdvErr(ex.message || 'Invalid JSON'); }
          }}
          rows={6}
          spellCheck={false}
          className="w-full mt-1 px-2 py-1.5 rounded-xl border border-slate-200 text-xs font-mono outline-none"
        />
        {advErr && <p className="text-[11px] text-red-500">{advErr}</p>}
      </details>
      <p className="text-[10px] text-normal-text leading-snug">Values support <code>={'{{ $json.field }}'}</code>. When this node is wired as an agent tool, <code>$json</code> is the model&apos;s tool arguments.</p>
    </div>
  );
}

function IntegrationField({ name, value, json, onCommit }) {
  const textOf = (v) => v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  const [draft, setDraft] = useState(() => textOf(value));
  const sig = textOf(value);
  useEffect(() => { setDraft(sig); }, [name, sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const common = {
    value: draft,
    onChange: (e) => setDraft(e.target.value),
    onBlur: () => { if (draft !== sig) onCommit(draft); },
    onKeyDown: (e) => { if (e.key === 'Enter' && !json) e.currentTarget.blur(); },
    className: 'w-full px-2 py-1.5 rounded-xl border border-slate-200 text-xs font-mono outline-none focus:border-main-blue',
    spellCheck: false,
    placeholder: json ? (name === 'choices' ? '{"route":"description"}' : '{}') : `={{ $json.${name} }}`,
  };
  return json ? <textarea rows={name === 'messages' || name === 'payload' || name === 'where' ? 3 : 2} {...common} /> : <input {...common} />;
}

function SynapseOneApiForm({ params, onPatch }) {
  const res = typeof params.resource === 'string' && SYNAPSEONE_API[params.resource] ? params.resource : '';
  const ops = res ? SYNAPSEONE_API[res].ops : [];
  const op = typeof params.operation === 'string' && ops.includes(params.operation) ? params.operation : '';
  const input = params.input && typeof params.input === 'object' && !Array.isArray(params.input) ? params.input : {};
  const fields = res && op ? (SYNAPSEONE_API[res].fields[op] || []) : [];
  const setField = (k, v) => onPatch({ input: { ...input, [k]: v } });
  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs text-normal-text mb-1">Resource</label>
        <select value={res} onChange={(e) => onPatch({ resource: e.target.value || undefined, operation: undefined, input: {} })} className={rowInputCls()}>
          <option value="">Pick a resource…</option>
          {Object.keys(SYNAPSEONE_API).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      {res && (
        <div>
          <label className="block text-xs text-normal-text mb-1">Operation</label>
          <select value={op} onChange={(e) => onPatch({ operation: e.target.value || undefined, input: {} })} className={rowInputCls()}>
            <option value="">Pick an operation…</option>
            {ops.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <p className="text-[11px] text-normal-text mt-1">{SYNAPSEONE_API[res].hint} Runs as <b>you</b> (your login).</p>
        </div>
      )}
      {fields.map((f) => (
        <div key={f}>
          <label className="block text-xs text-normal-text mb-1">{f} (required)</label>
          <input value={input[f] !== undefined && input[f] !== null ? String(input[f]) : ''} onChange={(e) => setField(f, e.target.value)} placeholder={f === 'limit' ? '20' : `={{ $json.${f} }}`} className={`${rowInputCls()} font-mono`} />
        </div>
      ))}
      {res && op && (
        <p className="text-[11px] text-normal-text">Extra input keys go in Advanced JSON (<code className="font-mono">input</code> object, values support ={'{{'} $json.x {'}}'}).</p>
      )}
    </div>
  );
}

const IF_OPS = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'larger', 'largerEqual', 'smaller', 'smallerEqual', 'isEmpty', 'isNotEmpty'];

function IfForm({ params, onPatch }) {
  const simple = params.value1 !== undefined || params.value2 !== undefined || params.operation !== undefined;
  return (
    <div className="space-y-2">
      {!simple ? (
        <div>
          <label className="block text-xs text-normal-text mb-1">Condition (JS — true → output 0, false → output 1)</label>
          <input value={params.condition || ''} onChange={(e) => onPatch({ condition: e.target.value })} placeholder="$input.value > 10" className={`${rowInputCls()} font-mono`} />
          <button onClick={() => onPatch({ value1: '={{ $json.value }}', operation: 'larger', value2: '10' })} className="mt-1 text-[11px] text-main-blue hover:underline">Switch to value / operation / value</button>
        </div>
      ) : (
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-normal-text mb-1">Left value</label>
            <input value={typeof params.value1 === 'string' ? params.value1 : JSON.stringify(params.value1 ?? '')} onChange={(e) => onPatch({ value1: e.target.value })} placeholder="={{ $json.value }}" className={`${rowInputCls()} font-mono`} />
          </div>
          <div>
            <label className="block text-xs text-normal-text mb-1">Operation</label>
            <select value={params.operation || 'equals'} onChange={(e) => onPatch({ operation: e.target.value })} className={rowInputCls()}>
              {IF_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-normal-text mb-1">Right value</label>
            <input value={typeof params.value2 === 'string' ? params.value2 : JSON.stringify(params.value2 ?? '')} onChange={(e) => onPatch({ value2: e.target.value })} placeholder="10" className={`${rowInputCls()} font-mono`} />
          </div>
          <button onClick={() => onPatch({ condition: '$input.value > 10', value1: undefined, value2: undefined, operation: undefined })} className="text-[11px] text-main-blue hover:underline">Switch to JS condition</button>
        </div>
      )}
    </div>
  );
}

function WebhookForm({ params, onPatch, headers }) {
  const path = String(params.path || '').replace(/^\/+|\/+$/g, '');
  const auth = params.auth && typeof params.auth === 'object' ? params.auth : {};
  const setAuth = (k, v) => {
    const next = { ...auth };
    if (v === undefined || v === '') delete next[k];
    else next[k] = v;
    onPatch({ auth: Object.keys(next).length ? next : undefined });
  };
  const mode = auth.mode || 'none';
  const idem = params.idempotency && typeof params.idempotency === 'object' ? params.idempotency : null;
  const setIdem = (k, v) => {
    const next = { ...(idem || {}) };
    if (v === undefined || v === '') delete next[k];
    else next[k] = v;
    onPatch({ idempotency: Object.keys(next).length ? next : undefined });
  };
  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs text-normal-text mb-1">Path (unique per workspace)</label>
        <input value={params.path || ''} onChange={(e) => onPatch({ path: e.target.value.replace(/^\/+/, '') })} placeholder="my-hook" className={`${rowInputCls()} font-mono`} />
      </div>
      <div>
        <label className="block text-xs text-normal-text mb-1">Method</label>
        <select value={params.httpMethod || 'POST'} onChange={(e) => onPatch({ httpMethod: e.target.value })} className={rowInputCls()}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      {path && (
        <div className="rounded-xl bg-background p-2 text-[11px] text-normal-text break-all">
          Webhook URL after save + Activate: <code className="font-mono text-main-text">/webhook/{path}</code>
        </div>
      )}
      <div className="rounded-xl border border-slate-100 p-2 space-y-1">
        <p className="text-[11px] font-medium text-normal-text">INBOUND AUTH (P0-5)</p>
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => onPatch({ httpMethod: 'POST', auth: { ...auth, mode: 'hmac-sha256', header: 'x-hub-signature-256' } })}
            title="Fill auth for a GitHub webhook (X-Hub-Signature-256 verified)"
            className="px-2 py-1 rounded-xl text-[11px] bg-slate-100 text-main-text hover:text-main-blue"
          >
            GitHub push preset
          </button>
        </div>
        <select value={mode} onChange={(e) => setAuth('mode', e.target.value === 'none' ? undefined : e.target.value)} className={rowInputCls()} title="How callers prove themselves">
          <option value="none">none (public URL)</option>
          <option value="secret-header">secret-header (shared secret)</option>
          <option value="hmac-sha256">hmac-sha256 (signed body)</option>
          <option value="jwt">jwt (HS256 bearer)</option>
        </select>
        {mode !== 'none' && (
          <>
            <CredentialPicker headers={headers} value={auth.credentialId} onChange={(id) => setAuth('credentialId', id)} allowKinds={mode === 'hmac-sha256' ? ['hmac'] : ['bearer', 'api-key', 'hmac']} />
            {mode === 'hmac-sha256' && auth.header === 'x-hub-signature-256' && (
              <p className="text-[11px] text-normal-text break-words">
                GitHub: Payload URL <code className="font-mono">/webhook/{path || '…'}</code>, Content-Type <code className="font-mono">application/json</code>,
                Secret = the hmac credential above. Events: push, issues, pull_request.
              </p>
            )}
            <label className="block text-[11px] text-normal-text">Header name
              <input
                value={auth.header || ''} onChange={(e) => setAuth('header', e.target.value)}
                placeholder={mode === 'secret-header' ? 'x-webhook-secret' : mode === 'hmac-sha256' ? 'x-signature' : 'authorization'}
                className={`${rowInputCls()} font-mono mt-0.5`}
              />
            </label>
          </>
        )}
      </div>
      <div className="rounded-xl border border-slate-100 p-2 space-y-1">
        <p className="text-[11px] font-medium text-normal-text">LIMITS</p>
        <label className="block text-[11px] text-normal-text">Requests / minute (1–60000, default 600)
          <input value={params?.rateLimit?.rpm ?? ''} onChange={(e) => onPatch({ rateLimit: e.target.value === '' ? undefined : { rpm: Math.min(60000, Math.max(1, Number(e.target.value) || 1)) } })} type="number" min="1" max="60000" className={`${rowInputCls()} mt-0.5`} />
        </label>
        <label className="flex items-center gap-1 text-[11px] text-normal-text">
          <input type="checkbox" checked={!!idem} onChange={(e) => onPatch({ idempotency: e.target.checked ? { header: 'x-delivery', ttlSeconds: 3600 } : undefined })} />
          Reject replayed deliveries (idempotency key)
        </label>
        {idem && (
          <div className="flex gap-1">
            <input value={idem.header || ''} onChange={(e) => setIdem('header', e.target.value)} placeholder="x-delivery" aria-label="Idempotency header" className={`${rowInputCls()} font-mono`} />
            <input value={idem.ttlSeconds ?? ''} onChange={(e) => setIdem('ttlSeconds', e.target.value === '' ? undefined : Math.min(86400, Math.max(60, Number(e.target.value) || 60)))} type="number" min="60" max="86400" title="Dedupe TTL seconds (60–86400)" aria-label="Idempotency TTL seconds" className={rowInputCls()} />
          </div>
        )}
      </div>
    </div>
  );
}

function CronForm({ params, onPatch }) {
  const interval = params?.rule?.interval?.[0] || {};
  const unit = String(interval.field || 'hours');
  const count = interval.hoursInterval || interval.minutesInterval || interval.daysInterval || interval.secondsInterval || 24;
  const cronExpr = typeof params.cronExpression === 'string' ? params.cronExpression : '';
  const info = describeCron(params);
  const setSimple = (c, u) => {
    const n = Math.max(1, Number(c) || 1);
    const item = { field: u };
    if (u === 'hours') item.hoursInterval = n;
    else if (u === 'minutes') item.minutesInterval = n;
    else if (u === 'days') item.daysInterval = n;
    else if (u === 'seconds') item.secondsInterval = n;
    onPatch({ rule: { interval: [item] }, cronExpression: undefined });
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <input value={String(count)} onChange={(e) => setSimple(e.target.value, unit)} type="number" min="1" className={rowInputCls()} title="Interval count" />
        <select value={unit} onChange={(e) => setSimple(count, e.target.value)} className={rowInputCls()}>
          <option value="minutes">minutes</option>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-normal-text mb-1">…or cron expression (overrides interval)</label>
        <input value={cronExpr} onChange={(e) => onPatch({ cronExpression: e.target.value || undefined })} placeholder="*/5 * * * * | 30 9 * * * | @hourly | @daily" className={`${rowInputCls()} font-mono`} />
      </div>
      <div>
        <label className="block text-xs text-normal-text mb-1">Timezone (wall-clock “M H” only, default UTC)</label>
        <input value={params.timezone || ''} onChange={(e) => onPatch({ timezone: e.target.value || undefined })} placeholder="UTC | Asia/Ho_Chi_Minh" className={`${rowInputCls()} font-mono`} />
      </div>
      <div className="rounded-xl bg-background p-2 text-[11px] text-normal-text">
        {info.text}
        {info.nextRun && <span> — next run ≈ {new Date(info.nextRun).toLocaleString()}</span>}
      </div>
    </div>
  );
}
