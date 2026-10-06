/*
 * Copyright 2026 OLP Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * Minimal Redis fixed-window store for express-rate-limit v7 (callback API).
 * Lua script giữ INCR + EXPIRE nguyên tử; prefix key để share Redis an toàn.
 */
import Redis from 'ioredis';

export interface RedisStoreOptions {
  redisUrl: string;
  prefix?: string;
  windowMs: number;
}

const INCR_EXPIRE_LUA = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {hits, ttl}
`;

export function createRedisStore(opts: RedisStoreOptions) {
  // enableOfflineQueue=false: Redis mất thì command lỗi NGAY (fail-open),
  // thay vì xếp hàng chờ reconnect làm treo request.
  const redis = new Redis(opts.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  const prefix = opts.prefix || 'olp:rl:';
  redis.on('error', (e) => console.error('[gateway][ratelimit] redis error:', e.message));

  return {
    redis,
    incr(key: string, cb: (err: Error | undefined, totalHits: number, resetTime: Date | undefined) => void): void {
      redis
        .eval(INCR_EXPIRE_LUA, 1, prefix + key, String(opts.windowMs))
        .then((res: any) => {
          const hits = Number(res?.[0] ?? 0);
          const ttl = Number(res?.[1] ?? opts.windowMs);
          cb(undefined, hits, new Date(Date.now() + Math.max(ttl, 0)));
        })
        // Fail-open: Redis chết thì cho qua (log 1 dòng) thay vì 500 toàn gateway.
        .catch((err: any) => {
          console.error('[gateway][ratelimit] redis unavailable, fail-open:', err.message);
          cb(undefined, 0, new Date(Date.now() + opts.windowMs));
        });
    },
    decrement(key: string): void {
      redis.decr(prefix + key).catch(() => undefined);
    },
    resetKey(key: string): void {
      redis.del(prefix + key).catch(() => undefined);
    },
    async getKey(key: string): Promise<{ totalHits: number; resetTime: Date | undefined } | undefined> {
      try {
        const v = await redis.get(prefix + key);
        if (v == null) return undefined;
        const ttl = await redis.pttl(prefix + key);
        return { totalHits: Number(v), resetTime: new Date(Date.now() + Math.max(ttl, 0)) };
      } catch {
        return undefined;
      }
    },
  };
}
