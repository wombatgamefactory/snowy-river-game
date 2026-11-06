// sim-report.mjs - summarises one or more sim.mjs JSON files (several = side-by-side columns).
//
//   node tests/sim-report.mjs tests/tmp/a.json [tests/tmp/b.json ...] [--detail]
//   node tests/sim-report.mjs tests/tmp/js.json --vs=path/to/reference.json     (cross-check, z-tests of differences)
//   node tests/sim-report.mjs tests/tmp/js.json --bands                          (score by quartile of hand extremity / strength)
//
// Per file: win rate by bot and by seat (Wilson 95% CI; a shared win counts 1/winners), score mean/sd,
// margin 1st-2nd, tie and tiebreak rates, and Snowy River's own hand measures (below).
// Definitions:
//   "tie for 1st"  = two or more players on the top total BEFORE any tiebreak.
//   "shared"       = still tied after the tiebreak (level on mobs brought home too).
//   win % (tiebreak) is the game's rule: a tied total is split by mobs brought home (R11.6), then shared 1/winners.
//   win % (no tiebreak) shares every tie on the top total (what the Python simulator, which has no tiebreak, counts).
//   chasers per hand = seats that chose Chase; "nobody chased" = 0, "lone" = 1, "race" = 2 or more.
//   mob home by the fewest-climb player: the seat that brought the mob home had the fewest climb tricks (ties count,
//     as in the Python); "by a lone chaser": that hand had exactly one chaser. Both are shares of mobs brought home.
//   climb points held: climb tricks (1 point each) of the seats that chased v the seats that watched, in the same hands.
//   hand strength = sum of the ranks dealt to a seat; extremity = sum of |rank - 6.5|; the links are Pearson r
//     between that and the seat's hand score, over every seat of every hand.
//   Brumby stack = Brumby cards under the Colt at the deal; "cap binds" = an escape found all 4 already there.
// Everything is recomputed from the totals (`tot`), the hands' scores (`h[].s`) and who brought the mob
// home (`h[].home`), so a file made by a reference simulator in the same format works too (fields it lacks give n/a).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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
const mci = (xs) => (1.96 * sd(xs)) / Math.sqrt(xs.length);
export const pm = (xs, d = 2) => (xs.length ? `${mean(xs).toFixed(d)} ±${mci(xs).toFixed(d)}` : 'n/a');
/** Two-sample z of the difference of means of two arrays (0/1 arrays give a difference of proportions). */
export function diffZ(xs, ys) {
  const se = Math.sqrt(sd(xs) ** 2 / xs.length + sd(ys) ** 2 / ys.length);
  return se === 0 ? 0 : (mean(xs) - mean(ys)) / se;
}
/** Pearson r of two equal-length arrays (NaN when there is no variance). */
export function pearson(xs, ys) {
  const mx = mean(xs); const my = mean(ys);
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx; const dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}
/** r with its Fisher 95% interval, as text. */
export function rci(r, n) {
  if (!Number.isFinite(r) || n < 4) return 'n/a';
  const z = Math.atanh(r); const se = 1 / Math.sqrt(n - 3);
  const f = (x) => Math.tanh(x).toFixed(2);
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)} [${f(z - 1.96 * se)}, ${f(z + 1.96 * se)}]`;
}
/** z of the difference of two correlations (Fisher). Pairs inside one hand are not independent, so this is slightly generous. */
export function corrZ(r1, n1, r2, n2) {
  return (Math.atanh(r1) - Math.atanh(r2)) / Math.sqrt(1 / (n1 - 3) + 1 / (n2 - 3));
}

// ---------- tiebreak: recomputed from the totals and the mobs brought home ----------
/** Winners of one game under the standard tiebreak (mobs brought home, R11.6) and with none. */
export function winnersOf(g) {
  const top = Math.max(...g.tot);
  const tied = g.tot.map((t, s) => (t === top ? s : -1)).filter((s) => s >= 0);
  const homes = g.tot.map((_, s) => g.h.filter((h) => h.home === s).length);
  const most = Math.max(...tied.map((s) => homes[s]));
  return { tied, noTb: tied, withTb: tied.filter((s) => homes[s] === most) };
}

// ---------- summary ----------
export function summarise(data) {
  const gs = data.games; const N = gs.length;
  const n = data.meta.players;
  const W = gs.map(winnersOf);
  const credit = (list, s) => (list.includes(s) ? 1 / list.length : 0);
  const levels = [...new Set(gs.flatMap((g) => g.lv))].sort();

  const bySeat = Array.from({ length: n }, (_, s) => ({ seat: s, k: sum(gs.map((g, i) => credit(W[i].withTb, s))), n: N }));
  const byOffset = Array.from({ length: n }, (_, o) => ({ off: o, k: sum(gs.map((g, i) => credit(W[i].withTb, (g.fd + o) % n))), n: N }));
  const byLevel = levels.map((lv) => {
    const cred = []; const cred0 = []; const scores = []; const perHand = [];
    gs.forEach((g, i) => {
      for (let s = 0; s < n; s++) {
        if (g.lv[s] !== lv) continue;
        cred.push(credit(W[i].withTb, s)); cred0.push(credit(W[i].noTb, s)); scores.push(g.tot[s]);
        for (const h of g.h) perHand.push(h.s[s]);
      }
    });
    return { lv, cred, cred0, k: sum(cred), k0: sum(cred0), n: cred.length, base: 1 / n, mean: mean(scores), perHand: mean(perHand), sdTotal: sd(scores) };
  });
  const exp = N / n;
  const chi = sum(bySeat.map((b) => ((b.k - exp) ** 2) / exp));

  const hands = gs.flatMap((g) => g.h);
  const totals = gs.flatMap((g) => g.tot);
  const finals = gs.map((g) => Math.max(...g.tot));
  const margins = gs.map((g) => { const t = [...g.tot].sort((a, b) => b - a); return t[0] - t[1]; });

  // Snowy River's own measures, per hand
  const nc = hands.map((h) => (h.c.match(/C/g) || []).length);
  const homeHands = hands.filter((h) => h.home >= 0);
  const chaserClimb = []; const watcherClimb = [];
  const strength = []; const extreme = []; const score = []; const chase = [];
  for (const h of hands) {
    for (let s = 0; s < n; s++) {
      (h.c[s] === 'C' ? chaserClimb : watcherClimb).push(h.ct[s]);
      if (h.ds) { strength.push(h.ds[s]); extreme.push(h.de[s]); score.push(h.s[s]); chase.push(h.c[s] === 'C' ? 1 : 0); }
    }
  }
  const hasB = hands.length > 0 && hands.every((h) => typeof h.b === 'number');
  const hasO = hands.length > 0 && hands.every((h) => typeof h.o === 'string');
  const fallsPerHand = hasO ? hands.map((h) => (h.o.match(/F/g) || []).length) : hands.map((h) => (h.c.match(/C/g) || []).length - (h.home >= 0 ? 1 : 0));
  const tieHeelsHands = hands.filter((h) => h.heels >= 0);
  return {
    N, n, H: hands.length, W, bySeat, byOffset, byLevel, chi, levels,
    handScores: hands.flatMap((h) => h.s), totals, finals, margins,
    summitTricks: hands.map((h) => h.k),
    homeArr: hands.map((h) => (h.home >= 0 ? 1 : 0)),
    nobodyArr: nc.map((x) => (x === 0 ? 1 : 0)),
    loneArr: nc.map((x) => (x === 1 ? 1 : 0)),
    raceArr: nc.map((x) => (x >= 2 ? 1 : 0)),
    chasersPerHand: nc,
    loneHomeArr: homeHands.map((h) => ((h.c.match(/C/g) || []).length === 1 ? 1 : 0)),
    fewestHomeArr: homeHands.map((h) => (h.ct[h.home] === Math.min(...h.ct) ? 1 : 0)),
    chaserClimb, watcherClimb,
    strength, extreme, score, chase,
    corrStrength: pearson(strength, score), corrExtreme: pearson(extreme, score), corrN: strength.length,
    mobValues: hands.map((h) => h.m),
    brumbyStart: hasB ? [0, 1, 2, 3, 4].map((k) => hands.filter((h) => h.b === k).length) : null,
    capArr: hands.map((h) => h.cap || 0),
    capHands: hands.filter((h) => h.cap).length,
    capGames: gs.filter((g) => g.h.some((h) => h.cap)).length,
    maxMob: hands.reduce((x, h) => Math.max(x, h.m), 0),
    fallsPerHand,
    thArr: tieHeelsHands.map((h) => h.th || 0),
    handsWithDescent: tieHeelsHands.length,
    tiedArr: W.map((w) => (w.tied.length > 1 ? 1 : 0)),
    tbArr: W.map((w) => (w.withTb.length < w.tied.length ? 1 : 0)),
    sharedArr: W.map((w) => (w.withTb.length > 1 ? 1 : 0)),
  };
}

// ---------- output ----------
export function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => '| ' + r.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
  return [fmt(headers), '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |', ...rows.map(fmt)].join('\n');
}

export function labelOf(data) {
  const m = data.meta;
  const c = Object.entries(m.consts || {}).map(([k, x]) => `${k}=${typeof x === 'object' ? JSON.stringify(x) : x}`).join(' ');
  return `${m.players}p ${m.seats.join(',')}${m.rotate ? '' : ' (fixed seats)'}${m.jitter ? ` j${m.jitter}` : ''}${c ? ` ${c}` : ''}`;
}

const asProp = (arr) => (arr.length ? ci(sum(arr), arr.length) : 'n/a');
const pctMean = (arr) => (arr.length ? `${pct(mean(arr))}` : 'n/a');

export function report(files, { detail = false } = {}) {
  const loaded = files.map((f) => ({ f, data: JSON.parse(readFileSync(f, 'utf8')) }));
  const S = loaded.map((x) => ({ x, s: summarise(x.data) }));
  const out = [];
  const cols = ['', ...S.map(({ x }, i) => `[${i + 1}] ${labelOf(x.data)}`)];
  const row = (name, f) => [name, ...S.map(({ s }) => f(s))];
  out.push('== Summary ==');
  out.push(table(cols, [
    row('games', (s) => String(s.N)),
    row('summit trick, mean ±95%', (s) => pm(s.summitTricks, 2)),
    row('chasers per hand, mean ±95%', (s) => pm(s.chasersPerHand, 2)),
    row('nobody chased %  [CI]', (s) => asProp(s.nobodyArr)),
    row('one chaser %  [CI]', (s) => asProp(s.loneArr)),
    row('two or more chasers %  [CI]', (s) => asProp(s.raceArr)),
    row('mob brought home %  [CI]', (s) => asProp(s.homeArr)),
    row('  ...by a lone chaser, % of homes  [CI]', (s) => asProp(s.loneHomeArr)),
    row('  ...by the fewest-climb player, % of homes  [CI]', (s) => asProp(s.fewestHomeArr)),
    row('falls per hand, mean ±95%', (s) => pm(s.fallsPerHand, 3)),
    row('climb points: chasers v watchers', (s) => `${mean(s.chaserClimb).toFixed(2)} v ${mean(s.watcherClimb).toFixed(2)}`),
    row('later-trick tie at the heels, % of descents', (s) => asProp(s.thArr)),
    row('mob value, mean (max)', (s) => `${mean(s.mobValues).toFixed(2)} (${s.maxMob})`),
    row('Brumby stack at the deal 0/1/2/3/4, %', (s) => (s.brumbyStart ? s.brumbyStart.map((k) => pctMean([k / s.H])).join(' / ') : 'n/a')),
    row('4-Brumby cap binds: hands (games)', (s) => `${s.capHands} (${s.capGames})`),
    row('link: hand strength v score, r [95%]', (s) => rci(s.corrStrength, s.corrN)),
    row('link: hand extremity v score, r [95%]', (s) => rci(s.corrExtreme, s.corrN)),
    row('score per hand, mean ±95%', (s) => pm(s.handScores)),
    row('final total (mean, sd)', (s) => `${mean(s.totals).toFixed(1)} (${sd(s.totals).toFixed(1)})`),
    row('winner total, mean', (s) => mean(s.finals).toFixed(1)),
    row('margin 1st-2nd, mean ±95%', (s) => pm(s.margins)),
    row('tie for 1st on total %  [CI]', (s) => asProp(s.tiedArr)),
    row('tiebreak decided %  [CI]', (s) => asProp(s.tbArr)),
    row('still shared after tiebreak %  [CI]', (s) => asProp(s.sharedArr)),
    row('seat chi-square (df n-1)', (s) => s.chi.toFixed(1)),
  ]));

  for (const { x, s } of S) {
    out.push('', `== [${S.findIndex((q) => q.x === x) + 1}] ${labelOf(x.data)} ==`);
    out.push('Win % by bot (base rate = 1/n; "tiebreak" = the game rule; "no tiebreak" shares every tie):');
    out.push(table(['bot', 'seat-games', 'win % tiebreak [95% CI]', 'win % no tiebreak [95% CI]', 'base %', 'score/hand', 'final total (sd)'],
      s.byLevel.map((b) => [b.lv, b.n, ci(b.k, b.n), ci(b.k0, b.n), pct(b.base), b.perHand.toFixed(2), `${b.mean.toFixed(2)} (${b.sdTotal.toFixed(2)})`])));
    if (detail || s.byLevel.length === 1 || !x.data.meta.rotate) {
      out.push('', 'Win % by seat number:');
      out.push(table(['seat', 'win % [95% CI]'], s.bySeat.map((b) => [b.seat, ci(b.k, b.n)])));
      out.push('', 'Win % by position after the first dealer (0 = dealer of hand 1, 1 = first leader):');
      out.push(table(['offset', 'win % [95% CI]'], s.byOffset.map((b) => [b.off, ci(b.k, b.n)])));
    }
  }
  return out.join('\n');
}

// ---------- hand bands: does a middle hand score less? ----------
/** Mean hand score (and chase rate) by quartile of the dealt hand's extremity, and of its strength. */
export function bandsTable(s) {
  const quart = (key, label) => {
    const idx = s[key].map((_, i) => i).sort((a, b) => s[key][a] - s[key][b]);
    const rows = [];
    for (let q = 0; q < 4; q++) {
      const part = idx.slice(Math.floor((idx.length * q) / 4), Math.floor((idx.length * (q + 1)) / 4));
      const xs = part.map((i) => s[key][i]); const sc = part.map((i) => s.score[i]); const ch = part.map((i) => s.chase[i]);
      rows.push([`${label} Q${q + 1}${q === 0 ? ' (lowest)' : q === 3 ? ' (highest)' : ''}`, `${xs.reduce((x, y) => Math.min(x, y), Infinity).toFixed(1)} to ${xs.reduce((x, y) => Math.max(x, y), -Infinity).toFixed(1)}`, pm(sc, 2), pct(mean(ch), 1), part.length]);
    }
    return rows;
  };
  return table(['quartile of dealt hand', 'range', 'score per hand ±95%', 'chase %', 'seat-hands'], [...quart('extreme', 'extremity'), ...quart('strength', 'strength')]);
}

// ---------- cross-check against a second file (a reference simulator) ----------
/**
 * Side-by-side table of the reference measures, with the z of the difference.
 * |z| < 1.96 = "within CI" (the difference is not distinguishable from noise at 95%).
 */
export function crossCheck(jsFile, refFile) {
  const a = summarise(JSON.parse(readFileSync(jsFile, 'utf8')));
  const b = summarise(JSON.parse(readFileSync(refFile, 'utf8')));
  const rows = [];
  const add = (name, xs, ys, kind) => {
    if (!xs.length || !ys.length) { rows.push([name, 'n/a', 'n/a', '-', '-']); return; }
    const z = diffZ(xs, ys);
    const f = kind === 'pct' ? (arr) => `${pct(mean(arr), 1)}%` : (arr) => mean(arr).toFixed(2);
    rows.push([name, f(xs), f(ys), z.toFixed(2), Math.abs(z) < 1.96 ? 'within CI' : 'DIFFERS']);
  };
  add('summit trick', a.summitTricks, b.summitTricks, 'num');
  add('nobody chased (share of hands)', a.nobodyArr, b.nobodyArr, 'pct');
  add('one chaser (share of hands)', a.loneArr, b.loneArr, 'pct');
  add('two or more chasers (share of hands)', a.raceArr, b.raceArr, 'pct');
  add('mob brought home (share of hands)', a.homeArr, b.homeArr, 'pct');
  add('  ...by a lone chaser (share of homes)', a.loneHomeArr, b.loneHomeArr, 'pct');
  add('  ...by the fewest-climb player (share of homes)', a.fewestHomeArr, b.fewestHomeArr, 'pct');
  add('climb points held by chasers', a.chaserClimb, b.chaserClimb, 'num');
  add('climb points held by watchers', a.watcherClimb, b.watcherClimb, 'num');
  add('mob value (mean)', a.mobValues, b.mobValues, 'num');
  for (const [name, ra, rb] of [['link: hand strength v score (r)', a.corrStrength, b.corrStrength], ['link: hand extremity v score (r)', a.corrExtreme, b.corrExtreme]]) {
    if (Number.isFinite(ra) && Number.isFinite(rb)) {
      const z = corrZ(ra, a.corrN, rb, b.corrN);
      rows.push([name, ra.toFixed(2), rb.toFixed(2), z.toFixed(2), Math.abs(z) < 1.96 ? 'within CI' : 'DIFFERS']);
    } else rows.push([name, 'n/a', 'n/a', '-', '-']);
  }
  add('tied games (tie for 1st on total)', a.tiedArr, b.tiedArr, 'pct');
  for (const lv of a.levels) {
    const bl = b.byLevel.find((l) => l.lv === lv);
    const al = a.byLevel.find((l) => l.lv === lv);
    if (bl && al) add(`win % per seat: ${lv}`, al.cred0, bl.cred0, 'pct');
  }
  const head = ['measure', `This engine (${a.N} games)`, `Reference (${b.N} games)`, 'z of difference', 'verdict'];
  return table(head, rows);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const vs = process.argv.find((a) => a.startsWith('--vs='));
  if (!files.length) { console.error('usage: node tests/sim-report.mjs file.json [file2.json ...] [--detail] [--vs=reference.json] [--bands]'); process.exit(2); }
  if (process.argv.includes('--bands')) console.log(bandsTable(summarise(JSON.parse(readFileSync(files[0], 'utf8')))));
  else console.log(vs ? crossCheck(files[0], vs.slice(5)) : report(files, { detail: process.argv.includes('--detail') }));
}
