// stats-node.mjs - the local stats store, the recorder, the CSV / JSON export, the summary, the
// stats screen markup, the analytics whitelist and events, and the bug report (all without a
// browser: storage is a fake, `window.gtag` is a recorder).
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. Run: node tests/stats-node.mjs

import { suite, roundTrip } from './lib.mjs';
import {
  createStatsStore, createRecorder, handRecord, toCsv, toJson, exportFilename, csvCell, gameToRow, CSV_COLUMNS, summarise, seatKind,
  STORE_KEY, MAX_GAMES, migrate, RULES_VERSION, V4_CODE, V5_CODE,
} from '../src/ui/stats-store.js';
import { statsHtml, statsButtonsHtml, effectiveFilter } from '../src/ui/stats-view.js';
import * as analytics from '../src/ui/analytics.js';
import * as bug from '../src/ui/bug-report.js';
import { createController } from '../src/ui/controller.js';
import { VARIANTS } from '../src/engine/index.js';
import { GAME_SLUG, CONTACT_EMAIL } from '../src/game-config.js';

const { check, done } = suite('stats-node');
const BAD = /undefined|NaN|\[object/;
const V6_ROWS = ['Average hand score', 'Average hand score of a human seat', 'Took the -1 Climb card (human seats)', 'Brumby cards won (all seats)', 'Brumby cards won (human seats)', 'Hands ending below zero (all seats)', 'Hands ending below zero (human seats)', 'Colt in the row', 'Colt taken by a human seat (+4)', 'Colt taken by the Home 1 holder'];

// ---------- helpers ----------
function fakeStorage(opts = {}) {
  const map = new Map();
  return {
    map,
    getItem: (k) => { if (opts.throwOnGet) throw new Error('blocked'); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { if (opts.throwOnSet) throw new Error('quota'); if (opts.maxLength && v.length > opts.maxLength) throw new Error('quota'); map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** A finished game played by bots (or humans standing in as Easy), with the seats as the UI would describe them. */
function finishedGame(seed, seatTypes, rules = {}) {
  const ctl = createController({ seats: seatTypes.map((t) => ({ type: t === 'human' ? 'easy' : t, name: t === 'human' ? 'Mia' : '' })), seed, rules });
  ctl.runBots();
  const seats = seatTypes.map((t) => ({ type: t, name: t === 'human' ? 'Mia' : '' }));
  return { ctl, state: ctl.state, seats, seed };
}

// ---------- recorder and store ----------
{
  const storage = fakeStorage();
  const store = createStatsStore(() => storage);
  let clock = 1_000_000;
  const rec = createRecorder(store, () => clock);
  const g = finishedGame(5, ['human', 'easy', 'medium', 'hard']);
  rec.gameStart({});
  clock += 90_000;
  const r = rec.gameEnd({ state: g.state, seats: g.seats, seed: g.seed });
  check('recorder: a finished game is stored', store.load().games.length === 1 && r.players === 4 && r.hands === 4);
  check('recorder: seats record kind and level; only a human\'s typed name is kept', r.seats[0].type === 'human' && r.seats[0].name === 'Mia' && r.seats[1].type === 'bot' && r.seats[1].level === 'easy' && r.seats[3].level === 'hard' && !('name' in r.seats[1]));
  check('recorder: duration, rules code, seed, winners and totals are kept', r.seconds === 90 && r.rules_code === 'std' && r.seed === '5' && r.winners.length >= 1 && r.totals.length === 4 && r.margin >= 0);
  check('recorder: the record is plain JSON and equals what the store reads back', JSON.stringify(roundTrip(r)) === JSON.stringify(store.load().games[0]));
  check('recorder: one hand breakdown per hand', r.hand_log.length === 4 && r.hand_log.every((h) => h.climb_tricks.length === 4 && h.descent_tricks.length === 4 && h.scores.length === 4 && h.climb_values.length === 4 && h.kept_values.length === 4) && handRecord(g.state.handLog[0]).scores.length === 4);
  check('recorder: an unfinished game records nothing', rec.gameEnd({ state: createController({ seats: [{ type: 'human' }, { type: 'easy' }], seed: 1 }).state, seats: [], seed: 1 }) === null);
  const st = g.state;
  const hl = r.hand_log;
  const sumBy = (rows, i) => rows.reduce((a, row) => a + row[i], 0);
  check('record: rules_version 6 and rules_code std', r.rules_version === RULES_VERSION && RULES_VERSION === 6 && r.rules_code === 'std');
  check('record: hand scores add up to the totals and the engine result', r.totals.every((t, i) => t === sumBy(r.hand_scores, i) && t === st.result.totals[i] && t === st.totals[i]));
  check('record: ranking and last-hand scores come from the engine result', JSON.stringify(r.last_hand_scores) === JSON.stringify(st.result.lastHandScores) && r.ranking.every((x) => x.last_hand_score === st.result.lastHandScores[x.seat]));
  check('record: each hand has the Climb cards and Brumby cards taken (values), the -1 and Colt winners, row and hand total', hl.every((h, i) => {
    const e = st.handLog[i];
    return h.tricks_by_seat.every((t, s) => t === h.climb_tricks[s] + h.descent_tricks[s]) && h.climb_cards.length === 4 && h.climb_values.every((v, s) => v === e.climbValues[s])
      && h.climb_row_values.length === 6 && h.minus_position === e.minusPosition && h.minus_winner === e.minusWinner && h.kept.length === 4 && h.kept_values.every((v, s) => v === e.keptValues[s])
      && h.row.length === 6 && h.row_value === e.rowValue && h.colt === e.colt && h.colt_winner === e.coltWinner && h.home1_seat === e.home1Seat && h.tricks === 12 && h.scores.every((x, s) => x === e.scores[s]);
  }));
  check('record: a hand total is the Climb values plus the Brumby values taken; tricks score nothing', hl.every((h) => h.scores.every((x, s) => x === h.climb_values[s] + h.kept_values[s]) && h.climb_values.reduce((a, b) => a + b, 0) === 4));
  check('record: the game counts match the engine measures and the hand log', r.minus_by_seat.join() === st.measures.minusBySeat.join() && r.minus_by_seat.reduce((a, b) => a + b, 0) === hl.length && r.colt_by_seat.join() === st.measures.coltBySeat.join() && r.colt_rows === hl.filter((h) => h.colt).length && r.colt_rows === st.measures.coltRows && r.negative_hands === st.measures.negativeHands && r.negative_hands === hl.reduce((a, h) => a + h.scores.filter((x) => x < 0).length, 0) && r.brumby_value === hl.reduce((a, h) => a + h.kept_values.reduce((x, y) => x + y, 0), 0) && r.brumby_cards === hl.length * 6 && r.reshuffles === st.measures.reshuffles);
  check('record: tiebreak flag matches the engine', r.tiebreak_used === st.result.tiebreakUsed && r.tied_on_total === (st.result.tiedOnTotal.length > 1));
  check('record: no v4 or v5 fields leak into a v6 record', !('mobs_home' in r) && !('escapes' in r) && !('chases' in r) && !('nobody_chased' in r) && !('kept_value' in r) && hl.every((h) => !('end_reason' in h) && !('choices' in h) && !('chasers' in h) && !('costs' in h) && !('colt_kept' in h)));
  check('store: uses the slug in its key', STORE_KEY === `${GAME_SLUG}-stats-v1`);
}
{
  const storage = fakeStorage();
  const store = createStatsStore(() => storage);
  const g = finishedGame(6, ['easy', 'easy', 'easy']);
  const rec = createRecorder(store);
  for (let i = 0; i < 5; i++) rec.gameEnd({ state: g.state, seats: g.seats, seed: i });
  check('store: appends in order', store.load().games.length === 5);
  check('store: a corrupt value reads as empty', (() => { storage.map.set(STORE_KEY, '{nope'); return store.load().games.length === 0; })());
  check('store: another version reads as empty', (() => { storage.map.set(STORE_KEY, JSON.stringify({ v: 99, games: [1] })); return store.load().games.length === 0; })());
  check('store: junk records are dropped, good ones kept', (() => {
    const good = createRecorder(createStatsStore(() => fakeStorage())).gameEnd({ state: g.state, seats: g.seats, seed: 1 });
    storage.map.set(STORE_KEY, JSON.stringify({ v: 1, games: [null, 5, { seats: 1 }, good] }));
    return store.load().games.length === 1;
  })());
  check('store: clear empties it', store.clear() && store.load().games.length === 0);
  check('store: the cap keeps the newest', MAX_GAMES >= 1000);
}
{
  const g = finishedGame(7, ['easy', 'easy', 'easy']);
  const blocked = createStatsStore(() => { throw new Error('storage blocked'); });
  const none = createStatsStore(() => null);
  const quota = createStatsStore(() => fakeStorage({ throwOnSet: true }));
  const rec = (s) => createRecorder(s).gameEnd({ state: g.state, seats: g.seats, seed: 1 });
  check('store: blocked, absent and full storage never throw; the store just forgets', rec(blocked) !== undefined && rec(none) !== undefined && rec(quota) !== undefined && blocked.load().games.length === 0 && none.load().games.length === 0 && blocked.clear() === false);
  check('store: a store that keeps only small values retries smaller and gives up quietly', createStatsStore(() => fakeStorage({ maxLength: 10 })).addGame({ big: 'x'.repeat(100) }) === false);
}

// ---------- export ----------
{
  const g1 = finishedGame(8, ['human', 'easy', 'easy', 'easy']);
  const g2 = finishedGame(9, ['easy', 'medium', 'hard']);
  const rec = createRecorder(createStatsStore(() => fakeStorage()));
  const r1 = rec.gameEnd({ state: g1.state, seats: g1.seats, seed: 8 });
  const r2 = rec.gameEnd({ state: g2.state, seats: g2.seats, seed: 9 });
  const csv = toCsv([r1, r2]);
  const lines = csv.trim().split('\n');
  check('csv: a header and a row per game, LF only, same number of fields as columns', lines.length === 3 && !csv.includes('\r') && csv.endsWith('\n') && lines[0].split(',').length === CSV_COLUMNS.length && gameToRow(r1).length === CSV_COLUMNS.length);
  check('csv: one rule column per VARIANTS row (none) and one pair per seat; the game columns', VARIANTS.length === 0 && !CSV_COLUMNS.some((c) => c.startsWith('rule_')) && CSV_COLUMNS.includes('seat5_type') && ['rules_version', 'tricks', 'minus_by_seat', 'colt_by_seat', 'colt_rows', 'negative_hands', 'brumby_cards', 'brumby_value', 'hand_row_values'].every((c) => CSV_COLUMNS.includes(c)) && !CSV_COLUMNS.includes('mobs_home') && !CSV_COLUMNS.includes('chases'));
  const row1 = gameToRow(r1); const col = (c) => row1[CSV_COLUMNS.indexOf(c)];
  check('csv: the game cells carry the record values', col('rules_version') === 6 && col('minus_by_seat') === r1.minus_by_seat.join(' ') && col('colt_by_seat') === r1.colt_by_seat.join(' ') && col('colt_rows') === r1.colt_rows && col('negative_hands') === r1.negative_hands && col('brumby_cards') === r1.brumby_cards && col('brumby_value') === r1.brumby_value && col('hand_row_values') === r1.hand_log.map((h) => h.row_value).join(' '));
  check('csv: rows carry the rules code and the seat kinds', lines[1].includes(',std,') && lines[2].includes(',std,') && lines[2].includes(',easy,') && lines[2].includes(',hard,'));
  check('csv: cells with commas and quotes are quoted', csvCell('a,b') === '"a,b"' && csvCell('say "hi"') === '"say ""hi"""' && csvCell(null) === '' && csvCell(3) === '3');
  const json = JSON.parse(toJson({ v: 1, games: [r1] }));
  check('json: names the game and holds the records', json.game === GAME_SLUG && json.games.length === 1 && typeof json.exported === 'string');
  check('export: file names are the slug, the word stats and a local date', new RegExp(`^${GAME_SLUG}-stats-\\d{4}-\\d{2}-\\d{2}\\.csv$`).test(exportFilename('csv')) && exportFilename('json', new Date(2026, 10, 4)) === `${GAME_SLUG}-stats-2026-11-04.json`);
  check('export: file names are kebab-case with no spaces', !/[\sA-Z]/.test(exportFilename('csv')));

  // ---------- summary ----------
  const sum = summarise([r1, r2]);
  check('summary: counts games, seat kinds and wins', sum.total === 2 && sum.byKind.human.seats === 1 && sum.byKind.easy.seats === 4 && sum.byKind.hard.seats === 1);
  check('summary: wins by kind never exceed seats', Object.values(sum.byKind).every((t) => t.wins <= t.seats));
  check('summary: human v bot matchups only count games with both', sum.humanVs.easy.games === 1 && sum.humanVs.hard.games === 0);
  check('summary: split by rules code: everything is the current rules', sum.byRules.map((r) => r.code).join() === 'std' && summarise([r1, r2], 'std').total === 2);
  check('summary: by player count', sum.byPlayers[4].games === 1 && sum.byPlayers[3].games === 1);
  const ex = sum.extra;
  const allHands = [r1, r2].flatMap((x) => x.hand_log);
  check('summary: extra counts hands, seat-hands, Brumby cards and value, hands below zero, the -1 and the Colt', ex.hands === allHands.length && ex.seatHands === r1.hands * 4 + r2.hands * 3 && ex.brumbyCards === r1.brumby_cards + r2.brumby_cards && ex.brumbyValue === r1.brumby_value + r2.brumby_value && ex.negHands === r1.negative_hands + r2.negative_hands && ex.minusTaken === allHands.length && ex.coltRows === r1.colt_rows + r2.colt_rows && Object.values(ex.coltByKind).reduce((a, b) => a + b, 0) === ex.coltRows && Object.values(ex.minusByKind).reduce((a, b) => a + b, 0) === ex.minusTaken && Math.abs(ex.scoreSum - sum.avgScorePerHand * ex.seatHands) < 1e-6);
  check('summary: the human numbers come from the human seat only', ex.humanHands === r1.hand_log.length && ex.humanScoreSum === r1.hand_scores.reduce((a, h) => a + h[0], 0) && ex.humanMinus === r1.hand_log.filter((h) => h.minus_winner === 0).length && ex.humanColt === r1.hand_log.filter((h) => h.colt && h.colt_winner === 0).length && ex.humanBrumby === r1.hand_log.reduce((a, h) => a + h.kept[0].length, 0));
  check('summary: seat kind helper', seatKind({ type: 'human' }) === 'human' && seatKind({ type: 'bot', level: 'hard' }) === 'hard');
  const html = statsHtml({ games: [r1, r2] }, 'all');
  const h3 = [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]);
  check('stats screen: the sections', ['Win rate by seat type', 'Win rate by seat position', 'Scores by player count', 'The Climb row and the Brumby row', 'Ties and the tiebreak', 'By rules'].every((s) => h3.includes(s)) && !h3.includes('Chase, Watch and the Brumby row'), h3.join(' | '));
  check('stats screen: current rules, small-sample warnings, the v6 measures, no raw values', /Current rules \(v6\)/.test(html) && /small sample/.test(html) && V6_ROWS.every((m) => html.includes(`<th scope="row">${m}</th>`)) && !/Chase rate|chaser/i.test(html) && !BAD.test(html));
  check('stats screen: the tiebreak is the last hand; no mob, no variants talk', /most points in the last hand/.test(html) && !/mob/i.test(html) && !/variant/i.test(html));
  check('stats screen: no human seat gives dashes, not NaN', !BAD.test(statsHtml({ games: [r2] })) && /Average hand score of a human seat<\/th><td>0 hands<\/td><td>-/.test(statsHtml({ games: [r2] })));
  check('stats screen: empty state and an unknown filter fall back to the current rules', /No games recorded yet/.test(statsHtml({ games: [] })) && /2<\/b> games played/.test(statsHtml({ games: [r1, r2] }, 'nope')));
  check('stats screen: export buttons disabled with no data', /disabled/.test(statsButtonsHtml(false)) && !/disabled/.test(statsButtonsHtml(true)));
}

// ---------- v4 and v5 records are relabelled, never mixed with v6 ----------
{
  const g = finishedGame(11, ['easy', 'easy', 'easy']);
  const v6 = createRecorder(createStatsStore(() => fakeStorage())).gameEnd({ state: g.state, seats: g.seats, seed: 11 });
  const v5 = {
    v: 1, id: 'gold-5', date: '2026-11-11T10:00:00.000Z', players: 3, seed: '5', rules: {}, rules_version: 5, rules_code: 'std',
    seats: [{ seat: 0, type: 'human', level: null }, { seat: 1, type: 'bot', level: 'easy' }, { seat: 2, type: 'bot', level: 'hard' }],
    hand_scores: [[5, 2, 1], [3, 3, 4], [6, 1, 2]], totals: [14, 6, 7], last_hand_scores: [6, 1, 2], ranking: [{ seat: 0, total: 14, last_hand_score: 6, rank: 1 }],
    winners: [0], shared: false, tiebreak_used: false, tied_on_total: false, winning_score: 14, margin: 7, hands: 3, tricks: 36,
    nobody_chased: 1, chases: 3, chases_by_seat: [2, 1, 0], chaser_counts: [1, 1, 1, 0, 0], kept_value: 6, colt_rows: 1, colt_kept: 1, seconds: 400,
    hand_log: [{ choices: 'CWW', chasers: 1, kept: [['b1'], [], []], kept_values: [2, 0, 0], costs: [2, 0, 0], scores: [5, 2, 1], colt: false, colt_kept: false, colt_winner: null },
      { choices: 'CCW', chasers: 2, kept: [['b2'], ['b3'], []], kept_values: [1, 1, 0], costs: [2, 2, 0], scores: [3, 3, 4], colt: true, colt_kept: true, colt_winner: 0, top_home_seat: 0 },
      { choices: 'WWW', chasers: 0, kept: [[], [], []], kept_values: [0, 0, 0], costs: [0, 0, 0], scores: [6, 1, 2], colt: false, colt_kept: false, colt_winner: null }],
  };
  const v4 = {
    v: 1, id: 'gold-4', date: '2026-11-09T10:00:00.000Z', players: 3, seed: '4', rules: {}, rules_code: 'std',
    seats: [{ seat: 0, type: 'human', level: null }, { seat: 1, type: 'bot', level: 'easy' }, { seat: 2, type: 'bot', level: 'hard' }],
    hand_scores: [[3, 2, -1], [1, 4, 0], [2, 2, 5]], totals: [6, 8, 4], ranking: [{ seat: 1, total: 8, mobs_home: 1, rank: 1 }],
    winners: [1], shared: false, tiebreak_used: false, tied_on_total: false, winning_score: 8, margin: 2, hands: 3, tricks: 36,
    mobs_home: 1, nobody_chased: 1, mobs_home_by_seat: [0, 1, 0], escapes: 2, chases: 2, falls: 1, chases_by_seat: [1, 1, 0], falls_by_seat: [1, 0, 0], seconds: 300,
    hand_log: [{ end_reason: 'descent', outcome: 'home', choices: 'CWW', chasers: 1, outcomes: ['home', 'x', 'x'], mob_value: 3, scores: [3, 2, -1] },
      { end_reason: 'descent', outcome: 'escaped-watcher', choices: 'CCW', chasers: 2, outcomes: ['fell', 'fell', 'x'], mob_value: 5, scores: [1, 4, 0] },
      { end_reason: 'nobody-chases', outcome: 'nobody-chased', choices: 'WWW', chasers: 0, outcomes: ['x', 'x', 'x'], mob_value: 3, scores: [2, 2, 5] }],
  };
  const m4 = migrate(v4);
  const m5 = migrate(v5);
  check('migrate: a record with no rules_version is relabelled v4 (rules_version 4, rules_code "v4")', m4.rules_version === 4 && m4.rules_code === V4_CODE && V4_CODE === 'v4');
  check('migrate: a v5 record (rules_version 5, code std) is relabelled v5, its version kept', m5.rules_version === 5 && m5.rules_code === V5_CODE && V5_CODE === 'v5');
  check('migrate: the old records are not mutated and keep all their fields', v4.rules_code === 'std' && v4.rules_version === undefined && m4.mobs_home === 1 && m4.hand_log.length === 3 && m4.totals === v4.totals && v5.rules_code === 'std' && m5.chases === 3 && m5.kept_value === 6 && m5.totals === v5.totals);
  check('migrate: a v6 record is returned as it is; migrating twice changes nothing', migrate(v6) === v6 && migrate(m4) === m4 && migrate(m5) === m5 && JSON.stringify(migrate(migrate(v5))) === JSON.stringify(m5) && JSON.stringify(migrate(migrate(v4))) === JSON.stringify(m4));
  check('migrate: junk passes through without throwing', migrate(null) === null && migrate(5) === 5);
  const storage = fakeStorage();
  storage.map.set(STORE_KEY, JSON.stringify({ v: 1, games: [v4, v5] }));
  const store = createStatsStore(() => storage);
  const loaded = store.load().games;
  check('store: loading relabels planted v4 and v5 records', loaded[0].rules_code === 'v4' && loaded[0].rules_version === 4 && loaded[1].rules_code === 'v5' && loaded[1].rules_version === 5);
  store.addGame(v6);
  const all = store.load().games;
  check('store: v4, v5 and v6 records sit together, each with its own code', all.length === 3 && all.map((x) => x.rules_code).join() === 'v4,v5,std' && JSON.parse(storage.map.get(STORE_KEY)).games.map((x) => x.rules_code).join() === 'v4,v5,std');
  const sAll = summarise(all);
  check('summary: codes list std, v5 and v4 apart; v6 measures never count the old games', sAll.byRules.map((r) => r.code).join() === 'std,v5,v4' && sAll.allTotal === 3 && sAll.extra.hands === v6.hands && sAll.extra5.hands === 3 && sAll.extra4.hands === 3);
  const s6 = summarise(all, 'std');
  check('summary: the std filter holds only the v6 game', s6.total === 1 && s6.extra.hands === v6.hands && s6.extra5.hands === 0 && s6.extra4.hands === 0);
  const s5 = summarise(all, 'v5');
  check('summary: the v5 filter holds only the v5 game and its Chase counts', s5.total === 1 && s5.extra5.hands === 3 && s5.extra5.chases === 3 && s5.extra5.seatHands === 9 && s5.extra5.nobodyChased === 1 && s5.extra5.coltRows === 1 && s5.extra5.coltKept === 1 && s5.extra.hands === 0 && s5.extra4.hands === 0);
  const s4 = summarise(all, 'v4');
  check('summary: the v4 filter holds only the v4 game and its mob counts', s4.total === 1 && s4.extra4.mobsHome === 1 && s4.extra4.escapes === 2 && s4.extra4.nobodyChased === 1 && s4.extra4.chases === 3 && s4.extra4.falls === 2 && s4.extra.hands === 0 && s4.extra5.hands === 0);
  check('view: the default is the current rules (v6), even though v4 and v5 are in the store', effectiveFilter(sAll.codes, 'all') === 'std' && effectiveFilter(sAll.codes, 'v4') === 'v4' && effectiveFilter(sAll.codes, 'v5') === 'v5' && effectiveFilter([{ code: 'v4' }], 'all') === 'v4');
  const h6 = statsHtml({ games: all }, 'all');
  const h5 = statsHtml({ games: all }, 'v5');
  const h4 = statsHtml({ games: all }, 'v4');
  check('view: v6 screen shows the Climb row section and offers all three rule sets', /The Climb row and the Brumby row/.test(h6) && !/The mob and the summit/.test(h6) && !/Chase, Watch/.test(h6) && /Old rules \(v5/.test(h6) && /<option value="v5"/.test(h6) && /<option value="v4"/.test(h6) && /1<\/b> game played under Current rules \(v6\)/.test(h6));
  check('view: v5 screen shows the Chase section, no v6 section, no NaN', /Chase, Watch and the Brumby row/.test(h5) && /Chase rate/.test(h5) && !/The Climb row and the Brumby row/.test(h5) && !/The mob/.test(h5) && !BAD.test(h5) && /1<\/b> game played under Old rules \(v5/.test(h5));
  check('view: v4 screen shows the old mob section and its tiebreak, no NaN', /The mob and the summit/.test(h4) && /Mob brought home/.test(h4) && /most mobs brought home/.test(h4) && !/Chase, Watch/.test(h4) && !BAD.test(h4) && /1<\/b> game played under Old rules \(v4/.test(h4));
  const csv = toCsv(all).trim().split('\n');
  check('csv: all three records are exported, with their rules codes and versions', csv.length === 4 && csv[1].includes(',v4,4,') && csv[2].includes(',v5,5,') && csv[3].includes(',std,6,'));
  check('json: the export holds all three records with rules_version', JSON.parse(toJson({ v: 1, games: all })).games.map((x) => x.rules_version).join() === '4,5,6');
}

// ---------- analytics ----------
{
  const calls = [];
  globalThis.window = { gtag: (...a) => calls.push(a), addEventListener() {} };
  let now = 0;
  analytics._setClock(() => now);
  analytics._reset();
  const g = finishedGame(10, ['human', 'easy', 'medium', 'hard']);
  const seats = [{ type: 'human', name: 'Secret Name' }, { type: 'easy', name: '' }, { type: 'medium', name: '' }, { type: 'hard', name: '' }];
  const base = { seed: 10, players: 4, seats, rulesCode: 'std', state: g.state };
  analytics.trackGameStart(base);
  analytics.trackTrickEnd();
  analytics.trackHandEnd({ ...base, event: { handNo: 0 }, record: g.state.handLog[0] });
  const hrec = g.state.handLog[0];
  now = 125_400;
  analytics.trackGameEnd({ ...base, result: g.state.result });
  analytics.trackGameEnd({ ...base, result: g.state.result }); // once only
  analytics.trackGameAbandoned(); // already ended: nothing
  const names = calls.map((c) => c[1]);
  check('analytics: game_start, hand_end and game_end fired once each; nothing after the end', same(names, ['game_start', 'hand_end', 'game_end']));
  const ge = calls[2][2];
  check('analytics: game_end carries counts, seat kinds and the result summary', ge.game_name === GAME_SLUG && ge.player_count === 4 && ge.human_players === 1 && ge.bot_players === 3 && ge.bot_levels === 'easy,hard,medium' && ge.duration_seconds === 125 && ge.hands === 4 && typeof ge.winner_seat_type === 'string' && /^(yes|no)$/.test(ge.tiebreak_used));
  const he = calls[1][2];
  const m = g.state.measures;
  check('analytics: hand_end says the outcome through colt_in_row (0 or 1) and row_value', he.hand_number === 1 && he.colt_in_row === (hrec.colt ? 1 : 0) && he.row_value === hrec.rowValue && !('nobody_chased' in he) && !('chasers' in he) && !('kept_value' in he) && Object.keys(he).every((k) => analytics.ALLOWED_PARAMS.includes(k)));
  check('analytics: game_end carries the per-game counts and they match the engine', ge.colt_in_row === m.coltRows && ge.negative_hands === m.negativeHands && ge.tricks === m.tricks && !('nobody_chased' in ge) && !('chasers' in ge) && !('kept_value' in ge) && !('mobs_home' in ge) && !('escapes' in ge));
  check('analytics: the whitelist is the v5 list minus nobody_chased, chasers and kept_value plus colt_in_row and negative_hands; no variant event; game name', same(analytics.ALLOWED_PARAMS.slice().sort(), ['game_name', 'player_count', 'human_players', 'bot_players', 'bot_levels', 'rules_code', 'hand_number', 'hands', 'tricks', 'duration_seconds', 'winner_seat_type', 'winning_score', 'winning_margin', 'tiebreak_used', 'human_rank', 'row_value', 'colt_in_row', 'negative_hands'].sort()) && analytics.ALLOWED_PARAMS.length === 18 && !analytics.EVENT_NAMES.includes('variant_changed') && analytics.EVENT_NAMES.length === 7 && analytics.trackVariantChanged === undefined && analytics.GAME_NAME === 'snowy-river');
  check('analytics: clean() drops the retired v4 and v5 params and any extra key', same(Object.keys(analytics.clean({ mobs_home: 1, escapes: 1, seed: 's', name: 'x', chasers: 2, nobody_chased: 1, kept_value: 5, row_value: 7, colt_in_row: 1, negative_hands: 2 })).sort(), ['colt_in_row', 'negative_hands', 'row_value']));
  check('analytics: every parameter is on the whitelist and is a number or a short token', calls.every((c) => Object.entries(c[2]).every(([k, v]) => analytics.ALLOWED_PARAMS.includes(k) && (typeof v === 'number' || /^[A-Za-z0-9_,.+-]{1,60}$/.test(v)))));
  check('analytics: no name, seed or sentence is ever sent', !JSON.stringify(calls).includes('Secret') && !JSON.stringify(calls).includes('"seed"'));
  check('analytics: clean() drops unknown keys, long strings, spaces, objects and non-finite numbers', JSON.stringify(analytics.clean({ player_name: 'x', rules_code: 'a b', game_name: 'x'.repeat(61), hands: NaN, tricks: {}, winning_score: 7, bot_levels: 'easy,hard' })) === '{"bot_levels":"easy,hard","winning_score":7}');
  check('analytics: event names are known', calls.every((c) => analytics.EVENT_NAMES.includes(c[1])));

  calls.length = 0;
  analytics._reset();
  analytics.trackGameStart(base);
  analytics.trackTrickEnd(); analytics.trackTrickEnd();
  now += 40_000;
  analytics.trackGameAbandoned({ beacon: true });
  analytics.trackGameAbandoned();
  const ab = calls.filter((c) => c[1] === 'game_abandoned');
  check('analytics: a game left half way is reported once, with progress and no result', ab.length === 1 && ab[0][2].tricks === 2 && ab[0][2].transport_type === 'beacon' && !('winning_score' in ab[0][2]));
  calls.length = 0;
  analytics.trackStatsViewed(); analytics.trackStatsExported(); analytics.trackRulesOpened();
  check('analytics: the small events carry the game name only', calls.length === 3 && calls.every((c) => same(Object.keys(c[2]), ['game_name']) && c[2].game_name === 'snowy-river'));
  globalThis.window = {}; // no gtag at all
  check('analytics: with no gtag every call is a silent no-op', (() => { try { analytics.trackGameStart(base); analytics.trackGameEnd({ ...base, result: g.state.result }); analytics.trackStatsViewed(); return true; } catch { return false; } })());
  delete globalThis.window;
  check('analytics: with no window at all it still does not throw', (() => { try { analytics.trackStatsViewed(); analytics.installAbandonTracking(); return true; } catch { return false; } })());
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---------- bug report ----------
{
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }], seed: 77 });
  ctl.runBots();
  const before = JSON.stringify(ctl.state);
  bug._resetLogs();
  bug.logAction({ kind: 'play', card: 'red-1' });
  bug.logEvent('error', 'x'.repeat(5000));
  const rep = bug.buildReport({ ctl, screen: 'game' }, { title: 'T', happened: 'H', expected: 'E' });
  check('bug report: never mutates the live state', JSON.stringify(ctl.state) === before);
  check('bug report: has the state, controller, diagnostics, logs and the player\'s words', rep.schemaVersion === 1 && rep.game.kind === 'game' && rep.game.n === 3 && rep.controller.seed === 77 && Array.isArray(rep.diagnostics.cards) && rep.player.title === 'T' && rep.actionLog.length === 1);
  check('bug report: is JSON-safe and long strings are clipped', JSON.stringify(roundTrip(rep)) === JSON.stringify(rep) && rep.eventLog[0].message.length === 2000);
  const sn = rep.diagnostics.snowy;
  check('bug report: diagnostics hold the half, direction, trumps, Climb row, taken cards, Brumby row and deck counts', typeof sn.phase === 'string' && /^(highest|lowest)$/.test(sn.direction) && /^(escape|home)$/.test(sn.trump) && Array.isArray(sn.climbRow) && Array.isArray(sn.climbRowDealt) && Array.isArray(sn.climbCards) && sn.climbCards.length === 3 && Array.isArray(sn.row) && Array.isArray(sn.kept) && typeof sn.brumbyDeckCount === 'number' && typeof sn.brumbyDiscardCount === 'number' && Array.isArray(sn.climbTricks) && !('marker' in sn) && !('handsTurned' in sn) && !('chosen' in sn) && !('choiceOrder' in sn) && !('summitStep' in sn) && !('mob' in sn));
  const hum = () => createController({ seats: [{ type: 'human' }, { type: 'human' }, { type: 'human' }], seed: 5 });
  const live = hum();
  const lv = bug.buildReport({ ctl: live, screen: 'game' }).diagnostics;
  check('bug report: a live card hand gives a block reason per card in the human hand (null for legal cards)', lv.snowy.phase === 'climb' && lv.snowy.direction === 'highest' && lv.snowy.trump === 'escape' && lv.snowy.climbRow.length === 6 && lv.snowy.climbRowDealt.length === 6 && lv.cards.length === live.state.hands[lv.seat].length && lv.cards.every((c) => c.blockReason === null || typeof c.blockReason === 'string'));
  const sc = hum();
  for (let i = 0; i < 300 && sc.state.phase === 'climb'; i++) sc.play(sc.legalActions()[0]);
  const sd = bug.buildReport({ ctl: sc, screen: 'game' }).diagnostics;
  check('bug report: past the summit the half, direction, trumps, Brumby row and taken cards are in the report', sc.state.phase === 'descent' && sd.snowy.half === 'descent' && sd.snowy.direction === 'lowest' && sd.snowy.trump === 'home' && sd.snowy.row.length === 6 && sd.snowy.climbCards.reduce((a, c) => a + c.length, 0) === 6 && sd.snowy.climbRow.every((c) => c === null) && sd.cards.length > 0 && sd.cards.every((c) => c.blockReason === null || typeof c.blockReason === 'string'));
  check('bug report: the id starts with the slug', rep.id.startsWith(`${GAME_SLUG}-`));
  check('bug report: a section that fails becomes an error object, not a lost report', typeof rep.environment.error === 'string');
  const none = bug.buildReport({ ctl: null });
  check('bug report: works on the landing page (no game)', none.game === null && none.controller === null && none.diagnostics === null);
  check('bug report: the contact address is the public one', bug.BUG_REPORT_EMAIL === CONTACT_EMAIL && CONTACT_EMAIL === 'info@wombatgamefactory.com');
  const store = fakeStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true });
  for (let i = 0; i < bug.ARCHIVE_MAX + 5; i++) bug.archiveReport({ ...rep, id: `r${i}` });
  check('bug report: the archive keeps the newest few', bug.loadArchive().length === bug.ARCHIVE_MAX && bug.loadArchive().at(-1).id === `r${bug.ARCHIVE_MAX + 4}`);
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
  check('bug report: blocked storage gives an empty archive and a false save, not an error', bug.loadArchive().length === 0 && bug.archiveReport(rep) === false);
  delete globalThis.localStorage;
}

done();
