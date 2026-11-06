// hard.js - Hard bot: determinised Monte Carlo search with Medium rollouts. Level id 'hard'.
//
// At each real decision (a card to play, or the secret Chase / Watch choice at the summit):
//   1. Sample worlds consistent with what this seat can see (engine determinise()): the cards it cannot
//      place are dealt to the other hands honouring every suit a seat has shown it lacks (shownVoids);
//      the cards out of play are whatever is left. A seat that has already locked in its summit choice
//      gets a guessed side (guessChoice below); seats still to choose are asked in turn by the rollout.
//   2. In EACH world, play every candidate action, then finish the hand with the Medium policy for EVERY
//      seat (this one included), using the real engine (applyAction): the climb, the marker, the summit
//      (every other seat makes its own Chase / Watch call from its sampled hand), the descent, the heels
//      and the reckoning are all played out.
//   3. Score a rollout by the final-score margin: my running total minus the best rival's when the hand
//      ends (the reckoning of mob, falls and Brumby cards included). An action's score is the mean over
//      worlds. The same worlds serve every candidate (common random numbers), so the comparison is
//      paired and much less noisy.
//   4. On the last hand of the game the end-of-game result (totals, then the mobs-home tiebreak, then
//      shared wins, taken from the engine's gameResult) is a minor term: HARD_WIN_BONUS for a sole win,
//      half of it for a shared win, minus it for a loss.
//
// It reads only its view. It draws from the rng it is given (so a game is reproducible from a seed) and
// never reads a clock: the cost of a decision is bounded by a fixed budget of rollouts, not by time.
// It runs in the UI's Web Worker (src/ui/bot-worker.js imports the registry; nothing to change there).

import { applyAction, determinise, legalActionsFromView, forkRng } from '../engine/index.js';
import { mediumActionFromState, chooseMediumFromView } from './medium.js';

// ---- tuning constants ------------------------------------------------------------------------------------
/** Worlds sampled per decision when there are few candidates (the nominal sample count). */
export const HARD_SAMPLES = 40;
/** Fewest worlds per decision, however many candidates there are. */
export const HARD_MIN_SAMPLES = 6;
/** Cap on rollouts per decision (worlds x candidates): keeps a decision under ~250 ms at 5 players in Node. */
export const HARD_MAX_ROLLOUTS = 400;
/**
 * Worlds each seat deals for ITS OWN summit call inside a rollout (Medium itself uses 16). Every rollout makes up
 * to n summit calls, so this is the biggest cost per rollout; a few worlds are noisy but unbiased, and the noise
 * averages out over the many rollouts of a decision.
 */
export const HARD_ROLLOUT_SUMMIT_SAMPLES = 8;
/** Margin points added to the score of the action Medium would choose (a prior that damps sampling noise). */
export const HARD_MEDIUM_PRIOR = 0.15;
/** Margin points for winning the whole game outright (half if shared, negative if lost); last hand only. */
export const HARD_WIN_BONUS = 0.25;

/**
 * A copy of a determinised world that applyAction can mutate without touching the original.
 * The copy's game is cut to end with the current hand (params.handsPerGame = handNo + 1), so the
 * engine scores the hand and stops instead of dealing the next one. The trick piles are replaced by
 * empty ones: nothing in the engine reads them back (they exist for the conservation checks).
 */
function cloneWorld(s) {
  const measures = { ...s.measures };
  for (const k of Object.keys(measures)) if (Array.isArray(measures[k])) measures[k] = measures[k].slice();
  return {
    ...s,
    params: { ...s.params, handsPerGame: s.handNo + 1 },
    hands: s.hands.map((h) => h.slice()),
    climbPiles: s.climbPiles.map(() => []),
    descentPiles: s.descentPiles.map(() => []),
    climbTricks: s.climbTricks.slice(),
    descentTricks: s.descentTricks.slice(),
    lastDescentWin: s.lastDescentWin.slice(),
    choices: s.choices.slice(),
    trick: s.trick ? { ...s.trick, plays: s.trick.plays.slice() } : null,
    tricks: s.tricks.slice(),
    handLog: s.handLog.slice(),
    totals: s.totals.slice(),
    mobsHome: s.mobsHome.slice(),
    measures,
  };
}

/**
 * Plays the rest of the hand with the rollout policy for every seat; returns the margin of seat `me`.
 * `lastHand`: this is the real game's last hand, so the game result (the tiebreak) counts a little.
 */
function rollout(st, me, lastHand, policy) {
  while (st.toAct !== null) applyAction(st, policy(st), { silent: true });
  let best = -Infinity;
  for (let s = 0; s < st.n; s++) if (s !== me && st.totals[s] > best) best = st.totals[s];
  let value = st.totals[me] - best;
  if (lastHand && st.result) {
    const r = st.result;
    if (r.winners.includes(me)) value += r.winners.length === 1 ? HARD_WIN_BONUS : HARD_WIN_BONUS / 2;
    else value -= HARD_WIN_BONUS;
  }
  return value;
}

/** How many worlds to sample for this many candidate actions. */
export function samplesFor(candidates, maxRollouts = HARD_MAX_ROLLOUTS) {
  return Math.max(HARD_MIN_SAMPLES, Math.min(HARD_SAMPLES, Math.floor(maxRollouts / candidates)));
}

/** The view without the earlier hands' trick detail (the sampler copies it every world; scores are all a rollout needs). */
function lightView(view) {
  return { ...view, handLog: view.handLog.map((h) => ({ ...h, tricks: [] })) };
}

/**
 * The side a seat that has locked in but not yet shown is guessed to hold: the stakes rule Medium uses, with
 * the seat's chance of finishing at the mob's heels taken as an even 1 / n (it cannot be known from outside).
 */
function guessChoice(seat, view) {
  const climbPoints = view.climbTricks[seat] * view.params.climbTrickValue;
  const p = 1 / view.n;
  return p * view.mob > (1 - p) * (climbPoints - view.params.fallScore) ? 'chase' : 'watch';
}

const sameAction = (a, b) => a.type === b.type && a.card === b.card && a.choice === b.choice;

/**
 * The best action by mean margin; exposes the scores for tests and tuning.
 * @param {object} view
 * @param {{s:number}} rng
 * @param {{ samples?:number|null, prior?:number, policy?:(state:object, rng:{s:number})=>object, priorAction?:(view:object, rng:{s:number})=>object }} [opts]
 *   policy: the rollout policy (state -> action), default Medium with cheap summit calls;
 *   priorAction: the choice that gets the prior (default: what Medium would choose);
 *   rolloutSummitSamples, maxRollouts: the budget constants, overridable for tuning runs;
 *   guess: how a locked-in seat's hidden side is guessed (null = a fair coin).
 */
export function searchAction(view, rng, { samples = null, prior = HARD_MEDIUM_PRIOR, policy = null, priorAction = chooseMediumFromView, rolloutSummitSamples = HARD_ROLLOUT_SUMMIT_SAMPLES, maxRollouts = HARD_MAX_ROLLOUTS, guess = guessChoice } = {}) {
  const legal = legalActionsFromView(view);
  if (legal.length === 1) return { action: legal[0], scores: [0] };
  const me = view.seat;
  const nWorlds = samples === null ? samplesFor(legal.length, maxRollouts) : samples;
  const sums = legal.map(() => 0);
  const light = lightView(view);
  const lastHand = view.handNo + 1 >= view.params.handsPerGame;
  const rollRng = forkRng(rng); // the summit calls inside rollouts draw from their own stream
  const rollPolicy = policy ? (st) => policy(st, rollRng) : (st) => mediumActionFromState(st, rollRng, { samples: rolloutSummitSamples, voids: false });
  for (let w = 0; w < nWorlds; w++) {
    const world = determinise(light, rng, { guessChoice: guess });
    for (let i = 0; i < legal.length; i++) {
      const st = cloneWorld(world);
      applyAction(st, legal[i], { silent: true });
      sums[i] += rollout(st, me, lastHand, rollPolicy);
    }
  }
  const priorChoice = priorAction(view, forkRng(rng));
  let bestIndex = 0;
  let bestScore = -Infinity;
  const scores = sums.map((sum, i) => sum / nWorlds + (sameAction(legal[i], priorChoice) ? prior : 0));
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
