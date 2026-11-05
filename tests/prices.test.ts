import { test } from "node:test";
import assert from "node:assert/strict";
import { matchListings, median, parseTitleRegex, confidenceOf } from "../src/services/ebayService.js";

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

test("matchListings keeps only the exact grade and year", () => {
  assert.deepEqual(matchListings(listings, { company: "PSA", value: "10.0", year: "1986" }).map((x) => x.price), [200000, 210000]);
  assert.deepEqual(matchListings(listings, { company: "PSA", value: "9" }).map((x) => x.price), [20000]);
});

test("matchListings: raw drops slabs, unknown grade never mixes grades", () => {
  assert.deepEqual(matchListings(listings).map((x) => x.price), [5000]);
  assert.equal(matchListings(listings, { company: "BGS", value: "9.5" }).length, 0);
});

test("median ignores outliers", () => {
  assert.equal(median([1, 3, 1_000_000]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("confidenceOf grades sample size and spread", () => {
  assert.equal(confidenceOf([1, 2]), "low");
  assert.equal(confidenceOf([100, 105, 110, 98, 102, 101, 99, 104]), "high");
  assert.equal(confidenceOf([100, 120, 90]), "medium");
  assert.equal(confidenceOf([10, 500, 20, 900, 15]), "low");
});

test("parseTitleRegex splits listing titles", () => {
  const j = parseTitleRegex("1986 FLEER #57 MICHAEL JORDAN PSA 9");
  assert.deepEqual([j.name, j.year, j.setName, j.cardNumber, j.gradeCompany, j.gradeValue], ["Michael Jordan", 1986, "Fleer", "57", "PSA", 9]);
  const h = parseTitleRegex("Erling Haaland RARE TOPPS CHROME INVESTMENT CARD MVP MINT");
  assert.deepEqual([h.name, h.setName], ["Erling Haaland", "Topps Chrome"]);
  assert.equal(parseTitleRegex("Michael Jordan 🙂‍↕️").name, "Michael Jordan");
});
