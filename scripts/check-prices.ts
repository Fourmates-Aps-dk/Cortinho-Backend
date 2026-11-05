// Run: npx tsx scripts/check-prices.ts
import assert from "node:assert/strict";
import { matchListings, median } from "../src/services/ebayService.js";

const l = (title: string, price: number) => ({ title, price, url: "" });
const listings = [
  l("1986 Fleer Michael Jordan #57 PSA 10", 200000),
  l("1986 Fleer Michael Jordan #57 PSA 9", 20000),
  l("1986 Fleer Michael Jordan 57 PSA 10 GEM MINT", 210000),
  l("1986 Fleer Michael Jordan 57 reprint PSA 10", 50),
  l("1986 Fleer Michael Jordan 57 poster", 49.99),
  l("1986 Fleer Michael Jordan 57 raw", 5000),
  l("GSA Pablo Escobar Michael Jordan PSA 10 1986-87 Fleer Jordan Rookie #57 Size L", 80),
  l("Michael Jordan - 2006-07 Fleer '86-87 20th Anniversary #57 PSA 10", 3999),
  l("Michael Jordan Fleer 1986 Rookie 57 PSA 5.5 1996 Decade of Excellence PSA10", 8500),
  l("1986 Fleer Michael Jordan 57 CGC 9 | Only 3 Higher | Looks PSA 10", 24500),
  l("2006 FLEER 86-87 MICHAEL JORDAN PSA 10", 50000),
];

assert.deepEqual(matchListings(listings, { company: "PSA", value: "10.0", year: "1986" }).map((x) => x.price), [200000, 210000]);
assert.deepEqual(matchListings(listings, { company: "PSA", value: "9" }).map((x) => x.price), [20000]);
assert.deepEqual(matchListings(listings).map((x) => x.price), [5000]);
assert.equal(matchListings(listings, { company: "BGS", value: "9.5" }).length, 0); // never mix grades
assert.equal(median([1, 3, 1_000_000]), 3);
assert.equal(median([1, 2, 3, 4]), 2.5);
console.log("prices ok");
