// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Live Server-Sent Events feed over the Tier-1 capability stream.
 *
 * `GET /v1/capabilities/events/stream` is a generic Tier-2 capability: it
 * forwards the caller's verified credential to Tier-1 and relays capability
 * events. It holds no queue or database of its own; the cursor is an opaque
 * Tier-1 stream id.
 *
 * Authorization happens before any SSE header is written, so an unauthenticated
 * caller receives a normal JSON 401 instead of an open event stream.
 */
import { Express, Request, Response } from 'express';
import { SynapseOneClient, SynapseOneError } from '@synapseone/sdk';
import { ServiceConfig } from '../config';
import { apiError } from '../errors';
import {
  EventStreamFilters, EventStreamRead, EventStreamSink, runEventStream,
} from '../event-stream';
import { handler } from '../http';
import { stringParam } from '../pagination';
import { readContext } from './shared';

export const MAX_CONCURRENT_EVENT_STREAMS = 100;

let activeStreams = 0;
let streamCapacity = MAX_CONCURRENT_EVENT_STREAMS;

/** Test-only: number of live SSE connections in this process. */
export function activeEventStreamConnections(): number {
  return activeStreams;
}

/** Test-only capacity override (production uses MAX_CONCURRENT_EVENT_STREAMS). */
export function setEventStreamCapacityForTests(value: number): void {
  streamCapacity = Math.max(1, Math.floor(value));
}

/** Test-only: restore the connection counter and default capacity. */
export function resetEventStreamStateForTests(): void {
  activeStreams = 0;
  streamCapacity = MAX_CONCURRENT_EVENT_STREAMS;
}

function cursorValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_.:-]{1,512}$/.test(value)) {
    throw apiError(400, 'invalid_cursor', 'cursor is not valid');
  }
  return value;
}

/** Resolve where the stream should start without replaying history. */
async function resolveCursor(
  client: SynapseOneClient,
  config: ServiceConfig,
  since: string | undefined,
  lastEventId: string | undefined,
): Promise<string | null> {
  if (since) return since;
  if (lastEventId) return lastEventId;
  try {
    // `range(start:'-', count:1)` returns the *oldest* event, not the tail.
    // Topic stats expose the authoritative last id, so a fresh subscription
    // starts after it and never replays history.
    const stats = await client.stream.topicStats(config.eventsStream);
    const lastId = stats?.stats?.lastId ?? stats?.stats?.last_id;
    return lastId ? String(lastId) : null;
  } catch (error) {
    // No topic yet means no event has been published; wait for it instead of
    // failing the subscription.
    if (error instanceof SynapseOneError && error.status === 404) return null;
    throw error;
  }
}

function streamReader(client: SynapseOneClient, config: ServiceConfig): EventStreamRead {
  return async (cursor, count) => {
    const page = await client.stream.read(config.eventsStream, {
      ...(cursor ? { fromId: cursor } : {}),
      count,
    });
    return {
      events: (Array.isArray(page?.events) ? page.events : []).map((event: any) => ({
        id: String(event?.id ?? ''),
        payload: event?.payload,
      })),
    };
  };
}

function responseSink(res: Response, isClosed: () => boolean): EventStreamSink {
  return {
    write(frame: string): boolean {
      if (isClosed() || res.writableEnded || res.destroyed) return false;
      try {
        res.write(frame);
        return true;
      } catch {
        return false;
      }
    },
    end(): void {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.end();
      } catch {
        /* the client already disconnected */
      }
    },
  };
}

export function registerEventStreamRoutes(app: Express, config: ServiceConfig): void {
  app.get('/v1/capabilities/events/stream', handler(async (req: Request, res: Response) => {
    const { caller, client } = await readContext(req, config);
    if (!caller.authenticated) {
      throw apiError(401, 'unauthorized', 'event consumption requires a verified credential');
    }

    const since = cursorValue(stringParam(req.query.since, 512));
    const lastEventId = cursorValue(stringParam(req.header('last-event-id'), 512));
    const type = stringParam(req.query.type, 64);
    const datasetId = stringParam(req.query.datasetId, 80);
    const filters: EventStreamFilters = {
      ...(type ? { type } : {}),
      ...(datasetId ? { datasetId } : {}),
    };

    if (activeStreams >= streamCapacity) {
      throw apiError(503, 'stream_capacity', 'too many concurrent event streams', { limit: streamCapacity });
    }

    // Reserve the slot in the same synchronous block as the check: resolving
    // the tail is an await, and parallel subscribers must not all pass the
    // capacity gate before any of them is counted.
    activeStreams += 1;
    let closed = false;
    const abort = new AbortController();
    const onClose = (): void => {
      closed = true;
      abort.abort();
    };
    req.on('close', onClose);
    res.on('close', onClose);
    res.on('error', onClose);
    req.on('error', onClose);

    try {
      const cursor = await resolveCursor(client, config, since, lastEventId);
      if (closed || res.destroyed) return;

      res.status(200);
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();

      await runEventStream({
        read: streamReader(client, config),
        sink: responseSink(res, () => closed),
        cursor,
        filters,
        stream: config.eventsStream,
        signal: abort.signal,
        isClosed: () => closed,
      });
    } finally {
      req.off('close', onClose);
      res.off('close', onClose);
      res.off('error', onClose);
      req.off('error', onClose);
      activeStreams = Math.max(0, activeStreams - 1);
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }
    }
  }));
}
