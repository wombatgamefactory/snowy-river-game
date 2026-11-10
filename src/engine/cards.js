// cards.js - card ids, the deck, values, sorting and display names; the Brumby cards.
//
// R1.1 / R1.3: 48 split playing cards. A card id is `<suit>-<v>` where v is the CLIMB value 1..12
// ('escape-1' ... 'home-12'); its DESCENT value is 13 - v (R1.1). Every card is unique.
// R1.7: 12 Brumby cards, ids 'brumby-plus2-1'..'-5', 'brumby-plus1-1'..'-3', 'brumby-flint',
// 'brumby-wombat-1', '-2', 'colt'. They are never in a hand.
// Face assets: assets/cards/card-<id>.webp (cardFace()); Brumby faces: brumbyFace().

import { SUITS, SUIT_ORDER, SUIT_NAMES, CONSTANTS, BRUMBY_KINDS } from './rules.js';

export function cardSuit(card) {
  return card.slice(0, card.indexOf('-'));
}

/** The card's printed CLIMB value v (the number in its id). */
export function cardValue(card) {
  return Number(card.slice(card.indexOf('-') + 1));
}

/** The climb value v (R1.1). */
export const climbValue = cardValue;

/** The descent value 13 - v (R1.1), printed upside down. */
export function descentValue(card) {
  return CONSTANTS.VALUE_MAX + CONSTANTS.VALUE_MIN - cardValue(card);
}

/** The value in play in a half (R1.4): climb value on the climb, descent value on the descent. */
export function valueIn(card, half) {
  return half === 'descent' ? descentValue(card) : cardValue(card);
}

export function makeCard(suit, number) {
  return `${suit}-${number}`;
}

/** True if `card` is a well-formed id of the deck. */
export function isCard(card) {
  if (typeof card !== 'string' || !/^[a-z]+-\d{1,2}$/.test(card)) return false;
  const s = cardSuit(card);
  const k = cardValue(card);
  return SUITS.includes(s) && k >= CONSTANTS.VALUE_MIN && k <= CONSTANTS.VALUE_MAX;
}

/** The whole deck in suit order then climb value (index = suit id x 12 + v - 1). */
export function fullDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = CONSTANTS.VALUE_MIN; r <= CONSTANTS.VALUE_MAX; r++) deck.push(makeCard(s, r));
  return deck;
}

/** Sort key (R1.3): suit order, then ascending value in the given half ('climb' default). */
export function compareCards(a, b, half = 'climb') {
  const ds = SUIT_ORDER.indexOf(cardSuit(a)) - SUIT_ORDER.indexOf(cardSuit(b));
  if (ds !== 0) return ds;
  return valueIn(a, half) - valueIn(b, half);
}

/** A sorted copy (R1.3); `half` 'descent' sorts a turned hand by descent value. */
export function sortCards(cards, half = 'climb') {
  return [...cards].sort((a, b) => compareCards(a, b, half));
}

/**
 * 'escape-7' -> 'Escape 7' (climb half) or 'Escape 6' (descent half). With no half given the card
 * is named by its climb value.
 */
export function cardName(card, half = 'climb') {
  return `${SUIT_NAMES[cardSuit(card)]} ${valueIn(card, half)}`;
}

/** ['home-3', 'home-7'] -> 'Home 3 and Home 7'; three or more use commas. */
export function listCardNames(cards, half = 'climb') {
  const names = cards.map((c) => cardName(c, half));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The face asset id of a card: 'card-escape-7' (the split face, climb number at the top). */
export function cardFace(card) {
  return `card-${card}`;
}

// ---------- the Brumby cards (R1.7) ----------

/** Every Brumby id in deck-building order (kinds in BRUMBY_KINDS order). */
export function brumbyDeck() {
  const out = [];
  for (const k of BRUMBY_KINDS) {
    if (k.count === 1) out.push(k.kind);
    else for (let i = 1; i <= k.count; i++) out.push(`${k.kind}-${i}`);
  }
  return out;
}

const BRUMBY_IDS = new Set(brumbyDeck());

/** True if `id` is one of the 12 Brumby card ids. */
export function isBrumby(id) {
  return typeof id === 'string' && BRUMBY_IDS.has(id);
}

/** 'brumby-plus2-3' -> 'brumby-plus2'; 'colt' -> 'colt'. */
export function brumbyKind(id) {
  const k = BRUMBY_KINDS.find((x) => id === x.kind || id.startsWith(`${x.kind}-`));
  if (!k) throw new Error(`Not a Brumby card: ${JSON.stringify(id)}`);
  return k.kind;
}

/** The points of a Brumby card: +2, +1, -1, -2 or +4. */
export function brumbyValue(id) {
  const kind = brumbyKind(id);
  return BRUMBY_KINDS.find((x) => x.kind === kind).value;
}

/** 'Brumby +2', 'Flint stones -1', 'The Colt from old Regret +4'. */
export function brumbyName(id) {
  const k = BRUMBY_KINDS.find((x) => x.kind === brumbyKind(id));
  return `${k.name} ${k.value > 0 ? '+' : ''}${k.value}`;
}

/** The face asset id: 'brumby-plus2', 'brumby-plus1', 'brumby-flint', 'brumby-wombat', 'colt'. */
export function brumbyFace(id) {
  return brumbyKind(id);
}
