// ui-node.mjs - Node-level checks of the UI's pure parts: the table model and its frames (the
// event reducer must land exactly on the live state after every action, and must never hold an
// unrevealed summit choice), the sentences, the clone-and-apply hints, the landing/setup builders (no
// Playtest panel: VARIANTS is empty), the art ids against the manifest, the summit decision panel, and
// the pass-and-play hand-hiding rules.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. Run: node tests/ui-node.mjs

import fs from 'node:fs';
import { suite, position, play } from './lib.mjs';
import { createController } from '../src/ui/controller.js';
import { boardFromState, reduceBoard, buildFrames, sameBoard } from '../src/ui/board.js';
import { trickSentence, tiebreakText, turnPrompt, previewText, winnerBanner, tiedGroups, waitingText, handEndText, stakesText, phaseText, phaseParts, bannerText, stepCallout, descentGoal } from '../src/ui/text.js';
import { previewCard } from '../src/ui/preview.js';
import { makeVm } from '../src/ui/viewmodel.js';
import { seatHtml, tableHtml, handBoxHtml, sideHtml, coverHtml, handSummaryHtml, gameEndHtml, statusHtml, endBarHtml, summitModalHtml, revealHtml, mountainHtml, coltHtml, stepPosition, MOUNTAIN_STEPS, heelsSeat, standing } from '../src/ui/components.js';
import * as landing from '../src/ui/landing.js';
import { landingHtml, howToPlayHtml, seatTypeOptions, uniqueNames, DEFAULT_SETUP, RULEBOOK_URL, safeCode, PLAYER_COUNTS, humanCount } from '../src/ui/landing.js';
import { useManifest, assetUrl, builtInIds, img, cardImg, cardBackImg, badgeImg } from '../src/ui/assets.js';
import { GAME_NAME, GAME_SLUG, GAME_TAGLINE, PUBLISH_URL, AT_A_GLANCE, FOOTER_VERSION } from '../src/game-config.js';
import { botLevels } from '../src/bots/index.js';
import {
  startGame, applyAction, getValidActions, describeEvent, makeRng, rngPick, fullDeck, cardFace, cloneState, isCardPhase,
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
  check('assets: every file the manifest calls real or placeholder exists', manifest.assets.filter((a) => a.status !== 'missing').every((a) => fs.existsSync(new URL(`../assets/${a.file}`, import.meta.url))));
  check('assets: no absolute or Windows path in the manifest', manifest.assets.every((a) => !/^([A-Za-z]:|[\\/])/.test(a.file) && !/\\/.test(a.file)));
  const uiIds = ['card-back', 'favicon', 'avatar-1', 'avatar-5', 'badge-escape', 'badge-home', 'mob-marker', 'chase', 'watch', 'mountain-7', 'mountain-6', 'colt'];
  check('assets: the UI art ids are all built in', uiIds.every((id) => builtInIds().includes(id)));
  useManifest(manifest);
  check('assets: assetUrl resolves an id and refuses an unknown one', assetUrl('badge-home') === 'assets/badge-home.webp' && assetUrl('card-nope-7') === null);
  check('assets: an unknown id gives a text chip, not a broken image', /asset-chip/.test(img('nope', { label: 'Nope' })) && !/<img/.test(img('nope')));
  useManifest({ assets: [] });
  const chipFace = cardImg('escape-7');
  useManifest({ assets: [{ id: 'card-escape-7', file: 'cards/card-escape-7.webp', width: 300, height: 428 }] });
  const artFace = cardImg('escape-7');
  useManifest(manifest);
  check('assets: a card with no art is drawn as a face with its number, suit shape and a label', /cardchip--escape/.test(chipFace) && />7</.test(chipFace) && /aria-label="Escape 7"/.test(chipFace));
  check('assets: a card with art is an <img> by manifest id', /<img/.test(artFace) && artFace.includes('cards/card-escape-7.webp'));
  check('assets: the card back and a badge fall back too', !BAD.test(cardBackImg()) && !BAD.test(badgeImg('home')));
}

// ---------- sentences ----------
{
  const names = ['Mia', 'Sam', 'Ann', 'Bo'];
  const g = position({ hands: [['home-7', 'home-1', 'escape-1'], ['climb-4', 'climb-2', 'escape-2'], ['home-2', 'climb-3', 'escape-3'], ['home-9', 'climb-9', 'escape-4']], leader: 0 });
  const ev = play(g, 'home-7', 'climb-4');
  const won = ev.find((e) => e.type === 'trick-won');
  const s = trickSentence(g.tricks[0], won, names);
  check('sentence: an off-suit card in the climb is named as a break-away; the winner is named', /^Mia led Home 7; Sam had no Home and threw Climb 4 \(the mob breaks away a step\); Ann followed with Home 2; Bo followed with Home 9 and wins\.$/.test(s), s);
  check('banner: says who won with what, and which way', winnerBanner({ winner: 1, card: 'home-4', phase: 'descent' }, names) === 'Sam wins with Home 4 (lowest wins the descent)');
  check('banner: second person for You', winnerBanner({ winner: 0, card: 'home-9', phase: 'climb' }, ['You', 'Sam']) === 'You win with Home 9 (highest wins the climb)');
  check('phase banner: the climb, the summit, the descent', phaseText('climb') === 'The climb: highest wins' && phaseText('descent') === 'The descent: lowest wins' && /Chase or Watch/.test(phaseText('summit')));
}
{
  const names = ['Ann', 'Bo', 'Cy'];
  const mk = (tied, winners, shared, used, mobsHome) => ({ tiedOnTotal: tied, winners, shared, tiebreakUsed: used, winningScore: 14, mobsHome, ranking: [] });
  const t1 = tiebreakText(mk([0, 1], [1], false, true, [0, 2, 1]), names);
  check('tiebreak text: mobs brought home decides, tied players only', /^Ann and Bo tied on 14\. Tiebreak: who brought the mob home most often\. Mobs brought home: Ann 0, Bo 2\. Bo wins\.$/.test(t1), t1);
  const t2 = tiebreakText(mk([0, 1], [0, 1], true, false, [1, 1, 0]), names);
  check('tiebreak text: a shared win says shared', /Still level, so the win is shared\.$/.test(t2), t2);
  const t3 = tiebreakText(mk([0, 1, 2], [0, 1], true, true, [1, 1, 0]), names);
  check('tiebreak text: a three-way tie with two level on mobs home shares between those two', /^Ann, Bo and Cy tied on 14\. Tiebreak: who brought the mob home most often\. Mobs brought home: Ann 1, Bo 1, Cy 0\. Ann and Bo share the win\.$/.test(t3), t3);
  check('tiebreak text: no tie at the top says nothing', tiebreakText(mk([0], [0], false, false, [0, 0, 0]), names) === '');
  check('tied groups: only groups of two or more', JSON.stringify(tiedGroups({ ranking: [{ seat: 0, total: 9 }, { seat: 1, total: 9 }, { seat: 2, total: 4 }] })) === '[[0,1]]');
  check('hand end text: names every score', handEndText({ handNo: 0, scores: [3, 5, -1] }, names) === 'Hand 1 scores: Ann 3, Bo 5, Cy -1.');
  check('waiting text: bot, human, You, the summit and the end', waitingText({ phase: 'climb', toAct: 1 }, names, ['human', 'easy', 'human']) === 'Bo is thinking.'
    && waitingText({ phase: 'descent', toAct: 0 }, ['You', 'x'], ['human', 'easy']) === 'You are to play.' && /choosing Chase or Watch in secret/.test(waitingText({ phase: 'summit', toAct: 1 }, names, []))
    && waitingText({ phase: 'over', toAct: null }, names, []) === 'Game over.');
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
  check('preview (climb): a card that cannot beat the lead says so, with who is ahead', lose.kind === 'follow' && !lose.wins && lose.winnerSeat === 0 && lose.winnerCard === 'home-8' && lose.remaining === 2);
  check('preview (climb): a card that beats the lead says it would win as it stands', win.wins && !win.final && win.remaining === 2);
  check('preview: a card that may not be played has no hint', previewCard(g, 'escape-2') === null && previewCard(g, 'nope') === null);
  play(g, 'home-9', 'home-3');
  const last = previewCard(g, 'home-4');
  const lastWin = previewCard(g, 'home-10');
  check('preview: the last card of a trick knows the final result and the marker step', last.final && !last.wins && last.winnerSeat === 1 && lastWin.final && lastWin.wins && last.markerSteps === 1);
  check('preview text: reads as English with no raw values', [lead, lose, win, last, lastWin].every((p) => !BAD.test(previewText(p, ['A', 'B', 'C', 'D'])) && previewText(p, ['A', 'B', 'C', 'D']).length > 10));
  check('cloneState: a deep, independent copy', (() => { const c = cloneState(g); c.hands[0].pop(); c.totals[0] = 99; return g.totals[0] !== 99 && JSON.stringify(cloneState(g)) === JSON.stringify(g); })());
  const d = position({ hands: [['home-8', 'home-1', 'escape-1'], ['home-2', 'home-9', 'escape-2'], ['home-3', 'home-5', 'escape-3'], ['home-4', 'home-10', 'escape-4']], leader: 0, phase: 'descent' });
  play(d, 'home-8');
  check('preview (descent): the lowest card of the suit led would win', previewCard(d, 'home-2').wins && !previewCard(d, 'home-9').wins);
}

// ---------- the table model: events land exactly on the live state ----------
{
  let actions = 0; let drift = 0; let firstDrift = ''; let framesBad = 0; let modals = 0; let handEnds = 0; let decided = 0; let tricks = 0; let games = 0; let leaks = 0; let summits = 0;
  for (let seed = 1; seed <= 12; seed++) {
    for (const players of [2, 3, 4, 5]) {
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
            if (f.kind === 'summit-revealed') summits++;
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
  check('board: frames are well formed (a decided beat per trick, one modal per hand end, a reveal beat)', framesBad === 0 && modals === handEnds && handEnds > 100 && decided === tricks && tricks > 1000 && summits > 100, `bad ${framesBad}, modals ${modals}, hand ends ${handEnds}, decided ${decided}, tricks ${tricks}, reveals ${summits}`);
  check('board: no frame ever holds a summit choice before the reveal (R12.5)', leaks === 0, `${leaks}`);
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
  check('landing: a radio per player count and five seat forms', PLAYER_COUNTS.every((n) => html.includes(`name="players" value="${n}"`)) && (html.match(/class="seatform"/g) || []).length === 5);
  check('landing: no Playtest rules panel and no non-standard note (there are no switches)', !('rulesPanelHtml' in landing) && !/Playtest/i.test(html) && !/non-standard/i.test(html) && !/class="rule"|rules-panel|rules-note/.test(html));
  check('landing: the hero art, the hook, 2-5 players / 20-30 min / ages 10+', /data-asset="hero-wide"/.test(html) && html.includes('High wins the climb. Low wins the descent.') && GAME_TAGLINE === 'High wins the climb. Low wins the descent.'
    && AT_A_GLANCE.players === '2-5' && AT_A_GLANCE.minutes === '20-30' && AT_A_GLANCE.age === '10+' && />10\+</.test(html) && !/>8\+</.test(html));
  check('landing: the footer names the rule book version it links to', FOOTER_VERSION === 'Rule book v3' && /rule-book-v3\.pdf$/.test(RULEBOOK_URL) && html.includes('Rule book v3'));
  check('landing: setup says to set every seat to a bot to watch', /Set every seat to a bot to watch a game/.test(html));
  check('landing: Play forced cards for me is off by default and explained', /Play forced cards for me/.test(html) && !/id="autoPlayForced" checked/.test(html));
  check('landing: How to play (climb, summit, descent) and the rule book link are on the page', /How to play/.test(html) && /Chase/.test(howToPlayHtml()) && /lowest/.test(howToPlayHtml()) && html.includes(RULEBOOK_URL) && howToPlayHtml().includes(RULEBOOK_URL) && RULEBOOK_URL === 'rules/snowy-river-rule-book-v3.pdf');
  check('landing: the bug-free text (no undefined / NaN / [object])', !BAD.test(html) && !BAD.test(howToPlayHtml()));
  check('landing: the contact for bug reports is not on the page as a raw address', !/@/.test(html));
  check('seat menu: human and the three levels, a missing level disabled', /value="human"/.test(seatTypeOptions(levels, 'human')) && /value="hard"/.test(seatTypeOptions(levels, 'easy'))
    && /disabled/.test(seatTypeOptions(levels.filter((l) => l.id !== 'hard'), 'easy')));
  check('seat menu: simulator-only bots are not offered', !/value="high"/.test(seatTypeOptions(levels, 'easy')) && !/value="low"/.test(seatTypeOptions(levels, 'easy')));
  check('setup: names made unique, case-insensitive', JSON.stringify(uniqueNames(['Sam', 'sam', '', 'Ann', 'SAM'])) === '["Sam","sam 2","","Ann","SAM 3"]');
  check('setup: the rules code of a setup is always std', safeCode(DEFAULT_SETUP) === 'std' && safeCode({ players: 4, rules: { TRUMP: 'red' } }) === 'std');
  check('setup: humans counted over the seats in play only', humanCount({ players: 3, seats: [{ type: 'human' }, { type: 'easy' }, { type: 'human' }, { type: 'human' }] }) === 2);
}

// ---------- pass-and-play: hands stay hidden ----------
{
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  const mk = (seats, reveal) => {
    const ctl = createController({ seats, seed: 21 });
    if (reveal !== undefined) ctl.reveal(reveal);
    return ctl;
  };
  const lone = mk([{ type: 'human' }, { type: 'easy' }, { type: 'easy' }]);
  const vmLone = makeVm({ ctl: lone, ui, board: boardFromState(lone.state, lone.humanSeats), log: [] });
  check('viewmodel: a lone human always has their hand on show, with a reason or a hint on every card when it is their turn', vmLone.hand !== null && vmLone.hand.length === 12 && (!vmLone.myTurn || vmLone.hand.every((c) => vmLone.reasons.has(c))));
  const duo = mk([{ type: 'human', name: 'A' }, { type: 'human', name: 'B' }, { type: 'easy' }]);
  const vmCover = makeVm({ ctl: duo, ui, board: boardFromState(duo.state, duo.humanSeats), log: [] });
  check('viewmodel: with two humans no hand is shown until the next human confirms', duo.needsHandoff() ? vmCover.hand === null : true);
  if (duo.isHumanTurn()) duo.reveal(duo.toAct());
  const vmShown = makeVm({ ctl: duo, ui, board: boardFromState(duo.state, duo.humanSeats), log: [] });
  check('viewmodel: after the cover is confirmed the hand of that human is shown', !duo.isHumanTurn() || (vmShown.hand !== null && vmShown.shown === duo.toAct()));
  const cover = coverHtml({ names: duo.names }, 1);
  check('cover: names the player and shows no card, trick or score', /Pass to B/.test(cover) && !/class="hand"|cardimg|cardchip|tplay|Total/.test(cover));
  check('cover: at the summit it asks for a secret Chase or Watch', /Chase or Watch in secret/.test(coverHtml({ names: duo.names, phase: 'summit' }, 1)));
  const replay = makeVm({ ctl: duo, ui: { ...ui, frame: { board: boardFromState(duo.state, duo.humanSeats) } }, board: boardFromState(duo.state, duo.humanSeats), log: [] });
  check('viewmodel: while a replay frame is on screen with two humans, no hand is shown', replay.hand === null || replay.shown === null);
}

// ---------- the summit decision on screen ----------
{
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  let found = null;
  for (let seed = 1; seed < 60 && !found; seed++) {
    const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed });
    const rng = makeRng(`sd${seed}`);
    let guard = 0;
    while (!ctl.isFinished() && guard++ < 500) {
      ctl.runBots();
      if (!ctl.isHumanTurn()) continue;
      if (ctl.state.phase === 'summit') { found = ctl; break; }
      ctl.play(rngPick(rng, ctl.legalActions()));
    }
  }
  check('summit: a human reaches a summit decision', !!found);
  if (found) {
    const vm = makeVm({ ctl: found, ui, board: boardFromState(found.state, found.humanSeats), log: [] });
    const box = handBoxHtml(vm);
    const modal = summitModalHtml(vm);
    const st = stakesText(found.view(0));
    const v0 = found.view(0);
    const pts = (k) => `${k} point${k === 1 ? '' : 's'}`;
    check('summit: a modal step with a Chase card and a Watch card as buttons, each with its stakes (R12.10)', (modal.match(/data-action="decide"/g) || []).length === 2 && modal.includes('"choice":"chase"') && modal.includes('"choice":"watch"') && modal.includes(st.chase) && modal.includes(st.watch)
      && /data-asset="chase"/.test(modal) && /data-asset="watch"/.test(modal) && /role="dialog"/.test(modal) && !BAD.test(modal));
    check('summit: the stakes read as the rule book words them (risk your N climb points for the mob worth M; if you fall -1 / bank N)', st.chase === `Chase: risk your ${v0.stakes.climbTricks} climb ${v0.stakes.climbTricks === 1 ? 'point' : 'points'} for the mob, worth ${v0.stakes.mob}; if you fall, -1.` && st.watch === `Watch: bank ${pts(v0.stakes.climbTricks)}.`);
    check('summit: the hand box itself carries no decision and the modal names no side', !/data-action="decide"/.test(box) && !/schip--chase|schip--watch/.test(modal));
    check('summit: not shown to a seat that is not deciding', summitModalHtml({ ...vm, myTurn: false }) === '' && summitModalHtml({ ...vm, state: { ...vm.state, phase: 'climb' } }) === '');
    check('summit: no card is playable during the summit', !/is-legal/.test(box));
    check('summit: the turn prompt states the stakes', /Choose in secret/.test(turnPrompt(found.view(0))));
    const others = [1, 2, 3].map((s) => found.state.choices[s]).filter(Boolean);
    const table = tableHtml(vm);
    check('summit: the table shows locked-in seats as face down, never their side', !found.state.revealed && (others.length === 0 || (/face down/.test(table) && !/schip--chase|schip--watch/.test(table))));
  }
}

// ---------- screens ----------
{
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 31 });
  let guard = 0; let screens = 0; let bad = '';
  const rng = makeRng('scr');
  let sawSummary = false; let sawEnd = false; let checkedHand = false;
  while (guard++ < 600) {
    ctl.runBots();
    const board = boardFromState(ctl.state, ctl.humanSeats);
    const vm = makeVm({ ctl, ui, board, log: ctl.log.map((l) => ({ text: l.text, kind: 'info' })) });
    const html = [tableHtml(vm), handBoxHtml(vm), sideHtml(vm), statusHtml(vm)].join('');
    screens++;
    if (BAD.test(html) && !bad) bad = (html.match(/.{40}(undefined|NaN|\[object).{20}/) || ['?'])[0];
    if (ctl.isFinished()) {
      const end = gameEndHtml(vm) + endBarHtml(vm);
      if (BAD.test(end) && !bad) bad = 'end';
      sawEnd = true;
      check('end screen: ranks everyone, names a winner, offers Play again and Stats', (end.match(/class="rank/g) || []).length >= 4 && /Play again/.test(end) && /data-action="open-stats"/.test(end) && /home/.test(end));
      break;
    }
    if (ctl.state.handLog.length && !sawSummary) {
      const rec = ctl.state.handLog[0];
      const html2 = handSummaryHtml(vm, { kind: 'hand', handNo: 0, event: { ...rec, totals: rec.totalsAfter } });
      sawSummary = true;
      check('hand summary: a row per player with choice, climb, descent, outcome and score, and a Deal the next hand button', (html2.match(/class="reck__row/g) || []).length === 4 && /Deal the next hand/.test(html2) && /(Watched|Brought the mob home|Fell)/.test(html2) && !BAD.test(html2));
    }
    if (ctl.isHumanTurn()) {
      const legal = ctl.legalActions();
      if (!checkedHand && isCardPhase(ctl.state.phase)) {
        const myHtml = handBoxHtml(vm);
        checkedHand = true;
        check('hand: every playable card is a button, every other dimmed with its reason', (myHtml.match(/is-legal/g) || []).length === legal.length && (myHtml.match(/is-blocked/g) || []).length === vm.hand.length - legal.length);
      }
      ctl.play(rngPick(rng, legal));
    }
  }
  check('screens: the table, hand, side and status render for the whole game with no raw values', screens > 20 && !bad, bad);
  check('screens: the summary and the end screen were both reached', sawSummary && sawEnd);
  check('screens: the Mountain shows the summit step for the player count', /of 7/.test(tableHtml(makeVm({ ctl, ui, board: boardFromState(ctl.state, ctl.humanSeats), log: [] }))));
}

// ---------- the Mountain card, the marker and the Colt ----------
{
  check('mountain: both sides have a printed circle table (8 steps for 0-7, 7 for 0-6), each climbing the slope', MOUNTAIN_STEPS['0-7'].length === 8 && MOUNTAIN_STEPS['0-6'].length === 7
    && Object.values(MOUNTAIN_STEPS).every((pts) => pts.every((p, i) => i === 0 || p[1] < pts[i - 1][1])));
  check('mountain: the two sides do not share positions', JSON.stringify(MOUNTAIN_STEPS['0-7'].slice(0, 7)) !== JSON.stringify(MOUNTAIN_STEPS['0-6']));
  check('mountain: step positions are percentages of the card and inside it', Object.keys(MOUNTAIN_STEPS).every((side) => MOUNTAIN_STEPS[side].every((_, k) => { const [x, y] = stepPosition(side, k); return x > 0 && x < 100 && y > 0 && y < 100; })));
  const mk = (players) => { const ctl = createController({ seats: Array.from({ length: players }, (_, i) => ({ type: i === 0 ? 'human' : 'easy' })), seed: 5 }); return makeVm({ ctl, ui: { selected: null, note: '', panels: {}, frame: null, modal: null }, board: boardFromState(ctl.state, ctl.humanSeats), log: [] }); };
  const m2 = mountainHtml(mk(2)); const m4 = mountainHtml(mk(4)); const m5 = mountainHtml(mk(5));
  check('mountain: the 0-7 card for 2 and 4 players, the 0-6 card for 5', /data-asset="mountain-7"/.test(m2) && /data-asset="mountain-7"/.test(m4) && /data-asset="mountain-6"/.test(m5) && /step <b data-marker>0<\/b> of 6/.test(m5) && /of 7/.test(m4));
  const [l0, t0] = stepPosition('0-7', 0);
  check('mountain: the marker sits on step 0 at the measured spot', m4.includes(`style="left:${l0}%;top:${t0}%"`) && /data-step="0"/.test(m4));
  const vmB = mk(4);
  const b3 = { ...vmB.board, marker: 3, brumbies: 2, mob: 7, phase: 'climb' };
  const mm = mountainHtml({ ...vmB, board: b3 });
  const [l3, t3] = stepPosition('0-7', 3);
  check('mountain: the marker moves to the step it is on', mm.includes(`style="left:${l3}%;top:${t3}%"`) && /data-step="3"/.test(mm));
  const colt0 = coltHtml(vmB);
  const colt2 = coltHtml({ ...vmB, board: { ...vmB.board, brumbies: 2, mob: 7 } });
  const colt4 = coltHtml({ ...vmB, board: { ...vmB.board, brumbies: 4, mob: 11 } });
  check('colt: the Colt card with 0, 2 and 4 Brumby cards tucked under it and the mob value', (colt0.match(/class="brumby"/g) || []).length === 0 && (colt2.match(/class="brumby"/g) || []).length === 2 && (colt4.match(/class="brumby"/g) || []).length === 4
    && /data-asset="colt"/.test(colt2) && /data-asset="brumby-front"/.test(colt2) && /data-mob>7</.test(colt2) && /data-mob>11</.test(colt4) && /data-mob>3</.test(colt0));
  check('colt: a stack that grew after this hand was dealt shows the next value, and no raw values appear', /Next hand: 9/.test(coltHtml({ ...vmB, board: { ...vmB.board, brumbies: 3, mob: 7 } })) && !BAD.test(colt2 + colt4 + mm));
  check('callouts: the first step is the climb trick, later steps are off-suit steps', stepCallout({ step: 1 }).off === false && stepCallout({ step: 2 }).off === true && stepCallout({ step: 3 }).text === '+1 off-suit' && stepCallout(null) === null);
  check('phase banner: the parts split on the colon', phaseParts('climb').name === 'The climb' && phaseParts('climb').rule === 'highest wins' && phaseParts('descent').rule === 'lowest wins' && phaseParts('summit').name === 'The summit');
  const status = statusHtml({ ...vmB, board: { ...vmB.board, phase: 'descent' }, myTurn: false, view: null, frame: null });
  check('phase banner: THE DESCENT lowest wins is on the screen', /phasebar--descent/.test(status) && /The descent/.test(status) && /lowest wins/.test(status) && /aria-label="The descent: lowest wins"/.test(status));
  check('phase banner: THE CLIMB highest wins, and the summit', /highest wins/.test(statusHtml({ ...vmB, myTurn: false, view: null, frame: null })) && /phasebar--summit/.test(statusHtml({ ...vmB, board: { ...vmB.board, phase: 'summit' }, myTurn: false, view: null, frame: null })));
}

// ---------- the marker walks one step at a time ----------
{
  let moves = 0; let stepFrames = 0; let bad = 0; let offFrames = 0; let steps = 0;
  for (let seed = 1; seed <= 6; seed++) {
    for (const players of [2, 3, 4, 5]) {
      const { state } = startGame({ seed: seed * 13 + players, players });
      let board = boardFromState(state, [0]);
      const rng = makeRng(`mv${seed}${players}`);
      const names = Array.from({ length: players }, (_, i) => `P${i + 1}`);
      while (state.phase !== 'over') {
        const events = applyAction(state, rngPick(rng, getValidActions(state)));
        const frames = buildFrames(board, events, { names, describe: describeEvent, trickText: trickSentence, liveHands: (s) => state.hands[s] });
        if (frames.length) board = frames[frames.length - 1].board;
        for (const ev of events.filter((e) => e.type === 'marker-moved')) {
          moves++;
          const mine = frames.filter((f) => f.kind === 'marker-moved' && f.board.fx && f.board.fx.marker && f.board.fx.marker.from === ev.from && f.board.fx.marker.to === ev.to);
          const want = ev.to - ev.from;
          stepFrames += mine.length; steps += want;
          if (mine.length !== want) bad++;
          mine.forEach((f, i) => {
            if (f.board.marker !== ev.from + i + 1 || f.board.fx.marker.step !== i + 1) bad++;
            if ((f.board.fx.marker.step > 1) !== stepCallout(f.board.fx.marker).off) bad++;
            if (stepCallout(f.board.fx.marker).off) offFrames++;
            if ((i === mine.length - 1) !== !!f.log) bad++;
          });
        }
      }
    }
  }
  check('marker: one beat per step (the base step then one per off-suit card), the last carrying the log', moves > 200 && bad === 0 && stepFrames === steps, `${moves} moves, ${stepFrames} frames for ${steps} steps, ${bad} bad`);
  check('marker: off-suit steps exist and are called out', offFrames > 20, `${offFrames}`);
}

// ---------- who is at the heels, the reveal, and every reckoning case ----------
{
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  const b = (over) => ({ n: 4, phase: 'descent', descentTricks: [1, 2, 2, 0], lastDescentWin: [0, 1, 3, -1], ...over });
  check('heels: the most descent tricks, a tie to the later trick (the engine rule), none outside the descent or before a trick', heelsSeat(b()) === 2 && heelsSeat(b({ lastDescentWin: [0, 4, 3, -1] })) === 1 && heelsSeat(b({ phase: 'climb' })) === null && heelsSeat(b({ descentTricks: [0, 0, 0, 0] })) === null);
  // a descent in progress shows the At the heels tag, the marker line and a sideways pile
  let seen = null;
  for (let seed = 1; seed < 40 && !seen; seed++) {
    const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed, autoPlayForced: true });
    const rng = makeRng(`hl${seed}`);
    let guard = 0;
    while (!ctl.isFinished() && guard++ < 600 && !seen) {
      ctl.runBots();
      if (!ctl.isHumanTurn()) continue;
      if (ctl.state.phase === 'descent' && ctl.state.descentTricks.some((d) => d > 0)) { seen = ctl; break; }
      ctl.play(rngPick(rng, ctl.legalActions()));
    }
  }
  check('heels: a descent in progress is reached', !!seen);
  if (seen) {
    const vm = makeVm({ ctl: seen, ui, board: boardFromState(seen.state, seen.humanSeats), log: [] });
    const html = tableHtml(vm);
    check('heels: the seat at the heels is tagged and the Mountain says who, descent piles are shown separately from climb piles', (html.match(/tag--heels/g) || []).length === 1 && /At the mob's heels: <b>/.test(html) && /pile--descent/.test(html) && /pile--climb/.test(html) && /mini--side/.test(html));
    check('heels: THE DESCENT banner on screen', /phasebar--descent/.test(html) && /lowest wins/.test(html));
  }
  // the reveal overlay: faces for every seat
  const ctl = createController({ seats: [{ type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 8 });
  ctl.runBots();
  const names = ctl.names;
  const bd = { ...boardFromState(ctl.state, []), revealed: true, choices: ['chase', 'watch', 'chase'], choiceOrder: [1, 2, 0], banner: { kind: 'reveal', chasers: [0, 2] } };
  const vmR = makeVm({ ctl, ui: { ...ui, frame: { board: bd } }, board: bd, log: [] });
  const rv = revealHtml(vmR);
  check('reveal: a Chase or Watch card face per seat, in summit order, with who chose what in words', (rv.match(/class="reveal__seat/g) || []).length === 3 && (rv.match(/data-asset="chase"/g) || []).length === 2 && (rv.match(/data-asset="watch"/g) || []).length === 1 && /chase; /.test(rv) && !BAD.test(rv));
  check('reveal: nothing is shown before the reveal', revealHtml({ ...vmR, board: { ...bd, revealed: false } }) === '');
  const nb = { ...bd, choices: ['watch', 'watch', 'watch'], banner: { kind: 'nobody', mob: 3 } };
  check('reveal: the nobody-chases end says so', /Nobody chased/.test(revealHtml({ ...vmR, board: nb })) && /hand ends here/.test(revealHtml({ ...vmR, board: nb })));
  check('banners: heels, home, escape and Brumby lines', /at the mob's heels with 3 descent tricks, winning the later/.test(bannerText({ kind: 'heels', seat: 1, tricks: 3, tie: true }, names, bd))
    && /brings the mob home: 4 \+ 7 = 11 points/.test(bannerText({ kind: 'home', seat: 0, mob: 7, climbTricks: 4, score: 11 }, names, bd))
    && /watched from the top, so the mob escapes and every chaser falls/.test(bannerText({ kind: 'escaped', reason: 'watcher-at-heels', heels: 2, fallen: [0] }, names, bd))
    && /already under the Colt/.test(bannerText({ kind: 'brumby', added: false, atCap: true, brumbies: 4, nextMob: 11 }, names, bd)) && /Brumby card goes under the Colt: the mob will be worth 5/.test(bannerText({ kind: 'brumby', added: true, brumbies: 1, nextMob: 5 }, names, bd)));

  // the reckoning, every case, from real hands played by bots (and the capped Brumby case from a real record)
  const cases = { nobody: null, home: null, escaped: null, fell: null, tie: null };
  for (let seed = 1; seed < 80; seed++) {
    const c = createController({ seats: [{ type: 'easy' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed });
    c.runBots();
    for (const rec of c.state.handLog) {
      const kind = rec.endReason === 'nobody-chases' ? 'nobody' : rec.broughtHomeBy !== null ? 'home' : 'escaped';
      if (!cases[kind]) cases[kind] = { c, rec };
      if (rec.outcomes.includes('fell') && !cases.fell) cases.fell = { c, rec };
      if (rec.tieAtHeels && !cases.tie) cases.tie = { c, rec };
    }
    if (Object.values(cases).every(Boolean)) break;
  }
  check('reckoning: a real hand of every kind was found (nobody chases, mob home, escape, a fall, a tie at the heels)', Object.values(cases).every(Boolean), Object.entries(cases).filter(([, v]) => !v).map(([k]) => k).join(','));
  const sum = (x, patch = {}) => { const vmx = makeVm({ ctl: x.c, ui, board: boardFromState(x.c.state, []), log: [] }); return handSummaryHtml(vmx, { kind: 'hand', handNo: x.rec.handNo, event: { ...x.rec, totals: x.rec.totalsAfter, ...patch } }); };
  if (Object.values(cases).every(Boolean)) {
    const hNobody = sum(cases.nobody); const hHome = sum(cases.home); const hEsc = sum(cases.escaped); const hFell = sum(cases.fell); const hTie = sum(cases.tie);
    check('reckoning: nobody chased', /end--nobody/.test(hNobody) && /Nobody chased/.test(hNobody) && !/reck__row--fell|reck__row--home/.test(hNobody) && /Watched/.test(hNobody));
    check('reckoning: mob home (climb + mob, the Brumby cards go back, others fell or watched)', /end--home/.test(hHome) && /brought it home/.test(hHome) && /reck__row--home/.test(hHome) && /climb \+ \d+ mob/.test(hHome) && /go back to the box/.test(hHome));
    check('reckoning: a watcher at the heels lets the mob escape, the chasers fall, a Brumby card is added', /end--escaped/.test(hEsc) && /watched, so the mob escaped/.test(hEsc) && /(A Brumby card goes under the Colt|already under the Colt)/.test(hEsc));
    check('reckoning: a fall is -1 and says what was lost', /reck__row--fell/.test(hFell) && /Fell: -1/.test(hFell) && /class="reck__score"[^>]*>-1</.test(hFell));
    check('reckoning: a tie at the heels is explained', /Level on descent tricks, .+ won the later one/.test(hTie));
    const capped = sum(cases.escaped, { brumbyAdded: false, brumbyAtCap: true, brumbiesAfter: 4 });
    check('reckoning: at the cap no Brumby card is added and it says so', /All 4 Brumby cards are already under the Colt, so nothing is added/.test(capped) && !BAD.test(capped));
    check('reckoning: every row has the choice card, the sums and the running total, no raw values', [hNobody, hHome, hEsc, hFell, hTie].every((h) => (h.match(/class="reck__row/g) || []).length === 4 && /reck__choice/.test(h) && /reck__total/.test(h) && !BAD.test(h)));
  }
}

// ---------- the seat panel: tricks big, cards in hand small ----------
{
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }], seed: 17 });
  const base = makeVm({ ctl, ui, board: boardFromState(ctl.state, ctl.humanSeats), log: [] });
  const seat = seatHtml(base, 1, 'r1');
  check('seat: the cards in hand are a small line under the name and level ("12 cards"); no big number or caption', /class="seat__id"><b class="seat__name">[^<]*<\/b><span class="badge[^"]*">[^<]*<\/span><span class="seat__hand"[^>]*><b class="seat__cardsnum" data-cards="1">12<\/b> cards<\/span><\/div>/.test(seat) && !/seat__cards"|cards in hand<\/small>/.test(seat));
  check('seat: one card reads "1 card"', /<b class="seat__cardsnum" data-cards="1">1<\/b> card</.test(seatHtml({ ...base, board: { ...base.board, handCounts: [3, 1, 3] } }, 1, 'r1')));
  const bd = { ...base.board, phase: 'descent', descentTricks: [0, 2, 1], lastDescentWin: [-1, 3, 1], dealer: 1 };
  const heelsSeatHtml = seatHtml({ ...base, board: bd }, 1, 'r1');
  const iHeels = heelsSeatHtml.indexOf('tag--heels'); const iDealer = heelsSeatHtml.indexOf('tag--dealer'); const iDescent = heelsSeatHtml.indexOf('pile--descent'); const iClimb = heelsSeatHtml.indexOf('pile--climb');
  check('seat: the descent pile comes before the climb pile, rings when at the heels, and the heels tag sits directly above them, before the dealer tag', iDescent > 0 && iClimb > iDescent && /pile--descent[^"]* is-heels/.test(heelsSeatHtml) && iHeels > 0 && iHeels < iDealer && iDealer < iDescent, `${iHeels} ${iDealer} ${iDescent} ${iClimb}`);
  check('seat: both piles carry their label, count and sideways / upright cards', /pile--descent[\s\S]*mini--side[\s\S]*<b>2<\/b><i>descent<\/i>/.test(heelsSeatHtml) && /pile--climb[\s\S]*<b>\d+<\/b><i>climb<\/i>/.test(heelsSeatHtml));
}

// ---------- the range 1-12, the goal of the descent, the heels standing, the rule at the summit ----------
{
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 33 });
  const base = makeVm({ ctl, ui, board: boardFromState(ctl.state, ctl.humanSeats), log: [] });
  const withB = (o) => ({ ...base, board: { ...base.board, ...o }, myTurn: false, view: null, frame: null });
  const names = base.names;
  for (const ph of ['climb', 'summit', 'descent']) {
    const html = statusHtml(withB({ phase: ph, revealed: false }));
    check(`range: the ${ph} banner states that cards run 1 to 12 in each suit`, /<strong class="phasebar__range">Cards run 1 to 12 in each suit<\/strong>/.test(html));
  }
  check('range: the climb banner says 12 is best, the descent banner says 1 is best, the summit names neither', /highest wins <em class="phasebar__best">\(12 is best\)/.test(statusHtml(withB({ phase: 'climb' }))) && /lowest wins <em class="phasebar__best">\(1 is best\)/.test(statusHtml(withB({ phase: 'descent' }))) && !/phasebar__best/.test(statusHtml(withB({ phase: 'summit' }))));
  check('range: the aria label of the banner keeps the plain rule text', /aria-label="The climb: highest wins"/.test(statusHtml(withB({ phase: 'climb' }))));
  check('range: the hand box says each suit runs 1 to 12, and the landing How to play says it in step 1', /sorted by suit; each suit runs 1 to 12/.test(handBoxHtml({ ...base, hand: base.hand || ['home-1'], myTurn: false, reasons: new Map(), hints: new Map() })) && /each running 1 to 12/.test(howToPlayHtml()));

  // the goal of the descent
  const dn = ['You', 'Ann', 'Bo', 'Cy'];
  const bd = (choices, phase = 'descent', revealed = true) => ({ phase, revealed, choices });
  const g1 = descentGoal(bd(['chase', 'watch', 'chase', 'watch']), dn, [0]);
  const g2 = descentGoal(bd(['watch', 'chase', 'watch', 'watch']), dn, [0]);
  check('goal: names the chasers and says win the MOST descent tricks to reach the heels, what a fall costs and what a watcher at the heels does', /^Chasers \(You and Bo\): win the MOST descent tricks to reach the mob's heels and bring the mob home\.$/.test(g1.main) && /falls \(-1\)/.test(g1.extra) && /watcher is at the heels, the mob escapes/.test(g1.extra) && /^Chaser \(Ann\): win the MOST/.test(g2.main));
  check('goal: a human who chased is told they need the most descent tricks; one who watched is told to block', g1.personal.length === 1 && g1.personal[0].text === 'You chased: you need the most descent tricks.' && g2.personal[0].text === 'You watched: block the chasers by winning descent tricks yourself.');
  const g3 = descentGoal(bd(['chase', 'watch', 'chase', 'watch']), ['Ann', 'Bo', 'Cy', 'Di'], [0, 1]);
  check('goal: with two humans each gets a line in the third person, in seat order', g3.personal.length === 2 && g3.personal[0].text === 'Ann chased: needs the most descent tricks.' && g3.personal[1].text === 'Bo watched: blocks the chasers by winning descent tricks.');
  check('goal: none outside the descent, before the cards are turned, or when nobody chased', descentGoal(bd(['chase', 'watch', 'chase', 'watch'], 'climb'), dn, [0]) === null && descentGoal(bd(['chase', 'watch', 'chase', 'watch'], 'descent', false), dn, [0]) === null && descentGoal(bd(['watch', 'watch', 'watch', 'watch']), dn, [0]) === null);
  const goalHtml = statusHtml(withB({ phase: 'descent', revealed: true, choices: ['watch', 'chase', 'chase', 'watch'] }));
  check('goal: the banner block carries the big goal line and the personal line for the human (watcher here)', /class="goal__main"/.test(goalHtml) && /goal__me goal__me--watch">You watched: block the chasers/.test(goalHtml) && !/goal__me--chase/.test(goalHtml) && !/class="goal"/.test(statusHtml(withB({ phase: 'climb' }))));
  check('goal: nothing in the status block is a raw value', !BAD.test(goalHtml));

  // who leads the heels race
  const sb = { descentTricks: [1, 3, 3, 0], lastDescentWin: [0, 2, 5, -1] };
  check('standing: the engine tie rule orders the race (3 v 3: the later trick leads), then the next', JSON.stringify(standing(sb, 2)) === '[2,1]' && JSON.stringify(standing(sb, 4)) === '[2,1,0,3]' && standing({ descentTricks: [0, 0], lastDescentWin: [-1, -1] }, 2).length === 2);
  const mh = mountainHtml({ ...base, board: { ...base.board, phase: 'descent', descentTricks: [1, 2, 0, 0], lastDescentWin: [0, 1, -1, -1] } });
  check('standing: the Mountain keeps its heels line and adds "Leading: X (2), next: Y (1)"', /At the mob's heels: <b>[^<]+<\/b> with 2 descent tricks/.test(mh) && /Leading: [^(]+ \(2\), next: [^(]+ \(1\)/.test(mh));
  const mh2 = mountainHtml({ ...base, board: { ...base.board, phase: 'descent', descentTricks: [0, 2, 0, 0], lastDescentWin: [-1, 1, -1, -1] } });
  check('standing: with only one seat on the board there is no "next" clause', /At the mob's heels/.test(mh2) && !/Leading:/.test(mh2));
}
{
  // the summit modal carries the rule
  const ui = { selected: null, note: '', panels: {}, frame: null, modal: null };
  let found = null;
  for (let seed = 1; seed < 60 && !found; seed++) {
    const c = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }], seed });
    const rng = makeRng(`rl${seed}`);
    let guard = 0;
    while (!c.isFinished() && guard++ < 500) { c.runBots(); if (!c.isHumanTurn()) continue; if (c.state.phase === 'summit') { found = c; break; } c.play(rngPick(rng, c.legalActions())); }
  }
  const modal = summitModalHtml(makeVm({ ctl: found, ui, board: boardFromState(found.state, found.humanSeats), log: [] }));
  check('summit: the modal states the rule under the stakes (win the most descent tricks; a tie goes to the later trick)', /<p class="summit__rule">To bring the mob home you must win the most descent tricks; a tie goes to whoever won the later trick\.<\/p>/.test(modal) && modal.indexOf('decide__stakes') < modal.indexOf('summit__rule'));
}

done();
