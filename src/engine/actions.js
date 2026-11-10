// actions.js - applyAction (returns events).
//
// applyAction(state, action) mutates `state` and RETURNS the events it produced; nothing is
// logged into the state. It throws, before changing anything, if getActionBlockReason refuses.
//
// After the action, every decision that has exactly ONE legal option is applied at once and its
// events carry `auto: true` (R4.10, R12.2): the only card of the led suit, the last card of each half.
// The summit choice always has two options, so it is never auto-applied. Hand ends and the next deal
// happen inside the same call, so one call can return the last trick, the scoring, the next deal and
// even the game result. The UI walks those events (board.js).
//
// A completed trick (state.tricks, and handLog[h].tricks) is:
//   { n (1..12 in the hand), half: 'climb'|'descent', halfTrickNo (1..6), phase (= half), leader, seats,
//     ledSuit, trump, plays: [{ seat, card, offSuit, trump }], winner, winningCard, byTrump,
//     prize (descent: the Brumby id at this trick's row position, else null),
//     prizeTo ('kept' | 'discard' | null) }
//
// Event types, in the order they can occur (fields where each is pushed below):
//   game-started, hand-started, card-played, trick-won, marker-moved (climb),
//   summit-opened, summit-chosen (no side!), summit-revealed, descent-started,
//   brumby-kept | brumby-discarded (descent), hand-ended, brumby-reshuffled, game-over

import { cardSuit, valueIn, sortCards, brumbyValue } from './cards.js';
import { trumpFor } from './rules.js';
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
  doAction(state, action, events, false);
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
    doAction(state, acts[0], events, true);
  }
}

function doAction(state, action, events, auto) {
  if (action.type === 'play') playCard(state, action.card, events, auto);
  else if (action.type === 'summit') chooseAtSummit(state, action.choice, events);
}

// ---------- card play ----------

function playCard(state, card, events, auto) {
  const seat = state.toAct;
  const n = state.n;
  const half = state.phase;
  const trump = trumpFor(state.params, half);
  if (state.trick === null) {
    const halfTrickNo = half === 'descent' ? state.descentTrickNo + 1 : state.marker + 1;
    state.trick = { n: state.trickNo + 1, half, halfTrickNo, phase: half, leader: seat, seats: Array.from({ length: n }, (_, k) => (seat + k) % n), ledSuit: null, trump, plays: [] };
  }
  const t = state.trick;
  state.hands[seat] = state.hands[seat].filter((c) => c !== card);
  const lead = t.ledSuit === null;
  if (lead) t.ledSuit = cardSuit(card);
  const offSuit = !lead && cardSuit(card) !== t.ledSuit;
  const isTrump = cardSuit(card) === trump;
  t.plays.push({ seat, card, offSuit, trump: isTrump });
  if (events) {
    events.push({ type: 'card-played', handNo: state.handNo, trickNo: t.n, half, halfTrickNo: t.halfTrickNo, phase: half, seat, card, value: valueIn(card, half), asLeader: t.plays.length === 1, setsSuit: lead, ledSuit: t.ledSuit, offSuit, trump: isTrump, auto });
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
  const record = {
    n: t.n, half: t.half, halfTrickNo: t.halfTrickNo, phase: t.half, leader: t.leader, seats: [...t.seats], ledSuit: t.ledSuit, trump: t.trump,
    plays: t.plays.map((p) => ({ seat: p.seat, card: p.card, offSuit: p.offSuit, trump: p.trump })),
    winner: w, winningCard: win.card, byTrump: win.byTrump, prize: null, prizeTo: null,
  };
  // R4.7 the winner takes the trick into their one pile
  state.piles[w].push(...t.plays.map((p) => p.card));
  state.trick = null;
  state.trickNo++;
  m.tricks++;
  if (win.byTrump) m.trumpWins++;
  const trickEvent = () => ({
    type: 'trick-won', handNo: state.handNo, trickNo: record.n, half: t.half, halfTrickNo: t.halfTrickNo, phase: t.half, winner: w, card: win.card,
    value: valueIn(win.card, t.half), ledSuit: record.ledSuit, trump: t.trump, byTrump: win.byTrump, plays: record.plays.map((p) => ({ ...p })),
    climbTricks: [...state.climbTricks], descentTricks: [...state.descentTricks],
  });

  if (!descent) {
    state.climbTricks[w]++;
    m.climbTricks++;
    const from = state.marker;
    state.marker++; // R4.8 one step per climb trick
    state.tricks.push(record);
    const summit = state.marker >= P.climbTricks; // R4.9
    if (events) {
      events.push(trickEvent());
      events.push({ type: 'marker-moved', handNo: state.handNo, trickNo: record.n, from, to: state.marker, summit, climbTricks: P.climbTricks });
    }
    state.leader = w; // the winner leads the next trick (R4.7), and the descent after the summit (R6.1)
    if (summit) { openSummit(state, w, events); return; }
    state.toAct = w;
    return;
  }

  // R6.6 the descent: the trick's row card goes to a chaser's kept pile or to the discard
  state.descentTricks[w]++;
  m.descentTricks++;
  const pos = state.descentTrickNo; // 0-based row position
  const prize = state.row[pos];
  state.row[pos] = null;
  const chaser = state.choices[w] === 'chase';
  if (chaser) { state.kept[w].push(prize); m.keptCards++; m.keptValue += brumbyValue(prize); } else { state.brumbyDiscard.push(prize); m.sentOff++; }
  record.prize = prize;
  record.prizeTo = chaser ? 'kept' : 'discard';
  state.descentTrickNo++;
  state.tricks.push(record);
  if (events) {
    events.push(trickEvent());
    const base = { handNo: state.handNo, trickNo: record.n, halfTrickNo: t.halfTrickNo, position: pos + 1, winner: w, card: prize, value: brumbyValue(prize) };
    if (chaser) events.push({ type: 'brumby-kept', ...base, kept: [...state.kept[w]], keptValue: state.kept[w].reduce((a, id) => a + brumbyValue(id), 0) });
    else events.push({ type: 'brumby-discarded', ...base, discardCount: state.brumbyDiscard.length });
  }
  if (state.descentTrickNo >= P.descentTricks) { endHand(state, events); return; } // R9.1 (4)
  state.leader = w; // R6.7
  state.toAct = w;
}

// ---------- the summit ----------

/** Takes the hand's row from the deck: the fixed row of the test hook, else the top 6 (R5.4). */
function dealRow(state) {
  const P = state.params;
  const fixed = state.deals && state.deals[state.handNo] && state.deals[state.handNo].row ? state.deals[state.handNo].row : null;
  if (state.brumbyDeck.length < P.rowSize) throw new Error(`The Brumby deck holds ${state.brumbyDeck.length} cards at the summit; R8.4 keeps at least ${P.rowSize}`);
  if (!fixed) return state.brumbyDeck.splice(0, P.rowSize);
  const row = [];
  for (const want of fixed) {
    const i = typeof want === 'number' ? state.brumbyDeck.findIndex((id) => brumbyValue(id) === want) : state.brumbyDeck.indexOf(want);
    if (i < 0) throw new Error(`Fixed row of hand ${state.handNo}: ${JSON.stringify(want)} is not in the Brumby deck (${state.brumbyDeck.join(' ')})`);
    row.push(state.brumbyDeck.splice(i, 1)[0]);
  }
  return row;
}

/**
 * R5.1 to R5.4: after the 6th climb trick everyone's hand turns round, the Mountain turns (Home is
 * trumps), the row is dealt; then one secret choice per seat, starting with the winner of the last
 * climb trick (R5.8).
 */
function openSummit(state, lastWinner, events) {
  const n = state.n;
  const m = state.measures;
  state.phase = 'summit';
  state.handsTurned = true; // R5.2
  state.hands = state.hands.map((h) => sortCards(h, 'descent'));
  const fresh = state.freshDeck;
  state.row = dealRow(state);
  state.rowDealt = [...state.row];
  state.freshDeck = false;
  state.rowFresh = fresh;
  state.topHomeSeat = topHomeOf(state);
  const values = state.row.map(brumbyValue);
  m.rowValueSum += values.reduce((a, b) => a + b, 0);
  if (state.row.includes('colt')) m.coltRows++;
  state.choices = Array.from({ length: n }, () => null);
  state.choiceOrder = Array.from({ length: n }, (_, k) => (lastWinner + k) % n);
  state.revealed = false;
  state.leader = lastWinner; // R6.1
  state.toAct = state.choiceOrder[0];
  if (events) {
    events.push({
      type: 'summit-opened', handNo: state.handNo, trickNo: state.trickNo, climbTricks: [...state.climbTricks], trump: state.params.trumpDescent,
      row: [...state.row], rowValues: values, rowValue: values.reduce((a, b) => a + b, 0), colt: state.row.includes('colt'),
      deckCount: state.brumbyDeck.length, freshDeck: fresh, chaseCost: state.params.chaseCost, order: [...state.choiceOrder], leader: lastWinner,
    });
  }
}

function chooseAtSummit(state, choice, events) {
  const seat = state.toAct;
  state.choices[seat] = choice;
  const chosen = state.choices.filter((c) => c !== null).length;
  // The event names the seat but NEVER the side: it goes to every viewer (R5.8, R10.6).
  if (events) events.push({ type: 'summit-chosen', handNo: state.handNo, seat, chosen, of: state.n });
  const next = state.choiceOrder.find((s) => state.choices[s] === null);
  if (next !== undefined) { state.toAct = next; return; }
  revealChoices(state, events);
}

/** R5.9 every choice is shown at once; then the descent, always (R5.10). */
function revealChoices(state, events) {
  const n = state.n;
  const m = state.measures;
  state.revealed = true;
  const chasers = [];
  const watchers = [];
  for (let s = 0; s < n; s++) (state.choices[s] === 'chase' ? chasers : watchers).push(s);
  m.chaserCounts[chasers.length]++;
  if (chasers.length === 0) m.nobodyChased++;
  for (const s of chasers) m.chasesBySeat[s]++;
  if (events) events.push({ type: 'summit-revealed', handNo: state.handNo, choices: [...state.choices], chasers, watchers, chaseCost: state.params.chaseCost });
  state.phase = 'descent';
  state.toAct = state.leader; // R6.1
  if (events) events.push({ type: 'descent-started', handNo: state.handNo, leader: state.leader, chasers, trump: state.params.trumpDescent });
}

// ---------- the end of a hand (R9.3) ----------

/**
 * The seat holding the Home card with the highest descent value (the lowest climb value) among the cards
 * in hand at the summit, or null if nobody holds a Home card (R7.7; the Python's "top Home holder").
 */
function topHomeOf(state) {
  let best = null;
  let bestV = Infinity;
  state.hands.forEach((h, s) => {
    for (const c of h) {
      if (cardSuit(c) !== state.params.trumpDescent) continue;
      const v = valueIn(c, 'climb');
      if (v < bestV) { bestV = v; best = s; }
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

  // 1. score every seat (R7) and add to the pad
  const rk = reckonHand(state);
  for (let s = 0; s < n; s++) state.totals[s] += rk.scores[s];
  const chaserSeats = state.choices.map((c, s) => (c === 'chase' ? s : -1)).filter((s) => s >= 0);
  m.chaseCostPaid += chaserSeats.length * P.chaseCost;
  const coltTrick = state.rowDealt.indexOf('colt');
  const coltRec = coltTrick >= 0 ? state.tricks.find((t) => t.prize === 'colt') : null;
  if (coltRec && coltRec.prizeTo === 'kept') m.coltKept++;
  const values = state.rowDealt.map(brumbyValue);
  const rec = {
    handNo: state.handNo,
    dealer: state.dealer,
    firstLeader: (state.dealer + 1) % n,
    descentLeader: state.tricks.find((t) => t.half === 'descent').leader,
    choices: [...state.choices],
    chasers: chaserSeats.length,
    chaserSeats,
    climbTricks: [...state.climbTricks],
    descentTricks: [...state.descentTricks],
    trickCounts: state.climbTricks.map((c, s) => c + state.descentTricks[s]),
    kept: state.kept.map((k) => [...k]),
    keptValues: rk.breakdown.map((b) => b.keptValue),
    costs: rk.breakdown.map((b) => b.cost),
    scores: rk.scores,
    breakdown: rk.breakdown,
    row: [...state.rowDealt],
    rowValues: values,
    rowValue: values.reduce((a, b) => a + b, 0),
    colt: coltTrick >= 0,
    coltTrick: coltTrick >= 0 ? coltTrick + 1 : null,
    coltWinner: coltRec ? coltRec.winner : null,
    coltKept: coltRec ? coltRec.prizeTo === 'kept' : false,
    topHomeSeat: state.topHomeSeat,
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

  // 2. every Brumby card of the hand goes to the discard (R8.3); the row is already empty (R6.6)
  for (let s = 0; s < n; s++) { state.brumbyDiscard.push(...state.kept[s]); state.kept[s] = []; }
  for (const id of state.row) if (id !== null) state.brumbyDiscard.push(id);
  state.row = [];
  state.tricks = [];

  // 3. next hand, or the end of the game
  state.handNo++;
  if (state.handNo >= P.handsPerGame) {
    state.phase = 'over';
    state.toAct = null;
    state.result = gameResult(state);
    if (events) events.push({ type: 'game-over', ...JSON.parse(JSON.stringify(state.result)) });
    return;
  }
  if (state.brumbyDeck.length < P.reshuffleBelow) reshuffleBrumbies(state, events); // R8.4, only if another hand follows
  dealHand(state, events); // R2.5 everything gathered and reshuffled
}
