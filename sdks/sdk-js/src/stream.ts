/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * SynapseStream client: topics, produce (single & batch), consumer groups,
 * non-destructive reads, time-range queries and retention trimming.
 */

import { HttpClient } from './_http';

const P = '/v1/stream/topics';

export interface StreamTopicConfig {
  name: string;
  maxLen?: number;
  minId?: string;
  retentionMs?: number;
  createdAt: number;
  updatedAt: number;
}

export interface StreamEvent<T = unknown> {
  id: string;
  payload: T;
  key?: string;
  headers?: Record<string, unknown>;
  timestamp: number;
}

export interface StreamPublishInput {
  payload: unknown;
  key?: string;
  headers?: Record<string, unknown>;
  id?: string;
}

export interface StreamReadOptions {
  fromId?: string;
  count?: number;
  blockMs?: number;
}

export interface StreamGroupReadOptions {
  consumer?: string;
  count?: number;
  blockMs?: number;
  autoAck?: boolean;
}

export interface StreamRangeOptions {
  start?: string;
  end?: string;
  count?: number;
}

export class StreamService {
  constructor(private readonly http: HttpClient) {}

  private t(topic: string): string {
    return encodeURIComponent(topic);
  }

  private g(group: string): string {
    return encodeURIComponent(group);
  }

  // ---- topics ----
  listTopics() {
    return this.http.req<{ topics: StreamTopicConfig[] }>(P);
  }

  createTopic(topic: string, opts: { maxLen?: number; minId?: string; retentionMs?: number } = {}) {
    return this.http.req<{ topic: StreamTopicConfig }>(`${P}/${this.t(topic)}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...(opts.maxLen !== undefined ? { maxLen: opts.maxLen } : {}),
        ...(opts.minId !== undefined ? { minId: opts.minId } : {}),
        ...(opts.retentionMs !== undefined ? { retentionMs: opts.retentionMs } : {}),
      }),
    });
  }

  getTopic(topic: string) {
    return this.http.req<{ topic: StreamTopicConfig }>(`${P}/${this.t(topic)}`);
  }

  deleteTopic(topic: string) {
    return this.http.req<{ deleted: boolean }>(`${P}/${this.t(topic)}`, { method: 'DELETE' });
  }

  topicStats(topic: string) {
    return this.http.req<{ stats: any }>(`${P}/${this.t(topic)}/stats`);
  }

  // ---- publish ----
  publish(topic: string, payload: unknown, opts: { key?: string; headers?: Record<string, unknown>; id?: string } = {}) {
    return this.http.req<{ event: StreamEvent }>(`${P}/${this.t(topic)}/events`, {
      method: 'POST',
      body: JSON.stringify({
        payload,
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
        ...(opts.id !== undefined ? { id: opts.id } : {}),
      }),
    });
  }

  publishBatch(topic: string, events: StreamPublishInput[]) {
    return this.http.req<{ events: StreamEvent[]; count: number }>(`${P}/${this.t(topic)}/events:batch`, {
      method: 'POST',
      body: JSON.stringify({ events }),
    });
  }

  // ---- read / range ----
  read(topic: string, opts: StreamReadOptions = {}) {
    return this.http.req<{ events: StreamEvent[]; count: number }>(`${P}/${this.t(topic)}/read`, {
      method: 'POST',
      body: JSON.stringify({
        ...(opts.fromId !== undefined ? { fromId: opts.fromId } : {}),
        ...(opts.count !== undefined ? { count: opts.count } : {}),
        ...(opts.blockMs !== undefined ? { blockMs: opts.blockMs } : {}),
      }),
    });
  }

  range(topic: string, opts: StreamRangeOptions = {}) {
    const qs = new URLSearchParams();
    if (opts.start) qs.set('start', opts.start);
    if (opts.end) qs.set('end', opts.end);
    if (opts.count !== undefined) qs.set('count', String(opts.count));
    const s = qs.toString();
    return this.http.req<{ events: StreamEvent[]; count: number }>(`${P}/${this.t(topic)}/range${s ? `?${s}` : ''}`);
  }

  // ---- consumer groups ----
  createGroup(topic: string, group: string, opts: { startId?: string } = {}) {
    return this.http.req<{ group: string; topic: string; startId: string }>(
      `${P}/${this.t(topic)}/groups/${this.g(group)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          ...(opts.startId !== undefined ? { startId: opts.startId } : {}),
        }),
      },
    );
  }

  destroyGroup(topic: string, group: string) {
    return this.http.req<{ destroyed: boolean }>(`${P}/${this.t(topic)}/groups/${this.g(group)}`, {
      method: 'DELETE',
    });
  }

  readGroup(topic: string, group: string, opts: StreamGroupReadOptions = {}) {
    return this.http.req<{ events: StreamEvent[]; count: number }>(
      `${P}/${this.t(topic)}/groups/${this.g(group)}/read`,
      {
        method: 'POST',
        body: JSON.stringify({
          consumer: opts.consumer || 'default-worker',
          ...(opts.count !== undefined ? { count: opts.count } : {}),
          ...(opts.blockMs !== undefined ? { blockMs: opts.blockMs } : {}),
          ...(opts.autoAck !== undefined ? { autoAck: opts.autoAck } : {}),
        }),
      },
    );
  }

  ack(topic: string, group: string, ids: string[]) {
    return this.http.req<{ acked: number }>(`${P}/${this.t(topic)}/groups/${this.g(group)}/ack`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
  }
}
