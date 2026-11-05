import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { validate } from "../../middleware/validate.js";
import { sendSuccess } from "../../utils/response.js";
import { env } from "../../config/env.js";
import {
  listNotifications, markRead, markReadSchema, notify, pushEnabled,
  saveSubscription, removeSubscription, subscribeSchema,
} from "../../services/notificationService.js";

const router = Router();

// GET /v1/notifications → { items, unread }
router.get("/", asyncHandler(async (req, res) => {
  sendSuccess(res, await listNotifications(req.dbUserId!), 200, req.requestId);
}));

// POST /v1/notifications/read — { ids? } (no ids = mark all read)
router.post("/read", validate(markReadSchema), asyncHandler(async (req, res) => {
  await markRead(req.dbUserId!, req.body.ids);
  sendSuccess(res, { ok: true }, 200, req.requestId);
}));

// POST /v1/notifications/test — sends a test notification to the user's own devices
router.post("/test", asyncHandler(async (req, res) => {
  await notify(req.dbUserId!, { type: "test", title: "Notifications are on", body: "You'll hear from Cortinho here when a wishlist card hits your target.", url: "/dashboard/wishlist" });
  sendSuccess(res, { ok: true }, 200, req.requestId);
}));

// GET /v1/notifications/push-key → VAPID public key for PushManager.subscribe (null = push not configured)
router.get("/push-key", (req, res) => {
  sendSuccess(res, { publicKey: pushEnabled ? env.VAPID_PUBLIC_KEY : null }, 200, req.requestId);
});

// POST /v1/notifications/subscribe — browser PushSubscription JSON
router.post("/subscribe", validate(subscribeSchema), asyncHandler(async (req, res) => {
  await saveSubscription(req.dbUserId!, req.body, req.get("user-agent"));
  sendSuccess(res, { ok: true }, 201, req.requestId);
}));

// POST /v1/notifications/unsubscribe — { endpoint }
router.post("/unsubscribe", validate(z.object({ endpoint: z.string().url().max(2000) })), asyncHandler(async (req, res) => {
  await removeSubscription(req.dbUserId!, req.body.endpoint);
  sendSuccess(res, { ok: true }, 200, req.requestId);
}));

export default router;
