// sim-check.mjs - the simulator is deterministic and its records are consistent (a few seconds).
// Same seed twice gives identical JSON (also across worker threads); every game plays n hands and the
// records agree with the engine's own totals and winners; bad arguments are refused; --const is
// restored after a run; the per-hand records agree with the rules (outcomes, scores, dealt strength, Brumby stack,
// fixed clock); the Python simulator's reference numbers (the all-smart-bot table) as wide range checks; the report and
// the cross-check run.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runSim, runSimThreaded } from './sim.mjs';
import { report, crossCheck, winnersOf } from './sim-report.mjs';
import { CONSTANTS } from '../src/engine/index.js';
import { suite } from './lib.mjs';

const { check, done } = suite('sim-check');
const run = (argv) => runSim(parseArgs(argv));
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// ---- determinism, termination, consistency ----
for (const argv of [
  ['--players=2', '--seats=easy', '--games=60', '--seed=7'],
  ['--players=3', '--seats=medium,high,easy', '--games=60', '--seed=7', '--jitter=10'],
  ['--players=4', '--seats=medium,high,low,easy', '--games=60', '--seed=9'],
  ['--players=5', '--seats=medium', '--games=40', '--seed=3'],
  ['--players=3', '--seats=hard:2,medium,easy', '--games=6', '--seed=4'],
]) {
  const a = JSON.stringify(run(argv));
  const b = JSON.stringify(run(argv));
  const tag = argv.slice(0, 3).join(' ');
  check(`same seed, same JSON (${tag})`, a === b);
  const games = JSON.parse(a);
  const n = parseArgs(argv).players;
  check(`${tag}: hands per game 3, 3, 4, 5`, games.every((g) => g.h.length === { 2: 3, 3: 3, 4: 4, 5: 5 }[n]));
  check(`${tag}: hand scores add up to the totals`, games.every((g) => g.tot.every((t, s) => g.h.reduce((x, h) => x + h.s[s], 0) === t)));
  check(`${tag}: climb tricks add up to the summit trick`, games.every((g) => g.h.every((h) => h.ct.reduce((x, y) => x + y, 0) === h.k)));
  check(`${tag}: the winners are the top total, then mobs brought home, and the report agrees`, games.every((g) => {
    const w = winnersOf(g);
    return JSON.stringify(w.withTb) === JSON.stringify(g.win) && JSON.stringify(w.tied) === JSON.stringify(g.tied) && g.tb === (g.win.length < g.tied.length);
  }));
}
check('different seeds differ', JSON.stringify(run(['--games=30', '--seed=1', '--seats=easy'])) !== JSON.stringify(run(['--games=30', '--seed=2', '--seats=easy'])));
{
  const a = parseArgs(['--players=4', '--seats=medium,easy,easy,easy', '--games=24', '--seed=5']);
  const serial = JSON.stringify(runSim(a));
  const threaded = JSON.stringify((await runSimThreaded({ ...a, threads: 3 })).games);
  check('worker threads give the same games as one thread', serial === threaded);
  const rot = runSim(a);
  check('seat rotation moves the bot list', rot[0].lv[0] === 'medium' && rot[1].lv[3] === 'medium' && rot[1].lv[0] === 'easy');
  const fixed = runSim({ ...a, rotate: false });
  check('--rotate=0 keeps the seats as listed', fixed.every((g) => g.lv[0] === 'medium' && g.lv[1] === 'easy'));
}
{
  const before = JSON.stringify(CONSTANTS);
  const a = parseArgs(['--players=4', '--seats=medium', '--games=20', '--seed=1', '--const.MOB_BASE=4']);
  const g = run(['--players=4', '--seats=medium', '--games=20', '--seed=1', '--const.MOB_BASE=4']);
  check('--const changes the rules for the run (a mob of 4 + 2 per Brumby card)', a.consts.MOB_BASE === 4 && g.every((x) => x.h.every((h) => (h.m - 4) % 2 === 0 && (h.home < 0 || h.s[h.home] === h.ct[h.home] + h.m))) && g.some((x) => x.h[0].m === 4));
  check('--const is restored after the run', JSON.stringify(CONSTANTS) === before);
}

// ---- the Snowy River record: outcomes, scores, dealt strength, the Brumby stack, the cap, the fixed clock ----
{
  const games = run(['--players=4', '--seats=medium,naive,always,never', '--games=80', '--seed=11']);
  const hands = games.flatMap((g) => g.h);
  check('outcomes: watchers keep their climb tricks, the home seat adds the mob, a fallen chaser scores -1', hands.every((h) => h.s.every((sc, s) => (
    h.o[s] === 'W' ? sc === h.ct[s] : h.o[s] === 'H' ? sc === h.ct[s] + h.m : sc === -1))));
  check('choices and outcomes agree: only chasers home or fell; one home seat or none', hands.every((h) => [...h.o].every((x, s) => (x === 'W') === (h.c[s] === 'W')) && (h.o.match(/H/g) || []).length === (h.home >= 0 ? 1 : 0)));
  check('nobody chasing means no descent: no heels seat, every outcome W', hands.every((h) => (h.c.includes('C') ? h.heels >= 0 : h.heels === -1 && h.home === -1 && h.dt.every((x) => x === 0))));
  check('dealt strength: 11 cards of ranks 1..12 (21..122), extremity 8.5..60.5', hands.every((h) => h.ds.every((x) => x >= 21 && x <= 122) && h.de.every((x) => x >= 8.5 && x <= 60.5)));
  check('the Brumby stack starts at 0, grows by 1 per escape and goes back to 0 after a mob comes home', games.every((g) => g.h.every((h, i) => {
    if (i === 0) return h.b === 0;
    const p = g.h[i - 1];
    return h.b === (p.home >= 0 ? 0 : Math.min(4, p.b + 1)) && h.m === 3 + 2 * h.b;
  })));
  check('standard games never reach the 4-Brumby cap (at most 5 hands)', hands.every((h) => h.cap === 0 && h.b <= 4));
  const fixed = run(['--players=4', '--seats=medium', '--games=30', '--seed=2', '--const.CLOCK=fixed']);
  check('--const.CLOCK=fixed puts the summit after half the hand (5 of 11 at 4p)', fixed.every((g) => g.h.every((h) => h.k === 5)));
  const blind = JSON.stringify(run(['--players=3', '--seats=medium-blind,naive-blind,medium', '--games=10', '--seed=3']));
  check('the void-blind bots are deterministic too', blind === JSON.stringify(run(['--players=3', '--seats=medium-blind,naive-blind,medium', '--games=10', '--seed=3'])));
  const arch = run(['--players=5', '--seats=always,never,random,nothing,naive-random', '--games=10', '--seed=3']);
  check('the archetypes play: always chases every hand, never chases none', arch.every((g) => g.h.every((h) => {
    const at = (id) => h.c[g.lv.indexOf(id)];
    return at('always') === 'C' && at('never') === 'W';
  })));
}

// ---- refusals ----
{
  let threw = 0;
  const bad = [['--variant.NOPE=1'], ['--variant.TRUMP=red'], ['--seats=genius'], ['--players=6'], ['--players=1'], ['--players=4', '--seats=easy,easy'], ['--const.NOPE=1'], ['--bogus=1']];
  for (const b of bad) {
    try { parseArgs(b); } catch { threw++; }
  }
  check('bad variants, bots, counts, constants and options are refused', threw === bad.length, `${threw}/${bad.length}`);
}

// ---- sanity numbers: the summit comes between trick 2 and trick 7 at 4 players ----
{
  const games = run(['--players=4', '--seats=medium', '--games=200', '--seed=1']);
  const hands = games.flatMap((g) => g.h);
  const avg = mean(hands.map((h) => h.k));
  check('4p medium: the summit trick is 2..7 and averages between 3 and 7', hands.every((h) => h.k >= 2 && h.k <= 7) && avg > 3 && avg < 7, avg.toFixed(2));
}

// ---- the Python's reference numbers (all-smart bots), as wide range checks ----
// 250 games per count: the ranges are the table value +- about 4 sampling sd (the exact comparison is in the balance report).
{
  const share = (xs) => xs.filter(Boolean).length / xs.length;
  const ranges = {
    // n: [summit trick, nobody chases, mob home, ties]   (4%/9%/11%/11% ties are wide: 250 games)
    2: { k: [5.9, 6.9], nobody: [0.04, 0.17], home: [0.68, 0.90] },
    3: { k: [5.4, 6.4], nobody: [0.05, 0.18], home: [0.62, 0.84] },
    4: { k: [4.8, 5.6], nobody: [0.05, 0.19], home: [0.58, 0.81] },
    5: { k: [3.6, 4.5], nobody: [0.04, 0.19], home: [0.56, 0.80] },
  };
  for (const n of [2, 3, 4, 5]) {
    const hands = run([`--players=${n}`, '--seats=medium-blind', '--games=250', '--seed=21']).flatMap((g) => g.h);
    const r = ranges[n];
    const k = mean(hands.map((h) => h.k)); const nobody = share(hands.map((h) => !h.c.includes('C'))); const home = share(hands.map((h) => h.home >= 0));
    check(`${n}p reference: summit trick ${r.k[0]}-${r.k[1]} (Python ${[6.4, 5.9, 5.2, 4.0][n - 2]})`, k >= r.k[0] && k <= r.k[1], k.toFixed(2));
    check(`${n}p reference: nobody chases ${r.nobody[0] * 100}-${r.nobody[1] * 100}% (Python ${[10, 11, 12, 11][n - 2]}%)`, nobody >= r.nobody[0] && nobody <= r.nobody[1], (nobody * 100).toFixed(1));
    check(`${n}p reference: mob brought home ${r.home[0] * 100}-${r.home[1] * 100}% (Python ${[80, 73, 70, 69][n - 2]}%)`, home >= r.home[0] && home <= r.home[1], (home * 100).toFixed(1));
  }
}

// ---- the report and the cross-check ----
{
  const dir = mkdtempSync(join(tmpdir(), 'sim-check-'));
  try {
    const f = join(dir, 'a.json');
    const a = parseArgs(['--players=3', '--seats=medium,high,easy', '--games=40', '--seed=1']);
    writeFileSync(f, JSON.stringify({ meta: { players: 3, seats: a.seats, rotate: true, jitter: 0, variants: {}, consts: {}, rules: a.rules }, games: runSim(a) }));
    const text = report([f]);
    check('report prints the summary and the bot table', /tie for 1st/.test(text) && /Win % by bot/.test(text) && /still shared/.test(text));
    check('report prints the Snowy River measures', /chasers per hand/.test(text) && /fewest-climb/.test(text) && /Brumby stack/.test(text) && /hand extremity/.test(text) && /cap binds/.test(text));
    const x = crossCheck(f, f);
    check('cross-check of a file against itself shows no difference', /within CI/.test(x) && !/DIFFERS/.test(x));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

done();
