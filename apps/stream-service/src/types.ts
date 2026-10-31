/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * SynapseStream — Types and Interfaces for pluggable streaming engines.
 */

export type StreamErrorCode = 'not_found' | 'conflict' | 'invalid' | 'storage_unavailable';

export class StreamError extends Error {
  code: StreamErrorCode;
  constructor(code: StreamErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'StreamError';
  }
}

export interface TopicConfig {
  name: string;
  maxLen?: number;
  minId?: string;
  retentionMs?: number;
  createdAt: number;
  updatedAt: number;
}

export interface StreamEvent {
  id: string;
  payload: unknown;
  key?: string;
  headers?: Record<string, unknown>;
  timestamp: number;
}

export interface PublishInput {
  payload: unknown;
  key?: string;
  headers?: Record<string, unknown>;
  id?: string;
}

export interface ReadOptions {
  fromId?: string;
  count?: number;
  blockMs?: number;
}

export interface GroupReadOptions {
  consumer: string;
  count?: number;
  blockMs?: number;
  autoAck?: boolean;
}

export interface RangeOptions {
  start?: string;
  end?: string;
  count?: number;
}

export interface ConsumerGroupInfo {
  name: string;
  consumers: number;
  pending: number;
  lastDeliveredId: string;
}

export interface TopicStats {
  topic: string;
  length: number;
  firstId?: string;
  lastId?: string;
  groupsCount: number;
  groups: ConsumerGroupInfo[];
}

/** Pluggable Stream Engine Contract (implemented by Memory, Redis Streams, Kafka/Redpanda drivers) */
export interface StreamEngine {
  readonly name: string;
  init(): Promise<boolean>;
  close(): Promise<void>;

  createTopic(tenant: string, name: string, config?: Partial<TopicConfig>): Promise<TopicConfig>;
  getTopic(tenant: string, name: string): Promise<TopicConfig | null>;
  listTopics(tenant: string): Promise<TopicConfig[]>;
  deleteTopic(tenant: string, name: string): Promise<boolean>;
  topicStats(tenant: string, name: string): Promise<TopicStats>;

  publish(tenant: string, topic: string, input: PublishInput): Promise<StreamEvent>;
  publishBatch(tenant: string, topic: string, inputs: PublishInput[]): Promise<StreamEvent[]>;

  read(tenant: string, topic: string, options?: ReadOptions): Promise<StreamEvent[]>;
  createGroup(tenant: string, topic: string, group: string, startId?: string): Promise<boolean>;
  destroyGroup(tenant: string, topic: string, group: string): Promise<boolean>;
  readGroup(tenant: string, topic: string, group: string, options: GroupReadOptions): Promise<StreamEvent[]>;
  ack(tenant: string, topic: string, group: string, ids: string[]): Promise<number>;
  range(tenant: string, topic: string, options?: RangeOptions): Promise<StreamEvent[]>;

  clear?(): void;
}
