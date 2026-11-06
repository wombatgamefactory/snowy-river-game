// medium.js - Medium bot. Level id 'medium'. The Python simulator's "smart" bot, ported decision for
// decision (sim/snowy-river-sim.py: play_card style "smart", decide policy "smart"; the pure parts live
// in smart-core.js, which is where the Python line-by-line port is).
//
// Card play (every card decision):
//   climb lead:     the cheapest card no unseen card of its suit can beat; else the most "middle" card
//   climb follow:   the cheapest card that beats the trick as it stands; else the most middle card
//   climb void:     the most middle card (keep the extremes: highs for the climb, lows for the descent)
//   descent lead:   the HIGHEST card no unseen card of its suit can undercut; else the lowest card
//   descent follow: the highest card that still undercuts the trick; else the highest card
//   descent void:   the highest card
// Summit (Monte Carlo): deal the cards I cannot place to the other seats MEDIUM_SAMPLES times, play each
// descent out with smart players, and let p = how often I finish at the mob's heels. Chase if
// p x mob > (1 - p) x (my climb points + the fall).
//
// The decision is a pure function of plain data (mediumChoose), so the SAME code serves the real bot (from
// a view) and Hard's rollouts (from a full state, no viewFor per step). It reads only what a seat may see:
// its own hand, the public tricks, the counts, the stakes. It returns one of the legal actions it was given.

import { legalActionsFromView, getValidActions, shownVoids } from '../engine/index.js';
import { playCard, unseenMask, estimateP, chaseIfWorth } from './smart-core.js';

/** Worlds dealt for the summit call (Python cfg["samples"]). */
export const MEDIUM_SAMPLES = 16;
/**
 * Deal the summit samples honouring the suits other seats have shown they lack (what is public).
 * The Python deals from every unseen card regardless of voids; false reproduces that exactly.
 */
export const MEDIUM_HONOUR_VOIDS = true;

const cardsOf = (tricks) => {
  const out = [];
  for (const t of tricks) for (const p of t.plays) out.push(p.card);
  return out;
};

/**
 * The plain-data context of one decision.
 * @param {object} src   a view or a full state (both carry n, phase, trick, tricks, leader, params, mob, climbTricks)
 * @param {number} seat
 * @param {string[]} hand
 * @param {number[]} handCounts
 * @param {{s:number}} rng
 * @param {{ samples?:number, voids?:boolean }} [opts]
 */
export function buildContext(src, seat, hand, handCounts, rng, opts = {}) {
  const played = cardsOf(src.tricks);
  const trickCards = src.trick ? src.trick.plays.map((p) => p.card) : [];
  return {
    seat,
    n: src.n,
    phase: src.phase,
    hand,
    handCounts,
    trickCards,
    played,
    leader: src.leader,
    mob: src.mob,
    climbPoints: src.climbTricks[seat] * src.params.climbTrickValue,
    fall: -src.params.fallScore, // the Python's `spill`
    rng,
    samples: opts.samples === undefined ? MEDIUM_SAMPLES : opts.samples,
    // the shown voids are worked out only when a summit call needs them
    voids: () => ((opts.voids === undefined ? MEDIUM_HONOUR_VOIDS : opts.voids) ? shownVoids(src).map((v) => new Set(v)) : null),
    style: opts.style || 'smart',
  };
}

/** The summit call: the Monte Carlo estimate and the stakes rule. Returns { p, chase }. */
export function summitCall(ctx, pools = null) {
  const p = estimateP({ me: ctx.seat, hand: ctx.hand, handCounts: ctx.handCounts, leader: ctx.leader, played: ctx.played, n: ctx.n, rng: ctx.rng, samples: ctx.samples, voids: pools ? null : ctx.voids(), pools });
  return { p, chase: chaseIfWorth(p, ctx.mob, ctx.climbPoints, ctx.fall) };
}

/** The card the Python's play_card style `ctx.style` plays here. */
export function cardChoice(ctx) {
  const un = unseenMask(ctx.played, ctx.hand, ctx.trickCards);
  return playCard(ctx.style, ctx.hand, ctx.trickCards, ctx.phase === 'descent', un);
}

/**
 * @param {object} ctx   buildContext()
 * @param {{type:string, card?:string, choice?:string}[]} legal
 */
export function mediumChoose(ctx, legal) {
  if (legal.length === 1) return legal[0];
  if (ctx.phase === 'summit') {
    const want = summitCall(ctx).chase ? 'chase' : 'watch';
    return legal.find((a) => a.choice === want);
  }
  const card = cardChoice(ctx);
  return legal.find((a) => a.card === card);
}

/** The Medium choice from a view (what the real bot sees). */
export function chooseMediumFromView(view, rng = { s: 1 }, opts = {}) {
  return mediumChoose(buildContext(view, view.seat, view.hand, view.handCounts, rng, opts), legalActionsFromView(view));
}

/**
 * The Medium choice for the seat to act in a full state (Hard's rollouts; no view is built).
 * `rng` is the sampler for a summit call. The options let a rollout use a cheaper summit estimate.
 */
export function mediumActionFromState(st, rng, opts = {}) {
  const seat = st.toAct;
  const ctx = buildContext(st, seat, st.hands[seat], st.hands.map((h) => h.length), rng, opts);
  return mediumChoose(ctx, getValidActions(st));
}

export const mediumBot = {
  id: 'medium',
  label: 'Medium',
  chooseAction(view, rng) {
    return chooseMediumFromView(view, rng);
  },
};
