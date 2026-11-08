// Offline match simulator: your strategy vs the server's house bots.
// Mirrors the server rules (Vickrey, 100 starting balance, 5-tile racks,
// 98-tile bag, match ends when the bag empties at an auction's close).
//
//   npm run sim            # 300 matches
//   MATCHES=1000 npm run sim

import * as fs from "node:fs";
import { decideBid, planWords, wordReward, LETTER_VALUE, MARKET_PRICE } from "./strategy.js";
import * as v1 from "./strategy_v1.js";
import { TUNING } from "./strategy.js";
if (process.env.AGG) TUNING.aggression = Number(process.env.AGG);
if (process.env.SHARE) TUNING.shareTarget = Number(process.env.SHARE);

const DICT = fs
  .readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8")
  .split("\n")
  .map((l) => l.trim().toUpperCase())
  .filter((l) => l.length >= 2)
  .sort((a, b) => b.length - a.length);

const RIVAL_BOOST = Number(process.env.RIVAL_BOOST ?? 1);
const BAG: [string, number][] = [
  ["A", 9], ["B", 2], ["C", 2], ["D", 4], ["E", 12], ["F", 2], ["G", 3],
  ["H", 2], ["I", 9], ["J", 1], ["K", 1], ["L", 4], ["M", 2], ["N", 6],
  ["O", 8], ["P", 2], ["Q", 1], ["R", 6], ["S", 4], ["T", 6], ["U", 4],
  ["V", 2], ["W", 2], ["X", 1], ["Y", 2], ["Z", 1],
];

type Kind = "me" | "v1" | "starter" | "market" | "Cheapskate" | "ValueBidder" | "Aggressive";
interface P { kind: Kind; balance: number; score: number; rack: Map<string, number> }

const rnd = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

function canSpell(w: string, r: Map<string, number>) {
  const u: Record<string, number> = {};
  for (const c of w) { u[c] = (u[c] ?? 0) + 1; if (u[c] > (r.get(c) ?? 0)) return false; }
  return true;
}
function longest(r: Map<string, number>, minLen: number) {
  let t = 0; for (const n of r.values()) t += n;
  for (const w of DICT) { if (w.length < minLen) break; if (w.length <= t && canSpell(w, r)) return w; }
  return null;
}
function play(p: P, w: string) {
  for (const c of w) p.rack.set(c, p.rack.get(c)! - 1);
  const r = wordReward(w); p.balance += r; p.score += r;
}

function houseBid(kind: Kind, letter: string, bal: number) {
  const v = LETTER_VALUE[letter], vowel = "AEIOU".includes(letter);
  const base = kind === "Cheapskate" ? v - 1 : kind === "ValueBidder" ? v : v + (vowel ? 4 : 2);
  return Math.max(Math.min(Math.max(base + rnd(-2, 2), 1), bal), 0);
}
function starterBid(letter: string, p: P) {
  const v = LETTER_VALUE[letter], have = p.rack.get(letter) ?? 0;
  return Math.min(have === 0 ? v + 2 : Math.max(1, v), Math.max(0, p.balance));
}

function runMatch(kinds: Kind[]): P[] {
  const bag = new Map(BAG);
  let total = 98;
  const draw = () => {
    let i = rnd(0, total - 1);
    for (const [c, n] of [...bag].sort()) {
      if (i < n) { bag.set(c, n - 1); total--; return c; }
      i -= n;
    }
    return undefined;
  };
  const ps: P[] = kinds.map((kind) => ({ kind, balance: 100, score: 0, rack: new Map() }));
  for (const p of ps) for (let k = 0; k < 5; k++) { const c = draw()!; p.rack.set(c, (p.rack.get(c) ?? 0) + 1); }

  let letter = draw();
  let guard = 0;
  while (letter !== undefined && guard++ < 2000) {
    // Our bot gets a chance to play words before each auction (it reacts to every round).
    for (const p of ps) {
      const plan = p.kind === "me" ? planWords : p.kind === "v1" ? v1.planWords : null;
      if (plan) for (const w of plan({ myRack: p.rack, dictionary: DICT, bagTotal: total, myBalance: p.balance })) play(p, w);
      if (p.kind === "market") {
        // Realistic rival: cashes in 6+ letter words, refills when broke, flushes at the end.
        for (;;) {
          const w = total <= 2 ? longest(p.rack, 2) : longest(p.rack, p.balance < 12 ? 3 : 6);
          if (!w) break;
          play(p, w);
        }
      }
    }

    const bids = ps.map((p) =>
      p.kind === "me" ? decideBid({ letter: letter!, myBalance: p.balance, myRack: p.rack, bagTotal: total, players: ps.length, dictionary: DICT })
      : p.kind === "v1" ? v1.decideBid({ letter: letter!, myBalance: p.balance, myRack: p.rack, bagTotal: total, players: ps.length, dictionary: DICT })
      : p.kind === "market" ? Math.min(p.balance, Math.round(MARKET_PRICE[letter!] * RIVAL_BOOST * (0.75 + Math.random() * 0.6)))
      : p.kind === "starter" ? starterBid(letter!, p)
      : houseBid(p.kind, letter!, p.balance));
    const order = ps.map((_, i) => i).filter((i) => bids[i] > 0).sort(() => Math.random() - 0.5).sort((a, b) => bids[b] - bids[a]);
    if (order.length) {
      const w = ps[order[0]];
      const paid = order.length > 1 ? bids[order[1]] : Math.min(1, bids[order[0]]);
      if (w.balance >= paid) {
        w.balance -= paid;
        w.rack.set(letter, (w.rack.get(letter) ?? 0) + 1);
        if (w.kind === "starter") { const x = longest(w.rack, 2); if (x) play(w, x); }
        else if (w.kind !== "me" && w.kind !== "v1" && w.kind !== "market") { const x = longest(w.rack, 3); if (x) play(w, x); }
      }
    } else {
      bag.set(letter, (bag.get(letter) ?? 0) + 1); total++; // no bids: back in the bag
    }
    letter = draw();
    // When the bag is empty the match ends right here; nobody plays again.
  }
  return ps;
}

const MATCHES = Number(process.env.MATCHES ?? 150);
const LOBBIES: [string, Kind[]][] = [
  ["5 real-price rivals", ["market", "market", "market", "market", "market"]],
  ["3 rivals + 2 house bots", ["market", "market", "market", "Aggressive", "Cheapskate"]],
];

for (const [label, rivals] of LOBBIES) {
  console.log(`\n${label}:`);
  for (const hero of ["me", "v1", "starter"] as Kind[]) {
    let score = 0, wins = 0, rankSum = 0;
    for (let m = 0; m < MATCHES; m++) {
      const ps = runMatch([hero, ...rivals]);
      const mine = ps[0].score;
      score += mine;
      const rank = 1 + ps.filter((p) => p.score > mine).length;
      rankSum += rank;
      if (rank === 1) wins++;
    }
    const name = { me: "new version   ", v1: "old version   ", starter: "starter       " }[hero as string];
    console.log(`  ${name}: avg score ${(score / MATCHES).toFixed(1)}, avg place ${(rankSum / MATCHES).toFixed(2)} of 6, 1st in ${((100 * wins) / MATCHES).toFixed(0)}%`);
  }
}
