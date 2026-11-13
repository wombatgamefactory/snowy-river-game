// preview.js - "what would this do?", by clone-and-apply.
//
// The UI never re-derives a rule. To hint at a card it copies the state, applies the action with
// the engine, and reads what happened: if the trick completed (the engine plays forced moves on
// its own) the trick-won event says who won; if the trick is still open, the engine's
// trickWinner() names who leads it right now (any trump, else the highest of the suit led on the
// climb, the lowest on the descent). The real state is never touched.

import { applyAction, getActionBlockReason, trickWinner, cloneState, isCardPhase, cardSuit } from '../engine/index.js';

/**
 * @param {object} state  the live state; the seat to act is state.toAct (phase 'climb' or 'descent')
 * @param {string} card
 * @returns {null | object}  null if the card may not be played now. Otherwise
 *   { kind: 'lead'|'follow', seat, card, half, offSuit, trumps (the card is a trump played off-suit),
 *     isTrumpSuit (the card is of the trump suit),
 *     wins, final (the trick is decided), remaining (plays still to come when not final),
 *     winnerSeat, winnerCard,
 *     prize (the id of the row card this trick takes: a Climb card on the climb, a Brumby card on the descent) }
 */
export function previewCard(state, card) {
  const seat = state.toAct;
  if (seat === null || !isCardPhase(state.phase)) return null;
  const action = { type: 'play', card };
  if (getActionBlockReason(state, action) !== null) return null;
  const sim = cloneState(state);
  const events = applyAction(sim, action);
  const played = events.find((e) => e.type === 'card-played');
  const trickN = state.trick ? state.trick.n : state.trickNo + 1;
  const won = events.find((e) => e.type === 'trick-won' && e.handNo === state.handNo && e.trickNo === trickN);
  const descent = state.phase === 'descent';
  const prize = descent ? (state.row[state.descentTrickNo] || null) : (state.climbRow[state.climbTrickNo] || null);
  const base = {
    seat, card, half: state.phase, offSuit: !!played.offSuit, trumps: !!(played.offSuit && played.trump), isTrumpSuit: !!played.trump,
    wins: false, final: !!won, remaining: 0, winnerSeat: null, winnerCard: null, prize,
  };
  if (won) {
    Object.assign(base, { wins: won.winner === seat, winnerSeat: won.winner, winnerCard: won.card });
  } else {
    const t = sim.trick;
    const win = trickWinner(t.plays, t.ledSuit, t.half, t.trump);
    base.remaining = t.seats.length - t.plays.length;
    if (win) Object.assign(base, { wins: win.seat === seat, winnerSeat: win.seat, winnerCard: win.card });
  }
  if (base.isTrumpSuit && !base.offSuit) base.trumps = false; // a trump that follows its own suit is just the led suit
  return { ...base, kind: !won && played.setsSuit ? 'lead' : 'follow', suit: cardSuit(card) };
}
