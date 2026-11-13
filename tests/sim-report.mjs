// sim-report.mjs - summarises sim.mjs JSON files (v6 rules). Output is plain text with pipe tables.
//
//   node tests/sim-report.mjs tests/tmp/a.json [tests/tmp/b.json ...]                 summary of each file
//   node tests/sim-report.mjs tests/tmp/a.json --python=sim/out-v6-base.txt            + the cross-check against the Python's printed table
//   node tests/sim-report.mjs tests/tmp/a.json --pyjson=tests/tmp/bal3/py-v6-4000.json + the cross-check against a larger Python re-run (full precision)
//   node tests/sim-report.mjs tests/tmp/a.json --wins=play --pyjson=...                + the win-share cross-check (naive card play v Medium)
//
// Per file: win rate by bot and by seat position (a shared win counts 1/winners; Wilson 95% interval), score mean
// and sd, winning margin, tie rates, the hand measures the Python simulator (sim/snowy-river-sim-v6.py) prints, and
// the v6-only measures the Python does not print (the -1 Climb card, the dealt Home 1, trump luck by bucket).
//
// Definitions (the Python's where it has one, so the two compare like for like):
//   top Home holder       the seat holding the lowest-numbered Home card among the cards STILL IN HAND at the summit
//                         (the Python's reading; Colt measures use hands with the Colt in the row
//                         and a Home card in some hand)
//   Home 1 holder         the seat DEALT home-1 (null at 2-3 players when it is out unseen)
//   trumps dealt          cards of the Escape and Home suits in the 12 dealt; extremes dealt = number 1-2 or 11-12
//   climb leader          the seat with the most climb tricks before the trick in question (only when one seat leads)
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

/** The seat that has won most of the first `upTo` climb tricks (winners string `cs`), or -1 when none or tied for most. */
function climbLeaderBefore(cs, upTo) {
  const c = new Map();
  for (let i = 0; i < upTo; i++) c.set(cs[i], (c.get(cs[i]) || 0) + 1);
  let best = 0; let who = -1; let tie = false;
  for (const [s, k] of c) { if (k > best) { best = k; who = Number(s); tie = false; } else if (k === best) tie = true; }
  return tie ? -1 : who;
}

// ---------- the measures (Python's labels where it prints one) ----------
/** Python's printed label for a JS measure whose label differs. */
const PY_LABEL = {
  'hand score (mean per seat)': 'hand score: chasers v watchers',
  'Brumby points per seat (mean)': 'chaser net from row (Brumbies - cost)',
  'link: climb tricks v Brumby points (same hand)': 'link: climb cards v Brumby points (same hand)',
};

/**
 * Hand and game measures. Returns Map label -> { unit: 'pct'|'num', items: [{ name, est, se, n }] }.
 * Percent measures are in percent (0-100). `se` is null for descriptive items that are not tested.
 */
export function measures(games) {
  const n = games[0].n;
  const H = games.flatMap((g) => g.h);
  const out = new Map();
  const add = (label, unit, items) => out.set(label, { unit, items });
  const P = (name, est) => ({ name, est: est.est * 100, se: est.se * 100, n: est.m });
  const N = (name, est) => ({ name, est: est.est, se: est.se, n: est.m });

  // scores
  add('hand score (mean per seat)', 'num', [N('', meanOf(H.map((h) => h.s)))]);
  add('Brumby points per seat (mean)', 'num', [N('', meanOf(H.map((h) => h.bv)))]);
  add('Climb points per seat (mean)', 'num', [N('', meanOf(H.map((h) => h.cv)))]);
  add('hand score sd (all seat-hands)', 'num', [{ name: '', est: sd(H.flatMap((h) => h.s)), se: null, n: H.length * n }]);
  add('seat-hands finishing below zero', 'pct', [P('', propOf(H.map((h) => h.s.map((x) => x < 0))))]);
  add('best minus worst score in a hand (avg)', 'num', [N('', meanOf(H.map((h) => [Math.max(...h.s) - Math.min(...h.s)])))]);
  const linkPairs = (a, b) => {
    const xs = []; const ys = [];
    for (const h of H) for (let s = 0; s < n; s++) { xs.push(h[a][s]); ys.push(h[b][s]); }
    const r = pearson(xs, ys);
    return { name: '', est: r, se: (1 - r * r) / Math.sqrt(xs.length - 3), n: xs.length };
  };
  add('link: climb tricks v Brumby points (same hand)', 'num', [linkPairs('ct', 'bv')]);

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
  const topH = coltH.filter((h) => h.top >= 0);
  add("top Home holder wins the Colt's trick", 'pct', [P('', propOf(topH.map((h) => [h.cw === h.top])))]);
  add('top Home holder takes the Colt', 'pct', [P('', propOf(topH.map((h) => [h.cw === h.top])))]);

  // runs and who leads
  add('longest run of wins in a hand (avg)', 'num', [N('', meanOf(H.map((h) => [longest(h.cs + h.ds)])))]);
  add('a 5+ run on the climb (of 6)', 'pct', [P('', propOf(H.map((h) => [longest(h.cs) >= 5])))]);
  add('a 5+ run on the descent (of 6)', 'pct', [P('', propOf(H.map((h) => [longest(h.ds) >= 5])))]);
  add('one player wins 5+ climb tricks', 'pct', [P('', propOf(H.map((h) => [Math.max(...h.ct) >= 5])))]);
  add('most climb tricks by one player (avg)', 'num', [N('', meanOf(H.map((h) => [Math.max(...h.ct)])))]);
  add('tricks won by the player who led', 'pct', [P('', ratio(H.map((h) => ({ y: h.ld, m: 12 }))))]);

  // luck links: Pearson r over every seat of every hand
  add('link: trumps dealt v hand score', 'num', [linkPairs('tr', 's')]);
  add('link: extremes dealt v hand score', 'num', [linkPairs('ex', 's')]);

  // game measures
  add('tied games (before tiebreak)', 'pct', [P('', propOf(games.map((g) => [g.tied.length > 1])))]);
  add('tied games (after last-hand tiebreak)', 'pct', [P('', propOf(games.map((g) => [g.win.length > 1])))]);
  add('winning margin (avg pts)', 'num', [N('', meanOf(games.map((g) => { const t = [...g.tot].sort((a, b) => b - a); return [t[0] - t[1]]; })))]);
  return out;
}

/** The v6-only measures (no Python line to compare with): the -1 Climb card, the dealt Home 1, trump luck by bucket. */
export function extraMeasures(games) {
  const n = games[0].n;
  const H = games.flatMap((g) => g.h);
  const out = new Map();
  const add = (label, unit, items) => out.set(label, { unit, items });
  const P = (name, est) => ({ name, est: est.est * 100, se: est.se * 100, n: est.m });
  const N = (name, est) => ({ name, est: est.est, se: est.se, n: est.m });

  // the -1 Climb card (position mp, 1..6)
  const minusTrick = (h) => h.mp - 1;
  add('-1 card: at climb trick 1 / 2 / 3 / 4 / 5 / 6', 'pct', [1, 2, 3, 4, 5, 6].map((p) => P(String(p), propOf(H.map((h) => [h.mp === p])))));
  add('-1 card: taken by the seat that led that trick', 'pct', [P('', propOf(H.map((h) => [h.mw === h.ml])))]);
  add('+1 cards: taken by the seat that led that trick', 'pct', [P('', propOf(H.map((h) => [...h.cl].map((l, i) => i !== minusTrick(h) && h.cs[i] === l))))]);
  const withLeader = H.filter((h) => h.mp >= 2 && climbLeaderBefore(h.cs, h.mp - 1) >= 0);
  add('-1 card: taken by the climb leader so far', 'pct', [P('', propOf(withLeader.map((h) => [h.mw === climbLeaderBefore(h.cs, h.mp - 1)])))]);
  add('+1 cards: taken by the climb leader so far', 'pct', [P('', propOf(H.map((h) => {
    const r = [];
    for (let i = 1; i < 6; i++) {
      if (i === minusTrick(h)) continue;
      const l = climbLeaderBefore(h.cs, i);
      if (l >= 0) r.push(h.cs[i] === String(l));
    }
    return r;
  })))]);
  add('-1 card: its trick won with a trump', 'pct', [P('', propOf(H.map((h) => [h.mt === 1])))]);
  add('+1 cards: their tricks won with a trump', 'pct', [P('', propOf(H.map((h) => [...h.ctr].filter((_, i) => i !== minusTrick(h)).map((c) => c === '1'))))]);
  add('-1 trick: number on the winning card (avg)', 'num', [N('', meanOf(H.map((h) => [h.mn])))]);
  add('+1 tricks: number on the winning card (avg)', 'num', [N('', meanOf(H.map((h) => h.cn.filter((_, i) => i !== minusTrick(h)))))]);
  add('-1 taker: hand score (avg)', 'num', [N('', meanOf(H.map((h) => [h.s[h.mw]])))]);
  add('-1 taker: hand score minus the hand average', 'num', [N('', meanOf(H.map((h) => [h.s[h.mw] - mean(h.s)])))]);
  add('-1 taker: finishes the hand with the lowest score (alone)', 'pct', [P('', propOf(H.map((h) => { const lo = Math.min(...h.s); return [h.s[h.mw] === lo && h.s.filter((x) => x === lo).length === 1]; })))]);
  add('-1 taker: also wins 3+ climb tricks', 'pct', [P('', propOf(H.map((h) => [h.ct[h.mw] >= 3])))]);

  // the Colt and the dealt Home 1
  const colt = H.filter((h) => h.ck > 0);
  const colt1 = colt.filter((h) => h.h1 >= 0);
  add('Colt hands where the Home 1 was dealt to someone', 'pct', [P('', propOf(colt.map((h) => [h.h1 >= 0])))]);
  add('Home 1 holder (dealt) takes the Colt', 'pct', [P('', propOf(colt1.map((h) => [h.cw === h.h1])))]);
  add('Home 1 holder (dealt) is still the top Home at the summit', 'pct', [P('', propOf(colt1.map((h) => [h.top === h.h1])))]);
  add('Colt goes to a seat that is neither the top Home holder nor the dealt Home 1 holder', 'pct', [P('', propOf(colt1.map((h) => [h.cw !== h.top && h.cw !== h.h1])))]);

  // trump luck by bucket
  const bucket = (t) => (t <= 4 ? 0 : t <= 6 ? 1 : t <= 8 ? 2 : 3);
  add('hand score by trump cards dealt (<=4 / 5-6 / 7-8 / 9+)', 'num', [0, 1, 2, 3].map((b) => N(['<=4', '5-6', '7-8', '9+'][b], ratio(H.map((h) => {
    const idx = h.tr.map((t, s) => (bucket(t) === b ? s : -1)).filter((s) => s >= 0);
    return { y: sum(idx.map((s) => h.s[s])), m: idx.length };
  })))));
  add('seat-hands in each trump bucket', 'pct', [0, 1, 2, 3].map((b) => P(['<=4', '5-6', '7-8', '9+'][b], propOf(H.map((h) => h.tr.map((t) => bucket(t) === b))))));
  // the game: the player dealt the most trumps over the whole game (alone)
  const topTr = [];
  for (const g of games) {
    const tot = Array(n).fill(0);
    for (const h of g.h) h.tr.forEach((t, s) => { tot[s] += t; });
    const mx = Math.max(...tot);
    const who = tot.map((t, s) => (t === mx ? s : -1)).filter((s) => s >= 0);
    if (who.length === 1) topTr.push([g.win.includes(who[0]) ? 1 / g.win.length : 0]);
  }
  add('player dealt the most trumps over the game: wins', 'pct', [P('', propOf(topTr))]);
  add('(fair share of a win)', 'pct', [{ name: '', est: 100 / n, se: null, n: 0 }]);
  return out;
}

// ---------- the Python's printed table ----------
/** Parses one block of a sim/out-v6-*.txt file (the block whose header line starts with `header`): label -> { 2: [..], 3: [..], 4: [..], 5: [..] } with the decimals each token had. */
export function parsePython(text, header = '-- v6: cards only') {
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

/** A full-precision Python re-run (JSON from a re-run of the reference simulator) as the same table shape; no rounding. */
export function pythonFromJson(obj) {
  const table = new Map();
  for (const [label, byN] of Object.entries(obj.measures)) {
    const row = {};
    for (const [n, vals] of Object.entries(byN)) row[n] = vals.map((v) => ({ v, half: 0 }));
    table.set(label, row);
  }
  return table;
}

/**
 * Cross-check: JS measures against the Python's numbers. The Python's own sampling error is taken as the JS
 * error scaled to its game count (`pyGames`), its rounding as uniform. |z| < 1.96 = "within CI".
 */
export function crossCheckRows(games, pyTable, pyGames = 1000) {
  const n = games[0].n;
  const mine = measures(games);
  const rows = [];
  for (const [label, m] of mine) {
    const ref = pyTable.get(PY_LABEL[label] || label);
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
export function crossCheckText(games, pyTable, pyGames = 1000, what = 'the Python table') {
  const rows = crossCheckRows(games, pyTable, pyGames);
  const out = [`Cross-check against ${what}, ${games[0].n} players, ${games.length} JS games v ${pyGames} Python games`, '', '| Measure | JS (95% CI) | Python | z | Verdict |', '|---|---|---|---|---|'];
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

/**
 * The Python's win shares for Medium v naive card play (sim/out-v6-play.txt, "v6: cards only", 1,000 games per count, the
 * smart seat first). The Python's labels are "<card play>/<summit>": smart/smart is Medium, naive/smart is naive.
 */
export const PY_WINS = {
  play: { seats: (n) => ['medium', ...Array(n - 1).fill('naive')], py: { 2: { medium: 63, naive: 37 }, 3: { medium: 59, naive: 20 }, 4: { medium: 69, naive: 10 }, 5: { medium: 66, naive: 9 } } },
};
/**
 * Win-share cross-check. `pyShares` (optional, from a Python re-run JSON `.wins.play[n]` = { medium, naive }) replaces the printed
 * whole-percent numbers; `pyGames` is the Python's game count.
 */
export function winsCrossCheckText(games, mix, pyGames = 1000, pyShares = null) {
  const n = games[0].n;
  const ref = PY_WINS[mix];
  if (!ref || !ref.py[n]) return `No Python win-share line for "${mix}" at ${n} players`;
  const mine = winsByBot(games);
  const lines = [`Win-share cross-check, ${mix}, ${n} players (${games.length} JS games v ${pyGames} Python games)`, '', '| Bot | JS win % (95% CI) | Python | z | Verdict |', '|---|---|---|---|---|'];
  for (const [id, py0] of Object.entries(ref.py[n])) {
    const e = mine.get(id);
    const py = pyShares ? pyShares[id] * 100 : py0;
    const rnd = pyShares ? 0 : 0.5 / 100 / Math.sqrt(3);
    const se = Math.sqrt(e.se ** 2 + (e.se * Math.sqrt(games.length / pyGames)) ** 2 + rnd ** 2);
    const z = (e.share - py / 100) / se;
    lines.push(`| ${id} | ${shareText(e.share, e.se)} | ${pyShares ? py.toFixed(1) : py} | ${z >= 0 ? '+' : ''}${z.toFixed(1)} | ${Math.abs(z) < 1.96 ? 'within CI' : 'DIFFERS'} |`);
  }
  return lines.join('\n');
}

// ---------- summary ----------
const fmtItems = (e) => e.items.map((it) => {
  const v = e.unit === 'pct' ? `${it.est.toFixed(1)}%` : (Number.isInteger(it.est) && it.se === null ? String(it.est) : it.est.toFixed(2));
  return it.se === null || !Number.isFinite(it.se) ? v : `${v} ±${e.unit === 'pct' ? (1.96 * it.se).toFixed(1) : (1.96 * it.se).toFixed(2)}`;
}).join(' / ');

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
    out.push('| Hand measure | Value (95% CI) |', '|---|---|');
    for (const [label, e] of measures(games)) out.push(`| ${label} | ${fmtItems(e)} |`);
    out.push('', '| v6 measure (no Python line) | Value (95% CI) |', '|---|---|');
    for (const [label, e] of extraMeasures(games)) out.push(`| ${label} | ${fmtItems(e)} |`);
    out.push('');
    if (opts.python) out.push(crossCheckText(games, parsePython(readFileSync(opts.python, 'utf8')), 1000, 'the Python printed table'), '');
    if (opts.pyjson) {
      const pj = JSON.parse(readFileSync(opts.pyjson, 'utf8'));
      out.push(crossCheckText(games, pythonFromJson(pj), pj.games, `the Python re-run (${pj.games} games per count, full precision)`), '');
      if (opts.wins && pj.wins && pj.wins[opts.wins] && pj.wins[opts.wins][n]) out.push(winsCrossCheckText(games, opts.wins, pj.games, pj.wins[opts.wins][n]), '');
    } else if (opts.wins) out.push(winsCrossCheckText(games, opts.wins), '');
  }
  return out.join('\n');
}

// ---------- main ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const opt = (k) => (process.argv.find((x) => x.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null;
  if (!files.length) { console.error('usage: node tests/sim-report.mjs a.json [b.json ...] [--python=sim/out-v6-base.txt] [--pyjson=file.json] [--wins=play]'); process.exit(2); }
  console.log(report(files, { python: opt('python'), pyjson: opt('pyjson'), wins: opt('wins') }));
}
