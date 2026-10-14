/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';

export function Card({ className = '', children }) {
  return <div className={`bg-white rounded-3xl shadow-md p-6 ${className}`}>{children}</div>;
}

export function PageTitle({ title, sub, right }) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div>
        <h2 className="text-2xl font-semibold text-main-text">{title}</h2>
        {sub && <p className="text-normal-text text-sm mt-1">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Btn({ children, onClick, kind = 'primary', type = 'button', disabled }) {
  const styles =
    kind === 'primary'
      ? 'bg-gradient-to-b from-main-start to-main-end text-white'
      : kind === 'danger'
        ? 'bg-red-500 text-white'
        : 'bg-slate-100 text-main-text';
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`px-4 py-2 rounded-2xl text-sm font-medium shadow-sm disabled:opacity-50 ${styles}`}
    >
      {children}
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

export function Empty({ text = 'No data yet' }) {
  return <p className="text-normal-text text-sm py-6 text-center">{text}</p>;
}

export function Err({ e }) {
  if (!e) return null;
  return (
    <div className="mb-4 px-4 py-2.5 rounded-2xl bg-red-500/10 text-red-600 text-sm">
      {e.message || String(e)}
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

export function Code({ data }) {
  let text;
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  } catch {
    text = String(data);
  }
  return <pre className="bg-background rounded-2xl p-3 text-xs overflow-x-auto text-main-text">{text}</pre>;
}
