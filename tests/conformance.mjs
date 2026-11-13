// conformance.mjs - replays the Python fixtures (tests/fixtures/python-conformance.json, made by
// a script that lives outside the repo, which drives the v6 Python simulator
// unchanged with random legal play at 2, 3, 4 and 5 players) through the JS engine,
// and requires identical results: the dealer, the seat to play and the size of the legal option set at every
// card, every trick winner (climb and descent), the Climb row and the Brumby row (values in order, fed in
// through the test hook `deals[h].climbRow` / `deals[h].row`), whether the Brumby row came from a fresh
// shuffle of all 12, the Climb values and Brumby values taken by each seat (sums and multisets), the hand
// scores, the top-Home-holder statistic, the game totals, the top-total seats and the winners after the
// last-hand tiebreak.
// Every game is replayed twice: learner style (every card clicked, legal sets compared at every play)
// and with forced cards auto-played (the recorded plays must match the auto events).
// Known Python differences: D4 the shuffles are not reproducible, so deals and
// rows come in by the hook; D5 Climb and Brumby cards are bare values in the Python, so they are compared by
// value; D7 the first dealer is seat 0; D11 the plays are the generator's random ones. Nothing in the
// Python's v6 rules differs from the spec, so nothing had to be left out.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { readFileSync } from 'node:fs';
import { startGame, applyAction, getValidActions, fullDeck, isCardPhase, brumbyValue, climbCardValue } from '../src/engine/index.js';
import { suite } from './lib.mjs';

const { check, done } = suite('conformance');
const FX = JSON.parse(readFileSync(new URL('./fixtures/python-conformance.json', import.meta.url), 'utf8'));
const DECK = fullDeck(5); // fixture alphabet index = fullDeck(5) index (suit id x 12 + n - 1; Muster = 48..59)
const card = (ch) => DECK[FX.alphabet.indexOf(ch)];
const hex = (s) => [...s].map((c) => parseInt(c, 16));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const COUNTS = [2, 3, 4, 5];

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
  const handNo = state.handNo;
  if (!same(state.climbRowDealt.map(climbCardValue), fh.cr)) bad(id, `Climb row JS ${state.climbRowDealt.map(climbCardValue)}, Python ${fh.cr}`);
  let i = 0;
  let guard = 0;
  let sawSummit = false;
  while (state.handLog.length === handNo && state.toAct !== null && guard++ < 400) {
    if (!isCardPhase(state.phase)) { bad(id, `resting in phase ${state.phase}`); return null; }
    if (state.phase === 'descent' && !sawSummit) {
      sawSummit = true;
      if (!same(state.rowDealt.map(brumbyValue), fh.row)) bad(id, `Brumby row JS ${state.rowDealt.map(brumbyValue)}, Python ${fh.row}`);
    }
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
  if (!same(rec.climbRowValues, fh.cr)) bad(id, `Climb row JS ${rec.climbRowValues}, Python ${fh.cr}`);
  if (!same(rec.rowValues, fh.row)) bad(id, `Brumby row JS ${rec.rowValues}, Python ${fh.row}`);
  if (rec.reshuffled !== (fh.f === 1)) bad(id, `fresh Brumby shuffle JS ${rec.reshuffled}, Python ${fh.f}`);
  // climb / descent trick counts from the Python's winners
  const w = [...fh.w].map(Number);
  const yC = state.totals.map(() => 0); const xC = state.totals.map(() => 0);
  w.forEach((s, k) => { if (k < 6) yC[s]++; else xC[s]++; });
  if (!same(rec.climbTricks, yC)) bad(id, `climb tricks JS ${rec.climbTricks}, Python ${yC}`);
  if (!same(rec.descentTricks, xC)) bad(id, `descent tricks JS ${rec.descentTricks}, Python ${xC}`);
  // Climb and Brumby values taken: sums against the Python, multisets against the Python's winners + rows (D5)
  if (!same(rec.climbValues, fh.cv)) bad(id, `Climb values JS ${rec.climbValues}, Python ${fh.cv}`);
  if (!same(rec.keptValues, fh.b)) bad(id, `Brumby sums JS ${rec.keptValues}, Python ${fh.b}`);
  const pyClimb = state.totals.map(() => []); const pyKept = state.totals.map(() => []);
  w.forEach((s, k) => { if (k < 6) pyClimb[s].push(fh.cr[k]); else pyKept[s].push(fh.row[k - 6]); });
  if (!same(rec.climbCards.map((k) => k.map(climbCardValue)), pyClimb)) bad(id, `Climb cards in order JS ${JSON.stringify(rec.climbCards)}, Python ${JSON.stringify(pyClimb)}`);
  if (!same(rec.kept.map((k) => sorted(k.map(brumbyValue))), pyKept.map(sorted))) bad(id, `Brumby cards JS ${JSON.stringify(rec.kept)}, Python ${JSON.stringify(pyKept)}`);
  if (!same(rec.kept.map((k) => k.map(brumbyValue)), pyKept)) bad(id, `Brumby cards in order JS ${JSON.stringify(rec.kept)}, Python ${JSON.stringify(pyKept)}`);
  if (!same(rec.scores, fh.r)) bad(id, `scores JS ${rec.scores}, Python ${fh.r}`);
  if (rec.topHomeSeat !== fh.t) bad(id, `top Home holder JS ${rec.topHomeSeat}, Python expression ${fh.t}`);
  return rec;
}

const hands = (fh) => fh.h.map((s) => [...s].map(card));
const allSeats = (n) => Array.from({ length: n }, (_, s) => s);

const perCount = Object.fromEntries(COUNTS.map((n) => [n, { games: 0, deals: 0 }]));
let plays = 0; let replays = 0; let tied = 0; let tiebreaks = 0; let shared = 0; let colt = 0; let fresh = 0; let negHand = 0; let negTotal = 0; let musterPlays = 0;
const minusPos = new Set();
for (const manual of [true, false]) {
  for (const fg of FX.games) {
    replays++;
    const id = `${fg.id}${manual ? '' : ' (auto)'}`;
    let state;
    try {
      state = startGame({
        seed: `fx:${fg.id}`, players: fg.n, firstDealer: fg.firstDealer,
        deals: fg.hands.map((fh) => ({ hands: hands(fh), climbRow: fh.cr, row: fh.row })),
        manualSeats: manual ? allSeats(fg.n) : [],
      }).state;
    } catch (e) { bad(id, `startGame threw ${e.message}`); continue; }
    let ok = true;
    for (const fh of fg.hands) {
      if (state.dealer !== fh.d) { bad(id, `dealer JS ${state.dealer}, Python ${fh.d}`); ok = false; break; }
      let rec;
      try { rec = playHand(state, fh, `${id} hand ${state.handNo}`, manual); } catch (e) { bad(id, `threw ${e.message}`); rec = null; }
      if (!rec) { ok = false; break; }
      if (manual) {
        plays += fh.p.length; if (fh.row.includes(4)) colt++; fresh += fh.f; minusPos.add(fh.cr.indexOf(-1) + 1);
        negHand += fh.r.filter((x) => x < 0).length; musterPlays += [...fh.p].filter((c) => card(c).startsWith('muster-')).length;
      }
    }
    if (!ok) continue;
    if (state.phase !== 'over') { bad(id, 'the game did not end after the Python\'s hands'); continue; }
    if (!same(state.result.totals, fg.totals)) bad(id, `totals JS ${state.result.totals}, Python ${fg.totals}`);
    if (!same(state.result.tiedOnTotal, fg.tied)) bad(id, `top total JS ${state.result.tiedOnTotal}, Python ${fg.tied}`);
    if (!same(state.result.winners, fg.winners)) bad(id, `winners JS ${state.result.winners}, Python ${fg.winners}`);
    if (manual) {
      perCount[fg.n].games++; perCount[fg.n].deals += fg.hands.length;
      negTotal += fg.totals.filter((x) => x < 0).length;
      if (fg.tied.length > 1) { tied++; if (fg.winners.length < fg.tied.length) tiebreaks++; if (fg.winners.length > 1) shared++; }
    }
  }
}

console.log(`  fixture: ${FX.generator}`);
console.log(`  replayed ${COUNTS.map((n) => `${n}p ${perCount[n].games} games / ${perCount[n].deals} deals`).join(', ')}; ${plays} recorded card plays (${musterPlays} Muster); twice (learner and auto-play): ${replays} replays`);
console.log(`  covered: ${colt} Brumby rows with the Colt, ${fresh} rows from a fresh shuffle, the -1 Climb card at positions ${[...minusPos].sort().join(',')}, ${negHand} negative hand scores, ${negTotal} negative totals, ${tied} games tied on total (${tiebreaks} settled by the last hand, ${shared} shared)`);
for (const f of firstFew) console.log(`  mismatch ${f}`);
check('conformance: the fixture has about 300 deals at each of 2, 3, 4 and 5 players', COUNTS.every((n) => FX.counts[n].gameDeals >= 290 && perCount[n].deals === FX.counts[n].gameDeals));
check('conformance: the fixture was made with the v6 settings of spec 13.1 (Climb row 5 x +1 and 1 x -1, no choice, no cost, no descent point)', same(FX.cfg.climb_row, [1, 1, 1, 1, 1, -1]) && FX.cfg.choice === false && FX.cfg.cost === 0 && FX.cfg.desc_plus === false && FX.cfg.row_mode === 'deck12' && FX.cfg.colt === 4 && FX.cfg.trump_up === 0 && FX.cfg.trump_down === 3);
check('conformance: every recorded game replays with zero mismatches', mismatches === 0, `${mismatches} mismatches`);
check('conformance: the fixture exercises the Colt, reshuffles, the -1 at every position, negative scores, the Muster, a last-hand tiebreak and a shared win', colt > 0 && fresh > 0 && minusPos.size === 6 && negHand > 0 && negTotal > 0 && musterPlays > 0 && tiebreaks > 0 && shared > 0);
done();
