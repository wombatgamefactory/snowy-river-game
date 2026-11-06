// archetypes.js - simulator-only reference bots (offered: false, never in the UI menus). They are the
// Python simulator's style x policy combinations (sim/snowy-river-sim.py: `styles` for card play,
// `policies` for the summit) so balance runs can reproduce the concept's tables and measure the real
// levels against fixed reference opponents.
//
//   card play  smart  = Medium's card play        naive = win cheaply but dump the LOW cards early
//   summit     always  = chase every time         never = watch every time
//              random  = a fair coin              nothing = chase only with no climb tricks to lose
//              smart   = the Monte Carlo call Medium makes
//
// Registered ids (all offered: false):
//   always   smart cards, always chase            never    smart cards, never chase
//   random   smart cards, coin-flip summit        nothing  smart cards, chase only with nothing to lose
//   naive    naive cards, smart (Monte Carlo) summit   (the Python's "play" mode: naive v smart play)
//   naive-random   naive cards, coin-flip summit       (the Python's "one full-smart bot v naive + random summit")
// `makeArchetype(style, policy)` builds any other pairing.
//
// Two kit-era probes also stay registered because tests/sim-check.mjs seats them:
//   high   always plays the highest legal card; a fair coin at the summit.
//   low    always plays the lowest legal card; a fair coin at the summit.

import { legalActionsFromView, rngNext, cardValue } from '../engine/index.js';
import { buildContext, cardChoice, summitCall } from './medium.js';

/** @param {'smart'|'naive'} style @param {'always'|'never'|'random'|'nothing'|'smart'} policy */
export function makeArchetype(style, policy, id = `${style}-${policy}`, label = `${style} cards, ${policy} summit`) {
  return {
    id,
    label,
    offered: false,
    chooseAction(view, rng) {
      const legal = legalActionsFromView(view);
      if (legal.length === 1) return legal[0];
      const ctx = buildContext(view, view.seat, view.hand, view.handCounts, rng, { style });
      if (view.phase === 'summit') {
        let chase;
        if (policy === 'always') chase = true;
        else if (policy === 'never') chase = false;
        else if (policy === 'random') chase = rngNext(rng) < 0.5;
        else if (policy === 'nothing') chase = view.climbTricks[view.seat] === 0;
        else chase = summitCall(ctx).chase;
        return legal.find((a) => a.choice === (chase ? 'chase' : 'watch'));
      }
      const card = cardChoice(ctx);
      return legal.find((a) => a.card === card);
    },
  };
}

export const alwaysBot = makeArchetype('smart', 'always', 'always', 'Always chase');
export const neverBot = makeArchetype('smart', 'never', 'never', 'Never chase');
export const randomSummitBot = makeArchetype('smart', 'random', 'random', 'Coin-flip summit');
export const nothingBot = makeArchetype('smart', 'nothing', 'nothing', 'Chase with nothing to lose');
export const naiveBot = makeArchetype('naive', 'smart', 'naive', 'Naive card play');
export const naiveRandomBot = makeArchetype('naive', 'random', 'naive-random', 'Naive cards, coin-flip summit');

function byValue(id, label, pick) {
  return {
    id,
    label,
    offered: false,
    chooseAction(view, rng) {
      const legal = legalActionsFromView(view);
      if (view.phase === 'summit') return legal[rngNext(rng) < 0.5 ? 0 : 1];
      return [...legal].sort((a, b) => cardValue(a.card) - cardValue(b.card))[pick === 'high' ? legal.length - 1 : 0];
    },
  };
}

export const highBot = byValue('high', 'Always high', 'high');
export const lowBot = byValue('low', 'Always low', 'low');

export const archetypeBots = [alwaysBot, neverBot, randomSummitBot, nothingBot, naiveBot, naiveRandomBot, highBot, lowBot];
