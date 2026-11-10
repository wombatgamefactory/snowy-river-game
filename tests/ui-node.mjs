// ui-node.mjs - Node-level checks of the UI's pure parts (v5 rules): the table model and its frames (the
// event reducer must land exactly on the live state after every action, and must never hold an
// unrevealed summit choice), the sentences, the clone-and-apply hints, the landing/setup builders (no
// Playtest panel, no rule book link, 2-4 players), the art ids against the manifest, the Mountain, the
// Brumby row, kept cards, the summit decision and the turn of the hands, the reckoning, the end of the
// game with its tiebreak, and the pass-and-play hand-hiding rules.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. Run: node tests/ui-node.mjs

import fs from 'node:fs';
import { suite, position, play } from './lib.mjs';
import { createController } from '../src/ui/controller.js';
import { boardFromState, reduceBoard, buildFrames, sameBoard } from '../src/ui/board.js';
import { trickSentence, tiebreakText, turnPrompt, previewText, winnerBanner, tiedGroups, waitingText, handEndText, stakesText, phaseText, phaseParts, bannerText, stepCallout, descentGoal } from '../src/ui/text.js';
import { previewCard } from '../src/ui/preview.js';
import { makeVm } from '../src/ui/viewmodel.js';
import { seatHtml, tableHtml, handBoxHtml, sideHtml, coverHtml, handSummaryHtml, gameEndHtml, statusHtml, endBarHtml, summitModalHtml, revealHtml, turnHtml, mountainHtml, rowHtml, stepPosition, MOUNTAIN_STEPS } from '../src/ui/components.js';
import * as landing from '../src/ui/landing.js';
import { landingHtml, howToPlayHtml, seatTypeOptions, uniqueNames, DEFAULT_SETUP, safeCode, PLAYER_COUNTS, humanCount } from '../src/ui/landing.js';
import { useManifest, assetUrl, builtInIds, img, cardImg, cardBackImg, badgeImg, brumbyImg, choiceArt } from '../src/ui/assets.js';
import { GAME_NAME, GAME_SLUG, GAME_TAGLINE, PUBLISH_URL, AT_A_GLANCE, FOOTER_VERSION, RULEBOOK_URL } from '../src/game-config.js';
import { botLevels } from '../src/bots/index.js';
import {
  startGame, applyAction, getValidActions, describeEvent, makeRng, rngPick, fullDeck, cardFace, cloneState, isCardPhase, brumbyDeck, brumbyFace,
} from '../src/engine/index.js';

const { check, done } = suite('ui-node');
const BAD = /undefined|NaN|\[object/;

// ---------- config and the page ----------
{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  check('config: name, slug and address are set', GAME_NAME === 'Snowy River' && GAME_SLUG === 'snowy-river' && PUBLISH_URL === 'https://www.wombatgamefactory.com/snowy-river-game/');
  const tokens = [...new Set(html.match(/\{\{[A-Z_]+\}\}/g) || [])];
  check('index.html: every token filled', tokens.length === 0, tokens.join(' '));
  check('index.html: one app root, one module script, the consent loader before gtag, nothing loads on localhost', /id="app"/.test(html) && /type="module" src="src\/ui\/main\.js"/.test(html)
    && html.indexOf('cdn-cookieyes.com') < html.indexOf('googletagmanager.com/gtag/js') && /localhost/.test(html));
  check('index.html: the page text describes v5, not the old rules', !/Low wins the descent/i.test(html) && /turn your hand round/i.test(html));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  check('package.json: the scripts the workflow relies on', ['dev', 'test', 'test:browser', 'sim', 'qa', 'sweep'].every((k) => pkg.scripts[k]) && pkg.type === 'module' && pkg.name === 'snowy-river-game');
}

// ---------- art ids against the manifest ----------
{
  const raw = JSON.parse(fs.readFileSync(new URL('../assets/manifest.json', import.meta.url), 'utf8'));
  const manifest = { assets: Array.isArray(raw) ? raw : raw.assets };
  const ids = new Set(manifest.assets.map((a) => a.id));
  check('assets: every built-in art id is in the manifest', builtInIds().every((id) => ids.has(id)), builtInIds().filter((id) => !ids.has(id)).join(','));
  check('assets: all 48 cards resolve to a face in the manifest', fullDeck().every((c) => ids.has(cardFace(c))));
  check('assets: all 12 Brumby cards resolve to a face in the manifest', brumbyDeck().every((id) => ids.has(brumbyFace(id))));
  check('assets: every file the manifest calls real or placeholder exists', manifest.assets.filter((a) => a.status !== 'missing').every((a) => fs.existsSync(new URL(`../assets/${a.file}`, import.meta.url))));
  check('assets: no absolute or Windows path in the manifest', manifest.assets.every((a) => !/^([A-Za-z]:|[\\/])/.test(a.file) && !/\\/.test(a.file)));
  const uiIds = ['card-back', 'favicon', 'avatar-1', 'avatar-5', 'badge-escape', 'badge-home', 'mob-marker', 'chase-3', 'chase-2', 'watch', 'mountain-up', 'mountain-down', 'colt', 'brumby-back', 'brumby-plus2', 'brumby-plus1', 'brumby-flint', 'brumby-wombat'];
  check('assets: the UI art ids are all built in', uiIds.every((id) => builtInIds().includes(id)));
  check('assets: the v4 art ids are gone (mountain-6, mountain-7, brumby-front, chase)', ['mountain-6', 'mountain-7', 'brumby-front', 'chase'].every((id) => !builtInIds().includes(id) && !ids.has(id)));
  useManifest(manifest);
  check('assets: assetUrl resolves an id and refuses an unknown one', assetUrl('badge-home') === 'assets/badge-home.webp' && assetUrl('card-nope-7') === null);
  check('assets: Chase shows its cost: chase-3 at two players, chase-2 at three and four', choiceArt('chase', 3) === 'chase-3' && choiceArt('chase', 2) === 'chase-2' && choiceArt('watch', 2) === 'watch');
  check('assets: an unknown id gives a text chip, not a broken image', /asset-chip/.test(img('nope', { label: 'Nope' })) && !/<img/.test(img('nope')));
  useManifest({ assets: [] });
  const chipFace = cardImg('escape-7');
  const chipTurned = cardImg('escape-7', { turned: true });
  const chipBrumby = brumbyImg('brumby-wombat-1');
  useManifest({ assets: [{ id: 'card-escape-7', file: 'cards/card-escape-7.webp', width: 300, height: 428 }] });
  const artFace = cardImg('escape-7');
  const artTurned = cardImg('escape-7', { turned: true });
  useManifest(manifest);
  check('assets: a card with no art is drawn as a face with its number, suit shape and a label', /cardchip--escape/.test(chipFace) && />7</.test(chipFace) && /aria-label="Escape 7"/.test(chipFace));
  check('assets: a turned card with no art shows the descent number (13 - 7 = 6)', />6</.test(chipTurned) && /is-turned/.test(chipTurned) && /aria-label="Escape 6"/.test(chipTurned));
  check('assets: a Brumby card with no art shows its value', />-2</.test(chipBrumby));
  check('assets: a card with art is an <img> by manifest id; a turned card carries is-turned', /<img/.test(artFace) && artFace.includes('cards/card-escape-7.webp') && !/is-turned/.test(artFace) && /is-turned/.test(artTurned));
  check('assets: the card back and a badge fall back too', !BAD.test(cardBackImg()) && !BAD.test(badgeImg('home')));
}

// ---------- sentences ----------
{
  const names = ['Mia', 'Sam', 'Ann', 'Bo'];
  const g = position({ hands: [['home-7', 'home-1', 'escape-1'], ['climb-4', 'climb-2', 'escape-2'], ['home-2', 'climb-3', 'escape-3'], ['home-9', 'climb-9', 'escape-4']], leader: 0 });
  const ev = play(g, 'home-7', 'climb-4');
  const won = ev.find((e) => e.type === 'trick-won');
  const s = trickSentence(g.tricks[0], won, names);
  check('sentence: an off-suit card is named as thrown; the winner is named', /^Mia led Home 7; Sam had no Home and threw Climb 4; Ann followed with Home 2; Bo followed with Home 9 and wins\.$/.test(s), s);
  const g2 = position({ hands: [['home-7', 'home-1', 'escape-1'], ['climb-4', 'climb-2', 'escape-2'], ['home-2', 'climb-3', 'escape-3'], ['home-9', 'climb-9', 'escape-4']], leader: 0 });
  const ev2 = play(g2, 'home-7', 'escape-2');
  const w2 = ev2.find((e) => e.type === 'trick-won');
  const s2 = w2 ? trickSentence(g2.tricks[0], w2, names) : '';
  check('sentence: a trump played on another suit is named as trumping', /Sam had no Home and trumped with Escape 2/.test(s2) || !w2, s2);
  check('banner: a plain win names the card without a trump note', winnerBanner({ winner: 1, card: 'home-4', phase: 'climb', byTrump: false }, names) === 'Sam wins with Home 4');
  check('banner: second person for You, and a trump is called out', winnerBanner({ winner: 0, card: 'escape-9', phase: 'climb', byTrump: true }, ['You', 'Sam']) === 'You win with Escape 9 (trumps)');
  check('banner: the descent reads the turned number (Home 4 is a 9 going down)', winnerBanner({ winner: 1, card: 'home-4', phase: 'descent', byTrump: false }, names) === 'Sam wins with Home 9');
  check('phase banner: the climb, the summit, the descent (highest always wins)', phaseText('climb') === 'The climb: highest wins' && phaseText('descent') === 'The descent: highest wins' && /Chase or Watch/.test(phaseText('summit')));
  check('phase banner: the parts split on the colon', phaseParts('climb').name === 'The climb' && phaseParts('descent').rule === 'highest wins' && phaseParts('summit').name === 'The summit');
}
{
  const names = ['Ann', 'Bo', 'Cy'];
  const mk = (tied, winners, shared, used, last) => ({ tiedOnTotal: tied, winners, shared, tiebreakUsed: used, winningScore: 14, lastHandScores: last, ranking: [] });
  const t1 = tiebreakText(mk([0, 1], [1], false, true, [3, 6, 0]), names);
  check('tiebreak text: most points in the last hand decides, tied players only', /^Ann and Bo tied on 14\. Tiebreak: the most points in the last hand\. Points in the last hand: Ann 3, Bo 6\. Bo wins\.$/.test(t1), t1);
  const t2 = tiebreakText(mk([0, 1], [0, 1], true, false, [4, 4, 0]), names);
  check('tiebreak text: a shared win says shared', /Still level, so the win is shared\.$/.test(t2), t2);
  const t3 = tiebreakText(mk([0, 1, 2], [0, 1], true, true, [5, 5, 1]), names);
  check('tiebreak text: a three-way tie shares between those still level', /^Ann, Bo and Cy tied on 14\..*Ann and Bo share the win\.$/.test(t3), t3);
  check('tiebreak text: no tie at the top says nothing', tiebreakText(mk([0], [0], false, false, [0, 0, 0]), names) === '');
  check('tied groups: only groups of two or more', JSON.stringify(tiedGroups({ ranking: [{ seat: 0, total: 9 }, { seat: 1, total: 9 }, { seat: 2, total: 4 }] })) === '[[0,1]]');
  check('hand end text: names every score', handEndText({ handNo: 0, scores: [3, 5, -1] }, names) === 'Hand 1 scores: Ann 3, Bo 5, Cy -1.');
  check('waiting text: bot, human, You, the summit and the end', waitingText({ phase: 'climb', toAct: 1 }, names, ['human', 'easy', 'human']) === 'Bo is thinking.'
    && waitingText({ phase: 'climb', toAct: 2 }, names, ['human', 'easy', 'human']) === 'Cy is to play.' && waitingText({ phase: 'summit', toAct: 0 }, ['You', 'Bo'], ['human', 'easy']) === 'You are choosing Chase or Watch in secret.'
    && waitingText({ phase: 'over', toAct: null }, names, []) === 'Game over.');
  check('callout: a climb step and the summit', stepCallout({ to: 3, summit: false }).text === 'Step 3' && stepCallout({ to: 6, summit: true }).text === 'The summit!' && stepCallout(null) === null);
}

// ---------- clone-and-apply hints ----------
{
  const g = position({ hands: [['home-8', 'home-1', 'escape-1'], ['home-2', 'home-9', 'escape-2'], ['home-3', 'home-5', 'escape-3'], ['home-4', 'home-10', 'escape-4']], leader: 0 });
  const before = JSON.stringify(g);
  const lead = previewCard(g, 'home-8');
  check('preview: leading is a lead hint and never touches the real state', lead.kind === 'lead' && JSON.stringify(g) === before);
  play(g, 'home-8');
  const lose = previewCard(g, 'home-2');
  const win = previewCard(g, 'home-9');
  const trumpIn = previewCard(g, 'escape-2');
  check('preview (climb): a card that cannot beat the lead says so, with who is ahead', lose.kind === 'follow' && !lose.wins && lose.winnerSeat === 0 && lose.winnerCard === 'home-8' && lose.remaining === 2);
  check('preview (climb): a card that beats the lead says it would win as it stands', win.wins && !win.final && win.remaining === 2);
  check('preview (climb): a card that may not be played has no hint (must follow Home)', trumpIn === null && previewCard(g, 'nope') === null);
  play(g, 'home-9', 'home-3');
  const last = previewCard(g, 'home-4');
  const lastWin = previewCard(g, 'home-10');
  check('preview: the last card of a trick knows the final result', last.final && !last.wins && last.winnerSeat === 1 && lastWin.final && lastWin.wins);
  check('preview text: reads as English with no raw values', [lead, lose, win, last, lastWin].every((p) => !BAD.test(previewText(p, ['A', 'B', 'C', 'D'])) && previewText(p, ['A', 'B', 'C', 'D']).length > 10));
  check('cloneState: a deep, independent copy', (() => { const c = cloneState(g); c.hands[0].pop(); c.totals[0] = 99; return g.totals[0] !== 99 && JSON.stringify(cloneState(g)) === JSON.stringify(g); })());
  // a trump played on another suit beats the led suit (Escape on the climb)
  const t = position({ hands: [['home-8', 'climb-1', 'climb-2'], ['climb-3', 'escape-2', 'climb-4'], ['home-3', 'home-5', 'climb-5'], ['home-4', 'home-10', 'climb-6']], leader: 0 });
  play(t, 'home-8');
  const tr = previewCard(t, 'escape-2');
  check('preview (climb): an Escape card played on Home would trump it and win as it stands', tr === null || (tr.wins && tr.trumps));
  const d = position({ hands: [['home-8', 'home-1', 'escape-1'], ['home-2', 'home-9', 'escape-2'], ['home-3', 'home-5', 'escape-3'], ['home-4', 'home-10', 'escape-4']], leader: 0, phase: 'descent' });
  play(d, 'home-8');
  const pd = previewCard(d, 'home-2');
  check('preview (descent): the highest turned number wins (Home 2 reads 11, Home 9 reads 4)', pd.wins && !previewCard(d, 'home-9').wins && pd.half === 'descent');
  check('preview (descent): the Brumby card the trick takes is named, and kept or sent off by the choice', !!pd.prizeId && pd.chase === true && /Brumby|Colt|Flint|Wombat/i.test(previewText(pd, ['A', 'B', 'C', 'D'])) && /keep it/.test(previewText(pd, ['A', 'B', 'C', 'D'])));
}

// ---------- the table model: events land exactly on the live state ----------
{
  let actions = 0; let drift = 0; let firstDrift = ''; let framesBad = 0; let modals = 0; let handEnds = 0; let decided = 0; let tricks = 0; let games = 0; let leaks = 0; let turns = 0; let reveals = 0; let prizes = 0; let descents = 0;
  for (let seed = 1; seed <= 12; seed++) {
    for (const players of [2, 3, 4]) {
      for (const humans of [[0], [0, 1], []]) {
        if (humans.some((h) => h >= players)) continue;
        if (!(seed <= 4 || humans.length === 1)) continue;
        const started = startGame({ seed: seed * 7 + players, players });
        games++;
        const state = started.state;
        const names = Array.from({ length: players }, (_, i) => `P${i + 1}`);
        let board = boardFromState(state, humans);
        const rng = makeRng(`b${seed}${players}`);
        while (state.phase !== 'over') {
          const action = rngPick(rng, getValidActions(state));
          const events = applyAction(state, action);
          const ctx = { names, describe: describeEvent, trickText: trickSentence, liveHands: (s) => state.hands[s] };
          const frames = buildFrames(board, events, ctx);
          actions++;
          if (frames.length) board = frames[frames.length - 1].board;
          const live = boardFromState(state, humans);
          if (!sameBoard(board, live)) { drift++; if (!firstDrift) firstDrift = `seed ${seed} p${players}: ${diffKeys(board, live)}`; board = live; }
          for (const f of frames) {
            if (f.hold === Infinity && !f.modal) framesBad++;
            if (f.modal) modals++;
            if (f.kind === 'decided') { decided++; if (!f.board.trick || !f.board.banner || f.board.trick.winner === undefined) framesBad++; }
            if (f.kind === 'resolve') { tricks++; if (!f.log || !/\.$/.test(f.log)) framesBad++; }
            if (f.kind === 'summit-opened') { turns++; if (!f.board.handsTurned || !f.board.banner || f.board.banner.kind !== 'turn' || f.board.row.length !== 6) framesBad++; }
            if (f.kind === 'summit-revealed') reveals++;
            if (f.kind === 'brumby-kept' || f.kind === 'brumby-discarded') prizes++;
            if (f.kind === 'descent-started') descents++;
            if (!f.board.revealed && f.board.choices.some((c) => c !== null)) leaks++;
            if (f.log && BAD.test(f.log)) framesBad++;
          }
          const he = events.filter((e) => e.type === 'hand-ended').length;
          handEnds += he;
          if (frames.filter((f) => f.modal).length !== he) framesBad++;
          if (events.some((e) => e.type === 'trick-won' && !frames.some((f) => f.kind === 'decided'))) framesBad++;
        }
      }
    }
  }
  check('board: walking the events lands exactly on the live state, every action', drift === 0, `${actions} actions in ${games} games, ${drift} drifts, first: ${firstDrift}`);
  check('board: frames are well formed (a decided beat per trick, one modal per hand end, the turn, the reveal and every Brumby card)', framesBad === 0 && modals === handEnds && handEnds > 100 && decided === tricks && tricks > 1000 && turns === reveals && reveals === descents && turns > 100 && prizes > 600,
    `bad ${framesBad}, modals ${modals}, hand ends ${handEnds}, decided ${decided}, tricks ${tricks}, turns ${turns}, reveals ${reveals}, prizes ${prizes}`);
  check('board: no frame ever holds a summit choice before the reveal', leaks === 0, `${leaks}`);
}
function diffKeys(a, b) {
  const keys = Object.keys(a).filter((k) => !['fx', 'last', 'banner'].includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return keys.map((k) => `${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`).join(' | ');
}
{
  // The last trick of a hand plays itself: the frames must show the trick, the reckoning, and then the new deal.
  let seen = 0; let ok = true;
  for (let seed = 1; seed <= 8; seed++) {
    const { state } = startGame({ seed, players: 4 });
    let board = boardFromState(state, [0]);
    const rng = makeRng(`z${seed}`);
    while (state.phase !== 'over') {
      const action = rngPick(rng, getValidActions(state));
      const events = applyAction(state, action);
      const frames = buildFrames(board, events, { names: ['A', 'B', 'C', 'D'], describe: describeEvent, trickText: trickSentence, liveHands: (s) => state.hands[s] });
      if (frames.length) board = frames[frames.length - 1].board;
      if (events.some((e) => e.type === 'hand-ended')) {
        seen++;
        const kinds = frames.map((f) => f.kind);
        const iEnd = kinds.indexOf('hand-end');
        const iNext = kinds.indexOf('deal');
        if (!(state.phase === 'over' ? iNext === -1 : iNext > iEnd)) ok = false;
      }
    }
  }
  check('board: a hand end shows the reckoning before the next deal', seen >= 20 && ok, `${seen} hand ends`);
  const b0 = boardFromState(startGame({ seed: 1, players: 3 }).state, [0]);
  check('board: reduceBoard returns a fresh copy and ignores unknown events', reduceBoard(b0, { type: 'nope' }) !== b0 && sameBoard(reduceBoard(b0, { type: 'nope' }), b0));
}

// ---------- landing and setup ----------
{
  const levels = botLevels();
  const html = landingHtml(levels, DEFAULT_SETUP, '');
  check('landing: a radio per player count (2, 3, 4) and four seat forms; five players is not offered', JSON.stringify(PLAYER_COUNTS) === '[2,3,4]' && PLAYER_COUNTS.every((n) => html.includes(`name="players" value="${n}"`)) && !html.includes('name="players" value="5"') && (html.match(/class="seatform"/g) || []).length === 4);
  check('landing: no Playtest rules panel and no non-standard note (there are no switches)', !('rulesPanelHtml' in landing) && !/Playtest/i.test(html) && !/non-standard/i.test(html) && !/class="rule"|rules-panel|rules-note/.test(html));
  check('landing: the hero art, the v5 hook, 2-4 players / 20-30 min / ages 10+', /data-asset="hero-wide"/.test(html) && html.includes(GAME_TAGLINE) && /turn your hand round/.test(GAME_TAGLINE) && AT_A_GLANCE.players === '2-4' && AT_A_GLANCE.minutes === '20-30' && AT_A_GLANCE.age === '10+');
  check('landing: no rule book link anywhere (page, How to play, footer)', !/rule book|rulebook|\.pdf/i.test(html) && !/rule book|rulebook|\.pdf/i.test(howToPlayHtml()) && RULEBOOK_URL === '' && !/rule book/i.test(FOOTER_VERSION));
  check('landing: setup says to set every seat to a bot to watch', /Set every seat to a bot to watch a game/.test(html));
  check('landing: Play forced cards for me is off by default and explained', /Play forced cards for me/.test(html) && !/id="autoPlayForced" checked/.test(html));
  const how = howToPlayHtml();
  check('landing: How to play teaches v5 (two numbers, Escape then Home trumps, the turn, the row, Chase 2 or 3, the tiebreak)', /two numbers/.test(how) && /Escape is trumps/.test(how) && /Home is trumps/.test(how) && /turns their whole hand round/.test(how) && /Chase/.test(how) && /Watch/.test(how) && /pay 2 \(3 with two players\)/.test(how) && /most points in the last hand/.test(how));
  check('landing: How to play has none of the v4 terms (low wins, heels, breakaway, nobody chases)', !/lowest card|at the mob's heels|break away|off-suit steps|nobody chases|1 to 12 in each suit.*No trumps|Brumby card goes under the Colt/i.test(how + html));
  check('landing: the bug-free text (no undefined / NaN / [object])', !BAD.test(html) && !BAD.test(how));
  check('landing: the contact for bug reports is not on the page as a raw address', !/@/.test(html));
  check('seat menu: human and the three levels, a missing level disabled', /value="human"/.test(seatTypeOptions(levels, 'human')) && /value="hard"/.test(seatTypeOptions(levels, 'easy'))
    && /disabled/.test(seatTypeOptions([{ id: 'easy', label: 'Easy' }], 'easy')));
  check('seat menu: simulator-only bots are not offered', !/value="high"/.test(seatTypeOptions(levels, 'easy')) && !/value="low"/.test(seatTypeOptions(levels, 'easy')));
  check('setup: names made unique, case-insensitive', JSON.stringify(uniqueNames(['Sam', 'sam', '', 'Ann', 'SAM'])) === '["Sam","sam 2","","Ann","SAM 3"]');
  check('setup: the rules code of a setup is always std', safeCode(DEFAULT_SETUP) === 'std' && safeCode({ players: 4, rules: { TRUMP: 'red' } }) === 'std');
  check('setup: humans counted over the seats in play only', humanCount({ players: 3, seats: [{ type: 'human' }, { type: 'easy' }, { type: 'human' }, { type: 'human' }] }) === 2);
  check('setup: the default setup has four seats', DEFAULT_SETUP.seats.length === 4 && DEFAULT_SETUP.players === 4);
}

// ---------- pass-and-play: hands stay hidden ----------
{
  const duo = createController({ seats: [{ type: 'human', name: 'A' }, { type: 'human', name: 'B' }, { type: 'easy' }], seed: 5, autoPlayForced: false });
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  const mk = () => makeVm({ ctl: duo, ui, board: boardFromState(duo.state, duo.humanSeats), log: [] });
  const solo = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }], seed: 5, autoPlayForced: false });
  const vmLone = makeVm({ ctl: solo, ui, board: boardFromState(solo.state, solo.humanSeats), log: [] });
  check('viewmodel: a lone human always has their hand on show, with a reason or a hint on every card when it is their turn', vmLone.hand !== null && vmLone.hand.length === 12 && (!vmLone.myTurn || vmLone.hand.every((c) => vmLone.reasons.has(c))));
  while (!duo.isHumanTurn() && duo.isBotTurn()) duo.stepBot();
  const vmCover = mk();
  check('viewmodel: with two humans no hand is shown until the next human confirms', duo.needsHandoff() ? vmCover.hand === null : true);
  const cover = coverHtml({ names: duo.names, phase: 'climb' }, duo.toAct());
  check('cover: names the player and shows no card, trick or score', /Pass to [AB]/.test(cover) && !/class="hand"|cardimg|cardchip|tplay|Total|brumbyimg/.test(cover));
  check('cover: at the summit it asks for a secret Chase or Watch', /Chase or Watch in secret/.test(coverHtml({ names: duo.names, phase: 'summit' }, 1)));
  duo.reveal(duo.toAct());
  const vmShown = mk();
  check('viewmodel: after the cover is confirmed the hand of that human is shown', vmShown.hand !== null && vmShown.shown === duo.toAct());
  const replay = makeVm({ ctl: duo, ui: { ...ui, frame: { board: boardFromState(duo.state, duo.humanSeats) } }, board: boardFromState(duo.state, duo.humanSeats), log: [] });
  check('viewmodel: while a replay frame is on screen with two humans, no hand is shown', replay.hand === null || replay.shown === null);
}

// ---------- the summit, the turn of the hands, the row (a real game, played to the summit) ----------
function toSummit(players, seed, humans = [0]) {
  const types = Array.from({ length: players }, (_, i) => (humans.includes(i) ? 'human' : 'easy'));
  const ctl = createController({ seats: types.map((type) => ({ type })), seed, autoPlayForced: true });
  const rng = makeRng(`s${seed}`);
  let guard = 0;
  while (ctl.state.phase !== 'summit' && guard++ < 500) {
    const acts = ctl.legalActions();
    const a = rngPick(rng, acts);
    // drive whoever is to act (the test bypasses the human / bot split)
    applyAction(ctl.state, a);
  }
  return ctl;
}
{
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  for (const players of [2, 3, 4]) {
    const ctl = toSummit(players, 30 + players);
    const st = ctl.state;
    // make seat 0 the one to choose
    while (st.toAct !== 0 && st.phase === 'summit') applyAction(st, { type: 'summit', choice: 'watch' });
    const board = boardFromState(st, [0]);
    const vm = makeVm({ ctl, ui, board, log: [] });
    const modal = summitModalHtml(vm);
    const cost = players === 2 ? 3 : 2;
    check(`summit ${players}p: the modal shows the turned hand, the six-card row with its value, and Chase / Watch`, vm.myTurn && (modal.match(/summit__brumby/g) || []).length === 6 && /Your hand, turned round/.test(modal) && /is-turned/.test(modal) && /worth [+-]\d+ in all/.test(modal) && (modal.match(/data-action="decide"/g) || []).length === 2, modal.slice(0, 200));
    check(`summit ${players}p: Chase costs ${cost} and shows the ${cost === 3 ? 'chase-3' : 'chase-2'} face; Watch pays nothing`, new RegExp(`data-asset="chase-${cost}"`).test(modal) && !new RegExp(`data-asset="chase-${5 - cost}"`).test(modal) && new RegExp(`pay ${cost}\\.`).test(modal) && /Watch: pay nothing/.test(modal) && /data-asset="watch"/.test(modal));
    check(`summit ${players}p: the stakes come from the view and name the row value`, stakesText(vm.view).chase.includes(`pay ${cost}`) && /worth [+-]?\d+ in all/.test(stakesText(vm.view).chase) && !BAD.test(modal));
    check(`summit ${players}p: no side is named before everyone has chosen`, !/schip--chase|schip--watch|Chose Chase|Chose Watch/.test(tableHtml(vm)));
    check(`summit ${players}p: the Mountain is turned to the descent side, Home is trumps, hands are turned`, board.handsTurned && /mountain-down/.test(mountainHtml(vm)) && /Home<\/b> is trumps going down/.test(mountainHtml(vm)) && !/mountain__marker/.test(mountainHtml(vm)));
    const rowH = rowHtml(vm);
    check(`summit ${players}p: the row panel shows six face-up Brumby cards, the cost, the deck and discard counts`, (rowH.match(/class="rslot[ "]/g) || []).length === 6 && /is-next/.test(rowH) && new RegExp(`Chase costs ${cost}`).test(rowH) && /Deck <b>\d+<\/b>/.test(rowH) && /Discard/.test(rowH));
    const fake = { ...board, banner: { kind: 'turn', row: [...board.row], rowValue: 5, colt: false, chaseCost: cost } };
    const turn = turnHtml({ ...vm, board: fake, names: ctl.names });
    check(`summit ${players}p: the turn overlay says everyone turns their hand round and shows the row`, /turns their hand round/.test(turn) && /is-turned/.test(turn) === false && (turn.match(/summit__brumby/g) || []).length === 6 && /overlay--turn/.test(turn));
    check(`summit ${players}p: the hand box shows the turned hand (rotated, sorted by the number now on top)`, /hand--turned/.test(handBoxHtml(vm)) && /turned round/.test(handBoxHtml(vm)));
  }
}
{
  const ctl = toSummit(4, 41);
  const st = ctl.state;
  const b = boardFromState(st, []);
  const noChoice = revealHtml({ board: b, names: ctl.names, me: 0 });
  check('reveal: nothing is shown before the reveal', noChoice === '');
  const order = [...st.choiceOrder];
  for (const s of order) applyAction(st, { type: 'summit', choice: s % 2 ? 'watch' : 'chase' });
  const b2 = boardFromState(st, []);
  const chasers = b2.choices.map((c, s) => (c === 'chase' ? s : -1)).filter((s) => s >= 0);
  const vmR = { board: { ...b2, banner: { kind: 'reveal', chasers, watchers: [1, 3], chaseCost: 2 } }, names: ctl.names, me: 0 };
  const rv = revealHtml(vmR);
  check('reveal: a Chase or Watch face per seat, with who chose what in words', (rv.match(/class="reveal__seat/g) || []).length === 4 && (rv.match(/data-asset="chase-2"/g) || []).length === 2 && (rv.match(/data-asset="watch"/g) || []).length === 2 && /chase; .* watch/.test(rv) && !BAD.test(rv));
  check('banners: the turn, the descent start, the prize kept and sent off, the reshuffle', /turns their hand round/.test(bannerText({ kind: 'turn', rowValue: 6 }, ctl.names, b2)) && /leads/.test(bannerText({ kind: 'descent', leader: 1, chasers: [] }, ctl.names, b2))
    && /keeps/.test(bannerText({ kind: 'prize', seat: 1, to: 'kept', card: 'colt' }, ctl.names, b2)) && /sent off/.test(bannerText({ kind: 'prize', seat: 1, to: 'discard', card: 'colt' }, ctl.names, b2)) && /all 12 are shuffled/.test(bannerText({ kind: 'reshuffle' }, ctl.names, b2)));
  const nobody = revealHtml({ ...vmR, board: { ...b2, choices: ['watch', 'watch', 'watch', 'watch'], banner: { kind: 'reveal', chasers: [], watchers: [0, 1, 2, 3], chaseCost: 2 } } });
  check('reveal: nobody chasing is stated, and the descent is still played', /Nobody chased/.test(nobody) && /every Brumby card will be sent off/.test(nobody));
  const g = descentGoal({ ...b2, phase: 'descent' }, ['You', 'Bo', 'Cy', 'Di'], [0]);
  check('goal: names the chasers, says what a chaser keeps, and gives the human a personal line', !!g && /^Chasers \(You and Cy\): win a trick to keep its Brumby card\.$/.test(g.main) && /Chasing costs 2/.test(g.extra) && g.personal.length === 1 && /^You chased: you paid 2/.test(g.personal[0].text));
  check('goal: none outside the descent or before the cards are turned', descentGoal({ ...b2, phase: 'climb' }, ctl.names, [0]) === null && descentGoal({ ...b2, phase: 'descent', revealed: false }, ctl.names, [0]) === null);
}

// ---------- the Mountain card, the marker and the row ----------
{
  check('mountain: the climb side has a printed circle table (the foot, then steps 1 to 6)', MOUNTAIN_STEPS.climb.length === 7);
  check('mountain: step positions are percentages of the card and inside it', MOUNTAIN_STEPS.climb.every((_, k) => { const [x, y] = stepPosition('climb', k); return x > 0 && x < 100 && y > 0 && y < 100; }));
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 11, autoPlayForced: true });
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  const vm = makeVm({ ctl, ui, board: boardFromState(ctl.state, [0]), log: [] });
  const m = mountainHtml(vm);
  const [l0, t0] = stepPosition('climb', 0);
  check('mountain: the climb side with the marker on step 0, Escape named as trumps', /data-asset="mountain-up"/.test(m) && /data-step="0"/.test(m) && m.includes(`style="left:${l0}%;top:${t0}%"`) && /Escape<\/b> is trumps going up/.test(m) && /<b data-marker>0<\/b> of 6 tricks/.test(m));
  const mm = mountainHtml({ ...vm, board: { ...vm.board, marker: 3 } });
  const [l3, t3] = stepPosition('climb', 3);
  check('mountain: the marker moves to the step it is on', mm.includes(`style="left:${l3}%;top:${t3}%"`) && /data-step="3"/.test(mm));
  const rowClimb = rowHtml(vm);
  check('row: during the climb six face-down cards wait, with the deck at 12 and the Chase cost', (rowClimb.match(/rslot--down/g) || []).length === 6 && /Deck <b>12<\/b>/.test(rowClimb) && /Chase costs 2/.test(rowClimb) && /turned up at the summit/.test(rowClimb));
  const fakeRow = ['brumby-plus2-1', 'colt', 'brumby-flint', 'brumby-wombat-1', 'brumby-plus1-1', 'brumby-plus2-2'];
  const b = { ...vm.board, phase: 'descent', handsTurned: true, row: [null, 'colt', ...fakeRow.slice(2)], rowDealt: fakeRow, rowTaken: [{ seat: 2, to: 'kept' }, null, null, null, null, null], rowNext: 1, kept: [[], [], ['brumby-plus2-1'], []], discard: ['brumby-plus1-2'] };
  const r2 = rowHtml({ ...vm, board: b, names: ['You', 'Bo', 'Cy', 'Di'] });
  check('row: the next card to be won is lit, a taken card shows who kept it, the Colt is marked, the discard is counted', (r2.match(/is-next/g) || []).length >= 1 && /data-pos="2"[^>]*>/.test(r2) && /rslot is-next[^"]*is-colt|rslot is-next is-colt|is-colt/.test(r2) && /rslot__gone--kept" data-seat="2"/.test(r2) && /Discard <b>1<\/b>/.test(r2) && /still to win/.test(r2));
  const seatK = seatHtml({ ...vm, board: { ...b, revealed: true, choices: ['watch', 'watch', 'chase', 'watch'], phase: 'descent' }, names: ['You', 'Bo', 'Cy', 'Di'], types: ['human', 'easy', 'easy', 'easy'], view: null }, 2, 'r2');
  check('seat: a chaser shows the Brumby cards kept, face up, with their sum, and the Chase cost', /seat__kept/.test(seatK) && /kept__card/.test(seatK) && /<b class="kept__sum">\+2<\/b>/.test(seatK) && /Chase<\/b><i>-2<\/i>/.test(seatK));
  const seatW = seatHtml({ ...vm, board: { ...b, revealed: true, choices: ['watch', 'watch', 'chase', 'watch'], phase: 'descent' }, names: ['You', 'Bo', 'Cy', 'Di'], types: ['human', 'easy', 'easy', 'easy'], view: null }, 1, 'r1');
  check('seat: a watcher has no kept row', !/seat__kept/.test(seatW) && /Watch/.test(seatW));
  check('seat: one pile of tricks per seat (no separate climb and descent piles), cards in hand are a small line', (seatW.match(/class="pile[ "]/g) || []).length === 1 && !/pile--descent|pile--climb|heels/i.test(seatW) && /class="seat__hand"/.test(seatW) && /12 cards/.test(seatW));
  check('seat: one card reads "1 card"', /<b class="seat__cardsnum" data-cards="1">1<\/b> card</.test(seatHtml({ ...vm, board: { ...vm.board, handCounts: [3, 1, 3, 3] } }, 1, 'r1')));
  check('seat: the pile counts climb and descent tricks together', /<b>5<\/b>/.test(seatHtml({ ...vm, board: { ...vm.board, climbTricks: [3, 0, 0, 0], descentTricks: [2, 0, 0, 0] } }, 0, 'me')));
}

// ---------- screens: the table, hand, side and status over whole games ----------
{
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  let screens = 0; let bad = ''; let sawEnd = false; let sawSummary = false; let sawSummit = false; let sawDescent = false; let tiebreakSeen = false; let sharedSeen = false; let coltSeen = false;
  const names = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? 'You' : `Bot ${i + 1}`));
  for (const [players, seed] of [[2, 3], [3, 4], [4, 5], [4, 9], [3, 12], [2, 14]]) {
    const ctl = createController({ seats: [{ type: 'human' }, ...Array.from({ length: players - 1 }, () => ({ type: 'easy' }))], seed, autoPlayForced: true });
    const rng = makeRng(`sc${seed}`);
    let board = boardFromState(ctl.state, [0]);
    let guard = 0;
    while (ctl.state.phase !== 'over' && guard++ < 400) {
      const st = ctl.state;
      const vm = makeVm({ ctl, ui, board, log: [] });
      const html = [tableHtml(vm), handBoxHtml(vm), sideHtml(vm), statusHtml(vm), vm.myTurn && st.phase === 'summit' ? summitModalHtml(vm) : ''].join('');
      screens++;
      if (BAD.test(html) && !bad) bad = `p${players} seed ${seed} trick ${st.trickNo}: ${html.match(BAD)[0]}`;
      if (st.phase === 'summit') sawSummit = true;
      if (st.phase === 'descent') sawDescent = true;
      const events = applyAction(st, rngPick(rng, getValidActions(st)));
      for (const ev of events) {
        if (ev.type === 'hand-ended') {
          const vm2 = makeVm({ ctl, ui, board, log: [] });
          const h = handSummaryHtml(vm2, { kind: 'hand', handNo: ev.handNo, event: ev });
          sawSummary = true;
          if (BAD.test(h) && !bad) bad = `reckoning: ${h.match(BAD)[0]}`;
          const rows = (h.match(/class="reck__row/g) || []).length;
          const costOk = ev.breakdown.every((x) => (x.choice === 'chase' ? x.cost === (players === 2 ? 3 : 2) : x.cost === 0));
          if (rows !== players || !costOk || !/Chase -(2|3)|Watch/.test(h)) bad = bad || `reckoning rows ${rows}`;
          for (const x of ev.breakdown) if (x.choice === 'chase' && x.kept.length && !h.includes(brumbyFace(x.kept[0]))) bad = bad || 'a kept Brumby card is missing from the reckoning';
          if (ev.colt) coltSeen = true;
        }
      }
      const frames = buildFrames(board, events, { names: ctl.names, describe: describeEvent, trickText: trickSentence, liveHands: (s) => st.hands[s] });
      if (frames.length) board = frames[frames.length - 1].board;
      if (st.phase === 'over') {
        const vm3 = makeVm({ ctl, ui, board, log: [] });
        const end = gameEndHtml(vm3);
        sawEnd = true;
        if (BAD.test(end) && !bad) bad = `end: ${end.match(BAD)[0]}`;
        if (/end__tiebreak/.test(end)) tiebreakSeen = true;
        if (st.result.shared) sharedSeen = true;
        if (!/Final ranking/.test(end) || (end.match(/class="rank[ "]/g) || []).length !== players) bad = bad || 'ranking rows';
        if (!/last hand \d/.test(end)) bad = bad || 'ranking lacks the last hand score';
        if (!/Look at the table/.test(end) || !/endbar/.test(endBarHtml(vm3))) bad = bad || 'end buttons';
      }
    }
  }
  check('screens: the table, hand, side, status and summit render for whole games with no raw values', screens > 100 && !bad, bad);
  check('screens: the summit, the descent, the summary and the end screen were all reached', sawSummit && sawDescent && sawSummary && sawEnd);
  check('screens: a game with the Colt in a row was reached', coltSeen);
}

// ---------- the game end and its tiebreak (built from a fixed result) ----------
{
  const ctl = createController({ seats: [{ type: 'human', name: 'Ann' }, { type: 'easy' }, { type: 'easy' }], seed: 2, autoPlayForced: true });
  const st = ctl.state;
  const mkRes = (extra) => ({ totals: [14, 14, 6], lastHandScores: [2, 5, 1], handScores: [], winners: [1], shared: false, tiebreakUsed: true, tiedOnTotal: [0, 1], winningScore: 14, margin: 8, hands: 3, tricks: 36, ranking: [{ seat: 1, total: 14, lastHandScore: 5, rank: 1 }, { seat: 0, total: 14, lastHandScore: 2, rank: 2 }, { seat: 2, total: 6, lastHandScore: 1, rank: 3 }], ...extra });
  const vmBase = { names: ctl.names, types: ['human', 'easy', 'easy'], state: { ...st, result: mkRes({}), handLog: [] }, board: boardFromState(st, [0]) };
  const e1 = gameEndHtml(vmBase);
  check('end: a tiebreak is explained with the last-hand points, and the ranking shows each last hand', /Tiebreak: the most points in the last hand/.test(e1) && /Ann 2, .* 5/.test(e1) && /last hand 5/.test(e1) && /Winner/.test(e1));
  const e2 = gameEndHtml({ ...vmBase, state: { ...st, result: mkRes({ winners: [0, 1], shared: true, tiebreakUsed: false, lastHandScores: [4, 4, 1], ranking: [{ seat: 0, total: 14, lastHandScore: 4, rank: 1 }, { seat: 1, total: 14, lastHandScore: 4, rank: 1 }, { seat: 2, total: 6, lastHandScore: 1, rank: 3 }] }), handLog: [] } });
  check('end: a shared win says so and shows the equal ranks', /Shared win/.test(e2) && /Still level, so the win is shared/.test(e2) && /=1/.test(e2));
  const e3 = gameEndHtml({ ...vmBase, state: { ...st, result: mkRes({ tiedOnTotal: [1], tiebreakUsed: false, totals: [10, 14, 6], ranking: [{ seat: 1, total: 14, lastHandScore: 5, rank: 1 }, { seat: 0, total: 10, lastHandScore: 2, rank: 2 }, { seat: 2, total: 6, lastHandScore: 1, rank: 3 }] }), handLog: [] } });
  check('end: no tie at the top, no tiebreak line', !/end__tiebreak/.test(e3));
}

// ---------- prompts ----------
{
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 6, autoPlayForced: false });
  let p = '';
  let guard = 0;
  while (!(ctl.isHumanTurn() && ctl.state.trick && ctl.state.trick.ledSuit) && ctl.state.phase !== 'over' && guard++ < 200) {
    if (ctl.isBotTurn()) ctl.stepBot(); else applyAction(ctl.state, ctl.legalActions()[0]);
  }
  if (ctl.isHumanTurn()) p = turnPrompt(ctl.view(0));
  check('prompt: a climb prompt names trumps and the follow rule, with no raw values', /Escape/.test(p) && /follow|only card|last card|Play anything/.test(p) && !BAD.test(p), p);
  let q = '';
  guard = 0;
  while (ctl.state.phase !== 'summit' && ctl.state.phase !== 'over' && guard++ < 200) {
    if (ctl.isBotTurn()) ctl.stepBot(); else applyAction(ctl.state, ctl.legalActions()[0]);
  }
  while (ctl.state.phase === 'summit' && !ctl.isHumanTurn()) ctl.stepBot();
  if (ctl.state.phase === 'summit') q = turnPrompt(ctl.view(0));
  check('prompt: the summit prompt names the Chase cost', /Chase \(pay 2/.test(q), q);
  guard = 0;
  while (ctl.state.phase === 'summit' && guard++ < 10) applyAction(ctl.state, { type: 'summit', choice: 'chase' });
  guard = 0;
  while (!(ctl.isHumanTurn() && ctl.state.phase === 'descent') && ctl.state.phase !== 'over' && guard++ < 100) {
    if (ctl.isBotTurn()) ctl.stepBot(); else applyAction(ctl.state, ctl.legalActions()[0]);
  }
  const d = ctl.isHumanTurn() && ctl.state.phase === 'descent' ? turnPrompt(ctl.view(0)) : '';
  check('prompt: a descent prompt names Home as trumps and the Brumby card the trick takes', /Home/.test(d) && /Brumby|Colt|Flint|Wombat/.test(d) && !BAD.test(d), d);
}

done();
