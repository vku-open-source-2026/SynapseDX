/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useMemo, useRef, useState } from 'react';
import { highlightJS, checkJSSyntax, hasTopReturn, looksLikeStatements } from '../lib/code-highlight.js';

// Dependency-free code editor: a transparent <textarea> stacked over a
// highlighted <pre> (same font/padding), with line numbers, Tab-to-indent,
// live syntax check, missing-return hint, example insert and fullscreen.
// No new dependencies — highlighting comes from lib/code-highlight.js.
const FONT_CLS = 'font-mono text-xs leading-5';

export default function CodeEditor({
  value,
  onChange,
  placeholder,
  example,
  docs,
  minRows = 8,
  maxHeight = 320,
  label = 'JavaScript (sandboxed, 5s timeout)',
}) {
  const [full, setFull] = useState(false);
  const taRef = useRef(null);
  const scrollRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);

  const html = useMemo(() => highlightJS(value) + '\n', [value]);
  const lineCount = useMemo(() => String(value || '').split('\n').length, [value]);
  const syntax = useMemo(() => checkJSSyntax(value), [value]);
  const showReturnHint = useMemo(() => {
    const v = String(value || '');
    return v.trim() && !hasTopReturn(v) && looksLikeStatements(v);
  }, [value]);

  const onKeyDown = (e) => {
    const ta = taRef.current;
    if (!ta) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en } = ta;
      const next = value.slice(0, s) + '  ' + value.slice(en);
      onChange(next);
      requestAnimationFrame(() => {
        try {
          ta.selectionStart = ta.selectionEnd = s + 2;
        } catch { /* ignore */ }
      });
    }
  };

  const insertExample = () => {
    if (!example) return;
    if (String(value || '').trim() && !window.confirm('Replace the current code with the example?')) return;
    onChange(example);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const editor = (
    <div className="rounded-xl border border-slate-200 overflow-hidden bg-white">
      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="overflow-auto"
        style={{ maxHeight: full ? '70vh' : maxHeight }}
      >
        <div className="flex items-stretch min-h-full">
          <div
            aria-hidden
            className={`${FONT_CLS} shrink-0 select-none text-right text-slate-300 bg-slate-50 border-r border-slate-100 px-2 py-2`}
          >
            <div style={{ transform: `translateY(${-scrollTop}px)` }}>
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i + 1}>{i + 1}</div>
              ))}
            </div>
          </div>
          <div className="relative flex-1">
            <pre aria-hidden className={`${FONT_CLS} m-0 px-2 py-2 whitespace-pre`} dangerouslySetInnerHTML={{ __html: html }} />
            <textarea
              ref={taRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={placeholder}
              aria-label={label}
              className={`${FONT_CLS} absolute inset-0 w-full h-full px-2 py-2 whitespace-pre overflow-hidden resize-none outline-none bg-transparent`}
              style={{ color: 'transparent', caretColor: '#0f172a' }}
            />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <div className="flex items-center gap-1 mb-1">
        <label className="block text-xs text-normal-text">{label}</label>
        <span className="ml-auto flex gap-1">
          {example && (
            <button onClick={insertExample} title="Replace with a runnable example" className="px-2 py-0.5 rounded-xl text-[11px] bg-main-blue/10 text-main-blue">
              Insert example
            </button>
          )}
          <button onClick={() => setFull((v) => !v)} title={full ? 'Exit fullscreen (Esc closes the editor, not this)' : 'Edit fullscreen'} className="px-2 py-0.5 rounded-xl text-[11px] bg-slate-100 text-main-text">
            {full ? 'Shrink' : 'Expand'}
          </button>
        </span>
      </div>
      {full ? (
        <div className="fixed inset-0 z-[60] bg-black/40 p-4 sm:p-8" onClick={() => setFull(false)}>
          <div className="bg-white rounded-3xl shadow-xl p-4 h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1 mb-2">
              <span className="text-sm font-semibold text-main-text">{label}</span>
              <button onClick={() => setFull(false)} className="ml-auto px-3 py-1 rounded-xl text-xs bg-slate-100">Done</button>
            </div>
            <div className="flex-1 min-h-0 flex flex-col">{editor}</div>
            {docs}
          </div>
        </div>
      ) : (
        editor
      )}
      {!syntax.ok && <p className="text-[11px] text-red-500 mt-1 break-words">Syntax error: {syntax.error} — fix before Test-run.</p>}
      {syntax.ok && showReturnHint && (
        <p className="text-[11px] text-amber-600 mt-1">No <code className="font-mono">return</code> found — the output will be the input echoed back (plus any <code className="font-mono">console</code> logs).</p>
      )}
      {minRows > 0 && !String(value || '').trim() && (
        <p className="text-[11px] text-normal-text mt-1">Empty — the node passes its input through untouched.</p>
      )}
      {docs}
    </div>
  );
}

/** Shared mini-docs for the sandboxed Code node ($vars + return contract). */
export function CodeDocs() {
  return (
    <details className="mt-1 rounded-xl bg-background p-2 text-[11px] text-normal-text">
      <summary className="cursor-pointer hover:text-main-blue">Docs: $input · $json · $now · return</summary>
      <div className="mt-1 space-y-0.5">
        <p><code className="font-mono">$input</code> / <code className="font-mono">$json</code> / <code className="font-mono">input</code>: current item · <code className="font-mono">$now</code>: ISO timestamp.</p>
        <p><code className="font-mono">return {'{ … }'}</code> sets the output. A bare expression like <code className="font-mono">({'{'}a: 1{'}'})</code> is auto-returned; <code className="font-mono">await</code> works.</p>
        <p><code className="font-mono">console.log</code> is captured (see <code className="font-mono">_logs</code> in output — or <code className="font-mono">_consoleLogs</code> if your data already has <code className="font-mono">_logs</code>).</p>
        <p>No <code className="font-mono">process / require / fetch</code>, 5s timeout, ≤50KB code, ≤500KB output.</p>
      </div>
    </details>
  );
}
