import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFifo } from "../src/services/transactionService.js";

const tx = (id: number, type: string, cardId: number | null, transactionDate: string) => ({ id, type, cardId, transactionDate });

test("each buy is matched once, oldest first, across years", () => {
  const m = matchFifo([
    tx(1, "buy", 7, "2024-01-10"), tx(2, "buy", 7, "2024-06-01"),
    tx(3, "sell", 7, "2024-12-01"), tx(4, "sell", 7, "2025-03-01"),
  ]);
  assert.deepEqual(m.map((x) => [x.sell.id, x.buy?.id]), [[3, 1], [4, 2]]);
});

test("a buy dated after the sale is not its cost basis", () => {
  const m = matchFifo([tx(1, "sell", 7, "2025-01-01"), tx(2, "buy", 7, "2025-02-01")]);
  assert.equal(m[0].buy, null);
});

test("sells only match buys of the same card", () => {
  const m = matchFifo([tx(1, "buy", 8, "2024-01-01"), tx(2, "sell", 7, "2024-02-01"), tx(3, "sell", null, "2024-02-01")]);
  assert.deepEqual(m.map((x) => x.buy), [null, null]);
});
