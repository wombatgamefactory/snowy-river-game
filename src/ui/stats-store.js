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
//   rules {} (no switches), rules_version (5 = the split-card game; 4 = the old summit-steps game),
//   rules_code ('std' = the current rules, i.e. v5; migrate() relabels records of the v4 game 'v4'),
//   seats [{ seat, type: 'human'|'bot', level: null|'easy'|'medium'|'hard', name? }]  (name only for a
//     human who typed one),
//   hand_scores [[score by seat] by hand], hand_log [per hand, see handRecord],
//   totals [by seat], last_hand_scores [by seat], ranking [{ seat, total, last_hand_score, rank }],
//   winners [seats], shared, tiebreak_used (the last hand separated seats tied on the top total),
//   tied_on_total (two or more seats level on the top total),
//   winning_score, margin, hands, tricks, seconds,
//   v5 counts: chases (chasers over all hands), chases_by_seat, nobody_chased (hands nobody chased),
//     chaser_counts (index = how many chased, value = hands), kept_value (Brumby value kept by chasers),
//     colt_rows (hands the Colt was in the row), colt_kept (hands a chaser kept it).
//
// Hand record (hand_log entry, see handRecord): choices ('C'/'W' by seat as one string), chasers (count),
//   chaser_seats, watcher_seats, climb_tricks / descent_tricks / tricks_by_seat (tricks won, by seat),
//   kept (Brumby ids kept, by seat), kept_values (their value, by seat), costs (chase cost paid, by seat),
//   scores (hand total, by seat), row (6 ids), row_value, colt (in the row), colt_trick (1..6 | null),
//   colt_winner (seat | null), colt_kept, top_home_seat, reshuffled, tricks (tricks played, 12).
//   Records of the v4 game keep their own hand fields (end_reason, mob_value, outcome ...).

import { VARIANTS, DEFAULT_RULES } from '../engine/index.js';
import { STORE_PREFIX } from '../game-config.js';

export const STORE_KEY = `${STORE_PREFIX}-stats-v1`;
export const STORE_VERSION = 1;
/** The rules this build plays. Written to every new record as rules_version. */
export const RULES_VERSION = 5;
/** The rules_code given to records written by the v4 game, so they are never mixed with today's 'std'. */
export const V4_CODE = 'v4';
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
 * Relabels records written by the v4 game (rules before 10/11/2026: summit steps, the mob, low wins).
 * Those records have no rules_version, so a record without one is a v4 record: it gets rules_version 4
 * and rules_code 'v4' (the stats screen then lists it apart from 'std', which now means v5). A record that
 * already has a rules_version is returned as it is (the same object), so migrating twice changes nothing.
 * Never mutates its argument; never throws.
 */
export function migrate(g) {
  if (!g || typeof g !== 'object' || g.rules_version !== undefined) return g;
  return { ...g, rules_version: 4, rules_code: V4_CODE };
}

/** A record read back from storage is trusted only as far as the summary needs. */
function isRecord(g) {
  return !!g && typeof g === 'object' && Array.isArray(g.seats) && Array.isArray(g.totals)
    && Array.isArray(g.winners) && typeof g.rules_code === 'string' && Number.isInteger(g.players);
}

// ---------- recording ----------

/** 'human' or the bot level: the "seat kind" the stats are split by. */
export const seatKind = (s) => (s.type === 'human' ? 'human' : (s.level || 'bot'));

/** One hand's breakdown from a state.handLog entry (v5). */
export function handRecord(h) {
  const choices = h.choices.map((c) => (c === 'chase' ? 'C' : 'W'));
  const seatsOf = (letter) => choices.map((c, i) => (c === letter ? i : -1)).filter((i) => i >= 0);
  return {
    choices: choices.join(''),
    chasers: h.chasers,
    chaser_seats: seatsOf('C'),
    watcher_seats: seatsOf('W'),
    climb_tricks: [...h.climbTricks],
    descent_tricks: [...h.descentTricks],
    tricks_by_seat: [...h.trickCounts],
    kept: h.kept.map((k) => [...k]),
    kept_values: [...h.keptValues],
    costs: [...h.costs],
    scores: [...h.scores],
    row: [...h.row],
    row_value: h.rowValue,
    colt: !!h.colt,
    colt_trick: h.coltTrick,
    colt_winner: h.coltWinner,
    colt_kept: !!h.coltKept,
    top_home_seat: h.topHomeSeat,
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
        nobody_chased: m.nobodyChased,
        chases: m.chasesBySeat.reduce((a, b) => a + b, 0),
        chases_by_seat: [...m.chasesBySeat],
        chaser_counts: [...m.chaserCounts],
        kept_value: m.keptValue,
        colt_rows: m.coltRows,
        colt_kept: m.coltKept,
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
const GAME_COLUMNS = ['tricks', 'nobody_chased', 'chases', 'chases_by_seat', 'kept_value', 'colt_rows', 'colt_kept', 'hand_choices', 'hand_row_values'];
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
    r.winning_score, r.margin, r.tricks, r.nobody_chased, r.chases, join(r.chases_by_seat), r.kept_value, r.colt_rows, r.colt_kept,
    (r.hand_log || []).map((h) => h.choices).join(' '), (r.hand_log || []).map((h) => h.row_value).join(' '), r.seconds,
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
 * `extra` holds the v5 totals (shown in stats-view.js), counted from each v5 hand_log entry and never
 * from a v4 record: seatHands (a seat in a hand), hands, tricks, chases (chasers), nobodyChased, keptValue
 * (Brumby value kept by chasers), keptCards, chaserNet (their hand totals), coltRows, coltKept, coltByKind,
 * coltTopHome (Colt trick won by the top Home holder), humanHands / humanChases (the human seats' own Chase
 * numbers). `extra4` holds the v4 game's totals (hands, tricks, mobsHome, escapes, nobodyChased, chases,
 * falls) for records relabelled 'v4'.
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
  const ex = { seatHands: 0, hands: 0, tricks: 0, chases: 0, nobodyChased: 0, keptValue: 0, keptCards: 0, chaserNet: 0, coltRows: 0, coltKept: 0, coltTopHome: 0, coltByKind: {}, humanHands: 0, humanChases: 0 };
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
    } else {
      ex.hands += log.length; ex.tricks += g.tricks || 0;
      for (const h of log) {
        const ch = typeof h.choices === 'string' ? h.choices : '';
        if (h.chasers === 0) ex.nobodyChased++;
        for (let i = 0; i < ch.length; i++) {
          ex.seatHands++;
          const human = kinds[i] === 'human';
          if (human) ex.humanHands++;
          if (ch[i] !== 'C') continue;
          ex.chases++;
          if (human) ex.humanChases++;
          ex.keptValue += (h.kept_values && h.kept_values[i]) || 0;
          ex.keptCards += (h.kept && h.kept[i] ? h.kept[i].length : 0);
          ex.chaserNet += (h.scores && h.scores[i]) || 0;
        }
        if (h.colt) {
          ex.coltRows++;
          if (h.colt_kept) ex.coltKept++;
          if (h.colt_winner !== null && h.colt_winner !== undefined) {
            const k = kinds[h.colt_winner] || 'bot';
            ex.coltByKind[k] = (ex.coltByKind[k] || 0) + 1;
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
  const byRules = [...rows.values()].sort((a, b) => (a.code === 'std' ? -1 : b.code === 'std' ? 1 : b.games - a.games));

  return {
    total: sel.length,
    allTotal: games.length,
    filter,
    codes: byRules.map((r) => ({ code: r.code, games: r.games })),
    byKind, bySeat, humanVs, byPlayers, ties, byRules,
    extra: ex, extra4: ex4,
    avgScorePerHand: handsScored ? scoreSum / handsScored : null,
    avgMargin: sel.length ? marginSum / sel.length : null,
  };
}

export const statsStore = createStatsStore();
