// bots.mjs - the bots (v5 rules): registry, determinism, no view mutation, only-the-view imports, legality
// of every move at 2, 3 and 4 players, Medium and the archetypes decision-matched against the Python
// simulator's own bots (tests/fixtures/bots-python-decisions.json, recorded from sim/snowy-river-sim-v5.py by
// web-game-docs/conformance/make-python-bots-fixtures-v2.py), Medium's habits on hand-built positions, Hard
// (search, the compact rollout checked against the real engine, timing), and strength checks with counts and
// z-scores (Medium v Easy, Hard v Medium).
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. `--full` runs the long strength budgets.

import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  createGame, startGame, applyAction, viewFor, legalActionsFromView, getValidActions, determinise, brumbyValue,
  makeRng, deriveSeed, rngPick, shuffle, fullDeck,
} from '../src/engine/index.js';
import { getBot, botLevels, registerBot } from '../src/bots/index.js';
import {
  searchAction, samplesFor, worldFromState, playOut, handScores, HARD_SAMPLES, HARD_MIN_SAMPLES, HARD_MAX_ROLLOUTS,
} from '../src/bots/hard.js';
import { buildContext, summitCall, mediumChoose, MEDIUM_SAMPLES } from '../src/bots/medium.js';
import { makeArchetype, archetypeBots } from '../src/bots/archetypes.js';
import { descentStakes, quick, cardIndex } from '../src/bots/smart-core.js';
import { suite, position, same } from './lib.mjs';
import { botOf, sameAction, playGame, strengthBlock, strengthResult } from './bots-lib.mjs';

const { check, done } = suite('bots');
const FULL = process.argv.includes('--full');

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

/** A hand-built summit: hands of 6 (descent order), the row, nobody has chosen yet. */
function summitPosition({ players, hands, row, leader = 0, climbTricks = null }) {
  const g = position({ players, hands, phase: 'descent', row, leader, climbTricks });
  g.phase = 'summit';
  g.choices = hands.map(() => null);
  g.revealed = false;
  g.choiceOrder = Array.from({ length: players }, (_, k) => (leader + k) % players);
  g.toAct = leader;
  g.leader = leader;
  g.descentTrickNo = 0;
  g.row = [...g.rowDealt];
  return g;
}

// ---------- 1. registry ----------
{
  const levels = botLevels();
  check('registry: easy, medium and hard are offered', ['easy', 'medium', 'hard'].every((id) => levels.some((l) => l.id === id && l.offered)));
  check('registry: only easy, medium and hard are offered', levels.filter((l) => l.offered).length === 3);
  check('registry: the simulator archetypes (always, never, random, nothing, quick, naive, naive-random, plus the kit probes high and low) are registered, none offered', ['always', 'never', 'random', 'nothing', 'quick', 'naive', 'naive-random', 'high', 'low'].every((id) => levels.some((l) => l.id === id && !l.offered)) && archetypeBots.every((b) => levels.some((l) => l.id === b.id && !l.offered)));
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
  check('only the view: and every bot answers them identically', ['easy', 'medium', 'hard-fast', 'naive', 'always'].every((id) => sameAction(botOf(id).chooseAction(v1, { s: 3 }), botOf(id).chooseAction(v2, { s: 3 }))));

  const imports = ['medium.js', 'hard.js', 'archetypes.js', 'smart-core.js', 'random.js', 'index.js'].flatMap((f) => {
    const src = readFileSync(new URL(`../src/bots/${f}`, import.meta.url), 'utf8');
    return [...src.matchAll(/from '([^']+)'/g)].map((m) => `${f}: ${m[1]}`);
  });
  check('only the view: the bots import the engine index and each other, never the UI, the state files or a clock', imports.every((i) => /: (\.\.\/engine\/index\.js|\.\/[a-z-]+\.js)$/.test(i)), imports.filter((i) => !/: (\.\.\/engine\/index\.js|\.\/[a-z-]+\.js)$/.test(i)).join('; '));
  const src = readFileSync(new URL('../src/bots/hard.js', import.meta.url), 'utf8') + readFileSync(new URL('../src/bots/medium.js', import.meta.url), 'utf8');
  check('only the view: no bot reads state.hands of a real state (hands are read only inside determinised worlds)', !/viewFor\(/.test(src) && !/\.out\b/.test(src.replace(/\/\/.*$/gm, '')));
}

// ---------- 3. legality at every player count ----------
{
  const MIXED = ['easy', 'medium', ...archetypeBots.map((b) => b.id)];
  const perCount = 500;
  let games = 0; let refusals = 0; let illegal = 0; let mutated = 0; let unfinished = 0; const used = new Set();
  for (const n of [2, 3, 4]) {
    for (let i = 0; i < perCount; i++) {
      // a different mixed table every game: every level meets every other, in every seat
      const levels = Array.from({ length: n }, (_, s) => MIXED[(i * 3 + s * 5 + n + Math.floor(i / MIXED.length)) % MIXED.length]);
      levels.forEach((l) => used.add(l));
      const r = playGame({ levels, seed: deriveSeed('leg', n, i), checkView: i < 40 });
      games++; refusals += r.refusals; illegal += r.illegal; mutated += r.mutated;
      if (!r.over) unfinished++;
    }
  }
  check(`legality: ${games} mixed-level games (${perCount} per player count; ${[...used].length} levels) all finish`, unfinished === 0 && used.size === MIXED.length, `${unfinished} unfinished, levels used ${used.size}/${MIXED.length}`);
  check('legality: no bot ever proposes an action the view does not list, or one the engine refuses (zero refusals)', illegal === 0 && refusals === 0, `${illegal} illegal, ${refusals} refused`);
  check('legality: no bot mutates its view', mutated === 0, `${mutated}`);

  let hardGames = 0; let hardBad = 0;
  for (const n of [2, 3, 4]) {
    for (let i = 0; i < (FULL ? 100 : 60); i++) {
      const r = playGame({ levels: Array.from({ length: n }, (_, s) => (s === i % n ? 'hard-fast' : MIXED[(i + s) % 2])), seed: deriveSeed('leg-hard', n, i), checkView: i < 5 });
      hardGames++; hardBad += r.illegal + r.refusals + r.mutated + (r.over ? 0 : 1);
    }
  }
  for (const n of [2, 3, 4]) {
    for (let i = 0; i < (FULL ? 10 : 4); i++) {
      const r = playGame({ levels: Array.from({ length: n }, (_, s) => (s === i % n ? 'hard' : 'medium')), seed: deriveSeed('leg-hard-real', n, i), checkView: true });
      hardGames++; hardBad += r.illegal + r.refusals + r.mutated + (r.over ? 0 : 1);
    }
  }
  check(`legality: Hard (a 2-world search, and the real budget) plays ${hardGames} games at 2-4 players with only legal moves`, hardBad === 0, `${hardBad}`);
}

// ---------- 4. Python decision match ----------
{
  const FX = JSON.parse(readFileSync(new URL('./fixtures/bots-python-decisions.json', import.meta.url), 'utf8'));
  const DECK = fullDeck(); // the fixture alphabet is fullDeck() order (suit id x 12 + v - 1)
  const idxOf = (c) => FX.alphabet.indexOf(c);
  const cardOf = (c) => DECK[idxOf(c)];
  const botFor = (style, policy) => (style === 'smart' && policy === 'smart' ? getBot('medium') : makeArchetype(style, policy === 'zero' ? 'nothing' : policy));
  const st = {
    games: 0, hands: 0, plays: 0,
    cards: 0, exactBad: 0, byStyle: { smart: 0, naive: 0 }, byPhase: { climb: 0, descent: 0 }, byN: { 2: 0, 3: 0, 4: 0 },
    sortedSame: 0, tieOrder: 0, unexplained: 0,
    detSummit: 0, detSummitBad: 0, randomSkipped: 0,
    fixed: 0, fixedTotalBad: 0, fixedCallBad: 0, fixedCallChase: 0,
    natural: 0, naturalSame: 0, selfAgree: 0, extreme: 0, extremeSame: 0,
  };
  const firstBad = [];
  const bad = (id, what) => { if (firstBad.length < 10) firstBad.push(`${id}: ${what}`); };
  const permRng = makeRng('hand-orders');
  FX.games.forEach((fg, gi) => {
    const n = fg.n;
    const state = startGame({
      seed: `fxb:${gi}`, players: n, firstDealer: 0,
      deals: fg.hands.map((fh) => ({ hands: fh.h.map((s) => [...s].map(cardOf)), row: fh.row })),
      manualSeats: Array.from({ length: n }, (_, s) => s),
    }).state;
    const rngs = Array.from({ length: n }, (_, s) => makeRng(deriveSeed('fxb', gi, s)));
    const rngs2 = Array.from({ length: n }, (_, s) => makeRng(deriveSeed('fxb2', gi, s)));
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
        const style = fg.styles[seat]; const policy = fg.policies[seat];
        const view = viewFor(state, seat);
        const viewPy = { ...view, hand: py[seat].slice() };
        if (state.phase === 'summit') {
          const pyChase = fh.c[seat] === 'C';
          const bot = botFor(style, policy);
          if (policy === 'random') {
            st.randomSkipped++;
          } else if (policy !== 'smart') {
            // always / never / nothing (zero) / quick: deterministic, must match exactly (on the Python's hand order too)
            st.detSummit++;
            const a = bot.chooseAction(view, rngs[seat]);
            const b = bot.chooseAction(viewPy, rngs[seat]);
            if ((a.choice === 'chase') !== pyChase || (b.choice === 'chase') !== pyChase) { st.detSummitBad++; bad(id, `${policy} summit JS ${a.choice}, Python ${pyChase}`); }
          } else {
            const ep = fh.e.find((e) => e[0] === seat);
            if (ep[2]) { // (a) the Python's own sample set, its own hand order: the same total, the same call
              const ctx = buildContext(viewPy, seat, py[seat], view.handCounts, null, {});
              const r = summitCall(ctx, ep[2].map((p) => [...p].map(idxOf)));
              st.fixed++;
              if (r.total !== ep[1]) { st.fixedTotalBad++; bad(id, `total JS ${r.total}, Python ${ep[1]}`); }
              if (r.chase !== pyChase) { st.fixedCallBad++; bad(id, `call JS ${r.chase}, Python ${pyChase} (total ${ep[1]})`); }
              if (pyChase) st.fixedCallChase++;
            }
            // (b) the bot's own random samples (statistical): agreement with the Python's call, against two runs of the port
            const a = bot.chooseAction(view, rngs[seat]);
            const b = bot.chooseAction(view, rngs2[seat]);
            st.natural++;
            if ((a.choice === 'chase') === pyChase) st.naturalSame++;
            if (a.choice === b.choice) st.selfAgree++;
            if (ep[1] === 0 || Math.abs(ep[1]) >= FX.samples * 2) { st.extreme++; if ((a.choice === 'chase') === pyChase) st.extremeSame++; }
          }
          applyAction(state, { type: 'summit', choice: pyChase ? 'chase' : 'watch' });
          continue;
        }
        if (i >= plays.length || seat !== seats[i]) { bad(id, `play ${i}: engine seat ${seat}, Python seat ${seats[i]}`); st.unexplained++; break; }
        const bot = botFor(style, policy);
        const legal = getValidActions(state);
        if (legal.length > 1) {
          st.cards++; st.byStyle[style]++; st.byPhase[state.phase]++; st.byN[n]++;
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
        }
        applyAction(state, { type: 'play', card: plays[i] });
        py[seat].splice(py[seat].indexOf(plays[i]), 1);
        i++;
      }
    }
  });
  const pyPlays = Object.values(FX.counts).reduce((a, c) => a + c.plays, 0);
  console.log(`  decision match: ${st.games} Python games, ${st.hands} hands, ${pyPlays} recorded plays`);
  console.log(`    card play, fed the Python's hand order: ${st.cards} decisions with 2+ legal cards (smart ${st.byStyle.smart}, naive ${st.byStyle.naive}; climb ${st.byPhase.climb}, descent ${st.byPhase.descent}; 2p ${st.byN[2]}, 3p ${st.byN[3]}, 4p ${st.byN[4]}): ${st.exactBad} mismatches`);
  console.log(`    card play on the engine's sorted hand: ${st.sortedSame} the same card, ${st.tieOrder} a different card of equal worth (tie order: the Python's card is one the port picks in some hand order), ${st.unexplained} unexplained`);
  console.log(`    summit, deterministic policies (always / never / nothing / quick): ${st.detSummit} decisions, ${st.detSummitBad} mismatches; coin-flip summits skipped: ${st.randomSkipped}`);
  console.log(`    summit, Monte Carlo fed the Python's own ${FX.samples} sample pools: ${st.fixed} decisions (${st.fixedCallChase} chases), total mismatches ${st.fixedTotalBad}, call mismatches ${st.fixedCallBad}`);
  console.log(`    summit, Monte Carlo on its own samples (${st.natural} decisions): agrees with the Python's call in ${st.naturalSame} (${pct(st.naturalSame / st.natural)}); two independent runs of the port agree with each other in ${pct(st.selfAgree / st.natural)}; where the Python's estimate was 0 or at least 2 points either way (${st.extreme}): ${pct(st.extremeSame / st.extreme)}`);
  for (const f of firstBad) console.log(`    mismatch ${f}`);
  check('match: the fixture has 1000+ non-forced card decisions, both styles and both phases, at every player count', st.cards >= 1000 && st.byStyle.smart > 0 && st.byStyle.naive > 0 && st.byPhase.climb > 0 && st.byPhase.descent > 0 && Object.values(st.byN).every((k) => k > 100), JSON.stringify(st.byN));
  check('match: Medium and the naive archetype play the Python\'s card at every one of those decisions when given the Python\'s hand order (zero mismatches)', st.exactBad === 0, `${st.exactBad} of ${st.cards}`);
  check('match: on the engine\'s sorted hand every difference from the Python is a tie between equal candidates (zero unexplained)', st.unexplained === 0 && st.sortedSame + st.tieOrder === st.cards, `${st.unexplained} unexplained`);
  check('match: always / never / nothing / quick summit policies match the Python in every decision', st.detSummit > 100 && st.detSummitBad === 0, `${st.detSummitBad} of ${st.detSummit}`);
  check('match: fed the Python\'s own sample pools, the Monte Carlo returns the same total (exactly) at every recorded decision', st.fixed >= 400 && st.fixedTotalBad === 0, `${st.fixedTotalBad} of ${st.fixed}`);
  check('match: fed the Python\'s own sample pools, the summit call (mean chase - watch > 0) is the Python\'s every time, and both calls occur', st.fixedCallBad === 0 && st.fixedCallChase > 20 && st.fixedCallChase < st.fixed - 20, `${st.fixedCallBad} of ${st.fixed}`);
  check('match: on its own samples the Monte Carlo calls the summit like the Python about as often as two runs of the port agree with each other (within 4 points)', st.naturalSame / st.natural >= st.selfAgree / st.natural - 0.04, `${pct(st.naturalSame / st.natural)} v ${pct(st.selfAgree / st.natural)}`);
  check('match: Medium samples 12 worlds as the Python', MEDIUM_SAMPLES === FX.samples && MEDIUM_SAMPLES === 12);
}

// ---------- 5. the descent stakes the port computes equal the Python's (tv, colt_tv) ----------
{
  const FX = JSON.parse(readFileSync(new URL('./fixtures/bots-python-decisions.json', import.meta.url), 'utf8'));
  const DECK = fullDeck();
  const cardOf = (c) => DECK[FX.alphabet.indexOf(c)];
  let checked = 0; let badStakes = 0; const firstBad = [];
  FX.games.forEach((fg, gi) => {
    const n = fg.n;
    const state = startGame({
      seed: `fxs:${gi}`, players: n, firstDealer: 0,
      deals: fg.hands.map((fh) => ({ hands: fh.h.map((s) => [...s].map(cardOf)), row: fh.row })),
      manualSeats: Array.from({ length: n }, (_, s) => s),
    }).state;
    for (const fh of fg.hands) {
      const plays = [...fh.p].map(cardOf);
      const handNo = state.handNo;
      let i = 0; let d = 0; let guard = 0;
      while (state.handLog.length === handNo && state.toAct !== null && guard++ < 500) {
        const seat = state.toAct;
        if (state.phase === 'summit') { applyAction(state, { type: 'summit', choice: fh.c[seat] === 'C' ? 'chase' : 'watch' }); continue; }
        if (state.phase === 'descent' && fg.styles[seat] === 'smart') {
          const v = viewFor(state, seat);
          const sk = descentStakes(seat, v.descentTrickNo, v.rowDealt.map(brumbyValue), v.choices.map((c) => c === 'chase'));
          const tv2 = Math.round(sk.tv * 2); const ctv2 = sk.coltTv === -99 ? -198 : Math.round(sk.coltTv * 2);
          checked++;
          if (tv2 !== fh.t[2 * d] || ctv2 !== fh.t[2 * d + 1]) { badStakes++; if (firstBad.length < 5) firstBad.push(`g${gi} d${d}: JS ${tv2},${ctv2}; Python ${fh.t[2 * d]},${fh.t[2 * d + 1]}`); }
        }
        if (state.phase === 'descent') d++;
        applyAction(state, { type: 'play', card: plays[i++] });
      }
    }
  });
  for (const f of firstBad) console.log(`    stakes mismatch ${f}`);
  console.log(`  descent stakes: ${checked} smart-style descent plays, ${badStakes} differ from the Python's (tv, colt_tv)`);
  check('stakes: the row-card stakes (trick value, best trick still to come) equal the Python\'s at every recorded smart descent play', checked > 500 && badStakes === 0, `${badStakes} of ${checked}`);
}

// ---------- 6. Medium and the archetypes on hand-built positions ----------
{
  const med = (g, seat) => getBot('medium').chooseAction(viewFor(g, seat), { s: 1 });
  const naive = (g, seat) => getBot('naive').chooseAction(viewFor(g, seat), { s: 1 });
  const climb = (hands, leader = 0) => position({ hands, leader, marker: 0 });
  const others = [['climb-3', 'climb-4', 'descent-2', 'descent-3', 'home-8', 'home-9'], ['climb-5', 'climb-6', 'descent-7', 'descent-9', 'home-10', 'home-11'], ['climb-8', 'climb-10', 'descent-10', 'descent-11', 'escape-6', 'escape-2']];

  check('medium: leading the climb it plays the cheapest card nothing unseen can beat', med(climb([['escape-12', 'climb-2', 'climb-6', 'descent-4', 'descent-5', 'home-9'], ...others]), 0).card === 'escape-12');
  check('medium: leading with no sure card it plays the card worth least to keep (not a 1 or 2, which win the descent)', med(climb([['escape-3', 'climb-2', 'climb-6', 'descent-4', 'descent-5', 'home-9'], ...others]), 0).card === 'climb-6');
  const follow = climb([['climb-5', 'escape-1', 'home-2', 'home-3', 'descent-8', 'descent-9'], ['climb-3', 'climb-7', 'climb-9', 'home-4', 'descent-1', 'descent-2'], ...others.slice(1)]);
  applyAction(follow, { type: 'play', card: 'climb-5' });
  check('medium: following on the climb it plays the cheapest card that wins as the trick stands', med(follow, 1).card === 'climb-7');
  const lose = climb([['climb-5', 'escape-1', 'home-2', 'home-3', 'descent-8', 'descent-9'], ['climb-1', 'climb-2', 'home-4', 'descent-1', 'descent-2', 'descent-6'], ...others.slice(1)]);
  applyAction(lose, { type: 'play', card: 'climb-5' });
  check('medium: unable to win it throws the card worth least to keep (Climb 2 before Climb 1, which would win the descent)', med(lose, 1).card === 'climb-2');
  const ruff = climb([['climb-5', 'escape-1', 'home-2', 'home-3', 'descent-8', 'descent-9'], ['escape-4', 'descent-6', 'descent-8', 'home-3', 'home-12', 'escape-9'], ...others.slice(1)]);
  applyAction(ruff, { type: 'play', card: 'climb-5' });
  check('medium: void on the climb it ruffs with the lowest Escape (the climb trump) that wins', med(ruff, 1).card === 'escape-4');
  const dump = climb([['climb-5', 'escape-1', 'home-2', 'home-3', 'descent-8', 'descent-9'], ['descent-6', 'descent-8', 'home-3', 'home-12', 'descent-1', 'home-5'], ...others.slice(1)]);
  applyAction(dump, { type: 'play', card: 'climb-5' });
  check('medium: void on the climb with no Escape it dumps the card worth least to keep', med(dump, 1).card === 'descent-6');
  check('naive: wins a climb trick with the cheapest winner, and dumps its lowest-power card when it cannot', (() => {
    const g = climb([['climb-5', 'escape-1', 'home-2', 'home-3', 'descent-8', 'descent-9'], ['climb-3', 'climb-4', 'climb-1', 'home-4', 'descent-1', 'descent-2'], ...others.slice(1)]);
    applyAction(g, { type: 'play', card: 'climb-5' });
    return naive(g, 1).card === 'climb-1';
  })());
  check('naive: leads its most powerful card (any Escape, the climb trump, before a high card)', naive(climb([['escape-3', 'climb-2', 'climb-6', 'descent-4', 'descent-5', 'home-9'], ...others]), 0).card === 'escape-3');

  // the descent: each trick is valued by its row card
  const descentHands = [['climb-12', 'climb-1', 'home-12', 'escape-6', 'descent-6', 'home-2'], ['climb-2', 'climb-3', 'climb-4', 'descent-1', 'descent-2', 'escape-3'], ['climb-5', 'climb-6', 'climb-7', 'descent-3', 'descent-4', 'escape-4'], ['climb-8', 'climb-9', 'climb-10', 'descent-5', 'descent-7', 'escape-5']];
  const rowOf = (first) => [first, 'brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus1-1', 'brumby-plus1-2', 'brumby-plus2-3'];
  const bad = position({ hands: descentHands, phase: 'descent', row: rowOf('brumby-flint'), leader: 0 });
  const good = position({ hands: descentHands, phase: 'descent', row: rowOf('brumby-plus2-4'), leader: 0 });
  check('medium: a chaser leading for a -1 Flint stones card tries to lose the trick (leads its weakest descent card)', med(bad, 0).card === 'climb-12');
  check('medium: a chaser leading for a +2 card leads the descent card nothing unseen can beat', med(good, 0).card === 'climb-1');

  // the summit
  const strongHand = ['escape-1', 'climb-1', 'descent-1', 'home-1', 'home-2', 'climb-2'];
  const weakHand = ['escape-12', 'climb-12', 'descent-12', 'home-12', 'escape-11', 'climb-11'];
  const richRow = ['brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus2-3', 'brumby-plus2-4', 'brumby-plus1-1', 'colt'];
  const poorRow = ['brumby-flint', 'brumby-wombat-1', 'brumby-wombat-2', 'brumby-plus1-1', 'brumby-plus1-2', 'brumby-plus1-3'];
  const mid1 = ['escape-6', 'climb-6', 'descent-6', 'home-6', 'escape-7', 'climb-7'];
  const mid2 = ['escape-8', 'climb-8', 'descent-8', 'home-8', 'escape-9', 'climb-9'];
  const sureWin = summitPosition({ players: 3, hands: [strongHand, mid1, mid2], row: richRow, climbTricks: [0, 3, 3] });
  const hopeless = summitPosition({ players: 3, hands: [weakHand, mid1, mid2], row: poorRow, climbTricks: [4, 1, 1] });
  check('medium: a hand of the best descent cards against a row worth 12 chases', med(sureWin, 0).choice === 'chase');
  check('medium: a hand of the worst descent cards against a row of Flint stones and Wombat holes watches', med(hopeless, 0).choice === 'watch');
  check('medium: its summit call reports the chase gain it weighed (positive for the strong hand, negative for the weak one)', (() => {
    const call = (g) => summitCall(buildContext(viewFor(g, 0), 0, viewFor(g, 0).hand, viewFor(g, 0).handCounts, makeRng('sc'), {}));
    return call(sureWin).d > 1 && call(hopeless).d < 0 && call(sureWin).chase === true && call(hopeless).chase === false;
  })());

  // the archetypes' summit policies, read off the same table
  const policyRows = (policy) => {
    const g = summitPosition({ players: 4, hands: [strongHand, weakHand, mid1, mid2], row: richRow, climbTricks: [3, 0, 2, 1] });
    const bot = makeArchetype('smart', policy);
    const out = [];
    while (g.phase === 'summit') {
      const seat = g.toAct;
      const view = viewFor(g, seat);
      out.push({ seat, climb: view.climbTricks[seat], strong: quick(view.hand.map(cardIndex)), choice: bot.chooseAction(view, { s: 1 }).choice });
      applyAction(g, { type: 'summit', choice: 'watch' });
    }
    return out;
  };
  const nothingRows = policyRows('nothing');
  const quickRows = policyRows('quick');
  check('archetypes: always chases, never watches, nothing-to-lose chases exactly the seats without climb tricks, quick chases exactly the seats with 2+ strong descent cards',
    policyRows('always').every((r) => r.choice === 'chase') && policyRows('never').every((r) => r.choice === 'watch')
    && nothingRows.every((r) => (r.choice === 'chase') === (r.climb === 0)) && nothingRows.some((r) => r.climb === 0) && nothingRows.some((r) => r.climb > 0)
    && quickRows.every((r) => (r.choice === 'chase') === r.strong) && quickRows.some((r) => r.strong) && quickRows.some((r) => !r.strong));
  const coin = [0, 0];
  const coinView = viewFor(summitPosition({ players: 3, hands: [strongHand, mid1, mid2], row: richRow, climbTricks: [3, 0, 3] }), 0);
  for (let i = 0; i < 200; i++) coin[makeArchetype('smart', 'random').chooseAction(coinView, { s: i + 1 }).choice === 'chase' ? 0 : 1]++;
  check('archetypes: the coin-flip summit chases about half the time', coin[0] > 60 && coin[1] > 60, `${coin}`);
  check('archetypes: the naive archetype plays naive cards but keeps the Monte Carlo summit (naive v smart play)', getBot('naive').style === 'naive' && getBot('naive').policy === 'smart' && getBot('naive-random').policy === 'random');
}

// ---------- 7. Hard ----------
{
  check('hard: sample counts shrink as candidates grow, within the bounds', samplesFor(1) === HARD_SAMPLES && samplesFor(10) >= HARD_MIN_SAMPLES && samplesFor(10) <= HARD_SAMPLES && samplesFor(100000) === HARD_MIN_SAMPLES && samplesFor(12) === Math.min(HARD_SAMPLES, Math.floor(HARD_MAX_ROLLOUTS / 12)));
  const g = createGame({ seed: 31, players: 3 });
  const v = viewFor(g, g.toAct);
  const a = searchAction(v, { s: 3 }, { samples: 8 });
  const b = searchAction(v, { s: 3 }, { samples: 8 });
  check('hard: a search is reproducible from its rng, and scores one entry per legal action', sameAction(a.action, b.action) && a.scores.length === legalActionsFromView(v).length && same(a.scores, b.scores));
  const single = position({ players: 3, hands: [['home-5'], ['home-3'], ['home-2']], leader: 0 });
  check('hard: a single legal action is returned at once', searchAction(viewFor(single, 0), { s: 1 }).scores.length === 1);

  // the summit: Hard searches the chase / watch choice from its view too
  const sureWin = summitPosition({ players: 3, hands: [['escape-1', 'climb-1', 'descent-1', 'home-1', 'home-2', 'climb-2'], ['escape-6', 'climb-6', 'descent-6', 'home-6', 'escape-7', 'climb-7'], ['escape-8', 'climb-8', 'descent-8', 'home-8', 'escape-9', 'climb-9']], row: ['brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus2-3', 'brumby-plus2-4', 'brumby-plus1-1', 'colt'], climbTricks: [0, 3, 3] });
  const hopeless = summitPosition({ players: 3, hands: [['escape-12', 'climb-12', 'descent-12', 'home-12', 'escape-11', 'climb-11'], ['escape-6', 'climb-6', 'descent-6', 'home-6', 'escape-7', 'climb-7'], ['escape-8', 'climb-8', 'descent-8', 'home-8', 'escape-9', 'climb-9']], row: ['brumby-flint', 'brumby-wombat-1', 'brumby-wombat-2', 'brumby-plus1-1', 'brumby-plus1-2', 'brumby-plus1-3'], climbTricks: [4, 1, 1] });
  const hs = searchAction(viewFor(sureWin, 0), { s: 2 }, { samples: 40 });
  const hh = searchAction(viewFor(hopeless, 0), { s: 2 }, { samples: 40 });
  check('hard: searches the summit choice from its view: chases with the best descent cards against a rich row, watches with the worst against a poor one', hs.action.type === 'summit' && hs.scores.length === 2 && hs.action.choice === 'chase' && hh.action.choice === 'watch', `${hs.action.choice} ${hs.scores.map((x) => x.toFixed(2))}; ${hh.action.choice} ${hh.scores.map((x) => x.toFixed(2))}`);
  // a later seat's summit decision: an earlier seat's locked-in side is hidden; whatever side it really holds, the search is identical
  const later = summitPosition({ players: 3, hands: [['escape-6', 'climb-6', 'descent-6', 'home-6', 'escape-7', 'climb-7'], ['escape-1', 'climb-1', 'descent-1', 'home-1', 'home-2', 'climb-2'], ['escape-8', 'climb-8', 'descent-8', 'home-8', 'escape-9', 'climb-9']], row: ['brumby-plus2-1', 'brumby-plus2-2', 'brumby-plus2-3', 'brumby-plus2-4', 'brumby-plus1-1', 'colt'], climbTricks: [1, 3, 2] });
  applyAction(later, { type: 'summit', choice: 'chase' }); // seat 0 locks in
  const twin = JSON.parse(JSON.stringify(later));
  twin.choices[0] = 'watch';
  check('hard: its answer is the same whatever side a locked-in seat actually holds (only the view reaches it)', later.toAct === 1 && same(searchAction(viewFor(later, 1), { s: 2 }, { samples: 20 }).scores, searchAction(viewFor(twin, 1), { s: 2 }, { samples: 20 }).scores));
  const sure = position({ players: 3, hands: [['escape-12', 'escape-1', 'home-6', 'home-7', 'climb-5', 'climb-6', 'climb-9'], ['climb-1', 'climb-2', 'climb-3', 'climb-4', 'climb-7', 'climb-8', 'descent-9'], ['descent-1', 'descent-2', 'descent-3', 'descent-4', 'descent-5', 'descent-6', 'descent-7']], leader: 0 }); // 7 cards each: the 6th climb trick is next
  check('hard: leads a card from a legal set at a hand-built position', (() => { const r = searchAction(viewFor(sure, 0), { s: 4 }, { samples: 10 }); return r.action.type === 'play' && viewFor(sure, 0).hand.includes(r.action.card); })());

  // The compact rollout the search plays out on must equal the real engine playing the same policy
  // (Medium's card play; at the summit the Python's `quick` guess for every seat that has not chosen).
  {
    const enginePlayOut = (world) => {
      world.params.handsPerGame = world.handNo + 1;
      while (world.toAct !== null) {
        const seat = world.toAct;
        let act;
        if (world.phase === 'summit') act = { type: 'summit', choice: quick(world.hands[seat].map(cardIndex)) ? 'chase' : 'watch' };
        else act = mediumChoose(buildContext(world, seat, world.hands[seat], world.hands.map((h) => h.length), null, {}), getValidActions(world));
        applyAction(world, act, { silent: true });
      }
      return world.handLog[world.handNo - 1].scores;
    };
    let compared = 0; let differ = 0; const phases = { climb: 0, summit: 0, descent: 0 };
    const easy = getBot('easy');
    for (const n of [2, 3, 4]) {
      for (let k = 0; k < 110; k++) {
        const s = createGame({ seed: deriveSeed('rollout', n, k), players: n });
        const rng = makeRng(deriveSeed('rollout-r', n, k));
        const steps = (k * 7) % (12 * n + 6 * n + n);
        for (let i = 0; i < steps && s.toAct !== null && s.handNo === 0; i++) applyAction(s, easy.chooseAction(viewFor(s, s.toAct), rng), { silent: true });
        if (s.toAct === null || s.handNo > 0) continue;
        const world = determinise(viewFor(s, s.toAct), makeRng(k + 1));
        phases[world.phase]++;
        const fast = handScores(playOut(worldFromState(world)));
        const eng = enginePlayOut(JSON.parse(JSON.stringify(world)));
        compared++;
        if (!same(fast, eng)) differ++;
      }
    }
    check(`hard: the compact rollout gives the engine's own hand scores from ${compared} sampled worlds (${phases.climb} on the climb, ${phases.summit} at the summit, ${phases.descent} on the descent)`, compared >= 150 && differ === 0 && phases.climb > 10 && phases.summit > 5 && phases.descent > 10, `${differ} differ`);
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
      const st = createGame({ seed: deriveSeed('wk', level), players: 4 });
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
    check(`worker: bot-worker.js answers Easy, Medium and Hard exactly as the in-process bots do (${checked} decisions at 4 players)`, ok && checked >= 18);
  }

  // Time per decision with the real budget (every decision Hard is asked, forced single-option ones are never asked).
  const timing = [];
  for (const n of [2, 3, 4]) {
    const ms = [];
    for (let game = 0; game < (FULL ? 6 : 2); game++) {
      const state = createGame({ seed: deriveSeed('time', n, game), players: n });
      const rngs = Array.from({ length: n }, (_, s) => makeRng(deriveSeed('time', n, s)));
      while (state.toAct !== null) {
        const seat = state.toAct;
        const view = viewFor(state, seat);
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
  const t4 = timing[2];
  check('hard: a decision at 4 players has a median under 100 ms and a p95 under 250 ms in Node (target about 250 ms)', t4.median < 100 && t4.p95 < 250 && t4.max < 500, `median ${t4.median.toFixed(0)} ms, p95 ${t4.p95.toFixed(0)} ms, max ${t4.max.toFixed(0)} ms`);
}

// ---------- 8. strength ----------
{
  const MV = FULL ? { 2: 1000, 3: 1000, 4: 1000 } : { 2: 300, 3: 300, 4: 300 };
  const mediumRuns = {};
  for (const n of [2, 3, 4]) {
    const r = await strengthRun({ strong: 'medium', opp: 'easy', n, games: MV[n], tag: 'm-v-e' });
    mediumRuns[n] = r;
    console.log(`  ${strengthLine('Medium v Easy', n, r)}`);
    check(`strength: one Medium against Easy wins clearly more than a fair share at ${n} players (z > 4)`, r.z > 4, `${r.win.toFixed(3)} z ${r.z.toFixed(1)}`);
  }
  const HV = FULL ? { 2: 1000, 3: 1000, 4: 600 } : { 2: 300, 3: 300, 4: 300 };
  const hardRuns = {};
  for (const n of [2, 3, 4]) {
    const r = await strengthRun({ strong: 'hard', opp: 'medium', n, games: HV[n], tag: 'h-v-m' });
    hardRuns[n] = r;
    console.log(`  ${strengthLine('Hard v Medium', n, r)}`);
    check(`strength: one Hard against Medium wins clearly more than a fair share at ${n} players (z > 3)`, r.z > 3, `${r.win.toFixed(3)} z ${r.z.toFixed(1)}`);
  }
  check('strength: Easy < Medium < Hard at every player count (each stronger level beats the one below)', [2, 3, 4].every((n) => mediumRuns[n].win > 1 / n && hardRuns[n].win > 1 / n));
}

done();
