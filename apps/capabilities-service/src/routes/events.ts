// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Capability event feed and outbox recovery.
 *
 * Events are written to the Tier-1 queue (durable, at-least-once) and to a
 * Tier-1 stream topic (non-destructive fan-out). Tier-3 reads this feed with a
 * cursor; it never needs a Tier-1 credential or a private queue connection.
 */
import { Express } from 'express';
import { SynapseOneError } from '@synapseone/sdk';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import { handler } from '../http';
import { validateDatasetId } from '../ids';
import { stringParam } from '../pagination';
import {
  CapabilityEvent, flushPendingEvents, getDocumentOrNull, COLLECTIONS, DatasetRecord,
} from '../platform';
import { accessibleDataset, readContext, writeContext } from './shared';

interface FeedItem {
  id: string;
  event: CapabilityEvent;
}

export function registerEventRoutes(app: Express, config: ServiceConfig): void {
  app.get('/v1/capabilities/events', handler(async (req, res) => {
    const { caller, client } = await readContext(req, config);
    if (!caller.authenticated) throw apiError(401, 'unauthorized', 'event consumption requires a verified credential');
    const limitRaw = stringParam(req.query.limit, 5);
    const count = limitRaw ? Number(limitRaw) : 100;
    if (!Number.isInteger(count) || count < 1 || count > 500) {
      throw apiError(400, 'invalid_limit', 'limit must be an integer 1..500');
    }
    const since = stringParam(req.query.since, 512);
    const type = stringParam(req.query.type, 64);
    const datasetId = stringParam(req.query.datasetId, 80);
    let events: Array<{ id: string; payload: unknown }> = [];
    try {
      events = since
        ? (await client.stream.read(config.eventsStream, { fromId: since, count })).events as any
        : (await client.stream.range(config.eventsStream, { start: '-', count })).events as any;
    } catch (error) {
      if (error instanceof SynapseOneError && error.status === 404) {
        // No topic means no event has been published yet.
        res.json({ items: [], count: 0, nextCursor: null });
        return;
      }
      throw error;
    }
    const items: FeedItem[] = events
      .map((event) => ({ id: String(event.id), event: event.payload as CapabilityEvent }))
      .filter((item) => item.event && typeof item.event === 'object')
      .filter((item) => !type || item.event.type === type)
      .filter((item) => !datasetId || item.event.datasetId === datasetId);
    const nextCursor = items.length ? items[items.length - 1].id : (since || null);
    res.setHeader('cache-control', 'no-store');
    res.json({ items, count: items.length, nextCursor });
  }));

  app.post('/v1/capabilities/events/outbox/flush', handler(async (req, res) => {
    const datasetId = validateDatasetId(String(req.query.datasetId || req.body?.datasetId || ''));
    const { caller, client } = await writeContext(req, config);
    const { data: dataset } = await accessibleDataset(client, datasetId, caller, 'write');
    const remaining = await flushPendingEvents(client, config, dataset);
    const refreshed = await getDocumentOrNull<DatasetRecord>(client, COLLECTIONS.datasets, datasetId);
    const pending = refreshed?.data.pendingEvents?.length ?? dataset.pendingEvents?.length ?? 0;
    res.json({ datasetId, pending, flushed: Boolean(remaining.pendingEvents !== undefined) });
  }));
}
