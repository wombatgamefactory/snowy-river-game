// bots.mjs - the bots: registry, determinism, no view mutation, only-the-view imports, legality of every
// move at every player count, Medium and the naive archetype decision-matched against the Python
// simulator's own bots (tests/fixtures/bots-python-decisions.json, recorded from
// the Python simulator), Medium's habits on hand-built positions, Hard,
// and strength checks with counts and z-scores (Medium v Easy, Hard v Medium).
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. `--full` runs the long strength budgets.

import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  createGame, startGame, applyAction, viewFor, legalActionsFromView, getValidActions,
  makeRng, deriveSeed, rngPick, fullDeck,
} from '../src/engine/index.js';
import { getBot, botLevels, registerBot } from '../src/bots/index.js';
import { searchAction, samplesFor, HARD_SAMPLES, HARD_MIN_SAMPLES } from '../src/bots/hard.js';
import { buildContext, summitCall, chooseMediumFromView, MEDIUM_SAMPLES } from '../src/bots/medium.js';
import { makeArchetype, archetypeBots } from '../src/bots/archetypes.js';
import { descentHeels, unplayedMask } from '../src/bots/smart-core.js';
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

// ---------- 1. registry ----------
{
  const levels = botLevels();
  check('registry: easy, medium and hard are offered', ['easy', 'medium', 'hard'].every((id) => levels.some((l) => l.id === id && l.offered)));
  check('registry: only easy, medium and hard are offered', levels.filter((l) => l.offered).length === 3);
  check('registry: the simulator archetypes (always, never, random, nothing, naive, naive-random, plus the kit probes high and low) are registered, none offered', ['always', 'never', 'random', 'nothing', 'naive', 'naive-random', 'high', 'low'].every((id) => levels.some((l) => l.id === id && !l.offered)) && archetypeBots.every((b) => levels.some((l) => l.id === b.id && !l.offered)));
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
  const w1 = createGame({ seed: 11, players: 4 });
  const w2 = createGame({ seed: 11, players: 4 });
  const other = (w2.toAct + 1) % 4;
  const k = w2.out.length; // swap hidden cards: the first k cards of another seat's hand trade places with the cards out of play
  const [swapped, kept] = [w2.hands[other].slice(0, k), w2.hands[other].slice(k)];
  w2.hands[other] = [...w2.out, ...kept];
  w2.out = swapped;
  const v1 = viewFor(w1, w1.toAct); const v2 = viewFor(w2, w2.toAct);
  check('only the view: two worlds that differ only in hidden cards give identical views', JSON.stringify(v1) === JSON.stringify(v2));

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
  const perCount = FULL ? 500 : 500;
  let games = 0; let refusals = 0; let illegal = 0; let mutated = 0; let unfinished = 0; const used = new Set();
  for (const n of [2, 3, 4, 5]) {
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
  for (const n of [2, 3, 4, 5]) {
    for (let i = 0; i < (FULL ? 60 : 30); i++) {
      const r = playGame({ levels: Array.from({ length: n }, (_, s) => (s === i % n ? 'hard-fast' : MIXED[(i + s) % 2])), seed: deriveSeed('leg-hard', n, i), checkView: i < 5 });
      hardGames++; hardBad += r.illegal + r.refusals + r.mutated + (r.over ? 0 : 1);
    }
  }
  for (const n of [2, 3, 4, 5]) {
    for (let i = 0; i < (FULL ? 6 : 2); i++) {
      const r = playGame({ levels: Array.from({ length: n }, (_, s) => (s === i % n ? 'hard' : 'medium')), seed: deriveSeed('leg-hard-real', n, i), checkView: true });
      hardGames++; hardBad += r.illegal + r.refusals + r.mutated + (r.over ? 0 : 1);
    }
  }
  check(`legality: Hard (a 2-world search, and the real budget) plays ${hardGames} games at 2-5 players with only legal moves`, hardBad === 0, `${hardBad}`);
}

// ---------- 4. Python decision match ----------
{
  const FX = JSON.parse(readFileSync(new URL('./fixtures/bots-python-decisions.json', import.meta.url), 'utf8'));
  const DECK = fullDeck(); // the fixture alphabet is fullDeck() order (suit id x 12 + rank - 1)
  const cardOf = (c) => DECK[FX.alphabet.indexOf(c)];
  const botFor = (style, policy) => (style === 'smart' && policy === 'smart' ? getBot('medium') : makeArchetype(style, policy));
  const st = {
    cards: 0, cardBad: 0, cardByStyle: { smart: 0, naive: 0 }, cardByPhase: { climb: 0, descent: 0 }, cardByN: { 2: 0, 3: 0, 4: 0, 5: 0 },
    detSummit: 0, detSummitBad: 0, fixedP: 0, fixedPBad: 0, fixedCall: 0, fixedCallBad: 0,
    natural: 0, naturalSame: 0, naturalNoVoids: 0, naturalNoVoidsSame: 0, extreme: 0, extremeSame: 0, extremeNoVoids: 0, extremeNoVoidsSame: 0, randomSkipped: 0,
    hands: 0, games: 0, selfAgree: 0,
  };
  const firstBad = [];
  const bad = (id, what) => { if (firstBad.length < 10) firstBad.push(`${id}: ${what}`); };
  FX.games.forEach((fg, gi) => {
    const n = fg.n;
    const state = startGame({
      seed: `fxb:${gi}`, players: n, firstDealer: 0,
      deals: fg.hands.map((fh) => ({ hands: fh.h.map((s) => [...s].map(cardOf)) })),
      manualSeats: Array.from({ length: n }, (_, s) => s),
    }).state;
    const rngs = Array.from({ length: n }, (_, s) => makeRng(deriveSeed('fxb', gi, s)));
    const rngsNo = Array.from({ length: n }, (_, s) => makeRng(deriveSeed('fxb-nv', gi, s)));
    const rngsNo2 = Array.from({ length: n }, (_, s) => makeRng(deriveSeed('fxb-nv2', gi, s)));
    st.games++;
    for (const fh of fg.hands) {
      const plays = [...fh.p].map(cardOf);
      const seats = [...fh.s].map(Number);
      const handNo = state.handNo;
      let i = 0; let guard = 0;
      st.hands++;
      while (state.handLog.length === handNo && state.toAct !== null && guard++ < 500) {
        const seat = state.toAct;
        const id = `g${gi} hand ${handNo} seat ${seat}`;
        const style = fg.styles[seat]; const policy = fg.policies[seat];
        const view = viewFor(state, seat);
        if (state.phase === 'summit') {
          const pyChase = fh.c[seat] === 'C';
          const bot = botFor(style, policy);
          if (policy === 'random') {
            st.randomSkipped++;
          } else if (policy !== 'smart') {
            // always / never / nothing: deterministic, must match exactly
            st.detSummit++;
            const a = bot.chooseAction(view, rngs[seat]);
            if ((a.choice === 'chase') !== pyChase) { st.detSummitBad++; bad(id, `${policy} summit JS ${a.choice}, Python ${pyChase}`); }
          } else {
            const ep = fh.e.find((e) => e[0] === seat);
            const pyP = ep[1] / FX.samples;
            // (a) the Python's own sample set: the same p, the same call
            if (ep[2]) {
              const ctx = buildContext(view, seat, view.hand, view.handCounts, null, {});
              const pools = ep[2].map((s) => [...s].map(cardOf));
              const r = summitCall(ctx, pools);
              st.fixedP++; st.fixedCall++;
              if (r.p !== pyP) { st.fixedPBad++; bad(id, `p JS ${r.p}, Python ${pyP}`); }
              if (r.chase !== pyChase) { st.fixedCallBad++; bad(id, `call JS ${r.chase}, Python ${pyChase} (p ${pyP})`); }
            }
            // (b) the bot's own random samples (statistical): with the shown voids, and with the Python's deal
            const a = bot.chooseAction(view, rngs[seat]);
            const b = chooseMediumFromView(view, rngsNo[seat], { voids: false }); // the summit call does not depend on the card style
            const b2 = chooseMediumFromView(view, rngsNo2[seat], { voids: false });
            st.selfAgree += (b.choice === b2.choice) ? 1 : 0;
            const extreme = ep[1] === 0 || ep[1] === FX.samples;
            st.natural++; st.naturalNoVoids++;
            if ((a.choice === 'chase') === pyChase) st.naturalSame++;
            if ((b.choice === 'chase') === pyChase) st.naturalNoVoidsSame++;
            if (extreme) {
              st.extreme++; st.extremeNoVoids++;
              if ((a.choice === 'chase') === pyChase) st.extremeSame++;
              if ((b.choice === 'chase') === pyChase) st.extremeNoVoidsSame++;
            }
          }
          applyAction(state, { type: 'summit', choice: pyChase ? 'chase' : 'watch' });
          continue;
        }
        if (i >= plays.length || seat !== seats[i]) { bad(id, `play ${i}: engine seat ${seat}, Python seat ${seats[i]}`); st.cardBad++; break; }
        const legal = getValidActions(state);
        if (legal.length > 1) {
          const a = botFor(style, policy).chooseAction(view, rngs[seat]);
          st.cards++; st.cardByStyle[style]++; st.cardByPhase[state.phase]++; st.cardByN[n]++;
          if (a.card !== plays[i]) { st.cardBad++; bad(id, `${style} ${state.phase} play ${i}: JS ${a.card}, Python ${plays[i]} (hand ${view.hand.join(' ')}; trick ${(view.trick ? view.trick.plays.map((p) => p.card) : []).join(' ')})`); }
        }
        applyAction(state, { type: 'play', card: plays[i] });
        i++;
      }
    }
  });
  const smartSummits = st.fixedP + (st.natural - st.fixedP);
  console.log(`  decision match: ${st.games} Python games, ${st.hands} hands, ${FX.counts[2].cardDecisions + FX.counts[3].cardDecisions + FX.counts[4].cardDecisions + FX.counts[5].cardDecisions} recorded plays`);
  console.log(`    card play: ${st.cards} decisions with 2+ legal cards (smart ${st.cardByStyle.smart}, naive ${st.cardByStyle.naive}; climb ${st.cardByPhase.climb}, descent ${st.cardByPhase.descent}; 2p ${st.cardByN[2]}, 3p ${st.cardByN[3]}, 4p ${st.cardByN[4]}, 5p ${st.cardByN[5]}), ${st.cardBad} mismatches`);
  console.log(`    summit, deterministic policies (always / never / nothing): ${st.detSummit} decisions, ${st.detSummitBad} mismatches; coin-flip summits skipped: ${st.randomSkipped}`);
  console.log(`    summit, Monte Carlo fed the Python's own ${FX.samples} samples: ${st.fixedP} decisions, p mismatches ${st.fixedPBad}, call mismatches ${st.fixedCallBad}`);
  console.log(`    summit, Monte Carlo on its own samples (${smartSummits} decisions): with shown voids agrees with the Python's call in ${st.naturalSame} (${pct(st.naturalSame / st.natural)}); with the Python's void-blind deal in ${st.naturalNoVoidsSame} (${pct(st.naturalNoVoidsSame / st.naturalNoVoids)}); where the Python's p was 0 or 1 (${st.extreme}): ${st.extremeSame} and ${st.extremeNoVoidsSame}; two independent runs of the port agree with each other in ${pct(st.selfAgree / st.natural)} (the ceiling for any 16-sample estimate)`);
  for (const f of firstBad) console.log(`    mismatch ${f}`);
  check('match: the fixture has 1000+ non-forced card decisions, both styles and both phases, at every player count', st.cards >= 1000 && st.cardByStyle.smart > 0 && st.cardByStyle.naive > 0 && st.cardByPhase.climb > 0 && st.cardByPhase.descent > 0 && Object.values(st.cardByN).every((k) => k > 100), JSON.stringify(st.cardByN));
  check('match: Medium and the naive archetype play the Python\'s card at every one of those decisions (zero mismatches)', st.cardBad === 0, `${st.cardBad} of ${st.cards}`);
  check('match: always / never / nothing summit policies match the Python in every decision', st.detSummit > 100 && st.detSummitBad === 0, `${st.detSummitBad} of ${st.detSummit}`);
  check('match: fed the Python\'s own samples, the Monte Carlo returns the same p (exactly) at every recorded decision', st.fixedP >= 500 && st.fixedPBad === 0, `${st.fixedPBad} of ${st.fixedP}`);
  check('match: fed the Python\'s own samples, the summit call (p x mob > (1 - p) x (climb + fall)) is the Python\'s every time', st.fixedCallBad === 0, `${st.fixedCallBad} of ${st.fixedCall}`);
  check('match: on its own samples the Monte Carlo (void-blind, as the Python) calls the summit like the Python about as often as two runs of the port agree with each other (within 3 points)', st.naturalNoVoidsSame / st.naturalNoVoids >= st.selfAgree / st.natural - 0.03, `${pct(st.naturalNoVoidsSame / st.naturalNoVoids)} v ${pct(st.selfAgree / st.natural)}`);
  check('match: where the Python\'s own p was 0 or 1, the void-blind port calls the summit the same in at least 97% of cases', st.extremeNoVoids > 50 && st.extremeNoVoidsSame / st.extremeNoVoids >= 0.97, `${st.extremeNoVoidsSame}/${st.extremeNoVoids}`);
  check('match: Medium (with shown voids, its default) still agrees with the Python\'s summit call in at least 80% of decisions', st.naturalSame / st.natural >= 0.8, pct(st.naturalSame / st.natural));
  check('match: Medium samples 16 worlds as the Python', MEDIUM_SAMPLES === FX.samples);

  // the fast numeric core equals a plain re-statement of the Python on random positions (descent playout winner)
  const rng = makeRng('core');
  let ok = 0; let tot = 0;
  for (let k = 0; k < 200; k++) {
    const g = createGame({ seed: deriveSeed('core', k), players: 2 + (k % 4) });
    const n = g.n;
    const hands = g.hands.map((h) => h.slice());
    const top = descentHeels(hands, g.leader, unplayedMask([]), n);
    tot++; if (top >= 0 && top < n) ok++;
  }
  void rng;
  check('core: the descent playout always ends with one seat at the heels', ok === tot);
}

// ---------- 5. Medium and the archetypes on hand-built positions ----------
{
  const med = (g, seat) => getBot('medium').chooseAction(viewFor(g, seat), { s: 1 });
  const naive = (g, seat) => getBot('naive').chooseAction(viewFor(g, seat), { s: 1 });
  const lead = position({ hands: [['escape-12', 'escape-3', 'home-7'], ['climb-1', 'climb-2', 'descent-1'], ['climb-3', 'climb-4', 'descent-2'], ['climb-5', 'climb-6', 'descent-3']], leader: 0 });
  check('medium: in the climb it leads the cheapest card nothing unseen can beat', med(lead, 0).card === 'escape-12');
  check('medium: a climb lead with no sure card dumps the most middle card (a 7 before a 3 or a 1)', (() => {
    const g = position({ hands: [['escape-3', 'home-7', 'home-1'], ['climb-1', 'climb-2', 'descent-1'], ['climb-3', 'climb-4', 'descent-2'], ['climb-5', 'climb-6', 'descent-3']], leader: 0 });
    return med(g, 0).card === 'home-7';
  })());
  const follow = position({ hands: [['home-5', 'escape-1', 'climb-7'], ['home-6', 'home-9', 'home-12'], ['climb-3', 'climb-4', 'descent-2'], ['climb-5', 'climb-6', 'descent-3']], leader: 0 });
  applyAction(follow, { type: 'play', card: 'home-5' });
  check('medium: in the climb it follows with the cheapest card that wins as it stands', med(follow, 1).card === 'home-6');
  const void1 = position({ hands: [['home-5', 'escape-1', 'climb-7'], ['climb-1', 'climb-9', 'descent-12'], ['climb-3', 'climb-4', 'descent-2'], ['climb-5', 'climb-6', 'descent-3']], leader: 0 });
  applyAction(void1, { type: 'play', card: 'home-5' });
  check('medium: void in the climb it throws the most middle card (keeps the extremes)', med(void1, 1).card === 'climb-9');
  const desc = position({ hands: [['home-5', 'escape-1', 'climb-7'], ['home-2', 'home-4', 'home-12'], ['climb-3', 'climb-4', 'descent-2'], ['climb-5', 'climb-6', 'descent-3']], leader: 0, phase: 'descent' });
  applyAction(desc, { type: 'play', card: 'home-5' });
  check('medium: in the descent it follows with the highest card that still undercuts', med(desc, 1).card === 'home-4');
  check('medium: in the descent, unable to undercut, it throws its highest card of the suit', (() => {
    const g = position({ hands: [['home-2', 'escape-1', 'climb-7'], ['home-4', 'home-9', 'home-12'], ['climb-3', 'climb-4', 'descent-2'], ['climb-5', 'climb-6', 'descent-3']], leader: 0, phase: 'descent' });
    applyAction(g, { type: 'play', card: 'home-2' });
    return med(g, 1).card === 'home-12';
  })());
  check('naive: wins a climb trick with the cheapest winner, and dumps its LOWEST card when it cannot', (() => {
    const g = position({ hands: [['home-5', 'escape-1', 'climb-7'], ['home-3', 'home-4', 'home-1'], ['climb-3', 'climb-4', 'descent-2'], ['climb-5', 'climb-6', 'descent-3']], leader: 0 });
    applyAction(g, { type: 'play', card: 'home-5' });
    return naive(g, 1).card === 'home-1';
  })());

  // the summit. A hand of 12s against 1s and 2s can never be at the heels (p = 0): with climb tricks to lose, Medium watches.
  const hopeless = position({ players: 3, hands: [['escape-12', 'climb-12', 'descent-12', 'home-12'], ['escape-1', 'climb-1', 'descent-1', 'home-1'], ['escape-2', 'climb-2', 'descent-2', 'home-2']], leader: 0, marker: 6, climbTricks: [4, 2, 2] });
  applyAction(hopeless, { type: 'play', card: 'escape-12' });
  check('medium: with climb tricks to lose and no chance of the heels (p = 0) it watches', hopeless.phase === 'summit' && hopeless.toAct === 0 && med(hopeless, 0).choice === 'watch');
  // a hand of 1s against 11s and 12s wins every descent trick (p = 1): with a 7-point mob and nothing to lose it chases.
  const sure = position({ players: 3, hands: [['escape-1', 'climb-1', 'descent-1', 'home-1'], ['escape-12', 'climb-12', 'descent-12', 'home-12'], ['escape-11', 'climb-11', 'descent-11', 'home-11']], leader: 0, marker: 6, climbTricks: [0, 2, 2], brumbies: 2 });
  applyAction(sure, { type: 'play', card: 'escape-1' }); // seat 1 takes the trick (escape-12); the summit is reached
  const first = sure.toAct;
  applyAction(sure, { type: 'summit', choice: 'watch' });
  applyAction(sure, { type: 'summit', choice: 'watch' });
  check('medium: a hand of 1s against 11s and 12s (p = 1) chases for the mob', sure.phase === 'summit' && first === 1 && sure.toAct === 0 && med(sure, 0).choice === 'chase');

  // the archetypes' summit policies, read off the same table
  const summitTable = () => {
    const g = position({ hands: [['escape-5', 'escape-6', 'climb-1'], ['escape-1', 'home-2', 'climb-2'], ['escape-2', 'descent-2', 'climb-3'], ['escape-3', 'descent-3', 'climb-4']], leader: 0, marker: 6, climbTricks: [3, 0, 2, 0] });
    applyAction(g, { type: 'play', card: 'escape-5' });
    return g;
  };
  const policyRows = (policy) => {
    const g = summitTable();
    const bot = makeArchetype('smart', policy);
    const out = [];
    while (g.phase === 'summit') {
      const seat = g.toAct;
      const view = viewFor(g, seat);
      out.push({ seat, climb: view.climbTricks[seat], choice: bot.chooseAction(view, { s: 1 }).choice });
      applyAction(g, { type: 'summit', choice: 'watch' });
    }
    return out;
  };
  const nothingRows = policyRows('nothing');
  check('archetypes: always chases, never watches, nothing-to-lose chases exactly the seats without climb tricks',
    policyRows('always').every((r) => r.choice === 'chase') && policyRows('never').every((r) => r.choice === 'watch')
    && nothingRows.every((r) => (r.choice === 'chase') === (r.climb === 0)) && nothingRows.some((r) => r.climb === 0) && nothingRows.some((r) => r.climb > 0));
  const coin = [0, 0];
  const coinView = viewFor(summitTable(), 0);
  for (let i = 0; i < 200; i++) coin[makeArchetype('smart', 'random').chooseAction(coinView, { s: i + 1 }).choice === 'chase' ? 0 : 1]++;
  check('archetypes: the coin-flip summit chases about half the time', coin[0] > 60 && coin[1] > 60, `${coin}`);
}

// ---------- 6. Hard ----------
{
  check('hard: sample counts shrink as candidates grow, within the bounds', samplesFor(1) === HARD_SAMPLES && samplesFor(10) >= HARD_MIN_SAMPLES && samplesFor(10) <= HARD_SAMPLES && samplesFor(100) === HARD_MIN_SAMPLES);
  const g = createGame({ seed: 31, players: 3 });
  const v = viewFor(g, g.toAct);
  const a = searchAction(v, { s: 3 }, { samples: 8 });
  const b = searchAction(v, { s: 3 }, { samples: 8 });
  check('hard: a search is reproducible from its rng, and scores one entry per legal action', sameAction(a.action, b.action) && a.scores.length === legalActionsFromView(v).length && same(a.scores, b.scores));
  const single = position({ players: 3, hands: [['home-5'], ['home-3'], ['home-2']], leader: 0 });
  check('hard: a single legal action is returned at once', searchAction(viewFor(single, 0), { s: 1 }).scores.length === 1);
  const sm = position({ hands: [['escape-5', 'escape-6', 'climb-1'], ['escape-1', 'home-2', 'climb-2'], ['escape-2', 'descent-2', 'climb-3'], ['escape-3', 'descent-3', 'climb-4']], leader: 0, marker: 6 });
  applyAction(sm, { type: 'play', card: 'escape-5' });
  applyAction(sm, { type: 'summit', choice: 'chase' });
  const hs = searchAction(viewFor(sm, sm.toAct), { s: 2 }, { samples: 6 });
  check('hard: searches the summit choice from its view (a hidden choice is guessed, never read)', hs.action.type === 'summit' && hs.scores.length === 2);
  // the summit choice does not depend on another seat's hidden side: flip it and the search is identical
  const twin = JSON.parse(JSON.stringify(sm));
  twin.choices[0] = twin.choices[0] === 'chase' ? 'watch' : 'chase';
  check('hard: its answer is the same whatever side a locked-in seat actually holds (only the view reaches it)', same(searchAction(viewFor(sm, sm.toAct), { s: 2 }, { samples: 6 }).scores, searchAction(viewFor(twin, twin.toAct), { s: 2 }, { samples: 6 }).scores));
  // sanity: from a hand-built lead position Hard returns one of its own legal cards
  const sure = position({ players: 3, hands: [['escape-12', 'escape-1', 'home-6'], ['climb-1', 'climb-2', 'climb-3'], ['descent-1', 'descent-2', 'descent-3']], leader: 0 });
  check('hard: leads a card from a legal set at a hand-built position', (() => { const r = searchAction(viewFor(sure, 0), { s: 4 }, { samples: 6 }); return r.action.type === 'play' && ['escape-12', 'escape-1', 'home-6'].includes(r.action.card); })());

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

  // Time per decision with the real budget.
  const timing = [];
  for (const n of [2, 3, 4, 5]) {
    const ms = [];
    for (let game = 0; game < (FULL ? 4 : 1); game++) {
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
  for (const t of timing) console.log(`  hard time ${t.n}p: ${t.count} decisions, median ${t.median.toFixed(1)} ms, mean ${t.mean.toFixed(1)} ms, p95 ${t.p95.toFixed(1)} ms, max ${t.max.toFixed(1)} ms`);
  const t5 = timing[3];
  check('hard: a decision at 5 players has a median under 150 ms and a p95 under 400 ms in Node (target about 250 ms)', t5.median < 150 && t5.p95 < 400, `median ${t5.median.toFixed(0)} ms, p95 ${t5.p95.toFixed(0)} ms`);
}

// ---------- 7. strength ----------
{
  const MV = FULL ? { 2: 1000, 3: 1000, 4: 1000, 5: 1000 } : { 2: 300, 3: 300, 4: 300, 5: 300 };
  for (const n of [2, 3, 4, 5]) {
    const r = await strengthRun({ strong: 'medium', opp: 'easy', n, games: MV[n], tag: 'm-v-e' });
    console.log(`  ${strengthLine('Medium v Easy', n, r)}`);
    check(`strength: one Medium against Easy wins clearly more than a fair share at ${n} players (z > 4)`, r.z > 4, `${r.win.toFixed(3)} z ${r.z.toFixed(1)}`);
  }
  const HV = FULL ? { 2: 300, 3: 300, 4: 300, 5: 300 } : { 2: 60, 3: 120, 4: 120, 5: 120 };
  const hardRuns = {};
  for (const n of [2, 3, 4, 5]) {
    const r = await strengthRun({ strong: 'hard', opp: 'medium', n, games: HV[n], tag: 'h-v-m' });
    hardRuns[n] = r;
    console.log(`  ${strengthLine('Hard v Medium', n, r)}`);
  }
  const ok = [2, 3, 4, 5].filter((n) => hardRuns[n].win > 1 / n).length;
  check('strength: one Hard against Medium wins more than a fair share at every player count', ok === 4, [2, 3, 4, 5].map((n) => `${n}p ${hardRuns[n].win.toFixed(3)} z ${hardRuns[n].z.toFixed(1)}`).join('; '));
  const zsum = [2, 3, 4, 5].reduce((acc, n) => acc + hardRuns[n].z, 0) / 2; // Stouffer combination of the four counts
  check('strength: combined over the four player counts Hard beats Medium (Stouffer z > 4)', zsum > 4, `combined z ${zsum.toFixed(1)}`);
}

done();
