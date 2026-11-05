import { db } from "../../db.js";
import { cards, priceHistory } from "../../drizzle/schema.js";
import { eq, and, isNull, desc, sql } from "drizzle-orm";

export async function getCollectionSummary(userId: number) {
  const allCards = await db.query.cards.findMany({
    where: and(eq(cards.userId, userId), isNull(cards.deletedAt)),
    columns: {
      id: true, status: true, category: true,
      currentValue: true, purchasePrice: true,
      isGraded: true, isRookie: true, isAutographed: true,
    },
  });

  const active  = allCards.filter((c) => c.status === "collection");
  const sum     = (arr: typeof allCards, key: "currentValue" | "purchasePrice") =>
    arr.reduce((s, c) => s + (Number(c[key]) || 0), 0);

  const totalValue = sum(active, "currentValue");
  const totalCost  = sum(active, "purchasePrice");

  const byCategory: Record<string, { count: number; value: number }> = {};
  for (const c of active) {
    const cat = c.category ?? "other";
    if (!byCategory[cat]) byCategory[cat] = { count: 0, value: 0 };
    byCategory[cat].count++;
    byCategory[cat].value += Number(c.currentValue) || 0;
  }

  return {
    totalCards:      allCards.length,
    collectionCount: active.length,
    wishlistCount:   allCards.filter((c) => c.status === "wishlist").length,
    forSaleCount:    allCards.filter((c) => c.status === "for_sale").length,
    soldCount:       allCards.filter((c) => c.status === "sold").length,
    gradedCount:     allCards.filter((c) => c.isGraded).length,
    rookieCount:     allCards.filter((c) => c.isRookie).length,
    totalValue:      +totalValue.toFixed(2),
    totalCost:       +totalCost.toFixed(2),
    totalPl:         +(totalValue - totalCost).toFixed(2),
    plPct:           totalCost > 0 ? +((totalValue - totalCost) / totalCost * 100).toFixed(2) : null,
    byCategory,
  };
}

export async function getPortfolioTimeline(userId: number, days = 90) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Each day = sum of every collection card's latest value known on that day (values carry forward).
  const rows = await db.execute<{ date: string; value: string }>(sql`
    WITH user_ph AS (
      SELECT ph.card_id, ph.value, ph.recorded_at
      FROM ${priceHistory} ph JOIN ${cards} c ON c.id = ph.card_id
      WHERE c.user_id = ${userId} AND c.deleted_at IS NULL AND c.status = 'collection'
    ),
    days AS (
      SELECT DISTINCT DATE_TRUNC('day', recorded_at)::date AS d FROM user_ph WHERE recorded_at >= ${since.toISOString()}
    )
    SELECT d::text AS date, ROUND(SUM(v.value), 2)::text AS value
    FROM days CROSS JOIN LATERAL (
      SELECT DISTINCT ON (card_id) value FROM user_ph
      WHERE recorded_at < d + 1 ORDER BY card_id, recorded_at DESC
    ) v
    GROUP BY d ORDER BY d`);

  return rows.map((r) => ({ date: r.date, value: Number(r.value) }));
}

export async function getRecentCards(userId: number, limit = 8) {
  return db.query.cards.findMany({
    where:   and(eq(cards.userId, userId), isNull(cards.deletedAt), eq(cards.status, "collection")),
    orderBy: desc(cards.createdAt),
    limit,
    columns: {
      id: true, name: true, setName: true, category: true,
      currentValue: true, purchasePrice: true,
      imageUrl: true, isRookie: true, isAutographed: true,
      isGraded: true, gradeValue: true, gradeCompanyId: true,
      createdAt: true,
    },
  });
}

export async function getDashboardStats(userId: number) {
  const [summary, timeline, recent] = await Promise.all([
    getCollectionSummary(userId),
    getPortfolioTimeline(userId, 365), // always fetch full year; client slices
    getRecentCards(userId, 8),
  ]);

  return { summary, timeline, recentCards: recent };
}
