// Splits messy card names (raw eBay/CSV titles) into name / year / set / card # / parallel / category.
// Only fills empty fields; category changes only from "other". Used by POST /v1/cards/tidy (preview) and scripts/tidy-card-names.ts.

import { db } from "../../db.js";
import { cards } from "../../drizzle/schema.js";
import { and, eq, isNull } from "drizzle-orm";
import { parseTitle } from "./ebayService.js";
import { cache, CacheKey } from "../cache/index.js";

const MESSY = /[#\p{Extended_Pictographic}]|\b(19|20)\d{2}\b|\b(PSA|BGS|CGC|SGC)\s*\d|\b[A-Z]{4,}\b.*\b[A-Z]{4,}\b/u;
const messy = (name: string) => MESSY.test(name) || name.length > 30;
const MAX_PER_RUN = 50; // one Gemini call per card

export type TidyChange = { id: number; name: string; patch: Partial<typeof cards.$inferInsert> };

// userId undefined = every user (script only).
export async function tidyCards(opts: { userId?: number; apply: boolean }): Promise<TidyChange[]> {
  const rows = await db.select().from(cards).where(and(
    isNull(cards.deletedAt),
    opts.userId !== undefined ? eq(cards.userId, opts.userId) : undefined,
  ));

  const changes: TidyChange[] = [];
  for (const c of rows.filter((r) => messy(r.name) || r.category === "other").slice(0, MAX_PER_RUN)) {
    const p = await parseTitle([c.name, c.setName, c.year].filter(Boolean).join(" "));
    const patch: TidyChange["patch"] = {};
    if (p.name && p.name !== c.name && messy(c.name)) patch.name = p.name;
    if (c.year == null && p.year) patch.year = p.year;
    if (!c.setName && p.setName) patch.setName = p.setName;
    if (!c.cardNumber && p.cardNumber) patch.cardNumber = p.cardNumber;
    if (!c.parallel && "parallel" in p && p.parallel) patch.parallel = p.parallel;
    if (c.category === "other" && p.category && p.category !== "other") patch.category = p.category;
    if (!Object.keys(patch).length) continue;
    changes.push({ id: c.id, name: c.name, patch });
    if (opts.apply) {
      await db.update(cards).set({ ...patch, updatedAt: new Date() }).where(eq(cards.id, c.id));
      await cache.del(CacheKey.userCards(c.userId));
    }
  }
  return changes;
}
