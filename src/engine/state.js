// state.js - createGame / startGame, dealing a hand, and cloneState.
//
// SERIALISABILITY IS LOAD-BEARING: every state survives JSON.parse(JSON.stringify(state))
// unchanged. Plain JSON only, null never undefined, no functions or class instances.
//
// Seats are 0..n-1 clockwise; "left of X" is (X + 1) mod n. Who is human or bot is a UI
// concern and is NOT in the engine state. Everything "per player" is an array indexed by seat.
//
// The state shape (each field is described where it is created, in startGame below):
//   kind 'game', schema, seed, n, rules, params, rulesCode, rng, deals, manualSeats,
//   firstDealer, dealer, handNo, handSize,
//   phase 'climb' | 'summit' | 'descent' | 'handEnd' | 'over', toAct, leader,
//   hands, out, climbPiles, descentPiles, climbTricks, descentTricks, lastDescentWin,
//   marker, summitTrick, forcedSummit, choices, choiceOrder, revealed,
//   brumbies, mob, trickNo, descentTrickNo, trick, tricks, handLog, totals, mobsHome, measures, result.
//
// 'handEnd' is a transient phase: it is set while a hand is reckoned inside applyAction (the
// at-the-heels, mob and Brumby events are emitted in it). A state returned by applyAction is never
// in 'handEnd': it is the next hand's 'climb', or 'over'.

import { CONSTANTS, resolveVariants, rulesCode, deriveParams, mobValueFor } from './rules.js';
import { makeRng, rngInt, shuffle } from './rng.js';
import { fullDeck, sortCards, isCard } from './cards.js';

const filled = (n, f) => Array.from({ length: n }, f);

/** Counters kept for stats, analytics and balance work (per game). */
export function emptyMeasures(n) {
  return {
    hands: 0, // completed hands
    tricks: 0, // completed tricks, climb and descent
    climbTricks: 0, // completed climb tricks
    descentTricks: 0, // completed descent tricks
    summitTrickSum: 0, // sum over hands of the summit trick (climb tricks played); / hands = average
    offSuitSteps: 0, // marker steps that came from off-suit cards (the breakaway)
    overshoots: 0, // summits reached with steps to spare (R4.8)
    forcedSummits: 0, // summits forced because the cards nearly ran out (never under standard constants)
    chaserCounts: filled(n + 1, () => 0), // hands by number of chasers, index 0..n
    nobodyChased: 0, // hands that ended at the summit (R6)
    mobsHome: 0, // hands in which a chaser brought the mob home
    loneChaserHomes: 0, // ... by the only chaser
    fewestClimbHomes: 0, // ... by a player with the fewest climb tricks at the table
    escapes: 0, // hands in which the mob escaped (nobody chased, or a watcher at the heels)
    watcherAtHeels: 0, // escapes because a watcher was at the heels (R8.5)
    falls: 0, // chasers who fell (R9.3), summed over hands
    tieAtHeels: 0, // hands where the later-trick rule decided the heels (R8.2)
    brumbiesAdded: 0, // Brumby cards put under the Colt
    brumbyCapHits: 0, // escapes that added nothing because all 4 were there (R10.3)
    maxBrumbies: 0, // the largest stack seen at the start of a hand
    mobsHomeBySeat: filled(n, () => 0),
    fallsBySeat: filled(n, () => 0),
    chasesBySeat: filled(n, () => 0),
  };
}

function checkDeal(deal, state) {
  const { n, params } = state;
  const k = params.handSize;
  if (!deal || !Array.isArray(deal.hands) || deal.hands.length !== n || deal.hands.some((h) => !Array.isArray(h) || h.length !== k)) {
    throw new Error(`A fixed deal needs ${n} hands of ${k} cards`);
  }
  const all = deal.hands.flat();
  if (all.some((c) => !isCard(c))) throw new Error('A fixed deal holds a card that is not in the deck');
  if (new Set(all).size !== all.length) throw new Error('A fixed deal contains a card twice');
}

/**
 * Deals hand `state.handNo` (R2.3, R2.5, R2.6, R3): sets the dealer and first leader, gathers and
 * shuffles all 48 cards, deals, resets the marker, the piles and the summit choices.
 * The Brumby stack and the scores carry over (R10.1). Pushes an event when `events` is an array.
 */
export function dealHand(state, events) {
  const { n, params } = state;
  const h = state.handNo;
  const k = params.handSize;
  state.dealer = (state.firstDealer + h) % n; // R2.3 the deal passes left
  state.leader = (state.dealer + 1) % n; // R2.3 the player on the dealer's left leads

  const fixed = state.deals && state.deals[h] ? state.deals[h] : null;
  let packets;
  if (fixed) {
    checkDeal(fixed, state);
    packets = fixed.hands.map((x) => [...x]);
    const dealt = new Set(packets.flat());
    state.out = fullDeck().filter((c) => !dealt.has(c));
  } else {
    // R3.3 shuffle the whole deck, deal k each from the seat left of the dealer; the rest are out unseen.
    const deck = shuffle(state.rng, fullDeck());
    packets = filled(n, () => []);
    for (let i = 0; i < n; i++) packets[(state.dealer + 1 + i) % n] = deck.slice(i * k, (i + 1) * k);
    state.out = deck.slice(n * k);
  }
  state.out = sortCards(state.out);
  state.hands = packets.map((p) => sortCards(p));
  state.climbPiles = filled(n, () => []);
  state.descentPiles = filled(n, () => []);
  state.climbTricks = filled(n, () => 0);
  state.descentTricks = filled(n, () => 0);
  state.lastDescentWin = filled(n, () => -1);
  state.marker = 0;
  state.summitTrick = null;
  state.forcedSummit = false;
  state.choices = filled(n, () => null);
  state.choiceOrder = [];
  state.revealed = false;
  state.mob = mobValueFor(params, state.brumbies);
  state.trick = null;
  state.tricks = [];
  state.trickNo = 0;
  state.descentTrickNo = 0;
  state.handSize = k;
  state.phase = 'climb'; // R4.1
  state.toAct = state.leader;
  state.measures.maxBrumbies = Math.max(state.measures.maxBrumbies, state.brumbies);
  if (events) {
    events.push({
      type: 'hand-started', handNo: h, dealer: state.dealer, leader: state.leader, handSize: k, handsPerGame: params.handsPerGame,
      outCount: state.out.length, summitStep: params.summitStep, mountainSide: params.mountainSide, brumbies: state.brumbies, mob: state.mob,
    });
  }
}

/**
 * A new game, dealt and ready for the first decision, plus the events of the start.
 * @param {object} opts
 * @param {number|string} opts.seed       drives the first dealer (if random) and every shuffle
 * @param {number} opts.players           2 to 5
 * @param {object} [opts.rules]           variant overrides: there are none, so any name throws
 * @param {number|null} [opts.firstDealer] seat of the first dealer; default drawn from the seed (R2.2)
 * @param {Array<{hands: string[][]}>|null} [opts.deals]
 *        fixed deals by hand index (replays, tests): hands by seat. Hands without an entry are
 *        shuffled from the seed.
 * @param {number[]} [opts.manualSeats] seats whose single-option card plays are NOT auto-applied
 *        (learners click even a forced card). Not a rule: never in `rules` or the rules code.
 * @param {number} [opts.startBrumbies] TESTS AND FIXTURES ONLY: the Brumby stack at the start
 *        (0..BRUMBY_MAX; default 0, R2.7). Lets a single hand be replayed with a given mob.
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
  const startBrumbies = opts.startBrumbies === undefined || opts.startBrumbies === null ? 0 : opts.startBrumbies;
  if (!Number.isInteger(startBrumbies) || startBrumbies < 0 || startBrumbies > params.brumbyMax) throw new Error(`startBrumbies must be 0..${params.brumbyMax}`);

  const state = {
    kind: 'game',
    schema: 1,
    seed: String(seed),
    n,
    rules, // {} : no switches
    params, // deriveParams(): hand size, summit step, mob numbers ... fixed for the game
    rulesCode: rulesCode(rules, n), // always 'std'
    rng, // the game's RNG stream (shuffles)
    deals: deals ? JSON.parse(JSON.stringify(deals)) : null,
    manualSeats,
    firstDealer: dealer0,
    dealer: dealer0,
    handNo: 0, // index of the hand being played (= hands completed)
    handSize: 0, // cards dealt to each player this hand
    phase: 'climb', // 'climb' | 'summit' | 'descent' | 'handEnd' (transient) | 'over'
    toAct: null, // the seat deciding now; null when the game is over
    leader: null, // the seat that leads (or led) the current trick
    hands: filled(n, () => []), // cards in hand by seat, sorted (R1.3)
    out: [], // cards not dealt: out of play, unseen all hand (R3.2)
    climbPiles: filled(n, () => []), // cards of the climb tricks each seat won (face down)
    descentPiles: filled(n, () => []), // cards of the descent tricks each seat won (sideways)
    climbTricks: filled(n, () => 0), // climb tricks won this hand (public counts, R12.3)
    descentTricks: filled(n, () => 0), // descent tricks won this hand
    lastDescentWin: filled(n, () => -1), // index (0-based) of each seat's latest descent-trick win; -1 none (R8.2)
    marker: 0, // the mob marker's step, 0..summitStep (shown capped, R4.8)
    summitTrick: null, // climb tricks played when the summit was reached; null before
    forcedSummit: false, // the summit was forced by the cards nearly running out (only under probe constants)
    choices: filled(n, () => null), // summit choice per seat: null | 'chase' | 'watch' (HIDDEN until revealed)
    choiceOrder: [], // the order the summit choices are collected in (R5.5)
    revealed: false, // the choices have been revealed (R5.6)
    brumbies: startBrumbies, // Brumby cards under the Colt, 0..4; persists across hands (R10.1)
    mob: 0, // this hand's mob value, 3 + 2 x brumbies at the deal (R10.5)
    trickNo: 0, // completed tricks this hand, climb and descent
    descentTrickNo: 0, // completed descent tricks this hand
    trick: null, // the trick being played, or null
    tricks: [], // completed tricks this hand (public history, R12.8)
    handLog: [], // one record per finished hand (scoring.js / actions.js endHand)
    totals: filled(n, () => 0), // running totals over finished hands
    mobsHome: filled(n, () => 0), // hands in which each seat brought the mob home (the tiebreak, R11.6)
    measures: emptyMeasures(n),
    result: null, // gameResult() once the game is over
  };
  const events = [{ type: 'game-started', players: n, firstDealer: dealer0, rules: { ...rules }, rulesCode: state.rulesCode, handsPerGame: params.handsPerGame, summitStep: params.summitStep, mountainSide: params.mountainSide }];
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
