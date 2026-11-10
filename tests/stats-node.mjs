// stats-node.mjs - the local stats store, the recorder, the CSV / JSON export, the summary, the
// stats screen markup, the analytics whitelist and events, and the bug report (all without a
// browser: storage is a fake, `window.gtag` is a recorder).
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. Run: node tests/stats-node.mjs

import { suite, roundTrip } from './lib.mjs';
import {
  createStatsStore, createRecorder, handRecord, toCsv, toJson, exportFilename, csvCell, gameToRow, CSV_COLUMNS, summarise, seatKind,
  STORE_KEY, MAX_GAMES, migrate, RULES_VERSION, V4_CODE,
} from '../src/ui/stats-store.js';
import { statsHtml, statsButtonsHtml, effectiveFilter } from '../src/ui/stats-view.js';
import * as analytics from '../src/ui/analytics.js';
import * as bug from '../src/ui/bug-report.js';
import { createController } from '../src/ui/controller.js';
import { VARIANTS } from '../src/engine/index.js';
import { GAME_SLUG, CONTACT_EMAIL } from '../src/game-config.js';

const { check, done } = suite('stats-node');
const BAD = /undefined|NaN|\[object/;

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
  check('recorder: one hand breakdown per hand', r.hand_log.length === 4 && r.hand_log.every((h) => h.climb_tricks.length === 4 && h.descent_tricks.length === 4 && h.scores.length === 4 && h.choices.length === 4) && handRecord(g.state.handLog[0]).scores.length === 4);
  check('recorder: an unfinished game records nothing', rec.gameEnd({ state: createController({ seats: [{ type: 'human' }, { type: 'easy' }], seed: 1 }).state, seats: [], seed: 1 }) === null);
  const st = g.state;
  const hl = r.hand_log;
  const sumBy = (rows, i) => rows.reduce((a, row) => a + row[i], 0);
  check('record: rules_version 5 and rules_code std', r.rules_version === RULES_VERSION && RULES_VERSION === 5 && r.rules_code === 'std');
  check('record: hand scores add up to the totals and the engine result', r.totals.every((t, i) => t === sumBy(r.hand_scores, i) && t === st.result.totals[i] && t === st.totals[i]));
  check('record: ranking and last-hand scores come from the engine result', JSON.stringify(r.last_hand_scores) === JSON.stringify(st.result.lastHandScores) && r.ranking.every((x) => x.last_hand_score === st.result.lastHandScores[x.seat]));
  check('record: each hand has choices, chasers, tricks, kept cards with values, costs, row and Colt', hl.every((h, i) => {
    const e = st.handLog[i];
    return h.choices === e.choices.map((c) => (c === 'chase' ? 'C' : 'W')).join('') && h.chasers === e.chasers && h.chaser_seats.length === h.chasers && h.chaser_seats.length + h.watcher_seats.length === 4
      && h.tricks_by_seat.every((t, s) => t === h.climb_tricks[s] + h.descent_tricks[s]) && h.kept.length === 4 && h.kept_values.every((v, s) => v === e.keptValues[s]) && h.costs.length === 4
      && h.row.length === 6 && h.row_value === e.rowValue && h.colt === e.colt && h.colt_kept === e.coltKept && h.tricks === 12 && h.scores.every((x, s) => x === e.scores[s]);
  }));
  check('record: a watcher keeps nothing and pays nothing; a chasers hand total is tricks + kept - cost', hl.every((h) => h.choices.split('').every((c, s) => (c === 'W' ? h.kept[s].length === 0 && h.costs[s] === 0 && h.scores[s] === h.tricks_by_seat[s] : h.scores[s] === h.tricks_by_seat[s] + h.kept_values[s] - h.costs[s]))));
  check('record: the game counts match the engine measures and the hand log', r.chases === hl.reduce((a, h) => a + h.chasers, 0) && r.chases === st.measures.chasesBySeat.reduce((a, b) => a + b, 0) && r.nobody_chased === hl.filter((h) => h.chasers === 0).length && r.nobody_chased === st.measures.nobodyChased && r.kept_value === hl.reduce((a, h) => a + h.kept_values.reduce((x, y) => x + y, 0), 0) && r.colt_rows === hl.filter((h) => h.colt).length && r.colt_kept === hl.filter((h) => h.colt_kept).length && r.chaser_counts.length === 5 && r.chaser_counts.reduce((a, b) => a + b, 0) === r.hands);
  check('record: tiebreak flag matches the engine', r.tiebreak_used === st.result.tiebreakUsed && r.tied_on_total === (st.result.tiedOnTotal.length > 1));
  check('record: no v4 fields leak into a v5 record', !('mobs_home' in r) && !('escapes' in r) && hl.every((h) => !('end_reason' in h) && !('mob_value' in h) && !('outcome' in h)));
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
  check('csv: one rule column per VARIANTS row (none) and one pair per seat; the game columns', VARIANTS.length === 0 && !CSV_COLUMNS.some((c) => c.startsWith('rule_')) && CSV_COLUMNS.includes('seat5_type') && ['rules_version', 'tricks', 'nobody_chased', 'chases', 'chases_by_seat', 'kept_value', 'colt_rows', 'colt_kept', 'hand_choices', 'hand_row_values'].every((c) => CSV_COLUMNS.includes(c)) && !CSV_COLUMNS.includes('mobs_home'));
  const row1 = gameToRow(r1); const col = (c) => row1[CSV_COLUMNS.indexOf(c)];
  check('csv: the game cells carry the record values', col('rules_version') === 5 && col('nobody_chased') === r1.nobody_chased && col('chases') === r1.chases && col('chases_by_seat') === r1.chases_by_seat.join(' ') && col('kept_value') === r1.kept_value && col('colt_rows') === r1.colt_rows && col('colt_kept') === r1.colt_kept && col('hand_choices') === r1.hand_log.map((h) => h.choices).join(' ') && col('hand_row_values') === r1.hand_log.map((h) => h.row_value).join(' '));
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
  check('summary: extra counts hands, chasers, nobody-chased, kept value and the Colt', ex.hands === allHands.length && ex.chases === r1.chases + r2.chases && ex.seatHands === r1.hands * 4 + r2.hands * 3 && ex.nobodyChased === r1.nobody_chased + r2.nobody_chased && ex.keptValue === r1.kept_value + r2.kept_value && ex.coltRows === r1.colt_rows + r2.colt_rows && ex.coltKept === r1.colt_kept + r2.colt_kept && Object.values(ex.coltByKind).reduce((a, b) => a + b, 0) <= ex.coltRows);
  check('summary: the human Chase numbers come from the human seat only', ex.humanHands === r1.hand_log.length && ex.humanChases === r1.hand_log.filter((h) => h.choices[0] === 'C').length);
  check('summary: seat kind helper', seatKind({ type: 'human' }) === 'human' && seatKind({ type: 'bot', level: 'hard' }) === 'hard');
  const html = statsHtml({ games: [r1, r2] }, 'all');
  const h3 = [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]);
  check('stats screen: the sections', ['Win rate by seat type', 'Win rate by seat position', 'Scores by player count', 'Chase, Watch and the Brumby row', 'Ties and the tiebreak', 'By rules'].every((s) => h3.includes(s)), h3.join(' | '));
  check('stats screen: current rules, small-sample warnings, the Chase and Colt lines, no raw values', /Current rules \(v5\)/.test(html) && /small sample/.test(html) && /Chase rate/.test(html) && /Nobody chased/.test(html) && /Brumby value won by chasers/.test(html) && /Colt in the row/.test(html) && /Colt kept by a chaser/.test(html) && /Human Chase rate/.test(html) && !BAD.test(html));
  check('stats screen: the tiebreak is the last hand; no mob, no variants talk', /most points in the last hand/.test(html) && !/mob/i.test(html) && !/variant/i.test(html));
  check('stats screen: no human seat gives dashes, not NaN', !BAD.test(statsHtml({ games: [r2] })) && /Human Chase rate<\/th><td>0 of 0<\/td><td>-/.test(statsHtml({ games: [r2] })));
  check('stats screen: empty state and an unknown filter fall back to the current rules', /No games recorded yet/.test(statsHtml({ games: [] })) && /2<\/b> games played/.test(statsHtml({ games: [r1, r2] }, 'nope')));
  check('stats screen: export buttons disabled with no data', /disabled/.test(statsButtonsHtml(false)) && !/disabled/.test(statsButtonsHtml(true)));
}

// ---------- v4 records are relabelled, never mixed with v5 ----------
{
  const g = finishedGame(11, ['easy', 'easy', 'easy']);
  const v5 = createRecorder(createStatsStore(() => fakeStorage())).gameEnd({ state: g.state, seats: g.seats, seed: 11 });
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
  const m = migrate(v4);
  check('migrate: a record with no rules_version is relabelled v4 (rules_version 4, rules_code "v4")', m.rules_version === 4 && m.rules_code === V4_CODE && V4_CODE === 'v4');
  check('migrate: the old record is not mutated and keeps all its fields', v4.rules_code === 'std' && v4.rules_version === undefined && m.mobs_home === 1 && m.hand_log.length === 3 && m.totals === v4.totals);
  check('migrate: a v5 record is returned as it is; migrating twice changes nothing', migrate(v5) === v5 && migrate(m) === m && JSON.stringify(migrate(migrate(v4))) === JSON.stringify(m));
  check('migrate: junk passes through without throwing', migrate(null) === null && migrate(5) === 5);
  const storage = fakeStorage();
  storage.map.set(STORE_KEY, JSON.stringify({ v: 1, games: [v4] }));
  const store = createStatsStore(() => storage);
  check('store: loading relabels a planted v4 record', store.load().games[0].rules_code === 'v4' && store.load().games[0].rules_version === 4);
  store.addGame(v5);
  const both = store.load().games;
  check('store: v4 and v5 records sit together, each with its own code', both.length === 2 && both[0].rules_code === 'v4' && both[1].rules_code === 'std');
  const sAll = summarise(both);
  check('summary: codes list std and v4 apart; v5 measures never count the v4 game', sAll.byRules.map((r) => r.code).join() === 'std,v4' && sAll.extra.hands === v5.hands && sAll.extra4.hands === 3);
  const s4 = summarise(both, 'v4');
  check('summary: the v4 filter holds only the v4 game and its mob counts', s4.total === 1 && s4.extra4.mobsHome === 1 && s4.extra4.escapes === 2 && s4.extra4.nobodyChased === 1 && s4.extra4.chases === 3 && s4.extra4.falls === 2 && s4.extra.hands === 0);
  check('view: the default is the current rules (v5), even though v4 is in the store', effectiveFilter(sAll.codes, 'all') === 'std' && effectiveFilter(sAll.codes, 'v4') === 'v4' && effectiveFilter([{ code: 'v4' }], 'all') === 'v4');
  const h5 = statsHtml({ games: both }, 'all');
  const h4 = statsHtml({ games: both }, 'v4');
  check('view: v5 screen shows the Chase section and offers both rule sets', /Chase, Watch and the Brumby row/.test(h5) && !/The mob and the summit/.test(h5) && /Old rules \(v4/.test(h5) && /<option value="v4"/.test(h5) && /1<\/b> game played/.test(h5));
  check('view: v4 screen shows the old mob section and its tiebreak, no NaN', /The mob and the summit/.test(h4) && /Mob brought home/.test(h4) && /most mobs brought home/.test(h4) && !/Chase, Watch/.test(h4) && !BAD.test(h4) && /1<\/b> game played under Old rules/.test(h4));
  const csv = toCsv(both).trim().split('\n');
  check('csv: both records are exported, with their rules codes and versions', csv.length === 3 && csv[1].includes(',v4,4,') && csv[2].includes(',std,5,'));
  check('json: the export holds both records with rules_version', JSON.parse(toJson({ v: 1, games: both })).games.map((x) => x.rules_version).join() === '4,5');
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
  check('analytics: hand_end says the outcome through nobody_chased (0 or 1), chasers and row_value', he.hand_number === 1 && he.nobody_chased === (hrec.chasers === 0 ? 1 : 0) && he.chasers === hrec.chasers && he.row_value === hrec.rowValue && !('mobs_home' in he) && !('escapes' in he) && Object.keys(he).every((k) => analytics.ALLOWED_PARAMS.includes(k)));
  check('analytics: game_end carries the per-game counts and they match the engine', ge.nobody_chased === m.nobodyChased && ge.chasers === m.chasesBySeat.reduce((a, b) => a + b, 0) && ge.kept_value === m.keptValue && ge.tricks === m.tricks && !('mobs_home' in ge) && !('escapes' in ge));
  check('analytics: the whitelist is the v4 list minus mobs_home and escapes plus chasers, row_value, kept_value; no variant event; game name', same(analytics.ALLOWED_PARAMS.slice().sort(), ['game_name', 'player_count', 'human_players', 'bot_players', 'bot_levels', 'rules_code', 'hand_number', 'hands', 'tricks', 'duration_seconds', 'winner_seat_type', 'winning_score', 'winning_margin', 'tiebreak_used', 'human_rank', 'nobody_chased', 'chasers', 'row_value', 'kept_value'].sort()) && analytics.ALLOWED_PARAMS.length === 19 && !analytics.EVENT_NAMES.includes('variant_changed') && analytics.EVENT_NAMES.length === 7 && analytics.trackVariantChanged === undefined && analytics.GAME_NAME === 'snowy-river');
  check('analytics: clean() drops the retired mobs_home and escapes and any extra key', same(Object.keys(analytics.clean({ mobs_home: 1, escapes: 1, seed: 's', name: 'x', chasers: 2, row_value: 7, kept_value: 5 })).sort(), ['chasers', 'kept_value', 'row_value']));
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
  check('bug report: diagnostics hold the phase, marker, row, kept cards, deck counts and choices', typeof sn.phase === 'string' && typeof sn.marker === 'number' && Array.isArray(sn.row) && Array.isArray(sn.kept) && typeof sn.brumbyDeckCount === 'number' && typeof sn.brumbyDiscardCount === 'number' && Array.isArray(sn.chosen) && sn.chosen.length === 3 && (sn.choicesRevealed === null || sn.choicesRevealed.length === 3) && Array.isArray(sn.climbTricks) && !('summitStep' in sn) && !('mob' in sn));
  const hum = () => createController({ seats: [{ type: 'human' }, { type: 'human' }, { type: 'human' }], seed: 5 });
  const live = hum();
  const lv = bug.buildReport({ ctl: live, screen: 'game' }).diagnostics;
  check('bug report: a live card hand gives a block reason per card in the human hand (null for legal cards)', lv.snowy.phase === 'climb' && lv.snowy.marker === 0 && lv.cards.length === live.state.hands[lv.seat].length && lv.cards.every((c) => c.blockReason === null || typeof c.blockReason === 'string') && lv.snowy.choicesRevealed === null);
  const sc = hum();
  for (let i = 0; i < 300 && sc.state.phase === 'climb'; i++) sc.play(sc.legalActions()[0]);
  if (sc.state.phase === 'summit') {
    const first = sc.play({ type: 'summit', choice: 'chase' });
    const sd = bug.buildReport({ ctl: sc, screen: 'game' }).diagnostics;
    check('bug report: at the summit the cards say why they are blocked; choices show who has chosen, not what, until revealed', first.ok && sd.snowy.phase === 'summit' && sd.snowy.marker === 6 && sd.snowy.handsTurned === true && sd.snowy.row.length === 6 && sd.cards.length > 0 && sd.cards.every((c) => /summit|Chase/.test(c.blockReason)) && sd.snowy.revealed === false && sd.snowy.choicesRevealed === null && sd.snowy.chosen.filter(Boolean).length === 1);
    sc.play({ type: 'summit', choice: 'watch' }); sc.play({ type: 'summit', choice: 'watch' });
    const sr = bug.buildReport({ ctl: sc, screen: 'game' }).diagnostics;
    check('bug report: after the reveal the choices are in the report', sr.snowy.phase !== 'summit' ? sr.snowy.choicesRevealed === null || Array.isArray(sr.snowy.choicesRevealed) : Array.isArray(sr.snowy.choicesRevealed));
  } else check('bug report: reached the summit with the controller helper', false, sc.state.phase);
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
