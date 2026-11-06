// cards.js - card ids, the deck, sorting and display names.
//
// R1.1 / R1.3: 48 horse cards, a card id is a string `<suit>-<rank>`: 'escape-1' ... 'home-12'.
// Every card is unique; there are no specials (the Colt, Brumby and Chase / Watch cards are not in
// the deck and are never in a hand, R13.2).
// Face assets: assets/cards/card-<id>.webp (cardFace()); missing art falls back to a text chip.

import { SUITS, SUIT_ORDER, SUIT_NAMES, CONSTANTS } from './rules.js';

export function cardSuit(card) {
  return card.slice(0, card.indexOf('-'));
}

/** The card's number (its rank). */
export function cardValue(card) {
  return Number(card.slice(card.indexOf('-') + 1));
}

export function makeCard(suit, number) {
  return `${suit}-${number}`;
}

/** True if `card` is a well-formed id of the deck. */
export function isCard(card) {
  if (typeof card !== 'string' || !/^[a-z]+-\d{1,2}$/.test(card)) return false;
  const s = cardSuit(card);
  const k = cardValue(card);
  return SUITS.includes(s) && k >= CONSTANTS.RANK_MIN && k <= CONSTANTS.RANK_MAX;
}

/** The whole deck in suit order then number. */
export function fullDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = CONSTANTS.RANK_MIN; r <= CONSTANTS.RANK_MAX; r++) deck.push(makeCard(s, r));
  return deck;
}

/** Sort key: suit order, then ascending number. */
export function compareCards(a, b) {
  const ds = SUIT_ORDER.indexOf(cardSuit(a)) - SUIT_ORDER.indexOf(cardSuit(b));
  if (ds !== 0) return ds;
  return cardValue(a) - cardValue(b);
}

export function sortCards(cards) {
  return [...cards].sort(compareCards);
}

/** 'escape-7' -> 'Escape 7'. */
export function cardName(card) {
  return `${SUIT_NAMES[cardSuit(card)]} ${cardValue(card)}`;
}

/** ['home-3', 'home-7'] -> 'Home 3 and Home 7'; three or more use commas. */
export function listCardNames(cards) {
  const names = cards.map(cardName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The face asset id of a card: 'card-escape-7'. */
export function cardFace(card) {
  return `card-${card}`;
}
