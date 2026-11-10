// ui-browser.mjs - drives the real UI in headless Chromium (v5 rules): landing and setup (2-4 players, no rule
// book link), human v Easy (and every level that is registered) at 2 / 3 / 4 players, bot v bot, pass-and-play with
// the secret summit choice covered, the no-Worker fallback, reduced motion, phone widths, the keyboard and a clean
// console. Starts its own static server on a free port; needs Playwright, which is NOT a dependency
// of this repo (see tests/browser-lib.mjs). Without it the suite prints SKIPPED (exit 0), or exits 1 with --require.
// Screenshots go to a fresh folder under the system temp folder (the path is printed).
// Snowy River v5: the turn of the hands and the summit step (a modal with the turned hand, the row and the Chase and
// Watch cards) in every human game; no Playtest panel; scenarios for the Mountain and its marker, the Brumby row and
// kept cards, the Chase cost by player count, the reveal and the reckoning.
// Run: node tests/ui-browser.mjs [--require]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './lib.mjs';
import { requireChromium, serveRepo } from './browser-lib.mjs';
import { VARIANTS } from '../src/engine/index.js';
import { GAME_NAME, GAME_TAGLINE, PUBLISH_URL } from '../src/game-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// One folder per run: a fixed name would be overwritten by the next run, and on Windows an overwrite can
// fail while a virus scanner or indexer still holds the file from the last run.
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'card-game-ui-shots-'));
// --part=a,b runs only the named sections (landing, human4, levels-easy, levels-medium, levels-hard, botbot, passplay,
// motion, trick, responsive-1440, responsive-1024, responsive-390, keyboard, hand, stretch, learner). Default: all.
// A full run takes several minutes; in a shell that throttles background jobs, run it in parts in the foreground.
const PART = (process.argv.find((a) => a.startsWith('--part=')) || '').slice(7);
const want = (name) => !PART || PART.split(',').includes(name);
const { check: rawCheck, done } = suite('ui-browser');
// Each check is printed as it is made, so a slow or stuck run shows where it is.
const check = (label, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` -- ${String(detail).slice(0, 300)}`}`); return rawCheck(label, cond, detail); };

const chromium = await requireChromium('ui-browser');
const { base: BASE, close } = await serveRepo(ROOT);
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const tokensLeft = /\{\{[A-Z_]+\}\}/.test(html);

// Background throttling off: a run started in the background (CI, a terminal tab, an agent) would otherwise crawl.
const browser = await chromium.launch({ args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'] });
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

async function setup(page, { players = 4, types = ['human', 'easy', 'easy', 'easy'], names = [], q = 'seed=11', delay = 40 } = {}) {
  await page.goto(`${BASE}?botdelay=${delay}&${q}`);
  await page.waitForSelector('#setup-form');
  await page.check(`input[name=players][value="${players}"]`);
  for (let i = 0; i < players; i++) {
    await page.selectOption(`select[name=type${i}]`, types[i]);
    if (names[i]) await page.fill(`input[name=name${i}]`, names[i]);
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
  let i = 0;
  while (Date.now() < deadline) {
    const r = await humanStep(page, stats);
    if (process.env.UI_DEBUG && i++ % 40 === 0) console.log(`  [playHuman ${i}] ${r} ${JSON.stringify(stats)}`);
    if (r === 'end') break;
  }
  return stats;
}

// ---------- landing ----------
if (want('landing')) {
  const page = await newPage();
  await page.goto(`${BASE}?seed=1`);
  await page.waitForSelector('#setup-form');
  check('landing: title is the game name', (await page.title()) === GAME_NAME, await page.title());
  check('landing: the hook is the v5 tagline', (await page.textContent('.hero__hook')) === GAME_TAGLINE && /turn your hand round/.test(GAME_TAGLINE));
  check('landing: stat strip says 2-4 players, 20-30 minutes, ages 10+', /2-4[\s\S]*Players[\s\S]*20-30[\s\S]*Minutes[\s\S]*10\+[\s\S]*Ages/.test(await page.textContent('.stats')));
  await imagesSettled(page, '.hero__img');
  check('landing: the hero art is the key art with the title, fully loaded', await page.$eval('.hero__img', (e) => e.complete && e.naturalWidth >= 1000));
  check('landing: no rule book link anywhere on the page (no PDF link, no "rule book" text)', (await page.locator('a[data-action=rulebook], a[href$=".pdf"]').count()) === 0 && !/rule book/i.test(await page.textContent('body')));
  const opts = await page.$$eval('select[name=type1] option', (o) => o.map((x) => x.value));
  check('landing: Human and the three bot levels are on the menu, simulator bots are not', ['human', 'easy', 'medium', 'hard'].every((v) => opts.includes(v)) && !opts.includes('high'), opts.join(','));
  check('landing: hint to watch bots', /Set every seat to a bot to watch a game/.test(await page.textContent('.hint')));
  check('landing: no Playtest rules panel (there are no switches)', VARIANTS.length === 0 && (await page.locator('#rules-panel, .rule').count()) === 0);
  check('landing: How to play teaches v5 (two numbers on a card, the turn, Chase / Watch)', /two numbers/.test(await page.textContent('#how')) && /turns their whole hand round/.test(await page.textContent('#how')));
  check('landing: only 2, 3 and 4 players are offered', JSON.stringify(await page.$$eval('input[name=players]', (e) => e.map((x) => x.value))) === '["2","3","4"]');
  await page.check('input[name=players][value="2"]');
  check('landing: 2 players shows 2 seats', (await page.locator('.seatform:visible').count()) === 2);
  await page.check('input[name=players][value="4"]');
  check('landing: 4 players shows 4 seats', (await page.locator('.seatform:visible').count()) === 4);
  if (!tokensLeft) check('landing: og:url is the published address', (await page.$eval('meta[property="og:url"]', (m) => m.content)) === PUBLISH_URL);
  check('landing: the favicon is declared and loads', (await (await page.request.get(`${BASE}assets/favicon.png`)).status()) === 200 && (await page.getAttribute('link[rel=icon]', 'href')) === 'assets/favicon.png');
  check('landing: a bug button is on the body', (await page.locator('body > #bug-button').count()) === 1);
  await shot(page, 'landing-1280');
  await page.click('[data-action=open-rules]');
  check('landing: the How to play dialog opens, with no rule book link in it', (await page.locator('.dialog').count()) === 1 && /Chase or Watch/.test(await page.textContent('.dialog')) && (await page.locator('.dialog a').count()) === 0);
  await page.keyboard.press('Escape');
  check('landing: Escape closes the dialog', (await page.locator('.dialog').count()) === 0);
  await page.close();
}

// ---------- human v Easy, 4 players ----------
if (want('human4')) {
  const page = await newPage();
  await setup(page, { names: ['Mia'] });
  await page.waitForSelector('.hand .card.is-legal');
  check('4p: four seats round the table, each with one pile of tricks (no climb / descent piles)', (await page.locator('.seat').count()) === 4 && (await page.locator('.seat .pile').count()) === 4 && (await page.locator('.pile--descent, .pile--climb').count()) === 0);
  check('4p: twelve cards in the hand, sorted by suit', (await page.locator('.hand .card').count()) === 12);
  check('4p: the Mountain climb side shows the mob on step 0 of 6, Escape named as trumps', (await page.getAttribute('.mountain', 'data-side')) === 'climb' && (await page.getAttribute('.mountain__marker', 'data-step')) === '0' && /Escape is trumps going up/.test(await page.textContent('.mountain__trump')));
  check('4p: the phase banner says THE CLIMB, highest wins, Escape is trumps', /The climb/.test(await page.textContent('.phasebar')) && /highest wins/i.test(await page.textContent('.phasebar')) && /Escape is trumps/.test(await page.textContent('.phasebar')));
  check('4p: the row has six face-down cards, the deck holds 12, Chase costs 2', (await page.locator('.rslot--down').count()) === 6 && /Deck\s*12/.test(await page.textContent('.row__piles')) && /Chase costs 2/.test(await page.textContent('.row__cost')));
  {
    const counts = await page.$$eval('.seat', (els) => els.map((e) => e.querySelector('.seat__cardsnum') && e.querySelector('.seat__cardsnum').textContent));
    check('4p: every seat shows its cards in hand as a number (12 each at the start), and your own matches the hand', counts.length === 4 && counts.every((t) => t === '12') && Number(await page.textContent('.area-me .seat__cardsnum')) === (await page.locator('.hand .card').count()));
  }
  await imagesSettled(page, '.hand .cardimg');
  {
    const faces = await page.$$eval('.hand .card', (els) => els.map((e) => ({ id: e.dataset.card, asset: e.querySelector('img') && e.querySelector('img').dataset.asset, src: e.querySelector('img') && e.querySelector('img').getAttribute('src'), ok: e.querySelector('img') && e.querySelector('img').complete && e.querySelector('img').naturalWidth > 0, turned: e.querySelector('img') && e.querySelector('img').classList.contains('is-turned') })));
    check('4p: every card in the hand shows its own face (card-<suit>-<n>), loaded, climb side up', faces.length === 12 && faces.every((f) => f.asset === `card-${f.id}` && f.src === `assets/cards/card-${f.id}.webp` && f.ok && !f.turned), JSON.stringify(faces.filter((f) => !(f.asset === `card-${f.id}` && f.ok)).slice(0, 2)));
  }
  await shot(page, 'start-1280');
  await page.locator('.hand .card.is-legal').first().click();
  await page.waitForFunction(() => document.querySelector('.area-me .seat__cardsnum').textContent === '11', null, { timeout: 8000 }).catch(() => {});
  check('4p: playing a card lowers your cards-in-hand number', (await page.textContent('.area-me .seat__cardsnum')) === '11');
  const s = await playHuman(page);
  check('4p: human plays and the game ends', s.plays >= 8 && (await page.locator('.end--game').count()) === 1, JSON.stringify(s));
  check('4p: the human made a secret summit choice with the Chase / Watch cards', s.summits >= 1, JSON.stringify(s));
  check('4p: every hand end showed the reckoning (4 hands)', s.summaries >= 3, `${s.summaries}`);
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

// ---------- every registered level at 2, 3 and 4 players ----------
for (const level of levels.filter((l) => ['easy', 'medium', 'hard'].includes(l) && want(`levels-${l}`))) {
  for (const n of [2, 3, 4]) {
    const page = await newPage();
    await setup(page, { players: n, types: ['human', level, level, level], q: 'seed=21' });
    await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
    const s = await playHuman(page);
    check(`${n}p v ${level}: the game ends with a ranking of ${n}`, (await page.locator('.end--game').count()) === 1 && (await page.locator('.rank').count()) === n, JSON.stringify(s));
    check(`${n}p v ${level}: the human played cards and chose at the summit`, s.plays >= 6 && s.summits >= 1, JSON.stringify(s));
    await page.close();
  }
}

// ---------- bot v bot, with and without Workers ----------
if (want('botbot')) {
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

// ---------- pass and play: the summit choice is secret, the cover hides everything ----------
if (want('passplay')) {
  const page = await newPage();
  await setup(page, { players: 3, types: ['human', 'human', 'easy'], names: ['Ann', 'Bo'], q: 'seed=5' });
  await page.waitForSelector('.cover', { timeout: 30000 });
  check('pass-and-play: a cover comes first and body is marked covered', (await page.getAttribute('body', 'data-covered')) === '1' && /Pass to (Ann|Bo)/.test(await page.textContent('.cover')));
  check('pass-and-play: the bug button is hidden under the cover and Ctrl+Shift+B opens nothing', !(await page.isVisible('#bug-button')) && await (async () => { await page.keyboard.press('Control+Shift+B'); await page.waitForTimeout(150); return (await page.locator('.bug').count()) === 0; })());
  await page.evaluate(() => {
    window.__pp = { summitCovers: 0, leaks: 0, sidesSeen: 0, reveals: 0, revealFaces: 0, summitModals: 0, modalNames: [] };
    const app = document.getElementById('app');
    new MutationObserver(() => {
      const P = window.__pp;
      const cover = app.querySelector('.cover');
      if (cover && /Chase or Watch in secret/.test(cover.textContent)) { P.summitCovers++; if (app.querySelectorAll('.mountain, .decision, .overlay, .seat, .hand, #log, .row').length) P.leaks++; }
      if (app.querySelector('.overlay--summit')) { P.summitModals++; P.modalNames.push((app.querySelector('#summit-title') || {}).textContent); }
      // a side must never be on a seat before the reveal
      if (!app.querySelector('.overlay--reveal') && app.querySelector('.phasebar--summit') && app.querySelectorAll('.seat .schip--chase, .seat .schip--watch').length > 0 && !app.querySelector('.schip--own')) P.sidesSeen++;
      const r = app.querySelector('.overlay--reveal'); if (r) { P.reveals++; P.revealFaces = Math.max(P.revealFaces, r.querySelectorAll('.reveal__card').length); }
    }).observe(app, { childList: true, subtree: true });
  });
  const s = newStats();
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) { if ((await humanStep(page, s)) === 'end') break; }
  const pp = await page.evaluate(() => window.__pp);
  check('pass-and-play: the game ends, with a cover before each human turn and no leak behind it', (await page.locator('.end--game').count()) === 1 && s.covers > 10 && s.coverLeaks === 0, JSON.stringify(s));
  check('pass-and-play: a cover saying Chase or Watch in secret came before every human summit choice, nothing of the table behind it', pp.summitCovers >= 2 && pp.leaks === 0 && pp.summitModals >= 2 && s.summits >= 2, JSON.stringify(pp));
  check('pass-and-play: each human chose alone (the modal names them), nobody\'s side showed before the reveal, then all faces were revealed together', pp.modalNames.some((t) => /Ann/.test(t)) && pp.modalNames.some((t) => /Bo/.test(t)) && pp.sidesSeen === 0 && pp.reveals > 0 && pp.revealFaces === 3, JSON.stringify(pp));
  await page.close();
}

// ---------- motion ----------
if (want('motion')) {
  const page = await newPage(1280, 900);
  await setup(page, { q: 'seed=11', delay: 800 });
  await page.waitForSelector('.hand .card.is-legal');
  check('motion: cards transition by default', parseFloat(await page.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) > 0);
  check('motion: the marker glides between steps by default', parseFloat(await page.$eval('.mountain__marker', (e) => getComputedStyle(e).transitionDuration)) > 0);
  await page.close();
  const rm = await newPage(1280, 900, { reducedMotion: 'reduce' });
  await setup(rm, { q: 'seed=11', delay: 800 });
  await rm.waitForSelector('.hand .card.is-legal');
  check('motion: prefers-reduced-motion turns the transitions off', parseFloat(await rm.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) === 0);
  check('motion: the marker does not glide under prefers-reduced-motion', parseFloat(await rm.$eval('.mountain__marker', (e) => getComputedStyle(e).transitionDuration)) === 0);
  await rm.close();
}

// ---------- the trick winner is shown ----------
if (want('trick')) {
  const page = await newPage();
  await setup(page, { players: 3, q: 'seed=13', delay: 300 });
  await page.waitForSelector('.hand .card.is-legal');
  await tryClick(page.locator('.hand .card.is-legal').first());
  const seen = await page.waitForSelector('.tplay.is-winner, .trick__msg.is-banner', { timeout: 15000 }).then(() => true, () => false);
  check('trick: the winner is marked on the table before the trick is taken', seen);
  await page.close();
}

// ---------- responsive ----------
for (const [w, h] of [[1440, 900], [1024, 800], [390, 844]].filter(([w]) => want(`responsive-${w}`))) {
  for (const n of [2, 3, 4]) {
    const page = await newPage(w, h, w < 700 ? { hasTouch: true, isMobile: true } : {});
    await page.goto(`${BASE}?seed=1`);
    await page.waitForSelector('#setup-form');
    if (n === 4) {
      check(`responsive ${w}px: landing has no horizontal scroll`, (await overflow(page)) <= 0);
      await shot(page, `landing-${w}`);
    }
    await setup(page, { players: n, types: ['human', 'medium', 'easy', 'easy'], q: 'seed=9' });
    await page.waitForSelector('.hand .card.is-legal');
    check(`responsive ${w}px ${n}p: first screen has no horizontal scroll`, (await overflow(page)) <= 0);
    if (n === 4) await shot(page, `start-${w}`);
    const stats = newStats();
    for (let i = 0; i < 30 && stats.plays < 6; i++) await humanStep(page, stats);
    const box = await page.$eval('.table', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.right]; });
    check(`responsive ${w}px ${n}p: mid-game has no horizontal scroll, table fits with gutters`, (await overflow(page)) <= 0 && box[0] >= 0 && box[1] <= w, JSON.stringify(box));
    const seatSizes = await page.evaluate(() => [...document.querySelectorAll('.seat')].map((e) => { const r = e.getBoundingClientRect(); return { inside: r.left >= 0 && r.right <= window.innerWidth }; }));
    check(`responsive ${w}px ${n}p: every seat fits the screen`, seatSizes.length === n && seatSizes.every((x) => x.inside), JSON.stringify(seatSizes));
    await shot(page, `play-${n}p-${w}`);
    if ((w === 390 && n === 4) || (w === 390 && n === 2) || (w === 1024 && n === 3) || (w === 1440 && n === 2)) {
      let atSummit = false;
      const until = Date.now() + 90000;
      while (Date.now() < until && !(await page.locator('.overlay--summit').count()) && !(await page.locator('.end--game').count())) await humanStep(page, stats);
      if (await page.locator('.overlay--summit').count()) {
        atSummit = true;
        await imagesSettled(page, '.overlay--summit img');
        const m = await page.evaluate(() => { const e = document.querySelector('.overlay--summit .end'); const r = e.getBoundingClientRect(); return { fits: r.left >= 0 && r.right <= window.innerWidth, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, cards: document.querySelectorAll('.overlay--summit .summit__brumby').length, hand: document.querySelectorAll('.overlay--summit .summit__hand li').length, chase: document.querySelector('.overlay--summit .decide--chase .decide__card').getAttribute('src') }; });
        check(`responsive ${w}px ${n}p: the summit modal fits (no sideways scroll), shows the row, the turned hand and the Chase card for the cost`, m.fits && m.over <= 0 && m.cards === 6 && m.hand === 6 && m.chase === (n === 2 ? 'assets/cards/chase-3.webp' : 'assets/cards/chase-2.webp'), JSON.stringify(m));
        await shot(page, `summit-${n}p-${w}`, false);
      }
      const s = await playHuman(page);
      check(`responsive ${w}px ${n}p: the whole game plays and ends without sideways scroll`, atSummit && (await page.locator('.end--game').count()) === 1 && (await overflow(page)) <= 0, JSON.stringify(s));
      if (n === 4) await shot(page, `end-${w}`);
    }
    await page.close();
  }
}

// ---------- keyboard ----------
if (want('keyboard')) {
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

// ---------- the whole hand on screen: marker, turn, summit, reveal, row, kept cards, reckoning (2, 3 and 4 players) ----------
for (const n of [4, 2, 3].filter(() => want('hand'))) {
  const cost = n === 2 ? 3 : 2;
  const page = await newPage();
  await setup(page, { players: n, types: ['human', 'easy', 'easy', 'easy'], q: 'seed=11', delay: 120 });
  await page.waitForSelector('.hand .card.is-legal');
  await imagesSettled(page, '.mountain__img, .mountain__piece, .hand .cardimg, .seat__avatar, .rslot__img');
  const loaded = await page.$$eval('.mountain__img, .mountain__piece, .hand .cardimg, .seat__avatar, .rslot__img', (els) => els.map((e) => e.complete && e.naturalWidth > 0));
  check(`${n}p art: the Mountain, marker, avatars, the face-down row and every hand card face loaded`, loaded.length >= 20 && loaded.every(Boolean), `${loaded.length} images`);
  const foot = await page.evaluate(() => { const m = document.querySelector('.mountain__marker').getBoundingClientRect(); const c = document.querySelector('.mountain__card').getBoundingClientRect(); return { inside: m.left >= c.left - 2 && m.right <= c.right + 2 && m.bottom <= c.bottom + 4, lowerHalf: (m.bottom - c.top) / c.height > 0.8 }; });
  check(`${n}p mountain: the marker starts at the foot of the road (step 0), inside the card`, foot.inside && foot.lowerHalf, JSON.stringify(foot));
  await page.evaluate(() => {
    window.__seen = { steps: [], turn: 0, turnHandTurned: 0, handTurnedFrames: 0, handUpright: 0, reveal: 0, revealFaces: 0, rowTakenMax: 0, keptMax: 0, keptSumOk: true, sides: [], mountains: [], nextLit: 0, trumpLines: [], discardMax: 0, phases: [], goal: 0 };
    const app = document.getElementById('app');
    const look = () => {
      const q = (x) => app.querySelectorAll(x).length;
      const S = window.__seen;
      const mk = app.querySelector('.mountain__marker');
      if (mk) { const st = Number(mk.dataset.step); if (S.steps[S.steps.length - 1] !== st) S.steps.push(st); }
      const mt = app.querySelector('.mountain'); if (mt) { const d = mt.dataset.side; if (S.mountains[S.mountains.length - 1] !== d) S.mountains.push(d); const tl = mt.querySelector('.mountain__trump'); if (tl) { const t = tl.textContent.trim(); if (S.trumpLines[S.trumpLines.length - 1] !== t) S.trumpLines.push(t); } }
      if (q('.overlay--turn')) { S.turn++; }
      const hand = app.querySelector('.hand');
      if (hand && hand.classList.contains('hand--turned')) { S.handTurnedFrames++; if ([...hand.querySelectorAll('img')].some((i) => !i.classList.contains('is-turned'))) S.handUpright++; }
      else if (hand && [...hand.querySelectorAll('img')].some((i) => i.classList.contains('is-turned'))) S.handUpright++;
      const r = app.querySelector('.overlay--reveal'); if (r) { S.reveal++; S.revealFaces = Math.max(S.revealFaces, r.querySelectorAll('.reveal__card').length); }
      S.rowTakenMax = Math.max(S.rowTakenMax, q('.rslot.is-taken'));
      S.nextLit = Math.max(S.nextLit, q('.rslot.is-next'));
      S.keptMax = Math.max(S.keptMax, q('.seat .kept__card'));
      S.discardMax = Math.max(S.discardMax, Number((app.querySelector('.row__discard summary b, .row__piles .row__pile:last-child b') || {}).textContent || 0));
      const ph = app.querySelector('.phasebar'); if (ph) { const k = ph.className.replace('phasebar phasebar--', ''); if (!S.phases.includes(k)) S.phases.push(k); }
      if (q('.goal')) S.goal++;
    };
    new MutationObserver(look).observe(app, { childList: true, subtree: true });
  });
  const stats = newStats();
  let modalCheck = null; let reck = null; let handAfterTurn = null;
  const deadline = Date.now() + 170000;
  while (Date.now() < deadline) {
    if (!modalCheck && (await page.locator('.overlay--summit').count())) {
      await imagesSettled(page, '.overlay--summit img');
      modalCheck = await page.evaluate(() => ({
        buttons: document.querySelectorAll('.overlay--summit [data-action=decide]').length,
        cards: [...document.querySelectorAll('.overlay--summit img')].every((e) => e.complete && e.naturalWidth > 0),
        row: document.querySelectorAll('.overlay--summit .summit__brumby').length, hand: document.querySelectorAll('.overlay--summit .summit__hand li').length,
        handTurned: [...document.querySelectorAll('.overlay--summit .summit__hand img')].every((i) => i.classList.contains('is-turned') && getComputedStyle(i).transform !== 'none'),
        text: document.querySelector('.overlay--summit').textContent, chaseSrc: document.querySelector('.decide--chase .decide__card').getAttribute('src'),
        dialog: !!document.querySelector('.overlay--summit [role=dialog]'), hidesSide: !document.querySelector('.seat .schip--chase, .seat .schip--watch'),
      }));
      handAfterTurn = await page.evaluate(() => [...document.querySelectorAll('.hand .card')].map((e) => ({ id: e.dataset.card, asset: e.querySelector('img').dataset.asset, turned: e.querySelector('img').classList.contains('is-turned'), transform: getComputedStyle(e.querySelector('img')).transform })));
      await shot(page, `summit-modal-${n}p`, false);
    }
    if (!reck && (await page.locator('#continue').count())) {
      await imagesSettled(page, '.reck img');
      reck = await page.evaluate(() => ({ rows: document.querySelectorAll('.reck__row').length, text: document.querySelector('.end--hand').textContent, faces: [...document.querySelectorAll('.reck img')].every((e) => e.complete && e.naturalWidth > 0) }));
      await shot(page, `reckoning-${n}p`, false);
    }
    if ((await humanStep(page, stats)) === 'end') break;
  }
  const seen = await page.evaluate(() => window.__seen);
  check(`${n}p summit: a modal with the turned hand, the six-card row (art loaded), a Chase and a Watch card, and no side shown on any seat`,
    !!modalCheck && modalCheck.buttons === 2 && modalCheck.cards && modalCheck.dialog && modalCheck.row === 6 && modalCheck.hand === 6 && modalCheck.handTurned && modalCheck.hidesSide && /Your hand, turned round/.test(modalCheck.text), JSON.stringify(modalCheck));
  check(`${n}p summit: Chase costs ${cost} (the ${cost === 3 ? 'chase-3' : 'chase-2'} face, "pay ${cost}"), Watch pays nothing`, !!modalCheck && modalCheck.chaseSrc === `assets/cards/chase-${cost}.webp` && new RegExp(`Chase: pay ${cost}`).test(modalCheck.text) && /Watch: pay nothing/.test(modalCheck.text), modalCheck && modalCheck.chaseSrc);
  check(`${n}p turn: after the summit the hand is shown turned round (every card rotated 180 degrees, sorted by the number now on top), and never half turned`,
    !!handAfterTurn && handAfterTurn.length === 6 && handAfterTurn.every((c) => c.turned && c.asset === `card-${c.id}` && /matrix\(-1, 0, 0, -1|matrix\(-1, -1.2/.test(c.transform)) && seen.handTurnedFrames > 0 && seen.handUpright === 0, JSON.stringify({ handAfterTurn: handAfterTurn && handAfterTurn.slice(0, 2), seen: [seen.handTurnedFrames, seen.handUpright] }));
  check(`${n}p turn: the turn of the hands was shown as its own beat, and the Mountain turned from the climb side to the descent side`, seen.turn > 0 && JSON.stringify(seen.mountains.slice(0, 2)) === '["climb","descent"]', JSON.stringify([seen.turn, seen.mountains]));
  check(`${n}p mountain: the trump line says Escape going up, then Home going down`, /Escape is trumps going up/.test(seen.trumpLines[0] || '') && seen.trumpLines.some((t) => /Home is trumps going down/.test(t)), JSON.stringify(seen.trumpLines));
  const singles = seen.steps.reduce((k, x, i) => k + (i > 0 && x === seen.steps[i - 1] + 1 ? 1 : 0), 0);
  check(`${n}p mountain: the marker climbed one step per trick to the sixth circle`, Math.max(...seen.steps) === 6 && singles >= 5, JSON.stringify(seen.steps.slice(0, 20)));
  check(`${n}p phases: the climb, the summit and the descent banners were all shown`, ['climb', 'summit', 'descent'].every((p) => seen.phases.includes(p)), JSON.stringify(seen.phases));
  check(`${n}p reveal: the reveal showed a Chase or Watch face for every seat`, seen.reveal > 0 && seen.revealFaces === n, JSON.stringify([seen.reveal, seen.revealFaces]));
  check(`${n}p row: the next card to be won was lit, taken cards were marked, the discard grew`, seen.nextLit >= 1 && seen.rowTakenMax >= 6 && seen.discardMax >= 1, JSON.stringify([seen.nextLit, seen.rowTakenMax, seen.discardMax]));
  check(`${n}p kept: a chaser's Brumby cards were shown face up on their seat`, seen.keptMax >= 1, `${seen.keptMax}`);
  check(`${n}p goal: the descent block named the chasers and what a chaser keeps`, seen.goal > 0, `${seen.goal}`);
  check(`${n}p reckoning: a row per seat with the Chase / Watch card, the arithmetic and the score`, !!reck && reck.rows === n && reck.faces && /Total/.test(reck.text) && /(Watch|Chase -\d)/.test(reck.text) && /tricks? /.test(reck.text), JSON.stringify(reck && { rows: reck.rows }));
  await page.close();
}

// ---------- the summit must not stretch the seats (face-down choices are small chips) ----------
for (const [w, h, n] of [[1280, 900, 4], [390, 844, 4]].filter(() => want('stretch'))) {
  const page = await newPage(w, h, w < 700 ? { hasTouch: true, isMobile: true } : {});
  await setup(page, { players: n, types: ['human', 'easy', 'easy', 'easy'], q: 'seed=11', delay: 300 });
  await page.waitForSelector('.hand .card.is-legal');
  await page.evaluate(() => {
    window.__h = { climb: {}, summit: {}, chipMax: 0 };
    const app = document.getElementById('app');
    new MutationObserver(() => {
      const ph = app.querySelector('.phasebar');
      if (!ph) return;
      const seats = [...app.querySelectorAll('.seat')];
      if (ph.classList.contains('phasebar--climb')) seats.forEach((e) => { window.__h.climb[e.dataset.seat] = e.getBoundingClientRect().height; });
      if (ph.classList.contains('phasebar--summit')) {
        seats.forEach((e) => { window.__h.summit[e.dataset.seat] = Math.max(window.__h.summit[e.dataset.seat] || 0, e.getBoundingClientRect().height); });
        app.querySelectorAll('.seat .schip__card').forEach((e) => { window.__h.chipMax = Math.max(window.__h.chipMax, e.getBoundingClientRect().height); });
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
    return { max: Math.max(...ratios), n: ratios.length, chipMax: H.chipMax, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  check(`summit ${w}px ${n}p: no seat grows more than 1.3x between the last climb trick and the summit`, r.n >= n && r.max <= 1.3, JSON.stringify(r));
  check(`summit ${w}px ${n}p: a face-down choice is a small chip (card thumbnail under 40 px), no sideways scroll`, r.chipMax > 0 && r.chipMax <= 40 && r.overflow <= 0, JSON.stringify(r));
  await page.close();
}

// ---------- the learner option ----------
if (want('learner')) {
  const page = await newPage();
  await page.goto(`${BASE}?seed=3&botdelay=40`);
  await page.waitForSelector('#setup-form');
  check('learner: Play forced cards for me is off by default', !(await page.isChecked('#autoPlayForced')));
  await page.check('#autoPlayForced');
  check('learner: it can be ticked', await page.isChecked('#autoPlayForced'));
  await page.close();
}

const real = problems.filter((p) => !/fonts\.(googleapis|gstatic)\.com/.test(p)); // web fonts are optional, with fallbacks
check('console is clean (no errors, warnings, failed requests)', real.length === 0, real.slice(0, 5).join(' || '));

await browser.close();
close();
console.log(`screenshots: ${SHOTS}`);
done();
