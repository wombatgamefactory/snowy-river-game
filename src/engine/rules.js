// rules.js - constants and the (empty) VARIANTS table. Data only, plus resolveVariants(), rulesCode()
// and deriveParams().
//
// Snowy River, v5 rules (rule numbers R1.1 ... R12.4 in the comments):
// a trick-taker for 2 to 4 players. 48 SPLIT cards in four suits (Escape, Climb, Descent, Home); each
// card has a climb value v (1-12) and a descent value 13 - v. Every hand is 6 CLIMB tricks (climb values,
// Escape trumps), the SUMMIT (hands turn round, the Mountain turns, 6 Brumby cards are laid face up and
// everyone secretly chooses Chase or Watch), then 6 DESCENT tricks (descent values, Home trumps). Highest
// always wins; a trump played beats the led suit. Every trick is 1 point; a chaser also keeps the Brumby
// card of each descent trick they win and pays the chase cost.
//
// There are NO Playtest switches: VARIANTS is empty, rules_code is always 'std' (which means v5 rules).
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

/** The phases in which a card is played (R4, R6). */
export const CARD_PHASES = ['climb', 'descent'];

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
  MAX_PLAYERS: 4,
  /** R3.1 every player is dealt 12 (6 climb + 6 descent tricks). */
  HAND_SIZE: 12,
  /** R2.1 hands per game by player count. */
  HANDS_PER_GAME: { 2: 3, 3: 3, 4: 4 },
  /** R4.1 / R6 tricks in each half. */
  CLIMB_TRICKS: 6,
  DESCENT_TRICKS: 6,
  /** R7.1 every trick is worth this. */
  TRICK_POINTS: 1,
  /** R4.4 / R6.3 trumps by half. */
  TRUMP_CLIMB: 'escape',
  TRUMP_DESCENT: 'home',
  /** R5.4 Brumby cards laid out at the summit (one per descent trick). */
  ROW_SIZE: 6,
  /** R8.4 shuffle all 12 together when fewer than this are left in the deck. */
  RESHUFFLE_BELOW: 6,
  /** R5.7 the Chase cost by player count. */
  CHASE_COST_BY_COUNT: { 2: 3, 3: 2, 4: 2 },
};

/**
 * @typedef {object} VariantDef
 * @property {string} id  @property {string} name  @property {string} code  @property {string[]} values
 * @property {string[]} implemented  @property {string} default  @property {string} rule  @property {string} label
 * @property {object} valueLabels  @property {string} description  @property {number[]} [onlyFor]
 */

/**
 * The Playtest rules. EMPTY (R1.12, spec section 15): the standard rules are the only rules.
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
 * The short rules code for stats and analytics. With no switches this is always 'std' (v5 rules since
 * 10/11/2026); the general code is kept so the shape matches the other games.
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
 * Throws for a player count outside MIN_PLAYERS..MAX_PLAYERS (R1.9: 5 players are not built).
 * @returns {{ n:number, handSize:number, handsPerGame:number, climbTricks:number, descentTricks:number,
 *   trickPoints:number, trumpClimb:string, trumpDescent:string, rowSize:number, reshuffleBelow:number,
 *   chaseCost:number, deckSize:number, dealt:number, out:number, brumbyCount:number }}
 */
export function deriveParams(rules, n) {
  const C = CONSTANTS;
  if (!Number.isInteger(n) || n < C.MIN_PLAYERS || n > C.MAX_PLAYERS) {
    throw new Error(`This game needs ${C.MIN_PLAYERS} to ${C.MAX_PLAYERS} players, got ${n}`);
  }
  const handSize = C.HAND_SIZE;
  const deckSize = SUITS.length * (C.VALUE_MAX - C.VALUE_MIN + 1);
  const dealt = n * handSize;
  if (!Number.isInteger(handSize) || dealt > deckSize) throw new Error(`Hand size ${handSize} x ${n} players does not fit the deck`);
  if (C.CLIMB_TRICKS + C.DESCENT_TRICKS !== handSize) throw new Error(`CLIMB_TRICKS + DESCENT_TRICKS must equal HAND_SIZE (${handSize})`);
  if (C.ROW_SIZE !== C.DESCENT_TRICKS) throw new Error('ROW_SIZE must equal DESCENT_TRICKS (one Brumby card per descent trick)');
  const handsPerGame = C.HANDS_PER_GAME[n];
  if (!Number.isInteger(handsPerGame) || handsPerGame < 1) throw new Error(`Hands per game must be a positive integer, got ${handsPerGame}`);
  const chaseCost = C.CHASE_COST_BY_COUNT[n];
  if (!Number.isInteger(chaseCost)) throw new Error(`No chase cost for ${n} players`);
  const brumbyCount = BRUMBY_KINDS.reduce((a, k) => a + k.count, 0);
  if (C.RESHUFFLE_BELOW > brumbyCount || C.ROW_SIZE > brumbyCount) throw new Error('The Brumby deck is too small for the row');
  return {
    n,
    handSize,
    handsPerGame,
    climbTricks: C.CLIMB_TRICKS,
    descentTricks: C.DESCENT_TRICKS,
    trickPoints: C.TRICK_POINTS,
    trumpClimb: C.TRUMP_CLIMB,
    trumpDescent: C.TRUMP_DESCENT,
    rowSize: C.ROW_SIZE,
    reshuffleBelow: C.RESHUFFLE_BELOW,
    chaseCost,
    deckSize,
    dealt,
    out: deckSize - dealt,
    brumbyCount,
  };
}

/** The trump suit of a half: 'climb' -> Escape, 'descent' -> Home (R4.4, R6.3). */
export function trumpFor(params, half) {
  return half === 'descent' ? params.trumpDescent : params.trumpClimb;
}
