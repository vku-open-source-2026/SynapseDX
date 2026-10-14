/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React, { useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Badge, Btn, Card, Code, Err, Field, Input, PageTitle } from '../components/ui.jsx';

export default function Authorize() {
  const { headers } = useAuth();
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState('workflow:Execute');
  const [resource, setResource] = useState('*');
  const [context, setContext] = useState('{\n  "team": "etl"\n}');
  const [doc, setDoc] = useState(
    JSON.stringify(
      {
        Version: '2026-01-01',
        Statement: [{ Effect: 'Allow', Action: ['workflow:Execute'], Resource: '*', Condition: { StringEquals: { team: 'etl' } } }],
      },
      null,
      2,
    ),
  );
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);

  const run = async (dry) => {
    setErr(null);
    setOut(null);
    try {
      let ctx = {};
      try {
        ctx = context.trim() ? JSON.parse(context) : {};
      } catch {
        throw new Error('Context is not valid JSON');
      }
      if (dry) {
        let docs;
        try {
          docs = JSON.parse(doc);
        } catch {
          throw new Error('Document is not valid JSON');
        }
        const docsArr = Array.isArray(docs) ? docs : [docs];
        setOut(await api.simulate(docsArr, action, resource, ctx, headers));
      } else {
        if (!userId) throw new Error('Enter a userId for a live authorize check');
        setOut(await api.authorize(userId, action, resource, ctx, headers));
      }
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <>
      <PageTitle title="Authorize" sub="Check permissions: dry-run simulator or live per-user authorize" />
      <Err e={err} />
      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <Field label="Action (e.g. workflow:Execute)">
            <Input value={action} onChange={(e) => setAction(e.target.value)} />
          </Field>
          <Field label="Resource (e.g. * or arn:synapsedx:...)">
            <Input value={resource} onChange={(e) => setResource(e.target.value)} />
          </Field>
          <Field label="Context JSON (for Condition)">
            <textarea value={context} onChange={(e) => setContext(e.target.value)} rows={4} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono outline-none focus:border-main-blue" />
          </Field>
          <div className="flex gap-2">
            <Btn onClick={() => run(true)}>Dry-run simulator</Btn>
          </div>
        </Card>
        <Card>
          <Field label="Policy documents (for dry-run)">
            <textarea value={doc} onChange={(e) => setDoc(e.target.value)} rows={10} className="w-full px-3 py-2 rounded-2xl border border-slate-200 text-xs font-mono outline-none focus:border-main-blue" />
          </Field>
          <Field label="User ID (for live authorize)">
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="user uuid" />
          </Field>
          <Btn kind="ghost" onClick={() => run(false)}>
            Live authorize
          </Btn>
        </Card>
      </div>
      {out && (
        <Card className="mt-4">
          <div className="flex items-center gap-2 mb-2">
            {typeof out.allowed === 'boolean' ? (
              <>
                <Badge tone={out.allowed ? 'green' : 'red'}>{out.allowed ? 'ALLOW' : 'DENY'}</Badge>
                {out.matchedBy && <span className="text-xs text-normal-text">matched by {out.matchedBy}</span>}
              </>
            ) : (
              <Badge tone="amber">Unexpected response shape</Badge>
            )}
          </div>
          <Code data={out} />
        </Card>
      )}
    </>
  );
}
