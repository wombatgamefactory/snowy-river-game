// hard.js - Hard bot: determinised Monte Carlo search with Medium rollouts. Level id 'hard'.
//
// At each real decision (a card to play, or the secret Chase / Watch choice at the summit):
//   1. Sample worlds consistent with what this seat can see (engine determinise()): the cards it cannot
//      place are dealt to the other hands honouring every suit a seat has shown it lacks; the cards out
//      of play are whatever is left; the Brumby deck is the unseen Brumby cards in a random order (so
//      before the summit the coming row is sampled too). A seat that has already locked in its summit
//      choice gets a side guessed from the hand it holds in the world (chase with 2+ strong descent
//      cards, the Python's `quick`); seats still to choose are asked in turn by the rollout.
//   2. In EACH world, play every candidate action, then finish the hand with the Medium policy for EVERY
//      seat (this one included): Medium's card play (play_smart, with the row-card stakes on the descent)
//      and, at the summit, the `quick` guess for whoever has not chosen. The rollout runs on a compact
//      copy of the world (card indices, no events or records), which tests/bots.mjs checks against the
//      real engine playing the same policy.
//   3. Score a rollout by the final-score margin: my running total minus the best rival's once the hand
//      is scored (tricks, kept Brumby cards and the Chase cost included). An action's score is the mean
//      over worlds. The same worlds serve every candidate (common random numbers), so the comparison is
//      paired and much less noisy.
//   4. On the last hand of the game the end-of-game result is a minor term: HARD_WIN_BONUS for a sole win,
//      half of it for a tie on total, minus it for a loss.
//
// It reads only its view. It draws from the rng it is given (so a game is reproducible from a seed) and
// never reads a clock: the cost of a decision is bounded by a fixed budget of rollouts, not by time.
// It runs in the UI's Web Worker (src/ui/bot-worker.js imports the registry; nothing to change there).

import { determinise, legalActionsFromView, forkRng, brumbyValue } from '../engine/index.js';
import { chooseMediumFromView } from './medium.js';
import {
  UP, DOWN, TRUMP_UP, TRUMP_DOWN, cardIndex, cardSuitIndex, playSmart, trickValue, trickWinnerIndex, quick,
} from './smart-core.js';

// ---- tuning constants ------------------------------------------------------------------------------------
/** Worlds sampled per decision when there are few candidates (the nominal sample count). */
export const HARD_SAMPLES = 100;
/** Fewest worlds per decision, however many candidates there are. */
export const HARD_MIN_SAMPLES = 24;
/** Cap on rollouts per decision (worlds x candidates): keeps a decision well under 250 ms at 4 players in Node. */
export const HARD_MAX_ROLLOUTS = 1200;
/** Margin points added to the score of the action Medium would choose (a prior that damps sampling noise). */
export const HARD_MEDIUM_PRIOR = 0.1;
/** Margin points for winning the whole game outright (half if tied on total, negative if lost); last hand only. */
export const HARD_WIN_BONUS = 0.25;

/** How many worlds to sample for this many candidate actions. */
export function samplesFor(candidates, maxRollouts = HARD_MAX_ROLLOUTS) {
  return Math.max(HARD_MIN_SAMPLES, Math.min(HARD_SAMPLES, Math.floor(maxRollouts / candidates)));
}

// ---- the compact world -----------------------------------------------------------------------------------
// ph: 'climb' | 'summit' | 'descent' | 'over'. Cards are indices (smart-core.js). Hands keep the order the
// engine would show a bot: climb value order until the summit, descent value order after it.

const descentOrder = (a, b) => (cardSuitIndex(a) - cardSuitIndex(b)) || ((b % 12) - (a % 12)); // suit, then ascending descent value (13 - v)

/**
 * The compact world of a complete engine-shaped state (a determinised world, or a real state in tests).
 * @param {object} st
 */
export function worldFromState(st) {
  const n = st.n;
  const played = new Uint8Array(48);
  for (const t of st.tricks) for (const p of t.plays) played[cardIndex(p.card)] = 1;
  const trick = st.trick ? st.trick.plays.map((p) => cardIndex(p.card)) : [];
  for (const c of trick) played[c] = 1;
  const inClimb = st.phase === 'climb';
  const rowIds = st.phase === 'climb' ? st.brumbyDeck.slice(0, st.params.rowSize) : st.rowDealt;
  const brum = st.kept.map((k) => k.reduce((a, id) => a + brumbyValue(id), 0));
  const w = {
    n,
    ph: st.phase,
    hands: st.hands.map((h) => h.map(cardIndex)),
    trick,
    leader: st.trick ? st.trick.leader : st.leader,
    played,
    climbN: st.marker,
    descN: st.descentTrickNo,
    cl: [...st.climbTricks],
    de: [...st.descentTricks],
    rowValues: rowIds.map(brumbyValue),
    roles: st.choices.map((c) => (c === null ? null : c === 'chase')),
    brum,
    cost: st.params.chaseCost,
    order: inClimb ? [] : [...st.choiceOrder],
    anych: false,
    cbAfter: null,
  };
  if (w.ph === 'descent') prepareDescent(w);
  return w;
}

/** A copy a rollout can change without touching the original. */
export function cloneWorld(w) {
  return {
    ...w,
    hands: w.hands.map((h) => h.slice()),
    trick: w.trick.slice(),
    played: w.played.slice(),
    cl: w.cl.slice(),
    de: w.de.slice(),
    roles: w.roles.slice(),
    brum: w.brum.slice(),
  };
}

/** The best row value still to come after each descent trick (the Python's colt_tv base); -99 after the last. */
function prepareDescent(w) {
  const rv = w.rowValues;
  w.anych = w.roles.some(Boolean);
  w.cbAfter = rv.map((_, i) => {
    let m = -99;
    for (let j = i + 1; j < rv.length; j++) if (rv[j] > m) m = rv[j];
    return m;
  });
}

/** The seat whose turn it is (a summit chooser, or the next card player); null when over. */
function toActOf(w) {
  if (w.ph === 'over') return null;
  if (w.ph === 'summit') {
    for (const s of w.order) if (w.roles[s] === null) return s;
    return null;
  }
  return (w.leader + w.trick.length) % w.n;
}

function openSummit(w, winner) {
  w.ph = 'summit';
  w.hands = w.hands.map((h) => h.slice().sort(descentOrder));
  w.order = Array.from({ length: w.n }, (_, k) => (winner + k) % w.n);
  w.leader = winner;
}

function finishTrick(w) {
  const down = w.ph === 'descent';
  const wi = trickWinnerIndex(w.trick, down ? TRUMP_DOWN : TRUMP_UP, down ? DOWN : UP);
  const winner = (w.leader + wi) % w.n;
  w.trick = [];
  w.leader = winner;
  if (!down) {
    w.cl[winner]++;
    w.climbN++;
    if (w.climbN >= 6) openSummit(w, winner);
    return;
  }
  w.de[winner]++;
  if (w.roles[winner]) w.brum[winner] += w.rowValues[w.descN];
  w.descN++;
  if (w.descN >= 6) w.ph = 'over';
}

/** Applies an action (the shape the engine uses) for the seat to act. */
function applyFast(w, action) {
  const seat = toActOf(w);
  if (action.type === 'summit') {
    w.roles[seat] = action.choice === 'chase';
    if (toActOf(w) === null) { w.ph = 'descent'; prepareDescent(w); }
    return;
  }
  const c = cardIndex(action.card);
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
    const u = new Uint8Array(48);
    for (let ci = 0; ci < 48; ci++) u[ci] = w.played[ci] ? 0 : 1;
    for (const c of hand) u[c] = 0;
    return u;
  };
  if (w.ph === 'climb') return playSmart(hand, w.trick, UP, w.n, unseen);
  const i = w.descN;
  const tv = trickValue(seat, w.rowValues[i], w.roles, w.anych);
  const cb = w.cbAfter[i];
  const ctv = cb > -99 ? trickValue(seat, cb, w.roles, w.anych) : -99;
  return playSmart(hand, w.trick, DOWN, w.n, unseen, tv, ctv, i === 5);
}

/** Plays the rest of the hand with the rollout policy for every seat. */
export function playOut(w) {
  while (w.ph !== 'over') {
    if (w.ph === 'summit') {
      for (const s of w.order) if (w.roles[s] === null) w.roles[s] = quick(w.hands[s]);
      w.ph = 'descent';
      prepareDescent(w);
      continue;
    }
    const seat = (w.leader + w.trick.length) % w.n;
    const c = mediumCard(w, seat);
    const h = w.hands[seat];
    h.splice(h.indexOf(c), 1);
    w.trick.push(c);
    w.played[c] = 1;
    if (w.trick.length === w.n) finishTrick(w);
  }
  return w;
}

/** Hand scores by seat from a finished world (R7: tricks; a chaser adds its kept Brumby values and pays the cost). */
export function handScores(w) {
  return w.cl.map((c, s) => c + w.de[s] + (w.roles[s] ? w.brum[s] - w.cost : 0));
}

// ---- the search ------------------------------------------------------------------------------------------
/** The view without the earlier hands' trick detail (the sampler copies it every world; scores are all a rollout needs). */
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

const sameAction = (a, b) => a.type === b.type && a.card === b.card && a.choice === b.choice;

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
  const lastHand = view.handNo + 1 >= view.params.handsPerGame;
  for (let k = 0; k < nWorlds; k++) {
    const st = determinise(light, rng);
    if (!view.revealed) { // a locked-in seat's hidden side: guessed from the hand it holds in this world
      for (let s = 0; s < view.n; s++) if (s !== me && st.choices[s] !== null) st.choices[s] = quick(st.hands[s].map(cardIndex)) ? 'chase' : 'watch';
    }
    const base = worldFromState(st);
    for (let i = 0; i < legal.length; i++) {
      const w = cloneWorld(base);
      applyFast(w, legal[i]);
      playOut(w);
      sums[i] += marginOf(handScores(w), view.totals, me, lastHand, HARD_WIN_BONUS);
    }
  }
  const priorChoice = prior ? priorAction(view, forkRng(rng)) : null;
  let bestIndex = 0;
  let bestScore = -Infinity;
  const scores = sums.map((sum, i) => sum / nWorlds + (priorChoice && sameAction(legal[i], priorChoice) ? prior : 0));
  for (let i = 0; i < legal.length; i++) {
    if (scores[i] > bestScore) { bestScore = scores[i]; bestIndex = i; }
  }
  return { action: legal[bestIndex], scores };
}

export const hardBot = {
  id: 'hard',
  label: 'Hard',
  chooseAction(view, rng) {
    return searchAction(view, rng).action;
  },
};
