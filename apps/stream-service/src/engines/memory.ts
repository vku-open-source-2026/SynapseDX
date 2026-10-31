/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * In-memory stream engine for local development, tests, and dependency-free operation.
 */

import { StreamEngine, TopicConfig, StreamEvent, PublishInput, ReadOptions, GroupReadOptions, RangeOptions, TopicStats, StreamError, ConsumerGroupInfo } from '../types';

interface GroupState {
  name: string;
  lastDeliveredId: string;
  consumers: Set<string>;
  pending: Map<string, { consumer: string; deliveryTime: number }>;
}

export class MemoryStreamEngine implements StreamEngine {
  readonly name = 'memory';

  private topics = new Map<string, TopicConfig>();
  private streams = new Map<string, StreamEvent[]>();
  private groups = new Map<string, Map<string, GroupState>>();
  private lastTimestamp = 0;
  private sequence = 0;

  async init(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.clear();
  }

  clear(): void {
    this.topics.clear();
    this.streams.clear();
    this.groups.clear();
    this.lastTimestamp = 0;
    this.sequence = 0;
  }

  private tKey(tenant: string, name: string): string {
    return `${tenant}:${name}`;
  }

  private nextId(customId?: string): string {
    if (customId) {
      if (!/^\d+-\d+$/.test(customId)) {
        throw new StreamError('invalid', 'Custom stream ID must match <milliseconds>-<sequence>');
      }
      return customId;
    }
    const now = Date.now();
    if (now === this.lastTimestamp) {
      this.sequence += 1;
    } else {
      this.lastTimestamp = now;
      this.sequence = 0;
    }
    return `${this.lastTimestamp}-${this.sequence}`;
  }

  private compareIds(a: string, b: string): number {
    const [msA, seqA] = a.split('-').map(Number);
    const [msB, seqB] = b.split('-').map(Number);
    if (msA !== msB) return msA - msB;
    return (seqA || 0) - (seqB || 0);
  }

  async createTopic(tenant: string, name: string, config?: Partial<TopicConfig>): Promise<TopicConfig> {
    const k = this.tKey(tenant, name);
    const existing = this.topics.get(k);
    const now = Date.now();
    const topic: TopicConfig = {
      name,
      maxLen: config?.maxLen !== undefined ? Math.max(0, Number(config.maxLen)) : existing?.maxLen,
      minId: config?.minId || existing?.minId,
      retentionMs: config?.retentionMs !== undefined ? Math.max(0, Number(config.retentionMs)) : existing?.retentionMs,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    this.topics.set(k, topic);
    if (!this.streams.has(k)) {
      this.streams.set(k, []);
    }
    return topic;
  }

  async getTopic(tenant: string, name: string): Promise<TopicConfig | null> {
    return this.topics.get(this.tKey(tenant, name)) || null;
  }

  async listTopics(tenant: string): Promise<TopicConfig[]> {
    const prefix = `${tenant}:`;
    const res: TopicConfig[] = [];
    for (const [k, topic] of this.topics.entries()) {
      if (k.startsWith(prefix)) res.push(topic);
    }
    return res;
  }

  async deleteTopic(tenant: string, name: string): Promise<boolean> {
    const k = this.tKey(tenant, name);
    const deleted = this.topics.delete(k);
    this.streams.delete(k);
    this.groups.delete(k);
    return deleted;
  }

  async topicStats(tenant: string, name: string): Promise<TopicStats> {
    const k = this.tKey(tenant, name);
    const events = this.streams.get(k) || [];
    const groupMap = this.groups.get(k) || new Map<string, GroupState>();

    const groupInfos: ConsumerGroupInfo[] = [];
    for (const [gName, state] of groupMap.entries()) {
      groupInfos.push({
        name: gName,
        consumers: state.consumers.size,
        pending: state.pending.size,
        lastDeliveredId: state.lastDeliveredId,
      });
    }

    return {
      topic: name,
      length: events.length,
      firstId: events[0]?.id,
      lastId: events[events.length - 1]?.id,
      groupsCount: groupInfos.length,
      groups: groupInfos,
    };
  }

  async publish(tenant: string, topicName: string, input: PublishInput): Promise<StreamEvent> {
    const k = this.tKey(tenant, topicName);
    let topic = this.topics.get(k);
    if (!topic) {
      topic = await this.createTopic(tenant, topicName);
    }

    const events = this.streams.get(k) || [];
    const id = this.nextId(input.id);
    const event: StreamEvent = {
      id,
      payload: input.payload,
      key: input.key,
      headers: input.headers,
      timestamp: Date.now(),
    };

    events.push(event);

    // Apply trimming
    if (topic.maxLen && topic.maxLen > 0 && events.length > topic.maxLen) {
      const drop = events.length - topic.maxLen;
      events.splice(0, drop);
    }

    this.streams.set(k, events);
    return event;
  }

  async publishBatch(tenant: string, topicName: string, inputs: PublishInput[]): Promise<StreamEvent[]> {
    const results: StreamEvent[] = [];
    for (const input of inputs) {
      results.push(await this.publish(tenant, topicName, input));
    }
    return results;
  }

  async read(tenant: string, topicName: string, options?: ReadOptions): Promise<StreamEvent[]> {
    const k = this.tKey(tenant, topicName);
    const events = this.streams.get(k) || [];
    const fromId = options?.fromId || '0-0';
    const count = options?.count && options.count > 0 ? options.count : 100;

    let filtered: StreamEvent[];
    if (fromId === '0-0' || fromId === '0') {
      filtered = events;
    } else {
      filtered = events.filter((e) => this.compareIds(e.id, fromId) > 0);
    }

    return filtered.slice(0, count);
  }

  async createGroup(tenant: string, topicName: string, groupName: string, startId = '$'): Promise<boolean> {
    const k = this.tKey(tenant, topicName);
    if (!this.topics.has(k)) {
      await this.createTopic(tenant, topicName);
    }
    let groupMap = this.groups.get(k);
    if (!groupMap) {
      groupMap = new Map();
      this.groups.set(k, groupMap);
    }
    if (groupMap.has(groupName)) {
      throw new StreamError('conflict', `Consumer group '${groupName}' already exists`);
    }

    const events = this.streams.get(k) || [];
    let initialId = '0-0';
    if (startId === '$') {
      initialId = events[events.length - 1]?.id || '0-0';
    } else if (startId) {
      initialId = startId;
    }

    groupMap.set(groupName, {
      name: groupName,
      lastDeliveredId: initialId,
      consumers: new Set(),
      pending: new Map(),
    });

    return true;
  }

  async destroyGroup(tenant: string, topicName: string, groupName: string): Promise<boolean> {
    const k = this.tKey(tenant, topicName);
    const groupMap = this.groups.get(k);
    if (!groupMap) return false;
    return groupMap.delete(groupName);
  }

  async readGroup(tenant: string, topicName: string, groupName: string, options: GroupReadOptions): Promise<StreamEvent[]> {
    const k = this.tKey(tenant, topicName);
    const groupMap = this.groups.get(k);
    const group = groupMap?.get(groupName);
    if (!group) {
      throw new StreamError('not_found', `Consumer group '${groupName}' not found`);
    }

    group.consumers.add(options.consumer);
    const count = options.count && options.count > 0 ? options.count : 10;
    const events = this.streams.get(k) || [];

    // Fetch messages newer than lastDeliveredId
    const eligible = events.filter((e) => this.compareIds(e.id, group.lastDeliveredId) > 0).slice(0, count);

    const now = Date.now();
    for (const ev of eligible) {
      group.lastDeliveredId = ev.id;
      if (!options.autoAck) {
        group.pending.set(ev.id, { consumer: options.consumer, deliveryTime: now });
      }
    }

    return eligible;
  }

  async ack(tenant: string, topicName: string, groupName: string, ids: string[]): Promise<number> {
    const k = this.tKey(tenant, topicName);
    const group = this.groups.get(k)?.get(groupName);
    if (!group) {
      throw new StreamError('not_found', `Consumer group '${groupName}' not found`);
    }
    let acked = 0;
    for (const id of ids) {
      if (group.pending.delete(id)) {
        acked += 1;
      }
    }
    return acked;
  }

  async range(tenant: string, topicName: string, options?: RangeOptions): Promise<StreamEvent[]> {
    const k = this.tKey(tenant, topicName);
    const events = this.streams.get(k) || [];
    const start = options?.start || '-';
    const end = options?.end || '+';
    const count = options?.count && options.count > 0 ? options.count : 100;

    let res = events;
    if (start !== '-') {
      res = res.filter((e) => this.compareIds(e.id, start) >= 0);
    }
    if (end !== '+') {
      res = res.filter((e) => this.compareIds(e.id, end) <= 0);
    }

    return res.slice(0, count);
  }
}
