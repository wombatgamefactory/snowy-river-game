// bots.mjs - the bots (v6 rules): registry, determinism, no view mutation, only-the-view imports, legality
// of every move at 2, 3, 4 and 5 players, Medium and the naive archetype decision-matched against the Python
// simulator's own bots (tests/fixtures/bots-python-decisions.json, recorded from the Python v6 simulator by a
// script that is kept with the design notes, not in this repo),
// Medium's habits on hand-built positions, Hard (search, the compact rollout checked against the real
// engine, timing), and strength checks with counts and z-scores (Medium v Easy, Hard v Medium).
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. `--full` runs the long strength budgets.
// Run the strength part through simrun (CPU budget): python D:/data/pc-health/scripts/simrun.py node tests/bots.mjs --full

import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  createGame, startGame, applyAction, viewFor, legalActionsFromView, getValidActions, determinise, brumbyValue, climbCardValue,
  makeRng, deriveSeed, rngPick, shuffle, fullDeck,
} from '../src/engine/index.js';
import { getBot, botLevels, registerBot } from '../src/bots/index.js';
import {
  searchAction, samplesFor, worldFromState, worldSampler, playOut, handScores, HARD_SAMPLES, HARD_MIN_SAMPLES, HARD_MAX_ROLLOUTS,
} from '../src/bots/hard.js';
import { mediumActionFromState } from '../src/bots/medium.js';
import { makeArchetype, archetypeBots } from '../src/bots/archetypes.js';
import { stakes, UP, DOWN } from '../src/bots/smart-core.js';
import { suite, position, play, same } from './lib.mjs';
import { botOf, sameAction, playGame, strengthBlock, strengthResult } from './bots-lib.mjs';

const { check, done } = suite('bots');
const FULL = process.argv.includes('--full');
const COUNTS = [2, 3, 4, 5];

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const strengthLine = (label, n, r) => `${label} ${n}p: ${r.credit % 1 === 0 ? r.credit : r.credit.toFixed(1)} wins in ${r.games} games = ${pct(r.win)} (fair ${pct(1 / n)}), z = ${r.z.toFixed(1)}, mean margin ${r.margin.toFixed(2)}`;

/**
 * A strength run split over worker threads (the games are independent and seeded by index, so the answer
 * does not depend on how many workers there are). Falls back to one thread if workers are unavailable.
 */
async function strengthRun({ strong, opp, n, games, tag }) {
  const workers = Math.max(1, Math.min(8, availableParallelism() - 1, games));
  const per = Math.ceil(games / workers);
  const jobs = [];
  for (let from = 0; from < games; from += per) jobs.push({ strong, opp, n, from, to: Math.min(games, from + per), tag });
  let blocks;
  try {
    blocks = await Promise.all(jobs.map((job) => new Promise((resolve, reject) => {
      const w = new Worker(new URL('./bots-worker.mjs', import.meta.url), { workerData: job });
      w.once('message', resolve);
      w.once('error', reject);
    })));
  } catch {
    blocks = jobs.map((job) => strengthBlock(job));
  }
  return strengthResult(n, blocks);
}

// ---------- 1. registry ----------
{
  const levels = botLevels();
  check('registry: easy, medium and hard are offered', ['easy', 'medium', 'hard'].every((id) => levels.some((l) => l.id === id && l.offered)));
  check('registry: only easy, medium and hard are offered', levels.filter((l) => l.offered).length === 3);
  check('registry: the simulator archetypes (naive, plus the kit probes high and low) are registered, none offered', ['naive', 'high', 'low'].every((id) => levels.some((l) => l.id === id && !l.offered)) && archetypeBots.every((b) => levels.some((l) => l.id === b.id && !l.offered)));
  check('registry: an unknown level is refused with the known list', (() => { try { getBot('genius'); return false; } catch (e) { return /Known:/.test(e.message); } })());
  check('registry: a bot needs an id and a chooseAction', (() => { try { registerBot({ id: 'x' }); return false; } catch { return true; } })());
}

// ---------- 2. determinism, no mutation, only the view ----------
{
  const g = createGame({ seed: 77, players: 4 });
  const view = viewFor(g, g.toAct);
  let ok = true;
  for (const id of ['easy', 'medium', 'hard-fast', ...archetypeBots.map((b) => b.id)]) {
    const a = botOf(id).chooseAction(view, { s: 5 });
    const b = botOf(id).chooseAction(view, { s: 5 });
    if (!sameAction(a, b)) ok = false;
  }
  check('determinism: the same view and the same rng give the same action, for every bot', ok);
  const r1 = { s: 9 }; const r2 = { s: 9 };
  getBot('easy').chooseAction(view, r1);
  check('determinism: a bot advances only the rng it is given', r1.s !== r2.s);
  const rng = makeRng('pick');
  check('determinism: rngPick returns an element', legalActionsFromView(view).some((a) => sameAction(a, rngPick(rng, legalActionsFromView(view)))));

  // a bot is a function of its view: two worlds with the same public facts and different hidden hands give the same answer
  const w1 = createGame({ seed: 11, players: 3 });
  const w2 = createGame({ seed: 11, players: 3 });
  const other = (w2.toAct + 1) % 3;
  const k = 5; // swap hidden cards: five cards of another seat's hand trade places with five of the cards out of play
  const [swapped, kept] = [w2.hands[other].slice(0, k), w2.hands[other].slice(k)];
  w2.hands[other] = [...w2.out.slice(0, k), ...kept];
  w2.out = [...swapped, ...w2.out.slice(k)];
  const v1 = viewFor(w1, w1.toAct); const v2 = viewFor(w2, w2.toAct);
  check('only the view: two worlds that differ only in hidden cards give identical views', JSON.stringify(v1) === JSON.stringify(v2));
  check('only the view: and every bot answers them identically', ['easy', 'medium', 'hard-fast', 'naive'].every((id) => sameAction(botOf(id).chooseAction(v1, { s: 3 }), botOf(id).chooseAction(v2, { s: 3 }))));

  const imports = ['medium.js', 'hard.js', 'archetypes.js', 'smart-core.js', 'random.js', 'index.js'].flatMap((f) => {
    const src = readFileSync(new URL(`../src/bots/${f}`, import.meta.url), 'utf8');
    return [...src.matchAll(/from '([^']+)'/g)].map((m) => `${f}: ${m[1]}`);
  });
  check('only the view: the bots import the engine index and each other, never the UI, the state files or a clock', imports.every((i) => /: (\.\.\/engine\/index\.js|\.\/[a-z-]+\.js)$/.test(i)), imports.filter((i) => !/: (\.\.\/engine\/index\.js|\.\/[a-z-]+\.js)$/.test(i)).join('; '));
  const src = readFileSync(new URL('../src/bots/hard.js', import.meta.url), 'utf8') + readFileSync(new URL('../src/bots/medium.js', import.meta.url), 'utf8');
  check('only the view: no bot reads state.hands of a real state (hands are read only inside sampled worlds)', !/viewFor\(/.test(src) && !/\.out\b/.test(src.replace(/\/\/.*$/gm, '')));
}

// ---------- 3. legality at every player count ----------
{
  const MIXED = ['easy', 'medium', ...archetypeBots.map((b) => b.id)];
  const perCount = 500;
  let games = 0; let refusals = 0; let illegal = 0; let mutated = 0; let unfinished = 0; const used = new Set();
  for (const n of COUNTS) {
    for (let i = 0; i < perCount; i++) {
      // a different mixed table every game: every level meets every other, in every seat
      const levels = Array.from({ length: n }, (_, s) => MIXED[(i * 3 + s * 5 + n + Math.floor(i / MIXED.length)) % MIXED.length]);
      levels.forEach((l) => used.add(l));
      const r = playGame({ levels, seed: deriveSeed('leg', n, i), checkView: i < 40 });
      games++; refusals += r.refusals; illegal += r.illegal; mutated += r.mutated;
      if (!r.over) unfinished++;
    }
  }
  check(`legality: ${games} mixed-level games (${perCount} per player count at 2, 3, 4 and 5 players; ${[...used].length} levels) all finish`, unfinished === 0 && used.size === MIXED.length, `${unfinished} unfinished, levels used ${used.size}/${MIXED.length}`);
  check('legality: no bot ever proposes an action the view does not list, or one the engine refuses (zero refusals)', illegal === 0 && refusals === 0, `${illegal} illegal, ${refusals} refused`);
  check('legality: no bot mutates its view', mutated === 0, `${mutated}`);

  let hardGames = 0; let hardBad = 0;
  for (const n of COUNTS) {
    for (let i = 0; i < (FULL ? 100 : 60); i++) {
      const r = playGame({ levels: Array.from({ length: n }, (_, s) => (s === i % n ? 'hard-fast' : MIXED[(i + s) % 2])), seed: deriveSeed('leg-hard', n, i), checkView: i < 5 });
      hardGames++; hardBad += r.illegal + r.refusals + r.mutated + (r.over ? 0 : 1);
    }
  }
  for (const n of COUNTS) {
    for (let i = 0; i < (FULL ? 10 : 3); i++) {
      const r = playGame({ levels: Array.from({ length: n }, (_, s) => (s === i % n ? 'hard' : 'medium')), seed: deriveSeed('leg-hard-real', n, i), checkView: true });
      hardGames++; hardBad += r.illegal + r.refusals + r.mutated + (r.over ? 0 : 1);
    }
  }
  check(`legality: Hard (a 2-world search, and the real budget) plays ${hardGames} games at 2-5 players with only legal moves`, hardBad === 0, `${hardBad}`);
}

// ---------- 4. Python decision match ----------
const FX = JSON.parse(readFileSync(new URL('./fixtures/bots-python-decisions.json', import.meta.url), 'utf8'));
const DECK5 = fullDeck(5); // the fixture alphabet is fullDeck(5) order (suit id x 12 + n - 1)
const cardOf = (c) => DECK5[FX.alphabet.indexOf(c)];
{
  const botFor = (style) => (style === 'smart' ? getBot('medium') : makeArchetype('naive'));
  const st = {
    games: 0, hands: 0, cards: 0, exactBad: 0, byStyle: { smart: 0, naive: 0 }, byPhase: { climb: 0, descent: 0 }, byN: { 2: 0, 3: 0, 4: 0, 5: 0 },
    sortedSame: 0, tieOrder: 0, unexplained: 0, forced: 0, musterPlays: 0,
  };
  const firstBad = [];
  const bad = (id, what) => { if (firstBad.length < 10) firstBad.push(`${id}: ${what}`); };
  const permRng = makeRng('hand-orders');
  FX.games.forEach((fg, gi) => {
    const n = fg.n;
    const state = startGame({
      seed: `fxb:${gi}`, players: n, firstDealer: 0,
      deals: fg.hands.map((fh) => ({ hands: fh.h.map((s) => [...s].map(cardOf)), climbRow: fh.cr, row: fh.row })),
      manualSeats: Array.from({ length: n }, (_, s) => s),
    }).state;
    const rngs = Array.from({ length: n }, (_, s) => makeRng(deriveSeed('fxb', gi, s)));
    st.games++;
    for (const fh of fg.hands) {
      const plays = [...fh.p].map(cardOf);
      const seats = [...fh.s].map(Number);
      const py = fh.h.map((s) => [...s].map(cardOf)); // each seat's hand in the Python's own (dealt) order
      const handNo = state.handNo;
      let i = 0; let guard = 0;
      st.hands++;
      while (state.handLog.length === handNo && state.toAct !== null && guard++ < 500) {
        const seat = state.toAct;
        const id = `g${gi} hand ${handNo} seat ${seat}`;
        const style = fg.styles[seat];
        const view = viewFor(state, seat);
        const viewPy = { ...view, hand: py[seat].slice() };
        if (i >= plays.length || seat !== seats[i]) { bad(id, `play ${i}: engine seat ${seat}, Python seat ${seats[i]}`); st.unexplained++; break; }
        const bot = botFor(style);
        const legal = getValidActions(state);
        if (legal.length > 1) {
          st.cards++; st.byStyle[style]++; st.byPhase[state.phase]++; st.byN[n]++;
          if (plays[i].startsWith('muster-')) st.musterPlays++;
          const a = bot.chooseAction(viewPy, rngs[seat]); // the Python's hand order: must match exactly
          if (a.card !== plays[i]) { st.exactBad++; bad(id, `${style} ${state.phase} play ${i}: JS ${a.card}, Python ${plays[i]} (hand ${py[seat].join(' ')}; trick ${(view.trick ? view.trick.plays.map((p) => p.card) : []).join(' ')})`); }
          const s = bot.chooseAction(view, rngs[seat]); // the engine's sorted hand: may differ only where candidates tie
          if (s.card === plays[i]) st.sortedSame++;
          else {
            const picks = new Set([s.card]);
            for (let k = 0; k < 24; k++) picks.add(bot.chooseAction({ ...view, hand: shuffle(permRng, view.hand.slice()) }, rngs[seat]).card);
            if (picks.has(plays[i])) st.tieOrder++;
            else { st.unexplained++; bad(id, `${style} ${state.phase} play ${i}: JS picks ${[...picks].join('/')} in every hand order, Python ${plays[i]}`); }
          }
        } else st.forced++;
        applyAction(state, { type: 'play', card: plays[i] });
        py[seat].splice(py[seat].indexOf(plays[i]), 1);
        i++;
      }
    }
  });
  const pyPlays = Object.values(FX.counts).reduce((a, c) => a + c.plays, 0);
  console.log(`  decision match: ${st.games} Python games, ${st.hands} hands, ${pyPlays} recorded plays (${st.forced} forced, ${st.cards} decisions with 2+ legal cards)`);
  console.log(`    card play, fed the Python's hand order: ${st.cards} decisions (smart ${st.byStyle.smart}, naive ${st.byStyle.naive}; climb ${st.byPhase.climb}, descent ${st.byPhase.descent}; 2p ${st.byN[2]}, 3p ${st.byN[3]}, 4p ${st.byN[4]}, 5p ${st.byN[5]}): ${st.exactBad} mismatches`);
  console.log(`    card play on the engine's sorted hand: ${st.sortedSame} the same card, ${st.tieOrder} a different card of equal worth (tie order: the Python's card is one the port picks in some hand order), ${st.unexplained} unexplained`);
  for (const f of firstBad) console.log(`    mismatch ${f}`);
  check('match: the fixture has 10000+ non-forced card decisions, both styles and both phases, at every player count', st.cards >= 10000 && st.byStyle.smart > 0 && st.byStyle.naive > 0 && st.byPhase.climb > 0 && st.byPhase.descent > 0 && Object.values(st.byN).every((k) => k > 1000), JSON.stringify(st.byN));
  check('match: Medium and the naive archetype play the Python\'s card at every one of those decisions when given the Python\'s hand order (zero mismatches)', st.exactBad === 0, `${st.exactBad} of ${st.cards}`);
  check('match: on the engine\'s sorted hand every difference from the Python is a tie between equal candidates (zero unexplained)', st.unexplained === 0 && st.sortedSame + st.tieOrder === st.cards, `${st.unexplained} unexplained`);
  check('match: Muster cards are played in decisions at 5 players', st.musterPlays > 100, `${st.musterPlays}`);
}

// ---------- 5. the stakes the port computes equal the Python's (tv, colt_tv) ----------
{
  let checked = 0; let badStakes = 0; let climbChecked = 0; const firstBad = [];
  FX.games.forEach((fg, gi) => {
    const n = fg.n;
    const state = startGame({
      seed: `fxs:${gi}`, players: n, firstDealer: 0,
      deals: fg.hands.map((fh) => ({ hands: fh.h.map((s) => [...s].map(cardOf)), climbRow: fh.cr, row: fh.row })),
      manualSeats: Array.from({ length: n }, (_, s) => s),
    }).state;
    for (const fh of fg.hands) {
      const plays = [...fh.p].map(cardOf);
      const handNo = state.handNo;
      let i = 0; let d = 0; let guard = 0;
      while (state.handLog.length === handNo && state.toAct !== null && guard++ < 500) {
        const seat = state.toAct;
        const v = viewFor(state, seat);
        if (state.phase === 'climb' && fg.styles[seat] === 'smart') {
          // the price line of the view is the Climb card this trick takes; the port's tv is the Python's cv
          const sk = stakes(UP, v.climbTrickNo, v.climbRowValues);
          climbChecked++;
          if (sk.tv !== fh.cr[v.climbTrickNo] || sk.tv !== v.price.value || v.price.card !== v.climbRowDealt[v.climbTrickNo]) { badStakes++; if (firstBad.length < 5) firstBad.push(`g${gi} climb ${v.climbTrickNo}`); }
        }
        if (state.phase === 'descent') {
          if (fg.styles[seat] === 'smart') {
            const sk = stakes(DOWN, v.descentTrickNo, v.rowDealt.map(brumbyValue));
            checked++;
            if (sk.tv !== fh.t[2 * d] || sk.coltTv !== fh.t[2 * d + 1] || sk.tv !== v.price.value || (v.price.best === null ? -99 : v.price.best) !== sk.coltTv || sk.last !== (v.descentTrickNo === 5)) {
              badStakes++; if (firstBad.length < 5) firstBad.push(`g${gi} d${d}: JS ${sk.tv},${sk.coltTv}; Python ${fh.t[2 * d]},${fh.t[2 * d + 1]}`);
            }
          }
          d++;
        }
        applyAction(state, { type: 'play', card: plays[i++] });
      }
    }
  });
  for (const f of firstBad) console.log(`    stakes mismatch ${f}`);
  console.log(`  stakes: ${checked} smart-style descent plays and ${climbChecked} climb plays, ${badStakes} differ from the Python's (tv, colt_tv)`);
  check('stakes: the row-card stakes (trick value, best trick still to come) equal the Python\'s at every recorded smart play, and the view\'s price line agrees', checked > 3000 && climbChecked > 3000 && badStakes === 0, `${badStakes}`);
}

// ---------- 6. Medium and the archetypes on hand-built positions ----------
{
  const med = (g, seat) => getBot('medium').chooseAction(viewFor(g, seat), { s: 1 });
  const naive = (g, seat) => getBot('naive').chooseAction(viewFor(g, seat), { s: 1 });
  // the last climb trick (7 cards each at 3 players): its prize is the +1 card in `plus`, the -1 card in `minus`
  const PLUS_ROW = ['climb-minus1', 'climb-plus1-1', 'climb-plus1-2', 'climb-plus1-3', 'climb-plus1-4', 'climb-plus1-5'];
  const MINUS_ROW = ['climb-plus1-1', 'climb-plus1-2', 'climb-plus1-3', 'climb-plus1-4', 'climb-plus1-5', 'climb-minus1'];
  const plus = (hands, leader = 0) => position({ players: 3, hands, leader, climbTrickNo: 5, climbRow: PLUS_ROW });
  const minus = (hands, leader = 0) => position({ players: 3, hands, leader, climbTrickNo: 5, climbRow: MINUS_ROW });
  const o1 = ['climb-8', 'climb-10', 'descent-1', 'descent-2', 'escape-6', 'escape-2', 'home-11'];
  const o2 = ['climb-9', 'climb-11', 'descent-12', 'descent-3', 'escape-7', 'escape-8', 'home-12'];
  const rest = ['escape-6', 'escape-7', 'escape-8', 'climb-11', 'climb-12', 'descent-11', 'descent-12']; // a third seat that never acts below

  const lead = ['escape-12', 'climb-2', 'climb-6', 'descent-4', 'descent-5', 'home-9', 'home-10'];
  const noSure = ['escape-3', 'climb-2', 'climb-6', 'descent-4', 'descent-5', 'home-9', 'home-10'];
  check('position check: the +1 position prices the last climb trick at +1 and the -1 position at -1', viewFor(plus([lead, o1, o2]), 0).price.value === 1 && viewFor(minus([lead, o1, o2]), 0).price.value === -1);
  check('medium: leading the climb it plays the cheapest card nothing unseen can beat', med(plus([lead, o1, o2]), 0).card === 'escape-12');
  check('medium: leading with no sure card it plays the card worth least to keep (not a 1 or 2, which win the descent)', med(plus([noSure, o1, o2]), 0).card === 'climb-6');
  check('medium: leading for the -1 Climb card it leads its weakest card on the climb', med(minus([noSure, o1, o2]), 0).card === 'climb-2');

  const A = ['climb-5', 'escape-1', 'home-2', 'home-3', 'descent-8', 'descent-9', 'descent-1'];
  const B = ['climb-3', 'climb-7', 'climb-9', 'home-4', 'descent-5', 'descent-6', 'home-5'];
  const follow = plus([A, B, rest]);
  applyAction(follow, { type: 'play', card: 'climb-5' });
  check('medium: following on the climb for a +1 card it plays the cheapest card that wins as the trick stands', med(follow, 1).card === 'climb-7');
  const followMinus = minus([A, B, rest]);
  applyAction(followMinus, { type: 'play', card: 'climb-5' });
  check('medium: the same hand following for the -1 Climb card ducks (plays the strongest card that loses: Climb 3, not Climb 7)', med(followMinus, 1).card === 'climb-3');
  const A2 = ['climb-5', 'escape-1', 'home-2', 'home-3', 'descent-8', 'descent-9', 'descent-3'];
  const lose = plus([A2, ['climb-1', 'climb-2', 'home-4', 'descent-1', 'descent-2', 'descent-6', 'home-6'], rest]);
  applyAction(lose, { type: 'play', card: 'climb-5' });
  check('medium: unable to win it throws the card worth least to keep (Climb 2 before Climb 1, which would win the descent)', med(lose, 1).card === 'climb-2');
  const ruff = plus([A2, ['escape-4', 'descent-6', 'descent-7', 'home-4', 'home-12', 'escape-9', 'home-6'], rest]);
  applyAction(ruff, { type: 'play', card: 'climb-5' });
  check('medium: void on the climb it ruffs with the lowest Escape (the climb trump) that wins', med(ruff, 1).card === 'escape-4');
  const dump = plus([A2, ['descent-6', 'descent-7', 'home-4', 'home-12', 'descent-1', 'home-5', 'home-6'], rest]);
  applyAction(dump, { type: 'play', card: 'climb-5' });
  check('medium: void on the climb with no Escape it dumps the card worth least to keep', med(dump, 1).card === 'descent-6');
  check('naive: wins a climb trick with the cheapest winner, and dumps its lowest-power card when it cannot', (() => {
    const g = plus([A2, ['climb-3', 'climb-4', 'climb-1', 'home-4', 'descent-1', 'descent-2', 'home-6'], rest]);
    applyAction(g, { type: 'play', card: 'climb-5' });
    return naive(g, 1).card === 'climb-1';
  })());
  check('naive: leads its most powerful card (any Escape, the climb trump, before a high card), and does not duck the -1 Climb card', naive(plus([noSure, o1, o2]), 0).card === 'escape-3' && naive(minus([noSure, o1, o2]), 0).card === 'escape-3');
  check('naive: following for the -1 Climb card it still wins with the cheapest winner (Climb 7)', (() => {
    const g = minus([A, B, rest]);
    applyAction(g, { type: 'play', card: 'climb-5' });
    return naive(g, 1).card === 'climb-7';
  })());

  // the descent: each trick is valued by its Brumby card
  const descentHands = [['climb-12', 'climb-1', 'home-12', 'escape-6', 'descent-6', 'home-2'], ['climb-2', 'climb-3', 'climb-4', 'descent-1', 'descent-2', 'escape-3'], ['climb-5', 'climb-6', 'climb-7', 'descent-3', 'descent-4', 'escape-4'], ['climb-8', 'climb-9', 'climb-10', 'descent-5', 'descent-7', 'escape-5']];
  const rowOf = (first) => [first, 'brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus1-1', 'brumby-plus1-2', 'brumby-plus2-3'];
  const bad = position({ players: 4, hands: descentHands, phase: 'descent', row: rowOf('brumby-flint'), leader: 0 });
  const good = position({ players: 4, hands: descentHands, phase: 'descent', row: rowOf('brumby-plus2-4'), leader: 0 });
  check('medium: leading the descent for a -1 Flint stones card it tries to lose the trick (leads its weakest descent card)', med(bad, 0).card === 'climb-12');
  check('medium: leading the descent for a +2 card it leads the descent card nothing unseen can beat', med(good, 0).card === 'climb-1');
  const saverHands = [['home-1', 'climb-6', 'climb-7', 'descent-8', 'descent-9', 'escape-10'], ['climb-1', 'climb-2', 'climb-3', 'descent-1', 'descent-2', 'escape-3'], ['climb-4', 'climb-5', 'climb-8', 'descent-3', 'descent-4', 'escape-4'], ['climb-9', 'climb-10', 'climb-11', 'descent-5', 'descent-7', 'escape-5']];
  const noBetter = position({ players: 4, hands: saverHands, phase: 'descent', row: ['brumby-plus2-1', 'brumby-plus1-1', 'brumby-plus1-2', 'brumby-plus1-3', 'brumby-flint', 'brumby-wombat-1'], leader: 0 });
  const betterLater = position({ players: 4, hands: saverHands, phase: 'descent', row: ['brumby-plus1-1', 'brumby-plus1-2', 'brumby-plus1-3', 'brumby-plus2-1', 'brumby-flint', 'colt'], leader: 0 });
  check('medium: with nothing better to come it leads its sure winner (Home 1) for a +2 card', med(noBetter, 0).card === 'home-1');
  check('medium: with the Colt still to come it saves its strongest card (Home 1) and leads something else for a +1 card', med(betterLater, 0).card === 'escape-10');
  const coltHands = [['descent-9', 'climb-12', 'climb-11', 'climb-10', 'climb-9', 'climb-8'], ['descent-2', 'descent-3', 'descent-5', 'climb-1', 'climb-2', 'climb-3'], ['home-3', 'home-4', 'home-5', 'climb-4', 'climb-5', 'climb-6']];
  const coltFollow = position({ players: 3, hands: coltHands, phase: 'descent', row: ['colt', 'brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus1-1', 'brumby-plus1-2', 'brumby-plus1-3'], leader: 0 });
  const plusFollow = position({ players: 3, hands: coltHands, phase: 'descent', row: ['brumby-plus1-1', 'brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus1-2', 'brumby-plus1-3', 'brumby-flint'], leader: 0 });
  applyAction(coltFollow, { type: 'play', card: 'descent-9' });
  applyAction(plusFollow, { type: 'play', card: 'descent-9' });
  check('medium: a +4 Colt trick that can still be overtaken is won with the strongest winning card (Descent 2, lowest number)', med(coltFollow, 1).card === 'descent-2');
  check('medium: an ordinary trick is won with the cheapest winning card (Descent 5)', med(plusFollow, 1).card === 'descent-5');
  check('stakes: the descent stakes are the row card, the best card still to come, and the last-trick flag; the climb stakes are the Climb card', (() => {
    const a = stakes(DOWN, 0, [1, 2, -1, 4, 2, -2]); const b = stakes(DOWN, 5, [1, 2, -1, 4, 2, -2]); const c = stakes(UP, 5, [1, 1, 1, 1, 1, -1]);
    return a.tv === 1 && a.coltTv === 4 && !a.last && b.tv === -2 && b.coltTv === -99 && b.last && c.tv === -1 && !c.last;
  })());
  check('archetypes: the naive archetype is the Python naive play (id naive, style naive, not offered); high and low pick the highest and lowest number', (() => {
    const bots = Object.fromEntries(archetypeBots.map((b) => [b.id, b]));
    const v = viewFor(plus([noSure, o1, o2]), 0);
    return bots.naive.style === 'naive' && bots.naive.offered === false && bots.high.chooseAction(v).card === 'home-10' && bots.low.chooseAction(v).card === 'climb-2';
  })());
}

// ---------- 7. Hard ----------
{
  check('hard: sample counts shrink as candidates grow, within the bounds', samplesFor(1) === HARD_SAMPLES && samplesFor(10) >= HARD_MIN_SAMPLES && samplesFor(10) <= HARD_SAMPLES && samplesFor(100000) === HARD_MIN_SAMPLES && samplesFor(12) === Math.min(HARD_SAMPLES, Math.floor(HARD_MAX_ROLLOUTS / 12)));
  const g = createGame({ seed: 31, players: 3 });
  const v = viewFor(g, g.toAct);
  const a = searchAction(v, { s: 3 }, { samples: 8 });
  const b = searchAction(v, { s: 3 }, { samples: 8 });
  check('hard: a search is reproducible from its rng, and scores one entry per legal action', sameAction(a.action, b.action) && a.scores.length === legalActionsFromView(v).length && same(a.scores, b.scores));
  const single = position({ players: 3, hands: [['home-5'], ['home-3'], ['home-2']], phase: 'descent', descentTrickNo: 5, row: ['brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus2-3', 'brumby-plus1-1', 'brumby-flint', 'colt'], leader: 0, handsPerGame: 1 });
  check('hard: a single legal action is returned at once', searchAction(viewFor(single, 0), { s: 1 }).scores.length === 1);

  // an endgame with a clear answer: last-but-one descent trick, the +4 Colt trick, void in the led suit with a trump
  const endHands = [['descent-9', 'climb-12'], ['descent-2', 'climb-1'], ['home-3', 'climb-4']];
  const end = position({ players: 3, hands: endHands, phase: 'descent', descentTrickNo: 4, row: ['brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus2-3', 'brumby-plus1-1', 'colt', 'brumby-flint'], leader: 0, handsPerGame: 1 });
  play(end, 'descent-9', 'descent-2'); // seat 1's Descent 2 is forced (it must follow suit) and is auto-played
  const er = searchAction(viewFor(end, 2), { s: 2 }, { samples: 40 });
  check('hard: in the Colt trick with a trump in hand it takes the +4 (plays Home 3, not Climb 4)', end.toAct === 2 && er.action.card === 'home-3' && er.scores[er.scores.length - 1] !== undefined, `${er.action.card} ${er.scores.map((x) => x.toFixed(2))}`);

  // the world sampler draws exactly what the engine's determinise() draws (same rng stream), as compact worlds
  {
    let compared = 0; let differ = 0;
    const easy = getBot('easy');
    for (const n of COUNTS) {
      for (let k = 0; k < 60; k++) {
        const s = createGame({ seed: deriveSeed('sampler', n, k), players: n });
        const rng = makeRng(deriveSeed('sampler-r', n, k));
        const steps = (k * 5) % (12 * n - 1);
        for (let i = 0; i < steps && s.toAct !== null && s.handNo === 0; i++) applyAction(s, easy.chooseAction(viewFor(s, s.toAct), rng), { silent: true });
        if (s.toAct === null || s.handNo > 0) continue;
        const view = viewFor(s, s.toAct);
        const mine = worldSampler(view)({ s: k + 7 });
        const theirs = worldFromState(determinise(view, { s: k + 7 }));
        compared++;
        const flat = (w) => JSON.stringify({ ...w, played: [...w.played] });
        if (flat(mine) !== flat(theirs)) differ++;
      }
    }
    check(`hard: the sampler's compact worlds equal worldFromState(determinise(view)) on the same rng stream (${compared} views at 2-5 players)`, compared > 150 && differ === 0, `${differ} differ`);
  }

  // The compact rollout the search plays out on must equal the real engine playing the same policy (Medium's card play for every seat).
  {
    const enginePlayOut = (world) => {
      world.params.handsPerGame = world.handNo + 1;
      while (world.toAct !== null) applyAction(world, mediumActionFromState(world), { silent: true });
      return world.handLog[world.handNo - 1].scores;
    };
    let compared = 0; let differ = 0; const phases = { climb: 0, descent: 0 }; const byN = { 2: 0, 3: 0, 4: 0, 5: 0 };
    const easy = getBot('easy');
    for (const n of COUNTS) {
      for (let k = 0; k < 110; k++) {
        const s = createGame({ seed: deriveSeed('rollout', n, k), players: n });
        const rng = makeRng(deriveSeed('rollout-r', n, k));
        const steps = (k * 7) % (12 * n - 1);
        for (let i = 0; i < steps && s.toAct !== null && s.handNo === 0; i++) applyAction(s, easy.chooseAction(viewFor(s, s.toAct), rng), { silent: true });
        if (s.toAct === null || s.handNo > 0) continue;
        const world = determinise(viewFor(s, s.toAct), makeRng(k + 1));
        phases[world.phase]++; byN[n]++;
        const fast = handScores(playOut(worldFromState(world)));
        const eng = enginePlayOut(JSON.parse(JSON.stringify(world)));
        compared++;
        if (!same(fast, eng)) differ++;
      }
    }
    check(`hard: the compact rollout gives the engine's own hand scores from ${compared} sampled worlds (${phases.climb} on the climb, ${phases.descent} on the descent; 2p ${byN[2]}, 3p ${byN[3]}, 4p ${byN[4]}, 5p ${byN[5]})`, compared >= 300 && differ === 0 && phases.climb > 30 && phases.descent > 30 && Object.values(byN).every((k) => k > 40), `${differ} differ`);
  }

  // The UI runs every bot through src/ui/bot-worker.js (a module worker). Load that file in a Node worker with a
  // minimal `self`, send it the same task the page sends, and require the answer (action and advanced rng) to equal
  // the in-process answer: the module graph resolves with no DOM, and Hard needs no change in the worker.
  const viaWorker = (task) => new Promise((resolve, reject) => {
    const code = "const { parentPort, workerData } = require('node:worker_threads');"
      + 'globalThis.self = { postMessage: (m) => parentPort.postMessage(m) };'
      + 'import(workerData.url).then(() => self.onmessage({ data: workerData.task })).catch((e) => parentPort.postMessage({ error: String(e) }));';
    const w = new Worker(code, { eval: true, workerData: { url: new URL('../src/ui/bot-worker.js', import.meta.url).href, task } });
    w.once('message', (m) => { resolve(m); w.terminate(); });
    w.once('error', reject);
  });
  {
    let ok = true; let checked = 0;
    for (const level of ['easy', 'medium', 'hard']) {
      const st = createGame({ seed: deriveSeed('wk', level), players: 5 });
      for (let k = 0; k < 6 && st.toAct !== null; k++) {
        const seat = st.toAct;
        const view = viewFor(st, seat);
        const mine = { s: 4242 + k };
        const expect = getBot(level).chooseAction(view, mine);
        const got = await viaWorker({ id: k, level, view, rng: { s: 4242 + k } });
        checked++;
        if (got.error || !sameAction(got.action, expect) || got.rng.s !== mine.s) ok = false;
        applyAction(st, expect, { silent: true });
      }
    }
    check(`worker: bot-worker.js answers Easy, Medium and Hard exactly as the in-process bots do (${checked} decisions at 5 players)`, ok && checked >= 18);
  }

  // Time per decision with the real budget (every decision Hard is asked; forced single-option ones are never asked).
  const timing = [];
  for (const n of COUNTS) {
    const ms = [];
    for (let game = 0; game < (FULL ? 4 : 1); game++) {
      const state = createGame({ seed: deriveSeed('time', n, game), players: n });
      const rngs = Array.from({ length: n }, (_, s) => makeRng(deriveSeed('time', n, s)));
      while (state.toAct !== null) {
        const seat = state.toAct;
        const view = viewFor(state, seat);
        if (legalActionsFromView(view).length < 2) { applyAction(state, legalActionsFromView(view)[0], { silent: true }); continue; }
        const t0 = process.hrtime.bigint();
        const act = getBot('hard').chooseAction(view, rngs[seat]);
        ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
        applyAction(state, act, { silent: true });
      }
    }
    ms.sort((x, y) => x - y);
    timing.push({ n, count: ms.length, median: ms[ms.length >> 1], p95: ms[Math.floor(ms.length * 0.95)], max: ms[ms.length - 1], mean: ms.reduce((x, y) => x + y, 0) / ms.length });
  }
  for (const t of timing) console.log(`  hard time ${t.n}p: ${t.count} decisions, median ${t.median.toFixed(1)} ms, mean ${t.mean.toFixed(1)} ms, p95 ${t.p95.toFixed(1)} ms, max ${t.max.toFixed(1)} ms (budget ${HARD_SAMPLES} worlds, at most ${HARD_MAX_ROLLOUTS} rollouts)`);
  const t5 = timing[3];
  check('hard: a decision at 5 players has a median under 150 ms and a p95 under 250 ms in Node (target about 250 ms)', t5.median < 150 && t5.p95 < 250 && t5.max < 500, `median ${t5.median.toFixed(0)} ms, p95 ${t5.p95.toFixed(0)} ms, max ${t5.max.toFixed(0)} ms`);
}

// ---------- 8. strength ----------
{
  const MV = FULL ? { 2: 1000, 3: 1000, 4: 1000, 5: 1000 } : { 2: 300, 3: 300, 4: 300, 5: 300 };
  const mediumRuns = {};
  for (const n of COUNTS) {
    const r = await strengthRun({ strong: 'medium', opp: 'easy', n, games: MV[n], tag: 'm-v-e' });
    mediumRuns[n] = r;
    console.log(`  ${strengthLine('Medium v Easy', n, r)}`);
    check(`strength: one Medium against Easy wins clearly more than a fair share at ${n} players (z > 4)`, r.z > 4, `${r.win.toFixed(3)} z ${r.z.toFixed(1)}`);
  }
  const HV = FULL ? { 2: 600, 3: 600, 4: 400, 5: 300 } : { 2: 150, 3: 150, 4: 100, 5: 80 };
  const hardRuns = {};
  for (const n of COUNTS) {
    const r = await strengthRun({ strong: 'hard', opp: 'medium', n, games: HV[n], tag: 'h-v-m' });
    hardRuns[n] = r;
    console.log(`  ${strengthLine('Hard v Medium', n, r)}`);
    check(`strength: one Hard against Medium wins more than a fair share at ${n} players (z > ${FULL ? 3 : 1.5})`, r.z > (FULL ? 3 : 1.5), `${r.win.toFixed(3)} z ${r.z.toFixed(1)}`);
  }
  check('strength: Easy < Medium < Hard at every player count (each stronger level beats the one below)', COUNTS.every((n) => mediumRuns[n].win > 1 / n && hardRuns[n].win > 1 / n));
}

done();
