/*
 * Copyright 2026 OLP Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Workflow service: thin control-plane over n8n REST API.
 * Không fork n8n — gọi n8n như engine ngoài qua N8N_BASE_URL + N8N_API_KEY.
 */
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';

dotenv.config();
const PORT = Number(process.env.PORT || 4002);
const N8N_BASE_URL = (process.env.N8N_BASE_URL || 'http://n8n:5678').replace(/\/$/, '');
const N8N_API_KEY = process.env.N8N_API_KEY || '';

async function n8nFetch(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const url = `${N8N_BASE_URL}${path}`;
  try {
    const r = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(N8N_API_KEY ? { 'X-N8N-API-KEY': N8N_API_KEY } : {}),
        ...((init?.headers as any) || {}),
      },
    });
    const text = await r.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: r.status, body };
  } catch (e: any) {
    return { status: 502, body: { error: 'n8n_unreachable', message: e.message, hint: 'kiểm tra N8N_BASE_URL + mạng docker' } };
  }
}

export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  app.use(morgan('combined'));
  app.use(express.json({ limit: '2mb' }));

  // Bọc async handler (Express 4 không catch async throw).
  for (const m of ['get', 'post', 'put', 'delete', 'patch'] as const) {
    const orig = ((app as any)[m] as Function).bind(app);
    (app as any)[m] = (path: string, ...handlers: any[]) =>
      orig(
        path,
        ...handlers.map((h: any) =>
          typeof h === 'function' && h.length < 4
            ? (req: express.Request, res: express.Response, next: express.NextFunction) =>
                Promise.resolve(h(req, res, next)).catch(next)
            : h,
        ),
      );
  }

  app.get('/health', async (_req, res) => {
    const n8n = await n8nFetch('/healthz').catch(() => ({ status: 0, body: null }));
    res.json({ status: 'ok', service: 'workflow', n8n: N8N_BASE_URL, n8nStatus: (n8n as any).status, time: new Date().toISOString() });
  });

  // List workflows (proxy)
  app.get('/v1/workflows', async (_req, res) => {
    const r = await n8nFetch('/api/v1/workflows');
    res.status(r.status).json(r.body);
  });

  // Get one workflow (proxy)
  app.get('/v1/workflows/:id', async (req, res) => {
    const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(req.params.id)}`);
    res.status(r.status).json(r.body);
  });

  // Create workflow from template or raw definition
  app.post('/v1/workflows', async (req, res) => {
    const { name, definition, template } = req.body as any;
    let payload: any = definition;
    if (template && !definition) {
      payload = buildTemplate(template, name);
      if (!payload) return res.status(400).json({ error: 'unknown_template', available: listTemplates().map((t) => t.name) });
    }
    if (!payload) return res.status(400).json({ error: 'definition or template required' });
    const r = await n8nFetch('/api/v1/workflows', { method: 'POST', body: JSON.stringify({ name: name || 'olp-workflow', nodes: payload.nodes || [], connections: payload.connections || {}, settings: {} }) });
    res.status(r.status).json(r.body);
  });

  // Execute workflow (n8n webhook or manual trigger proxy)
  app.post('/v1/workflows/:id/execute', async (req, res) => {
    const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(req.params.id)}/execute`, {
      method: 'POST',
      body: JSON.stringify(req.body || {}),
    });
    res.status(r.status).json(r.body);
  });

  // Activate / deactivate (proxy)
  app.post('/v1/workflows/:id/activate', async (req, res) => {
    const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(req.params.id)}/activate`, { method: 'POST' });
    res.status(r.status).json(r.body);
  });

  app.post('/v1/workflows/:id/deactivate', async (req, res) => {
    const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(req.params.id)}/deactivate`, { method: 'POST' });
    res.status(r.status).json(r.body);
  });

  // Proxy executions list
  app.get('/v1/executions', async (req, res) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const r = await n8nFetch(`/api/v1/executions${qs}`);
    res.status(r.status).json(r.body);
  });

  // Get one execution (proxy)
  app.get('/v1/executions/:id', async (req, res) => {
    const r = await n8nFetch(`/api/v1/executions/${encodeURIComponent(req.params.id)}`);
    res.status(r.status).json(r.body);
  });

  // Built-in templates (versioned JSON, dùng khi n8n chưa có workflow)
  app.get('/v1/templates', (_req, res) => res.json(listTemplates()));
  app.get('/v1/templates/:name', (req, res) => {
    const t = buildTemplate(req.params.name, req.params.name);
    if (!t) return res.status(404).json({ error: 'template_not_found' });
    res.json(t);
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[workflow] unhandled:', err?.message || err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

export function listTemplates() {
  return [
    { name: 'webhook-to-log', description: 'Webhook nhận event từ gateway -> ghi log -> trả lời 200' },
    { name: 'cron-etl', description: 'Cron mỗi đêm -> fetch IAM health -> transform -> log' },
    { name: 'iam-webhook', description: 'Nhận sự kiện IAM (user.created) -> gọi lại OLP API' },
  ];
}

export function buildTemplate(name: string, workflowName?: string): any | null {
  const wname = workflowName || name;
  const wid = () => (globalThis.crypto as any)?.randomUUID?.() || Math.random().toString(36).slice(2);
  if (name === 'webhook-to-log') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'olp-event', httpMethod: 'POST' } },
        { id: wid(), name: 'Log', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [400, 300], parameters: {} },
      ],
      connections: { Webhook: { main: [[{ node: 'Log', type: 'main', index: 0 }]] } },
    };
  }
  if (name === 'cron-etl') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'Cron', type: 'n8n-nodes-base.cron', typeVersion: 1, position: [200, 300], parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 24 }] } } },
        { id: wid(), name: 'FetchIAM', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [400, 300], parameters: { url: 'http://iam:4001/health', method: 'GET' } },
      ],
      connections: { Cron: { main: [[{ node: 'FetchIAM', type: 'main', index: 0 }]] } },
    };
  }
  if (name === 'iam-webhook') {
    return {
      name: wname,
      nodes: [
        { id: wid(), name: 'IAMEvent', type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: wid(), position: [200, 300], parameters: { path: 'iam-event', httpMethod: 'POST' } },
        { id: wid(), name: 'CallOLP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [420, 300], parameters: { url: 'http://gateway:8080/v1/orgs', method: 'GET' } },
      ],
      connections: { IAMEvent: { main: [[{ node: 'CallOLP', type: 'main', index: 0 }]] } },
    };
  }
  return null;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => console.log(`[workflow] listening on :${PORT} n8n=${N8N_BASE_URL}`));
}
