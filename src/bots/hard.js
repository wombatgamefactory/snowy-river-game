// hard.js - Hard bot, level id 'hard'. T3 PLACEHOLDER (v6 engine, 13/11/2026): it PLAYS LIKE EASY (a random
// legal card) until task T4 writes the v6 search (determinised Monte Carlo over the unseen cards with
// Medium rollouts, choosing by expected final-score margin; spec R12.4).
//
// The exports below are kept so every importer still loads (tests/bots.mjs, tests/bots-lib.mjs,
// tests/sim.mjs). searchAction returns { action, scores: null }; the rollout helpers throw "not ported".
// It runs in the UI's Web Worker (src/ui/bot-worker.js imports the registry; nothing to change there).

import { legalActionsFromView, rngPick } from '../engine/index.js';

export const HARD_SAMPLES = 100;
export const HARD_MIN_SAMPLES = 24;
export const HARD_MAX_ROLLOUTS = 1200;
export const HARD_MEDIUM_PRIOR = 0.1;
export const HARD_WIN_BONUS = 0.25;

const notPorted = (name) => () => { throw new Error(`hard.js ${name}: not ported to v6 yet (task T4)`); };

/** Worlds per candidate for a rollout budget (kept from v5; harmless arithmetic). */
export function samplesFor(candidates, maxRollouts = HARD_MAX_ROLLOUTS) {
  if (candidates <= 1) return 0;
  return Math.max(HARD_MIN_SAMPLES, Math.min(HARD_SAMPLES, Math.floor(maxRollouts / candidates)));
}

export const worldFromState = notPorted('worldFromState');
export const cloneWorld = notPorted('cloneWorld');
export const playOut = notPorted('playOut');
export const handScores = notPorted('handScores');

/** PLACEHOLDER: a random legal action, no scores. */
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
