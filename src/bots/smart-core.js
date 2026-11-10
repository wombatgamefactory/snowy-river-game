// smart-core.js - the pure decision core shared by Medium, the archetypes and Hard's rollouts: a
// line-by-line port of the v5 Python simulator's card play (`play_smart`, `play_naive`, `play_fast`),
// its descent playout (`run_descent`, fast mode) and the summit Monte Carlo (`mc_diff`, `quick`,
// `strong_count`). Python source of truth: sim/snowy-river-sim-v5.py (read only).
//
// Everything here works on plain numbers: a card is an INDEX ci = suit x 12 + (v - 1), where suit is the
// Python suit id (escape 0, climb 1, descent 2, home 3) and v is the CLIMB value 1..12 (the descent value
// is 13 - v). That is the engine's fullDeck() order. No engine state, no view, no clock, no ambient
// randomness: randomness comes only from the rng a caller passes in.
//
// Conventions that make the port exact:
//   * Python min() / max() return the FIRST of equal candidates, in the order of the `hand` list. Here a
//     strict < or > keeps the first of equals over the same order. The engine hands a bot its hand sorted
//     (suit, then value in the half), while the Python's hands stay in dealt order; so where two
//     candidates tie on the Python's key, JS and Python can pick different (equivalent) cards. Fed the
//     Python's own hand order the port matches it exactly (tests/bots.mjs).
//   * `unseen` is a Uint8Array(48): 1 = the seat has not seen the card (not in its hand, not played in an
//     earlier trick, not in the current trick). On 2-3 players that includes the cards out of play, as the
//     Python's `alld - played - hand - trick` does.

import { fullDeck, SUIT_ORDER, shuffle } from '../engine/index.js';

export const UP = 0; // the climb: climb values count, Escape trumps
export const DOWN = 1; // the descent: descent values count, Home trumps
export const TRUMP_UP = 0; // Python ESCAPE
export const TRUMP_DOWN = 3; // Python HOME

const DECK = fullDeck();
const IDX = new Map(DECK.map((c, i) => [c, i]));
const SUIT = DECK.map((c) => SUIT_ORDER.indexOf(c.slice(0, c.indexOf('-'))));
const VUP = DECK.map((c) => Number(c.slice(c.indexOf('-') + 1))); // climb value
const VDOWN = VUP.map((v) => 13 - v); // descent value

/** Card id -> index (throws on an unknown id). */
export function cardIndex(card) {
  const i = IDX.get(card);
  if (i === undefined) throw new Error(`smart-core: unknown card ${card}`);
  return i;
}
/** Index -> card id. */
export const cardId = (ci) => DECK[ci];
export const cardSuitIndex = (ci) => SUIT[ci];

const val = (ci, ph) => (ph === UP ? VUP[ci] : VDOWN[ci]);
const trumpOf = (ph) => (ph === UP ? TRUMP_UP : TRUMP_DOWN);

/** Trick strength (Python key): trumps above the led suit; other suits can never win. */
function key(ci, led, t, ph) {
  const v = ph === UP ? VUP[ci] : VDOWN[ci];
  if (SUIT[ci] === t) return 100 + v;
  if (SUIT[ci] === led) return v;
  return -1;
}

/** How strong a card is in a half, for keeping and dumping (Python pw). */
function pw(ci, ph, t) {
  return (ph === UP ? VUP[ci] : VDOWN[ci]) + (SUIT[ci] === t ? 12 : 0);
}

/** Python worth_fn: how much a card is worth keeping in this half. */
function worth(ci, ph) {
  if (ph === UP) return Math.max(pw(ci, UP, TRUMP_UP), pw(ci, DOWN, TRUMP_DOWN));
  return pw(ci, DOWN, TRUMP_DOWN);
}

// first of equals, like Python min() / max()
function minBy(xs, f) {
  let best = xs[0];
  let bk = f(best);
  for (let i = 1; i < xs.length; i++) { const k = f(xs[i]); if (k < bk) { best = xs[i]; bk = k; } }
  return best;
}
function maxBy(xs, f) {
  let best = xs[0];
  let bk = f(best);
  for (let i = 1; i < xs.length; i++) { const k = f(xs[i]); if (k > bk) { best = xs[i]; bk = k; } }
  return best;
}

/** Python legal(hand, led): the led suit if held, else the whole hand. */
function legalOf(hand, led) {
  if (led < 0) return hand;
  const f = hand.filter((c) => SUIT[c] === led);
  return f.length ? f : hand;
}

/** The winner (an index into `trick`) of the plays so far, Python winner_of: first card with the strictly highest key. */
export function trickWinnerIndex(trick, t, ph) {
  const led = SUIT[trick[0]];
  let best = -1;
  let bk = -9;
  for (let i = 0; i < trick.length; i++) {
    const k = key(trick[i], led, t, ph);
    if (k > bk) { bk = k; best = i; }
  }
  return best;
}

/** Everything not in `hand`, not in `played` and not in `trick` (card ids), as an `unseen` flag array. */
export function unseenFlags(playedIds, handIds, trickIds) {
  const u = new Uint8Array(48).fill(1);
  for (const c of playedIds) u[IDX.get(c)] = 0;
  for (const c of handIds) u[IDX.get(c)] = 0;
  for (const c of trickIds) u[IDX.get(c)] = 0;
  return u;
}

/** Python unseen_max: the highest value per suit still unseen in this half (0 = none). */
function unseenMax(unseen, ph) {
  const m = [0, 0, 0, 0];
  for (let ci = 0; ci < 48; ci++) {
    if (!unseen[ci]) continue;
    const v = val(ci, ph);
    if (v > m[SUIT[ci]]) m[SUIT[ci]] = v;
  }
  return m;
}

// ---------------------------------------------------------------- card play
/**
 * Python play_smart. Wins tricks cheaply, dumps middle cards on the climb (keeps cards strong in either
 * half), values each descent trick by its Brumby card, keeps its best card for a better trick to come.
 * @param {number[]} hand     card indices, in hand order
 * @param {number[]} trick    cards already in the trick, in play order ([] = this seat leads)
 * @param {number} ph         UP | DOWN
 * @param {number} n          players
 * @param {Uint8Array|(() => Uint8Array)} unseen unseenFlags(), or a function making it (only a lead reads it)
 * @param {number} tv         this trick's value to this seat (Python tv)
 * @param {number} coltTv     the best trick still to come, valued the same way (Python colt_tv; -99 = none)
 * @param {boolean} last      the last trick of the half
 * @returns {number} the chosen card index (always a legal one)
 */
export function playSmart(hand, trick, ph, n, unseen, tv = 1, coltTv = 1, last = false) {
  const t = trumpOf(ph);
  const led = trick.length ? SUIT[trick[0]] : -1;
  let opts = legalOf(hand, led);
  if (opts.length === 1) return opts[0];
  const worthOf = (c) => worth(c, ph);
  if (ph === DOWN && !last && coltTv > tv + 0.5) {
    const strongest = maxBy(hand, (c) => pw(c, DOWN, t));
    if (opts.includes(strongest)) opts = opts.filter((c) => c !== strongest);
  }
  if (tv <= 0) { // try to lose this trick
    if (!trick.length) return minBy(opts, (c) => pw(c, ph, t));
    let cur = -Infinity;
    for (const c of trick) cur = Math.max(cur, key(c, led, t, ph));
    const losers = opts.filter((c) => key(c, led, t, ph) < cur);
    if (losers.length) return maxBy(losers, (c) => pw(c, ph, t));
    return minBy(opts, (c) => key(c, led, t, ph));
  }
  if (!trick.length) {
    const um = unseenMax(typeof unseen === 'function' ? unseen() : unseen, ph); // a function: built only when a lead needs it
    const sure = opts.filter((c) => val(c, ph) > um[SUIT[c]]);
    if (sure.length) return minBy(sure, (c) => pw(c, ph, t));
    return minBy(opts, worthOf);
  }
  let cur = -Infinity;
  for (const c of trick) cur = Math.max(cur, key(c, led, t, ph));
  const wins = opts.filter((c) => key(c, led, t, ph) > cur);
  if (wins.length) {
    if (tv >= 3 && trick.length < n - 1) return maxBy(wins, (c) => key(c, led, t, ph));
    return minBy(wins, (c) => key(c, led, t, ph));
  }
  return minBy(opts, worthOf);
}

/** Python play_naive: Whist habits (lead high, win cheaply, dump your lowest card). Ignores the row. */
export function playNaive(hand, trick, ph) {
  const t = trumpOf(ph);
  const led = trick.length ? SUIT[trick[0]] : -1;
  const opts = legalOf(hand, led);
  if (!trick.length) return maxBy(opts, (c) => pw(c, ph, t));
  let cur = -Infinity;
  for (const c of trick) cur = Math.max(cur, key(c, led, t, ph));
  const wins = opts.filter((c) => key(c, led, t, ph) > cur);
  if (wins.length) return minBy(wins, (c) => key(c, led, t, ph));
  return minBy(opts, (c) => pw(c, ph, t));
}

/** Python play_fast: the cheap descent play inside the summit Monte Carlo. */
export function playFast(hand, trick, tv, coltTv, last) {
  const t = TRUMP_DOWN;
  const led = trick.length ? SUIT[trick[0]] : -1;
  let opts = legalOf(hand, led);
  if (opts.length > 1 && !last && coltTv > tv + 0.5) {
    const strongest = maxBy(hand, (c) => pw(c, DOWN, t));
    if (opts.includes(strongest)) opts = opts.filter((c) => c !== strongest);
  }
  if (!trick.length) {
    return tv > 0 ? maxBy(opts, (c) => pw(c, DOWN, t)) : minBy(opts, (c) => pw(c, DOWN, t));
  }
  let cur = -Infinity;
  for (const c of trick) cur = Math.max(cur, key(c, led, t, DOWN));
  if (tv > 0) {
    const wins = opts.filter((c) => key(c, led, t, DOWN) > cur);
    if (wins.length) return minBy(wins, (c) => key(c, led, t, DOWN));
    return minBy(opts, (c) => pw(c, DOWN, t));
  }
  const losers = opts.filter((c) => key(c, led, t, DOWN) < cur);
  if (losers.length) return maxBy(losers, (c) => pw(c, DOWN, t));
  return minBy(opts, (c) => key(c, led, t, DOWN));
}

// ---------------------------------------------------------------- the descent
/** Python trick_value: what winning a descent trick whose row card is worth `b` is worth to seat p. */
export function trickValue(p, b, roles, anyChaser) {
  if (roles[p]) return 1 + b;
  return anyChaser ? 1 + 0.5 * b : 1;
}

/** The (tv, coltTv, last) the Python run_descent hands to play_smart for seat p at descent trick `i`. */
export function descentStakes(p, i, rowValues, roles) {
  const anych = roles.some(Boolean);
  const b = rowValues[i];
  const cb = i < rowValues.length - 1 ? Math.max(...rowValues.slice(i + 1)) : -99; // row face up: the best trick still to come
  return { tv: trickValue(p, b, roles, anych), coltTv: cb > -99 ? trickValue(p, cb, roles, anych) : -99, last: i === rowValues.length - 1 };
}

/**
 * Python run_descent(fast=True): plays the descent out with play_fast for every seat.
 * @param {number[][]} hands   by seat, card indices (copied, not changed)
 * @param {number} leader
 * @param {number[]} rowValues the 6 row values in order
 * @param {boolean[]} roles    true = chaser
 * @returns {{ pts:number[], brum:number[] }} descent tricks and Brumby points by seat
 */
export function runDescentFast(hands, leader, rowValues, roles, n) {
  const hs = hands.map((h) => h.slice());
  const pts = new Array(n).fill(0);
  const brum = new Array(n).fill(0);
  const anych = roles.some(Boolean);
  const nd = rowValues.length;
  for (let i = 0; i < nd; i++) {
    const b = rowValues[i];
    const last = i === nd - 1;
    let cb = -99;
    if (i < nd - 1) { cb = rowValues[i + 1]; for (let j = i + 2; j < nd; j++) if (rowValues[j] > cb) cb = rowValues[j]; }
    const trick = [];
    for (let k = 0; k < n; k++) {
      const p = (leader + k) % n;
      const tv = trickValue(p, b, roles, anych);
      const ctv = cb > -99 ? trickValue(p, cb, roles, anych) : -99;
      const c = playFast(hs[p], trick, tv, ctv, last);
      hs[p].splice(hs[p].indexOf(c), 1);
      trick.push(c);
    }
    const w = (leader + trickWinnerIndex(trick, TRUMP_DOWN, DOWN)) % n;
    pts[w]++;
    if (roles[w]) brum[w] += b;
    leader = w;
  }
  return { pts, brum };
}

// ---------------------------------------------------------------- the summit
/** Python strong_count: cards that are Home or have descent value 10+. */
export function strongCount(hand) {
  let k = 0;
  for (const c of hand) if (SUIT[c] === TRUMP_DOWN || VDOWN[c] >= 10) k++;
  return k;
}

/** Python quick: the cheap guess at who chases (2+ strong cards for the descent). */
export const quick = (hand) => strongCount(hand) >= 2;

/**
 * Python mc_diff: the mean advantage of chasing over watching, over `samples` dealt worlds. Others'
 * hands are dealt from the cards the seat cannot place (the Python ignores shown voids); each world plays
 * the descent out twice (chase, then watch) with the cheap play and `quick` guesses for the others.
 * Positive = chase.
 * @param {number} me
 * @param {number[]} myHand          card indices, in hand order
 * @param {number[]} handSizes       by seat (cards left; all equal at the summit)
 * @param {number} leader            the descent leader
 * @param {number[]} rowValues       the 6 row values in order
 * @param {number} n
 * @param {number} cost              the Chase cost (3 at 2p, 2 at 3-4p)
 * @param {{ samples:number, rng?:{s:number}, pools?:number[][] }} src
 *   pools: explicit post-shuffle pools, one per sample (the Python's own, for the decision-match test);
 *   else the pool is shuffled from `rng`.
 * @param {number[]} pool            every card index the seat cannot place
 * @returns {{ d:number, total:number }} d = total / samples
 */
export function mcDiff(me, myHand, handSizes, leader, rowValues, n, cost, pool, { samples, rng = null, pools = null }) {
  let total = 0;
  const work = pool.slice();
  for (let s = 0; s < samples; s++) {
    let cards;
    if (pools) cards = pools[s];
    else { shuffle(rng, work); cards = work; }
    const sim = [];
    let i = 0;
    for (let p = 0; p < n; p++) {
      if (p === me) sim.push(myHand.slice());
      else { sim.push(cards.slice(i, i + handSizes[p])); i += handSizes[p]; }
    }
    const roles = sim.map((h) => quick(h));
    const res = [];
    for (const mine of [true, false]) {
      roles[me] = mine;
      const { pts, brum } = runDescentFast(sim, leader, rowValues, roles, n);
      res.push(pts[me] + brum[me] - (mine ? cost : 0));
    }
    total += res[0] - res[1];
  }
  return { d: total / samples, total };
}
