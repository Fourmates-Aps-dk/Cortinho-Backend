import { db } from "../../db.js";
import { transactions, platforms } from "../../drizzle/schema.js";
import { eq, and, gte, lte, desc, count, SQL, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { patchSchema } from "../utils/schema.js";

export const createTransactionSchema = z.object({
  cardId:          z.number().int().positive().optional(),
  type:            z.enum(["buy", "sell", "trade", "pull", "gift"]),
  price:           z.number().min(0).default(0),
  counterparty:    z.string().max(256).optional(),
  platformId:      z.number().int().optional(),
  platformCustom:  z.string().max(128).optional(),
  tradedFor:       z.string().max(256).optional(),
  note:            z.string().optional(),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
});

export const updateTransactionSchema = patchSchema(createTransactionSchema);

export const listTransactionsSchema = z.object({
  page:            z.coerce.number().int().positive().default(1),
  pageSize:        z.coerce.number().int().min(1).max(100).default(20),
  type:            z.enum(["buy", "sell", "trade", "pull", "gift", "all"]).default("all"),
  platformId:      z.coerce.number().int().optional(),
  startDate:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cardId:          z.coerce.number().int().optional(),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type ListTransactionsInput  = z.infer<typeof listTransactionsSchema>;

export async function listTransactions(userId: number, input: ListTransactionsInput) {
  const conditions: SQL[] = [eq(transactions.userId, userId)];

  if (input.type !== "all")  conditions.push(eq(transactions.type, input.type));
  if (input.platformId)      conditions.push(eq(transactions.platformId, input.platformId));
  if (input.cardId)          conditions.push(eq(transactions.cardId, input.cardId));
  if (input.startDate)       conditions.push(gte(transactions.transactionDate, input.startDate));
  if (input.endDate)         conditions.push(lte(transactions.transactionDate, input.endDate));

  const where  = and(...conditions);
  const offset = (input.page - 1) * input.pageSize;

  const [rows, [{ total }]] = await Promise.all([
    db.query.transactions.findMany({
      where,
      limit:   input.pageSize,
      offset,
      orderBy: desc(transactions.transactionDate),
      with:    { card: { columns: { id: true, name: true, setName: true, imageUrl: true } } },
    }),
    db.select({ total: count() }).from(transactions).where(where),
  ]);

  const n = Number(total);
  return { items: rows, total: n, page: input.page, pageSize: input.pageSize, totalPages: Math.ceil(n / input.pageSize) };
}

export async function getTransaction(userId: number, txId: number) {
  return db.query.transactions.findFirst({
    where: and(eq(transactions.id, txId), eq(transactions.userId, userId)),
    with:  { card: { columns: { id: true, name: true, setName: true, imageUrl: true } } },
  });
}

export async function createTransaction(userId: number, input: CreateTransactionInput) {
  const [tx] = await db
    .insert(transactions)
    .values({ ...input, userId, price: String(input.price) } as any)
    .returning();
  return tx;
}

export async function updateTransaction(userId: number, txId: number, input: Partial<CreateTransactionInput>) {
  const [tx] = await db
    .update(transactions)
    .set({ ...input, ...(input.price !== undefined && { price: String(input.price) }), updatedAt: new Date() } as any)
    .where(and(eq(transactions.id, txId), eq(transactions.userId, userId)))
    .returning();
  return tx ?? null;
}

export async function deleteTransaction(userId: number, txId: number): Promise<boolean> {
  const [r] = await db
    .delete(transactions)
    .where(and(eq(transactions.id, txId), eq(transactions.userId, userId)))
    .returning({ id: transactions.id });
  return !!r;
}

export interface ExportRow {
  cardName:    string;
  set:         string;
  sellDate:    string;
  sellPrice:   number;
  buyDate:     string;
  buyPrice:    number;
  daysHeld:    number | null;
  gainLoss:    number;
}

export async function exportTransactionsCsv(userId: number, year: number): Promise<string> {
  const start = `${year}-01-01`;
  const end   = `${year}-12-31`;

  // Fetch all sell transactions in the year + all buy transactions (any year, for matching)
  const allTx = await db.query.transactions.findMany({
    where: eq(transactions.userId, userId),
    orderBy: [desc(transactions.transactionDate)],
    with: { card: { columns: { id: true, name: true, setName: true } } },
  });

  const sells = allTx
    .filter((t) => t.type === "sell" && t.transactionDate >= start && t.transactionDate <= end)
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));

  const buys = allTx
    .filter((t) => t.type === "buy")
    .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));

  // FIFO matching: for each sell, consume earliest unmatched buy for same cardId
  const usedBuyIds = new Set<number>();
  const rows: ExportRow[] = [];

  for (const sell of sells) {
    const matchedBuy = sell.cardId
      ? buys.find((b) => b.cardId === sell.cardId && !usedBuyIds.has(b.id))
      : null;

    if (matchedBuy) usedBuyIds.add(matchedBuy.id);

    const sellPrice = Number(sell.price);
    const buyPrice  = matchedBuy ? Number(matchedBuy.price) : 0;
    const daysHeld  = matchedBuy
      ? Math.round((new Date(sell.transactionDate).getTime() - new Date(matchedBuy.transactionDate).getTime()) / 86_400_000)
      : null;

    rows.push({
      cardName:  sell.card?.name ?? sell.platformCustom ?? "Unknown",
      set:       sell.card?.setName ?? "",
      sellDate:  sell.transactionDate,
      sellPrice,
      buyDate:   matchedBuy?.transactionDate ?? "",
      buyPrice,
      daysHeld,
      gainLoss:  +(sellPrice - buyPrice).toFixed(2),
    });
  }

  // CSV lines
  // Prefix dangerous leading chars to prevent CSV formula injection (Excel/Sheets)
  const esc = (v: string | number) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };

  const header = ["Card", "Set", "Date Sold", "Sale Price ($)", "Date Bought", "Cost Basis ($)", "Days Held", "Gain / Loss ($)"].join(",");

  const dataRows = rows.map((r) =>
    [
      esc(r.cardName),
      esc(r.set),
      esc(r.sellDate),
      r.sellPrice.toFixed(2),
      esc(r.buyDate || "N/A"),
      r.buyPrice > 0 ? r.buyPrice.toFixed(2) : "N/A",
      r.daysHeld !== null ? r.daysHeld : "N/A",
      (r.gainLoss >= 0 ? "+" : "") + r.gainLoss.toFixed(2),
    ].join(",")
  );

  const totalEarned    = rows.reduce((s, r) => s + r.sellPrice, 0);
  const totalCost      = rows.reduce((s, r) => s + r.buyPrice,  0);
  const totalGain      = rows.reduce((s, r) => s + r.gainLoss,  0);

  const summary = [
    "",
    `"Tax Year",${year}`,
    `"Generated",${new Date().toISOString().slice(0, 10)}`,
    "",
    `"Total Sales",${totalEarned.toFixed(2)}`,
    `"Total Cost Basis",${totalCost.toFixed(2)}`,
    `"Net Capital Gain / Loss",${(totalGain >= 0 ? "+" : "") + totalGain.toFixed(2)}`,
    `"Transactions Included",${rows.length}`,
  ];

  return [header, ...dataRows, ...summary].join("\r\n");
}

export async function getTransactionSummary(userId: number) {
  const all = await db.query.transactions.findMany({ where: eq(transactions.userId, userId) });

  const totalSpent  = all.filter((t) => t.type === "buy").reduce((s, t)  => s + Number(t.price), 0);
  const totalEarned = all.filter((t) => t.type === "sell").reduce((s, t) => s + Number(t.price), 0);

  return {
    total:        all.length,
    totalSpent:   +totalSpent.toFixed(2),
    totalEarned:  +totalEarned.toFixed(2),
    netPl:        +(totalEarned - totalSpent).toFixed(2),
    byType: {
      buy:   all.filter((t) => t.type === "buy").length,
      sell:  all.filter((t) => t.type === "sell").length,
      trade: all.filter((t) => t.type === "trade").length,
      pull:  all.filter((t) => t.type === "pull").length,
      gift:  all.filter((t) => t.type === "gift").length,
    },
  };
}
