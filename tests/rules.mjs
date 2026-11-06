// rules.mjs - one check (or a few) per numbered rule of Snowy River, named by its number
// (R1.1 ... R18.5). It is the executable form of the rules. Hand-made positions cover what the Python
// simulator cannot (spec 15.3): the 4-Brumby cap, the escape in the last hand, hidden summit choices,
// the tiebreak by mobs brought home and the shared win, overshoot, a tie at the heels with a watcher
// among the tied, a chaser with no climb tricks who falls, the two-sided Mountain by player count.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import {
  startGame, createGame, applyAction, getValidActions, getPlayBlockReason, getActionBlockReason, trickWinner, gameResult, heelsOf,
  viewFor, legalActionsFromView, shownVoids, unknownCards, determinise, dealRespectingVoids,
  makeRng, rngNext, rngInt, rngPick, shuffle, deriveSeed, forkRng, hashSeed,
  fullDeck, sortCards, cardName, listCardNames, isCard, cardFace, cardSuit,
  VARIANTS, DEFAULT_RULES, CONSTANTS, SUITS, SUIT_NAMES, SUIT_ICONS, resolveVariants, rulesCode, deriveParams, describeEvent, describeAction,
} from '../src/engine/index.js';
import { suite, position, play, conservation, roundTrip, same, throws } from './lib.mjs';

const { check, done } = suite('rules');
const types = (evs) => evs.map((e) => e.type);
const NO_CARD_ID = /\b(escape|climb|descent|home)-\d/;

/** Plays a whole game with random legal cards and a summit policy; returns { state, events }. */
function randomGame(players, seed, choose = null, opts = {}) {
  const { state, events } = startGame({ seed, players, ...opts });
  const rng = makeRng(`rg:${seed}`);
  const all = [...events];
  let guard = 0;
  while (state.toAct !== null && guard++ < 5000) {
    const acts = getValidActions(state);
    const a = state.phase === 'summit' && choose ? { type: 'summit', choice: choose(state, rng) } : rngPick(rng, acts);
    all.push(...applyAction(state, a));
  }
  return { state, events: all };
}

// ---------- rng (kept from the kit) ----------
{
  const a = makeRng(7); const b = makeRng(7); const c = makeRng('7');
  const xs = Array.from({ length: 5 }, () => rngNext(a));
  const ys = Array.from({ length: 5 }, () => rngNext(b));
  check('rng: same seed, same stream', same(xs, ys));
  check('rng: a number seed and a string seed differ', rngNext(makeRng(7)) !== rngNext(c));
  check('rng: floats are in [0, 1)', xs.every((x) => x >= 0 && x < 1));
  check('rng: rngInt stays in range', Array.from({ length: 200 }, () => rngInt(a, 6)).every((x) => x >= 0 && x < 6));
  check('rng: a missing seed is refused', throws(() => makeRng(null)) && throws(() => makeRng(NaN)));
  const deck = shuffle(makeRng(1), fullDeck());
  check('rng: shuffle is a permutation', same([...deck].sort(), [...fullDeck()].sort()) && !same(deck, fullDeck()));
  check('rng: deriveSeed is a plain label', deriveSeed(4, 'bot', 2) === '4:bot:2' && hashSeed('x') === hashSeed('x'));
  const p = makeRng(3); const f = forkRng(p);
  check('rng: a fork is its own stream', f.s !== p.s && Number.isInteger(f.s));
}

// ---------- 1. components ----------
{
  const deck = fullDeck();
  check('R1.1: 48 horse cards, 4 suits x ranks 1 to 12, all unique', deck.length === 48 && new Set(deck).size === 48 && SUITS.length === 4 && deck.includes('escape-1') && deck.includes('home-12') && !deck.includes('home-13'));
  check('R1.2: suit names and icons (Escape trophy, Climb stockwhip, Descent hat, Home horseshoe)', SUIT_NAMES.escape === 'Escape' && SUIT_ICONS.escape === 'trophy' && SUIT_ICONS.climb === 'stockwhip' && SUIT_ICONS.descent === 'hat' && SUIT_ICONS.home === 'horseshoe');
  check('R1.3: suit ids 0..3 are Escape, Climb, Descent, Home; card ids <suit>-<rank>', same(SUITS, ['escape', 'climb', 'descent', 'home']) && deck[0] === 'escape-1' && deck[12] === 'climb-1' && deck[24] === 'descent-1' && deck[36] === 'home-1');
  check('R1.3: hands sort by suit in that order, then rank ascending', same(sortCards(['home-2', 'escape-12', 'escape-3', 'climb-1']), ['escape-3', 'escape-12', 'climb-1', 'home-2']));
  check('R1.3: names and lists read well', cardName('descent-7') === 'Descent 7' && listCardNames(['home-3', 'climb-4']) === 'Home 3 and Climb 4' && listCardNames(['home-3', 'climb-4', 'escape-1']) === 'Home 3, Climb 4 and Escape 1');
  check('R1.3: isCard accepts the deck and refuses the rest', deck.every(isCard) && !isCard('home-13') && !isCard('red-1') && !isCard(7) && !isCard('climb-0'));
  check('R1.3: one face asset per card', cardFace('escape-7') === 'card-escape-7');
  const P = (n) => deriveParams(resolveVariants({}), n);
  check('R1.5: two-sided Mountain card: summit 7 at 2-4 players (side 0-7), 6 at 5 (side 0-6)', [2, 3, 4].every((n) => P(n).summitStep === 7 && P(n).mountainSide === '0-7') && P(5).summitStep === 6 && P(5).mountainSide === '0-6');
  check('R1.7 / R1.8: the Colt is worth 3, each Brumby card 2, at most 4 Brumby cards (mob at most 11)', P(4).mobBase === 3 && P(4).brumbyValue === 2 && P(4).brumbyMax === 4 && P(4).mobMax === 11);
  check('R1.11: 2 to 5 players; 1 and 6 are refused', [2, 3, 4, 5].every((n) => P(n).n === n) && throws(() => P(1)) && throws(() => P(6)));
}

// ---------- 16. no variants (no Playtest switches) ----------
{
  check('R16: VARIANTS is empty and the standard rules are {}', VARIANTS.length === 0 && same(DEFAULT_RULES, {}) && same(resolveVariants({}), {}));
  check('R16: resolveVariants still throws on any rule name', throws(() => resolveVariants({ TRUMP: 'red' }), /Unknown rule/) && throws(() => createGame({ seed: 1, players: 3, rules: { MOB: '4' } }), /Unknown rule/));
  const table = [{ id: 'V9', name: 'X', code: 'x', values: ['a', 'b'], implemented: ['a'], default: 'a' }];
  check('R16: a declared but unimplemented value is refused (table shape kept)', throws(() => resolveVariants({ X: 'b' }, table), /not implemented/) && throws(() => resolveVariants({ X: 'c' }, table), /must be one of/));
  check('R16: rules_code is always std', rulesCode(resolveVariants({}), 4) === 'std' && rulesCode({}) === 'std' && [2, 3, 4, 5].every((n) => createGame({ seed: n, players: n }).rulesCode === 'std'));
  const saved = CONSTANTS.MOB_BASE;
  CONSTANTS.MOB_BASE = 4;
  const probe = createGame({ seed: 1, players: 4 });
  CONSTANTS.MOB_BASE = saved;
  check('R17: CONSTANTS is a live object a simulator probe can change; params are fixed at creation', probe.params.mobBase === 4 && probe.mob === 4 && createGame({ seed: 1, players: 4 }).mob === 3);
}

// ---------- 2. game structure / 3. the deal ----------
{
  const P = (n) => deriveParams(resolveVariants({}), n);
  check('R2.1: hands per game 3, 3, 4, 5 at 2, 3, 4, 5 players', [2, 3, 4, 5].map((n) => P(n).handsPerGame).join() === '3,3,4,5');
  const a = createGame({ seed: 5, players: 4 }); const b = createGame({ seed: 5, players: 4 }); const c = createGame({ seed: 6, players: 4 });
  check('R2.2: the first dealer is drawn from the seed (same seed, same game) or given', same(a, b) && !same(a.hands, c.hands) && createGame({ seed: 5, players: 4, firstDealer: 2 }).firstDealer === 2 && throws(() => createGame({ seed: 1, players: 4, firstDealer: 9 })));
  check('R2.2: a game needs a seed', throws(() => startGame({ players: 4 }), /seed/));
  for (const n of [2, 3, 4, 5]) {
    const { state } = randomGame(n, `rot${n}`, null, { firstDealer: 1 % n });
    const dealers = state.handLog.map((h) => h.dealer);
    const leaders = state.handLog.map((h) => h.firstLeader);
    check(`R2.3 ${n}p: the deal passes left each hand; the first leader is left of the dealer`, dealers.every((d, h) => d === (1 % n + h) % n) && leaders.every((l, h) => l === (dealers[h] + 1) % n) && state.handLog.length === P(n).handsPerGame);
  }
  {
    const { state } = randomGame(2, 'two', null, { firstDealer: 0 });
    check('R2.4: at two players one player deals twice (0, 1, 0)', same(state.handLog.map((h) => h.dealer), [0, 1, 0]));
  }
  for (const n of [2, 3, 4, 5]) {
    const g = createGame({ seed: 100 + n, players: n });
    const k = g.params.handSize;
    const want = { 2: [12, 24], 3: [12, 12], 4: [11, 4], 5: [9, 3] }[n];
    check(`R3.1 ${n}p: ${want[0]} cards each, ${want[1]} left out`, k === want[0] && g.hands.every((h) => h.length === k) && new Set(g.hands.flat()).size === n * k && g.out.length === want[1]);
    check(`R3.1 / R13.1 ${n}p: every card in exactly one place after the deal`, conservation(g).ok);
    check(`R4.1 ${n}p: the hand starts in the climb, led by the player left of the dealer`, g.phase === 'climb' && g.leader === (g.dealer + 1) % n && g.toAct === g.leader);
    check(`R2.6 / R2.7 ${n}p: marker on step 0, choices unchosen, piles empty, no Brumby cards, mob 3`, g.marker === 0 && g.choices.every((x) => x === null) && g.climbPiles.every((p) => p.length === 0) && g.brumbies === 0 && g.mob === 3 && g.totals.every((t) => t === 0));
  }
  const fixed = startGame({ seed: 1, players: 4, deals: [{ hands: Array.from({ length: 4 }, (_, i) => fullDeck().slice(i * 11, i * 11 + 11)) }] });
  check('R3.3: a fixed deal is used as given (fixtures record hands, never shuffles)', fixed.state.hands[0].join() === fullDeck().slice(0, 11).join() && fixed.state.out.length === 4);
  check('R3.3: a fixed deal with the wrong shape or a repeated card is refused', throws(() => createGame({ seed: 1, players: 4, deals: [{ hands: [['home-1']] }] }), /needs 4 hands of 11/)
    && throws(() => createGame({ seed: 1, players: 2, deals: [{ hands: [fullDeck().slice(0, 12), fullDeck().slice(0, 12)] }] }), /twice/));
  {
    const { state } = randomGame(3, 'fresh');
    check('R2.5 / R13.3: all 48 cards are gathered and reshuffled for every hand', state.handLog.length === 3 && conservation(state).ok);
  }
}

// ---------- 4. the climb ----------
{
  // Scenario A, 4 players: Escape 5 led; seat 2 is void in Escape and throws Home 12 (higher, off-suit).
  const g = position({ hands: [['escape-5', 'escape-1', 'climb-3'], ['escape-9', 'home-2', 'climb-4'], ['home-12', 'home-3', 'climb-5'], ['escape-2', 'descent-4', 'climb-6']], leader: 0 });
  check('R4.2: the leader may lead any card', getValidActions(g).length === 3);
  applyAction(g, { type: 'play', card: 'escape-5' });
  // seat 1 held only one Escape: auto-played (R4.13); now seat 2 (void) may play anything.
  check('R4.3: with no card of the led suit, anything goes', g.toAct === 2 && same(getValidActions(g).map((a) => a.card), ['climb-5', 'home-3', 'home-12']));
  check('R4.13: a single legal card is played at once and marked auto', g.trick.plays.length === 2 && g.trick.plays[1].card === 'escape-9');
  const ev = applyAction(g, { type: 'play', card: 'home-12' });
  const won = ev.find((e) => e.type === 'trick-won');
  check('R4.4 / R1.4: the highest card of the led suit wins the climb; an off-suit card never wins, however high', won.winner === 1 && won.card === 'escape-9' && won.phase === 'climb');
  check('R4.6: the winner takes the trick to their climb pile and leads next', g.climbTricks[1] === 1 && g.climbPiles[1].length === 4 && g.toAct === 1 && g.leader === 1 && g.trick === null);
  const mv = ev.find((e) => e.type === 'marker-moved');
  check('R4.7: the marker moves 1 step plus 1 per off-suit card', mv.from === 0 && mv.to === 2 && mv.steps === 2 && mv.offSuit === 1 && g.marker === 2 && !mv.summit);
  check('R4.14 / R11.1: a climb trick yields trick-won (cards, led suit) then marker-moved', same(types(ev).slice(-2), ['trick-won', 'marker-moved']) && won.plays.length === 4 && won.ledSuit === 'escape' && won.offSuit === 1);
  check('R4.13: the auto flags are on the forced plays only', same(ev.filter((e) => e.type === 'card-played').map((e) => !!e.auto), [false, true]));
  check('R4.3: the block reason names the suit and the cards held', (() => {
    const h = position({ hands: [['escape-5', 'home-1'], ['escape-9', 'escape-8'], ['home-12', 'home-3'], ['escape-2', 'descent-4']], leader: 0 });
    applyAction(h, { type: 'play', card: 'escape-5' });
    const r = getPlayBlockReason(h, 1, 'escape-8');
    return r === null && /not your turn/.test(getPlayBlockReason(h, 2, 'home-3')) && /do not hold/.test(getPlayBlockReason(h, 1, 'home-3'));
  })());
  const h2 = position({ hands: [['escape-5', 'home-1', 'home-4'], ['escape-9', 'escape-8', 'home-8'], ['home-12', 'home-3', 'climb-1'], ['escape-2', 'descent-4', 'climb-2']], leader: 0 });
  applyAction(h2, { type: 'play', card: 'escape-5' });
  const snap = JSON.stringify(h2);
  check('R4.3: following is required when able; the reason says so; the refusal changes nothing', /must follow suit: Escape was led, and you hold Escape 8 and Escape 9/.test(getPlayBlockReason(h2, 1, 'home-8')) && throws(() => applyAction(h2, { type: 'play', card: 'home-8' })) && JSON.stringify(h2) === snap);
  check('R18.1: unknown actions are refused with a message', /Unknown action/.test(getActionBlockReason(h2, { type: 'dance' })) && /Unknown action/.test(getActionBlockReason(h2, null)) && /Unknown action/.test(getActionBlockReason(h2, { type: 'summit', choice: 'maybe' })));
  check('R18.1: a summit choice is refused during the climb', /Play a card/.test(getActionBlockReason(h2, { type: 'summit', choice: 'chase' })));
}
{
  const plays = [{ seat: 0, card: 'home-5' }, { seat: 1, card: 'home-9' }, { seat: 2, card: 'escape-12' }, { seat: 3, card: 'home-2' }];
  check('R4.4 / R14.2: trickWinner climb = argmax of rank in the led suit', trickWinner(plays, 'home').seat === 1);
  check('R7.3 / R14.2: trickWinner descent = argmin of rank in the led suit; off-suit low cards never win', trickWinner(plays, 'home', true).seat === 3 && trickWinner([{ seat: 0, card: 'home-5' }, { seat: 1, card: 'escape-1' }], 'home', true).seat === 0);
  check('R4.5: an empty trick has no winner; a trick never ties', trickWinner([], null) === null);
}
{
  // R4.8 overshoot: marker on 5 of 7, three off-suit cards = 4 steps; the marker stops at 7.
  const g = position({ hands: [['escape-5', 'escape-6', 'climb-1'], ['home-1', 'home-2', 'climb-2'], ['descent-1', 'descent-2', 'climb-3'], ['home-3', 'descent-3', 'climb-4']], leader: 0, marker: 5, climbTricks: [2, 1, 1, 1] });
  const ev = play(g, 'escape-5', 'home-1', 'descent-1', 'home-3');
  const mv = ev.find((e) => e.type === 'marker-moved');
  check('R4.8: overshooting counts as reaching the summit; the marker shows the summit', mv.steps === 4 && mv.to === 7 && mv.overshoot === 2 && mv.summit && g.marker === 7);
  check('R4.9 / R4.10: the climb is over; the summit comes before anyone leads; the phase is summit', g.phase === 'summit' && g.trick === null && g.summitTrick === 6 && types(ev).slice(-3).join() === 'trick-won,marker-moved,summit-reached');
  const sr = ev.find((e) => e.type === 'summit-reached');
  check('R5.5: choices are collected from the winner of the last climb trick, clockwise', same(g.choiceOrder, [0, 1, 2, 3]) && g.toAct === 0 && same(sr.order, [0, 1, 2, 3]));
  check('R5.1 / R18.1: at the summit the actions are Chase and Watch, nothing else', same(getValidActions(g), [{ type: 'summit', choice: 'chase' }, { type: 'summit', choice: 'watch' }]) && /choose Chase or Watch/.test(getActionBlockReason(g, { type: 'play', card: 'escape-6' })));
  check('R12.10: the view offers the stakes for the summit decision', (() => { const v = viewFor(g, 0); return v.stakes.climbTricks === 3 && v.stakes.mob === 3 && v.stakes.fall === -1; })());

  // R5.2 / R12.5: secret choices.
  const e1 = applyAction(g, { type: 'summit', choice: 'watch' });
  check('R4.13 / R18.2: the summit choice is never auto-applied (each seat decides)', g.phase === 'summit' && g.toAct === 1 && e1.length === 1 && e1[0].type === 'summit-chosen');
  check('R5.2: the summit-chosen event names the seat, never the side', !/chase|watch/.test(JSON.stringify(e1)) && !/chase|watch|Chase|Watch/.test(describeEvent(e1[0])));
  const v1 = viewFor(g, 1); const v0 = viewFor(g, 0);
  check('R12.5: before the reveal another seat sees only that a choice is locked in', v1.choices[0] === null && v1.chosen[0] === true && v1.chosen[1] === false && !/"(chase|watch)"/.test(JSON.stringify(v1)));
  check('R12.5: a seat sees its own choice once made', v0.choices[0] === 'watch');
  check('R18.3: the next chooser\'s legal actions from its own view are Chase and Watch', legalActionsFromView(v1).length === 2 && legalActionsFromView(v0).length === 0);
  applyAction(g, { type: 'summit', choice: 'chase' });
  applyAction(g, { type: 'summit', choice: 'chase' });
  check('R12.5: still hidden with one seat to choose', viewFor(g, 3).choices.slice(0, 3).every((c) => c === null) && viewFor(g, 3).chosen.slice(0, 3).every(Boolean));
  const e4 = applyAction(g, { type: 'summit', choice: 'watch' });
  check('R5.6: after the last choice one summit-revealed event lists every choice', e4.filter((e) => e.type === 'summit-revealed').length === 1 && same(e4.find((e) => e.type === 'summit-revealed').choices, ['watch', 'chase', 'chase', 'watch']) && same(e4.find((e) => e.type === 'summit-revealed').chasers, [1, 2]));
  check('R5.7 / R12.5: after the reveal every seat sees every choice', [0, 1, 2, 3].every((s) => same(viewFor(g, s).choices, ['watch', 'chase', 'chase', 'watch'])) && g.revealed);
  check('R7.1: the winner of the last climb trick leads the descent, even a watcher', g.phase === 'descent' && g.toAct === 0 && e4.some((e) => e.type === 'descent-started' && e.leader === 0));
  // Descent: s0 leads Climb 1 (lowest Climb wins), everything else is forced to the end of the hand.
  g.params.handsPerGame = 1;
  const ev2 = applyAction(g, { type: 'play', card: 'climb-1' });
  const tw = ev2.filter((e) => e.type === 'trick-won');
  check('R7.3: the lowest card of the led suit wins the descent', tw[0].winner === 0 && tw[0].card === 'climb-1' && tw[0].phase === 'descent');
  check('R7.2 / R7.6: must-follow is unchanged and the descent is played until the hands are empty', tw.length === 2 && g.hands.every((h) => h.length === 0));
  check('R7.5: descent tricks go to a separate descent pile; climb counts are untouched', g.descentTricks[0] === 2 && g.descentPiles[0].length === 8 && g.climbTricks[0] === 3);
  check('R5.8 / R7.8: watchers play every descent trick', tw.every((t) => t.plays.length === 4));
  const ah = ev2.find((e) => e.type === 'at-the-heels');
  check('R8.1: the most descent tricks puts a player at the heels; a watcher can be there', ah.seat === 0 && !ah.chased && !ah.tie);
  const rec = g.handLog[0];
  check('R8.5 / R8.6: a watcher at the heels: the mob escapes and every chaser falls', rec.broughtHomeBy === null && same(rec.outcomes, ['watched', 'fell', 'fell', 'watched']) && ev2.some((e) => e.type === 'mob-escaped' && e.reason === 'watcher-at-heels'));
  check('R9.1 / R9.3: watchers +1 per climb trick; a chaser who falls scores -1 and loses the climb tricks', same(rec.scores, [3, -1, -1, 1]));
  check('R10.2: an escape puts a Brumby card under the Colt', g.brumbies === 1 && rec.brumbyAdded && !rec.brumbyAtCap && ev2.some((e) => e.type === 'brumby-added' && e.added && e.nextMob === 5));
  check('R11.4: hand-end order: at-the-heels, mob-escaped, brumby-added, hand-ended, then game-over', same(types(ev2).filter((t) => !['card-played', 'trick-won'].includes(t)), ['at-the-heels', 'mob-escaped', 'brumby-added', 'hand-ended', 'game-over']));
  check('R10.8: the escape on the last hand still shows its Brumby card', ev2.find((e) => e.type === 'brumby-added').lastHand === true);
  check('R9.7: the hand record has every field', ['choices', 'climbTricks', 'descentTricks', 'scores', 'outcomes', 'breakdown', 'summitTrick', 'chasers', 'mobValue', 'broughtHomeBy', 'heelsSeat', 'endReason', 'brumbyAdded', 'brumbyAtCap', 'tieAtHeels'].every((k) => k in rec)
    && rec.summitTrick === 6 && rec.chasers === 2 && rec.mobValue === 3 && rec.heelsSeat === 0 && rec.endReason === 'descent' && rec.breakdown[1].fallPoints === -1 && rec.breakdown[0].climbPoints === 3);
  check('R13.1: cards conserved through the summit and descent', conservation(g).ok);
}
{
  // R4.9 / R1.5 summit step by player count: one trick with no off-suit card (1 step).
  const mk = (players, marker) => {
    // every seat holds exactly one Escape, so the trick plays itself with no off-suit card
    const hands = Array.from({ length: players }, (_, s) => [`escape-${s + 1}`, `climb-${s + 1}`, `home-${s + 1}`]);
    const g = position({ players, hands, leader: 0, marker });
    const ev = applyAction(g, { type: 'play', card: 'escape-1' });
    return { g, mv: ev.find((e) => e.type === 'marker-moved') };
  };
  const five = mk(5, 5);
  check('R1.5 / R4.9: at 5 players the summit is step 6 (5 + 1 reaches it)', five.mv && five.mv.summit && five.mv.to === 6 && five.g.phase === 'summit');
  const four = mk(4, 5);
  check('R1.5: at 4 players step 6 is not the summit', four.mv && !four.mv.summit && four.mv.to === 6 && four.g.phase === 'climb');
  const four7 = mk(4, 6);
  check('R1.5: at 4 players step 7 is the summit', four7.mv.summit && four7.g.phase === 'summit');
}

// ---------- 6. nobody chases ----------
{
  const g = position({ hands: [['escape-5', 'escape-6', 'climb-1'], ['escape-1', 'home-2', 'climb-2'], ['escape-2', 'descent-2', 'climb-3'], ['escape-3', 'descent-3', 'climb-4']], leader: 0, marker: 6, climbTricks: [3, 1, 2, 0] });
  g.params.handsPerGame = 2;
  play(g, 'escape-5', 'escape-1', 'escape-2', 'escape-3');
  check('R6 setup: the summit after one more trick', g.phase === 'summit');
  const handsLeft = JSON.stringify(g.hands);
  const ev = play(g, 'watch', 'watch', 'watch', 'watch');
  check('R6.1: nobody chases: the hand ends at once, the mob escapes', same(types(ev).slice(0, 8), ['summit-chosen', 'summit-chosen', 'summit-chosen', 'summit-chosen', 'summit-revealed', 'nobody-chased', 'mob-escaped', 'brumby-added']) && g.handLog.length === 1 && g.handLog[0].endReason === 'nobody-chases');
  check('R6.2: cards still in hand are not played; nobody is at the heels', g.handLog[0].heelsSeat === null && !ev.some((e) => e.type === 'at-the-heels' || e.type === 'card-played') && g.handLog[0].descentTricksPlayed === 0);
  check('R6.3: everyone scores +1 per climb trick', same(g.handLog[0].scores, [4, 1, 2, 0]) && g.handLog[0].outcomes.every((o) => o === 'watched'));
  check('R6.4: a Brumby card goes under the Colt for the next hand', g.brumbies === 1 && g.mob === 5 && g.handNo === 1);
  check('R6.5: the unplayed hands are not revealed in any event or record', !NO_CARD_ID.test(JSON.stringify(ev.filter((e) => e.type !== 'hand-started'))) && !/hands/.test(Object.keys(g.handLog[0]).join()) && handsLeft.length > 10);
  check('R6.6: the hand counts as one of the game\'s hands; the deal passes left', g.handNo === 1 && g.dealer === (g.handLog[0].dealer + 1) % 4 && g.phase === 'climb');
}

// ---------- 8. at the mob's heels, 9. scoring, 10. Brumby cards ----------
{
  // A 1-1 tie on descent tricks: seat 0 wins trick 1 (Escape 1), seat 2 the later trick 2 (Home 1).
  const hands = [['escape-1', 'home-9'], ['escape-5', 'home-10'], ['escape-6', 'home-1'], ['escape-7', 'home-11']];
  const tie = (choices, brumbies = 0, climbTricks = [2, 0, 3, 2]) => {
    const g = position({ hands, leader: 0, phase: 'descent', choices, brumbies, climbTricks, handsPerGame: 2 });
    const ev = play(g, 'escape-1');
    return { g, ev, rec: g.handLog[0] };
  };
  const a = tie(['chase', 'chase', 'watch', 'watch']);
  const ah = a.ev.find((e) => e.type === 'at-the-heels');
  check('R8.2: a tie on descent tricks goes to the tied player who won the later trick', ah.seat === 2 && ah.tie && same(ah.tied, [0, 2]) && a.rec.tieAtHeels);
  check('R8.2 / R8.5: a tie at the heels with a watcher among the tied: the watcher wins it, the mob escapes', a.rec.broughtHomeBy === null && same(a.rec.outcomes, ['fell', 'fell', 'watched', 'watched']));
  check('R9.3: a chaser with no climb tricks at all who falls still scores -1', a.rec.climbTricks[1] === 0 && a.rec.scores[1] === -1 && a.rec.breakdown[1].outcome === 'fell');
  check('R9.1: watchers keep their climb tricks', a.rec.scores[2] === 3 && a.rec.scores[3] === 2);
  const b = tie(['chase', 'watch', 'chase', 'watch'], 2);
  check('R8.4 / R9.2: the chaser at the heels brings the mob home: climb tricks + the mob (3 + 2 x 2 = 7)', b.rec.broughtHomeBy === 2 && b.rec.scores[2] === 3 + 7 && b.rec.mobValue === 7 && b.rec.breakdown[2].mobPoints === 7);
  check('R8.6: every other chaser falls', b.rec.outcomes[0] === 'fell' && b.rec.scores[0] === -1);
  check('R10.4: the Brumby cards are returned; the next hand\'s mob is 3', b.g.brumbies === 0 && b.g.mob === 3 && b.ev.some((e) => e.type === 'mob-home' && e.brumbiesReturned === 2) && !b.ev.some((e) => e.type === 'brumby-added'));
  check('R11.4: hand-end order when the mob comes home: at-the-heels, mob-home, hand-ended, hand-started', same(types(b.ev).filter((t) => !['card-played', 'trick-won'].includes(t)), ['at-the-heels', 'mob-home', 'hand-ended', 'hand-started']));
  check('R11.6: mobs brought home are counted per seat', same(b.g.mobsHome, [0, 0, 1, 0]));
  check('R8.3 / R14.4: heelsOf = argmax (descent tricks, last descent trick won)', heelsOf([2, 2, 1], [3, 4, 0]).seat === 1 && heelsOf([3, 1, 1], [1, 4, 3]).seat === 0 && heelsOf([1, 1, 1], [0, 2, 1]).seat === 1);
  const c = tie(['chase', 'chase', 'chase', 'chase'], 4);
  check('R10.5: the mob is 3 + 2 x stack; with 4 Brumby cards it is worth 11', c.rec.mobValue === 11 && c.rec.scores[2] === 3 + 11);
}
{
  // R10.3 THE 4-BRUMBY CAP: all 4 under the Colt and the mob escapes again: nothing is added.
  const g = position({ hands: [['escape-5', 'escape-6', 'climb-1'], ['escape-1', 'home-2', 'climb-2'], ['escape-2', 'descent-2', 'climb-3'], ['escape-3', 'descent-3', 'climb-4']], leader: 0, marker: 6, brumbies: 4, handsPerGame: 2 });
  const ev = play(g, 'escape-5', 'escape-1', 'escape-2', 'escape-3', 'watch', 'watch', 'watch', 'watch');
  const ba = ev.find((e) => e.type === 'brumby-added');
  check('R10.3: at the cap an escape adds no Brumby card; the stack stays 4 and the mob 11', ba && ba.added === false && ba.atCap === true && ba.brumbies === 4 && ba.nextMob === 11 && g.brumbies === 4 && g.mob === 11 && g.handLog[0].brumbyAtCap && !g.handLog[0].brumbyAdded);
  check('R10.3: the cap is counted in the measures', g.measures.brumbyCapHits === 1 && conservation(g).ok);
  check('R10.3: describe says the mob stays at 11', /already under the Colt: the mob stays at 11/.test(describeEvent(ba)));
}
{
  // R10.3 over a long game (probe constants: 7 hands at 2 players, nobody ever chases): 3, 5, 7, 9, 11, 11, 11.
  const saved = CONSTANTS.HANDS_PER_GAME;
  CONSTANTS.HANDS_PER_GAME = { ...saved, 2: 7 };
  let st;
  try { st = randomGame(2, 'cap', () => 'watch').state; } finally { CONSTANTS.HANDS_PER_GAME = saved; }
  check('R10.3 / R10.5: escapes add a Brumby card a hand up to 4, then nothing (mob 3, 5, 7, 9, 11, 11, 11)', same(st.handLog.map((h) => h.mobValue), [3, 5, 7, 9, 11, 11, 11]) && same(st.handLog.map((h) => h.brumbyAtCap), [false, false, false, false, true, true, true]) && st.brumbies === 4 && st.measures.brumbyCapHits === 3);
  check('R10.6: in a standard game the stack at the start of a hand never exceeds 4', [2, 3, 4, 5].every((n) => {
    for (let i = 0; i < 40; i++) { const r = randomGame(n, `std${n}:${i}`, () => 'watch').state; if (Math.max(...r.handLog.map((h) => h.mobValue)) > 11) return false; }
    return true;
  }));
  check('R10.6: at 5 players with every hand escaping the cap is hit only by the last hand\'s escape', (() => { const r = randomGame(5, 'five', () => 'watch').state; return same(r.handLog.map((h) => h.brumbyAtCap), [false, false, false, false, true]) && same(r.handLog.map((h) => h.mobValue), [3, 5, 7, 9, 11]); })());
}

// ---------- 11. game end, tiebreak, ranking ----------
{
  const mk = (totals, mobsHome) => ({ n: totals.length, totals, mobsHome, handLog: [{ scores: totals }], measures: { tricks: 9 } });
  const r1 = gameResult(mk([10, 7, 4], [0, 1, 2]));
  check('R11.5: the highest total wins; margin to the next', same(r1.winners, [0]) && !r1.shared && !r1.tiebreakUsed && r1.margin === 3 && r1.winningScore === 10);
  const r2 = gameResult(mk([10, 10, 4], [1, 2, 3]));
  check('R11.6 / R11.8: a tie on the top total goes to the tied player who brought the mob home most often (others ignored)', same(r2.winners, [1]) && r2.tiebreakUsed && same(r2.tiedOnTotal, [0, 1]) && r2.margin === 0);
  const r3 = gameResult(mk([10, 10, 4], [1, 1, 5]));
  check('R11.7: still tied: a shared win', same(r3.winners, [0, 1]) && r3.shared && !r3.tiebreakUsed);
  const r3b = gameResult(mk([9, 9, 9], [2, 2, 0]));
  check('R11.6 / R11.7: three tied, two level on mobs home: those two share', same(r3b.winners, [0, 1]) && r3b.shared && r3b.tiebreakUsed);
  const r4 = gameResult(mk([8, 10, 8, 8], [0, 0, 2, 0]));
  check('R11.9: ranking by total then mobs home; equal on both share a rank', same(r4.ranking.map((r) => r.seat), [1, 2, 0, 3]) && same(r4.ranking.map((r) => r.rank), [1, 2, 3, 3]));
  for (const n of [2, 3, 4, 5]) {
    const { state, events } = randomGame(n, `end${n}`);
    const r = state.result;
    check(`R11.5 ${n}p: totals are the sums of the hand scores; the result is in the game-over event`, state.phase === 'over' && r.totals.every((t, s) => t === state.handLog.reduce((x, h) => x + h.scores[s], 0)) && events[events.length - 1].type === 'game-over');
    check(`R11.6 ${n}p: mobsHome counts the hands each seat brought the mob home`, r.mobsHome.every((k, s) => k === state.handLog.filter((h) => h.broughtHomeBy === s).length));
    check(`R18.1 ${n}p: nobody may act after the end`, getValidActions(state).length === 0 && throws(() => applyAction(state, { type: 'play', card: 'home-1' })));
  }
}

// ---------- 12. the player view ----------
{
  const g = createGame({ seed: 9, players: 4 });
  applyAction(g, getValidActions(g)[0]);
  const seat = g.toAct;
  const v = viewFor(g, seat);
  check('R12.1 / R12.2: own hand only, counts for everyone; no rng, no other hands', same(v.hand, g.hands[seat]) && v.handCounts.length === 4 && !('hands' in v) && !('rng' in v));
  check('R12.7: the cards out of play: only their count', !('out' in v) && v.outCount === 4 && !g.out.some((c) => JSON.stringify(v).includes(`"${c}"`)));
  check('R12.3: public counts: marker, summit step, Mountain side, Brumby stack, mob, climb and descent tricks, totals', v.marker === 0 && v.summitStep === 7 && v.mountainSide === '0-7' && v.brumbies === 0 && v.mob === 3 && v.climbTricks.length === 4 && v.descentTricks.length === 4 && v.totals.length === 4);
  check('R12.4: the current trick and the phase', v.trick && v.trick.plays.length === 1 && v.phase === 'climb');
  check('R12: plain JSON, a fresh copy', same(roundTrip(v), v) && (() => { v.hand.pop(); v.totals[0] = 99; return g.hands[seat].length === 11 && g.totals[0] !== 99; })());
  check('R18.3: legalActionsFromView equals getValidActions for the actor, empty for others', same(legalActionsFromView(viewFor(g, seat)), getValidActions(g)) && legalActionsFromView(viewFor(g, (seat + 1) % 4)).length === 0);
  check('R12: a bad seat is refused', throws(() => viewFor(g, 9)));
  const p = position({ players: 3, hands: [['home-5', 'climb-2', 'climb-3'], ['climb-4', 'escape-1', 'escape-2'], ['descent-9', 'descent-8', 'home-1']], leader: 0 });
  play(p, 'home-5', 'climb-4'); // seat 1 had no Home: void in Home
  const pv = viewFor(p, 2);
  check('R12.9: voids are inferred from play, not announced', same(shownVoids(pv)[1], ['home']) && shownVoids(pv)[0].length === 0);
  check('R12.7 / unknown: the viewer cannot place other hands or the cards out', unknownCards(pv).length === 48 - (3 + 2));
}
{
  // determinise: whole deck once, the viewer's hand, the counts, voids, and a playable world, at every phase.
  let ok = true; let voidOk = true; let worlds = 0; let summitWorlds = 0; let guessOk = true;
  for (const n of [2, 4, 5]) {
    const g = createGame({ seed: 21 + n, players: n });
    const rng = makeRng(`det${n}`);
    const prng = makeRng(`detp${n}`);
    let steps = 0;
    while (g.toAct !== null && steps < 400) {
      const seat = g.toAct;
      const v = viewFor(g, seat);
      const w = determinise(v, rng);
      worlds++;
      if (g.phase === 'summit') {
        summitWorlds++;
        for (let s = 0; s < n; s++) {
          if (s === seat) { if (w.choices[s] !== g.choices[s]) guessOk = false; }
          else if ((g.choices[s] === null) !== (w.choices[s] === null)) guessOk = false;
        }
      }
      const all = [...w.hands.flat(), ...w.out, ...w.climbPiles.flat(), ...w.descentPiles.flat(), ...(w.trick ? w.trick.plays.map((x) => x.card) : [])];
      if (new Set(all).size !== 48 || all.length !== 48) ok = false;
      if (!same(w.hands[seat], g.hands[seat])) ok = false;
      if (!w.hands.every((h, s) => h.length === g.hands[s].length)) ok = false;
      if (!conservation(w).ok) ok = false;
      const sv = shownVoids(v);
      for (let s = 0; s < n; s++) if (s !== seat && w.hands[s].some((c) => sv[s].includes(cardSuit(c)))) voidOk = false;
      if (!same(roundTrip(w), w)) ok = false;
      const copy = roundTrip(w);
      let guard = 0;
      while (copy.toAct !== null && guard++ < 600) applyAction(copy, rngPick(prng, getValidActions(copy)), { silent: true });
      if (copy.phase !== 'over') ok = false;
      applyAction(g, rngPick(prng, getValidActions(g)), { silent: true });
      steps++;
    }
  }
  check('determinise: every world holds the whole deck once, keeps the viewer\'s hand and the counts, and plays out', ok, `${worlds} worlds`);
  check('determinise: no hand holds a suit its owner has shown it lacks', voidOk);
  check('determinise: at the summit, locked-in seats get a guessed side, the rest stay unchosen, the viewer keeps its own', guessOk && summitWorlds > 5, `${summitWorlds} summit worlds`);
  const pool = ['home-1', 'home-2', 'climb-1', 'climb-2', 'escape-1', 'escape-2'];
  const dealt = dealRespectingVoids(pool, [0, 2, 2], [new Set(), new Set(['home']), new Set(['climb'])], makeRng(1), [1, 2]);
  check('dealRespectingVoids: honours voids and returns the rest as leftover', dealt.hands[1].every((c) => !c.startsWith('home')) && dealt.hands[2].every((c) => !c.startsWith('climb')) && dealt.leftover.length === 2);
}

// ---------- 13. conservation and whole games ----------
for (const n of [2, 3, 4, 5]) {
  const g = createGame({ seed: 40 + n, players: n });
  const rng = makeRng(`whole${n}`);
  let consOk = true; let steps = 0;
  while (g.toAct !== null && steps < 2000) {
    applyAction(g, rngPick(rng, getValidActions(g)));
    if (!conservation(g).ok) consOk = false;
    steps++;
  }
  check(`R13.1 ${n}p: cards conserved after every action of a whole game`, consOk && g.phase === 'over');
  check(`R4.12 / R7.9 ${n}p: climb at least ceil(K/n) tricks; every descent at least ${{ 2: 5, 3: 5, 4: 4, 5: 3 }[n]} tricks`, g.handLog.every((h) => h.summitTrick >= Math.ceil(g.params.summitStep / n) && h.summitTrick <= g.params.summitStep && (h.endReason === 'nobody-chases' || h.descentTricksPlayed >= { 2: 5, 3: 5, 4: 4, 5: 3 }[n])));
}

// ---------- auto-play and manual seats ----------
{
  const m = position({ players: 3, hands: [['home-9', 'home-8'], ['home-2', 'escape-1'], ['climb-3', 'climb-4']], leader: 0 });
  m.manualSeats = [1];
  const ev2 = play(m, 'home-9');
  check('R4.13: a manual seat (learner) is left to click even a forced card', ev2.filter((e) => e.auto).length === 0 && m.toAct === 1);
  check('R4.13: manualSeats must be real seats', throws(() => startGame({ seed: 1, players: 3, manualSeats: [7] })));
  const g = position({ players: 3, hands: [['home-9', 'home-8'], ['home-2', 'escape-1'], ['climb-3', 'climb-4']], leader: 0 });
  const ev = play(g, 'home-9');
  check('R4.13: a single legal card is applied at once and marked auto', ev.filter((e) => e.type === 'card-played' && e.auto).map((e) => e.seat).join() === '1');
}

// ---------- describe ----------
{
  const { events } = randomGame(3, 'desc');
  const names = ['You', 'Sam', 'Ann'];
  const lines = events.map((e) => describeEvent(e, names)).filter(Boolean);
  check('describe: every event a player sees has a line in plain English, second person for You', lines.length > 30 && lines.some((l) => /^You (lead|play|win|have)/.test(l)) && lines.some((l) => /^Reveal: /.test(l)));
  check('describe: no line has undefined, NaN or [object]', lines.every((l) => !/undefined|NaN|\[object/.test(l)));
  check('describe: summit-chosen lines never name a side', events.filter((e) => e.type === 'summit-chosen').every((e) => !/chase|watch/i.test(describeEvent(e, names))));
  check('describe: actions', describeAction({ type: 'play', card: 'home-3' }) === 'Play Home 3' && describeAction({ type: 'summit', choice: 'chase' }) === 'Chase' && describeAction({ type: 'summit', choice: 'watch' }) === 'Watch');
}

done();
