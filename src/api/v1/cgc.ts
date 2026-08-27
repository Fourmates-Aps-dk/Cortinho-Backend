import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../db.js";
import { cards } from "../../../drizzle/schema.js";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { validate } from "../../middleware/validate.js";
import { cgcLimiter } from "../../middleware/rateLimit.js";
import { sendSuccess, sendError } from "../../utils/response.js";
import { ErrorCode } from "../../types/api.js";
import { createCard } from "../../services/cardService.js";
import {
  lookupCert, isCgcConfigured, CgcError,
  cgcCertParamSchema, cgcLookupQuerySchema, cgcToCardSchema,
} from "../../services/cgcService.js";

const router = Router();

function handleCgcError(err: unknown, res: any, requestId: string): boolean {
  if (!(err instanceof CgcError)) return false;

  const code =
    err.status === 404 ? ErrorCode.NOT_FOUND    :
    err.status === 429 ? ErrorCode.RATE_LIMITED :
    ErrorCode.INTERNAL;

  sendError(res, err.status, code, err.message, requestId);
  return true;
}

// GET /v1/cgc/cert/:certNumber?population=true
// Look up a CGC cert without writing anything. Population costs a second
// upstream call, so it is opt-in.
router.get(
  "/cert/:certNumber",
  cgcLimiter,
  validate(cgcCertParamSchema, "params"),
  validate(cgcLookupQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    if (!isCgcConfigured()) {
      return sendError(res, 503, ErrorCode.INTERNAL, "CGC lookup not configured on this server", req.requestId);
    }

    const wantPopulation = (req as any).parsedQuery?.population === "true";

    try {
      const result = await lookupCert((req.params as any).certNumber, { population: wantPopulation });
      sendSuccess(res, result, 200, req.requestId);
    } catch (err) {
      if (!handleCgcError(err, res, req.requestId)) throw err;
    }
  })
);

// POST /v1/cgc/cert/:certNumber/card
// Look up the cert and create the card in one call. Body fields override the
// CGC-derived values.
router.post(
  "/cert/:certNumber/card",
  cgcLimiter,
  validate(cgcCertParamSchema, "params"),
  validate(cgcToCardSchema),
  asyncHandler(async (req, res) => {
    if (!isCgcConfigured()) {
      return sendError(res, 503, ErrorCode.INTERNAL, "CGC lookup not configured on this server", req.requestId);
    }

    const certNumber = (req.params as any).certNumber as string;

    const duplicate = await db.query.cards.findFirst({
      where: and(
        eq(cards.userId, req.dbUserId!),
        eq(cards.certNumber, certNumber),
        isNull(cards.deletedAt)
      ),
    });
    if (duplicate) {
      return sendError(
        res, 409, ErrorCode.CONFLICT,
        `Cert ${certNumber} is already in your collection`,
        req.requestId,
        { cardId: duplicate.id }
      );
    }

    try {
      const result = await lookupCert(certNumber);
      const card = await createCard(req.dbUserId!, {
        ...result.card,
        isRookie:  false,
        isPatch:   false,
        isPublic:  false,
        status:    "collection",
        ...req.body,
      });
      sendSuccess(res, { card, population: result.population, cached: result.cached }, 201, req.requestId);
    } catch (err) {
      if (!handleCgcError(err, res, req.requestId)) throw err;
    }
  })
);

export default router;
