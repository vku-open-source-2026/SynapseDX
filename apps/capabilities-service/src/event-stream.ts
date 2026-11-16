// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Server-Sent Events relay for the Tier-1 capability stream.
 *
 * The loop is deliberately transport-agnostic: the HTTP route supplies a
 * `read` function backed by `client.stream.read()` and a sink backed by the
 * Express response. `now`/`sleep` are injectable so tests can exercise the
 * heartbeat and the 30-minute reconnect boundary without waiting in real time.
 *
 * No event is persisted here. The Tier-1 topic is the only buffer; the cursor
 * is the last stream id observed, and it advances even for filtered events so
 * a non-matching event can never pin the reader to the same position.
 */
import { SynapseOneError } from '@synapseone/sdk';

/** One Tier-1 stream record, projected to the fields the feed needs. */
export interface CapabilityStreamEvent {
  id: string;
  payload: unknown;
}

export interface CapabilityStreamPage {
  events: CapabilityStreamEvent[];
}

/**
 * Read at most `count` events after `cursor`. A null cursor reads from the
 * oldest retained event; callers that must not replay history resolve the tail
 * before starting the loop.
 */
export type EventStreamRead = (cursor: string | null, count: number) => Promise<CapabilityStreamPage>;

export interface EventStreamFilters {
  type?: string;
  datasetId?: string;
}

/** The HTTP response, reduced to the two operations the loop needs. */
export interface EventStreamSink {
  /** Write one complete SSE frame. Returns false when the client is gone. */
  write(frame: string): boolean;
  /** Finish the response. Must be safe to call more than once. */
  end(): void;
}

export type EventStreamStopReason = 'client_closed' | 'reconnect' | 'write_error';

export interface EventStreamResult {
  reason: EventStreamStopReason;
  cursor: string | null;
  delivered: number;
}

export interface EventStreamOptions {
  read: EventStreamRead;
  sink: EventStreamSink;
  /** Last stream id already delivered; null starts at the oldest retained event. */
  cursor: string | null;
  filters?: EventStreamFilters;
  /** Stream/topic name reported in the ready frame. */
  stream: string;
  /** Aborted when the HTTP client disconnects. */
  signal?: AbortSignal;
  /** Additional disconnect predicate (e.g. response `close` already fired). */
  isClosed?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxDurationMs?: number;
  /** How many events to request per poll. */
  batchSize?: number;
  warn?: (message: string) => void;
}

export const EVENT_STREAM_POLL_MS = 1000;
export const EVENT_STREAM_HEARTBEAT_MS = 15000;
export const EVENT_STREAM_MAX_DURATION_MS = 30 * 60 * 1000;
export const EVENT_STREAM_BATCH_SIZE = 100;
export const EVENT_STREAM_RETRY_MS = 3000;
export const KEEPALIVE_FRAME = ': keepalive\n\n';

export function readyFrame(cursor: string | null, stream: string, filters: EventStreamFilters): string {
  const data = {
    cursor,
    stream,
    filters: {
      type: filters.type ?? null,
      datasetId: filters.datasetId ?? null,
    },
  };
  return `retry: ${EVENT_STREAM_RETRY_MS}\n\nevent: ready\ndata: ${JSON.stringify(data)}\n\n`;
}

export function capabilityFrame(event: CapabilityStreamEvent): string {
  return `id: ${event.id}\nevent: capability\ndata: ${JSON.stringify({ id: event.id, event: event.payload })}\n\n`;
}

export function reconnectFrame(cursor: string | null): string {
  return `event: reconnect\ndata: ${JSON.stringify({ cursor })}\n\n`;
}

/** SSE comment that keeps proxies and idle-connection reapers from closing. */
export function keepaliveFrame(): string {
  return KEEPALIVE_FRAME;
}

function isNotFound(error: unknown): boolean {
  if (error instanceof SynapseOneError) return error.status === 404;
  return Number((error as { status?: unknown } | undefined)?.status) === 404;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function payloadMatches(payload: unknown, filters: EventStreamFilters): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const event = payload as { type?: unknown; datasetId?: unknown };
  if (filters.type && event.type !== filters.type) return false;
  if (filters.datasetId && event.datasetId !== filters.datasetId) return false;
  return true;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Run the feed until the client disconnects, the 30-minute reconnect boundary
 * is reached, or a write fails. Always ends the sink; never leaves a timer
 * behind because the injected sleep owns its timer and is resolved on abort.
 */
export async function runEventStream(options: EventStreamOptions): Promise<EventStreamResult> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => defaultSleep(ms, options.signal));
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? EVENT_STREAM_POLL_MS);
  const heartbeatIntervalMs = Math.max(1, options.heartbeatIntervalMs ?? EVENT_STREAM_HEARTBEAT_MS);
  const maxDurationMs = Math.max(1, options.maxDurationMs ?? EVENT_STREAM_MAX_DURATION_MS);
  const batchSize = Math.max(1, options.batchSize ?? EVENT_STREAM_BATCH_SIZE);
  const filters = options.filters ?? {};
  const warn = options.warn ?? ((message: string) => console.warn(message));

  let cursor = options.cursor ?? null;
  let delivered = 0;
  let lastActivity = now();
  let lastWarningAt = 0;
  let ended = false;
  const startedAt = lastActivity;

  const isClosed = (): boolean => options.signal?.aborted === true || options.isClosed?.() === true;

  const end = (): void => {
    if (ended) return;
    ended = true;
    try {
      options.sink.end();
    } catch {
      /* the socket is already gone */
    }
  };

  /** Returns false when the frame could not be written. */
  const send = (frame: string): boolean => {
    if (isClosed()) return false;
    try {
      if (options.sink.write(frame) === false) return false;
    } catch {
      return false;
    }
    lastActivity = now();
    return true;
  };

  const stopReason = (): EventStreamStopReason => (isClosed() ? 'client_closed' : 'write_error');

  if (!send(readyFrame(cursor, options.stream, filters))) {
    end();
    return { reason: stopReason(), cursor, delivered };
  }

  while (!isClosed()) {
    if (now() - startedAt >= maxDurationMs) {
      // Ask the client to reconnect with Last-Event-ID = cursor. Proxies and
      // load balancers have their own idle limits; a planned handover is safer
      // than an abrupt TCP reset.
      send(reconnectFrame(cursor));
      end();
      return { reason: 'reconnect', cursor, delivered };
    }

    let events: CapabilityStreamEvent[] = [];
    let progressed = false;
    try {
      const page = await options.read(cursor, batchSize);
      events = Array.isArray(page?.events) ? page.events : [];
    } catch (error) {
      if (isClosed()) break;
      if (!isNotFound(error)) {
        // A transient Tier-1 failure must not tear down a live feed. Keep the
        // SSE connection open and retry; only a 404 means "topic not created".
        const at = now();
        if (at - lastWarningAt >= 30000) {
          lastWarningAt = at;
          warn(`[synapsedx] event stream read failed, retrying: ${errorMessage(error)}`);
        }
      }
      events = [];
    }
    if (isClosed()) break;

    for (const event of events) {
      const id = String(event?.id ?? '');
      if (!id) continue;
      // Advance for every observed event, including filtered ones.
      cursor = id;
      progressed = true;
      if (!payloadMatches(event.payload, filters)) continue;
      if (!send(capabilityFrame({ id, payload: event.payload }))) {
        end();
        return { reason: stopReason(), cursor, delivered };
      }
      delivered += 1;
    }
    if (isClosed()) break;

    if (now() - lastActivity >= heartbeatIntervalMs && !send(keepaliveFrame())) {
      end();
      return { reason: stopReason(), cursor, delivered };
    }

    // Drain a full page immediately only when the cursor moved; a page of
    // id-less records must not spin against the same position.
    if (events.length >= batchSize && progressed) continue;
    const untilHeartbeat = Math.max(1, heartbeatIntervalMs - (now() - lastActivity));
    const untilDeadline = Math.max(1, maxDurationMs - (now() - startedAt));
    await sleep(Math.min(pollIntervalMs, untilHeartbeat, untilDeadline));
  }

  end();
  return { reason: 'client_closed', cursor, delivered };
}
