// smoke.mjs - Easy bots only: 1000 games at each of 2, 3, 4 and 5 players (there are no variants).
// Every game must terminate, with zero refused bot actions, legalActionsFromView = getValidActions
// at every decision, conservation of the playing cards (48, or 60 at 5 players), the 6 Climb cards and the
// 12 Brumby cards after every action (R11.1 to R11.3), every player to act holding a card, the state JSON
// round-tripping (play continues on the parsed copy), and the game's own invariants: a hand of 12 (R3.1),
// the Muster in the deck at 5 players only (R1.2), the Climb row 6 cards 5 x +1 and 1 x -1 (R1.6), 6 climb +
// 6 descent tricks every hand (R4.1, R6), the summit after exactly 6 climb tricks with a Brumby row of 6
// (R5.3), the -1 Climb card to the winner of its trick (R4.8), hand scores = Climb values + Brumby values
// (R7.1), the sum of hand scores = 4 + the row value (R7.5), the Brumby deck reshuffled only when fewer than
// 6 are left (R8.4), hands 1, 3, 5 start a fresh shuffle (R8.5), no phase but climb / descent at rest (R5.5),
// no deck order, other hand or out card in any view (R10). The same seed must give an identical game.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import {
  startGame, applyAction, getValidActions, getActionBlockReason, viewFor, legalActionsFromView,
  makeRng, deriveSeed, isCardPhase, brumbyValue, climbCardValue, cardSuit,
} from '../src/engine/index.js';
import { getBot } from '../src/bots/index.js';
import { suite, conservation } from './lib.mjs';

const { check, done } = suite('smoke');
const GAMES = 1000;
const MAX_ACTIONS_PER_GAME = 2000; // a game is under 310 decisions; near this is a livelock
const ROUND_TRIP_EVERY_STEP_GAMES = 30; // per run: the first N games round-trip after every action; the rest after every hand
const VIEW_LEAK_EVERY_STEP_GAMES = 30; // per run: the first N games check every view for hidden cards
const HANDS = { 2: 3, 3: 3, 4: 4, 5: 5 };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Plays a game with Easy bots; returns counters. */
function playOut(players, seed, everyStep) {
  const r = { refusals: 0, actions: 0, roundTripBad: 0, viewBad: 0, consBad: 0, consProblem: '', emptyToAct: 0, invariantBad: 0, invariantProblem: '', over: false, events: [] };
  const bad = (msg) => { r.invariantBad++; if (!r.invariantProblem) r.invariantProblem = msg; };
  const started = startGame({ seed, players });
  let state = started.state;
  r.events.push(...started.events);
  const rngs = Array.from({ length: players }, (_, s) => makeRng(deriveSeed(seed, 'bot', s)));
  const checkDeal = () => {
    if (state.hands.some((h) => h.length !== 12)) bad('a hand of other than 12 cards');
    const muster = state.hands.flat().concat(state.out).some((c) => cardSuit(c) === 'muster');
    if (muster !== (players === 5)) bad(`Muster in the deck at ${players} players: ${muster}`);
    const cv = state.climbRow.map(climbCardValue).sort();
    if (state.climbRow.length !== 6 || cv.join() !== '-1,1,1,1,1,1') bad(`Climb row ${state.climbRow.join(' ')}`);
  };
  {
    const c = conservation(state);
    if (!c.ok) { r.consBad++; r.consProblem = c.problem; }
    checkDeal();
  }
  let deckBeforeEnd = null;
  while (state.toAct !== null && r.actions < MAX_ACTIONS_PER_GAME) {
    const seat = state.toAct;
    if (isCardPhase(state.phase) && state.hands[seat].length === 0) r.emptyToAct++;
    if (!['climb', 'descent'].includes(state.phase)) bad(`resting in phase ${state.phase}`);
    if (state.phase === 'climb' && state.row.length) bad('a Brumby row on the climb');
    if (state.phase === 'descent' && state.climbRow.some((x) => x !== null)) bad('Climb cards left on the descent');
    const view = viewFor(state, seat);
    if (JSON.stringify(legalActionsFromView(view)) !== JSON.stringify(getValidActions(state))) r.viewBad++;
    if (everyStep) {
      // earlier hands' public trick logs (handLog) name cards that this hand re-dealt, so they are left out
      const text = JSON.stringify({ ...view, handLog: null });
      if (text.includes('"brumbyDeck"')) bad('the Brumby deck order is in a view');
      for (let s = 0; s < players; s++) if (s !== seat) for (const c of state.hands[s]) if (text.includes(`"${c}"`)) bad(`another seat's card ${c} is in a view`);
      for (const c of state.out) if (text.includes(`"${c}"`)) bad(`an out card ${c} is in a view`);
    }
    const action = getBot('easy').chooseAction(view, rngs[seat]);
    if (getActionBlockReason(state, action) !== null) { r.refusals++; break; }
    const handBefore = state.handNo;
    deckBeforeEnd = state.brumbyDeck.length;
    const evs = applyAction(state, action);
    r.events.push(...evs);
    r.actions++;
    let lastTrick = null;
    for (const e of evs) {
      if (e.type === 'trick-won') lastTrick = e;
      if (e.type === 'climb-card-taken' && (!lastTrick || lastTrick.winner !== e.winner || lastTrick.half !== 'climb' || e.position !== lastTrick.halfTrickNo)) bad('a Climb card not to its trick\'s winner');
      if (e.type === 'brumby-taken' && (!lastTrick || lastTrick.winner !== e.winner || lastTrick.half !== 'descent' || e.position !== lastTrick.halfTrickNo)) bad('a Brumby card not to its trick\'s winner');
      if (e.type === 'summit-opened' && (e.row.length !== 6 || e.trickNo !== 6 || sum(e.climbTricks) !== 6 || e.trump !== 'home' || e.direction !== 'lowest')) bad(`summit after ${e.trickNo} tricks, row of ${e.row.length}`);
      if (e.type === 'brumby-reshuffled' && (deckBeforeEnd >= 6 || e.deckCount !== 12)) bad(`reshuffle with ${deckBeforeEnd} left (R8.4)`);
      if (e.type === 'hand-started' && e.handNo > 0 && e.deckCount < 6) bad(`a hand starts with ${e.deckCount} Brumby cards in the deck`);
      if (e.type === 'hand-ended') {
        if (sum(e.climbTricks) !== 6 || sum(e.descentTricks) !== 6) bad('not 6 + 6 tricks');
        if (e.row.length !== 6 || e.climbRow.length !== 6) bad('a row not 6');
        e.breakdown.forEach((b) => {
          const cv = sum(b.climbCards.map(climbCardValue));
          const kv = sum(b.kept.map(brumbyValue));
          if (b.score !== cv + kv || b.climbValue !== cv || b.keptValue !== kv || b.climbCards.length !== b.climbTricks || b.kept.length !== b.descentTricks) bad(`R7.1 score ${JSON.stringify(b)}`);
        });
        if (sum(e.scores) !== 4 + e.rowValue) bad(`R7.5 sum ${sum(e.scores)} vs 4 + ${e.rowValue}`);
        if (e.minusWinner === null || !e.climbCards[e.minusWinner].includes('climb-minus1')) bad('R4.8 the -1 not with its trick\'s winner');
        if (e.reshuffled !== (e.handNo % 2 === 0)) bad(`hand ${e.handNo} reshuffled ${e.reshuffled}`); // R8.5: hands 1, 3, 5 start a shuffle
      }
    }
    const c = conservation(state);
    if (!c.ok) { r.consBad++; r.consProblem = r.consProblem || c.problem; }
    if (state.handNo !== handBefore && state.toAct !== null) checkDeal();
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
  let hands = 0; let colts = 0; let trumpWins = 0; let tricks = 0; let negHands = 0;
  for (let i = 0; i < games; i++) {
    const r = playOut(players, deriveSeed('smoke', label, i), i < Math.max(ROUND_TRIP_EVERY_STEP_GAMES, VIEW_LEAK_EVERY_STEP_GAMES));
    refusals += r.refusals; rt += r.roundTripBad; view += r.viewBad; cons += r.consBad; actions += r.actions; empty += r.emptyToAct; inv += r.invariantBad;
    if (!firstProblem && r.consProblem) firstProblem = r.consProblem;
    if (!invProblem && r.invariantProblem) invProblem = r.invariantProblem;
    if (!r.over) unfinished++;
    else {
      shared += r.state.result.shared; tiebreaks += r.state.result.tiebreakUsed;
      const m = r.state.measures;
      hands += m.hands; colts += m.coltRows; trumpWins += m.trumpWins; tricks += m.tricks; negHands += m.negativeHands;
      if (m.climbValueSum !== 4 * m.hands) { inv++; if (!invProblem) invProblem = `climbValueSum ${m.climbValueSum}`; }
    }
  }
  check(`${label}: ${games} games terminate`, unfinished === 0, `${unfinished} unfinished`);
  check(`${label}: zero refused bot actions`, refusals === 0, `${refusals}`);
  check(`${label}: legalActionsFromView = getValidActions at every decision`, view === 0, `${view}`);
  check(`${label}: playing card, Climb card and Brumby card conservation after every action`, cons === 0, `${cons}: ${firstProblem}`);
  check(`${label}: the player to act always holds a card`, empty === 0, `${empty}`);
  check(`${label}: state JSON round-trips`, rt === 0, `${rt}`);
  check(`${label}: the game's invariants (deal, rows, 6 + 6 tricks, R7 scores, reshuffles, views)`, inv === 0, `${inv}: ${invProblem}`);
  console.log(`  ${label}: ${games} games, ${(actions / games).toFixed(0)} decisions/game, Colt in ${(100 * colts / hands).toFixed(0)}% of rows, trump wins ${(100 * trumpWins / tricks).toFixed(0)}% of tricks, negative hand scores ${negHands}, shared wins ${shared}, tiebreaks ${tiebreaks}`);
}

const t0 = process.hrtime.bigint();
for (const n of [2, 3, 4, 5]) run(`std ${n}p`, n);

// R1.10: 2 to 5 players; 1 and 6 are refused
check('R1.10 1 and 6 players are rejected', [0, 1, 6, 7].every((n) => { try { startGame({ seed: 1, players: n }); return false; } catch (e) { return /2 to 5 players/.test(e.message); } }));
check('R1.10 2 to 5 players are accepted', [2, 3, 4, 5].every((n) => startGame({ seed: 1, players: n }).state.n === n));

// Determinism: same seed, same game (state and events).
{
  const once = (seed, n = 4) => { const r = playOut(n, seed, false); return JSON.stringify([r.state, r.events]); };
  check('same seed -> identical game (state and events)', once('det-1') === once('det-1') && once('det-5', 5) === once('det-5', 5));
  check('different seed -> different game', once('det-1') !== once('det-2'));
}
console.log(`  smoke time ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s`);
done();
