/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { Spinner, TableSkeleton as TableSkeletonBase, ListSkeleton, InlineLoader } from './loading.jsx';

export { Spinner, InlineLoader, ListSkeleton, TableSkeletonBase as TableSkeleton };
export { PageSkeleton, LoadingOverlay, RouteProgress, ScrollToTop, Dots } from './loading.jsx';

export function Card({ className = '', children }) {
  return <div className={`bg-white rounded-3xl shadow-md p-6 ${className}`}>{children}</div>;
}

export function PageTitle({ title, sub, right }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
      <div className="min-w-0">
        <h2 className="text-xl sm:text-2xl font-semibold text-main-text truncate">{title}</h2>
        {sub && <p className="text-normal-text text-sm mt-1">{sub}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">{right}</div>}
    </div>
  );
}

export function Btn({ children, onClick, kind = 'primary', type = 'button', disabled, loading = false, className = '' }) {
  const styles =
    kind === 'primary'
      ? 'bg-gradient-to-b from-main-start to-main-end text-white'
      : kind === 'danger'
        ? 'bg-red-500 text-white'
        : 'bg-slate-100 text-main-text';
  const isDisabled = disabled || loading;
  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      onClick={onClick}
      className={`px-4 py-2 rounded-2xl text-sm font-medium shadow-sm disabled:opacity-60 disabled:cursor-wait whitespace-nowrap inline-flex items-center justify-center gap-2 transition-opacity ${styles} ${className}`}
    >
      {loading && <Spinner size="sm" className="sdx-spinner-on-dark" label="Loading" />}
      <span className={loading ? 'opacity-90' : ''}>{children}</span>
    </button>
  );
}

export function Field({ label, children }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-medium text-normal-text mb-1">{label}</span>
      {children}
    </label>
  );
}

export function Input(props) {
  return (
    <input
      {...props}
      className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-sm text-main-text outline-none focus:border-main-blue"
    />
  );
}

export function Table({ head, children }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-normal-text">
            {head.map((h) => (
              <th key={h} className="py-2 pr-4 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Badge({ tone = 'gray', children }) {
  const tones = {
    gray: 'bg-slate-100 text-main-text',
    green: 'bg-emerald-500/10 text-emerald-600',
    red: 'bg-red-500/10 text-red-600',
    blue: 'bg-main-blue/10 text-main-blue',
    amber: 'bg-amber-400/15 text-amber-500',
  };
  return (
    <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${tones[tone] || tones.gray}`}>
      {children}
    </span>
  );
}

export function Empty({ text = 'No data yet', action }) {
  return (
    <div className="py-6 text-center">
      <p className="text-normal-text text-sm">{text}</p>
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }) {
  return <div aria-hidden="true" className={`sdx-skeleton rounded-2xl ${className}`} />;
}

export function StatValue({ loading, value }) {
  if (loading) return <Skeleton className="h-9 w-16" />;
  return <p className="text-3xl font-semibold text-main-text tabular-nums">{value ?? '—'}</p>;
}

export function Err({ e }) {
  const [show, setShow] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  if (!e) return null;
  // SynapseDXError packs `status path: bodyJSON` into one message (api.js) —
  // a full JSON body would stretch the banner for pages. Show one short line,
  // expand + copy on demand.
  const full = e.message || String(e);
  const LIMIT = 220;
  const long = full.length > LIMIT;
  const shown = long && !show ? `${full.slice(0, LIMIT)}…` : full;
  const copy = async () => {
    await copyText(full);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="mb-4 px-4 py-2.5 rounded-2xl bg-red-500/10 text-red-600 text-sm min-w-0">
      <p className="break-all">{shown}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {long && (
          <button onClick={() => setShow((v) => !v)} className="underline underline-offset-2 hover:opacity-80">
            {show ? 'Show less' : 'Show details'}
          </button>
        )}
        <button onClick={copy} className="underline underline-offset-2 hover:opacity-80">
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children }) {
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-3xl shadow-md p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-main-text">{title}</h3>
          <button onClick={onClose} className="text-normal-text text-xl leading-none">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Editor test-output convention (WorkflowEditor.jsx): never mount more than a
// 2k-char slice of a payload in one <pre>; huge execDetail blobs froze the DOM.
export const CODE_LIMIT = 2000;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* clipboard API unavailable (permissions/insecure ctx) — fall back below */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    /* best-effort */
  }
  document.body.removeChild(ta);
}

export function Code({ data, limit = CODE_LIMIT }) {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  let text;
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  } catch {
    text = String(data);
  }
  const long = text.length > limit;
  const shown = expanded || !long ? text : text.slice(0, limit);
  const copy = async () => {
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="min-w-0">
      <pre className="bg-background rounded-2xl p-3 text-xs overflow-x-auto text-main-text">
        {shown}
        {!expanded && long ? '…' : ''}
      </pre>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-normal-text">
        {long && <span>Showing {expanded ? text.length : limit} of {text.length} chars</span>}
        {long && (
          <button onClick={() => setExpanded((v) => !v)} className="text-main-blue hover:underline">
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        <button onClick={copy} className="text-main-blue hover:underline">
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
