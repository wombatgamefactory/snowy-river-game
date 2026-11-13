// smart-core.js - the pure decision core shared by Medium, the archetypes and Hard's rollouts: a
// line-by-line port of the v6 Python simulator's card play (`play_smart`, `play_naive`, with `key`, `pw`,
// `worth_fn`, `unseen_max`, `legal`, `winner_of`). Python source of truth: sim/snowy-river-sim-v6.py
// (read only), with its default settings (make_cfg()).
//
// What v6 has and v5 had not: single-number cards, no summit choice, a Climb row. So there is no summit
// Monte Carlo here (v5's mc_diff / quick / strong_count are gone) and no play_fast: Hard's rollouts use
// play_smart for every seat. Each trick is valued by the row card it takes: the Climb card on the climb,
// the Brumby card on the descent (the Python's tv; a trick worth 0 or less is one to duck).
//
// Everything here works on plain numbers: a card is an INDEX ci = suit x 12 + (n - 1), where suit is the
// Python suit id (escape 0, climb 1, descent 2, home 3, muster 4) and n is the printed number 1..12. That
// is the engine's fullDeck(5) order. The Python's descent value is 13 - n (higher = stronger), the
// engine's strength(card, 'descent'). No engine state, no view, no clock, no ambient randomness.
//
// Conventions that make the port exact:
//   * Python min() / max() return the FIRST of equal candidates, in the order of the `hand` list. Here a
//     strict < or > keeps the first of equals over the same order. The engine hands a bot its hand sorted
//     (suit, then number in the half), while the Python's hands stay in dealt order; so where two
//     candidates tie on the Python's key, JS and Python can pick different (equivalent) cards. Fed the
//     Python's own hand order the port matches it exactly (tests/bots.mjs).
//   * `unseen` is a Uint8Array(60): 1 = the seat has not seen the card (in the game's deck, not in its
//     hand, not played in an earlier trick, not in the current trick). At 2-3 players that includes the
//     cards out of play, as the Python's `alld - played - hand - trick` does; the Muster is in the deck at
//     5 players only.

import { fullDeck, SUITS } from '../engine/index.js';

export const UP = 0; // the climb: highest wins, Escape trumps
export const DOWN = 1; // the descent: lowest wins (Python value 13 - n, highest wins), Home trumps
export const TRUMP_UP = 0; // Python ESCAPE
export const TRUMP_DOWN = 3; // Python HOME

const DECK = fullDeck(5); // all 60 cards, code order
const INDEX = new Map(DECK.map((c, i) => [c, i]));
const SUIT = DECK.map((c) => SUITS.indexOf(c.slice(0, c.indexOf('-'))));
const VUP = DECK.map((c) => Number(c.slice(c.indexOf('-') + 1))); // the printed number
const VDOWN = VUP.map((v) => 13 - v); // the Python's descent value

/** 'escape-1' -> 0 ... 'home-12' -> 47, 'muster-12' -> 59 (throws on an unknown id). */
export function cardIndex(card) {
  const i = INDEX.get(card);
  if (i === undefined) throw new Error(`smart-core: not a card: ${JSON.stringify(card)}`);
  return i;
}
export const cardId = (ci) => DECK[ci];
export const cardSuitIndex = (ci) => SUIT[ci];
/** The number of suits (4, or 5 with the Muster) in an n-player game, as the Python's nsuits(). */
export const suitCount = (n) => (n === 5 ? 5 : 4);

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

/** Python worth_fn: how much a card is worth keeping in this half (on the climb, the better of its two halves). */
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

/** Python legal(hand, led): the led suit if held, else the whole hand. `led` -1 = leading. */
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

/**
 * The `unseen` flag array of a seat in an n-player game: every card of the game's deck that is not in
 * `handIds`, not in `playedIds` (earlier tricks of this hand) and not in `trickIds` (the current trick).
 */
export function unseenFlags(n, playedIds, handIds, trickIds) {
  const u = new Uint8Array(60);
  u.fill(1, 0, 12 * suitCount(n));
  for (const c of playedIds) u[INDEX.get(c)] = 0;
  for (const c of handIds) u[INDEX.get(c)] = 0;
  for (const c of trickIds) u[INDEX.get(c)] = 0;
  return u;
}

/** Python unseen_max: the highest value per suit still unseen in this half (0 = none). */
function unseenMax(unseen, ph) {
  const m = [0, 0, 0, 0, 0];
  for (let ci = 0; ci < 60; ci++) {
    if (!unseen[ci]) continue;
    const v = val(ci, ph);
    if (v > m[SUIT[ci]]) m[SUIT[ci]] = v;
  }
  return m;
}

// ---------------------------------------------------------------- card play
/**
 * Python play_smart. Wins tricks cheaply, dumps middle cards on the climb (keeps cards strong in either
 * half), ducks a trick that is worth nothing or less (the Climb -1, Flint stones, a Wombat hole), and on
 * the descent keeps its strongest card for a better trick still to come.
 * @param {number[]} hand     card indices, in hand order
 * @param {number[]} trick    cards already in the trick, in play order ([] = this seat leads)
 * @param {number} ph         UP | DOWN
 * @param {number} n          players
 * @param {Uint8Array|(() => Uint8Array)} unseen unseenFlags(), or a function making it (only a lead reads it)
 * @param {number} tv         the value of the row card this trick takes (Python tv)
 * @param {number} coltTv     the best row card still to come after it (Python colt_tv; -99 = none; unused on the climb)
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

/** Python play_naive: Whist habits (lead high, win cheaply, dump your lowest card). Ignores the rows. */
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

// ---------------------------------------------------------------- the stakes
/**
 * The (tv, coltTv, last) the Python hands to play_smart for the trick at 0-based position `i` of a half.
 * Climb (ph UP): tv = the Climb card's value, coltTv = 1.0 (the default, unused), last = false (the default).
 * Descent (ph DOWN): tv = the Brumby card's value (run_descent with every seat "chasing" and desc_plus off:
 * trick_value = 0 + b), coltTv = the best Brumby value after it (-99 after the last), last = the 6th trick.
 * @param {number} ph
 * @param {number} i        0-based trick position in the half
 * @param {number[]} values the 6 row values as dealt (Climb values on the climb, Brumby values on the descent)
 */
export function stakes(ph, i, values) {
  if (ph === UP) return { tv: values[i], coltTv: 1, last: false };
  let cb = -99;
  for (let j = i + 1; j < values.length; j++) if (values[j] > cb) cb = values[j];
  return { tv: values[i], coltTv: cb, last: i === values.length - 1 };
}
