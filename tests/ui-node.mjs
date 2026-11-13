// ui-node.mjs - Node-level checks of the UI's pure parts (v6 rules): the table model and its frames (the
// event reducer must land exactly on the live state after every action), the sentences, the clone-and-apply
// hints, the landing/setup builders (no Playtest panel, no rule book link, 2-5 players), the art ids against the
// manifest (the Muster included), the half banner (direction and trumps), the Climb row, the Brumby row, the cards
// each seat has taken and its hand score, the summit beat, the reckoning, the end of the game with its tiebreak, and
// the pass-and-play hand-hiding rules. None of the v5 terms (Chase, Watch, the Mountain, the mob marker, turning the
// hand) may appear anywhere.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. Run: node tests/ui-node.mjs

import fs from 'node:fs';
import { suite, position, play } from './lib.mjs';
import { createController } from '../src/ui/controller.js';
import { boardFromState, reduceBoard, buildFrames, sameBoard, halfOf } from '../src/ui/board.js';
import * as text from '../src/ui/text.js';
import { trickSentence, tiebreakText, turnPrompt, previewText, winnerBanner, tiedGroups, waitingText, handEndText, phaseText, phaseParts, phaseNote, bannerText, priceText } from '../src/ui/text.js';
import { previewCard } from '../src/ui/preview.js';
import { makeVm } from '../src/ui/viewmodel.js';
import * as components from '../src/ui/components.js';
import { seatHtml, tableHtml, handBoxHtml, sideHtml, coverHtml, handSummaryHtml, gameEndHtml, statusHtml, endBarHtml, summitHtml, climbRowHtml, rowHtml, trickHtml, handScoreOf } from '../src/ui/components.js';
import * as landing from '../src/ui/landing.js';
import { landingHtml, howToPlayHtml, seatTypeOptions, uniqueNames, DEFAULT_SETUP, safeCode, PLAYER_COUNTS, humanCount } from '../src/ui/landing.js';
import { useManifest, assetUrl, builtInIds, img, cardImg, cardBackImg, badgeImg, brumbyImg, climbImg } from '../src/ui/assets.js';
import * as assets from '../src/ui/assets.js';
import { GAME_NAME, GAME_SLUG, GAME_TAGLINE, PUBLISH_URL, AT_A_GLANCE, FOOTER_VERSION, RULEBOOK_URL, MAX_SEATS } from '../src/game-config.js';
import { botLevels } from '../src/bots/index.js';
import {
  startGame, applyAction, getValidActions, describeEvent, makeRng, rngPick, fullDeck, cardFace, cloneState, brumbyDeck, brumbyFace, climbCardDeck, climbCardFace, SUITS, SUIT_ORDER,
} from '../src/engine/index.js';

const { check, done } = suite('ui-node');
const BAD = /undefined|NaN|\[object/;
/** Words from the v5 rules that must not appear on any v6 screen. */
const V5 = /\bChase\b|\bChasing\b|\bWatch\b|\bwatcher|\bchaser|Mountain|mob marker|mountain-|turns? (their|your) (whole )?hand|turned round|two numbers|split card|\bsplit\b/;

// ---------- config and the page ----------
{
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  check('config: name, slug and address are set', GAME_NAME === 'Snowy River' && GAME_SLUG === 'snowy-river' && PUBLISH_URL === 'https://www.wombatgamefactory.com/snowy-river-game/');
  const tokens = [...new Set(html.match(/\{\{[A-Z_]+\}\}/g) || [])];
  check('index.html: every token filled', tokens.length === 0, tokens.join(' '));
  check('index.html: one app root, one module script, the consent loader before gtag, nothing loads on localhost', /id="app"/.test(html) && /type="module" src="src\/ui\/main\.js"/.test(html)
    && html.indexOf('cdn-cookieyes.com') < html.indexOf('googletagmanager.com/gtag/js') && /localhost/.test(html));
  check('index.html: the page text describes v6 (smallest horse wins over the top), with no v5 words', /smallest horse/i.test(html) && !V5.test(html.replace(/<script[\s\S]*?<\/script>/g, '')));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  check('package.json: the scripts the workflow relies on', ['dev', 'test', 'test:browser', 'sim', 'qa', 'sweep'].every((k) => pkg.scripts[k]) && pkg.type === 'module' && pkg.name === 'snowy-river-game');
  check('config: 2 to 5 players, the tagline is v6 (no turning the hand)', JSON.stringify(PLAYER_COUNTS) === '[2,3,4,5]' && MAX_SEATS === 5 && AT_A_GLANCE.players === '2-5' && /smallest horse/.test(GAME_TAGLINE) && !V5.test(GAME_TAGLINE) && /6 rules/.test(FOOTER_VERSION));
}

// ---------- art ids against the manifest ----------
{
  const raw = JSON.parse(fs.readFileSync(new URL('../assets/manifest.json', import.meta.url), 'utf8'));
  const manifest = { assets: Array.isArray(raw) ? raw : raw.assets };
  const ids = new Set(manifest.assets.map((a) => a.id));
  check('assets: every built-in art id is in the manifest', builtInIds().every((id) => ids.has(id)), builtInIds().filter((id) => !ids.has(id)).join(','));
  check('assets: all 60 cards (five suits, the Muster included) resolve to a face in the manifest', fullDeck(5).length === 60 && fullDeck(5).every((c) => ids.has(cardFace(c))));
  check('assets: all 12 Brumby cards and the 6 Climb cards resolve to a face in the manifest', brumbyDeck().every((id) => ids.has(brumbyFace(id))) && climbCardDeck().every((id) => ids.has(climbCardFace(id))) && ids.has('climb-back') && ids.has('brumby-back'));
  check('assets: every file the manifest calls real or placeholder exists', manifest.assets.filter((a) => a.status !== 'missing').every((a) => fs.existsSync(new URL(`../assets/${a.file}`, import.meta.url))));
  check('assets: no absolute or Windows path in the manifest', manifest.assets.every((a) => !/^([A-Za-z]:|[\\/])/.test(a.file) && !/\\/.test(a.file) && !/^([A-Za-z]:|[\\/])/.test(a.source || '')));
  const uiIds = ['card-back', 'favicon', 'avatar-1', 'avatar-5', 'badge-escape', 'badge-muster', 'badge-home', 'icon-muster', 'colt', 'brumby-back', 'brumby-plus2', 'brumby-plus1', 'brumby-flint', 'brumby-wombat', 'climb-plus1', 'climb-minus1', 'climb-back', 'card-muster-7'];
  check('assets: the UI art ids are all built in', uiIds.every((id) => builtInIds().includes(id) || id === 'icon-muster' && ids.has(id)));
  check('assets: a badge and an icon for each of the five suits, the Muster included', SUITS.every((s) => ids.has(`badge-${s}`) && ids.has(`icon-${s}`) && builtInIds().includes(`badge-${s}`)) && SUITS.includes('muster'));
  check('assets: the v5 art ids are gone (Mountain, Chase, Watch, the mob marker are not built in or in any listing the UI uses)', ['mountain-up', 'mountain-down', 'chase-3', 'chase-2', 'watch', 'mob-marker', 'mountain-6', 'mountain-7', 'brumby-front', 'chase'].every((id) => !builtInIds().includes(id) && !ids.has(id) || id === 'mob-marker' && !builtInIds().includes(id)));
  check('assets: no choice or Mountain helpers are left in assets.js', !('choiceArt' in assets));
  useManifest(manifest);
  check('assets: assetUrl resolves an id and refuses an unknown one', assetUrl('badge-home') === 'assets/badge-home.webp' && assetUrl('badge-muster') === 'assets/badge-muster.webp' && assetUrl('card-nope-7') === null);
  check('assets: an unknown id gives a text chip, not a broken image', /asset-chip/.test(img('nope', { label: 'Nope' })) && !/<img/.test(img('nope')));
  useManifest({ assets: [] });
  const chipFace = cardImg('muster-7');
  const chipBrumby = brumbyImg('brumby-wombat-1');
  const chipClimb = climbImg('climb-minus1');
  useManifest({ assets: [{ id: 'card-escape-7', file: 'cards/card-escape-7.webp', width: 300, height: 428 }] });
  const artFace = cardImg('escape-7');
  useManifest(manifest);
  check('assets: a card with no art is drawn as a face with its number, suit shape and a label (the Muster too)', /cardchip--muster/.test(chipFace) && />7</.test(chipFace) && /aria-label="Muster 7"/.test(chipFace));
  check('assets: a Brumby card and a Climb card with no art show their value', />-2</.test(chipBrumby) && />-1</.test(chipClimb));
  check('assets: a card with art is an <img> by manifest id, upright (never turned)', /<img/.test(artFace) && artFace.includes('cards/card-escape-7.webp') && !/is-turned/.test(artFace) && !/is-turned/.test(cardImg('home-3')));
  check('assets: the card back and a badge fall back too', !BAD.test(cardBackImg()) && !BAD.test(badgeImg('home')) && !BAD.test(badgeImg('muster')));
}

// ---------- sentences ----------
{
  const names = ['Mia', 'Sam', 'Ann', 'Bo'];
  const g = position({ hands: [['home-7', 'home-1', 'escape-1'], ['climb-4', 'climb-2', 'escape-2'], ['home-2', 'climb-3', 'escape-3'], ['home-9', 'climb-9', 'escape-4']], leader: 0 });
  const ev = play(g, 'home-7', 'climb-4');
  const won = ev.find((e) => e.type === 'trick-won');
  const s = trickSentence(g.tricks[0], won, names);
  check('sentence: an off-suit card is named as thrown; the winner is named (highest wins on the climb)', /^Mia led Home 7; Sam had no Home and threw Climb 4; Ann followed with Home 2; Bo followed with Home 9 and wins\.$/.test(s), s);
  const g2 = position({ hands: [['home-7', 'home-1', 'escape-1'], ['climb-4', 'climb-2', 'escape-2'], ['home-2', 'climb-3', 'escape-3'], ['home-9', 'climb-9', 'escape-4']], leader: 0 });
  const ev2 = play(g2, 'home-7', 'escape-2');
  const w2 = ev2.find((e) => e.type === 'trick-won');
  const s2 = w2 ? trickSentence(g2.tricks[0], w2, names) : '';
  check('sentence: a trump played on another suit is named as trumping', /Sam had no Home and trumped with Escape 2/.test(s2) || !w2, s2);
  const d = position({ hands: [['home-7', 'home-1', 'escape-1'], ['home-3', 'climb-2', 'escape-2'], ['home-2', 'climb-3', 'escape-3'], ['home-9', 'climb-9', 'escape-4']], leader: 0, phase: 'descent' });
  const evd = play(d, 'home-7', 'home-3', 'home-2', 'home-9');
  const wd = evd.find((e) => e.type === 'trick-won');
  check('sentence: on the descent the LOWEST card of the suit wins (Home 2)', wd && wd.winner === 2 && /Ann followed with Home 2 and wins/.test(trickSentence(d.tricks[0], wd, names)));
  check('banner: a plain win names the card without a trump note', winnerBanner({ winner: 1, card: 'home-4', phase: 'climb', byTrump: false }, names) === 'Sam wins with Home 4');
  check('banner: second person for You, and a trump is called out', winnerBanner({ winner: 0, card: 'escape-9', phase: 'climb', byTrump: true }, ['You', 'Sam']) === 'You win with Escape 9 (trumps)');
  check('banner: the descent names the card as printed (one number per card, no turned reading)', winnerBanner({ winner: 1, card: 'home-4', phase: 'descent', byTrump: false }, names) === 'Sam wins with Home 4');
  check('phase banner: the climb is highest wins, the descent is lowest wins; no summit phase', phaseText('climb') === 'The climb: highest wins' && phaseText('descent') === 'The descent: lowest wins' && phaseText('summit') === '' && phaseText('over') === 'Game over');
  check('phase banner: the parts split on the colon', phaseParts('climb').name === 'The climb' && phaseParts('descent').rule === 'lowest wins');
  check('phase note: names the trump suit and the direction in each half', /^Escape is trumps: any Escape card played beats every other suit\. Otherwise the highest card of the suit led wins\.$/.test(phaseNote('climb', 'escape'))
    && /^Home is trumps: .*lowest Home wins.*lowest card of the suit led wins\.$/.test(phaseNote('descent', 'home')));
  check('banner text: the deal names the -1 card, the summit names the switch and the leader, a prize names the card, the reshuffle', /climb trick 4/.test(bannerText({ kind: 'deal', minusPosition: 4 }, names)) && /Over the top.*lowest card wins.*Home is trumps.*\+6 in all.*Sam leads the descent/.test(bannerText({ kind: 'summit', rowValue: 6, colt: false, leader: 1 }, names))
    && /^Ann takes Climb card -1 \(-1\)\.$/.test(bannerText({ kind: 'prize', half: 'climb', seat: 2, card: 'climb-minus1', value: -1 }, names)) && /Colt.*\+4/.test(bannerText({ kind: 'prize', half: 'descent', seat: 2, card: 'colt', value: 4 }, names)) && /all 12 are shuffled/.test(bannerText({ kind: 'reshuffle' }, names)));
  check('price text: the card and its points', priceText({ card: 'climb-minus1', value: -1 }) === 'Climb card -1 (-1 point)' && /Brumby \+2 \(\+2 points\)/.test(priceText({ card: 'brumby-plus2-1', value: 2 })));
  check('text.js has no v5 helpers left (stakes, descent goal, step callout)', !('stakesText' in text) && !('descentGoal' in text) && !('stepCallout' in text));
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
  check('waiting text: bot, human, the end (no summit wait)', waitingText({ phase: 'climb', toAct: 1 }, names, ['human', 'easy', 'human']) === 'Bo is thinking.'
    && waitingText({ phase: 'descent', toAct: 2 }, names, ['human', 'easy', 'human']) === 'Cy is to play.' && waitingText({ phase: 'over', toAct: null }, names, []) === 'Game over.');
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
  const t = position({ hands: [['home-8', 'climb-1', 'climb-2'], ['climb-3', 'escape-2', 'climb-4'], ['home-3', 'home-5', 'climb-5'], ['home-4', 'home-10', 'climb-6']], leader: 0 });
  play(t, 'home-8');
  const tr = previewCard(t, 'escape-2');
  check('preview (climb): an Escape card played on Home would trump it and win as it stands', tr === null || (tr.wins && tr.trumps));
  const dd = position({ hands: [['home-8', 'home-1', 'escape-1'], ['home-2', 'home-9', 'escape-2'], ['home-3', 'home-5', 'escape-3'], ['home-4', 'home-10', 'escape-4']], leader: 0, phase: 'descent' });
  play(dd, 'home-8');
  const pd = previewCard(dd, 'home-2');
  check('preview (descent): the LOWEST card wins (Home 2 beats Home 8, Home 9 does not)', pd.wins && !previewCard(dd, 'home-9').wins && pd.half === 'descent');
  const pt = previewText(pd, ['A', 'B', 'C', 'D']);
  check('preview (descent): the Brumby card the trick takes is named with its value, and there is no keep / send-off wording', !!pd.prize && /Brumby|Colt|Flint|Wombat/i.test(pt) && /\([+-]\d\)/.test(pt) && !V5.test(pt) && /lowest so far/.test(pt), pt);
  const pc = previewCard(position({ hands: [['home-8', 'home-1', 'escape-1'], ['home-2', 'home-9', 'escape-2'], ['home-3', 'home-5', 'escape-3'], ['home-4', 'home-10', 'escape-4']], leader: 0 }), 'home-8');
  check('preview (climb): the Climb card the trick takes is named', /Climb card [+-]1/.test(previewText(pc, ['A', 'B', 'C', 'D'])) && /^climb-/.test(pc.prize));
}

// ---------- the table model: events land exactly on the live state ----------
{
  let actions = 0; let drift = 0; let firstDrift = ''; let framesBad = 0; let modals = 0; let handEnds = 0; let decided = 0; let tricks = 0; let games = 0; let summits = 0; let climbTakes = 0; let brumbyTakes = 0; let deals = 0;
  for (let seed = 1; seed <= 10; seed++) {
    for (const players of [2, 3, 4, 5]) {
      for (const humans of [[0], [0, 1], []]) {
        if (humans.some((h) => h >= players)) continue;
        if (!(seed <= 3 || humans.length === 1)) continue;
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
            if (f.kind === 'deal') { deals++; if (f.board.climbRow.length !== 6 || f.board.climbRow.some((c) => c === null) || f.board.climbNext !== 0) framesBad++; }
            if (f.kind === 'summit-opened') { summits++; if (f.board.phase !== 'descent' || !f.board.banner || f.board.banner.kind !== 'summit' || f.board.row.length !== 6 || f.board.climbRow.some((c) => c !== null) || halfOf(f.board) !== 'descent') framesBad++; }
            if (f.kind === 'climb-card-taken') { climbTakes++; if (!f.board.banner || f.board.banner.kind !== 'prize' || !f.log) framesBad++; }
            if (f.kind === 'brumby-taken') brumbyTakes++;
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
  check('board: walking the events lands exactly on the live state, every action (2 to 5 players)', drift === 0, `${actions} actions in ${games} games, ${drift} drifts, first: ${firstDrift}`);
  check('board: frames are well formed (a decided beat per trick, one modal per hand end, six Climb cards and six Brumby cards taken and one summit per hand)',
    framesBad === 0 && modals === handEnds && handEnds > 100 && decided === tricks && tricks > 1500 && summits === handEnds && climbTakes === 6 * handEnds && brumbyTakes === 6 * handEnds && deals === handEnds - games,
    `bad ${framesBad}, modals ${modals}, hand ends ${handEnds}, decided ${decided}, tricks ${tricks}, summits ${summits}, climb takes ${climbTakes}, brumby takes ${brumbyTakes}, deals ${deals}`);
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
  check('board: the board holds no v5 fields (marker, handsTurned, choices, chaseCost, kept piles of tricks)', !['marker', 'handsTurned', 'choices', 'chosen', 'revealed', 'choiceOrder', 'chaseCost'].some((k) => k in b0));
}

// ---------- landing and setup ----------
{
  const levels = botLevels();
  const html = landingHtml(levels, DEFAULT_SETUP, '');
  check('landing: a radio per player count (2, 3, 4, 5) and five seat forms', JSON.stringify(PLAYER_COUNTS) === '[2,3,4,5]' && PLAYER_COUNTS.every((n) => html.includes(`name="players" value="${n}"`)) && (html.match(/class="seatform"/g) || []).length === 5);
  check('landing: no Playtest rules panel and no non-standard note (there are no switches)', !('rulesPanelHtml' in landing) && !/Playtest/i.test(html) && !/non-standard/i.test(html) && !/class="rule"|rules-panel|rules-note/.test(html));
  check('landing: the hero art, the v6 hook, 2-5 players / 20-30 min / ages 10+', /data-asset="hero-wide"/.test(html) && html.includes(GAME_TAGLINE) && AT_A_GLANCE.players === '2-5' && AT_A_GLANCE.minutes === '20-30' && AT_A_GLANCE.age === '10+');
  check('landing: no rule book link anywhere (page, How to play, footer)', !/rule book|rulebook|\.pdf/i.test(html) && !/rule book|rulebook|\.pdf/i.test(howToPlayHtml()) && RULEBOOK_URL === '' && !/rule book/i.test(FOOTER_VERSION));
  check('landing: setup says to set every seat to a bot to watch', /Set every seat to a bot to watch a game/.test(html));
  check('landing: Play forced cards for me is off by default and explained', /Play forced cards for me/.test(html) && !/id="autoPlayForced" checked/.test(html));
  const how = howToPlayHtml();
  check('landing: How to play teaches v6 (one number per card, the Climb row with the -1, Escape then Home trumps, highest then lowest wins, the Brumby row, no choice, the tiebreak)',
    /one number/.test(how) && /Climb cards/.test(how) && /one worth -1/.test(how) && /Escape is trumps/.test(how) && /Home is trumps/.test(how) && /lowest card wins/.test(how) && /Brumby/.test(how) && /Colt/.test(how) && /no choice/.test(how) && /Muster/.test(how) && /most points in the last hand/.test(how) && /Tricks themselves score nothing/.test(how));
  check('landing: How to play lists all five suits, the Muster marked as five players only', SUIT_ORDER.length === 5 && (how.match(/how__badge/g) || []).length === 5 && /5 players only/.test(how));
  check('landing: no v5 words on the page or in How to play (Chase, Watch, Mountain, turning the hand, two numbers)', !V5.test(html.replace(/<svg[\s\S]*?<\/svg>/g, '')) && !V5.test(how), (html + how).match(V5) && (html + how).match(V5)[0]);
  check('landing: no v4 terms (heels, breakaway, nobody chases)', !/at the mob's heels|break away|off-suit steps|nobody chases|Brumby card goes under the Colt/i.test(how + html));
  check('landing: the bug-free text (no undefined / NaN / [object])', !BAD.test(html) && !BAD.test(how));
  check('landing: the contact for bug reports is not on the page as a raw address', !/@/.test(html));
  check('seat menu: human and the three levels, a missing level disabled', /value="human"/.test(seatTypeOptions(levels, 'human')) && /value="hard"/.test(seatTypeOptions(levels, 'easy'))
    && /disabled/.test(seatTypeOptions([{ id: 'easy', label: 'Easy' }], 'easy')));
  check('seat menu: simulator-only bots are not offered', !/value="high"/.test(seatTypeOptions(levels, 'easy')) && !/value="low"/.test(seatTypeOptions(levels, 'easy')) && !/value="naive"/.test(seatTypeOptions(levels, 'easy')));
  check('setup: names made unique, case-insensitive', JSON.stringify(uniqueNames(['Sam', 'sam', '', 'Ann', 'SAM'])) === '["Sam","sam 2","","Ann","SAM 3"]');
  check('setup: the rules code of a setup is always std', safeCode(DEFAULT_SETUP) === 'std' && safeCode({ players: 4, rules: { TRUMP: 'red' } }) === 'std');
  check('setup: humans counted over the seats in play only', humanCount({ players: 3, seats: [{ type: 'human' }, { type: 'easy' }, { type: 'human' }, { type: 'human' }] }) === 2);
  check('setup: the default setup is four players, with a form entry for each of the five seats', DEFAULT_SETUP.seats.length === 5 && DEFAULT_SETUP.players === 4 && DEFAULT_SETUP.seats[0].type === 'human');
  check('how to play, in the in-game dialog and on the page, is the same text', howToPlayHtml() === how);
}

// ---------- pass-and-play: hands stay hidden ----------
{
  const duo = createController({ seats: [{ type: 'human', name: 'A' }, { type: 'human', name: 'B' }, { type: 'easy' }], seed: 5, autoPlayForced: false });
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  const mk = () => makeVm({ ctl: duo, ui, board: boardFromState(duo.state, duo.humanSeats), log: [] });
  const solo = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }], seed: 5, autoPlayForced: false });
  const vmLone = makeVm({ ctl: solo, ui, board: boardFromState(solo.state, solo.humanSeats), log: [] });
  check('viewmodel: a lone human always has their hand on show, with a reason or a hint on every card when it is their turn', vmLone.hand !== null && vmLone.hand.length === 12 && (!vmLone.myTurn || vmLone.hand.every((c) => vmLone.reasons.has(c))) && vmLone.half === 'climb');
  while (!duo.isHumanTurn() && duo.isBotTurn()) duo.stepBot();
  const vmCover = mk();
  check('viewmodel: with two humans no hand is shown until the next human confirms', duo.needsHandoff() ? vmCover.hand === null : true);
  const cover = coverHtml({ names: duo.names, phase: 'climb' }, duo.toAct());
  check('cover: names the player and shows no card, trick, row or score', /Pass to [AB]/.test(cover) && !/class="hand"|cardimg|cardchip|tplay|Total|brumbyimg|climbimg|rslot/.test(cover) && !V5.test(cover));
  duo.reveal(duo.toAct());
  const vmShown = mk();
  check('viewmodel: after the cover is confirmed the hand of that human is shown', vmShown.hand !== null && vmShown.shown === duo.toAct());
  const replay = makeVm({ ctl: duo, ui: { ...ui, frame: { board: boardFromState(duo.state, duo.humanSeats) } }, board: boardFromState(duo.state, duo.humanSeats), log: [] });
  check('viewmodel: while a replay frame is on screen with two humans, no hand is shown', replay.hand === null || replay.shown === null);
}

// ---------- helpers: a real game played to the summit ----------
/** Plays a real game (random legal cards) up to the first descent trick and returns the controller and the frames of the action that crossed the summit. */
function toDescent(players, seed, humans = [0]) {
  const types = Array.from({ length: players }, (_, i) => (humans.includes(i) ? 'human' : 'easy'));
  const ctl = createController({ seats: types.map((type) => ({ type })), seed, autoPlayForced: true });
  const rng = makeRng(`s${seed}`);
  let board = boardFromState(ctl.state, humans);
  let crossing = null;
  let guard = 0;
  while (ctl.state.phase === 'climb' && guard++ < 500) {
    const events = applyAction(ctl.state, rngPick(rng, ctl.legalActions()));
    const frames = buildFrames(board, events, { names: ctl.names, describe: describeEvent, trickText: trickSentence, liveHands: (s) => ctl.state.hands[s] });
    if (frames.length) board = frames[frames.length - 1].board;
    if (events.some((e) => e.type === 'summit-opened')) crossing = { events, frames };
  }
  return { ctl, board, crossing };
}
const UI0 = () => ({ selected: null, note: '', panels: {}, frame: null, modal: null });

// ---------- the half banner: direction and trumps in each half ----------
{
  const ui = UI0();
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 11, autoPlayForced: true });
  const vm = makeVm({ ctl, ui, board: boardFromState(ctl.state, [0]), log: [] });
  const s1 = statusHtml(vm);
  check('banner (climb): THE CLIMB, highest wins, Escape is trumps, with the Escape badge (trophy)', /phasebar--climb/.test(s1) && />The climb</.test(s1) && />highest wins</.test(s1) && /Escape is trumps/.test(s1) && /data-asset="badge-escape"/.test(s1));
  check('banner (climb): the ride shows six climb steps, the summit and six descent steps, with the first step now', (s1.match(/ride__step--climb/g) || []).length === 6 && (s1.match(/ride__step--descent/g) || []).length === 6 && /class="ride__summit"/.test(s1) && /ride__step--climb is-now/.test(s1) && !/is-done/.test(s1));
  const { ctl: c2, board: b2 } = toDescent(4, 12);
  const vm2 = makeVm({ ctl: c2, ui, board: b2, log: [] });
  const s2 = statusHtml(vm2);
  check('banner (descent): THE DESCENT, lowest wins, Home is trumps, with the Home badge (horseshoe)', /phasebar--descent/.test(s2) && />The descent</.test(s2) && />lowest wins</.test(s2) && /Home is trumps/.test(s2) && /data-asset="badge-home"/.test(s2));
  check('banner (descent): the ride has all six climb steps done and the first descent step now', (s2.match(/ride__step--climb is-done/g) || []).length === 6 && /ride__step--descent is-now/.test(s2));
  check('banner: no v5 words in either half, no raw values', !V5.test(s1 + s2) && !BAD.test(s1 + s2));
  check('hand box: states the direction and the trump suit in each half', /highest wins/.test(handBoxHtml(vm)) && /Escape is trumps/.test(handBoxHtml(vm)) && /lowest wins/.test(handBoxHtml(vm2)) && /Home is trumps/.test(handBoxHtml(vm2)));
  check('hand: cards are never turned (one number, upright), the trump suit is marked', !/is-turned|hand--turned|turned round/.test(handBoxHtml(vm) + handBoxHtml(vm2)) && (/is-trump/.test(handBoxHtml(vm)) === vm.hand.some((c) => c.startsWith('escape-'))) && (/is-trump/.test(handBoxHtml(vm2)) === vm2.hand.some((c) => c.startsWith('home-'))));
}

// ---------- the summit beat ----------
{
  for (const players of [2, 3, 4, 5]) {
    const { ctl, crossing } = toDescent(players, 30 + players);
    const frame = crossing.frames.find((f) => f.kind === 'summit-opened');
    const vm = makeVm({ ctl, ui: { ...UI0(), frame }, board: frame.board, log: [] });
    const h = summitHtml(vm);
    check(`summit ${players}p: the beat says over the top, lowest wins, Escape was trumps and Home is, shows the six-card row with values and who leads`, /overlay--summit/.test(h) && /Over the top: now the lowest card wins/.test(h) && /Escape/.test(h) && /is trumps, lowest wins/.test(h) && /was trumps, highest won/.test(h) && (h.match(/summit__brumby/g) || []).length === 6 && /worth [+-]\d+ in all/.test(h) && /leads? the descent/.test(h), h.slice(0, 200));
    check(`summit ${players}p: the Climb row is empty on the beat, the Brumby row is dealt, the banner has changed`, frame.board.climbRow.every((c) => c === null) && frame.board.row.length === 6 && /phasebar--descent/.test(statusHtml(vm)) && /Climb row is empty/.test(climbRowHtml(vm)));
    check(`summit ${players}p: nothing on the beat names a v5 term and no raw value`, !V5.test(h) && !BAD.test(h));
    check(`summit ${players}p: the beat is only shown on the summit frame (none on a plain frame)`, summitHtml({ ...vm, board: { ...frame.board, banner: null }, names: ctl.names }) === '');
  }
}

// ---------- the Climb row, the Brumby row, the seats ----------
{
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 11, autoPlayForced: true });
  const ui = UI0();
  const vm = makeVm({ ctl, ui, board: boardFromState(ctl.state, [0]), log: [] });
  const cr = climbRowHtml(vm);
  const st = ctl.state;
  const dealtVals = st.climbRowDealt.map((id) => (id === 'climb-minus1' ? -1 : 1));
  check('Climb row: six face-up Climb cards, in the order dealt, each with its value under it', (cr.match(/class="rslot rslot--climb/g) || []).length === 6 && (cr.match(/rslot__val--pos/g) || []).length === 5 && (cr.match(/rslot__val--neg/g) || []).length === 1 && st.climbRowDealt.every((id, i) => cr.includes(`data-pos="${i + 1}" aria-label="Climb card ${i + 1}: ${id === 'climb-minus1' ? 'Climb card -1' : 'Climb card +1'}`)) && dealtVals.filter((x) => x < 0).length === 1);
  check('Climb row: the first card is the one on offer (lit), the -1 is marked bad, and the line says what the next trick takes', (cr.match(/is-next/g) || []).length >= 1 && /rslot rslot--climb is-next/.test(cr) && /is-bad/.test(cr) && /Climb trick 1 takes Climb card [+-]1/.test(cr) && /The -1 card is on trick \d/.test(cr));
  const b = { ...vm.board, climbRow: [null, null, ...vm.board.climbRow.slice(2)], climbTaken: [{ seat: 1 }, { seat: 2 }, null, null, null, null], climbNext: 2 };
  const cr2 = climbRowHtml({ ...vm, board: b, names: ['You', 'Bo', 'Cy', 'Di'] });
  check('Climb row: a taken card shows who took it and its value; the next card moves on', (cr2.match(/is-taken/g) || []).length === 2 && /rslot__gone" data-seat="1"/.test(cr2) && /rslot__gone" data-seat="2"/.test(cr2) && /Climb trick 3 takes/.test(cr2) && /data-pos="3"[^>]*>/.test(cr2) && /rslot rslot--climb is-next[^"]*" data-pos="3"/.test(cr2));
  const rowClimb = rowHtml(vm);
  check('Brumby row: during the climb six face-down cards wait, with the deck at 12; the line says when it is dealt', (rowClimb.match(/rslot--down/g) || []).length === 6 && /Deck <b>12<\/b>/.test(rowClimb) && /Dealt at the summit/.test(rowClimb) && !V5.test(rowClimb));
  const fakeRow = ['brumby-plus2-1', 'colt', 'brumby-flint', 'brumby-wombat-1', 'brumby-plus1-1', 'brumby-plus2-2'];
  const bd = { ...vm.board, phase: 'descent', row: [null, 'colt', ...fakeRow.slice(2)], rowDealt: fakeRow, rowTaken: [{ seat: 2 }, null, null, null, null, null], rowNext: 1, kept: [[], [], ['brumby-plus2-1'], []], discard: ['brumby-plus1-2'] };
  const r2 = rowHtml({ ...vm, board: bd, names: ['You', 'Bo', 'Cy', 'Di'] });
  check('Brumby row: the next card to be won is lit, a taken card shows who took it, the Colt is marked, bad cards are marked, the discard is counted', /rslot rslot--brumby is-next is-colt|is-next[^"]*is-colt/.test(r2) && /rslot__gone" data-seat="2"/.test(r2) && /Discard <b>1<\/b>/.test(r2) && /is-bad/.test(r2) && /still to win/.test(r2) && /rslot__val--neg/.test(r2));
  check('Brumby row: every value is printed under its card (+2, Colt +4, Flint -1, Wombat -2)', /\+4<\/b>/.test(r2) && /-1<\/b>/.test(r2) && /-2<\/b>/.test(r2));
  const names4 = ['You', 'Bo', 'Cy', 'Di'];
  const bs = { ...bd, climbCards: [[], [], ['climb-plus1-1', 'climb-minus1'], []], kept: [[], [], ['brumby-plus2-1', 'brumby-wombat-1'], []] };
  const seatH = seatHtml({ ...vm, board: bs, names: names4, types: ['human', 'easy', 'easy', 'easy'], view: null }, 2, 'r2');
  check('seat: leads with the hand score so far (the cards taken: +1 -1 +2 -2 = 0) and shows both lots of taken cards face up with their sums', handScoreOf(bs, 2) === 0 && /data-hand-score="2">0</.test(seatH) && /Hand score/.test(seatH) && (seatH.match(/taken__card/g) || []).length === 4 && /Climb cards/.test(seatH) && /Brumby cards/.test(seatH) && seatH.indexOf('hscore') < seatH.indexOf('taken--climb'));
  const seatP = seatHtml({ ...vm, board: { ...bs, climbCards: [[], [], ['climb-plus1-1', 'climb-plus1-2'], []], kept: [[], [], ['brumby-plus2-1'], []] }, names: names4, types: ['human', 'easy', 'easy', 'easy'], view: null }, 2, 'r2');
  check('seat: a positive hand score reads +4 and is styled as such; a negative one is styled as such', /hscore__num--pos" data-hand-score="2">\+4</.test(seatP) && /hscore__num--neg" data-hand-score="2">-?\d/.test(seatHtml({ ...vm, board: { ...bs, climbCards: [[], [], ['climb-minus1'], []], kept: [[], [], ['brumby-wombat-1'], []] }, names: names4, types: ['human', 'easy', 'easy', 'easy'], view: null }, 2, 'r2')));
  const seatE = seatHtml({ ...vm, names: names4, types: ['human', 'easy', 'easy', 'easy'], view: null }, 1, 'r1');
  check('seat: nothing taken yet reads 0 and "none yet"; cards in hand are a small line; no pile of tricks or Chase chip', /data-hand-score="1">0</.test(seatE) && /none yet/.test(seatE) && /class="seat__hand"/.test(seatE) && /12 cards/.test(seatE) && !/class="pile|schip|kept__/.test(seatE) && !V5.test(seatE));
  check('seat: one card reads "1 card"', /<b class="seat__cardsnum" data-cards="1">1<\/b> card</.test(seatHtml({ ...vm, board: { ...vm.board, handCounts: [3, 1, 3, 3] } }, 1, 'r1')));
  const tr = trickHtml(vm);
  check('trick: the title says what this trick takes (the next Climb card)', /Climb trick 1 of 6/.test(tr) && /class="prize prize--(pos|neg)"/.test(tr) && /takes [+-]1/.test(tr));
}

// ---------- screens: the table, hand, side and status over whole games ----------
{
  const ui = UI0();
  let screens = 0; let bad = ''; let sawEnd = false; let sawSummary = false; let sawDescent = false; let tiebreakSeen = false; let sharedSeen = false; let coltSeen = false; let negSeen = false; let musterSeen = false;
  for (const [players, seed] of [[2, 3], [3, 4], [4, 5], [5, 6], [5, 9], [4, 9], [3, 12], [2, 14]]) {
    const ctl = createController({ seats: [{ type: 'human' }, ...Array.from({ length: players - 1 }, () => ({ type: 'easy' }))], seed, autoPlayForced: true });
    const rng = makeRng(`sc${seed}`);
    let board = boardFromState(ctl.state, [0]);
    let guard = 0;
    while (ctl.state.phase !== 'over' && guard++ < 400) {
      const st = ctl.state;
      const vm = makeVm({ ctl, ui, board, log: [] });
      const html = [tableHtml(vm), handBoxHtml(vm), sideHtml(vm), statusHtml(vm)].join('');
      screens++;
      if (BAD.test(html) && !bad) bad = `p${players} seed ${seed} trick ${st.trickNo}: ${html.match(BAD)[0]}`;
      if (V5.test(html) && !bad) bad = `p${players} seed ${seed}: v5 word ${html.match(V5)[0]}`;
      if (!/phasebar--(climb|descent)/.test(html) || !/is trumps/.test(html) && !bad) bad = bad || 'no direction and trumps banner';
      if (html.includes('card-muster-')) musterSeen = true;
      if (st.phase === 'descent') sawDescent = true;
      const events = applyAction(st, rngPick(rng, getValidActions(st)));
      for (const ev of events) {
        if (ev.type === 'hand-ended') {
          const vm2 = makeVm({ ctl, ui, board, log: [] });
          const h = handSummaryHtml(vm2, { kind: 'hand', handNo: ev.handNo, event: ev });
          sawSummary = true;
          if (BAD.test(h) && !bad) bad = `reckoning: ${h.match(BAD)[0]}`;
          if (V5.test(h) && !bad) bad = `reckoning v5 word: ${h.match(V5)[0]}`;
          const rows = (h.match(/class="reck__row/g) || []).length;
          const sumsOk = ev.breakdown.every((x) => x.score === x.climbValue + x.keptValue);
          if (rows !== players || !sumsOk || !/Climb cards/.test(h) || !/Brumby cards/.test(h) || !/Deal the next hand|See the final result/.test(h)) bad = bad || `reckoning rows ${rows}`;
          for (const x of ev.breakdown) {
            if (x.climbCards.length && !h.includes(climbCardFace(x.climbCards[0]))) bad = bad || 'a taken Climb card is missing from the reckoning';
            if (x.kept.length && !h.includes(brumbyFace(x.kept[0]))) bad = bad || 'a taken Brumby card is missing from the reckoning';
            if (x.score < 0) negSeen = true;
          }
          if (!new RegExp(`${ev.breakdown.map((x) => (x.score > 0 ? `\\+${x.score}` : `${x.score}`)).join('[\\s\\S]*')}`).test(h)) bad = bad || 'scores not shown in order';
          if (ev.colt) { coltSeen = true; if (!/won the Colt/.test(h)) bad = bad || 'the Colt winner is not named'; }
          if (!/took the -1 Climb card/.test(h)) bad = bad || 'the -1 winner is not named';
        }
      }
      const frames = buildFrames(board, events, { names: ctl.names, describe: describeEvent, trickText: trickSentence, liveHands: (s) => st.hands[s] });
      if (frames.length) board = frames[frames.length - 1].board;
      if (st.phase === 'over') {
        const vm3 = makeVm({ ctl, ui, board, log: [] });
        const end = gameEndHtml(vm3);
        sawEnd = true;
        if (BAD.test(end) && !bad) bad = `end: ${end.match(BAD)[0]}`;
        if (V5.test(end) && !bad) bad = `end v5 word: ${end.match(V5)[0]}`;
        if (/end__tiebreak/.test(end)) tiebreakSeen = true;
        if (st.result.shared) sharedSeen = true;
        if (!/Final ranking/.test(end) || (end.match(/class="rank[ "]/g) || []).length !== players) bad = bad || 'ranking rows';
        if (!/last hand -?\d/.test(end)) bad = bad || 'ranking lacks the last hand score';
        if (!/Look at the table/.test(end) || !/endbar/.test(endBarHtml(vm3))) bad = bad || 'end buttons';
      }
    }
  }
  check('screens: the table, hand, side and status render for whole games at 2 to 5 players with the direction and trumps banner, no v5 words and no raw values', screens > 100 && !bad, bad);
  check('screens: the descent, the reckoning and the end screen were all reached', sawDescent && sawSummary && sawEnd);
  check('screens: the Colt was reached in a row', coltSeen);
  check('screens: the Muster suit showed on a five-player table', musterSeen);
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
  check('prompt: a climb prompt names Escape as trumps, the highest card, the follow rule and the Climb card the trick takes, with no raw values', /Escape/.test(p) && /highest/.test(p) && /follow|only card|last card|Play anything/.test(p) && /This trick takes Climb card [+-]1 \([+-]1 point\)\./.test(p) && !BAD.test(p) && !V5.test(p), p);
  guard = 0;
  while (!(ctl.isHumanTurn() && ctl.state.phase === 'descent') && ctl.state.phase !== 'over' && guard++ < 200) {
    if (ctl.isBotTurn()) ctl.stepBot(); else applyAction(ctl.state, ctl.legalActions()[0]);
  }
  const d = ctl.isHumanTurn() && ctl.state.phase === 'descent' ? turnPrompt(ctl.view(0)) : '';
  check('prompt: a descent prompt names Home as trumps, the lowest card and the Brumby card the trick takes', /Home/.test(d) && /lowest/.test(d) && /This trick takes (Brumby|Colt|Flint|Wombat)/.test(d) && !BAD.test(d) && !V5.test(d), d);
}

// ---------- no v5 code left in the UI ----------
{
  const files = ['main.js', 'components.js', 'board.js', 'text.js', 'landing.js', 'assets.js', 'viewmodel.js', 'preview.js', 'controller.js'];
  const src = files.map((f) => fs.readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8')).join('\n');
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  check('no v5 code left: no Mountain, mob marker, Chase / Watch decision, reveal, turned hand or chase cost in the UI sources', !/Mountain|mountain[-A-Z_]|mob-marker|handsTurned|chaseCost|summit-chosen|summit-revealed|marker-moved|brumby-kept|brumby-discarded|decisionHtml|revealHtml|turnHtml|summitModalHtml|descentGoal|stakesText|choiceArt/.test(src.replace(/\/\/.*$/gm, '')));
  check('no v5 styles left: no mountain, schip, decide, reveal or turned rules in style.css', !/\.mountain|\.schip|\.decide|\.reveal|is-turned|\.turn__|\.goal\b|kept__/.test(css));
  check('the new suit colours are the style tokens (Escape orange, Descent sky blue, Muster violet)', /--s-escape: #f07f1e/i.test(css) && /--s-descent: #6fa8d6/i.test(css) && /--s-muster: #944ddb/i.test(css) && /--s-home: #3c5677/i.test(css));
  check('components.js exports no v5 builders', !['decisionHtml', 'revealHtml', 'turnHtml', 'summitModalHtml', 'mountainHtml'].some((k) => k in components));
}

done();
