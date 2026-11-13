// archetypes.js - simulator-only bots (offered: false). T3 PLACEHOLDER (v6 engine, 13/11/2026).
//
// v6 has no summit choice, so the v5 summit archetypes (always, never, random, nothing, quick, naive-random)
// are gone. What is left until task T4 ports the Python's naive card play:
//   naive   PLACEHOLDER: a random legal card (T4: the Python play_naive, Whist habits)
//   high    the legal card with the highest number (first in hand order on a tie)
//   low     the legal card with the lowest number
// makeArchetype(style, policy, id, label) is kept for importers; it returns a random-card bot.

import { legalActionsFromView, rngPick, cardNumber } from '../engine/index.js';

export function makeArchetype(style, policy, id = `${style}-${policy}`, label = `${style} cards`) {
  return {
    id,
    label,
    offered: false,
    chooseAction(view, rng) {
      return rngPick(rng, legalActionsFromView(view));
    },
  };
}

export const naiveBot = makeArchetype('naive', 'none', 'naive', 'Naive card play');

function byNumber(id, label, high) {
  return {
    id,
    label,
    offered: false,
    chooseAction(view) {
      const acts = legalActionsFromView(view);
      let best = acts[0];
      for (const a of acts) {
        const d = cardNumber(a.card) - cardNumber(best.card);
        if (high ? d > 0 : d < 0) best = a;
      }
      return best;
    },
  };
}

export const highBot = byNumber('high', 'Always high', true);
export const lowBot = byNumber('low', 'Always low', false);

export const archetypeBots = [naiveBot, highBot, lowBot];
