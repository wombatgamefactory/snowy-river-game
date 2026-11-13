// hard.js - Hard bot: determinised Monte Carlo search with Medium rollouts. Level id 'hard'.
//
// At each real decision (a card to play):
//   1. Sample worlds consistent with what this seat can see: the cards it cannot place are dealt to the other
//      hands honouring every suit a seat has shown it lacks (the engine's dealRespectingVoids, the same deal
//      as determinise()); the cards out of play are whatever is left; the Climb row and the cards taken so
//      far are public; the Brumby row that the summit will lay out is the top six of the unseen Brumby
//      cards in a random order (the deck's order is hidden; once the descent has begun the row is face up).
//   2. In EACH world, play every candidate card, then finish the hand with the Medium policy for EVERY seat
//      (this one included): Medium's card play (play_smart, each trick valued by the row card it takes, the
//      bad ones ducked). The rollout runs on a compact copy of the world (card indices, no events or
//      records), which tests/bots.mjs checks against the real engine playing the same policy.
//   3. Score a rollout by the final-score margin: my running total plus this hand's score (Climb cards and
//      Brumby cards) minus the best rival's. An action's score is the mean over worlds. The same worlds
//      serve every candidate (common random numbers), so the comparison is paired and much less noisy.
//   4. On the last hand of the game the end-of-game result is a minor term: HARD_WIN_BONUS for a sole win,
//      half of it for a tie on total, minus it for a loss.
//
// v6 has no summit choice and no Chase / Watch, so a decision is always a card.
//
// It reads only its view. It draws from the rng it is given (so a game is reproducible from a seed) and
// never reads a clock: the cost of a decision is bounded by a fixed budget of rollouts, not by time.
// It runs in the UI's Web Worker (src/ui/bot-worker.js imports the registry; nothing to change there).

import {
  legalActionsFromView, shownVoids, unknownCards, unseenBrumbies, dealRespectingVoids, forkRng, shuffle,
  climbCardValue, brumbyValue, SUITS,
} from '../engine/index.js';
import { chooseMediumFromView } from './medium.js';
import {
  UP, DOWN, TRUMP_UP, TRUMP_DOWN, cardIndex, cardSuitIndex, playSmart, stakes, trickWinnerIndex,
} from './smart-core.js';

// ---- tuning constants ------------------------------------------------------------------------------------
/** Worlds sampled per decision when there are few candidates (the nominal sample count). */
export const HARD_SAMPLES = 200;
/** Fewest worlds per decision, however many candidates there are. */
export const HARD_MIN_SAMPLES = 48;
/** Cap on rollouts per decision (worlds x candidates): keeps a decision well under 250 ms at 5 players in Node. */
export const HARD_MAX_ROLLOUTS = 2400;
/** Margin points added to the score of the action Medium would choose (a prior that damps sampling noise). */
export const HARD_MEDIUM_PRIOR = 0.1;
/** Margin points for winning the whole game outright (half if tied on total, negative if lost); last hand only. */
export const HARD_WIN_BONUS = 0.25;

/** How many worlds to sample for this many candidate actions. */
export function samplesFor(candidates, maxRollouts = HARD_MAX_ROLLOUTS) {
  return Math.max(HARD_MIN_SAMPLES, Math.min(HARD_SAMPLES, Math.floor(maxRollouts / Math.max(1, candidates))));
}

// ---- the compact world -----------------------------------------------------------------------------------
// ph: 'climb' | 'descent' | 'over'. Cards are indices (smart-core.js). Hands keep the order the engine would
// show a bot: display suit order, then the number ascending on the climb and descending on the descent.

const HAND_RANK = [0, 1, 2, 4, 3]; // Python suit id (escape, climb, descent, home, muster) -> display rank
const climbOrder = (a, b) => (HAND_RANK[cardSuitIndex(a)] - HAND_RANK[cardSuitIndex(b)]) || ((a % 12) - (b % 12));
const descentOrder = (a, b) => (HAND_RANK[cardSuitIndex(a)] - HAND_RANK[cardSuitIndex(b)]) || ((b % 12) - (a % 12));

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** The best row value after each position (Python colt_tv base); -99 after the last. */
function bestAfter(values) {
  return values.map((_, i) => {
    let m = -99;
    for (let j = i + 1; j < values.length; j++) if (values[j] > m) m = values[j];
    return m;
  });
}

function makeWorld({ n, ph, hands, trick, leader, played, climbN, descN, cv, bv, climbVals, rowVals }) {
  return { n, ph, hands, trick, leader, played, climbN, descN, cv, bv, climbVals, rowVals, cbAfter: bestAfter(rowVals) };
}

/**
 * The compact world of a complete engine-shaped state (a determinised world, or a real state in tests).
 * @param {object} st
 */
export function worldFromState(st) {
  const played = new Uint8Array(60);
  for (const t of st.tricks) for (const p of t.plays) played[cardIndex(p.card)] = 1;
  const trick = st.trick ? st.trick.plays.map((p) => cardIndex(p.card)) : [];
  for (const c of trick) played[c] = 1;
  const rowIds = st.phase === 'climb' ? st.brumbyDeck.slice(0, st.params.rowSize) : st.rowDealt;
  return makeWorld({
    n: st.n,
    ph: st.phase,
    hands: st.hands.map((h) => h.map(cardIndex)),
    trick,
    leader: st.trick ? st.trick.leader : st.leader,
    played,
    climbN: st.climbTrickNo,
    descN: st.descentTrickNo,
    cv: st.climbCards.map((k) => sum(k.map(climbCardValue))),
    bv: st.kept.map((k) => sum(k.map(brumbyValue))),
    climbVals: st.climbRowDealt.map(climbCardValue),
    rowVals: rowIds.map(brumbyValue),
  });
}

/** A copy a rollout can change without touching the original. */
export function cloneWorld(w) {
  return { ...w, hands: w.hands.map((h) => h.slice()), trick: w.trick.slice(), played: w.played.slice(), cv: w.cv.slice(), bv: w.bv.slice() };
}

/**
 * What a decision needs from the view, computed once and reused for every sampled world.
 * @param {object} view
 */
function samplerFor(view) {
  const n = view.n;
  const me = view.seat;
  const pool = unknownCards(view).map(cardIndex);
  const voids = shownVoids(view).map((v) => new Set(v));
  const others = Array.from({ length: n }, (_, s) => s).filter((s) => s !== me);
  const need = Array.from({ length: n }, (_, s) => (s === me ? 0 : view.handCounts[s]));
  const unseenB = unseenBrumbies(view);
  const played = new Uint8Array(60);
  for (const t of view.tricks) for (const p of t.plays) played[cardIndex(p.card)] = 1;
  const trick = view.trick ? view.trick.plays.map((p) => cardIndex(p.card)) : [];
  for (const c of trick) played[c] = 1;
  const myHand = view.hand.map(cardIndex);
  const common = {
    n,
    ph: view.phase,
    trick,
    leader: view.trick ? view.trick.leader : view.leader,
    climbN: view.climbTrickNo,
    descN: view.descentTrickNo,
    cv: view.climbValue.slice(),
    bv: view.keptValue.slice(),
    climbVals: view.climbRowValues.slice(),
  };
  const known = view.phase === 'descent' ? view.rowDealt.map(brumbyValue) : null;
  const suitName = (ci) => SUITS[cardSuitIndex(ci)];
  const sort = view.phase === 'descent' ? descentOrder : climbOrder;
  /** One world: the same draws, in the same order, as the engine's determinise(view, rng). */
  return (rng) => {
    const dealt = dealRespectingVoids(pool, need, voids, rng, others, suitName);
    forkRng(rng); // determinise() forks the world's own rng here; keep the stream identical
    const deck = shuffle(rng, unseenB.slice());
    const hands = dealt.hands.map((h, s) => (s === me ? myHand.slice() : h.sort(sort)));
    return makeWorld({
      ...common,
      hands,
      trick: common.trick.slice(),
      played: played.slice(),
      cv: common.cv.slice(),
      bv: common.bv.slice(),
      rowVals: known || deck.slice(0, view.params.rowSize).map(brumbyValue),
    });
  };
}

/** The seat to play next in a world. */
const toActOf = (w) => (w.leader + w.trick.length) % w.n;

function finishTrick(w) {
  const down = w.ph === 'descent';
  const wi = trickWinnerIndex(w.trick, down ? TRUMP_DOWN : TRUMP_UP, down ? DOWN : UP);
  const winner = (w.leader + wi) % w.n;
  w.trick = [];
  w.leader = winner;
  if (!down) {
    w.cv[winner] += w.climbVals[w.climbN];
    w.climbN++;
    if (w.climbN >= w.climbVals.length) {
      w.ph = 'descent';
      w.hands = w.hands.map((h) => h.slice().sort(descentOrder)); // R1.4: the hand turns to descent order at the summit
    }
    return;
  }
  w.bv[winner] += w.rowVals[w.descN];
  w.descN++;
  if (w.descN >= w.rowVals.length) w.ph = 'over';
}

function playCard(w, seat, c) {
  const h = w.hands[seat];
  h.splice(h.indexOf(c), 1);
  w.trick.push(c);
  w.played[c] = 1;
  if (w.trick.length === w.n) finishTrick(w);
}

/** Medium's card for `seat` in this world (the policy of every rollout seat). */
function mediumCard(w, seat) {
  const hand = w.hands[seat];
  const unseen = () => {
    const u = new Uint8Array(60);
    u.fill(1, 0, w.n === 5 ? 60 : 48);
    for (let ci = 0; ci < 60; ci++) if (w.played[ci]) u[ci] = 0;
    for (const c of hand) u[c] = 0;
    return u;
  };
  if (w.ph === 'climb') {
    const { tv } = stakes(UP, w.climbN, w.climbVals);
    return playSmart(hand, w.trick, UP, w.n, unseen, tv);
  }
  const { tv, coltTv, last } = stakes(DOWN, w.descN, w.rowVals);
  return playSmart(hand, w.trick, DOWN, w.n, unseen, tv, coltTv, last);
}

/** Plays the rest of the hand with the rollout policy for every seat. */
export function playOut(w) {
  while (w.ph !== 'over') playCard(w, toActOf(w), mediumCard(w, toActOf(w)));
  return w;
}

/** Hand scores by seat from a finished world (R7.1: Climb card values plus Brumby card values taken). */
export function handScores(w) {
  return w.cv.map((c, s) => c + w.bv[s]);
}

// ---- the search ------------------------------------------------------------------------------------------
/** The view without the earlier hands' trick detail (scores are all a rollout needs from them). */
function lightView(view) {
  return { ...view, handLog: view.handLog.map((h) => ({ ...h, tricks: [] })) };
}

/**
 * Margin of seat `me` after the hand: its running total minus the best rival's; on the last hand a small
 * bonus for the win, from the totals.
 */
function marginOf(scores, totals, me, lastHand, bonus) {
  let best = -Infinity;
  for (let s = 0; s < scores.length; s++) if (s !== me && totals[s] + scores[s] > best) best = totals[s] + scores[s];
  const margin = totals[me] + scores[me] - best;
  if (!lastHand) return margin;
  return margin + (margin > 0 ? bonus : margin < 0 ? -bonus : bonus / 2);
}

const sameAction = (a, b) => a.type === b.type && a.card === b.card;

/**
 * The best action by mean margin; exposes the scores for tests and tuning.
 * @param {object} view
 * @param {{s:number}} rng
 * @param {{ samples?:number|null, prior?:number, maxRollouts?:number, priorAction?:(view:object, rng:{s:number})=>object }} [opts]
 *   samples: worlds to sample (default samplesFor(candidates));
 *   prior: margin points added to the action Medium would choose;
 *   priorAction: the choice that gets the prior (default: what Medium would choose).
 */
export function searchAction(view, rng, { samples = null, prior = HARD_MEDIUM_PRIOR, maxRollouts = HARD_MAX_ROLLOUTS, priorAction = chooseMediumFromView } = {}) {
  const legal = legalActionsFromView(view);
  if (legal.length === 1) return { action: legal[0], scores: [0] };
  const me = view.seat;
  const nWorlds = samples === null ? samplesFor(legal.length, maxRollouts) : samples;
  const sums = legal.map(() => 0);
  const light = lightView(view);
  const sample = samplerFor(light);
  const lastHand = view.handNo + 1 >= view.params.handsPerGame;
  const cards = legal.map((a) => cardIndex(a.card));
  for (let k = 0; k < nWorlds; k++) {
    const base = sample(rng);
    for (let i = 0; i < legal.length; i++) {
      const w = cloneWorld(base);
      playCard(w, me, cards[i]);
      playOut(w);
      sums[i] += marginOf(handScores(w), view.totals, me, lastHand, HARD_WIN_BONUS);
    }
  }
  const priorChoice = prior ? priorAction(view, forkRng(rng)) : null;
  let bestIndex = 0;
  let bestScore = -Infinity;
  const scores = sums.map((sum_, i) => sum_ / nWorlds + (priorChoice && sameAction(legal[i], priorChoice) ? prior : 0));
  for (let i = 0; i < legal.length; i++) {
    if (scores[i] > bestScore) { bestScore = scores[i]; bestIndex = i; }
  }
  return { action: legal[bestIndex], scores };
}

/** Exposed for tests: the sampler of a view (one compact world per call, the same draws as determinise). */
export const worldSampler = samplerFor;

export const hardBot = {
  id: 'hard',
  label: 'Hard',
  chooseAction(view, rng) {
    return searchAction(view, rng).action;
  },
};
