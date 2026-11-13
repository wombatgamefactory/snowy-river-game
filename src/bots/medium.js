// medium.js - Medium bot, level id 'medium'. T3 PLACEHOLDER (v6 engine, 13/11/2026): it PLAYS LIKE EASY
// (a random legal card) until task T4 ports the v6 Python "smart" card play (sim/snowy-river-sim-v6.py
// play_smart: each trick valued by the row card it takes, the -1 ducked, the best later card saved for).
//
// The exports below are kept so every importer still loads (tests/bots.mjs, tests/sim.mjs, archetypes.js,
// hard.js). The v5 helpers that have no v6 meaning yet throw "not ported". v6 has no summit decision, so
// summitCall is gone for good once T4 lands; it throws here.

import { legalActionsFromView, getValidActions, rngPick } from '../engine/index.js';

/** Kept for importers; v6 Medium has no summit sampling (spec R12.4). */
export const MEDIUM_SAMPLES = 0;

const notPorted = (name) => () => { throw new Error(`medium.js ${name}: not ported to v6 yet (task T4)`); };

export const buildContext = notPorted('buildContext');
export const summitCall = notPorted('summitCall');
export const cardChoice = notPorted('cardChoice');
export const mediumChoose = notPorted('mediumChoose');

/** PLACEHOLDER: a random legal action from the view. */
export function chooseMediumFromView(view, rng = { s: 1 }) {
  return rngPick(rng, legalActionsFromView(view));
}

/** PLACEHOLDER: a random legal action from a full state (Hard's rollouts). */
export function mediumActionFromState(st, rng) {
  return rngPick(rng, getValidActions(st));
}

export const mediumBot = {
  id: 'medium',
  label: 'Medium',
  chooseAction(view, rng) {
    return chooseMediumFromView(view, rng);
  },
};
