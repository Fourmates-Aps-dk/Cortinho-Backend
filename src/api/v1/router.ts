import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { apiLimiter } from "../../middleware/rateLimit.js";
import cardsRouter        from "./cards.js";
import profileRouter      from "./profile.js";
import transactionsRouter from "./transactions.js";
import statsRouter        from "./stats.js";
import sealedRouter       from "./sealed.js";
import scanRouter         from "./scan.js";
import importRouter       from "./import.js";
import uploadRouter       from "./upload.js";
import pricesRouter       from "./prices.js";
import ebayRouter         from "./ebay.js";
import psaRouter          from "./psa.js";

const v1 = Router();

// ── Public ────────────────────────────────────────────────────
v1.get("/health", (_req, res) => {
  res.json({ ok: true, version: "v1", ts: new Date().toISOString() });
});

// ── Authenticated ─────────────────────────────────────────────
v1.use(apiLimiter);
v1.use(requireAuth);

v1.use("/cards",        cardsRouter);
v1.use("/profile",      profileRouter);
v1.use("/transactions", transactionsRouter);
v1.use("/stats",        statsRouter);
v1.use("/sealed",       sealedRouter);
v1.use("/scan",         scanRouter);
v1.use("/import",       importRouter);
v1.use("/upload",       uploadRouter);
v1.use("/prices",       pricesRouter);
v1.use("/ebay",         ebayRouter);
v1.use("/psa",          psaRouter);

export default v1;
