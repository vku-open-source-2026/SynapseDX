/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faComments, faPaperPlane, faXmark } from '@fortawesome/free-solid-svg-icons';
import { api } from '../lib/api.js';
import { Badge, Code, Dots, Err, Spinner } from './ui.jsx';

const METHOD_TONE = { GET: 'blue', POST: 'green', PUT: 'amber', DELETE: 'red' };

// Floating chatbot: guides API testing on the docs page.
// The agent endpoint (/v1/ai/agent) is intentionally NOT in the public
// catalog — the bot only explains and pre-fills try-it forms, and it
// requires a signed-in session (gateway auth: either).
export default function Chatbot({ auth, headers, onOpenInDocs }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [sug, setSug] = useState(null);
  const [sPathVals, setSPathVals] = useState({});
  const [sBody, setSBody] = useState('');
  const [sOut, setSOut] = useState(null);
  const [sErr, setSErr] = useState(null);
  const [sBusy, setSBusy] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, sug, sOut, open, aiBusy]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const ask = async (ev) => {
    ev?.preventDefault();
    const question = q.trim();
    if (!question || aiBusy) return;
    setQ('');
    setAiBusy(true);
    setSOut(null);
    setSErr(null);
    setMsgs((m) => [...m, { role: 'user', text: question }]);
    const convo = [...msgs, { role: 'user', text: question }].slice(-6).map(({ role, text }) => ({ role, text }));
    try {
      const r = await api.agent(question, convo, headers);
      setMsgs((m) => [...m, { role: 'ai', text: r.guidance || r.explanation || 'I built a try-it form below.' }]);
      if (r.method && r.path) {
        setSug(r);
        setSPathVals(r.pathValues || {});
        setSBody(r.body ? JSON.stringify(r.body, null, 2) : '');
      } else {
        setSug(null);
      }
    } catch (e) {
      // Friendly text in chat; technical detail goes to the console log.
      console.error('[chatbot] agent failed:', e?.message || e);
      const st = e?.status;
      const text =
        st === 401
          ? 'Session expired — sign in again, then ask away.'
          : st === 429
            ? 'Slow down a little — then try again.'
            : 'Sorry, I could not answer that. Try again.';
      setMsgs((m) => [...m, { role: 'ai', text }]);
    } finally {
      setAiBusy(false);
    }
  };

  const pathParams = (p) => [...p.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);

  const tryCall = async () => {
    if (!sug || sBusy) return;
    // The agent generates the call (not the user picking a documented
    // endpoint), so destructive methods get an explicit confirm.
    if ((sug.method === 'PUT' || sug.method === 'PATCH' || sug.method === 'DELETE') && !window.confirm(`${sug.method} ${sug.path} — proceed?`)) {
      return;
    }
    setSErr(null);
    setSOut(null);
    setSBusy(true);
    try {
      const p = sug.path.replace(/:([A-Za-z0-9_]+)/g, (_, n) => {
        const v = (sPathVals[n] || '').trim();
        if (!v) throw new Error(`Enter :${n} to try the call`);
        return encodeURIComponent(v);
      });
      let payload;
      if (sug.method !== 'GET') {
        try {
          payload = sBody.trim() ? JSON.parse(sBody) : {};
        } catch {
          throw new Error('Body is not valid JSON');
        }
      }
      try {
        const data = await api.call(sug.method, p, sug.method === 'GET' ? undefined : payload, headers);
        setSOut({ status: 200, body: data });
      } catch (ex) {
        if (ex && typeof ex.status === 'number') setSOut({ status: ex.status, body: ex.body ?? null });
        else throw ex;
      }
    } catch (ex) {
      setSErr(ex);
    } finally {
      setSBusy(false);
    }
  };

  const openDocs = () => {
    if (!sug) return;
    if (onOpenInDocs?.(sug, sBody, sPathVals)) setOpen(false);
  };

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-4 sm:right-6 z-50 w-[380px] max-w-[calc(100vw-2rem)]">
          <div className="bg-white rounded-3xl shadow-xl flex flex-col max-h-[70vh] overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 bg-gradient-to-b from-main-start to-main-end text-white">
              <FontAwesomeIcon icon={faComments} />
              <div className="flex-1">
                <p className="text-sm font-semibold leading-none">API assistant</p>
                <p className="text-[11px] opacity-90 mt-0.5">Ask to be guided through trying an endpoint</p>
              </div>
              <button onClick={() => setOpen(false)} className="opacity-90 hover:opacity-100" title="Close">
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </div>
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2">
              {msgs.length === 0 && (
                <p className="text-xs text-normal-text">
                  {auth
                    ? 'e.g. "list all orgs", "create a prod account in org acme"…'
                    : 'You are browsing anonymously. Sign in to use the assistant.'}
                </p>
              )}
              {msgs.map((m, i) => (
                <div key={i} className={`text-xs ${m.role === 'user' ? 'text-right' : 'text-left'}`}>
                  <span
                    className={`inline-block px-3 py-1.5 rounded-2xl ${
                      m.role === 'user' ? 'bg-main-blue/10 text-main-blue' : 'bg-slate-100 text-main-text'
                    }`}
                  >
                    {m.text}
                  </span>
                </div>
              ))}
              {aiBusy && (
                <p className="text-xs text-normal-text inline-flex items-center gap-2">
                  Thinking <Dots />
                </p>
              )}
              {!auth && (
                <p className="text-xs text-amber-500">
                  <Link to="/login" className="text-main-blue">Sign in</Link> to use the assistant.
                </p>
              )}
              {sug && (
                <div className="p-3 rounded-2xl bg-background">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge tone={METHOD_TONE[sug.method] || 'gray'}>{sug.method}</Badge>
                    <code className="text-xs font-mono text-main-text break-all">{sug.path}</code>
                  </div>
                  {pathParams(sug.path).map((p) => (
                    <div key={p} className="flex items-center gap-2 mb-2 text-xs">
                      <span className="font-mono text-main-text w-20">:{p}</span>
                      <input
                        value={sPathVals[p] || ''}
                        onChange={(ev) => setSPathVals({ ...sPathVals, [p]: ev.target.value })}
                        placeholder={`enter ${p}…`}
                        className="flex-1 px-2 py-1 rounded-xl border border-slate-200 text-xs outline-none"
                      />
                    </div>
                  ))}
                  {sug.method !== 'GET' && (
                    <textarea
                      value={sBody}
                      onChange={(ev) => setSBody(ev.target.value)}
                      rows={5}
                      spellCheck={false}
                      className="w-full px-2 py-1 rounded-xl border border-slate-200 text-xs font-mono outline-none mb-2"
                    />
                  )}
                  <div className="flex gap-2 mb-2">
                    <button
                      onClick={tryCall}
                      disabled={sBusy}
                      className="px-4 py-1.5 rounded-2xl text-xs font-medium text-white bg-gradient-to-b from-main-start to-main-end disabled:opacity-60 disabled:cursor-wait inline-flex items-center gap-1.5"
                    >
                      {sBusy && <Spinner size="xs" className="sdx-spinner-on-dark" />}
                      {sBusy ? 'Calling…' : 'Try it'}
                    </button>
                    <button
                      onClick={openDocs}
                      className="px-4 py-1.5 rounded-2xl text-xs font-medium bg-slate-100 text-main-text hover:text-main-blue"
                    >
                      Open in docs
                    </button>
                  </div>
                  <Err e={sErr} />
                  {sOut && (
                    <div className="mt-2">
                      <Badge tone={sOut.status < 300 ? 'green' : sOut.status < 500 ? 'amber' : 'red'}>
                        HTTP {sOut.status}
                      </Badge>
                      <div className="mt-1">
                        <Code data={sOut.body} />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <form onSubmit={ask} className="flex gap-2 p-3 border-t border-slate-100">
              <input
                value={q}
                onChange={(ev) => setQ(ev.target.value)}
                placeholder="Ask anything…"
                disabled={!auth || aiBusy}
                className="flex-1 px-3 py-2 rounded-2xl border border-slate-200 text-xs outline-none"
              />
              <button
                type="submit"
                disabled={!auth || aiBusy || !q.trim()}
                title="Send"
                className="w-9 h-9 rounded-full text-white bg-gradient-to-b from-main-start to-main-end disabled:opacity-50"
              >
                <FontAwesomeIcon icon={faPaperPlane} size="xs" />
              </button>
            </form>
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen(!open)}
        title={open ? 'Close assistant' : 'Ask the API assistant'}
        className="fixed bottom-6 right-4 sm:right-6 z-50 w-14 h-14 rounded-full text-white text-xl shadow-xl bg-gradient-to-b from-main-start to-main-end hover:opacity-90"
      >
        <FontAwesomeIcon icon={open ? faXmark : faComments} />
      </button>
    </>
  );
}
