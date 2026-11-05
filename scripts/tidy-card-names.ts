// Tidies messy card names for every user (see src/services/tidyService.ts).
// Dry run: npx tsx scripts/tidy-card-names.ts   Apply: npx tsx scripts/tidy-card-names.ts --apply
import "../src/config/env.js";
import { tidyCards } from "../src/services/tidyService.js";

const apply = process.argv.includes("--apply");
tidyCards({ apply }).then((changes) => {
  for (const c of changes) console.log(`#${c.id} ${JSON.stringify(c.name)} →`, JSON.stringify(c.patch));
  console.log(apply ? `applied ${changes.length}` : "dry run — pass --apply to save");
  process.exit(0);
}, (err) => { console.error(err); process.exit(1); });
