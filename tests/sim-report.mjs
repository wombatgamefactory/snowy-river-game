// sim-report.mjs - summarises sim.mjs JSON files (v5 rules). Output is plain text with pipe tables.
//
//   node tests/sim-report.mjs tests/tmp/a.json [tests/tmp/b.json ...]            summary of each file
//   node tests/sim-report.mjs tests/tmp/a.json --python=sim/out-v5-base.txt       + the cross-check against the Python table
//   node tests/sim-report.mjs tests/tmp/a.json --wins=play                        + the Python win-share cross-check for a seat mix
//       (--wins=play | play-random | policy2-always | policy2-never | policy3 | policy4)
//
// Per file: win rate by bot and by seat position (a shared win counts 1/winners; Wilson 95% interval), score mean
// and sd, winning margin, tie rates, and the hand measures the Python simulator (sim/snowy-river-sim-v5.py) prints.
//
// Definitions (all the Python's, so the two compare like for like):
//   chasers per hand      seats that chose Chase: nobody = 0, one = 1, two+ = 2 or more
//   strong descent cards  at the summit, cards in hand that are Home cards or have a descent value of 10+ (0 and 1 share a bucket)
//   close / obvious       |d| < 1 / |d| >= 3 where d = the Monte Carlo mean (chase - watch) gain a Medium-type bot computed
//   top Home holder       the seat holding the highest descent Home card among the cards STILL IN HAND at the summit
//                         (the Python's reading; not "among all cards dealt"). Colt measures use hands with the Colt in the row
//                         and a Home card in some hand.
//   trumps dealt          cards of the Escape and Home suits in the 12 dealt; extremes dealt = climb value 1-2 or 11-12
//   tied before / after   two or more on the top total / still two or more after the last-hand tiebreak (shared)
//   winning margin        best total minus second best (points)
// Standard errors treat each hand (or game, for game measures) as one cluster, so seats of one hand are not counted as
// independent. Correlations use the Fisher interval over seat-hands (slightly generous, as hands share a game).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ---------- statistics ----------
export function wilson(k, n, z = 1.96) {
  if (n <= 0) return [0, 0];
  const p = k / n; const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
export const pct = (x, d = 1) => (x * 100).toFixed(d);
export const ci = (k, n) => { if (!n) return 'n/a'; const [lo, hi] = wilson(k, n); return `${pct(k / n)} [${pct(lo)}, ${pct(hi)}]`; };
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
export const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
export const sd = (xs) => { const m = mean(xs); return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / Math.max(1, xs.length - 1)); };
export const pm = (xs, d = 2) => (xs.length ? `${mean(xs).toFixed(d)} ±${((1.96 * sd(xs)) / Math.sqrt(xs.length)).toFixed(d)}` : 'n/a');
export function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx; const dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}
export function rci(r, n) {
  if (!Number.isFinite(r) || n < 4) return 'n/a';
  const z = Math.atanh(r); const se = 1 / Math.sqrt(n - 3);
  const f = (x) => Math.tanh(x).toFixed(2);
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)} [${f(z - 1.96 * se)}, ${f(z + 1.96 * se)}]`;
}

/** Ratio estimate with cluster-robust se: clusters = [{ y, m }] (y = numerator sum, m = denominator count). */
export function ratio(clusters) {
  const G = clusters.length;
  const Y = sum(clusters.map((c) => c.y)); const M = sum(clusters.map((c) => c.m));
  if (!M || G < 2) return { est: M ? Y / M : NaN, se: NaN, m: M };
  const est = Y / M;
  const v = sum(clusters.map((c) => (c.y - est * c.m) ** 2)) * (G / (G - 1)) / (M * M);
  return { est, se: Math.sqrt(v), m: M };
}
/** Same, for a list of pre-built observations per cluster: obs = [[v, v, ...] per cluster] -> mean of all values. */
const meanOf = (perCluster) => ratio(perCluster.map((vs) => ({ y: sum(vs), m: vs.length })));
const propOf = (perCluster) => ratio(perCluster.map((vs) => ({ y: sum(vs.map(Number)), m: vs.length })));

function longest(seq) {
  let best = 0; let run = 0;
  for (let i = 0; i < seq.length; i++) { run = i && seq[i - 1] === seq[i] ? run + 1 : 1; best = Math.max(best, run); }
  return best;
}
const quantile = (xs, lo) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(lo * s.length)]; };

// ---------- the measures (Python's labels) ----------
/**
 * Hand and game measures in the Python's terms. Returns Map label -> { unit: 'pct'|'num', items: [{ name, est, se, n }] }.
 * Percent measures are in percent (0-100). `se` is null for descriptive items that are not tested.
 */
export function measures(games) {
  const n = games[0].n;
  const H = games.flatMap((g) => g.h);
  const out = new Map();
  const add = (label, unit, items) => out.set(label, { unit, items });
  const P = (name, est) => ({ name, est: est.est * 100, se: est.se * 100, n: est.m });
  const N = (name, est) => ({ name, est: est.est, se: est.se, n: est.m });

  // per hand: chasers
  const chasers = H.map((h) => [...h.c].filter((x) => x === 'C').length);
  add('nobody chases', 'pct', [P('', propOf(chasers.map((x) => [x === 0])))]);
  add('one chaser', 'pct', [P('', propOf(chasers.map((x) => [x === 1])))]);
  add('two+ chasers', 'pct', [P('', propOf(chasers.map((x) => [x >= 2])))]);

  // per seat-hand clusters (one cluster per hand)
  const seatObs = (f) => H.map((h) => [...h.c].map((_, s) => f(h, s)));
  add('chase rate (all seats)', 'pct', [P('', propOf(seatObs((h, s) => h.c[s] === 'C')))]);
  const bucketRate = (bucketOf, buckets) => buckets.map((b) => {
    const cl = H.map((h) => {
      const idx = [...h.c].map((_, s) => s).filter((s) => bucketOf(h, s) === b);
      return { y: idx.filter((s) => h.c[s] === 'C').length, m: idx.length };
    });
    return P(String(b), ratio(cl));
  });
  add('chase rate by climb tricks 0/1/2/3+', 'pct', bucketRate((h, s) => Math.min(h.ct[s], 3), [0, 1, 2, 3]));
  add('chase rate by descent cards 0-1/2/3/4+', 'pct', bucketRate((h, s) => Math.min(Math.max(h.st[s], 1), 4), [1, 2, 3, 4]));

  // close calls: per hand, the d values the bots exposed
  const dObs = H.map((h) => (h.d ? h.d.filter((x) => x !== null) : []));
  if (dObs.some((x) => x.length)) {
    add('close calls (|chase - watch| < 1 pt)', 'pct', [P('', propOf(dObs.map((v) => v.map((x) => Math.abs(x) < 1))))]);
    add('obvious (|chase - watch| >= 3 pts)', 'pct', [P('', propOf(dObs.map((v) => v.map((x) => Math.abs(x) >= 3))))]);
  }

  // chasers v watchers
  const chaserNet = H.map((h) => [...h.c].map((x, s) => (x === 'C' ? h.kv[s] - h.cc[s] : null)).filter((x) => x !== null));
  add('chaser net from row (Brumbies - cost)', 'num', [N('', meanOf(chaserNet))]);
  const scoreOf = (want) => H.map((h) => [...h.c].map((x, s) => (x === want ? h.s[s] : null)).filter((x) => x !== null));
  add('hand score: chasers v watchers', 'num', [N('chasers', meanOf(scoreOf('C'))), N('watchers', meanOf(scoreOf('W')))]);

  // the row and the Colt
  add('hands with the Colt in the row', 'pct', [P('', propOf(H.map((h) => [h.ck > 0])))]);
  const coltH = H.filter((h) => h.ck > 0);
  add("Colt's trick (avg, 1-6)", 'num', [N('', meanOf(coltH.map((h) => [h.ck])))]);
  const rowSums = H.map((h) => sum(h.rv));
  add('row value (avg / spread low-high 10%)', 'num', [
    N('mean', meanOf(rowSums.map((x) => [x]))),
    { name: 'p10', est: quantile(rowSums, 0.1), se: null, n: rowSums.length },
    { name: 'p90', est: quantile(rowSums, 0.9), se: null, n: rowSums.length },
  ]);
  add('Colt taken by a chaser', 'pct', [P('', propOf(coltH.map((h) => [h.cke === 1])))]);
  const topH = coltH.filter((h) => h.top >= 0);
  add('top Home holder chases', 'pct', [P('', propOf(topH.map((h) => [h.c[h.top] === 'C'])))]);
  add("top Home holder wins the Colt's trick", 'pct', [P('', propOf(topH.map((h) => [h.cw === h.top])))]);
  add('top Home holder takes the Colt', 'pct', [P('', propOf(topH.map((h) => [h.cw === h.top && h.c[h.top] === 'C'])))]);

  // runs and who leads
  add('longest run of wins in a hand (avg)', 'num', [N('', meanOf(H.map((h) => [longest(h.cs + h.ds)])))]);
  add('a 5+ run on the climb (of 6)', 'pct', [P('', propOf(H.map((h) => [longest(h.cs) >= 5])))]);
  add('a 5+ run on the descent (of 6)', 'pct', [P('', propOf(H.map((h) => [longest(h.ds) >= 5])))]);
  add('one player wins 5+ climb tricks', 'pct', [P('', propOf(H.map((h) => [Math.max(...h.ct) >= 5])))]);
  add('most climb tricks by one player (avg)', 'num', [N('', meanOf(H.map((h) => [Math.max(...h.ct)])))]);
  add('tricks won by the player who led', 'pct', [P('', ratio(H.map((h) => ({ y: h.ld, m: 12 }))))]);

  // luck links: Pearson r over every seat of every hand
  const link = (key) => {
    const xs = []; const ys = [];
    for (const h of H) for (let s = 0; s < n; s++) { xs.push(h[key][s]); ys.push(h.s[s]); }
    const r = pearson(xs, ys);
    return { name: '', est: r, se: (1 - r * r) / Math.sqrt(xs.length - 3), n: xs.length };
  };
  add('link: trumps dealt v hand score', 'num', [link('tr')]);
  add('link: extremes dealt v hand score', 'num', [link('ex')]);

  // game measures
  add('tied games (before tiebreak)', 'pct', [P('', propOf(games.map((g) => [g.tied.length > 1])))]);
  add('tied games (after last-hand tiebreak)', 'pct', [P('', propOf(games.map((g) => [g.win.length > 1])))]);
  add('winning margin (avg pts)', 'num', [N('', meanOf(games.map((g) => { const t = [...g.tot].sort((a, b) => b - a); return [t[0] - t[1]]; })))]);
  return out;
}

// ---------- the Python's printed table ----------
/** Parses one block of a sim/out-v5-*.txt file (the block whose header line starts with `header`): label -> { 2: [..], 3: [..], 4: [..] } with the decimals each token had. */
export function parsePython(text, header = '-- v5 locked') {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(header));
  if (start < 0) throw new Error(`Python block "${header}" not found`);
  const table = new Map();
  for (let i = start + 2; i < lines.length && !lines[i].startsWith('--'); i++) {
    const m = /^\s*(.+?)\s{2,}(.*)$/.exec(lines[i]);
    if (!m) continue;
    const toks = m[2].match(/[-+]?\d+(?:\.\d+)?%?/g) || [];
    if (toks.length % 4 !== 0 || !toks.length) continue; // 4 columns (2p..5p)
    const k = toks.length / 4;
    const col = (c) => toks.slice(c * k, (c + 1) * k).map((t) => ({ v: Number.parseFloat(t), half: t.endsWith('%') ? 0.5 : 0.5 * 10 ** -((t.split('.')[1] || '').replace('%', '').length) }));
    table.set(m[1].trim(), { 2: col(0), 3: col(1), 4: col(2), 5: col(3) });
  }
  return table;
}

/**
 * Cross-check: JS measures against the Python's printed numbers. The Python's own sampling error is taken as the JS
 * error scaled to its game count (`pyGames`, default 1,000), its rounding as uniform. |z| < 1.96 = "within CI".
 */
export function crossCheckRows(games, pyTable, pyGames = 1000) {
  const n = games[0].n;
  const mine = measures(games);
  const rows = [];
  for (const [label, m] of mine) {
    const ref = pyTable.get(label);
    if (!ref || !ref[n]) { rows.push({ label, n, missing: true }); continue; }
    m.items.forEach((it, i) => {
      const py = ref[n][i];
      if (!py) return;
      const name = it.name ? `${label} [${it.name}]` : label;
      if (it.se === null || !Number.isFinite(it.se)) { rows.push({ label: name, js: it.est, py: py.v, z: null, descriptive: true, unit: m.unit }); return; }
      const sePy = it.se * Math.sqrt(games.length / pyGames);
      const rnd = py.half / Math.sqrt(3);
      const se = Math.sqrt(it.se ** 2 + sePy ** 2 + rnd ** 2);
      const z = (it.est - py.v) / se;
      rows.push({ label: name, js: it.est, jsSe: it.se, py: py.v, z, unit: m.unit, ok: Math.abs(z) < 1.96 });
    });
  }
  return rows;
}

const f2 = (x, unit) => (unit === 'pct' ? `${x.toFixed(1)}%` : x.toFixed(2));
export function crossCheckText(games, pyTable, pyGames = 1000) {
  const rows = crossCheckRows(games, pyTable, pyGames);
  const out = [`Cross-check against the Python table, ${games[0].n} players, ${games.length} JS games v ${pyGames} Python games`, '', '| Measure | JS (95% CI) | Python | z | Verdict |', '|---|---|---|---|---|'];
  for (const r of rows) {
    if (r.missing) { out.push(`| ${r.label} | n/a | not in the Python table | | not compared |`); continue; }
    if (r.descriptive) { out.push(`| ${r.label} | ${f2(r.js, r.unit)} | ${f2(r.py, r.unit)} | | descriptive |`); continue; }
    const ci95 = 1.96 * r.jsSe;
    out.push(`| ${r.label} | ${f2(r.js, r.unit)} ±${r.unit === 'pct' ? ci95.toFixed(1) : ci95.toFixed(2)} | ${f2(r.py, r.unit)} | ${r.z >= 0 ? '+' : ''}${r.z.toFixed(1)} | ${r.ok ? 'within CI' : 'DIFFERS'} |`);
  }
  const tested = rows.filter((r) => r.z !== null && r.z !== undefined && !r.missing && !r.descriptive);
  out.push('', `${tested.filter((r) => r.ok).length} of ${tested.length} compared items within CI (about 5% would miss by chance alone).`);
  return out.join('\n');
}

// ---------- win rates ----------
/** Per bot id: seat appearances, credit (shared win = 1/winners), per-game clusters for the CI. */
export function winsByBot(games) {
  const by = new Map();
  games.forEach((g, gi) => {
    g.lv.forEach((id, s) => {
      const e = by.get(id) || { seats: 0, credit: 0, clusters: new Map() };
      const c = g.win.includes(s) ? 1 / g.win.length : 0;
      e.seats++; e.credit += c;
      const cl = e.clusters.get(gi) || { y: 0, m: 0 };
      cl.y += c; cl.m += 1; e.clusters.set(gi, cl);
      by.set(id, e);
    });
  });
  const res = new Map();
  for (const [id, e] of by) {
    const r = ratio([...e.clusters.values()]);
    res.set(id, { id, seats: e.seats, share: e.credit / e.seats, se: r.se, credit: e.credit, games: e.clusters.size });
  }
  return res;
}
const shareText = (x, se) => `${pct(x)} ±${pct(1.96 * se)}`;

/** Win share by bot id, no tiebreak (ties on the top total shared) and with the tiebreak. */
function winTable(games) {
  const n = games[0].n;
  const withTb = winsByBot(games);
  const noTb = winsByBot(games.map((g) => ({ ...g, win: g.tied })));
  const lines = ['| Bot | Seats | Win % (last-hand tiebreak) | Win % (ties shared) | Fair share |', '|---|---|---|---|---|'];
  for (const [id, e] of withTb) lines.push(`| ${id} | ${e.seats} | ${shareText(e.share, e.se)} | ${shareText(noTb.get(id).share, noTb.get(id).se)} | ${pct(1 / n)} |`);
  return lines.join('\n');
}

/** Win share by seat position, 0 = the first leader (left of the first dealer). */
function seatTable(games) {
  const n = games[0].n;
  const credit = Array(n).fill(0);
  for (const g of games) for (const w of g.win) credit[(w - g.fd - 1 + 2 * n) % n] += 1 / g.win.length;
  const lines = ['| Seat (0 = first leader) | Win % |', '|---|---|'];
  credit.forEach((c, p) => lines.push(`| ${p} | ${ci(c, games.length)} |`));
  return lines.join('\n');
}

/** Python win shares by seat mix, from sim/out-v5-policy.txt and out-v5-play.txt (800 games per line). */
export const PY_WINS = {
  play: { seats: (n) => ['medium', ...Array(n - 1).fill('naive')], py: { 2: { medium: 55, naive: 45 }, 3: { medium: 57, naive: 22 }, 4: { medium: 66, naive: 11 } } },
  'play-random': { seats: (n) => ['medium', ...Array(n - 1).fill('naive-random')], py: { 2: { medium: 58, 'naive-random': 42 }, 3: { medium: 61, 'naive-random': 20 }, 4: { medium: 75, 'naive-random': 8 } } },
  'policy2-always': { seats: () => ['medium', 'always'], py: { 2: { medium: 60, always: 40 } } },
  'policy2-never': { seats: () => ['medium', 'never'], py: { 2: { medium: 62, never: 38 } } },
  policy3: { seats: () => ['medium', 'always', 'never'], py: { 3: { medium: 48, always: 30, never: 23 } } },
  policy4: { seats: () => ['medium', 'always', 'never', 'nothing'], py: { 4: { medium: 37, always: 23, never: 20, nothing: 20 } } },
};
export function winsCrossCheckText(games, mix, pyGames = 800) {
  const n = games[0].n;
  const ref = PY_WINS[mix];
  if (!ref || !ref.py[n]) return `No Python win-share line for "${mix}" at ${n} players`;
  const mine = winsByBot(games);
  const lines = [`Win-share cross-check, ${mix}, ${n} players (${games.length} JS games v ${pyGames} Python games)`, '', '| Bot | JS win % (95% CI) | Python | z | Verdict |', '|---|---|---|---|---|'];
  for (const [id, py] of Object.entries(ref.py[n])) {
    const e = mine.get(id);
    const se = Math.sqrt(e.se ** 2 + (e.se * Math.sqrt(games.length / pyGames)) ** 2 + (0.5 / 100 / Math.sqrt(3)) ** 2);
    const z = (e.share - py / 100) / se;
    lines.push(`| ${id} | ${shareText(e.share, e.se)} | ${py} | ${z >= 0 ? '+' : ''}${z.toFixed(1)} | ${Math.abs(z) < 1.96 ? 'within CI' : 'DIFFERS'} |`);
  }
  return lines.join('\n');
}

// ---------- summary ----------
export function report(files, opts = {}) {
  const out = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    const games = data.games; const n = data.meta.players;
    const totals = games.flatMap((g) => g.tot.map((t, s) => ({ t, lv: g.lv[s] })));
    out.push(`## ${f}`, `${games.length} games, ${n} players, seats ${data.meta.seats.join(', ')}${data.meta.rotate ? ' (rotating)' : ' (fixed)'}, seed ${data.meta.seed}, jitter ${data.meta.jitter}`, '');
    out.push(winTable(games), '', seatTable(games), '');
    const levels = [...new Set(games.flatMap((g) => g.lv))];
    out.push('| Bot | Game total (mean ±CI) | sd | Hand score (mean) |', '|---|---|---|---|');
    for (const lv of levels) {
      const ts = totals.filter((x) => x.lv === lv).map((x) => x.t);
      const hs = games.flatMap((g) => g.h.flatMap((h) => h.s.filter((_, s) => g.lv[s] === lv)));
      out.push(`| ${lv} | ${pm(ts)} | ${sd(ts).toFixed(2)} | ${mean(hs).toFixed(2)} |`);
    }
    out.push('');
    const ties = games.filter((g) => g.tied.length > 1).length;
    const tbSplit = games.filter((g) => g.tied.length > 1 && g.win.length < g.tied.length).length;
    const shared = games.filter((g) => g.win.length > 1).length;
    out.push(`Ties on the top total ${ci(ties, games.length)}%; of those the last-hand tiebreak separates ${tbSplit} of ${ties}; still shared ${ci(shared, games.length)}%.`);
    const margins = games.map((g) => { const t = [...g.tot].sort((a, b) => b - a); return t[0] - t[1]; });
    out.push(`Winning margin ${pm(margins)} points; winning score ${pm(games.map((g) => Math.max(...g.tot)))}; hand score sd ${sd(games.flatMap((g) => g.h.flatMap((h) => h.s))).toFixed(2)}.`, '');
    const m = measures(games);
    out.push('| Hand measure | Value (95% CI) |', '|---|---|');
    for (const [label, e] of m) {
      const cells = e.items.map((it) => {
        const v = e.unit === 'pct' ? `${it.est.toFixed(1)}%` : (Number.isInteger(it.est) ? String(it.est) : it.est.toFixed(2));
        return it.se === null || !Number.isFinite(it.se) ? v : `${v} ±${e.unit === 'pct' ? (1.96 * it.se).toFixed(1) : (1.96 * it.se).toFixed(2)}`;
      });
      out.push(`| ${label} | ${cells.join(' / ')} |`);
    }
    out.push('');
    if (opts.python) out.push(crossCheckText(games, parsePython(readFileSync(opts.python, 'utf8')), opts.pyGames || 1000), '');
    if (opts.wins) out.push(winsCrossCheckText(games, opts.wins), '');
  }
  return out.join('\n');
}

// ---------- main ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const opt = (k) => (process.argv.find((x) => x.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null;
  if (!files.length) { console.error('usage: node tests/sim-report.mjs a.json [b.json ...] [--python=sim/out-v5-base.txt] [--wins=play]'); process.exit(2); }
  console.log(report(files, { python: opt('python'), wins: opt('wins') }));
}
