// legality.js - legal actions, block reasons and the trick-winner rule.
//
// ONE implementation of "which cards may this seat play": playableCards(). It reads only the
// actor's own hand and the current trick's led suit, so getValidActions (full state) and
// legalActionsFromView (a bot's view, view.js) both call it and cannot disagree.
// applyAction refuses through getActionBlockReason, which asks the same function.
//
// Actions (the acting seat is always state.toAct; actions carry no seat):
//   { type: 'play', card }                         phase 'climb' or 'descent': a card to the trick
//   { type: 'summit', choice: 'chase' | 'watch' }  phase 'summit': this seat's secret choice (R5)

import { SUIT_NAMES, CARD_PHASES } from './rules.js';
import { cardSuit, cardValue, cardName, listCardNames } from './cards.js';

export const SUMMIT_CHOICES = ['chase', 'watch'];

/** True for the phases in which a card is played. */
export const isCardPhase = (phase) => CARD_PHASES.includes(phase);

/**
 * Every card of `hand` that may be played now (R4.2, R4.3, R7.2).
 * @param {string[]} hand
 * @param {string|null} ledSuit   the led suit, or null in a lead position (anything may be led)
 */
export function playableCards(hand, ledSuit) {
  if (ledSuit === null) return [...hand];
  const follow = hand.filter((c) => cardSuit(c) === ledSuit);
  return follow.length ? follow : [...hand]; // must follow suit if able; otherwise anything
}

/** playableCards as the action list uses it (every card is unique, so nothing is merged). */
export function legalCards(hand, ledSuit) {
  return playableCards(hand, ledSuit);
}

/**
 * The winner of a (possibly partial) trick: the highest card of the led suit in the climb (R4.4),
 * the LOWEST card of the led suit in the descent (R7.3). Off-suit cards never win; no trumps.
 * Null when no plays yet. Ranks within a suit are unique, so there is never a tie (R4.5).
 * @param {{seat:number, card:string}[]} plays in play order
 * @param {string|null} ledSuit
 * @param {boolean} [low]  true in the descent
 * @returns {{ index:number, seat:number, card:string } | null}
 */
export function trickWinner(plays, ledSuit, low = false) {
  let best = -1;
  let bestKey = 0;
  plays.forEach((p, i) => {
    if (cardSuit(p.card) !== ledSuit) return;
    const key = cardValue(p.card);
    if (best < 0 || (low ? key < bestKey : key > bestKey)) { bestKey = key; best = i; }
  });
  if (best < 0) return null;
  return { index: best, seat: plays[best].seat, card: plays[best].card };
}

/**
 * The legal actions of the seat to act in a state-like object (state or view).
 * @param {string} phase
 * @param {string[]} hand  the actor's hand
 * @param {object|null} trick
 */
function actionsFor(phase, hand, trick) {
  if (isCardPhase(phase)) return legalCards(hand, trick ? trick.ledSuit : null).map((card) => ({ type: 'play', card }));
  if (phase === 'summit') return SUMMIT_CHOICES.map((choice) => ({ type: 'summit', choice })); // R5.1: never auto
  return [];
}

/** Every legal action for state.toAct; empty when nobody may act. Complete and sound (R18.1). */
export function getValidActions(state) {
  if (state.toAct === null || state.phase === 'over' || state.phase === 'handEnd') return [];
  if (state.phase === 'summit' && state.choices[state.toAct] !== null) return [];
  return actionsFor(state.phase, state.hands[state.toAct], state.trick);
}

/** Internal: shared with view.js. */
export { actionsFor as legalActionsFor };

/**
 * Why `seat` may not play `card` now, as a sentence addressed to that player, or null if it is
 * legal. For UI tooltips; checks in rule-book order.
 */
export function getPlayBlockReason(state, seat, card) {
  if (state.phase === 'over') return 'The game is over.';
  if (state.phase === 'summit') return 'The mob is at the summit: everyone chooses Chase or Watch before another card is played.';
  if (!isCardPhase(state.phase)) return 'The hand is being scored.';
  if (seat !== state.toAct) return 'It is not your turn.';
  const hand = state.hands[seat];
  if (!hand.includes(card)) return `You do not hold ${typeof card === 'string' && card.includes('-') ? cardName(card) : JSON.stringify(card)}.`;
  const led = state.trick ? state.trick.ledSuit : null;
  const ok = playableCards(hand, led);
  if (ok.includes(card)) return null;
  const follow = hand.filter((c) => cardSuit(c) === led);
  return `You must follow suit: ${SUIT_NAMES[led]} was led, and you hold ${listCardNames(follow)}.`;
}

/** Why an action object is refused, or null. */
export function getActionBlockReason(state, action) {
  const okShape = action && ((action.type === 'play' && typeof action.card === 'string') || (action.type === 'summit' && SUMMIT_CHOICES.includes(action.choice)));
  if (!okShape) {
    return `Unknown action ${JSON.stringify(action)}; actions are { type: 'play', card } and { type: 'summit', choice: 'chase' | 'watch' }.`;
  }
  if (state.phase === 'over' || state.toAct === null) return 'The game is over.';
  if (state.phase === 'summit') {
    if (action.type !== 'summit') return 'The mob is at the summit: choose Chase or Watch.';
    if (state.choices[state.toAct] !== null) return 'You have already chosen.';
    return null;
  }
  if (isCardPhase(state.phase)) {
    if (action.type !== 'play') return 'Play a card to the trick.';
    return getPlayBlockReason(state, state.toAct, action.card);
  }
  return 'The hand is being scored.';
}
