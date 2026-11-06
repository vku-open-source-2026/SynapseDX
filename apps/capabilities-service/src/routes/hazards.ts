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
    const { items } = await listScoped<HazardRecord>(client, COLLECTIONS.kttvHazards, principal, {
      limit: 1000,
      orderBy: { field: 'published_at', direction: 'desc' },
    });
    const cutoff = Date.now() - hours * 3600_000;
    const hazards = items
      .filter((item) => item.is_active !== false)
      .filter((item) => new Date(item.published_at).getTime() >= cutoff)
      .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
      .slice(0, limit);
    res.json({ hazards, total: hazards.length, hours });
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

  app.post('/v1/capabilities/crawlers/kttv/run', handler(async (req, res) => {
    const { principal } = await writeContext(req, config);
    if (!isAdmin(principal)) throw apiError(403, 'admin_required', 'only an admin credential can trigger the crawler');
    const result = await runKttvCrawl(config);
    if (result.error) throw apiError(502, 'crawl_failed', result.error);
    res.json(result);
  }));
}

/** Start the Tier-2 crawler loop (cron-like interval, disabled in tests). */
export function startKttvScheduler(config: ServiceConfig): void {
  if (process.env.NODE_ENV === 'test' || process.env.KTTV_CRAWL_ENABLED === 'false') return;
  const intervalMs = Math.min(Math.max(Number(process.env.KTTV_CRAWL_INTERVAL_MS || 30 * 60_000), 60_000), 24 * 3600_000);
  const run = () => {
    runKttvCrawl(config).catch((error) => console.error('[kttv] crawl failed:', error?.message || error));
  };
  setTimeout(run, Math.min(15_000, intervalMs));
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  console.log(`[kttv] crawler enabled: every ${Math.round(intervalMs / 1000)}s (tenant ${KTTV_TENANT})`);
}
