// rules.js - constants and the (empty) VARIANTS table. Data only, plus resolveVariants(), rulesCode()
// and deriveParams().
//
// Snowy River (rule numbers R1.1 ... R18.5 in the comments): a trick-taker for 2 to 5 players. 48 horse cards, four
// suits (Escape, Climb, Descent, Home) ranked 1 to 12, no trumps, must follow. Each hand has a CLIMB
// (highest card of the led suit wins; each climb trick is 1 point and moves the mob marker 1 step plus
// 1 per off-suit card), a SUMMIT (every player secretly chooses Chase or Watch) and, if anyone chased,
// a DESCENT (lowest card of the led suit wins; the most descent tricks puts you at the mob's heels).
//
// There are NO Playtest switches: VARIANTS is empty, rules_code is always 'std'.
// resolveVariants() is kept so every caller (UI, stats, simulator) works unchanged and an unknown rule
// name still throws.
//
// CONSTANTS is an exported OBJECT (not bare numbers) so a simulator probe can change a value at
// runtime (`--const.X=Y`) and every NEW game picks it up (deriveParams copies them into
// state.params). Logic reads state.params, never CONSTANTS directly. The UI never exposes them.

/** The suits in code order (also the sort order of a hand). R1.3: ids 0..3 = Escape, Climb, Descent, Home. */
export const SUITS = ['escape', 'climb', 'descent', 'home'];

/** Every card kind in display / sort order. */
export const SUIT_ORDER = [...SUITS];

export const SUIT_NAMES = { escape: 'Escape', climb: 'Climb', descent: 'Descent', home: 'Home' };

/** R1.2: the suit icons of the printed cards (colour-blind cue and the text-chip faces). */
export const SUIT_ICONS = { escape: 'trophy', climb: 'stockwhip', descent: 'hat', home: 'horseshoe' };

/** The phases in which a card is played (R4, R7). */
export const CARD_PHASES = ['climb', 'descent'];

/** Tunable numbers (spec section 17). Mutable on purpose: see header. */
export const CONSTANTS = {
  RANK_MIN: 1,
  RANK_MAX: 12,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 5,
  /** R3.1 cards each by player count. */
  HAND_SIZE_BY_COUNT: { 2: 12, 3: 12, 4: 11, 5: 9 },
  /** R2.1 hands per game by player count. */
  HANDS_PER_GAME: { 2: 3, 3: 3, 4: 4, 5: 5 },
  /** R1.5 summit step K by player count (the two-sided Mountain card). */
  SUMMIT_BY_COUNT: { 2: 7, 3: 7, 4: 7, 5: 6 },
  /** R4.7 the marker moves this much per climb trick, plus 1 per off-suit card. */
  MARKER_STEP_BASE: 1,
  /** R1.7 / R10.5 the Colt is worth this much on its own. */
  MOB_BASE: 3,
  /** R1.8 each Brumby card under the Colt adds this much. */
  BRUMBY_VALUE: 2,
  /** R10.3 at most this many Brumby cards (there are only 4). */
  BRUMBY_MAX: 4,
  /** R9.3 a chaser who falls scores this (and loses their climb tricks). */
  FALL_SCORE: -1,
  /** R4.6 each climb trick is worth this to a watcher or to the chaser who brings the mob home. */
  CLIMB_TRICK_VALUE: 1,
  /**
   * Simulator probe only (an open design question): 'climb' (the standard breakaway clock) or 'fixed'
   * (the summit comes after half the hand's tricks, floor(handSize / 2), whatever the marker says).
   */
  CLOCK: 'climb',
};

/**
 * @typedef {object} VariantDef
 * @property {string} id  @property {string} name  @property {string} code  @property {string[]} values
 * @property {string[]} implemented  @property {string} default  @property {string} rule  @property {string} label
 * @property {object} valueLabels  @property {string} description  @property {number[]} [onlyFor]
 */

/**
 * The Playtest rules. EMPTY: the standard rules are the only rules. Open design questions are not
 * built as switches.
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
 * The short rules code for stats and analytics. With no switches this is always 'std'; the general
 * code is kept so the shape matches the other games.
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

/** The mob's value with `brumbies` Brumby cards under the Colt (R10.5): 3, 5, 7, 9 or 11. */
export function mobValueFor(params, brumbies) {
  return params.mobBase + params.brumbyValue * brumbies;
}

/**
 * The numbers a game at player count n uses, read from CONSTANTS now (stored at state.params by
 * startGame, so a probe changes only the games created while it is set).
 * @returns {{ n:number, handSize:number, handsPerGame:number, summitStep:number, mountainSide:string,
 *   markerStepBase:number, mobBase:number, brumbyValue:number, brumbyMax:number, mobMax:number,
 *   fallScore:number, climbTrickValue:number, clock:string, fixedSummitTrick:number|null,
 *   deckSize:number, dealt:number, out:number }}
 */
export function deriveParams(rules, n) {
  const C = CONSTANTS;
  if (!Number.isInteger(n) || n < C.MIN_PLAYERS || n > C.MAX_PLAYERS) {
    throw new Error(`This game needs ${C.MIN_PLAYERS} to ${C.MAX_PLAYERS} players, got ${n}`);
  }
  const handSize = C.HAND_SIZE_BY_COUNT[n];
  const deckSize = SUITS.length * (C.RANK_MAX - C.RANK_MIN + 1);
  const dealt = n * handSize;
  if (!Number.isInteger(handSize) || dealt > deckSize || handSize < 2) throw new Error(`Hand size ${handSize} x ${n} players does not fit the deck`);
  const summitStep = C.SUMMIT_BY_COUNT[n];
  if (!Number.isInteger(summitStep) || summitStep < 1) throw new Error(`Summit step must be a positive integer, got ${summitStep}`);
  const handsPerGame = C.HANDS_PER_GAME[n];
  if (!Number.isInteger(handsPerGame) || handsPerGame < 1) throw new Error(`Hands per game must be a positive integer, got ${handsPerGame}`);
  if (!['climb', 'fixed'].includes(C.CLOCK)) throw new Error(`CLOCK must be 'climb' or 'fixed', got ${JSON.stringify(C.CLOCK)}`);
  return {
    n,
    handSize,
    handsPerGame,
    summitStep,
    mountainSide: `0-${summitStep}`, // R1.5: '0-7' for 2-4 players, '0-6' for 5
    markerStepBase: C.MARKER_STEP_BASE,
    mobBase: C.MOB_BASE,
    brumbyValue: C.BRUMBY_VALUE,
    brumbyMax: C.BRUMBY_MAX,
    mobMax: C.MOB_BASE + C.BRUMBY_VALUE * C.BRUMBY_MAX,
    fallScore: C.FALL_SCORE,
    climbTrickValue: C.CLIMB_TRICK_VALUE,
    clock: C.CLOCK,
    fixedSummitTrick: C.CLOCK === 'fixed' ? Math.max(1, Math.floor(handSize / 2)) : null,
    deckSize,
    dealt,
    out: deckSize - dealt,
  };
}
