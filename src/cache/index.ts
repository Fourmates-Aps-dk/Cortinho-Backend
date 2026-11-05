// Cache layer with an in-process Map store.
// Replace set/get/del implementations with ioredis when REDIS_URL is set
// — the interface is identical so no call-site changes are needed.

import { logger } from "../logger/index.js";
import { redis, KEY_PREFIX } from "./redis.js";

interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  flush(): Promise<void>;
}

// ── In-process store (development / single-instance) ─────────
interface CacheEntry<T> {
  value: T;
  expiresAt: number | null;
}

const store = new Map<string, CacheEntry<unknown>>();

function isExpired(entry: CacheEntry<unknown>): boolean {
  return entry.expiresAt !== null && Date.now() > entry.expiresAt;
}

const memoryCache: CacheStore = {
  async get<T>(key: string): Promise<T | null> {
    const entry = store.get(key) as CacheEntry<T> | undefined;
    if (!entry || isExpired(entry)) {
      if (entry) store.delete(key);
      return null;
    }
    return entry.value;
  },

  async set<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
    store.set(key, {
      value,
      expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
    });
  },

  async del(key: string): Promise<void> {
    store.delete(key);
  },

  async flush(): Promise<void> {
    store.clear();
  },
};

// ── Redis store (shared across instances) ────────────────────
const redisCache = (r: NonNullable<typeof redis>): CacheStore => ({
  async get<T>(key: string) {
    const raw = await r.get(KEY_PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  },
  async set<T>(key: string, value: T, ttlSeconds = 300) {
    const raw = JSON.stringify(value);
    await (ttlSeconds > 0 ? r.set(KEY_PREFIX + key, raw, "EX", ttlSeconds) : r.set(KEY_PREFIX + key, raw));
  },
  async del(key: string) {
    await r.del(KEY_PREFIX + key);
  },
  async flush() {
    // Only our keys: the Redis may be shared
    for await (const keys of r.scanStream({ match: `${KEY_PREFIX}*`, count: 500 })) if ((keys as string[]).length) await r.del(...(keys as string[]));
  },
});

export const cache: CacheStore = redis ? redisCache(redis) : memoryCache;

// ── Cache key helpers ─────────────────────────────────────────
export const CacheKey = {
  userCards:   (userId: number) => `user:${userId}:cards`,
  userProfile: (userId: number) => `user:${userId}:profile`,
  cardDetail:  (cardId: number) => `card:${cardId}`,
  jwks:        ()               => "clerk:jwks",
};

// ── Cache-aside wrapper ───────────────────────────────────────
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const hit = await cache.get<T>(key);
  if (hit !== null) return hit;
  const value = await fetcher();
  await cache.set(key, value, ttlSeconds);
  return value;
}

// Periodic GC for in-process store (purge expired keys)
setInterval(() => {
  let purged = 0;
  for (const [key, entry] of store.entries()) {
    if (isExpired(entry)) { store.delete(key); purged++; }
  }
  if (purged > 0) logger.debug({ purged }, "Cache GC run");
}, 60_000).unref();
