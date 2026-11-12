// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { BookOpen, BrainCircuit, Database, ShieldCheck, Workflow } from 'lucide-react';
import { PublicHeader } from '../components/PublicHeader';
import { PublicFooter } from '../components/PublicFooter';
import { API_DOCS, REPO } from '../lib/site';

const BASE = 'https://synapsedx.sbs';

const TOC = [
  { id: 'overview', label: 'Overview' },
  { id: 'quickstart', label: 'Quickstart' },
  { id: 'auth', label: 'Authentication' },
  { id: 'datasets', label: 'Datasets & records' },
  { id: 'jobs', label: 'Jobs & workflows' },
  { id: 'ai', label: 'AI & inference' },
  { id: 'files', label: 'Files & notifications' },
  { id: 'errors', label: 'Errors & limits' },
  { id: 'mcp', label: 'AI docs over MCP' },
];

function Section({ id, title, kicker, children }: { id: string; title: string; kicker?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-dx-line pt-9 first:border-t-0 first:pt-0">
      {kicker && <p className="mb-1 font-mono text-xs text-dx-muted">{kicker}</p>}
      <h2 className="text-xl font-semibold tracking-tight text-dx-fg">{title}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-7 text-dx-muted">{children}</div>
    </section>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <pre className="overflow-x-auto rounded-xl border border-dx-line bg-dx-surface p-4 text-xs leading-6 text-dx-fg"><code>{children}</code></pre>;
}

function Endpoint({ method, path, desc }: { method: string; path: string; desc: string }) {
  return (
    <div className="grid gap-1 border-t border-dx-line py-2.5 sm:grid-cols-[4.5rem_1fr]">
      <span className="font-mono text-[11px] font-semibold text-cyan-600">{method}</span>
      <div>
        <code className="break-all font-mono text-xs text-dx-fg">{path}</code>
        <p className="mt-0.5 text-xs text-dx-muted">{desc}</p>
      </div>
    </div>
  );
}

export function DocsPage() {
  return (
    <div className="min-h-screen bg-dx-bg text-dx-fg">
      <PublicHeader />
      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="mb-8 max-w-3xl">
          <p className="mb-2 inline-flex items-center gap-2 rounded-full border border-dx-line px-3 py-1 text-xs text-dx-muted">
            <BookOpen className="h-3.5 w-3.5" /> Tier-2 documentation
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">SynapseDX docs</h1>
          <p className="mt-3 text-dx-muted">
            Reusable capabilities built on SynapseOne: datasets, records, jobs, AI, files, notifications and audit.
            Every request goes through the public Tier-2 gateway; callers authenticate with a SynapseOne JWT or API key.
          </p>
          <p className="mt-2 text-sm text-dx-muted">
            Full raw reference: <a className="text-cyan-600 underline" href={API_DOCS} target="_blank" rel="noreferrer">docs/API.md</a>
            {' · '}<a className="text-cyan-600 underline" href={REPO} target="_blank" rel="noreferrer">source repository</a>
          </p>
        </div>

        <div className="grid gap-10 lg:grid-cols-[220px_1fr]">
          <aside className="hidden lg:block">
            <div className="sticky top-24">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-dx-muted">On this page</p>
              <nav className="space-y-1 text-sm">
                {TOC.map((item) => (
                  <a key={item.id} href={`#${item.id}`} className="block rounded-lg px-2 py-1.5 text-dx-muted hover:bg-dx-surface hover:text-dx-fg">{item.label}</a>
                ))}
              </nav>
            </div>
          </aside>

          <div className="min-w-0 space-y-10">
            <Section id="overview" title="Overview" kicker="Tier 2">
              <p>
                SynapseDX exposes reusable capabilities to Tier-3 products. It owns capability semantics and talks to
                SynapseOne only through the published <code className="font-mono text-xs">@synapseone/sdk</code>.
                Data, queues, identity, workflows and inference stay Tier-1.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  [Database, 'Datasets & records', 'Capability metadata, validated records and public NGSI-LD projections.'],
                  [Workflow, 'Jobs & workflows', 'Scheduled Tier-1 workflows or runner-leased jobs.'],
                  [BrainCircuit, 'AI & inference', 'Chat, embeddings and decision routes through the Tier-1 inference capability.'],
                  [ShieldCheck, 'Identity & audit', 'Bearer JWT or API key, tenant-scoped audit and usage.'],
                ].map(([Icon, title, body]) => (
                  <div key={String(title)} className="rounded-2xl border border-dx-line bg-dx-surface p-4">
                    <Icon className="mb-2 h-5 w-5 text-cyan-600" />
                    <div className="font-medium text-dx-fg">{title as string}</div>
                    <p className="mt-1 text-xs leading-5 text-dx-muted">{body as string}</p>
                  </div>
                ))}
              </div>
            </Section>

            <Section id="quickstart" title="Quickstart" kicker="5 minutes">
              <p>Base URL: <code className="font-mono text-xs">{BASE}</code>. Health check:</p>
              <Code>{`curl -s ${BASE}/health
# { "status": "ok", "service": "capabilities", ... }`}</Code>
              <p>Authenticated call with a SynapseOne access token or API key:</p>
              <Code>{`curl -s ${BASE}/v1/capabilities/datasets \\
  -H "Authorization: Bearer $SYNAPSEONE_TOKEN"

# API keys can use X-API-Key (or Bearer for MCP clients)
curl -s ${BASE}/v1/capabilities/datasets \\
  -H "X-API-Key: $SYNAPSEONE_API_KEY"`}</Code>
            </Section>

            <Section id="auth" title="Authentication" kicker="Gateway">
              <p>
                The gateway verifies SynapseOne credentials and stamps the tenant before forwarding to the capabilities
                service. The server-side <code className="font-mono text-xs">SYNAPSEONE_API_KEY</code> is only used by
                SynapseDX to call Tier 1; it is never a caller fallback.
              </p>
              <ul className="list-disc space-y-1.5 pl-5">
                <li>User JWT: full scopes of the signed-in user.</li>
                <li>API key: narrow scopes such as <code className="font-mono text-xs">base:read</code>, <code className="font-mono text-xs">inference:invoke</code>.</li>
                <li>Cross-tenant reads return 404; authorization failures return 403.</li>
                <li>Every mutating call is audited with the caller’s tenant and request id.</li>
              </ul>
            </Section>

            <Section id="datasets" title="Datasets & records" kicker="Capabilities">
              <Endpoint method="GET" path="/v1/capabilities/datasets" desc="List capability datasets visible to the caller." />
              <Endpoint method="POST" path="/v1/capabilities/datasets" desc="Create a dataset (name, schema, visibility)." />
              <Endpoint method="GET" path="/v1/capabilities/datasets/:id" desc="Dataset metadata and versions." />
              <Endpoint method="POST" path="/v1/capabilities/datasets/:id/records" desc="Insert or upsert validated records." />
              <Endpoint method="POST" path="/v1/capabilities/datasets/:id/query" desc="Filter, sort and paginate records." />
              <Endpoint method="GET" path="/v1/capabilities/datasets/:id/entities" desc="Public NGSI-LD projection." />
              <p>Records are validated against the dataset schema before they reach SynapseBase/LDS. Use <code className="font-mono text-xs">Idempotency-Key</code> on writes that may be retried.</p>
            </Section>

            <Section id="jobs" title="Jobs & workflows" kicker="Automation">
              <p>
                Jobs use <code className="font-mono text-xs">executor: "workflow"</code> for a Tier-1 cron workflow, or
                <code className="mx-1 font-mono text-xs">executor: "runner"</code> for a Tier-3 lease contract.
              </p>
              <Endpoint method="GET" path="/v1/capabilities/jobs" desc="List jobs with status, schedule and workflow id." />
              <Endpoint method="POST" path="/v1/capabilities/jobs" desc="Create a scheduled job; creates and activates the Tier-1 workflow." />
              <Endpoint method="POST" path="/v1/capabilities/jobs/:id/run" desc="Trigger a run now." />
              <Endpoint method="GET" path="/v1/capabilities/jobs/:id/executions" desc="Execution history projection." />
            </Section>

            <Section id="ai" title="AI & inference" kicker="Models">
              <Endpoint method="POST" path="/v1/capabilities/ai/chat" desc="Chat completion through Tier-1 inference." />
              <Endpoint method="POST" path="/v1/capabilities/ai/embeddings" desc="Embedding vectors for semantic search." />
              <Endpoint method="POST" path="/v1/capabilities/ai/decision" desc="Decision route with confidence and fallback." />
              <p>The capability service uses its scoped SynapseOne key; caller credentials are never forwarded as a Tier-1 fallback.</p>
            </Section>

            <Section id="files" title="Files & notifications" kicker="Platform">
              <Endpoint method="POST" path="/v1/capabilities/files" desc="Upload a binary object through SynapseOCS." />
              <Endpoint method="GET" path="/v1/capabilities/files/:id" desc="Metadata and a short-lived signed URL." />
              <Endpoint method="POST" path="/v1/capabilities/notifications" desc="Queue an outbox notification (email/webhook)." />
              <Endpoint method="GET" path="/v1/capabilities/notifications/:id" desc="Delivery status and retry count." />
            </Section>

            <Section id="errors" title="Errors & limits" kicker="Contract">
              <p>Errors use one envelope everywhere:</p>
              <Code>{`{ "error": "invalid_request", "message": "human readable", "requestId": "..." }`}</Code>
              <ul className="list-disc space-y-1.5 pl-5">
                <li><code className="font-mono text-xs">400</code> validation, <code className="font-mono text-xs">401</code> missing/invalid credential, <code className="font-mono text-xs">403</code> scope/tenant, <code className="font-mono text-xs">404</code> hidden existence, <code className="font-mono text-xs">409</code> conflict, <code className="font-mono text-xs">429</code> rate limit.</li>
                <li>List endpoints use <code className="font-mono text-xs">limit</code> and <code className="font-mono text-xs">offset</code>; default 20, max 100.</li>
                <li>Signed URLs and file downloads are short-lived; never cache them in logs.</li>
              </ul>
            </Section>

            <Section id="mcp" title="AI docs over MCP" kicker="SynapseFlow">
              <p>
                SynapseDX ships the same docs-reader workflow as SynapseOne in
                <code className="mx-1 font-mono text-xs">workflows/mcp-docs-reader.json</code>. It exposes an MCP tool
                backed by a SynapseFlow <code className="font-mono text-xs">mcpTrigger</code>; the workflow fetches the
                requested docs file from this repository and returns it as MCP text.
              </p>
              <p>
                Point an MCP client (Claude, Cursor, …) at the SynapseOne gateway:
              </p>
              <Code>{`{
  "mcpServers": {
    "synapsedx-docs": {
      "url": "https://api.synapseone.space/mcp",
      "headers": { "X-API-Key": "<SYNAPSEONE_API_KEY>" }
    }
  }
}`}</Code>
              <p>
                The tool is <code className="font-mono text-xs">read_synapsedx_docs</code> and accepts
                <code className="mx-1 font-mono text-xs">{`{ "path": "docs/API.md" }`}</code>.
                Edit the workflow JSON in git, then provision it through the product pipeline; the JSON is the source of truth.
              </p>
              <p className="text-xs">
                See <Link to="/about" className="text-cyan-600 underline">About</Link> for the architecture and
                <a href={API_DOCS} target="_blank" rel="noreferrer" className="ml-1 text-cyan-600 underline">the raw API reference</a>.
              </p>
            </Section>
          </div>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
