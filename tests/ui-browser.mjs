// ui-browser.mjs - drives the real UI in headless Chromium: landing and setup, human v Easy (and every
// level that is registered), 2 / 3 / 4 / 5 players, bot v bot, pass-and-play, a game under a
// non-standard rule, the no-Worker fallback, reduced motion, phone widths, the keyboard and a clean
// console. Starts its own static server on a free port; needs Playwright, which is NOT a dependency
// of this repo (see tests/browser-lib.mjs). Without it the suite prints SKIPPED (exit 0), or exits 1 with --require.
// Screenshots go to a fresh folder under the system temp folder (the path is printed).
// Snowy River: the summit step (a modal with the Chase and Watch cards) in every human game; no Playtest panel;
// scenarios for the Mountain and its marker, the Colt, the reveal, the heels and the reckoning.
// Run: node tests/ui-browser.mjs [--require]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './lib.mjs';
import { requireChromium, serveRepo } from './browser-lib.mjs';
import { VARIANTS } from '../src/engine/index.js';
import { GAME_NAME, GAME_TAGLINE, PUBLISH_URL, RULEBOOK_URL } from '../src/game-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// One folder per run: a fixed name would be overwritten by the next run, and on Windows an overwrite can
// fail while a virus scanner or indexer still holds the file from the last run.
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'card-game-ui-shots-'));
const { check, done } = suite('ui-browser');

const chromium = await requireChromium('ui-browser');
const { base: BASE, close } = await serveRepo(ROOT);
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const tokensLeft = /\{\{[A-Z_]+\}\}/.test(html);

const browser = await chromium.launch();
const problems = [];
async function newPage(w = 1280, h = 900, opts = {}, init = null) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...opts });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${w}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${w}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[${w}] request failed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[${w}] HTTP ${r.status()} ${r.url()}`); });
  page.__touch = !!opts.hasTouch;
  return page;
}
// A screenshot is evidence for a human, never a pass/fail check: failing to take one must not end the run.
const shot = (page, name, full = true) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full }).catch((e) => console.log(`  (screenshot ${name} failed: ${String(e.message).slice(0, 80)})`));

/** A click that gives up after a few seconds and says so, instead of waiting out Playwright's 30 s default and throwing. */
async function tryClick(locator, opts = {}) {
  try { await locator.click({ timeout: 5000, ...opts }); return true; } catch { return false; }
}

/** Which bot levels the registry offers (read from the setup page itself). */
let levels = ['easy'];
{
  const page = await newPage();
  await page.goto(`${BASE}?seed=1`);
  await page.waitForSelector('#setup-form');
  levels = await page.$$eval('select[name=type1] option:not([disabled])', (o) => o.map((x) => x.value).filter((v) => v !== 'human'));
  await page.close();
}
console.log(`bot levels offered: ${levels.join(', ')}`);

async function setup(page, { players = 4, types = ['human', 'easy', 'easy', 'easy', 'easy'], names = [], rules = {}, q = 'seed=11', delay = 40 } = {}) {
  await page.goto(`${BASE}?botdelay=${delay}&${q}`);
  await page.waitForSelector('#setup-form');
  await page.check(`input[name=players][value="${players}"]`);
  for (let i = 0; i < players; i++) {
    await page.selectOption(`select[name=type${i}]`, types[i]);
    if (names[i]) await page.fill(`input[name=name${i}]`, names[i]);
  }
  if (Object.keys(rules).length) {
    await page.evaluate(() => { document.getElementById('rules-panel').open = true; });
    for (const [k, v] of Object.entries(rules)) await page.selectOption(`select[name="rule-${k}"]`, v);
  }
  await page.click('#start');
}

/** Waits (up to 10 s) until every image matching `sel` has finished loading, so an art check reads the result, not the race. */
const imagesSettled = (page, sel) => page.waitForFunction((q) => [...document.querySelectorAll(q)].every((e) => e.complete), sel, { timeout: 10000 }).catch(() => {});

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const newStats = () => ({ plays: 0, covers: 0, coverLeaks: 0, summaries: 0, illegalTried: 0, tooltipMatches: 0, hints: 0, summits: 0 });

/**
 * One human decision, whatever it is: a cover, a reckoning or a card (the first few times a
 * dimmed card is clicked first, to see that it explains itself), or the summit choice (Chase and
 * Watch in turn). Returns what it did.
 */
async function humanStep(page, stats) {
  if (await page.locator('.end--game').count()) return 'end';
  if (await page.locator('.cover').count()) {
    stats.covers++;
    if (await page.locator('.hand, .card, .cardimg, .table, .log__list, .mountain, .colt, .decision, .overlay, .seat').count()) stats.coverLeaks++;
    await tryClick(page.locator('.cover .btn--primary'));
    return 'cover';
  }
  if (await page.locator('#continue').count()) { if (await tryClick(page.locator('#continue'))) stats.summaries++; return 'summary'; }
  const decide = page.locator('.decision [data-action=decide]');
  if (await decide.count()) {
    stats.summits++;
    if (!(await tryClick(decide.nth(stats.summits % 2)))) { stats.summits--; return 'retry'; }
    return 'summit';
  }
  const legal = page.locator('.hand .card.is-legal');
  if (await legal.count()) {
    const blocked = page.locator('.hand .card.is-blocked');
    if (stats.illegalTried < 4 && await blocked.count()) {
      const title = await blocked.first().getAttribute('title');
      if (await tryClick(blocked.first(), { force: true })) {
        stats.illegalTried++;
        const note = await page.textContent('#note');
        if (title && /must follow/.test(title) && title === note) stats.tooltipMatches++;
      }
    }
    if (await page.locator('.hand .card__hint').count()) stats.hints++;
    stats.plays++;
    if (!(await tryClick(legal.first()))) { stats.plays--; return 'retry'; }
    if (page.__touch) await tryClick(page.locator('.hand .card.is-selected'), { timeout: 1500 });
    return 'card';
  }
  await page.waitForTimeout(30);
  return 'wait';
}

async function playHuman(page, limitMs = 170000) {
  const stats = newStats();
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if ((await humanStep(page, stats)) === 'end') break;
  }
  return stats;
}

// ---------- landing ----------
{
  const page = await newPage();
  await page.goto(`${BASE}?seed=1`);
  await page.waitForSelector('#setup-form');
  check('landing: title is the game name', (await page.title()) === GAME_NAME, await page.title());
  check('landing: the hook is the tagline', (await page.textContent('.hero__hook')) === GAME_TAGLINE);
  check('landing: stat strip says 2-5 players, 20-30 minutes, ages 10+', /2-5[\s\S]*Players[\s\S]*20-30[\s\S]*Minutes[\s\S]*10\+[\s\S]*Ages/.test(await page.textContent('.stats')));
  await imagesSettled(page, '.hero__img');
  check('landing: the hero art is the key art with the title, fully loaded', await page.$eval('.hero__img', (e) => e.complete && e.naturalWidth >= 1000));
  check('landing: the rule book is linked from the hero and the footer names its version', (await page.locator('a[data-action=rulebook]').count()) >= 2 && /Rule book v3/.test(await page.textContent('.footer')) && /rule-book-v3/.test(RULEBOOK_URL));
  const opts = await page.$$eval('select[name=type1] option', (o) => o.map((x) => x.value));
  check('landing: Human and the three bot levels are on the menu, simulator bots are not', ['human', 'easy', 'medium', 'hard'].every((v) => opts.includes(v)) && !opts.includes('high'), opts.join(','));
  check('landing: hint to watch bots', /Set every seat to a bot to watch a game/.test(await page.textContent('.hint')));
  const href = await page.getAttribute('a[data-action=rulebook]', 'href');
  const r = await page.request.get(BASE + href);
  check('landing: the rule book link answers 200', href === RULEBOOK_URL && r.status() === 200, `${href} ${r.status()}`);
  check('landing: no Playtest rules panel (there are no switches)', VARIANTS.length === 0 && (await page.locator('#rules-panel, .rule').count()) === 0);
  await page.check('input[name=players][value="2"]');
  check('landing: 2 players shows 2 seats', (await page.locator('.seatform:visible').count()) === 2);
  await page.check('input[name=players][value="5"]');
  check('landing: 5 players shows 5 seats', (await page.locator('.seatform:visible').count()) === 5);
  if (!tokensLeft) check('landing: og:url is the published address', (await page.$eval('meta[property="og:url"]', (m) => m.content)) === PUBLISH_URL);
  check('landing: the favicon is declared and loads', (await (await page.request.get(`${BASE}assets/favicon.png`)).status()) === 200 && (await page.getAttribute('link[rel=icon]', 'href')) === 'assets/favicon.png');
  check('landing: a bug button is on the body', (await page.locator('body > #bug-button').count()) === 1);
  await shot(page, 'landing-1280');
  await page.click('[data-action=open-rules]');
  check('landing: the How to play dialog opens', (await page.locator('.dialog').count()) === 1 && /Lead and follow/.test(await page.textContent('.dialog')));
  await page.keyboard.press('Escape');
  check('landing: Escape closes the dialog', (await page.locator('.dialog').count()) === 0);
  await page.close();
}

// ---------- human v Easy, 4 players ----------
{
  const page = await newPage();
  await setup(page, { names: ['Mia'] });
  await page.waitForSelector('.hand .card.is-legal');
  check('4p: four seats round the table with their climb and descent counts', (await page.locator('.seat').count()) === 4 && (await page.locator('.seat .pile').count()) === 8 && (await page.locator('.seat .pile--descent').count()) === 4);
  check('4p: eleven cards in the hand, sorted by suit', (await page.locator('.hand .card').count()) === 11);
  check('4p: the Mountain (0-7) shows the mob on step 0', /step 0 of 7/.test(await page.textContent('.mountain')));
  check('4p: the phase banner says THE CLIMB, highest wins', /The climb/.test(await page.textContent('.phasebar')) && /highest wins/.test(await page.textContent('.phasebar')));
  {
    const counts = await page.$$eval('.seat', (els) => els.map((e) => e.querySelector('.seat__cardsnum') && e.querySelector('.seat__cardsnum').textContent));
    check('4p: every seat shows its cards in hand as a number (11 each at the start), and your own matches the hand', counts.length === 4 && counts.every((t) => t === '11') && Number(await page.textContent('.area-me .seat__cardsnum')) === (await page.locator('.hand .card').count()));
    check('4p: the cards in hand are a small muted line under the name ("11 cards"), the old big number and its caption are gone', (await page.locator('.seat__id .seat__hand').count()) === 4 && (await page.locator('.seat__cards').count()) === 0
      && (await page.locator('.seat__id .seat__hand').allTextContents()).every((t) => /^11 cards$/.test(t.trim())));
    const sz = await page.evaluate(() => {
      const fz = (el) => parseFloat(getComputedStyle(el).fontSize);
      const me = document.querySelector('.area-me');
      return { descent: fz(me.querySelector('.pile--descent b')), climb: fz(me.querySelector('.pile--climb b')), hand: fz(me.querySelector('.seat__hand')), name: fz(me.querySelector('.seat__name')) };
    });
    check('4p: the descent count is the biggest number on the seat, the climb count about two-thirds of it, and the cards-in-hand text is small', sz.descent >= sz.climb && sz.climb >= sz.descent * 0.55 && sz.climb <= sz.descent * 0.8 && sz.descent >= sz.hand * 2.5 && sz.hand <= 14, JSON.stringify(sz));
    check('4p: the descent pile is the first (left) of the two piles, labelled DESCENT, with its little sideways cards', await page.evaluate(() => { const ps = [...document.querySelectorAll('.area-me .seat__piles > .pile')]; return ps[0].classList.contains('pile--descent') && ps[1].classList.contains('pile--climb') && /descent/i.test(ps[0].textContent); }));
  }
  await shot(page, 'start-1280');
  await page.locator('.hand .card.is-legal').first().click();
  await page.waitForFunction(() => document.querySelector('.area-me .seat__cardsnum').textContent === '10', null, { timeout: 8000 }).catch(() => {});
  check('4p: playing a card lowers your cards-in-hand number', (await page.textContent('.area-me .seat__cardsnum')) === '10');
  const s = await playHuman(page);
  check('4p: human plays and the game ends', s.plays >= 8 && (await page.locator('.end--game').count()) === 1, JSON.stringify(s));
  check('4p: the human made a secret summit choice with the Chase / Watch cards', s.summits >= 1, JSON.stringify(s));
  check('4p: every hand end showed the reckoning (4)', s.summaries >= 3, `${s.summaries}`);
  check('4p: illegal cards explain themselves (tooltip equals the note)', s.illegalTried > 0 && s.tooltipMatches === s.illegalTried, `${s.tooltipMatches}/${s.illegalTried}`);
  check('4p: legal cards carry a would-win hint', s.hints > 3);
  check('4p: end screen ranks everyone with seat badges and a winner', (await page.locator('.ranking .rank').count()) === 4 && (await page.locator('.ranking .badge').count()) === 4 && (await page.locator('.rank.is-winner').count()) >= 1);
  check('4p: the typed name is used', /Mia/.test(await page.textContent('.ranking')));
  check('4p: the log has trick lines', (await page.locator('.log__item--trick').count()) > 15, `${await page.locator('.log__item--trick').count()}`);
  await shot(page, 'end-1280');
  check('4p: no horizontal scroll at the end', (await overflow(page)) <= 0);
  await page.click('.end--game [data-action=again]');
  await page.waitForSelector('.hand .card.is-legal');
  check('play again starts a new game with the same setup', (await page.locator('.seat').count()) === 4 && (await page.locator('.log__item--trick').count()) === 0);
  await page.close();
}

// ---------- every registered level, and 2 / 3 / 5 players ----------
for (const level of levels.filter((l) => ['easy', 'medium', 'hard'].includes(l))) {
  for (const n of [2, 3, 5]) {
    if (level !== 'easy' && n === 3) continue; // keep the run short: every level meets 2 and 5 players, Easy meets 3 too
    const page = await newPage();
    await setup(page, { players: n, types: ['human', level, level, level, level], q: 'seed=21' });
    await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
    const s = await playHuman(page);
    check(`${n}p v ${level}: the game ends with a ranking of ${n}`, (await page.locator('.end--game').count()) === 1 && (await page.locator('.rank').count()) === n, JSON.stringify(s));
    check(`${n}p v ${level}: the human played cards and chose at the summit`, s.plays >= 6 && s.summits >= 1, JSON.stringify(s));
    await page.close();
  }
}

// ---------- bot v bot, with and without Workers ----------
{
  const page = await newPage();
  await setup(page, { players: 3, types: ['easy', 'medium', 'easy'], q: 'seed=3' });
  await page.waitForSelector('.end--game', { timeout: 120000 });
  check('bot v bot: finishes by itself', (await page.locator('.rank').count()) === 3);
  check('bot v bot: no hand is shown', (await page.locator('.hand .card').count()) === 0);
  check('bot v bot: the Worker was used', (await page.evaluate(() => document.body.dataset.botMode)) === 'worker');
  await page.close();
  const p2 = await newPage(1280, 900, {}, () => { delete window.Worker; });
  await setup(p2, { players: 3, types: ['easy', 'easy', 'easy'], q: 'seed=4' });
  await p2.waitForSelector('.end--game', { timeout: 120000 });
  check('no Worker: falls back to synchronous bots and still finishes', (await p2.evaluate(() => document.body.dataset.botMode)) === 'sync');
  await p2.close();
}

// ---------- pass and play ----------
{
  const page = await newPage();
  await setup(page, { players: 3, types: ['human', 'human', 'easy'], names: ['Ann', 'Bo'], q: 'seed=5' });
  await page.waitForSelector('.cover', { timeout: 30000 });
  check('pass-and-play: a cover comes first and body is marked covered', (await page.getAttribute('body', 'data-covered')) === '1' && /Pass to (Ann|Bo)/.test(await page.textContent('.cover')));
  const s = newStats();
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) { if ((await humanStep(page, s)) === 'end') break; }
  check('pass-and-play: the game ends, with a cover before each human turn and no leak behind it', (await page.locator('.end--game').count()) === 1 && s.covers > 10 && s.coverLeaks === 0 && s.summits >= 2, JSON.stringify(s));
  await page.close();
}

// ---------- standard rules only ----------
{
  const page = await newPage();
  await setup(page, { players: 4, q: 'seed=7' });
  await page.waitForSelector('.hand .card.is-legal');
  check('rules: no non-standard rules flag on the game screen', (await page.locator('.rules-flag').count()) === 0);
  await page.close();
}

// ---------- motion ----------
{
  const page = await newPage(1280, 900);
  await setup(page, { q: 'seed=11', delay: 800 });
  await page.waitForSelector('.hand .card.is-legal');
  check('motion: cards transition by default', parseFloat(await page.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) > 0);
  await page.close();
  const rm = await newPage(1280, 900, { reducedMotion: 'reduce' });
  await setup(rm, { q: 'seed=11', delay: 800 });
  await rm.waitForSelector('.hand .card.is-legal');
  check('motion: prefers-reduced-motion turns the transitions off', parseFloat(await rm.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) === 0);
  await rm.close();
}

// ---------- the trick winner is shown ----------
{
  const page = await newPage();
  await setup(page, { players: 3, q: 'seed=13', delay: 300 });
  await page.waitForSelector('.hand .card.is-legal');
  await tryClick(page.locator('.hand .card.is-legal').first());
  const seen = await page.waitForSelector('.tplay.is-winner, .trick__msg.is-banner', { timeout: 15000 }).then(() => true, () => false);
  check('trick: the winner is marked on the table before the trick is taken', seen);
  await page.close();
}

// ---------- responsive ----------
for (const [w, h] of [[1440, 900], [1024, 800], [390, 844]]) {
  for (const n of [2, 3, 4, 5]) {
    const page = await newPage(w, h, w < 700 ? { hasTouch: true, isMobile: true } : {});
    await page.goto(`${BASE}?seed=1`);
    await page.waitForSelector('#setup-form');
    if (n === 4) {
      check(`responsive ${w}px: landing has no horizontal scroll`, (await overflow(page)) <= 0);
      await shot(page, `landing-${w}`);
    }
    await setup(page, { players: n, types: ['human', 'medium', 'easy', 'easy', 'easy'], q: 'seed=9' });
    await page.waitForSelector('.hand .card.is-legal');
    check(`responsive ${w}px ${n}p: first screen has no horizontal scroll`, (await overflow(page)) <= 0);
    if (n === 4) await shot(page, `start-${w}`);
    const stats = newStats();
    for (let i = 0; i < 30 && stats.plays < 6; i++) await humanStep(page, stats);
    const box = await page.$eval('.table', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.right]; });
    check(`responsive ${w}px ${n}p: mid-game has no horizontal scroll, table fits with gutters`, (await overflow(page)) <= 0 && box[0] >= 0 && box[1] <= w, JSON.stringify(box));
    const seatSizes = await page.evaluate(() => [...document.querySelectorAll('.seat')].map((e) => {
      const fz = (x) => parseFloat(getComputedStyle(x).fontSize);
      const r = e.getBoundingClientRect();
      return { d: fz(e.querySelector('.pile--descent b')), c: fz(e.querySelector('.pile--climb b')), h: fz(e.querySelector('.seat__hand')), inside: r.left >= 0 && r.right <= window.innerWidth };
    }));
    check(`responsive ${w}px ${n}p: on every seat the descent count is at least the climb count and well above the cards-in-hand text, and the seat fits the screen`, seatSizes.length === n && seatSizes.every((x) => x.d >= x.c && x.c >= x.d * 0.55 && x.d >= x.h * 2.5 && x.inside), JSON.stringify(seatSizes[0]));
    await shot(page, `play-${n}p-${w}`);
    if ((w === 390 && n === 4) || (w === 1024 && n === 5) || (w === 1440 && n === 2)) {
      const s = await playHuman(page);
      check(`responsive ${w}px ${n}p: the whole game plays and ends without sideways scroll`, (await page.locator('.end--game').count()) === 1 && (await overflow(page)) <= 0, JSON.stringify(s));
      if (n === 4) await shot(page, `end-${w}`);
    }
    await page.close();
  }
}

// ---------- keyboard ----------
{
  const page = await newPage();
  await setup(page, { q: 'seed=11' });
  await page.waitForSelector('.hand .card.is-legal');
  await page.focus('.hand .card.is-legal');
  check('keyboard: focusing a card shows its hint', (await page.textContent('#preview')).length > 10);
  await page.keyboard.press('ArrowRight');
  check('keyboard: arrow keys move along the hand', await page.evaluate(() => document.activeElement.classList.contains('card')));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('keyboard: Enter on a focused card plays it or explains why not', (await page.locator('#note').count()) === 1);
  await page.close();
}

const real = problems.filter((p) => !/fonts\.(googleapis|gstatic)\.com/.test(p)); // web fonts are optional, with fallbacks

// ---------- the table: Mountain, marker, Colt, summit step, reveal, heels, reckoning ----------
{
  const page = await newPage();
  await setup(page, { players: 4, types: ['human', 'easy', 'easy', 'easy'], q: 'seed=11', delay: 120 });
  await page.waitForSelector('.hand .card.is-legal');
  check('mountain: the 0-7 card for 4 players, marker on step 0, the Colt with no Brumby cards, the mob worth 3',
    (await page.getAttribute('.mountain', 'data-side')) === '0-7' && (await page.getAttribute('.mountain__marker', 'data-step')) === '0' && (await page.locator('.colt .brumby').count()) === 0 && (await page.textContent('[data-mob]')) === '3');
  await imagesSettled(page, '.mountain__img, .colt__img, .mountain__piece, .hand .cardimg, .seat__avatar');
  const loaded = await page.$$eval('.mountain__img, .colt__img, .mountain__piece, .hand .cardimg, .seat__avatar', (els) => els.map((e) => e.complete && e.naturalWidth > 0));
  check('art: the Mountain, Colt, marker, avatars and every hand card face loaded (no broken or missing image)', loaded.length >= 15 && loaded.every(Boolean), `${loaded.length} images`);
  const foot = await page.evaluate(() => { const m = document.querySelector('.mountain__marker').getBoundingClientRect(); const c = document.querySelector('.mountain__card').getBoundingClientRect(); return { inside: m.left >= c.left && m.right <= c.right && m.bottom <= c.bottom + 4, lowerHalf: (m.bottom - c.top) / c.height > 0.8 }; });
  check('mountain: the marker starts at the foot of the slope (step 0), inside the card', foot.inside && foot.lowerHalf, JSON.stringify(foot));
  await page.evaluate(() => {
    window.__seen = { steps: [], offCallouts: 0, callouts: 0, reveal: 0, revealFaces: 0, heels: 0, heelsLine: 0, brumbies: 0, mobMax: 3, phases: [], range: {}, goal: 0, goalPairs: [], goalSize: 0, promptSize: 0, standing: 0, ownLast: null };
    const app = document.getElementById('app');
    const look = () => {
      const q = (x) => app.querySelectorAll(x).length;
      const S = window.__seen;
      const mk = app.querySelector('.mountain__marker');
      if (mk) { const st = Number(mk.dataset.step); if (S.steps[S.steps.length - 1] !== st) S.steps.push(st); }
      S.callouts += q('.mountain__callout'); S.offCallouts += q('.mountain__callout.is-off');
      if (q('.overlay--reveal')) { S.reveal++; S.revealFaces = Math.max(S.revealFaces, q('.overlay--reveal .reveal__card')); }
      S.heels += q('.tag--heels'); S.heelsLine += q('.mountain__heels');
      S.brumbies = Math.max(S.brumbies, q('.colt .brumby'));
      const mob = app.querySelector('[data-mob]'); if (mob) S.mobMax = Math.max(S.mobMax, Number(mob.textContent));
      const ph = app.querySelector('.phasebar'); if (ph) { const k = ph.className.replace('phasebar phasebar--', ''); if (!S.phases.includes(k)) S.phases.push(k); const rg = ph.querySelector('.phasebar__range'); S.range[k] = S.range[k] !== false && !!rg && /^Cards run 1 to 12 in each suit$/.test(rg.textContent); }
      const own = app.querySelector('.area-me .schip--own b'); if (own) S.ownLast = own.textContent;
      const goal = app.querySelector('.goal');
      if (goal) {
        S.goal++;
        const me = goal.querySelector('.goal__me');
        if (me) { const pair = `${S.ownLast}|${me.className.replace('goal__me goal__me--', '')}|${/chased: you need the most descent tricks/.test(me.textContent) ? 'chase-text' : /watched: block the chasers/.test(me.textContent) ? 'watch-text' : 'other'}`; if (!S.goalPairs.includes(pair)) S.goalPairs.push(pair); }
        S.goalSize = parseFloat(getComputedStyle(goal.querySelector('.goal__main')).fontSize);
        const pr = app.querySelector('#prompt'); if (pr) S.promptSize = parseFloat(getComputedStyle(pr).fontSize);
      }
      S.standing += q('.mountain__standing');
    };
    new MutationObserver(look).observe(app, { childList: true, subtree: true });
  });
  const stats = newStats();
  let modalCheck = null; let reck = null;
  const deadline = Date.now() + 170000;
  while (Date.now() < deadline) {
    if (!modalCheck && (await page.locator('.overlay--summit').count())) {
      await imagesSettled(page, '.overlay--summit .decide__card');
      modalCheck = await page.evaluate(() => ({ buttons: document.querySelectorAll('.overlay--summit [data-action=decide]').length, cards: [...document.querySelectorAll('.overlay--summit .decide__card')].every((e) => e.complete && e.naturalWidth > 0), stakes: document.querySelector('.overlay--summit').textContent, dialog: !!document.querySelector('.overlay--summit [role=dialog]'), hidesSide: !document.querySelector('.seat .schip--chase, .seat .schip--watch') }));
      await shot(page, 'summit-modal-1280', false);
    }
    if (!reck && (await page.locator('#continue').count())) {
      await imagesSettled(page, '.reck__card');
      reck = await page.evaluate(() => ({ rows: document.querySelectorAll('.reck__row').length, text: document.querySelector('.end--hand').textContent, faces: [...document.querySelectorAll('.reck__card')].every((e) => e.complete && e.naturalWidth > 0) }));
      await shot(page, 'reckoning-1280', false);
    }
    if ((await humanStep(page, stats)) === 'end') break;
  }
  const seen = await page.evaluate(() => window.__seen);
  check('summit: a modal step with a Chase card and a Watch card, both art loaded, the stakes stated, no side shown on any seat',
    !!modalCheck && modalCheck.buttons === 2 && modalCheck.cards && modalCheck.dialog && /Chase: risk your \d+ climb points? for the mob, worth \d+; if you fall, -1\./.test(modalCheck.stakes) && /Watch: bank \d+ points?\./.test(modalCheck.stakes) && /To bring the mob home you must win the most descent tricks; a tie goes to whoever won the later trick\./.test(modalCheck.stakes) && modalCheck.hidesSide, JSON.stringify(modalCheck));
  check('summit: the reveal showed a Chase or Watch face for every seat', seen.reveal > 0 && seen.revealFaces === 4, JSON.stringify(seen));
  const singles = seen.steps.reduce((k, x, i) => k + (i > 0 && x === seen.steps[i - 1] + 1 ? 1 : 0), 0);
  check('mountain: the marker climbed to the summit and single steps were shown, each its own picture', seen.steps.length >= 6 && Math.max(...seen.steps) === 7 && singles >= 5, `${JSON.stringify(seen.steps.slice(0, 30))}`);
  check('mountain: callouts were shown and off-suit steps called out', seen.callouts > 0 && seen.offCallouts > 0, `${seen.callouts} callouts, ${seen.offCallouts} off-suit`);
  check('phases: the climb, the summit and the descent banners were all shown', ['climb', 'summit', 'descent'].every((p) => seen.phases.includes(p)), JSON.stringify(seen.phases));
  check('range: the banner says "Cards run 1 to 12 in each suit" in the climb, the summit and the descent', ['climb', 'summit', 'descent'].every((p) => seen.range[p] === true), JSON.stringify(seen.range));
  check('goal: a big goal line (larger than the message line) is in the banner during the descent', seen.goal > 0 && seen.goalSize >= seen.promptSize * 1.2 && seen.goalSize >= 18, `${seen.goal} frames, ${seen.goalSize}px v ${seen.promptSize}px`);
  check('goal: the personal line always matches what the human chose (You chased / You watched)', seen.goalPairs.length >= 1 && seen.goalPairs.every((x) => /^(Chase\|chase\|chase-text|Watch\|watch\|watch-text)$/.test(x)), JSON.stringify(seen.goalPairs));
  check('descent: the seat at the mob heels was marked and the Mountain named them', seen.heels > 0 && seen.heelsLine > 0, `${seen.heels} / ${seen.heelsLine}`);
  check('colt: the mob value is on screen', seen.mobMax >= 3, `max ${seen.mobMax}, most Brumby cards seen ${seen.brumbies}`);
  check('reckoning: a row per seat with the Chase / Watch card, the arithmetic and the score', !!reck && reck.rows === 4 && reck.faces && /Total/.test(reck.text) && /(Watched|Brought the mob home|Fell)/.test(reck.text), JSON.stringify(reck && { rows: reck.rows }));
  await page.close();
}

// ---------- the Mountain for five players ----------
{
  const page = await newPage();
  await setup(page, { players: 5, q: 'seed=21' });
  await page.waitForSelector('.hand .card.is-legal');
  const info = await page.evaluate(() => ({ side: document.querySelector('.mountain').dataset.side, src: document.querySelector('.mountain__img').getAttribute('src'), text: document.querySelector('.mountain').textContent }));
  check('mountain: five players get the 0-6 card and the summit is step 6', info.side === '0-6' && /mountain-6/.test(info.src) && /of 6/.test(info.text), JSON.stringify(info));
  await shot(page, 'mountain-5p-1280');
  await page.close();
}

// ---------- pass and play: the summit is secret, the cover hides everything ----------
{
  const page = await newPage();
  await setup(page, { players: 3, types: ['human', 'human', 'easy'], names: ['Ann', 'Bo'], q: 'seed=5' });
  await page.waitForSelector('.cover', { timeout: 30000 });
  check('pass-and-play: the bug button is hidden under the cover and Ctrl+Shift+B opens nothing', !(await page.isVisible('#bug-button')) && await (async () => { await page.keyboard.press('Control+Shift+B'); await page.waitForTimeout(150); return (await page.locator('.bug').count()) === 0; })());
  let summitCover = null; let secretOk = true; let summits = 0;
  const stats2 = newStats();
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    if (await page.locator('.end--game').count()) break;
    if (await page.locator('.cover').count()) {
      const txt = await page.textContent('.cover');
      if (/Chase or Watch in secret/.test(txt)) {
        const leak = await page.locator('.mountain, .decision, .overlay, .seat, .hand, #log').count();
        const hidden = !(await page.isVisible('#bug-button'));
        summitCover = { leak, hidden };
        if (leak || !hidden) secretOk = false;
      }
    }
    if (await page.locator('.overlay--summit').count()) {
      const sides = await page.locator('.seat .schip--chase, .seat .schip--watch').count();
      if (sides) secretOk = false;
      summits++;
    }
    await humanStep(page, stats2);
  }
  check('pass-and-play: a cover saying Chase or Watch in secret came before each human summit choice, nothing of the table behind it, bug button dead', !!summitCover && secretOk && summitCover.leak === 0 && summitCover.hidden && summits >= 2, JSON.stringify({ summitCover, secretOk, summits }));
  await page.close();
}


// ---------- the summit must not stretch the seats (face-down choices are small chips) ----------
for (const [w, h, n] of [[1280, 900, 4], [1024, 800, 5], [390, 844, 5]]) {
  const page = await newPage(w, h, w < 700 ? { hasTouch: true, isMobile: true } : {});
  await setup(page, { players: n, types: ['human', 'easy', 'easy', 'easy', 'easy'], q: 'seed=11', delay: 300 });
  await page.waitForSelector('.hand .card.is-legal');
  await page.evaluate(() => {
    window.__h = { climb: {}, summit: {}, chipMax: 0, youMax: 0 };
    const app = document.getElementById('app');
    new MutationObserver(() => {
      const ph = app.querySelector('.phasebar');
      if (!ph) return;
      const seats = [...app.querySelectorAll('.seat')];
      if (ph.classList.contains('phasebar--climb')) seats.forEach((e) => { window.__h.climb[e.dataset.seat] = e.getBoundingClientRect().height; });
      if (ph.classList.contains('phasebar--summit')) {
        seats.forEach((e) => { window.__h.summit[e.dataset.seat] = Math.max(window.__h.summit[e.dataset.seat] || 0, e.getBoundingClientRect().height); });
        app.querySelectorAll('.seat .schip__card').forEach((e) => { window.__h.chipMax = Math.max(window.__h.chipMax, e.getBoundingClientRect().height); });
        const me = app.querySelector('.area-me'); if (me) window.__h.youMax = Math.max(window.__h.youMax, me.getBoundingClientRect().height);
      }
    }).observe(app, { childList: true, subtree: true });
  });
  const st = newStats();
  const until = Date.now() + 90000;
  while (Date.now() < until && !(await page.locator('.overlay--summit').count())) await humanStep(page, st);
  await page.waitForTimeout(150);
  const r = await page.evaluate(() => {
    const H = window.__h;
    const ratios = Object.keys(H.summit).filter((k) => H.climb[k]).map((k) => H.summit[k] / H.climb[k]);
    return { max: Math.max(...ratios), n: ratios.length, chipMax: H.chipMax, youMax: H.youMax, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  check(`summit ${w}px ${n}p: no seat grows more than 1.3x between the last climb trick and the summit`, r.n >= n && r.max <= 1.3, JSON.stringify(r));
  check(`summit ${w}px ${n}p: a face-down choice is a small chip (card thumbnail under 40 px), your seat stays small, no sideways scroll`, r.chipMax > 0 && r.chipMax <= 40 && r.youMax < 260 && r.overflow <= 0, JSON.stringify(r));
  await shot(page, `summit-${w}-${n}p`);
  // choose, and the reveal shows the faces without growing the seats. The reveal is a timed beat (about a second at this
  // pace), so what it shows is recorded by an observer the moment it appears; reading it after a fixed sleep failed
  // now and then on a busy machine, when the beat was over before the read.
  await page.evaluate(() => {
    window.__rev = null;
    new MutationObserver(() => {
      if (window.__rev) return;
      const r = document.querySelector('.overlay--reveal');
      if (r) window.__rev = { faces: r.querySelectorAll('.reveal__card').length, seatMax: Math.max(...[...document.querySelectorAll('.seat')].map((e) => e.getBoundingClientRect().height)) };
    }).observe(document.getElementById('app'), { childList: true, subtree: true });
  });
  await tryClick(page.locator('.overlay--summit [data-action=decide]').first());
  const rev = await page.waitForFunction(() => window.__rev, null, { timeout: 15000 }).then(() => true, () => false);
  if (rev) {
    const faces = await page.evaluate(() => window.__rev);
    check(`reveal ${w}px ${n}p: every seat's face is shown in the overlay and no seat is stretched`, faces.faces === n && faces.seatMax < 260, JSON.stringify(faces));
    await shot(page, `reveal-${w}-${n}p`);
  } else check(`reveal ${w}px ${n}p: the reveal overlay appeared`, false);
  await page.close();
}

// ---------- reduced motion for the marker ----------
{
  const rm = await newPage(1280, 900, { reducedMotion: 'reduce' });
  await setup(rm, { q: 'seed=11', delay: 800 });
  await rm.waitForSelector('.hand .card.is-legal');
  check('motion: the marker does not glide under prefers-reduced-motion', parseFloat(await rm.$eval('.mountain__marker', (e) => getComputedStyle(e).transitionDuration)) === 0);
  await rm.close();
  const page = await newPage(1280, 900);
  await setup(page, { q: 'seed=11', delay: 800 });
  await page.waitForSelector('.hand .card.is-legal');
  check('motion: the marker glides between steps by default', parseFloat(await page.$eval('.mountain__marker', (e) => getComputedStyle(e).transitionDuration)) > 0);
  await page.close();
}

// ---------- the learner option ----------
{
  const page = await newPage();
  await page.goto(`${BASE}?seed=3&botdelay=40`);
  await page.waitForSelector('#setup-form');
  check('learner: Play forced cards for me is off by default', !(await page.isChecked('#autoPlayForced')));
  await page.check('#autoPlayForced');
  check('learner: it can be ticked', await page.isChecked('#autoPlayForced'));
  await page.close();
}

check('console is clean (no errors, warnings, failed requests)', real.length === 0, real.slice(0, 5).join(' || '));

await browser.close();
close();
console.log(`screenshots: ${SHOTS}`);
done();
