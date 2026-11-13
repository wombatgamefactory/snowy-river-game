// archetypes.js - simulator-only bots (offered: false), never in the UI's seat menus. v6 has no summit
// choice, so an archetype is only a style of card play:
//
//   naive   the Python's play_naive (sim/snowy-river-sim-v6.py): Whist habits, lead your most powerful
//           card, win a trick with the cheapest winner, dump your lowest-power card; it ignores both rows
//           (never ducks a bad trick, never saves a card). The opponent the simulator measures Medium against.
//   high    the legal card with the highest number (first in hand order on a tie)   (kit probe)
//   low     the legal card with the lowest number                                     (kit probe)
//
// Pure: no clock, no global randomness; the rng argument is accepted and unused.

import { legalActionsFromView, cardNumber } from '../engine/index.js';
import { chooseMediumFromView } from './medium.js';

/** The Python's naive card play as a bot, built on medium.js's context so the port stays in one place. */
export function makeArchetype(style = 'naive', id = style, label = `${style} cards`) {
  return {
    id,
    label,
    offered: false,
    style,
    chooseAction(view, rng) {
      return chooseMediumFromView(view, rng, { style });
    },
  };
}

export const naiveBot = makeArchetype('naive', 'naive', 'Naive card play');

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
