/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
// SSR smoke test: render every route's default state to a string (no browser).
// Catches module-eval crashes, missing providers (useScope outside ScopeProvider),
// unbound identifiers on default branches, and broken imports — without jsdom.
// State-dependent branches (modals, suggestion panels) are covered by reviews;
// data fetching never runs under renderToString (effects don't fire server-side).
// Run: npm run test:ssr (bundles with esbuild, then executes).
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './lib/auth.jsx';
import App from './App.jsx';
import WorkflowEditor from './components/WorkflowEditor.jsx';

const ROUTES = [
  '/',
  '/login',
  '/oidc/callback',
  '/dashboard',
  '/orgs',
  '/accounts',
  '/users',
  '/roles',
  '/policies',
  '/keys',
  '/service-accounts',
  '/workflows',
  '/authorize',
  '/audit',
  '/api-docs',
  '/docs',
  '/nope-not-a-route',
];

const SESSIONS = {
  anon: null,
  key: { apiKey: 'synapsedx_test' },
};

const GUARDED = new Set([
  '/dashboard',
  '/orgs',
  '/accounts',
  '/users',
  '/roles',
  '/policies',
  '/keys',
  '/service-accounts',
  '/workflows',
  '/authorize',
  '/audit',
]);

let failures = 0;
for (const [label, session] of Object.entries(SESSIONS)) {
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k === 'synapsedx.console.auth' && session ? JSON.stringify(session) : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  // Silent the expected console.error from ErrorBoundary probes (none expected).
  for (const path of ROUTES) {
    try {
      const html = renderToString(
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>,
      );
      // Anonymous hits on guarded routes render <Navigate> (empty in SSR) —
      // the client performs the redirect. Same for /login with a live session.
      // Everything else must produce HTML.
      const expectHtml = (session || !GUARDED.has(path)) && !(session && path === '/login');
      if (expectHtml && (typeof html !== 'string' || html.length === 0)) throw new Error('empty render');
      console.log(`ok [${label}] ${path} (${html.length} chars)`);
    } catch (e: any) {
      failures++;
      console.error(`FAIL [${label}] ${path}: ${e?.message || e}`);
    }
  }
}
if (failures > 0) {
  console.error(`${failures} route(s) failed to render`);
  process.exit(1);
}

// Visual workflow editor (default visual tab, empty selection) — catches JSX
// crashes in the overlay/palette/canvas/inspector default branches.
try {
  const editorHtml = renderToString(
    <WorkflowEditor
      workflowId="w1"
      initial={{
        name: 'demo',
        nodes: [
          { id: 'a', name: 'Webhook', type: 'n8n-nodes-base.webhook', position: [200, 300], parameters: { path: 'ev' } },
          { id: 'b', name: 'Log', type: 'n8n-nodes-base.noOp', position: [420, 300], parameters: {} },
        ],
        connections: { Webhook: { main: [[{ node: 'Log', type: 'main', index: 0 }]] } },
      }}
      headers={{}}
      onClose={() => undefined}
      onSaved={() => undefined}
    />,
  );
  if (editorHtml.length === 0) throw new Error('empty editor render');
  console.log(`ok [editor] visual default (${editorHtml.length} chars)`);
} catch (e: any) {
  console.error(`FAIL [editor]: ${e?.message || e}`);
  process.exit(1);
}
console.log('ssr smoke: all routes render');
