// Sentry init — imported first in server.ts. No-op unless SENTRY_DSN is set.
// ponytail: plain first import, not `node --import`; ESM can't patch express this way, so
// errors are captured explicitly in globalErrorHandler. Use --import if auto-tracing of express matters.
import * as Sentry from "@sentry/node";
import { env } from "./src/config/env.js";

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn:              env.SENTRY_DSN,
    environment:      env.NODE_ENV,
    tracesSampleRate: 0.1,
    // SDK v11 replaced sendDefaultPii with dataCollection; keep user data out of events.
    dataCollection:   { userInfo: false, cookies: false, httpBodies: [], databaseQueryData: false, genAI: { inputs: false, outputs: false } },
  });
}
