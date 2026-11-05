import { Request, Response, NextFunction } from "express";
import * as Sentry from "@sentry/node";
import { logger } from "../logger/index.js";
import { ErrorCode } from "../types/api.js";

// Global error handler — catches anything thrown by next(err) or async handlers.
// Must be registered LAST, after all routes.
export function globalErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) {
  logger.error(
    { err, requestId: req.requestId, path: req.path, method: req.method },
    "Unhandled error"
  );

  const status = (err as any).status ?? (err as any).statusCode ?? 500;
  if (status >= 500) Sentry.captureException(err); // no-op when Sentry isn't initialised
  res.status(status).json({
    ok:        false,
    error: {
      code:    ErrorCode.INTERNAL,
      message: status < 500 ? err.message : "An unexpected error occurred",
    },
    requestId: req.requestId,
    ts:        new Date().toISOString(),
  });
}

// Wrap async route handlers so errors propagate to globalErrorHandler.
// Usage: router.get("/path", asyncHandler(async (req, res) => { ... }))
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
