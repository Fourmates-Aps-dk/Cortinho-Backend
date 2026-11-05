// In-app notifications + Web Push. notify() stores the notification (the bell reads it) and pushes it
// to every device the user enabled. Push is skipped when VAPID keys aren't configured.

import webpush from "web-push";
import { z } from "zod";
import { db } from "../../db.js";
import { notifications, pushSubscriptions } from "../../drizzle/schema.js";
import { and, desc, eq, inArray, isNull, count } from "drizzle-orm";
import { env } from "../config/env.js";
import { logger } from "../logger/index.js";

export const pushEnabled = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
if (pushEnabled) webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);

export type NotificationInput = { type: string; title: string; body?: string; url?: string };

export async function notify(userId: number, n: NotificationInput) {
  const [row] = await db.insert(notifications).values({ userId, ...n }).returning();
  if (pushEnabled) await pushToUser(userId, { id: row.id, title: n.title, body: n.body, url: n.url ?? "/dashboard", tag: n.type });
  return row;
}

async function pushToUser(userId: number, payload: Record<string, unknown>) {
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  const gone: number[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 24 * 3600 });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) gone.push(s.id); // browser dropped the subscription
      else logger.warn({ status, userId }, "web push failed");
    }
  }));
  if (gone.length) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));
}

export async function listNotifications(userId: number, limit = 50) {
  const [items, [{ unread }]] = await Promise.all([
    db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(limit),
    db.select({ unread: count() }).from(notifications).where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
  ]);
  return { items, unread: Number(unread) };
}

export const markReadSchema = z.object({ ids: z.array(z.number().int().positive()).max(200).optional() }); // omit ids = all

export async function markRead(userId: number, ids?: number[]) {
  await db.update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), ids?.length ? inArray(notifications.id, ids) : undefined));
}

export const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});

export async function saveSubscription(userId: number, sub: z.infer<typeof subscribeSchema>, userAgent?: string) {
  // An endpoint belongs to one browser; re-subscribing (or another account on it) takes it over
  await db.insert(pushSubscriptions)
    .values({ userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent?.slice(0, 300) })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
}

export async function removeSubscription(userId: number, endpoint: string) {
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}
