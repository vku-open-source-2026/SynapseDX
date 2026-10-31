/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * Redis Streams backend — High-throughput event streaming engine using Redis 7 native streams.
 */

import Redis from 'ioredis';
import { StreamEngine, TopicConfig, StreamEvent, PublishInput, ReadOptions, GroupReadOptions, RangeOptions, TopicStats, StreamError, ConsumerGroupInfo } from '../types';

export class RedisStreamsEngine implements StreamEngine {
  readonly name = 'redis';
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 3000,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    this.redis.on('error', (e: any) => console.error('[stream][redis]', e?.message || e));
  }

  async init(): Promise<boolean> {
    try {
      await this.redis.connect();
      await this.redis.ping();
      console.log('[stream] connected to Redis Streams backend');
      return true;
    } catch (e: any) {
      console.warn('[stream] Redis connection failed:', e?.message || e);
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      this.redis.disconnect();
    } catch { /* ignore */ }
  }

  private tPrefix(tenant: string): string {
    return `synapseone:stream:v1:${tenant}:`;
  }

  private streamKey(tenant: string, topic: string): string {
    return `${this.tPrefix(tenant)}t:${topic}:events`;
  }

  private topicsMetaKey(tenant: string): string {
    return `${this.tPrefix(tenant)}topics`;
  }

  private mapError(e: any): never {
    if (e instanceof StreamError) throw e;
    const msg = String(e?.message || e || 'redis error');
    if (/BUSYGROUP/i.test(msg)) {
      throw new StreamError('conflict', 'Consumer group already exists');
    }
    if (/NOGROUP/i.test(msg) || /no such key/i.test(msg)) {
      throw new StreamError('not_found', 'Topic or consumer group not found');
    }
    if (/ECONNREFUSED|ECONNRESET|NR_CLOSED|Connection is closed|READONLY/i.test(msg)) {
      throw new StreamError('storage_unavailable', 'Stream storage backend is unavailable');
    }
    throw new StreamError('invalid', msg);
  }

  private parseEvent(id: string, fields: string[]): StreamEvent {
    let payload: unknown = null;
    let key: string | undefined;
    let headers: Record<string, unknown> | undefined;

    for (let i = 0; i < fields.length; i += 2) {
      const f = fields[i];
      const val = fields[i + 1];
      if (f === 'payload') {
        try { payload = JSON.parse(val); } catch { payload = val; }
      } else if (f === 'key') {
        key = val || undefined;
      } else if (f === 'headers') {
        try { headers = JSON.parse(val); } catch { headers = undefined; }
      }
    }

    const [ms] = id.split('-');
    return {
      id,
      payload,
      key,
      headers,
      timestamp: Number(ms) || Date.now(),
    };
  }

  async createTopic(tenant: string, name: string, config?: Partial<TopicConfig>): Promise<TopicConfig> {
    try {
      const metaKey = this.topicsMetaKey(tenant);
      const existingRaw = await this.redis.hget(metaKey, name);
      const existing: TopicConfig | null = existingRaw ? JSON.parse(existingRaw) : null;
      const now = Date.now();

      const topic: TopicConfig = {
        name,
        maxLen: config?.maxLen !== undefined ? Math.max(0, Number(config.maxLen)) : existing?.maxLen,
        minId: config?.minId || existing?.minId,
        retentionMs: config?.retentionMs !== undefined ? Math.max(0, Number(config.retentionMs)) : existing?.retentionMs,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
      };

      await this.redis.hset(metaKey, name, JSON.stringify(topic));
      return topic;
    } catch (e) {
      this.mapError(e);
    }
  }

  async getTopic(tenant: string, name: string): Promise<TopicConfig | null> {
    try {
      const metaKey = this.topicsMetaKey(tenant);
      const raw = await this.redis.hget(metaKey, name);
      return raw ? (JSON.parse(raw) as TopicConfig) : null;
    } catch (e) {
      this.mapError(e);
    }
  }

  async listTopics(tenant: string): Promise<TopicConfig[]> {
    try {
      const metaKey = this.topicsMetaKey(tenant);
      const map = await this.redis.hgetall(metaKey);
      const list: TopicConfig[] = [];
      for (const val of Object.values(map)) {
        try { list.push(JSON.parse(val)); } catch { /* ignore */ }
      }
      return list;
    } catch (e) {
      this.mapError(e);
    }
  }

  async deleteTopic(tenant: string, name: string): Promise<boolean> {
    try {
      const metaKey = this.topicsMetaKey(tenant);
      const sKey = this.streamKey(tenant, name);
      const [hdelCount] = await Promise.all([
        this.redis.hdel(metaKey, name),
        this.redis.del(sKey),
      ]);
      return hdelCount > 0;
    } catch (e) {
      this.mapError(e);
    }
  }

  async topicStats(tenant: string, name: string): Promise<TopicStats> {
    try {
      const sKey = this.streamKey(tenant, name);
      const len = await this.redis.xlen(sKey);
      let firstId: string | undefined;
      let lastId: string | undefined;

      if (len > 0) {
        const first = await this.redis.xrange(sKey, '-', '+', 'COUNT', 1);
        if (first && first.length) firstId = first[0][0];
        const last = await this.redis.xrevrange(sKey, '+', '-', 'COUNT', 1);
        if (last && last.length) lastId = last[0][0];
      }

      const groups: ConsumerGroupInfo[] = [];
      try {
        const rawGroups: any[] = (await (this.redis as any).xinfo('GROUPS', sKey)) || [];
        for (const g of rawGroups) {
          const gMap: Record<string, any> = {};
          for (let i = 0; i < g.length; i += 2) {
            gMap[g[i]] = g[i + 1];
          }
          groups.push({
            name: String(gMap.name || ''),
            consumers: Number(gMap.consumers || 0),
            pending: Number(gMap.pending || 0),
            lastDeliveredId: String(gMap['last-delivered-id'] || '0-0'),
          });
        }
      } catch {
        // Stream may not have groups yet
      }

      return {
        topic: name,
        length: len,
        firstId,
        lastId,
        groupsCount: groups.length,
        groups,
      };
    } catch (e) {
      this.mapError(e);
    }
  }

  async publish(tenant: string, topicName: string, input: PublishInput): Promise<StreamEvent> {
    try {
      const sKey = this.streamKey(tenant, topicName);
      const topic = await this.getTopic(tenant, topicName);

      const args: (string | number)[] = [sKey];
      if (topic?.maxLen && topic.maxLen > 0) {
        args.push('MAXLEN', '~', topic.maxLen);
      }
      args.push(input.id || '*');
      args.push('payload', JSON.stringify(input.payload === undefined ? null : input.payload));
      if (input.key) args.push('key', String(input.key));
      if (input.headers) args.push('headers', JSON.stringify(input.headers));

      const id = (await (this.redis as any).xadd(...args)) as string;
      const [ms] = id.split('-');

      return {
        id,
        payload: input.payload,
        key: input.key,
        headers: input.headers,
        timestamp: Number(ms) || Date.now(),
      };
    } catch (e) {
      this.mapError(e);
    }
  }

  async publishBatch(tenant: string, topicName: string, inputs: PublishInput[]): Promise<StreamEvent[]> {
    const pipeline = this.redis.pipeline();
    const sKey = this.streamKey(tenant, topicName);
    const topic = await this.getTopic(tenant, topicName);

    for (const input of inputs) {
      const args: (string | number)[] = [sKey];
      if (topic?.maxLen && topic.maxLen > 0) {
        args.push('MAXLEN', '~', topic.maxLen);
      }
      args.push(input.id || '*');
      args.push('payload', JSON.stringify(input.payload === undefined ? null : input.payload));
      if (input.key) args.push('key', String(input.key));
      if (input.headers) args.push('headers', JSON.stringify(input.headers));
      (pipeline as any).xadd(...args);
    }

    const execRes = await pipeline.exec();
    const results: StreamEvent[] = [];
    if (!execRes) return results;

    for (let i = 0; i < execRes.length; i++) {
      const [err, id] = execRes[i];
      if (err) this.mapError(err);
      const input = inputs[i];
      const strId = String(id);
      const [ms] = strId.split('-');
      results.push({
        id: strId,
        payload: input.payload,
        key: input.key,
        headers: input.headers,
        timestamp: Number(ms) || Date.now(),
      });
    }

    return results;
  }

  async read(tenant: string, topicName: string, options?: ReadOptions): Promise<StreamEvent[]> {
    try {
      const sKey = this.streamKey(tenant, topicName);
      const count = options?.count && options.count > 0 ? options.count : 100;
      const fromId = options?.fromId || '0-0';

      const args: (string | number)[] = ['COUNT', count];
      if (options?.blockMs && options.blockMs > 0) {
        args.push('BLOCK', options.blockMs);
      }
      args.push('STREAMS', sKey, fromId);

      const raw = (await (this.redis as any).xread(...args)) as any[];
      if (!raw || !raw.length) return [];

      const streamEntries = raw[0][1];
      const events: StreamEvent[] = [];
      for (const [id, fields] of streamEntries) {
        events.push(this.parseEvent(id, fields));
      }
      return events;
    } catch (e) {
      this.mapError(e);
    }
  }

  async createGroup(tenant: string, topicName: string, groupName: string, startId = '$'): Promise<boolean> {
    try {
      const sKey = this.streamKey(tenant, topicName);
      // XGROUP CREATE key group id MKSTREAM
      await (this.redis as any).xgroup('CREATE', sKey, groupName, startId, 'MKSTREAM');
      return true;
    } catch (e) {
      this.mapError(e);
    }
  }

  async destroyGroup(tenant: string, topicName: string, groupName: string): Promise<boolean> {
    try {
      const sKey = this.streamKey(tenant, topicName);
      const res = await (this.redis as any).xgroup('DESTROY', sKey, groupName);
      return res === 1;
    } catch (e) {
      this.mapError(e);
    }
  }

  async readGroup(tenant: string, topicName: string, groupName: string, options: GroupReadOptions): Promise<StreamEvent[]> {
    try {
      const sKey = this.streamKey(tenant, topicName);
      const count = options.count && options.count > 0 ? options.count : 10;
      const args: (string | number)[] = [
        'GROUP', groupName, options.consumer,
        'COUNT', count,
      ];
      if (options.blockMs && options.blockMs > 0) {
        args.push('BLOCK', options.blockMs);
      }
      if (options.autoAck) {
        args.push('NOACK');
      }
      args.push('STREAMS', sKey, '>');

      const raw = (await (this.redis as any).xreadgroup(...args)) as any[];
      if (!raw || !raw.length) return [];

      const streamEntries = raw[0][1];
      const events: StreamEvent[] = [];
      for (const [id, fields] of streamEntries) {
        events.push(this.parseEvent(id, fields));
      }
      return events;
    } catch (e) {
      this.mapError(e);
    }
  }

  async ack(tenant: string, topicName: string, groupName: string, ids: string[]): Promise<number> {
    try {
      if (!ids.length) return 0;
      const sKey = this.streamKey(tenant, topicName);
      const count = await this.redis.xack(sKey, groupName, ...ids);
      return Number(count || 0);
    } catch (e) {
      this.mapError(e);
    }
  }

  async range(tenant: string, topicName: string, options?: RangeOptions): Promise<StreamEvent[]> {
    try {
      const sKey = this.streamKey(tenant, topicName);
      const start = options?.start || '-';
      const end = options?.end || '+';
      const count = options?.count && options.count > 0 ? options.count : 100;

      const raw = (await this.redis.xrange(sKey, start, end, 'COUNT', count)) as any[];
      if (!raw || !raw.length) return [];

      const events: StreamEvent[] = [];
      for (const [id, fields] of raw) {
        events.push(this.parseEvent(id, fields));
      }
      return events;
    } catch (e) {
      this.mapError(e);
    }
  }
}
