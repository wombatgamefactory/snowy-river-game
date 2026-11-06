// qa-run.mjs - browser QA over the whole game, run from a sub-path the way GitHub Pages serves it.
//
// 1. Copies the files that would be published (git ls-files plus untracked files that are not ignored) into
//    <system temp>/<slug>-qa/site/<slug>-game/ and serves <temp>/site on a CASE-SENSITIVE static server (a request
//    must match a real file name exactly, like Pages).
// 2. Drives the game in headless Chromium: the landing page from the sub-path, the consent banner and analytics on
//    a real-looking host name, 1440 / 1024 / 390 px, 2 to 5 players against every bot level (Hard at five players
//    must not freeze the page), all-bot games, pass-and-play with the summit choices secret behind the cover, every
//    way a hand can end (a lone chaser brings the mob home, one of several chasers does, every chaser falls with a
//    watcher at the heels, nobody chases), the Brumby cap (four cards, the mob worth 11), both sides of the Mountain
//    card, the tiebreak and a shared win, the summit reveal, the overlays dimming the whole viewport, every card
//    face, the stats screen and its exports, the bug reporter, the rule book link, reduced motion, keyboard play,
//    leaving a game and a clean console.
// 3. Prints PASS/FAIL per check, writes screenshots to <temp>/<slug>-qa/shots/ and a JSON summary to
//    <temp>/<slug>-qa/qa-results.json. Exit 1 if anything fails.
//
// The hand endings, the Brumby cap and the tiebreak games are found by playing the same games headlessly first
// (the real controller and the Easy bot, a human seat that plays its first legal card and follows a fixed Chase /
// Watch policy), so each is reached from a `?seed=` and the page's reckoning is checked against the engine's own
// numbers. A search that finds nothing fails the run instead of skipping the scenario.
//
// Needs Playwright (not a dependency of this repo; see tests/browser-lib.mjs).
// Run: node tests/qa/qa-run.mjs [--only=<scenario substring>] [--widths=390,1440]

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GAME_NAME, GAME_SLUG, GAME_TAGLINE, RULEBOOK_URL, CONTACT_EMAIL } from '../../src/game-config.js';
import { createController } from '../../src/ui/controller.js';
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
const HANDS = { 2: 3, 3: 3, 4: 4, 5: 5 }; // one hand per player, three at two players
const SUMMIT = { 2: 7, 3: 7, 4: 7, 5: 6 };

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
fs.rmSync(TMP, { recursive: true, force: true });
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
async function scenario(name, fn) {
  if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) return;
  current = name;
  console.log(`\n== ${name}`);
  const t0 = Date.now();
  try { await fn(); } catch (e) { check('scenario ran without throwing', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); }
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---------- browser plumbing ----------
const browser = await chromium.launch();
const problems = []; // console errors/warnings, page errors, failed requests, HTTP >= 400 (web fonts aside)
const FONT_HOST = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//; // optional, with fallbacks; may be unreachable offline
const imageBytes = new Map();
const allBytes = new Map();
async function newPage(w = 1440, h = 900, opts = {}, init = null, b = browser) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, acceptDownloads: true, ...opts });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/fonts\.(googleapis|gstatic)\.com/.test(m.text() + (m.location().url || ''))) problems.push(`[${current}] ${m.type()}: ${m.text()}`); });
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
 */
async function humanStep(page, stats, opts = {}) {
  if (await page.locator('.end--game').count()) return 'end';
  if (await page.locator('.cover').count()) {
    stats.covers++;
    if (await page.locator('.hand, .card, .cardimg, .table, .log__list, .mountain, .colt, .decision, .overlay, .seat, .schip').count()) stats.leaks++;
    await tryClick(page.locator('.cover .btn--primary'));
    return 'cover';
  }
  if (await page.locator('#continue').count()) {
    if (opts.stopAtReckoning && (await opts.stopAtReckoning())) return 'stop';
    if (await tryClick(page.locator('#continue'))) stats.summaries++;
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

/** Watches the table for everything that flashes past: marker steps, Brumby cards, the mob, reveals, reckonings. */
async function watch(page) {
  await page.evaluate(() => {
    const W = { steps: [], sides: [], brumbies: [], brumbyMax: 0, mobs: [], mobMax: 0, reveals: [], hands: [], phases: [], summitModals: 0 };
    window.__w = W;
    const app = document.getElementById('app');
    const look = () => {
      const mk = app.querySelector('.mountain__marker');
      if (mk) {
        const st = Number(mk.dataset.step);
        if (W.steps[W.steps.length - 1] !== st) W.steps.push(st);
        if (!W.sides.includes(mk.dataset.side)) W.sides.push(mk.dataset.side);
      }
      const k = app.querySelectorAll('.colt .brumby').length;
      if (W.brumbies[W.brumbies.length - 1] !== k) W.brumbies.push(k);
      W.brumbyMax = Math.max(W.brumbyMax, k);
      const mob = app.querySelector('[data-mob]');
      if (mob) { const m = Number(mob.textContent); if (W.mobs[W.mobs.length - 1] !== m) W.mobs.push(m); W.mobMax = Math.max(W.mobMax, m); }
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
      const hd = app.querySelector('.end--hand');
      if (hd) {
        const title = hd.querySelector('#hand-title').textContent;
        if (!W.hands.length || W.hands[W.hands.length - 1].title !== title) {
          W.hands.push({
            title,
            kind: ['home', 'escaped', 'nobody'].find((x) => hd.classList.contains(`end--${x}`)),
            lead: hd.querySelector('.end__note--lead').textContent,
          });
        }
      }
    };
    new MutationObserver(look).observe(app, { childList: true, subtree: true });
    look();
  });
}
const seen = (page) => page.evaluate(() => window.__w);

/** The reckoning on screen, read back from the DOM. */
const readReckoning = (page) => page.evaluate(() => {
  const el = document.querySelector('.end--hand');
  return {
    cls: el.className,
    title: el.querySelector('#hand-title').textContent,
    lead: el.querySelector('.end__note--lead').textContent,
    rows: [...el.querySelectorAll('.reck__row')].map((r) => ({
      cls: r.className,
      choice: r.querySelector('.reck__choice b').textContent,
      what: r.querySelector('.reck__what b').textContent,
      sum: r.querySelector('.reck__what small').textContent,
      score: Number(r.querySelector('.reck__score').textContent),
      total: Number(r.querySelector('.reck__total b').textContent),
      heels: !!r.querySelector('.mark--heels'),
    })),
  };
});

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
/** A game as the page plays it: seat 0 is the human (first legal card, the Chase / Watch policy), the rest Easy bots unless `bots` says. */
function simulate({ seed, players, policy = 'alt', allBots = false }) {
  const seats = Array.from({ length: players }, (_, i) => ({ type: allBots || i > 0 ? 'easy' : 'human' }));
  const ctl = createController({ seats, seed, rules: {}, autoPlayForced: false });
  const hands = [];
  const summitOrders = []; // the order the engine collects each summit's choices in (from the last climb winner)
  const take = (evs) => { for (const e of evs || []) { if (e.type === 'hand-ended') hands.push(e); else if (e.type === 'summit-reached') summitOrders.push(e.order); } };
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
  return { hands, summitOrders, result: ctl.state.result, names: ctl.names };
}

const chasersOf = (ev) => ev.choices.filter((c) => c === 'chase').length;
const KINDS = {
  'a lone chaser brings the mob home': (ev) => ev.broughtHomeBy !== null && chasersOf(ev) === 1,
  'one of several chasers brings the mob home': (ev) => ev.broughtHomeBy !== null && chasersOf(ev) >= 2,
  'every chaser falls, a watcher is at the heels': (ev) => ev.endReason === 'descent' && ev.broughtHomeBy === null && chasersOf(ev) >= 2 && ev.heelsSeat !== null && ev.choices[ev.heelsSeat] === 'watch',
  'nobody chases': (ev) => ev.endReason === 'nobody-chases',
};

/** The earliest game (fewest players, then earliest hand, then lowest seed) with a hand that satisfies `want`. */
function findHand(want, { playersList = [2, 3, 4, 5], policies = ['chase', 'watch', 'alt'], seeds = 400 } = {}) {
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
function findResult(want, seeds = 4000) {
  for (const players of [2, 3, 4, 5]) {
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
const searchStart = Date.now();
const TARGETS = {};
for (const [kind, want] of Object.entries(KINDS)) TARGETS[kind] = findHand(want);
// Five players, four escapes in a row so the stack is full (the mob is worth 11); prefer a fifth escape at the cap.
TARGETS.cap = findHand((ev) => ev.brumbiesBefore === 4 && ev.mobValue === 11 && ev.brumbyAtCap && ev.broughtHomeBy === null, { playersList: [5], seeds: 3000 })
  || findHand((ev) => ev.brumbiesBefore === 4 && ev.mobValue === 11, { playersList: [5], seeds: 3000 });
for (const n of [2, 3, 4, 5]) TARGETS[`reveal${n}`] = findAwayFromYou(n);
TARGETS.tiebreak = findResult((r) => r.tiebreakUsed && !r.shared);
TARGETS.shared = findResult((r) => r.shared);
console.log(`scenario search (${((Date.now() - searchStart) / 1000).toFixed(1)} s):`);
for (const [k, t] of Object.entries(TARGETS)) console.log(`  ${k}: ${t ? `seed ${t.seed}${t.players ? `, ${t.players} players` : ''}${t.policy ? `, policy ${t.policy}, hand ${t.handIdx + 1}` : ''}${t.order ? `, collected from seat ${t.order[0] + 1}` : ''}` : 'NOT FOUND'}`);

// ============================================================================================
await scenario('Static: every referenced path is an exact-case match; lower-case names; sizes', async () => {
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
  check('manifest has no absolute or Windows paths', list.every((a) => !/^([A-Za-z]:|[\\/])/.test(a.file) && !/\\/.test(a.file)));
  check('manifest files marked real or placeholder are served', list.filter((a) => a.status !== 'missing').every((a) => served.has(`${SUB}/assets/${a.file}`)));
  check('names are lower-case with no spaces (README aside)', [...served].every((f) => !/\s/.test(f) && (f === `${SUB}/README.md` || f === f.toLowerCase())));
  const big = [...served].filter((f) => fs.statSync(path.join(SITE, f)).size > 500 * 1024 && !/\/rules\/[a-z0-9-]+\.pdf$/.test(f));
  check('no file over 500 KB except the printed rule book', big.length === 0, big.join(', '));
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
  const href = await page.getAttribute('a[data-action=rulebook]', 'href');
  const r = await page.request.get(BASE + href);
  const body = await r.body();
  check('rule book link answers 200 and the file is a PDF', href === RULEBOOK_URL && r.status() === 200 && body.subarray(0, 4).toString() === '%PDF' && /pdf/.test(r.headers()['content-type'] || ''), `${href} ${r.status()} ${body.length} bytes`);
  check('rule book link opens in a new tab with noopener', (await page.getAttribute('a[data-action=rulebook]', 'target')) === '_blank' && /noopener/.test(await page.getAttribute('a[data-action=rulebook]', 'rel')));
  const rulesFiles = [...served].filter((f) => f.startsWith(`${SUB}/rules/`));
  check('rules/ holds only the file the page links to', rulesFiles.length === 1 && rulesFiles[0] === `${SUB}/${RULEBOOK_URL}`, rulesFiles.join(', '));
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
      }
    }
    return { n: items.length, bad, white };
  }, list);
  check(`all ${out.n} images in the manifest decode at the size it states`, out.bad.length === 0, out.bad.slice(0, 3).join('; '));
  check('no white patch in the corners of any card, Mountain or Colt image', out.white.length === 0, out.white.slice(0, 4).join(', '));
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

await scenario('Responsive landing at every width, 5 seats', async () => {
  for (const w of WIDTHS) {
    const page = await newPage(w, 900, phoneOpts(w));
    await open(page);
    await page.check('input[name=players][value="5"]');
    check(`${w}px: no sideways scroll`, (await overflow(page)) <= 0);
    const out = await page.evaluate((vw) => [...document.querySelectorAll('main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1); }).length, w);
    check(`${w}px: nothing outside the viewport`, out === 0, `${out} elements`);
    await shot(page, `landing-5-seats-${w}`);
    await page.close();
  }
});

await scenario('Human v bots to the end (every level, 2 to 5 players, every width)', async () => {
  const matrix = [['easy', [2, 3, 4, 5]], ['medium', [2, 4]], ['hard', [3, 5]]];
  for (const w of WIDTHS) {
    for (const [level, counts] of matrix) {
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
        check(`${tag}: ${HANDS[n]} reckonings, the human played cards and chose at the summit`, s.plays >= HANDS[n] * 3 && s.summaries === HANDS[n] && s.summits >= 1, JSON.stringify(s));
        const W = await seen(page);
        check(`${tag}: the Mountain was the ${n === 5 ? '0-6' : '0-7'} side and the marker reached step ${SUMMIT[n]} and never went past it`, W.sides.join() === (n === 5 ? '0-6' : '0-7') && Math.max(...W.steps) === SUMMIT[n], JSON.stringify({ sides: W.sides, max: Math.max(...W.steps) }));
        check(`${tag}: no sideways scroll at the end`, (await overflow(page)) <= 0);
        if (level === 'hard') {
          const gap = await page.evaluate(() => window.__gap);
          check(`${tag}: the page never froze (longest main-thread gap under 250 ms)`, gap < 250, `${gap.toFixed(0)} ms`);
          check(`${tag}: decisions came from the Worker`, (await page.evaluate(() => document.body.dataset.botMode)) === 'worker');
        }
        const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{"games":[]}').games, STORE);
        check(`${tag}: the finished game was recorded once, under the standard rules`, stored.length === 1 && stored[0].players === n && stored[0].rules_code === 'std', JSON.stringify(stored[0] && { players: stored[0].players, rules_code: stored[0].rules_code }));
        if (n === 4 || (level === 'hard' && n === 5)) await shot(page, `${level}-${n}p-end-${w}`);
        await page.close();
      }
    }
  }
});

await scenario('All-bot games at 2 to 5 seats', async () => {
  const mixes = { 2: ['easy', 'medium'], 3: ['medium', 'hard', 'easy'], 4: ['hard', 'medium', 'easy', 'easy'], 5: ['easy', 'easy', 'medium', 'medium', 'hard'] };
  for (const w of WIDTHS) {
    for (const n of [2, 3, 4, 5]) {
      if (w !== WIDTHS[0] && n !== 5) continue; // every count at the first width, the biggest table at the others
      const page = await newPage(w, 900, phoneOpts(w));
      await begin(page, { players: n, types: mixes[n] }, `seed=${n + 20}&botdelay=0`);
      await finish(page);
      check(`${w}px ${n} bots: finishes by itself with a ranking`, (await page.locator('.rank').count()) === n);
      check(`${w}px ${n} bots: no hand is shown`, (await page.locator('.hand .card').count()) === 0);
      const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games[0], STORE);
      check(`${w}px ${n} bots: recorded with ${HANDS[n]} hands and no human seat`, stored.hands === HANDS[n] && stored.seats.every((s) => s.type === 'bot'));
      if (n === 4 || n === 5) await shot(page, `bots-${n}-end-${w}`);
      await page.close();
    }
  }
});

await scenario('Pass-and-play: covers, and the summit choices stay secret', async () => {
  for (const [n, humans, w] of [[2, 2, 1440], [3, 2, 390], [4, 3, 1024], [3, 3, 1440]]) {
    const page = await newPage(w, 900, phoneOpts(w));
    await page.addInitScript(() => {
      window.__seenBehindCover = 0;
      // Every cover and every summit modal, in order, recorded at the moment the DOM changes (not by polling, which
      // can miss a cover that is confirmed between two polls when the bots play instantly).
      window.__trace = [];
      document.addEventListener('DOMContentLoaded', () => {
        let last = '';
        new MutationObserver(() => {
          if (document.querySelector('.cover') && document.querySelector('.hand, .card, .table, .seat, .log__list, .mountain, .decision, .schip')) window.__seenBehindCover++;
          const cover = document.querySelector('.cover');
          const modal = document.querySelector('.overlay--summit');
          let ev = null;
          if (cover) ev = { kind: 'cover', name: (/Pass to (\S+)/.exec(cover.textContent) || [])[1] || null, summit: /Chase or Watch in secret/.test(cover.textContent) };
          else if (modal) ev = { kind: 'modal', name: ((document.querySelector('#summit-title') || { textContent: '' }).textContent.match(/^(\S+?)[,:]/) || [])[1] || null, sides: document.querySelectorAll('.seat .schip--chase, .seat .schip--watch').length, own: document.querySelectorAll('.seat .schip--own').length };
          const key = ev ? JSON.stringify(ev) : '';
          if (ev && key !== last) window.__trace.push(ev);
          if (ev) last = key;
        }).observe(document.body, { childList: true, subtree: true });
      });
    });
    await begin(page, { players: n, types: Array.from({ length: n }, (_, i) => (i < humans ? 'human' : 'easy')), names: ['Ann', 'Bo', 'Cy'] }, `seed=${n + 40}&botdelay=0`);
    await page.waitForSelector('.cover', { timeout: 30000 });
    const tag = `${humans} humans in ${n}p at ${w}px`;
    if (w < 700) await shot(page, `cover-${n}p-${w}`);
    const cover = await page.$eval('.cover', (e) => { const r = e.getBoundingClientRect(); return [r.width, r.height, innerWidth, innerHeight]; });
    check(`${tag}: the cover fills the viewport`, cover[0] >= cover[2] - 1 && cover[1] >= cover[3] - 1);
    check(`${tag}: the cover names no cards or scores`, !/\d+ pts|Total|[A-Z][a-z]+ \d+/.test((await page.textContent('.cover')).replace(/Pass to .*?(show my hand|make my choice)/, '')));
    check(`${tag}: the bug button is hidden under the cover and Ctrl+Shift+B opens nothing`, !(await page.isVisible('#bug-button')) && await (async () => { await page.keyboard.press('Control+Shift+B'); await page.waitForTimeout(150); return (await page.locator('.bug, #bug-form').count()) === 0; })());
    // Play on, looking at every cover and every summit modal on the way.
    const st = newStats();
    const obs = { noCover: 0, summitCovers: 0, summitModals: 0, coverLeak: 0, bugVisible: 0, sidesShown: 0, nameMismatch: 0, ownChipEarly: 0 };
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
          if (await page.locator('.mountain, .decision, .overlay, .seat, .hand, #log, .schip').count()) obs.coverLeak++;
        }
        if (await page.isVisible('#bug-button')) obs.bugVisible++;
      } else if (await page.locator('.overlay--summit').count()) {
        obs.summitModals++;
        if (!coverSeenLast) obs.noCover++;
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
    // The verdict comes from the in-page trace (every cover and modal as it was drawn), not from the polling above.
    const trace = await page.evaluate(() => window.__trace);
    const tr = { modals: 0, noCover: 0, nameMismatch: 0, sides: 0, own: 0, first: null };
    trace.forEach((e, i) => {
      if (e.kind !== 'modal') return;
      tr.modals++;
      const prev = trace[i - 1];
      if (!prev || prev.kind !== 'cover' || !prev.summit) { tr.noCover++; tr.first = tr.first || `modal for ${e.name} with no summit cover just before (${prev ? `${prev.kind} for ${prev.name}` : 'nothing'})`; }
      else if (prev.name !== e.name) { tr.nameMismatch++; tr.first = tr.first || `cover for ${prev.name} then modal for ${e.name}`; }
      tr.sides += e.sides; tr.own += e.own;
    });
    check(`${tag}: at every summit modal no seat shows a side, nobody's own choice is already on show, and it is addressed to the player named on the cover, and a cover came immediately before it`, tr.modals >= humans && tr.sides === 0 && tr.own === 0 && tr.nameMismatch === 0 && tr.noCover === 0 && obs.sidesShown === 0 && obs.ownChipEarly === 0, JSON.stringify({ trace: tr, polled: obs }));
    await page.close();
  }
});

await scenario('Summit: the modal, the reveal order and the dimmed backdrop', async () => {
  for (const [w, n] of [...WIDTHS.map((x) => [x, 4]), [WIDTHS[0], 2], [WIDTHS[0], 3], [WIDTHS[0], 5]]) {
    const page = await newPage(w, 900, phoneOpts(w));
    const tg = TARGETS[`reveal${n}`];
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
    check(`${tag}: the summit modal states the descent rule and the banner states the 1-12 range`, /To bring the mob home you must win the most descent tricks; a tie goes to whoever won the later trick\./.test(await page.textContent('.overlay--summit')) && /Cards run 1 to 12 in each suit/.test(await page.textContent('.phasebar')));
    check(`${tag}: no seat shows a side before the reveal`, (await page.locator('.seat .schip--chase, .seat .schip--watch').count()) === 0);
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

await scenario('Every way a hand ends, at every width', async () => {
  for (const [kind, target] of Object.entries(KINDS).map(([k]) => [k, TARGETS[k]])) {
    if (!check(`a game with "${kind}" was found by seed search`, !!target)) continue;
    for (const w of WIDTHS) {
      const page = await newPage(w, 900, phoneOpts(w));
      page.__policy = target.policy;
      await begin(page, { players: target.players, types: types(target.players), names: ['Mia'] }, `seed=${target.seed}&botdelay=0`);
      await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
      await watch(page);
      const wantTitle = `Hand ${target.handIdx + 1} of `;
      const s1 = await playHuman(page, 120000, null, { stopAtReckoning: async () => (await page.textContent('#hand-title')).startsWith(wantTitle) });
      const tag = `${w}px ${kind}`;
      if (!check(`${tag}: the reckoning of hand ${target.handIdx + 1} came up`, s1.stopped === 'stop' && (await page.locator('.overlay--hand').count()) === 1, JSON.stringify(s1))) { await page.close(); continue; }
      const rec = await readReckoning(page);
      const ev = target.ev;
      const kindCls = ev.endReason === 'nobody-chases' ? 'nobody' : ev.broughtHomeBy !== null ? 'home' : 'escaped';
      check(`${tag}: the reckoning is the "${kindCls}" kind and has a row per seat`, rec.cls.includes(`end--${kindCls}`) && rec.rows.length === target.players, rec.cls);
      check(`${tag}: every score and running total matches the engine's own`, rec.rows.map((r) => r.score).join() === ev.scores.join() && rec.rows.map((r) => r.total).join() === ev.totals.join(), `${rec.rows.map((r) => r.score)} vs ${ev.scores}; ${rec.rows.map((r) => r.total)} vs ${ev.totals}`);
      check(`${tag}: each row names the Chase or Watch card that seat showed`, rec.rows.every((r, i) => r.choice === (ev.choices[i] === 'chase' ? 'Chase' : 'Watch')));
      const homes = rec.rows.filter((r) => r.cls.includes('reck__row--home'));
      const falls = rec.rows.filter((r) => r.cls.includes('reck__row--fell'));
      if (kindCls === 'home') {
        const row = homes[0];
        const m = row && /^(\d+) climb \+ (\d+) mob$/.exec(row.sum);
        check(`${tag}: exactly one seat brought the mob home, its score is climb tricks + the mob (${ev.mobValue}), every other chaser fell for -1`,
          homes.length === 1 && m && Number(m[1]) + Number(m[2]) === row.score && Number(m[2]) === ev.mobValue && falls.length === chasersOf(ev) - 1 && falls.every((r) => r.score === -1), JSON.stringify({ homes: homes.length, falls: falls.length, sum: row && row.sum }));
        check(`${tag}: ${chasersOf(ev) === 1 ? 'the lone chaser' : `one of ${chasersOf(ev)} chasers`} is named in the note, which says the mob came home`, /brought it home/.test(rec.lead) && /Brumby cards go back to the box/.test(rec.lead), rec.lead);
      } else if (kindCls === 'escaped') {
        const heelsRow = rec.rows.find((r) => r.heels);
        check(`${tag}: nobody brought it home, every chaser fell for -1, and a watcher is marked at the heels`, homes.length === 0 && falls.length === chasersOf(ev) && falls.every((r) => r.score === -1) && heelsRow && heelsRow.choice === 'Watch', JSON.stringify({ homes: homes.length, falls: falls.length, heels: heelsRow && heelsRow.choice }));
        check(`${tag}: the note says the mob escaped and a Brumby card goes under the Colt`, /watched, so the mob escaped/.test(rec.lead) && /Brumby card goes under the Colt/.test(rec.lead), rec.lead);
      } else {
        check(`${tag}: every seat watched and banked its climb tricks (no falls, no mob)`, rec.rows.every((r) => r.choice === 'Watch' && r.score >= 0) && homes.length === 0 && falls.length === 0, JSON.stringify(rec.rows.map((r) => [r.choice, r.score])));
        check(`${tag}: the note says nobody chased and the mob ran free`, /Nobody chased/.test(rec.lead) && /mob ran free/.test(rec.lead) && /Brumby card goes under the Colt/.test(rec.lead), rec.lead);
      }
      check(`${tag}: no sideways scroll with the reckoning up`, (await overflow(page)) <= 0);
      await shot(page, `${kindCls}-${slug(kind)}-${w}`);
      await dimCheck(page, `${tag} reckoning`);
      await tryClick(page.locator('#continue'));
      const s2 = await playHuman(page, 120000);
      check(`${tag}: the game plays on to its end`, (await page.locator('.end--game').count()) === 1, JSON.stringify(s2));
      await page.close();
    }
  }
});

await scenario('The Brumby cap: four cards under the Colt, the mob worth 11', async () => {
  const t = TARGETS.cap;
  if (!check('a five-player game with four escapes in a row was found by seed search', !!t)) return;
  for (const w of WIDTHS) {
    const page = await newPage(w, 900, phoneOpts(w));
    page.__policy = t.policy;
    await begin(page, { players: 5, types: types(5), names: ['Mia'] }, `seed=${t.seed}&botdelay=0`);
    await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
    await watch(page);
    const tag = `${w}px`;
    const s1 = await playHuman(page, 200000, null, { stopAtReckoning: async () => (await page.textContent('#hand-title')).startsWith(`Hand ${t.handIdx + 1} of `) });
    check(`${tag}: hand ${t.handIdx + 1} is reached`, s1.stopped === 'stop', JSON.stringify(s1));
    const W = await seen(page);
    check(`${tag}: the stack grew one Brumby card at a time, 0 1 2 3 4, and never past 4`, W.brumbies.join() === '0,1,2,3,4' && W.brumbyMax === 4, W.brumbies.join());
    check(`${tag}: the mob was worth 3, 5, 7, 9 and then 11`, W.mobs.join() === '3,5,7,9,11', W.mobs.join());
    const rec = await readReckoning(page);
    if (t.ev.brumbyAtCap) check(`${tag}: the fifth escape says all four Brumby cards are already under the Colt`, /All 4 Brumby cards are already under the Colt, so nothing is added/.test(rec.lead), rec.lead);
    check(`${tag}: the reckoning matches the engine's scores`, rec.rows.map((r) => r.score).join() === t.ev.scores.join(), `${rec.rows.map((r) => r.score)} vs ${t.ev.scores}`);
    await tryClick(page.locator('#continue'));
    await page.waitForSelector('.end--game');
    await page.click('[data-action=review]');
    const colt = await page.evaluate(() => ({ brumbies: document.querySelectorAll('.colt .brumby').length, mob: document.querySelector('[data-mob]').textContent, sum: document.querySelector('.mob__sum').textContent, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    check(`${tag}: after the last hand the Colt still shows four Brumby cards and the sum "3 + 4 x 2"`, colt.brumbies === 4 && /Colt 3 \+ 4 Brumby cards x 2/.test(colt.sum) && colt.overflowX <= 0, JSON.stringify(colt));
    await page.locator('.colt').scrollIntoViewIfNeeded();
    await shot(page, `cap-${w}`);
    await page.close();
  }
});

await scenario('The 5-player Mountain: the 0-6 side, summit at step 6', async () => {
  for (const w of WIDTHS) {
    const page = await newPage(w, 900, phoneOpts(w));
    await begin(page, { players: 5, types: types(5), names: ['Mia'] }, 'seed=21&botdelay=0');
    await page.waitForSelector('.hand .card.is-legal');
    const info = await page.evaluate(() => ({ side: document.querySelector('.mountain').dataset.side, src: document.querySelector('.mountain__img').getAttribute('src'), text: document.querySelector('.mountain').textContent, loaded: document.querySelector('.mountain__img').naturalWidth > 0 }));
    check(`${w}px: five players get the 0-6 card (mountain-6) and the title says step 0 of 6`, info.side === '0-6' && /mountain-6/.test(info.src) && /on step 0 of 6/.test(info.text.replace(/\s+/g, ' ')) && info.loaded, JSON.stringify(info));
    await page.locator('.mountain').scrollIntoViewIfNeeded();
    await shot(page, `mountain-5p-${w}`);
    await watch(page);
    const st = newStats();
    const until = Date.now() + 60000;
    while (Date.now() < until && !(await page.locator('.overlay--summit').count())) await humanStep(page, st);
    const marker = await page.evaluate(() => ({ step: document.querySelector('.mountain__marker').dataset.step, text: document.querySelector('.mountain__title').textContent }));
    check(`${w}px: the summit modal came up with the mob on step 6, not 7`, marker.step === '6' && /step 6 of 6/.test(marker.text), JSON.stringify(marker));
    await page.close();
    const p4 = await newPage(w, 900, phoneOpts(w));
    await begin(p4, { players: 4, types: types(4), names: ['Mia'] }, 'seed=21&botdelay=0');
    await p4.waitForSelector('.hand .card.is-legal');
    check(`${w}px: four players get the 0-7 card`, (await p4.getAttribute('.mountain', 'data-side')) === '0-7' && /mountain-7/.test(await p4.getAttribute('.mountain__img', 'src')));
    await p4.close();
  }
});

await scenario('Ties: the tiebreak decides one game, a shared win ends another', async () => {
  for (const [label, t] of [['tiebreak', TARGETS.tiebreak], ['shared', TARGETS.shared]]) {
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
        ranks: [...document.querySelectorAll('.rank__pos')].map((e) => e.textContent),
        totals: [...document.querySelectorAll('.rank__total b')].map((e) => Number(e.textContent)),
        crowns: [...document.querySelectorAll('.crown')].map((e) => e.textContent),
      }));
      check(`${tag}: the totals on screen are the engine's`, [...out.totals].sort().join() === [...r.totals].sort().join(), `${out.totals} vs ${r.totals}`);
      check(`${tag}: ${r.winners.length} winner${r.winners.length === 1 ? '' : 's'} marked`, out.winners === r.winners.length, JSON.stringify(out));
      if (label === 'tiebreak') {
        check(`${tag}: the tiebreak line names the tied seats, mobs brought home and the winner`, /tied on \d+/.test(out.tb) && /Tiebreak: who brought the mob home most often/.test(out.tb) && /Mobs brought home:/.test(out.tb) && /\bwins?\b/.test(out.tb), out.tb);
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

await scenario('Stats screen and exports', async () => {
  const page = await newPage();
  await open(page);
  await page.click('.landing [data-action=open-stats]');
  check('empty state first', /No games recorded yet/.test(await page.textContent('.dialog .st')));
  await page.keyboard.press('Escape');
  for (let i = 0; i < 3; i++) {
    await configure(page, { players: 3 + (i % 2), types: ['easy', 'easy', 'medium', 'easy'] });
    await page.click('#start');
    await finish(page);
    if (i < 2) { await page.click('.end [data-action=new]'); await page.waitForSelector('#setup-form'); }
  }
  await page.click('.end [data-action=open-stats]');
  await page.waitForSelector('.dialog .st');
  check('three games listed', /^\s*3\s+games played/.test(await page.textContent('.dialog .st__lead')));
  check('the mob and the summit section is there', /mob/i.test(await page.textContent('.dialog .st')));
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).games, STORE);
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]);
  const csvText = fs.readFileSync(await csvDl.path(), 'utf8');
  const rows = csvText.trim().split('\n');
  check('CSV: LF only, a row per game, every row the same field count', rows.length === 4 && !csvText.includes('\r') && rows.every((r) => r.split(',').length === rows[0].split(',').length));
  check('CSV: the file is named for the game and the date', /^snowy-river-stats-\d{4}-\d{2}-\d{2}\.csv$/.test(csvDl.suggestedFilename()), csvDl.suggestedFilename());
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-json]')]);
  check('JSON equals the store', JSON.stringify(JSON.parse(fs.readFileSync(await jsonDl.path(), 'utf8')).games) === JSON.stringify(stored));
  check('every stored game is under the standard rules and has an id and a seed', stored.every((g) => g.rules_code === 'std' && g.id && g.seed !== undefined));
  await shot(page, 'stats-1440');
  await page.keyboard.press('Escape');
  await page.close();
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
  check('mid-game: the report holds the state and the action log', rep.game && rep.game.n === 3 && rep.actionLog.length >= 3);
  await page.keyboard.press('Escape');
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

await scenario('Rules dialog and rule book link', async () => {
  for (const w of WIDTHS) {
    const page = await newPage(w, 800, phoneOpts(w));
    await open(page);
    await page.click('.landing [data-action=open-rules]');
    check(`${w}px: the dialog opens, has steps and a rule book link, and fits`, (await page.locator('.dialog .how__steps > li').count()) >= 5 && (await page.locator('.dialog a[data-action=rulebook]').count()) === 1 && (await overflow(page)) <= 0);
    if (w === 390) await shot(page, 'rules-390');
    await dimCheck(page, `${w}px rules dialog`);
    const n = (await events(page)).filter((c) => c[1] === 'rules_opened').length;
    check(`${w}px: rules_opened was queued`, n === 1, `${n}`);
    const href = await page.getAttribute('.dialog a[data-action=rulebook]', 'href');
    check(`${w}px: the dialog's rule book link is the PDF and answers 200`, href === RULEBOOK_URL && (await page.request.get(BASE + href)).status() === 200);
    await page.close();
  }
});

await scenario('Responsive sweep: 2, 4 and 5 players at every width', async () => {
  for (const w of WIDTHS) {
    for (const n of [2, 4, 5]) {
      const page = await newPage(w, 844, phoneOpts(w));
      await begin(page, { players: n, types: ['human', 'medium', 'easy', 'easy', 'easy'] }, 'seed=9&botdelay=0');
      await page.waitForSelector('.hand .card.is-legal');
      const first = await page.$$eval('.hand .card', (cs) => cs.map((c) => c.getBoundingClientRect().width));
      check(`${w}px ${n}p: first screen fits and hand cards are at least 36 px wide`, (await overflow(page)) <= 0 && Math.min(...first) >= 36, `min ${Math.min(...first).toFixed(0)}`);
      if (n === 4) await shot(page, `start-${n}p-${w}`);
      let sawSummary = false;
      for (let i = 0; i < 400 && !sawSummary; i++) { await humanStep(page, newStats()); if (await page.locator('#continue').count()) sawSummary = true; }
      if (sawSummary) {
        check(`${w}px ${n}p: the reckoning fits`, (await overflow(page)) <= 0);
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
  check('the summit modal takes focus', await page.evaluate(() => !!document.activeElement.closest('.overlay--summit')));
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

// ============================================================================================
await scenario('Console and server log', async () => {
  check('no console errors or warnings, no failed requests, no HTTP 4xx across the whole run', problems.length === 0, problems.slice(0, 4).join(' || '));
  const missing = requestLog.filter((r) => r.status === 404 && r.url !== '/');
  check('the server log has no 404 (the origin root aside)', missing.length === 0, missing.slice(0, 3).map((r) => r.url).join(' '));
});

await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(TMP, 'qa-results.json'), `${JSON.stringify({ total: results.length, failed: failed.length, targets: Object.fromEntries(Object.entries(TARGETS).map(([k, t]) => [k, t && { seed: t.seed, players: t.players, policy: t.policy || null, hand: t.handIdx === undefined ? null : t.handIdx + 1 }])), results }, null, 1)}\n`);
console.log(`\nqa-run: ${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`);
if (failed.length) { for (const f of failed) console.log(`  FAIL [${f.scenario}] ${f.name}${f.detail ? ` -- ${f.detail}` : ''}`); process.exit(1); }
