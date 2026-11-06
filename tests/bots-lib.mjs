// bots-lib.mjs - helpers shared by tests/bots.mjs and its strength workers (tests/bots-worker.mjs):
// bot lookup (including the reduced-budget Hard names), a bot-v-bot game with legality accounting,
// and a block of strength games (one strong seat against copies of one opponent level).

import {
  createGame, applyAction, viewFor, legalActionsFromView, getActionBlockReason, makeRng, deriveSeed,
} from '../src/engine/index.js';
import { getBot } from '../src/bots/index.js';
import { searchAction } from '../src/bots/hard.js';

/** A bot by level name. `hard-fast` = Hard with 2 worlds; `hard:N` = Hard with N worlds; anything else = the registry. */
export const botOf = (level) => {
  if (level === 'hard-fast') return { id: level, chooseAction: (view, rng) => searchAction(view, rng, { samples: 2 }).action };
  if (/^hard:\d+$/.test(level)) return { id: level, chooseAction: (view, rng) => searchAction(view, rng, { samples: Number(level.slice(5)) }).action };
  return getBot(level);
};
export const sameAction = (a, b) => a.type === b.type && a.card === b.card && a.choice === b.choice;

/** Plays one game; `levels[seat]` names each seat's bot. */
export function playGame({ levels, seed, rules = {}, checkView = true }) {
  const players = levels.length;
  const state = createGame({ seed, players, rules });
  const rngs = Array.from({ length: players }, (_, s) => makeRng(deriveSeed(seed, 'bot', s)));
  const bots = levels.map(botOf);
  let refusals = 0; let illegal = 0; let mutated = 0; let actions = 0;
  while (state.toAct !== null && actions < 3000) {
    const seat = state.toAct;
    const view = viewFor(state, seat);
    const before = checkView ? JSON.stringify(view) : null;
    const act = bots[seat].chooseAction(view, rngs[seat]);
    if (checkView && JSON.stringify(view) !== before) mutated++;
    if (!legalActionsFromView(view).some((a) => sameAction(a, act))) illegal++;
    if (getActionBlockReason(state, act) !== null) { refusals++; break; }
    applyAction(state, act, { silent: true });
    actions++;
  }
  return { state, refusals, illegal, mutated, actions, over: state.phase === 'over' && state.result !== null };
}

/**
 * Games `from` .. `to - 1` of a strength run: the strong level sits in seat i mod n of game i, everyone
 * else plays `opp`. Shared wins count 1 / winners. Returns the sums (so blocks can be added up).
 */
export function strengthBlock({ strong, opp, n, from, to, tag }) {
  let credit = 0; let marginSum = 0;
  for (let i = from; i < to; i++) {
    const strongSeat = i % n;
    const r = playGame({ levels: Array.from({ length: n }, (_, s) => (s === strongSeat ? strong : opp)), seed: deriveSeed(tag, n, i), checkView: false });
    const res = r.state.result;
    if (res.winners.includes(strongSeat)) credit += 1 / res.winners.length;
    marginSum += res.totals[strongSeat] - Math.max(...res.totals.filter((_, s) => s !== strongSeat));
  }
  return { credit, marginSum, games: to - from };
}

/** Sums of blocks -> win rate, mean margin and the z-score of the win rate against the fair share 1 / n. */
export function strengthResult(n, blocks) {
  const games = blocks.reduce((a, b) => a + b.games, 0);
  const credit = blocks.reduce((a, b) => a + b.credit, 0);
  const marginSum = blocks.reduce((a, b) => a + b.marginSum, 0);
  const win = credit / games;
  const z = (win - 1 / n) / Math.sqrt((1 / n) * (1 - 1 / n) / games);
  return { win, margin: marginSum / games, z, credit, games };
}
