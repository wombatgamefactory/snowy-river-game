// sim-check.mjs - the v5 simulator is deterministic and its records are consistent (a few seconds).
// Same seed twice gives identical JSON (also across worker threads); every game plays the right number of hands and the
// records agree with the engine's own totals, winners and the v5 scoring rule; the d-recording Medium wrapper plays exactly
// like the registry Medium; bad arguments (including 5 players and variants) are refused; --const is restored; and the Python
// simulator's all-Medium numbers (sim/out-v5-base.txt, copied below for 2 to 4 players) hold as wide z checks.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runSim, runSimThreaded } from './sim.mjs';
import { report, parsePython, crossCheckRows, measures } from './sim-report.mjs';
import { playGame } from './bots-lib.mjs';
import { CONSTANTS, deriveSeed } from '../src/engine/index.js';
import { suite } from './lib.mjs';

const { check, done } = suite('sim-check');
const run = (argv) => runSim(parseArgs(argv));
const HANDS = { 2: 3, 3: 3, 4: 4 };

// ---- determinism, termination, consistency ----
for (const argv of [
  ['--players=2', '--seats=easy', '--games=60', '--seed=7'],
  ['--players=3', '--seats=medium,high,easy', '--games=40', '--seed=7', '--jitter=10'],
  ['--players=4', '--seats=medium,naive,low,easy', '--games=40', '--seed=9'],
  ['--players=4', '--seats=medium,always,never,nothing', '--games=30', '--seed=3'],
  ['--players=3', '--seats=hard:2,medium,easy', '--games=6', '--seed=4'],
]) {
  const a = JSON.stringify(run(argv));
  const b = JSON.stringify(run(argv));
  const tag = argv.slice(0, 3).join(' ');
  check(`same seed, same JSON (${tag})`, a === b);
  const games = JSON.parse(a);
  const n = parseArgs(argv).players;
  check(`${tag}: ${HANDS[n]} hands per game`, games.every((g) => g.h.length === HANDS[n]));
  check(`${tag}: hand scores add up to the totals and the winners are the top total (then the last hand)`, games.every((g) => {
    const top = Math.max(...g.tot);
    const tied = g.tot.map((t, s) => (t === top ? s : -1)).filter((s) => s >= 0);
    const lastBest = Math.max(...tied.map((s) => g.h[g.h.length - 1].s[s]));
    const win = tied.filter((s) => g.h[g.h.length - 1].s[s] === lastBest);
    return g.tot.every((t, s) => g.h.reduce((x, h) => x + h.s[s], 0) === t)
      && JSON.stringify(win) === JSON.stringify(g.win) && JSON.stringify(tied) === JSON.stringify(g.tied) && g.tb === (g.win.length < g.tied.length);
  }));
  check(`${tag}: v5 scoring: tricks + kept Brumby values - chase cost; watchers keep no Brumby and pay nothing`, games.every((g) => g.h.every((h) => h.s.every((sc, s) => (
    sc === h.ct[s] + h.dt[s] + h.kv[s] - h.cc[s] && (h.c[s] === 'C' || (h.kv[s] === 0 && h.cc[s] === 0)))))));
  check(`${tag}: 6 climb and 6 descent tricks, rows of 6, strong counts and deals recorded`, games.every((g) => g.h.every((h) => (
    h.ct.reduce((x, y) => x + y, 0) === 6 && h.dt.reduce((x, y) => x + y, 0) === 6 && h.cs.length === 6 && h.ds.length === 6 && h.rv.length === 6
    && h.st.length === n && h.tr.length === n && h.ex.length === n && h.ld >= 0 && h.ld <= 12))));
  check(`${tag}: the Colt is +4, in the row when ck > 0, and kept only if its winner chased`, games.every((g) => g.h.every((h) => (
    (h.ck > 0) === h.rv.includes(4) && (h.ck === 0 || h.rv[h.ck - 1] === 4) && (h.ck === 0 ? h.cw === -1 : h.cke === (h.c[h.cw] === 'C' ? 1 : 0))))));
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
  const argv = ['--players=3', '--seats=medium', '--games=20', '--seed=1', '--const.CHASE_COST_BY_COUNT={"2":1,"3":1,"4":1}'];
  const g = run(argv);
  check('--const changes the rules for the run (chase cost 1 at 3p)', g.every((x) => x.h.every((h) => h.cc.every((c, s) => c === (h.c[s] === 'C' ? 1 : 0)))) && g.some((x) => x.h.some((h) => h.c.includes('C'))));
  check('--const is restored after the run', JSON.stringify(CONSTANTS) === before);
}

// ---- the d-recording wrapper plays exactly like the registry bots ----
for (const [id, n] of [['medium', 3], ['naive', 4], ['medium', 2]]) {
  const sim = run([`--players=${n}`, `--seats=${id}`, '--games=3', '--seed=11']);
  const same = sim.every((g, i) => JSON.stringify(playGame({ levels: Array(n).fill(id), seed: deriveSeed(11, 'game', i), checkView: false }).state.result.totals) === JSON.stringify(g.tot));
  check(`${id} at ${n}p: the recording wrapper gives the registry bot's totals`, same);
  check(`${id} at ${n}p: the summit gains are recorded`, sim.every((g) => g.h.every((h) => h.d && h.d.every((x) => typeof x === 'number'))));
}
{
  const easy = run(['--players=3', '--seats=easy', '--games=5', '--seed=1']);
  check('bots that do not expose d record null', easy.every((g) => g.h.every((h) => h.d === null)));
  const arch = run(['--players=4', '--seats=always,never,nothing,quick', '--games=12', '--seed=3']);
  check('the archetypes play: always chases every hand, never chases none', arch.every((g) => g.h.every((h) => h.c[g.lv.indexOf('always')] === 'C' && h.c[g.lv.indexOf('never')] === 'W')));
}

// ---- refusals ----
{
  let threw = 0;
  const bad = [['--variant.NOPE=1'], ['--seats=genius'], ['--players=5'], ['--players=1'], ['--players=4', '--seats=easy,easy'], ['--const.NOPE=1'], ['--bogus=1'], ['--games=0'], ['--jitter=101']];
  for (const b of bad) {
    try { parseArgs(b); } catch { threw++; }
  }
  check('bad variants, bots, counts (5 players included), constants and options are refused', threw === bad.length, `${threw}/${bad.length}`);
}

// ---- the Python's all-Medium numbers (sim/out-v5-base.txt, locked rules) as z checks, and the report ----
// 600 games per count against the Python's 1,000; |z| < 4 so a healthy build passes and a real rule difference does not.
const PY = `== Snowy River v5 sim: base ==
-- v5 locked: copy
                                                             2p              3p              4p              5p
   nobody chases                                            24%             12%             13%             14%
   chase rate (all seats)                                   57%             49%             32%             26%
   chase rate by descent cards 0-1/2/3/4+       9%/35%/54%/70%  6%/27%/45%/69%  5%/18%/32%/49%  3%/13%/24%/43%
   hands with the Colt in the row                           50%             50%             50%             50%
   top Home holder takes the Colt                           65%             66%             68%             68%
   one player wins 5+ climb tricks                          17%              6%              5%              3%
   tricks won by the player who led                         52%             42%             39%             31%
   link: trumps dealt v hand score                        +0.30           +0.37           +0.39           +0.42
   tied games (before tiebreak)                              5%              5%              8%              6%
   winning margin (avg pts)                                 8.6             6.0             5.4             5.0
-- end
`;
{
  const py = parsePython(PY);
  check('the Python table parser reads the labels and four columns', py.size === 10 && py.get('nobody chases')[4][0].v === 13 && py.get('chase rate by descent cards 0-1/2/3/4+')[3].length === 4 && py.get('link: trumps dealt v hand score')[3][0].v === 0.37);
  for (const n of [2, 3, 4]) {
    const games = run([`--players=${n}`, '--seats=medium', '--games=600', '--seed=21']);
    const rows = crossCheckRows(games, py, 1000).filter((r) => !r.missing && !r.descriptive);
    check(`${n}p all-Medium v the Python: ${rows.length} measures within |z| < 4`, rows.length >= 10 && rows.every((r) => Math.abs(r.z) < 4), rows.filter((r) => Math.abs(r.z) >= 4).map((r) => `${r.label} z=${r.z.toFixed(1)}`).join('; '));
  }
  const m = measures(run(['--players=4', '--seats=medium', '--games=100', '--seed=2']));
  const nobody = m.get('nobody chases').items[0]; const one = m.get('one chaser').items[0]; const two = m.get('two+ chasers').items[0];
  check('nobody + one + two-plus chasers add to 100%', Math.abs(nobody.est + one.est + two.est - 100) < 1e-9);
}
{
  const dir = mkdtempSync(join(tmpdir(), 'sim-check-'));
  try {
    const f = join(dir, 'a.json');
    const a = parseArgs(['--players=3', '--seats=medium,naive,easy', '--games=40', '--seed=1']);
    writeFileSync(f, JSON.stringify({ meta: { players: 3, seats: a.seats, rotate: true, jitter: 0, seed: 1, variants: {}, consts: {}, rules: a.rules }, games: runSim(a) }));
    const text = report([f]);
    check('report prints the bot table, seats, ties and the hand measures', /Win % \(last-hand tiebreak\)/.test(text) && /Seat \(0 = first leader\)/.test(text) && /Ties on the top total/.test(text) && /top Home holder takes the Colt/.test(text) && /chase rate by descent cards/.test(text));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

done();
