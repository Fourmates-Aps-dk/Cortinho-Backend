// Wishlist alerts: when a wishlist card's daily eBay median drops to or below the user's target,
// send one notification (bell + push). Each target alerts once (targetAlertedAt); editing the target re-arms it.

import { db } from "../../db.js";
import { cards } from "../../drizzle/schema.js";
import { eq, sql } from "drizzle-orm";
import { notify } from "./notificationService.js";
import { logger } from "../logger/index.js";

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n);

export async function sendWishlistAlerts() {
  const deals = await db.execute<{ id: number; user_id: number; name: string; target: string; market: string }>(sql`
    SELECT c.id, c.user_id, c.name, c.target_price AS target, m.value AS market
    FROM ${cards} c
    CROSS JOIN LATERAL (
      SELECT value FROM price_history WHERE card_id = c.id AND source = 'ebay_auto' ORDER BY recorded_at DESC LIMIT 1
    ) m
    WHERE c.status = 'wishlist' AND c.deleted_at IS NULL AND c.target_price IS NOT NULL
      AND c.target_alerted_at IS NULL AND m.value <= c.target_price`);

  for (const d of deals) {
    try {
      await notify(d.user_id, {
        type: "wishlist_deal",
        title: `${d.name} hit your target`,
        body: `${usd(+d.market)} on eBay, your target is ${usd(+d.target)}.`,
        url: `/dashboard/collection/${d.id}`,
      });
      await db.update(cards).set({ targetAlertedAt: new Date() }).where(eq(cards.id, d.id));
    } catch (err) {
      logger.error({ err, cardId: d.id }, "wishlist alert failed"); // not marked, so the next run retries
    }
  }
  if (deals.length) logger.info({ alerts: deals.length }, "wishlist alerts sent");
}
