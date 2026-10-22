/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0;
 */
// AI service: LLM-assisted API testing agent.
// Giống workflow-service: gọi engine ngoài (OpenAI-compatible LLM API)
// qua env — API key ở server-side, KHÔNG bao giờ xuống browser.
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { timingSafeEqual } from 'crypto';
import { runAgent, AgentError, AgentConfig } from './agent';
import { LlmError, chatJson, chatComplete } from './llm';

dotenv.config();
const PORT = Number(process.env.PORT || 4003);
const VERSION = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export function createApp(): express.Express {
  const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const AI_API_KEY = process.env.AI_API_KEY || '';
  const AI_DECISION_MODEL = process.env.AI_DECISION_MODEL || 'inception/mercury-2.5';
  const AI_LLM_MODEL = process.env.AI_LLM_MODEL || 'liquid/lfm-2.5-2.6b:free';
  // Fallback model for the generate/guide steps (different provider =
  // uncorrelated outages). Defaults to the decision model; empty disables.
  const AI_LLM_FALLBACK_MODEL = (process.env.AI_LLM_FALLBACK_MODEL ?? AI_DECISION_MODEL).trim();
  // Numeric envs are operator-controlled: garbage must fall back to safe
  // defaults, never NaN (NaN timeout = instant abort, NaN retries = no
  // attempts, NaN rate limit = limiter never fires).
  const num = (raw: string | undefined, fallback: number, min: number, max: number): number => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.floor(n), min), max);
  };
  const AGENT_TIMEOUT_MS = num(process.env.AI_TIMEOUT_MS, 20000, 1000, 300000);
  const AGENT_RETRIES = num(process.env.AI_RETRIES, 2, 0, 3);
  const IS_PROD = process.env.NODE_ENV === 'production';

  if (IS_PROD) {
    if (!process.env.SYNAPSEDX_INTERNAL_SECRET) {
      throw new Error('[ai] SYNAPSEDX_INTERNAL_SECRET must be set in production');
    }
    if (!AI_API_KEY) {
      throw new Error('[ai] AI_API_KEY must be set in production');
    }
  }
  if (!AI_API_KEY) {
    console.warn('[ai][security] AI_API_KEY not set — /v1/ai/agent returns 503 (dev default).');
  }

  const app = express();
  app.disable('x-powered-by');
  // Baseline security headers (no extra dep; API-only service).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if ((process.env.HSTS_ENABLED || 'false') === 'true') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  app.use(cors((() => {
    const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!origins.length) {
      if (!IS_PROD) console.warn('[ai][security] CORS_ORIGIN not set — allowing all origins (dev default).');
      return undefined;
    }
    return { origin: origins } as any;
  })()));
  app.use(morgan(':method :url :status :response-time ms rid=:req[x-request-id]'));
  // Echo/propagate x-request-id (see iam-service for rationale).
  app.use(((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const incoming = String(req.headers['x-request-id'] || '').replace(/[^A-Za-z0-9._~-]/g, '').slice(0, 128);
    const id = incoming || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    (req.headers as any)['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    next();
  }) as any);
  app.use(express.json({ limit: '2mb' }));

  // Defense-in-depth: giống workflow-service — khi SYNAPSEDX_INTERNAL_SECRET
  // được set, mọi /v1/* phải mang header x-synapsedx-internal khớp.
  const INTERNAL_SECRET = process.env.SYNAPSEDX_INTERNAL_SECRET || '';
  if (!INTERNAL_SECRET) {
    console.warn('[ai][security] SYNAPSEDX_INTERNAL_SECRET not set — service-to-service auth disabled (dev default). Set it in production.');
  }
  app.use('/v1/' as any, ((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!INTERNAL_SECRET) {
      if (IS_PROD) return res.status(500).json({ error: 'misconfigured', message: 'internal secret required in production' });
      return next();
    }
    const raw = req.headers['x-synapsedx-internal'] as string | string[] | undefined;
    const got = Array.isArray(raw) ? (raw[0] || '') : (raw || '');
    const a = Buffer.from(got);
    const b = Buffer.from(INTERNAL_SECRET);
    const ok = got.length > 0 && a.length === b.length && timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal credential' });
    next();
  }) as any);

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

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'ai',
      version: VERSION,
      models: { decision: AI_DECISION_MODEL, llm: AI_LLM_MODEL, fallback: AI_LLM_FALLBACK_MODEL || null },
      configured: Boolean(AI_API_KEY),
      time: new Date().toISOString(),
    });
  });

  // In-memory limiter: LLM calls tốn tiền — giới hạn theo principal
  // (gateway đã stamp x-synapsedx-user/x-synapsedx-account từ JWT/API key).
  const hits = new Map<string, { n: number; reset: number }>();
  const WINDOW_MS = 60_000;
  const LIMIT = num(process.env.AI_RATE_LIMIT, 30, 1, 1000);
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, WINDOW_MS).unref?.();
  function agentLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
    const principal =
      String(req.headers['x-synapsedx-user'] || req.headers['x-synapsedx-account'] || '') ||
      String(req.ip || req.socket?.remoteAddress || 'anon').slice(0, 64);
    const now = Date.now();
    const cur = hits.get(principal);
    if (!cur || cur.reset < now) {
      hits.set(principal, { n: 1, reset: now + WINDOW_MS });
      return next();
    }
    cur.n++;
    if (cur.n > LIMIT) {
      return res.status(429).json({ error: 'rate_limited', message: 'Too many agent requests, slow down' });
    }
    return next();
  }

  // Agent: hỏi bằng ngôn ngữ tự nhiên → decision model chọn endpoint,
  // LLM tạo path params + JSON body gọi thử.
  app.post('/v1/ai/agent', agentLimit as any, async (req, res) => {
    if (!AI_API_KEY) {
      return res.status(503).json({ error: 'ai_not_configured', message: 'AI_API_KEY is not set on the server' });
    }
    const { question, history } = (req.body || {}) as { question?: unknown; history?: unknown };
    if (typeof question !== 'string' || !question.trim() || question.length > 2000) {
      return res.status(400).json({ error: 'invalid_question', message: 'question must be a 1..2000 char string' });
    }
    // Conversation history: strict shape, server-side caps (client is untrusted).
    let convo: Array<{ role: string; text: string }> = [];
    if (history !== undefined) {
      if (!Array.isArray(history)) {
        return res.status(400).json({ error: 'invalid_history', message: 'history must be an array' });
      }
      convo = history
        .slice(-10)
        .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
        .map((h) => ({ role: h.role === 'user' ? 'user' : 'ai', text: String(h.text || '').slice(0, 500) }))
        .filter((h) => h.text.length > 0);
    }
    const base = { baseUrl: AI_BASE_URL, apiKey: AI_API_KEY, timeoutMs: AGENT_TIMEOUT_MS, retries: AGENT_RETRIES };
    const cfg: AgentConfig = {
      decision: { ...base, model: AI_DECISION_MODEL },
      llm: { ...base, model: AI_LLM_MODEL },
      ...(AI_LLM_FALLBACK_MODEL ? { llmFallback: { ...base, model: AI_LLM_FALLBACK_MODEL } } : {}),
    };
    try {
      const result = await runAgent(question, cfg, chatJson, chatComplete, convo);
      res.json(result);
    } catch (e: unknown) {
      if (e instanceof AgentError) {
        return res.status(502).json({ error: e.code, message: e.message });
      }
      if (e instanceof LlmError) {
        return res.status(502).json({ error: 'llm_error', message: e.message });
      }
      console.error('[ai] agent failed:', (e as Error)?.message || e);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[ai] unhandled:', err?.message || err);
    if (res.headersSent) return;
    if (err?.status === 400 || err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && /JSON/i.test(err.message))) {
      return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
    }
    if (err?.status === 413 || err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds the size limit' });
    }
    res.status(500).json({ error: 'internal' });
  });
  return app;
}

if (require.main === module) {
  const app = createApp();
  const server = app.listen(PORT, () =>
    console.log(`[ai] listening on :${PORT} provider=${process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1'}`),
  );
  const shutdown = () => {
    console.log('[ai] shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
