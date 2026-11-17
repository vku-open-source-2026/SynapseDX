// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * SSE feed contract tests.
 *
 * HTTP tests use raw fetch + a ReadableStream reader (never `response.text()`)
 * so they observe frames as they are flushed. The loop-level tests inject a
 * clock to reach the idle heartbeat and the 30-minute reconnect boundary
 * without real waits.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SynapseOneClient, SynapseOneError } from '@synapseone/sdk';
import { KEEPALIVE_FRAME, runEventStream } from './event-stream';
import {
  activeEventStreamConnections, resetEventStreamStateForTests, setEventStreamCapacityForTests,
} from './routes/event-stream';
import { Harness, startHarness } from './testing/harness';

const TOPIC = 'synapsedx-capability-events';
const READY_TIMEOUT_MS = 8000;

interface OpenStream {
  response: Response;
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  buffer: string;
  done: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), Math.max(1, ms));
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function openStream(
  harness: Harness,
  path: string,
  options: { token?: string; headers?: Record<string, string> } = {},
): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${harness.base}${path}`, {
    headers: {
      accept: 'text/event-stream',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
    signal: controller.signal,
  });
  if (!response.body) throw new Error('SSE response has no body');
  return {
    response,
    controller,
    reader: response.body.getReader(),
    decoder: new TextDecoder(),
    buffer: '',
    done: false,
  };
}

async function closeStream(stream: OpenStream): Promise<void> {
  stream.controller.abort();
  try {
    await stream.reader.cancel();
  } catch {
    /* already aborted */
  }
}

/** Return the next non-empty SSE frame (a frame is separated by a blank line). */
async function nextFrame(stream: OpenStream, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const end = stream.buffer.indexOf('\n\n');
    if (end >= 0) {
      const frame = stream.buffer.slice(0, end);
      stream.buffer = stream.buffer.slice(end + 2);
      if (frame.trim()) return frame;
      continue;
    }
    if (stream.done) throw new Error(`SSE stream ended before a frame; buffered=${stream.buffer}`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for an SSE frame; buffered=${stream.buffer}`);
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await withTimeout(stream.reader.read(), remaining, 'SSE frame');
    } catch (error) {
      if (stream.controller.signal.aborted) throw new Error(`SSE stream aborted; buffered=${stream.buffer}`);
      throw error;
    }
    if (chunk.done) {
      stream.done = true;
      continue;
    }
    stream.buffer += stream.decoder.decode(chunk.value, { stream: true });
  }
}

interface SseEvent {
  frame: string;
  data: any;
}

/** Read until a named event arrives, skipping retry/comment frames. */
async function readEvent(stream: OpenStream, name: string, timeoutMs = 5000): Promise<SseEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = await nextFrame(stream, Math.max(1, deadline - Date.now()));
    const eventName = frame.split('\n').find((line) => line.startsWith('event: '));
    if (eventName?.slice('event: '.length).trim() !== name) continue;
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
    return { frame, data: dataLine ? JSON.parse(dataLine.slice('data: '.length)) : null };
  }
}

/** Collect frames for `durationMs`; returns whatever arrived (possibly none). */
async function drainFrames(stream: OpenStream, durationMs: number): Promise<string[]> {
  const frames: string[] = [];
  const deadline = Date.now() + durationMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return frames;
    try {
      frames.push(await nextFrame(stream, remaining));
    } catch (error) {
      if (/timed out/.test((error as Error).message)) return frames;
      throw error;
    }
  }
}

async function publish(harness: Harness, event: Record<string, unknown>, id: string): Promise<void> {
  const client = new SynapseOneClient({
    baseUrl: harness.config.tier1BaseUrl,
    apiKey: 'service-key',
  });
  try {
    await client.stream.createTopic(TOPIC, { maxLen: 1000 });
  } catch (error) {
    if (!(error instanceof SynapseOneError && (error.status === 400 || error.status === 409))) throw error;
  }
  await client.stream.publish(TOPIC, event, { id, key: String(event.datasetId || '') });
}

function capabilityEvent(
  type: string,
  datasetId: string,
  eventId: string,
  recordId?: string,
  tenant = 'org-a',
): Record<string, unknown> {
  return {
    eventId,
    type,
    schemaVersion: 1,
    datasetId,
    tenant,
    ...(recordId ? { recordId } : {}),
    at: new Date().toISOString(),
    correlationId: 'test-correlation',
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('connects with a read token and receives the retry/ready frames', { timeout: 20000 }, async () => {
  const harness = await startHarness();
  const stream = await openStream(harness, '/v1/capabilities/events/stream', { token: 'read-token' });
  try {
    assert.equal(stream.response.status, 200);
    assert.equal(stream.response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(stream.response.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(stream.response.headers.get('connection'), 'keep-alive');
    assert.equal(stream.response.headers.get('x-accel-buffering'), 'no');

    const retry = await nextFrame(stream, READY_TIMEOUT_MS);
    assert.equal(retry, 'retry: 3000');

    const ready = await readEvent(stream, 'ready', READY_TIMEOUT_MS);
    assert.equal(ready.data.cursor, null);
    assert.equal(ready.data.stream, TOPIC);
    assert.deepEqual(ready.data.filters, { type: null, datasetId: null });
  } finally {
    await closeStream(stream);
    await harness.close();
  }
});

test('a fresh subscription starts after the existing tail without replay', { timeout: 20000 }, async () => {
  const harness = await startHarness();
  try {
    await publish(harness, capabilityEvent('record.created', 'feed-ds', 'old-event'), '90-0');
    const stream = await openStream(harness, '/v1/capabilities/events/stream', { token: 'read-token' });
    try {
      await nextFrame(stream, READY_TIMEOUT_MS);
      const ready = await readEvent(stream, 'ready', READY_TIMEOUT_MS);
      assert.equal(ready.data.cursor, '90-0');

      await publish(harness, capabilityEvent('record.created', 'feed-ds', 'new-event'), '91-0');
      const delivered = await readEvent(stream, 'capability', 6000);
      assert.equal(delivered.data.id, '91-0');
      assert.equal((delivered.data.event as any).eventId, 'new-event');
    } finally {
      await closeStream(stream);
    }
  } finally {
    await harness.close();
  }
});

test('delivers a capability event published after connect as id/event/data', { timeout: 20000 }, async () => {
  const harness = await startHarness();
  const stream = await openStream(harness, '/v1/capabilities/events/stream', { token: 'read-token' });
  try {
    await readEvent(stream, 'ready', READY_TIMEOUT_MS);

    const event = capabilityEvent('record.created', 'feed-ds', 'evt-1', 'rec-1');
    await publish(harness, event, '100-0');

    const delivered = await readEvent(stream, 'capability', 6000);
    const lines = delivered.frame.split('\n');
    assert.equal(lines[0], 'id: 100-0');
    assert.equal(lines[1], 'event: capability');
    assert.ok(lines[2].startsWith('data: '));
    assert.deepEqual(delivered.data, { id: '100-0', event });
  } finally {
    await closeStream(stream);
    await harness.close();
  }
});

test('type filtering advances the cursor past a non-matching event', { timeout: 25000 }, async () => {
  const harness = await startHarness();
  const stream = await openStream(harness, '/v1/capabilities/events/stream?type=dataset.published', {
    token: 'read-token',
  });
  try {
    await readEvent(stream, 'ready', READY_TIMEOUT_MS);

    await publish(harness, capabilityEvent('record.created', 'ds-a', 'skip-1'), '110-0');
    const matching = capabilityEvent('dataset.published', 'ds-a', 'take-1');
    await publish(harness, matching, '110-1');

    const delivered = await readEvent(stream, 'capability', 6000);
    assert.equal(delivered.data.id, '110-1');
    assert.equal(delivered.data.event.type, 'dataset.published');

    // If the filtered event had not advanced the cursor, the reader would
    // replay 110-0 and re-emit 110-1 on every poll.
    const extra = await drainFrames(stream, 1400);
    assert.equal(extra.filter((frame) => frame.includes('id: 110-0')).length, 0);
    assert.equal(extra.filter((frame) => frame.includes('id: 110-1')).length, 0);
  } finally {
    await closeStream(stream);
    await harness.close();
  }
});

test('SSE never relays another tenant event but advances the cursor past it', { timeout: 20000 }, async () => {
  const harness = await startHarness();
  const stream = await openStream(harness, '/v1/capabilities/events/stream', { token: 'read-token' });
  try {
    await readEvent(stream, 'ready', READY_TIMEOUT_MS);
    await publish(harness, capabilityEvent('record.created', 'org-b-dataset', 'foreign', 'org-b-record', 'org-b'), '145-0');
    await publish(harness, capabilityEvent('record.created', 'org-a-dataset', 'own', 'org-a-record', 'org-a'), '145-1');
    const delivered = await readEvent(stream, 'capability', 6000);
    assert.equal(delivered.data.id, '145-1');
    assert.equal((delivered.data.event as any).tenant, 'org-a');
    const extra = await drainFrames(stream, 1400);
    assert.equal(extra.filter((frame) => frame.includes('id: 145-0')).length, 0);
  } finally {
    await closeStream(stream);
    await harness.close();
  }
});

test('datasetId filtering advances the cursor past a non-matching event', { timeout: 25000 }, async () => {
  const harness = await startHarness();
  const stream = await openStream(harness, '/v1/capabilities/events/stream?datasetId=ds-b', {
    token: 'read-token',
  });
  try {
    await readEvent(stream, 'ready', READY_TIMEOUT_MS);

    await publish(harness, capabilityEvent('record.created', 'ds-a', 'skip-2'), '120-0');
    const matching = capabilityEvent('record.created', 'ds-b', 'take-2');
    await publish(harness, matching, '120-1');

    const delivered = await readEvent(stream, 'capability', 6000);
    assert.equal(delivered.data.id, '120-1');
    assert.equal(delivered.data.event.datasetId, 'ds-b');

    const extra = await drainFrames(stream, 1400);
    assert.equal(extra.filter((frame) => frame.includes('id: 120-0')).length, 0);
    assert.equal(extra.filter((frame) => frame.includes('id: 120-1')).length, 0);
  } finally {
    await closeStream(stream);
    await harness.close();
  }
});

test('Last-Event-ID resumes after the cursor without replaying history', { timeout: 25000 }, async () => {
  const harness = await startHarness();
  const first = capabilityEvent('record.created', 'ds-c', 'first');
  await publish(harness, first, '130-0');

  const stream = await openStream(harness, '/v1/capabilities/events/stream', {
    token: 'read-token',
    headers: { 'last-event-id': '130-0' },
  });
  try {
    const ready = await readEvent(stream, 'ready', READY_TIMEOUT_MS);
    assert.equal(ready.data.cursor, '130-0');

    const second = capabilityEvent('record.created', 'ds-c', 'second');
    await publish(harness, second, '130-1');

    const delivered = await readEvent(stream, 'capability', 6000);
    assert.equal(delivered.data.id, '130-1');
    assert.equal(delivered.data.event.eventId, 'second');

    const extra = await drainFrames(stream, 1400);
    assert.equal(extra.filter((frame) => frame.includes('id: 130-0')).length, 0);
  } finally {
    await closeStream(stream);
    await harness.close();
  }
});

test('an explicit since parameter wins over Last-Event-ID', { timeout: 25000 }, async () => {
  const harness = await startHarness();
  await publish(harness, capabilityEvent('record.created', 'ds-d', 'one'), '140-0');
  await publish(harness, capabilityEvent('record.created', 'ds-d', 'two'), '140-1');

  const stream = await openStream(harness, '/v1/capabilities/events/stream?since=140-1', {
    token: 'read-token',
    headers: { 'last-event-id': '140-0' },
  });
  try {
    const ready = await readEvent(stream, 'ready', READY_TIMEOUT_MS);
    assert.equal(ready.data.cursor, '140-1');

    await publish(harness, capabilityEvent('record.created', 'ds-d', 'three'), '140-2');
    const delivered = await readEvent(stream, 'capability', 6000);
    assert.equal(delivered.data.id, '140-2');
  } finally {
    await closeStream(stream);
    await harness.close();
  }
});

test('an unauthenticated request is rejected before SSE headers', { timeout: 15000 }, async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.base}/v1/capabilities/events/stream`, {
      headers: { accept: 'text/event-stream' },
    });
    assert.equal(response.status, 401);
    assert.match(String(response.headers.get('content-type')), /^application\/json/);
    assert.notEqual(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const body: any = await response.json();
    assert.equal(body.error.code, 'unauthorized');
  } finally {
    await harness.close();
  }
});

test('aborting the client releases the connection slot', { timeout: 20000 }, async () => {
  const harness = await startHarness();
  const stream = await openStream(harness, '/v1/capabilities/events/stream', { token: 'read-token' });
  try {
    await readEvent(stream, 'ready', READY_TIMEOUT_MS);
    await waitFor(() => activeEventStreamConnections() === 1);
    await closeStream(stream);
    await waitFor(() => activeEventStreamConnections() === 0);
    assert.equal(activeEventStreamConnections(), 0);
  } finally {
    await closeStream(stream);
    // `harness.close()` only resolves once the SSE socket is gone; a leaked
    // timer or connection would hang this test.
    await harness.close();
  }
});

test('returns 503 stream_capacity when the process is at its limit', { timeout: 20000 }, async () => {
  const harness = await startHarness();
  let first: OpenStream | undefined;
  try {
    setEventStreamCapacityForTests(1);
    first = await openStream(harness, '/v1/capabilities/events/stream', { token: 'read-token' });
    await readEvent(first, 'ready', READY_TIMEOUT_MS);

    const rejected = await fetch(`${harness.base}/v1/capabilities/events/stream`, {
      headers: { accept: 'text/event-stream', authorization: 'Bearer read-token' },
    });
    assert.equal(rejected.status, 503);
    assert.match(String(rejected.headers.get('content-type')), /^application\/json/);
    const body: any = await rejected.json();
    assert.equal(body.error.code, 'stream_capacity');
  } finally {
    if (first) await closeStream(first);
    await waitFor(() => activeEventStreamConnections() === 0).catch(() => undefined);
    resetEventStreamStateForTests();
    await harness.close();
  }
});

test('the loop emits an idle heartbeat and reconnects after its duration budget', async () => {
  let clock = 0;
  const heartbeatFrames: string[] = [];
  const heartbeat = await runEventStream({
    read: async () => ({ events: [] }),
    sink: { write: (frame) => { heartbeatFrames.push(frame); return true; }, end: () => undefined },
    cursor: null,
    stream: TOPIC,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    isClosed: () => clock >= 31000,
    pollIntervalMs: 1000,
    heartbeatIntervalMs: 15000,
    maxDurationMs: 120000,
  });
  assert.equal(heartbeat.reason, 'client_closed');
  assert.equal(heartbeatFrames.filter((frame) => frame === KEEPALIVE_FRAME).length, 2);
  assert.equal(heartbeatFrames[0].startsWith('retry: 3000'), true);

  clock = 0;
  const reconnectFrames: string[] = [];
  const reconnect = await runEventStream({
    read: async () => ({ events: [] }),
    sink: { write: (frame) => { reconnectFrames.push(frame); return true; }, end: () => undefined },
    cursor: '150-0',
    stream: TOPIC,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    pollIntervalMs: 1000,
    heartbeatIntervalMs: 15000,
    maxDurationMs: 30000,
  });
  assert.equal(reconnect.reason, 'reconnect');
  assert.equal(reconnect.cursor, '150-0');
  assert.match(reconnectFrames[reconnectFrames.length - 1], /^event: reconnect\ndata: \{"cursor":"150-0"\}\n\n$/);
});

test('the loop survives a missing Tier-1 topic and delivers once it appears', async () => {
  let clock = 0;
  let reads = 0;
  const frames: string[] = [];
  const missing = Object.assign(new Error('stream topic not found'), { status: 404 });
  const result = await runEventStream({
    read: async () => {
      reads += 1;
      if (reads <= 2) throw missing;
      return { events: [{ id: '160-0', payload: capabilityEvent('dataset.published', 'ds-e', 'later') }] };
    },
    sink: { write: (frame) => { frames.push(frame); return true; }, end: () => undefined },
    cursor: null,
    stream: TOPIC,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    isClosed: () => frames.some((frame) => frame.includes('id: 160-0')),
    pollIntervalMs: 1000,
    heartbeatIntervalMs: 15000,
    maxDurationMs: 120000,
  });
  assert.equal(result.reason, 'client_closed');
  assert.equal(result.delivered, 1);
  assert.ok(frames.some((frame) => frame.startsWith('id: 160-0\nevent: capability\ndata: ')));
});
