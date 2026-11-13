// ui-browser.mjs - drives the real UI in headless Chromium (v6 rules): landing and setup (2-5 players, no rule
// book link), human v Easy (and every level that is registered) at 2 / 3 / 4 / 5 players, bot v bot, pass-and-play,
// the no-Worker fallback, reduced motion, phone widths, the keyboard and a clean console. Starts its own static
// server on a free port; needs Playwright, which is NOT a dependency of this repo (see tests/browser-lib.mjs).
// Without it the suite prints SKIPPED (exit 0), or exits 1 with --require.
// Screenshots go to a fresh folder under the system temp folder (the path is printed).
// Snowy River v6: the half banner (direction and trumps), the Climb row and the Brumby row, the cards each seat
// has taken and its hand score, the summit beat, the reckoning. No Chase / Watch, no Mountain, no turning of hands.
// Run: node tests/ui-browser.mjs [--require] [--part=a,b]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite } from './lib.mjs';
import { requireChromium, serveRepo } from './browser-lib.mjs';
import { VARIANTS } from '../src/engine/index.js';

const V5 = /\bChase\b|\bChasing\b|\bWatch\b|\bwatcher|\bchaser|Mountain|mob marker|turns? (their|your) (whole )?hand|turned round|two numbers|\bsplit\b/;
import { GAME_NAME, GAME_TAGLINE, PUBLISH_URL } from '../src/game-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// One folder per run: a fixed name would be overwritten by the next run, and on Windows an overwrite can
// fail while a virus scanner or indexer still holds the file from the last run.
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'card-game-ui-shots-'));
// --part=a,b runs only the named sections (landing, human4, levels-easy, levels-medium, levels-hard, botbot, passplay,
// motion, trick, responsive-1440, responsive-1024, responsive-390, keyboard, hand, learner). Default: all.
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
const newStats = () => ({ plays: 0, covers: 0, coverLeaks: 0, summaries: 0, illegalTried: 0, tooltipMatches: 0, hints: 0 });

/**
 * One human decision, whatever it is: a cover, a reckoning or a card (the first few times a
 * dimmed card is clicked first, to see that it explains itself). Returns what it did.
 */
async function humanStep(page, stats) {
  if (await page.locator('.end--game').count()) return 'end';
  if (await page.locator('.cover').count()) {
    stats.covers++;
    if (await page.locator('.hand, .card, .cardimg, .table, .log__list, .rslot, .row, .taken, .ride, .overlay, .seat').count()) stats.coverLeaks++;
    await tryClick(page.locator('.cover .btn--primary'));
    return 'cover';
  }
  if (await page.locator('#continue').count()) { if (await tryClick(page.locator('#continue'))) stats.summaries++; return 'summary'; }
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
  check('landing: the hook is the v6 tagline (no turning the hand)', (await page.textContent('.hero__hook')) === GAME_TAGLINE && /smallest horse/.test(GAME_TAGLINE) && !V5.test(GAME_TAGLINE));
  check('landing: stat strip says 2-5 players, 20-30 minutes, ages 10+', /2-5[\s\S]*Players[\s\S]*20-30[\s\S]*Minutes[\s\S]*10\+[\s\S]*Ages/.test(await page.textContent('.stats')));
  await imagesSettled(page, '.hero__img');
  check('landing: the hero art is the key art with the title, fully loaded', await page.$eval('.hero__img', (e) => e.complete && e.naturalWidth >= 1000));
  check('landing: no rule book link anywhere on the page (no PDF link, no "rule book" text)', (await page.locator('a[data-action=rulebook], a[href$=".pdf"]').count()) === 0 && !/rule book/i.test(await page.textContent('body')));
  const opts = await page.$$eval('select[name=type1] option', (o) => o.map((x) => x.value));
  check('landing: Human and the three bot levels are on the menu, simulator bots are not', ['human', 'easy', 'medium', 'hard'].every((v) => opts.includes(v)) && !opts.includes('high') && !opts.includes('naive'), opts.join(','));
  check('landing: hint to watch bots', /Set every seat to a bot to watch a game/.test(await page.textContent('.hint')));
  check('landing: no Playtest rules panel (there are no switches)', VARIANTS.length === 0 && (await page.locator('#rules-panel, .rule').count()) === 0);
  check('landing: How to play teaches v6 (one number a card, the Climb row with a -1, the summit, lowest wins, no choice) and no v5 words', /one number/.test(await page.textContent('#how')) && /one worth -1/.test(await page.textContent('#how')) && /lowest card wins/.test(await page.textContent('#how')) && /no choice/.test(await page.textContent('#how')) && !V5.test(await page.textContent('body')), (await page.textContent('body')).match(V5) && (await page.textContent('body')).match(V5)[0]);
  check('landing: 2, 3, 4 and 5 players are offered', JSON.stringify(await page.$$eval('input[name=players]', (e) => e.map((x) => x.value))) === '["2","3","4","5"]');
  for (const n of [2, 3, 4, 5]) {
    await page.check(`input[name=players][value="${n}"]`);
    check(`landing: ${n} players shows ${n} seats`, (await page.locator('.seatform:visible').count()) === n);
  }
  if (!tokensLeft) check('landing: og:url is the published address', (await page.$eval('meta[property="og:url"]', (m) => m.content)) === PUBLISH_URL);
  check('landing: the favicon is declared and loads', (await (await page.request.get(`${BASE}assets/favicon.png`)).status()) === 200 && (await page.getAttribute('link[rel=icon]', 'href')) === 'assets/favicon.png');
  check('landing: a bug button is on the body', (await page.locator('body > #bug-button').count()) === 1);
  await shot(page, 'landing-1280');
  await page.click('[data-action=open-rules]');
  check('landing: the How to play dialog opens, with no rule book link in it', (await page.locator('.dialog').count()) === 1 && /Climb row|Climb cards/.test(await page.textContent('.dialog')) && (await page.locator('.dialog a').count()) === 0);
  await page.keyboard.press('Escape');
  check('landing: Escape closes the dialog', (await page.locator('.dialog').count()) === 0);
  await page.close();
}

/** Checks of the whole table that hold on every screen of a game: the banner, the rows, no v5 words. */
async function tableChecks(page, label, n, half) {
  const t = await page.evaluate(() => ({
    banner: (document.querySelector('.phasebar') || {}).textContent || '',
    cls: (document.querySelector('.phasebar') || { className: '' }).className,
    badge: !!document.querySelector('.phasebar .phasebar__badge'),
    climbSlots: document.querySelectorAll('.row--climb .rslot').length, brumbySlots: document.querySelectorAll('.row--brumby .rslot').length,
    ride: document.querySelectorAll('.ride__step').length, summitMark: !!document.querySelector('.ride__summit'),
    body: document.body.innerText,
    seats: [...document.querySelectorAll('.seat')].map((e) => ({ score: (e.querySelector('[data-hand-score]') || {}).textContent, taken: e.querySelectorAll('.taken').length })),
  }));
  const climb = half === 'climb';
  check(`${label}: the banner names the half, its direction and its trumps (${climb ? 'THE CLIMB, highest wins, Escape' : 'THE DESCENT, lowest wins, Home'}) with a badge`,
    new RegExp(climb ? 'The climb[\\s\\S]*highest wins[\\s\\S]*Escape is trumps' : 'The descent[\\s\\S]*lowest wins[\\s\\S]*Home is trumps', 'i').test(t.banner) && t.cls.includes(`phasebar--${half}`) && t.badge, t.banner);
  check(`${label}: the ride shows 12 steps and the summit mark`, t.ride === 12 && t.summitMark);
  check(`${label}: six Climb row slots and six Brumby row slots`, t.climbSlots === 6 && t.brumbySlots === 6, `${t.climbSlots}/${t.brumbySlots}`);
  check(`${label}: every seat leads with a hand score and shows two lots of taken cards`, t.seats.length === n && t.seats.every((x) => /^[+-]?\d+$/.test(x.score || '') && x.taken === 2), JSON.stringify(t.seats));
  check(`${label}: no v5 words on screen (Chase, Watch, Mountain, turning the hand)`, !V5.test(t.body), t.body.match(V5) && t.body.match(V5)[0]);
}

// ---------- human v Easy, 4 players ----------
if (want('human4')) {
  const page = await newPage();
  await setup(page, { names: ['Mia'] });
  await page.waitForSelector('.hand .card.is-legal');
  check('4p: four seats round the table', (await page.locator('.seat').count()) === 4 && (await page.locator('.pile, .schip, .mountain').count()) === 0);
  check('4p: twelve cards in the hand, sorted by suit', (await page.locator('.hand .card').count()) === 12);
  await tableChecks(page, '4p start', 4, 'climb');
  check('4p: the Climb row is face up with five +1 cards and one -1, the first lit', (await page.locator('.row--climb .rslot__val--pos').count()) === 5 && (await page.locator('.row--climb .rslot__val--neg').count()) === 1 && (await page.locator('.row--climb .rslot.is-next').count()) === 1);
  check('4p: the Brumby row is six face-down cards, the deck holds 12', (await page.locator('.rslot--down').count()) === 6 && /Deck\s*12/.test(await page.textContent('.row__piles')));
  check('4p: the trick panel says what the trick takes', /takes\s*[+-]1/.test(await page.textContent('.trick__title')));
  {
    const counts = await page.$$eval('.seat', (els) => els.map((e) => e.querySelector('.seat__cardsnum') && e.querySelector('.seat__cardsnum').textContent));
    check('4p: every seat shows its cards in hand as a number (12 each at the start), and your own matches the hand', counts.length === 4 && counts.every((t) => t === '12') && Number(await page.textContent('.area-me .seat__cardsnum')) === (await page.locator('.hand .card').count()));
  }
  await imagesSettled(page, '.hand .cardimg, .row--climb img');
  {
    const faces = await page.$$eval('.hand .card', (els) => els.map((e) => ({ id: e.dataset.card, asset: e.querySelector('img') && e.querySelector('img').dataset.asset, src: e.querySelector('img') && e.querySelector('img').getAttribute('src'), ok: e.querySelector('img') && e.querySelector('img').complete && e.querySelector('img').naturalWidth > 0, turned: e.querySelector('img') && e.querySelector('img').classList.contains('is-turned') })));
    check('4p: every card in the hand shows its own face (card-<suit>-<n>), loaded, upright', faces.length === 12 && faces.every((f) => f.asset === `card-${f.id}` && f.src === `assets/cards/card-${f.id}.webp` && f.ok && !f.turned), JSON.stringify(faces.filter((f) => !(f.asset === `card-${f.id}` && f.ok)).slice(0, 2)));
    const climbImgs = await page.$$eval('.row--climb .rslot__img', (els) => els.map((e) => e.complete && e.naturalWidth > 0 && /climb-(plus|minus)1/.test(e.dataset.asset)));
    check('4p: the six Climb cards show their art', climbImgs.length === 6 && climbImgs.every(Boolean));
  }
  await shot(page, 'start-1280');
  await page.locator('.hand .card.is-legal').first().click();
  await page.waitForFunction(() => document.querySelector('.area-me .seat__cardsnum').textContent === '11', null, { timeout: 8000 }).catch(() => {});
  check('4p: playing a card lowers your cards-in-hand number', (await page.textContent('.area-me .seat__cardsnum')) === '11');
  const s = await playHuman(page);
  check('4p: human plays and the game ends', s.plays >= 8 && (await page.locator('.end--game').count()) === 1, JSON.stringify(s));
  check('4p: every hand end showed the reckoning (4 hands)', s.summaries >= 3, `${s.summaries}`);
  check('4p: illegal cards explain themselves (tooltip equals the note)', s.illegalTried > 0 && s.tooltipMatches === s.illegalTried, `${s.tooltipMatches}/${s.illegalTried}`);
  check('4p: legal cards carry a would-win hint', s.hints > 3);
  check('4p: end screen ranks everyone with seat badges and a winner', (await page.locator('.ranking .rank').count()) === 4 && (await page.locator('.ranking .badge').count()) === 4 && (await page.locator('.rank.is-winner').count()) >= 1);
  check('4p: the typed name is used', /Mia/.test(await page.textContent('.ranking')));
  check('4p: the log has trick lines and Climb / Brumby card lines', (await page.locator('.log__item--trick').count()) > 15 && /takes (Climb card|Brumby|Colt|Flint|Wombat)/.test(await page.textContent('#log')), `${await page.locator('.log__item--trick').count()}`);
  await shot(page, 'end-1280');
  check('4p: no horizontal scroll at the end', (await overflow(page)) <= 0);
  await page.click('.end--game [data-action=again]');
  await page.waitForSelector('.hand .card.is-legal');
  check('play again starts a new game with the same setup', (await page.locator('.seat').count()) === 4 && (await page.locator('.log__item--trick').count()) === 0);
  await page.close();
}

// ---------- every registered level at 2, 3, 4 and 5 players ----------
for (const level of levels.filter((l) => ['easy', 'medium', 'hard'].includes(l) && want(`levels-${l}`))) {
  for (const n of [2, 3, 4, 5]) {
    const page = await newPage();
    await setup(page, { players: n, types: ['human', level, level, level, level], q: 'seed=21' });
    await page.waitForSelector('.hand .card.is-legal', { timeout: 30000 });
    if (n === 5) check(`5p v ${level}: the Muster suit is dealt (violet cards in the hand or on the table)`, (await page.locator('[data-asset^="card-muster-"], .hand .card--muster').count()) >= 0 && (await page.locator('.hand .card').count()) === 12);
    const s = await playHuman(page);
    check(`${n}p v ${level}: the game ends with a ranking of ${n}`, (await page.locator('.end--game').count()) === 1 && (await page.locator('.rank').count()) === n, JSON.stringify(s));
    check(`${n}p v ${level}: the human played cards`, s.plays >= 6, JSON.stringify(s));
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
  const p5 = await newPage();
  await setup(p5, { players: 5, types: ['easy', 'easy', 'hard', 'medium', 'easy'], q: 'seed=8' });
  await p5.waitForSelector('.end--game', { timeout: 150000 });
  check('bot v bot: five bots finish by themselves with a ranking of five', (await p5.locator('.rank').count()) === 5);
  await p5.close();
  const p2 = await newPage(1280, 900, {}, () => { delete window.Worker; });
  await setup(p2, { players: 3, types: ['easy', 'easy', 'easy'], q: 'seed=4' });
  await p2.waitForSelector('.end--game', { timeout: 120000 });
  check('no Worker: falls back to synchronous bots and still finishes', (await p2.evaluate(() => document.body.dataset.botMode)) === 'sync');
  await p2.close();
}

// ---------- pass and play: the cover hides everything; the summit beat is public ----------
if (want('passplay')) {
  const page = await newPage();
  await setup(page, { players: 3, types: ['human', 'human', 'easy'], names: ['Ann', 'Bo'], q: 'seed=5', delay: 120 });
  await page.waitForSelector('.cover', { timeout: 30000 });
  check('pass-and-play: a cover comes first and body is marked covered', (await page.getAttribute('body', 'data-covered')) === '1' && /Pass to (Ann|Bo)/.test(await page.textContent('.cover')) && !V5.test(await page.textContent('.cover')));
  check('pass-and-play: the bug button is hidden under the cover and Ctrl+Shift+B opens nothing', !(await page.isVisible('#bug-button')) && await (async () => { await page.keyboard.press('Control+Shift+B'); await page.waitForTimeout(150); return (await page.locator('.bug').count()) === 0; })());
  await page.evaluate(() => {
    window.__pp = { summits: 0, summitCovers: 0, leaks: 0 };
    const app = document.getElementById('app');
    new MutationObserver(() => {
      const P = window.__pp;
      const cover = app.querySelector('.cover');
      if (cover && app.querySelectorAll('.hand, .row, .rslot, .overlay, .seat, #log, .taken').length) P.leaks++;
      if (app.querySelector('.overlay--summit')) P.summits++;
      if (cover && /summit/i.test(cover.textContent)) P.summitCovers++;
    }).observe(app, { childList: true, subtree: true });
  });
  const s = newStats();
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) { if ((await humanStep(page, s)) === 'end') break; }
  const pp = await page.evaluate(() => window.__pp);
  check('pass-and-play: the game ends, with a cover before each human turn and no leak behind it', (await page.locator('.end--game').count()) === 1 && s.covers > 10 && s.coverLeaks === 0 && pp.leaks === 0, JSON.stringify([s, pp]));
  check('pass-and-play: the summit beat was shown to the table (it is not secret) and no cover talks about a summit choice', pp.summits > 0 && pp.summitCovers === 0, JSON.stringify(pp));
  await page.close();
}

// ---------- motion ----------
if (want('motion')) {
  const page = await newPage(1280, 900);
  await setup(page, { q: 'seed=11', delay: 800 });
  await page.waitForSelector('.hand .card.is-legal');
  check('motion: cards transition by default', parseFloat(await page.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) > 0);
  await page.close();
  const rm = await newPage(1280, 900, { reducedMotion: 'reduce' });
  await setup(rm, { q: 'seed=11', delay: 800 });
  await rm.waitForSelector('.hand .card.is-legal');
  check('motion: prefers-reduced-motion turns the transitions off', parseFloat(await rm.$eval('.card', (e) => getComputedStyle(e).transitionDuration)) === 0);
  check('motion: prefers-reduced-motion turns the animations off', await rm.evaluate(() => [...document.querySelectorAll('.rslot__card, .seat, .hscore')].every((e) => getComputedStyle(e).animationName === 'none')));
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
  for (const n of [2, 3, 4, 5]) {
    const page = await newPage(w, h, w < 700 ? { hasTouch: true, isMobile: true } : {});
    await page.goto(`${BASE}?seed=1`);
    await page.waitForSelector('#setup-form');
    if (n === 4) {
      check(`responsive ${w}px: landing has no horizontal scroll`, (await overflow(page)) <= 0);
      await shot(page, `landing-${w}`);
    }
    await setup(page, { players: n, types: ['human', 'medium', 'easy', 'easy', 'easy'], q: 'seed=9', delay: 150 });
    await page.waitForSelector('.hand .card.is-legal');
    check(`responsive ${w}px ${n}p: first screen has no horizontal scroll`, (await overflow(page)) <= 0);
    await shot(page, `climb-start-${n}p-${w}`);
    const stats = newStats();
    for (let i = 0; i < 30 && stats.plays < 6; i++) await humanStep(page, stats);
    const box = await page.$eval('.table', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.right]; });
    check(`responsive ${w}px ${n}p: mid-game has no horizontal scroll, table fits with gutters`, (await overflow(page)) <= 0 && box[0] >= 0 && box[1] <= w, JSON.stringify(box));
    const seatSizes = await page.evaluate(() => [...document.querySelectorAll('.seat, .row--climb, .row--brumby, .trick')].map((e) => { const r = e.getBoundingClientRect(); return { inside: r.left >= 0 && r.right <= window.innerWidth }; }));
    check(`responsive ${w}px ${n}p: every seat, both rows and the trick fit the screen`, seatSizes.length === n + 3 && seatSizes.every((x) => x.inside), JSON.stringify(seatSizes));
    await shot(page, `climb-mid-${n}p-${w}`);
    if ((w === 390 && (n === 4 || n === 2 || n === 5)) || (w === 1024 && n === 3) || (w === 1440 && (n === 2 || n === 5))) {
      // play on; catch the summit beat, the descent and the end of the hand
      let beat = false; let hand = false; let desc = false;
      const until = Date.now() + 120000;
      while (Date.now() < until && !(await page.locator('.end--game').count())) {
        if (!beat && await page.locator('.overlay--summit').count()) {
          beat = true;
          await imagesSettled(page, '.overlay--summit img');
          const m = await page.evaluate(() => { const e = document.querySelector('.overlay--summit .end'); const r = e.getBoundingClientRect(); return { fits: r.left >= 0 && r.right <= window.innerWidth, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, cards: document.querySelectorAll('.overlay--summit .summit__brumby').length, text: e.textContent }; });
          check(`responsive ${w}px ${n}p: the summit beat fits (no sideways scroll), shows the six Brumby cards and says lowest wins`, m.fits && m.over <= 0 && m.cards === 6 && /lowest card wins/.test(m.text) && !V5.test(m.text), JSON.stringify(m).slice(0, 200));
          await shot(page, `summit-${n}p-${w}`, false);
        }
        if (!desc && !(await page.locator('.overlay--summit').count()) && (await page.locator('.phasebar--descent').count()) && (await page.locator('.hand .card.is-legal').count())) {
          desc = true;
          await shot(page, `descent-${n}p-${w}`);
          await tableChecks(page, `responsive ${w}px ${n}p descent`, n, 'descent');
        }
        if (!hand && await page.locator('#continue').count()) {
          hand = true;
          await imagesSettled(page, '.reck img');
          const f = await page.evaluate(() => { const e = document.querySelector('.end--hand'); const r = e.getBoundingClientRect(); return { fits: r.left >= 0 && r.right <= window.innerWidth, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; });
          check(`responsive ${w}px ${n}p: the end-of-hand panel fits`, f.fits && f.over <= 0, JSON.stringify(f));
          await shot(page, `end-of-hand-${n}p-${w}`, false);
        }
        await humanStep(page, stats);
      }
      check(`responsive ${w}px ${n}p: the whole game plays and ends without sideways scroll`, beat && desc && hand && (await page.locator('.end--game').count()) === 1 && (await overflow(page)) <= 0, JSON.stringify({ beat, desc, hand }));
      await shot(page, `end-game-${n}p-${w}`);
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

// ---------- the whole hand on screen: banner, Climb row, summit beat, Brumby row, taken cards, reckoning (2 to 5 players) ----------
for (const n of [4, 2, 3, 5].filter(() => want('hand'))) {
  const page = await newPage();
  await setup(page, { players: n, types: ['human', 'easy', 'easy', 'easy', 'easy'], q: 'seed=11', delay: 120 });
  await page.waitForSelector('.hand .card.is-legal');
  await imagesSettled(page, '.hand .cardimg, .seat__avatar, .rslot__img');
  const loaded = await page.$$eval('.hand .cardimg, .seat__avatar, .rslot__img', (els) => els.map((e) => e.complete && e.naturalWidth > 0));
  check(`${n}p art: the avatars, the Climb row, the face-down Brumby row and every hand card face loaded`, loaded.length >= 20 && loaded.every(Boolean), `${loaded.length} images`);
  await page.evaluate(() => {
    window.__seen = { phases: [], summit: 0, summitText: '', climbTaken: 0, climbNextMoves: [], brumbyTakenMax: 0, nextLit: 0, takenSeatCards: 0, scoreMax: -99, scoreMin: 99, discardMax: 0, rideDone: 0, trumpLines: [], handResorted: false, noTurned: true };
    const app = document.getElementById('app');
    const look = () => {
      const q = (x) => app.querySelectorAll(x).length;
      const S = window.__seen;
      const ph = app.querySelector('.phasebar'); if (ph) { const k = ph.className.replace('phasebar phasebar--', ''); if (!S.phases.includes(k)) S.phases.push(k); const t = ((ph.querySelector('.phasebar__rule') || {}).textContent || '') + '|' + ((ph.querySelector('.phasebar__range') || {}).textContent || '').slice(0, 14); if (S.trumpLines[S.trumpLines.length - 1] !== t) S.trumpLines.push(t); }
      const sm = app.querySelector('.overlay--summit'); if (sm) { S.summit++; S.summitText = sm.textContent; }
      S.climbTaken = Math.max(S.climbTaken, q('.row--climb .rslot.is-taken'));
      const nx = app.querySelector('.row--climb .rslot.is-next'); if (nx) { const p = Number(nx.dataset.pos); if (S.climbNextMoves[S.climbNextMoves.length - 1] !== p) S.climbNextMoves.push(p); }
      S.brumbyTakenMax = Math.max(S.brumbyTakenMax, q('.row--brumby .rslot.is-taken'));
      S.nextLit = Math.max(S.nextLit, q('.row--brumby .rslot.is-next'));
      S.takenSeatCards = Math.max(S.takenSeatCards, q('.seat .taken__card'));
      app.querySelectorAll('[data-hand-score]').forEach((e) => { const v = Number(e.textContent); S.scoreMax = Math.max(S.scoreMax, v); S.scoreMin = Math.min(S.scoreMin, v); });
      S.discardMax = Math.max(S.discardMax, Number((app.querySelector('.row__discard summary b, .row__piles .row__pile:last-child b') || {}).textContent || 0));
      S.rideDone = Math.max(S.rideDone, q('.ride__step.is-done'));
      if (q('.is-turned, .hand--turned')) S.noTurned = false;
    };
    new MutationObserver(look).observe(app, { childList: true, subtree: true });
  });
  const stats = newStats();
  let reck = null; let sumShot = false; let descCheck = false;
  const deadline = Date.now() + 170000;
  while (Date.now() < deadline) {
    if (!sumShot && (await page.locator('.overlay--summit').count())) { sumShot = true; await shot(page, `summit-${n}p-1280`, false); }
    if (!descCheck && !(await page.locator('.overlay--summit').count()) && (await page.locator('.phasebar--descent').count()) && (await page.locator('.hand .card.is-legal').count())) { descCheck = true; await tableChecks(page, `${n}p descent`, n, 'descent'); }
    if (!reck && (await page.locator('#continue').count())) {
      await imagesSettled(page, '.reck img');
      reck = await page.evaluate(() => ({ rows: document.querySelectorAll('.reck__row').length, text: document.querySelector('.end--hand').textContent, faces: [...document.querySelectorAll('.reck img')].every((e) => e.complete && e.naturalWidth > 0) }));
      await shot(page, `reckoning-${n}p`, false);
    }
    if ((await humanStep(page, stats)) === 'end') break;
  }
  const seen = await page.evaluate(() => window.__seen);
  check(`${n}p banner: the climb then the descent banner were shown, with highest wins then lowest wins`, JSON.stringify(seen.phases.slice(0, 2)) === '["climb","descent"]' && seen.trumpLines.some((t) => /HIGHEST WINS|highest wins/i.test(t) && /Escape/.test(t)) && seen.trumpLines.some((t) => /lowest wins/i.test(t) && /Home/.test(t)), JSON.stringify(seen.trumpLines.slice(0, 4)));
  check(`${n}p summit: the summit beat was shown with Escape was trumps / Home is trumps, lowest wins and the six-card row`, seen.summit > 0 && /Over the top/.test(seen.summitText) && /Escape/.test(seen.summitText) && /Home/.test(seen.summitText) && /lowest/.test(seen.summitText), seen.summitText.slice(0, 160));
  check(`${n}p Climb row: all six cards were taken and the lit card moved on one at a time`, seen.climbTaken === 6 && [1, 2, 3, 4, 5, 6].every((p) => seen.climbNextMoves.includes(p)), JSON.stringify(seen.climbNextMoves.slice(0, 8)));
  check(`${n}p Brumby row: the next card was lit, all six were taken, the discard grew`, seen.nextLit >= 1 && seen.brumbyTakenMax === 6 && seen.discardMax >= 1, JSON.stringify([seen.nextLit, seen.brumbyTakenMax, seen.discardMax]));
  check(`${n}p taken cards: seats showed the cards they took and a changing hand score`, seen.takenSeatCards >= 2 && seen.scoreMax > 0 && seen.rideDone >= 11, JSON.stringify([seen.takenSeatCards, seen.scoreMax, seen.scoreMin, seen.rideDone]));
  check(`${n}p hand: cards were never turned`, seen.noTurned);
  check(`${n}p reckoning: a row per seat with Climb cards, Brumby cards and the score, no Chase / Watch`, !!reck && reck.rows === n && reck.faces && /Total/.test(reck.text) && /Climb cards/.test(reck.text) && /Brumby cards/.test(reck.text) && !V5.test(reck.text), JSON.stringify(reck && { rows: reck.rows }));
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
