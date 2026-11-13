// legality.js - legal actions, block reasons and the trick-winner rule.
//
// ONE implementation of "which cards may this seat play": playableCards(). It reads only the
// actor's own hand and the current trick's led suit, so getValidActions (full state) and
// legalActionsFromView (a bot's view, view.js) both call it and cannot disagree.
// applyAction refuses through getActionBlockReason, which asks the same function.
//
// The only action (R12.1; the acting seat is always state.toAct; actions carry no seat):
//   { type: 'play', card }      phase 'climb' or 'descent': a card to the trick

import { SUIT_NAMES, CARD_PHASES } from './rules.js';
import { cardSuit, strength, cardName, listCardNames } from './cards.js';

/** True for the phases in which a card is played. */
export const isCardPhase = (phase) => CARD_PHASES.includes(phase);

/**
 * Every card of `hand` that may be played now (R4.2, R4.3, R6.2): any card to lead; otherwise a card
 * of the led suit if you hold one, else any card.
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
 * The strength of a played card in a trick (R4.4, R6.3): a trump scores 100 + its strength in the half, a
 * card of the led suit its strength, anything else -1 (it can never win). Strength is the number on the
 * climb and 13 - number on the descent (lowest wins), so this is the Python's key() exactly (D12).
 */
export function trickKey(card, ledSuit, trump, half) {
  const s = cardSuit(card);
  const v = strength(card, half);
  if (s === trump) return 100 + v;
  if (s === ledSuit) return v;
  return -1;
}

/**
 * The winner of a (possibly partial) trick (R4.4 to R4.6, R6.3 to R6.5): if any trump was played, the
 * highest trump on the climb / the lowest trump on the descent; otherwise the highest (climb) / lowest
 * (descent) card of the led suit. A card replaces the best only when STRICTLY stronger, so a tie goes to the
 * first card played (unreachable with unique cards). The Muster is never trumps (it is never `trump`).
 * Null when no plays yet.
 * @param {{seat:number, card:string}[]} plays in play order
 * @param {string|null} ledSuit   (the first play's suit)
 * @param {'climb'|'descent'} half
 * @param {string} trump          the trump suit of this half (trumpFor(params, half))
 * @returns {{ index:number, seat:number, card:string, byTrump:boolean } | null}
 *   byTrump: a trump won a trick that was led in another suit
 */
export function trickWinner(plays, ledSuit, half, trump) {
  let best = -1;
  let bestKey = -Infinity;
  plays.forEach((p, i) => {
    const key = trickKey(p.card, ledSuit, trump, half);
    if (key > bestKey) { bestKey = key; best = i; }
  });
  if (best < 0) return null;
  const card = plays[best].card;
  return { index: best, seat: plays[best].seat, card, byTrump: cardSuit(card) === trump && ledSuit !== trump };
}

/**
 * The legal actions of the seat to act in a state-like object (state or view).
 * @param {string} phase
 * @param {string[]} hand  the actor's hand
 * @param {object|null} trick
 */
function actionsFor(phase, hand, trick) {
  if (isCardPhase(phase)) return legalCards(hand, trick ? trick.ledSuit : null).map((card) => ({ type: 'play', card }));
  return [];
}

/** Every legal action for state.toAct; empty when nobody may act (R12.1). */
export function getValidActions(state) {
  if (state.toAct === null || !isCardPhase(state.phase)) return [];
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
  if (!isCardPhase(state.phase)) return 'The hand is being scored.';
  if (seat !== state.toAct) return 'It is not your turn.';
  const hand = state.hands[seat];
  if (!hand.includes(card)) return `You do not hold ${typeof card === 'string' && /^[a-z]+-\d{1,2}$/.test(card) ? cardName(card) : JSON.stringify(card)}.`;
  const led = state.trick ? state.trick.ledSuit : null;
  const ok = playableCards(hand, led);
  if (ok.includes(card)) return null;
  const follow = hand.filter((c) => cardSuit(c) === led);
  return `You must follow suit: ${SUIT_NAMES[led]} was led, and you hold ${listCardNames(follow)}.`;
}

/** Why an action object is refused, or null. */
export function getActionBlockReason(state, action) {
  const okShape = action && action.type === 'play' && typeof action.card === 'string';
  if (!okShape) return `Unknown action ${JSON.stringify(action)}; the only action is { type: 'play', card }.`;
  if (state.phase === 'over' || state.toAct === null) return 'The game is over.';
  if (isCardPhase(state.phase)) return getPlayBlockReason(state, state.toAct, action.card);
  return 'The hand is being scored.';
}
