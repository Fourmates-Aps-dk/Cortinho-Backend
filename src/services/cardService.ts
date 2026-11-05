import { db } from "../../db.js";
import { cards, priceHistory } from "../../drizzle/schema.js";
import { eq, and, isNull, desc, ilike, or, SQL, count, sql, inArray } from "drizzle-orm";
import { cache, CacheKey } from "../cache/index.js";
import type { NewCard } from "../../drizzle/schema.js";
import { z } from "zod";
import { patchSchema } from "../utils/schema.js";

// ── Schemas ───────────────────────────────────────────────────

export const createCardSchema = z.object({
  name:              z.string().min(1).max(256),
  category:          z.enum(["pokemon","soccer","basketball","football","other"]).default("other"),
  player:            z.string().max(256).optional(),
  team:              z.string().max(256).optional(),
  year:              z.number().int().min(1800).max(2100).optional(),
  setName:           z.string().max(256).optional(),
  cardNumber:        z.string().max(64).optional(),
  parallel:          z.string().max(128).optional(),
  serialNumber:      z.string().max(64).optional(),
  isRookie:          z.boolean().default(false),
  isAutographed:     z.boolean().default(false),
  isPatch:           z.boolean().default(false),
  isGraded:          z.boolean().default(false),
  gradeCompanyId:    z.number().int().optional(),
  gradeValue:        z.number().min(1).max(10).optional(),
  certNumber:        z.string().max(64).optional(),
  condition:         z.enum(["raw","poor","fair","good","very_good","excellent","near_mint","mint","gem_mint"]).optional(),
  purchasePrice:     z.number().min(0).optional(),
  targetPrice:       z.number().min(0).nullable().optional(),
  currentValue:      z.number().min(0).optional(),
  purchaseDate:      z.string().optional(),       // YYYY-MM-DD
  acquisitionMethod: z.enum(["bought","pulled","trade","gift","other"]).optional(),
  priceSource:       z.string().max(256).optional(),
  imageUrl:          z.string().url().optional(),
  imageBackUrl:      z.string().url().optional(),
  notes:             z.string().optional(),
  isPublic:          z.boolean().default(false),
  status:            z.enum(["collection","wishlist","for_sale","sold","traded","draft"]).default("collection"),
});

export const updateCardSchema = patchSchema(createCardSchema);

export const listCardsSchema = z.object({
  page:     z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status:   z.enum(["collection","wishlist","for_sale","sold","traded","draft","all"]).default("all"),
  category: z.enum(["pokemon","soccer","basketball","football","other","all"]).default("all"),
  search:   z.string().optional(),
  sort:     z.enum(["createdAt","name","currentValue","purchasePrice"]).default("createdAt"),
  dir:      z.enum(["asc","desc"]).default("desc"),
});

export type CreateCardInput = z.infer<typeof createCardSchema>;
export type UpdateCardInput = z.infer<typeof updateCardSchema>;
export type ListCardsInput  = z.infer<typeof listCardsSchema>;

// ── Service functions ─────────────────────────────────────────

export async function listCards(userId: number, input: ListCardsInput) {
  const conditions: SQL[] = [
    eq(cards.userId, userId),
    isNull(cards.deletedAt),
  ];

  if (input.status !== "all")   conditions.push(eq(cards.status, input.status));
  if (input.category !== "all") conditions.push(eq(cards.category, input.category));

  if (input.search?.trim()) {
    const q = `%${input.search.trim()}%`;
    conditions.push(
      or(
        ilike(cards.name,       q),
        ilike(cards.setName!,   q),
        ilike(cards.player!,    q),
        ilike(cards.cardNumber!, q)
      ) as SQL
    );
  }

  const where = and(...conditions);
  const offset = (input.page - 1) * input.pageSize;

  const [rows, [{ total }]] = await Promise.all([
    db.query.cards.findMany({
      where,
      // Latest daily eBay median (see jobs/priceSnapshot) — drives wishlist price alerts
      extras: {
        marketPrice: sql<string | null>`(SELECT ph.value FROM ${priceHistory} ph WHERE ph.card_id = "cards"."id"
          AND ph.source = 'ebay_auto' ORDER BY ph.recorded_at DESC LIMIT 1)`.as("market_price"),
      },
      limit:  input.pageSize,
      offset,
      orderBy: (t, { asc, desc }) =>
        input.dir === "asc" ? [asc((t as any)[input.sort])] : [desc((t as any)[input.sort])],
    }),
    db.select({ total: count() }).from(cards).where(where),
  ]);

  return {
    items:      rows,
    total:      Number(total),
    page:       input.page,
    pageSize:   input.pageSize,
    totalPages: Math.ceil(Number(total) / input.pageSize),
  };
}

export async function getCard(userId: number, cardId: number) {
  return db.query.cards.findFirst({
    where: and(eq(cards.id, cardId), eq(cards.userId, userId), isNull(cards.deletedAt)),
  });
}

export async function createCard(userId: number, input: CreateCardInput) {
  const [card] = await db
    .insert(cards)
    .values({ ...input, userId } as NewCard)
    .returning();

  if (input.currentValue) {
    await db.insert(priceHistory).values({
      cardId: card.id,
      value:  String(input.currentValue),
      source: "manual",
    });
  }

  await cache.del(CacheKey.userCards(userId));
  return card;
}

const GRADE_NAME_TO_ID: Record<string, number> = { PSA: 1, BGS: 2, CGC: 3, SGC: 4 };

export interface BulkImportResult {
  imported: number;
  failed:   number;
  errors:   Array<{ index: number; name?: string; message: string }>;
}

export async function bulkCreateCards(userId: number, rows: any[]): Promise<BulkImportResult> {
  const validRows: NewCard[]  = [];
  const priceRows: { idx: number; value: string }[] = [];
  const errors: BulkImportResult["errors"] = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = { ...rows[i] };

    // Resolve gradeCompanyId from name string
    if (raw.gradeCompany && !raw.gradeCompanyId) {
      raw.gradeCompanyId = GRADE_NAME_TO_ID[String(raw.gradeCompany).toUpperCase()] ?? undefined;
    }
    delete raw.gradeCompany;

    const parsed = createCardSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({ index: i, name: raw.name, message: parsed.error.issues[0]?.message ?? "Invalid row" });
      continue;
    }
    validRows.push({ ...parsed.data, userId } as unknown as NewCard);
    if (parsed.data.currentValue !== undefined) {
      priceRows.push({ idx: validRows.length - 1, value: String(parsed.data.currentValue) });
    }
  }

  if (validRows.length > 0) {
    const inserted = await db.insert(cards).values(validRows as any[]).returning({ id: cards.id });
    const priceInserts = priceRows.map((pr) => ({
      cardId: inserted[pr.idx].id,
      value:  pr.value,
      source: "import" as const,
    }));
    if (priceInserts.length > 0) {
      await db.insert(priceHistory).values(priceInserts);
    }
    await cache.del(CacheKey.userCards(userId));
  }

  return { imported: validRows.length, failed: errors.length, errors };
}

export async function updateCard(userId: number, cardId: number, input: UpdateCardInput) {
  const existing = await getCard(userId, cardId);
  if (!existing) return null;

  const [updated] = await db
    .update(cards)
    // A new target re-arms the wishlist alert
    .set({ ...input, ...(input.targetPrice !== undefined && { targetAlertedAt: null }), updatedAt: new Date() } as any)
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
    .returning();

  // Auto-log price history when value changes
  const newValue = input.currentValue;
  if (newValue !== undefined && String(newValue) !== existing.currentValue) {
    await db.insert(priceHistory).values({
      cardId,
      value:  String(newValue),
      source: "manual",
    });
  }

  await Promise.all([
    cache.del(CacheKey.userCards(userId)),
    cache.del(CacheKey.cardDetail(cardId)),
  ]);

  return updated;
}

export async function bulkUpdateCards(userId: number, ids: number[], patch: Pick<UpdateCardInput, "status" | "isPublic">) {
  if (patch.status === undefined && patch.isPublic === undefined) return 0;
  const rows = await db
    .update(cards)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(inArray(cards.id, ids), eq(cards.userId, userId), isNull(cards.deletedAt)))
    .returning({ id: cards.id });
  await cache.del(CacheKey.userCards(userId));
  return rows.length;
}

export async function bulkSoftDeleteCards(userId: number, ids: number[]) {
  const rows = await db
    .update(cards)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(inArray(cards.id, ids), eq(cards.userId, userId), isNull(cards.deletedAt)))
    .returning({ id: cards.id });
  await cache.del(CacheKey.userCards(userId));
  return rows.length;
}

export async function softDeleteCard(userId: number, cardId: number): Promise<boolean> {
  const [result] = await db
    .update(cards)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId), isNull(cards.deletedAt)))
    .returning({ id: cards.id });

  if (!result) return false;

  await Promise.all([
    cache.del(CacheKey.userCards(userId)),
    cache.del(CacheKey.cardDetail(cardId)),
  ]);

  return true;
}

export async function getPriceHistory(userId: number, cardId: number) {
  const card = await getCard(userId, cardId);
  if (!card) return null;
  return db.query.priceHistory.findMany({
    where:   eq(priceHistory.cardId, cardId),
    orderBy: desc(priceHistory.recordedAt),
  });
}

export async function logPrice(userId: number, cardId: number, value: number, source = "manual", note?: string) {
  const card = await getCard(userId, cardId);
  if (!card) return null;

  const [entry] = await db
    .insert(priceHistory)
    .values({ cardId, value: String(value), source, note })
    .returning();

  // Update card's current_value to latest price
  await db.update(cards)
    .set({ currentValue: String(value), priceSource: source, updatedAt: new Date() })
    .where(eq(cards.id, cardId));

  await cache.del(CacheKey.cardDetail(cardId));
  return entry;
}
