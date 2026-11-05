// Express app factory — separated from listen() so tests can import without binding a port.

import express from "express";
import { requestId }              from "./middleware/requestId.js";
import { applySecurityMiddleware } from "./middleware/security.js";
import { globalErrorHandler }     from "./middleware/errorHandler.js";
import { logger }                 from "./logger/index.js";
import pinoHttp                   from "pino-http";
import v1Router                   from "./api/v1/router.js";
import publicProfilesRouter        from "./api/public/profiles.js";
import publicCompsRouter           from "./api/public/comps.js";
import { clerkWebhookHandler }    from "./webhooks/clerk.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1); // Render sits one proxy hop in front; needed for per-IP rate limits

  // ── Request ID — before everything ───────────────────────
  app.use(requestId);

  // ── HTTP request logger ───────────────────────────────────
  app.use(
    pinoHttp({
      logger,
      customLogLevel: (_req, res) =>
        res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
      genReqId: (req) => (req as any).requestId,
      serializers: {
        req: (r) => ({ method: r.method, url: r.url, requestId: r.id }),
        res: (r) => ({ status: r.statusCode }),
      },
    })
  );

  // ── Security (Helmet + CORS) ──────────────────────────────
  applySecurityMiddleware(app);

  // ── Clerk webhook — RAW body required for svix signature ─
  // Must be mounted BEFORE express.json() so the body isn't consumed.
  app.post(
    "/webhooks/clerk",
    express.raw({ type: "application/json" }),
    clerkWebhookHandler
  );

  // ── Body parsing ──────────────────────────────────────────
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // ── Root — so visiting the bare URL doesn't look like an outage
  app.get("/", (_req, res) => {
    res.json({ ok: true, service: "cortinho-api", health: "/health", api: "/api/v1" });
  });

  // ── Health check ──────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), ts: new Date().toISOString() });
  });

  // ── Public (no auth) ─────────────────────────────────────
  app.use("/api/public/u", publicProfilesRouter);
  app.use("/api/public/comps", publicCompsRouter);

  // ── Versioned API ─────────────────────────────────────────
  app.use("/api/v1", v1Router);

  // ── 404 ───────────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).json({
      ok:    false,
      error: { code: "NOT_FOUND", message: `${req.method} ${req.path} not found` },
      requestId: req.requestId,
      ts:    new Date().toISOString(),
    });
  });

  // ── Global error handler — must be last ──────────────────
  app.use(globalErrorHandler);

  return app;
}
