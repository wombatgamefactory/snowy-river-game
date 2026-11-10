// rules.mjs - one check (or a few) per numbered rule of Snowy River (v5 rules), each citing
// its R-number. Hand-built positions (tests/lib.mjs position()) for the trick and scoring rules, seeded
// Easy-bot games for the structure, the Brumby deck across hands and the view.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import {
  SUITS, CONSTANTS, VARIANTS, DEFAULT_RULES, BRUMBY_KINDS, resolveVariants, rulesCode, deriveParams,
  startGame, createGame, applyAction, getValidActions, getActionBlockReason, getPlayBlockReason, viewFor, legalActionsFromView,
  trickWinner, playableCards, fullDeck, sortCards, cardValue, descentValue, valueIn, cardName, isCard,
  brumbyDeck, brumbyValue, brumbyName, isBrumby, gameResult, reckonHand, shownVoids, unknownCards, unseenBrumbies, determinise,
  makeRng, deriveSeed, describeEvent, cloneState,
} from '../src/engine/index.js';
import { getBot } from '../src/bots/index.js';
import { PLAYER_COUNTS, MAX_SEATS } from '../src/game-config.js';
import { suite, position, play, conservation, throws, same, roundTrip } from './lib.mjs';

const { check, done } = suite('rules');
const easy = getBot('easy');
const P4 = deriveParams({}, 4);

/** Plays a seeded game with Easy bots; returns { state, events }. `opts` go to startGame. */
function easyGame(players, seed, opts = {}) {
  const { state, events } = startGame({ seed, players, ...opts });
  const all = [...events];
  const rngs = Array.from({ length: players }, (_, s) => makeRng(deriveSeed(seed, 'bot', s)));
  let guard = 0;
  while (state.toAct !== null && guard++ < 1000) all.push(...applyAction(state, easy.chooseAction(viewFor(state, state.toAct), rngs[state.toAct])));
  return { state, events: all };
}

/** Plays Easy bots until `stop(state)` is true (or the game ends). */
function easyUntil(state, stop, seed = 'u') {
  const rng = makeRng(seed);
  const events = [];
  let guard = 0;
  while (state.toAct !== null && !stop(state) && guard++ < 1000) events.push(...applyAction(state, easy.chooseAction(viewFor(state, state.toAct), rng)));
  return events;
}

const tw = (plays, led, half) => trickWinner(plays.map(([seat, card]) => ({ seat, card })), led, half, half === 'descent' ? 'home' : 'escape');

// ---------------- 1. Components ----------------
{
  const deck = fullDeck();
  check('R1.1 48 split cards, unique, 4 suits x 12', deck.length === 48 && new Set(deck).size === 48 && SUITS.every((s) => deck.filter((c) => c.startsWith(`${s}-`)).length === 12));
  check('R1.1 descent value = 13 - climb value (12/1 ... 1/12)', deck.every((c) => descentValue(c) === 13 - cardValue(c)) && descentValue('home-1') === 12 && descentValue('escape-12') === 1);
  check('R1.3 suit ids 0..3 = escape, climb, descent, home; ids <suit>-<v>; fullDeck index = suit x 12 + v - 1', same(SUITS, ['escape', 'climb', 'descent', 'home']) && deck[0] === 'escape-1' && deck[47] === 'home-12' && deck[3 * 12 + 4] === 'home-5' && isCard('climb-7') && !isCard('muster-3') && !isCard('climb-13'));
  check('R1.3 hands sort by suit then the value that counts (climb ascending / descent ascending)', same(sortCards(['home-2', 'escape-9', 'escape-3']), ['escape-3', 'escape-9', 'home-2']) && same(sortCards(['escape-3', 'escape-9'], 'descent'), ['escape-9', 'escape-3']));
  check('R1.4 value in play: climb value on the climb, descent value on the descent', valueIn('climb-4', 'climb') === 4 && valueIn('climb-4', 'descent') === 9 && cardName('climb-4', 'descent') === 'Climb 9');
  const b = brumbyDeck();
  const count = (v) => b.filter((id) => brumbyValue(id) === v).length;
  check('R1.7 Brumby deck: 12 cards, 5 x +2, 3 x +1, Flint -1, 2 x Wombat -2, the Colt +4; total +12', b.length === 12 && new Set(b).size === 12 && count(2) === 5 && count(1) === 3 && count(-1) === 1 && count(-2) === 2 && count(4) === 1 && brumbyValue('colt') === 4 && brumbyValue('brumby-flint') === -1 && b.reduce((a, id) => a + brumbyValue(id), 0) === 12 && b.every(isBrumby) && !isBrumby('escape-1'));
  check('R1.7 Brumby ids and names', b.includes('brumby-plus2-5') && b.includes('brumby-plus1-3') && b.includes('brumby-wombat-2') && brumbyName('colt') === 'The Colt from old Regret +4' && brumbyName('brumby-wombat-1') === 'Wombat hole -2' && BRUMBY_KINDS.length === 5);
  check('R1.8 / R5.7 Chase costs 3 at 2 players, 2 at 3 and 4', deriveParams({}, 2).chaseCost === 3 && deriveParams({}, 3).chaseCost === 2 && P4.chaseCost === 2 && same(CONSTANTS.CHASE_COST_BY_COUNT, { 2: 3, 3: 2, 4: 2 }));
  check('R1.9 2 to 4 players only: 1, 5 and 6 are rejected by the engine', [1, 5, 6].every((n) => throws(() => createGame({ seed: 1, players: n }), /2 to 4 players/)) && [2, 3, 4].every((n) => createGame({ seed: 1, players: n }).n === n));
  check('R1.9 the setup offers 2 to 4 players only (game-config)', same(PLAYER_COUNTS, [2, 3, 4]) && MAX_SEATS === 4 && CONSTANTS.MAX_PLAYERS === 4);
  check('R1.12 no variants: VARIANTS empty, any rule name refused, rules code std', VARIANTS.length === 0 && same(DEFAULT_RULES, {}) && same(resolveVariants({}), {}) && throws(() => resolveVariants({ COLT: '3' }), /Unknown rule/) && rulesCode({}, 3) === 'std' && createGame({ seed: 1, players: 3 }).rulesCode === 'std');
}

// ---------------- 2. Game structure ----------------
{
  const g2 = easyGame(2, 'r2-2'); const g3 = easyGame(3, 'r2-3'); const g4 = easyGame(4, 'r2-4');
  check('R2.1 hands per game: 3 at 2p, 3 at 3p, 4 at 4p', g2.state.handLog.length === 3 && g3.state.handLog.length === 3 && g4.state.handLog.length === 4 && g4.state.phase === 'over');
  const fixedDealer = createGame({ seed: 5, players: 3, firstDealer: 2 });
  const draws = new Set(Array.from({ length: 40 }, (_, i) => createGame({ seed: `fd${i}`, players: 4 }).firstDealer));
  check('R2.2 first dealer: from setup when given, otherwise drawn from the seeded RNG (same seed, same dealer)', fixedDealer.firstDealer === 2 && fixedDealer.dealer === 2 && draws.size > 1 && createGame({ seed: 'fd1', players: 4 }).firstDealer === createGame({ seed: 'fd1', players: 4 }).firstDealer && throws(() => createGame({ seed: 1, players: 3, firstDealer: 3 })));
  const recs = g4.state.handLog;
  const f = g4.state.firstDealer;
  check('R2.3 the deal passes left each hand; the dealer\'s left leads the climb', recs.every((h, i) => h.dealer === (f + i) % 4 && h.firstLeader === (h.dealer + 1) % 4 && h.tricks[0].leader === h.firstLeader));
  const two = createGame({ seed: 'two', players: 2, firstDealer: 1 });
  const d2 = easyGame(2, 'two', { firstDealer: 1 }).state.handLog.map((h) => h.dealer);
  check('R2.4 at 2 players the dealer runs d, other, d', two.dealer === 1 && same(d2, [1, 0, 1]));
  const firstHands = g3.state.handLog.map((h) => JSON.stringify(h.tricks.flatMap((t) => t.plays.map((p) => p.card)).sort()));
  check('R2.5 all 48 cards are gathered and reshuffled for every hand (each hand deals a different set)', new Set(firstHands).size === 3);
  const s = createGame({ seed: 'r26', players: 3 });
  easyUntil(s, (st) => st.handNo === 1);
  check('R2.6 each new hand: marker 0, no choices, empty piles, kept piles and row', s.handNo === 1 && s.marker === 0 && s.choices.every((c) => c === null) && !s.revealed && s.piles.every((p) => p.length === 0) && s.kept.every((k) => k.length === 0) && s.row.length === 0 && !s.handsTurned && s.trickNo === 0);
  const n0 = createGame({ seed: 'r27', players: 4 });
  check('R2.7 a new game: scores 0, all 12 Brumby cards in one face-down deck, empty discard', n0.totals.every((t) => t === 0) && n0.brumbyDeck.length === 12 && new Set(n0.brumbyDeck).size === 12 && n0.brumbyDiscard.length === 0 && n0.handLog.length === 0);
}

// ---------------- 3. The deal ----------------
{
  const outs = [2, 3, 4].map((n) => { const g = createGame({ seed: `d${n}`, players: n }); return [g.hands.every((h) => h.length === 12), g.out.length]; });
  check('R3.1 12 cards each; out 24 / 12 / 0 at 2 / 3 / 4 players', outs.every((o) => o[0]) && same(outs.map((o) => o[1]), [24, 12, 0]));
  const g = createGame({ seed: 'r32', players: 2 });
  const out = new Set(g.out);
  const played = easyGame(2, 'r32').state.handLog[0].tricks.flatMap((t) => t.plays.map((p) => p.card));
  check('R3.2 the cards out stay out all hand: never played, never in any view', played.every((c) => !out.has(c)) && [0, 1].every((s) => { const v = JSON.stringify(viewFor(g, s)); return [...out].every((c) => !v.includes(`"${c}"`)); }));
  const s = createGame({ seed: 'r33', players: 3 });
  const before = s.hands.map((h) => [...h].sort());
  check('R3.3 hands are picked up climb side up (not turned) until the summit', !s.handsTurned && viewFor(s, 0).half === 'climb');
  easyUntil(s, (st) => st.phase === 'summit');
  const after = s.hands.map((h) => [...h]);
  const allPlayed = s.tricks.flatMap((t) => t.plays);
  check('R3.3 at the summit every hand turns together; the cards held do not change', s.handsTurned && after.every((h, seat) => h.every((c) => before[seat].includes(c)) && h.length + allPlayed.filter((p) => p.seat === seat).length === 12) && same(after[0], sortCards(after[0], 'descent')));
  const fixed = { hands: [fullDeck().slice(0, 12), fullDeck().slice(12, 24)] };
  const fx = createGame({ seed: 'r34', players: 2, deals: [fixed] });
  check('R3.4 a fixed deal (test hook) gives each seat its 12 cards; the rest are out', same(fx.hands[0], sortCards(fixed.hands[0])) && same(fx.hands[1], sortCards(fixed.hands[1])) && fx.out.length === 24 && throws(() => createGame({ seed: 1, players: 2, deals: [{ hands: [fullDeck().slice(0, 12), fullDeck().slice(0, 12)] }] })));
  check('R3.5 setup: Mountain climb side up, marker at the start, Brumby deck face down', fx.marker === 0 && viewFor(fx, 0).mountainSide === 'climb' && viewFor(fx, 0).deckCount === 12 && !('brumbyDeck' in viewFor(fx, 0)));
}

// ---------------- 4. The climb ----------------
{
  const s = createGame({ seed: 'r41', players: 3 });
  check('R4.1 the hand starts in the climb, the dealer\'s left to lead', s.phase === 'climb' && s.toAct === (s.dealer + 1) % 3 && s.params.climbTricks === 6);
  check('R4.2 the leader may lead any card', getValidActions(s).length === 12);
  check('R4.3 must follow the led suit if able, else any card', same(playableCards(['climb-2', 'home-4', 'climb-9'], 'climb'), ['climb-2', 'climb-9']) && same(playableCards(['home-4', 'escape-1'], 'climb'), ['home-4', 'escape-1']));
  {
    const p = position({ players: 3, hands: [['climb-5', 'descent-3'], ['escape-1', 'home-3'], ['climb-7', 'descent-2']] });
    const r = getActionBlockReason(p, { type: 'play', card: 'descent-3' });
    const evs = play(p, 'climb-5', 'escape-1', 'climb-7');
    const won = evs.find((e) => e.type === 'trick-won');
    check('R4.2 the leader may lead an off-trump, any card (no block reason)', r === null);
    check('R4.4 any Escape played on the climb wins: a void seat trumps the led suit', won.winner === 1 && won.byTrump === true && won.card === 'escape-1');
  }
  {
    const p = position({ players: 3, hands: [['climb-2', 'home-1'], ['climb-9', 'home-2'], ['climb-4', 'home-3']], leader: 1 });
    p.manualSeats = [2];
    applyAction(p, { type: 'play', card: 'climb-9' });
    check('R4.3 following seat is told why an off-suit card is refused', /must follow suit: Climb was led/.test(getPlayBlockReason(p, 2, 'home-3')) && getActionBlockReason(p, { type: 'play', card: 'home-3' }) !== null);
  }
  check('R4.4 the highest Escape wins when several are played (climb values)', tw([[0, 'climb-5'], [1, 'escape-3'], [2, 'escape-11'], [3, 'climb-12']], 'climb', 'climb').seat === 2);
  check('R4.4 no trump played: the highest card of the led suit wins (climb values)', tw([[0, 'descent-5'], [1, 'descent-12'], [2, 'climb-12']], 'descent', 'climb').seat === 1);
  check('R4.4 Escape led is simply the led suit and trumps: highest Escape wins', tw([[0, 'escape-2'], [1, 'escape-9'], [2, 'home-12']], 'escape', 'climb').seat === 1 && tw([[0, 'escape-2'], [1, 'escape-9']], 'escape', 'climb').byTrump === false);
  check('R4.5 Home is not trumps on the climb; an off-suit non-trump never wins', tw([[0, 'climb-3'], [1, 'home-12'], [2, 'descent-12']], 'climb', 'climb').seat === 0);
  check('R4.6 a tie between played cards goes to the first card played', tw([[2, 'climb-5'], [0, 'climb-5']], 'climb', 'climb').seat === 2 && tw([[1, 'escape-4'], [0, 'climb-9'], [2, 'escape-4']], 'climb', 'climb').seat === 1 && tw([[1, 'home-7'], [2, 'home-7']], 'climb', 'descent').seat === 1);
  {
    // a hand-made state with a duplicated card (impossible in play) resolves the tie through applyAction too
    const p = position({ players: 2, hands: [['climb-5', 'home-1'], ['climb-6', 'home-2']] });
    p.hands[1] = ['climb-5', 'home-2'];
    const evs = play(p, 'climb-5', 'climb-5');
    check('R4.6 through applyAction: two equal cards, the leader\'s (first) wins', evs.find((e) => e.type === 'trick-won').winner === 0);
  }
  {
    const p = position({ players: 3, hands: [['climb-5', 'climb-1', 'descent-3'], ['climb-9', 'home-3', 'home-4'], ['climb-7', 'descent-2', 'descent-4']], marker: 2, climbTricks: [1, 1, 0] });
    const evs = play(p, 'climb-5', 'climb-9', 'climb-7');
    const mv = evs.find((e) => e.type === 'marker-moved');
    check('R4.7 the winner takes the trick into their one pile and leads the next', p.toAct === 1 && p.leader === 1 && p.piles[1].length === 3 && p.climbTricks[1] === 2);
    check('R4.8 the marker moves one step per climb trick (climb tricks played)', mv.from === 2 && mv.to === 3 && p.marker === 3 && viewFor(p, 0).climbTricksPlayed === 3 && !mv.summit);
    check('R4.11 a climb trick yields trick-won (winner, led suit, cards in order, trump?) and marker-moved', evs.map((e) => e.type).join() === 'card-played,card-played,card-played,trick-won,marker-moved' && same(evs[3].plays.map((x) => x.card), ['climb-5', 'climb-9', 'climb-7']) && evs[3].ledSuit === 'climb' && evs[3].byTrump === false);
  }
  {
    const s = createGame({ seed: 'r49', players: 4 });
    const evs = easyUntil(s, (st) => st.phase === 'summit');
    check('R4.9 after exactly the 6th climb trick the summit comes, every hand holding 6', s.phase === 'summit' && s.marker === 6 && s.trickNo === 6 && s.hands.every((h) => h.length === 6) && evs.filter((e) => e.type === 'trick-won').length === 6 && evs.filter((e) => e.type === 'marker-moved' && e.summit).length === 1);
  }
  {
    const p = position({ players: 3, hands: [['climb-5', 'escape-2'], ['climb-9', 'home-3'], ['climb-7', 'descent-2']] });
    const evs = play(p, 'climb-5');
    const autos = evs.filter((e) => e.type === 'card-played' && e.auto);
    check('R4.10 a single legal card is played automatically and marked auto', autos.length === 2 && autos.map((e) => e.card).join() === 'climb-9,climb-7');
    const m = position({ players: 3, hands: [['climb-5', 'escape-2'], ['climb-9', 'home-3'], ['climb-7', 'descent-2']] });
    m.manualSeats = [1];
    play(m, 'climb-5');
    check('R4.10 a manual (learner) seat is not auto-played', m.toAct === 1 && m.trick.plays.length === 1);
  }
}

// ---------------- 5. The summit ----------------
{
  const order = brumbyDeck().reverse(); // colt first
  const s = createGame({ seed: 'r5', players: 3, brumbyDeck: order });
  const evs = easyUntil(s, (st) => st.phase === 'summit');
  const op = evs.find((e) => e.type === 'summit-opened');
  const lastClimb = evs.filter((e) => e.type === 'trick-won').pop().winner;
  const i1 = evs.findIndex((e) => e.type === 'summit-opened');
  check('R5.1 the summit opens straight after the 6th climb trick, in one engine step', i1 === evs.length - 1 && evs[i1 - 1].type === 'marker-moved' && evs[i1 - 1].summit);
  check('R5.2 every hand turns round: handsTurned, descent values count', s.handsTurned && viewFor(s, 0).half === 'descent' && viewFor(s, 1).handsTurned);
  check('R5.3 the Mountain turns over: Home is trumps from now on', op.trump === 'home' && viewFor(s, 0).trump === 'home' && viewFor(s, 0).mountainSide === 'descent');
  check('R5.4 the top 6 Brumby cards of the deck are laid face up, left to right', same(s.row, order.slice(0, 6)) && same(op.row, order.slice(0, 6)) && s.brumbyDeck.length === 6 && same(s.brumbyDeck, order.slice(6)) && op.rowValue === order.slice(0, 6).reduce((a, id) => a + brumbyValue(id), 0));
  check('R5.5 every seat chooses; the legal actions are chase and watch', same(getValidActions(s), [{ type: 'summit', choice: 'chase' }, { type: 'summit', choice: 'watch' }]) && getActionBlockReason(s, { type: 'play', card: s.hands[s.toAct][0] }) !== null);
  check('R5.8 choices are collected seat by seat from the winner of the last climb trick, clockwise', s.toAct === lastClimb && same(s.choiceOrder, [lastClimb, (lastClimb + 1) % 3, (lastClimb + 2) % 3]));
  const first = s.toAct;
  const e1 = applyAction(s, { type: 'summit', choice: 'chase' });
  const second = s.toAct;
  check('R5.8 / R10.6 a locked-in choice is hidden from every other seat; only "chosen" shows', viewFor(s, second).choices[first] === null && viewFor(s, second).chosen[first] === true && viewFor(s, first).choices[first] === 'chase' && !/chase|watch/.test(JSON.stringify(e1)) && second !== first);
  check('R5.8 a seat cannot choose twice', s.choices[s.toAct] === null && getValidActions(s).length === 2);
  applyAction(s, { type: 'summit', choice: 'watch' });
  const e3 = applyAction(s, { type: 'summit', choice: 'chase' });
  const rev = e3.find((e) => e.type === 'summit-revealed');
  check('R5.9 one summit-revealed event shows every choice at once; then they stay visible', rev && rev.choices.every((c) => c !== null) && s.revealed && [0, 1, 2].every((v) => viewFor(s, v).choices.every((c) => c !== null)));
  easyUntil(s, (st) => st.descentTrickNo === 4);
  check('R5.9 choices stay visible through the descent and cannot change', s.revealed && viewFor(s, (first + 1) % 3).choices[first] === 'chase' && getActionBlockReason(s, { type: 'summit', choice: 'watch' }) !== null);
  check('R5.6 Chase keeps the Brumby card of each descent trick won; Watch keeps none', s.kept[(first + 1) % 3].length === 0 && s.kept.every((k, seat) => s.choices[seat] === 'chase' || k.length === 0));
  // nobody chases: the descent is still played
  const n = createGame({ seed: 'r510', players: 3 });
  easyUntil(n, (st) => st.phase === 'summit');
  const evs2 = [];
  for (let k = 0; k < 3; k++) evs2.push(...applyAction(n, { type: 'summit', choice: 'watch' }));
  evs2.push(...easyUntil(n, (st) => st.handNo === 1));
  const rec = n.handLog[0];
  check('R5.10 / R6.8 nobody chases: the descent is still played and every Brumby card is sent off', rec.descentTricks.reduce((a, b) => a + b, 0) === 6 && rec.chasers === 0 && evs2.filter((e) => e.type === 'brumby-discarded').length === 6 && rec.kept.every((k) => k.length === 0));
  check('R5.11 chasers and watchers alike play every descent trick', rec.tricks.filter((t) => t.half === 'descent').every((t) => t.plays.length === 3));
  check('R12.2 the summit choice is never auto-applied (always two options)', evs.every((e) => e.type !== 'summit-chosen') && !e1.some((e) => e.auto));
}

// ---------------- 6. The descent ----------------
{
  const s = createGame({ seed: 'r61', players: 4 });
  easyUntil(s, (st) => st.phase === 'summit');
  const lastClimb = s.tricks[5].winner;
  easyUntil(s, (st) => st.phase === 'descent');
  check('R6.1 the winner of the last climb trick leads the first descent trick', s.toAct === lastClimb && s.leader === lastClimb);
  check('R6.2 the descent leader may lead any card; must-follow unchanged', getValidActions(s).length === 6);
  check('R6.2 descent values: the low climb number is now high (Climb 1 = 12 beats Climb 12 = 1)', tw([[0, 'climb-12'], [1, 'climb-1']], 'climb', 'descent').seat === 1);
  check('R6.3 any Home played on the descent wins: Home 12 (descent 1) beats a led Climb 1 (descent 12)', tw([[0, 'climb-1'], [1, 'home-12']], 'climb', 'descent').seat === 1 && tw([[0, 'climb-1'], [1, 'home-12']], 'climb', 'descent').byTrump);
  check('R6.3 the highest Home by descent value wins (Home 2 = 11 beats Home 5 = 8)', tw([[0, 'descent-1'], [1, 'home-5'], [2, 'home-2']], 'descent', 'descent').seat === 2);
  check('R6.3 Home led is the led suit and trumps', tw([[0, 'home-9'], [1, 'home-3'], [2, 'escape-1']], 'home', 'descent').seat === 1);
  check('R6.4 Escape is not trumps on the descent', tw([[0, 'descent-6'], [1, 'escape-1']], 'descent', 'descent').seat === 0);
  check('R6.5 a tie on the descent goes to the first card played', tw([[3, 'descent-6'], [1, 'descent-6']], 'descent', 'descent').seat === 3);
  {
    const row = ['colt', 'brumby-wombat-1', 'brumby-plus2-1', 'brumby-plus1-1', 'brumby-flint', 'brumby-plus2-2'];
    const p = position({ players: 3, phase: 'descent', hands: [['climb-1', 'climb-3'], ['climb-12', 'home-5'], ['climb-11', 'descent-5']], row, descentTrickNo: 4, choices: ['chase', 'watch', 'chase'], descentTricks: [2, 1, 1], climbTricks: [2, 2, 2], handsPerGame: 1 });
    p.manualSeats = [0, 1, 2];
    const evs = play(p, 'climb-1', 'climb-12', 'climb-11');
    const kept = evs.find((e) => e.type === 'brumby-kept');
    check('R6.6 the winner of descent trick i takes row position i; a chaser keeps it face up', kept && kept.position === 5 && kept.card === 'brumby-flint' && kept.winner === 0 && p.kept[0].includes('brumby-flint') && p.row[4] === null);
    check('R6.10 / R9.1 a descent trick yields trick-won, then brumby-kept or brumby-discarded', evs.findIndex((e) => e.type === 'trick-won') === evs.findIndex((e) => e.type === 'brumby-kept') - 1);
    check('R6.7 the winner leads the next descent trick', p.toAct === 0 && p.leader === 0);
    const evs2 = play(p, 'climb-3', 'home-5', 'descent-5');
    const disc = evs2.find((e) => e.type === 'brumby-discarded');
    check('R6.6 a watcher\'s win sends the card straight to the discard (Home trumps a led Climb)', disc && disc.winner === 1 && disc.card === 'brumby-plus2-2' && disc.position === 6 && p.brumbyDiscard.includes('brumby-plus2-2') && p.kept[1].length === 0);
    check('R6.6 the 6th trick takes the last card; the row is empty after the hand', p.row.length === 0 && p.phase === 'over');
  }
  {
    const row = ['brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus2-3', 'brumby-plus2-4', 'brumby-plus2-5', 'colt'];
    const p = position({ players: 2, phase: 'descent', hands: [['climb-6'], ['climb-2']], row, descentTrickNo: 5, choices: ['chase', 'watch'], climbTricks: [3, 3], descentTricks: [2, 3], handsPerGame: 1 });
    const evs = play(p, 'climb-6');
    const d = evs.find((e) => e.type === 'brumby-discarded');
    check('R6.6 / R6.9 a watcher who wins the Colt\'s trick sends the Colt off (no rule names the Colt)', d && d.card === 'colt' && d.winner === 1 && p.handLog[0].coltWinner === 1 && p.handLog[0].coltKept === false && p.handLog[0].coltTrick === 6);
  }
}

// ---------------- 7. Scoring ----------------
{
  // seat 0 chases and wins nothing more; seat 1 watches; seat 2 chases and keeps -1 and -2 cards
  const row = ['brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus2-3', 'brumby-plus2-4', 'brumby-flint', 'brumby-wombat-1'];
  const p = position({ players: 3, phase: 'descent', hands: [['climb-12'], ['climb-11'], ['climb-1']], row, descentTrickNo: 5, choices: ['chase', 'watch', 'chase'], climbTricks: [0, 4, 2], descentTricks: [0, 3, 2], kept: [[], [], ['brumby-flint']], handsPerGame: 1 });
  p.row = [null, null, null, null, null, 'brumby-wombat-1'];
  p.brumbyDiscard = ['brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus2-3', 'brumby-plus2-4'];
  const evs = play(p, 'climb-12');
  const he = evs.find((e) => e.type === 'hand-ended');
  const b = he.breakdown;
  check('R7.1 every trick is 1 point, climb or descent', b[1].trickPoints === 7 && b[1].tricks === 7);
  check('R7.2 a watcher scores their tricks', b[1].score === 7 && b[1].cost === 0);
  check('R7.3 a chaser scores tricks + kept Brumby values - the cost (2 at 3 players)', b[2].tricks === 5 && b[2].keptValue === -3 && b[2].cost === 2 && b[2].score === 0 && same(b[2].kept, ['brumby-flint', 'brumby-wombat-1']));
  check('R7.4 a chaser with no tricks still pays; scores may be negative', b[0].tricks === 0 && b[0].score === -2 && p.totals[0] === -2);
  check('R7.5 the hand score is added to the pad once, when the 6th descent trick is complete', same(p.totals, [-2, 7, 0]) && evs.filter((e) => e.type === 'hand-ended').length === 1);
  check('R7.6 tricks total 12; hand scores total 12 + kept values of chasers - cost x chasers', he.trickCounts.reduce((a, x) => a + x, 0) === 12 && he.scores.reduce((a, x) => a + x, 0) === 12 + (-3) - 2 * 2);
  const two = position({ players: 2, phase: 'descent', hands: [['climb-1'], ['climb-2']], descentTrickNo: 5, choices: ['chase', 'chase'], climbTricks: [3, 3], descentTricks: [3, 2], handsPerGame: 1 });
  play(two, 'climb-1');
  check('R5.7 / R7.3 at 2 players a chaser pays 3', two.handLog[0].costs[0] === 3 && two.handLog[0].costs[1] === 3);
  const rec = p.handLog[0];
  check('R7.7 the hand record: choices, tricks, kept, values, costs, row, Colt, top Home, reshuffled', ['choices', 'climbTricks', 'descentTricks', 'trickCounts', 'kept', 'keptValues', 'costs', 'scores', 'row', 'rowValues', 'rowValue', 'colt', 'coltTrick', 'coltWinner', 'coltKept', 'chasers', 'topHomeSeat', 'reshuffled'].every((k) => k in rec) && rec.chasers === 2 && rec.rowValue === 5 && rec.colt === false && rec.coltWinner === null);
  const g = createGame({ seed: 'top', players: 3 });
  easyUntil(g, (st) => st.phase === 'summit');
  let want = null; let bv = 99;
  g.hands.forEach((h, s) => h.forEach((c) => { if (c.startsWith('home-') && cardValue(c) < bv) { bv = cardValue(c); want = s; } }));
  check('R7.7 topHomeSeat = the holder at the summit of the Home card with the highest descent value', g.topHomeSeat === want);
  check('R7 reckonHand agrees with the hand record', same(reckonHand({ ...p, choices: rec.choices, climbTricks: rec.climbTricks, descentTricks: rec.descentTricks, kept: rec.kept }).scores, rec.scores));
}

// ---------------- 8. The Brumby deck across hands ----------------
{
  const order = brumbyDeck();
  const { state, events } = easyGame(4, 'r8', { brumbyDeck: order });
  const L = state.handLog;
  const resh = events.filter((e) => e.type === 'brumby-reshuffled');
  check('R8.1 / R8.5 hands 1 and 2 use the same shuffle: hand 1 the top 6, hand 2 the other 6', same(L[0].row, order.slice(0, 6)) && same(L[1].row, order.slice(6)) && L[0].reshuffled && !L[1].reshuffled);
  check('R8.3 at the end of a hand every Brumby card of its row goes to the discard, kept or sent off', events.filter((e) => e.type === 'hand-started' && e.handNo === 1).every((e) => e.discardCount === 6 && e.deckCount === 6));
  check('R8.4 fewer than 6 left: all 12 are shuffled together (after hand 2 only, not after the last hand)', resh.length === 1 && resh[0].handNo === 2 && resh[0].deckCount === 12 && L[2].reshuffled && !L[3].reshuffled);
  check('R8.5 hand 3 starts a fresh shuffle; at 4 players hand 4 takes the other 6', same([...L[2].row, ...L[3].row].sort(), [...order].sort()) && state.brumbyDeck.length === 0 && state.brumbyDiscard.length === 12);
  const g3 = easyGame(3, 'r8-3').state;
  check('R8.4 a 3-hand game ends without reshuffling: the third hand\'s shuffle leaves 6 in the deck, 6 discarded', g3.handLog[2].reshuffled && g3.brumbyDeck.length === 6 && g3.brumbyDiscard.length === 6);
  check('R8.5 the Colt is in exactly one of the two rows of each shuffle', [easyGame(4, 'colt-a').state, easyGame(4, 'colt-b').state].every((st) => st.handLog[0].colt !== st.handLog[1].colt && st.handLog[2].colt !== st.handLog[3].colt));
  check('R8.6 the order of the row is the order dealt', same(L[0].tricks.filter((t) => t.half === 'descent').map((t) => t.prize), order.slice(0, 6)));
  // the test hook: a fixed row must come from the deck as it stands
  const h1 = { hands: [fullDeck().slice(0, 12), fullDeck().slice(12, 24), fullDeck().slice(24, 36)], row: [4, 2, 2, 2, 2, 2] };
  const s = createGame({ seed: 'hook', players: 3, deals: [h1, { hands: h1.hands, row: [2, 1, 1, 1, -1, -2] }, { hands: h1.hands, row: [4, 2, 2, 2, 2, 2] }] });
  easyUntil(s, (st) => st.phase === 'summit');
  check('R8.7 test hook: a fixed row by values takes the first such cards from the deck, in the given order', same(s.row.map(brumbyValue), [4, 2, 2, 2, 2, 2]) && s.row[0] === 'colt' && s.brumbyDeck.length === 6);
  const bad = createGame({ seed: 'hook2', players: 3, deals: [{ hands: h1.hands, row: [4, 4, 2, 2, 2, 2] }] });
  check('R8.7 test hook: a row the deck cannot supply throws', throws(() => easyUntil(bad, (st) => st.phase === 'summit'), /not in the Brumby deck/));
  check('R8.7 the deck order is in no view; only its count', [0, 1, 2].every((v) => { const view = viewFor(s, v); return !('brumbyDeck' in view) && view.deckCount === 6; }));
}

// ---------------- 9. Order of events and game end ----------------
{
  const { events } = easyGame(3, 'r9');
  const types = events.map((e) => e.type);
  const i = types.indexOf('hand-ended');
  check('R9.2 summit events in order: summit-opened, summit-chosen x n, summit-revealed, descent-started', (() => { const a = types.indexOf('summit-opened'); return types.slice(a, a + 6).join() === 'summit-opened,summit-chosen,summit-chosen,summit-chosen,summit-revealed,descent-started'; })());
  check('R9.3 end of hand: hand-ended (scores), then the next hand-started (hand 1 -> 2, no reshuffle)', types[i + 1] === 'hand-started');
  const j = types.indexOf('hand-ended', i + 1);
  check('R9.3 after hand 2: hand-ended, brumby-reshuffled, hand-started', types.slice(j, j + 3).join() === 'hand-ended,brumby-reshuffled,hand-started');
  check('R9.3 after the last hand: hand-ended, game-over', types[types.length - 1] === 'game-over' && types[types.length - 2] === 'hand-ended');
  const fake = (totals, last) => gameResult({ n: totals.length, totals, handLog: [{ scores: last.map(() => 0) }, { scores: last }], measures: { tricks: 24 } });
  const r1 = fake([10, 10, 7], [3, 6, 9]);
  check('R9.4 the highest total wins', same(fake([12, 9, 4], [1, 1, 1]).winners, [0]) && !fake([12, 9, 4], [1, 1, 1]).tiebreakUsed);
  check('R9.5 tie on total: the most points in the last hand wins', same(r1.winners, [1]) && r1.tiebreakUsed && !r1.shared && same(r1.tiedOnTotal, [0, 1]));
  const r2 = fake([10, 10, 3], [4, 4, 9]);
  check('R9.5 still tied: a shared win', same(r2.winners, [0, 1]) && r2.shared && !r2.tiebreakUsed);
  check('R9.6 the tiebreak applies only among the players tied for the highest total (a lower player\'s big last hand is ignored)', same(r1.winners, [1]) && r1.lastHandScores[2] === 9);
  const r3 = fake([5, 8, 8, 5], [2, 1, 1, 4]);
  check('R9.7 ranking by total then last hand; equal on both share a rank', same(r3.ranking.map((x) => [x.seat, x.rank]), [[1, 1], [2, 1], [3, 3], [0, 4]]) && r3.shared);
  check('R9.8 scores are integers; no draws (a tie is a shared win)', [r1, r2, r3].every((r) => r.totals.every(Number.isInteger) && r.winners.length >= 1));
  check('R9.7 the result explains a tiebreak in plain English', /tiebreak: most points in the last hand \(6 against 3\)/.test(describeEvent({ type: 'game-over', ...r1 }, ['A', 'B', 'C'])) && /Shared win/.test(describeEvent({ type: 'game-over', ...r2 })));
}

// ---------------- 10. The player view ----------------
{
  const s = createGame({ seed: 'r10', players: 3 });
  easyUntil(s, (st) => st.phase === 'summit');
  applyAction(s, { type: 'summit', choice: 'chase' });
  const v = viewFor(s, 1);
  const others = [0, 2].flatMap((x) => s.hands[x]);
  const text = JSON.stringify(v);
  check('R10.1 own hand in full, with handsTurned', same(v.hand, s.hands[1]) && v.handsTurned === true);
  check('R10.2 other seats: hand sizes only, never their cards', same(v.handCounts, [6, 6, 6]) && others.every((c) => !text.includes(`"${c}"`)));
  check('R10.3 public counts and table state: tricks per seat (and split), marker, dealer, leader, phase, trump, totals', same(v.climbTricks, s.climbTricks) && v.trickCounts.reduce((a, b) => a + b, 0) === 6 && v.marker === 6 && v.dealer === s.dealer && v.phase === 'summit' && v.trump === 'home' && same(v.totals, s.totals));
  check('R10.5 the row face up with values, and the next position', same(v.row, s.row) && same(v.rowValues, s.row.map(brumbyValue)) && v.rowNext === 0);
  check('R10.6 before the reveal only the viewer\'s own choice shows; others are "chosen" booleans', viewFor(s, s.choiceOrder[0]).choices[s.choiceOrder[0]] === 'chase' && v.choices.every((c, x) => x === s.choiceOrder[0] ? (x === 1 ? c === 'chase' : c === null) : c === null) && v.chosen.filter(Boolean).length === 1);
  check('R10.8 the Brumby deck: count only', v.deckCount === 6 && !('brumbyDeck' in v) && s.brumbyDeck.every((id) => !text.includes(`"${id}"`)));
  check('R10.10 the cards out of play: count only', v.outCount === 12 && s.out.every((c) => !text.includes(`"${c}"`)));
  check('R10.13 the summit stakes line: row, its value, the Chase cost and the cost of each choice', v.stakes.rowValue === s.row.reduce((a, id) => a + brumbyValue(id), 0) && v.stakes.chaseCost === 2 && v.stakes.cost.chase === 2 && v.stakes.cost.watch === 0 && v.chaseCost === 2);
  while (s.phase === 'summit') applyAction(s, { type: 'summit', choice: s.toAct === 0 ? 'watch' : 'chase' });
  easyUntil(s, (st) => st.descentTrickNo === 3 && st.trick && st.trick.plays.length === 1);
  const w = viewFor(s, 0);
  check('R10.4 the current trick: plays so far, led suit, the card winning it now', w.trick && w.trick.plays.length === 1 && w.trick.ledSuit === w.trick.plays[0].card.split('-')[0] && w.trick.best.seat === w.trick.plays[0].seat);
  check('R10.7 each chaser\'s kept cards face up with their total', same(w.kept, s.kept) && w.keptValue.every((x, k) => x === s.kept[k].reduce((a, id) => a + brumbyValue(id), 0)));
  check('R10.9 the discard is public (ids in order)', same(w.discard, s.brumbyDiscard));
  check('R10.11 trick piles are counts; the trick log (this hand\'s tricks) is public history', !('piles' in w) && w.tricks.length === s.tricks.length && same(w.tricks.map((t) => t.winner), s.tricks.map((t) => t.winner)));
  const voids = shownVoids(w);
  const unk = unknownCards(w);
  check('R10.12 voids are inferred from the history (shownVoids), not announced', Array.isArray(voids) && voids.length === 3 && !('voids' in w));
  check('R10 helpers: unknownCards = other hands + out; unseenBrumbies = the deck\'s contents', unk.length === s.hands[1].length + s.hands[2].length + s.out.length && same([...unseenBrumbies(w)].sort(), [...s.brumbyDeck].sort()));
  const world = determinise(w, makeRng('det'));
  check('R10 determinise: a full state consistent with the view (own hand, sizes, voids, deck contents, choices)', same(world.hands[0], s.hands[0]) && world.hands.every((h, k) => h.length === s.hands[k].length) && same([...world.brumbyDeck].sort(), [...s.brumbyDeck].sort()) && same(world.choices, s.choices) && conservation(world).ok && voids.every((vs, k) => vs.every((suit) => !world.hands[k].some((c) => c.startsWith(`${suit}-`)))));
  check('R10 a determinised world plays on to the end of the game', (() => { const c = cloneState(world); easyUntil(c, () => false); return c.phase === 'over'; })());
  check('R10 the view is plain JSON and a fresh copy', same(roundTrip(w), w) && viewFor(s, 0) !== viewFor(s, 0));
  check('R10.15 legalActionsFromView equals getValidActions for the seat to act', same(legalActionsFromView(viewFor(s, s.toAct)), getValidActions(s)) && legalActionsFromView(viewFor(s, (s.toAct + 1) % 3)).length === 0);
}

// ---------------- 11. Conservation ----------------
{
  const s = createGame({ seed: 'r11', players: 2 });
  let ok = true;
  const rng = makeRng('r11');
  while (s.toAct !== null) { applyAction(s, easy.chooseAction(viewFor(s, s.toAct), rng)); if (!conservation(s).ok) ok = false; }
  check('R11.1 / R11.2 every playing card and every Brumby card is in exactly one place after every action', ok);
  const g = easyGame(4, 'r115').state;
  check('R11.5 after each hand: 12 tricks, row and kept piles empty, deck + discard = 12', g.handLog.every((h) => h.trickCounts.reduce((a, b) => a + b, 0) === 12) && g.row.length === 0 && g.kept.every((k) => k.length === 0) && g.brumbyDeck.length + g.brumbyDiscard.length === 12);
}

// ---------------- 12. Actions and bots ----------------
{
  const s = createGame({ seed: 'r12', players: 3 });
  check('R12.1 card phases: getValidActions = the legal cards of the seat to act', getValidActions(s).every((a) => a.type === 'play' && s.hands[s.toAct].includes(a.card)));
  const picks = new Set();
  for (let k = 0; k < 40; k++) {
    const g = createGame({ seed: `e${k}`, players: 2 });
    easyUntil(g, (st) => st.phase === 'summit', `e${k}`);
    picks.add(easy.chooseAction(viewFor(g, g.toAct), makeRng(`p${k}`)).choice);
  }
  check('R12.4 Easy plays random legal actions, including both summit choices', picks.has('chase') && picks.has('watch'));
  const lv = ['medium', 'hard'].map((id) => getBot(id));
  const g = createGame({ seed: 'placeholder', players: 4 });
  let okBots = true;
  const rng = makeRng('pl');
  while (g.toAct !== null) {
    const a = lv[g.toAct % 2].chooseAction(viewFor(g, g.toAct), rng);
    if (getActionBlockReason(g, a) !== null) { okBots = false; break; }
    applyAction(g, a);
  }
  check('R12.4 Medium and Hard return legal actions (they are stand-ins that play like Easy for now)', okBots && g.phase === 'over');
  check('R12 actions with an unknown shape are refused', getActionBlockReason(s, { type: 'bid', n: 3 }) !== null && throws(() => applyAction(s, { type: 'summit', choice: 'chase' })));
}

done();
