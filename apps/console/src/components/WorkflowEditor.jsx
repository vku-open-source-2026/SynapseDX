/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faXmark, faMagnifyingGlassPlus, faMagnifyingGlassMinus, faTrash, faUndo, faRedo } from '@fortawesome/free-solid-svg-icons';
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
  sampleInputFor,
  describeCron,
  ifWarnings,
  isKnownType,
  wouldCycle,
  IF_TYPE,
  ifBranchLabel,
  EXAMPLE_PARAMS,
} from '../lib/workflow-graph.js';

const NODE_W = 180;
const NODE_H = 64;

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
  const clearPending = () => { setPendingFrom(null); setPendingBranch(null); };
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
      const raw = localStorage.getItem(`synapsedx.testrun.${workflowId}`);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, 5) : [];
    } catch {
      return [];
    }
  });
  const [expandedRuns, setExpandedRuns] = useState({});
  const boxRef = useRef(null);
  const dragRef = useRef(null);
  const draftKey = `synapsedx.editor.${workflowId}`;
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
  const selEdge = sel && typeof sel === 'object' ? sel.edge : null;
  const [paramsRev, setParamsRev] = useState(0);

  // Live structural validation — blocks Save with a tooltip (synced with
  // workflow-service validateDefinition: duplicate / self-loop / dangling / cycle).
  const graphErr = useMemo(() => validateGraph(nodes, connections), [nodes, connections]);
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
        if (pendingFrom) clearPending();
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
        } else if (sel.edge) {
          checkpoint();
          const srcIsIf = nodes.some((n) => n.name === sel.edge.from && n.type === IF_TYPE);
          setConnections((c) => disconnect(c, sel.edge.from, sel.edge.to, srcIsIf ? { preserveSlots: true } : undefined));
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
      setSel(node.name);
      clearPending();
    }
  };

  const onWheelZoom = (e) => {
    e.preventDefault();
    // Trackpad horizontal scroll / swipe is panning, not zooming (pinch sends ctrlKey).
    if (!e.ctrlKey && Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
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
  const addNode = (type) => {
    if (!boxRef.current) return;
    checkpoint();
    const r = boxRef.current.getBoundingClientRect();
    const [wx, wy] = toWorld(r.left + r.width / 2 - (NODE_W / 2) * view.k, r.top + r.height / 2 - (NODE_H / 2) * view.k);
    const n = makeNode(type, wx + (nodes.length % 5) * 24, wy + (nodes.length % 5) * 24);
    n.name = uniqueName(nodes, n.name);
    setNodes((ns) => [...ns, n]);
    setSel(n.name);
  };

  const onPortClick = (e, node, side) => {
    e.stopPropagation();
    if (side === 'out') {
      // Clicking the same output again cancels the pending wire (m1).
      if (pendingFrom === node.name) { clearPending(); return; }
      setPendingFrom(node.name);
      setPendingBranch(null);
      setSel(null);
    } else if (pendingFrom && pendingFrom !== node.name) {
      const src = nodes.find((n) => n.name === pendingFrom);
      if (src && src.type === IF_TYPE && pendingBranch !== 0 && pendingBranch !== 1) {
        setErr(new Error(`Pick a branch for '${pendingFrom}': true (output 0) or false (output 1) — see the banner.`));
        return;
      }
      if (wouldCycle(nodes, connections, pendingFrom, node.name)) {
        setErr(new Error(`Connecting '${pendingFrom}' → '${node.name}' would close a cycle — refused.`));
        return;
      }
      checkpoint();
      const branch = src && src.type === IF_TYPE ? pendingBranch : undefined;
      setConnections((c) => connect(c, pendingFrom, node.name, branch === undefined ? undefined : { branch }));
      clearPending();
      setErr(null);
    } else if (pendingFrom === node.name) {
      clearPending();
    }
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
    const vErr = validateGraph(w.nodes, w.connections);
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
        localStorage.setItem(`synapsedx.testrun.${workflowId}`, JSON.stringify(next));
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
      if (n?.type !== 'n8n-nodes-base.code') continue;
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
      setTestOut(null);
      setErr(ex);
      pushHist({ at: new Date().toISOString(), input, ok: false, status: 'error' });
    } finally {
      setTestBusy(false);
    }
  };

  const edges = listEdgesWithBranches(connections);
  const warnings = useMemo(() => ifWarnings(nodes, connections), [nodes, connections]);
  const port = (n, side) => {
    const [x, y] = n.position;
    return side === 'out' ? { x: x + NODE_W, y: y + NODE_H / 2 } : { x, y: y + NODE_H / 2 };
  };
  const edgePath = (a, b) => {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
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
    const w = Math.max(...xs) + NODE_W + 60 - minX;
    const h = Math.max(...ys) + NODE_H + 60 - minY;
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
              <Btn onClick={save} disabled={busy || !dirty || !!saveBlocked}>{busy ? 'Saving…' : 'Save'}</Btn>
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
                {items.map((t) => (
                  <button key={t.type} onClick={() => addNode(t.type)} title={`${t.hint}\n${t.placeholder || ''}`} className="w-full text-left px-2 py-1.5 rounded-xl hover:bg-background text-xs text-main-text flex items-center gap-1.5">
                    <FontAwesomeIcon icon={faPlus} size="xs" className="text-main-blue" />
                    <span className="truncate">{t.label}</span>
                  </button>
                ))}
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
              className="flex-1 relative overflow-hidden touch-none select-none min-w-[320px]"
              style={{ backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)', backgroundSize: `${24 * view.k}px ${24 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px`, cursor: pendingFrom ? 'crosshair' : 'default' }}
            >
              <svg className="absolute inset-0 w-full h-full pointer-events-none">
                <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                  {edges.map((e, i) => {
                    const a = byName[e.from];
                    const b = byName[e.to];
                    if (!a || !b) return null;
                    const active = selEdge && selEdge.from === e.from && selEdge.to === e.to;
                    const pa = port(a, 'out');
                    const pb = port(b, 'in');
                    const showBranch = a.type === IF_TYPE && (e.branch === 0 || e.branch === 1);
                    return (
                      <g key={`${e.from}→${e.to}:${e.branch}:${i}`}>
                        <path
                          d={edgePath(pa, pb)}
                          fill="none"
                          stroke={active ? '#ef4444' : pendingFrom === e.from ? '#4FACFE' : '#94a3b8'}
                          strokeWidth={active ? 3 / view.k : 2 / view.k}
                          className="pointer-events-auto cursor-pointer"
                          onClick={(ev) => { ev.stopPropagation(); setSel({ edge: e }); }}
                        />
                        {showBranch && (
                          <text
                            x={(pa.x + pb.x) / 2}
                            y={(pa.y + pb.y) / 2 - 6 / view.k}
                            textAnchor="middle"
                            fontSize={11 / view.k}
                            fontWeight="700"
                            fill={e.branch === 0 ? '#059669' : '#dc2626'}
                            className="pointer-events-none"
                          >
                            {ifBranchLabel(e.branch)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                  {pendingFrom && byName[pendingFrom] && (
                    <circle cx={port(byName[pendingFrom], 'out').x} cy={port(byName[pendingFrom], 'out').y} r={7 / view.k} fill="none" stroke="#4FACFE" strokeWidth={2 / view.k} />
                  )}
                </g>
              </svg>
              {nodes.map((n) => {
                const st = runStatusByNode[n.name];
                const known = isKnownType(n.type);
                const disabled = n.disabled === true;
                const border = sel === n.name ? 'border-main-blue' : st === 'success' ? 'border-emerald-400' : st === 'error' ? 'border-red-400' : 'border-slate-200';
                // Constant screen-size hit targets (m2): usable even when zoomed out.
                const ps = 14;
                const off = -ps / 2;
                return (
                <div
                  key={n.id}
                  data-node={n.name}
                  onPointerDown={(e) => onNodePointerDown(e, n)}
                  onPointerUp={(e) => onNodePointerUp(e, n)}
                  title={disabled ? `${n.name} (disabled — skipped at run time)` : n.name}
                  className={`absolute rounded-2xl border-2 bg-white shadow-sm ${border} ${disabled ? 'opacity-50 border-dashed' : ''}`}
                  style={{ left: n.position[0] * view.k + view.x, top: n.position[1] * view.k + view.y, width: NODE_W * view.k, height: NODE_H * view.k, fontSize: 12 * view.k }}
                >
                  <div className="px-2 pt-1 font-semibold text-main-text truncate" style={{ fontSize: 12 * view.k }}>{disabled ? '⏸ ' : ''}{n.name}{st === 'success' ? ' ✓' : st === 'error' ? ' ✗' : ''}</div>
                  <div
                    className={`px-2 text-normal-text truncate ${known ? '' : 'underline decoration-wavy decoration-amber-500'}`}
                    style={{ fontSize: 10 * view.k }}
                    title={known ? String(n.type) : `${n.type} — unknown type: the engine passes it through as skipped`}
                  >
                    {String(n.type).split('.').pop()}{known ? '' : ' ⚠'}
                  </div>
                  <button
                    onClick={(e) => onPortClick(e, n, 'in')}
                    onPointerDown={(e) => e.stopPropagation()}
                    title="Input — click after picking an output to connect"
                    aria-label={`Connect input of ${n.name}`}
                    className="absolute rounded-full bg-white border-2 border-slate-300 hover:border-main-blue"
                    style={{ left: off, top: '50%', marginTop: off, width: ps, height: ps }}
                  />
                  <button
                    onClick={(e) => onPortClick(e, n, 'out')}
                    onPointerDown={(e) => e.stopPropagation()}
                    title="Output — click, then click a target input"
                    aria-label={`Connect output of ${n.name}`}
                    className={`absolute rounded-full border-2 ${pendingFrom === n.name ? 'bg-main-blue border-main-blue' : 'bg-white border-slate-300 hover:border-main-blue'}`}
                    style={{ right: off, top: '50%', marginTop: off, width: ps, height: ps }}
                  />
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
                    <p className="text-xs text-normal-text mt-1">Add a trigger on the left (Webhook, Schedule or Manual), then wire it to an action. Every node ships with a runnable example — use Fill example, then Test-run before Save.</p>
                  </div>
                </div>
              )}
              {pendingFrom && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-2xl bg-main-blue text-white text-xs shadow-md flex items-center gap-2">
                  <span>Connecting from “{pendingFrom}” — click a target input (Esc to cancel)</span>
                  {byName[pendingFrom]?.type === IF_TYPE && (
                    <span className="flex gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); setPendingBranch(0); }}
                        className={`px-2 py-0.5 rounded-xl font-bold ${pendingBranch === 0 ? 'bg-white text-main-blue' : 'bg-white/20 text-white'}`}
                        title="Wire into the true branch (output 0)"
                      >
                        true
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setPendingBranch(1); }}
                        className={`px-2 py-0.5 rounded-xl font-bold ${pendingBranch === 1 ? 'bg-white text-main-blue' : 'bg-white/20 text-white'}`}
                        title="Wire into the false branch (output 1)"
                      >
                        false
                      </button>
                    </span>
                  )}
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
                <NodeForm node={selNode} onPatch={patchParams} workflowId={workflowId} headers={headers} />
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
                <p className="text-xs font-mono text-main-text mb-3 break-all">{selEdge.from} → {selEdge.to}</p>
                <button
                  onClick={() => { checkpoint(); const srcIsIf = nodes.some((n) => n.name === selEdge.from && n.type === IF_TYPE); setConnections((c) => disconnect(c, selEdge.from, selEdge.to, srcIsIf ? { preserveSlots: true } : undefined)); setSel(null); }}
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
                className="px-3 py-1.5 rounded-2xl text-xs font-medium text-white bg-gradient-to-b from-main-start to-main-end disabled:opacity-50"
              >
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
                            <div className="px-2 pb-2">
                              {r.error && <p className="text-[11px] text-red-500 break-words">{r.error}</p>}
                              <p className="text-[10px] text-normal-text mt-1">input</p>
                              <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-background rounded-lg p-1.5">{JSON.stringify(r.input, null, 2)?.slice(0, 1200)}</pre>
                              <p className="text-[10px] text-normal-text mt-1">output</p>
                              <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-background rounded-lg p-1.5">{JSON.stringify(r.output, null, 2)?.slice(0, 1200)}</pre>
                            </div>
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

function rowInputCls() {
  return 'w-full px-2 py-1.5 rounded-xl border border-slate-200 text-xs outline-none';
}

function NodeForm({ node, onPatch, workflowId, headers }) {
  const p = node.parameters || {};
  switch (node.type) {
    case 'n8n-nodes-base.code':
      return <CodeForm params={p} onPatch={onPatch} />;
    case 'n8n-nodes-base.httpRequest':
      return <HttpForm params={p} onPatch={onPatch} headers={headers} />;
    case 'n8n-nodes-base.set':
      return <SetForm params={p} onPatch={onPatch} />;
    case 'n8n-nodes-base.if':
      return <IfForm params={p} onPatch={onPatch} />;
    case 'synapsedx.api':
      return <SynapseDXApiForm params={p} onPatch={onPatch} />;
    case 'n8n-nodes-base.webhook':
      return <WebhookForm params={p} onPatch={onPatch} headers={headers} />;
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
    try { return localStorage.getItem('synapsedx.credAccount') || ''; } catch { return ''; }
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
    try { localStorage.setItem('synapsedx.credAccount', v); } catch { /* ignore */ }
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
          <button onClick={create} disabled={busy || !nm.trim() || !secret || !accountId} title={!accountId ? 'Enter the account id first' : 'Save encrypted server-side'} className="px-2 py-1 rounded-xl text-[11px] bg-main-blue/10 text-main-blue disabled:opacity-50">
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

const SYNAPSEDX_API = {
  orgs: { ops: ['list'], fields: { list: [] }, hint: 'All organizations you can see' },
  users: { ops: ['list'], fields: { list: ['orgId'] }, hint: 'Users in an org (orgId required)' },
  roles: { ops: ['list'], fields: { list: ['accountId'] }, hint: 'Roles in an account' },
  policies: { ops: ['list'], fields: { list: ['accountId'] }, hint: 'Policies in an account' },
  authorize: { ops: ['check'], fields: { check: ['userId', 'action', 'resource'] }, hint: 'Ask: may this user do this action?' },
  audit: { ops: ['query'], fields: { query: ['limit'] }, hint: 'Recent authorize decisions (limit 1..200)' },
  keys: { ops: ['list'], fields: { list: ['accountId'] }, hint: 'API key metadata (never secrets)' },
  'service-accounts': { ops: ['list'], fields: { list: ['accountId'] }, hint: 'Machine identities in an account' },
  workflows: { ops: ['list', 'get'], fields: { list: [], get: ['id'] }, hint: 'Workflows you can access' },
  executions: { ops: ['list', 'get'], fields: { list: [], get: ['id'] }, hint: 'Run history (list accepts workflowId/status/limit)' },
  templates: { ops: ['list', 'get'], fields: { list: [], get: ['name'] }, hint: 'Built-in starters' },
};

function SynapseDXApiForm({ params, onPatch }) {
  const res = typeof params.resource === 'string' && SYNAPSEDX_API[params.resource] ? params.resource : '';
  const ops = res ? SYNAPSEDX_API[res].ops : [];
  const op = typeof params.operation === 'string' && ops.includes(params.operation) ? params.operation : '';
  const input = params.input && typeof params.input === 'object' && !Array.isArray(params.input) ? params.input : {};
  const fields = res && op ? (SYNAPSEDX_API[res].fields[op] || []) : [];
  const setField = (k, v) => onPatch({ input: { ...input, [k]: v } });
  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs text-normal-text mb-1">Resource</label>
        <select value={res} onChange={(e) => onPatch({ resource: e.target.value || undefined, operation: undefined, input: {} })} className={rowInputCls()}>
          <option value="">Pick a resource…</option>
          {Object.keys(SYNAPSEDX_API).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      {res && (
        <div>
          <label className="block text-xs text-normal-text mb-1">Operation</label>
          <select value={op} onChange={(e) => onPatch({ operation: e.target.value || undefined, input: {} })} className={rowInputCls()}>
            <option value="">Pick an operation…</option>
            {ops.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <p className="text-[11px] text-normal-text mt-1">{SYNAPSEDX_API[res].hint} Runs as <b>you</b> (your login).</p>
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
