// view.js - what one seat may know (R12), and the helpers a search bot builds worlds from.
//
// viewFor(state, seat) is the ONLY thing a bot receives. It holds the seat's own hand and
// everything public: every seat's card count, the marker, the Brumby stack and the mob's value, each
// seat's climb and descent trick COUNTS, the current trick, this hand's completed tricks (public
// history, R12.8), the pad. Never: another seat's cards, the cards out of play (count only, R12.7),
// the cards of a gathered trick pile beyond the public history, or another seat's summit choice
// before the reveal (R12.5: only whether they have locked in).
//
//   viewFor(state, seat)                the view
//   legalActionsFromView(view)          the seat's legal actions, from the view alone
//   shownVoids(view)                    suits each seat has shown it lacks (this hand)
//   unknownCards(view)                  cards the viewer cannot place
//   dealRespectingVoids(...)            GENERIC: deals a pool of unknown cards to seats, honouring voids
//   determinise(view, rng, opts)        a complete state consistent with the view, for search bots

import { SUIT_ORDER } from './rules.js';
import { cardSuit, fullDeck, sortCards } from './cards.js';
import { legalActionsFor } from './legality.js';
import { forkRng, rngNext, shuffle } from './rng.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

// Fast copies of the history records (viewFor runs at every bot decision).
const copyPlays = (plays) => plays.map((p) => ({ seat: p.seat, card: p.card, offSuit: p.offSuit }));
const copyTrick = (t) => ({ ...t, seats: [...t.seats], plays: copyPlays(t.plays) });

function copyMeasures(m) {
  const out = { ...m };
  for (const k of Object.keys(m)) if (Array.isArray(m[k])) out[k] = [...m[k]];
  return out;
}

function copyHandRecord(h) {
  const out = { ...h };
  for (const k of ['choices', 'chaserSeats', 'climbTricks', 'descentTricks', 'scores', 'outcomes', 'totalsAfter']) out[k] = [...h[k]];
  out.breakdown = h.breakdown.map((b) => ({ ...b }));
  out.tricks = h.tricks.map(copyTrick);
  return out;
}

/**
 * The view of `seat` (0..n-1). Plain JSON; a fresh copy each call.
 * Summit choices (R12.5): `choices[s]` is the side for the viewer's own seat once chosen, and for every
 * seat after the reveal; otherwise null. `chosen[s]` (locked in, a boolean) is public.
 */
export function viewFor(state, seat) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.n) throw new Error(`viewFor needs a seat 0..${state.n - 1}, got ${seat}`);
  const P = state.params;
  const revealed = state.revealed;
  return {
    kind: 'view',
    seat,
    n: state.n,
    rules: { ...state.rules },
    params: { ...P },
    rulesCode: state.rulesCode,
    phase: state.phase, // 'climb' | 'summit' | 'descent' | 'over'
    toAct: state.toAct,
    hand: [...state.hands[seat]],
    handCounts: state.hands.map((h) => h.length),
    outCount: state.out.length,
    firstDealer: state.firstDealer,
    dealer: state.dealer,
    leader: state.leader,
    handNo: state.handNo,
    handSize: state.handSize,
    trickNo: state.trickNo,
    descentTrickNo: state.descentTrickNo,
    marker: state.marker,
    summitStep: P.summitStep,
    mountainSide: P.mountainSide,
    summitTrick: state.summitTrick,
    forcedSummit: state.forcedSummit,
    brumbies: state.brumbies,
    mob: state.mob,
    climbTricks: [...state.climbTricks],
    descentTricks: [...state.descentTricks],
    lastDescentWin: [...state.lastDescentWin],
    choices: state.choices.map((c, s) => (revealed || s === seat ? c : null)),
    chosen: state.choices.map((c) => c !== null),
    choiceOrder: [...state.choiceOrder],
    revealed,
    stakes: { climbTricks: state.climbTricks[seat], climbPoints: state.climbTricks[seat] * P.climbTrickValue, mob: state.mob, fall: P.fallScore }, // R12.10
    trick: state.trick ? copyTrick(state.trick) : null,
    tricks: state.tricks.map(copyTrick),
    handLog: state.handLog.map(copyHandRecord),
    totals: [...state.totals],
    mobsHome: [...state.mobsHome],
    measures: copyMeasures(state.measures),
    result: state.result ? clone(state.result) : null,
  };
}

/** The legal actions for the viewing seat, computed from the view alone (empty if not its turn). */
export function legalActionsFromView(view) {
  if (view.toAct !== view.seat) return [];
  if (view.phase === 'summit' && view.chosen[view.seat]) return [];
  return legalActionsFor(view.phase, view.hand, view.trick);
}

/**
 * Suits each seat has SHOWN it lacks this hand: a card off the led suit shows a void in the led
 * suit (R12.9). Voids last the hand (cards are never drawn).
 * @returns {string[][]} by seat, in suit order
 */
export function shownVoids(view) {
  const out = Array.from({ length: view.n }, () => new Set());
  const scan = (t) => {
    let led = null;
    for (const p of t.plays) {
      const s = cardSuit(p.card);
      if (led === null) { led = s; continue; }
      if (s !== led) out[p.seat].add(led);
    }
  };
  for (const t of view.tricks) scan(t);
  if (view.trick) scan(view.trick);
  return out.map((set) => SUIT_ORDER.filter((s) => set.has(s)));
}

/** Every card the viewer can place this hand: own hand and every card played this hand. */
function knownCards(view) {
  const known = new Set(view.hand);
  for (const t of view.tricks) for (const p of t.plays) known.add(p.card);
  if (view.trick) for (const p of view.trick.plays) known.add(p.card);
  return known;
}

/** Cards the viewer cannot place: other seats' hands plus the cards out of play. Sorted. */
export function unknownCards(view) {
  const known = knownCards(view);
  return sortCards(fullDeck().filter((c) => !known.has(c)));
}

/**
 * GENERIC. Deals `pool` (cards nobody can place) to `seats`, `need[s]` cards each, giving no seat
 * a card of a suit it has shown it lacks. Retries with fresh shuffles (the most constrained seat
 * first on the later attempts); if no deal honours every void it ignores them (should not happen
 * for a consistent view). Returns { hands, leftover }: hands by seat (arrays, empty for seats not
 * in `seats`) and the cards nobody got (the cards out of play).
 */
export function dealRespectingVoids(pool, need, voids, rng, seats, suitOf = cardSuit) {
  const n = need.length;
  for (let attempt = 0; attempt < 40; attempt++) {
    const cards = shuffle(rng, [...pool]);
    const hands = Array.from({ length: n }, () => []);
    const order = attempt < 20 ? seats : [...seats].sort((a, b) => voids[b].size - voids[a].size);
    let ok = true;
    for (const s of order) {
      for (let i = 0; i < cards.length && hands[s].length < need[s];) {
        if (voids[s].has(suitOf(cards[i]))) { i++; continue; }
        hands[s].push(cards[i]);
        cards.splice(i, 1);
      }
      if (hands[s].length < need[s]) { ok = false; break; }
    }
    if (ok) return { hands, leftover: cards };
  }
  const cards = shuffle(rng, [...pool]);
  const hands = Array.from({ length: n }, () => []);
  for (const s of seats) hands[s].push(...cards.splice(0, need[s]));
  return { hands, leftover: cards };
}

/**
 * A complete game state consistent with the view, for search bots (clone it and play on with
 * applyAction). The other seats' hands are dealt uniformly from the unknown cards, respecting shown
 * voids; the rest are the cards out. Before the reveal, a seat that has locked in its summit choice
 * gets a guessed side: `opts.guessChoice(seat, view, rng)` if given, else a fair coin. Seats that
 * have not chosen yet stay null (the world asks them in turn).
 * @param {object} view
 * @param {{s:number}} rng
 * @param {{ guessChoice?: (seat:number, view:object, rng:{s:number}) => 'chase'|'watch' }} [opts]
 */
export function determinise(view, rng, opts = {}) {
  const n = view.n;
  const me = view.seat;
  const unknown = unknownCards(view);
  const voids = shownVoids(view).map((v) => new Set(v));
  const others = Array.from({ length: n }, (_, s) => s).filter((s) => s !== me);
  const need = Array.from({ length: n }, (_, s) => (s === me ? 0 : view.handCounts[s]));
  const dealt = dealRespectingVoids(unknown, need, voids, rng, others);
  const hands = dealt.hands;
  hands[me] = [...view.hand];

  const tricks = clone(view.tricks);
  const climbPiles = Array.from({ length: n }, () => []);
  const descentPiles = Array.from({ length: n }, () => []);
  for (const t of tricks) (t.phase === 'descent' ? descentPiles : climbPiles)[t.winner].push(...t.plays.map((p) => p.card));
  const guess = opts.guessChoice || ((_s, _v, r) => (rngNext(r) < 0.5 ? 'chase' : 'watch'));
  const choices = view.choices.map((c, s) => {
    if (c !== null) return c;
    if (view.chosen[s]) return guess(s, view, rng);
    return null;
  });
  return {
    kind: 'game',
    schema: 1,
    seed: 'determinised',
    n,
    rules: { ...view.rules },
    params: { ...view.params },
    rulesCode: view.rulesCode,
    rng: forkRng(rng),
    deals: null,
    manualSeats: [],
    firstDealer: view.firstDealer,
    dealer: view.dealer,
    handNo: view.handNo,
    handSize: view.handSize,
    phase: view.phase,
    toAct: view.toAct,
    leader: view.leader,
    hands: hands.map((h) => sortCards(h)),
    out: sortCards(dealt.leftover),
    climbPiles,
    descentPiles,
    climbTricks: [...view.climbTricks],
    descentTricks: [...view.descentTricks],
    lastDescentWin: [...view.lastDescentWin],
    marker: view.marker,
    summitTrick: view.summitTrick,
    forcedSummit: view.forcedSummit,
    choices,
    choiceOrder: [...view.choiceOrder],
    revealed: view.revealed,
    brumbies: view.brumbies,
    mob: view.mob,
    trickNo: view.trickNo,
    descentTrickNo: view.descentTrickNo,
    trick: view.trick ? clone(view.trick) : null,
    tricks,
    handLog: clone(view.handLog),
    totals: [...view.totals],
    mobsHome: [...view.mobsHome],
    measures: clone(view.measures),
    result: view.result ? clone(view.result) : null,
  };
}
