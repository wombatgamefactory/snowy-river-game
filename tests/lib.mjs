// lib.mjs - a tiny check harness shared by the suites (no framework), plus game helpers.

import { createGame, applyAction, fullDeck, sortCards, brumbyDeck, isBrumby } from '../src/engine/index.js';

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
 * A hand-built position in the middle of a hand, no trick started (v5).
 * Playing cards not placed in a hand go to `out`, so card conservation holds; the trick piles start
 * empty (the counts in climbTricks / descentTricks are what scoring reads). The Brumby cards not in the
 * row, the kept piles or the discard are the deck, in id order unless `deck` is given.
 * @param {object} o
 * @param {number} [o.players]          default 4
 * @param {string[][]} o.hands          cards in hand by seat (all the same length)
 * @param {number} [o.leader]           seat to lead (default 0)
 * @param {string} [o.phase]            'climb' (default) or 'descent'
 * @param {number} [o.marker]           climb: climb tricks already played (default 12 - hand size, capped at 5)
 * @param {number[]} [o.climbTricks]    climb tricks already won by seat (default zeros)
 * @param {number[]} [o.descentTricks]  descent tricks already won by seat (default zeros)
 * @param {(string|null)[]} [o.choices] descent: the revealed summit choices (default everyone chases)
 * @param {string[]} [o.row]            descent: the 6 row ids as dealt (default the first 6 of the deck)
 * @param {number} [o.descentTrickNo]   descent: tricks already played (row slots before it are emptied)
 * @param {string[][]} [o.kept]         descent: kept piles by seat (default empty)
 * @param {string[]} [o.discard]        the Brumby discard (default empty)
 * @param {string[]} [o.deck]           the Brumby deck order (default: the rest, in id order)
 * @param {number} [o.handNo]           default 0
 * @param {number} [o.handsPerGame]     override params.handsPerGame (e.g. 1 to stop after this hand)
 * @param {number[]} [o.totals]         running totals (default zeros)
 */
export function position({ players = 4, hands, leader = 0, phase = 'climb', marker = null, climbTricks = null, descentTricks = null, choices = null, row = null, descentTrickNo = 0, kept = null, discard = [], deck = null, handNo = 0, handsPerGame = null, totals = null }) {
  const g = createGame({ seed: 1, players, firstDealer: (leader - 1 + players) % players });
  const n = players;
  g.handNo = handNo;
  g.dealer = (g.firstDealer + handNo) % players;
  if (handsPerGame !== null) g.params.handsPerGame = handsPerGame;
  const descent = phase === 'descent';
  g.handsTurned = descent;
  g.hands = hands.map((h) => sortCards(h, descent ? 'descent' : 'climb'));
  g.piles = hands.map(() => []);
  const placed = new Set(g.hands.flat());
  g.out = fullDeck().filter((c) => !placed.has(c));
  g.climbTricks = climbTricks ? [...climbTricks] : hands.map(() => 0);
  g.descentTricks = descentTricks ? [...descentTricks] : hands.map(() => 0);
  g.kept = kept ? kept.map((k) => [...k]) : hands.map(() => []);
  g.brumbyDiscard = [...discard];
  const used = new Set([...g.kept.flat(), ...g.brumbyDiscard, ...(row || [])]);
  let rest = deck ? [...deck] : brumbyDeck().filter((id) => !used.has(id));
  if (descent) {
    const r = row ? [...row] : rest.slice(0, 6);
    if (!row) rest = rest.slice(6);
    g.rowDealt = [...r];
    g.row = r.map((id, i) => (i < descentTrickNo ? null : id));
    g.marker = g.params.climbTricks;
    g.choices = choices ? [...choices] : hands.map(() => 'chase');
    g.choiceOrder = Array.from({ length: n }, (_, k) => (leader + k) % n);
    g.revealed = true;
    g.descentTrickNo = descentTrickNo;
  } else {
    g.row = [];
    g.rowDealt = [];
    g.marker = marker === null ? Math.min(5, Math.max(0, 12 - hands[0].length)) : marker;
    g.choices = hands.map(() => null);
    g.choiceOrder = [];
    g.revealed = false;
    g.descentTrickNo = 0;
  }
  g.brumbyDeck = rest;
  g.freshDeck = false;
  g.trickNo = g.marker + g.descentTrickNo;
  g.phase = phase;
  g.leader = leader;
  g.toAct = leader;
  g.trick = null;
  g.tricks = [];
  if (totals) g.totals = [...totals];
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
 * Every card's location: returns { ok, problem }.
 * R11.1: each of the 48 playing cards is in exactly one of: a hand, the current trick, a trick pile,
 * the cards out of play. R11.2: each of the 12 Brumby cards is in exactly one of: the deck, the row,
 * a kept pile, the discard.
 */
const DECK = new Set(fullDeck());
const BRUMBIES = new Set(brumbyDeck());

export function conservation(state) {
  const seen = new Map();
  const places = [];
  state.hands.forEach((h, s) => h.forEach((c) => places.push([c, `hand ${s}`])));
  if (state.trick) state.trick.plays.forEach((p) => places.push([p.card, 'trick']));
  state.piles.forEach((w, s) => w.forEach((c) => places.push([c, `pile ${s}`])));
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
  const hs = state.hands.map((h) => h.length);
  if (state.phase !== 'over' && new Set(hs).size > 1 && !state.trick) return { ok: false, problem: `hands of different sizes between tricks: ${hs.join(',')}` };

  const bseen = new Map();
  const bplaces = [];
  state.brumbyDeck.forEach((id) => bplaces.push([id, 'deck']));
  state.row.forEach((id) => { if (id !== null) bplaces.push([id, 'row']); });
  state.kept.forEach((k, s) => k.forEach((id) => bplaces.push([id, `kept ${s}`])));
  state.brumbyDiscard.forEach((id) => bplaces.push([id, 'discard']));
  for (const [id, w] of bplaces) {
    if (!isBrumby(id)) return { ok: false, problem: `${id} (${w}) is not a Brumby card` };
    if (bseen.has(id)) return { ok: false, problem: `${id} in ${bseen.get(id)} and ${w}` };
    bseen.set(id, w);
  }
  if (bseen.size !== BRUMBIES.size) return { ok: false, problem: `${bseen.size} Brumby cards placed, there are ${BRUMBIES.size}` };
  return { ok: true, problem: '' };
}
