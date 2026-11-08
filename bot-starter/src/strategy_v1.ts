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
  lowBalance: 6,      // ...or when money runs low and we need to refill
  lateBag: 8,         // late game: play anything of 5+ letters
  flushBag: 2,        // last few tiles: play everything we can
  expectedMult: 2.4,  // what a mid-match tile is worth vs its face value
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

export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  bagTotal?: number;      // tiles still in the bag (0 = this is the last auction)
  players?: number;       // bots in the match
  dictionary?: string[];
}

export function decideBid(ctx: BidContext): number {
  const { letter, myRack } = ctx;
  const balance = Math.max(0, Math.floor(ctx.myBalance));
  if (balance <= 0) return 0;

  const bag = ctx.bagTotal;
  // Last auction: the match ends as it closes, so the tile can't be played.
  if (bag === 0) return 0;

  const face = LETTER_VALUE[letter] ?? 1;
  const players = Math.max(1, ctx.players ?? TUNING.players);

  // What adding this letter would do to our best playable word.
  let marginal = 0;
  if (ctx.dictionary && ctx.dictionary.length) {
    const before = bestWord(myRack, ctx.dictionary)?.reward ?? 0;
    const after = bestWord(withLetter(myRack, letter), ctx.dictionary)?.reward ?? 0;
    marginal = Math.max(0, after - before);
  }

  // Late game: a tile is only worth what it adds to words we can still play.
  if (bag !== undefined && bag <= TUNING.lateBag) {
    return clampBid(marginal, balance);
  }

  // Mid-match: face value x expected length bonus, adjusted for fit.
  let tiles = 0, vowels = 0;
  for (const [c, n] of myRack) {
    tiles += n;
    if (VOWELS.has(c)) vowels += n;
  }
  const vowelShare = tiles ? vowels / tiles : 0.4;
  let fit = PLAYABILITY[letter] ?? 1;
  if (VOWELS.has(letter)) {
    if (vowelShare < 0.3) fit *= 1.6;       // starving for vowels
    else if (vowelShare > 0.5) fit *= 0.5;  // already vowel-heavy
  } else if (vowelShare > 0.55) {
    fit *= 1.3;
  }
  const have = myRack.get(letter) ?? 0;
  if (have >= 2) fit *= 0.4;
  else if (have === 1 && !"ESTRNLAEIO".includes(letter)) fit *= 0.6;
  if (letter === "Q" && !myRack.get("U") && !myRack.get("I")) fit *= 0.5;
  if (tiles >= TUNING.bigRack + 2) fit *= 0.6; // rack is already huge

  // Spend pace: unspent money is worthless at the end, so the more money
  // we have per remaining auction, the bolder we bid.
  const auctionsLeft = (bag ?? 60) + 1;
  const myShare = Math.max(1, (auctionsLeft / players) * 1.5);
  const perTile = balance / myShare;
  const pace = Math.min(2.5, Math.max(0.6, perTile / 4));

  const heuristic = face * TUNING.expectedMult * fit * pace;
  return clampBid(Math.max(heuristic, marginal * 0.8), balance);
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
  if (tiles >= TUNING.bigRack || broke) {
    const b = bestWord(rack, ctx.dictionary, broke ? 2 : 5);
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
}
