import type { Config } from "drizzle-kit";
import dotenv from "dotenv";

dotenv.config();

// drizzle-kit runs many introspection queries concurrently. Supabase's
// transaction pooler (port 6543) crosses responses under that load, so
// migrations use the session pooler (DIRECT_URL, port 5432) instead.
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL!;

// The database still carries the pre-Drizzle Prisma tables (PascalCase:
// Card, User, ...). Without this filter drizzle-kit sees them as unknown
// tables and prompts whether e.g. "cards" is a rename of "Card" — answering
// wrong would rename the Prisma tables out from under their data. Scoping
// introspection to the tables this schema owns removes the ambiguity.
const OWNED_TABLES = [
  "users",
  "grading_companies",
  "platforms",
  "cards",
  "price_history",
  "transactions",
  "sealed_products",
  "sealed_price_history",
  "psa_cert_cache",
];

export default {
  schema: "./drizzle/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  tablesFilter: OWNED_TABLES,
  dbCredentials: {
    url,
  },
} satisfies Config;
