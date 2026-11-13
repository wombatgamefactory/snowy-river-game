// cards.js - card ids, the deck, numbers, strength, sorting and display names; the Climb cards and the
// Brumby cards.
//
// R1.1 / R1.4: single-number playing cards. A card id is `<suit>-<n>` with n the one printed number 1..12
// ('escape-1' ... 'home-12', 'muster-7' at 5 players only). Every card is unique.
// R1.5: in the climb a higher n is stronger; in the descent a LOWER n is stronger. strength() turns that into
// one "higher is stronger" scale (n on the climb, 13 - n on the descent), exactly the Python's key (D12).
// R1.6: 6 Climb cards, ids 'climb-plus1-1'..'-5' (+1) and 'climb-minus1' (-1). Never in a hand.
// R1.7: 12 Brumby cards, ids 'brumby-plus2-1'..'-5', 'brumby-plus1-1'..'-3', 'brumby-flint',
// 'brumby-wombat-1', '-2', 'colt'. Never in a hand.
// Face assets (assets/manifest.json ids): cardFace() 'card-escape-7'; climbCardFace() 'climb-plus1' /
// 'climb-minus1'; brumbyFace() 'brumby-plus2' ... 'colt'.

import { SUITS, SUIT_ORDER, SUIT_NAMES, CONSTANTS, BRUMBY_KINDS, CLIMB_KINDS } from './rules.js';

export function cardSuit(card) {
  return card.slice(0, card.indexOf('-'));
}

/** The card's one printed number n (1..12). */
export function cardNumber(card) {
  return Number(card.slice(card.indexOf('-') + 1));
}

/** The printed number (v6 cards have one number; kept under the v5 names for older callers). */
export const cardValue = cardNumber;
export const climbValue = cardNumber;

/**
 * The card's STRENGTH on the descent on a higher-is-stronger scale: 13 - n (the Python's descent value,
 * D12). Not printed anywhere; the number on the card is cardNumber().
 */
export function descentValue(card) {
  return CONSTANTS.VALUE_MAX + CONSTANTS.VALUE_MIN - cardNumber(card);
}

/**
 * Strength in a half, higher = stronger (R1.5): n on the climb, 13 - n on the descent. Use this for every
 * comparison; never show it to players (show cardNumber).
 */
export function strength(card, half) {
  return half === 'descent' ? descentValue(card) : cardNumber(card);
}

/** The value printed on the card (half is ignored: single-number cards; kept for older callers). */
export function valueIn(card, _half) {
  return cardNumber(card);
}

export function makeCard(suit, number) {
  return `${suit}-${number}`;
}

/** True if `card` is a well-formed id of a playing card of any of the five suits (see fullDeck(n) for a game's deck). */
export function isCard(card) {
  if (typeof card !== 'string' || !/^[a-z]+-\d{1,2}$/.test(card)) return false;
  const s = cardSuit(card);
  const k = cardNumber(card);
  return SUITS.includes(s) && k >= CONSTANTS.VALUE_MIN && k <= CONSTANTS.VALUE_MAX;
}

/** The suits in a game of n players (code order): four, or five with the Muster at 5 players (R1.2). */
export function suitsFor(n = 4) {
  const k = CONSTANTS.SUITS_BY_COUNT[n] || 4;
  return SUITS.slice(0, k);
}

/**
 * The deck of a game of `n` players in CODE order: suit id, then number (index = suit id x 12 + n - 1).
 * 48 cards at 2-4 players, 60 at 5 (R1.1, R1.2). Default 4 players (48).
 */
export function fullDeck(n = 4) {
  const deck = [];
  for (const s of suitsFor(n)) for (let r = CONSTANTS.VALUE_MIN; r <= CONSTANTS.VALUE_MAX; r++) deck.push(makeCard(s, r));
  return deck;
}

/**
 * Sort key (R1.4): display suit order (Escape, Climb, Descent, Muster, Home), then the number ascending on
 * the climb and DESCENDING on the descent.
 */
export function compareCards(a, b, half = 'climb') {
  const ds = SUIT_ORDER.indexOf(cardSuit(a)) - SUIT_ORDER.indexOf(cardSuit(b));
  if (ds !== 0) return ds;
  return half === 'descent' ? cardNumber(b) - cardNumber(a) : cardNumber(a) - cardNumber(b);
}

/** A sorted copy (R1.4). */
export function sortCards(cards, half = 'climb') {
  return [...cards].sort((a, b) => compareCards(a, b, half));
}

/** 'escape-7' -> 'Escape 7' (the half is ignored: one number per card). */
export function cardName(card, _half) {
  return `${SUIT_NAMES[cardSuit(card)]} ${cardNumber(card)}`;
}

/** ['home-3', 'home-7'] -> 'Home 3 and Home 7'; three or more use commas. */
export function listCardNames(cards) {
  const names = cards.map((c) => cardName(c));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The face asset id of a card: 'card-escape-7'. */
export function cardFace(card) {
  return `card-${card}`;
}

// ---------- kinds with ids (shared by the Climb cards and the Brumby cards) ----------

function idsOf(kinds) {
  const out = [];
  for (const k of kinds) {
    if (k.count === 1) out.push(k.kind);
    else for (let i = 1; i <= k.count; i++) out.push(`${k.kind}-${i}`);
  }
  return out;
}

function kindOf(kinds, id, what) {
  const k = typeof id === 'string' ? kinds.find((x) => id === x.kind || id.startsWith(`${x.kind}-`)) : null;
  if (!k) throw new Error(`Not a ${what} card: ${JSON.stringify(id)}`);
  return k;
}

const signed = (v) => `${v > 0 ? '+' : ''}${v}`;

// ---------- the Climb cards (R1.6) ----------

/** Every Climb card id in kind order: climb-plus1-1 ... -5, climb-minus1. */
export function climbCardDeck() {
  return idsOf(CLIMB_KINDS);
}

const CLIMB_IDS = new Set(climbCardDeck());

/** True if `id` is one of the 6 Climb card ids. */
export function isClimbCard(id) {
  return typeof id === 'string' && CLIMB_IDS.has(id);
}

/** 'climb-plus1-3' -> 'climb-plus1'; 'climb-minus1' -> 'climb-minus1'. */
export function climbCardKind(id) {
  return kindOf(CLIMB_KINDS, id, 'Climb').kind;
}

/** +1 or -1. */
export function climbCardValue(id) {
  return kindOf(CLIMB_KINDS, id, 'Climb').value;
}

/** 'Climb card +1' / 'Climb card -1'. */
export function climbCardName(id) {
  const k = kindOf(CLIMB_KINDS, id, 'Climb');
  return `${k.name} ${signed(k.value)}`;
}

/** The face asset id: 'climb-plus1' or 'climb-minus1'. */
export function climbCardFace(id) {
  return climbCardKind(id);
}

// ---------- the Brumby cards (R1.7) ----------

/** Every Brumby id in deck-building order (kinds in BRUMBY_KINDS order). */
export function brumbyDeck() {
  return idsOf(BRUMBY_KINDS);
}

const BRUMBY_IDS = new Set(brumbyDeck());

/** True if `id` is one of the 12 Brumby card ids. */
export function isBrumby(id) {
  return typeof id === 'string' && BRUMBY_IDS.has(id);
}

/** 'brumby-plus2-3' -> 'brumby-plus2'; 'colt' -> 'colt'. */
export function brumbyKind(id) {
  return kindOf(BRUMBY_KINDS, id, 'Brumby').kind;
}

/** The points of a Brumby card: +2, +1, -1, -2 or +4. */
export function brumbyValue(id) {
  return kindOf(BRUMBY_KINDS, id, 'Brumby').value;
}

/** 'Brumby +2', 'Flint stones -1', 'The Colt from old Regret +4'. */
export function brumbyName(id) {
  const k = kindOf(BRUMBY_KINDS, id, 'Brumby');
  return `${k.name} ${signed(k.value)}`;
}

/** The face asset id: 'brumby-plus2', 'brumby-plus1', 'brumby-flint', 'brumby-wombat', 'colt'. */
export function brumbyFace(id) {
  return brumbyKind(id);
}

/** The value of any row card: a Climb card or a Brumby card. */
export function rowCardValue(id) {
  return isClimbCard(id) ? climbCardValue(id) : brumbyValue(id);
}

/** The name of any row card. */
export function rowCardName(id) {
  return isClimbCard(id) ? climbCardName(id) : brumbyName(id);
}
