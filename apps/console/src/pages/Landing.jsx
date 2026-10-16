/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBolt,
  faKey,
  faLayerGroup,
  faRobot,
  faShieldHalved,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons';
import PublicHeader from '../components/PublicHeader.jsx';
import { appDashboardUrl, isCanonicalAppHost } from '../lib/site.js';

const FEATURES = [
  { icon: faShieldHalved, title: 'AWS-style IAM', text: 'Organization → Account → User → Role → JSON Policy (Allow/Deny, Condition), authorize + simulator + audit log.' },
  { icon: faKey, title: 'Flexible tokens', text: 'Short-lived JWT, atomic rotating refresh, API keys, service accounts, OIDC via Authentik/Keycloak.' },
  { icon: faBolt, title: 'API Gateway', text: 'Single entry point: auth, edge rate-limiting, principal propagation, tracing, aggregate /ready.' },
  { icon: faLayerGroup, title: 'Core data cluster', text: 'Postgres + Redis + S3-compatible storage, versioned schema, idempotent seed, backup/restore.' },
  { icon: faRobot, title: 'Workflows', text: 'Local engine: versioned templates, sandboxed code, activate/execute, webhooks + cron, definition editor.' },
  { icon: faWandMagicSparkles, title: 'AI assistant + SDKs', text: 'Chatbot on the API Docs pre-fills try-it forms; JS/TS, Python, Go, a zero-dependency CLI and an admin Console — one API.' },
];

export default function Landing() {
  // Web chinh (@): nut Mo Console tro ve canonical app (cloud.*) theo env.
  const offSite = !isCanonicalAppHost();
  const openConsoleHref = appDashboardUrl();
  return (
    <div className="min-h-screen">
      <PublicHeader />

      <main className="mx-auto max-w-6xl px-4 pt-28 sm:pt-32 pb-16 text-center">
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-main-text leading-tight">
          The <span className="bg-gradient-to-b from-main-start to-main-end bg-clip-text text-transparent">open</span>
          <br />
          PaaS for your infrastructure
        </h1>
        <p className="mt-4 text-normal-text max-w-2xl mx-auto">
          SynapseDX is an open-source Tier-1 PaaS (Apache-2.0): API gateway, AWS-style IAM,
          core data cluster and workflows — managed via Console, multi-language SDKs and CLI.
        </p>
        <div className="mt-6 flex flex-col sm:flex-row justify-center items-stretch sm:items-center gap-3 max-w-md sm:max-w-none mx-auto">
          {offSite ? (
            <a href={openConsoleHref} className="px-6 py-2.5 rounded-2xl text-white font-medium bg-gradient-to-b from-main-start to-main-end shadow-md">
              Open Console
            </a>
          ) : (
            <Link to="/login" className="px-6 py-2.5 rounded-2xl text-white font-medium bg-gradient-to-b from-main-start to-main-end shadow-md">
              Open Console
            </Link>
          )}
          <Link to="/api-docs" className="px-6 py-2.5 rounded-2xl bg-white font-medium text-main-text shadow-md">
            Explore the API
          </Link>
        </div>
        <div className="mt-6 inline-block bg-white rounded-2xl shadow-sm px-4 py-2 text-xs font-mono text-main-text">
          docker compose up -d --build
        </div>

        <div className="mt-8 mx-auto max-w-2xl bg-white rounded-3xl shadow-md p-6 text-left">
          <h2 className="font-semibold text-main-text">Install the CLI</h2>
          <p className="text-sm text-normal-text mt-1 mb-3">
            One line, no clone needed — or run it instantly with npx (Node 18+).
          </p>
          <pre className="bg-background rounded-2xl p-4 text-xs font-mono overflow-x-auto text-main-text">
{`curl -fsSL https://synapsedx.sbs/install.sh | sh
# ..or without installing anything:
npx -y @synapsedx/cli@latest --help`}
          </pre>
        </div>

        <div className="mt-14 grid sm:grid-cols-2 md:grid-cols-3 gap-4 text-left">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-white rounded-3xl shadow-md p-6">
              <div className="w-10 h-10 rounded-2xl flex items-center justify-center text-white bg-gradient-to-b from-main-start to-main-end mb-3">
                <FontAwesomeIcon icon={f.icon} />
              </div>
              <h3 className="font-semibold text-main-text">{f.title}</h3>
              <p className="text-sm text-normal-text mt-1">{f.text}</p>
            </div>
          ))}
        </div>

        <div className="mt-14 bg-white rounded-3xl shadow-md p-8 text-left">
          <h2 className="text-2xl font-semibold text-main-text">Self-host in 3 commands</h2>
          <pre className="mt-3 bg-background rounded-2xl p-4 text-xs font-mono overflow-x-auto text-main-text">
{`cp .env.example .env   # then replace every *_change_me_* secret
docker compose up -d --build
open http://localhost:3000   # sign in: demo@acme.local / org acme`}
          </pre>
        </div>
      </main>

      <footer className="pb-10 text-center text-xs text-normal-text">
        synapsedx · Apache-2.0 · Tier-1 PaaS
      </footer>
    </div>
  );
}
