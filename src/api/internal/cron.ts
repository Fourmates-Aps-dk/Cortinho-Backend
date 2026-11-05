import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { sendSuccess, sendError } from "../../utils/response.js";
import { ErrorCode } from "../../types/api.js";
import { triggerPriceSnapshot } from "../../jobs/priceSnapshot.js";

export const cronRouter = Router();

const authorized = (header: string | undefined) => {
  if (!env.CRON_SECRET || !header) return false;
  const a = Buffer.from(header), b = Buffer.from(`Bearer ${env.CRON_SECRET}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

// POST /internal/price-snapshot — Authorization: Bearer <CRON_SECRET>
// Starts one batch in the background and answers 202 straight away (a batch takes ~1-2 min).
cronRouter.post("/price-snapshot", (req, res) => {
  if (!authorized(req.headers.authorization)) {
    return sendError(res, 401, ErrorCode.UNAUTHORIZED, "Unauthorized", req.requestId);
  }
  sendSuccess(res, { started: triggerPriceSnapshot() }, 202, req.requestId);
});
