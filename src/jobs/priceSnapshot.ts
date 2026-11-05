// Logs a market value for every collection card once a day so price history fills itself.
// Runs hourly in small batches to stay inside eBay's daily call limit (Browse: 5,000/day).

import { db } from "../../db.js";
import { cards, gradingCompanies, priceHistory } from "../../drizzle/schema.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { lookupPrices, hasEbayCredentials } from "../services/ebayService.js";
import { logger } from "../logger/index.js";

const BATCH = 40;
const MIN_SAMPLE = 3;
export const AUTO_SOURCE = "ebay_auto";

export async function runPriceSnapshot(batch = BATCH) {
  const due = await db
    .select({
      id: cards.id, name: cards.name, year: cards.year, setName: cards.setName,
      cardNumber: cards.cardNumber, category: cards.category,
      gradeValue: cards.gradeValue, gradeCompany: gradingCompanies.abbr,
    })
    .from(cards)
    .leftJoin(gradingCompanies, eq(gradingCompanies.id, cards.gradeCompanyId))
    .where(and(
      isNull(cards.deletedAt),
      eq(cards.status, "collection"),
      sql`NOT EXISTS (SELECT 1 FROM ${priceHistory} ph WHERE ph.card_id = ${cards.id}
            AND ph.source = ${AUTO_SOURCE} AND ph.recorded_at > NOW() - INTERVAL '20 hours')`,
    ))
    .limit(batch);

  let logged = 0;
  for (const c of due) {
    try {
      const r = await lookupPrices({
        name: c.name, year: c.year?.toString(), setName: c.setName ?? undefined,
        cardNumber: c.cardNumber ?? undefined, category: c.category,
        gradeCompany: c.gradeCompany ?? undefined, gradeValue: c.gradeValue ?? undefined,
      });
      if (r.sampleSize < MIN_SAMPLE) continue;
      await db.insert(priceHistory).values({
        cardId: c.id, value: String(r.medianPrice), source: AUTO_SOURCE,
        note: `median of ${r.sampleSize} ${r.source} eBay listings`,
      });
      logged++;
    } catch (err) {
      logger.warn({ err, cardId: c.id }, "price snapshot failed");
    }
  }
  logger.info({ due: due.length, logged }, "price snapshot run");
}

// ponytail: in-process timer, single instance only; move to a cron/queue if the API scales out.
export function startPriceSnapshots() {
  if (!hasEbayCredentials()) return logger.warn("eBay not configured — price snapshots disabled");
  const tick = () => runPriceSnapshot().catch((err) => logger.error({ err }, "price snapshot crashed"));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 60 * 60_000).unref();
}
