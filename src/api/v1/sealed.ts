import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { validate, idParamSchema } from "../../middleware/validate.js";
import { sendSuccess, sendError } from "../../utils/response.js";
import { ErrorCode } from "../../types/api.js";
import {
  listSealed, getSealed, createSealed, updateSealed,
  softDeleteSealed, getSealedPriceHistory,
  createSealedSchema, updateSealedSchema, listSealedSchema,
} from "../../services/sealedService.js";

const router = Router();

router.get("/",    validate(listSealedSchema, "query"), asyncHandler(async (req, res) => {
  sendSuccess(res, await listSealed(req.dbUserId!, (req as any).parsedQuery), 200, req.requestId);
}));

router.get("/:id", validate(idParamSchema, "params"), asyncHandler(async (req, res) => {
  const p = await getSealed(req.dbUserId!, (req.params as any).id);
  if (!p) return sendError(res, 404, ErrorCode.NOT_FOUND, "Sealed product not found", req.requestId);
  sendSuccess(res, p, 200, req.requestId);
}));

router.post("/", validate(createSealedSchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await createSealed(req.dbUserId!, req.body), 201, req.requestId);
}));

router.patch("/:id",
  validate(idParamSchema, "params"),
  validate(updateSealedSchema),
  asyncHandler(async (req, res) => {
    const p = await updateSealed(req.dbUserId!, (req.params as any).id, req.body);
    if (!p) return sendError(res, 404, ErrorCode.NOT_FOUND, "Sealed product not found", req.requestId);
    sendSuccess(res, p, 200, req.requestId);
  })
);

router.delete("/:id", validate(idParamSchema, "params"), asyncHandler(async (req, res) => {
  const deleted = await softDeleteSealed(req.dbUserId!, (req.params as any).id);
  if (!deleted) return sendError(res, 404, ErrorCode.NOT_FOUND, "Sealed product not found", req.requestId);
  sendSuccess(res, { deleted: true }, 200, req.requestId);
}));

router.get("/:id/price-history", validate(idParamSchema, "params"), asyncHandler(async (req, res) => {
  const history = await getSealedPriceHistory(req.dbUserId!, (req.params as any).id);
  if (!history) return sendError(res, 404, ErrorCode.NOT_FOUND, "Sealed product not found", req.requestId);
  sendSuccess(res, history, 200, req.requestId);
}));

const logPriceSchema = z.object({
  value:  z.number().positive(),
  source: z.enum(["manual","pricecharting","import"]).default("manual"),
  note:   z.string().max(256).optional(),
});

router.post("/:id/price-history",
  validate(idParamSchema, "params"),
  validate(logPriceSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as any;
    const product = await getSealed(req.dbUserId!, id);
    if (!product) return sendError(res, 404, ErrorCode.NOT_FOUND, "Sealed product not found", req.requestId);

    const { db } = await import("../../../db.js");
    const { sealedPriceHistory, sealedProducts } = await import("../../../drizzle/schema.js");
    const { eq } = await import("drizzle-orm");

    const [entry] = await db.insert(sealedPriceHistory)
      .values({ sealedProductId: id, value: String(req.body.value), source: req.body.source, note: req.body.note })
      .returning();
    await db.update(sealedProducts)
      .set({ currentValue: String(req.body.value), updatedAt: new Date() })
      .where(eq(sealedProducts.id, id));

    sendSuccess(res, entry, 201, req.requestId);
  })
);

export default router;
