// lib.mjs - a tiny check harness shared by the suites (no framework), plus game helpers.

import { createGame, applyAction, fullDeck, sortCards, mobValueFor } from '../src/engine/index.js';

export function suite(name) {
  let pass = 0;
  const failures = [];
  function check(label, cond, detail = '') {
    if (cond) pass++;
    else failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
  }
  function done() {
    for (const f of failures) console.log(`  FAIL ${f}`);
    console.log(`${name}: ${pass} passed, ${failures.length} failed`);
    if (failures.length) process.exitCode = 1;
    return failures.length === 0;
  }
  return { check, done, counts: () => ({ pass, fail: failures.length }) };
}

export const roundTrip = (x) => JSON.parse(JSON.stringify(x));
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

/**
 * A hand-built position in the middle of a hand, no trick started.
 * Cards not placed anywhere go to `out`, so card conservation holds. The trick piles start empty
 * (the counts in climbTricks / descentTricks are what scoring reads).
 * @param {object} o
 * @param {number} [o.players]        default 4
 * @param {string[][]} o.hands        cards in hand by seat (all the same length)
 * @param {number} [o.leader]         seat to lead (default 0)
 * @param {string} [o.phase]          'climb' (default) or 'descent'
 * @param {number} [o.marker]         climb only: the marker's step (default 0)
 * @param {number[]} [o.climbTricks]  climb tricks already won by seat (default zeros)
 * @param {(string|null)[]} [o.choices] descent: the revealed summit choices (default everyone chases)
 * @param {number} [o.brumbies]       Brumby cards under the Colt (default 0)
 * @param {number} [o.handNo]         default 0
 * @param {number} [o.handsPerGame]   override params.handsPerGame (e.g. 1 to stop after this hand)
 * @param {number[]} [o.totals]       running totals (default zeros)
 * @param {number[]} [o.mobsHome]     mobs brought home so far (default zeros)
 */
export function position({ players = 4, hands, leader = 0, phase = 'climb', marker = 0, climbTricks = null, choices = null, brumbies = 0, handNo = 0, handsPerGame = null, totals = null, mobsHome = null }) {
  const g = createGame({ seed: 1, players, firstDealer: (leader - 1 + players) % players });
  const n = players;
  g.handNo = handNo;
  g.dealer = (g.firstDealer + handNo) % players;
  if (handsPerGame !== null) g.params.handsPerGame = handsPerGame;
  g.hands = hands.map((h) => sortCards(h));
  g.climbPiles = hands.map(() => []);
  g.descentPiles = hands.map(() => []);
  const placed = new Set(g.hands.flat());
  g.out = fullDeck().filter((c) => !placed.has(c));
  g.climbTricks = climbTricks ? [...climbTricks] : hands.map(() => 0);
  g.descentTricks = hands.map(() => 0);
  g.lastDescentWin = hands.map(() => -1);
  g.brumbies = brumbies;
  g.mob = mobValueFor(g.params, brumbies);
  g.marker = phase === 'climb' ? marker : g.params.summitStep;
  g.phase = phase;
  if (phase === 'descent') {
    g.choices = choices ? [...choices] : hands.map(() => 'chase');
    g.choiceOrder = Array.from({ length: n }, (_, k) => (leader + k) % n);
    g.revealed = true;
    g.summitTrick = g.climbTricks.reduce((a, b) => a + b, 0);
  } else {
    g.choices = hands.map(() => null);
    g.choiceOrder = [];
    g.revealed = false;
    g.summitTrick = null;
  }
  g.trickNo = g.climbTricks.reduce((a, b) => a + b, 0);
  g.descentTrickNo = 0;
  g.leader = leader;
  g.toAct = leader;
  g.trick = null;
  g.tricks = [];
  if (totals) g.totals = [...totals];
  if (mobsHome) g.mobsHome = [...mobsHome];
  return g;
}

/**
 * Plays actions in order, each by whoever is to act. A string is a card ('home-7'), 'chase' / 'watch'
 * is a summit choice; objects are passed as they are. A card that the engine already auto-played
 * (single legal option) is skipped. Returns all events.
 */
export function play(state, ...moves) {
  let events = [];
  for (const m of moves) {
    if (m === 'chase' || m === 'watch') {
      events = events.concat(applyAction(state, { type: 'summit', choice: m }));
    } else if (typeof m === 'string') {
      const auto = events.find((e) => e.type === 'card-played' && e.auto && !e._used && e.card === m);
      if (auto) { auto._used = true; continue; }
      events = events.concat(applyAction(state, { type: 'play', card: m }));
    } else {
      events = events.concat(applyAction(state, m));
    }
  }
  return events;
}

/**
 * Every card's location: returns { ok, problem }. R13.1: each of the 48 horse cards is in exactly
 * one of: a hand, the current trick, a climb pile, a descent pile, the cards out of play. Also the
 * Brumby stack is 0..BRUMBY_MAX (the 4 Brumby cards are under the Colt or in the reserve).
 */
const DECK = new Set(fullDeck());

export function conservation(state) {
  const seen = new Map();
  const places = [];
  state.hands.forEach((h, s) => h.forEach((c) => places.push([c, `hand ${s}`])));
  if (state.trick) state.trick.plays.forEach((p) => places.push([p.card, 'trick']));
  state.climbPiles.forEach((w, s) => w.forEach((c) => places.push([c, `climb pile ${s}`])));
  state.descentPiles.forEach((w, s) => w.forEach((c) => places.push([c, `descent pile ${s}`])));
  state.out.forEach((c) => places.push([c, 'out']));
  for (const [c, w] of places) {
    if (seen.has(c)) return { ok: false, problem: `${c} in ${seen.get(c)} and ${w}` };
    seen.set(c, w);
  }
  if (seen.size !== DECK.size) {
    const missing = [...DECK].filter((c) => !seen.has(c));
    return { ok: false, problem: `${seen.size} cards placed, deck has ${DECK.size}; missing ${missing.slice(0, 5).join(' ')}` };
  }
  for (const c of seen.keys()) if (!DECK.has(c)) return { ok: false, problem: `${c} is not in the deck` };
  if (!Number.isInteger(state.brumbies) || state.brumbies < 0 || state.brumbies > state.params.brumbyMax) return { ok: false, problem: `Brumby stack ${state.brumbies}` };
  const hs = state.hands.map((h) => h.length);
  if (state.phase !== 'over' && new Set(hs).size > 1 && !state.trick) return { ok: false, problem: `hands of different sizes between tricks: ${hs.join(',')}` };
  return { ok: true, problem: '' };
}
