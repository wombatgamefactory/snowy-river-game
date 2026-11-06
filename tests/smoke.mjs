// smoke.mjs - Easy bots only: 1000 games at each of 2, 3, 4 and 5 players (there are no variants).
// Every game must terminate, with zero refused bot actions, legalActionsFromView = getValidActions
// at every decision, card conservation after every action (R13.1), every player to act holding a
// card in the climb and the descent, the state JSON round-tripping (play continues on the parsed
// copy), and the game's own invariants: the summit always comes with enough cards left (R4.11), the
// descent always has tricks (R7.9), the fallback summit never fires, the Brumby stack stays 0..4 and
// the mob at most 11 (R10.3), hand scores follow R9, and no summit-chosen event names a side.
// The same seed must give an identical game.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import {
  startGame, applyAction, getValidActions, getActionBlockReason, viewFor, legalActionsFromView,
  makeRng, deriveSeed, isCardPhase,
} from '../src/engine/index.js';
import { getBot } from '../src/bots/index.js';
import { suite, conservation } from './lib.mjs';

const { check, done } = suite('smoke');
const GAMES = 1000;
const MAX_ACTIONS_PER_GAME = 2000; // a game is well under 400 decisions; near this is a livelock
const ROUND_TRIP_EVERY_STEP_GAMES = 30; // per run: the first N games round-trip after every action; the rest after every hand
const MIN_LEFT = { 2: 5, 3: 5, 4: 4, 5: 3 }; // R4.11 / R7.9

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
  }
  while (state.toAct !== null && r.actions < MAX_ACTIONS_PER_GAME) {
    const seat = state.toAct;
    if (isCardPhase(state.phase) && state.hands[seat].length === 0) r.emptyToAct++;
    if (state.phase === 'summit' && state.choices[seat] !== null) bad('a seat asked twice at the summit');
    if (!['climb', 'summit', 'descent'].includes(state.phase)) bad(`resting in phase ${state.phase}`);
    const view = viewFor(state, seat);
    if (JSON.stringify(legalActionsFromView(view)) !== JSON.stringify(getValidActions(state))) r.viewBad++;
    if (state.phase === 'summit' && !state.revealed) {
      for (let s = 0; s < players; s++) if (s !== seat && view.choices[s] !== null) bad('a hidden choice leaked into a view');
    }
    const action = getBot('easy').chooseAction(view, rngs[seat]);
    if (getActionBlockReason(state, action) !== null) { r.refusals++; break; }
    const handBefore = state.handNo;
    const evs = applyAction(state, action);
    r.events.push(...evs);
    r.actions++;
    for (const e of evs) {
      if (e.type === 'summit-reached' && e.cardsLeft < MIN_LEFT[players]) bad(`summit with ${e.cardsLeft} cards left`);
      if (e.type === 'summit-chosen' && /chase|watch/.test(JSON.stringify(e))) bad('summit-chosen names a side');
      if (e.type === 'hand-ended') {
        if (e.endReason === 'descent' && e.descentTricksPlayed < MIN_LEFT[players]) bad(`descent of ${e.descentTricksPlayed} tricks`);
        if (e.mobValue > 11 || e.brumbiesAfter > 4) bad(`mob ${e.mobValue}, stack ${e.brumbiesAfter}`);
        e.breakdown.forEach((b) => {
          const want = b.outcome === 'watched' ? b.climbTricks : b.outcome === 'home' ? b.climbTricks + e.mobValue : -1;
          if (b.score !== want || (b.outcome === 'home') !== (b.choice === 'chase' && e.broughtHomeBy === b.seat) || (b.outcome === 'fell') !== (b.choice === 'chase' && e.broughtHomeBy !== b.seat)) bad(`R9 score ${JSON.stringify(b)}`);
        });
        if (e.endReason === 'nobody-chases' && (e.chasers !== 0 || e.heelsSeat !== null)) bad('nobody-chases record');
        if (e.endReason === 'descent' && e.chasers === 0) bad('descent with no chaser');
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
  if (state.measures.forcedSummits !== 0) bad('the fallback summit fired');
  r.over = state.phase === 'over' && state.result !== null && state.handLog.length === state.params.handsPerGame;
  r.state = state;
  return r;
}

function run(label, players, games = GAMES) {
  let refusals = 0; let unfinished = 0; let rt = 0; let view = 0; let cons = 0; let firstProblem = ''; let actions = 0; let shared = 0; let tiebreaks = 0; let empty = 0; let inv = 0; let invProblem = '';
  let nobody = 0; let homes = 0; let hands = 0; let capHits = 0; let heelsTies = 0;
  for (let i = 0; i < games; i++) {
    const r = playOut(players, deriveSeed('smoke', label, i), i < ROUND_TRIP_EVERY_STEP_GAMES);
    refusals += r.refusals; rt += r.roundTripBad; view += r.viewBad; cons += r.consBad; actions += r.actions; empty += r.emptyToAct; inv += r.invariantBad;
    if (!firstProblem && r.consProblem) firstProblem = r.consProblem;
    if (!invProblem && r.invariantProblem) invProblem = r.invariantProblem;
    if (!r.over) unfinished++;
    else {
      shared += r.state.result.shared; tiebreaks += r.state.result.tiebreakUsed;
      const m = r.state.measures;
      nobody += m.nobodyChased; if (m.nobodyChased !== m.chaserCounts[0]) inv++; homes += m.mobsHome; hands += m.hands; capHits += m.brumbyCapHits; heelsTies += m.tieAtHeels;
    }
  }
  check(`${label}: ${games} games terminate`, unfinished === 0, `${unfinished} unfinished`);
  check(`${label}: zero refused bot actions`, refusals === 0, `${refusals}`);
  check(`${label}: legalActionsFromView = getValidActions at every decision`, view === 0, `${view}`);
  check(`${label}: card conservation after every action`, cons === 0, `${cons}: ${firstProblem}`);
  check(`${label}: the player to act always holds a card`, empty === 0, `${empty}`);
  check(`${label}: state JSON round-trips`, rt === 0, `${rt}`);
  check(`${label}: the game's invariants (summit, descent, Brumby cap, R9 scores, hidden choices)`, inv === 0, `${inv}: ${invProblem}`);
  console.log(`  ${label}: ${games} games, ${(actions / games).toFixed(0)} decisions/game, nobody chased ${(100 * nobody / hands).toFixed(0)}% of hands, mob home ${(100 * homes / hands).toFixed(0)}%, heels ties ${heelsTies}, cap hits ${capHits}, shared wins ${shared}, tiebreaks ${tiebreaks}`);
}

const t0 = process.hrtime.bigint();
for (const n of [2, 3, 4, 5]) run(`std ${n}p`, n);

// Determinism: same seed, same game (state and events).
{
  const once = (seed) => { const r = playOut(4, seed, false); return JSON.stringify([r.state, r.events]); };
  check('same seed -> identical game (state and events)', once('det-1') === once('det-1'));
  check('different seed -> different game', once('det-1') !== once('det-2'));
}
console.log(`  smoke time ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s`);
done();
