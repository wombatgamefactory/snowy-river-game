// smoke.mjs - Easy bots only: 1000 games at each of 2, 3 and 4 players (there are no variants).
// Every game must terminate, with zero refused bot actions, legalActionsFromView = getValidActions
// at every decision, card conservation of the 48 playing cards and the 12 Brumby cards after every
// action (R11.1, R11.2), every player to act holding a card, the state JSON round-tripping (play
// continues on the parsed copy), and the game's own invariants: 6 climb + 6 descent tricks every hand
// (R4.1, R6), a hand of 12 (R3.1), the row 6 cards (R5.4), hand scores per R7 with the chase cost by
// count (R5.7), 12 tricks a hand (R7.6), the Brumby deck reshuffled only when fewer than 6 are left
// (R8.4), no hidden choice in any other seat's view before the reveal (R10.6), no summit-chosen event
// naming a side. The same seed must give an identical game.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import {
  startGame, applyAction, getValidActions, getActionBlockReason, viewFor, legalActionsFromView,
  makeRng, deriveSeed, isCardPhase, brumbyValue,
} from '../src/engine/index.js';
import { getBot } from '../src/bots/index.js';
import { suite, conservation } from './lib.mjs';

const { check, done } = suite('smoke');
const GAMES = 1000;
const MAX_ACTIONS_PER_GAME = 2000; // a game is under 250 decisions; near this is a livelock
const ROUND_TRIP_EVERY_STEP_GAMES = 30; // per run: the first N games round-trip after every action; the rest after every hand
const COST = { 2: 3, 3: 2, 4: 2 };
const HANDS = { 2: 3, 3: 3, 4: 4 };

/** Plays a game with Easy bots; returns counters. */
function playOut(players, seed, everyStep) {
  const r = { refusals: 0, actions: 0, roundTripBad: 0, viewBad: 0, consBad: 0, consProblem: '', emptyToAct: 0, invariantBad: 0, invariantProblem: '', over: false, events: [] };
  const bad = (msg) => { r.invariantBad++; if (!r.invariantProblem) r.invariantProblem = msg; };
  const started = startGame({ seed, players });
  let state = started.state;
  r.events.push(...started.events);
  const rngs = Array.from({ length: players }, (_, s) => makeRng(deriveSeed(seed, 'bot', s)));
  {
    const c = conservation(state);
    if (!c.ok) { r.consBad++; r.consProblem = c.problem; }
    if (state.hands.some((h) => h.length !== 12)) bad('a hand of other than 12 cards');
  }
  let deckBeforeEnd = null;
  while (state.toAct !== null && r.actions < MAX_ACTIONS_PER_GAME) {
    const seat = state.toAct;
    if (isCardPhase(state.phase) && state.hands[seat].length === 0) r.emptyToAct++;
    if (state.phase === 'summit' && state.choices[seat] !== null) bad('a seat asked twice at the summit');
    if (!['climb', 'summit', 'descent'].includes(state.phase)) bad(`resting in phase ${state.phase}`);
    if (state.phase === 'climb' && state.handsTurned) bad('hands turned on the climb');
    if (state.phase !== 'climb' && !state.handsTurned) bad('hands not turned after the summit');
    const view = viewFor(state, seat);
    if (JSON.stringify(legalActionsFromView(view)) !== JSON.stringify(getValidActions(state))) r.viewBad++;
    if (!state.revealed) {
      for (let s = 0; s < players; s++) if (s !== seat && view.choices[s] !== null) bad('a hidden choice leaked into a view');
    }
    if (JSON.stringify(view).includes('"brumbyDeck"')) bad('the Brumby deck order is in a view');
    const action = getBot('easy').chooseAction(view, rngs[seat]);
    if (getActionBlockReason(state, action) !== null) { r.refusals++; break; }
    const handBefore = state.handNo;
    deckBeforeEnd = state.brumbyDeck.length;
    const evs = applyAction(state, action);
    r.events.push(...evs);
    r.actions++;
    for (const e of evs) {
      if (e.type === 'summit-chosen' && /chase|watch/.test(JSON.stringify(e))) bad('summit-chosen names a side');
      if (e.type === 'summit-opened' && (e.row.length !== 6 || e.trickNo !== 6 || e.climbTricks.reduce((a, b) => a + b, 0) !== 6)) bad(`summit after ${e.trickNo} tricks, row of ${e.row.length}`);
      if (e.type === 'brumby-reshuffled' && (deckBeforeEnd >= 6 || e.deckCount !== 12)) bad(`reshuffle with ${deckBeforeEnd} left (R8.4)`);
      if (e.type === 'hand-started' && e.handNo > 0 && e.deckCount < 6) bad(`a hand starts with ${e.deckCount} Brumby cards in the deck`);
      if (e.type === 'hand-ended') {
        if (e.climbTricks.reduce((a, b) => a + b, 0) !== 6 || e.descentTricks.reduce((a, b) => a + b, 0) !== 6) bad('not 6 + 6 tricks');
        if (e.row.length !== 6) bad('row not 6');
        e.breakdown.forEach((b) => {
          const keptValue = b.kept.reduce((a, id) => a + brumbyValue(id), 0);
          const want = b.tricks + (b.choice === 'chase' ? keptValue - COST[players] : 0);
          if (b.score !== want || (b.choice === 'watch' && b.kept.length) || b.tricks !== b.climbTricks + b.descentTricks) bad(`R7 score ${JSON.stringify(b)}`);
        });
        const sum = e.scores.reduce((a, b) => a + b, 0);
        const formula = 12 + e.breakdown.reduce((a, b) => a + (b.choice === 'chase' ? b.keptValue - COST[players] : 0), 0);
        if (sum !== formula) bad(`R7.6 sum ${sum} vs ${formula}`);
        if (e.reshuffled !== (e.handNo % 2 === 0)) bad(`hand ${e.handNo} reshuffled ${e.reshuffled}`); // R8.5: hands 1 and 3 start a shuffle
      }
    }
    const c = conservation(state);
    if (!c.ok) { r.consBad++; r.consProblem = r.consProblem || c.problem; }
    if (everyStep || state.handNo !== handBefore || state.toAct === null) {
      const text = JSON.stringify(state);
      const copy = JSON.parse(text);
      if (JSON.stringify(copy) !== text) r.roundTripBad++;
      state = copy; // continue on the round-tripped copy
    }
  }
  r.over = state.phase === 'over' && state.result !== null && state.handLog.length === HANDS[players];
  r.state = state;
  return r;
}

function run(label, players, games = GAMES) {
  let refusals = 0; let unfinished = 0; let rt = 0; let view = 0; let cons = 0; let firstProblem = ''; let actions = 0; let shared = 0; let tiebreaks = 0; let empty = 0; let inv = 0; let invProblem = '';
  let nobody = 0; let hands = 0; let colts = 0; let trumpWins = 0; let tricks = 0;
  for (let i = 0; i < games; i++) {
    const r = playOut(players, deriveSeed('smoke', label, i), i < ROUND_TRIP_EVERY_STEP_GAMES);
    refusals += r.refusals; rt += r.roundTripBad; view += r.viewBad; cons += r.consBad; actions += r.actions; empty += r.emptyToAct; inv += r.invariantBad;
    if (!firstProblem && r.consProblem) firstProblem = r.consProblem;
    if (!invProblem && r.invariantProblem) invProblem = r.invariantProblem;
    if (!r.over) unfinished++;
    else {
      shared += r.state.result.shared; tiebreaks += r.state.result.tiebreakUsed;
      const m = r.state.measures;
      nobody += m.nobodyChased; hands += m.hands; colts += m.coltRows; trumpWins += m.trumpWins; tricks += m.tricks;
      if (m.nobodyChased !== m.chaserCounts[0]) inv++;
    }
  }
  check(`${label}: ${games} games terminate`, unfinished === 0, `${unfinished} unfinished`);
  check(`${label}: zero refused bot actions`, refusals === 0, `${refusals}`);
  check(`${label}: legalActionsFromView = getValidActions at every decision`, view === 0, `${view}`);
  check(`${label}: card and Brumby conservation after every action`, cons === 0, `${cons}: ${firstProblem}`);
  check(`${label}: the player to act always holds a card`, empty === 0, `${empty}`);
  check(`${label}: state JSON round-trips`, rt === 0, `${rt}`);
  check(`${label}: the game's invariants (6 + 6 tricks, row, R7 scores, reshuffles, hidden choices)`, inv === 0, `${inv}: ${invProblem}`);
  console.log(`  ${label}: ${games} games, ${(actions / games).toFixed(0)} decisions/game, nobody chased ${(100 * nobody / hands).toFixed(0)}% of hands, Colt in ${(100 * colts / hands).toFixed(0)}% of rows, trump wins ${(100 * trumpWins / tricks).toFixed(0)}% of tricks, shared wins ${shared}, tiebreaks ${tiebreaks}`);
}

const t0 = process.hrtime.bigint();
for (const n of [2, 3, 4]) run(`std ${n}p`, n);

// R1.9: 5 players (and 1, 6) are refused
check('5 players are rejected (R1.9)', [1, 5, 6].every((n) => { try { startGame({ seed: 1, players: n }); return false; } catch (e) { return /2 to 4 players/.test(e.message); } }));

// Determinism: same seed, same game (state and events).
{
  const once = (seed) => { const r = playOut(4, seed, false); return JSON.stringify([r.state, r.events]); };
  check('same seed -> identical game (state and events)', once('det-1') === once('det-1'));
  check('different seed -> different game', once('det-1') !== once('det-2'));
}
console.log(`  smoke time ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s`);
done();
