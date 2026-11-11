// qa-run.mjs - browser QA over the whole game (v5 rules), run from a sub-path the way GitHub Pages serves it.
//
// 1. Copies the files that would be published (git ls-files plus untracked files that are not ignored) into
//    <system temp>/<slug>-qa/site/<slug>-game/ and serves <temp>/site on a CASE-SENSITIVE static server (a request
//    must match a real file name exactly, like Pages).
// 2. Drives the game in headless Chromium: the landing page from the sub-path (2 to 4 players, no rule book link),
//    the consent banner and analytics on a real-looking host name, 1440 / 1024 / 390 px, 2 to 4 players against every
//    bot level (Hard must not freeze the page), all-bot games, pass-and-play with the summit choice secret behind the
//    cover and the cards turned together, the turn of the hands and of the Mountain card at the summit, the Brumby row
//    and each chaser's kept cards, the Chase cost by player count, every kind of hand (nobody chases, a lone chaser,
//    several, everyone, the Colt kept or sent off, a chaser below zero, the Brumby deck reshuffled), the tiebreak and a
//    shared win, the overlays dimming the whole viewport, every card face, the stats screen and its exports with a
//    migrated v4 record, analytics, the bug reporter, reduced motion, keyboard play, leaving a game and a clean console.
// 3. Prints PASS/FAIL per check, writes screenshots to <temp>/<slug>-qa/shots/ and a JSON summary to
//    <temp>/<slug>-qa/qa-results.json. Exit 1 if anything fails.
//
// The hands, the Colt and the tiebreak games are found by playing the same games headlessly first (the real controller
// and the Easy bot, a human seat that plays its first legal card and follows a fixed Chase / Watch policy), so each is
// reached from a `?seed=` and the page's reckoning is checked against the engine's own numbers. A search that finds
// nothing fails the run instead of skipping the scenario. Searches run only for the scenarios that are selected.
//
// Needs Playwright (not a dependency of this repo; see tests/browser-lib.mjs).
// Run: node tests/qa/qa-run.mjs [--only=<scenario substring>] [--widths=390,1440]
//   --only keeps the screenshots of earlier runs (a full run clears them) and writes qa-results-<only>.json.
//   A full run takes several minutes; in a shell that throttles background jobs, run it in parts with --only.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GAME_NAME, GAME_SLUG, GAME_TAGLINE, CONTACT_EMAIL, PLAYER_COUNTS } from '../../src/game-config.js';
import { createController } from '../../src/ui/controller.js';
import { brumbyValue } from '../../src/engine/index.js';
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
const phoneOpts = (w) => (w < 700 ? { hasTouch: true, isMobile: true } : {});
const COUNTS = [2, 3, 4];
const HANDS = { 2: 3, 3: 3, 4: 4 }; // one hand per player, three at two players
const COST = { 2: 3, 3: 2, 4: 2 }; // the Chase cost by player count
const signed = (x) => (x > 0 ? `+${x}` : `${x}`);

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
  page.__policy = 'alt';
  return page;
}
const tryClick = (loc, opts = {}) => loc.click({ timeout: 5000, ...opts }).then(() => true, () => false);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const events = (page) => page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event'));
const types = (n, level = 'easy', first = 'human') => Array.from({ length: n }, (_, i) => (i === 0 ? first : level));

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
const newStats = () => ({ plays: 0, covers: 0, summaries: 0, hints: 0, leaks: 0, summits: 0 });

/** The human's Chase / Watch policy: 'chase', 'watch', or 'alt' (Chase, Watch, Chase, ...). */
const summitChoice = (policy, k) => (policy === 'alt' ? (k % 2 ? 'watch' : 'chase') : policy);

/**
 * One human decision: a cover, a reckoning, the summit choice or a card. Returns what it did.
 * `opts.stopAtReckoning` is an async predicate asked before a reckoning is dismissed; true returns 'stop'.
 * `opts.onSummary` is called after a reckoning is dismissed.
 */
async function humanStep(page, stats, opts = {}) {
  if (await page.locator('.end--game').count()) return 'end';
  if (await page.locator('.cover').count()) {
    stats.covers++;
    if (await page.locator('.hand, .card, .cardimg, .table, .log__list, .mountain, .row, .decision, .overlay, .seat, .schip').count()) stats.leaks++;
    await tryClick(page.locator('.cover .btn--primary'));
    return 'cover';
  }
  if (await page.locator('#continue').count()) {
    if (opts.stopAtReckoning && (await opts.stopAtReckoning())) return 'stop';
    if (await tryClick(page.locator('#continue'))) { stats.summaries++; if (opts.onSummary) await opts.onSummary(); }
    return 'summary';
  }
  const decide = page.locator('.decision [data-action=decide]');
  if (await decide.count()) {
    if (page.__noDecide) return 'wait';
    const choice = summitChoice(page.__policy, stats.summits);
    if (!(await tryClick(page.locator(`.decision [data-action=decide][data-decision*='"${choice}"']`)))) return 'retry';
    stats.summits++;
    return 'summit';
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
 * Watches the table for everything that flashes past: the marker, the Mountain's side, the turn of the hands, the Brumby row,
 * kept cards, reveals, phases. `window.__w.reset()` clears the per-hand counters (called after each reckoning).
 */
async function watch(page) {
  await page.evaluate(() => {
    const fresh = () => ({ steps: [], sides: [], mtnSrc: [], trumpLines: [], turnBeats: 0, turnedFrames: 0, upright: 0, reveals: [], phases: [], summitModals: 0, rowTakenMax: 0, nextLit: 0, keptMax: 0, coltSeenKept: false, discardMax: 0, coltInRow: false, takenOff: 0, takenKept: 0, markerOnDescent: 0 });
    const W = fresh();
    W.reset = () => { const f = fresh(); for (const k of Object.keys(f)) W[k] = f[k]; };
    window.__w = W;
    const app = document.getElementById('app');
    const look = () => {
      const mt = app.querySelector('.mountain');
      if (mt) {
        const side = mt.dataset.side;
        if (!W.sides.length || W.sides[W.sides.length - 1] !== side) W.sides.push(side);
        const im = mt.querySelector('.mountain__img');
        if (im) { const src = im.getAttribute('src'); if (W.mtnSrc[W.mtnSrc.length - 1] !== src) W.mtnSrc.push(src); }
        const tl = mt.querySelector('.mountain__trump');
        if (tl) { const t = tl.textContent.trim(); if (W.trumpLines[W.trumpLines.length - 1] !== t) W.trumpLines.push(t); }
        if (side === 'descent' && mt.querySelector('.mountain__marker')) W.markerOnDescent++;
      }
      const mk = app.querySelector('.mountain__marker');
      if (mk) { const st = Number(mk.dataset.step); if (W.steps[W.steps.length - 1] !== st) W.steps.push(st); }
      if (app.querySelector('.overlay--turn')) W.turnBeats++;
      const hand = app.querySelector('.hand');
      const imgs = hand ? [...hand.querySelectorAll('img')] : [];
      if (hand && hand.classList.contains('hand--turned')) { W.turnedFrames++; if (imgs.some((i) => !i.classList.contains('is-turned'))) W.upright++; }
      else if (imgs.some((i) => i.classList.contains('is-turned'))) W.upright++;
      const ph = app.querySelector('.phasebar');
      if (ph) { const key = ph.className.replace('phasebar phasebar--', ''); if (!W.phases.includes(key)) W.phases.push(key); }
      if (app.querySelector('.overlay--summit')) W.summitModals++;
      const rv = app.querySelector('.overlay--reveal');
      if (rv) {
        const names = [...rv.querySelectorAll('.reveal__who')].map((e) => e.textContent);
        const faces = [...rv.querySelectorAll('.reveal__seat')].map((e) => (e.classList.contains('reveal__seat--chase') ? 'chase' : 'watch'));
        const text = rv.textContent;
        const last = W.reveals[W.reveals.length - 1];
        if (!last || last.names.join('|') !== names.join('|') || last.faces.join('|') !== faces.join('|') || last.text !== text) W.reveals.push({ names, faces, text });
      }
      W.rowTakenMax = Math.max(W.rowTakenMax, app.querySelectorAll('.rslot.is-taken').length);
      W.takenKept = Math.max(W.takenKept, app.querySelectorAll('.rslot.is-taken .rslot__gone--kept').length);
      W.takenOff = Math.max(W.takenOff, app.querySelectorAll('.rslot.is-taken .rslot__gone--off').length);
      W.nextLit = Math.max(W.nextLit, app.querySelectorAll('.rslot.is-next').length);
      W.keptMax = Math.max(W.keptMax, app.querySelectorAll('.seat .kept__card').length);
      if (app.querySelector('.seat .kept__card[title*="Colt"]')) W.coltSeenKept = true;
      if (app.querySelector('.rslot.is-colt, .summit__row .is-colt')) W.coltInRow = true;
      const disc = [...app.querySelectorAll('.row__discard summary, .row__pile')].find((e) => /Discard/.test(e.textContent));
      if (disc && disc.querySelector('b')) W.discardMax = Math.max(W.discardMax, Number(disc.querySelector('b').textContent));
    };
    new MutationObserver(look).observe(app, { childList: true, subtree: true });
    look();
  });
}
const seen = (page) => page.evaluate(() => { const { reset, ...rest } = window.__w; return rest; });
const resetWatch = (page) => page.evaluate(() => window.__w && window.__w.reset());

/** The reckoning on screen, read back from the DOM. */
const readReckoning = (page) => page.evaluate(() => {
  const el = document.querySelector('.end--hand');
  const notes = [...el.querySelectorAll('.end__note')];
  return {
    cls: el.className,
    title: el.querySelector('#hand-title').textContent,
    lead: el.querySelector('.end__note--lead').textContent,
    foot: notes.filter((n) => !n.classList.contains('end__note--lead')).map((n) => n.textContent).join(' '),
    button: el.querySelector('#continue').textContent,
    rows: [...el.querySelectorAll('.reck__row')].map((r) => ({
      cls: r.className,
      seat: Number(r.dataset.seat),
      who: r.querySelector('.reck__who b').textContent,
      ud: r.querySelector('.reck__who small').textContent,
      choice: r.querySelector('.reck__choice b').textContent,
      sum: r.querySelector('.reck__what b').textContent,
      kept: r.querySelectorAll('.reck__keptcard').length,
      score: Number(r.querySelector('.reck__score').textContent),
      total: Number(r.querySelector('.reck__total b').textContent),
    })),
  };
});

/** What the reckoning row for a seat must say, worked out from the engine's own hand record. */
function expectedRow(bd) {
  const trickWord = `${bd.tricks} ${bd.tricks === 1 ? 'trick' : 'tricks'}`;
  return {
    ud: `${bd.climbTricks} up, ${bd.descentTricks} down`,
    choice: bd.choice === 'chase' ? `Chase -${bd.cost}` : 'Watch',
    sum: bd.choice === 'chase' ? `${trickWord} ${bd.keptValue < 0 ? '-' : '+'} ${Math.abs(bd.keptValue)} kept - ${bd.cost} Chase = ${signed(bd.score)}` : `${trickWord} = ${signed(bd.score)}`,
    kept: bd.choice === 'chase' ? bd.kept.length : 0,
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
      scrollable: document.documentElement.scrollHeight > innerHeight + 4,
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
/** A game as the page plays it: seat 0 is the human (first legal card, the Chase / Watch policy), the rest Easy bots unless `allBots`. */
function simulate({ seed, players, policy = 'alt', allBots = false }) {
  const key = `${seed}|${players}|${policy}|${allBots}`;
  if (simCache.has(key)) return simCache.get(key);
  const seats = Array.from({ length: players }, (_, i) => ({ type: allBots || i > 0 ? 'easy' : 'human' }));
  const ctl = createController({ seats, seed, rules: {}, autoPlayForced: false });
  const hands = [];
  const summitOrders = []; // the order the engine collects each summit's choices in (from the last climb winner)
  const take = (evs) => {
    for (const e of evs || []) {
      if (e.type === 'hand-ended') hands.push({ ...e, reshuffleNext: false });
      else if (e.type === 'summit-opened') summitOrders.push(e.order);
      else if (e.type === 'brumby-reshuffled' && hands.length) hands[hands.length - 1].reshuffleNext = true;
    }
  };
  take(ctl.startEvents);
  let summits = 0;
  for (let guard = 0; !ctl.isFinished() && guard < 20000; guard++) {
    if (ctl.isBotTurn()) { take(ctl.stepBot()); continue; }
    if (!ctl.isHumanTurn()) break;
    const action = ctl.state.phase === 'summit' ? { type: 'summit', choice: summitChoice(policy, summits++) } : ctl.legalActions()[0];
    const r = ctl.play(action);
    if (!r.ok) break;
    take(r.events);
  }
  const out = { hands, summitOrders, result: ctl.state.result, names: ctl.names };
  simCache.set(key, out);
  return out;
}

const nChasers = (ev) => ev.chasers;
const KINDS = {
  'nobody chases': { want: (ev) => ev.chasers === 0, players: [3, 2, 4] },
  'a lone chaser': { want: (ev) => ev.chasers === 1, players: [4, 3, 2] },
  'several chase, some watch': { want: (ev) => ev.chasers >= 2 && ev.chasers < ev.choices.length, players: [4, 3, 2] },
  'everyone chases': { want: (ev) => ev.chasers === ev.choices.length, players: [2, 3, 4] },
  'the Colt in the row, kept by a chaser': { want: (ev) => ev.colt && ev.coltKept, players: [3, 2, 4] },
  'the Colt in the row, sent off by a watcher': { want: (ev) => ev.colt && !ev.coltKept, players: [4, 3, 2] },
  'a chaser ends the hand below zero': { want: (ev) => ev.breakdown.some((b) => b.choice === 'chase' && b.score < 0), players: [2, 3, 4] },
  'the Brumby deck is shuffled again before the next hand': { want: (ev) => ev.reshuffleNext, players: [2, 3, 4] },
};

/** The earliest game (in the order of `playersList`, then earliest hand, then lowest seed) with a hand that satisfies `want`. */
function findHand(want, { playersList = [2, 3, 4], policies = ['chase', 'watch', 'alt'], seeds = 400 } = {}) {
  for (const players of playersList) {
    let best = null;
    for (const policy of policies) {
      for (let seed = 1; seed <= seeds; seed++) {
        const { hands } = simulate({ seed, players, policy });
        const handIdx = hands.findIndex(want);
        if (handIdx >= 0 && (!best || handIdx < best.handIdx)) best = { seed, players, policy, handIdx, ev: hands[handIdx] };
        if (best && best.handIdx === 0) break;
      }
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

/** A seed whose first summit is collected from a seat other than the human's, so the reveal order is a real test. */
function findAwayFromYou(players) {
  for (let seed = 1; seed <= 300; seed++) {
    const { summitOrders } = simulate({ seed, players, policy: 'chase' });
    if (summitOrders.length && summitOrders[0][0] !== 0) return { seed, order: summitOrders[0] };
  }
  return null;
}

const TARGETS = {};
function target(key, fn) {
  if (!(key in TARGETS)) {
    const t0 = Date.now();
    TARGETS[key] = fn();
    const t = TARGETS[key];
    console.log(`  search "${key}" (${((Date.now() - t0) / 1000).toFixed(1)} s): ${t ? `seed ${t.seed}${t.players ? `, ${t.players} players` : ''}${t.policy ? `, policy ${t.policy}, hand ${t.handIdx + 1}` : ''}${t.order ? `, collected from seat ${t.order[0] + 1}` : ''}` : 'NOT FOUND'}`);
  }
  return TARGETS[key];
}
const handTarget = (kind) => target(kind, () => findHand(KINDS[kind].want, { playersList: KINDS[kind].players }));
const revealTarget = (n) => target(`reveal${n}`, () => findAwayFromYou(n));
const tieTarget = () => target('tiebreak', () => findResult((r) => r.tiebreakUsed && !r.shared));
const sharedTarget = () => target('shared', () => findResult((r) => r.shared));

// ============================================================================================
await scenario('Static: every referenced path is an exact-case match; lower-case names; sizes; no 5-player art', async () => {
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
  check('names are lower-case with no spaces (README aside)', [...served].every((f) => !/\s/.test(f) && (f === `${SUB}/README.md` || f === f.toLowerCase())));
  const big = [...served].filter((f) => fs.statSync(path.join(SITE, f)).size > 500 * 1024 && !/\/rules\/[a-z0-9-]+\.pdf$/.test(f));
  check('no file over 500 KB except the old printed rule book, which stays in rules/ unlinked', big.length === 0, big.join(', '));
  check('the v4-only art is gone (mountain-6, mountain-7, brumby-front, chase) and the v5 art is all there', ['mountain-6.webp', 'mountain-7.webp', 'brumby-front.webp', 'chase.webp'].every((f) => !served.has(`${SUB}/assets/cards/${f}`)) && ['mountain-up', 'mountain-down', 'chase-2', 'chase-3', 'watch', 'colt', 'brumby-back', 'card-back', 'brumby-plus2', 'brumby-plus1', 'brumby-flint', 'brumby-wombat'].every((f) => served.has(`${SUB}/assets/cards/${f}.webp`)));
  const cardFaces = ['escape', 'climb', 'descent', 'home'].flatMap((s) => Array.from({ length: 12 }, (_, i) => `assets/cards/card-${s}-${i + 1}.webp`));
  check('all 48 split card faces are served and there is no fifth-suit (Muster) art', cardFaces.every((f) => served.has(`${SUB}/${f}`)) && ![...served].some((f) => /muster/i.test(f)));
  check('config offers 2 to 4 players only', JSON.stringify(PLAYER_COUNTS) === '[2,3,4]');
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
  }
  check('only 2, 3 and 4 players are offered (5 is not)', JSON.stringify(await page.$$eval('input[name=players]', (e) => e.map((x) => x.value))) === '["2","3","4"]' && (await page.locator('input[name=players][value="5"]').count()) === 0);
  check('the stat strip says 2-4 players', /2-4[\s\S]*Players/.test(await page.textContent('.stats')));
  check('no rule book link anywhere on the landing page (no PDF link, no "rule book" text, no rules/ href)', (await page.locator('a[data-action=rulebook], a[href$=".pdf"], a[href*="rules/"]').count()) === 0 && !/rule\s?book/i.test(await page.textContent('body')) && !/rules\//.test(html));
  check('How to play on the page teaches v5 (two numbers on a card, the turn, Chase or Watch)', /two numbers/.test(await page.textContent('#how')) && /turns their whole hand round/.test(await page.textContent('#how')) && /Chase/.test(await page.textContent('#how')) && /Watch/.test(await page.textContent('#how')));
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
  check('no white patch in the corners of any card, Mountain or Colt image', out.white.length === 0, out.white.slice(0, 4).join(', '));
  check('no transparent hole inside any card face (sampled at seven interior points)', out.holes.length === 0, out.holes.slice(0, 4).join(', '));
  check('no asset is a placeholder or missing', (Array.isArray(manifest) ? manifest : manifest.assets).every((a) => a.status === 'real'), [...new Set((Array.isArray(manifest) ? manifest : manifest.assets).map((a) => a.status))].join(','));
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

await scenario('Responsive landing at every width, 4 seats', async () => {
  for (const w of WIDTHS) {
    const page = await newPage(w, 900, phoneOpts(w));
    await open(page);
    await page.check('input[name=players][value="4"]');
    check(`${w}px: no sideways scroll`, (await overflow(page)) <= 0);
    const out = await page.evaluate((vw) => [...document.querySelectorAll('main *, .landing *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1); }).length, w);
    check(`${w}px: nothing outside the viewport`, out === 0, `${out} elements`);
    check(`${w}px: four seat forms are shown, no fifth`, (await page.locator('.seatform:visible').count()) === 4 && (await page.locator('.seatform').count()) === 4);
    await shot(page, `landing-4-seats-${w}`);
    await page.close();
  }
});

await scenario('Human v bots to the end (every level, 2 to 4 players, every width)', async () => {
  // The full matrix at the first width; one table per level at the others.
  const full = [['easy', [2, 3, 4]], ['medium', [2, 3, 4]], ['hard', [2, 3, 4]]];
  const slim = [['easy', [3]], ['medium', [4]], ['hard', [2]]];
  for (const w of WIDTHS) {
    for (const [level, counts] of (w === WIDTHS[0] ? full : slim)) {
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
        check(`${tag}: the human made exactly one summit choice per hand`, s.summits === HANDS[n], JSON.stringify(s));
        const W = await seen(page);
        check(`${tag}: the Mountain showed its climb side and then its descent side, the marker climbed (at instant pace the sixth step can be skipped by the turn; the Turn scenario sees it) and never went past step 6`, W.sides.slice(0, 2).join() === 'climb,descent' && Math.max(...W.steps) >= 5 && Math.max(...W.steps) <= 6 && W.markerOnDescent === 0, JSON.stringify({ sides: W.sides.slice(0, 4), max: Math.max(...W.steps), onDescent: W.markerOnDescent }));
        check(`${tag}: no sideways scroll at the end`, (await overflow(page)) <= 0);
        if (level === 'hard') {
          const gap = await page.evaluate(() => window.__gap);
          check(`${tag}: the page never froze (longest main-thread gap under 250 ms)`, gap < 250, `${gap.toFixed(0)} ms`);
          check(`${tag}: decisions came from the Worker`, (await page.evaluate(() => document.body.dataset.botMode)) === 'worker');
        }
        const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{"games":[]}').games, STORE);
        check(`${tag}: the finished game was recorded once, as v5 (rules_code std, rules_version 5), with ${HANDS[n]} hands`, stored.length === 1 && stored[0].players === n && stored[0].rules_code === 'std' && stored[0].rules_version === 5 && stored[0].hands === HANDS[n], JSON.stringify(stored[0] && { players: stored[0].players, rules_code: stored[0].rules_code, v: stored[0].rules_version, hands: stored[0].hands }));
        if (w === WIDTHS[0] ? (n === 4 || n === 2) : true) await shot(page, `${level}-${n}p-end-${w}`);
        await page.close();
      }
    }
  }
});

await scenario('All-bot games at 2 to 4 seats', async () => {
  const mixes = { 2: ['easy', 'medium'], 3: ['medium', 'hard', 'easy'], 4: ['hard', 'medium', 'easy', 'easy'] };
  for (const w of WIDTHS) {
    for (const n of COUNTS) {
      if (w !== WIDTHS[0] && n !== 4) continue; // every count at the first width, the biggest table at the others
      const page = await newPage(w, 900, phoneOpts(w));
      await begin(page, { players: n, types: mixes[n] }, `seed=${n + 20}&botdelay=0`);
      await finish(page);
      check(`${w}px ${n} bots: finishes by itself with a ranking`, (await page.locator('.rank').count()) === n);
      check(`${w}px ${n} bots: no hand is shown`, (await page.locator('.hand .card').count()) === 0);
      const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games[0], STORE);
      check(`${w}px ${n} bots: recorded with ${HANDS[n]} hands and no human seat`, stored.hands === HANDS[n] && stored.seats.every((s) => s.type === 'bot'));
      if (n === 4 || n === 2) await shot(page, `bots-${n}-end-${w}`);
      await page.close();
    }
  }
});

await scenario('Pass-and-play: covers, the secret summit choice, and the cards turned together', async () => {
  for (const [n, humans, w] of [[2, 2, 1440], [3, 2, 390], [4, 3, 1024], [3, 3, 1440]]) {
    const page = await newPage(w, 900, phoneOpts(w));
    await page.addInitScript(() => {
      window.__seenBehindCover = 0;
      // Every cover, summit modal and reveal, in order, recorded at the moment the DOM changes (not by polling, which
      // can miss a cover that is confirmed between two polls when the bots play instantly).
      window.__trace = [];
      document.addEventListener('DOMContentLoaded', () => {
        let last = '';
        let revealOn = false;
        new MutationObserver(() => {
          if (document.querySelector('.cover') && document.querySelector('.hand, .card, .table, .seat, .log__list, .mountain, .row, .decision, .schip')) window.__seenBehindCover++;
          const cover = document.querySelector('.cover');
          const modal = document.querySelector('.overlay--summit');
          const rev = document.querySelector('.overlay--reveal');
          if (rev && !revealOn) window.__trace.push({ kind: 'reveal', faces: rev.querySelectorAll('.reveal__card').length, names: [...rev.querySelectorAll('.reveal__who')].map((e) => e.textContent) });
          revealOn = !!rev;
          let ev = null;
          if (cover) ev = { kind: 'cover', name: (/Pass to (\S+)/.exec(cover.textContent) || [])[1] || null, summit: /Chase or Watch in secret/.test(cover.textContent) };
          else if (modal) ev = { kind: 'modal', name: ((document.querySelector('#summit-title') || { textContent: '' }).textContent.match(/^(\S+?)[,:]/) || [])[1] || null, sides: document.querySelectorAll('.seat .schip--chase, .seat .schip--watch').length, own: document.querySelectorAll('.seat .schip--own').length, reveal: !!rev };
          const key = ev ? JSON.stringify(ev) : '';
          if (ev && key !== last) window.__trace.push(ev);
          if (ev) last = key;
        }).observe(document.body, { childList: true, subtree: true });
      });
    });
    await begin(page, { players: n, types: Array.from({ length: n }, (_, i) => (i < humans ? 'human' : 'easy')), names: ['Ann', 'Bo', 'Cy'] }, `seed=${n + 40}&botdelay=40`);
    await page.waitForSelector('.cover', { timeout: 30000 });
    const tag = `${humans} humans in ${n}p at ${w}px`;
    if (w < 700) await shot(page, `cover-${n}p-${w}`);
    const cover = await page.$eval('.cover', (e) => { const r = e.getBoundingClientRect(); return [r.width, r.height, innerWidth, innerHeight]; });
    check(`${tag}: the cover fills the viewport`, cover[0] >= cover[2] - 1 && cover[1] >= cover[3] - 1);
    check(`${tag}: the cover names no cards or scores`, !/\d+ pts|Total|[A-Z][a-z]+ \d+/.test((await page.textContent('.cover')).replace(/Pass to .*?(show my hand|make my choice)/, '')));
    check(`${tag}: the bug button is hidden under the cover and Ctrl+Shift+B opens nothing`, !(await page.isVisible('#bug-button')) && await (async () => { await page.keyboard.press('Control+Shift+B'); await page.waitForTimeout(150); return (await page.locator('.bug, #bug-form').count()) === 0; })());
    // Play on, looking at every cover and every summit modal on the way.
    const st = newStats();
    const obs = { summitCovers: 0, summitModals: 0, coverLeak: 0, bugVisible: 0, sidesShown: 0, nameMismatch: 0, ownChipEarly: 0 };
    let lastCoverName = null;
    let coverSeenLast = false;
    const deadline = Date.now() + 200000;
    while (Date.now() < deadline) {
      if (await page.locator('.end--game').count()) break;
      const coverNow = (await page.locator('.cover').count()) > 0;
      if (coverNow) {
        const txt = await page.textContent('.cover');
        lastCoverName = (/Pass to (\S+)/.exec(txt) || [])[1] || null;
        if (/Chase or Watch in secret/.test(txt)) {
          obs.summitCovers++;
          if (await page.locator('.mountain, .decision, .overlay, .seat, .hand, #log, .schip, .row').count()) obs.coverLeak++;
        }
        if (await page.isVisible('#bug-button')) obs.bugVisible++;
      } else if (await page.locator('.overlay--summit').count()) {
        obs.summitModals++;
        if (await page.locator('.seat .schip--chase, .seat .schip--watch').count()) obs.sidesShown++;
        if (await page.locator('.seat .schip--own').count()) obs.ownChipEarly++;
        const title = await page.textContent('#summit-title');
        if (lastCoverName && !title.startsWith(lastCoverName)) { obs.nameMismatch++; obs.mismatch = `${lastCoverName} then ${title}; cover seen just before: ${coverSeenLast}`; }
      }
      coverSeenLast = coverNow;
      await humanStep(page, st);
    }
    check(`${tag}: the game ends`, (await page.locator('.end--game').count()) === 1, JSON.stringify(st));
    check(`${tag}: a cover before every human decision, never a leak`, st.covers >= 6 && st.leaks === 0 && (await page.evaluate(() => window.__seenBehindCover)) === 0, JSON.stringify(st));
    check(`${tag}: a "Chase or Watch in secret" cover came before each human summit choice, with nothing of the table behind it and the bug button dead`, obs.summitCovers >= humans && obs.summitModals >= humans && obs.coverLeak === 0 && obs.bugVisible === 0, JSON.stringify(obs));
    // The verdict comes from the in-page trace (every cover, modal and reveal as it was drawn), not from the polling above.
    const trace = await page.evaluate(() => window.__trace);
    const tr = { modals: 0, noCover: 0, nameMismatch: 0, sides: 0, own: 0, first: null, reveals: 0, revealFaces: [], modalsPerName: {} };
    trace.forEach((e, i) => {
      if (e.kind === 'reveal') { tr.reveals++; tr.revealFaces.push(e.faces); return; }
      if (e.kind !== 'modal') return;
      tr.modals++;
      tr.modalsPerName[e.name] = (tr.modalsPerName[e.name] || 0) + 1;
      const prev = trace[i - 1];
      if (!prev || prev.kind !== 'cover' || !prev.summit) { tr.noCover++; tr.first = tr.first || `modal for ${e.name} with no summit cover just before (${prev ? `${prev.kind} for ${prev.name}` : 'nothing'})`; }
      else if (prev.name !== e.name) { tr.nameMismatch++; tr.first = tr.first || `cover for ${prev.name} then modal for ${e.name}`; }
      tr.sides += e.sides; tr.own += e.own;
    });
    check(`${tag}: every human got their own summit cover and modal in every hand (${humans} x ${HANDS[n]}), none shows a side, nobody's own choice is already on show, and each modal follows its own cover`, tr.modals === humans * HANDS[n] && Object.values(tr.modalsPerName).every((k) => k === HANDS[n]) && tr.sides === 0 && tr.own === 0 && tr.nameMismatch === 0 && tr.noCover === 0 && obs.sidesShown === 0 && obs.ownChipEarly === 0, JSON.stringify({ trace: tr, polled: obs }));
    check(`${tag}: the cards were turned together, once a hand, with a face for each of the ${n} seats, only after the last choice`, tr.reveals === HANDS[n] && tr.revealFaces.every((f) => f === n), JSON.stringify({ reveals: tr.reveals, faces: tr.revealFaces }));
    await page.close();
  }
});

await scenario('Summit: the modal, Chase cost by player count, the reveal order and the dimmed backdrop', async () => {
  for (const [w, n] of [...WIDTHS.map((x) => [x, 4]), [WIDTHS[0], 2], [WIDTHS[0], 3]]) {
    const page = await newPage(w, 900, phoneOpts(w));
    const tg = revealTarget(n);
    if (!check(`${w}px ${n}p: a seed whose summit is collected from another seat than yours was found`, !!tg)) { await page.close(); continue; }
    await begin(page, { players: n, types: types(n) }, `seed=${tg.seed}&botdelay=1000`);
    await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
    await watch(page);
    // Instant for the climb (Speed: Normal -> Fast -> Instant), then back to Normal so the reveal beat lasts about three seconds.
    const speed = () => page.evaluate(() => document.querySelector('[data-action=speed]').click());
    await speed(); await speed();
    const st = newStats();
    const until = Date.now() + 90000;
    page.__noDecide = true;
    while (Date.now() < until && !(await page.locator('.overlay--summit').count())) await humanStep(page, st);
    page.__noDecide = false;
    const tag = `${w}px ${n}p`;
    check(`${tag}: the summit modal comes up`, (await page.locator('.overlay--summit').count()) === 1);
    await page.waitForFunction(() => [...document.querySelectorAll('.overlay--summit img')].every((i) => i.complete), null, { timeout: 8000 }).catch(() => {});
    const m = await page.evaluate(() => {
      const o = document.querySelector('.overlay--summit');
      const r = o.querySelector('.end').getBoundingClientRect();
      return {
        text: o.textContent, dialog: !!o.querySelector('[role=dialog][aria-modal=true]'), row: o.querySelectorAll('.summit__brumby').length, hand: o.querySelectorAll('.summit__hand li').length,
        handTurned: [...o.querySelectorAll('.summit__hand img')].every((i) => i.classList.contains('is-turned')), buttons: o.querySelectorAll('[data-action=decide]').length,
        chase: o.querySelector('.decide--chase .decide__card').getAttribute('src'), watch: o.querySelector('.decide--watch .decide__card').getAttribute('src'),
        loaded: [...o.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0), fits: r.left >= 0 && r.right <= innerWidth, banner: document.querySelector('.phasebar').textContent,
        sidesOnSeats: document.querySelectorAll('.seat .schip--chase, .seat .schip--watch').length, over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    check(`${tag}: the modal shows your turned hand (6 cards, rotated), the six-card Brumby row and a Chase and a Watch card, all loaded`, m.dialog && m.row === 6 && m.hand === 6 && m.handTurned && m.buttons === 2 && m.loaded && /Your hand, turned round/.test(m.text), JSON.stringify({ ...m, text: undefined }));
    check(`${tag}: Chase costs ${COST[n]} (the chase-${COST[n]} face, "Chase: pay ${COST[n]}"), Watch pays nothing`, m.chase === `assets/cards/chase-${COST[n]}.webp` && m.watch === 'assets/cards/watch.webp' && new RegExp(`Chase: pay ${COST[n]}`).test(m.text) && /Watch: pay nothing/.test(m.text) && new RegExp(`A chaser pays ${COST[n]} at the end of the hand`).test(m.text), JSON.stringify({ chase: m.chase }));
    check(`${tag}: the banner says the summit, hands turned, Home is trumps`, /The summit/.test(m.banner) && /Hands turned/.test(m.banner) && /Home is trumps/.test(m.banner), m.banner);
    check(`${tag}: no seat shows a side before the reveal, the modal fits and nothing scrolls sideways`, m.sidesOnSeats === 0 && m.fits && m.over <= 0);
    await page.waitForTimeout(80);
    await shot(page, `summit-modal-${n}p-${w}`);
    await dimCheck(page, `${tag} summit modal`);
    page.__policy = 'chase';
    await speed();
    await humanStep(page, st);
    await page.waitForSelector('.overlay--reveal', { timeout: 15000 });
    await page.waitForTimeout(350);
    await shot(page, `reveal-${n}p-${w}`);
    await dimCheck(page, `${tag} reveal`);
    const W = await seen(page);
    const rv = W.reveals[W.reveals.length - 1];
    const expected = ['You', ...Array.from({ length: n - 1 }, (_, k) => `Easy bot ${k + 2}`)];
    check(`${tag}: the reveal lists You first, then the seats clockwise, though the choices were collected from seat ${tg.order[0] + 1} (the last climb winner)`, rv && rv.names.join('|') === expected.join('|') && rv.faces.length === n, JSON.stringify(rv && rv.names));
    check(`${tag}: your own face is Chase and each other seat shows one Chase or Watch card`, rv && rv.faces[0] === 'chase' && rv.faces.every((f) => f === 'chase' || f === 'watch'));
    await page.close();
  }
});

await scenario('The hand turns at the summit and the Mountain card turns over', async () => {
  const SUIT_ORDER = ['escape', 'climb', 'descent', 'home'];
  const order = (cards, key) => cards.every((c, i) => {
    if (i === 0) return true;
    const p = cards[i - 1];
    const sp = SUIT_ORDER.indexOf(p.suit); const sc = SUIT_ORDER.indexOf(c.suit);
    return sp < sc || (sp === sc && key(p.v) < key(c.v));
  });
  const parse = (id) => { const [suit, v] = id.split('-'); return { suit, v: Number(v) }; };
  for (const [w, n] of [...WIDTHS.map((x) => [x, 4]), [WIDTHS[0], 2], [WIDTHS[0], 3]]) {
    const page = await newPage(w, 900, phoneOpts(w));
    await begin(page, { players: n, types: types(n), names: ['Mia'] }, 'seed=11&botdelay=150');
    await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
    await watch(page);
    const tag = `${w}px ${n}p`;
    await page.waitForFunction(() => [...document.querySelectorAll('.hand .cardimg')].every((i) => i.complete), null, { timeout: 8000 }).catch(() => {});
    const before = await page.evaluate(() => ({ cards: [...document.querySelectorAll('.hand .card')].map((e) => e.dataset.card), turned: document.querySelectorAll('.hand--turned, .hand .is-turned').length, src: document.querySelector('.mountain__img').getAttribute('src'), side: document.querySelector('.mountain').dataset.side, trump: document.querySelector('.mountain__trump').textContent.trim(), marker: document.querySelectorAll('.mountain__marker').length }));
    check(`${tag} before the summit: 12 cards climb side up in suit order, ascending by the climb number; the Mountain shows its climb side with the marker; Escape is trumps going up`, before.cards.length === 12 && before.turned === 0 && order(before.cards.map(parse), (v) => v) && before.src === 'assets/cards/mountain-up.webp' && before.side === 'climb' && before.marker === 1 && /Escape is trumps going up/.test(before.trump), JSON.stringify(before));
    await shot(page, `climb-start-${n}p-${w}`);
    // play up to the summit, then through to the first descent card
    const st = newStats();
    const until = Date.now() + 45000;
    let after = null;
    while (Date.now() < until && !after) {
      const r = await humanStep(page, st);
      if (r === 'end') break;
      if (await page.locator('.phasebar--descent').count() && (await page.locator('.hand--turned .card.is-legal').count()) > 0 && !(await page.locator('.overlay--turn, .overlay--reveal').count())) {
        await page.waitForFunction(() => [...document.querySelectorAll('.hand .cardimg')].every((i) => i.complete), null, { timeout: 5000 }).catch(() => {});
        after = await page.evaluate(() => ({
          cards: [...document.querySelectorAll('.hand .card')].map((e) => e.dataset.card),
          allTurned: [...document.querySelectorAll('.hand .card img')].every((i) => i.classList.contains('is-turned')),
          matrix: [...document.querySelectorAll('.hand .card img')].map((i) => getComputedStyle(i).transform),
          src: document.querySelector('.mountain__img').getAttribute('src'), side: document.querySelector('.mountain').dataset.side,
          trump: document.querySelector('.mountain__trump').textContent.trim(), marker: document.querySelectorAll('.mountain__marker').length,
          legend: (document.querySelector('.handbox__title') || {}).textContent, banner: document.querySelector('.phasebar').textContent,
        }));
        await shot(page, `descent-first-${n}p-${w}`);
      }
    }
    const W = await seen(page);
    const rot = (t) => { const m = /matrix\(([^)]+)\)/.exec(t); if (!m) return false; const [a, b, c, d] = m[1].split(',').map(Number); return a < -0.99 && d < -0.99 && Math.abs(b) < 0.01 && Math.abs(c) < 0.01; };
    check(`${tag} after the summit: the hand is six cards, every one rotated 180 degrees, in suit order ascending by the number now on top (13 minus the climb number)`,
      !!after && after.cards.length === 6 && after.allTurned && after.matrix.every(rot) && order(after.cards.map(parse), (v) => 13 - v), JSON.stringify(after && { cards: after.cards, turned: after.allTurned, m: after.matrix[0] }));
    check(`${tag} after the summit: the Mountain card turned over (descent side, no marker) and Home is trumps going down; the hand heading says turned round`, !!after && after.src === 'assets/cards/mountain-down.webp' && after.side === 'descent' && after.marker === 0 && /Home is trumps going down/.test(after.trump) && /turned round/.test(after.legend), JSON.stringify(after && { src: after.src, trump: after.trump, legend: after.legend }));
    check(`${tag} the turn is its own beat ("Everyone turns their hand round" was shown), the hand was never half turned, no marker stood on the descent side`, W.turnBeats > 0 && W.upright === 0 && W.turnedFrames > 0 && W.markerOnDescent === 0, JSON.stringify({ beats: W.turnBeats, upright: W.upright, frames: W.turnedFrames }));
    check(`${tag} the marker climbed one step per trick, 0 to 6, and the Mountain went climb then descent`, Math.max(...W.steps) === 6 && W.steps.slice(0, 7).join() === '0,1,2,3,4,5,6' && W.sides.slice(0, 2).join() === 'climb,descent', JSON.stringify({ steps: W.steps.slice(0, 10), sides: W.sides.slice(0, 3) }));
    check(`${tag} the three phase banners were shown in order: climb, summit, descent`, W.phases.slice(0, 3).join() === 'climb,summit,descent', W.phases.join());
    check(`${tag}: no sideways scroll`, (await overflow(page)) <= 0);
    await page.close();
  }
});

await scenario('Every kind of hand: the reckoning, the row and the kept cards', async () => {
  for (const kind of Object.keys(KINDS)) {
    const t = handTarget(kind);
    if (!check(`a game with "${kind}" was found by seed search`, !!t)) continue;
    const widths = kind === 'nobody chases' || kind === 'everyone chases' || kind === 'the Colt in the row, kept by a chaser' ? WIDTHS : [WIDTHS[0], WIDTHS[WIDTHS.length - 1]];
    for (const w of widths) {
      const page = await newPage(w, 900, phoneOpts(w));
      page.__policy = t.policy;
      await begin(page, { players: t.players, types: types(t.players), names: ['Mia'] }, `seed=${t.seed}&botdelay=0`);
      await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
      await watch(page);
      const wantTitle = `Hand ${t.handIdx + 1} of `;
      const s1 = await playHuman(page, 120000, null, { stopAtReckoning: async () => (await page.textContent('#hand-title')).startsWith(wantTitle), onSummary: () => resetWatch(page) });
      const tag = `${w}px ${kind} (${t.players}p)`;
      if (!check(`${tag}: the reckoning of hand ${t.handIdx + 1} came up`, s1.stopped === 'stop' && (await page.locator('.overlay--hand').count()) === 1, JSON.stringify(s1))) { await page.close(); continue; }
      await page.waitForFunction(() => [...document.querySelectorAll('.reck img')].every((i) => i.complete), null, { timeout: 5000 }).catch(() => {});
      const rec = await readReckoning(page);
      const ev = t.ev;
      const rowsOk = rec.rows.length === t.players && rec.rows.every((r, s) => {
        const e = expectedRow(ev.breakdown[s]);
        return r.seat === s && r.ud === e.ud && r.choice === e.choice && r.sum === e.sum && r.kept === e.kept && r.cls.includes(`reck__row--${ev.breakdown[s].choice}`);
      });
      check(`${tag}: a row per seat, each with its tricks up and down, Chase/Watch card, the sum, the Brumby cards kept (${ev.kept.map((k) => k.length).join('/')}) and the Chase cost, as the engine has them`, rowsOk, JSON.stringify(rec.rows.map((r) => [r.ud, r.choice, r.sum, r.kept])) + ' vs ' + JSON.stringify(ev.breakdown.map(expectedRow).map((e) => [e.ud, e.choice, e.sum, e.kept])));
      check(`${tag}: every hand score and running total matches the engine's own`, rec.rows.map((r) => r.score).join() === ev.scores.join() && rec.rows.map((r) => r.total).join() === ev.totals.join(), `${rec.rows.map((r) => r.score)} vs ${ev.scores}; ${rec.rows.map((r) => r.total)} vs ${ev.totals}`);
      check(`${tag}: the Chase cost shown is ${COST[t.players]} for ${t.players} players`, rec.rows.filter((r) => /^Chase/.test(r.choice)).every((r) => r.choice === `Chase -${COST[t.players]}`));
      check(`${tag}: the lead note gives the row's value (${signed(ev.rowValue)}) and its six cards`, rec.lead.includes(`The row was worth ${signed(ev.rowValue)}: ${ev.row.map((id) => signed(brumbyValue(id))).join(' ')}.`), rec.lead);
      if (ev.chasers === 0) check(`${tag}: the note says nobody chased and every Brumby card was sent off`, /Nobody chased, so every Brumby card was sent off/.test(rec.lead) && rec.rows.every((r) => r.choice === 'Watch' && r.kept === 0), rec.lead);
      else check(`${tag}: the note does not claim that nobody chased`, !/Nobody chased/.test(rec.lead));
      if (ev.colt) check(`${tag}: the Colt is explained (${ev.coltKept ? 'won and kept' : 'won by a watcher and sent off'})`, ev.coltKept ? /won the Colt/.test(rec.lead) && /\+4\) and kept it/.test(rec.lead) : /was won by .*who watched, so it was sent off/.test(rec.lead), rec.lead);
      else check(`${tag}: no Colt in the row, none mentioned`, !/Colt/.test(rec.lead));
      check(`${tag}: ${ev.reshuffleNext ? 'the note says the 12 Brumby cards are shuffled again' : 'no reshuffle is announced'}`, /Fewer than 6 Brumby cards are left, so all 12 are shuffled/.test(rec.foot) === !!ev.reshuffleNext, rec.foot);
      check(`${tag}: the button reads "Deal the next hand"`, rec.button === 'Deal the next hand', rec.button);
      const W = await seen(page);
      const keptTotal = ev.kept.reduce((a, k) => a + k.length, 0);
      check(`${tag} on the table: all six row cards were taken (${keptTotal} kept by chasers, ${6 - keptTotal} sent off), the next prize was lit, kept cards showed on the chasers' seats${ev.colt && ev.coltKept ? ', the Colt among them' : ''}`,
        W.rowTakenMax === 6 && W.takenKept === keptTotal && W.takenOff === 6 - keptTotal && W.nextLit >= 1 && W.keptMax === keptTotal && W.coltSeenKept === !!(ev.colt && ev.coltKept) && W.coltInRow === !!ev.colt, JSON.stringify(W));
      check(`${tag} on the table: the discard pile grew by the ${6 - keptTotal} Brumby cards sent off`, W.discardMax >= 6 - keptTotal, `${W.discardMax}`);
      check(`${tag}: no sideways scroll with the reckoning up`, (await overflow(page)) <= 0);
      await shot(page, `${slug(kind)}-${w}`);
      await dimCheck(page, `${tag} reckoning`);
      await tryClick(page.locator('#continue'));
      const s2 = await playHuman(page, 120000);
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
      }));
      check(`${tag}: the totals on screen are the engine's`, [...out.totals].sort().join() === [...r.totals].sort().join(), `${out.totals} vs ${r.totals}`);
      check(`${tag}: ${r.winners.length} winner${r.winners.length === 1 ? '' : 's'} marked, the engine's seats`, out.winners === r.winners.length && [...out.winnerNames].sort().join() === r.winners.map((s) => t.names[s]).sort().join(), `${out.winnerNames} vs ${r.winners.map((s) => t.names[s])}`);
      check(`${tag}: each ranking line shows the last-hand score`, out.lastHand.length === t.players && out.lastHand.every((x) => /^last hand -?\d+$/.test(x)));
      const tied = r.tiedOnTotal.map((s) => t.names[s]);
      if (label === 'tiebreak') {
        check(`${tag}: the tiebreak line names the tied seats, the total, the last-hand points and the winner`, new RegExp(`tied on ${r.winningScore}\\.`).test(out.tb) && tied.every((nm) => out.tb.includes(nm)) && /Tiebreak: the most points in the last hand/.test(out.tb) && /Points in the last hand: /.test(out.tb) && /\bwins?\b/.test(out.tb) && !/share the win|Still level/.test(out.tb), out.tb);
        check(`${tag}: the headline is not a shared win and the crown says Winner`, !/Shared/.test(out.head) && out.crowns.every((c) => c === 'Winner'), out.head);
      } else {
        check(`${tag}: the headline says shared win and the tiebreak line says still level`, /^Shared win/.test(out.head) && /Still level, so the win is shared/.test(out.tb) && out.crowns.every((c) => c === 'Shared win'), `${out.head} / ${out.tb}`);
        check(`${tag}: the tied seats share rank 1 (shown "=1")`, out.ranks.filter((x) => x === '=1').length === r.winners.length, out.ranks.join());
      }
      check(`${tag}: no sideways scroll on the end screen`, (await overflow(page)) <= 0);
      await shot(page, `${label}-${w}`);
      await page.close();
    }
  }
});

await scenario('Stats screen, exports, a migrated v4 record and analytics', async () => {
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
  // The ctx blocks the consent banner and Google; events are read back from dataLayer. The v4 record is planted before the page's own code runs.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript((a) => { try { if (!localStorage.getItem(a.k)) localStorage.setItem(a.k, JSON.stringify({ v: 1, games: [a.rec] })); } catch { /* ignore */ } }, { k: STORE, rec: V4_RECORD });
  await ctx.route(/cdn-cookieyes\.com|googletagmanager\.com|google-analytics\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource|fonts\.(googleapis|gstatic)\.com/.test(m.text())) problems.push(`[${current}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${current}] pageerror: ${e.message}`));
  await open(page);
  const planted = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games, STORE);
  check('a v4 record is in the browser as the old game wrote it (rules_code "std", no rules_version); it is relabelled when read, and saved relabelled with the next game', planted.length === 1 && planted[0].id === 'gplanted-4' && planted[0].rules_code === 'std' && planted[0].rules_version === undefined, JSON.stringify(planted.map((g) => [g.id, g.rules_code, g.rules_version])));
  await page.click('.landing [data-action=open-stats]');
  await page.waitForSelector('.dialog .st');
  const leadOnly = await page.textContent('.dialog .st__lead');
  check('with only the v4 record the stats screen opens on it, labelled as the old rules, with the mob section and no NaN', /^\s*1\s+game played under Old rules/.test(leadOnly) && (await page.locator('.st h3', { hasText: 'The mob and the summit' }).count()) === 1 && !/NaN|undefined/.test(await page.textContent('.dialog .st')), leadOnly);
  await page.keyboard.press('Escape');
  for (let i = 0; i < 3; i++) {
    await configure(page, { players: 3 + (i % 2), types: ['easy', 'easy', 'medium', 'easy'] });
    await page.click('#start');
    await finish(page);
    if (i < 2) { await page.click('.end [data-action=new]'); await page.waitForSelector('#setup-form'); }
  }
  await page.click('.end [data-action=open-stats]');
  await page.waitForSelector('.dialog .st');
  const lead = await page.textContent('.dialog .st__lead');
  check('three v5 games listed under the current rules, apart from the v4 record', /^\s*3\s+games played under Current rules/.test(lead), lead);
  const opts = await page.$$eval('[data-action=stats-filter] option', (os) => os.map((o) => `${o.value}:${o.textContent.trim()}`));
  check('the rules filter lists v5 (3 games) and v4 (1 game)', opts.length === 2 && opts[0].startsWith('std:Current rules (v5) (3)') && opts[1].startsWith('v4:Old rules') && opts[1].endsWith('(1)'), opts.join(' | '));
  const sections = await page.$$eval('.st h3', (hs) => hs.map((h) => h.textContent));
  check('the v5 screen has the Chase, Watch and Brumby row section and no mob section', sections.includes('Chase, Watch and the Brumby row') && !sections.includes('The mob and the summit') && !/NaN|undefined/.test(await page.textContent('.dialog .st')), sections.join(' | '));
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games, STORE);
  const v5 = stored.filter((g) => g.rules_version === 5);
  check('the store holds the v4 record and three v5 records, each with an id and a seed', stored.length === 4 && v5.length === 3 && v5.every((g) => g.rules_code === 'std' && g.id && g.seed !== undefined) && stored.filter((g) => g.rules_code === 'v4').length === 1);
  await shot(page, 'stats-1440');
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]);
  const csvText = fs.readFileSync(await csvDl.path(), 'utf8');
  const rows = csvText.trim().split('\n');
  check('CSV: LF only, a header and a row per game (v4 and v5 together), every row the same field count', rows.length === 5 && !csvText.includes('\r') && rows.every((r) => r.split(',').length === rows[0].split(',').length), String(rows.length));
  check('CSV: the v4 row carries ",v4,4," and the v5 rows ",std,5,"', rows.filter((r) => r.includes(',v4,4,')).length === 1 && rows.filter((r) => r.includes(',std,5,')).length === 3);
  check('CSV: the file is named for the game and the date', /^snowy-river-stats-\d{4}-\d{2}-\d{2}\.csv$/.test(csvDl.suggestedFilename()), csvDl.suggestedFilename());
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-json]')]);
  const exported = JSON.parse(fs.readFileSync(await jsonDl.path(), 'utf8'));
  check('JSON equals the store, with the v4 record relabelled', JSON.stringify(exported.games) === JSON.stringify(stored) && exported.games.some((g) => g.id === 'gplanted-4' && g.rules_code === 'v4' && g.rules_version === 4));
  await page.selectOption('[data-action=stats-filter]', 'v4');
  await page.waitForSelector('.st h3:has-text("The mob and the summit")');
  const lead4 = await page.textContent('.dialog .st__lead');
  check('choosing the old rules shows the one v4 game with its own mob section, no NaN', /^\s*1\s+game played under Old rules/.test(lead4) && !/NaN|undefined/.test(await page.textContent('.dialog .st')), lead4);
  await shot(page, 'stats-v4-1440');
  await page.keyboard.press('Escape');
  // analytics, read back from dataLayer
  const calls = await events(page);
  const names = calls.map((c) => c[1]);
  check('analytics: game_start x3, hand_end once per hand played (3 + 4 + 3), game_end x3, stats_viewed and stats_exported x2 fired', names.filter((x) => x === 'game_start').length === 3 && names.filter((x) => x === 'game_end').length === 3 && names.filter((x) => x === 'hand_end').length === v5.reduce((a, g) => a + g.hands, 0) && names.includes('stats_viewed') && names.filter((x) => x === 'stats_exported').length === 2, JSON.stringify(names.reduce((o, x) => ({ ...o, [x]: (o[x] || 0) + 1 }), {})));
  check('analytics: every event name is known and every parameter is on the whitelist', names.every((x) => EVENT_NAMES.includes(x)) && calls.every((c) => Object.keys(c[2] || {}).every((k) => ALLOWED_PARAMS.includes(k))), [...new Set(calls.flatMap((c) => Object.keys(c[2] || {})))].join(','));
  check('analytics: every value is a number or a short token, and nothing names a player', calls.every((c) => Object.values(c[2] || {}).every((v) => typeof v === 'number' || /^[A-Za-z0-9_,.+-]{1,60}$/.test(v))) && !/Player|You|bot 1/.test(JSON.stringify(calls)));
  check('analytics: game_name is snowy-river on every event; no mob or escape parameters (v4 names) are sent', calls.every((c) => c[2] && c[2].game_name === 'snowy-river') && !/mobs_home|escapes/.test(JSON.stringify(calls)));
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
  await shot(phone, 'stats-390');
  await phone.close();
});

await scenario('Bug reporter', async () => {
  const page = await newPage();
  await open(page);
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
  await shot(page, 'bug-modal');
  const [dl1] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  const rep = JSON.parse(fs.readFileSync(await dl1.path(), 'utf8'));
  check('mid-game: the report holds the v5 state (3 players, climb phase) and the action log', rep.game && rep.game.n === 3 && rep.game.phase === 'climb' && rep.game.rulesCode === 'std' && rep.actionLog.length >= 3);
  await page.keyboard.press('Escape');
  // at the summit: the report is still a valid snapshot (a single human sees the full state: it is their own bug report)
  const st = newStats();
  page.__noDecide = true;
  const until = Date.now() + 90000;
  while (Date.now() < until && !(await page.locator('.overlay--summit').count())) await humanStep(page, st);
  page.__noDecide = false;
  await page.keyboard.press('Control+Shift+B');
  const formAtSummit = await page.waitForSelector('#bug-form', { timeout: 3000 }).then(() => true, () => false);
  if (formAtSummit) {
    const [dlS] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
    const repS = JSON.parse(fs.readFileSync(await dlS.path(), 'utf8'));
    check('at the summit: the report downloads and says the game is at the summit', repS.game && repS.game.phase === 'summit' && Array.isArray(repS.game.row) && repS.game.row.length === 6);
    await page.keyboard.press('Escape');
  } else check('at the summit: the bug reporter opens over the summit modal', false);
  await playHuman(page);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  check('end screen: a report downloads', JSON.parse(fs.readFileSync(await dl2.path(), 'utf8')).game.phase === 'over');
  await page.keyboard.press('Escape');
  await page.close();
  for (const w of WIDTHS) {
    const p = await newPage(w, 900, phoneOpts(w));
    await begin(p, { players: 4 });
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

await scenario('Rules dialog (no rule book link)', async () => {
  for (const w of WIDTHS) {
    const page = await newPage(w, 800, phoneOpts(w));
    await open(page);
    await page.click('.landing [data-action=open-rules]');
    check(`${w}px: the dialog opens with the eight steps, has no link of any kind, and fits`, (await page.locator('.dialog .how__steps > li').count()) === 8 && (await page.locator('.dialog a').count()) === 0 && (await page.locator('.dialog a[data-action=rulebook]').count()) === 0 && (await overflow(page)) <= 0);
    check(`${w}px: the dialog teaches Chase, Watch, the turn of the hand and the 2/3 Chase cost`, /Chase/.test(await page.textContent('.dialog')) && /turns their whole hand round/.test(await page.textContent('.dialog')) && /pay 2 \(3 with two players\)|you pay 2/.test(await page.textContent('.dialog')) && !/rule book/i.test(await page.textContent('.dialog')));
    if (w === 390) await shot(page, 'rules-390');
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
  check('in a game: the Rules button opens the dialog, again without a link', (await g.locator('.dialog .how__steps > li').count()) === 8 && (await g.locator('.dialog a').count()) === 0);
  await g.keyboard.press('Escape');
  await g.close();
});

await scenario('Responsive sweep: 2, 3 and 4 players at every width', async () => {
  for (const w of WIDTHS) {
    for (const n of COUNTS) {
      const page = await newPage(w, 844, phoneOpts(w));
      await begin(page, { players: n, types: ['human', 'medium', 'easy', 'easy'] }, 'seed=9&botdelay=0');
      await page.waitForSelector('.hand .card.is-legal');
      const first = await page.$$eval('.hand .card', (cs) => cs.map((c) => c.getBoundingClientRect().width));
      check(`${w}px ${n}p: first screen fits and hand cards are at least 36 px wide`, (await overflow(page)) <= 0 && Math.min(...first) >= 36, `min ${Math.min(...first).toFixed(0)}`);
      if (n === 4) await shot(page, `start-${n}p-${w}`);
      let sawSummary = false;
      for (let i = 0; i < 400 && !sawSummary; i++) { await humanStep(page, newStats()); if (await page.locator('#continue').count()) sawSummary = true; }
      if (sawSummary) {
        check(`${w}px ${n}p: the reckoning fits`, (await overflow(page)) <= 0 && (await page.locator('.reck__row').count()) === n);
        if (n === 4) await shot(page, `reckoning-${n}p-${w}`);
        await tryClick(page.locator('#continue'));
      }
      const s = await playHuman(page);
      check(`${w}px ${n}p: the end panel shows and nothing scrolls sideways`, (await page.locator('.end--game').count()) === 1 && (await overflow(page)) <= 0, JSON.stringify(s));
      if (n === 4) await shot(page, `end-${n}p-${w}`);
      await page.close();
    }
  }
});

await scenario('Reduced motion', async () => {
  const dflt = await newPage();
  await begin(dflt, { players: 3 }, 'seed=11&botdelay=800');
  await dflt.waitForSelector('.hand .card.is-legal');
  check('by default cards and the marker transition', parseFloat(await dflt.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) > 0 && parseFloat(await dflt.$eval('.mountain__marker', (e) => getComputedStyle(e).transitionDuration)) > 0);
  await dflt.close();
  const rm = await newPage(1280, 900, { reducedMotion: 'reduce' });
  await begin(rm, { players: 3 }, 'seed=11&botdelay=800');
  await rm.waitForSelector('.hand .card.is-legal');
  check('with reduced motion the transitions and animations are off, the marker too', parseFloat(await rm.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) === 0 && parseFloat(await rm.$eval('.mountain__marker', (e) => getComputedStyle(e).transitionDuration)) === 0 && (await rm.$eval('.seat', (e) => getComputedStyle(e).animationName)) === 'none');
  // through the summit with reduced motion: the turned hand and the Mountain still change, with no animation left running
  await watch(rm);
  const st = newStats();
  rm.__policy = 'watch';
  const until = Date.now() + 120000;
  while (Date.now() < until && !(await rm.locator('.phasebar--descent').count())) await humanStep(rm, st);
  await rm.waitForTimeout(400);
  const after = await rm.evaluate(() => ({ turned: document.querySelectorAll('.hand--turned').length, side: document.querySelector('.mountain').dataset.side, anims: document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations === Infinity).length }));
  check('with reduced motion the hand is still turned and the Mountain still shows its descent side after the summit, with no endless animation', after.turned === 1 && after.side === 'descent' && after.anims === 0, JSON.stringify(after));
  await rm.close();
});

await scenario('Keyboard play', async () => {
  const page = await newPage();
  await begin(page, { players: 3, auto: false });
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
  // The summit choice by keyboard: Tab stays inside the modal, Enter on Chase chooses it.
  const st = newStats();
  const until = Date.now() + 90000;
  page.__noDecide = true;
  while (Date.now() < until && !(await page.locator('.overlay--summit').count())) await humanStep(page, st);
  page.__noDecide = false;
  check('the summit modal takes focus', await page.evaluate(() => !!document.activeElement.closest('.overlay--summit')), await page.evaluate(() => `${document.activeElement.tagName}.${document.activeElement.className} overlays: ${[...document.querySelectorAll('.overlay')].map((o) => o.className).join(',')}`));
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
  check('Tab cycles inside the summit modal', await page.evaluate(() => !!document.activeElement.closest('.overlay--summit')));
  await page.focus('.overlay--summit .decide--chase');
  await page.keyboard.press('Enter');
  check('Enter on the Chase card chooses it (the modal goes, the reveal follows)', await page.waitForFunction(() => !document.querySelector('.overlay--summit'), null, { timeout: 10000 }).then(() => true, () => false));
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

await scenario('Checklist: disabled controls explain themselves; AI turns are paced; the bug button survives re-renders', async () => {
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
  // in a game with paced bots: waiting cards say so, dimmed cards give the reason, and the bug button stays through the re-renders
  const page = await newPage();
  await begin(page, { players: 4, types: ['easy', 'easy', 'human', 'easy'] }, 'seed=12&botdelay=250');
  await page.waitForSelector('.hand .card', { timeout: 20000 });
  const wait = await page.$$eval('.hand .card.is-wait', (cs) => cs.map((c) => c.title));
  check('not your turn: every card is marked as waiting and its tooltip says to wait', wait.length > 0 && wait.every((t) => /wait for your turn/.test(t)), JSON.stringify(wait.slice(0, 2)));
  await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
  // play one card, then time the bots' replies: with a 250 ms delay they must arrive one by one, not all at once
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
});

// ============================================================================================
await scenario('Console and server log', async () => {
  check('no console errors or warnings, no failed requests, no HTTP 4xx across the whole run', problems.length === 0, problems.slice(0, 4).join(' || '));
  const missing = requestLog.filter((r) => r.status === 404 && r.url !== '/');
  check('the server log has no 404 (the origin root aside)', missing.length === 0, missing.slice(0, 3).map((r) => r.url).join(' '));
  check('no console.log / info / debug output anywhere in the run (no debug logs in the render path)', debugLogs.length === 0, debugLogs.slice(0, 3).join(' || '));
  check('nothing requested the old rule book PDF or any rules/ file', !requestLog.some((r) => /\/rules\//.test(r.url)), requestLog.filter((r) => /\/rules\//.test(r.url)).map((r) => r.url).join(' '));
}, { always: true });

await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
const out = path.join(TMP, ONLY ? `qa-results-${slug(ONLY)}.json` : 'qa-results.json');
fs.writeFileSync(out, `${JSON.stringify({ total: results.length, failed: failed.length, only: ONLY || null, targets: Object.fromEntries(Object.entries(TARGETS).map(([k, t]) => [k, t && { seed: t.seed, players: t.players, policy: t.policy || null, hand: t.handIdx === undefined ? null : t.handIdx + 1 }])), shots: fs.readdirSync(SHOTS), results }, null, 1)}\n`);
console.log(`\nqa-run: ${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`);
if (failed.length) { for (const f of failed) console.log(`  FAIL [${f.scenario}] ${f.name}${f.detail ? ` -- ${f.detail}` : ''}`); process.exit(1); }
