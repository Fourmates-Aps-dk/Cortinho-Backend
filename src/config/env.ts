import dotenv from "dotenv";
import { z } from "zod";

// Load .env at module init time (before env vars are read)
dotenv.config();

const envSchema = z.object({
  NODE_ENV:            z.enum(["development", "production", "test"]).default("development"),
  PORT:                z.coerce.number().default(3001),
  DATABASE_URL:        z.string().min(1, "DATABASE_URL is required"),
  CLERK_INSTANCE:      z.string().min(1, "CLERK_INSTANCE is required"),
  CLERK_WEBHOOK_SECRET: z.string().min(1, "CLERK_WEBHOOK_SECRET is required"),

  // CORS — comma-separated list of allowed origins
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),   // 1 minute
  RATE_LIMIT_MAX:       z.coerce.number().default(120),      // requests per window
  AI_RATE_LIMIT_MAX:    z.coerce.number().default(10),       // AI scan is expensive
  PSA_RATE_LIMIT_MAX:   z.coerce.number().default(10),       // PSA free tier is 100 calls/day
  CGC_RATE_LIMIT_MAX:   z.coerce.number().default(10),       // parse.bot bills per call

  // Redis (optional — falls back to in-process memory store)
  REDIS_URL: z.string().optional(),

  // Secrets
  PRICECHARTING_TOKEN: z.string().optional(),
  PSA_API_TOKEN:       z.string().optional(),
  PARSE_API_KEY:       z.string().optional(),
  CRON_SECRET:         z.string().min(32).optional(), // shared secret for POST /internal/price-snapshot
  PARSE_CGC_SCRAPER_ID: z.string().default("139b9b93-f52f-4c61-824f-4b9e918d0aa1"),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Environment validation failed:\n${issues}`);
  }
  return result.data;
}

export const env = parseEnv();
