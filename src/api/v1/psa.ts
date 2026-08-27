import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../db.js";
import { cards } from "../../../drizzle/schema.js";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { validate } from "../../middleware/validate.js";
import { psaLimiter } from "../../middleware/rateLimit.js";
import { sendSuccess, sendError } from "../../utils/response.js";
import { ErrorCode } from "../../types/api.js";
import { createCard } from "../../services/cardService.js";
import {
  lookupCert, isPsaConfigured, PsaError,
  certParamSchema, certToCardSchema,
} from "../../services/psaService.js";

const router = Router();

// Map a PsaError onto the API error envelope. Anything else bubbles to the
// global handler.
function handlePsaError(err: unknown, res: any, requestId: string): boolean {
  if (!(err instanceof PsaError)) return false;

  const code =
    err.status === 404 ? ErrorCode.NOT_FOUND      :
    err.status === 429 ? ErrorCode.RATE_LIMITED   :
    ErrorCode.INTERNAL;

  sendError(res, err.status, code, err.message, requestId);
  return true;
}

// GET /v1/psa/cert/:certNumber
// Look up a PSA cert without writing anything. Frontend uses this to preview
// before committing the card.
router.get(
  "/cert/:certNumber",
  psaLimiter,
  validate(certParamSchema, "params"),
  asyncHandler(async (req, res) => {
    if (!isPsaConfigured()) {
      return sendError(res, 503, ErrorCode.INTERNAL, "PSA lookup not configured on this server", req.requestId);
    }

    try {
      const result = await lookupCert((req.params as any).certNumber);
      sendSuccess(res, result, 200, req.requestId);
    } catch (err) {
      if (!handlePsaError(err, res, req.requestId)) throw err;
    }
  })
);

// POST /v1/psa/cert/:certNumber/card
// Look up the cert and create the card in one call. Body fields override the
// PSA-derived values.
router.post(
  "/cert/:certNumber/card",
  psaLimiter,
  validate(certParamSchema, "params"),
  validate(certToCardSchema),
  asyncHandler(async (req, res) => {
    if (!isPsaConfigured()) {
      return sendError(res, 503, ErrorCode.INTERNAL, "PSA lookup not configured on this server", req.requestId);
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
      if (!handlePsaError(err, res, req.requestId)) throw err;
    }
  })
);

export default router;
