// rules.mjs - one check (or a few) per numbered rule of Snowy River (v6 rules),
// each citing its R-number. Hand-built positions (tests/lib.mjs position()) for the trick and scoring rules,
// seeded Easy-bot games for the structure, the rows, the Brumby deck across hands and the view.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import {
  SUITS, SUIT_ORDER, SUIT_NAMES, SUIT_ICONS, SUIT_COLOURS, CONSTANTS, VARIANTS, DEFAULT_RULES, BRUMBY_KINDS, CLIMB_KINDS,
  resolveVariants, rulesCode, deriveParams,
  startGame, createGame, applyAction, getValidActions, getActionBlockReason, getPlayBlockReason, viewFor, legalActionsFromView,
  trickWinner, playableCards, fullDeck, sortCards, cardNumber, strength, cardName, isCard, cardFace,
  climbCardDeck, climbCardValue, climbCardName, climbCardFace, isClimbCard,
  brumbyDeck, brumbyValue, brumbyName, isBrumby, gameResult, reckonHand, shownVoids, unknownCards, unseenBrumbies, determinise,
  makeRng, deriveSeed, describeEvent, cloneState,
} from '../src/engine/index.js';
import { getBot, botLevels } from '../src/bots/index.js';
import { PLAYER_COUNTS, MAX_SEATS } from '../src/game-config.js';
import { suite, position, play, conservation, throws, same, roundTrip } from './lib.mjs';

const { check, done } = suite('rules');
const easy = getBot('easy');
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

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
const CLIMB6 = ['climb-plus1-1', 'climb-plus1-2', 'climb-minus1', 'climb-plus1-3', 'climb-plus1-4', 'climb-plus1-5']; // the -1 at position 3

// ---------------- 1. Components ----------------
{
  const deck = fullDeck();
  const four = ['escape', 'climb', 'descent', 'home'];
  check('R1.1 48 single-number cards at 2-4 players, unique, 4 suits x 12, one number 1-12 each', deck.length === 48 && new Set(deck).size === 48 && four.every((s) => deck.filter((c) => c.startsWith(`${s}-`)).length === 12) && deck.every((c) => cardNumber(c) >= 1 && cardNumber(c) <= 12) && [2, 3, 4].every((n) => fullDeck(n).length === 48));
  const d5 = fullDeck(5);
  const g4 = createGame({ seed: 'm4', players: 4 });
  const g5 = createGame({ seed: 'm5', players: 5 });
  check('R1.2 the Muster (12 cards) is added at 5 players only: 60 cards; none at 2-4', d5.length === 60 && d5.filter((c) => c.startsWith('muster-')).length === 12 && !g4.hands.flat().some((c) => c.startsWith('muster-')) && g5.hands.flat().filter((c) => c.startsWith('muster-')).length === 12 && throws(() => createGame({ seed: 1, players: 4, deals: [{ hands: [fullDeck(5).slice(48, 60), ...fullDeck(4).slice(0, 36).reduce((a, c, i) => { a[Math.floor(i / 12)].push(c); return a; }, [[], [], []])] }] }), /not in the 4-player deck/));
  check('R1.2 the Muster is never trumps: a Muster led is just the led suit; off-suit it never wins (either half)', tw([[0, 'muster-3'], [1, 'muster-9'], [2, 'climb-12']], 'muster', 'climb').seat === 1 && tw([[0, 'muster-3'], [1, 'muster-9'], [2, 'escape-1']], 'muster', 'climb').seat === 2 && tw([[0, 'climb-2'], [1, 'muster-12']], 'climb', 'climb').seat === 0 && tw([[0, 'climb-9'], [1, 'muster-1']], 'climb', 'descent').seat === 0 && tw([[0, 'muster-3'], [1, 'muster-9']], 'muster', 'descent').seat === 0 && deriveParams({}, 5).trumpClimb !== 'muster' && deriveParams({}, 5).trumpDescent !== 'muster');
  check('R1.3 suit ids 0..4 = escape, climb, descent, home, muster; display order escape, climb, descent, muster, home; fullDeck index = suit x 12 + n - 1', same(SUITS, ['escape', 'climb', 'descent', 'home', 'muster']) && same(SUIT_ORDER, ['escape', 'climb', 'descent', 'muster', 'home']) && deck[0] === 'escape-1' && deck[47] === 'home-12' && deck[3 * 12 + 4] === 'home-5' && d5[48] === 'muster-1' && d5[59] === 'muster-12');
  check('R1.3 suit colours, icons and names (decision 8)', same(SUIT_COLOURS, { escape: '#F07F1E', climb: '#6F9070', descent: '#6FA8D6', muster: '#944DDB', home: '#3C5677' }) && SUIT_ICONS.muster === 'saddle' && SUIT_ICONS.home === 'horseshoe' && SUIT_ICONS.escape === 'trophy' && SUIT_NAMES.muster === 'Muster');
  check('R1.4 ids <suit>-<n>; hands sort by display suit, then ascending on the climb and descending on the descent', isCard('muster-7') && isCard('climb-7') && !isCard('climb-13') && !isCard('climb-plus1-1') && cardName('home-12') === 'Home 12' && cardFace('escape-7') === 'card-escape-7' && same(sortCards(['home-2', 'muster-4', 'escape-9', 'escape-3']), ['escape-3', 'escape-9', 'muster-4', 'home-2']) && same(sortCards(['escape-3', 'escape-9', 'home-1'], 'descent'), ['escape-9', 'escape-3', 'home-1']));
  check('R1.5 rank depends on the half: higher n stronger on the climb, lower n stronger on the descent', strength('climb-9', 'climb') > strength('climb-4', 'climb') && strength('climb-4', 'descent') > strength('climb-9', 'descent') && tw([[0, 'climb-12'], [1, 'climb-1']], 'climb', 'descent').seat === 1 && tw([[0, 'climb-12'], [1, 'climb-1']], 'climb', 'climb').seat === 0);
  const cd = climbCardDeck();
  check('R1.6 six Climb cards: 5 x +1 and 1 x -1, ids climb-plus1-1..5 and climb-minus1, faces and names', cd.length === 6 && new Set(cd).size === 6 && cd.filter((id) => climbCardValue(id) === 1).length === 5 && climbCardValue('climb-minus1') === -1 && cd.includes('climb-plus1-5') && climbCardName('climb-minus1') === 'Climb card -1' && climbCardName('climb-plus1-2') === 'Climb card +1' && climbCardFace('climb-plus1-4') === 'climb-plus1' && climbCardFace('climb-minus1') === 'climb-minus1' && cd.every(isClimbCard) && !isClimbCard('climb-1') && CLIMB_KINDS.length === 2);
  const b = brumbyDeck();
  const count = (v) => b.filter((id) => brumbyValue(id) === v).length;
  check('R1.7 Brumby deck: 12 cards, 5 x +2, 3 x +1, Flint -1, 2 x Wombat -2, the Colt +4; total +12', b.length === 12 && new Set(b).size === 12 && count(2) === 5 && count(1) === 3 && count(-1) === 1 && count(-2) === 2 && count(4) === 1 && brumbyValue('colt') === 4 && brumbyValue('brumby-flint') === -1 && sum(b.map(brumbyValue)) === 12 && b.every(isBrumby) && !isBrumby('escape-1') && !isBrumby('climb-minus1'));
  check('R1.7 Brumby ids and names', b.includes('brumby-plus2-5') && b.includes('brumby-plus1-3') && b.includes('brumby-wombat-2') && brumbyName('colt') === 'The Colt from old Regret +4' && brumbyName('brumby-wombat-1') === 'Wombat hole -2' && BRUMBY_KINDS.length === 5);
  const g = createGame({ seed: 'r18', players: 3 });
  check('R1.8 not in the game: Mountain, marker, Chase / Watch, split values, hand turning, trick points, a trumps card', !['choices', 'handsTurned', 'marker', 'revealed', 'choiceOrder'].some((k) => k in g) && !('CHASE_COST_BY_COUNT' in CONSTANTS) && !('TRICK_POINTS' in CONSTANTS) && !('chaseCost' in g.params) && getActionBlockReason(g, { type: 'summit', choice: 'chase' }) !== null && getValidActions(g).every((a) => a.type === 'play'));
  check('R1.9 card totals: 48 + 6 + 12 = 66 at 2-4 players, 60 + 6 + 12 = 78 at 5', [2, 3, 4].every((n) => fullDeck(n).length + cd.length + b.length === 66) && fullDeck(5).length + cd.length + b.length === 78);
  check('R1.10 2 to 5 players: 1 and 6 are rejected by the engine, 2-5 accepted', [0, 1, 6].every((n) => throws(() => createGame({ seed: 1, players: n }), /2 to 5 players/)) && [2, 3, 4, 5].every((n) => createGame({ seed: 1, players: n }).n === n) && CONSTANTS.MIN_PLAYERS === 2 && CONSTANTS.MAX_PLAYERS === 5);
  check('R1.10 the setup offers 2 to 5 players (game-config)', same(PLAYER_COUNTS, [2, 3, 4, 5]) && MAX_SEATS === 5);
  const offered = botLevels().filter((x) => x.offered).map((x) => x.id);
  check('R1.11 bot levels Easy, Medium, Hard are offered', ['easy', 'medium', 'hard'].every((id) => offered.includes(id)));
  check('R1.13 no variants: VARIANTS empty, any rule name refused, rules code std', VARIANTS.length === 0 && same(DEFAULT_RULES, {}) && same(resolveVariants({}), {}) && throws(() => resolveVariants({ COLT: '3' }), /Unknown rule/) && rulesCode({}, 3) === 'std' && createGame({ seed: 1, players: 5 }).rulesCode === 'std');
}

// ---------------- 2. Game structure ----------------
{
  const g2 = easyGame(2, 'r2-2'); const g3 = easyGame(3, 'r2-3'); const g4 = easyGame(4, 'r2-4'); const g5 = easyGame(5, 'r2-5');
  check('R2.1 hands per game: 3 at 2p, 3 at 3p, 4 at 4p, 5 at 5p', g2.state.handLog.length === 3 && g3.state.handLog.length === 3 && g4.state.handLog.length === 4 && g5.state.handLog.length === 5 && g5.state.phase === 'over');
  const fixedDealer = createGame({ seed: 5, players: 3, firstDealer: 2 });
  const draws = new Set(Array.from({ length: 40 }, (_, i) => createGame({ seed: `fd${i}`, players: 4 }).firstDealer));
  check('R2.2 first dealer: from setup when given, otherwise drawn from the seeded RNG (same seed, same dealer)', fixedDealer.firstDealer === 2 && fixedDealer.dealer === 2 && draws.size > 1 && createGame({ seed: 'fd1', players: 4 }).firstDealer === createGame({ seed: 'fd1', players: 4 }).firstDealer && throws(() => createGame({ seed: 1, players: 3, firstDealer: 3 })));
  const recs = g5.state.handLog;
  const f = g5.state.firstDealer;
  check('R2.3 the deal passes left each hand; the dealer\'s left leads the climb', recs.every((h, i) => h.dealer === (f + i) % 5 && h.firstLeader === (h.dealer + 1) % 5 && h.tricks[0].leader === h.firstLeader));
  const d2 = easyGame(2, 'two', { firstDealer: 1 }).state.handLog.map((h) => h.dealer);
  check('R2.4 at 2 players the dealer runs d, other, d', same(d2, [1, 0, 1]));
  const sets = g3.state.handLog.map((h) => JSON.stringify(h.tricks.flatMap((t) => t.plays.map((p) => p.card)).sort()));
  check('R2.5 all cards are gathered and reshuffled for every hand (each 3p hand deals a different set of 36)', new Set(sets).size === 3);
  const s = createGame({ seed: 'r26', players: 3 });
  easyUntil(s, (st) => st.handNo === 1);
  check('R2.6 each new hand: empty piles and taken cards, no Brumby row, a fresh Climb row of 6', s.handNo === 1 && s.phase === 'climb' && s.piles.every((p) => p.length === 0) && s.kept.every((k) => k.length === 0) && s.climbCards.every((k) => k.length === 0) && s.row.length === 0 && s.climbRow.length === 6 && s.climbRow.every((id) => id !== null) && s.trickNo === 0 && s.climbTrickNo === 0 && s.descentTrickNo === 0 && sum(s.climbTricks) === 0);
  const n0 = createGame({ seed: 'r27', players: 4 });
  check('R2.7 a new game: scores 0, all 12 Brumby cards in one face-down deck, empty discard', n0.totals.every((t) => t === 0) && n0.brumbyDeck.length === 12 && new Set(n0.brumbyDeck).size === 12 && n0.brumbyDiscard.length === 0 && n0.handLog.length === 0);
}

// ---------------- 3. The deal ----------------
{
  const outs = [2, 3, 4, 5].map((n) => { const g = createGame({ seed: `d${n}`, players: n }); return [g.hands.every((h) => h.length === 12), g.out.length]; });
  check('R3.1 12 cards each; out 24 / 12 / 0 / 0 at 2 / 3 / 4 / 5 players', outs.every((o) => o[0]) && same(outs.map((o) => o[1]), [24, 12, 0, 0]));
  const g = createGame({ seed: 'r32', players: 2 });
  const out = new Set(g.out);
  const played = easyGame(2, 'r32').state.handLog[0].tricks.flatMap((t) => t.plays.map((p) => p.card));
  check('R3.2 the cards out stay out all hand: never played, never in any view', played.every((c) => !out.has(c)) && [0, 1].every((v) => { const text = JSON.stringify(viewFor(g, v)); return [...out].every((c) => !text.includes(`"${c}"`)); }));
  const s = createGame({ seed: 'r33', players: 3 });
  const before = s.hands.map((h) => [...h].sort());
  easyUntil(s, (st) => st.phase === 'descent');
  const allPlayed = s.tricks.flatMap((t) => t.plays);
  check('R3.3 nothing turns: at the summit the cards held are the same single-number cards, no turned flag', !('handsTurned' in s) && s.hands.every((h, seat) => h.every((c) => before[seat].includes(c)) && h.length + allPlayed.filter((p) => p.seat === seat).length === 12));
  const fixed = { hands: [fullDeck().slice(0, 12), fullDeck().slice(12, 24)] };
  const fx = createGame({ seed: 'r34', players: 2, deals: [fixed] });
  check('R3.4 a fixed deal (test hook) gives each seat its 12 cards; the rest are out', same(fx.hands[0], sortCards(fixed.hands[0])) && same(fx.hands[1], sortCards(fixed.hands[1])) && fx.out.length === 24 && throws(() => createGame({ seed: 1, players: 2, deals: [{ hands: [fullDeck().slice(0, 12), fullDeck().slice(0, 12)] }] })));
  const positions = new Set();
  const g5 = easyGame(5, 'r35').state;
  for (const h of g5.handLog) positions.add(h.minusPosition);
  for (let i = 0; i < 30; i++) positions.add(createGame({ seed: `cr${i}`, players: 3 }).climbRow.map(climbCardValue).indexOf(-1) + 1);
  const v0 = viewFor(createGame({ seed: 'cr0', players: 3 }), 1);
  check('R3.5 straight after the deal the six Climb cards are laid face up, shuffled every hand (the -1 moves)', positions.size === 6 && g5.handLog.every((h) => h.climbRow.length === 6 && same(h.climbRowValues.slice().sort(), [-1, 1, 1, 1, 1, 1])) && v0.climbRow.length === 6 && v0.climbRowValues.length === 6 && v0.climbNext === 0);
  const hk = createGame({ seed: 'r35h', players: 2, deals: [{ hands: fixed.hands, climbRow: [1, -1, 1, 1, 1, 1] }, { hands: fixed.hands, climbRow: CLIMB6 }] });
  check('R3.5 test hook: a fixed Climb row by values or ids', same(hk.climbRow.map(climbCardValue), [1, -1, 1, 1, 1, 1]) && hk.climbRow[1] === 'climb-minus1' && throws(() => createGame({ seed: 1, players: 2, deals: [{ hands: fixed.hands, climbRow: [-1, -1, 1, 1, 1, 1] }] }), /Climb row/));
  check('R3.6 every dealt card is played: 12 x n plays a hand', g5.handLog.every((h) => h.tricks.length === 12 && sum(h.tricks.map((t) => t.plays.length)) === 60));
}

// ---------------- 4. The climb ----------------
{
  const s = createGame({ seed: 'r41', players: 3 });
  const v = viewFor(s, s.toAct);
  check('R4.1 the hand starts in the climb, the dealer\'s left to lead; highest wins, Escape trumps', s.phase === 'climb' && s.toAct === (s.dealer + 1) % 3 && s.params.climbTricks === 6 && v.direction === 'highest' && v.trump === 'escape' && v.half === 'climb');
  check('R4.2 the leader may lead any card', getValidActions(s).length === 12);
  check('R4.3 must follow the led suit if able, else any card', same(playableCards(['climb-2', 'home-4', 'climb-9'], 'climb'), ['climb-2', 'climb-9']) && same(playableCards(['home-4', 'escape-1'], 'climb'), ['home-4', 'escape-1']));
  {
    const p = position({ players: 3, hands: [['climb-2', 'home-1'], ['climb-9', 'home-2'], ['climb-4', 'home-3']], leader: 1 });
    p.manualSeats = [2];
    applyAction(p, { type: 'play', card: 'climb-9' });
    check('R4.3 a following seat is told why an off-suit card is refused', /must follow suit: Climb was led, and you hold Climb 4/.test(getPlayBlockReason(p, 2, 'home-3')) && getActionBlockReason(p, { type: 'play', card: 'home-3' }) !== null);
  }
  {
    const p = position({ players: 3, hands: [['climb-5', 'descent-3'], ['escape-1', 'home-3'], ['climb-7', 'descent-2']] });
    const r = getActionBlockReason(p, { type: 'play', card: 'descent-3' });
    const evs = play(p, 'climb-5', 'escape-1', 'climb-7');
    const won = evs.find((e) => e.type === 'trick-won');
    check('R4.2 the leader may lead any card (no block reason)', r === null);
    check('R4.4 any Escape played on the climb wins: a void seat trumps the led suit with Escape 1', won.winner === 1 && won.byTrump === true && won.card === 'escape-1');
  }
  check('R4.4 the highest Escape wins when several are played', tw([[0, 'climb-5'], [1, 'escape-3'], [2, 'escape-11'], [3, 'climb-12']], 'climb', 'climb').seat === 2);
  check('R4.4 no trump played: the highest card of the led suit wins', tw([[0, 'descent-5'], [1, 'descent-12'], [2, 'climb-12']], 'descent', 'climb').seat === 1);
  check('R4.4 Escape led is simply the led suit and trumps: highest Escape wins, not "by trump"', tw([[0, 'escape-2'], [1, 'escape-9'], [2, 'home-12']], 'escape', 'climb').seat === 1 && tw([[0, 'escape-2'], [1, 'escape-9']], 'escape', 'climb').byTrump === false);
  check('R4.5 Home is not trumps on the climb; a card neither Escape nor led never wins', tw([[0, 'climb-3'], [1, 'home-12'], [2, 'descent-12']], 'climb', 'climb').seat === 0);
  check('R4.6 a tie between played cards goes to the first card played', tw([[2, 'climb-5'], [0, 'climb-5']], 'climb', 'climb').seat === 2 && tw([[1, 'escape-4'], [0, 'climb-9'], [2, 'escape-4']], 'climb', 'climb').seat === 1);
  {
    // a hand-made state with a duplicated card (impossible in play) resolves the tie through applyAction too
    const p = position({ players: 2, hands: [['climb-5', 'home-1'], ['climb-6', 'home-2']] });
    p.hands[1] = ['climb-5', 'home-2'];
    const evs = play(p, 'climb-5', 'climb-5');
    check('R4.6 through applyAction: two equal cards, the leader\'s (first) wins', evs.find((e) => e.type === 'trick-won').winner === 0);
  }
  {
    const p = position({ players: 3, hands: [['climb-5', 'climb-1', 'descent-3'], ['climb-9', 'home-3', 'home-4'], ['climb-7', 'descent-2', 'descent-4']], climbTrickNo: 2, climbTricks: [1, 1, 0], climbRow: CLIMB6 });
    const evs = play(p, 'climb-5', 'climb-9', 'climb-7');
    const taken = evs.find((e) => e.type === 'climb-card-taken');
    check('R4.7 the winner takes the trick into their one pile and leads the next', p.toAct === 1 && p.leader === 1 && p.piles[1].length === 3 && p.climbTricks[1] === 2);
    check('R4.8 climb trick i takes the Climb card at position i, good or bad: trick 3 takes the -1', taken.position === 3 && taken.card === 'climb-minus1' && taken.value === -1 && taken.winner === 1 && p.climbCards[1].includes('climb-minus1') && p.climbRow[2] === null && p.climbTrickNo === 3 && viewFor(p, 0).climbNext === 3);
    check('R4.11 a climb trick yields trick-won (winner, led suit, cards in order, trump?) and climb-card-taken', evs.map((e) => e.type).join() === 'card-played,card-played,card-played,trick-won,climb-card-taken' && same(evs[3].plays.map((x) => x.card), ['climb-5', 'climb-9', 'climb-7']) && evs[3].ledSuit === 'climb' && evs[3].byTrump === false && evs[3].direction === 'highest');
  }
  {
    const s4 = createGame({ seed: 'r49', players: 4 });
    const evs = easyUntil(s4, (st) => st.phase === 'descent');
    check('R4.9 after exactly the 6th climb trick the summit comes, every hand holding 6, the Climb row empty', s4.climbTrickNo === 6 && s4.trickNo === 6 && s4.hands.every((h) => h.length === 6) && s4.climbRow.every((x) => x === null) && evs.filter((e) => e.type === 'trick-won').length === 6 && evs.filter((e) => e.type === 'summit-opened').length === 1);
  }
  {
    const hands3 = [['climb-5', 'escape-2', 'escape-3'], ['climb-9', 'home-3', 'home-4'], ['climb-7', 'descent-2', 'descent-3']];
    const p = position({ players: 3, hands: hands3, climbTrickNo: 0 });
    const evs = play(p, 'climb-5');
    const autos = evs.filter((e) => e.type === 'card-played' && e.auto);
    check('R4.10 a single legal card is played automatically and marked auto', autos.length === 2 && autos.map((e) => e.card).join() === 'climb-9,climb-7' && p.toAct === 1 && getValidActions(p).length === 2);
    const m = position({ players: 3, hands: hands3, climbTrickNo: 0 });
    m.manualSeats = [1];
    play(m, 'climb-5');
    check('R4.10 a manual (learner) seat is not auto-played', m.toAct === 1 && m.trick.plays.length === 1);
  }
}

// ---------------- 5. The summit ----------------
{
  const order = brumbyDeck().reverse(); // colt first
  const s = createGame({ seed: 'r5', players: 3, brumbyDeck: order });
  const evs = easyUntil(s, (st) => st.phase === 'descent');
  const op = evs.find((e) => e.type === 'summit-opened');
  const i1 = evs.findIndex((e) => e.type === 'summit-opened');
  const lastClimb = evs.filter((e) => e.type === 'trick-won').pop().winner;
  check('R5.1 the summit comes straight after the 6th climb trick (its Climb card), in the same engine step', i1 === evs.length - 1 && evs[i1 - 1].type === 'climb-card-taken' && evs[i1 - 1].position === 6);
  check('R5.2 from the summit lowest wins and Home is trumps', op.trump === 'home' && op.direction === 'lowest' && viewFor(s, 0).trump === 'home' && viewFor(s, 0).direction === 'lowest' && viewFor(s, 0).half === 'descent');
  check('R5.3 the top 6 Brumby cards of the deck are laid face up, left to right', same(s.row, order.slice(0, 6)) && same(op.row, order.slice(0, 6)) && s.brumbyDeck.length === 6 && same(s.brumbyDeck, order.slice(6)) && op.rowValue === sum(order.slice(0, 6).map(brumbyValue)));
  check('R5.4 no decision at the summit: the next action is a card by the descent leader; no summit action exists', s.phase === 'descent' && s.toAct === lastClimb && getValidActions(s).every((a) => a.type === 'play') && getValidActions(s).length === 6 && getActionBlockReason(s, { type: 'summit', choice: 'watch' }) !== null);
  const full = easyGame(4, 'r54').state;
  check('R5.4 everyone plays all six descent tricks, every hand', full.handLog.every((h) => h.tricks.filter((t) => t.half === 'descent').every((t) => t.plays.length === 4) && sum(h.descentTricks) === 6));
  let rested = false;
  const t = createGame({ seed: 'r55', players: 2 });
  while (t.toAct !== null) { applyAction(t, easy.chooseAction(viewFor(t, t.toAct), makeRng(`r55-${t.trickNo}`))); if (t.phase === 'summit' || t.phase === 'handEnd') rested = true; }
  check('R5.5 the summit is one engine step: no state at rest is in phase summit (or handEnd)', !rested);
}

// ---------------- 6. The descent ----------------
{
  const s = createGame({ seed: 'r61', players: 4 });
  easyUntil(s, (st) => st.phase === 'descent');
  const lastClimb = s.tricks[5].winner;
  check('R6.1 the winner of the last climb trick leads the first descent trick', s.toAct === lastClimb && s.leader === lastClimb);
  check('R6.2 the descent leader may lead any card; must-follow unchanged', getValidActions(s).length === 6 && same(playableCards(['home-2', 'climb-3'], 'climb'), ['climb-3']));
  check('R6.3 any Home played on the descent wins: Home 12 beats a led Climb 1', tw([[0, 'climb-1'], [1, 'home-12']], 'climb', 'descent').seat === 1 && tw([[0, 'climb-1'], [1, 'home-12']], 'climb', 'descent').byTrump);
  check('R6.3 the LOWEST Home wins (Home 2 beats Home 5); no Home: the lowest of the led suit wins', tw([[0, 'descent-1'], [1, 'home-5'], [2, 'home-2']], 'descent', 'descent').seat === 2 && tw([[0, 'descent-9'], [1, 'descent-3'], [2, 'descent-7']], 'descent', 'descent').seat === 1);
  check('R6.3 Home led is the led suit and trumps: lowest Home wins', tw([[0, 'home-9'], [1, 'home-3'], [2, 'escape-1']], 'home', 'descent').seat === 1);
  check('R6.4 Escape is not trumps on the descent; the Muster never is', tw([[0, 'descent-6'], [1, 'escape-1']], 'descent', 'descent').seat === 0 && tw([[0, 'descent-6'], [1, 'muster-1']], 'descent', 'descent').seat === 0);
  check('R6.5 a tie on the descent goes to the first card played', tw([[3, 'descent-6'], [1, 'descent-6']], 'descent', 'descent').seat === 3 && tw([[1, 'home-7'], [2, 'home-7']], 'climb', 'descent').seat === 1);
  {
    const row = ['colt', 'brumby-wombat-1', 'brumby-plus2-1', 'brumby-plus1-1', 'brumby-flint', 'brumby-wombat-2'];
    const p = position({ players: 3, phase: 'descent', hands: [['climb-1', 'climb-3'], ['climb-12', 'home-5'], ['climb-11', 'descent-5']], row, descentTrickNo: 4, descentTricks: [2, 1, 1], climbTricks: [2, 2, 2], handsPerGame: 1 });
    p.manualSeats = [0, 1, 2];
    const evs = play(p, 'climb-1', 'climb-12', 'climb-11');
    const tk = evs.find((e) => e.type === 'brumby-taken');
    check('R6.6 the winner of descent trick i takes row position i (lowest wins: Climb 1 takes the Flint)', tk && tk.position === 5 && tk.card === 'brumby-flint' && tk.winner === 0 && p.kept[0].includes('brumby-flint') && p.row[4] === null);
    check('R6.11 a descent trick yields trick-won, then brumby-taken', evs.findIndex((e) => e.type === 'trick-won') === evs.findIndex((e) => e.type === 'brumby-taken') - 1 && evs.find((e) => e.type === 'trick-won').direction === 'lowest');
    check('R6.7 the winner leads the next descent trick', p.toAct === 0 && p.leader === 0);
    const evs2 = play(p, 'climb-3', 'home-5', 'descent-5');
    const tk2 = evs2.find((e) => e.type === 'brumby-taken');
    check('R6.6 good or bad: a Home trump takes the Wombat hole; nobody can refuse it', tk2 && tk2.winner === 1 && tk2.card === 'brumby-wombat-2' && tk2.position === 6 && p.handLog[0].kept[1].includes('brumby-wombat-2'));
    check('R6.8 the 6th trick takes the last card; the row is empty after the hand', p.row.length === 0 && p.phase === 'over' && p.handLog[0].row.length === 6);
  }
  {
    const L = easyGame(4, 'r69', { brumbyDeck: brumbyDeck() }).state.handLog; // hand 1 row = 5 x +2, 1 x +1: no Colt
    check('R6.9 a row without the Colt plays exactly the same', !L[0].colt && L[0].coltTrick === null && L[0].coltWinner === null && sum(L[0].descentTricks) === 6 && L[1].colt);
  }
  {
    const row = ['brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus2-3', 'brumby-plus2-4', 'brumby-plus2-5', 'colt'];
    const p = position({ players: 2, phase: 'descent', hands: [['climb-6'], ['climb-2']], row, descentTrickNo: 5, climbTricks: [3, 3], descentTricks: [2, 3], handsPerGame: 1 });
    play(p, 'climb-6');
    check('R6.10 no rule names the Colt or the Home 1: the Colt goes to the trick winner (Climb 2, lowest)', p.handLog[0].coltWinner === 1 && p.handLog[0].coltTrick === 6 && p.handLog[0].kept[1].includes('colt'));
  }
}

// ---------------- 7. Scoring ----------------
{
  const row = ['brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus2-3', 'brumby-plus2-4', 'brumby-flint', 'brumby-wombat-1'];
  const climbCards = [['climb-plus1-1', 'climb-plus1-2', 'climb-plus1-3'], ['climb-minus1'], ['climb-plus1-4', 'climb-plus1-5']];
  const p = position({ players: 3, phase: 'descent', hands: [['climb-12'], ['climb-1'], ['climb-11']], row, descentTrickNo: 5, climbTricks: [3, 1, 2], descentTricks: [2, 2, 1], climbCards, kept: [['brumby-plus2-1', 'brumby-plus2-2'], ['brumby-plus2-3', 'brumby-flint'], ['brumby-plus2-4']], handsPerGame: 1 });
  p.row = [null, null, null, null, null, 'brumby-wombat-1'];
  const evs = play(p, 'climb-12');
  const he = evs.find((e) => e.type === 'hand-ended');
  const b = he.breakdown;
  check('R7.1 hand score = Climb card values + Brumby card values', b.every((x) => x.score === x.climbValue + x.keptValue) && b[0].climbValue === 3 && b[0].keptValue === 4 && b[0].score === 7);
  check('R7.2 tricks score nothing: seat 1 won 4 tricks (Climb -1, Brumby +2, Flint, Wombat) and scores -2', b[1].tricks === 4 && b[1].climbValue === -1 && b[1].keptValue === -1 && b[1].score === -2 && same(b[1].kept, ['brumby-plus2-3', 'brumby-flint', 'brumby-wombat-1']));
  check('R7.3 hand scores and totals may be negative', p.totals[1] === -2 && he.scores[1] === -2);
  check('R7.4 the hand score is added to the pad once, when the 6th descent trick is complete', same(p.totals, he.scores) && evs.filter((e) => e.type === 'hand-ended').length === 1);
  check('R7.5 sum of hand scores = 4 (the Climb row) + the row value', sum(he.scores) === 4 + he.rowValue && he.rowValue === 5);
  const rec = p.handLog[0];
  check('R7.6 the hand record: tricks, Climb row, -1 position and winner, Climb and Brumby cards and values, row, Colt, top Home, Home 1, reshuffled', ['climbTricks', 'descentTricks', 'trickCounts', 'climbRow', 'climbRowValues', 'minusPosition', 'minusWinner', 'climbCards', 'climbValues', 'kept', 'keptValues', 'scores', 'row', 'rowValues', 'rowValue', 'colt', 'coltTrick', 'coltWinner', 'topHomeSeat', 'home1Seat', 'reshuffled'].every((k) => k in rec) && rec.colt === false && rec.coltWinner === null && rec.minusPosition === 6 && same(rec.climbValues, [3, -1, 2]));
  const g = createGame({ seed: 'top', players: 3 });
  const dealt1 = g.hands.findIndex((h) => h.includes('home-1'));
  easyUntil(g, (st) => st.phase === 'descent');
  let want = null; let bv = 99;
  g.hands.forEach((h, s) => h.forEach((c) => { if (c.startsWith('home-') && cardNumber(c) < bv) { bv = cardNumber(c); want = s; } }));
  check('R7.6 topHomeSeat = holder at the summit of the lowest-numbered Home card still in hand; home1Seat = dealt Home 1 (or null)', g.topHomeSeat === want && g.home1Seat === (dealt1 < 0 ? null : dealt1));
  const r = createGame({ seed: 'mw', players: 4, deals: [{ climbRow: [1, 1, -1, 1, 1, 1] }] });
  easyUntil(r, (st) => st.handNo === 1);
  const mrec = r.handLog[0];
  check('R7.6 minusPosition and minusWinner record the -1 Climb card', mrec.minusPosition === 3 && mrec.minusWinner === mrec.tricks[2].winner && mrec.climbCards[mrec.minusWinner].includes('climb-minus1'));
  check('R7 reckonHand agrees with the hand record', same(reckonHand({ n: 3, climbTricks: rec.climbTricks, descentTricks: rec.descentTricks, climbCards: rec.climbCards, kept: rec.kept }).scores, rec.scores));
}

// ---------------- 8. The Brumby deck across hands ----------------
{
  const order = brumbyDeck();
  const { state, events } = easyGame(4, 'r8', { brumbyDeck: order });
  const L = state.handLog;
  const resh = events.filter((e) => e.type === 'brumby-reshuffled');
  check('R8.1 / R8.5 hands 1 and 2 use the same shuffle: hand 1 the top 6, hand 2 the other 6', same(L[0].row, order.slice(0, 6)) && same(L[1].row, order.slice(6)) && L[0].reshuffled && !L[1].reshuffled);
  check('R8.2 a game starts with all 12 shuffled into one deck and an empty discard', events[0].type === 'game-started' && events.find((e) => e.type === 'hand-started').deckCount === 12 && events.find((e) => e.type === 'hand-started').discardCount === 0);
  check('R8.3 at the end of a hand every Brumby card of its row goes to the discard', events.filter((e) => e.type === 'hand-started' && e.handNo === 1).every((e) => e.discardCount === 6 && e.deckCount === 6));
  check('R8.4 fewer than 6 left: all 12 are shuffled together (after hand 2 only, not after the last hand)', resh.length === 1 && resh[0].handNo === 2 && resh[0].deckCount === 12 && L[2].reshuffled && !L[3].reshuffled);
  check('R8.5 hand 3 starts a fresh shuffle; at 4 players hand 4 takes the other 6', same([...L[2].row, ...L[3].row].sort(), [...order].sort()) && state.brumbyDeck.length === 0 && state.brumbyDiscard.length === 12);
  const g3 = easyGame(3, 'r8-3').state;
  check('R8.5 a 3-hand game: hand 3 starts a fresh shuffle; it ends with 6 in the deck, 6 discarded', g3.handLog[2].reshuffled && g3.brumbyDeck.length === 6 && g3.brumbyDiscard.length === 6);
  const g5 = easyGame(5, 'r8-5').state;
  check('R8.5 at 5 players hand 5 starts a fresh shuffle', same(g5.handLog.map((h) => h.reshuffled), [true, false, true, false, true]));
  check('R8.5 the Colt is in exactly one of the two rows of each shuffle', [easyGame(4, 'colt-a').state, easyGame(4, 'colt-b').state].every((st) => st.handLog[0].colt !== st.handLog[1].colt && st.handLog[2].colt !== st.handLog[3].colt));
  check('R8.6 the order of the row is the order dealt', same(L[0].tricks.filter((t) => t.half === 'descent').map((t) => t.prize), order.slice(0, 6)));
  const h1 = { hands: [fullDeck().slice(0, 12), fullDeck().slice(12, 24), fullDeck().slice(24, 36)], row: [4, 2, 2, 2, 2, 2] };
  const s = createGame({ seed: 'hook', players: 3, deals: [h1, { hands: h1.hands, row: [2, 1, 1, 1, -1, -2] }, { hands: h1.hands, row: [4, 2, 2, 2, 2, 2] }] });
  easyUntil(s, (st) => st.phase === 'descent');
  check('R8.7 test hook: a fixed row by values takes the first such cards from the deck, in the given order', same(s.row.map(brumbyValue), [4, 2, 2, 2, 2, 2]) && s.row[0] === 'colt' && s.brumbyDeck.length === 6);
  const bad = createGame({ seed: 'hook2', players: 3, deals: [{ hands: h1.hands, row: [4, 4, 2, 2, 2, 2] }] });
  check('R8.7 test hook: a row the deck cannot supply throws', throws(() => easyUntil(bad, (st) => st.phase === 'descent'), /not in the Brumby deck/));
  check('R8.7 the deck order is in no view; only its count', [0, 1, 2].every((v) => { const view = viewFor(s, v); return !('brumbyDeck' in view) && view.deckCount === 6; }));
  const c = createGame({ seed: 'r88', players: 3 });
  easyUntil(c, (st) => st.handNo === 1);
  check('R8.8 the Climb cards do not persist: after a hand all six are back in a fresh row, nobody holds any', c.climbRow.length === 6 && same(c.climbRow.slice().sort(), climbCardDeck().sort()) && c.climbCards.every((k) => k.length === 0));
}

// ---------------- 9. Order of events and game end ----------------
{
  const { events } = easyGame(3, 'r9');
  const types = events.map((e) => e.type);
  const tw1 = types.indexOf('trick-won');
  check('R9.1 end of a climb trick: the last card-played, trick-won, climb-card-taken, then the next lead', types[tw1 - 1] === 'card-played' && types[tw1 + 1] === 'climb-card-taken' && types[tw1 + 2] === 'card-played');
  const so = types.indexOf('summit-opened');
  check('R9.2 the summit: 6th climb-card-taken, summit-opened, then the first descent card', types[so - 1] === 'climb-card-taken' && events[so - 1].position === 6 && types[so + 1] === 'card-played' && events[so + 1].half === 'descent' && events[so + 1].seat === events[so].leader);
  const i = types.indexOf('hand-ended');
  check('R9.3 end of hand: last brumby-taken, hand-ended (scores), then the next hand-started (hand 1 -> 2, no reshuffle)', types[i - 1] === 'brumby-taken' && types[i + 1] === 'hand-started');
  const j = types.indexOf('hand-ended', i + 1);
  check('R9.3 after hand 2: hand-ended, brumby-reshuffled, hand-started', types.slice(j, j + 3).join() === 'hand-ended,brumby-reshuffled,hand-started');
  check('R9.3 after the last hand: hand-ended, game-over', types[types.length - 1] === 'game-over' && types[types.length - 2] === 'hand-ended');
  const fake = (totals, last) => gameResult({ n: totals.length, totals, handLog: [{ scores: last.map(() => 0) }, { scores: last }], measures: { tricks: 24 } });
  const r1 = fake([10, 10, 7], [3, 6, 9]);
  check('R9.4 the highest total wins', same(fake([12, 9, 4], [1, 1, 1]).winners, [0]) && !fake([12, 9, 4], [1, 1, 1]).tiebreakUsed);
  check('R9.5 tie on total: the most points in the last hand wins', same(r1.winners, [1]) && r1.tiebreakUsed && !r1.shared && same(r1.tiedOnTotal, [0, 1]));
  const r2 = fake([10, 10, 3], [4, 4, 9]);
  check('R9.5 still tied: a shared win', same(r2.winners, [0, 1]) && r2.shared && !r2.tiebreakUsed);
  check('R9.6 the tiebreak applies only among the players tied for the highest total', same(r1.winners, [1]) && r1.lastHandScores[2] === 9);
  const r3 = fake([5, 8, 8, 5], [2, 1, 1, 4]);
  check('R9.7 ranking by total then last hand; equal on both share a rank', same(r3.ranking.map((x) => [x.seat, x.rank]), [[1, 1], [2, 1], [3, 3], [0, 4]]) && r3.shared);
  check('R9.7 the result explains a tiebreak in plain English', /tiebreak: most points in the last hand \(6 against 3\)/.test(describeEvent({ type: 'game-over', ...r1 }, ['A', 'B', 'C'])) && /Shared win/.test(describeEvent({ type: 'game-over', ...r2 })));
  const neg = fake([-3, -5], [-1, 0]);
  check('R9.8 scores are integers, negatives allowed; no draws (a tie is a shared win)', [r1, r2, r3, neg].every((r) => r.totals.every(Number.isInteger) && r.winners.length >= 1) && same(neg.winners, [0]));
}

// ---------------- 10. The player view ----------------
{
  const s = createGame({ seed: 'r10', players: 3 });
  const v0 = viewFor(s, 1);
  check('R10.1 own hand in full; no turned-hand flag', same(v0.hand, s.hands[1]) && !('handsTurned' in v0));
  const t0 = JSON.stringify(v0);
  check('R10.2 other seats: hand sizes only, never their cards', same(v0.handCounts, [12, 12, 12]) && [0, 2].flatMap((x) => s.hands[x]).every((c) => !t0.includes(`"${c}"`)));
  check('R10.5 (a) the Climb row face up from the deal: ids, values, next position', same(v0.climbRow, s.climbRow) && same(v0.climbRowValues, s.climbRow.map(climbCardValue)) && v0.climbNext === 0 && v0.row.length === 0 && v0.rowNext === null);
  check('R10.12 the direction-and-trumps line and the price of the trick on the climb', v0.direction === 'highest' && v0.trump === 'escape' && v0.price.half === 'climb' && v0.price.position === 1 && v0.price.value === climbCardValue(s.climbRow[0]) && v0.price.laterValues.length === 5 && v0.price.best === Math.max(...s.climbRow.slice(1).map(climbCardValue)) && v0.price.worst === Math.min(...s.climbRow.slice(1).map(climbCardValue)));
  easyUntil(s, (st) => st.phase === 'descent' && st.descentTrickNo === 3 && st.trick && st.trick.plays.length === 1);
  const w = viewFor(s, 0);
  const text = JSON.stringify(w);
  check('R10.3 public counts and table state: trick counts (and split), dealer, leader, phase, direction, trump, totals', same(w.climbTricks, s.climbTricks) && w.trickCounts.reduce((a, b) => a + b, 0) === 9 && w.dealer === s.dealer && w.leader === s.leader && w.phase === 'descent' && w.direction === 'lowest' && w.trump === 'home' && same(w.totals, s.totals) && w.handNo === 0 && w.trickNo === 9);
  check('R10.4 the current trick: plays so far, led suit, the card winning it now', w.trick && w.trick.plays.length === 1 && w.trick.ledSuit === w.trick.plays[0].card.split('-')[0] && w.trick.best.seat === w.trick.plays[0].seat);
  check('R10.5 (b) the Brumby row: slots (null = taken), values, as dealt, the next position', same(w.row, s.row) && w.row.slice(0, 3).every((x) => x === null) && same(w.rowValues.slice(3), s.row.slice(3).map(brumbyValue)) && same(w.rowDealt, s.rowDealt) && w.rowNext === 3);
  check('R10.6 every seat\'s taken Climb and Brumby cards face up, with subtotals and the running hand score', same(w.climbCards, s.climbCards) && same(w.kept, s.kept) && w.climbValue.every((x, k) => x === sum(s.climbCards[k].map(climbCardValue))) && w.keptValue.every((x, k) => x === sum(s.kept[k].map(brumbyValue))) && w.handScore.every((x, k) => x === w.climbValue[k] + w.keptValue[k]) && sum(w.handScore) === 4 + sum(s.rowDealt.slice(0, 3).map(brumbyValue)));
  check('R10.7 the Brumby deck: count only', w.deckCount === 6 && !('brumbyDeck' in w) && s.brumbyDeck.every((id) => !text.includes(`"${id}"`)));
  check('R10.8 the discard is public (ids in order)', same(w.discard, s.brumbyDiscard));
  check('R10.9 the cards out of play: count only', w.outCount === 12 && s.out.every((c) => !text.includes(`"${c}"`)));
  check('R10.10 trick piles are counts; the trick log (this hand\'s tricks) is public history', !('piles' in w) && w.tricks.length === s.tricks.length && same(w.tricks.map((t) => t.winner), s.tricks.map((t) => t.winner)) && w.tricks.every((t) => 'prize' in t));
  const voids = shownVoids(w);
  check('R10.11 voids are inferred from the history (shownVoids), not announced', Array.isArray(voids) && voids.length === 3 && !('voids' in w));
  check('R10.12 on the descent: the price of the trick is the Brumby card on offer; best and worst still to come', w.price.half === 'descent' && w.price.position === 4 && w.price.card === s.row[3] && w.price.value === brumbyValue(s.row[3]) && same(w.price.laterValues, s.row.slice(4).map(brumbyValue)));
  const unk = unknownCards(w);
  check('R10 helpers: unknownCards = other hands + out; unseenBrumbies = the deck\'s contents', unk.length === s.hands[1].length + s.hands[2].length + s.out.length && same([...unseenBrumbies(w)].sort(), [...s.brumbyDeck].sort()));
  const world = determinise(w, makeRng('det'));
  check('R10 determinise: a full state consistent with the view (own hand, sizes, voids, deck contents, rows, taken cards)', same(world.hands[0], s.hands[0]) && world.hands.every((h, k) => h.length === s.hands[k].length) && same([...world.brumbyDeck].sort(), [...s.brumbyDeck].sort()) && same(world.climbCards, s.climbCards) && same(world.row, s.row) && same(world.kept, s.kept) && conservation(world).ok && voids.every((vs, k) => vs.every((suit) => !world.hands[k].some((c) => c.startsWith(`${suit}-`)))));
  check('R10 a determinised world plays on to the end of the game', (() => { const c = cloneState(world); easyUntil(c, () => false); return c.phase === 'over' && c.handLog.length === 3; })());
  const g5 = createGame({ seed: 'det5', players: 5 });
  easyUntil(g5, (st) => st.trickNo === 2);
  const w5 = determinise(viewFor(g5, g5.toAct), makeRng('d5'));
  check('R10 determinise at 5 players deals Muster cards too and conserves 60 cards', conservation(w5).ok && w5.hands.flat().some((c) => c.startsWith('muster-')));
  check('R10 the view is plain JSON and a fresh copy', same(roundTrip(w), w) && viewFor(s, 0) !== viewFor(s, 0));
  check('R10.13 pass-and-play covers are the UI\'s (tests/controller.mjs); the engine view holds one seat\'s hand only', !('hands' in w) && Array.isArray(w.hand));
  {
    const c = cloneState(s);
    const before = JSON.stringify(s);
    applyAction(c, getValidActions(c)[0]);
    check('R10.14 a legal-play hint can clone the state and apply the action without touching the original', JSON.stringify(s) === before && JSON.stringify(c) !== before);
  }
}

// ---------------- 11. Conservation ----------------
{
  let ok = true; let problem = '';
  for (const n of [2, 5]) {
    const s = createGame({ seed: `r11-${n}`, players: n });
    const rng = makeRng(`r11-${n}`);
    while (s.toAct !== null) { applyAction(s, easy.chooseAction(viewFor(s, s.toAct), rng)); const c = conservation(s); if (!c.ok) { ok = false; problem = problem || c.problem; } }
  }
  check('R11.1 / R11.2 / R11.3 every playing card, Brumby card and Climb card is in exactly one place after every action (2p and 5p)', ok, problem);
  {
    const p = position({ players: 2, hands: [['climb-5'], ['climb-6']] });
    p.climbCards[0].push('climb-plus1-5');
    check('R11.3 the conservation check notices a Climb card in two places', !conservation(p).ok);
  }
  {
    const p = position({ players: 2, hands: [['climb-5'], ['climb-6']] });
    p.brumbyDiscard.push(p.brumbyDeck[0]);
    check('R11.2 the conservation check notices a Brumby card in two places', !conservation(p).ok);
  }
  const g = easyGame(4, 'r115').state;
  check('R11.5 the Brumby deck and discard persist across hands (deck + discard = 12 at the end)', g.brumbyDeck.length + g.brumbyDiscard.length === 12 && g.measures.reshuffles === 2);
  check('R11.6 after each hand: 12 tricks, rows and taken piles empty, sum of scores = 4 + row value, score = Climb + Brumby', g.handLog.every((h) => sum(h.trickCounts) === 12 && sum(h.scores) === 4 + h.rowValue && h.breakdown.every((b) => b.score === b.climbValue + b.keptValue)) && g.row.length === 0 && g.climbRow.length === 0 && g.kept.every((k) => k.length === 0) && g.climbCards.every((k) => k.length === 0));
  const L = g.handLog;
  check('R11.4 a Climb card changes place only by being won: each Climb card taken is the one at its trick\'s position', L.every((h) => h.tricks.filter((t) => t.half === 'climb').every((t) => t.prize === h.climbRow[t.halfTrickNo - 1] && h.climbCards[t.winner].includes(t.prize))));
}

// ---------------- 12. Actions and bots ----------------
{
  const s = createGame({ seed: 'r12', players: 3 });
  check('R12.1 getValidActions = the legal cards of the seat to act; the only action type is play', getValidActions(s).every((a) => a.type === 'play' && s.hands[s.toAct].includes(a.card)) && same(legalActionsFromView(viewFor(s, s.toAct)), getValidActions(s)) && legalActionsFromView(viewFor(s, (s.toAct + 1) % 3)).length === 0);
  check('R12.2 a single legal option is applied automatically (see R4.10); the last card of each half is auto', (() => { const p = position({ players: 2, hands: [['climb-5', 'climb-2'], ['climb-6', 'climb-9']], climbTrickNo: 4 }); const evs = play(p, 'climb-5'); return evs.filter((e) => e.type === 'card-played' && e.auto).length === 0 && getValidActions(p).length === 2; })());
  const lv = ['medium', 'hard'].map((id) => getBot(id));
  const g = createGame({ seed: 'placeholder', players: 5 });
  let okBots = true;
  const rng = makeRng('pl');
  while (g.toAct !== null) {
    const a = lv[g.toAct % 2].chooseAction(viewFor(g, g.toAct), rng);
    if (getActionBlockReason(g, a) !== null) { okBots = false; break; }
    applyAction(g, a);
  }
  check('R12.3 / R12.4 Easy, Medium and Hard return legal actions from the view (Medium and Hard play from their own rules)', okBots && g.phase === 'over');
  check('R12 actions with an unknown shape are refused', getActionBlockReason(s, { type: 'bid', n: 3 }) !== null && throws(() => applyAction(s, { type: 'summit', choice: 'chase' })));
}

done();
