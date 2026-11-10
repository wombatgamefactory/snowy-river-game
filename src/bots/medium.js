// medium.js - Medium bot. Level id 'medium'. The v5 Python simulator's "smart" bot, ported decision for
// decision (sim/snowy-river-sim-v5.py: play_smart for card play, mc_diff / decide for the summit). The pure
// parts live in smart-core.js, which is where the line-by-line port is.
//
// Card play:
//   climb lead:     the cheapest card nothing unseen can beat in its suit; else the card worth least to keep
//   climb follow:   the cheapest card that beats the trick as it stands; else the card worth least to keep
//   descent:        the same, but each trick is valued by its row card: a chaser takes a good Brumby card
//                   (and ducks a bad one), a watcher tries to win a good one away from the chasers and
//                   saves its best card for the best trick still to come
// Summit (Monte Carlo): deal the cards I cannot place to the other seats MEDIUM_SAMPLES times, play the
// descent out twice (chasing, then watching) with the cheap play, others guessed to chase with 2+ strong
// cards, and chase if the mean gain (Brumby cards won - Chase cost + the tricks it changes) is above zero.
//
// The decision is a pure function of plain data (mediumChoose), so the SAME code serves the real bot (from
// a view) and Hard's rollouts (from a full state, no viewFor per step). It reads only what a seat may see:
// its own hand, the public tricks, the revealed choices, the face-up row. It returns one of the legal
// actions it was given.

import { legalActionsFromView, getValidActions, brumbyValue } from '../engine/index.js';
import {
  UP, DOWN, cardIndex, cardId, playSmart, playNaive, descentStakes, mcDiff, unseenFlags,
} from './smart-core.js';

/** Worlds dealt for the summit call (Python cfg["samples"] = 12). */
export const MEDIUM_SAMPLES = 12;

const cardsOf = (tricks) => {
  const out = [];
  for (const t of tricks) for (const p of t.plays) out.push(p.card);
  return out;
};

/**
 * The plain-data context of one decision.
 * @param {object} src   a view or a full state (both carry n, phase, trick, tricks, leader, params, choices, rowDealt, descentTrickNo)
 * @param {number} seat
 * @param {string[]} hand        the seat's cards, in the order that breaks ties (the view's hand order)
 * @param {number[]} handCounts
 * @param {{s:number}} rng
 * @param {{ samples?:number, style?:'smart'|'naive' }} [opts]
 */
export function buildContext(src, seat, hand, handCounts, rng, opts = {}) {
  const trickCards = src.trick ? src.trick.plays.map((p) => p.card) : [];
  return {
    seat,
    n: src.n,
    phase: src.phase,
    hand,
    handCounts,
    trickCards,
    played: cardsOf(src.tricks),
    leader: src.leader,
    descentTrickNo: src.descentTrickNo,
    rowValues: src.rowDealt.map(brumbyValue),
    roles: src.choices.map((c) => c === 'chase'), // all revealed in the descent
    cost: src.params.chaseCost,
    rng,
    samples: opts.samples === undefined ? MEDIUM_SAMPLES : opts.samples,
    style: opts.style || 'smart',
  };
}

/**
 * The summit call. Returns { d, chase, total }: d = mean (chase - watch) over the sampled worlds, chase = d > 0.
 * `pools` (optional): explicit post-shuffle pools of card INDICES, one per sample (the decision-match test feeds
 * the Python's own); otherwise the worlds are dealt from ctx.rng.
 */
export function summitCall(ctx, pools = null) {
  const hand = ctx.hand.map(cardIndex);
  const known = new Set([...ctx.hand, ...ctx.played]);
  const pool = [];
  for (let ci = 0; ci < 48; ci++) if (!known.has(cardId(ci))) pool.push(ci);
  const { d, total } = mcDiff(ctx.seat, hand, ctx.handCounts, ctx.leader, ctx.rowValues, ctx.n, ctx.cost, pool, { samples: ctx.samples, rng: ctx.rng, pools });
  return { d, chase: d > 0, total };
}

/** The card the Python's style `ctx.style` plays here (an id). */
export function cardChoice(ctx) {
  const ph = ctx.phase === 'descent' ? DOWN : UP;
  const hand = ctx.hand.map(cardIndex);
  const trick = ctx.trickCards.map(cardIndex);
  if (ctx.style === 'naive') return cardId(playNaive(hand, trick, ph));
  const unseen = unseenFlags(ctx.played, ctx.hand, ctx.trickCards); // ids, like the context
  if (ph === UP) return cardId(playSmart(hand, trick, ph, ctx.n, unseen));
  const { tv, coltTv, last } = descentStakes(ctx.seat, ctx.descentTrickNo, ctx.rowValues, ctx.roles);
  return cardId(playSmart(hand, trick, ph, ctx.n, unseen, tv, coltTv, last));
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
 * `rng` is the sampler for a summit call.
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
