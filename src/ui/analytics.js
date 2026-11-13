/**
 * Google Analytics events. Everything sent is anonymous: no names, no free text, no seed.
 * game_end carries one anonymous result summary per finished game: which kind of seat won
 * (human / easy / medium / hard / shared), the winning score and margin, whether the last-hand
 * tiebreak decided it (tiebreak_used), the best human rank, and Snowy River's v6 counts: hands whose Brumby
 * row held the Colt (colt_in_row) and seat-hands that ended below zero (negative_hands). hand_end carries
 * the same for that hand (colt_in_row as 0 or 1) plus the value of the Brumby row (row_value).
 *
 * track() drops any parameter that is not on ALLOWED_PARAMS and any value that is not a finite
 * number or a short token (letters, digits and _ , . + -), so a future edit cannot leak a name or a
 * sentence by accident.
 *
 *   game_start, hand_end, game_end, game_abandoned     one game
 *   stats_viewed, stats_exported                       the local stats screen
 *   rules_opened                                       How to play dialog (there is no rule book link)
 *
 * There is no variant_changed event: Snowy River has no Playtest switches. rules_code is always 'std',
 * which means the v6 rules from the publish date of the v6 game (it meant v5 from 10/11/2026, and v4 before).
 *
 * Every call is a no-op when gtag is missing (ad blocker, banner refusal, tests), and a failure
 * here never reaches the game. The page loads GA only off localhost (index.html).
 * v6 changes against v5: removed nobody_chased, chasers and kept_value (there is no Chase / Watch); kept
 * row_value; new colt_in_row and negative_hands (register both as custom metrics in GA).
 */

import { GAME_SLUG } from '../game-config.js';

export const GAME_NAME = GAME_SLUG;

export const ALLOWED_PARAMS = [
  'game_name', 'player_count', 'human_players', 'bot_players', 'bot_levels', 'rules_code',
  'hand_number', 'hands', 'tricks', 'duration_seconds',
  'winner_seat_type', 'winning_score', 'winning_margin', 'tiebreak_used', 'human_rank',
  'row_value', 'colt_in_row', 'negative_hands',
];

export const EVENT_NAMES = [
  'game_start', 'hand_end', 'game_end', 'game_abandoned',
  'stats_viewed', 'stats_exported', 'rules_opened',
];

const TOKEN = /^[A-Za-z0-9_,.+-]{1,60}$/;

let game = null; // { startedAt, ended, base, tricks, hands }
let clock = () => Date.now();

/** Tests only. */
export function _setClock(fn) { clock = fn; }
export function _reset() { game = null; }

/** Keeps whitelisted keys with a finite number or a short token as value. */
export function clean(params) {
  const out = {};
  if (!params) return out;
  for (const k of ALLOWED_PARAMS) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && TOKEN.test(v)) out[k] = v;
  }
  return out;
}

function send(name, params, extra) {
  try {
    if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;
    window.gtag('event', name, { ...clean(params), ...(extra || {}) });
  } catch {
    // Deliberately silent: analytics is allowed to fail.
  }
}

const seatKind = (s) => (s.type === 'human' ? 'human' : s.type);

function seatCounts(seats) {
  const humans = seats.filter((s) => s.type === 'human').length;
  const levels = seats.filter((s) => s.type !== 'human').map((s) => s.type).sort();
  return { human_players: humans, bot_players: levels.length, bot_levels: levels.length ? levels.join(',') : 'none' };
}

const baseOf = (info) => ({
  game_name: GAME_NAME,
  player_count: info.players,
  ...seatCounts(info.seats || []),
  rules_code: info.rulesCode || 'std',
});
const secondsSince = (t) => Math.max(0, Math.round((clock() - t) / 1000));

export function trackGameStart(info) {
  try {
    game = { startedAt: clock(), ended: false, base: baseOf(info), tricks: 0, hands: 0 };
    send('game_start', game.base);
  } catch { /* silent */ }
}

/** Counts completed tricks, so an abandoned game can say how far it got. */
export function trackTrickEnd() {
  try { if (game) game.tricks += 1; } catch { /* silent */ }
}

/** The hand's v6 outcome: row_value (the Brumby row's total) and colt_in_row (0 or 1). */
export function handOutcomeParams(rec) {
  if (!rec || !Array.isArray(rec.row)) return {};
  return { colt_in_row: rec.colt ? 1 : 0, row_value: rec.rowValue };
}

export function trackHandEnd(info) {
  try {
    if (!game) return;
    game.hands += 1;
    const rec = info.record;
    send('hand_end', {
      ...game.base,
      hand_number: info.event.handNo + 1,
      tricks: rec && Array.isArray(rec.tricks) ? rec.tricks.length : undefined,
      ...handOutcomeParams(rec),
      duration_seconds: secondsSince(game.startedAt),
    });
  } catch { /* silent */ }
}

/** The anonymous result summary (see the header). Pure; exported for the tests. */
export function resultSummary(info) {
  const res = info.result;
  const st = info.state;
  const kinds = info.seats.map(seatKind);
  const winnerKinds = new Set(res.winners.map((s) => kinds[s]));
  const humanRanks = res.ranking.filter((r) => kinds[r.seat] === 'human').map((r) => r.rank);
  const tricks = st ? st.measures.tricks : 0;
  return {
    winner_seat_type: res.shared || winnerKinds.size !== 1 ? 'shared' : [...winnerKinds][0],
    winning_score: res.winningScore,
    winning_margin: res.margin,
    tiebreak_used: res.tiebreakUsed ? 'yes' : 'no',
    human_rank: humanRanks.length ? Math.min(...humanRanks) : undefined,
    colt_in_row: st ? st.measures.coltRows : undefined,
    negative_hands: st ? st.measures.negativeHands : undefined,
    tricks,
  };
}

export function trackGameEnd(info) {
  try {
    if (!game || game.ended) return;
    game.ended = true;
    send('game_end', {
      ...game.base,
      ...resultSummary(info),
      hands: info.state ? info.state.handLog.length : game.hands,
      duration_seconds: secondsSince(game.startedAt),
    });
  } catch { /* silent */ }
}

export function trackStatsViewed() { send('stats_viewed', { game_name: GAME_NAME }); }
export function trackStatsExported() { send('stats_exported', { game_name: GAME_NAME }); }
export function trackRulesOpened() { send('rules_opened', { game_name: GAME_NAME }); }

/**
 * A game that is still running when the player leaves it: either by going back to the setup
 * screen (main.js calls onGameAbandoned) or because the page goes away (pagehide). Fires at
 * most once per game, with the usage parameters only (no result).
 */
export function trackGameAbandoned({ beacon = false } = {}) {
  try {
    if (!game || game.ended) return;
    game.ended = true;
    send('game_abandoned', {
      ...game.base,
      hands: game.hands,
      tricks: game.tricks,
      duration_seconds: secondsSince(game.startedAt),
    }, beacon ? { transport_type: 'beacon' } : null); // lets the hit survive a closing page
  } catch { /* silent */ }
}

/** pagehide (not beforeunload) because it also fires on mobile and in the back/forward cache. */
export function installAbandonTracking() {
  try {
    window.addEventListener('pagehide', () => trackGameAbandoned({ beacon: true }));
  } catch { /* silent */ }
}
