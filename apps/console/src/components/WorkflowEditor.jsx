/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faXmark, faMagnifyingGlassPlus, faMagnifyingGlassMinus, faTrash, faUndo, faRedo } from '@fortawesome/free-solid-svg-icons';
import { api } from '../lib/api.js';
import { Badge, Btn, Err } from './ui.jsx';
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
  EXAMPLE_PARAMS,
} from '../lib/workflow-graph.js';

const NODE_W = 180;
const NODE_H = 64;

// Visual drag-and-drop editor for a workflow definition (our own code —
// no embedded n8n UI). Persists through PUT /v1/workflows/:id.
export default function WorkflowEditor({ workflowId, initial, headers, onClose, onSaved }) {
  const norm = useMemo(() => normalizeWorkflow(initial), [workflowId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [name, setName] = useState(norm.name);
  const [nodes, setNodes] = useState(norm.nodes);
  const [connections, setConnections] = useState(norm.connections);
  const [tab, setTab] = useState('visual');
  const [jsonText, setJsonText] = useState(() => JSON.stringify({ nodes: norm.nodes, connections: norm.connections }, null, 2));
  const [sel, setSel] = useState(null); // node name | { edge: { from, to } } | null
  const [pendingFrom, setPendingFrom] = useState(null);
  const [view, setView] = useState({ x: 40, y: 40, k: 1 });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [paramsText, setParamsText] = useState('');
  const [paramsErr, setParamsErr] = useState(null);
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
        if (pendingFrom) setPendingFrom(null);
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
          setConnections((c) => disconnect(c, sel.edge.from, sel.edge.to));
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

  const onBoxPointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.kind === 'pan' && !d.moved) {
      setSel(null);
      setPendingFrom(null);
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
      setPendingFrom(null);
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
      setPendingFrom(node.name);
      setSel(null);
    } else if (pendingFrom && pendingFrom !== node.name) {
      checkpoint();
      setConnections((c) => connect(c, pendingFrom, node.name));
      setPendingFrom(null);
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

  const edges = listEdges(connections);
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
            <Btn onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</Btn>
            <button onClick={close} title="Close" className="text-normal-text hover:text-main-blue text-lg leading-none px-1">
              <FontAwesomeIcon icon={faXmark} />
            </button>
          </div>
        </div>
        <Err e={err} />
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
          <div className="w-44 shrink-0 border-r border-slate-100 p-2 overflow-y-auto">
            <p className="text-[11px] font-medium text-normal-text px-1 mb-1">ADD NODE</p>
            {NODE_TYPES.map((t) => (
              <button key={t.type} onClick={() => addNode(t.type)} title={t.hint} className="w-full text-left px-2 py-1.5 rounded-xl hover:bg-background text-xs text-main-text flex items-center gap-1.5">
                <FontAwesomeIcon icon={faPlus} size="xs" className="text-main-blue" />
                <span className="truncate">{t.label}</span>
              </button>
            ))}
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
                    return (
                      <path
                        key={`${e.from}→${e.to}:${i}`}
                        d={edgePath(port(a, 'out'), port(b, 'in'))}
                        fill="none"
                        stroke={active ? '#ef4444' : pendingFrom === e.from ? '#4FACFE' : '#94a3b8'}
                        strokeWidth={active ? 3 / view.k : 2 / view.k}
                        className="pointer-events-auto cursor-pointer"
                        onClick={(ev) => { ev.stopPropagation(); setSel({ edge: e }); }}
                      />
                    );
                  })}
                  {pendingFrom && byName[pendingFrom] && (
                    <circle cx={port(byName[pendingFrom], 'out').x} cy={port(byName[pendingFrom], 'out').y} r={7 / view.k} fill="none" stroke="#4FACFE" strokeWidth={2 / view.k} />
                  )}
                </g>
              </svg>
              {nodes.map((n) => (
                <div
                  key={n.id}
                  data-node={n.name}
                  onPointerDown={(e) => onNodePointerDown(e, n)}
                  onPointerUp={(e) => onNodePointerUp(e, n)}
                  className={`absolute rounded-2xl border-2 bg-white shadow-sm ${sel === n.name ? 'border-main-blue' : 'border-slate-200'}`}
                  style={{ left: n.position[0] * view.k + view.x, top: n.position[1] * view.k + view.y, width: NODE_W * view.k, height: NODE_H * view.k, fontSize: 12 * view.k }}
                >
                  <div className="px-2 pt-1 font-semibold text-main-text truncate" style={{ fontSize: 12 * view.k }}>{n.name}</div>
                  <div className="px-2 text-normal-text truncate" style={{ fontSize: 10 * view.k }}>{String(n.type).split('.').pop()}</div>
                  <button
                    onClick={(e) => onPortClick(e, n, 'in')}
                    onPointerDown={(e) => e.stopPropagation()}
                    title="Input — click after picking an output to connect"
                    className="absolute rounded-full bg-white border-2 border-slate-300 hover:border-main-blue"
                    style={{ left: -6 * view.k, top: '50%', marginTop: -6 * view.k, width: 12 * view.k, height: 12 * view.k }}
                  />
                  <button
                    onClick={(e) => onPortClick(e, n, 'out')}
                    onPointerDown={(e) => e.stopPropagation()}
                    title="Output — click, then click a target input"
                    className={`absolute rounded-full border-2 ${pendingFrom === n.name ? 'bg-main-blue border-main-blue' : 'bg-white border-slate-300 hover:border-main-blue'}`}
                    style={{ right: -6 * view.k, top: '50%', marginTop: -6 * view.k, width: 12 * view.k, height: 12 * view.k }}
                  />
                </div>
              ))}
              <div className="absolute bottom-3 right-3 flex gap-1">
                <button onClick={() => zoomBy(1.2)} title="Zoom in" className="w-8 h-8 rounded-full bg-white shadow-md text-normal-text"><FontAwesomeIcon icon={faMagnifyingGlassPlus} size="xs" /></button>
                <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out" className="w-8 h-8 rounded-full bg-white shadow-md text-normal-text"><FontAwesomeIcon icon={faMagnifyingGlassMinus} size="xs" /></button>
                <button onClick={zoomToFit} title="Fit all nodes" className="h-8 px-3 rounded-full bg-white shadow-md text-normal-text text-xs">Fit</button>
              </div>
              {pendingFrom && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-2xl bg-main-blue text-white text-xs shadow-md">
                  Connecting from “{pendingFrom}” — click a target input (Esc to cancel)
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
          <div className="w-60 shrink-0 border-l border-slate-100 p-3 overflow-y-auto">
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
                <label className="block text-xs text-normal-text mb-1">Parameters (JSON)</label>
                {selNode && EXAMPLE_PARAMS[selNode.type] && (
                  <button
                    onClick={() => { checkpoint(); const v = JSON.parse(JSON.stringify(EXAMPLE_PARAMS[selNode.type])); setNodes((ns) => ns.map((n) => (n.name === selNode.name ? { ...n, parameters: v } : n))); setParamsText(JSON.stringify(v, null, 2)); setParamsErr(null); }}
                    className="mb-1 px-2 py-1 rounded-xl text-[11px] bg-main-blue/10 text-main-blue"
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
                <button onClick={applyDeleteNode} className="mt-1 px-3 py-1.5 rounded-2xl text-xs font-medium bg-red-500/10 text-red-500">
                  <FontAwesomeIcon icon={faTrash} size="xs" /> Delete node
                </button>
              </>
            ) : selEdge ? (
              <>
                <p className="text-[11px] font-medium text-normal-text mb-2">CONNECTION</p>
                <p className="text-xs font-mono text-main-text mb-3 break-all">{selEdge.from} → {selEdge.to}</p>
                <button
                  onClick={() => { checkpoint(); setConnections((c) => disconnect(c, selEdge.from, selEdge.to)); setSel(null); }}
                  className="px-3 py-1.5 rounded-2xl text-xs font-medium bg-red-500/10 text-red-500"
                >
                  <FontAwesomeIcon icon={faTrash} size="xs" /> Remove connection
                </button>
              </>
            ) : (
              <p className="text-xs text-normal-text">Click a node to inspect · drag to move · click an output dot, then an input dot, to connect · drag the background to pan · scroll to zoom.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
