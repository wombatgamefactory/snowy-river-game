// preview.js - "what would this do?", by clone-and-apply.
//
// The UI never re-derives a rule. To hint at a card it copies the state, applies the action with
// the engine, and reads what happened: if the trick completed (the engine plays forced moves on
// its own) the trick-won event says who won; if the trick is still open, the engine's
// trickWinner() names who leads it right now (highest in the climb, lowest in the descent).
// The real state is never touched.
// There is no summit preview: the stakes are in view.stakes (shown on the summit step), and a preview of
// the descent is not possible without hidden information, so it is not offered.

import { applyAction, getActionBlockReason, trickWinner, cloneState, isCardPhase } from '../engine/index.js';

/**
 * @param {object} state  the live state; the seat to act is state.toAct (phase 'climb' or 'descent')
 * @param {string} card
 * @returns {null | object}  null if the card may not be played now. Otherwise
 *   { kind: 'lead'|'follow', seat, card, offSuit,
 *     wins, final (the trick is decided), remaining (plays still to come when not final),
 *     winnerSeat, winnerCard, markerSteps (climb, final only: steps the marker would move), summit }
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
  const moved = events.find((e) => e.type === 'marker-moved' && e.handNo === state.handNo && e.trickNo === trickN);
  const base = { seat, card, offSuit: !!played.offSuit, wins: false, final: !!won, remaining: 0, winnerSeat: null, winnerCard: null, markerSteps: moved ? moved.steps : null, summit: moved ? moved.summit : false };
  if (won) {
    Object.assign(base, { wins: won.winner === seat, winnerSeat: won.winner, winnerCard: won.card });
  } else {
    const win = trickWinner(sim.trick.plays, sim.trick.ledSuit, sim.trick.phase === 'descent');
    base.remaining = sim.trick.seats.length - sim.trick.plays.length;
    if (win) Object.assign(base, { wins: win.seat === seat, winnerSeat: win.seat, winnerCard: win.card });
  }
  return { ...base, kind: !won && played.setsSuit ? 'lead' : 'follow' };
}
