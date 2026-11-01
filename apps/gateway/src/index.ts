import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const upstream = (process.env.CAPABILITIES_SERVICE_URL || 'http://capabilities:8082').replace(/\/$/, '');

function assertUpstream(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`CAPABILITIES_SERVICE_URL is not an absolute URL: ${value}`); }
  if (/^(localhost|127\.0\.0\.1|::1)$/i.test(url.hostname)) throw new Error('CAPABILITIES_SERVICE_URL may not point to localhost');
  return value.replace(/\/$/, '');
}
const UPSTREAM = assertUpstream(upstream);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN || 'https://synapsedx.sbs');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-correlation-id,x-synapseone-tenant');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('x-correlation-id', req.header('x-correlation-id') || randomUUID());
  next();
});

async function proxy(req: Request, res: Response): Promise<void> {
  const path = req.originalUrl;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-correlation-id': res.getHeader('x-correlation-id')?.toString() || randomUUID() };
  for (const name of ['authorization', 'x-api-key', 'x-synapseone-tenant']) {
    const value = req.header(name);
    if (value) headers[name] = value;
  }
  const method = req.method.toUpperCase();
  const response = await fetch(`${UPSTREAM}${path}`, {
    method, headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
  });
  const text = await response.text();
  res.status(response.status);
  const contentType = response.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);
  res.send(text);
}

app.get('/health', async (_req, res) => {
  try {
    const response = await fetch(`${UPSTREAM}/health`);
    const body = await response.text();
    res.status(response.status).type('json').send(JSON.stringify({ status: response.ok ? 'ok' : 'degraded', service: 'synapsedx-gateway', upstream: JSON.parse(body) }));
  } catch (error) {
    res.status(503).json({ status: 'degraded', service: 'synapsedx-gateway', error: (error as Error).message });
  }
});
app.get('/ready', async (_req, res) => {
  try {
    const response = await fetch(`${UPSTREAM}/ready`);
    const body = await response.text();
    res.status(response.ok ? 200 : 503).type('json').send(JSON.stringify({ status: response.ok ? 'ready' : 'degraded', service: 'synapsedx-gateway', upstream: JSON.parse(body) }));
  } catch (error) {
    res.status(503).json({ status: 'degraded', service: 'synapsedx-gateway', error: (error as Error).message });
  }
});
app.use('/v1/capabilities', (req, res, next) => { proxy(req, res).catch(next); });
app.use((error: Error, _req: Request, res: Response, _next: unknown) => res.status(502).json({ error: 'capabilities_upstream_unavailable', message: error.message }));

if (require.main === module) app.listen(PORT, () => console.log(`[synapsedx-gateway] listening on :${PORT}; upstream=${UPSTREAM}`));
export { app };
