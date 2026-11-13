// sim-check.mjs - the v6 simulator is deterministic and its records are consistent (a few seconds).
// Same seed twice gives identical JSON (also across worker threads); every game plays the right number of hands and the
// records agree with the engine's own totals, winners and the v6 scoring rule (Climb cards + Brumby cards); the Climb row
// is five +1 and one -1; the sim plays exactly like the registry bots; bad arguments (6 players, variants) are refused;
// --const is restored; and the Python simulator's all-Medium numbers (sim/out-v6-base.txt, copied below for 2 to 5 players)
// hold as wide z checks.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runSim, runSimThreaded } from './sim.mjs';
import { report, parsePython, crossCheckRows, measures, extraMeasures } from './sim-report.mjs';
import { playGame } from './bots-lib.mjs';
import { CONSTANTS, deriveSeed } from '../src/engine/index.js';
import { suite } from './lib.mjs';

const { check, done } = suite('sim-check');
const run = (argv) => runSim(parseArgs(argv));
const HANDS = { 2: 3, 3: 3, 4: 4, 5: 5 };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ---- determinism, termination, consistency ----
for (const argv of [
  ['--players=2', '--seats=easy', '--games=60', '--seed=7'],
  ['--players=3', '--seats=medium,high,easy', '--games=40', '--seed=7', '--jitter=10'],
  ['--players=4', '--seats=medium,naive,low,easy', '--games=40', '--seed=9'],
  ['--players=5', '--seats=medium', '--games=40', '--seed=3'],
  ['--players=5', '--seats=medium-dealorder,medium,naive,easy,low', '--games=20', '--seed=8'],
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
  check(`${tag}: v6 scoring: a hand score is the Climb cards plus the Brumby cards taken (tricks score nothing)`, games.every((g) => g.h.every((h) => h.s.every((sc, s) => sc === h.cv[s] + h.bv[s]))));
  check(`${tag}: 6 climb and 6 descent tricks, rows of 6, deals recorded`, games.every((g) => g.h.every((h) => (
    sum(h.ct) === 6 && sum(h.dt) === 6 && h.cs.length === 6 && h.ds.length === 6 && h.cl.length === 6 && h.cn.length === 6 && h.rv.length === 6 && h.cr.length === 6
    && h.tr.length === n && h.ex.length === n && h.ld >= 0 && h.ld <= 12))));
  check(`${tag}: the Climb row is five +1 and one -1; its -1 sits at mp and goes to that trick's winner; the row is worth 4 to the table`, games.every((g) => g.h.every((h) => (
    h.cr.filter((v) => v === 1).length === 5 && h.cr.filter((v) => v === -1).length === 1 && h.cr[h.mp - 1] === -1
    && h.mw === Number(h.cs[h.mp - 1]) && h.ml === Number(h.cl[h.mp - 1]) && sum(h.cv) === 4))));
  check(`${tag}: Brumby points taken add up to the row; the Colt is +4, in the row when ck > 0, and goes to that trick's winner`, games.every((g) => g.h.every((h) => (
    sum(h.bv) === sum(h.rv) && (h.ck > 0) === h.rv.includes(4) && (h.ck === 0 ? h.cw === -1 : h.rv[h.ck - 1] === 4 && h.cw === Number(h.ds[h.ck - 1]))))));
  check(`${tag}: trick counts match the winner strings and the Home 1 is dealt to someone at 4-5 players`, games.every((g) => g.h.every((h) => (
    h.ct.every((c, s) => c === [...h.cs].filter((w) => Number(w) === s).length) && h.dt.every((c, s) => c === [...h.ds].filter((w) => Number(w) === s).length)
    && (n < 4 || h.h1 >= 0)))));
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
  const argv = ['--players=2', '--seats=medium', '--games=20', '--seed=1', '--const.HANDS_PER_GAME={"2":2,"3":3,"4":4,"5":5}'];
  const g = run(argv);
  check('--const changes the rules for the run (2 hands at 2p)', g.every((x) => x.h.length === 2));
  check('--const is restored after the run', JSON.stringify(CONSTANTS) === before);
}

// ---- the sim plays exactly like the registry bots ----
for (const [id, n] of [['medium', 3], ['naive', 4], ['medium', 5], ['medium', 2]]) {
  const sim = run([`--players=${n}`, `--seats=${id}`, '--games=3', '--seed=11']);
  const same = sim.every((g, i) => JSON.stringify(playGame({ levels: Array(n).fill(id), seed: deriveSeed(11, 'game', i), checkView: false }).state.result.totals) === JSON.stringify(g.tot));
  check(`${id} at ${n}p: the simulator gives the registry bot's totals`, same);
}

// ---- refusals ----
{
  let threw = 0;
  const bad = [['--variant.NOPE=1'], ['--seats=genius'], ['--players=6'], ['--players=1'], ['--players=4', '--seats=easy,easy'], ['--const.NOPE=1'], ['--bogus=1'], ['--games=0'], ['--jitter=101']];
  for (const b of bad) {
    try { parseArgs(b); } catch { threw++; }
  }
  check('bad variants, bots, counts (6 players included), constants and options are refused', threw === bad.length, `${threw}/${bad.length}`);
  check('5 players is accepted', parseArgs(['--players=5']).players === 5);
}

// ---- the Python's all-Medium numbers (sim/out-v6-base.txt, "v6: cards only") as z checks, and the report ----
// 600 games per count against the Python's 1,000; |z| < 4 so a healthy build passes and a real rule difference does not.
const PY = `== Snowy River v6 sim: base ==
-- v6: cards only (copy of sim/out-v6-base.txt)
                                                             2p              3p              4p              5p
   hand score: chasers v watchers                     5.0 v nan       3.4 v nan       2.5 v nan       2.0 v nan
   hands with the Colt in the row                           50%             50%             50%             51%
   top Home holder takes the Colt                           72%             71%             69%             69%
   one player wins 5+ climb tricks                          19%              6%              3%              2%
   tricks won by the player who led                         53%             40%             35%             28%
   link: trumps dealt v hand score                        +0.24           +0.30           +0.33           +0.35
   tied games (before tiebreak)                              4%              6%              8%              8%
   winning margin (avg pts)                                 7.7             5.4             5.0             4.7
   best minus worst score in a hand (avg)                   4.6             5.8             6.2             6.3
-- end
`;
{
  const py = parsePython(PY);
  check('the Python table parser reads the labels and four columns', py.size === 9 && py.get('hands with the Colt in the row')[4][0].v === 50 && py.get('link: trumps dealt v hand score')[5][0].v === 0.35 && py.get('hand score: chasers v watchers')[3][0].v === 3.4);
  for (const n of [2, 3, 4, 5]) {
    const games = run([`--players=${n}`, '--seats=medium', '--games=600', '--seed=21']);
    const rows = crossCheckRows(games, py, 1000).filter((r) => !r.missing && !r.descriptive);
    check(`${n}p all-Medium v the Python: ${rows.length} measures within |z| < 4`, rows.length >= 9 && rows.every((r) => Math.abs(r.z) < 4), rows.filter((r) => Math.abs(r.z) >= 4).map((r) => `${r.label} z=${r.z.toFixed(1)}`).join('; '));
  }
  const m = measures(run(['--players=4', '--seats=medium', '--games=100', '--seed=2']));
  check('the Climb and Brumby points per seat add up to the hand score (4 + the row, shared by 4)', Math.abs(m.get('hand score (mean per seat)').items[0].est - (m.get('Climb points per seat (mean)').items[0].est + m.get('Brumby points per seat (mean)').items[0].est)) < 1e-9);
  const x = extraMeasures(run(['--players=3', '--seats=medium', '--games=100', '--seed=2']));
  check('the -1 card sits at each climb trick about equally and its seat shares add up', x.get('-1 card: at climb trick 1 / 2 / 3 / 4 / 5 / 6').items.reduce((a, it) => a + it.est, 0) > 99.999);
}
{
  const dir = mkdtempSync(join(tmpdir(), 'sim-check-'));
  try {
    const f = join(dir, 'a.json');
    const a = parseArgs(['--players=3', '--seats=medium,naive,easy', '--games=40', '--seed=1']);
    writeFileSync(f, JSON.stringify({ meta: { players: 3, seats: a.seats, rotate: true, jitter: 0, seed: 1, variants: {}, consts: {}, rules: a.rules }, games: runSim(a) }));
    const text = report([f]);
    check('report prints the bot table, seats, ties, the hand measures and the v6 measures', /Win % \(last-hand tiebreak\)/.test(text) && /Seat \(0 = first leader\)/.test(text) && /Ties on the top total/.test(text) && /top Home holder takes the Colt/.test(text) && /-1 card: taken by the seat that led that trick/.test(text) && /Home 1 holder \(dealt\) takes the Colt/.test(text));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

done();
