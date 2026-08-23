import Redis from "ioredis";
import { getConfig } from "./config.js";

let client: Redis | null = null;

/** Redis is used for ephemeral state only — never the source of truth for identity. */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(getConfig().REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false
    });
    client.on("error", () => {
      /* handled by ioredis retry strategy */
    });
  }
  return client;
}

export async function redisGet(key: string): Promise<string | null> {
  return getRedis().get(key);
}

export async function redisSetEx(key: string, ttlSeconds: number, value: string): Promise<void> {
  await getRedis().set(key, value, "EX", ttlSeconds);
}

export async function redisDel(...keys: string[]): Promise<void> {
  if (keys.length > 0) await getRedis().del(...keys);
}

export async function redisIncr(key: string): Promise<number> {
  return getRedis().incr(key);
}

export async function redisExpire(key: string, ttlSeconds: number): Promise<void> {
  await getRedis().expire(key, ttlSeconds);
}

/** Atomic increment-and-expire (used for login attempt counters). */
export async function redisIncrEx(key: string, ttlSeconds: number): Promise<number> {
  const value = await getRedis().incr(key);
  if (value === 1) await getRedis().expire(key, ttlSeconds);
  return value;
}

/** Distributed lock with TTL. Returns true when acquired. */
export async function acquireLock(key: string, ttlSeconds = 30): Promise<boolean> {
  const result = await getRedis().set(`lock:${key}`, "1", "EX", ttlSeconds, "NX");
  return result === "OK";
}

export async function releaseLock(key: string): Promise<void> {
  await getRedis().del(`lock:${key}`);
}
