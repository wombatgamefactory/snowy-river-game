// stats-store.js - local play statistics. Results stay in the browser (localStorage); nothing
// here is ever sent anywhere. No DOM. Every storage access is inside try/catch, so the game
// works unchanged when storage is blocked, full or throwing: the store then just forgets.
//
// One key, `<slug>-stats-v1`, holds { v: 1, games: [...] }, newest last, capped at MAX_GAMES
// (oldest dropped).
//
// Game record (schema 1), one per finished game:
//   v, id, date (ISO), players, seed (string),
//   rules {} (no switches), rules_code (always 'std'),
//   seats [{ seat, type: 'human'|'bot', level: null|'easy'|'medium'|'hard', name? }]  (name only for a
//     human who typed one),
//   hand_scores [[score by seat] by hand], hand_log [per hand, see handRecord],
//   totals [by seat], ranking [{ seat, total, mobs_home (the tiebreak), rank }],
//   winners [seats], shared, tiebreak_used (mobs brought home separated seats tied on the top total),
//   tied_on_total (two or more seats level on the top total),
//   winning_score, margin, hands, tricks, seconds,
//   Snowy River's own counts: mobs_home (hands a chaser brought the mob home), mobs_home_by_seat (the
//     tiebreak, by seat), escapes (hands the mob escaped: nobody chased or a watcher at the heels),
//     nobody_chased (hands that ended at the summit), chases (chasers over all hands), falls (chasers
//     who fell), chases_by_seat, falls_by_seat.
//
// Hand record (hand_log entry, see handRecord): end_reason ('descent' | 'nobody-chases'), outcome
//   ('home' | 'escaped-watcher' | 'nobody-chased'), summit_reached, summit_trick (climb tricks played
//   when the summit came), forced_summit, tricks, mob_value, brumbies_before / brumbies_after, brumby_added,
//   choices ('C'/'W' by seat), chasers (count), chaser_seats, watcher_seats, heels (seat or null),
//   tie_at_heels, home (seat or null), falls, climb_tricks / descent_tricks / outcomes / scores by seat.

import { VARIANTS, DEFAULT_RULES } from '../engine/index.js';
import { STORE_PREFIX } from '../game-config.js';

export const STORE_KEY = `${STORE_PREFIX}-stats-v1`;
export const STORE_VERSION = 1;
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
      return { v: STORE_VERSION, games: Array.isArray(data.games) ? data.games.filter(isRecord) : [] };
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

/** A record read back from storage is trusted only as far as the summary needs. */
function isRecord(g) {
  return !!g && typeof g === 'object' && Array.isArray(g.seats) && Array.isArray(g.totals)
    && Array.isArray(g.winners) && typeof g.rules_code === 'string' && Number.isInteger(g.players);
}

// ---------- recording ----------

/** 'human' or the bot level: the "seat kind" the stats are split by. */
export const seatKind = (s) => (s.type === 'human' ? 'human' : (s.level || 'bot'));

/** 'home' | 'escaped-watcher' | 'nobody-chased' from a state.handLog entry. */
export function handOutcome(h) {
  if (h.broughtHomeBy !== null && h.broughtHomeBy !== undefined) return 'home';
  return h.chasers === 0 ? 'nobody-chased' : 'escaped-watcher';
}

/** One hand's breakdown from a state.handLog entry. */
export function handRecord(h) {
  const choices = h.choices.map((c) => (c === 'chase' ? 'C' : 'W'));
  const seatsOf = (letter) => choices.map((c, i) => (c === letter ? i : -1)).filter((i) => i >= 0);
  return {
    end_reason: h.endReason,
    outcome: handOutcome(h),
    summit_reached: h.summitTrick !== null && h.summitTrick !== undefined,
    summit_trick: h.summitTrick,
    forced_summit: !!h.forcedSummit,
    tricks: Array.isArray(h.tricks) ? h.tricks.length : 0,
    mob_value: h.mobValue,
    brumbies_before: h.brumbiesBefore,
    brumbies_after: h.brumbiesAfter,
    brumby_added: !!h.brumbyAdded,
    choices: choices.join(''),
    chasers: h.chasers,
    chaser_seats: seatsOf('C'),
    watcher_seats: seatsOf('W'),
    climb_tricks: [...h.climbTricks],
    descent_tricks: [...h.descentTricks],
    outcomes: [...h.outcomes],
    heels: h.heelsSeat,
    tie_at_heels: !!h.tieAtHeels,
    home: h.broughtHomeBy,
    falls: h.falls,
    scores: [...h.scores],
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
        ranking: res.ranking.map((r) => ({ seat: r.seat, total: r.total, mobs_home: r.mobsHome, rank: r.rank })),
        winners: [...res.winners],
        shared: !!res.shared,
        tiebreak_used: !!res.tiebreakUsed,
        tied_on_total: res.tiedOnTotal.length > 1,
        winning_score: res.winningScore,
        margin: res.margin,
        hands: st.handLog.length,
        tricks: m.tricks,
        mobs_home: m.mobsHome,
        nobody_chased: m.nobodyChased,
        mobs_home_by_seat: [...m.mobsHomeBySeat],
        escapes: m.escapes,
        chases: m.chasesBySeat.reduce((a, b) => a + b, 0),
        falls: m.falls,
        chases_by_seat: [...m.chasesBySeat],
        falls_by_seat: [...m.fallsBySeat],
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
const GAME_COLUMNS = ['tricks', 'mobs_home', 'mobs_home_by_seat', 'escapes', 'nobody_chased', 'chases', 'falls', 'hand_outcomes'];
export const CSV_COLUMNS = [
  'date', 'id', 'seed', 'players', 'rules_code',
  ...VARIANTS.map((v) => `rule_${v.name.toLowerCase()}`),
  ...SEAT_COLS,
  'hands', 'hand_scores', 'totals', 'ranks', 'winner_seats', 'shared_win', 'tiebreak_used', 'tied_on_total',
  'winning_score', 'margin', ...GAME_COLUMNS, 'hand_end_reasons', 'duration_seconds',
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
    r.date, r.id, r.seed, r.players, r.rules_code,
    ...VARIANTS.map((v) => (rules[v.name] !== undefined ? rules[v.name] : DEFAULT_RULES[v.name])),
    ...seatCells,
    r.hands, (r.hand_scores || []).map((h) => h.join(' ')).join('|'), join(r.totals), ranks.join(' '),
    r.winners.map((s) => s + 1).join(' '), bool(r.shared), bool(r.tiebreak_used), bool(r.tied_on_total),
    r.winning_score, r.margin, r.tricks, r.mobs_home, join(r.mobs_home_by_seat), r.escapes, r.nobody_chased, r.chases, r.falls,
    (r.hand_log || []).map((h) => h.outcome).join(' '), (r.hand_log || []).map((h) => h.end_reason).join(' '), r.seconds,
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
 * `extra` holds Snowy River's own totals (shown in stats-view.js), counted from each hand_log entry:
 * hands, tricks, mobsHome, escapes, nobodyChased, chases (chasers), falls, and the human seats' own
 * Chase numbers (humanHands, humanChases, humanHomes).
 */
export function summarise(allGames, filter = 'all') {
  const games = (allGames || []).filter(isRecord);
  const sel = filter === 'all' ? games : games.filter((g) => g.rules_code === filter);

  const byKind = Object.fromEntries(KINDS.map((k) => [k, tally()]));
  const bySeat = Array.from({ length: 5 }, tally);
  const humanVs = Object.fromEntries(['easy', 'medium', 'hard'].map((l) => [l, { games: 0, humanSeats: 0, humanWins: 0, botSeats: 0, botWins: 0 }]));
  const byPlayers = {};
  const ties = { games: sel.length, tied: 0, tiebreak: 0, shared: 0 };
  let handsScored = 0; let scoreSum = 0; let marginSum = 0;
  let hands = 0; let tricks = 0; let mobsHome = 0; let nobodyChased = 0;
  let escapes = 0; let chases = 0; let falls = 0; let humanHands = 0; let humanChases = 0; let humanHomes = 0;

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
    hands += g.hands || 0; tricks += g.tricks || 0; mobsHome += g.mobs_home || 0; nobodyChased += g.nobody_chased || 0;
    for (const h of Array.isArray(g.hand_log) ? g.hand_log : []) {
      const ch = typeof h.choices === 'string' ? h.choices : '';
      if (h.outcome && h.outcome !== 'home') escapes++;
      for (let i = 0; i < ch.length; i++) {
        if (ch[i] === 'C') chases++;
        if (kinds[i] === 'human') {
          humanHands++;
          if (ch[i] === 'C') { humanChases++; if (h.home === i) humanHomes++; }
        }
      }
      if (Array.isArray(h.outcomes)) falls += h.outcomes.filter((o) => o === 'fell').length;
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
    extra: { hands, tricks, mobsHome, escapes, nobodyChased, chases, falls, humanHands, humanChases, humanHomes },
    avgScorePerHand: handsScored ? scoreSum / handsScored : null,
    avgMargin: sel.length ? marginSum / sel.length : null,
  };
}

export const statsStore = createStatsStore();
