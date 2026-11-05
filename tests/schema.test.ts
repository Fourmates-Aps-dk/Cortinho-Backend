import { test } from "node:test";
import assert from "node:assert/strict";
import { updateCardSchema } from "../src/services/cardService.js";
import { updateSealedSchema } from "../src/services/sealedService.js";

// Regression: Zod .partial() kept .default()s, so a PATCH with one field reset others (isPublic, status, category).
test("PATCH schemas don't inject defaults for omitted fields", () => {
  assert.deepEqual(updateCardSchema.parse({ currentValue: 12 }), { currentValue: 12 });
  assert.deepEqual(updateCardSchema.parse({}), {});
  assert.deepEqual(Object.keys(updateSealedSchema.parse({ notes: "x" })), ["notes"]);
});

test("sealed PATCH can clear numbers", () => {
  assert.deepEqual(updateSealedSchema.parse({ currentValue: null, year: null }), { currentValue: null, year: null });
});
