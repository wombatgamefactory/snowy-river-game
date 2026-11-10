// archetypes.js - simulator-only reference bots (offered: false, never in the UI menus). They are the v5
// Python simulator's style x policy combinations (sim/snowy-river-sim-v5.py: `styles` for card play,
// `pols` for the summit), so balance runs can reproduce the concept's tables and measure the real levels
// against fixed reference opponents.
//
//   card play  smart = Medium's card play (play_smart)
//              naive = Whist habits: lead high, win cheaply, dump the lowest card, ignore the row (play_naive)
//   summit     always  = chase every time           never = watch every time
//              random  = a fair coin                nothing = chase only with no climb tricks (Python "zero")
//              quick   = chase with 2+ strong cards for the descent (Python "quick")
//              smart   = the Monte Carlo call Medium makes
//
// Registered ids (all offered: false):
//   always   smart cards, always chase          never    smart cards, never chase
//   random   smart cards, coin-flip summit      nothing  smart cards, chase only with nothing to lose
//   quick    smart cards, chase with 2+ strong descent cards
//   naive    naive cards, smart (Monte Carlo) summit    (the Python's "play" mode: naive v smart play)
//   naive-random   naive cards, coin-flip summit        (the Python's "one full-smart bot v naive + random summit")
// `makeArchetype(style, policy)` builds any other pairing.
//
// Two kit-era probes also stay registered because the simulator kit seats them:
//   high   always plays the highest legal card by the value that counts now; a fair coin at the summit.
//   low    always plays the lowest legal card; a fair coin at the summit.

import { legalActionsFromView, rngNext, valueIn } from '../engine/index.js';
import { buildContext, cardChoice, summitCall } from './medium.js';
import { cardIndex, quick } from './smart-core.js';

/** The summit side a policy picks: true = chase. `ctx` is only needed for the Monte Carlo. */
function chases(policy, view, ctx, rng) {
  if (policy === 'always') return true;
  if (policy === 'never') return false;
  if (policy === 'random') return rngNext(rng) < 0.5;
  if (policy === 'nothing') return view.climbTricks[view.seat] === 0;
  if (policy === 'quick') return quick(view.hand.map(cardIndex));
  return summitCall(ctx).chase;
}

/** @param {'smart'|'naive'} style @param {'always'|'never'|'random'|'nothing'|'quick'|'smart'} policy */
export function makeArchetype(style, policy, id = `${style}-${policy}`, label = `${style} cards, ${policy} summit`) {
  return {
    id,
    label,
    offered: false,
    style,
    policy,
    chooseAction(view, rng) {
      const legal = legalActionsFromView(view);
      if (legal.length === 1) return legal[0];
      const ctx = buildContext(view, view.seat, view.hand, view.handCounts, rng, { style });
      if (view.phase === 'summit') {
        const want = chases(policy, view, ctx, rng) ? 'chase' : 'watch'; // once: the call may draw from the rng
        return legal.find((a) => a.choice === want);
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
export const quickBot = makeArchetype('smart', 'quick', 'quick', 'Chase with strong descent cards');
export const naiveBot = makeArchetype('naive', 'smart', 'naive', 'Naive card play');
export const naiveRandomBot = makeArchetype('naive', 'random', 'naive-random', 'Naive cards, coin-flip summit');

function byValue(id, label, pick) {
  return {
    id,
    label,
    offered: false,
    chooseAction(view, rng) {
      const legal = legalActionsFromView(view);
      if (legal.length === 1) return legal[0];
      if (view.phase === 'summit') {
        const want = rngNext(rng) < 0.5 ? 'chase' : 'watch'; // drawn once, not per candidate
        return legal.find((a) => a.choice === want);
      }
      const sign = pick === 'high' ? 1 : -1;
      return legal.reduce((b, a) => (sign * (valueIn(a.card, view.half) - valueIn(b.card, view.half)) > 0 ? a : b));
    },
  };
}

export const highBot = byValue('high', 'Always high', 'high');
export const lowBot = byValue('low', 'Always low', 'low');

export const archetypeBots = [alwaysBot, neverBot, randomSummitBot, nothingBot, quickBot, naiveBot, naiveRandomBot, highBot, lowBot];
