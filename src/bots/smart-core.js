// smart-core.js - the pure decision core shared by Medium, the archetypes and Hard's rollouts:
// a line-by-line port of the Python simulator's card play (`play_card`, styles "smart" and "naive"),
// its descent playout (`run_descent`, `top_of`) and the summit Monte Carlo (`estimate_p`, `decide`).
// Python source of truth: sim/snowy-river-sim.py (read only).
//
// Everything here works on plain data: card ids ('home-7'), arrays, and a bit mask for "cards this
// seat has not seen". No engine state, no view, no clock, no ambient randomness: randomness comes only from
// the rng a caller passes in (rng.js streams).
//
// Conventions that make the port exact:
//   * Python hands are sorted (suit id, rank); the engine keeps hands in the same order (suit order
//     escape, climb, descent, home, then rank), and legal options keep hand order, so "the first of
//     equal candidates" (Python min / max) is the same card on both sides. Here a strict < or > keeps
//     the first of equals, as min() / max() do.
//   * Python `mid(c)` is abs(rank - 6.5); here 2 x abs(...) = abs(2 x rank - 13), the same order, in integers.
//   * Python "unseen" = every card not in this player's hand, not played in an earlier trick and not
//     in the current trick. Here it is a mask: one 12-bit word per suit, bit (rank - 1) set = unseen.

import { fullDeck, SUIT_ORDER, shuffle, dealRespectingVoids } from '../engine/index.js';

const DECK = fullDeck();
const SUIT = {}; // card id -> suit index 0..3 (Python suit id; R1.3)
const RANK = {}; // card id -> rank 1..12
const MID = {}; // card id -> 2 x Python mid(): how far from the middle rank (0 = a 6 or 7 ... 11 = a 1 or 12)
for (const c of DECK) {
  const dash = c.indexOf('-');
  SUIT[c] = SUIT_ORDER.indexOf(c.slice(0, dash));
  RANK[c] = Number(c.slice(dash + 1));
  MID[c] = Math.abs(2 * RANK[c] - 13);
}
const FULL_SUIT = (1 << 12) - 1;

export const cardSuitIndex = (c) => SUIT[c];
export const cardRank = (c) => RANK[c];

/** A mask with the bits of `cards` SET (or cleared from `base` when `clear`). */
export function maskOfCards(cards, base = null, clear = false) {
  const m = base ? Int32Array.from(base) : new Int32Array(4);
  for (const c of cards) {
    if (clear) m[SUIT[c]] &= ~(1 << (RANK[c] - 1));
    else m[SUIT[c]] |= 1 << (RANK[c] - 1);
  }
  return m;
}

/** The mask of cards nobody has played: all 48 minus `played`. */
export function unplayedMask(played) {
  return maskOfCards(played, Int32Array.of(FULL_SUIT, FULL_SUIT, FULL_SUIT, FULL_SUIT), true);
}

/** Python `unseen` for one player: everything except `hand`, the earlier tricks (`played`) and the current trick. */
export function unseenMask(played, hand, trickCards) {
  return maskOfCards(trickCards, maskOfCards(hand, unplayedMask(played), true), true);
}

// first of equals, like Python min() / max()
function minBy(xs, key) {
  let best = xs[0];
  let bk = key[best];
  for (let i = 1; i < xs.length; i++) { const k = key[xs[i]]; if (k < bk) { best = xs[i]; bk = k; } }
  return best;
}
function maxBy(xs, key) {
  let best = xs[0];
  let bk = key[best];
  for (let i = 1; i < xs.length; i++) { const k = key[xs[i]]; if (k > bk) { best = xs[i]; bk = k; } }
  return best;
}

/**
 * Python `play_card(style, hand, trick, low, unseen)`.
 * @param {'smart'|'naive'} style
 * @param {string[]} hand        cards in hand, in hand order
 * @param {string[]} trick       the cards already in the current trick, in play order ([] = this seat leads)
 * @param {boolean} low          true in the descent (the lowest card of the led suit wins)
 * @param {Int32Array} un        unseenMask()
 * @returns {string} the chosen card (always one of the legal cards)
 */
export function playCard(style, hand, trick, low, un) {
  const led = trick.length ? SUIT[trick[0]] : -1;
  let opts = hand;
  if (led >= 0) {
    const same = hand.filter((c) => SUIT[c] === led);
    if (same.length) opts = same;
  }
  const following = led >= 0 && SUIT[opts[0]] === led; // holds the led suit (all options are then of it)
  if (!low) {
    // ---- the climb: high wins ----
    if (style === 'naive') {
      if (led < 0) return maxBy(opts, RANK);
      if (following) {
        let w = 0;
        for (const c of trick) if (SUIT[c] === led && RANK[c] > w) w = RANK[c];
        const beat = opts.filter((c) => RANK[c] > w);
        return beat.length ? minBy(beat, RANK) : minBy(opts, RANK);
      }
      return minBy(opts, RANK);
    }
    // smart: win cheaply, otherwise dump the middle, keep the low cards for the descent
    if (led < 0) {
      const sure = opts.filter((c) => (un[SUIT[c]] >> RANK[c]) === 0); // no unseen card of the suit is higher
      return sure.length ? minBy(sure, RANK) : minBy(opts, MID);
    }
    if (following) {
      let w = 0;
      for (const c of trick) if (SUIT[c] === led && RANK[c] > w) w = RANK[c];
      const beat = opts.filter((c) => RANK[c] > w);
      return beat.length ? minBy(beat, RANK) : minBy(opts, MID);
    }
    return minBy(opts, MID);
  }
  // ---- the descent: low wins (both styles greedy) ----
  if (led < 0) {
    const sure = opts.filter((c) => (un[SUIT[c]] & ((1 << (RANK[c] - 1)) - 1)) === 0); // no unseen card of the suit is lower
    return sure.length ? maxBy(sure, RANK) : minBy(opts, RANK);
  }
  if (following) {
    let w = 99;
    for (const c of trick) if (SUIT[c] === led && RANK[c] < w) w = RANK[c];
    const beat = opts.filter((c) => RANK[c] < w);
    if (beat.length) return style === 'smart' ? maxBy(beat, RANK) : minBy(beat, RANK);
    return maxBy(opts, RANK);
  }
  return maxBy(opts, RANK);
}

/** Python `trick_winner(trick, low)` on the cards of a trick in play order: the index of the winning card. */
export function trickWinnerIndex(trick, low) {
  const led = SUIT[trick[0]];
  let best = 0;
  for (let i = 1; i < trick.length; i++) {
    const c = trick[i];
    if (SUIT[c] !== led) continue;
    if (low ? RANK[c] < RANK[trick[best]] : RANK[c] > RANK[trick[best]]) best = i;
  }
  return best;
}

/**
 * Python `run_descent` + `top_of`: plays the descent out from `startHands` (hands by seat, in the
 * order given; each seat's cards are removed as they go, keeping order) and returns the seat at the
 * mob's heels (most descent tricks; tie: the later trick).
 * @param {string[][]} startHands
 * @param {number} leader     the winner of the last climb trick
 * @param {Int32Array} playedBase  unplayedMask(cards played so far this hand): bit SET = not yet played
 * @param {number} n
 * @param {string[]|null} styles   per seat 'smart' | 'naive' (null = everyone smart, as the Python's playouts)
 */
export function descentHeels(startHands, leader, playedBase, n, styles = null) {
  const hands = startHands.map((h) => h.slice());
  const desc = new Array(n).fill(0);
  const last = new Array(n).fill(-1);
  const base = Int32Array.from(playedBase);
  const un = new Int32Array(4);
  let t = 0;
  while (hands[leader].length) {
    const trick = [];
    for (let k = 0; k < n; k++) {
      const p = (leader + k) % n;
      un.set(base);
      for (const c of hands[p]) un[SUIT[c]] &= ~(1 << (RANK[c] - 1));
      for (const c of trick) un[SUIT[c]] &= ~(1 << (RANK[c] - 1));
      const c = playCard(styles ? styles[p] : 'smart', hands[p], trick, true, un);
      const h = hands[p];
      h.splice(h.indexOf(c), 1);
      trick.push(c);
    }
    for (const c of trick) base[SUIT[c]] &= ~(1 << (RANK[c] - 1));
    const w = (leader + trickWinnerIndex(trick, true)) % n;
    desc[w]++;
    last[w] = t;
    t++;
    leader = w;
  }
  let top = 0;
  for (let p = 1; p < n; p++) if (desc[p] > desc[top] || (desc[p] === desc[top] && last[p] > last[top])) top = p;
  return top;
}

/**
 * Python `estimate_p`: the chance that `me` finishes at the mob's heels, from what `me` can see:
 * `samples` random deals of the cards `me` cannot place, each played out by smart players.
 * @param {object} o
 * @param {number} o.me
 * @param {string[]} o.hand        my hand (hand order)
 * @param {number[]} o.handCounts  cards in each seat's hand
 * @param {number} o.leader        the winner of the last climb trick (leads the descent)
 * @param {string[]} o.played      every card played this hand
 * @param {number} o.n
 * @param {{s:number}|null} o.rng
 * @param {number} o.samples
 * @param {Set<string>[]|null} [o.voids]  per seat, suits the seat has shown it lacks; null = the Python's deal (ignores voids)
 * @param {string[][]|null} [o.pools]     TEST HOOK: explicit shuffled pools, one per sample (replaces the random deal)
 * @returns {number} wins / samples
 */
export function estimateP({ me, hand, handCounts, leader, played, n, rng, samples, voids = null, pools = null }) {
  const playedSet = new Set(played);
  const mine = new Set(hand);
  const poolBase = DECK.filter((c) => !playedSet.has(c) && !mine.has(c));
  const base = unplayedMask(played);
  const others = [];
  for (let p = 0; p < n; p++) if (p !== me) others.push(p);
  const need = handCounts.map((k, p) => (p === me ? 0 : k));
  const count = pools ? pools.length : samples;
  let wins = 0;
  for (let i = 0; i < count; i++) {
    const sim = new Array(n);
    if (pools) {
      let at = 0;
      for (let p = 0; p < n; p++) {
        if (p === me) sim[p] = hand.slice();
        else { sim[p] = pools[i].slice(at, at + handCounts[p]); at += handCounts[p]; }
      }
    } else if (voids) {
      const dealt = dealRespectingVoids(poolBase, need, voids, rng, others);
      for (let p = 0; p < n; p++) sim[p] = p === me ? hand.slice() : dealt.hands[p];
    } else {
      const pool = shuffle(rng, poolBase.slice());
      let at = 0;
      for (let p = 0; p < n; p++) {
        if (p === me) sim[p] = hand.slice();
        else { sim[p] = pool.slice(at, at + handCounts[p]); at += handCounts[p]; }
      }
    }
    if (descentHeels(sim, leader, base, n) === me) wins++;
  }
  return wins / count;
}

/**
 * Python `decide(..., "smart", ...)` once p is known: chase if p x mob > (1 - p) x (what a fall costs).
 * @param {number} p
 * @param {number} mob         this hand's mob value
 * @param {number} climbPoints what a fall throws away (my climb tricks, in points)
 * @param {number} fall        the fall score magnitude (Python `spill`, 1)
 */
export function chaseIfWorth(p, mob, climbPoints, fall) {
  const loss = climbPoints + fall;
  return p * mob > (1 - p) * loss;
}
