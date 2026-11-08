// Checks for the default strategy. Run with `npm test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { chooseWord, warmUp } from "./strategy.js";

const rack = (letters: string) => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

test("chooseWord picks the longest word the rack can spell", () => {
  const dictionary = ["TACT", "CAT", "AT"];
  assert.equal(chooseWord({ myRack: rack("TACT"), dictionary }), "TACT");
  assert.equal(chooseWord({ myRack: rack("CATX"), dictionary }), "CAT");
  assert.equal(chooseWord({ myRack: rack("CX"), dictionary }), null);
});

// The bot can't see a match move on while it searches, so a slow search
// means bids on closed auctions and words from letters it already spent.
test("chooseWord searches the whole wordlist well within an auction", () => {
  const dictionary = fs
    .readFileSync(
      new URL("../../spacetimedb/wordlist.txt", import.meta.url),
      "utf8",
    )
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2)
    .sort((a, b) => b.length - a.length);
  // The largest rack an admin can set, with almost nothing to spell.
  const myRack = rack("BCDFGHJKLMNPQRSTVWXZ");
  warmUp(dictionary); // the bot does this once at startup
  const start = performance.now();
  chooseWord({ myRack, dictionary });
  assert.ok(performance.now() - start < 100, "a search took 100 ms or more");
});

import { decideBid, planWords, wordReward } from "./strategy.js";

test("wordReward matches the server's length bonus", () => {
  assert.equal(wordReward("CAT"), 5);      // 5 x 1
  assert.equal(wordReward("TACT"), 9);     // 6 x 1.5
  assert.equal(wordReward("QUIET"), 28);   // 14 x 2
});

test("never bids on the last letter (it can't be played)", () => {
  assert.equal(decideBid({ letter: "E", myBalance: 50, myRack: rack("RST"), bagTotal: 0 }), 0);
});

test("never bids more than the balance", () => {
  assert.ok(decideBid({ letter: "Z", myBalance: 3, myRack: rack("AE"), bagTotal: 40 }) <= 3);
});

test("mid-match it holds short words; at the end it plays everything", () => {
  const dictionary = ["CAT", "DOG", "AT"];
  assert.deepEqual(planWords({ myRack: rack("CATDOG"), dictionary, bagTotal: 40, myBalance: 50 }), []);
  assert.deepEqual(planWords({ myRack: rack("CATDOG"), dictionary, bagTotal: 1, myBalance: 50 }).sort(), ["CAT", "DOG"]);
});
