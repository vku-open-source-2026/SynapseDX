/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License").
 * Pluggable Stream Engine Factory & Registry.
 */

import { StreamEngine } from '../types';
import { MemoryStreamEngine } from './memory';
import { RedisStreamsEngine } from './redis';

export type EngineFactory = () => StreamEngine | Promise<StreamEngine>;

const engineRegistry = new Map<string, EngineFactory>();

// Register built-in engines
engineRegistry.set('memory', () => new MemoryStreamEngine());

let currentEngine: StreamEngine | null = null;
let initializingPromise: Promise<StreamEngine> | null = null;

/** Register an external engine driver (e.g. Kafka, Redpanda, NATS JetStream) */
export function registerStreamEngine(name: string, factory: EngineFactory): void {
  engineRegistry.set(name.toLowerCase(), factory);
}

export function listAvailableEngines(): string[] {
  return Array.from(engineRegistry.keys());
}

export async function getStreamEngine(): Promise<StreamEngine> {
  if (currentEngine) return currentEngine;
  if (initializingPromise) return initializingPromise;

  initializingPromise = (async () => {
    const redisUrl = process.env.STREAM_REDIS_URL || process.env.REDIS_URL || '';
    const isProd = process.env.NODE_ENV === 'production';
    const explicitEngine = (process.env.STREAM_ENGINE || '').toLowerCase().trim();

    let targetEngineName = 'memory';
    if (explicitEngine) {
      targetEngineName = explicitEngine;
    } else if (redisUrl) {
      targetEngineName = 'redis';
    }

    let engine: StreamEngine;

    if (targetEngineName === 'redis') {
      if (!redisUrl) {
        if (isProd) {
          throw new Error('[stream] In production, STREAM_REDIS_URL or REDIS_URL is required for Redis engine');
        }
        console.warn('[stream] No Redis URL provided, falling back to in-memory engine');
        engine = new MemoryStreamEngine();
      } else {
        const redisEngine = new RedisStreamsEngine(redisUrl);
        const ok = await redisEngine.init();
        if (!ok) {
          if (isProd) {
            throw new Error('[stream] Failed to connect to Redis Streams in production (fail-closed)');
          }
          console.warn('[stream] Redis connection failed, falling back to in-memory engine');
          engine = new MemoryStreamEngine();
        } else {
          engine = redisEngine;
        }
      }
    } else {
      const customFactory = engineRegistry.get(targetEngineName);
      if (!customFactory) {
        throw new Error(`[stream] Unknown stream engine '${targetEngineName}'. Available: ${listAvailableEngines().join(', ')}`);
      }
      engine = await customFactory();
      await engine.init();
    }

    currentEngine = engine;
    console.log(`[stream] Active streaming engine: ${engine.name}`);
    return engine;
  })();

  try {
    return await initializingPromise;
  } finally {
    initializingPromise = null;
  }
}

export async function closeStreamEngine(): Promise<void> {
  if (currentEngine) {
    await currentEngine.close();
    currentEngine = null;
  }
}

export function __setTestStreamEngine(engine: StreamEngine | null): void {
  currentEngine = engine;
}
