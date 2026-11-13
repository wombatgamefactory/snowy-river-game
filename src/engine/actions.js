// actions.js - applyAction (returns events).
//
// applyAction(state, action) mutates `state` and RETURNS the events it produced; nothing is
// logged into the state. It throws, before changing anything, if getActionBlockReason refuses.
//
// After the action, every decision that has exactly ONE legal option is applied at once and its
// events carry `auto: true` (R4.10, R12.2): the only card of the led suit, the last card of each half.
// The summit (R5.5), hand ends and the next deal happen inside the same call, so one call can return the
// last climb trick, the summit, ... the scoring, the next deal and even the game result. The UI walks
// those events (board.js).
//
// A completed trick (state.tricks, and handLog[h].tricks) is:
//   { n (1..12 in the hand), half: 'climb'|'descent', halfTrickNo (1..6), phase (= half), leader, seats,
//     ledSuit, trump, direction ('highest'|'lowest'), plays: [{ seat, card, offSuit, trump }], winner,
//     winningCard, byTrump, prize (the Climb card id on the climb, the Brumby id on the descent),
//     prizeValue }
//
// Event types, in the order they can occur (fields where each is pushed below):
//   game-started, hand-started, card-played, trick-won, climb-card-taken (climb),
//   summit-opened (after the 6th climb trick), brumby-taken (descent), hand-ended, brumby-reshuffled, game-over

import { cardSuit, cardNumber, brumbyValue, climbCardValue, sortCards, isBrumby } from './cards.js';
import { trumpFor, directionFor } from './rules.js';
import { isCardPhase, getActionBlockReason, getValidActions, trickWinner } from './legality.js';
import { dealHand, reshuffleBrumbies } from './state.js';
import { reckonHand, gameResult } from './scoring.js';

/**
 * Applies one action by state.toAct, then any forced (single-option) decisions.
 * @param {object} state
 * @param {object} action
 * @param {{silent?: boolean}} [opts]  silent: skip building events (search / simulator speed)
 * @returns {object[]} events (empty array when silent)
 */
export function applyAction(state, action, opts = {}) {
  const reason = getActionBlockReason(state, action);
  if (reason !== null) throw new Error(reason);
  const events = opts.silent ? null : [];
  playCard(state, action.card, events, false);
  runForced(state, events);
  return events || [];
}

/**
 * Applies single-option decisions until a real choice or the end. A card play by one of
 * state.manualSeats is left for that seat to make, even when it is the only legal card.
 */
function runForced(state, events) {
  const manual = state.manualSeats || [];
  while (state.toAct !== null) {
    if (isCardPhase(state.phase) && manual.includes(state.toAct)) return;
    const acts = getValidActions(state);
    if (acts.length !== 1) return;
    playCard(state, acts[0].card, events, true);
  }
}

// ---------- card play ----------

function playCard(state, card, events, auto) {
  const seat = state.toAct;
  const n = state.n;
  const half = state.phase;
  const trump = trumpFor(state.params, half);
  if (state.trick === null) {
    const halfTrickNo = half === 'descent' ? state.descentTrickNo + 1 : state.climbTrickNo + 1;
    state.trick = { n: state.trickNo + 1, half, halfTrickNo, phase: half, leader: seat, seats: Array.from({ length: n }, (_, k) => (seat + k) % n), ledSuit: null, trump, direction: directionFor(half), plays: [] };
  }
  const t = state.trick;
  state.hands[seat] = state.hands[seat].filter((c) => c !== card);
  const lead = t.ledSuit === null;
  if (lead) t.ledSuit = cardSuit(card);
  const offSuit = !lead && cardSuit(card) !== t.ledSuit;
  const isTrump = cardSuit(card) === trump;
  t.plays.push({ seat, card, offSuit, trump: isTrump });
  if (events) {
    events.push({ type: 'card-played', handNo: state.handNo, trickNo: t.n, half, halfTrickNo: t.halfTrickNo, phase: half, seat, card, value: cardNumber(card), asLeader: t.plays.length === 1, setsSuit: lead, ledSuit: t.ledSuit, offSuit, trump: isTrump, auto });
  }
  const i = t.seats.indexOf(seat);
  if (i < t.seats.length - 1) {
    state.toAct = t.seats[i + 1];
    return;
  }
  resolveTrick(state, events);
}

/** R9.1: the order of the end of a trick. */
function resolveTrick(state, events) {
  const t = state.trick;
  const m = state.measures;
  const P = state.params;
  const descent = t.half === 'descent';
  const win = trickWinner(t.plays, t.ledSuit, t.half, t.trump); // R4.4 / R6.3
  const w = win.seat;
  // (3) the row card at this trick's position goes to the winner, good or bad (R4.8, R6.6)
  const pos = descent ? state.descentTrickNo : state.climbTrickNo; // 0-based
  const prize = descent ? state.row[pos] : state.climbRow[pos];
  const prizeValue = descent ? brumbyValue(prize) : climbCardValue(prize);
  const record = {
    n: t.n, half: t.half, halfTrickNo: t.halfTrickNo, phase: t.half, leader: t.leader, seats: [...t.seats], ledSuit: t.ledSuit, trump: t.trump,
    direction: t.direction, plays: t.plays.map((p) => ({ seat: p.seat, card: p.card, offSuit: p.offSuit, trump: p.trump })),
    winner: w, winningCard: win.card, byTrump: win.byTrump, prize, prizeValue,
  };
  // (2) R4.7 the winner takes the trick into their one pile
  state.piles[w].push(...t.plays.map((p) => p.card));
  state.trick = null;
  state.trickNo++;
  m.tricks++;
  if (win.byTrump) m.trumpWins++;
  state.tricks.push(record);
  const trickEvent = () => ({
    type: 'trick-won', handNo: state.handNo, trickNo: record.n, half: t.half, halfTrickNo: t.halfTrickNo, phase: t.half, winner: w, card: win.card,
    value: cardNumber(win.card), ledSuit: record.ledSuit, trump: t.trump, direction: t.direction, byTrump: win.byTrump,
    plays: record.plays.map((p) => ({ ...p })), climbTricks: [...state.climbTricks], descentTricks: [...state.descentTricks],
  });

  if (!descent) {
    state.climbTricks[w]++;
    m.climbTricks++;
    state.climbRow[pos] = null;
    state.climbCards[w].push(prize);
    m.climbValueSum += prizeValue;
    if (prizeValue < 0) m.minusBySeat[w]++;
    state.climbTrickNo++;
    if (events) {
      events.push(trickEvent());
      events.push({
        type: 'climb-card-taken', handNo: state.handNo, trickNo: record.n, halfTrickNo: t.halfTrickNo, position: pos + 1, winner: w, card: prize, value: prizeValue,
        climbCards: [...state.climbCards[w]], climbValue: state.climbCards[w].reduce((a, id) => a + climbCardValue(id), 0),
      });
    }
    state.leader = w; // the winner leads the next trick (R4.7), and the descent after the summit (R6.1)
    if (state.climbTrickNo >= P.climbTricks) { openSummit(state, w, events); return; } // R4.9
    state.toAct = w;
    return;
  }

  // R6.6 the descent: the trick's Brumby card goes to the winner, always
  state.descentTricks[w]++;
  m.descentTricks++;
  state.row[pos] = null;
  state.kept[w].push(prize);
  if (prize === 'colt') m.coltBySeat[w]++;
  state.descentTrickNo++;
  if (events) {
    events.push(trickEvent());
    events.push({
      type: 'brumby-taken', handNo: state.handNo, trickNo: record.n, halfTrickNo: t.halfTrickNo, position: pos + 1, winner: w, card: prize, value: prizeValue,
      kept: [...state.kept[w]], keptValue: state.kept[w].reduce((a, id) => a + brumbyValue(id), 0),
    });
  }
  if (state.descentTrickNo >= P.descentTricks) { endHand(state, events); return; } // R9.1 (4)
  state.leader = w; // R6.7
  state.toAct = w;
}

// ---------- the summit ----------

/** Takes the hand's row from the deck: the fixed row of the test hook, else the top 6 (R5.3). */
function dealRow(state) {
  const P = state.params;
  const fixed = state.deals && state.deals[state.handNo] && state.deals[state.handNo].row ? state.deals[state.handNo].row : null;
  if (state.brumbyDeck.length < P.rowSize) throw new Error(`The Brumby deck holds ${state.brumbyDeck.length} cards at the summit; R8.4 keeps at least ${P.rowSize}`);
  if (!fixed) return state.brumbyDeck.splice(0, P.rowSize);
  const row = [];
  for (const want of fixed) {
    const i = typeof want === 'number' ? state.brumbyDeck.findIndex((id) => brumbyValue(id) === want) : (isBrumby(want) ? state.brumbyDeck.indexOf(want) : -1);
    if (i < 0) throw new Error(`Fixed row of hand ${state.handNo}: ${JSON.stringify(want)} is not in the Brumby deck (${state.brumbyDeck.join(' ')})`);
    row.push(state.brumbyDeck.splice(i, 1)[0]);
  }
  return row;
}

/**
 * R5.1 to R5.5: after the 6th climb trick, in one step: lowest wins and Home is trumps from now on, the
 * top 6 Brumby cards are laid face up, and the winner of the last climb trick leads the descent (R6.1).
 * No decision is asked of anyone.
 */
function openSummit(state, lastWinner, events) {
  const m = state.measures;
  state.phase = 'summit'; // never rests here: set for the length of this function only
  state.hands = state.hands.map((h) => sortCards(h, 'descent')); // R1.4 display order for the descent
  const fresh = state.freshDeck;
  state.row = dealRow(state);
  state.rowDealt = [...state.row];
  state.freshDeck = false;
  state.rowFresh = fresh;
  state.topHomeSeat = topHomeOf(state);
  const values = state.row.map(brumbyValue);
  const rowValue = values.reduce((a, b) => a + b, 0);
  m.rowValueSum += rowValue;
  if (state.row.includes('colt')) m.coltRows++;
  state.phase = 'descent';
  state.leader = lastWinner; // R6.1
  state.toAct = lastWinner;
  if (events) {
    events.push({
      type: 'summit-opened', handNo: state.handNo, trickNo: state.trickNo, climbTricks: [...state.climbTricks], trump: state.params.trumpDescent, direction: 'lowest',
      row: [...state.row], rowValues: values, rowValue, colt: state.row.includes('colt'), deckCount: state.brumbyDeck.length, freshDeck: fresh, leader: lastWinner,
    });
  }
}

// ---------- the end of a hand (R9.3) ----------

/**
 * The seat holding the lowest-numbered Home card among the cards in hand at the summit, or null if nobody
 * holds a Home card then (R7.6 `topHomeSeat`; the Python's "top Home holder", D9).
 */
function topHomeOf(state) {
  let best = null;
  let bestN = Infinity;
  state.hands.forEach((h, s) => {
    for (const c of h) {
      if (cardSuit(c) !== state.params.trumpDescent) continue;
      const v = cardNumber(c);
      if (v < bestN) { bestN = v; best = s; }
    }
  });
  return best;
}

function endHand(state, events) {
  const n = state.n;
  const m = state.measures;
  const P = state.params;
  state.phase = 'handEnd';
  state.toAct = null;

  // 1. score every seat (R7) and 2. add to the pad
  const rk = reckonHand(state);
  for (let s = 0; s < n; s++) state.totals[s] += rk.scores[s];
  for (const sc of rk.scores) if (sc < 0) m.negativeHands++;
  const climbValues = state.climbRowDealt.map(climbCardValue);
  const minusIdx = climbValues.indexOf(-1);
  const minusRec = minusIdx >= 0 ? state.tricks.find((t) => t.half === 'climb' && t.halfTrickNo === minusIdx + 1) : null;
  const coltIdx = state.rowDealt.indexOf('colt');
  const coltRec = coltIdx >= 0 ? state.tricks.find((t) => t.half === 'descent' && t.prize === 'colt') : null;
  const values = state.rowDealt.map(brumbyValue);
  const rec = {
    handNo: state.handNo,
    dealer: state.dealer,
    firstLeader: (state.dealer + 1) % n,
    descentLeader: state.tricks.find((t) => t.half === 'descent').leader,
    climbTricks: [...state.climbTricks],
    descentTricks: [...state.descentTricks],
    trickCounts: state.climbTricks.map((c, s) => c + state.descentTricks[s]),
    climbRow: [...state.climbRowDealt],
    climbRowValues: climbValues,
    minusPosition: minusIdx >= 0 ? minusIdx + 1 : null,
    minusWinner: minusRec ? minusRec.winner : null,
    climbCards: state.climbCards.map((k) => [...k]),
    climbValues: rk.breakdown.map((b) => b.climbValue),
    kept: state.kept.map((k) => [...k]),
    keptValues: rk.breakdown.map((b) => b.keptValue),
    scores: rk.scores,
    breakdown: rk.breakdown,
    row: [...state.rowDealt],
    rowValues: values,
    rowValue: values.reduce((a, b) => a + b, 0),
    colt: coltIdx >= 0,
    coltTrick: coltIdx >= 0 ? coltIdx + 1 : null,
    coltWinner: coltRec ? coltRec.winner : null,
    topHomeSeat: state.topHomeSeat,
    home1Seat: state.home1Seat,
    reshuffled: state.rowFresh === true,
    totalsAfter: [...state.totals],
    tricks: state.tricks,
  };
  m.hands++;
  state.handLog.push(rec);
  if (events) {
    const { tricks, ...summary } = rec;
    events.push({ type: 'hand-ended', ...JSON.parse(JSON.stringify(summary)), totals: [...state.totals] });
  }

  // 3. every Brumby card of the hand goes to the discard (R8.3); the Climb cards are gathered (R8.8)
  for (let s = 0; s < n; s++) { state.brumbyDiscard.push(...state.kept[s]); state.kept[s] = []; }
  for (const id of state.row) if (id !== null) state.brumbyDiscard.push(id);
  state.row = [];
  state.climbRow = [];
  state.climbCards = state.climbCards.map(() => []);
  state.tricks = [];

  // 4. next hand, or the end of the game
  state.handNo++;
  if (state.handNo >= P.handsPerGame) {
    state.phase = 'over';
    state.toAct = null;
    state.result = gameResult(state);
    if (events) events.push({ type: 'game-over', ...JSON.parse(JSON.stringify(state.result)) });
    return;
  }
  if (state.brumbyDeck.length < P.reshuffleBelow) reshuffleBrumbies(state, events); // R8.4, only if another hand follows
  dealHand(state, events); // R2.5 everything gathered and reshuffled; R3.5 a new Climb row
}
