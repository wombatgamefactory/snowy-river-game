// conformance.mjs - replays the Python fixtures (tests/fixtures/python-conformance.json, made by a
// script outside the repo that drives the original Python simulator unchanged with random legal play)
// through the JS engine, and requires identical results: the seat to play and the size of the legal
// option set at every card, every trick winner, the summit trick, the player at the heels, the hand
// scores, whether the mob came home, the next hand's mob, the game totals and the top-total seats.
// Every game is replayed twice: learner style (every card clicked, legal sets compared at every
// play) and with forced cards auto-played (the recorded plays must match the auto events).
// Known Python differences (D1 ... D5): D1 / D2 deals were skipped by the generator; D2 in a
// single hand that starts at the cap is checked as the cap (the rules give 11 where the Python gives
// 13); D4 (no tiebreak in the Python) compares the Python winners with tiedOnTotal; D5 first dealer 0.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { readFileSync } from 'node:fs';
import { startGame, applyAction, getValidActions, fullDeck, isCardPhase } from '../src/engine/index.js';
import { suite } from './lib.mjs';

const { check, done } = suite('conformance');
const FX = JSON.parse(readFileSync(new URL('./fixtures/python-conformance.json', import.meta.url), 'utf8'));
const DECK = fullDeck(); // fixture alphabet index = fullDeck() index (suit id x 12 + rank - 1)
const card = (ch) => DECK[FX.alphabet.indexOf(ch)];
const hex = (s) => [...s].map((c) => parseInt(c, 16));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let mismatches = 0;
const firstFew = [];
function bad(id, what) {
  mismatches++;
  if (firstFew.length < 12) firstFew.push(`${id}: ${what}`);
}

/**
 * Plays one recorded hand on `state` (at the start of that hand). Returns the handLog record or null.
 * @param {boolean} manual  every card is an explicit action (legal sets compared at every play)
 */
function playHand(state, fh, id, manual) {
  const plays = [...fh.p].map(card);
  const seats = [...fh.s].map(Number);
  const legalN = hex(fh.l);
  const choices = [...fh.c].map((c) => (c === 'C' ? 'chase' : 'watch'));
  const handNo = state.handNo;
  let i = 0;
  let guard = 0;
  while (state.handLog.length === handNo && state.toAct !== null && guard++ < 400) {
    if (state.phase === 'summit') {
      applyAction(state, { type: 'summit', choice: choices[state.toAct] });
      continue;
    }
    if (!isCardPhase(state.phase)) { bad(id, `resting in phase ${state.phase}`); return null; }
    if (i >= plays.length) { bad(id, `JS asks for a card after the ${plays.length} the Python played`); return null; }
    if (state.toAct !== seats[i]) { bad(id, `play ${i}: JS seat ${state.toAct} to act, Python seat ${seats[i]}`); return null; }
    const legal = getValidActions(state);
    if (manual && legal.length !== legalN[i]) bad(id, `play ${i}: ${legal.length} legal cards in JS, ${legalN[i]} in Python`);
    if (!legal.some((a) => a.card === plays[i])) { bad(id, `play ${i}: ${plays[i]} is not legal in JS`); return null; }
    const evs = applyAction(state, { type: 'play', card: plays[i] });
    for (const e of evs) {
      if (e.type !== 'card-played' || e.handNo !== handNo) continue;
      if (e.card !== plays[i] || e.seat !== seats[i]) { bad(id, `play ${i}: JS played ${e.seat}:${e.card}, Python ${seats[i]}:${plays[i]}`); return null; }
      i++;
    }
  }
  if (i !== plays.length) bad(id, `JS played ${i} cards, Python ${plays.length}`);
  const rec = state.handLog[handNo];
  if (!rec) { bad(id, 'the hand did not end'); return null; }
  const winners = rec.tricks.map((t) => t.winner).join('');
  if (winners !== fh.w) bad(id, `trick winners JS ${winners}, Python ${fh.w}`);
  if (rec.summitTrick !== fh.k) bad(id, `summit trick JS ${rec.summitTrick}, Python ${fh.k}`);
  if (!same(rec.choices, choices)) bad(id, 'choices');
  if (!same(rec.climbTricks, hex(fh.y))) bad(id, `climb tricks JS ${rec.climbTricks}, Python ${hex(fh.y)}`);
  const heels = rec.heelsSeat === null ? -1 : rec.heelsSeat;
  if (heels !== fh.e) bad(id, `heels JS ${heels}, Python ${fh.e}`);
  if (fh.x !== '' && !same(rec.descentTricks, hex(fh.x))) bad(id, `descent tricks JS ${rec.descentTricks}, Python ${hex(fh.x)}`);
  if (fh.x === '' && rec.endReason !== 'nobody-chases') bad(id, 'Python had no descent; JS did');
  if (rec.mobValue !== fh.m) bad(id, `mob JS ${rec.mobValue}, Python ${fh.m}`);
  if (!same(rec.scores, fh.r)) bad(id, `scores JS ${rec.scores}, Python ${fh.r}`);
  if ((rec.broughtHomeBy !== null) !== (fh.t === 1)) bad(id, `mob home JS ${rec.broughtHomeBy}, Python ${fh.t}`);
  return rec;
}

const hands = (fh) => fh.h.map((s) => [...s].map(card));
const allSeats = (n) => Array.from({ length: n }, (_, s) => s);

let games = 0; let gameDeals = 0; let singles = 0; let plays = 0; let d2Capped = 0; let d4Ties = 0; let replays = 0;
for (const manual of [true, false]) {
  for (const fg of FX.games) {
    replays++;
    const id = `${fg.id}${manual ? '' : ' (auto)'}`;
    const state = startGame({ seed: `fx:${fg.id}`, players: fg.n, firstDealer: fg.firstDealer, deals: fg.hands.map((fh) => ({ hands: hands(fh) })), manualSeats: manual ? allSeats(fg.n) : [] }).state;
    let ok = true;
    for (const fh of fg.hands) {
      if (state.dealer !== fh.d) { bad(id, `dealer JS ${state.dealer}, Python ${fh.d}`); ok = false; break; }
      if (!playHand(state, fh, `${id} hand ${state.handNo}`, manual)) { ok = false; break; }
      // the Python's next mob is the JS mob at the next deal (D2 cannot occur in a standard game)
      if (state.phase !== 'over' && state.mob !== fh.nm) bad(id, `next mob JS ${state.mob}, Python ${fh.nm}`);
      if (manual) plays += fh.p.length;
    }
    if (!ok) continue;
    if (state.phase !== 'over') { bad(id, 'the game did not end after the Python\'s hands'); continue; }
    if (!same(state.result.totals, fg.totals)) bad(id, `totals JS ${state.result.totals}, Python ${fg.totals}`);
    if (!same(state.result.tiedOnTotal, fg.winners)) bad(id, `top total JS ${state.result.tiedOnTotal}, Python winners ${fg.winners}`);
    if (manual) { games++; gameDeals += fg.hands.length; if (fg.winners.length > 1) d4Ties++; }
  }
  for (const fh of FX.hands) {
    replays++;
    const id = `${fh.id}${manual ? '' : ' (auto)'}`;
    const state = startGame({ seed: `fx:${fh.id}`, players: fh.n, firstDealer: fh.d, deals: [{ hands: hands(fh) }], startBrumbies: fh.stack, manualSeats: manual ? allSeats(fh.n) : [] }).state;
    const rec = playHand(state, fh, id, manual);
    if (!rec) continue;
    const pyStack = (fh.nm - FX.cfg.mob0) / FX.cfg.roll;
    if (fh.d2) {
      // D2: the Python has no cap and gives 13; the rules stop the stack at 4 (mob 11).
      if (!(pyStack === 5 && rec.brumbiesAfter === 4 && rec.brumbyAtCap)) bad(id, `D2 cap: JS stack ${rec.brumbiesAfter}, Python ${pyStack}`);
      if (manual) d2Capped++;
    } else if (rec.brumbiesAfter !== pyStack) bad(id, `stack after JS ${rec.brumbiesAfter}, Python ${pyStack}`);
    if (manual) { singles++; plays += fh.p.length; }
  }
}

console.log(`  fixture: ${FX.generator}`);
console.log(`  replayed ${games} games (${gameDeals} deals) and ${singles} single hands, ${plays} recorded card plays, twice (learner and auto-play): ${replays} replays`);
console.log(`  generator skipped: D1 ${FX.skipped.D1}, D2 games ${FX.skipped.D2_games}; single hands at the cap checked as the cap (D2): ${d2Capped}; games tied on the top total (D4, compared on tiedOnTotal): ${d4Ties}`);
for (const f of firstFew) console.log(`  mismatch ${f}`);
check('conformance: the fixture has about 300 deals per player count', [2, 3, 4, 5].every((n) => FX.counts[n].gameDeals >= 290));
check('conformance: every recorded game and hand replays with zero mismatches', mismatches === 0, `${mismatches} mismatches`);
check('conformance: the 4-Brumby cap is exercised against the Python (D2 single hands)', d2Capped > 0);
done();
