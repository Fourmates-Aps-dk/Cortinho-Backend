// Splits messy card names (raw eBay/CSV titles) into name / year / set / card # / category.
// Only fills empty fields; the category changes only when it is "other".
// Dry run by default: npx tsx scripts/tidy-card-names.ts   Apply: npx tsx scripts/tidy-card-names.ts --apply
import "../src/config/env.js";
import { db } from "../db.js";
import { cards } from "../drizzle/schema.js";
import { eq, isNull } from "drizzle-orm";
import { parseTitle } from "../src/services/ebayService.js";

const apply = process.argv.includes("--apply");
const MESSY = /[#\p{Extended_Pictographic}]|\b(19|20)\d{2}\b|\b(PSA|BGS|CGC|SGC)\s*\d|\b[A-Z]{4,}\b.*\b[A-Z]{4,}\b/u;

const messy = (name: string) => MESSY.test(name) || name.length > 30;

async function main() {
for (const c of (await db.select().from(cards).where(isNull(cards.deletedAt))).filter((r) => messy(r.name) || r.category === "other")) {
  const p = await parseTitle([c.name, c.setName, c.year].filter(Boolean).join(" "));
  const patch: Partial<typeof cards.$inferInsert> = {};
  if (p.name && p.name !== c.name && messy(c.name)) patch.name = p.name;
  if (c.year == null && p.year) patch.year = p.year;
  if (!c.setName && p.setName) patch.setName = p.setName;
  if (!c.cardNumber && p.cardNumber) patch.cardNumber = p.cardNumber;
  if (!c.parallel && "parallel" in p && p.parallel) patch.parallel = p.parallel;
  if (c.category === "other" && p.category && p.category !== "other") patch.category = p.category;
  if (!Object.keys(patch).length) continue;
  console.log(`#${c.id} ${JSON.stringify(c.name)} →`, JSON.stringify(patch));
  if (apply) await db.update(cards).set({ ...patch, updatedAt: new Date() }).where(eq(cards.id, c.id));
}
console.log(apply ? "applied" : "dry run — pass --apply to save");
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
