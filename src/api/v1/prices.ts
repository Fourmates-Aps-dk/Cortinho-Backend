import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { sendSuccess, sendError } from "../../utils/response.js";
import { ErrorCode } from "../../types/api.js";
import { lookupPrices, hasEbayCredentials, type PriceLookupResult } from "../../services/ebayService.js";
import { logger } from "../../logger/index.js";

const router = Router();

export const querySchema = z.object({
  name:         z.string().min(2).max(100),
  year:         z.string().optional(),
  set:          z.string().optional(),
  cardNumber:   z.string().optional(),
  gradeCompany: z.string().optional(),
  gradeValue:   z.string().optional(),
  category:     z.string().optional(),
});

router.get(
  "/lookup",
  asyncHandler(async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(res, 400, ErrorCode.BAD_REQUEST, "name param required (min 2 chars)", req.requestId);
    }

    if (!hasEbayCredentials()) {
      return sendError(res, 503, ErrorCode.INTERNAL, "Price lookup not configured on this server", req.requestId);
    }

    const { name, year, set, cardNumber, gradeCompany, gradeValue, category } = parsed.data;

    logger.info({ name, category }, "eBay price lookup");

    try {
      const result = await lookupPrices({ name, year, setName: set, cardNumber, gradeCompany, gradeValue, category });
      sendSuccess(res, result, 200, req.requestId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Price lookup failed";
      logger.error({ err }, "eBay price lookup failed");
      sendError(res, 502, ErrorCode.INTERNAL, msg, req.requestId);
    }
  })
);

const GRADES = [
  { label: "Raw" },
  { label: "PSA 8", gradeCompany: "PSA", gradeValue: "8" },
  { label: "PSA 9", gradeCompany: "PSA", gradeValue: "9" },
  { label: "PSA 10", gradeCompany: "PSA", gradeValue: "10" },
];

// GET /v1/prices/by-grade — median for the same card raw and at common PSA grades
router.get(
  "/by-grade",
  asyncHandler(async (req, res) => {
    const parsed = querySchema.omit({ gradeCompany: true, gradeValue: true }).safeParse(req.query);
    if (!parsed.success) {
      return sendError(res, 400, ErrorCode.BAD_REQUEST, "name param required (min 2 chars)", req.requestId);
    }
    if (!hasEbayCredentials()) {
      return sendError(res, 503, ErrorCode.INTERNAL, "Price lookup not configured on this server", req.requestId);
    }
    const { set, ...card } = parsed.data;
    const results = await Promise.all(GRADES.map(async ({ label, ...grade }) => {
      try {
        const r: PriceLookupResult = await lookupPrices({ ...card, setName: set, ...grade });
        return { label, medianPrice: r.medianPrice, sampleSize: r.sampleSize, currency: r.currency, source: r.source };
      } catch (err) {
        logger.warn({ err, label }, "by-grade lookup failed");
        return { label, medianPrice: 0, sampleSize: 0, currency: "USD", source: "active" as const };
      }
    }));
    sendSuccess(res, results, 200, req.requestId);
  })
);

export default router;
