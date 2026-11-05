// Shared Redis client when REDIS_URL is set (cache + rate limits work across instances); null = in-process fallbacks.
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../logger/index.js";

export const redis = env.REDIS_URL ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false }) : null;
export const KEY_PREFIX = "cortinho:";

redis?.on("error", (err) => logger.error({ err: err.message }, "Redis error"));
