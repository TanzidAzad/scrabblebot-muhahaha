// Bidding and word-forming strategy.
//
// The ideas, in plain words:
//  - Only word points count toward rank. Money left at the end and tiles
//    left in the rack are both worth nothing, so the bot spends its money
//    and plays its tiles before the bag runs out.
//  - Long words pay up to 3x, so mid-match the bot saves its letters for
//    7+ letter words instead of cashing in every 3-letter word.
//  - Auctions are Vickrey (you pay the runner-up's bid), so the bot bids
//    what a letter is honestly worth to it right now.
//  - The final auction's letter can never be played (the match ends the
//    moment it closes), so the bot bids 0 on it.

export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

const VOWELS = new Set(["A", "E", "I", "O", "U"]);

// How easy a letter is to fit into a long word (1 = easy).
const PLAYABILITY: Record<string, number> = {
  Q: 0.45, Z: 0.6, J: 0.55, X: 0.7, K: 0.8, V: 0.75, W: 0.85, Y: 0.9,
};

// ---- Tuning knobs ----
export const TUNING = {
  longWord: 7,        // mid-match: play once a word this long is possible
  bigRack: 11,        // ...or once the rack holds this many tiles
  lowBalance: 14,     // ...or when money runs low (about one letter's price) and we need to refill
  bigWordReward: 30,  // ...or when any word of 5+ letters pays at least this
  lateBag: 4,         // late game: play anything of 5+ letters
  flushBag: 2,        // last few tiles: play everything we can
  aggression: 1.5,
  usePlayability: 0,   // 1 = discount hard letters like Q/Z/J
  faceBonus: 0,        // extra bid share for high-value letters (0..1)
  potentialWeight: 2.0, // how much long-word planning counts in a bid
  marketWeight: 0.8,    // how much the typical-price estimate counts
  chancePerLetter: 0.45, // chance of getting each still-missing letter   // bid this much above the typical price for an average-fit letter
  shareTarget: 1.4,   // aim to win this many times our fair share of tiles
  players: 6,
};

/** Reward for playing `word`, exactly as the server computes it. */
export function wordReward(word: string): number {
  let base = 0;
  for (const c of word) base += LETTER_VALUE[c] ?? 0;
  const n = word.length;
  if (n <= 3) return base;
  if (n === 4) return Math.floor((base * 3) / 2);
  if (n === 5) return base * 2;
  if (n === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

// ---- Fast word index (built once per dictionary) ----

interface WordIndex {
  words: string[];      // sorted by reward, best first
  rewards: Int32Array;
  counts: Uint8Array;   // 26 letter counts per word, flattened
}
const indexCache = new WeakMap<string[], WordIndex>();

function getIndex(dictionary: string[]): WordIndex {
  let idx = indexCache.get(dictionary);
  if (idx) return idx;
  const words = dictionary
    .filter((w) => /^[A-Z]{2,}$/.test(w))
    .map((w) => ({ w, r: wordReward(w) }))
    .sort((a, b) => b.r - a.r || b.w.length - a.w.length)
    .map((x) => x.w);
  const rewards = new Int32Array(words.length);
  const counts = new Uint8Array(words.length * 26);
  words.forEach((w, i) => {
    rewards[i] = wordReward(w);
    for (const c of w) counts[i * 26 + c.charCodeAt(0) - 65]++;
  });
  idx = { words, rewards, counts };
  indexCache.set(dictionary, idx);
  return idx;
}

function rackArray(rack: Map<string, number>): [Uint8Array, number] {
  const a = new Uint8Array(26);
  let total = 0;
  for (const [c, n] of rack) {
    const i = c.charCodeAt(0) - 65;
    if (i >= 0 && i < 26 && n > 0) {
      a[i] += n;
      total += n;
    }
  }
  return [a, total];
}

/** Highest-reward word the rack can spell (optionally of at least `minLen` letters). */
export function bestWord(
  rack: Map<string, number>,
  dictionary: string[],
  minLen = 2,
): { word: string; reward: number } | null {
  const { words, rewards, counts } = getIndex(dictionary);
  const [r, total] = rackArray(rack);
  outer: for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.length > total || w.length < minLen) continue;
    const off = i * 26;
    for (let k = 0; k < 26; k++) if (counts[off + k] > r[k]) continue outer;
    return { word: w, reward: rewards[i] };
  }
  return null;
}

// ---- Long-word planning ----
// "Potential" of a rack = the best (reward x chance) over 7-8 letter words,
// where the chance shrinks with every letter we'd still need to buy.

interface LongIndex { rewards: Float64Array; counts: Uint8Array; lens: Uint8Array; n: number }
const longCache = new WeakMap<string[], LongIndex>();

function getLongIndex(dictionary: string[]): LongIndex {
  let li = longCache.get(dictionary);
  if (li) return li;
  const words = dictionary.filter((w) => w.length >= 7 && w.length <= 8 && /^[A-Z]+$/.test(w));
  const n = words.length;
  li = { rewards: new Float64Array(n), counts: new Uint8Array(n * 26), lens: new Uint8Array(n), n };
  words.forEach((w, i) => {
    li!.rewards[i] = wordReward(w);
    li!.lens[i] = w.length;
    for (const c of w) li!.counts[i * 26 + c.charCodeAt(0) - 65]++;
  });
  longCache.set(dictionary, li);
  return li;
}

/** [potential without the letter, potential with it]. */
export function potentialPair(
  rack: Map<string, number>,
  letter: string,
  dictionary: string[],
  maxMissing: number,
): [number, number] {
  const li = getLongIndex(dictionary);
  const [r] = rackArray(rack);
  const L = letter.charCodeAt(0) - 65;
  const q = TUNING.chancePerLetter;
  const pw = [1, q, q * q, q ** 3, q ** 4, q ** 5, q ** 6, q ** 7, q ** 8];
  let best = 0, bestWith = 0;
  const { rewards, counts, n } = li;
  for (let i = 0; i < n; i++) {
    const off = i * 26;
    let miss = 0;
    for (let k = 0; k < 26; k++) {
      const d = counts[off + k] - r[k];
      if (d > 0) { miss += d; if (miss > maxMissing + 1) break; }
    }
    if (miss > maxMissing + 1) continue;
    const helps = counts[off + L] > r[L] ? 1 : 0;
    if (miss <= maxMissing) {
      const v = rewards[i] * pw[miss];
      if (v > best) best = v;
    }
    const m2 = miss - helps;
    if (m2 <= maxMissing) {
      const v2 = rewards[i] * pw[m2];
      if (v2 > bestWith) bestWith = v2;
    }
  }
  return [best, Math.max(best, bestWith)];
}

function withLetter(rack: Map<string, number>, letter: string) {
  const r = new Map(rack);
  r.set(letter, (r.get(letter) ?? 0) + 1);
  return r;
}

function withoutWord(rack: Map<string, number>, word: string) {
  const r = new Map(rack);
  for (const c of word) r.set(c, (r.get(c) ?? 0) - 1);
  return r;
}

// ---- Bidding ----

// What letters typically sell for on the live server (median price paid,
// from ~40,000 recent auctions). The bot rescales this live with
// `marketScale` from what letters actually sell for in its own matches.
export const MARKET_PRICE: Record<string, number> = {
  A: 10, B: 16, C: 17, D: 13, E: 11, F: 19, G: 12, H: 20, I: 10, J: 29,
  K: 23, L: 10, M: 17, N: 10, O: 10, P: 16, Q: 27, R: 10, S: 12, T: 10,
  U: 10, V: 17, W: 18, X: 30, Y: 21, Z: 37,
};

export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  bagTotal?: number;      // tiles still in the bag (0 = this is the last auction)
  players?: number;       // bots in the match
  dictionary?: string[];
  marketScale?: number;   // recent prices paid / MARKET_PRICE (1 = typical)
}

/** How much this letter helps the rack we have (1 = average). */
function letterFit(letter: string, myRack: Map<string, number>): number {
  let tiles = 0, vowels = 0;
  for (const [c, n] of myRack) {
    tiles += n;
    if (VOWELS.has(c)) vowels += n;
  }
  const vowelShare = tiles ? vowels / tiles : 0.4;
  let fit = TUNING.usePlayability ? PLAYABILITY[letter] ?? 1 : 1;
  fit *= 1 + TUNING.faceBonus * ((LETTER_VALUE[letter] ?? 1) - 1) / 9;
  if (VOWELS.has(letter)) {
    if (vowelShare < 0.3) fit *= 1.35;
    else if (vowelShare > 0.5) fit *= 0.55;
  } else if (vowelShare > 0.55) {
    fit *= 1.25;
  }
  if ("ERSTLNAI".includes(letter)) fit *= 1.1; // the letters long words are made of
  const have = myRack.get(letter) ?? 0;
  if (have >= 2) fit *= 0.5;
  else if (have === 1 && !"ESTRNLAEIO".includes(letter)) fit *= 0.65;
  if (letter === "Q" && !myRack.get("U")) fit *= 0.6;
  if (tiles >= 13) fit *= 0.7; // rack already huge
  return fit;
}

export function decideBid(ctx: BidContext): number {
  const { letter, myRack } = ctx;
  const balance = Math.max(0, Math.floor(ctx.myBalance));
  if (balance <= 0) return 0;

  const bag = ctx.bagTotal;
  // Last auction: the match ends as it closes, so the tile can't be played.
  if (bag === 0) return 0;

  const players = Math.max(1, ctx.players ?? TUNING.players);
  const scale = Math.min(2, Math.max(0.3, ctx.marketScale ?? 1));
  const market = (MARKET_PRICE[letter] ?? 12) * scale;

  // What adding this letter would do to our best playable word right now.
  let marginal = 0;
  if (ctx.dictionary && ctx.dictionary.length) {
    const before = bestWord(myRack, ctx.dictionary)?.reward ?? 0;
    const after = bestWord(withLetter(myRack, letter), ctx.dictionary)?.reward ?? 0;
    marginal = Math.max(0, after - before);
  }

  // Very end: only worth what it adds to a word we can play right away.
  if (bag !== undefined && bag <= 1) return clampBid(marginal, balance);

  // Spending pace. Money left at the end is worthless, so aim to spend it
  // all. Compare our money with what our share of the remaining tiles costs.
  const auctionsLeft = (bag ?? 60) + 1;
  const myShare = Math.max(1, (auctionsLeft / players) * TUNING.shareTarget);
  const avgPrice = 13 * scale;
  const pace = Math.min(1.8, Math.max(0.55, balance / (myShare * avgPrice)));

  // Late game: a new tile has few chances to be used, so lean on what it
  // adds right now, but still spend money that would otherwise be wasted.
  if (bag !== undefined && bag <= TUNING.lateBag) {
    const lateWorth = market * letterFit(letter, myRack) * pace * (bag / TUNING.lateBag);
    return clampBid(Math.max(marginal, lateWorth), balance);
  }

  let worth = market * letterFit(letter, myRack) * pace * TUNING.aggression;
  if (TUNING.potentialWeight > 0 && ctx.dictionary && ctx.dictionary.length) {
    // How many more letters we can expect to win before the end.
    const canStillWin = Math.max(1, Math.min(6, Math.floor(((bag ?? 60) / players) * TUNING.shareTarget)));
    const [p0, p1] = potentialPair(myRack, letter, ctx.dictionary, canStillWin);
    const planWorth = (p1 - p0) * TUNING.potentialWeight * pace;
    worth = worth * TUNING.marketWeight + planWorth;
  }
  return clampBid(Math.max(worth, marginal * 0.9), balance);
}

function clampBid(v: number, balance: number) {
  return Math.max(0, Math.min(balance, Math.round(v)));
}

// ---- Word play ----

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[];
  bagTotal?: number;
  myBalance?: number;
}

/**
 * The words to play right now, in order (each uses tiles left over by the
 * previous one). Empty = hold the tiles for a longer word.
 */
export function planWords(ctx: WordContext): string[] {
  const bag = ctx.bagTotal;
  const plan: string[] = [];
  let rack = ctx.myRack;

  // Without match info, behave simply: play the best word now.
  if (bag === undefined) {
    const b = bestWord(rack, ctx.dictionary);
    return b ? [b.word] : [];
  }

  // Very end: play everything we can, best first.
  if (bag <= TUNING.flushBag) {
    for (;;) {
      const b = bestWord(rack, ctx.dictionary);
      if (!b) return plan;
      plan.push(b.word);
      rack = withoutWord(rack, b.word);
    }
  }

  let tiles = 0;
  for (const n of rack.values()) tiles += n;

  // Late game: cash in good words, keep short ones for the flush.
  if (bag <= TUNING.lateBag) {
    for (;;) {
      const b = bestWord(rack, ctx.dictionary, 5);
      if (!b) return plan;
      plan.push(b.word);
      rack = withoutWord(rack, b.word);
    }
  }

  // Mid-match: hold for long words.
  const long = bestWord(rack, ctx.dictionary, TUNING.longWord);
  if (long) return [long.word];
  const broke = (ctx.myBalance ?? Infinity) < TUNING.lowBalance;
  const five = bestWord(rack, ctx.dictionary, 5);
  if (five && (tiles >= TUNING.bigRack || broke || five.reward >= TUNING.bigWordReward)) {
    return [five.word];
  }
  if (broke) {
    const b = bestWord(rack, ctx.dictionary, 4) ?? (tiles >= 8 ? bestWord(rack, ctx.dictionary, 2) : null);
    if (b) return [b.word];
  }
  return plan;
}

/** First word of the plan, or null. */
export function chooseWord(ctx: WordContext): string | null {
  return planWords(ctx)[0] ?? null;
}

/** Build the word index up front so the first auction isn't slow. */
export function warmUp(dictionary: string[]): void {
  getIndex(dictionary);
  getLongIndex(dictionary);
}
