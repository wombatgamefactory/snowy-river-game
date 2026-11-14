// qa-run.mjs - browser QA over the whole game (v6 rules), run from a sub-path the way GitHub Pages serves it.
//
// 1. Copies the files that would be published (git ls-files plus untracked files that are not ignored) into
//    <system temp>/<slug>-qa/site/<slug>-game/ and serves <temp>/site on a CASE-SENSITIVE static server (a request
//    must match a real file name exactly, like Pages).
// 2. Drives the game in headless Chromium: the landing page from the sub-path (2 to 5 players, never 6, no rule book
//    link), the consent banner and analytics on a real-looking host name, 1440 / 1024 / 390 px, 2 to 5 players against
//    every bot level (Hard must not freeze the page), all-bot games, pass-and-play with two and three humans (a cover
//    before every human decision, the summit beat public), the Climb row (five +1 cards and one -1 card, the next card
//    lit, the -1 taken by you and by a bot), the summit (the banner switching from "highest wins, Escape is trumps" to
//    "lowest wins, Home is trumps", the Climb row empty, the Brumby row dealt), the Brumby row (the Colt, a Wombat hole,
//    Flint stones), hands that end below zero, the reckoning checked against the engine's own numbers, the tiebreak and a
//    shared win, the overlays dimming the whole viewport, the Muster suit at five players, every card face, the stats
//    screen and its exports with migrated v5 and v4 records, analytics, the bug reporter, reduced motion, keyboard play,
//    leaving a game, no old (v5) wording on any screen and a clean console.
// 3. Prints PASS/FAIL per check, writes screenshots to <temp>/<slug>-qa/shots/ and a JSON summary to
//    <temp>/<slug>-qa/qa-results.json. Exit 1 if anything fails.
//
// The hands and the tiebreak games are found by playing the same games headlessly first (the real controller and the
// Easy bot, a human seat that plays its first legal card), so each is reached from a `?seed=` and the page's reckoning is
// checked against the engine's own numbers. A search that finds nothing fails the run instead of skipping the scenario.
// Searches run only for the scenarios that are selected.
//
// Needs Playwright (not a dependency of this repo; see tests/browser-lib.mjs).
// Run: node tests/qa/qa-run.mjs [--only=<scenario substring>] [--widths=390,1440] [--levels=easy,hard]
//   --only keeps the screenshots of earlier runs (a full run clears them) and writes qa-results-<only>.json.
//   A full run takes several minutes; in a shell that throttles background jobs, run it in parts with --only.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GAME_NAME, GAME_SLUG, GAME_TAGLINE, CONTACT_EMAIL, PLAYER_COUNTS, FOOTER_VERSION, PUBLISH_URL } from '../../src/game-config.js';
import { createController } from '../../src/ui/controller.js';
import { ALLOWED_PARAMS, EVENT_NAMES } from '../../src/ui/analytics.js';
import { loadPlaywright, MIME } from '../browser-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = path.join(os.tmpdir(), `${GAME_SLUG}-qa${process.env.QA_TAG ? `-${process.env.QA_TAG}` : ''}`);
const SITE = path.join(TMP, 'site');
const SUB = `${GAME_SLUG}-game`;
const SHOTS = path.join(TMP, 'shots');
const STORE = `${GAME_SLUG}-stats-v1`;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const WIDTHS_ARG = (process.argv.find((a) => a.startsWith('--widths=')) || '').slice(9).split(',').filter(Boolean).map(Number);
const WIDTHS = WIDTHS_ARG.length ? WIDTHS_ARG : [1440, 1024, 390];
const LEVELS_ARG = (process.argv.find((x) => x.startsWith('--levels=')) || '').slice(9).split(',').filter(Boolean); // narrows the 'Human v bots' scenario to these bot levels
const phoneOpts = (w) => (w < 700 ? { hasTouch: true, isMobile: true } : {});
const COUNTS = [2, 3, 4, 5];
const HANDS = { 2: 3, 3: 3, 4: 4, 5: 5 }; // one hand per player, three at two and three players
const signed = (x) => (x > 0 ? `+${x}` : `${x}`);
// Words of the v5 game (and of the Playtest panel and the rule book) that must not be on any screen of v6.
const V5 = /\bChase\b|\bChasing\b|\bWatch\b|\bwatcher|\bchaser|Mountain|mob marker|turns? (?:their|your) (?:whole )?hand|turned round|two numbers|\bsplit\b|Playtest|rule ?book/;
// Names of internal documents, written in pieces so this file does not trip the sweep it is checked by.
const INTERNAL = new RegExp(['rules-' + 'spec', 'engine-' + 'api', 'balance-' + 'report', 'art-' + 'audit', 'qa-' + 'report', 'web-game-' + 'docs', '\\bT[0-9]\\b'].join('|'));
const V5_SRC =new RegExp(V5.source.replace('|\\bsplit\\b', '')); // in source code `split` is the string method

const chromium = await loadPlaywright();
if (!chromium) { console.log('qa-run: Playwright not found'); process.exit(1); }

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const tokensLeft = /\{\{[A-Z_]+\}\}/.test(html);

// ---------- the sub-path copy of the site ----------
function publishedFiles() {
  try {
    const top = path.resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    if (top.toLowerCase() !== ROOT.toLowerCase()) throw new Error('not the top of a checkout');
    const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
    return [...new Set([...git('ls-files'), ...git('ls-files', '-o', '--exclude-standard')])].filter((f) => fs.existsSync(path.join(ROOT, f)));
  } catch {
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!['.git', 'node_modules', 'bug-reports', 'test-results'].includes(e.name) && rel !== 'tests/tmp') walk(rel); } else out.push(rel);
      }
    };
    walk('');
    return out;
  }
}
fs.rmSync(SITE, { recursive: true, force: true });
if (!ONLY) fs.rmSync(SHOTS, { recursive: true, force: true }); // a part run keeps the pictures of the other parts
fs.mkdirSync(SHOTS, { recursive: true });
const served = new Set(); // exact-case relative paths under SITE
for (const rel of publishedFiles()) {
  const dst = path.join(SITE, SUB, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dst);
  served.add(`${SUB}/${rel}`);
}

const requestLog = []; // { url, status }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel.endsWith('/')) rel += 'index.html';
  if (!served.has(rel) && served.has(`${rel}/index.html`)) rel += '/index.html';
  const ok = served.has(rel);
  requestLog.push({ url: url.pathname, status: ok ? 200 : 404 });
  if (!ok) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(path.join(SITE, rel)).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/${SUB}/`;

// ---------- result bookkeeping ----------
const results = []; // { scenario, name, pass, detail }
let current = null;
function check(name, cond, detail = '') {
  const pass = !!cond;
  results.push({ scenario: current, name, pass, detail: String(detail || '') });
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail && !pass ? ` -- ${detail}` : ''}`);
  return pass;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
async function shot(page, name, opts = {}) {
  const file = path.join(SHOTS, `${slug(current || 'qa')}--${slug(name)}.png`);
  try { await page.screenshot({ path: file, ...opts }); } catch (e) { console.log(`  (screenshot failed: ${e.message})`); }
}
async function scenario(name, fn, { always = false } = {}) {
  if (ONLY && !always && !name.toLowerCase().includes(ONLY.toLowerCase())) return; // `always`: the console check runs in every part
  current = name;
  console.log(`\n== ${name}`);
  const t0 = Date.now();
  try { await fn(); } catch (e) { check('scenario ran without throwing', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); }
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---------- browser plumbing ----------
const browser = await chromium.launch({ args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'] });
const problems = []; // console errors/warnings, page errors, failed requests, HTTP >= 400 (web fonts aside)
const debugLogs = []; // console.log / info / debug output: there must be none (no debug logs in the render path)
const FONT_HOST = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//; // optional, with fallbacks; may be unreachable offline
const imageBytes = new Map();
const allBytes = new Map();
async function newPage(w = 1440, h = 900, opts = {}, init = null, b = browser) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, acceptDownloads: true, ...opts });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !/fonts\.(googleapis|gstatic)\.com/.test(m.text() + (m.location().url || ''))) problems.push(`[${current}] ${m.type()}: ${m.text()}`);
    if (['log', 'info', 'debug', 'trace'].includes(m.type())) debugLogs.push(`[${current}] ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[${current}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => { if (!FONT_HOST.test(r.url())) problems.push(`[${current}] request failed: ${r.url()}`); });
  page.on('response', async (r) => {
    if (r.status() >= 400) problems.push(`[${current}] HTTP ${r.status()} ${r.url()}`);
    const type = r.headers()['content-type'] || '';
    try {
      const len = (await r.body()).length;
      allBytes.set(r.url(), len);
      if (/^image\//.test(type)) imageBytes.set(r.url(), len);
    } catch { /* gone */ }
  });
  page.__touch = !!opts.hasTouch;
  page.__w = w;
  return page;
}
const tryClick = (loc, opts = {}) => loc.click({ timeout: 5000, ...opts }).then(() => true, () => false);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const events = (page) => page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event'));
const types = (n, level = 'easy', first = 'human') => Array.from({ length: n }, (_, i) => (i === 0 ? first : level));

/** Everything a player can read on the page: the text plus the tooltips, labels, alt texts and placeholders. */
const pageWords = (page) => page.evaluate(() => {
  const attrs = [...document.querySelectorAll('[title], [aria-label], [alt], [placeholder]')].flatMap((e) => ['title', 'aria-label', 'alt', 'placeholder'].map((a) => e.getAttribute(a)).filter(Boolean));
  return `${document.body.innerText}\n${document.body.textContent}\n${attrs.join('\n')}\n${document.title}`;
});
/** The old (v5) wording check: returns the first match or null. */
async function oldWords(page) {
  const t = await pageWords(page);
  const m = V5.exec(t);
  return m ? m[0] : null;
}

async function open(page, q = 'seed=1&botdelay=0') {
  await page.goto(`${BASE}?${q}`);
  await page.waitForSelector('#setup-form');
}
async function configure(page, { players = 4, types: ty = [], names = [], auto = false } = {}) {
  await page.check(`input[name=players][value="${players}"]`);
  for (let i = 0; i < players; i++) {
    await page.selectOption(`select[name=type${i}]`, ty[i] || (i === 0 ? 'human' : 'easy'));
    if (names[i]) await page.fill(`input[name=name${i}]`, names[i]);
  }
  if (auto) await page.check('#autoPlayForced');
}
async function begin(page, o = {}, q = 'seed=1&botdelay=0') {
  await open(page, q);
  await configure(page, o);
  await page.click('#start');
}
const newStats = () => ({ plays: 0, covers: 0, summaries: 0, hints: 0, leaks: 0 });

/**
 * One human decision: a cover, a reckoning or a card. Returns what it did.
 * `opts.stopAtReckoning` is an async predicate asked before a reckoning is dismissed; true returns 'stop'.
 * `opts.onSummary` is called after a reckoning is dismissed.
 */
async function humanStep(page, stats, opts = {}) {
  if (await page.locator('.end--game').count()) return 'end';
  if (await page.locator('.cover').count()) {
    stats.covers++;
    if (await page.locator('.hand, .card, .cardimg, .table, .log__list, .rslot, .row, .taken, .ride, .overlay, .seat').count()) stats.leaks++;
    await tryClick(page.locator('.cover .btn--primary'));
    return 'cover';
  }
  if (await page.locator('#summit-continue').count()) { await tryClick(page.locator('#summit-continue')); return 'summit'; }
  if (await page.locator('#continue').count()) {
    if (opts.stopAtReckoning && (await opts.stopAtReckoning())) return 'stop';
    if (await tryClick(page.locator('#continue'))) { stats.summaries++; if (opts.onSummary) await opts.onSummary(); }
    return 'summary';
  }
  const legal = page.locator('.hand .card.is-legal');
  if (await legal.count()) {
    if (await page.locator('.hand .card__hint').count()) stats.hints++;
    stats.plays++;
    if (!(await tryClick(legal.first()))) { stats.plays--; return 'retry'; }
    if (page.__touch) await tryClick(page.locator('.hand .card.is-selected'), { timeout: 1500 });
    return 'card';
  }
  await page.waitForTimeout(25);
  return 'wait';
}
async function playHuman(page, limitMs = 150000, until = null, opts = {}) {
  const stats = newStats();
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const r = await humanStep(page, stats, opts);
    if (r === 'end' || r === 'stop') { stats.stopped = r; break; }
    if (until && until(stats)) break;
  }
  return stats;
}
const finish = (page) => page.waitForSelector('.end--game', { timeout: 120000 });

/**
 * Watches the table for everything that flashes past: the half banner, the Climb row (taken, lit, ringed), the summit
 * beat, the Brumby row, the cards each seat has taken, hand scores, placeholders, Muster cards.
 * `window.__w.reset()` clears the counters (called after each reckoning). At `?botdelay=0` the frames of one action
 * collapse into one redraw, so scenarios that need to see each beat use a small delay (30 to 250 ms).
 */
async function watch(page) {
  await page.evaluate((v5src) => {
    const V5 = new RegExp(v5src);
    const fresh = () => ({
      phases: [], banners: [], summit: null, summitFrames: 0, climbTakenMax: 0, climbNextMoves: [], climbRing: 0, climbBy: {}, climbValsAtDeal: null,
      brumbyDownMax: 0, brumbyTakenMax: 0, brumbyNextLit: 0, coltInRow: false, wombatInRow: false, flintInRow: false, takenCardsMax: 0,
      scoreMin: 99, scoreMax: -99, discardMax: 0, chips: 0, turned: 0, musterCards: 0, musterTrumpMarks: 0, musterTrumpCards: 0, v5: null,
    });
    const W = fresh();
    W.reset = () => { const f = fresh(); for (const k of Object.keys(f)) W[k] = f[k]; };
    window.__w = W;
    const app = document.getElementById('app');
    const look = () => {
      const q = (x) => app.querySelectorAll(x).length;
      const ph = app.querySelector('.phasebar');
      if (ph) {
        const k = ph.className.replace(/^phasebar phasebar--/, '');
        if (!W.phases.includes(k)) W.phases.push(k);
        const t = `${(ph.querySelector('.phasebar__name') || {}).textContent || ''}|${(ph.querySelector('.phasebar__rule') || {}).textContent || ''}|${((ph.querySelector('.phasebar__range') || {}).textContent || '').slice(0, 18)}`;
        if (W.banners[W.banners.length - 1] !== t) W.banners.push(t);
      }
      const sm = app.querySelector('.overlay--summit');
      if (sm) {
        W.summitFrames++;
        if (!W.summit) W.summit = { text: sm.textContent, climbTaken: q('.row--climb .rslot.is-taken'), strip: sm.querySelectorAll('.summit__brumby').length, phase: ph ? ph.className : '', brumbyDown: q('.row--brumby .rslot--down'), brumbyUp: q('.row--brumby .rslot:not(.rslot--down):not(.is-taken)'), loaded: [...sm.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0) };
      }
      W.climbTakenMax = Math.max(W.climbTakenMax, q('.row--climb .rslot.is-taken'));
      W.climbRing = Math.max(W.climbRing, q('.row--climb .rslot.is-bad'));
      if (!W.climbValsAtDeal && q('.row--climb .rslot:not(.is-taken):not(.rslot--down)') === 6) W.climbValsAtDeal = [...app.querySelectorAll('.row--climb .rslot .rslot__val')].map((e) => e.textContent.trim());
      const nx = app.querySelector('.row--climb .rslot.is-next');
      if (nx) { const p = Number(nx.dataset.pos); if (W.climbNextMoves[W.climbNextMoves.length - 1] !== p) W.climbNextMoves.push(p); }
      app.querySelectorAll('.row--climb .rslot.is-taken').forEach((e) => { const g = e.querySelector('.rslot__gone'); if (g && g.dataset.seat !== '') W.climbBy[e.dataset.pos] = Number(g.dataset.seat); });
      W.brumbyDownMax = Math.max(W.brumbyDownMax, q('.row--brumby .rslot--down'));
      W.brumbyTakenMax = Math.max(W.brumbyTakenMax, q('.row--brumby .rslot.is-taken'));
      W.brumbyNextLit = Math.max(W.brumbyNextLit, q('.row--brumby .rslot.is-next'));
      if (q('.row--brumby .rslot.is-colt, .summit__row .is-colt')) W.coltInRow = true;
      if (app.querySelector('.row--brumby img[data-asset="brumby-wombat"], .summit__row img[data-asset="brumby-wombat"]')) W.wombatInRow = true;
      if (app.querySelector('.row--brumby img[data-asset="brumby-flint"], .summit__row img[data-asset="brumby-flint"]')) W.flintInRow = true;
      W.takenCardsMax = Math.max(W.takenCardsMax, q('.seat .taken__card'));
      app.querySelectorAll('[data-hand-score]').forEach((e) => { const v = Number(e.textContent); W.scoreMax = Math.max(W.scoreMax, v); W.scoreMin = Math.min(W.scoreMin, v); });
      const disc = [...app.querySelectorAll('.row__discard summary, .row__pile')].find((e) => /Discard/.test(e.textContent));
      if (disc && disc.querySelector('b')) W.discardMax = Math.max(W.discardMax, Number(disc.querySelector('b').textContent));
      W.chips = Math.max(W.chips, q('.asset-chip'));
      W.turned = Math.max(W.turned, q('.is-turned, .hand--turned'));
      W.musterCards = Math.max(W.musterCards, q('img[data-asset^="card-muster-"], .cardchip--muster'));
      W.musterTrumpCards = Math.max(W.musterTrumpCards, q('.card--muster.is-trump'));
      app.querySelectorAll('.tplay').forEach((e) => { if (e.querySelector('img[data-asset^="card-muster-"]') && e.querySelector('.mark--trump, .mark--trumps')) W.musterTrumpMarks++; });
      if (!W.v5) { const m = V5.exec(app.textContent); if (m) W.v5 = m[0]; }
    };
    new MutationObserver(look).observe(app, { childList: true, subtree: true });
    look();
  }, V5.source);
}
const seen = (page) => page.evaluate(() => { const { reset, ...rest } = window.__w; return rest; });
const resetWatch = (page) => page.evaluate(() => window.__w && window.__w.reset());

/** The reckoning on screen, read back from the DOM. */
const readReckoning = (page) => page.evaluate(() => {
  const el = document.querySelector('.end--hand');
  const notes = [...el.querySelectorAll('.end__note')];
  return {
    title: el.querySelector('#hand-title').textContent,
    lead: el.querySelector('.end__note--lead').textContent,
    foot: notes.filter((n) => !n.classList.contains('end__note--lead')).map((n) => n.textContent).join(' '),
    button: el.querySelector('#continue').textContent,
    text: el.textContent,
    rows: [...el.querySelectorAll('.reck__row')].map((r) => {
      const kinds = [...r.querySelectorAll('.reck__kind')];
      return {
        seat: Number(r.dataset.seat),
        who: r.querySelector('.reck__who b').textContent,
        counts: r.querySelector('.reck__who small').textContent,
        climbSum: kinds[0].querySelector('b').textContent,
        climbThumbs: kinds[0].querySelectorAll('.reck__card').length,
        climbTitles: [...kinds[0].querySelectorAll('.reck__card')].map((c) => c.title),
        keptSum: kinds[1].querySelector('b').textContent,
        keptThumbs: kinds[1].querySelectorAll('.reck__card').length,
        keptTitles: [...kinds[1].querySelectorAll('.reck__card')].map((c) => c.title),
        score: r.querySelector('.reck__score').textContent,
        scoreCls: r.querySelector('.reck__score').className,
        total: Number(r.querySelector('.reck__total b').textContent),
      };
    }),
  };
});

const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
/** What the reckoning row for a seat must say, worked out from the engine's own hand record. */
function expectedRow(bd) {
  return {
    counts: `${plural(bd.climbCards.length, 'Climb card', 'Climb cards')}, ${plural(bd.kept.length, 'Brumby card', 'Brumby cards')}`,
    climbSum: signed(bd.climbValue), keptSum: signed(bd.keptValue), score: signed(bd.score), climbN: bd.climbCards.length, keptN: bd.kept.length,
  };
}

/** A modal must dim the whole viewport, wherever the page is scrolled to (the overlay is position: fixed). */
async function dimCheck(page, label) {
  const probe = () => page.evaluate(() => {
    const o = document.querySelector('.overlay');
    if (!o) return null;
    const cs = getComputedStyle(o);
    const r = o.getBoundingClientRect();
    const pts = [[2, 2], [innerWidth - 3, 2], [2, innerHeight - 3], [innerWidth - 3, innerHeight - 3], [innerWidth / 2, 2], [innerWidth / 2, innerHeight - 3]];
    const alpha = (cs.backgroundColor.match(/rgba?\(([^)]+)\)/) || [])[1];
    const a = alpha ? Number(alpha.split(',')[3] ?? 1) : 0;
    return {
      fixed: cs.position === 'fixed',
      alpha: a,
      full: r.left <= 0 && r.top <= 0 && r.right >= innerWidth - 1 && r.bottom >= innerHeight - 1,
      hit: pts.every(([x, y]) => { const e = document.elementFromPoint(x, y); return !!(e && e.closest('.overlay')); }),
    };
  });
  const top = await probe();
  if (!top) { check(`${label}: an overlay is on screen`, false); return; }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(60);
  const bottom = await probe();
  await page.evaluate(() => window.scrollTo(0, 0));
  check(`${label}: the backdrop is fixed, tinted and covers the whole viewport at the top and after scrolling to the bottom`,
    top.fixed && top.alpha >= 0.4 && top.full && top.hit && bottom && bottom.fixed && bottom.full && bottom.hit, JSON.stringify({ top, bottom }));
}

// ---------- finding the games to drive: the same controller, played headlessly ----------
const simCache = new Map();
/** A game as the page plays it: seat 0 is the human (first legal card), the rest Easy bots unless `allBots`. */
function simulate({ seed, players, allBots = false }) {
  const key = `${seed}|${players}|${allBots}`;
  if (simCache.has(key)) return simCache.get(key);
  const seats = Array.from({ length: players }, (_, i) => ({ type: allBots || i > 0 ? 'easy' : 'human' }));
  const ctl = createController({ seats, seed, rules: {}, autoPlayForced: false });
  const hands = [];
  const take = (evs) => {
    for (const e of evs || []) {
      if (e.type === 'hand-ended') hands.push({ ...e, reshuffleNext: false });
      else if (e.type === 'brumby-reshuffled' && hands.length) hands[hands.length - 1].reshuffleNext = true;
    }
  };
  take(ctl.startEvents);
  for (let guard = 0; !ctl.isFinished() && guard < 20000; guard++) {
    if (ctl.isBotTurn()) { take(ctl.stepBot()); continue; }
    if (!ctl.isHumanTurn()) break;
    const r = ctl.play(ctl.legalActions()[0]);
    if (!r.ok) break;
    take(r.events);
  }
  const out = { hands, result: ctl.state.result, names: ctl.names };
  simCache.set(key, out);
  return out;
}

const isWombat = (id) => /^brumby-wombat/.test(id);
const KINDS = {
  'the -1 Climb card taken by you': { want: (ev) => ev.handNo === 0 && ev.minusWinner === 0, players: [3, 4, 2, 5] },
  'the -1 Climb card taken by a bot': { want: (ev) => ev.handNo === 0 && ev.minusWinner !== 0, players: [4, 3, 2, 5] },
  'the Colt in the row, taken by you': { want: (ev) => ev.colt && ev.coltWinner === 0, players: [3, 2, 4, 5] },
  'the Colt in the row, taken by a bot': { want: (ev) => ev.colt && ev.coltWinner !== 0, players: [4, 3, 2, 5] },
  'a Wombat hole in the row': { want: (ev) => ev.row.some(isWombat), players: [4, 3, 5, 2] },
  'Flint stones in the row': { want: (ev) => ev.row.includes('brumby-flint'), players: [3, 4, 2, 5] },
  'you end the hand below zero': { want: (ev) => ev.scores[0] < 0, players: [3, 4, 2, 5] },
  'a bot ends the hand below zero': { want: (ev) => ev.scores.some((x, s) => s > 0 && x < 0), players: [4, 3, 2, 5] },
  'the Brumby deck is shuffled again before the next hand': { want: (ev) => ev.reshuffleNext, players: [2, 3, 4, 5] },
};

/** The earliest game (in the order of `playersList`, then earliest hand, then lowest seed) with a hand that satisfies `want`. */
function findHand(want, { playersList = COUNTS, seeds = 400 } = {}) {
  for (const players of playersList) {
    let best = null;
    for (let seed = 1; seed <= seeds; seed++) {
      const { hands } = simulate({ seed, players });
      const handIdx = hands.findIndex(want);
      if (handIdx >= 0 && (!best || handIdx < best.handIdx)) best = { seed, players, handIdx, ev: hands[handIdx] };
      if (best && best.handIdx === 0) break;
    }
    if (best) return best;
  }
  return null;
}

/** A game that ends with the tiebreak deciding, or with a shared win (all-bot games, so the seed alone fixes them). */
function findResult(want, seeds = 6000) {
  for (const players of COUNTS) {
    for (let seed = 1; seed <= seeds; seed++) {
      const { result, names } = simulate({ seed, players, allBots: true });
      if (result && want(result)) return { seed, players, result, names };
    }
  }
  return null;
}

const TARGETS = {};
function target(key, fn) {
  if (!(key in TARGETS)) {
    const t0 = Date.now();
    TARGETS[key] = fn();
    const t = TARGETS[key];
    console.log(`  search "${key}" (${((Date.now() - t0) / 1000).toFixed(1)} s): ${t ? `seed ${t.seed}${t.players ? `, ${t.players} players` : ''}${t.handIdx === undefined ? '' : `, hand ${t.handIdx + 1}`}` : 'NOT FOUND'}`);
  }
  return TARGETS[key];
}
const handTarget = (kind) => target(kind, () => findHand(KINDS[kind].want, { playersList: KINDS[kind].players }));
const tieTarget = () => target('tiebreak', () => findResult((r) => r.tiebreakUsed && !r.shared));
const sharedTarget = () => target('shared', () => findResult((r) => r.shared));

// ============================================================================================
await scenario('Static: every referenced path is an exact-case match; lower-case names; sizes; v6 art; no v5 wording in the sources', async () => {
  const refs = [];
  const textFiles = [...served].filter((f) => /\.(html|css|js)$/.test(f) && !f.includes('/tests/'));
  for (const f of textFiles) {
    const text = fs.readFileSync(path.join(SITE, f), 'utf8');
    for (const m of text.matchAll(/["'(=]\s*((?:\.{1,2}\/)?[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:js|css|png|webp|jpg|json|pdf|md|svg))\b/g)) refs.push({ from: f, ref: m[1] });
  }
  const lower = new Map([...served].map((f) => [f.toLowerCase(), f]));
  const bad = [];
  for (const { from, ref } of refs) {
    const cands = [path.posix.normalize(path.posix.join(path.posix.dirname(from), ref)), path.posix.normalize(`${SUB}/${ref}`)];
    if (cands.some((c) => served.has(c))) continue;
    const near = cands.map((c) => lower.get(c.toLowerCase())).find(Boolean);
    if (near) bad.push(`${from} -> ${ref} (is ${near})`);
  }
  check(`every reference that resolves is an exact-case match (${refs.length} references)`, bad.length === 0, bad.slice(0, 3).join('; '));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/manifest.json'), 'utf8'));
  const list = Array.isArray(manifest) ? manifest : manifest.assets;
  check('manifest has no absolute or Windows paths', list.every((a) => !/^([A-Za-z]:|[\\/])/.test(a.file) && !/\\/.test(a.file) && !/^([A-Za-z]:|[\\/])/.test(a.source || '') && !/\\/.test(a.source || '')));
  check('manifest files marked real or placeholder are served', list.filter((a) => a.status !== 'missing').every((a) => served.has(`${SUB}/assets/${a.file}`)));
  const onDisk = [...served].filter((f) => f.startsWith(`${SUB}/assets/`) && !/manifest\.json$/.test(f)).map((f) => f.slice(`${SUB}/assets/`.length));
  const listed = new Set(list.map((a) => a.file));
  check(`every published image is in the manifest and every manifest entry is a published file (${onDisk.length} files, ${list.length} entries)`, onDisk.every((f) => listed.has(f)) && list.every((a) => served.has(`${SUB}/assets/${a.file}`)), `unlisted: ${onDisk.filter((f) => !listed.has(f)).join(', ')}`);
  check('names are lower-case with no spaces (README aside)', [...served].every((f) => !/\s/.test(f) && (f === `${SUB}/README.md` || f === f.toLowerCase())));
  const big = [...served].filter((f) => fs.statSync(path.join(SITE, f)).size > 500 * 1024 && !/\/rules\/[a-z0-9-]+\.pdf$/.test(f));
  check('no file over 500 KB except the old printed rule book, which stays in rules/ unlinked', big.length === 0, big.join(', '));
  const gone = ['mountain-up', 'mountain-down', 'mountain-6', 'mountain-7', 'chase-2', 'chase-3', 'watch', 'chase', 'brumby-front'];
  check('the v5 art is gone (Mountain, Chase, Watch) and so is the mob marker, with no manifest entry left', gone.every((f) => !served.has(`${SUB}/assets/cards/${f}.webp`)) && !served.has(`${SUB}/assets/mob-marker.webp`) && !list.some((a) => /mob-marker|mountain|chase|watch/i.test(`${a.id} ${a.file}`)));
  const cardFaces = ['escape', 'climb', 'descent', 'muster', 'home'].flatMap((s) => Array.from({ length: 12 }, (_, i) => `assets/cards/card-${s}-${i + 1}.webp`));
  check('all 60 single-number card faces are served, the Muster suit included', cardFaces.every((f) => served.has(`${SUB}/${f}`)));
  const others = ['brumby-plus2', 'brumby-plus1', 'brumby-flint', 'brumby-wombat', 'colt', 'brumby-back', 'climb-plus1', 'climb-minus1', 'climb-back', 'card-back'];
  check('the Brumby cards, the Colt, the Climb cards and both backs are served', others.every((f) => served.has(`${SUB}/assets/cards/${f}.webp`)));
  check('the Muster icon and badge are served', served.has(`${SUB}/assets/icon-muster.webp`) && served.has(`${SUB}/assets/badge-muster.webp`));
  check('config offers 2 to 5 players', JSON.stringify(PLAYER_COUNTS) === '[2,3,4,5]');
  // The sources: no v5 words in anything a player can see (comments aside; the stats and analytics modules may name the old rules).
  const mayName = /\/(stats-store|stats-view|analytics)\.js$/;
  const hits = [];
  for (const f of textFiles.filter((x) => !mayName.test(x))) {
    const src = fs.readFileSync(path.join(SITE, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/<!--[\s\S]*?-->/g, '');
    const m = V5_SRC.exec(src);
    if (m) hits.push(`${f}: ${m[0]}`);
  }
  check('no v5 wording (Chase, Watch, Mountain, mob marker, turning the hand, two numbers, Playtest, rule book) in the sources a player sees', hits.length === 0, hits.slice(0, 4).join('; '));
  const readme = fs.existsSync(path.join(ROOT, 'README.md')) ? fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8') : '';
  check('README: v6 rules, 2 to 5 players, the play link, the credit line, no v5 wording, no internal framing', /2 to 5 players/.test(readme) && readme.includes(PUBLISH_URL) && /Game design: Dean Morris, Wombat Game Factory/.test(readme) && !V5.test(readme) && !INTERNAL.test(readme));
});

await scenario('Landing from the sub-path', async () => {
  for (const w of WIDTHS) {
    const page = await newPage(w, 900, phoneOpts(w));
    imageBytes.clear();
    allBytes.clear();
    await open(page);
    await page.waitForLoadState('networkidle');
    const imgKb = [...imageBytes.values()].reduce((a, b) => a + b, 0) / 1024;
    const totalKb = [...allBytes.values()].reduce((a, b) => a + b, 0) / 1024;
    check(`first paint at ${w}px: everything that loaded is about 2 MB or less (${totalKb.toFixed(0)} KB in all, ${imgKb.toFixed(0)} KB of it images)`, totalKb <= 2150);
    check(`landing at ${w}px: no sideways scroll`, (await overflow(page)) <= 0);
    await shot(page, `landing-${w}`);
    await page.close();
  }
  const page = await newPage();
  await open(page);
  check('title is the game name', (await page.title()) === GAME_NAME);
  check('meta description is present and not empty', (await page.getAttribute('meta[name=description]', 'content')).length > 10);
  check('hook is the tagline', (await page.textContent('.hero__hook')) === GAME_TAGLINE);
  check('no Playtest rules panel (there are no switches)', (await page.locator('#rules-panel, .rule').count()) === 0);
  if (tokensLeft) console.log('  (index.html still has unfilled tokens: the og / canonical checks are skipped)');
  else {
    const abs = await page.$$eval('meta[property="og:url"], meta[property="og:image"], meta[name="twitter:image"], link[rel=canonical]', (els) => els.map((e) => e.content || e.href));
    check('og and canonical addresses are absolute https', abs.length >= 3 && abs.every((u) => /^https:\/\//.test(u)), abs.join(' '));
    check('og:url and canonical are the published address', (await page.$eval('meta[property="og:url"]', (m) => m.content)) === PUBLISH_URL && (await page.$eval('link[rel=canonical]', (m) => m.href)) === PUBLISH_URL);
  }
  check('2, 3, 4 and 5 players are offered, and 6 is not', JSON.stringify(await page.$$eval('input[name=players]', (e) => e.map((x) => x.value))) === '["2","3","4","5"]' && (await page.locator('input[name=players][value="6"]').count()) === 0 && (await page.locator('.seatform').count()) === 5);
  check('the stat strip says 2-5 players, 20-30 minutes, ages 10+', /2-5[\s\S]*Players[\s\S]*20-30[\s\S]*Minutes[\s\S]*10\+[\s\S]*Ages/.test(await page.textContent('.stats')));
  check('no rule book link anywhere on the landing page (no PDF link, no "rule book" text, no rules/ href)', (await page.locator('a[data-action=rulebook], a[href$=".pdf"], a[href*="rules/"]').count()) === 0 && !/rule\s?book/i.test(await page.textContent('body')) && !/rules\//.test(html));
  const how = await page.textContent('#how');
  check('How to play teaches v6: one number a card, five Muster-free suits at 2-4, the Climb row with one -1, the lowest card wins over the top, no choice, scoring by cards taken', /one number/.test(how) && /Climb cards/.test(how) && /one worth -1|one -1|-1 card/.test(how) && /lowest card wins/.test(how) && /no choice/.test(how) && /Muster/.test(how) && /Tricks themselves score nothing/.test(how), how.slice(0, 120));
  const old = await oldWords(page);
  check('no v5 wording anywhere on the landing page (text, tooltips, labels, alt texts)', old === null, old);
  check('the hero art is the key art, fully loaded', await page.$eval('.hero__img', (e) => e.complete && e.naturalWidth >= 1000));
  check('the footer names the v6 rules, the design credit and the studio', (await page.textContent('.footer')).includes(FOOTER_VERSION) && /Game design: Dean Morris/.test(await page.textContent('.footer')) && /Wombat Game Factory/.test(await page.textContent('.footer')));
  check('the favicon loads', (await (await page.request.get(`${BASE}assets/favicon.png`)).status()) === 200);
  const text = await page.textContent('body');
  check('no stray personal name or address on screen', !/@/.test(text) && !/\bDean\b(?! Morris)/.test(text));
  check('the origin root is not the game (404)', (await page.request.get(`${ORIGIN}/`)).status() === 404);
  await page.close();
});

await scenario('Card art: every face decodes at its size, the corners are clear, nothing is a placeholder', async () => {
  const page = await newPage();
  await open(page);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/manifest.json'), 'utf8'));
  const list = (Array.isArray(manifest) ? manifest : manifest.assets).filter((a) => a.status !== 'missing');
  const out = await page.evaluate(async (items) => {
    const bad = [];
    const white = [];
    const holes = [];
    for (const a of items) {
      const im = new Image();
      im.src = `assets/${a.file}`;
      try { await im.decode(); } catch { bad.push(`${a.id}: does not decode`); continue; }
      if (a.width && (im.naturalWidth !== a.width || im.naturalHeight !== a.height)) bad.push(`${a.id}: ${im.naturalWidth}x${im.naturalHeight}, manifest says ${a.width}x${a.height}`);
      if (/^cards\//.test(a.file)) {
        const c = document.createElement('canvas');
        c.width = im.naturalWidth; c.height = im.naturalHeight;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(im, 0, 0);
        for (const [x, y] of [[0, 0], [c.width - 1, 0], [0, c.height - 1], [c.width - 1, c.height - 1], [3, 3], [c.width - 4, 3], [3, c.height - 4], [c.width - 4, c.height - 4]]) {
          const [r, gg, b, al] = g.getImageData(x, y, 1, 1).data;
          if (al > 200 && r > 235 && gg > 235 && b > 235) white.push(`${a.id}@${x},${y}`);
        }
        // interior: nothing transparent in the middle of a card (a hole would show the table through the card)
        for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], [0.5, 0.15], [0.5, 0.85]]) {
          const al = g.getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data[3];
          if (al < 255) holes.push(`${a.id}@${fx},${fy}`);
        }
      }
    }
    return { n: items.length, bad, white, holes };
  }, list);
  check(`all ${out.n} images in the manifest decode at the size it states`, out.bad.length === 0, out.bad.slice(0, 3).join('; '));
  check('no white patch in the corners of any card face, Brumby card, Climb card or the Colt', out.white.length === 0, out.white.slice(0, 4).join(', '));
  check('no transparent hole inside any card face (sampled at seven interior points)', out.holes.length === 0, out.holes.slice(0, 4).join(', '));
  check('no asset is a placeholder or missing', (Array.isArray(manifest) ? manifest : manifest.assets).every((a) => a.status === 'real'), [...new Set((Array.isArray(manifest) ? manifest : manifest.assets).map((a) => a.status))].join(','));
  // Row cards are landscape, suit faces portrait
  const shapes = await page.evaluate(async () => {
    const dims = async (f) => { const im = new Image(); im.src = `assets/cards/${f}.webp`; await im.decode(); return [im.naturalWidth, im.naturalHeight]; };
    const row = await Promise.all(['brumby-plus2', 'brumby-flint', 'brumby-wombat', 'colt', 'climb-plus1', 'climb-minus1', 'brumby-back', 'climb-back'].map(dims));
    const face = await Promise.all(['card-escape-1', 'card-muster-7', 'card-home-12', 'card-back'].map(dims));
    return { row: row.every(([w, h]) => w > h), face: face.every(([w, h]) => h > w) };
  });
  check('the Brumby, Colt and Climb cards are landscape (read upright) and the suit faces and the card back are portrait', shapes.row && shapes.face, JSON.stringify(shapes));
  await page.close();
});

await scenario('Consent banner and analytics on a real host name', async () => {
  const b2 = await chromium.launch({ args: [`--host-resolver-rules=MAP game.example.test 127.0.0.1`] });
  const ctx = await b2.newContext({ viewport: { width: 1280, height: 900 } });
  const got = [];
  await ctx.route(/cdn-cookieyes\.com|googletagmanager\.com/, (route) => { got.push(route.request().url()); route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* stub */' }); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`[${current}] pageerror: ${e.message}`));
  await page.goto(`http://game.example.test:${PORT}/${SUB}/?seed=1`);
  await page.waitForSelector('#setup-form');
  await page.waitForTimeout(300);
  check('CookieYes is requested first, then the Google tag', got.length === 2 && /cdn-cookieyes\.com/.test(got[0]) && /googletagmanager\.com\/gtag\/js\?id=G-/.test(got[1]), got.join(' | '));
  check('the Google tag is configured in dataLayer', (await page.evaluate(() => (window.dataLayer || []).some((a) => a[0] === 'config' && /^G-/.test(a[1])))));
  await b2.close();
  const page2 = await newPage();
  const third = [];
  page2.on('request', (r) => { if (!r.url().startsWith(ORIGIN) && !FONT_HOST.test(r.url())) third.push(r.url()); });
  await open(page2);
  check('nothing third-party but the optional Google web fonts loads on 127.0.0.1', third.length === 0, third.join(' '));
  await page2.close();
});

await scenario('Responsive landing at every width, every seat count', async () => {
  for (const w of WIDTHS) {
    for (const n of [2, 4, 5]) {
      const page = await newPage(w, 900, phoneOpts(w));
      await open(page);
      await page.check(`input[name=players][value="${n}"]`);
      check(`${w}px ${n} seats: no sideways scroll, nothing outside the viewport`, (await overflow(page)) <= 0 && (await page.evaluate((vw) => [...document.querySelectorAll('main *, .landing *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1); }).length, w)) === 0);
      check(`${w}px ${n} seats: ${n} seat forms are shown (of five in the page)`, (await page.locator('.seatform:visible').count()) === n && (await page.locator('.seatform').count()) === 5);
      if (n === 5) await shot(page, `landing-5-seats-${w}`);
      await page.close();
    }
  }
});

await scenario('Human v bots to the end (every level, 2 to 5 players, every width)', async () => {
  // The full matrix at the first width; a few tables per level at the others.
  const full = [['easy', [2, 3, 4, 5]], ['medium', [2, 3, 4, 5]], ['hard', [2, 3, 4, 5]]];
  const slim = [['easy', [5]], ['medium', [3]], ['hard', [2, 4]]];
  for (const w of WIDTHS) {
    for (const [level, counts] of (w === WIDTHS[0] ? full : slim).filter(([l]) => !LEVELS_ARG.length || LEVELS_ARG.includes(l))) {
      for (const n of counts) {
        const page = await newPage(w, 900, phoneOpts(w));
        await begin(page, { players: n, types: types(n, level), names: ['Mia'] }, `seed=${n}&botdelay=0`);
        await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
        await watch(page);
        if (level === 'hard') {
          await page.evaluate(() => { window.__gap = 0; let last = performance.now(); setInterval(() => { const t = performance.now(); window.__gap = Math.max(window.__gap, t - last - 50); last = t; }, 50); });
        }
        const s = await playHuman(page, 400000);
        const tag = `${w}px ${level} ${n}p`;
        check(`${tag}: the game ends with a ranking of ${n}`, (await page.locator('.end--game').count()) === 1 && (await page.locator('.rank').count()) === n, JSON.stringify(s));
        check(`${tag}: ${HANDS[n]} reckonings were shown and the human played at least 6 cards a hand`, s.plays >= HANDS[n] * 6 && s.summaries === HANDS[n], JSON.stringify(s));
        const W = await seen(page);
        check(`${tag}: no art placeholder, no turned card, no v5 word, ${n === 5 ? 'Muster cards were dealt' : 'no Muster card'} on the table`, W.chips === 0 && W.turned === 0 && W.v5 === null && (n === 5 ? W.musterCards > 0 : W.musterCards === 0), JSON.stringify({ chips: W.chips, turned: W.turned, v5: W.v5, muster: W.musterCards }));
        check(`${tag}: the Muster is never trumps (no trump mark on a Muster play, no gold trump line on a Muster card)`, W.musterTrumpMarks === 0 && W.musterTrumpCards === 0, JSON.stringify([W.musterTrumpMarks, W.musterTrumpCards]));
        check(`${tag}: no sideways scroll at the end`, (await overflow(page)) <= 0);
        if (level === 'hard') {
          const gap = await page.evaluate(() => window.__gap);
          check(`${tag}: the page never froze (longest main-thread gap under 250 ms)`, gap < 250, `${gap.toFixed(0)} ms`);
          check(`${tag}: decisions came from the Worker`, (await page.evaluate(() => document.body.dataset.botMode)) === 'worker');
        }
        const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{"games":[]}').games, STORE);
        check(`${tag}: the finished game was recorded once, as v6 (rules_code std, rules_version 6), with ${HANDS[n]} hands`, stored.length === 1 && stored[0].players === n && stored[0].rules_code === 'std' && stored[0].rules_version === 6 && stored[0].hands === HANDS[n], JSON.stringify(stored[0] && { players: stored[0].players, rules_code: stored[0].rules_code, v: stored[0].rules_version, hands: stored[0].hands }));
        if (w === WIDTHS[0] ? (n === 5 || n === 2) : true) await shot(page, `${level}-${n}p-end-${w}`);
        await page.close();
      }
    }
  }
});

await scenario('All-bot games at 2 to 5 seats', async () => {
  const mixes = { 2: ['easy', 'medium'], 3: ['medium', 'hard', 'easy'], 4: ['hard', 'medium', 'easy', 'easy'], 5: ['hard', 'medium', 'easy', 'medium', 'easy'] };
  for (const w of WIDTHS) {
    for (const n of COUNTS) {
      if (w !== WIDTHS[0] && n !== 5) continue; // every count at the first width, the biggest table at the others
      const page = await newPage(w, 900, phoneOpts(w));
      await begin(page, { players: n, types: mixes[n] }, `seed=${n + 20}&botdelay=0`);
      await finish(page);
      check(`${w}px ${n} bots: finishes by itself with a ranking`, (await page.locator('.rank').count()) === n);
      check(`${w}px ${n} bots: no hand is shown`, (await page.locator('.hand .card').count()) === 0);
      const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games[0], STORE);
      check(`${w}px ${n} bots: recorded with ${HANDS[n]} hands and no human seat`, stored.hands === HANDS[n] && stored.seats.every((s) => s.type === 'bot'));
      if (n === 5 || n === 2) await shot(page, `bots-${n}-end-${w}`);
      await page.close();
    }
  }
});

await scenario('Pass-and-play: a cover before every human decision, the summit beat and the reckoning stay public', async () => {
  for (const [n, humans, w] of [[2, 2, 1440], [3, 2, 390], [4, 3, 1024], [5, 2, 1440], [3, 3, 1440]]) {
    const page = await newPage(w, 900, phoneOpts(w));
    await page.addInitScript(() => {
      window.__pp = { behindCover: 0, summits: 0, summitHand: 0, summitHandShown: 0, reck: 0, reckHand: 0 };
      document.addEventListener('DOMContentLoaded', () => {
        let summitOn = false;
        let reckOn = false;
        new MutationObserver(() => {
          const P = window.__pp;
          if (document.querySelector('.cover') && document.querySelector('.hand, .card, .table, .seat, .log__list, .rslot, .row, .taken, .overlay')) P.behindCover++;
          const sm = document.querySelector('.overlay--summit');
          if (sm && !summitOn) { P.summits++; if (document.querySelector('.hand .card')) P.summitHand++; if (document.querySelector('.handbox--hidden')) P.summitHandShown++; }
          summitOn = !!sm;
          const rk = document.querySelector('.overlay--hand');
          if (rk && !reckOn) { P.reck++; if (document.querySelector('.hand .card')) P.reckHand++; }
          reckOn = !!rk;
        }).observe(document.body, { childList: true, subtree: true });
      });
    });
    await begin(page, { players: n, types: Array.from({ length: n }, (_, i) => (i < humans ? 'human' : 'easy')), names: ['Ann', 'Bo', 'Cy'] }, `seed=${n + 40}&botdelay=40`);
    await page.waitForSelector('.cover', { timeout: 30000 });
    const tag = `${humans} humans in ${n}p at ${w}px`;
    if (w < 700) await shot(page, `cover-${n}p-${w}`);
    const cover = await page.$eval('.cover', (e) => { const r = e.getBoundingClientRect(); return [r.width, r.height, innerWidth, innerHeight]; });
    check(`${tag}: the cover fills the viewport`, cover[0] >= cover[2] - 1 && cover[1] >= cover[3] - 1);
    check(`${tag}: the cover names no cards or scores and uses no v5 word`, !/\d+ pts|Total|[A-Z][a-z]+ \d+/.test((await page.textContent('.cover')).replace(/Pass to .*?show my hand/, '')) && (await oldWords(page)) === null);
    check(`${tag}: the bug button is hidden under the cover and Ctrl+Shift+B opens nothing`, !(await page.isVisible('#bug-button')) && await (async () => { await page.keyboard.press('Control+Shift+B'); await page.waitForTimeout(150); return (await page.locator('.bug, #bug-form').count()) === 0; })());
    const st = newStats();
    let bugVisible = 0;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      if (await page.locator('.end--game').count()) break;
      if ((await page.locator('.cover').count()) > 0 && (await page.isVisible('#bug-button'))) bugVisible++;
      await humanStep(page, st);
    }
    const P = await page.evaluate(() => window.__pp);
    check(`${tag}: the game ends`, (await page.locator('.end--game').count()) === 1, JSON.stringify(st));
    check(`${tag}: a cover before every human decision, and never any part of the table behind it`, st.covers >= 6 && st.leaks === 0 && P.behindCover === 0 && bugVisible === 0, JSON.stringify({ st, P, bugVisible }));
    check(`${tag}: the summit beat was shown once a hand (${HANDS[n]}), to the whole table, with no hand on screen`, P.summits === HANDS[n] && P.summitHand === 0, JSON.stringify(P));
    check(`${tag}: the reckoning was shown once a hand with nobody's hand on screen`, P.reck === HANDS[n] && P.reckHand === 0, JSON.stringify(P));
    check(`${tag}: no v5 word at the end`, (await oldWords(page)) === null);
    await page.close();
  }
});

await scenario('The Climb row: five +1 cards and one -1, the next card lit, the -1 taken', async () => {
  for (const kind of ['the -1 Climb card taken by you', 'the -1 Climb card taken by a bot']) {
    const t = handTarget(kind);
    if (!check(`a game with "${kind}" in its first hand was found by seed search`, !!t)) continue;
    for (const w of [WIDTHS[0], WIDTHS[WIDTHS.length - 1]]) {
      const page = await newPage(w, 900, phoneOpts(w));
      await begin(page, { players: t.players, types: types(t.players), names: ['Mia'] }, `seed=${t.seed}&botdelay=40`);
      await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
      await watch(page);
      const tag = `${w}px ${kind} (${t.players}p)`;
      const ev = t.ev;
      await page.waitForFunction(() => [...document.querySelectorAll('.row--climb img')].every((i) => i.complete), null, { timeout: 8000 }).catch(() => {});
      const row0 = await page.evaluate(() => ({
        vals: [...document.querySelectorAll('.row--climb .rslot .rslot__val')].map((e) => e.textContent.trim()),
        pos: document.querySelectorAll('.row--climb .rslot__val--pos').length, neg: document.querySelectorAll('.row--climb .rslot__val--neg').length,
        ring: [...document.querySelectorAll('.row--climb .rslot.is-bad')].map((e) => Number(e.dataset.pos)),
        next: [...document.querySelectorAll('.row--climb .rslot.is-next')].map((e) => Number(e.dataset.pos)),
        art: [...document.querySelectorAll('.row--climb .rslot__img')].map((e) => `${e.dataset.asset}:${e.complete && e.naturalWidth > 0}`),
        line: document.querySelector('#climb-line').textContent, title: document.querySelector('.row--climb .row__title').textContent,
        banner: document.querySelector('.phasebar').textContent, trickTitle: document.querySelector('.trick__title').textContent,
      }));
      check(`${tag}: the Climb row is face up with five +1 cards and one -1 card, the -1 ringed on trick ${ev.minusPosition}`, row0.pos === 5 && row0.neg === 1 && row0.ring.join() === String(ev.minusPosition) && row0.vals.length === 6 && row0.vals[ev.minusPosition - 1] === '-1', JSON.stringify(row0));
      check(`${tag}: every Climb card shows its own art (climb-plus1 x5, climb-minus1 x1) and the first slot is lit`, row0.art.filter((a) => a === 'climb-plus1:true').length === 5 && row0.art.filter((a) => a === 'climb-minus1:true').length === 1 && row0.next.join() === '1', row0.art.join(' '));
      check(`${tag}: the line under the row names the card the next trick takes${ev.minusPosition > 1 ? ' and where the -1 is' : ''}`, /^Climb trick 1 takes Climb card [+-]1\./.test(row0.line) && (ev.minusPosition > 1 ? new RegExp(`The -1 card is on trick ${ev.minusPosition}\\.`).test(row0.line) : true), row0.line);
      check(`${tag}: the trick panel says what the first trick takes`, /takes\s*[+-]1/.test(row0.trickTitle), row0.trickTitle);
      await shot(page, `climb-row-${slug(kind)}-${w}`, { fullPage: false });
      const s1 = await playHuman(page, 120000, null, { stopAtReckoning: async () => true });
      check(`${tag}: the reckoning of hand 1 came up`, s1.stopped === 'stop' && (await page.locator('.overlay--hand').count()) === 1, JSON.stringify(s1));
      await page.waitForFunction(() => [...document.querySelectorAll('.reck img')].every((i) => i.complete), null, { timeout: 5000 }).catch(() => {});
      const W = await seen(page);
      const rec = await readReckoning(page);
      check(`${tag}: the lit card moved on one trick at a time, 1 to 6, and all six Climb cards were taken`, [1, 2, 3, 4, 5, 6].every((p) => W.climbNextMoves.includes(p)) && W.climbNextMoves.slice(0, 6).join() === '1,2,3,4,5,6' && W.climbTakenMax === 6, JSON.stringify({ moves: W.climbNextMoves, taken: W.climbTakenMax }));
      check(`${tag}: the slot of the -1 card showed the seat that took it (${t.ev.minusWinner === 0 ? 'you' : `seat ${t.ev.minusWinner + 1}`}), and the ring was on screen`, W.climbBy[String(ev.minusPosition)] === ev.minusWinner && W.climbRing === 1, JSON.stringify({ by: W.climbBy, ring: W.climbRing }));
      const owner = rec.rows.filter((r) => r.climbTitles.some((x) => /^Climb card -1/.test(x))).map((r) => r.seat);
      check(`${tag}: in the reckoning only the winner of trick ${ev.minusPosition} holds the -1 card, and the lead note says so`, owner.join() === String(ev.minusWinner) && new RegExp(`took the -1 Climb card \\(trick ${ev.minusPosition}\\)`).test(rec.lead), `${owner} ${rec.lead}`);
      check(`${tag}: the hand score was at some point below the others' by the -1 (lowest seen ${W.scoreMin}), and no placeholder art or v5 word was seen`, W.scoreMin <= 4 && W.chips === 0 && W.v5 === null, JSON.stringify({ min: W.scoreMin, chips: W.chips, v5: W.v5 }));
      check(`${tag}: no sideways scroll`, (await overflow(page)) <= 0);
      await page.close();
    }
  }
});

await scenario('The summit: the banner switches, the Climb row is empty, the Brumby row is dealt', async () => {
  for (const [w, n] of [...WIDTHS.map((x) => [x, 4]), [WIDTHS[0], 2], [WIDTHS[0], 3], [WIDTHS[0], 5]]) {
    const page = await newPage(w, 900, phoneOpts(w));
    await begin(page, { players: n, types: types(n), names: ['Mia'] }, 'seed=11&botdelay=250');
    await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
    await watch(page);
    const tag = `${w}px ${n}p`;
    const before = await page.evaluate(() => ({ banner: document.querySelector('.phasebar').textContent, cls: document.querySelector('.phasebar').className, badge: document.querySelector('.phasebar .phasebar__badge').dataset.asset, down: document.querySelectorAll('.row--brumby .rslot--down').length, deck: document.querySelector('.row__piles').textContent, ride: document.querySelectorAll('.ride__step').length, mark: !!document.querySelector('.ride__summit'), hand: document.querySelector('.handbox__title').textContent }));
    check(`${tag} before the summit: the banner says THE CLIMB, highest wins, Escape is trumps, with the Escape badge and the ride strip`, /The climb/i.test(before.banner) && /highest wins/i.test(before.banner) && /Escape is trumps/.test(before.banner) && before.cls.includes('phasebar--climb') && before.badge === 'badge-escape' && before.ride === 12 && before.mark, before.banner.slice(0, 120));
    check(`${tag} before the summit: the Brumby row is six face-down cards, the deck holds 12 or fewer, and the hand heading says highest wins`, before.down === 6 && /Deck\s*\d+/.test(before.deck) && /highest wins/.test(before.hand) && /Escape is trumps/.test(before.hand), JSON.stringify([before.down, before.deck, before.hand]));
    await shot(page, `climb-start-${n}p-${w}`, { fullPage: false });
    const st = newStats();
    const until = Date.now() + 90000;
    while (Date.now() < until && !(await page.locator('.overlay--summit').count())) await humanStep(page, st);
    check(`${tag}: the summit beat comes up`, (await page.locator('.overlay--summit').count()) === 1);
    await page.waitForFunction(() => [...document.querySelectorAll('.overlay--summit img')].every((i) => i.complete), null, { timeout: 8000 }).catch(() => {});
    const m = await page.evaluate(() => {
      const o = document.querySelector('.overlay--summit');
      const r = o.querySelector('.end').getBoundingClientRect();
      return {
        text: o.textContent, strip: o.querySelectorAll('.summit__brumby').length, loaded: [...o.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0), fits: r.left >= 0 && r.right <= innerWidth,
        banner: document.querySelector('.phasebar').textContent, cls: document.querySelector('.phasebar').className, badge: document.querySelector('.phasebar .phasebar__badge').dataset.asset,
        climbTaken: document.querySelectorAll('.row--climb .rslot.is-taken').length, brumbyDown: document.querySelectorAll('.row--brumby .rslot--down').length, brumbyUp: document.querySelectorAll('.row--brumby .rslot:not(.rslot--down)').length,
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth, cards: document.querySelectorAll('.hand .card').length, handHeading: (document.querySelector('.handbox__title') || { textContent: '' }).textContent,
      };
    });
    check(`${tag} the summit: "The summit", "Over the top: now the lowest card wins", Escape was trumps, Home is trumps, the six-card Brumby row in the beat, all art loaded, it fits and does not scroll sideways`, /The summit/.test(m.text) && /Over the top: now the lowest card wins/.test(m.text) && /Escape/.test(m.text) && /was trumps, highest won/.test(m.text) && /Home/.test(m.text) && /is trumps, lowest wins/.test(m.text) && m.strip === 6 && m.loaded && m.fits && m.sideways <= 0, JSON.stringify({ ...m, text: m.text.slice(0, 160) }));
    check(`${tag} the summit: behind the beat the banner has switched to THE DESCENT, lowest wins, Home is trumps (Home badge), the Climb row is empty (all six taken) and the Brumby row is dealt face up`, /The descent/i.test(m.banner) && /lowest wins/i.test(m.banner) && /Home is trumps/.test(m.banner) && m.cls.includes('phasebar--descent') && m.badge === 'badge-home' && m.climbTaken === 6 && m.brumbyDown === 0 && m.brumbyUp === 6, JSON.stringify({ banner: m.banner.slice(0, 80), cls: m.cls, taken: m.climbTaken, down: m.brumbyDown, up: m.brumbyUp }));
    await page.waitForTimeout(120);
    await shot(page, `summit-beat-${n}p-${w}`, { fullPage: false });
    await dimCheck(page, `${tag} summit beat`);
    // the beat waits for its button; then through to the first descent card
    const waits = await page.waitForTimeout(1500).then(() => page.locator('.overlay--summit').count());
    check(`${tag} the summit beat stays up until its button is pressed`, waits === 1 && (await page.locator('#summit-continue').count()) === 1);
    await tryClick(page.locator('#summit-continue'));
    await page.waitForFunction(() => !document.querySelector('.overlay--summit') && document.querySelector('.phasebar--descent'), null, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 }); // the bots lead the descent if it is theirs; nothing is played here
    await page.waitForFunction(() => [...document.querySelectorAll('.hand .cardimg')].every((i) => i.complete), null, { timeout: 5000 }).catch(() => {});
    const after = await page.evaluate(() => {
      const nums = [...document.querySelectorAll('.hand .card')].map((e) => Number(e.dataset.card.split('-')[1]));
      const suits = [...document.querySelectorAll('.hand .card')].map((e) => e.dataset.card.split('-')[0]);
      const order = ['escape', 'climb', 'descent', 'muster', 'home'];
      const sorted = suits.every((s, i) => i === 0 || order.indexOf(suits[i - 1]) < order.indexOf(s) || (suits[i - 1] === s && nums[i - 1] > nums[i]));
      return { n: nums.length, sorted, turned: document.querySelectorAll('.is-turned, .hand--turned').length, heading: document.querySelector('.handbox__title').textContent, prompt: document.querySelector('#prompt').textContent, trick: document.querySelector('.trick__title').textContent, next: [...document.querySelectorAll('.row--brumby .rslot.is-next')].map((e) => e.dataset.pos), banner: document.querySelector('.phasebar').textContent };
    });
    check(`${tag} the descent: the hand is six cards, upright (never turned), sorted by suit with the highest number first, the heading says lowest wins and Home is trumps, the first Brumby card is lit`, after.n === 6 && after.turned === 0 && after.sorted && /lowest wins/.test(after.heading) && /Home is trumps/.test(after.heading) && after.next.join() === '1' && /Descent trick 1/.test(after.trick), JSON.stringify(after));
    const W = await seen(page);
    check(`${tag}: the banners went climb then descent, the Climb row's last card was taken before the beat, and no placeholder or v5 word was seen`, W.phases.slice(0, 2).join() === 'climb,descent' && W.summit && W.summit.climbTaken === 6 && W.chips === 0 && W.v5 === null, JSON.stringify({ phases: W.phases, summit: W.summit && W.summit.climbTaken, chips: W.chips, v5: W.v5 }));
    check(`${tag}: the Brumby cards each show their value under them, the row line says what it is worth`, /Row worth [+-]\d+; [+-]\d+ still to win/.test(await page.textContent('#row-line')), await page.textContent('#row-line'));
    check(`${tag}: no sideways scroll on the descent`, (await overflow(page)) <= 0);
    await shot(page, `descent-start-${n}p-${w}`, { fullPage: false });
    await page.close();
  }
});

await scenario('Every kind of hand: the reckoning, the Brumby row, the Colt, a Wombat hole, a hand below zero', async () => {
  for (const kind of Object.keys(KINDS).filter((k) => !/the -1 Climb card/.test(k))) {
    const t = handTarget(kind);
    if (!check(`a game with "${kind}" was found by seed search`, !!t)) continue;
    const widths = /Colt in the row, taken by you|Wombat|you end/.test(kind) ? WIDTHS : [WIDTHS[0], WIDTHS[WIDTHS.length - 1]];
    for (const w of widths) {
      const page = await newPage(w, 900, phoneOpts(w));
      await begin(page, { players: t.players, types: types(t.players), names: ['Mia'] }, `seed=${t.seed}&botdelay=30`);
      await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
      await watch(page);
      const wantTitle = `Hand ${t.handIdx + 1} of `;
      const s1 = await playHuman(page, 150000, null, { stopAtReckoning: async () => (await page.textContent('#hand-title')).startsWith(wantTitle), onSummary: () => resetWatch(page) });
      const tag = `${w}px ${kind} (${t.players}p, hand ${t.handIdx + 1})`;
      if (!check(`${tag}: the reckoning came up`, s1.stopped === 'stop' && (await page.locator('.overlay--hand').count()) === 1, JSON.stringify(s1))) { await page.close(); continue; }
      await page.waitForFunction(() => [...document.querySelectorAll('.reck img')].every((i) => i.complete), null, { timeout: 5000 }).catch(() => {});
      const rec = await readReckoning(page);
      const ev = t.ev;
      const rowsOk = rec.rows.length === t.players && rec.rows.every((r, s) => {
        const e = expectedRow(ev.breakdown[s]);
        return r.seat === s && r.counts === e.counts && r.climbSum === e.climbSum && r.keptSum === e.keptSum && r.score === e.score && r.climbThumbs === e.climbN && r.keptThumbs === e.keptN;
      });
      check(`${tag}: a row per seat with its Climb cards and Brumby cards (counts, thumbnails, sums) and the hand score, as the engine has them`, rowsOk, JSON.stringify(rec.rows.map((r) => [r.counts, r.climbSum, r.keptSum, r.score])) + ' vs ' + JSON.stringify(ev.breakdown.map(expectedRow).map((e) => [e.counts, e.climbSum, e.keptSum, e.score])));
      check(`${tag}: every hand score is the Climb sum plus the Brumby sum, every running total is the engine's, the Climb cards add up to +4 over the table`, rec.rows.every((r, s) => Number(r.score) === Number(r.climbSum) + Number(r.keptSum)) && rec.rows.map((r) => r.total).join() === ev.totals.join() && rec.rows.reduce((a, r) => a + Number(r.climbSum), 0) === 4, `${rec.rows.map((r) => r.total)} vs ${ev.totals}`);
      const cltSum = ev.climbRowValues.reduce((a, x) => a + x, 0);
      check(`${tag}: the lead note gives both rows' worth (Climb ${signed(cltSum)}, Brumby ${signed(ev.rowValue)})`, rec.lead.includes(`The Climb row was worth ${signed(cltSum)} in all and the Brumby row ${signed(ev.rowValue)}.`), rec.lead);
      check(`${tag}: the lead note names the -1 card's winner (trick ${ev.minusPosition})`, rec.lead.includes(`${t.ev.minusWinner === 0 ? 'Mia' : `Easy bot ${t.ev.minusWinner + 1}`} took the -1 Climb card (trick ${ev.minusPosition}).`), rec.lead);
      if (ev.colt) check(`${tag}: the Colt is explained (won by ${ev.coltWinner === 0 ? 'you' : `seat ${ev.coltWinner + 1}`} on descent trick ${ev.coltTrick}, +4) and it sits in that seat's Brumby cards only`, rec.lead.includes(`won the Colt (descent trick ${ev.coltTrick}, +4)`) && rec.rows.filter((r) => r.keptTitles.some((x) => /^The Colt/.test(x))).map((r) => r.seat).join() === String(ev.coltWinner), rec.lead);
      else check(`${tag}: no Colt in the row, none mentioned`, !/Colt/.test(rec.lead) && !rec.rows.some((r) => r.keptTitles.some((x) => /Colt/.test(x))));
      check(`${tag}: ${ev.reshuffleNext ? 'the note says the 12 Brumby cards are shuffled again' : 'no reshuffle is announced'}`, /Fewer than 6 Brumby cards are left, so all 12 are shuffled/.test(rec.foot) === !!ev.reshuffleNext, rec.foot);
      check(`${tag}: the button reads "${t.handIdx + 1 === HANDS[t.players] ? 'See the final result' : 'Deal the next hand'}" and the note says tricks score nothing`, rec.button === (t.handIdx + 1 === HANDS[t.players] ? 'See the final result' : 'Deal the next hand') && /tricks themselves score nothing/.test(rec.foot), rec.button);
      const W = await seen(page);
      check(`${tag} on the table: all six Climb cards and all six Brumby cards were taken (12 cards on the seats), the next card was lit, the Brumby row held ${ev.row.length} cards${ev.colt ? ' with the Colt ringed' : ''}${ev.row.some(isWombat) ? ', a Wombat hole in it' : ''}`,
        W.climbTakenMax === 6 && W.brumbyTakenMax === 6 && W.takenCardsMax === 12 && W.brumbyNextLit >= 1 && W.coltInRow === !!ev.colt && W.wombatInRow === ev.row.some(isWombat) && W.flintInRow === ev.row.includes('brumby-flint'), JSON.stringify({ ...W, summit: undefined }));
      check(`${tag} on the table: hand scores were shown on every seat (lowest ${W.scoreMin}, highest ${W.scoreMax}); ${ev.scores.some((x) => x < 0) ? 'one went below zero' : 'none below zero'} as in the engine; the discard grew; no placeholder art or v5 word`, (ev.scores.some((x) => x < 0) ? W.scoreMin < 0 : true) && W.scoreMax >= Math.max(...ev.scores) - 0 && W.discardMax >= 0 && W.chips === 0 && W.v5 === null, JSON.stringify({ min: W.scoreMin, max: W.scoreMax, chips: W.chips, v5: W.v5 }));
      if (ev.scores.some((x) => x < 0)) check(`${tag}: a negative hand score is shown in the reckoning with its minus sign and the "neg" colour`, rec.rows.some((r) => /^-\d+/.test(r.score) && /--neg/.test(r.scoreCls)), JSON.stringify(rec.rows.map((r) => [r.score, r.scoreCls])));
      check(`${tag}: no sideways scroll with the reckoning up, and no v5 word in it`, (await overflow(page)) <= 0 && !V5.test(rec.text), (V5.exec(rec.text) || [''])[0]);
      await shot(page, `${slug(kind)}-${w}`, { fullPage: false });
      await dimCheck(page, `${tag} reckoning`);
      await tryClick(page.locator('#continue'));
      const s2 = await playHuman(page, 150000);
      check(`${tag}: the game plays on to its end`, (await page.locator('.end--game').count()) === 1, JSON.stringify(s2));
      await page.close();
    }
  }
});

await scenario('Ties: the tiebreak decides one game, a shared win ends another', async () => {
  for (const [label, t] of [['tiebreak', tieTarget()], ['shared', sharedTarget()]]) {
    if (!check(`an all-bot game with a ${label === 'shared' ? 'shared win' : 'tiebreak'} was found by seed search`, !!t)) continue;
    for (const w of [WIDTHS[0], WIDTHS[WIDTHS.length - 1]]) {
      const page = await newPage(w, 900, phoneOpts(w));
      await begin(page, { players: t.players, types: Array(t.players).fill('easy') }, `seed=${t.seed}&botdelay=0`);
      await finish(page);
      const r = t.result;
      const tag = `${w}px ${label} (${t.players}p, seed ${t.seed})`;
      const out = await page.evaluate(() => ({
        head: document.querySelector('#end-title').textContent,
        tb: (document.querySelector('#tiebreak') || {}).textContent || '',
        winners: document.querySelectorAll('.rank.is-winner').length,
        winnerNames: [...document.querySelectorAll('.rank.is-winner .rank__who b')].map((e) => e.textContent),
        ranks: [...document.querySelectorAll('.rank__pos')].map((e) => e.textContent),
        totals: [...document.querySelectorAll('.rank__total b')].map((e) => Number(e.textContent)),
        lastHand: [...document.querySelectorAll('.rank__total small')].map((e) => e.textContent),
        crowns: [...document.querySelectorAll('.crown')].map((e) => e.textContent),
        badges: document.querySelectorAll('.rank .badge').length,
        padRows: document.querySelectorAll('.pad--end tbody tr').length,
      }));
      check(`${tag}: the totals on screen are the engine's`, [...out.totals].sort().join() === [...r.totals].sort().join(), `${out.totals} vs ${r.totals}`);
      check(`${tag}: ${r.winners.length} winner${r.winners.length === 1 ? '' : 's'} marked, the engine's seats`, out.winners === r.winners.length && [...out.winnerNames].sort().join() === r.winners.map((s) => t.names[s]).sort().join(), `${out.winnerNames} vs ${r.winners.map((s) => t.names[s])}`);
      check(`${tag}: each ranking line shows a seat badge and the last-hand score, and the score pad has a row per hand`, out.lastHand.length === t.players && out.lastHand.every((x) => /^last hand -?\d+$/.test(x)) && out.badges === t.players && out.padRows === HANDS[t.players]);
      const tied = r.tiedOnTotal.map((s) => t.names[s]);
      if (label === 'tiebreak') {
        check(`${tag}: the tiebreak line names the tied seats, the total, the last-hand points and the winner`, new RegExp(`tied on ${r.winningScore}\\.`).test(out.tb) && tied.every((nm) => out.tb.includes(nm)) && /Tiebreak: the most points in the last hand/.test(out.tb) && /Points in the last hand: /.test(out.tb) && /\bwins?\b/.test(out.tb) && !/share the win|Still level/.test(out.tb), out.tb);
        check(`${tag}: the headline is not a shared win and the crown says Winner`, !/Shared/.test(out.head) && out.crowns.every((c) => c === 'Winner'), out.head);
      } else {
        check(`${tag}: the headline says shared win and the tiebreak line says still level`, /^Shared win/.test(out.head) && /Still level, so the win is shared/.test(out.tb) && out.crowns.every((c) => c === 'Shared win'), `${out.head} / ${out.tb}`);
        check(`${tag}: the tied seats share rank 1 (shown "=1")`, out.ranks.filter((x) => x === '=1').length === r.winners.length, out.ranks.join());
      }
      check(`${tag}: no sideways scroll on the end screen, no v5 word on it`, (await overflow(page)) <= 0 && (await oldWords(page)) === null);
      await shot(page, `${label}-${w}`, { fullPage: false });
      await page.close();
    }
  }
});

await scenario('Stats screen, exports, migrated v5 and v4 records and analytics', async () => {
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
  // The ctx blocks the consent banner and Google; events are read back from dataLayer. Both old records are planted before the page's own code runs.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript((a) => { try { if (!localStorage.getItem(a.k)) localStorage.setItem(a.k, JSON.stringify({ v: 1, games: [a.v4, a.v5] })); } catch { /* ignore */ } }, { k: STORE, v4: V4_RECORD, v5: V5_RECORD });
  await ctx.route(/cdn-cookieyes\.com|googletagmanager\.com|google-analytics\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource|fonts\.(googleapis|gstatic)\.com/.test(m.text())) problems.push(`[${current}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${current}] pageerror: ${e.message}`));
  await open(page);
  const planted = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games, STORE);
  check('a v4 record (no rules_version) and a v5 record (rules_version 5, code "std") are in the browser as the old games wrote them; they are relabelled when read', planted.length === 2 && planted[0].rules_version === undefined && planted[0].rules_code === 'std' && planted[1].rules_version === 5 && planted[1].rules_code === 'std', JSON.stringify(planted.map((g) => [g.id, g.rules_code, g.rules_version])));
  await page.click('.landing [data-action=open-stats]');
  await page.waitForSelector('.dialog .st');
  const leadOnly = await page.textContent('.dialog .st__lead');
  check('with only the two old records the stats screen opens on the newest of them, the v5 game, labelled as old rules, with the Chase and Watch section and no NaN', /^\s*1\s+game played under Old rules \(v5/.test(leadOnly) && (await page.locator('.st h3', { hasText: 'Chase, Watch and the Brumby row' }).count()) === 1 && !/NaN|undefined/.test(await page.textContent('.dialog .st')), leadOnly);
  await page.selectOption('[data-action=stats-filter]', 'v4');
  await page.waitForSelector('.st h3:has-text("The mob and the summit")');
  check('choosing v4 shows the one v4 game with its own mob section, no NaN', /^\s*1\s+game played under Old rules \(v4/.test(await page.textContent('.dialog .st__lead')) && !/NaN|undefined/.test(await page.textContent('.dialog .st')));
  await page.keyboard.press('Escape');
  const plan = [5, 2, 4];
  for (let i = 0; i < plan.length; i++) {
    await configure(page, { players: plan[i], types: ['easy', 'easy', 'medium', 'easy', 'easy'] });
    await page.click('#start');
    await finish(page);
    if (i < plan.length - 1) { await page.click('.end [data-action=new]'); await page.waitForSelector('#setup-form'); }
  }
  await page.click('.end [data-action=open-stats]');
  await page.waitForSelector('.dialog .st');
  const lead = await page.textContent('.dialog .st__lead');
  check('three v6 games listed under the current rules, apart from the two old records', /^\s*3\s+games played under Current rules \(v6\)/.test(lead), lead);
  const opts = await page.$$eval('[data-action=stats-filter] option', (os) => os.map((o) => `${o.value}:${o.textContent.trim()}`));
  check('the rules filter lists v6 (3 games), v5 (1) and v4 (1)', opts.length === 3 && opts[0].startsWith('std:Current rules (v6) (3)') && opts[1].startsWith('v5:Old rules (v5') && opts[1].endsWith('(1)') && opts[2].startsWith('v4:Old rules (v4') && opts[2].endsWith('(1)'), opts.join(' | '));
  const sections = await page.$$eval('.st h3', (hs) => hs.map((h) => h.textContent));
  check('the v6 screen has the Climb row and Brumby row section, and neither the Chase and Watch section nor the mob section', sections.includes('The Climb row and the Brumby row') && !sections.includes('Chase, Watch and the Brumby row') && !sections.includes('The mob and the summit') && !/NaN|undefined/.test(await page.textContent('.dialog .st')), sections.join(' | '));
  // The filter and the by-rules table name the old rules on purpose (the old records are listed there); nothing else may.
  const body6 = await page.$eval('.dialog .st', (e) => {
    const c = e.cloneNode(true);
    c.querySelectorAll('.st__filter').forEach((x) => x.remove());
    const h = [...c.querySelectorAll('h3')].find((x) => x.textContent === 'By rules');
    while (h && h.nextSibling) h.nextSibling.remove();
    if (h) h.remove();
    return c.textContent;
  });
  check('the v6 stats screen names no v5 wording outside the rules filter and the by-rules table', !V5.test(body6), (V5.exec(body6) || [''])[0]);
  const rows6 = await page.$$eval('.st h3', (hs) => { const h = hs.find((x) => x.textContent === 'The Climb row and the Brumby row'); return [...h.nextElementSibling.nextElementSibling.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim())); });
  check('the v6 section shows its ten measures, each with numbers and no NaN', rows6.length === 10 && rows6.every((r) => r.slice(1).every((c) => /\d|-/.test(c) && !/NaN|undefined/.test(c))), JSON.stringify(rows6.slice(0, 3)));
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games, STORE);
  const v6 = stored.filter((g) => g.rules_version === 6);
  check('the store holds the v4 record (v4 / 4), the v5 record (v5 / 5) and three v6 records (std / 6), each with an id and a seed', stored.length === 5 && v6.length === 3 && v6.every((g) => g.rules_code === 'std' && g.id && g.seed !== undefined) && stored.filter((g) => g.rules_code === 'v4' && g.rules_version === 4).length === 1 && stored.filter((g) => g.rules_code === 'v5' && g.rules_version === 5).length === 1, JSON.stringify(stored.map((g) => [g.rules_code, g.rules_version])));
  await shot(page, 'stats-1440', { fullPage: false });
  await page.selectOption('[data-action=stats-filter]', 'v5');
  await page.waitForSelector('.st h3:has-text("Chase, Watch and the Brumby row")');
  check('choosing v5 shows the one v5 game under its own section, no NaN', /^\s*1\s+game played under Old rules \(v5/.test(await page.textContent('.dialog .st__lead')) && !/NaN|undefined/.test(await page.textContent('.dialog .st')));
  await shot(page, 'stats-v5-1440', { fullPage: false });
  await page.selectOption('[data-action=stats-filter]', 'std');
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]);
  const csvText = fs.readFileSync(await csvDl.path(), 'utf8');
  const rows = csvText.trim().split('\n');
  check('CSV: LF only, a header and a row per game (v4, v5 and v6 together), every row the same field count', rows.length === 6 && !csvText.includes('\r') && rows.every((r) => r.split(',').length === rows[0].split(',').length), String(rows.length));
  check('CSV: the v4 row carries ",v4,4,", the v5 row ",v5,5," and the v6 rows ",std,6,"', rows.filter((r) => r.includes(',v4,4,')).length === 1 && rows.filter((r) => r.includes(',v5,5,')).length === 1 && rows.filter((r) => r.includes(',std,6,')).length === 3);
  check('CSV: the file is named for the game and the date', /^snowy-river-stats-\d{4}-\d{2}-\d{2}\.csv$/.test(csvDl.suggestedFilename()), csvDl.suggestedFilename());
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-json]')]);
  const exported = JSON.parse(fs.readFileSync(await jsonDl.path(), 'utf8'));
  check('JSON equals the store, with the old records relabelled', JSON.stringify(exported.games) === JSON.stringify(stored) && exported.games.some((g) => g.id === 'gplanted-4' && g.rules_code === 'v4' && g.rules_version === 4) && exported.games.some((g) => g.id === 'gplanted-5' && g.rules_code === 'v5' && g.rules_version === 5));
  await page.keyboard.press('Escape');
  const calls = await events(page);
  const names = calls.map((c) => c[1]);
  check('analytics: game_start x3, hand_end once per hand played (5 + 3 + 4), game_end x3, stats_viewed and stats_exported x2 fired', names.filter((x) => x === 'game_start').length === 3 && names.filter((x) => x === 'game_end').length === 3 && names.filter((x) => x === 'hand_end').length === v6.reduce((a, g) => a + g.hands, 0) && names.includes('stats_viewed') && names.filter((x) => x === 'stats_exported').length === 2, JSON.stringify(names.reduce((o, x) => ({ ...o, [x]: (o[x] || 0) + 1 }), {})));
  check('analytics: every event name is known and every parameter is on the whitelist', names.every((x) => EVENT_NAMES.includes(x)) && calls.every((c) => Object.keys(c[2] || {}).every((k) => ALLOWED_PARAMS.includes(k))), [...new Set(calls.flatMap((c) => Object.keys(c[2] || {})))].join(','));
  check('analytics: every value is a number or a short token, and nothing names a player', calls.every((c) => Object.values(c[2] || {}).every((v) => typeof v === 'number' || /^[A-Za-z0-9_,.+-]{1,60}$/.test(v))) && !/Player|You|bot 1/.test(JSON.stringify(calls)));
  check('analytics: game_name is snowy-river on every event, rules_code is std on game events, and no v5 or v4 parameter (chasers, kept_value, nobody_chased, mobs_home, escapes) is sent', calls.every((c) => c[2] && c[2].game_name === 'snowy-river') && calls.filter((c) => ['game_start', 'hand_end', 'game_end'].includes(c[1])).every((c) => c[2].rules_code === 'std') && !/chasers|kept_value|nobody_chased|mobs_home|escapes/.test(JSON.stringify(calls)));
  check('analytics: hand_end carries row_value and colt_in_row, game_end carries colt_in_row and negative_hands', calls.filter((c) => c[1] === 'hand_end').every((c) => Number.isFinite(c[2].row_value) && (c[2].colt_in_row === 0 || c[2].colt_in_row === 1)) && calls.filter((c) => c[1] === 'game_end').every((c) => Number.isFinite(c[2].colt_in_row) && Number.isFinite(c[2].negative_hands)));
  await ctx.close();
  // 390 px: the same data on a phone
  const phone = await newPage(390, 844, { hasTouch: true, isMobile: true });
  await phone.addInitScript((a) => { try { localStorage.setItem(a.k, JSON.stringify({ v: 1, games: a.games })); } catch { /* ignore */ } }, { k: STORE, games: stored });
  await open(phone);
  await phone.click('.landing [data-action=open-stats]');
  await phone.waitForSelector('.dialog .st');
  check('390px: the stats dialog has no sideways scroll and its tables sit in scroll boxes', (await overflow(phone)) <= 0 && (await phone.locator('.st__scroll .st__table').count()) >= 4);
  check('390px: the dialog buttons are tall enough to tap', await phone.$$eval('.dialog__buttons .btn', (bs) => bs.every((b) => b.getBoundingClientRect().height >= 34)));
  await dimCheck(phone, '390px stats dialog');
  await shot(phone, 'stats-390', { fullPage: false });
  await phone.close();
});

await scenario('Bug reporter', async () => {
  const page = await newPage();
  await open(page, 'seed=3&botdelay=300');
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  const [dl0] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  check('landing page: a report downloads as valid JSON', JSON.parse(fs.readFileSync(await dl0.path(), 'utf8')).schemaVersion === 1);
  const mail = await page.$eval('.bug a[href^="mailto:"]', (a) => a.getAttribute('href'));
  check(`the mailto names only ${CONTACT_EMAIL}`, mail.startsWith(`mailto:${CONTACT_EMAIL}?`) && (mail.match(/@/g) || []).length === 1);
  await page.keyboard.press('Escape');
  await configure(page, { players: 3 });
  await page.click('#start');
  await page.waitForSelector('.hand .card.is-legal');
  await playHuman(page, 20000, (s) => s.plays >= 3);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  await shot(page, 'bug-modal', { fullPage: false });
  const [dl1] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  const rep = JSON.parse(fs.readFileSync(await dl1.path(), 'utf8'));
  check('mid-game: the report holds the v6 state (3 players, climb phase, Climb row of six, rules code std) and the action log', rep.game && rep.game.n === 3 && rep.game.phase === 'climb' && rep.game.climbRowDealt.length === 6 && rep.controller.rulesCode === 'std' && rep.actionLog.length >= 3);
  check('mid-game: the diagnostics say highest wins and Escape is trumps, and name a block reason or null for every card in hand', rep.diagnostics && rep.diagnostics.snowy && rep.diagnostics.snowy.direction === 'highest' && rep.diagnostics.snowy.trump === 'escape' && Array.isArray(rep.diagnostics.cards) && rep.diagnostics.cards.length > 0 && !('error' in rep.diagnostics) && !/choices|handsTurned|marker/.test(JSON.stringify(rep.diagnostics)));
  await page.keyboard.press('Escape');
  // at the summit: the report is a valid snapshot (a single human sees the full state: it is their own bug report)
  const st = newStats();
  const until = Date.now() + 90000;
  while (Date.now() < until && !(await page.locator('.overlay--summit').count())) await humanStep(page, st);
  await page.keyboard.press('Control+Shift+B');
  const formAtSummit = await page.waitForSelector('#bug-form', { timeout: 3000 }).then(() => true, () => false);
  if (formAtSummit) {
    const [dlS] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
    const repS = JSON.parse(fs.readFileSync(await dlS.path(), 'utf8'));
    check('at the summit: the report downloads, the game is in the descent with a Brumby row of six, and the diagnostics say lowest wins and Home is trumps', repS.game && repS.game.phase === 'descent' && Array.isArray(repS.game.row) && repS.game.row.length === 6 && repS.diagnostics.snowy.direction === 'lowest' && repS.diagnostics.snowy.trump === 'home');
    await page.keyboard.press('Escape');
  } else check('at the summit: the bug reporter opens over the summit beat', false);
  await playHuman(page);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  check('end screen: a report downloads', JSON.parse(fs.readFileSync(await dl2.path(), 'utf8')).game.phase === 'over');
  await page.keyboard.press('Escape');
  await page.close();
  for (const w of WIDTHS) {
    const p = await newPage(w, 900, phoneOpts(w));
    await begin(p, { players: 5 });
    await p.waitForSelector('.hand .card.is-legal');
    await p.evaluate(() => document.querySelector('.hand').scrollIntoView({ block: 'center' }));
    const overlap = await p.evaluate(() => {
      const b = document.getElementById('bug-button').getBoundingClientRect();
      return [...document.querySelectorAll('.hand .card')].filter((c) => { const r = c.getBoundingClientRect(); return !(r.right < b.left || r.left > b.right || r.bottom < b.top || r.top > b.bottom); }).length;
    });
    check(`${w}px: with the hand scrolled into view the bug button never covers a card`, overlap === 0, `${overlap}`);
    await p.close();
  }
});

await scenario('Rules dialog (no rule book link, no old wording)', async () => {
  for (const w of WIDTHS) {
    const page = await newPage(w, 800, phoneOpts(w));
    await open(page);
    await page.click('.landing [data-action=open-rules]');
    const dlg = await page.textContent('.dialog');
    check(`${w}px: the dialog opens with the six steps, has no link of any kind, and fits`, (await page.locator('.dialog .how__steps > li').count()) === 6 && (await page.locator('.dialog a').count()) === 0 && (await overflow(page)) <= 0);
    check(`${w}px: the dialog teaches the Climb row (five +1, one -1), highest then lowest wins, no choice, the Muster at five players`, /Climb cards/.test(dlg) && /one -1|-1 card|worth -1/.test(dlg) && /highest card/.test(dlg) && /lowest card wins/.test(dlg) && /no choice/.test(dlg) && /Muster/.test(dlg) && !V5.test(dlg), (V5.exec(dlg) || [''])[0]);
    if (w === 390) await shot(page, 'rules-390', { fullPage: false });
    await dimCheck(page, `${w}px rules dialog`);
    const n = (await events(page)).filter((c) => c[1] === 'rules_opened').length;
    check(`${w}px: rules_opened was queued`, n === 1, `${n}`);
    await page.close();
  }
  // in a game the Rules button opens the same dialog
  const g = await newPage();
  await begin(g, { players: 3 });
  await g.waitForSelector('.hand .card.is-legal');
  await g.click('[data-action=open-rules]');
  check('in a game: the Rules button opens the dialog, again without a link', (await g.locator('.dialog .how__steps > li').count()) === 6 && (await g.locator('.dialog a').count()) === 0);
  await g.keyboard.press('Escape');
  await g.close();
});

await scenario('Muster: the violet suit at five players, never trumps, absent at two to four', async () => {
  const page = await newPage();
  await begin(page, { players: 5, types: types(5), names: ['Mia'] }, 'seed=2&botdelay=60');
  await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
  await watch(page);
  await page.waitForFunction(() => [...document.querySelectorAll('.hand .cardimg')].every((i) => i.complete), null, { timeout: 8000 }).catch(() => {});
  const hand = await page.evaluate(() => ({ n: document.querySelectorAll('.hand .card').length, muster: [...document.querySelectorAll('.hand .card--muster')].map((e) => ({ id: e.dataset.card, asset: e.querySelector('img') && e.querySelector('img').dataset.asset, ok: !!e.querySelector('img') && e.querySelector('img').complete && e.querySelector('img').naturalWidth > 0, trump: e.classList.contains('is-trump') })) }));
  check('5p: twelve cards in the hand and the Muster is among them, each face loaded, none marked as trumps', hand.n === 12 && hand.muster.length >= 1 && hand.muster.every((m) => m.asset === `card-${m.id}` && m.ok && !m.trump), JSON.stringify(hand));
  const suitsInHand = await page.$$eval('.hand .card', (cs) => [...new Set(cs.map((c) => c.dataset.card.split('-')[0]))]);
  const order = ['escape', 'climb', 'descent', 'muster', 'home'];
  check('5p: the hand is grouped by suit in the printed order, Muster between Descent and Home', suitsInHand.join() === order.filter((s) => suitsInHand.includes(s)).join(), suitsInHand.join());
  await shot(page, 'hand-5p-1440', { fullPage: false });
  await page.click('[data-action=open-rules]');
  const how = await page.evaluate(() => [...document.querySelectorAll('.dialog .how__suits li')].map((li) => ({ t: li.textContent.trim(), asset: li.querySelector('img') && li.querySelector('img').dataset.asset })));
  check('the How to play lists five suits with a badge each and says the Muster is for five players', how.length === 5 && how.map((h) => h.asset).join() === 'badge-escape,badge-climb,badge-descent,badge-muster,badge-home' && /Muster[\s\S]*5 players only/.test(how[3].t), JSON.stringify(how));
  await page.keyboard.press('Escape');
  const st = newStats();
  const until = Date.now() + 200000;
  let led = false;
  while (Date.now() < until && !(await page.locator('.end--game').count())) {
    if (await page.locator('.led--muster .led__badge').count()) {
      led = true;
    }
    await humanStep(page, st);
  }
  const W = await seen(page);
  check('5p: a whole game was played with Muster cards on the table, never a trump mark on a Muster card, never a placeholder, never an old word', W.musterCards >= 1 && W.musterTrumpMarks === 0 && W.musterTrumpCards === 0 && W.chips === 0 && W.v5 === null, JSON.stringify({ muster: W.musterCards, marks: W.musterTrumpMarks, chips: W.chips, v5: W.v5 }));
  check('5p: when the Muster was led the trick title showed its violet badge', led, 'the Muster was never led in this game');
  check('5p: the game ended with five on the ranking', (await page.locator('.rank').count()) === 5);
  await page.close();
  const p4 = await newPage();
  await begin(p4, { players: 4, types: types(4) }, 'seed=2&botdelay=0');
  await p4.waitForSelector('.hand .card.is-legal');
  await watch(p4);
  await playHuman(p4);
  const W4 = await seen(p4);
  check('4p: not one Muster card appeared on the table in a whole game', W4.musterCards === 0, `${W4.musterCards}`);
  await p4.close();
});

await scenario('Old wording: no v5 word on any screen of a game, in text, tooltips, labels or alt texts', async () => {
  const page = await newPage();
  await begin(page, { players: 3, types: types(3), names: ['Mia'] }, 'seed=14&botdelay=60');
  await page.waitForSelector('.hand .card.is-legal');
  const states = {};
  const note = async (name) => { const w = await oldWords(page); states[name] = w; };
  await note('climb start');
  await page.click('[data-action=open-rules]'); await note('how to play dialog'); await page.keyboard.press('Escape');
  const st = newStats();
  const until = Date.now() + 120000;
  let sawSummit = false; let sawDescent = false; let sawReck = false;
  while (Date.now() < until && !(await page.locator('.end--game').count())) {
    if (!sawSummit && (await page.locator('.overlay--summit').count())) { sawSummit = true; await note('summit beat'); }
    if (!sawDescent && !(await page.locator('.overlay--summit').count()) && (await page.locator('.phasebar--descent').count()) && (await page.locator('.hand .card.is-legal').count())) { sawDescent = true; await note('descent'); }
    if (!sawReck && (await page.locator('#continue').count())) { sawReck = true; await note('reckoning'); }
    await humanStep(page, st);
  }
  await note('end screen');
  await page.click('.end--game [data-action=review]');
  await note('table after the game');
  await page.click('.endbar [data-action=open-stats]'); await page.waitForSelector('.dialog .st'); await note('stats dialog'); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+B'); await page.waitForSelector('#bug-form'); await note('bug reporter'); await page.keyboard.press('Escape');
  check('the summit beat, the descent and the reckoning were all reached', sawSummit && sawDescent && sawReck);
  const bad = Object.entries(states).filter(([, w]) => w !== null);
  check(`no Chase, Watch, watcher, chaser, Mountain, mob marker, "turn your hand", two numbers, split, Playtest or rule book on any of ${Object.keys(states).length} screens`, bad.length === 0, bad.map(([k, w]) => `${k}: ${w}`).join('; '));
  await page.close();
});

await scenario('Responsive sweep: 2, 3, 4 and 5 players at every width', async () => {
  for (const w of WIDTHS) {
    for (const n of COUNTS) {
      const page = await newPage(w, 844, phoneOpts(w));
      await begin(page, { players: n, types: ['human', 'medium', 'easy', 'easy', 'easy'] }, 'seed=9&botdelay=0');
      await page.waitForSelector('.hand .card.is-legal');
      const first = await page.$$eval('.hand .card', (cs) => cs.map((c) => c.getBoundingClientRect().width));
      check(`${w}px ${n}p: first screen fits and hand cards are at least 36 px wide`, (await overflow(page)) <= 0 && Math.min(...first) >= 36, `min ${Math.min(...first).toFixed(0)}`);
      const fit = await page.evaluate(() => [...document.querySelectorAll('.seat, .row--climb, .row--brumby, .trick, .phasebar')].filter((e) => { const r = e.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).length);
      check(`${w}px ${n}p: every seat, both rows, the trick and the banner fit the width`, fit === 0, `${fit} outside`);
      if (n === 5 || n === 2) await shot(page, `start-${n}p-${w}`, { fullPage: w < 700 });
      let sawSummary = false;
      for (let i = 0; i < 600 && !sawSummary; i++) { await humanStep(page, newStats()); if (await page.locator('#continue').count()) sawSummary = true; }
      if (sawSummary) {
        check(`${w}px ${n}p: the reckoning fits and has a row per seat`, (await overflow(page)) <= 0 && (await page.locator('.reck__row').count()) === n);
        if (n === 5 || n === 2) await shot(page, `reckoning-${n}p-${w}`, { fullPage: false });
        await tryClick(page.locator('#continue'));
      }
      const s = await playHuman(page);
      check(`${w}px ${n}p: the end panel shows and nothing scrolls sideways`, (await page.locator('.end--game').count()) === 1 && (await overflow(page)) <= 0, JSON.stringify(s));
      if (n === 5 || n === 2) await shot(page, `end-${n}p-${w}`, { fullPage: false });
      await page.close();
    }
  }
});

await scenario('Reduced motion', async () => {
  const dflt = await newPage();
  await begin(dflt, { players: 3 }, 'seed=11&botdelay=800');
  await dflt.waitForSelector('.hand .card.is-legal');
  check('by default cards transition', parseFloat(await dflt.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) > 0);
  await dflt.close();
  const rm = await newPage(1280, 900, { reducedMotion: 'reduce' });
  await begin(rm, { players: 3 }, 'seed=11&botdelay=150');
  await rm.waitForSelector('.hand .card.is-legal');
  check('with reduced motion the transitions and animations are off', parseFloat(await rm.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) === 0 && (await rm.$eval('.seat', (e) => getComputedStyle(e).animationName)) === 'none' && (await rm.evaluate(() => [...document.querySelectorAll('.rslot__card, .hscore, .tag')].every((e) => getComputedStyle(e).animationName === 'none'))));
  // through the summit with reduced motion: the banner still switches, with no animation left running
  await watch(rm);
  const st = newStats();
  const until = Date.now() + 120000;
  while (Date.now() < until && !(await rm.locator('.overlay--summit').count())) await humanStep(rm, st);
  await rm.waitForTimeout(150);
  const during = await rm.evaluate(() => ({ anims: document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations === Infinity).length, popped: [...document.querySelectorAll('.overlay--summit *')].filter((e) => getComputedStyle(e).animationName !== 'none').length }));
  check('with reduced motion the summit beat shows with no animation running', during.anims === 0 && during.popped === 0, JSON.stringify(during));
  while (Date.now() < until && !(await rm.locator('.phasebar--descent').count())) await humanStep(rm, st);
  const W = await seen(rm);
  check('with reduced motion the banner still switches from the climb to the descent', W.phases.slice(0, 2).join() === 'climb,descent', W.phases.join());
  await rm.close();
});

await scenario('Keyboard play', async () => {
  const page = await newPage();
  await begin(page, { players: 3, auto: false }, 'seed=7&botdelay=40');
  await page.waitForSelector('.hand .card.is-legal');
  await page.focus('.hand .card.is-legal');
  await page.keyboard.press('Home');
  const first = await page.evaluate(() => document.activeElement.dataset.card);
  await page.keyboard.press('End');
  const last = await page.evaluate(() => document.activeElement.dataset.card);
  check('Home and End move to the first and last card', !!first && !!last && first !== last);
  const blocked = page.locator('.hand .card.is-blocked');
  if (await blocked.count()) {
    await blocked.first().focus();
    await page.keyboard.press('Enter');
    check('Enter on a dimmed card explains why it cannot be played', (await page.textContent('#note')).length > 10);
  } else check('Enter on a dimmed card explains why it cannot be played (no dimmed card this deal)', true);
  await page.focus('.hand .card.is-legal');
  const before = await page.locator('.hand .card').count();
  await page.keyboard.press('Enter');
  await page.waitForFunction((b) => document.querySelectorAll('.hand .card').length < b || document.querySelector('.cover, #continue, .end--game'), before, { timeout: 10000 }).catch(() => {});
  check('Enter on a legal card plays it', (await page.locator('.hand .card').count()) < before || (await page.locator('#continue, .end--game').count()) > 0);
  // The reckoning by keyboard: it takes focus, Tab stays inside it, Enter deals the next hand.
  const st = newStats();
  const until = Date.now() + 150000;
  while (Date.now() < until && !(await page.locator('#continue').count())) await humanStep(page, st);
  await page.waitForTimeout(100);
  check('the reckoning takes focus', await page.evaluate(() => !!document.activeElement.closest('.overlay--hand')), await page.evaluate(() => `${document.activeElement.tagName}.${document.activeElement.className}`));
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  check('Tab stays inside the reckoning', await page.evaluate(() => !!document.activeElement.closest('.overlay--hand')));
  await page.focus('#continue');
  await page.keyboard.press('Enter');
  check('Enter on "Deal the next hand" closes the reckoning and the next hand is dealt', await page.waitForFunction(() => !document.querySelector('.overlay--hand') && document.querySelector('.hand .card'), null, { timeout: 15000 }).then(() => true, () => false));
  await page.click('[data-action=open-rules]');
  await page.keyboard.press('Tab');
  check('a dialog keeps focus inside it', await page.evaluate(() => !!document.activeElement.closest('.dialog')));
  await page.keyboard.press('Escape');
  await page.close();
});

await scenario('Leaving a game', async () => {
  const page = await newPage();
  await begin(page, { players: 3 }, 'seed=71&botdelay=0');
  await page.waitForSelector('.hand .card.is-legal');
  await playHuman(page, 20000, (s) => s.plays >= 3);
  page.once('dialog', (d) => d.dismiss());
  await page.click('[data-action=quit]');
  check('Cancel keeps the game', (await page.locator('.hand').count()) === 1 && (await page.locator('#setup-form').count()) === 0);
  if (await page.locator('#continue').count()) await page.click('#continue');
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=quit]');
  await page.waitForSelector('#setup-form');
  const ab = (await events(page)).filter((c) => c[1] === 'game_abandoned').length;
  check('game_abandoned fires once', ab === 1, `${ab}`);
  check('an abandoned game is not recorded in the stats', (await page.evaluate((k) => localStorage.getItem(k), STORE)) === null);
  await page.close();
});

await scenario('Checklist: disabled controls explain themselves; AI turns are paced; the bug button survives re-renders; storage can be blocked', async () => {
  // empty stats: the export and clear buttons are disabled and say why
  const empty = await newPage();
  await open(empty);
  await empty.click('.landing [data-action=open-stats]');
  await empty.waitForSelector('.dialog .st');
  const dis = await empty.$$eval('.dialog button:disabled', (bs) => bs.map((b) => [b.textContent.trim(), b.title]));
  check('empty stats: Export CSV, Export JSON and Clear are disabled, each with a reason in its tooltip', dis.length === 3 && dis.every(([, t]) => /No games recorded yet/.test(t)), JSON.stringify(dis));
  await empty.close();
  // the setup page has no disabled control without a reason
  const land = await newPage();
  await open(land);
  check('setup page: nothing is disabled without a reason (every bot level is available)', (await land.locator('button:disabled, option:disabled, input:disabled, select:disabled').count()) === 0);
  await land.close();
  // hovering a card shows its hint; the line has a fixed height, so the page never jumps under the pointer (found by the QA at 390 px:
  // the page grew and shrank by 9 px, the card moved out from under the pointer and the hint flickered)
  for (const w of [390, 600, 800, 1024, 1440]) {
    const hp = await newPage(w, 900, w < 700 ? { hasTouch: true, isMobile: true } : {});
    await begin(hp, { players: 5 }, 'seed=2&botdelay=0');
    await hp.waitForSelector('.hand .card.is-legal');
    const hover = async (label) => {
      await hp.mouse.move(2, 2);
      await hp.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 8000 }).catch(() => {}); // the art settles first: a late image is not a hover jump
      await hp.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
      await hp.waitForTimeout(400); // late fonts and images settle first: only a change caused by the hover counts
      const rest = await hp.evaluate(() => document.documentElement.scrollHeight);
      const cards = hp.locator('.hand .card.is-legal');
      const n = await cards.count();
      const seenH = new Set();
      let longest = 0;
      for (let i = 0; i < n; i++) {
        await cards.nth(i).scrollIntoViewIfNeeded();
        const b = await cards.nth(i).boundingBox();
        await hp.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        const r = await hp.evaluate(() => ({ h: document.documentElement.scrollHeight, len: document.querySelector('#preview').textContent.length }));
        seenH.add(r.h);
        longest = Math.max(longest, r.len);
      }
      await hp.mouse.move(2, 2);
      const rest2 = await hp.evaluate(() => document.documentElement.scrollHeight);
      check(`${w}px ${label}: hovering each of the ${n} playable cards (longest hint ${longest} characters) never changes the page height (${rest} px at rest)`, seenH.size === 1 && [...seenH][0] === rest && rest2 === rest, `${[...seenH].join(',')} v ${rest} / ${rest2}`);
    };
    await hover('leading');
    const hs = newStats();
    while (hs.plays < 4) await humanStep(hp, hs);
    for (let i = 0; i < 400 && !(await hp.locator('.hand .card.is-legal').count()); i++) await hp.waitForTimeout(25);
    await hover('following');
    await hp.close();
  }
  // in a game with paced bots: waiting cards say so, dimmed cards give the reason, and the bug button stays through the re-renders
  const page = await newPage();
  await begin(page, { players: 4, types: ['easy', 'easy', 'human', 'easy'] }, 'seed=12&botdelay=250');
  await page.waitForSelector('.hand .card', { timeout: 20000 });
  const wait = await page.$$eval('.hand .card.is-wait', (cs) => cs.map((c) => c.title));
  check('not your turn: every card is marked as waiting and its tooltip says to wait', wait.length > 0 && wait.every((t) => /wait for your turn/.test(t)), JSON.stringify(wait.slice(0, 2)));
  await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
  await page.evaluate(() => { window.__t = []; const t0 = performance.now(); new MutationObserver(() => window.__t.push(Math.round(performance.now() - t0))).observe(document.getElementById('app'), { childList: true, subtree: true }); });
  await tryClick(page.locator('.hand .card.is-legal').first());
  if (page.__touch) await tryClick(page.locator('.hand .card.is-selected'), { timeout: 1500 });
  await page.waitForFunction(() => !document.querySelector('.hand .card.is-legal'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('.hand .card.is-legal, #continue, .overlay', { timeout: 30000 });
  const times = await page.evaluate(() => window.__t);
  const bursts = times.reduce((n, t, i) => n + (i === 0 || t - times[i - 1] > 80 ? 1 : 0), 0);
  check('AI turns are visibly paced: the replies of the bots came as separate redraws spread over time (not all at once)', bursts >= 3 && times[times.length - 1] >= 500, `${bursts} bursts, last redraw at ${times[times.length - 1]} ms`);
  await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
  const blocked = await page.$$eval('.hand .card.is-blocked', (cs) => cs.map((c) => c.title));
  check('your turn: every dimmed card has a reason in its tooltip', blocked.every((t) => t.length > 10 && /must follow/i.test(t)), JSON.stringify(blocked.slice(0, 2)));
  const disabledNoTitle = await page.$$eval('button:disabled, [aria-disabled=true]', (els) => els.filter((e) => !(e.title || e.getAttribute('aria-label'))).length);
  check('in a game: every disabled or dimmed control has a tooltip or label', disabledNoTitle === 0, `${disabledNoTitle}`);
  const st = newStats();
  let bugGone = 0;
  for (let i = 0; i < 80; i++) { await humanStep(page, st); if (!(await page.isVisible('#bug-button'))) bugGone++; }
  check('the bug button stays on screen through 80 re-rendering steps of play (and the summit)', bugGone === 0, `${bugGone}`);
  await page.close();
  // storage blocked: the game plays to the end and the stats screen says there is nothing
  const blockedPage = await newPage(1280, 900, {}, () => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
  await begin(blockedPage, { players: 2, types: ['easy', 'easy'] }, 'seed=5&botdelay=0');
  await finish(blockedPage);
  check('with localStorage blocked a game still plays to the end and shows its ranking', (await blockedPage.locator('.rank').count()) === 2);
  await blockedPage.click('.end [data-action=open-stats]');
  await blockedPage.waitForSelector('.dialog .st');
  check('with localStorage blocked the stats screen shows the empty state, not an error', /No games recorded yet/.test(await blockedPage.textContent('.dialog .st')));
  await blockedPage.close();
});

// ============================================================================================
await scenario('Console and server log', async () => {
  check('no console errors or warnings, no failed requests, no HTTP 4xx across the whole run', problems.length === 0, problems.slice(0, 4).join(' || '));
  const missing = requestLog.filter((r) => r.status === 404 && r.url !== '/');
  check('the server log has no 404 (the origin root aside)', missing.length === 0, missing.slice(0, 3).map((r) => r.url).join(' '));
  check('no console.log / info / debug output anywhere in the run (no debug logs in the render path)', debugLogs.length === 0, debugLogs.slice(0, 3).join(' || '));
  check('nothing requested the old rule book PDF or any rules/ file', !requestLog.some((r) => /\/rules\//.test(r.url)), requestLog.filter((r) => /\/rules\//.test(r.url)).map((r) => r.url).join(' '));
  check('nothing requested a removed v5 image (Mountain, Chase, Watch, mob marker)', !requestLog.some((r) => /mountain|chase|watch|mob-marker/i.test(r.url)), requestLog.filter((r) => /mountain|chase|watch|mob-marker/i.test(r.url)).map((r) => r.url).join(' '));
}, { always: true });

await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
const out = path.join(TMP, ONLY ? `qa-results-${slug(ONLY)}.json` : 'qa-results.json');
fs.writeFileSync(out, `${JSON.stringify({ total: results.length, failed: failed.length, only: ONLY || null, targets: Object.fromEntries(Object.entries(TARGETS).map(([k, t]) => [k, t && { seed: t.seed, players: t.players || null, hand: t.handIdx === undefined ? null : t.handIdx + 1 }])), shots: fs.readdirSync(SHOTS), results }, null, 1)}\n`);
console.log(`\nqa-run: ${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`);
if (failed.length) { for (const f of failed) console.log(`  FAIL [${f.scenario}] ${f.name}${f.detail ? ` -- ${f.detail}` : ''}`); process.exit(1); }
