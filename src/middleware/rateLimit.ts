import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { env } from "../config/env.js";
import { ErrorCode } from "../types/api.js";

// ── Shared error formatter ────────────────────────────────────
const handler = (req: any, res: any) => {
  res.status(429).json({
    ok:        false,
    error: {
      code:    ErrorCode.RATE_LIMITED,
      message: "Too many requests. Please slow down.",
    },
    requestId: req.requestId,
    ts:        new Date().toISOString(),
  });
};

// ── General API limiter ───────────────────────────────────────
// 120 req / 1 min per IP — enough for normal browsing
export const apiLimiter = rateLimit({
  windowMs:         env.RATE_LIMIT_WINDOW_MS,
  max:              env.RATE_LIMIT_MAX,
  standardHeaders:  "draft-7",
  legacyHeaders:    false,
  keyGenerator:     (req) => req.userId || ipKeyGenerator(req.ip || '0.0.0.0'),
  handler,
  skip:             (req) => env.NODE_ENV === "test",
});

// ── AI scan limiter ───────────────────────────────────────────
// Each scan calls Gemini — expensive. 10 req / 1 min per user.
export const aiLimiter = rateLimit({
  windowMs:         env.RATE_LIMIT_WINDOW_MS,
  max:              env.AI_RATE_LIMIT_MAX,
  standardHeaders:  "draft-7",
  legacyHeaders:    false,
  keyGenerator:     (req) => req.userId || ipKeyGenerator(req.ip || '0.0.0.0'),
  handler,
  skip:             (req) => env.NODE_ENV === "test",
});

// ── Auth limiter ──────────────────────────────────────────────
// Stricter limit on auth endpoints to slow brute-force attempts
export const authLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,   // 15 minutes
  max:              20,
  standardHeaders:  "draft-7",
  legacyHeaders:    false,
  keyGenerator:     (req) => ipKeyGenerator(req.ip || '0.0.0.0'),
  handler,
});

// ── PSA lookup limiter ────────────────────────────────────────
// PSA's free tier allows 100 calls/day. Cache hits don't reach PSA, but
// cap uncached bursts anyway. 10 req / 1 min per user.
export const psaLimiter = rateLimit({
  windowMs:         env.RATE_LIMIT_WINDOW_MS,
  max:              env.PSA_RATE_LIMIT_MAX,
  standardHeaders:  "draft-7",
  legacyHeaders:    false,
  keyGenerator:     (req) => req.userId || ipKeyGenerator(req.ip || '0.0.0.0'),
  handler,
  skip:             (req) => env.NODE_ENV === "test",
});

// ── CGC lookup limiter ────────────────────────────────────────
// CGC goes through parse.bot, which bills per call. Cache hits don't reach it,
// but cap uncached bursts anyway. 10 req / 1 min per user.
export const cgcLimiter = rateLimit({
  windowMs:         env.RATE_LIMIT_WINDOW_MS,
  max:              env.CGC_RATE_LIMIT_MAX,
  standardHeaders:  "draft-7",
  legacyHeaders:    false,
  keyGenerator:     (req) => req.userId || ipKeyGenerator(req.ip || '0.0.0.0'),
  handler,
  skip:             (req) => env.NODE_ENV === "test",
});

// ── Public comps limiter ──────────────────────────────────────
// Anonymous price search spends our eBay quota. Cache hits are free; 10 req / 1 min per IP.
export const compsLimiter = rateLimit({
  windowMs:         env.RATE_LIMIT_WINDOW_MS,
  max:              10,
  standardHeaders:  "draft-7",
  legacyHeaders:    false,
  keyGenerator:     (req) => ipKeyGenerator(req.ip || '0.0.0.0'),
  handler,
  skip:             (req) => env.NODE_ENV === "test",
});
