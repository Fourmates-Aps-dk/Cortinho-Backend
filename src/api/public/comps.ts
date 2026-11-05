import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { sendSuccess, sendError } from "../../utils/response.js";
import { ErrorCode } from "../../types/api.js";
import { compsLimiter } from "../../middleware/rateLimit.js";
import { lookupPrices, hasEbayCredentials } from "../../services/ebayService.js";
import { querySchema } from "../v1/prices.js";
import { logger } from "../../logger/index.js";

const router = Router();

// GET /public/comps?name=&year=&set=&cardNumber=&gradeCompany=&gradeValue=&category=
router.get(
  "/",
  compsLimiter,
  asyncHandler(async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return sendError(res, 400, ErrorCode.BAD_REQUEST, "name param required (min 2 chars)", req.requestId);
    }
    if (!hasEbayCredentials()) {
      return sendError(res, 503, ErrorCode.INTERNAL, "Price lookup not configured on this server", req.requestId);
    }
    const { set, ...rest } = parsed.data;
    try {
      sendSuccess(res, await lookupPrices({ ...rest, setName: set }), 200, req.requestId);
    } catch (err) {
      logger.error({ err }, "public comps lookup failed");
      sendError(res, 502, ErrorCode.INTERNAL, "Price lookup failed", req.requestId);
    }
  })
);

export default router;
