// stats-browser.mjs - the stats screen, exports, analytics events and the bug reporter in the
// real UI (headless Chromium): two quick all-bot games (the v5 rules: there are no variants) are played, a v4 record is planted, then the
// stats screen, CSV/JSON downloads, gtag events (read back from dataLayer, with
// the third-party scripts blocked), blocked localStorage, the pass-and-play cover and the
// bug-report download are checked.
// Needs Playwright (see tests/browser-lib.mjs); prints SKIPPED without it (exit 0), or exits 1
// with --require. Run: node tests/stats-browser.mjs [--require]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './lib.mjs';
import { requireChromium, serveRepo } from './browser-lib.mjs';
import { ALLOWED_PARAMS, EVENT_NAMES } from '../src/ui/analytics.js';
import { GAME_SLUG } from '../src/game-config.js';
import { VARIANTS } from '../src/engine/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, done } = suite('stats-browser');
const STORE = `${GAME_SLUG}-stats-v1`;
const BUGS = `${GAME_SLUG}-bugreports-v1`;

const chromium = await requireChromium('stats-browser');
const { base: BASE, close } = await serveRepo(ROOT);

const browser = await chromium.launch();
const pageErrors = [];
// index.html defines the real gtag (it pushes onto window.dataLayer), which would overwrite any stub,
// so the events are read back from dataLayer. The third-party scripts (consent banner, GA) are blocked.
const events = (page) => page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event'));

async function newPage(init) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  if (init) await ctx.addInitScript(init);
  await ctx.route(/cdn-cookieyes\.com|googletagmanager\.com|google-analytics\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(`console: ${m.text()}`); });
  return page;
}

/** Opens the setup page and starts a game. types: seat types; rules: { NAME: value }. */
async function start(page, { players = 4, types = ['easy', 'easy', 'easy', 'easy', 'easy'], rules = {}, seed = 31, reload = true } = {}) {
  if (reload) await page.goto(`${BASE}?botdelay=0&seed=${seed}`);
  await page.waitForSelector('#setup-form');
  await page.check(`input[name=players][value="${players}"]`);
  for (let i = 0; i < players; i++) await page.selectOption(`select[name=type${i}]`, types[i]);
  if (Object.keys(rules).length) {
    await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
    for (const [k, v] of Object.entries(rules)) await page.selectOption(`select[name="rule-${k}"]`, v);
  }
  await page.click('#start');
}

async function finish(page) { await page.waitForSelector('.end--game', { timeout: 90000 }); }

async function openStats(page, from) {
  await page.click(`${from} [data-action=open-stats]`);
  await page.waitForSelector('.dialog .st');
}

const tryClick = (loc) => loc.click({ timeout: 5000 }).then(() => true, () => false);

/** A few human decisions (cards, hand summaries) so the game has progress worth abandoning or reporting. */
async function playSome(page, count) {
  let played = 0;
  for (let guard = 0; guard < 600 && played < count; guard++) {
    if (await page.locator('#summit-continue').count()) { await tryClick(page.locator('#summit-continue')); continue; }
    if (await page.locator('#continue').count()) { await tryClick(page.locator('#continue')); continue; }
    if (await page.locator('.decision [data-action=decide]').count()) { await tryClick(page.locator('.decision [data-action=decide]').first()); continue; }
    const legal = page.locator('.hand .card.is-legal');
    if (await legal.count()) { if (await tryClick(legal.first())) { played++; await page.waitForTimeout(60); } } else await page.waitForTimeout(40);
  }
  return played;
}

const CODE2 = 'std'; // Snowy River has no Playtest switches (VARIANTS is empty); 'std' = v6, 'v5' and 'v4' = relabelled old records
const V4_RECORD = {
  v: 1, id: 'gplanted-4', date: '2026-11-09T10:00:00.000Z', players: 3, seed: '4', rules: {}, rules_code: 'std',
  seats: [{ seat: 0, type: 'human', level: null }, { seat: 1, type: 'bot', level: 'easy' }, { seat: 2, type: 'bot', level: 'hard' }],
  hand_scores: [[3, 2, -1], [1, 4, 0], [2, 2, 5]], totals: [6, 8, 4], ranking: [{ seat: 1, total: 8, mobs_home: 1, rank: 1 }],
  winners: [1], shared: false, tiebreak_used: false, tied_on_total: false, winning_score: 8, margin: 2, hands: 3, tricks: 36,
  mobs_home: 1, nobody_chased: 1, mobs_home_by_seat: [0, 1, 0], escapes: 2, chases: 2, falls: 1, chases_by_seat: [1, 1, 0], falls_by_seat: [1, 0, 0], seconds: 300,
  hand_log: [{ end_reason: 'descent', outcome: 'home', choices: 'CWW', chasers: 1, outcomes: ['home', 'x', 'x'], mob_value: 3, scores: [3, 2, -1] },
    { end_reason: 'descent', outcome: 'escaped-watcher', choices: 'CCW', chasers: 2, outcomes: ['fell', 'fell', 'x'], mob_value: 5, scores: [1, 4, 0] },
    { end_reason: 'nobody-chases', outcome: 'nobody-chased', choices: 'WWW', chasers: 0, outcomes: ['x', 'x', 'x'], mob_value: 3, scores: [2, 2, 5] }],
};
const V5_RECORD = {
  v: 1, id: 'gplanted-5', date: '2026-11-11T10:00:00.000Z', players: 3, seed: '5', rules: {}, rules_version: 5, rules_code: 'std',
  seats: [{ seat: 0, type: 'human', level: null }, { seat: 1, type: 'bot', level: 'easy' }, { seat: 2, type: 'bot', level: 'hard' }],
  hand_scores: [[5, 2, 1], [3, 3, 4], [6, 1, 2]], totals: [14, 6, 7], last_hand_scores: [6, 1, 2], ranking: [{ seat: 0, total: 14, last_hand_score: 6, rank: 1 }],
  winners: [0], shared: false, tiebreak_used: false, tied_on_total: false, winning_score: 14, margin: 7, hands: 3, tricks: 36,
  nobody_chased: 1, chases: 3, chases_by_seat: [2, 1, 0], chaser_counts: [1, 1, 1, 0, 0], kept_value: 6, colt_rows: 1, colt_kept: 1, seconds: 400,
  hand_log: [{ choices: 'CWW', chasers: 1, kept: [['b1'], [], []], kept_values: [2, 0, 0], costs: [2, 0, 0], scores: [5, 2, 1], colt: false, colt_kept: false, colt_winner: null },
    { choices: 'CCW', chasers: 2, kept: [['b2'], ['b3'], []], kept_values: [1, 1, 0], costs: [2, 2, 0], scores: [3, 3, 4], colt: true, colt_kept: true, colt_winner: 0, top_home_seat: 0 },
    { choices: 'WWW', chasers: 0, kept: [[], [], []], kept_values: [0, 0, 0], costs: [0, 0, 0], scores: [6, 1, 2], colt: false, colt_kept: false, colt_winner: null }],
};
const V6_ROWS = ['Average hand score', 'Average hand score of a human seat', 'Took the -1 Climb card (human seats)', 'Brumby cards won (all seats)', 'Brumby cards won (human seats)', 'Hands ending below zero (all seats)', 'Hands ending below zero (human seats)', 'Colt in the row', 'Colt taken by a human seat (+4)', 'Colt taken by the Home 1 holder'];

// ---------- empty state, then two games ----------
{
  const page = await newPage();
  await page.goto(`${BASE}?botdelay=0&seed=31`);
  await page.waitForSelector('#setup-form');
  check('landing: a Stats link is in the top nav', (await page.locator('#topnav-links [data-action=open-stats]').count()) === 1);
  await openStats(page, '.landing');
  check('empty: shows the empty state', /No games recorded yet/.test(await page.textContent('.dialog .st')));
  check('empty: export buttons disabled', await page.$eval('[data-action=export-csv]', (b) => b.disabled));
  await page.keyboard.press('Escape');

  await start(page, { players: 4, reload: false });
  await finish(page);
  check('end screen: a Stats button is among the end buttons', (await page.locator('#end-buttons [data-action=open-stats]').count()) === 1);
  await page.click('.end [data-action=new]');
  await page.waitForSelector('#setup-form');
  await start(page, { players: 3, reload: false });
  await finish(page);
  await openStats(page, '.end');
  const lead = await page.textContent('.dialog .st__lead');
  check('stats from the end screen: 2 games played', /^\s*2\s+games played/.test(lead), lead);
  const codes = await page.$$eval('.st__table tbody th', (ths) => ths.map((t) => t.textContent.trim()));
  check('stats: only the current rules (v6) in the by-rules table', VARIANTS.length === 0 && codes.includes('Current rules (v6)') && !codes.some((c) => /^[a-z]+-/.test(c) || /v4|v5/.test(c)), codes.join(' | '));
  const sections = await page.$$eval('.st h3', (hs) => hs.map((h) => h.textContent));
  check('stats: all sections present', ['Win rate by seat type', 'Win rate by seat position', 'Scores by player count', 'The Climb row and the Brumby row', 'Ties and the tiebreak', 'By rules'].every((s) => sections.includes(s)) && !sections.includes('The mob and the summit') && !sections.includes('Chase, Watch and the Brumby row'), sections.join(' | '));
  const mobRows = await page.$$eval('.st h3', (hs) => { const h = hs.find((x) => x.textContent === 'The Climb row and the Brumby row'); return [...h.nextElementSibling.nextElementSibling.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim())); });
  check('stats: the Snowy River section shows its ten v6 measures with numbers', mobRows.length === 10 && mobRows.map((r) => r[0]).join('|') === V6_ROWS.join('|') && mobRows.every((r) => r.slice(1).every((c) => /\d|-/.test(c) && !/NaN|undefined/.test(c))), JSON.stringify(mobRows));
  fs.mkdirSync(path.join(ROOT, 'tests', 'tmp'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'tests', 'tmp', 'stats-screen.png') });
  await page.evaluate(() => { const h = [...document.querySelectorAll('.st h3')].find((x) => x.textContent === 'The Climb row and the Brumby row'); h.scrollIntoView(); });
  await page.screenshot({ path: path.join(ROOT, 'tests', 'tmp', 'stats-screen-mob.png') });
  check('stats: scores by player count has 3 and 4 players', (await page.textContent('.dialog')).includes('3 players') && (await page.textContent('.dialog')).includes('4 players'));
  check('stats: small sample flagged', (await page.locator('.st__small').count()) > 0);

  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games, STORE);
  check('store: two v6 records', stored.length === 2 && stored.every((g) => g.rules_code === 'std' && g.rules_version === 6) && stored[1].players === 3 && stored[0].players === 4);
  check('store: records carry the hand breakdown and the v6 counts', stored.every((g) => g.hand_log.length === g.hands && Number.isInteger(g.tricks) && Array.isArray(g.minus_by_seat) && Array.isArray(g.colt_by_seat) && Number.isInteger(g.colt_rows) && Number.isInteger(g.negative_hands) && Number.isInteger(g.brumby_cards) && Number.isInteger(g.brumby_value) && g.last_hand_scores.length === g.players));
  check('store: v6 fields are consistent in every stored record', stored.every((g) => g.minus_by_seat.reduce((a, b) => a + b, 0) === g.hands && g.brumby_cards === g.hands * 6 && g.brumby_value === g.hand_log.reduce((a, h) => a + h.kept_values.reduce((x, y) => x + y, 0), 0) && g.totals.every((t, i) => t === g.hand_scores.reduce((a, h) => a + h[i], 0)) && g.hand_log.every((h) => h.row.length === 6 && h.climb_row_values.length === 6 && h.climb_values.reduce((a, b) => a + b, 0) === 4 && h.tricks === 12 && h.scores.every((x, s) => x === h.climb_values[s] + h.kept_values[s])) && g.hand_log.every((h) => !('choices' in h) && !('chasers' in h)) && !('chases' in g) && !('kept_value' in g)));
  check('store: every hand names the -1 Climb card winner and the Colt winner when the Colt is out', stored.every((g) => g.hand_log.every((h) => Number.isInteger(h.minus_winner) && (h.colt ? Number.isInteger(h.colt_winner) : h.colt_winner === null))));

  // exports
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]);
  check('export: csv filename', new RegExp(`^${GAME_SLUG}-stats-\\d{4}-\\d{2}-\\d{2}\\.csv$`).test(csvDl.suggestedFilename()), csvDl.suggestedFilename());
  const csvText = fs.readFileSync(await csvDl.path(), 'utf8');
  const csv = csvText.trim().split('\n');
  check('export: csv has a header and one row per game, LF only', csv.length === 3 && csv[0].startsWith('date,id,seed,players,rules_code') && !csvText.includes('\r'), String(csv.length));
  const cols = csv[0].split(',');
  check('export: csv has the v6 columns and a value in each', ['rules_version', 'minus_by_seat', 'colt_by_seat', 'colt_rows', 'negative_hands', 'brumby_cards', 'brumby_value', 'hand_row_values'].every((c) => cols.includes(c)) && !cols.includes('mobs_home') && !cols.includes('chases') && csv[1].split(',').length === cols.length && csv[1].split(',')[cols.indexOf('brumby_value')] === String(stored[0].brumby_value) && csv[1].split(',')[cols.indexOf('negative_hands')] === String(stored[0].negative_hands));
  check('export: csv rows carry the rules code and version', csv[1].includes(',std,6,') && csv[2].includes(`,${CODE2},6,`));
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-json]')]);
  const json = JSON.parse(fs.readFileSync(await jsonDl.path(), 'utf8'));
  check('export: json is valid and holds both records, identical to the store', json.games.length === 2 && JSON.stringify(json.games) === JSON.stringify(stored) && /\.json$/.test(jsonDl.suggestedFilename()) && json.game === GAME_SLUG);
  await page.keyboard.press('Escape');

  // analytics: setup-page events, then everything seen so far
  await page.click('.end [data-action=new]');
  await page.waitForSelector('#setup-form');
  await page.click('.landing [data-action=open-rules]');
  await page.keyboard.press('Escape');
  const calls = await events(page);
  const names = calls.map((c) => c[1]);
  for (const n of ['game_start', 'hand_end', 'game_end', 'stats_viewed', 'stats_exported', 'rules_opened']) check(`analytics: ${n} fired in the page`, names.includes(n));
  check('analytics: two games started, two ended, hands counted', names.filter((n) => n === 'game_start').length === 2 && names.filter((n) => n === 'game_end').length === 2 && names.filter((n) => n === 'hand_end').length === 7, `${names.filter((n) => n === 'hand_end').length}`);
  check('analytics: every event name is known', names.every((n) => EVENT_NAMES.includes(n)));
  const keys = new Set(calls.flatMap((c) => Object.keys(c[2] || {})));
  check('analytics: page params within the whitelist', [...keys].every((k) => ALLOWED_PARAMS.includes(k)), [...keys].join(','));
  check('analytics: values are numbers or short tokens', calls.every((c) => Object.values(c[2] || {}).every((v) => typeof v === 'number' || /^[A-Za-z0-9_,.+-]{1,60}$/.test(v))));
  check('analytics: stats_exported fired for csv and json', names.filter((n) => n === 'stats_exported').length === 2);
  const ge = calls.filter((c) => c[1] === 'game_end').map((c) => c[2]);
  check('analytics: game_end carries the result summary, rules_code and counts', ge.length === 2 && ge[0].rules_code === 'std' && ge[1].rules_code === CODE2 && ge[0].player_count === 4 && ge[0].hands === 4 && ge[1].hands === 3
    && ge.every((g) => g.game_name === GAME_SLUG && Number.isInteger(g.winning_score) && Number.isInteger(g.winning_margin) && /^(easy|shared)$/.test(g.winner_seat_type) && /^(yes|no)$/.test(g.tiebreak_used) && Number.isInteger(g.colt_in_row) && Number.isInteger(g.negative_hands) && !('chasers' in g) && !('nobody_chased' in g) && !('kept_value' in g) && g.human_players === 0 && g.human_rank === undefined && g.bot_levels.startsWith('easy')), JSON.stringify(ge));
  check('analytics: game_end matches the stored record', ge[0].winning_score === stored[0].winning_score && ge[0].winning_margin === stored[0].margin && ge[1].winning_score === stored[1].winning_score && ge[0].tricks === stored[0].tricks);
  check('analytics: no variant_changed (there are no switches)', !names.includes('variant_changed'));
  const he = calls.filter((c) => c[1] === 'hand_end').map((c) => c[2]);
  check('analytics: hand_end carries colt_in_row (0 or 1) and row_value; no Chase or mob params', he.length === 7 && he.every((h) => (h.colt_in_row === 0 || h.colt_in_row === 1) && Number.isInteger(h.row_value) && !('chasers' in h) && !('nobody_chased' in h) && !('mobs_home' in h) && !('escapes' in h) && h.game_name === GAME_SLUG));
  check('analytics: game_end per-game counts match the stored record', ge[0].colt_in_row === stored[0].colt_rows && ge[0].negative_hands === stored[0].negative_hands && ge[1].colt_in_row === stored[1].colt_rows && ge[1].negative_hands === stored[1].negative_hands);
  check('analytics: game_name is snowy-river on every event, and only whitelisted names are used', GAME_SLUG === 'snowy-river' && calls.every((c) => c[2] && c[2].game_name === 'snowy-river'));
  check('analytics: nothing sent says who won by name', !JSON.stringify(calls).match(/bot 1|Player|You/));

  // planted v4 and v5 records are relabelled and shown apart from the two v6 games
  await page.evaluate(([k, recs]) => { const d = JSON.parse(localStorage.getItem(k)); d.games.unshift(...recs); localStorage.setItem(k, JSON.stringify(d)); }, [STORE, [V4_RECORD, V5_RECORD]]);
  await openStats(page, '.landing');
  const lead6 = await page.textContent('.dialog .st__lead');
  check('old records: with v4 and v5 records in the store the screen still opens on the v6 games only', /^\s*2\s+games played under Current rules \(v6\)/.test(lead6), lead6);
  const opts = await page.$$eval('[data-action=stats-filter] option', (os) => os.map((o) => `${o.value}:${o.textContent.trim()}`));
  check('old records: the rules filter lists v6 (2 games), v5 (1 game) and v4 (1 game)', opts.length === 3 && opts[0].startsWith('std:Current rules (v6) (2)') && opts[1].startsWith('v5:Old rules (v5') && opts[1].endsWith('(1)') && opts[2].startsWith('v4:Old rules (v4') && opts[2].endsWith('(1)'), opts.join(' | '));
  check('old records: the v6 screen shows neither the mob nor the Chase section', (await page.locator('.st h3', { hasText: 'The mob and the summit' }).count()) === 0 && (await page.locator('.st h3', { hasText: 'Chase, Watch' }).count()) === 0);
  await page.selectOption('[data-action=stats-filter]', 'v5');
  await page.waitForSelector('.st h3:has-text("Chase, Watch and the Brumby row")');
  const lead5 = await page.textContent('.dialog .st__lead');
  const ch5 = await page.$$eval('.st h3', (hs) => { const h = hs.find((x) => x.textContent === 'Chase, Watch and the Brumby row'); return [...h.nextElementSibling.nextElementSibling.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim())); });
  check('v5: the planted record shows under v5 with its own numbers', /^\s*1\s+game played under Old rules \(v5/.test(lead5) && ch5[0][0] === 'Chase rate (seats that chased)' && ch5[0][1] === '3 of 9' && ch5[1][1] === '1' && ch5[5][1] === '1 of 1' && !/NaN|undefined/.test(await page.textContent('.dialog .st')), lead5 + JSON.stringify(ch5));
  await page.selectOption('[data-action=stats-filter]', 'v4');
  await page.waitForSelector('.st h3:has-text("The mob and the summit")');
  const lead4 = await page.textContent('.dialog .st__lead');
  const mob4 = await page.$$eval('.st h3', (hs) => { const h = hs.find((x) => x.textContent === 'The mob and the summit'); return [...h.nextElementSibling.nextElementSibling.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim())); });
  check('v4: the planted record shows under v4 with its own numbers', /^\s*1\s+game played under Old rules \(v4/.test(lead4) && mob4[0][0] === 'Mob brought home' && mob4[0][1] === '1' && mob4[1][1] === '2' && mob4[2][1] === '1' && !/NaN|undefined/.test(await page.textContent('.dialog .st')), lead4 + JSON.stringify(mob4));
  const relabelled = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games.length, STORE);
  check('old records: the stored list now holds four games', relabelled === 4);
  const [csv3] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]);
  const csvLines = fs.readFileSync(await csv3.path(), 'utf8').trim().split('\n');
  check('old records: the CSV export holds the v4 (code v4, version 4) and v5 (code v5, version 5) records beside the v6 ones', csvLines.length === 5 && csvLines.filter((l) => l.includes(',v4,4,')).length === 1 && csvLines.filter((l) => l.includes(',v5,5,')).length === 1 && csvLines.filter((l) => l.includes(',std,6,')).length === 2);
  const [json3] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-json]')]);
  const jg = JSON.parse(fs.readFileSync(await json3.path(), 'utf8')).games;
  check('old records: the JSON export holds all four records, the old ones relabelled', jg.length === 4 && jg.some((g) => g.id === 'gplanted-4' && g.rules_code === 'v4' && g.rules_version === 4) && jg.some((g) => g.id === 'gplanted-5' && g.rules_code === 'v5' && g.rules_version === 5) && jg.filter((g) => g.rules_version === 6 && g.rules_code === 'std').length === 2);
  await page.keyboard.press('Escape');


  // the clear button, with a confirm
  await openStats(page, '.landing');
  page.once('dialog', (d) => d.dismiss());
  await page.click('[data-action=clear-stats]');
  check('clear: dismissing the confirm keeps the data', (await page.locator('.dialog .st__table').count()) > 0);
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=clear-stats]');
  await page.waitForSelector('.st__empty');
  check('clear: accepting empties the store', (await page.evaluate((k) => localStorage.getItem(k), STORE)) === null);
  await page.close();
}

// ---------- human game: bug reporter, abandonment ----------
{
  const page = await newPage();
  await start(page, { players: 4, types: ['human', 'easy', 'easy', 'easy'], seed: 41 });
  check('bug: button on body, on the game screen', (await page.locator('body > #bug-button').count()) === 1);
  const played = await playSome(page, 5);
  check('bug: human played some decisions', played >= 5, String(played));
  check('bug: button still there after re-renders', (await page.locator('body > #bug-button').count()) === 1);
  check('bug: button visible while a hand is on show', await page.isVisible('#bug-button'));
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  await page.fill('#bug-form [name=title]', 'Card would not play');
  await page.fill('#bug-form [name=happened]', 'clicked and nothing');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  const rep = JSON.parse(text);
  check('bug: file name from id and title', new RegExp(`^${GAME_SLUG}-\\d{8}-\\d{6}-[a-z0-9]+-card-would-not-play\\.json$`).test(dl.suggestedFilename()), dl.suggestedFilename());
  check('bug: valid JSON that round-trips', JSON.stringify(JSON.parse(JSON.stringify(rep))) === JSON.stringify(rep) && text.trim().startsWith('{'));
  check('bug: report has state, diagnostics, controller and logs', rep.schemaVersion === 1 && rep.game && rep.game.kind === 'game' && rep.game.n === 4 && rep.diagnostics && Array.isArray(rep.diagnostics.cards) && Array.isArray(rep.diagnostics.legalActions) && rep.controller.seed === 41 && rep.player.title === 'Card would not play' && rep.player.whatHappened === 'clicked and nothing');
  const sn = rep.diagnostics.snowy;
  check('bug: diagnostics hold the v6 Snowy River fields', sn && typeof sn.phase === 'string' && /^(highest|lowest)$/.test(sn.direction) && /^(escape|home)$/.test(sn.trump) && Array.isArray(sn.climbRow) && sn.climbRowDealt.length === 6 && Array.isArray(sn.climbCards) && sn.climbCards.length === 4 && Array.isArray(sn.row) && Array.isArray(sn.kept) && !('marker' in sn) && !('handsTurned' in sn) && !('chosen' in sn) && !('summitStep' in sn), JSON.stringify(sn));
  check('bug: diagnostics hold the Brumby deck counts and a block reason slot per card', Number.isInteger(sn.brumbyDeckCount) && Number.isInteger(sn.brumbyDiscardCount) && rep.diagnostics.cards.length === rep.game.hands[rep.diagnostics.seat].length && rep.diagnostics.cards.every((c) => c.blockReason === null || typeof c.blockReason === 'string'));
  check('bug: action log covers human and bot plays', rep.actionLog.length >= 8 && new Set(rep.actionLog.map((a) => a.seatType)).size >= 2 && rep.actionLog.some((a) => a.kind === 'play') && rep.actionLog.some((a) => a.kind === 'trick-won'));
  check('bug: mailto link shown with the contact address', (await page.locator('.bug a[href^="mailto:info@wombatgamefactory.com?"]').count()) === 1);
  const archived = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), BUGS);
  check('bug: a copy is archived locally and equals the download', archived.length === 1 && JSON.stringify(archived[0]) === JSON.stringify(rep));
  await page.click('.bug .btn--primary');
  check('bug: modal closes', (await page.locator('.bug').count()) === 0);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('.bug__past');
  await page.click('.bug__past summary');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('.bug__past [data-bug=redownload]')]);
  check('bug: past report re-downloads identically', JSON.stringify(JSON.parse(fs.readFileSync(await dl2.path(), 'utf8'))) === JSON.stringify(rep));
  await page.keyboard.press('Escape');
  check('bug: Escape closes the modal', (await page.locator('.bug').count()) === 0);

  // leaving a running game through Setup counts as abandoning it (once)
  const before = (await events(page)).filter((c) => c[1] === 'game_abandoned').length;
  if (await page.locator('#continue').count()) await page.click('#continue'); // a hand summary may be up
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=quit]');
  await page.waitForSelector('#setup-form');
  const abandoned = (await events(page)).filter((c) => c[1] === 'game_abandoned');
  check('analytics: game_abandoned fires once when leaving a running game', before === 0 && abandoned.length === 1, `${before} -> ${abandoned.length}`);
  const ab = abandoned[0] ? abandoned[0][2] : {};
  check('analytics: game_abandoned carries usage and progress, not results', Object.keys(ab).every((k) => ALLOWED_PARAMS.includes(k) && !/winn|rank|tiebreak|trump/.test(k)) && ab.tricks >= 1 && ab.hands >= 0 && ab.human_players === 1 && ab.bot_players === 3 && ab.player_count === 4, JSON.stringify(ab));
  check('store: an abandoned game is not recorded', (await page.evaluate((k) => localStorage.getItem(k), STORE)) === null);
  await page.close();
}

// ---------- pass-and-play: no bug report while the cover is up ----------
{
  const page = await newPage();
  await start(page, { players: 3, types: ['human', 'human', 'easy'], seed: 61 });
  await page.waitForSelector('.cover', { timeout: 30000 });
  check('cover: body is marked covered', (await page.getAttribute('body', 'data-covered')) === '1');
  check('cover: the bug button is not available', !(await page.isVisible('#bug-button')));
  await page.keyboard.press('Control+Shift+B');
  await page.waitForTimeout(200);
  check('cover: Ctrl+Shift+B opens nothing (no hands in a report)', (await page.locator('.bug').count()) === 0);
  await page.click('.cover .btn--primary');
  await page.waitForSelector('.hand .card');
  check('cover: after revealing, the button is back and the shortcut works', (await page.isVisible('#bug-button')) && (await (async () => { await page.keyboard.press('Control+Shift+B'); return page.waitForSelector('#bug-form', { timeout: 3000 }).then(() => true, () => false); })()));
  await page.keyboard.press('Escape');
  await page.close();
}

// ---------- localStorage blocked: the game and the screens still work ----------
{
  const page = await newPage(() => {
    const boom = () => { throw new Error('storage blocked'); };
    Object.defineProperty(window, 'localStorage', { get: boom, configurable: true });
  });
  await start(page, { players: 3, seed: 51 });
  await finish(page);
  check('blocked storage: game reached the end panel', (await page.locator('.end--game').count()) === 1);
  await openStats(page, '.end');
  check('blocked storage: stats screen shows the empty state', /No games recorded yet/.test(await page.textContent('.dialog .st')));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  check('blocked storage: bug report still downloads', JSON.parse(fs.readFileSync(await dl.path(), 'utf8')).schemaVersion === 1);
  await page.close();
}

// ---------- no gtag at all ----------
{
  const page = await newPage(() => { document.addEventListener('DOMContentLoaded', () => { window.gtag = undefined; }); });
  await start(page, { players: 3, seed: 52 });
  await finish(page);
  check('no gtag: game completes', (await page.locator('.end--game').count()) === 1);
  await openStats(page, '.end');
  check('no gtag: the game is still recorded locally', /^\s*1\s+game played/.test(await page.textContent('.dialog .st__lead')));
  await page.close();
}

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
close();
done();
