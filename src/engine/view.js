// view.js - what one seat may know (R10), and the helpers a search bot builds worlds from.
//
// viewFor(state, seat) is the ONLY thing a bot receives. It holds the seat's own hand and
// everything public: every seat's card count, the phase, direction and trump of this half, each seat's
// trick COUNTS, the current trick (with the card winning it so far), this hand's completed tricks (public
// history, R10.10), the face-up Climb row and Brumby row, every seat's taken Climb and Brumby cards and
// running hand score, the public discard, the Brumby deck's COUNT, the pad. Never: another seat's cards,
// the cards out of play (count only, R10.9), the Brumby deck's order or contents as such (R10.7).
// There is no hidden choice in v6.
//
//   viewFor(state, seat)                the view
//   legalActionsFromView(view)          the seat's legal actions, from the view alone
//   shownVoids(view)                    suits each seat has shown it lacks (this hand)
//   unknownCards(view)                  playing cards the viewer cannot place
//   unseenBrumbies(view)                Brumby ids that are not face up anywhere (= the deck's contents)
//   dealRespectingVoids(...)            GENERIC: deals a pool of unknown cards to seats, honouring voids
//   determinise(view, rng)              a complete state consistent with the view, for search bots

import { SUIT_ORDER, directionFor } from './rules.js';
import { cardSuit, fullDeck, sortCards, brumbyDeck, brumbyValue, climbCardValue } from './cards.js';
import { legalActionsFor, trickWinner } from './legality.js';
import { forkRng, shuffle } from './rng.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

// Fast copies of the history records (viewFor runs at every bot decision).
const copyPlays = (plays) => plays.map((p) => ({ seat: p.seat, card: p.card, offSuit: p.offSuit, trump: p.trump }));
const copyTrick = (t) => ({ ...t, seats: [...t.seats], plays: copyPlays(t.plays) });

function copyMeasures(m) {
  const out = { ...m };
  for (const k of Object.keys(m)) if (Array.isArray(m[k])) out[k] = [...m[k]];
  return out;
}

function copyHandRecord(h) {
  const out = { ...h };
  for (const k of ['climbTricks', 'descentTricks', 'trickCounts', 'climbRow', 'climbRowValues', 'climbValues', 'keptValues', 'scores', 'row', 'rowValues', 'totalsAfter']) out[k] = [...h[k]];
  out.climbCards = h.climbCards.map((k) => [...k]);
  out.kept = h.kept.map((k) => [...k]);
  out.breakdown = h.breakdown.map((b) => ({ ...b, climbCards: [...b.climbCards], kept: [...b.kept] }));
  out.tricks = h.tricks.map(copyTrick);
  return out;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * R10.12 the price line: the row card the trick being played (or about to be led) takes, and the best and
 * worst cards still to come after it in the same row. Null when no trick is to be played.
 */
function priceLine(half, slots, next) {
  if (next === null || next >= slots.length || slots[next] === null || slots[next] === undefined) return null;
  const valueOf = half === 'descent' ? brumbyValue : climbCardValue;
  const later = slots.slice(next + 1).filter((id) => id !== null).map(valueOf);
  return {
    half,
    position: next + 1,
    card: slots[next],
    value: valueOf(slots[next]),
    laterValues: later,
    best: later.length ? Math.max(...later) : null,
    worst: later.length ? Math.min(...later) : null,
  };
}

/**
 * The view of `seat` (0..n-1). Plain JSON; a fresh copy each call.
 */
export function viewFor(state, seat) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.n) throw new Error(`viewFor needs a seat 0..${state.n - 1}, got ${seat}`);
  const P = state.params;
  const half = state.phase === 'descent' ? 'descent' : 'climb';
  const trump = half === 'descent' ? P.trumpDescent : P.trumpClimb;
  const playing = state.phase === 'climb' || state.phase === 'descent';
  let trick = null;
  if (state.trick) {
    trick = copyTrick(state.trick);
    const best = trickWinner(state.trick.plays, state.trick.ledSuit, state.trick.half, state.trick.trump);
    trick.best = best ? { ...best } : null; // R10.4 the card winning the trick so far
  }
  const climbValue = state.climbCards.map((k) => sum(k.map(climbCardValue)));
  const keptValue = state.kept.map((k) => sum(k.map(brumbyValue)));
  const climbNext = state.phase === 'climb' ? state.climbTrickNo : null;
  const rowNext = state.phase === 'descent' ? state.descentTrickNo : null;
  return {
    kind: 'view',
    seat,
    n: state.n,
    rules: { ...state.rules },
    params: { ...P, suits: [...P.suits] },
    rulesCode: state.rulesCode,
    phase: state.phase, // 'climb' | 'descent' | 'over'
    toAct: state.toAct,
    hand: [...state.hands[seat]],
    handCounts: state.hands.map((h) => h.length),
    outCount: state.out.length,
    firstDealer: state.firstDealer,
    dealer: state.dealer,
    leader: state.leader,
    handNo: state.handNo,
    handsPerGame: P.handsPerGame,
    trickNo: state.trickNo,
    climbTrickNo: state.climbTrickNo,
    descentTrickNo: state.descentTrickNo,
    half, // 'climb' | 'descent' (R10.3, R10.12)
    direction: directionFor(half), // 'highest' | 'lowest'
    trump, // the trump suit of that half
    climbTricks: [...state.climbTricks],
    descentTricks: [...state.descentTricks],
    trickCounts: state.climbTricks.map((c, s) => c + state.descentTricks[s]),
    // R10.5 (a) the Climb row: 6 slots, null = taken; the dealt order and values; the next position (0-based)
    climbRow: [...state.climbRow],
    climbRowDealt: [...state.climbRowDealt],
    climbRowValues: state.climbRowDealt.map(climbCardValue),
    climbNext,
    // R10.5 (b) the Brumby row from the summit: 6 slots, null = taken; [] on the climb
    row: [...state.row],
    rowValues: state.row.map((id) => (id === null ? null : brumbyValue(id))),
    rowDealt: [...state.rowDealt],
    rowValue: sum(state.rowDealt.map(brumbyValue)),
    rowNext,
    // R10.6 every seat's taken cards, face up, in the order won, with subtotals and the running hand score
    climbCards: state.climbCards.map((k) => [...k]),
    climbValue,
    kept: state.kept.map((k) => [...k]),
    keptValue,
    handScore: climbValue.map((c, s) => c + keptValue[s]),
    discard: [...state.brumbyDiscard], // R10.8 public
    deckCount: state.brumbyDeck.length, // R10.7 count only
    price: playing ? priceLine(half, half === 'descent' ? state.row : state.climbRow, half === 'descent' ? rowNext : climbNext) : null, // R10.12
    trick,
    tricks: state.tricks.map(copyTrick),
    handLog: state.handLog.map(copyHandRecord),
    totals: [...state.totals],
    measures: copyMeasures(state.measures),
    result: state.result ? clone(state.result) : null,
  };
}

/** The legal actions for the viewing seat, computed from the view alone (empty if not its turn). */
export function legalActionsFromView(view) {
  if (view.toAct !== view.seat) return [];
  return legalActionsFor(view.phase, view.hand, view.trick);
}

/**
 * Suits each seat has SHOWN it lacks this hand: a card off the led suit shows a void in the led
 * suit (R10.11). Voids last the hand (cards are never drawn).
 * @returns {string[][]} by seat, in display suit order
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

/** Playing cards the viewer cannot place: other seats' hands plus the cards out of play. Sorted. */
export function unknownCards(view) {
  const known = knownCards(view);
  return sortCards(fullDeck(view.n).filter((c) => !known.has(c)));
}

/**
 * Brumby ids that are not face up anywhere (row, taken piles, discard): exactly the deck's contents,
 * which anyone can work out from the public cards (R10.7, R10.8). The ORDER is unknown. In deck-list order.
 */
export function unseenBrumbies(view) {
  const seen = new Set([...view.row.filter((id) => id !== null), ...view.kept.flat(), ...view.discard]);
  return brumbyDeck().filter((id) => !seen.has(id));
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
 * voids; the rest are the cards out. The Brumby deck is the unseen Brumby cards in a random order. Everything
 * else (both rows, taken cards, the discard, the pad) is public and copied. `topHomeSeat` and `home1Seat` are
 * statistics, not rules: null in a world unless the view's own seat settles them.
 * @param {object} view
 * @param {{s:number}} rng
 */
export function determinise(view, rng) {
  const n = view.n;
  const me = view.seat;
  const unknown = unknownCards(view);
  const voids = shownVoids(view).map((v) => new Set(v));
  const others = Array.from({ length: n }, (_, s) => s).filter((s) => s !== me);
  const need = Array.from({ length: n }, (_, s) => (s === me ? 0 : view.handCounts[s]));
  const dealt = dealRespectingVoids(unknown, need, voids, rng, others);
  const hands = dealt.hands;
  hands[me] = [...view.hand];
  const half = view.half;

  const tricks = clone(view.tricks);
  const piles = Array.from({ length: n }, () => []);
  for (const t of tricks) piles[t.winner].push(...t.plays.map((p) => p.card));
  const trick = view.trick ? clone(view.trick) : null;
  if (trick) delete trick.best;
  return {
    kind: 'game',
    schema: 3,
    seed: 'determinised',
    n,
    rules: { ...view.rules },
    params: { ...view.params, suits: [...view.params.suits] },
    rulesCode: view.rulesCode,
    rng: forkRng(rng),
    deals: null,
    manualSeats: [],
    firstDealer: view.firstDealer,
    dealer: view.dealer,
    handNo: view.handNo,
    phase: view.phase,
    toAct: view.toAct,
    leader: view.leader,
    hands: hands.map((h) => sortCards(h, half)),
    out: sortCards(dealt.leftover),
    piles,
    climbTricks: [...view.climbTricks],
    descentTricks: [...view.descentTricks],
    trickNo: view.trickNo,
    climbTrickNo: view.climbTrickNo,
    descentTrickNo: view.descentTrickNo,
    trick,
    tricks,
    climbRow: [...view.climbRow],
    climbRowDealt: [...view.climbRowDealt],
    climbCards: view.climbCards.map((k) => [...k]),
    brumbyDeck: shuffle(rng, unseenBrumbies(view)),
    brumbyDiscard: [...view.discard],
    freshDeck: false,
    row: [...view.row],
    rowDealt: [...view.rowDealt],
    rowFresh: false,
    kept: view.kept.map((k) => [...k]),
    topHomeSeat: null,
    home1Seat: null,
    handLog: clone(view.handLog),
    totals: [...view.totals],
    measures: clone(view.measures),
    result: view.result ? clone(view.result) : null,
  };
}
