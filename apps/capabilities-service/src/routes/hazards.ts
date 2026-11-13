// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * KTTV hazard feed: crawler runs, normalised hazard records and the public
 * "today" projection consumed by SynapseCitySOS. State is Tier-1 Base
 * documents (plus PostGIS geometry for spatial queries); no local store.
 */
import { Express } from 'express';
import { SynapseOneClient } from '@synapseone/sdk';
import { CallerPrincipal, isAdmin } from '../auth';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { COLLECTIONS, ensureCollections, getDocumentOrNull, serviceClient } from '../platform';
import { authenticatedReadContext, writeContext } from './shared';
import { createScoped, listScoped } from './module-helpers';
import { CrawledHazard, crawlAll } from '../crawlers/kttv';
import { indexKnowledgeDocument } from './knowledge';

const KTTV_TENANT = String(process.env.KTTV_TENANT || 'service:kttv').trim() || 'service:kttv';

export function crawlerPrincipal(): CallerPrincipal {
  return { type: 'apikey', subject: 'service:kttv-crawler', tenantKey: KTTV_TENANT, scopes: ['*'], kind: 'service-account' };
}

export interface HazardRecord {
  id: string;
  tenant: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  hazard_id: string;
  title: string;
  description: string;
  event_type: string;
  severity: string;
  source: string;
  is_active: boolean;
  geometry: { type: string; coordinates: unknown } | null;
  provinces: string[];
  url: string;
  published_at: string;
  fetched_at: string;
  hash: string;
}

export interface CrawlStateRecord {
  id: string;
  tenant: string;
  createdAt: string;
  updatedAt: string;
  last_run_at: string | null;
  last_success_at: string | null;
  running: boolean;
  hazards: number;
  indexed: number;
  sources: Record<string, unknown>;
  error: string | null;
}

export interface HazardBrief {
  brief: string;
  hazards: Array<Pick<HazardRecord, 'id' | 'hazard_id' | 'title' | 'event_type' | 'severity' | 'provinces' | 'published_at' | 'url'>>;
  model: string | null;
  fallback: boolean;
  generated_at: string;
  hours: number;
}

let running = false;

function isActive(publishedAt: string, hours = 72): boolean {
  const timestamp = new Date(publishedAt).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= hours * 3600_000;
}

async function upsertHazard(client: SynapseOneClient, principal: CallerPrincipal, hazard: CrawledHazard): Promise<HazardRecord> {
  const id = `h-${hazard.hazard_id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)}`;
  const existing = await getDocumentOrNull<HazardRecord>(client, COLLECTIONS.kttvHazards, id);
  const now = new Date().toISOString();
  const record: HazardRecord = {
    ...(existing?.data || {}),
    id,
    tenant: principal.tenantKey,
    createdBy: principal.subject,
    createdAt: existing?.data.createdAt || now,
    updatedAt: now,
    hazard_id: hazard.hazard_id,
    title: hazard.title,
    description: hazard.description,
    event_type: hazard.event_type,
    severity: hazard.severity,
    source: hazard.source,
    is_active: isActive(hazard.published_at),
    geometry: hazard.geometry,
    provinces: hazard.provinces,
    url: hazard.url,
    published_at: hazard.published_at,
    fetched_at: now,
    hash: hazard.hash,
  };
  if (existing) {
    await client.base.updateDocument(COLLECTIONS.kttvHazards, id, { data: record as unknown as Record<string, unknown> });
  } else {
    await createScoped<HazardRecord>(client, COLLECTIONS.kttvHazards, principal, record);
  }
  return record;
}

async function saveState(client: SynapseOneClient, principal: CallerPrincipal, patch: Partial<CrawlStateRecord>): Promise<void> {
  const existing = await getDocumentOrNull<CrawlStateRecord>(client, COLLECTIONS.kttvState, 'state');
  const data: CrawlStateRecord = {
    id: 'state',
    tenant: principal.tenantKey,
    createdAt: new Date().toISOString(),
    last_run_at: null,
    last_success_at: null,
    running: false,
    hazards: 0,
    indexed: 0,
    sources: {},
    error: null,
    ...(existing?.data || {}),
    updatedAt: new Date().toISOString(),
    ...patch,
  };
  if (existing) await client.base.updateDocument(COLLECTIONS.kttvState, 'state', { data: data as unknown as Record<string, unknown> });
  else await createScoped<CrawlStateRecord>(client, COLLECTIONS.kttvState, principal, data);
}

async function todayHazardRecords(
  client: SynapseOneClient,
  principal: CallerPrincipal,
  hours: number,
  limit: number,
): Promise<HazardRecord[]> {
  const { items } = await listScoped<HazardRecord>(client, COLLECTIONS.kttvHazards, principal, {
    limit: 1000,
    orderBy: { field: 'published_at', direction: 'desc' },
  });
  const cutoff = Date.now() - hours * 3600_000;
  return items
    .filter((item) => item.is_active !== false)
    .filter((item) => new Date(item.published_at).getTime() >= cutoff)
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
    .slice(0, limit);
}

function deterministicBrief(hazards: HazardRecord[], hours: number): string {
  if (!hazards.length) return `Trong ${hours} giờ qua chưa có cảnh báo KTTV đang hoạt động.`;
  const lines = hazards.slice(0, 8).map((hazard, index) => {
    const places = hazard.provinces.length ? ` tại ${hazard.provinces.join(', ')}` : '';
    return `[H${index + 1}] ${hazard.title} — ${hazard.severity} · ${hazard.event_type}${places}.`;
  });
  return `Trong ${hours} giờ qua có ${hazards.length} cảnh báo đang hoạt động:\n${lines.join('\n')}`;
}

/** LLM situation brief grounded in the live hazard feed, with a safe fallback. */
export async function buildHazardBrief(
  client: SynapseOneClient,
  principal: CallerPrincipal,
  options: { hours?: number; limit?: number; focus?: string } = {},
): Promise<HazardBrief> {
  const hours = Math.min(Math.max(Math.trunc(options.hours ?? 24), 1), 168);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 12), 1), 40);
  const hazards = await todayHazardRecords(client, principal, hours, limit);
  const generatedAt = new Date().toISOString();
  const citations = hazards.map((hazard) => ({
    id: hazard.id,
    hazard_id: hazard.hazard_id,
    title: hazard.title,
    event_type: hazard.event_type,
    severity: hazard.severity,
    provinces: hazard.provinces,
    published_at: hazard.published_at,
    url: hazard.url,
  }));

  if (!hazards.length) {
    return { brief: deterministicBrief([], hours), hazards: citations, model: null, fallback: true, generated_at: generatedAt, hours };
  }

  const focus = String(options.focus || '').trim().slice(0, 500);
  const context = hazards.map((hazard, index) => {
    const places = hazard.provinces.length ? hazard.provinces.join(', ') : 'không xác định';
    return `[H${index + 1}] ${hazard.title}\n` +
      `Loại: ${hazard.event_type}; mức độ: ${hazard.severity}; khu vực: ${places}; ` +
      `phát hành: ${hazard.published_at}; nguồn: ${hazard.source}; url: ${hazard.url}\n` +
      `${hazard.description.slice(0, 700)}`;
  }).join('\n\n');

  const messages = [
    {
      role: 'system' as const,
      content: [
        'Bạn là trợ lý khí tượng thủy văn của SynapseCity, hỗ trợ người dân và ban chỉ huy.',
        `Tóm tắt tình hình cảnh báo trong ${hours} giờ qua dựa DUY NHẤT trên CONTEXT.`,
        'Nêu ngắn gọn: khu vực nào, loại thiên tai, mức độ, khuyến nghị an toàn. Trích dẫn [H1], [H2] tương ứng.',
        'Nếu CONTEXT không có cảnh báo, nói rõ là chưa có cảnh báo. Không bịa thêm hiện tượng hoặc số liệu.',
        'Trả lời bằng tiếng Việt, tối đa 220 từ.',
        `CONTEXT:\n${context}`,
      ].join('\n\n'),
    },
    {
      role: 'user' as const,
      content: focus ? `Tập trung vào: ${focus}` : 'Tóm tắt tình hình cảnh báo hôm nay.',
    },
  ];

  // Large contexts occasionally make the free model return an empty
  // completion. Retry once with a compact context before falling back.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_200));
    const attemptContext = attempt === 0
      ? context
      : hazards.slice(0, 4).map((hazard, index) => {
          const places = hazard.provinces.length ? hazard.provinces.join(', ') : 'không xác định';
          return `[H${index + 1}] ${hazard.title} | ${hazard.event_type} | ${hazard.severity} | ${places} | ${hazard.published_at}`;
        }).join('\n');
    const attemptMessages = attempt === 0
      ? messages
      : [{ ...messages[0], content: messages[0].content.replace(context, attemptContext) }, messages[1]];
    const fallbackModel = attempt === 1
      ? String(process.env.HAZARD_BRIEF_FALLBACK_MODEL || 'inception/mercury-2.5')
      : undefined;
    try {
      const response: any = await client.inference.chat(attemptMessages as any, {
        temperature: 0.2,
        max_tokens: fallbackModel ? 2_000 : 450,
        ...(fallbackModel ? { model: fallbackModel } : {}),
      } as any);
      const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
      const brief = String(choice?.message?.content ?? response?.message ?? '').trim();
      if (brief) {
        return {
          brief,
          hazards: citations,
          model: response?.model ? String(response.model) : null,
          fallback: false,
          generated_at: generatedAt,
          hours,
        };
      }
    } catch (error) {
      console.warn(`[hazards][brief] LLM attempt ${attempt + 1} failed:`, (error as Error)?.message || error);
    }
  }
  return { brief: deterministicBrief(hazards, hours), hazards: citations, model: null, fallback: true, generated_at: generatedAt, hours };
}

/** Run both crawlers, persist hazards, index text and upsert GIS points. */
export async function runKttvCrawl(config: ServiceConfig): Promise<{
  hazards: number;
  indexed: number;
  sources: Record<string, unknown>;
  error: string | null;
}> {
  if (running) throw apiError(409, 'crawl_running', 'a KTTV crawl is already running');
  running = true;
  const client = serviceClient(config);
  const principal = crawlerPrincipal();
  await ensureCollections(client);
  await saveState(client, principal, { running: true, last_run_at: new Date().toISOString(), error: null }).catch(() => undefined);
  try {
    const { hazards, documents, stats } = await crawlAll();
    let indexed = 0;
    // VNDMS PDFs are first-class knowledge documents (historical bulletins
    // included). Indexing them separately keeps the full text searchable even
    // when they are too old to appear on the today map.
    for (const document of documents) {
      try {
        await indexKnowledgeDocument(client, principal, {
          id: document.document_id,
          title: document.title,
          body: document.text,
          source: document.source,
          url: document.url,
          publishedAt: document.published_at,
          kind: document.kind,
          tags: document.tags,
        });
        indexed += 1;
      } catch {
        // indexing is best-effort; a failed PDF must not abort the crawl
      }
    }
    for (const hazard of hazards) {
      await upsertHazard(client, principal, hazard).catch(() => undefined);
      if (hazard.source === 'vndms') continue; // already indexed as a PDF document above
      try {
        await indexKnowledgeDocument(client, principal, {
          id: `k-${hazard.hazard_id}`,
          title: hazard.title,
          body: `${hazard.description}\n\n${hazard.text}`.slice(0, 120_000),
          source: hazard.source,
          url: hazard.url,
          publishedAt: hazard.published_at,
          kind: 'html',
          tags: ['kttv', hazard.source, hazard.event_type, hazard.severity],
        });
        indexed += 1;
      } catch {
        // indexing is best-effort; the hazard record is already stored
      }
    }
    const geo = hazards
      .filter((hazard) => hazard.geometry)
      .map((hazard) => ({
        id: `h-${hazard.hazard_id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)}`,
        properties: {
          hazard_id: hazard.hazard_id,
          title: hazard.title,
          event_type: hazard.event_type,
          severity: hazard.severity,
          source: hazard.source,
          published_at: hazard.published_at,
        },
        geometry: hazard.geometry,
      }));
    if (geo.length) await client.base.geoUpsert(COLLECTIONS.kttvHazards, geo).catch(() => undefined);
    // Retire hazards that disappeared from the source only after a successful
    // non-empty crawl; a transient empty crawl must not wipe the live map.
    if (hazards.length > 0) {
      const activeIds = new Set(hazards.map((hazard) => hazard.hazard_id));
      const existing = await listScoped<HazardRecord>(client, COLLECTIONS.kttvHazards, principal, { limit: 1000 }).catch(() => ({ items: [] as HazardRecord[], total: 0 }));
      for (const row of existing.items) {
        if (activeIds.has(row.hazard_id) || row.is_active === false) continue;
        await client.base.updateDocument(COLLECTIONS.kttvHazards, row.id, {
          data: { ...row, is_active: false, status: 'expired', updatedAt: new Date().toISOString() },
        }).catch(() => undefined);
      }
    }
    await saveState(client, principal, {
      running: false,
      last_success_at: new Date().toISOString(),
      hazards: hazards.length,
      indexed,
      sources: stats as unknown as Record<string, unknown>,
      error: null,
    }).catch(() => undefined);
    return { hazards: hazards.length, indexed, sources: stats as unknown as Record<string, unknown>, error: null };
  } catch (error) {
    const message = (error as Error)?.message || 'crawl failed';
    await saveState(client, principal, { running: false, error: message }).catch(() => undefined);
    return { hazards: 0, indexed: 0, sources: {}, error: message };
  } finally {
    running = false;
  }
}

async function crawlState(client: SynapseOneClient, principal: CallerPrincipal): Promise<CrawlStateRecord | null> {
  const doc = await getDocumentOrNull<CrawlStateRecord>(client, COLLECTIONS.kttvState, 'state');
  if (!doc) return null;
  if (!isAdmin(principal) && doc.data.tenant !== principal.tenantKey) return null;
  return doc.data;
}

export function registerHazardRoutes(app: Express, config: ServiceConfig): void {
  app.get('/v1/capabilities/hazards/today', handler(async (req, res) => {
    const { client } = await authenticatedReadContext(req, config);
    const principal = crawlerPrincipal();
    const hours = Math.min(Math.max(Number((req.query as any).hours || 72), 1), 168);
    const limit = Math.min(Math.max(Number((req.query as any).limit || 200), 1), 500);
    const hazards = await todayHazardRecords(client, principal, hours, limit);
    res.json({ hazards, total: hazards.length, hours });
  }));

  app.post('/v1/capabilities/hazards/brief', handler(async (req, res) => {
    const { client } = await authenticatedReadContext(req, config);
    const principal = crawlerPrincipal();
    const body = (req.body || {}) as any;
    const result = await buildHazardBrief(client, principal, {
      hours: Number(body.hours ?? 24),
      limit: Number(body.limit ?? 12),
      focus: body.focus ? String(body.focus) : undefined,
    });
    res.json(result);
  }));

  app.get('/v1/capabilities/hazards/status', handler(async (req, res) => {
    const { client } = await authenticatedReadContext(req, config);
    const state = await crawlState(client, crawlerPrincipal());
    res.json({
      status: state?.last_success_at ? 'ok' : state?.error ? 'error' : 'unconfigured',
      configured: true,
      source: 'nchmf+vndms',
      ...(state || {}),
    });
  }));

  app.post('/v1/capabilities/crawlers/kttv/trigger', handler(async (req, res) => {
    const { principal } = await writeContext(req, config);
    if (!isAdmin(principal)) throw apiError(403, 'admin_required', 'only an admin credential can trigger the crawler');
    if (running) throw apiError(409, 'crawl_running', 'a KTTV crawl is already running');
    void runKttvCrawl(config).catch((error) => console.error('[kttv] crawl failed:', error?.message || error));
    res.status(202).json({ accepted: true, startedAt: new Date().toISOString() });
  }));

  app.post('/v1/capabilities/crawlers/kttv/run', handler(async (req, res) => {
    const { principal } = await writeContext(req, config);
    if (!isAdmin(principal)) throw apiError(403, 'admin_required', 'only an admin credential can trigger the crawler');
    const result = await runKttvCrawl(config);
    if (result.error) throw apiError(502, 'crawl_failed', result.error);
    res.json(result);
  }));
}
