// Entrypoint — binds the app to a port and handles graceful shutdown.
// Signals: SIGTERM (Docker/Kubernetes stop), SIGINT (Ctrl-C dev).

import "./instrument.js"; // must stay first
import { createApp } from "./src/app.js";
import { env }       from "./src/config/env.js";
import { logger }    from "./src/logger/index.js";
import { startPriceSnapshots } from "./src/jobs/priceSnapshot.js";

const app    = createApp();
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "Cortinho API started");
  startPriceSnapshots();
});

// ── Graceful shutdown ─────────────────────────────────────────
let isShuttingDown = false;

function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, "Shutdown signal received — draining connections");

  server.close((err) => {
    if (err) {
      logger.error({ err }, "Error during server close");
      process.exit(1);
    }
    logger.info("Server closed cleanly");
    process.exit(0);
  });

  // Force-kill if still open after 10 s (e.g. long-running WebSocket connections)
  setTimeout(() => {
    logger.warn("Forced shutdown after 10s timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — shutting down");
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "Unhandled promise rejection — shutting down");
  shutdown("unhandledRejection");
});
