// stats-store.js - local play statistics. Results stay in the browser (localStorage); nothing
// here is ever sent anywhere. No DOM. Every storage access is inside try/catch, so the game
// works unchanged when storage is blocked, full or throwing: the store then just forgets.
//
// One key, `<slug>-stats-v1`, holds { v: 1, games: [...] }, newest last, capped at MAX_GAMES
// (oldest dropped). The key and envelope are unchanged since the v4 game; the RULES changed, and that
// is carried by each record's rules_version / rules_code (see migrate()).
//
// Game record, one per finished game:
//   v, id, date (ISO), players, seed (string),
//   rules {} (no switches), rules_version (6 = the Climb row game; 5 = the split-card Chase / Watch game;
//     4 = the old summit-steps game),
//   rules_code ('std' = the current rules, i.e. v6; migrate() relabels records of the v5 game 'v5' and of
//     the v4 game 'v4', so the three are never mixed),
//   seats [{ seat, type: 'human'|'bot', level: null|'easy'|'medium'|'hard', name? }]  (name only for a
//     human who typed one),
//   hand_scores [[score by seat] by hand], hand_log [per hand, see handRecord],
//   totals [by seat], last_hand_scores [by seat], ranking [{ seat, total, last_hand_score, rank }],
//   winners [seats], shared, tiebreak_used (the last hand separated seats tied on the top total),
//   tied_on_total (two or more seats level on the top total),
//   winning_score, margin, hands, tricks, seconds,
//   v6 counts: minus_by_seat (the -1 Climb card taken, by seat), colt_by_seat (the Colt taken, by seat),
//     colt_rows (hands the Colt was in the row), negative_hands (seat-hands that scored below zero),
//     brumby_cards (Brumby cards taken, all seats), brumby_value (their total value), reshuffles.
//
// Hand record (hand_log entry, see handRecord): climb_tricks / descent_tricks / tricks_by_seat (tricks won,
//   by seat), climb_cards (Climb ids by seat), climb_values (their value, by seat), climb_row_values (6),
//   minus_position (1..6), minus_winner (seat), kept (Brumby ids by seat), kept_values (their value, by seat),
//   scores (hand total, by seat = climb_values + kept_values), row (6 ids), row_value, colt (in the row),
//   colt_trick (1..6 | null), colt_winner (seat | null), top_home_seat, home1_seat (null when out unseen),
//   reshuffled, tricks (tricks played, 12).
//   Records of the v5 game keep their own hand fields (choices, chasers, costs, colt_kept ...), and records
//   of the v4 game theirs (end_reason, mob_value, outcome ...).

import { VARIANTS, DEFAULT_RULES } from '../engine/index.js';
import { STORE_PREFIX } from '../game-config.js';

export const STORE_KEY = `${STORE_PREFIX}-stats-v1`;
export const STORE_VERSION = 1;
/** The rules this build plays. Written to every new record as rules_version. */
export const RULES_VERSION = 6;
/** The rules_code given to records written by the v4 game, so they are never mixed with today's 'std'. */
export const V4_CODE = 'v4';
/** The rules_code given to records written by the v5 game (Chase / Watch, split cards). */
export const V5_CODE = 'v5';
export const MAX_GAMES = 2000;

const empty = () => ({ v: STORE_VERSION, games: [] });

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** getStorage: () => Storage-like (getItem/setItem/removeItem); may throw or return null. */
export function createStatsStore(getStorage = defaultStorage) {
  function load() {
    try {
      const s = getStorage();
      if (!s) return empty();
      const raw = s.getItem(STORE_KEY);
      if (!raw) return empty();
      const data = JSON.parse(raw);
      if (!data || data.v !== STORE_VERSION) return empty();
      return { v: STORE_VERSION, games: Array.isArray(data.games) ? data.games.filter(isRecord).map(migrate) : [] };
    } catch { return empty(); }
  }

  function save(data) {
    for (const keep of [MAX_GAMES, 800, 200]) {
      try {
        const s = getStorage();
        if (!s) return false;
        s.setItem(STORE_KEY, JSON.stringify({ ...data, games: data.games.slice(-keep) }));
        return true;
      } catch { /* quota or blocked: retry smaller, then give up */ }
    }
    return false;
  }

  return {
    load,
    addGame(rec) {
      const data = load();
      data.games.push(rec);
      if (data.games.length > MAX_GAMES) data.games = data.games.slice(-MAX_GAMES);
      return save(data);
    },
    clear() {
      try { const s = getStorage(); if (s) s.removeItem(STORE_KEY); return true; } catch { return false; }
    },
  };
}

/**
 * Relabels records written by earlier games so they are never mixed with today's 'std' (= v6).
 *  - No rules_version: the v4 game (rules before 10/11/2026: summit steps, the mob, low wins). It gets
 *    rules_version 4 and rules_code 'v4'.
 *  - rules_version 5 and rules_code still 'std': the v5 game (split cards, Chase / Watch). It gets
 *    rules_code 'v5' (rules_version stays 5).
 * Anything else is returned as it is (the same object), so migrating twice changes nothing.
 * Never mutates its argument; never throws.
 */
export function migrate(g) {
  if (!g || typeof g !== 'object') return g;
  if (g.rules_version === undefined) return { ...g, rules_version: 4, rules_code: V4_CODE };
  if (g.rules_version === 5 && g.rules_code === 'std') return { ...g, rules_code: V5_CODE };
  return g;
}

/** A record read back from storage is trusted only as far as the summary needs. */
function isRecord(g) {
  return !!g && typeof g === 'object' && Array.isArray(g.seats) && Array.isArray(g.totals)
    && Array.isArray(g.winners) && typeof g.rules_code === 'string' && Number.isInteger(g.players);
}

// ---------- recording ----------

/** 'human' or the bot level: the "seat kind" the stats are split by. */
export const seatKind = (s) => (s.type === 'human' ? 'human' : (s.level || 'bot'));

/** One hand's breakdown from a state.handLog entry (v6). */
export function handRecord(h) {
  return {
    climb_tricks: [...h.climbTricks],
    descent_tricks: [...h.descentTricks],
    tricks_by_seat: [...h.trickCounts],
    climb_cards: h.climbCards.map((c) => [...c]),
    climb_values: [...h.climbValues],
    climb_row_values: [...h.climbRowValues],
    minus_position: h.minusPosition,
    minus_winner: h.minusWinner,
    kept: h.kept.map((k) => [...k]),
    kept_values: [...h.keptValues],
    scores: [...h.scores],
    row: [...h.row],
    row_value: h.rowValue,
    colt: !!h.colt,
    colt_trick: h.coltTrick,
    colt_winner: h.coltWinner,
    top_home_seat: h.topHomeSeat,
    home1_seat: h.home1Seat === undefined ? null : h.home1Seat,
    reshuffled: !!h.reshuffled,
    tricks: Array.isArray(h.tricks) ? h.tricks.length : 0,
  };
}

/**
 * Turns the session hooks into records. `now` is injectable for tests. The record is built from the
 * finished game state (info.state) and the seat setup (info.seats: [{ type: 'human'|level, name }]).
 */
export function createRecorder(store, now = () => Date.now()) {
  let gameStartedAt = null;
  return {
    gameStart() { gameStartedAt = now(); },
    gameEnd(info) {
      const st = info.state;
      const res = st && st.result;
      if (!st || !res) return null;
      const m = st.measures;
      const d = new Date(now());
      const rec = {
        v: STORE_VERSION,
        id: `g${d.getTime().toString(36)}-${String(info.seed).slice(0, 12)}`,
        date: d.toISOString(),
        players: st.n,
        seed: String(info.seed),
        rules: { ...st.rules },
        rules_version: RULES_VERSION,
        rules_code: st.rulesCode,
        seats: info.seats.map((s, i) => {
          const human = s.type === 'human';
          const seat = { seat: i, type: human ? 'human' : 'bot', level: human ? null : s.type };
          if (human && s.name) seat.name = String(s.name).slice(0, 16);
          return seat;
        }),
        hand_scores: st.handLog.map((h) => [...h.scores]),
        hand_log: st.handLog.map(handRecord),
        totals: [...res.totals],
        last_hand_scores: [...res.lastHandScores],
        ranking: res.ranking.map((r) => ({ seat: r.seat, total: r.total, last_hand_score: r.lastHandScore, rank: r.rank })),
        winners: [...res.winners],
        shared: !!res.shared,
        tiebreak_used: !!res.tiebreakUsed,
        tied_on_total: res.tiedOnTotal.length > 1,
        winning_score: res.winningScore,
        margin: res.margin,
        hands: st.handLog.length,
        tricks: m.tricks,
        minus_by_seat: [...m.minusBySeat],
        colt_by_seat: [...m.coltBySeat],
        colt_rows: m.coltRows,
        negative_hands: m.negativeHands,
        brumby_cards: st.handLog.reduce((a, h) => a + h.kept.reduce((x, k) => x + k.length, 0), 0),
        brumby_value: st.handLog.reduce((a, h) => a + h.keptValues.reduce((x, y) => x + y, 0), 0),
        reshuffles: m.reshuffles,
        seconds: gameStartedAt === null ? 0 : Math.max(0, Math.round((now() - gameStartedAt) / 1000)),
      };
      store.addGame(rec);
      return rec;
    },
  };
}

// ---------- export ----------

const SEAT_COLS = [1, 2, 3, 4, 5].flatMap((n) => [`seat${n}_type`, `seat${n}_name`]);
/** Snowy River's own CSV columns after the shared ones (the matching cells are in gameToRow). */
const GAME_COLUMNS = ['tricks', 'minus_by_seat', 'colt_by_seat', 'colt_rows', 'negative_hands', 'brumby_cards', 'brumby_value', 'hand_row_values'];
export const CSV_COLUMNS = [
  'date', 'id', 'seed', 'players', 'rules_code', 'rules_version',
  ...VARIANTS.map((v) => `rule_${v.name.toLowerCase()}`),
  ...SEAT_COLS,
  'hands', 'hand_scores', 'totals', 'ranks', 'winner_seats', 'shared_win', 'tiebreak_used', 'tied_on_total',
  'winning_score', 'margin', ...GAME_COLUMNS, 'duration_seconds',
];

export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const bool = (b) => (b ? 'yes' : 'no');
const join = (a) => (Array.isArray(a) ? a.join(' ') : '');

/** Seats are 1-based in the CSV (Seat 1 ... Seat 5, as on screen). Seat type is human, easy, medium or hard. */
export function gameToRow(r) {
  const seatCells = [0, 1, 2, 3, 4].flatMap((i) => {
    const s = r.seats[i];
    return s ? [seatKind(s), s.name || ''] : ['', ''];
  });
  const rules = r.rules || {};
  const ranks = [...(r.ranking || [])].sort((a, b) => a.seat - b.seat).map((x) => x.rank);
  return [
    r.date, r.id, r.seed, r.players, r.rules_code, r.rules_version,
    ...VARIANTS.map((v) => (rules[v.name] !== undefined ? rules[v.name] : DEFAULT_RULES[v.name])),
    ...seatCells,
    r.hands, (r.hand_scores || []).map((h) => h.join(' ')).join('|'), join(r.totals), ranks.join(' '),
    r.winners.map((s) => s + 1).join(' '), bool(r.shared), bool(r.tiebreak_used), bool(r.tied_on_total),
    r.winning_score, r.margin, r.tricks, join(r.minus_by_seat), join(r.colt_by_seat), r.colt_rows, r.negative_hands, r.brumby_cards, r.brumby_value,
    (r.hand_log || []).map((h) => h.row_value).join(' '), r.seconds,
  ];
}

/** One header row plus one row per game; LF only so it is safe to paste into URLs and tools. */
export function toCsv(games) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const g of games) lines.push(gameToRow(g).map(csvCell).join(','));
  return `${lines.join('\n')}\n`;
}

export function toJson(data) {
  return JSON.stringify({ exported: new Date().toISOString(), game: STORE_PREFIX, schema: STORE_VERSION, ...data }, null, 2);
}

/** `<slug>-stats-2026-11-04.csv`, local date. */
export function exportFilename(ext, d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${STORE_PREFIX}-stats-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${ext}`;
}

// ---------- summary ----------

export const KINDS = ['human', 'easy', 'medium', 'hard'];

const tally = () => ({ seats: 0, wins: 0 });

/**
 * Pure aggregation for the stats screen. `filter` is 'all' or a rules_code; the by-rules table
 * always covers every game so the codes can be compared side by side.
 * `extra` holds the v6 totals (shown in stats-view.js), counted from each v6 hand_log entry only: seatHands
 * (a seat in a hand), hands, tricks, scoreSum, brumbyCards / brumbyValue (Brumby cards taken and their value),
 * negHands (seat-hands below zero), minusTaken / minusByKind (the -1 Climb card, by seat kind), coltRows,
 * coltByKind (who took the Colt), coltHome1 (taken by the Home 1 holder), coltTopHome, and the human seats' own
 * numbers: humanHands, humanScoreSum, humanMinus, humanColt, humanNeg, humanBrumby, humanBrumbyValue.
 * `extra5` holds the v5 game's totals (Chase / Watch, for records relabelled 'v5') and `extra4` the v4
 * game's (hands, tricks, mobsHome, escapes, nobodyChased, chases, falls) for records relabelled 'v4'.
 */
export function summarise(allGames, filter = 'all') {
  const games = (allGames || []).filter(isRecord).map(migrate);
  const sel = filter === 'all' ? games : games.filter((g) => g.rules_code === filter);

  const byKind = Object.fromEntries(KINDS.map((k) => [k, tally()]));
  const bySeat = Array.from({ length: 5 }, tally);
  const humanVs = Object.fromEntries(['easy', 'medium', 'hard'].map((l) => [l, { games: 0, humanSeats: 0, humanWins: 0, botSeats: 0, botWins: 0 }]));
  const byPlayers = {};
  const ties = { games: sel.length, tied: 0, tiebreak: 0, shared: 0 };
  let handsScored = 0; let scoreSum = 0; let marginSum = 0;
  const ex = {
    seatHands: 0, hands: 0, tricks: 0, scoreSum: 0, brumbyCards: 0, brumbyValue: 0, negHands: 0, minusTaken: 0, minusByKind: {}, coltRows: 0, coltByKind: {},
    coltHome1: 0, coltTopHome: 0, humanHands: 0, humanScoreSum: 0, humanMinus: 0, humanColt: 0, humanNeg: 0, humanBrumby: 0, humanBrumbyValue: 0,
  };
  const ex5 = { seatHands: 0, hands: 0, tricks: 0, chases: 0, nobodyChased: 0, keptValue: 0, keptCards: 0, chaserNet: 0, coltRows: 0, coltKept: 0, coltTopHome: 0, coltByKind: {}, humanHands: 0, humanChases: 0 };
  const ex4 = { hands: 0, tricks: 0, mobsHome: 0, escapes: 0, nobodyChased: 0, chases: 0, falls: 0 };

  for (const g of sel) {
    const won = new Set(g.winners);
    const kinds = g.seats.map(seatKind);
    g.seats.forEach((s, i) => {
      const k = kinds[i];
      if (byKind[k]) { byKind[k].seats++; if (won.has(i)) byKind[k].wins++; }
      if (bySeat[i]) { bySeat[i].seats++; if (won.has(i)) bySeat[i].wins++; }
    });
    const humans = kinds.map((k, i) => (k === 'human' ? i : -1)).filter((i) => i >= 0);
    for (const level of Object.keys(humanVs)) {
      const bots = kinds.map((k, i) => (k === level ? i : -1)).filter((i) => i >= 0);
      if (!humans.length || !bots.length) continue;
      const h = humanVs[level];
      h.games++;
      h.humanSeats += humans.length; h.humanWins += humans.filter((i) => won.has(i)).length;
      h.botSeats += bots.length; h.botWins += bots.filter((i) => won.has(i)).length;
    }
    const p = byPlayers[g.players] || (byPlayers[g.players] = { games: 0, hands: 0, scoreSum: 0, marginSum: 0, winSum: 0 });
    p.games++;
    p.marginSum += g.margin || 0; p.winSum += g.winning_score || 0;
    for (const h of g.hand_scores || []) for (const x of h) { p.hands++; p.scoreSum += x; handsScored++; scoreSum += x; }
    marginSum += g.margin || 0;
    const log = Array.isArray(g.hand_log) ? g.hand_log : [];
    if (g.rules_version === 4) {
      ex4.hands += g.hands || 0; ex4.tricks += g.tricks || 0; ex4.mobsHome += g.mobs_home || 0; ex4.nobodyChased += g.nobody_chased || 0;
      for (const h of log) {
        if (h.outcome && h.outcome !== 'home') ex4.escapes++;
        ex4.chases += typeof h.choices === 'string' ? h.choices.split('C').length - 1 : 0;
        if (Array.isArray(h.outcomes)) ex4.falls += h.outcomes.filter((o) => o === 'fell').length;
      }
    } else if (g.rules_version === 5) {
      ex5.hands += log.length; ex5.tricks += g.tricks || 0;
      for (const h of log) {
        const ch = typeof h.choices === 'string' ? h.choices : '';
        if (h.chasers === 0) ex5.nobodyChased++;
        for (let i = 0; i < ch.length; i++) {
          ex5.seatHands++;
          const human = kinds[i] === 'human';
          if (human) ex5.humanHands++;
          if (ch[i] !== 'C') continue;
          ex5.chases++;
          if (human) ex5.humanChases++;
          ex5.keptValue += (h.kept_values && h.kept_values[i]) || 0;
          ex5.keptCards += (h.kept && h.kept[i] ? h.kept[i].length : 0);
          ex5.chaserNet += (h.scores && h.scores[i]) || 0;
        }
        if (h.colt) {
          ex5.coltRows++;
          if (h.colt_kept) ex5.coltKept++;
          if (h.colt_winner !== null && h.colt_winner !== undefined) {
            const k = kinds[h.colt_winner] || 'bot';
            ex5.coltByKind[k] = (ex5.coltByKind[k] || 0) + 1;
            if (h.colt_winner === h.top_home_seat) ex5.coltTopHome++;
          }
        }
      }
    } else {
      ex.hands += log.length; ex.tricks += g.tricks || 0;
      for (const h of log) {
        const scores = Array.isArray(h.scores) ? h.scores : [];
        scores.forEach((sc, i) => {
          const human = kinds[i] === 'human';
          ex.seatHands++; ex.scoreSum += sc;
          if (sc < 0) { ex.negHands++; if (human) ex.humanNeg++; }
          const cards = h.kept && h.kept[i] ? h.kept[i].length : 0;
          const value = (h.kept_values && h.kept_values[i]) || 0;
          ex.brumbyCards += cards; ex.brumbyValue += value;
          if (human) { ex.humanHands++; ex.humanScoreSum += sc; ex.humanBrumby += cards; ex.humanBrumbyValue += value; }
        });
        if (h.minus_winner !== null && h.minus_winner !== undefined) {
          const k = kinds[h.minus_winner] || 'bot';
          ex.minusTaken++; ex.minusByKind[k] = (ex.minusByKind[k] || 0) + 1;
          if (k === 'human') ex.humanMinus++;
        }
        if (h.colt) {
          ex.coltRows++;
          if (h.colt_winner !== null && h.colt_winner !== undefined) {
            const k = kinds[h.colt_winner] || 'bot';
            ex.coltByKind[k] = (ex.coltByKind[k] || 0) + 1;
            if (k === 'human') ex.humanColt++;
            if (h.home1_seat !== null && h.home1_seat !== undefined && h.colt_winner === h.home1_seat) ex.coltHome1++;
            if (h.colt_winner === h.top_home_seat) ex.coltTopHome++;
          }
        }
      }
    }
    if (g.tied_on_total) ties.tied++;
    if (g.tiebreak_used) ties.tiebreak++;
    if (g.shared) ties.shared++;
  }

  const rows = new Map();
  for (const g of games) {
    const r = rows.get(g.rules_code) || { code: g.rules_code, games: 0, hands: 0, scoreSum: 0, marginSum: 0, tied: 0, tiebreak: 0, shared: 0 };
    r.games++; r.marginSum += g.margin || 0;
    for (const h of g.hand_scores || []) for (const x of h) { r.hands++; r.scoreSum += x; }
    if (g.tied_on_total) r.tied++;
    if (g.tiebreak_used) r.tiebreak++;
    if (g.shared) r.shared++;
    rows.set(g.rules_code, r);
  }
  const order = (c) => (c === 'std' ? 0 : c === 'v5' ? 1 : c === 'v4' ? 2 : 3); // newest rules first
  const byRules = [...rows.values()].sort((a, b) => order(a.code) - order(b.code) || b.games - a.games);

  return {
    total: sel.length,
    allTotal: games.length,
    filter,
    codes: byRules.map((r) => ({ code: r.code, games: r.games })),
    byKind, bySeat, humanVs, byPlayers, ties, byRules,
    extra: ex, extra5: ex5, extra4: ex4,
    avgScorePerHand: handsScored ? scoreSum / handsScored : null,
    avgMargin: sel.length ? marginSum / sel.length : null,
  };
}

export const statsStore = createStatsStore();
