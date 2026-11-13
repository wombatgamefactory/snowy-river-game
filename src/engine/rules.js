// rules.js - constants and the (empty) VARIANTS table. Data only, plus resolveVariants(), rulesCode(),
// deriveParams(), trumpFor() and directionFor().
//
// Snowy River, v6 rules (the numbers R1.1 ... R12.4 in the comments are the numbered rules of the game):
// a trick-taker for 2 to 5 players. SINGLE-NUMBER cards 1-12 in four suits (Escape, Climb, Descent, Home),
// plus a fifth suit, the Muster, at 5 players only (never trumps). Every hand is 6 CLIMB tricks (highest
// wins, Escape trumps; climb trick i takes the Climb card at position i of a face-up row of 6: 5 x +1 and
// 1 x -1, shuffled every hand), the SUMMIT (6 Brumby cards laid face up from a 12-card deck that runs two
// hands), then 6 DESCENT tricks (LOWEST wins, Home trumps; descent trick i takes Brumby card i). Score = the
// values of the Climb and Brumby cards you took. Tricks themselves score nothing. No choices but the card.
//
// There are NO Playtest switches: VARIANTS is empty, rules_code is always 'std' (which means v6 rules since
// 13/11/2026). resolveVariants() is kept so every caller (UI, stats, simulator) works unchanged and an
// unknown rule name still throws.
//
// CONSTANTS is an exported OBJECT (not bare numbers) so a simulator probe can change a value at
// runtime (`--const.X=Y`) and every NEW game picks it up (deriveParams copies them into
// state.params). Logic reads state.params, never CONSTANTS directly. The UI never exposes them.

/**
 * The suits in CODE order: index = the Python suit id (R1.3: Escape 0, Climb 1, Descent 2, Home 3, Muster 4).
 * fullDeck() index = suit id x 12 + n - 1 (the conformance fixture alphabet uses it).
 */
export const SUITS = ['escape', 'climb', 'descent', 'home', 'muster'];

/** DISPLAY / sort order of the suits (R1.3: the print sheet's order; the Muster only at 5 players). */
export const SUIT_ORDER = ['escape', 'climb', 'descent', 'muster', 'home'];

export const SUIT_NAMES = { escape: 'Escape', climb: 'Climb', descent: 'Descent', muster: 'Muster', home: 'Home' };

/** R1.3: the suit icons of the printed cards (colour-blind cue and the text-chip faces). */
export const SUIT_ICONS = { escape: 'trophy', climb: 'stockwhip', descent: 'hat', muster: 'saddle', home: 'horseshoe' };

/** R1.3 / decision 8: the suit colours of the printed cards. */
export const SUIT_COLOURS = { escape: '#F07F1E', climb: '#6F9070', descent: '#6FA8D6', muster: '#944DDB', home: '#3C5677' };

/** The phases in which a card is played (R4, R6). */
export const CARD_PHASES = ['climb', 'descent'];

/**
 * R1.6: the Climb row, 6 cards, the same six every hand, shuffled every hand. `kind` is the id stem
 * (ids `climb-plus1-1` ... `-5`, `climb-minus1`), `value` the points, `count` how many.
 */
export const CLIMB_KINDS = [
  { kind: 'climb-plus1', name: 'Climb card', value: 1, count: 5 },
  { kind: 'climb-minus1', name: 'Climb card', value: -1, count: 1 },
];

/**
 * R1.7: the Brumby deck, 12 cards. `kind` is the id stem (ids `brumby-plus2-1` ... , `brumby-flint`,
 * `brumby-wombat-1`, `-2`, `colt`), `value` the points, `count` how many.
 */
export const BRUMBY_KINDS = [
  { kind: 'brumby-plus2', name: 'Brumby', value: 2, count: 5 },
  { kind: 'brumby-plus1', name: 'Brumby', value: 1, count: 3 },
  { kind: 'brumby-flint', name: 'Flint stones', value: -1, count: 1 },
  { kind: 'brumby-wombat', name: 'Wombat hole', value: -2, count: 2 },
  { kind: 'colt', name: 'The Colt from old Regret', value: 4, count: 1 },
];

/** Tunable numbers (spec section 16). Mutable on purpose: see header. */
export const CONSTANTS = {
  VALUE_MIN: 1,
  VALUE_MAX: 12,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 5,
  /** R3.1 every player is dealt 12 (6 climb + 6 descent tricks). */
  HAND_SIZE: 12,
  /** R2.1 hands per game by player count. */
  HANDS_PER_GAME: { 2: 3, 3: 3, 4: 4, 5: 5 },
  /** R1.1 / R1.2 suits in the game by player count (the Muster is the fifth, at 5 players only). */
  SUITS_BY_COUNT: { 2: 4, 3: 4, 4: 4, 5: 5 },
  /** R4.1 / R6 tricks in each half. */
  CLIMB_TRICKS: 6,
  DESCENT_TRICKS: 6,
  /** R4.4 / R6.3 trumps by half (never the Muster). */
  TRUMP_CLIMB: 'escape',
  TRUMP_DESCENT: 'home',
  /** R5.3 Brumby cards laid out at the summit (one per descent trick). */
  ROW_SIZE: 6,
  /** R8.4 shuffle all 12 together when fewer than this are left in the deck. */
  RESHUFFLE_BELOW: 6,
};

/**
 * @typedef {object} VariantDef
 * @property {string} id  @property {string} name  @property {string} code  @property {string[]} values
 * @property {string[]} implemented  @property {string} default  @property {string} rule  @property {string} label
 * @property {object} valueLabels  @property {string} description  @property {number[]} [onlyFor]
 */

/**
 * The Playtest rules. EMPTY (R1.13, spec section 15): the standard rules are the only rules.
 * @type {VariantDef[]}
 */
export const VARIANTS = [];

/** Standard-rules values by name (empty: there are no switches). */
export const DEFAULT_RULES = Object.fromEntries(VARIANTS.map((v) => [v.name, v.default]));

/**
 * Merges overrides onto DEFAULT_RULES and validates the result.
 * Throws on an unknown name (with no switches, ANY name is unknown), a value that is not allowed, or a
 * value that is not implemented.
 * @param {object} [overrides]
 * @param {VariantDef[]} [table] for tests only
 * @returns {object} plain JSON rules object, every name present ({} for the standard rules)
 */
export function resolveVariants(overrides = {}, table = VARIANTS) {
  const byName = new Map(table.map((v) => [v.name, v]));
  for (const key of Object.keys(overrides || {})) {
    if (!byName.has(key)) {
      throw new Error(`Unknown rule "${key}". ${table.length ? `Known rules: ${table.map((v) => v.name).join(', ')}` : 'This game has no rule switches.'}`);
    }
  }
  const defaults = table === VARIANTS ? DEFAULT_RULES : Object.fromEntries(table.map((v) => [v.name, v.default]));
  const rules = {};
  for (const def of table) {
    let value = overrides && Object.prototype.hasOwnProperty.call(overrides, def.name) ? overrides[def.name] : defaults[def.name];
    if (typeof value === 'number') value = String(value);
    if (!def.values.includes(value)) {
      throw new Error(`${def.name} must be one of ${def.values.join(', ')}, got ${JSON.stringify(value)}`);
    }
    if (!def.implemented.includes(value)) {
      throw new Error(`${def.name} = ${JSON.stringify(value)} is not implemented in the web engine`);
    }
    rules[def.name] = value;
  }
  return rules;
}

/**
 * The short rules code for stats and analytics. With no switches this is always 'std' (v6 rules since
 * 13/11/2026); the general code is kept so the shape matches the other games.
 * @param {object} rules  a resolved rules object
 * @param {number} [n]    player count
 */
export function rulesCode(rules, n) {
  const parts = [];
  for (const def of VARIANTS) {
    if (n !== undefined && def.onlyFor && !def.onlyFor.includes(n)) continue;
    if (rules[def.name] !== def.default) parts.push(`${def.code}-${rules[def.name]}`);
  }
  return parts.length ? parts.join('+') : 'std';
}

/**
 * The numbers a game at player count n uses, read from CONSTANTS now (stored at state.params by
 * startGame, so a probe changes only the games created while it is set).
 * Throws for a player count outside MIN_PLAYERS..MAX_PLAYERS (R1.10: 2 to 5).
 * @returns {{ n:number, handSize:number, handsPerGame:number, climbTricks:number, descentTricks:number,
 *   trumpClimb:string, trumpDescent:string, rowSize:number, reshuffleBelow:number, suits:string[],
 *   deckSize:number, dealt:number, out:number, brumbyCount:number, climbCardCount:number }}
 */
export function deriveParams(rules, n) {
  const C = CONSTANTS;
  if (!Number.isInteger(n) || n < C.MIN_PLAYERS || n > C.MAX_PLAYERS) {
    throw new Error(`This game needs ${C.MIN_PLAYERS} to ${C.MAX_PLAYERS} players, got ${n}`);
  }
  const handSize = C.HAND_SIZE;
  const nSuits = C.SUITS_BY_COUNT[n];
  if (!Number.isInteger(nSuits) || nSuits < 1 || nSuits > SUITS.length) throw new Error(`No suit count for ${n} players`);
  const suits = SUITS.slice(0, nSuits); // code order; the Muster (id 4) only at 5 players
  const deckSize = nSuits * (C.VALUE_MAX - C.VALUE_MIN + 1);
  const dealt = n * handSize;
  if (!Number.isInteger(handSize) || dealt > deckSize) throw new Error(`Hand size ${handSize} x ${n} players does not fit the deck`);
  if (C.CLIMB_TRICKS + C.DESCENT_TRICKS !== handSize) throw new Error(`CLIMB_TRICKS + DESCENT_TRICKS must equal HAND_SIZE (${handSize})`);
  if (C.ROW_SIZE !== C.DESCENT_TRICKS) throw new Error('ROW_SIZE must equal DESCENT_TRICKS (one Brumby card per descent trick)');
  const climbCardCount = CLIMB_KINDS.reduce((a, k) => a + k.count, 0);
  if (climbCardCount !== C.CLIMB_TRICKS) throw new Error('The Climb row must hold one card per climb trick');
  const handsPerGame = C.HANDS_PER_GAME[n];
  if (!Number.isInteger(handsPerGame) || handsPerGame < 1) throw new Error(`Hands per game must be a positive integer, got ${handsPerGame}`);
  const brumbyCount = BRUMBY_KINDS.reduce((a, k) => a + k.count, 0);
  if (C.RESHUFFLE_BELOW > brumbyCount || C.ROW_SIZE > brumbyCount) throw new Error('The Brumby deck is too small for the row');
  if (C.TRUMP_CLIMB === 'muster' || C.TRUMP_DESCENT === 'muster') throw new Error('The Muster is never trumps (R1.2)');
  return {
    n,
    handSize,
    handsPerGame,
    climbTricks: C.CLIMB_TRICKS,
    descentTricks: C.DESCENT_TRICKS,
    trumpClimb: C.TRUMP_CLIMB,
    trumpDescent: C.TRUMP_DESCENT,
    rowSize: C.ROW_SIZE,
    reshuffleBelow: C.RESHUFFLE_BELOW,
    suits,
    deckSize,
    dealt,
    out: deckSize - dealt,
    brumbyCount,
    climbCardCount,
  };
}

/** The trump suit of a half: 'climb' -> Escape, 'descent' -> Home (R4.4, R6.3). */
export function trumpFor(params, half) {
  return half === 'descent' ? params.trumpDescent : params.trumpClimb;
}

/** The direction of a half (R4.1, R6.1): 'highest' wins on the climb, 'lowest' on the descent. */
export function directionFor(half) {
  return half === 'descent' ? 'lowest' : 'highest';
}
