// state.js - createGame / startGame, dealing a hand (with the Climb row), the Brumby deck, and cloneState.
//
// SERIALISABILITY IS LOAD-BEARING: every state survives JSON.parse(JSON.stringify(state))
// unchanged. Plain JSON only, null never undefined, no functions or class instances.
//
// Seats are 0..n-1 clockwise; "left of X" is (X + 1) mod n. Who is human or bot is a UI
// concern and is NOT in the engine state. Everything "per player" is an array indexed by seat.
//
// The state shape, schema 3 (each field is described where it is created, in startGame below; the
// contract for the bot and UI workers is web-game-docs/engine-api-v3.md):
//   kind 'game', schema 3, seed, n, rules, params, rulesCode, rng, deals, manualSeats,
//   firstDealer, dealer, handNo,
//   phase 'climb' | 'descent' | 'handEnd' (transient) | 'over', toAct, leader,
//   hands, out, piles, climbTricks, descentTricks, trickNo, climbTrickNo, descentTrickNo, trick, tricks,
//   climbRow, climbRowDealt, climbCards,
//   brumbyDeck, brumbyDiscard, freshDeck, row, rowDealt, rowFresh, kept,
//   topHomeSeat, home1Seat, handLog, totals, measures, result.
//
// 'handEnd' is a transient phase: it is set while a hand is scored inside applyAction. A state returned
// by applyAction is never in 'handEnd': it is the next hand's 'climb', or 'over'. There is no 'summit'
// phase a state rests in (R5.5): the summit is one step inside applyAction.

import { CONSTANTS, resolveVariants, rulesCode, deriveParams } from './rules.js';
import { makeRng, rngInt, shuffle } from './rng.js';
import { fullDeck, sortCards, brumbyDeck, isBrumby, climbCardDeck, climbCardValue, isClimbCard } from './cards.js';

const filled = (n, f) => Array.from({ length: n }, f);

/** Counters kept for stats, analytics and balance work (per game). */
export function emptyMeasures(n) {
  return {
    hands: 0, // completed hands
    tricks: 0, // completed tricks, climb and descent
    climbTricks: 0, // completed climb tricks
    descentTricks: 0, // completed descent tricks
    trumpWins: 0, // tricks won by a trump that was not the led suit
    climbValueSum: 0, // Climb card values taken, summed (always 4 a hand)
    rowValueSum: 0, // sum of every Brumby row's value
    coltRows: 0, // Brumby rows with the Colt in them
    minusBySeat: filled(n, () => 0), // the -1 Climb card taken, by seat
    coltBySeat: filled(n, () => 0), // the Colt taken, by seat
    negativeHands: 0, // seat-hands that scored below zero
    reshuffles: 0, // fresh shuffles of all 12 Brumby cards (the first deck of the game included)
  };
}

/** Resolves a fixed row (ids or values) against a pool of ids, removing what it takes. Throws when it cannot. */
function takeFixed(pool, wanted, valueOf, isId, what) {
  const out = [];
  for (const want of wanted) {
    const i = typeof want === 'number' ? pool.findIndex((id) => valueOf(id) === want) : (isId(want) ? pool.indexOf(want) : -1);
    if (i < 0) throw new Error(`${what}: ${JSON.stringify(want)} is not available (${pool.join(' ')})`);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

function checkDeal(deal, state) {
  const { n, params } = state;
  const k = params.handSize;
  if (!deal || typeof deal !== 'object') throw new Error('A fixed deal must be an object { hands?, climbRow?, row? }');
  if (deal.hands !== undefined && deal.hands !== null) {
    if (!Array.isArray(deal.hands) || deal.hands.length !== n || deal.hands.some((h) => !Array.isArray(h) || h.length !== k)) {
      throw new Error(`A fixed deal needs ${n} hands of ${k} cards`);
    }
    const all = deal.hands.flat();
    const deck = new Set(fullDeck(n));
    if (all.some((c) => !deck.has(c))) throw new Error(`A fixed deal holds a card that is not in the ${n}-player deck`);
    if (new Set(all).size !== all.length) throw new Error('A fixed deal contains a card twice');
  }
  for (const key of ['row', 'climbRow']) {
    if (deal[key] !== undefined && deal[key] !== null) {
      const size = key === 'row' ? params.rowSize : params.climbTricks;
      if (!Array.isArray(deal[key]) || deal[key].length !== size) throw new Error(`A fixed ${key} needs ${size} cards (ids or values)`);
    }
  }
}

/**
 * A fresh Brumby deck: every one of the 12 cards shuffled (R2.7, R8.2, R8.4). The discard is emptied.
 * Pushes 'brumby-reshuffled' when `events` is an array and `announce` is true.
 */
export function reshuffleBrumbies(state, events, announce = true) {
  const all = [...state.brumbyDeck, ...state.brumbyDiscard];
  const ordered = brumbyDeck().filter((id) => all.includes(id)); // deterministic input order
  state.brumbyDeck = shuffle(state.rng, ordered);
  state.brumbyDiscard = [];
  state.freshDeck = true;
  state.measures.reshuffles++;
  if (events && announce) events.push({ type: 'brumby-reshuffled', handNo: state.handNo, deckCount: state.brumbyDeck.length });
}

/**
 * Deals hand `state.handNo` (R2.3, R2.5, R2.6, R3): sets the dealer and first leader, gathers and
 * shuffles all 48 (60) cards, deals 12 each, then shuffles the six Climb cards and lays them face up
 * (R3.5). The Brumby deck and discard and the scores carry over (R8.1). Pushes an event when `events` is
 * an array. RNG order: the deal shuffle (unless the hook fixes the hands), then the Climb row shuffle
 * (unless the hook fixes the Climb row) - the Python's order (spec 13.1).
 */
export function dealHand(state, events) {
  const { n, params } = state;
  const h = state.handNo;
  const k = params.handSize;
  state.dealer = (state.firstDealer + h) % n; // R2.3 the deal passes left
  state.leader = (state.dealer + 1) % n; // R2.3 the player on the dealer's left leads

  const fixed = state.deals && state.deals[h] ? state.deals[h] : null;
  let packets;
  if (fixed) checkDeal(fixed, state);
  if (fixed && fixed.hands) {
    packets = fixed.hands.map((x) => [...x]);
    const dealt = new Set(packets.flat());
    state.out = fullDeck(n).filter((c) => !dealt.has(c));
  } else {
    // R3.4 shuffle the whole deck, deal 12 each from the seat left of the dealer; the rest are out unseen.
    const deck = shuffle(state.rng, fullDeck(n));
    packets = filled(n, () => []);
    for (let i = 0; i < n; i++) packets[(state.dealer + 1 + i) % n] = deck.slice(i * k, (i + 1) * k);
    state.out = deck.slice(n * k);
  }
  state.out = sortCards(state.out);
  state.hands = packets.map((p) => sortCards(p, 'climb'));
  state.home1Seat = state.hands.findIndex((hd) => hd.includes('home-1'));
  if (state.home1Seat < 0) state.home1Seat = null; // out unseen (2-3 players)

  // R3.5 the six Climb cards shuffled and laid face up, every hand
  const climbRow = fixed && fixed.climbRow
    ? takeFixed(climbCardDeck(), fixed.climbRow, climbCardValue, isClimbCard, `Fixed Climb row of hand ${h}`)
    : shuffle(state.rng, climbCardDeck());
  state.climbRow = [...climbRow];
  state.climbRowDealt = [...climbRow];
  state.climbCards = filled(n, () => []);

  state.piles = filled(n, () => []);
  state.climbTricks = filled(n, () => 0);
  state.descentTricks = filled(n, () => 0);
  state.row = [];
  state.rowDealt = [];
  state.rowFresh = false;
  state.topHomeSeat = null;
  state.kept = filled(n, () => []);
  state.trick = null;
  state.tricks = [];
  state.trickNo = 0;
  state.climbTrickNo = 0;
  state.descentTrickNo = 0;
  state.phase = 'climb'; // R4.1
  state.toAct = state.leader;
  if (events) {
    const values = state.climbRowDealt.map(climbCardValue);
    events.push({
      type: 'hand-started', handNo: h, dealer: state.dealer, leader: state.leader, handSize: k, handsPerGame: params.handsPerGame,
      outCount: state.out.length, trump: params.trumpClimb, direction: 'highest',
      climbRow: [...state.climbRowDealt], climbRowValues: values, minusPosition: values.indexOf(-1) + 1,
      deckCount: state.brumbyDeck.length, discardCount: state.brumbyDiscard.length, freshDeck: state.freshDeck,
    });
  }
}

/**
 * A new game, dealt and ready for the first decision, plus the events of the start.
 * @param {object} opts
 * @param {number|string} opts.seed       drives the first dealer (if random), the Brumby shuffles, every deal and Climb row
 * @param {number} opts.players           2 to 5 (R1.10: anything else throws)
 * @param {object} [opts.rules]           variant overrides: there are none, so any name throws
 * @param {number|null} [opts.firstDealer] seat of the first dealer; default drawn from the seed (R2.2)
 * @param {Array<{hands?: string[][], climbRow?: (string|number)[], row?: (string|number)[]}|null>|null} [opts.deals]
 *        TEST HOOK (replays, fixtures): fixed deals by hand index. `hands` by seat (12 card ids each; omitted =
 *        shuffled). `climbRow` (optional) fixes that hand's Climb row, left to right: 6 entries, each a Climb
 *        id or a value (+1 / -1 = the next unused Climb card of that value). `row` (optional) fixes that hand's
 *        Brumby row: each entry a Brumby id or a value (+2, +1, -1, -2, +4 = the first card of that value still
 *        in the deck); it is taken out of the deck as it stands at the summit (persistence and reshuffles still
 *        apply), so a row the deck cannot supply throws. Hands without an entry are shuffled from the seed.
 * @param {string[]|null} [opts.brumbyDeck] TEST HOOK: the game's first Brumby deck order (all 12 ids,
 *        top first) instead of a shuffle. Later reshuffles use the seed.
 * @param {number[]} [opts.manualSeats] seats whose single-option card plays are NOT auto-applied
 *        (learners click even a forced card). Not a rule: never in `rules` or the rules code.
 * @returns {{ state: object, events: object[] }}
 */
export function startGame(opts = {}) {
  const { seed, players: n, firstDealer = null, deals = null } = opts;
  if (seed === undefined || seed === null) throw new Error('startGame needs a seed');
  const rules = resolveVariants(opts.rules || {});
  const params = deriveParams(rules, n);
  const rng = makeRng(seed);
  let dealer0;
  if (firstDealer === null || firstDealer === undefined) dealer0 = rngInt(rng, n);
  else if (Number.isInteger(firstDealer) && firstDealer >= 0 && firstDealer < n) dealer0 = firstDealer;
  else throw new Error(`firstDealer must be a seat 0..${n - 1} or null, got ${firstDealer}`);
  const manualSeats = Array.isArray(opts.manualSeats) ? [...new Set(opts.manualSeats)].sort((a, b) => a - b) : [];
  if (manualSeats.some((s) => !Number.isInteger(s) || s < 0 || s >= n)) throw new Error(`manualSeats must be seats 0..${n - 1}`);
  if (deals !== null && !Array.isArray(deals)) throw new Error('deals must be an array (by hand index) or null');
  let firstDeck = null;
  if (opts.brumbyDeck !== undefined && opts.brumbyDeck !== null) {
    const d = opts.brumbyDeck;
    const all = brumbyDeck();
    if (!Array.isArray(d) || d.length !== all.length || new Set(d).size !== d.length || !d.every(isBrumby)) throw new Error(`brumbyDeck must list all ${all.length} Brumby ids once each`);
    firstDeck = [...d];
  }

  const state = {
    kind: 'game',
    schema: 3,
    seed: String(seed),
    n,
    rules, // {} : no switches
    params, // deriveParams(): suits, hand size, tricks per half, trumps, row size ... fixed for the game
    rulesCode: rulesCode(rules, n), // always 'std' (v6 rules)
    rng, // the game's RNG stream (first dealer, Brumby shuffles, deals, Climb rows)
    deals: deals ? JSON.parse(JSON.stringify(deals)) : null,
    manualSeats,
    firstDealer: dealer0,
    dealer: dealer0,
    handNo: 0, // index of the hand being played (= hands completed)
    phase: 'climb', // 'climb' | 'descent' | 'handEnd' (transient) | 'over'
    toAct: null, // the seat deciding now; null when the game is over
    leader: null, // the seat that leads (or led) the current trick
    hands: filled(n, () => []), // cards in hand by seat, sorted (R1.4: ascending on the climb, descending on the descent)
    out: [], // cards not dealt: out of play, unseen all game (R3.2, R10.9)
    piles: filled(n, () => []), // the cards of every trick each seat won this hand (one pile, R4.7); counts only in views
    climbTricks: filled(n, () => 0), // climb tricks won this hand (public counts; score nothing, R7.2)
    descentTricks: filled(n, () => 0), // descent tricks won this hand
    trickNo: 0, // completed tricks this hand, climb and descent (0..12)
    climbTrickNo: 0, // completed climb tricks (0..6) = 0-based Climb row position of the next prize
    descentTrickNo: 0, // completed descent tricks (0..6) = 0-based Brumby row position of the next prize
    trick: null, // the trick being played, or null
    tricks: [], // completed tricks this hand (public history, R10.10)
    climbRow: [], // the face-up Climb row, 6 slots left to right; a slot is null once its trick is won (R3.5, R4.8)
    climbRowDealt: [], // the 6 Climb ids as laid out this hand
    climbCards: filled(n, () => []), // each seat's Climb cards taken this hand, in the order won (R4.8, R10.6)
    brumbyDeck: [], // Brumby ids, top first; persists across hands (R8.1); order hidden from every view
    brumbyDiscard: [], // Brumby ids in the order discarded (public, R10.8)
    freshDeck: false, // the deck was shuffled from all 12 and no row has been dealt from it yet
    row: [], // the face-up Brumby row from the summit, 6 slots left to right; null once taken (R5.3, R6.6); [] on the climb
    rowDealt: [], // the 6 Brumby ids as dealt (the hand's record of the row)
    rowFresh: false, // this hand's row came from a fresh shuffle of all 12 (R7.6 `reshuffled`)
    kept: filled(n, () => []), // each seat's Brumby cards taken this hand, in the order won (R6.6, R10.6)
    topHomeSeat: null, // set at the summit: holder of the lowest-numbered Home card still in hand (R7.6, D9)
    home1Seat: null, // set at the deal: the seat dealt Home 1, or null when it is out unseen (R7.6)
    handLog: [], // one record per finished hand (actions.js endHand, R7.6)
    totals: filled(n, () => 0), // running totals over finished hands
    measures: emptyMeasures(n),
    result: null, // gameResult() once the game is over
  };
  const events = [{ type: 'game-started', players: n, firstDealer: dealer0, rules: { ...rules }, rulesCode: state.rulesCode, handsPerGame: params.handsPerGame, suits: [...params.suits] }];
  if (firstDeck) {
    state.brumbyDeck = firstDeck;
    state.freshDeck = true;
    state.measures.reshuffles++;
  } else {
    state.brumbyDeck = brumbyDeck();
    reshuffleBrumbies(state, null, false); // R2.7 / R8.2 the 12 Brumby cards shuffled into one deck
  }
  dealHand(state, events);
  return { state, events };
}

/** startGame without the events. */
export function createGame(opts = {}) {
  return startGame(opts).state;
}

/**
 * A deep copy of a state (or of a determinised world) that applyAction can mutate without touching
 * the original. Plain JSON copied by recursion.
 */
export function cloneState(x) {
  if (Array.isArray(x)) {
    const out = new Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = cloneState(x[i]);
    return out;
  }
  if (x && typeof x === 'object') {
    const out = {};
    for (const k of Object.keys(x)) out[k] = cloneState(x[k]);
    return out;
  }
  return x;
}

export { CONSTANTS };
