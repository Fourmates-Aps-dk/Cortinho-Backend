import { db } from "../../db.js";
import { sealedProducts, sealedPriceHistory } from "../../drizzle/schema.js";
import { eq, and, isNull, desc, count, SQL } from "drizzle-orm";
import { z } from "zod";
import { patchSchema } from "../utils/schema.js";

export const createSealedSchema = z.object({
  name:          z.string().min(1).max(256),
  category:      z.enum(["pokemon","soccer","basketball","football","other"]).default("other"),
  setName:       z.string().max(256).optional(),
  productType:   z.string().max(128).optional(),
  language:      z.string().max(64).optional(),
  year:          z.number().int().min(1900).max(2100).optional(),
  quantity:      z.number().int().min(1).default(1),
  purchasePrice: z.number().min(0).optional(),
  currentValue:  z.number().min(0).optional(),
  purchaseDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  imageUrl:      z.string().url().optional(),
  notes:         z.string().optional(),
  status:        z.enum(["collection","for_sale","sold"]).default("collection"),
});

export const updateSealedSchema = patchSchema(createSealedSchema);

export const listSealedSchema = z.object({
  page:     z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status:   z.enum(["collection","for_sale","sold","all"]).default("all"),
  category: z.enum(["pokemon","soccer","basketball","football","other","all"]).default("all"),
});

export type CreateSealedInput = z.infer<typeof createSealedSchema>;

export async function listSealed(userId: number, input: z.infer<typeof listSealedSchema>) {
  const conditions: SQL[] = [eq(sealedProducts.userId, userId), isNull(sealedProducts.deletedAt)];
  if (input.status !== "all")   conditions.push(eq(sealedProducts.status, input.status));
  if (input.category !== "all") conditions.push(eq(sealedProducts.category, input.category));

  const where  = and(...conditions);
  const offset = (input.page - 1) * input.pageSize;

  const [rows, [{ total }]] = await Promise.all([
    db.query.sealedProducts.findMany({ where, limit: input.pageSize, offset, orderBy: desc(sealedProducts.createdAt) }),
    db.select({ total: count() }).from(sealedProducts).where(where),
  ]);

  const n = Number(total);
  return { items: rows, total: n, page: input.page, pageSize: input.pageSize, totalPages: Math.ceil(n / input.pageSize) };
}

export async function getSealed(userId: number, id: number) {
  return db.query.sealedProducts.findFirst({
    where: and(eq(sealedProducts.id, id), eq(sealedProducts.userId, userId), isNull(sealedProducts.deletedAt)),
  });
}

export async function createSealed(userId: number, input: CreateSealedInput) {
  const [product] = await db
    .insert(sealedProducts)
    .values({ ...input, userId,
      purchasePrice: input.purchasePrice !== undefined ? String(input.purchasePrice) : undefined,
      currentValue:  input.currentValue  !== undefined ? String(input.currentValue)  : undefined,
    } as any)
    .returning();

  if (input.currentValue) {
    await db.insert(sealedPriceHistory).values({
      sealedProductId: product.id,
      value: String(input.currentValue),
      source: "manual",
    });
  }

  return product;
}

export async function updateSealed(userId: number, id: number, input: Partial<CreateSealedInput>) {
  const existing = await getSealed(userId, id);
  if (!existing) return null;

  const [updated] = await db
    .update(sealedProducts)
    .set({ ...input,
      ...(input.purchasePrice !== undefined && { purchasePrice: String(input.purchasePrice) }),
      ...(input.currentValue  !== undefined && { currentValue:  String(input.currentValue)  }),
      updatedAt: new Date(),
    } as any)
    .where(and(eq(sealedProducts.id, id), eq(sealedProducts.userId, userId)))
    .returning();

  if (input.currentValue !== undefined && String(input.currentValue) !== existing.currentValue) {
    await db.insert(sealedPriceHistory).values({ sealedProductId: id, value: String(input.currentValue), source: "manual" });
  }

  return updated;
}

export async function softDeleteSealed(userId: number, id: number): Promise<boolean> {
  const [r] = await db
    .update(sealedProducts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(sealedProducts.id, id), eq(sealedProducts.userId, userId), isNull(sealedProducts.deletedAt)))
    .returning({ id: sealedProducts.id });
  return !!r;
}

export async function getSealedPriceHistory(userId: number, id: number) {
  const product = await getSealed(userId, id);
  if (!product) return null;
  return db.query.sealedPriceHistory.findMany({
    where:   eq(sealedPriceHistory.sealedProductId, id),
    orderBy: desc(sealedPriceHistory.recordedAt),
  });
}
