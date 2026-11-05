import {
  pgTable,
  pgView,
  serial,
  smallserial,
  smallint,
  text,
  varchar,
  char,
  integer,
  numeric,
  boolean,
  date,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────
// LEGACY PRISMA ENUMS
// ─────────────────────────────────────────────────────────────
// The pre-Drizzle Prisma tables (public."Card", public."User", ...) still
// live in this database and their columns depend on these types. Nothing in
// the Drizzle schema uses them -- they are declared only so drizzle-kit sees
// them as known and stops emitting DROP TYPE on every push. Delete these
// alongside the Prisma tables.
export const legacyCardStatus      = pgEnum("CardStatus",      ["COLLECTION","WISHLIST","FOR_SALE","SOLD","TRADED","DRAFT"]);
export const legacyCategory        = pgEnum("Category",        ["POKEMON","SOCCER","BASKETBALL","FOOTBALL","OTHER"]);
export const legacyCurrency        = pgEnum("Currency",        ["USD","EUR","GBP","DKK"]);
export const legacyPriceSource     = pgEnum("PriceSource",     ["MANUAL","PRICECHARTING","IMPORT"]);
export const legacyRole            = pgEnum("Role",            ["USER","ADMIN"]);
export const legacySealedStatus    = pgEnum("SealedStatus",    ["COLLECTION","FOR_SALE","SOLD"]);
export const legacyTransactionType = pgEnum("TransactionType", ["BUY","SELL","TRADE"]);

// ─────────────────────────────────────────────────────────────
// LOOKUP TABLES
// ─────────────────────────────────────────────────────────────

export const gradingCompanies = pgTable("grading_companies", {
  id:   smallserial("id").primaryKey(),
  name: varchar("name", { length: 64 }).notNull().unique(),
  abbr: varchar("abbr", { length: 8 }).notNull().unique(),
});

export const platforms = pgTable("platforms", {
  id:         smallserial("id").primaryKey(),
  name:       varchar("name", { length: 64 }).notNull().unique(),
  displayUrl: varchar("display_url", { length: 256 }),
});

// ─────────────────────────────────────────────────────────────
// CORE TABLES
// ─────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id:        serial("id").primaryKey(),
    clerkId:   varchar("clerk_id", { length: 256 }).notNull().unique(),
    email:     varchar("email", { length: 256 }).notNull().unique(),
    firstName: varchar("first_name", { length: 128 }),
    lastName:  varchar("last_name",  { length: 128 }),
    role:          varchar("role", { length: 16 }).notNull().default("user"),
    currency:      char("currency", { length: 3 }).notNull().default("USD"),
    username:      varchar("username", { length: 40 }).unique(),
    profilePublic: boolean("profile_public").notNull().default(false),
    showValues:    boolean("show_values").notNull().default(true),
    bio:           text("bio"),
    avatarUrl:     varchar("avatar_url", { length: 500 }),
    createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    clerkIdIdx: uniqueIndex("uq_users_clerk_id").on(t.clerkId),
    emailIdx:   uniqueIndex("uq_users_email").on(t.email),
  })
);

export const cards = pgTable(
  "cards",
  {
    id:     serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),

    // ── Card Identity ──────────────────────────────────────────
    name:         varchar("name",        { length: 256 }).notNull(),
    category:     varchar("category",    { length: 16  }).notNull().default("other"),
    player:       varchar("player",      { length: 256 }),
    team:         varchar("team",        { length: 256 }),
    year:         smallint("year"),
    setName:      varchar("set_name",    { length: 256 }),
    cardNumber:   varchar("card_number", { length: 64  }),
    parallel:     varchar("parallel",    { length: 128 }),
    serialNumber: varchar("serial_number", { length: 64 }),

    // ── Attributes ─────────────────────────────────────────────
    isRookie:        boolean("is_rookie").notNull().default(false),
    isAutographed:   boolean("is_autographed").notNull().default(false),
    isPatch:         boolean("is_patch").notNull().default(false),
    isGraded:        boolean("is_graded").notNull().default(false),
    gradeCompanyId:  smallint("grade_company_id").references(() => gradingCompanies.id),
    gradeValue:      numeric("grade_value", { precision: 4, scale: 1 }),
    certNumber:      varchar("cert_number", { length: 64 }),
    condition:       varchar("condition",   { length: 16 }),

    // ── Acquisition / Valuation ────────────────────────────────
    purchasePrice:     numeric("purchase_price",   { precision: 12, scale: 2 }),
    currentValue:      numeric("current_value",    { precision: 12, scale: 2 }),
    targetPrice:       numeric("target_price",     { precision: 12, scale: 2 }), // wishlist alert threshold
    purchaseDate:      date("purchase_date"),
    acquisitionMethod: varchar("acquisition_method", { length: 16 }),
    priceSource:       varchar("price_source", { length: 256 }),

    // ── Media ──────────────────────────────────────────────────
    imageUrl:     text("image_url"),
    imageBackUrl: text("image_back_url"),

    // ── Status / Meta ──────────────────────────────────────────
    notes:     text("notes"),
    isPublic:  boolean("is_public").notNull().default(false),
    status:    varchar("status", { length: 16 }).notNull().default("collection"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx:      index("idx_cards_user_id").on(t.userId),
    userStatusIdx:  index("idx_cards_user_status").on(t.userId, t.status),
    userCategoryIdx:index("idx_cards_user_category").on(t.userId, t.category),
    userCreatedIdx: index("idx_cards_user_created").on(t.userId, t.createdAt),
    certIdx:        index("idx_cards_cert").on(t.certNumber),
    gradedIdx:      index("idx_cards_graded").on(t.userId, t.gradeCompanyId, t.gradeValue),
  })
);

export const priceHistory = pgTable(
  "price_history",
  {
    id:         serial("id").primaryKey(),
    cardId:     integer("card_id").notNull().references(() => cards.id, { onDelete: "cascade" }),
    value:      numeric("value", { precision: 12, scale: 2 }).notNull(),
    source:     varchar("source", { length: 16 }).notNull().default("manual"),
    note:       varchar("note",   { length: 256 }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    cardDateIdx: index("idx_ph_card_date").on(t.cardId, t.recordedAt),
  })
);

export const transactions = pgTable(
  "transactions",
  {
    id:              serial("id").primaryKey(),
    userId:          integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    cardId:          integer("card_id").references(() => cards.id, { onDelete: "set null" }),
    type:            varchar("type", { length: 8 }).notNull(),
    price:           numeric("price", { precision: 12, scale: 2 }).notNull().default("0"),
    counterparty:    varchar("counterparty",   { length: 256 }),
    platformId:      smallint("platform_id").references(() => platforms.id),
    platformCustom:  varchar("platform_custom", { length: 128 }),
    tradedFor:       varchar("traded_for",     { length: 256 }),
    note:            text("note"),
    transactionDate: date("transaction_date").notNull(),
    createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userDateIdx:  index("idx_tx_user_date").on(t.userId, t.transactionDate),
    userTypeIdx:  index("idx_tx_user_type").on(t.userId, t.type),
    cardIdx:      index("idx_tx_card").on(t.cardId),
  })
);

export const sealedProducts = pgTable(
  "sealed_products",
  {
    id:            serial("id").primaryKey(),
    userId:        integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name:          varchar("name",         { length: 256 }).notNull(),
    category:      varchar("category",     { length: 16  }).notNull().default("other"),
    setName:       varchar("set_name",     { length: 256 }),
    productType:   varchar("product_type", { length: 128 }),
    language:      varchar("language",     { length: 64  }),
    year:          smallint("year"),
    quantity:      smallint("quantity").notNull().default(1),
    purchasePrice: numeric("purchase_price", { precision: 12, scale: 2 }),
    currentValue:  numeric("current_value",  { precision: 12, scale: 2 }),
    purchaseDate:  date("purchase_date"),
    imageUrl:      text("image_url"),
    notes:         text("notes"),
    status:        varchar("status", { length: 16 }).notNull().default("collection"),
    deletedAt:     timestamp("deleted_at", { withTimezone: true }),
    createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userStatusIdx: index("idx_sealed_user_status").on(t.userId, t.status),
  })
);

export const sealedPriceHistory = pgTable(
  "sealed_price_history",
  {
    id:              serial("id").primaryKey(),
    sealedProductId: integer("sealed_product_id").notNull().references(() => sealedProducts.id, { onDelete: "cascade" }),
    value:           numeric("value", { precision: 12, scale: 2 }).notNull(),
    source:          varchar("source", { length: 16 }).notNull().default("manual"),
    note:            varchar("note", { length: 256 }),
    recordedAt:      timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    productDateIdx: index("idx_sph_product_date").on(t.sealedProductId, t.recordedAt),
  })
);

export const psaCertCache = pgTable(
  "psa_cert_cache",
  {
    certNumber: varchar("cert_number", { length: 64 }).primaryKey(),
    resultJson: jsonb("result_json").notNull(),
    fetchedAt:  timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fetchedAtIdx: index("idx_psa_fetched").on(t.fetchedAt),
  })
);

export const cgcCertCache = pgTable(
  "cgc_cert_cache",
  {
    certNumber: varchar("cert_number", { length: 64 }).primaryKey(),
    resultJson: jsonb("result_json").notNull(),
    fetchedAt:  timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fetchedAtIdx: index("idx_cgc_fetched").on(t.fetchedAt),
  })
);

// ─────────────────────────────────────────────────────────────
// RELATIONS
// ─────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  cards:          many(cards),
  transactions:   many(transactions),
  sealedProducts: many(sealedProducts),
}));

export const cardsRelations = relations(cards, ({ one, many }) => ({
  user:          one(users,           { fields: [cards.userId],         references: [users.id] }),
  gradeCompany:  one(gradingCompanies,{ fields: [cards.gradeCompanyId], references: [gradingCompanies.id] }),
  priceHistory:  many(priceHistory),
  transactions:  many(transactions),
}));

export const priceHistoryRelations = relations(priceHistory, ({ one }) => ({
  card: one(cards, { fields: [priceHistory.cardId], references: [cards.id] }),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  user:     one(users,     { fields: [transactions.userId],    references: [users.id] }),
  card:     one(cards,     { fields: [transactions.cardId],    references: [cards.id] }),
  platform: one(platforms, { fields: [transactions.platformId], references: [platforms.id] }),
}));

export const sealedProductsRelations = relations(sealedProducts, ({ one, many }) => ({
  user:         one(users, { fields: [sealedProducts.userId], references: [users.id] }),
  priceHistory: many(sealedPriceHistory),
}));

export const sealedPriceHistoryRelations = relations(sealedPriceHistory, ({ one }) => ({
  sealedProduct: one(sealedProducts, {
    fields:     [sealedPriceHistory.sealedProductId],
    references: [sealedProducts.id],
  }),
}));

// ─────────────────────────────────────────────────────────────
// VIEWS  (for use with Drizzle .select() from view)
// ─────────────────────────────────────────────────────────────

export const vCardPl = pgView("v_card_pl").as((qb) =>
  qb
    .select({
      cardId:        cards.id,
      userId:        cards.userId,
      name:          cards.name,
      category:      cards.category,
      status:        cards.status,
      isRookie:      cards.isRookie,
      isAutographed: cards.isAutographed,
      isGraded:      cards.isGraded,
      gradeCompany:  gradingCompanies.abbr,
      gradeValue:    cards.gradeValue,
      purchasePrice: cards.purchasePrice,
      currentValue:  cards.currentValue,
      plAbs: sql<string>`ROUND(${cards.currentValue} - ${cards.purchasePrice}, 2)`.as("pl_abs"),
      plPct: sql<string>`
        CASE WHEN ${cards.purchasePrice} > 0
          THEN ROUND(((${cards.currentValue} - ${cards.purchasePrice}) / ${cards.purchasePrice}) * 100, 2)
          ELSE NULL
        END`.as("pl_pct"),
      createdAt: cards.createdAt,
    })
    .from(cards)
    .leftJoin(gradingCompanies, sql`${gradingCompanies.id} = ${cards.gradeCompanyId}`)
    .where(sql`${cards.deletedAt} IS NULL`)
);

export const vCollectionSummary = pgView("v_collection_summary").as((qb) =>
  qb
    .select({
      userId:           cards.userId,
      totalCards:       sql<number>`COUNT(*)`.as("total_cards"),
      collectionCount:  sql<number>`COUNT(*) FILTER (WHERE ${cards.status} = 'collection')`.as("collection_count"),
      wishlistCount:    sql<number>`COUNT(*) FILTER (WHERE ${cards.status} = 'wishlist')`.as("wishlist_count"),
      forSaleCount:     sql<number>`COUNT(*) FILTER (WHERE ${cards.status} = 'for_sale')`.as("for_sale_count"),
      gradedCount:      sql<number>`COUNT(*) FILTER (WHERE ${cards.isGraded} = TRUE)`.as("graded_count"),
      rookieCount:      sql<number>`COUNT(*) FILTER (WHERE ${cards.isRookie} = TRUE)`.as("rookie_count"),
      totalValue:       sql<string>`ROUND(SUM(${cards.currentValue}) FILTER (WHERE ${cards.status} = 'collection'), 2)`.as("total_value"),
      totalCost:        sql<string>`ROUND(SUM(${cards.purchasePrice}) FILTER (WHERE ${cards.status} = 'collection'), 2)`.as("total_cost"),
      totalPl:          sql<string>`ROUND(SUM(${cards.currentValue} - ${cards.purchasePrice}) FILTER (WHERE ${cards.status} = 'collection' AND ${cards.purchasePrice} IS NOT NULL AND ${cards.currentValue} IS NOT NULL), 2)`.as("total_pl"),
    })
    .from(cards)
    .where(sql`${cards.deletedAt} IS NULL`)
    .groupBy(cards.userId)
);

export const vTransactionSummary = pgView("v_transaction_summary").as((qb) =>
  qb
    .select({
      userId:            transactions.userId,
      totalTransactions: sql<number>`COUNT(*)`.as("total_transactions"),
      totalSpent:        sql<string>`ROUND(SUM(${transactions.price}) FILTER (WHERE ${transactions.type} = 'buy'), 2)`.as("total_spent"),
      totalEarned:       sql<string>`ROUND(SUM(${transactions.price}) FILTER (WHERE ${transactions.type} = 'sell'), 2)`.as("total_earned"),
      netPl:             sql<string>`ROUND(COALESCE(SUM(${transactions.price}) FILTER (WHERE ${transactions.type} = 'sell'), 0) - COALESCE(SUM(${transactions.price}) FILTER (WHERE ${transactions.type} = 'buy'), 0), 2)`.as("net_pl"),
    })
    .from(transactions)
    .groupBy(transactions.userId)
);

// ─────────────────────────────────────────────────────────────
// TYPE EXPORTS
// ─────────────────────────────────────────────────────────────

export type User              = typeof users.$inferSelect;
export type NewUser           = typeof users.$inferInsert;
export type Card              = typeof cards.$inferSelect;
export type NewCard           = typeof cards.$inferInsert;
export type PriceHistory      = typeof priceHistory.$inferSelect;
export type NewPriceHistory   = typeof priceHistory.$inferInsert;
export type Transaction       = typeof transactions.$inferSelect;
export type NewTransaction    = typeof transactions.$inferInsert;
export type SealedProduct     = typeof sealedProducts.$inferSelect;
export type NewSealedProduct  = typeof sealedProducts.$inferInsert;
export type GradingCompany    = typeof gradingCompanies.$inferSelect;
export type Platform          = typeof platforms.$inferSelect;
