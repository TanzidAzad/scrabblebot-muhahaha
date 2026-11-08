// Replay real matches from the live server against a strategy.
// For each real auction we know the highest bid anyone made. If our bid
// beats it we win the letter and pay that bid (Vickrey); otherwise we don't.
// Opponents don't react to us, so this is an approximation, but it uses
// real letters and real prices.
//
//   npm run replay                 # current strategy vs the old one
//   N=300 AGG=1.3 npm run replay   # try a setting

import * as fs from "node:fs";
import * as cur from "./strategy.js";
import * as v1 from "./strategy_v1.js";

const DICT = fs
  .readFileSync(new URL("../../spacetimedb/wordlist.txt", import.meta.url), "utf8")
  .split("\n").map((l) => l.trim().toUpperCase()).filter((l) => l.length >= 2)
  .sort((a, b) => b.length - a.length);
cur.warmUp(DICT);

interface Match { id: number; players: number; auctions: [string, number][]; scores: number[] }
const all: Match[] = JSON.parse(fs.readFileSync(new URL("../replay/matches.json", import.meta.url), "utf8"));
const N = Number(process.env.N ?? 250);
const OFF = Number(process.env.OFFSET ?? 0);
const matches = all.slice(OFF, OFF + N);

for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("T_") && v) (cur.TUNING as any)[k.slice(2)] = Number(v);
}

const BAG: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4, M: 2,
  N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1,
};

// Seeded random so every strategy sees the same starting racks.
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function startingRack(m: Match, rand: () => number) {
  const left = { ...BAG };
  for (const [L] of m.auctions) if (left[L] > 0) left[L]--;
  const pool: string[] = [];
  for (const [L, n] of Object.entries(left)) for (let i = 0; i < n; i++) pool.push(L);
  const rack = new Map<string, number>();
  for (let i = 0; i < 5 && pool.length; i++) {
    const L = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    rack.set(L, (rack.get(L) ?? 0) + 1);
  }
  return rack;
}

type Strat = { decideBid: typeof cur.decideBid; planWords: typeof cur.planWords };

function run(s: Strat, m: Match, seed: number) {
  const rand = rng(seed);
  let rack = startingRack(m, rand);
  let balance = 100, score = 0, won = 0, spent = 0;
  const play = () => {
    for (const w of s.planWords({ myRack: rack, dictionary: DICT, bagTotal: bag, myBalance: balance })) {
      const r = new Map(rack);
      let ok = true;
      for (const c of w) { const n = (r.get(c) ?? 0) - 1; if (n < 0) ok = false; r.set(c, n); }
      if (!ok) continue;
      rack = r;
      const pts = cur.wordReward(w);
      words.push(w);
      score += pts; balance += pts;
    }
  };
  const recent: number[] = [];
  const words: string[] = [];
  let bag = m.auctions.length - 1;
  for (let i = 0; i < m.auctions.length; i++) {
    const [L, top] = m.auctions[i];
    bag = m.auctions.length - 1 - i;
    play();
    const scale = recent.length >= 8 ? [...recent].sort((a, b) => a - b)[recent.length >> 1] : 1;
    const bid = s.decideBid({
      letter: L, myBalance: balance, myRack: rack, bagTotal: bag,
      players: m.players, dictionary: DICT, marketScale: scale,
    });
    const winIt = bid > top || (bid === top && bid > 0 && rand() < 0.5);
    const price = top > 0 ? top : Math.min(1, bid);
    if (winIt && balance >= price) {
      balance -= price; spent += price; won++;
      rack.set(L, (rack.get(L) ?? 0) + 1);
    }
    // what this letter sold for (as seen by everyone)
    if (top > 0 && cur.MARKET_PRICE[L]) { recent.push(top / cur.MARKET_PRICE[L]); if (recent.length > 40) recent.shift(); }
  }
  // The match ends when the last auction closes; no more plays.
  let tilesLeft = 0; for (const n of rack.values()) tilesLeft += n;
  if (process.env.DEBUG) console.log(m.id, score, words.join(' '), '| left tiles', [...rack].filter(([,n])=>n>0).map(([c,n])=>c.repeat(n)).join(''), '| coins', balance);
  return { score, won, spent, left: balance, tilesLeft };
}

function evaluate(name: string, s: Strat) {
  let score = 0, place = 0, first = 0, won = 0, left = 0;
  matches.forEach((m, i) => {
    const r = run(s, m, 1000 + i);
    score += r.score; won += r.won; left += r.left;
    const p = 1 + m.scores.filter((x) => x > r.score).length;
    place += p; if (p === 1) first++;
  });
  const n = matches.length;
  console.log(
    `${name.padEnd(8)} avg score ${(score / n).toFixed(1)}  avg place ${(place / n).toFixed(2)}  ` +
    `beats winner ${((100 * first) / n).toFixed(0)}%  tiles won ${(won / n).toFixed(1)}  money left ${(left / n).toFixed(0)}`,
  );
}

console.log(`Replaying ${matches.length} real matches (place is vs the real players' scores, out of 7)`);
if (!process.env.ONLY_CUR) evaluate("old", v1);
evaluate("current", cur);
