// archetypes.js - simulator-only reference bots (offered: false, never in the UI menus).
// STAND-INS for now: they are to be rebuilt from the v5 Python simulator's styles and policies.
// Until then card play is a random legal card for every
// archetype; only the summit policy differs:
//   always   always chase          never    always watch
//   random   a fair coin           nothing  chase only with no climb tricks
//   naive, naive-random            a fair coin (naive card play not ported yet)
//   high / low                     highest / lowest legal card by the value that counts now; a fair coin

import { legalActionsFromView, rngNext, rngPick, valueIn } from '../engine/index.js';

function summitPick(policy, view, rng) {
  if (policy === 'always') return 'chase';
  if (policy === 'never') return 'watch';
  if (policy === 'nothing') return view.climbTricks[view.seat] === 0 ? 'chase' : 'watch';
  return rngNext(rng) < 0.5 ? 'chase' : 'watch';
}

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
      if (view.phase === 'summit') {
        const want = summitPick(policy, view, rng);
        return legal.find((a) => a.choice === want);
      }
      if (style === 'high' || style === 'low') {
        const sign = style === 'high' ? 1 : -1;
        return legal.reduce((b, a) => (sign * (valueIn(a.card, view.half) - valueIn(b.card, view.half)) > 0 ? a : b));
      }
      return rngPick(rng, legal);
    },
  };
}

export const alwaysBot = makeArchetype('smart', 'always', 'always', 'Always chase');
export const neverBot = makeArchetype('smart', 'never', 'never', 'Never chase');
export const randomSummitBot = makeArchetype('smart', 'random', 'random', 'Coin-flip summit');
export const nothingBot = makeArchetype('smart', 'nothing', 'nothing', 'Chase with nothing to lose');
export const naiveBot = makeArchetype('naive', 'smart', 'naive', 'Naive card play');
export const naiveRandomBot = makeArchetype('naive', 'random', 'naive-random', 'Naive cards, coin-flip summit');
export const highBot = makeArchetype('high', 'random', 'high', 'Always high');
export const lowBot = makeArchetype('low', 'random', 'low', 'Always low');

export const archetypeBots = [alwaysBot, neverBot, randomSummitBot, nothingBot, naiveBot, naiveRandomBot, highBot, lowBot];
