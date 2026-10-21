/*
 * Copyright 2026 SynapseDX Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseQueue client: queues, publish (delay + dedupe), at-least-once
 * consumption with visibility-timeout leases, ack/nack/heartbeat, retry,
 * dead letters and replay.
 *
 * Delivery model: `consume()` leases messages and returns a `receipt` per
 * message. `ack` when processing succeeds, `nack` to requeue/dead-letter and
 * `heartbeat` to extend long-running leases. Expired leases are redelivered,
 * so consumers must be idempotent.
 *
 * Every operation is scoped to the caller's tenant (org / account / user).
 * Platform callers set `tenant` on the client (x-synapsedx-tenant).
 */

import { HttpClient } from './_http';

const P = '/v1/queue/queues';

export class QueueService {
  constructor(private readonly http: HttpClient) {}

  private q(queue: string): string {
    return encodeURIComponent(queue);
  }

  // ---- queues ----
  listQueues() { return this.http.req<any[]>(P); }

  createQueue(queue: string, opts: { maxAttempts?: number; visibilityTimeoutSeconds?: number } = {}) {
    return this.http.req(`${P}/${this.q(queue)}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
        ...(opts.visibilityTimeoutSeconds !== undefined ? { visibilityTimeoutSeconds: opts.visibilityTimeoutSeconds } : {}),
      }),
    });
  }
  getQueue(queue: string) { return this.http.req(`${P}/${this.q(queue)}`); }
  deleteQueue(queue: string) { return this.http.req(`${P}/${this.q(queue)}`, { method: 'DELETE' }); }
  purgeQueue(queue: string) { return this.http.req(`${P}/${this.q(queue)}/purge`, { method: 'POST' }); }
  queueStats(queue: string) { return this.http.req(`${P}/${this.q(queue)}/stats`); }

  // ---- publish ----
  publish(
    queue: string,
    payload: unknown,
    opts: {
      delaySeconds?: number;
      maxAttempts?: number;
      headers?: Record<string, unknown>;
      id?: string;
      dedupeKey?: string;
    } = {},
  ) {
    return this.http.req(`${P}/${this.q(queue)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        payload,
        ...(opts.delaySeconds !== undefined ? { delaySeconds: opts.delaySeconds } : {}),
        ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
        ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
        ...(opts.id !== undefined ? { id: opts.id } : {}),
        ...(opts.dedupeKey !== undefined ? { dedupeKey: opts.dedupeKey } : {}),
      }),
    });
  }

  /** Publish 1..100 messages; each entry takes the same fields as `publish`. */
  publishBatch(queue: string, messages: Array<Record<string, unknown>>) {
    return this.http.req<{ queue: string; results: any[]; ok: boolean }>(`${P}/${this.q(queue)}/messages:batch`, {
      method: 'POST', body: JSON.stringify({ messages }),
    });
  }

  // ---- consume / ack / nack / heartbeat ----
  consume(
    queue: string,
    opts: { maxMessages?: number; visibilityTimeoutSeconds?: number; consumer?: string } = {},
  ) {
    return this.http.req<{ queue: string; count: number; visibilityTimeoutSeconds: number; messages: any[] }>(
      `${P}/${this.q(queue)}/consume`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...(opts.maxMessages !== undefined ? { maxMessages: opts.maxMessages } : {}),
          ...(opts.visibilityTimeoutSeconds !== undefined ? { visibilityTimeoutSeconds: opts.visibilityTimeoutSeconds } : {}),
          ...(opts.consumer !== undefined ? { consumer: opts.consumer } : {}),
        }),
      },
    );
  }

  ack(queue: string, receipt: string) {
    return this.http.req(`${P}/${this.q(queue)}/ack`, { method: 'POST', body: JSON.stringify({ receipt }) });
  }
  ackMany(queue: string, receipts: string[]) {
    return this.http.req<{ queue: string; results: any[]; ok: boolean }>(`${P}/${this.q(queue)}/ack`, {
      method: 'POST', body: JSON.stringify({ receipts }),
    });
  }
  nack(
    queue: string,
    receipt: string,
    opts: { requeue?: boolean; delaySeconds?: number; error?: string } = {},
  ) {
    return this.http.req(`${P}/${this.q(queue)}/nack`, {
      method: 'POST',
      body: JSON.stringify({
        receipt,
        requeue: opts.requeue ?? true,
        ...(opts.delaySeconds !== undefined ? { delaySeconds: opts.delaySeconds } : {}),
        ...(opts.error !== undefined ? { error: opts.error } : {}),
      }),
    });
  }
  heartbeat(queue: string, receipt: string, opts: { visibilityTimeoutSeconds?: number } = {}) {
    return this.http.req(`${P}/${this.q(queue)}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({
        receipt,
        ...(opts.visibilityTimeoutSeconds !== undefined ? { visibilityTimeoutSeconds: opts.visibilityTimeoutSeconds } : {}),
      }),
    });
  }

  // ---- inspection / dead letters ----
  peek(queue: string, opts: { limit?: number; ready?: boolean } = {}) {
    const p = new URLSearchParams();
    if (opts.limit !== undefined) p.set('limit', String(opts.limit));
    if (opts.ready) p.set('ready', 'true');
    const s = p.toString();
    return this.http.req<{ queue: string; count: number; messages: any[] }>(`${P}/${this.q(queue)}/messages${s ? `?${s}` : ''}`);
  }
  deadLetters(queue: string, opts: { limit?: number } = {}) {
    const s = opts.limit !== undefined ? `?limit=${opts.limit}` : '';
    return this.http.req<{ queue: string; count: number; messages: any[] }>(`${P}/${this.q(queue)}/dead${s}`);
  }
  replayDead(
    queue: string,
    messageId: string,
    opts: { delaySeconds?: number; resetAttempts?: boolean } = {},
  ) {
    return this.http.req(`${P}/${this.q(queue)}/dead/${encodeURIComponent(messageId)}/replay`, {
      method: 'POST',
      body: JSON.stringify({
        ...(opts.delaySeconds !== undefined ? { delaySeconds: opts.delaySeconds } : {}),
        ...(opts.resetAttempts ? { resetAttempts: true } : {}),
      }),
    });
  }
  deleteDead(queue: string, messageId: string) {
    return this.http.req(`${P}/${this.q(queue)}/dead/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
  }
}
