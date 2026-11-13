// medium.js - Medium bot. Level id 'medium'. The v6 Python simulator's "smart" card play, ported decision for
// decision (sim/snowy-river-sim-v6.py: play_smart; the line-by-line port is in smart-core.js). v6 has no
// summit choice, so card play is all there is.
//
//   climb lead:     the cheapest card nothing unseen can beat in its suit; else the card worth least to keep
//   climb follow:   the cheapest card that beats the trick as it stands; else the card worth least to keep
//   a trick worth nothing or less (the Climb -1, Flint stones, a Wombat hole) it tries to LOSE: it leads its
//   weakest card, or follows with the strongest card that still loses
//   descent:        the same, but each trick is valued by the Brumby card it takes; a trick worth 3 or more
//                   (the Colt) is won with the highest card that wins when it can still be overtaken, and the
//                   seat saves its strongest card for a better trick still to come
//
// Medium is deterministic: no rng. It reads only what a seat may see: its own hand, this hand's public
// tricks and the current trick, and the face-up rows (the Climb row as dealt, the Brumby row once dealt).
//
// The decision is a pure function of plain data (mediumChoose), so the SAME code serves the real bot (from
// a view) and Hard's rollouts (from a full state, no viewFor per step). It returns one of the legal actions
// it was given.

import { legalActionsFromView, getValidActions, climbCardValue, brumbyValue } from '../engine/index.js';
import {
  UP, DOWN, cardIndex, cardId, playSmart, playNaive, stakes, unseenFlags,
} from './smart-core.js';

const cardsOf = (tricks) => {
  const out = [];
  for (const t of tricks) for (const p of t.plays) out.push(p.card);
  return out;
};

/**
 * The plain-data context of one decision.
 * @param {object} src   a view or a full state (both carry n, phase, trick, tricks, climbRowDealt, rowDealt, climbTrickNo, descentTrickNo)
 * @param {string[]} hand        the seat's cards, in the order that breaks ties (the view's hand order)
 * @param {{ style?:'smart'|'naive' }} [opts]
 */
export function buildContext(src, hand, opts = {}) {
  return {
    n: src.n,
    phase: src.phase,
    hand,
    trickCards: src.trick ? src.trick.plays.map((p) => p.card) : [],
    played: cardsOf(src.tricks),
    climbTrickNo: src.climbTrickNo,
    descentTrickNo: src.descentTrickNo,
    climbValues: src.climbRowDealt.map(climbCardValue),
    rowValues: src.rowDealt.map(brumbyValue),
    style: opts.style || 'smart',
  };
}

/** The card the Python's style `ctx.style` plays here (an id). */
export function cardChoice(ctx) {
  const ph = ctx.phase === 'descent' ? DOWN : UP;
  const hand = ctx.hand.map(cardIndex);
  const trick = ctx.trickCards.map(cardIndex);
  if (ctx.style === 'naive') return cardId(playNaive(hand, trick, ph));
  const unseen = () => unseenFlags(ctx.n, ctx.played, ctx.hand, ctx.trickCards); // built only if this is a lead
  const i = ph === UP ? ctx.climbTrickNo : ctx.descentTrickNo;
  const { tv, coltTv, last } = stakes(ph, i, ph === UP ? ctx.climbValues : ctx.rowValues);
  return cardId(playSmart(hand, trick, ph, ctx.n, unseen, tv, coltTv, last));
}

/**
 * @param {object} ctx   buildContext()
 * @param {{type:string, card?:string}[]} legal
 */
export function mediumChoose(ctx, legal) {
  if (legal.length === 1) return legal[0];
  const card = cardChoice(ctx);
  return legal.find((a) => a.card === card);
}

/** The Medium choice from a view (what the real bot sees). `rng` is accepted and unused (Medium is deterministic). */
export function chooseMediumFromView(view, _rng, opts = {}) {
  return mediumChoose(buildContext(view, view.hand, opts), legalActionsFromView(view));
}

/** The Medium choice for the seat to act in a full state (Hard's engine-side checks; no view is built). */
export function mediumActionFromState(st, opts = {}) {
  return mediumChoose(buildContext(st, st.hands[st.toAct], opts), getValidActions(st));
}

export const mediumBot = {
  id: 'medium',
  label: 'Medium',
  chooseAction(view, rng) {
    return chooseMediumFromView(view, rng);
  },
};
