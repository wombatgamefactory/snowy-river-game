// hard.js - Hard bot. Level id 'hard'. STAND-IN for now.
//
// The earlier Hard bot searched with Medium rollouts under the previous rules. Until it is rewritten for
// v5 (determinised Monte Carlo over the unseen cards with v5 Medium rollouts) this level plays exactly
// like Easy: a uniformly random legal action. searchAction keeps its earlier shape ({ action }) so tests/sim.mjs and tests/bots-lib.mjs
// still load and run.

import { legalActionsFromView, rngPick } from '../engine/index.js';

export const HARD_SAMPLES = 40;
export const HARD_MIN_SAMPLES = 6;
export const HARD_MAX_ROLLOUTS = 400;

/** Placeholder: worlds per decision for a number of candidates. */
export function samplesFor(candidates, maxRollouts = HARD_MAX_ROLLOUTS) {
  return Math.max(HARD_MIN_SAMPLES, Math.min(HARD_SAMPLES, Math.floor(maxRollouts / Math.max(1, candidates))));
}

/** Placeholder: a random legal action, as { action, scores: null }. */
export function searchAction(view, rng) {
  return { action: rngPick(rng, legalActionsFromView(view)), scores: null };
}

export const hardBot = {
  id: 'hard',
  label: 'Hard',
  chooseAction(view, rng) {
    return searchAction(view, rng).action;
  },
};
