/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { api, baseUrl } from '../lib/api.js';
import { GROUPS } from '../lib/endpoints.js';
import { Badge, Card, Code, Err, PageTitle, Spinner } from '../components/ui.jsx';
import Chatbot from '../components/Chatbot.jsx';

const METHOD_TONE = { GET: 'blue', POST: 'green', PUT: 'amber', PATCH: 'amber', DELETE: 'red' };
// Path params always follow a slash. This intentionally does not treat the
// colon in action suffixes such as `documents:batch` as a `:batch` parameter.
const PATH_PARAM = /(^|\/):([A-Za-z0-9_]+)/g;

export default function ApiDocs() {
  const { headers, auth } = useAuth();
  const [open, setOpen] = useState(null);
  const [body, setBody] = useState('');
  const [pathVals, setPathVals] = useState({});
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null);

  const copyCurl = async (g, e) => {
    let p;
    try {
      p = fillPath(e.path);
    } catch (ex) {
      setErr(ex);
      return;
    }
    let payload;
    if (e.method !== 'GET') {
      try {
        payload = body.trim() ? JSON.parse(body) : {};
      } catch {
        setErr(new Error('Body is not valid JSON'));
        return;
      }
    }
    const parts = [`curl -X ${e.method} '${baseUrl()}${p}'`];
    // Secrets stay out of the clipboard: reference env vars instead.
    if (headers.token) parts.push(`-H "Authorization: Bearer $SYNAPSEONE_TOKEN"`);
    if (headers.apiKey) parts.push(`-H "X-API-Key: $SYNAPSEONE_API_KEY"`);
    if (e.method !== 'GET') {
      parts.push(`-H 'Content-Type: application/json'`);
      // Escape single quotes for POSIX shells (o'clock → o'\''clock).
      parts.push(`-d '${JSON.stringify(payload).replace(/'/g, `'\\''`)}'`);
    }
    const cmd = parts.join(' \\\n  ');
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = cmd;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(key(g, e));
    setTimeout(() => setCopied(null), 2000);
  };

  const key = (g, e) => `${g}:${e.method}:${e.path}`;
  const toggle = (g, e) => {
    const k = key(g, e);
    setOpen(open === k ? null : k);
    setOut(null);
    setErr(null);
    setBody(e.body ? JSON.stringify(e.body, null, 2) : '');
    setPathVals({});
  };

  const fillPath = (p) =>
    p.replace(PATH_PARAM, (_, prefix, n) => {
      const v = (pathVals[n] || '').trim();
      if (!v) throw new Error(`Enter :${n} to try the call`);
      return `${prefix}${encodeURIComponent(v)}`;
    });

  const run = async (e) => {
    setErr(null);
    setOut(null);
    setBusy(true);
    try {
      const p = fillPath(e.path);
      let payload;
      if (e.method !== 'GET') {
        try {
          payload = body.trim() ? JSON.parse(body) : {};
        } catch {
          throw new Error('Body is not valid JSON');
        }
      }
      // api.call goes through the session client: expired access tokens
      // rotate silently instead of 401ing until a full reload.
      // HTTP errors still surface with their real status + body below.
      try {
        const data = await api.call(e.method, p, e.method === 'GET' ? undefined : payload, headers);
        setOut({ status: 200, body: data });
      } catch (ex) {
        if (ex && typeof ex.status === 'number') setOut({ status: ex.status, body: ex.body ?? null });
        else throw ex;
      }
    } catch (ex) {
      setErr(ex);
    } finally {
      setBusy(false);
    }
  };

  // Chatbot "Open in docs": load the agent suggestion into the try-it form below.
  const openInDocs = (sug, sugBody, sugPathVals) => {
    const g = GROUPS.find((x) => x.endpoints.some((e) => e.method === sug.method && e.path === sug.path));
    if (!g) return false;
    setBody(sugBody);
    setPathVals(sugPathVals);
    setOut(null);
    setErr(null);
    setOpen(`${g.name}:${sug.method}:${sug.path}`);
    requestAnimationFrame(() => {
      document.getElementById('api-groups')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return true;
  };

  return (
    <>
      <PageTitle title="API Docs" sub="Every Tier-1 endpoint — click to try it with your current session" />
      <Err e={err} />
      {!auth && (
        <Card className="mb-4">
          <p className="text-sm text-normal-text">
            You are browsing anonymously — public endpoints can still be tried. <Link to="/login" className="text-main-blue">Sign in</Link> to try endpoints that need auth.
          </p>
        </Card>
      )}
      <div id="api-groups">
      {GROUPS.map((g) => (
        <Card key={g.name} className="mb-4">
          <h3 className="font-semibold text-main-text mb-2">{g.name}</h3>
          <div className="divide-y divide-slate-100">
            {g.endpoints.map((e) => {
              const k = key(g.name, e);
              const params = [...e.path.matchAll(/(?:^|\/):([A-Za-z0-9_]+)/g)].map((m) => m[1]);
              return (
                <div key={k} className="py-2">
                  <button onClick={() => toggle(g.name, e)} className="w-full flex flex-wrap items-center gap-x-2 gap-y-1 text-left">
                    <Badge tone={METHOD_TONE[e.method] || 'gray'}>{e.method}</Badge>
                    <code className="text-xs font-mono text-main-text break-all min-w-0 flex-1">{e.path}</code>
                    <span className="ml-auto text-xs text-normal-text whitespace-nowrap">
                      {e.auth === 'none' ? 'public' : 'auth'}
                    </span>
                  </button>
                  <p className="text-xs text-normal-text mt-1 ml-1">{e.desc}</p>
                  {open === k && (
                    <div className="mt-2 ml-1 p-3 rounded-2xl bg-background">
                      {params.map((p) => (
                        <div key={p} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 mb-2 text-xs">
                          <span className="font-mono text-main-text sm:w-24 shrink-0 break-all">:{p}</span>
                          <input
                            value={pathVals[p] || ''}
                            onChange={(ev) => setPathVals({ ...pathVals, [p]: ev.target.value })}
                            placeholder={`enter ${p}…`}
                            className="flex-1 px-2 py-1 rounded-xl border border-slate-200 text-xs outline-none"
                          />
                        </div>
                      ))}
                      {e.method !== 'GET' && (
                        <textarea
                          value={body}
                          onChange={(ev) => setBody(ev.target.value)}
                          rows={6}
                          spellCheck={false}
                          className="w-full px-2 py-1 rounded-xl border border-slate-200 text-xs font-mono outline-none mb-2"
                        />
                      )}
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => run(e)}
                          disabled={busy}
                          className="px-4 py-1.5 rounded-2xl text-xs font-medium text-white bg-gradient-to-b from-main-start to-main-end disabled:opacity-60 disabled:cursor-wait inline-flex items-center gap-1.5"
                        >
                          {busy && <Spinner size="xs" className="sdx-spinner-on-dark" />}
                          {busy ? 'Calling…' : 'Try it'}
                        </button>
                        <button
                          onClick={() => copyCurl(g.name, e)}
                          title="Copy as cURL (tokens as $ENV, never pasted raw)"
                          className="px-4 py-1.5 rounded-2xl text-xs font-medium bg-slate-100 text-main-text hover:text-main-blue"
                        >
                          {copied === key(g.name, e) ? 'Copied!' : 'Copy as cURL'}
                        </button>
                      </div>
                      {out && (
                        <div className="mt-2">
                          <Badge tone={out.status < 300 ? 'green' : out.status < 500 ? 'amber' : 'red'}>
                            HTTP {out.status}
                          </Badge>
                          <div className="mt-1">
                            <Code data={out.body} />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      ))}
      </div>
      <Chatbot auth={auth} headers={headers} onOpenInDocs={openInDocs} />
    </>
  );
}
