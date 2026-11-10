// medium.js - Medium bot. Level id 'medium'. STAND-IN for now.
//
// The earlier Medium bot followed the previous rules and no longer fits v5. Until the v5 Python smart
// bot is ported this level plays exactly like Easy: a uniformly random legal action, card or summit
// choice. The exported names below exist only so the modules that import them (tests/sim.mjs,
// tests/bots.mjs) still load; the port replaces all of them.

import { legalActionsFromView, getValidActions, rngPick } from '../engine/index.js';

/** Worlds dealt for the summit call (Python cfg["samples"] = 12). Not used by the placeholder. */
export const MEDIUM_SAMPLES = 12;

/** Placeholder: the Medium choice from a view = a random legal action. */
export function chooseMediumFromView(view, rng = { s: 1 }) {
  return rngPick(rng, legalActionsFromView(view));
}

/** Placeholder: the Medium choice for the seat to act in a full state = a random legal action. */
export function mediumActionFromState(st, rng) {
  return rngPick(rng, getValidActions(st));
}

const notYet = (name) => () => { throw new Error(`medium.js ${name}: not ported to v5 yet`); };
export const buildContext = notYet('buildContext');
export const summitCall = notYet('summitCall');
export const cardChoice = notYet('cardChoice');
export const mediumChoose = notYet('mediumChoose');

export const mediumBot = {
  id: 'medium',
  label: 'Medium',
  chooseAction(view, rng) {
    return chooseMediumFromView(view, rng);
  },
};
