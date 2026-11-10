// conformance.mjs - replays the Python fixtures (tests/fixtures/python-conformance.json, made by a
// script outside the repo that drives the v5 Python simulator unchanged with random legal play and random summit choices)
// through the JS engine, and requires identical results: the seat to play and the size of the legal
// option set at every card, every trick winner (climb and descent), the Brumby row (values in order,
// through the test hook `deals[h].row`), whether the row came from a fresh shuffle of all 12, the
// summit choices, climb and descent tricks, each chaser's kept Brumby values (as a multiset) and their
// sum, the hand scores, the game totals, the top-total seats and the winners after the last-hand tiebreak.
// Every game is replayed twice: learner style (every card clicked, legal sets compared at every play)
// and with forced cards auto-played (the recorded plays must match the auto events).
// Known Python differences: D4 Brumby cards are values in the Python, so rows and
// kept cards are compared by value; D5 the shuffle is not reproducible, so rows come in by the hook;
// D6 the first dealer is seat 0; D7 / D8 the choices and plays are the generator's random ones.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { readFileSync } from 'node:fs';
import { startGame, applyAction, getValidActions, fullDeck, isCardPhase, brumbyValue } from '../src/engine/index.js';
import { suite } from './lib.mjs';

const { check, done } = suite('conformance');
const FX = JSON.parse(readFileSync(new URL('./fixtures/python-conformance.json', import.meta.url), 'utf8'));
const DECK = fullDeck(); // fixture alphabet index = fullDeck() index (suit id x 12 + v - 1)
const card = (ch) => DECK[FX.alphabet.indexOf(ch)];
const hex = (s) => [...s].map((c) => parseInt(c, 16));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs) => [...xs].sort((a, b) => a - b);

let mismatches = 0;
const firstFew = [];
function bad(id, what) {
  mismatches++;
  if (firstFew.length < 12) firstFew.push(`${id}: ${what}`);
}

/** Plays one recorded hand on `state` (at the start of that hand). Returns the handLog record or null. */
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
      if (!same(state.rowDealt.map(brumbyValue), fh.row)) bad(id, `row JS ${state.rowDealt.map(brumbyValue)}, Python ${fh.row}`);
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
  if (!same(rec.choices, choices)) bad(id, 'choices');
  if (!same(rec.rowValues, fh.row)) bad(id, `row JS ${rec.rowValues}, Python ${fh.row}`);
  if (rec.reshuffled !== (fh.f === 1)) bad(id, `fresh Brumby shuffle JS ${rec.reshuffled}, Python ${fh.f}`);
  if (!same(rec.climbTricks, hex(fh.y))) bad(id, `climb tricks JS ${rec.climbTricks}, Python ${hex(fh.y)}`);
  if (!same(rec.descentTricks, hex(fh.x))) bad(id, `descent tricks JS ${rec.descentTricks}, Python ${hex(fh.x)}`);
  if (!same(rec.keptValues, fh.b)) bad(id, `kept Brumby sums JS ${rec.keptValues}, Python ${fh.b}`);
  // kept cards as multisets of values: the Python's descent winners + row + choices (D4)
  const pyKept = choices.map(() => []);
  [...fh.w.slice(6)].map(Number).forEach((w, k) => { if (choices[w] === 'chase') pyKept[w].push(fh.row[k]); });
  if (!same(rec.kept.map((k) => sorted(k.map(brumbyValue))), pyKept.map(sorted))) bad(id, `kept cards JS ${JSON.stringify(rec.kept)}, Python ${JSON.stringify(pyKept)}`);
  if (!same(rec.scores, fh.r)) bad(id, `scores JS ${rec.scores}, Python ${fh.r}`);
  return rec;
}

const hands = (fh) => fh.h.map((s) => [...s].map(card));
const allSeats = (n) => Array.from({ length: n }, (_, s) => s);

const perCount = { 2: { games: 0, deals: 0 }, 3: { games: 0, deals: 0 }, 4: { games: 0, deals: 0 } };
let plays = 0; let replays = 0; let tied = 0; let tiebreaks = 0; let nobody = 0; let colt = 0; let fresh = 0;
for (const manual of [true, false]) {
  for (const fg of FX.games) {
    replays++;
    const id = `${fg.id}${manual ? '' : ' (auto)'}`;
    let state;
    try {
      state = startGame({ seed: `fx:${fg.id}`, players: fg.n, firstDealer: fg.firstDealer, deals: fg.hands.map((fh) => ({ hands: hands(fh), row: fh.row })), manualSeats: manual ? allSeats(fg.n) : [] }).state;
    } catch (e) { bad(id, `startGame threw ${e.message}`); continue; }
    let ok = true;
    for (const fh of fg.hands) {
      if (state.dealer !== fh.d) { bad(id, `dealer JS ${state.dealer}, Python ${fh.d}`); ok = false; break; }
      let rec;
      try { rec = playHand(state, fh, `${id} hand ${state.handNo}`, manual); } catch (e) { bad(id, `threw ${e.message}`); rec = null; }
      if (!rec) { ok = false; break; }
      if (manual) { plays += fh.p.length; if (!fh.c.includes('C')) nobody++; if (fh.row.includes(4)) colt++; fresh += fh.f; }
    }
    if (!ok) continue;
    if (state.phase !== 'over') { bad(id, 'the game did not end after the Python\'s hands'); continue; }
    if (!same(state.result.totals, fg.totals)) bad(id, `totals JS ${state.result.totals}, Python ${fg.totals}`);
    if (!same(state.result.tiedOnTotal, fg.tied)) bad(id, `top total JS ${state.result.tiedOnTotal}, Python ${fg.tied}`);
    if (!same(state.result.winners, fg.winners)) bad(id, `winners JS ${state.result.winners}, Python ${fg.winners}`);
    if (manual) {
      perCount[fg.n].games++; perCount[fg.n].deals += fg.hands.length;
      if (fg.tied.length > 1) { tied++; if (fg.winners.length < fg.tied.length) tiebreaks++; }
    }
  }
}

console.log(`  fixture: ${FX.generator}`);
console.log(`  replayed ${[2, 3, 4].map((n) => `${n}p ${perCount[n].games} games / ${perCount[n].deals} deals`).join(', ')}; ${plays} recorded card plays; twice (learner and auto-play): ${replays} replays`);
console.log(`  covered: ${nobody} nobody-chases hands, ${colt} rows with the Colt, ${fresh} rows from a fresh shuffle, ${tied} games tied on total (${tiebreaks} settled by the last hand)`);
for (const f of firstFew) console.log(`  mismatch ${f}`);
check('conformance: the fixture has about 300 deals at each of 2, 3 and 4 players', [2, 3, 4].every((n) => FX.counts[n].gameDeals >= 290 && perCount[n].deals === FX.counts[n].gameDeals));
check('conformance: the fixture has no 5-player games (R1.9)', !FX.games.some((g) => g.n === 5));
check('conformance: every recorded game replays with zero mismatches', mismatches === 0, `${mismatches} mismatches`);
check('conformance: the fixture exercises nobody-chases hands, the Colt, reshuffles and a last-hand tiebreak', nobody > 0 && colt > 0 && fresh > 0 && tiebreaks > 0);
done();
