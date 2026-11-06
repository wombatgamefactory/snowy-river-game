// stats-node.mjs - the local stats store, the recorder, the CSV / JSON export, the summary, the
// stats screen markup, the analytics whitelist and events, and the bug report (all without a
// browser: storage is a fake, `window.gtag` is a recorder).
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. Run: node tests/stats-node.mjs

import { suite, roundTrip } from './lib.mjs';
import {
  createStatsStore, createRecorder, handRecord, toCsv, toJson, exportFilename, csvCell, gameToRow, CSV_COLUMNS, summarise, seatKind,
  STORE_KEY, MAX_GAMES,
} from '../src/ui/stats-store.js';
import { handOutcome } from '../src/ui/stats-store.js';
import { statsHtml, statsButtonsHtml } from '../src/ui/stats-view.js';
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
  // Snowy River's own fields, cross-checked against the engine's result
  const st = g.state;
  const hl = r.hand_log;
  const sumBy = (rows, i) => rows.reduce((a, row) => a + row[i], 0);
  check('record: hand scores add up to the totals and the engine result', r.totals.every((t, i) => t === sumBy(r.hand_scores, i) && t === st.result.totals[i] && t === st.totals[i]));
  check('record: mobs home (total and by seat) match the engine and the hand log', r.mobs_home === st.measures.mobsHome && r.mobs_home === hl.filter((h) => h.outcome === 'home').length && JSON.stringify(r.mobs_home_by_seat) === JSON.stringify(st.mobsHome) && r.mobs_home === r.mobs_home_by_seat.reduce((a, b) => a + b, 0) && r.ranking.every((x) => x.mobs_home === st.mobsHome[x.seat]));
  check('record: escapes + mobs home = hands; nobody-chased hands match', r.escapes === st.measures.escapes && r.escapes + r.mobs_home === r.hands && r.nobody_chased === hl.filter((h) => h.outcome === 'nobody-chased').length && r.nobody_chased === st.measures.nobodyChased);
  check('record: chases and falls match the hand log and the engine', r.chases === hl.reduce((a, h) => a + h.chasers, 0) && r.chases === hl.reduce((a, h) => a + h.choices.split('C').length - 1, 0) && r.falls === st.measures.falls && r.falls === hl.reduce((a, h) => a + h.outcomes.filter((o) => o === 'fell').length, 0) && r.chases_by_seat.length === 4 && r.falls_by_seat.length === 4);
  check('record: each hand has its outcome, summit, mob, Brumby stack and seat counts', hl.every((h, i) => ['home', 'escaped-watcher', 'nobody-chased'].includes(h.outcome) && h.outcome === handOutcome(st.handLog[i]) && h.summit_reached === (h.summit_trick !== null) && h.mob_value === 3 + 2 * h.brumbies_before && h.chaser_seats.length === h.chasers && h.chaser_seats.length + h.watcher_seats.length === 4 && h.climb_tricks.length === 4 && h.descent_tricks.length === 4 && h.scores.length === 4 && h.tricks === st.handLog[i].tricks.length));
  check('record: the Brumby stack carries from one hand to the next and stays within 0..4', hl.every((h, i) => h.brumbies_after >= 0 && h.brumbies_after <= 4 && (i === 0 ? h.brumbies_before === 0 : h.brumbies_before === hl[i - 1].brumbies_after)) && hl.every((h) => (h.outcome === 'home' ? h.brumbies_after === 0 && h.home !== null : h.home === null && h.brumbies_after === Math.min(4, h.brumbies_before + 1))));
  check('record: heels is null only when nobody chased, and that hand ended at the summit', hl.every((h) => (h.outcome === 'nobody-chased') === (h.heels === null && h.end_reason === 'nobody-chases')));
  check('record: a chaser who was home scored climb + mob; fallers scored -1; watchers their climb tricks', hl.every((h) => h.outcomes.every((o, s) => (o === 'fell' ? h.scores[s] === -1 : o === 'home' ? h.scores[s] === h.climb_tricks[s] + h.mob_value : h.scores[s] === h.climb_tricks[s]))));
  check('record: tiebreak flag matches the engine', r.tiebreak_used === st.result.tiebreakUsed && r.tied_on_total === (st.result.tiedOnTotal.length > 1));
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
  check('csv: one rule column per VARIANTS row (none) and one pair per seat; the game columns', VARIANTS.length === 0 && !CSV_COLUMNS.some((c) => c.startsWith('rule_')) && CSV_COLUMNS.includes('seat5_type') && ['tricks', 'mobs_home', 'mobs_home_by_seat', 'escapes', 'nobody_chased', 'chases', 'falls', 'hand_outcomes'].every((c) => CSV_COLUMNS.includes(c)));
  const row1 = gameToRow(r1); const col = (c) => row1[CSV_COLUMNS.indexOf(c)];
  check('csv: the game cells carry the record values', col('mobs_home') === r1.mobs_home && col('mobs_home_by_seat') === r1.mobs_home_by_seat.join(' ') && col('escapes') === r1.escapes && col('nobody_chased') === r1.nobody_chased && col('chases') === r1.chases && col('falls') === r1.falls && col('hand_outcomes') === r1.hand_log.map((h) => h.outcome).join(' '));
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
  check('summary: split by rules code: everything is standard', sum.byRules.map((r) => r.code).join() === 'std' && summarise([r1, r2], 'std').total === 2);
  check('summary: by player count', sum.byPlayers[4].games === 1 && sum.byPlayers[3].games === 1);
  const ex = sum.extra;
  const allHands = [r1, r2].flatMap((x) => x.hand_log);
  check('summary: extra counts hands, mobs home, escapes, nobody-chased, chasers and falls', ex.hands === allHands.length && ex.mobsHome === r1.mobs_home + r2.mobs_home && ex.escapes === r1.escapes + r2.escapes && ex.mobsHome + ex.escapes === ex.hands && ex.nobodyChased === r1.nobody_chased + r2.nobody_chased && ex.chases === r1.chases + r2.chases && ex.falls === r1.falls + r2.falls);
  check('summary: the human Chase numbers come from the human seat only', ex.humanHands === r1.hand_log.length && ex.humanChases === r1.hand_log.filter((h) => h.choices[0] === 'C').length && ex.humanHomes === r1.hand_log.filter((h) => h.home === 0).length && ex.humanHomes <= ex.humanChases);
  check('summary: seat kind helper', seatKind({ type: 'human' }) === 'human' && seatKind({ type: 'bot', level: 'hard' }) === 'hard');
  const html = statsHtml({ games: [r1, r2] }, 'all');
  const h3 = [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1]);
  check('stats screen: the sections', ['Win rate by seat type', 'Win rate by seat position', 'Scores by player count', 'The mob and the summit', 'Ties and the tiebreak', 'By rules'].every((s) => h3.includes(s)), h3.join(' | '));
  check('stats screen: standard rules, small-sample warnings, the mob line, no raw values', /Standard rules/.test(html) && /small sample/.test(html) && /Mob brought home/.test(html) && /Nobody chased/.test(html) && /Chasers per hand/.test(html) && /Chasers who fell/.test(html) && /Human Chase rate/.test(html) && /Human chase succeeded/.test(html) && !BAD.test(html));
  check('stats screen: the tiebreak is named as mobs brought home, never the last hand; no variants talk', /most mobs brought home/.test(html) && !/last hand/i.test(html) && !/variant/i.test(html));
  check('stats screen: no human seat gives dashes, not NaN', !BAD.test(statsHtml({ games: [r2] })) && /Human Chase rate<\/th><td>0 of 0<\/td><td>-/.test(statsHtml({ games: [r2] })));
  check('stats screen: empty state and an unknown filter fall back', /No games recorded yet/.test(statsHtml({ games: [] })) && /2<\/b> games played/.test(statsHtml({ games: [r1, r2] }, 'nope')));
  check('stats screen: export buttons disabled with no data', /disabled/.test(statsButtonsHtml(false)) && !/disabled/.test(statsButtonsHtml(true)));
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
  check('analytics: hand_end says the outcome only through mobs_home / escapes / nobody_chased (0 or 1)', he.hand_number === 1 && he.mobs_home === (hrec.broughtHomeBy === null ? 0 : 1) && he.escapes === 1 - he.mobs_home && he.nobody_chased === (hrec.chasers === 0 ? 1 : 0) && Object.keys(he).every((k) => analytics.ALLOWED_PARAMS.includes(k)));
  check('analytics: game_end carries the per-game counts and they match the engine', ge.mobs_home === m.mobsHome && ge.escapes === m.escapes && ge.nobody_chased === m.nobodyChased && ge.mobs_home + ge.escapes === 4 && ge.tricks === m.tricks);
  check('analytics: the whitelist holds the three new params (mobs_home, escapes, nobody_chased); no variant event; game name', ['mobs_home', 'escapes', 'nobody_chased'].every((k) => analytics.ALLOWED_PARAMS.includes(k)) && analytics.ALLOWED_PARAMS.length === 18 && !analytics.EVENT_NAMES.includes('variant_changed') && analytics.EVENT_NAMES.length === 7 && analytics.trackVariantChanged === undefined && analytics.GAME_NAME === 'snowy-river');
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
  check('bug report: diagnostics hold the phase, marker, summit step, Brumby stack and choices', typeof sn.phase === 'string' && typeof sn.marker === 'number' && sn.summitStep === ctl.state.params.summitStep && typeof sn.brumbies === 'number' && Array.isArray(sn.chosen) && sn.chosen.length === 3 && (sn.choicesRevealed === null || sn.choicesRevealed.length === 3) && Array.isArray(sn.climbTricks));
  const hum = () => createController({ seats: [{ type: 'human' }, { type: 'human' }, { type: 'human' }], seed: 5 });
  const live = hum();
  const lv = bug.buildReport({ ctl: live, screen: 'game' }).diagnostics;
  check('bug report: a live card hand gives a block reason per card in the human hand (null for legal cards)', lv.snowy.phase === 'climb' && lv.snowy.marker === 0 && lv.cards.length === live.state.hands[lv.seat].length && lv.cards.every((c) => c.blockReason === null || typeof c.blockReason === 'string') && lv.snowy.choicesRevealed === null);
  const sc = hum();
  for (let i = 0; i < 300 && sc.state.phase === 'climb'; i++) sc.play(sc.legalActions()[0]);
  if (sc.state.phase === 'summit') {
    const first = sc.play({ type: 'summit', choice: 'chase' });
    const sd = bug.buildReport({ ctl: sc, screen: 'game' }).diagnostics;
    check('bug report: at the summit the cards say why they are blocked; choices show who has chosen, not what, until revealed', first.ok && sd.snowy.phase === 'summit' && sd.snowy.summitTrick === sc.state.summitTrick && sd.snowy.marker >= sd.snowy.summitStep && sd.cards.length > 0 && sd.cards.every((c) => /summit|Chase/.test(c.blockReason)) && sd.snowy.revealed === false && sd.snowy.choicesRevealed === null && sd.snowy.chosen.filter(Boolean).length === 1);
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
