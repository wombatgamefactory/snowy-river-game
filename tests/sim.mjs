// sim.mjs - headless bot-v-bot simulator for balance work (v6 rules: single-number cards, the Climb row, the
// Brumby row, no summit choice; 2 to 5 players).
//
//   node tests/sim.mjs --players=4 --seats=medium,hard,easy,medium --games=2000 --seed=1
//        [--rotate=1] [--jitter=5] [--threads=8] [--const.X=Y] [--out=path]
//   (npm run sim -- --players=4 --games=500 ...)
//   Launch long runs through simrun: python D:/data/pc-health/scripts/simrun.py node tests/sim.mjs ...
//
//  --players=2..5       table size. Default: the number of --seats entries (or 4).
//  --seats=a,b,c,d      bot per seat. One entry fills every seat. Default: medium for every seat.
//                       Ids from the bot registry: easy | medium | hard | naive | high | low, plus
//                         hard:N   Hard at N sampled worlds per decision (plain "hard" = the real budget)
//                         medium-dealorder   probe: Medium handed its hand in a random (deal) order, like the Python
//                       (naive = the Python's naive card play, the opponent Medium is measured against)
//  --games=N            games to play.
//  --seed=S             run seed; game i uses deriveSeed(S, 'game', i); bot and jitter streams are separate
//                       from the game's deal RNG, so a bot's choices never change the deals.
//  --rotate=1|0         1 (default): in game i seat s plays the bot listed at (s + i) mod n, so a bot's strength
//                       is spread over every seat and seat effects cancel out of bot results. 0: list used as given.
//  --jitter=N           N percent chance per decision of playing a random legal action instead of the bot's choice.
//  --variant.NAME=VALUE refused: Snowy River has no Playtest switches.
//  --const.NAME=VALUE   a numeric/JSON entry of the engine's CONSTANTS object (a probe, e.g. --const.HANDS_PER_GAME={"2":4,"3":4,"4":4,"5":5}).
//  --threads=N          worker threads (default 1). Results are identical for any N: games are independent.
//  --out=path           JSON output (default tests/tmp/sim-<auto-name>.json).
//
// Deterministic for a fixed argument list: the JSON holds no clock values (timing goes to stderr).
//
// Record per game (compact; explained in sim-report.mjs):
//   n, lv (bot by seat), fd (first dealer), tot (final totals), win (winners after the last-hand tiebreak),
//   tied (seats on the top total), tb (the tiebreak separated them), lh (last hand's scores),
//   h: one entry per hand {
//      s hand scores, ct / dt tricks won on the climb / descent by seat (= Climb cards / Brumby cards taken),
//      cv / bv value of the Climb / Brumby cards taken by seat,
//      cr the 6 Climb card values in row order, mp position (1..6) of the -1 Climb card, mw seat that took it,
//      ml seat that led the -1 trick, mn number on the card that won the -1 trick, mt 1 = it was won by a trump,
//      cn / ctr the winning card number and a 0/1 string of trump wins for the 6 climb tricks,
//      rv the 6 Brumby row values in order, rs 1 = the row came from a fresh shuffle,
//      ck Colt's trick in the row (1..6, 0 = Colt not in the row), cw seat that won the Colt's trick (-1 none),
//      top seat holding the lowest-numbered Home card still in hand at the summit (-1 none; the Python's reading),
//      h1 seat dealt Home 1 (-1 = it is out unseen),
//      cs / ds winners of the 6 climb / 6 descent tricks as a digit string, cl the seats that led the 6 climb tricks,
//      ld tricks (of 12) won by the seat that led them, tr trump-suit cards dealt (Escape + Home) by seat,
//      ex extreme cards dealt (number 1-2 or 11-12) by seat }.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  createGame, applyAction, viewFor, legalActionsFromView, makeRng, deriveSeed, rngInt, rngNext, cardNumber, cardSuit,
  CONSTANTS, resolveVariants,
} from '../src/engine/index.js';
import { getBot, botLevels } from '../src/bots/index.js';
import { searchAction } from '../src/bots/hard.js';
import { buildContext, mediumChoose } from '../src/bots/medium.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// ---------- bots ----------
const isHardN = (id) => /^hard:\d+$/.test(id);

/** Probe bots (simulator only, not in the registry). */
const PROBES = ['medium-dealorder'];

/**
 * medium-dealorder: Medium's own decisions, but with the hand handed over in a random order fixed for the hand instead of
 * the engine's sorted order. The Python's smart bot breaks ties by its hand list, which is the deal order (a shuffle), while
 * the registry Medium sees the sorted hand (the tie-order difference). This probe shows what that
 * difference does to the all-Medium measures. Uses the bot's own rng stream, so deals are untouched.
 */
function dealOrderMedium(id) {
  let handNo = -1;
  const prio = new Map();
  return {
    id,
    chooseAction(view, rng) {
      if (view.handNo !== handNo) { handNo = view.handNo; prio.clear(); }
      for (const c of view.hand) if (!prio.has(c)) prio.set(c, rngNext(rng));
      const hand = [...view.hand].sort((x, y) => prio.get(x) - prio.get(y));
      return mediumChoose(buildContext(view, hand), legalActionsFromView(view));
    },
  };
}

/** The bot object for a --seats name. v6 has no summit choice, so every bot is the registry bot (or Hard at N worlds, or a probe). */
export function simBot(id) {
  if (isHardN(id)) { const samples = Number(id.slice(5)); return { id, chooseAction: (view, rng) => searchAction(view, rng, { samples }).action }; }
  if (id === 'medium-dealorder') return dealOrderMedium(id);
  return getBot(id);
}

// ---------- arguments ----------
export function parseArgs(argv) {
  const a = { players: null, seats: null, games: 1000, seed: 1, jitter: 0, rotate: true, threads: 1, out: null, variants: {}, consts: {} };
  for (const raw of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) throw new Error(`Bad argument "${raw}" (use --name=value)`);
    const [, key, val] = m;
    if (key.startsWith('variant.')) {
      throw new Error('Snowy River has no variants (no Playtest switches); use --const.NAME=VALUE for a probe');
    } else if (key.startsWith('const.')) {
      const name = key.slice(6);
      if (!(name in CONSTANTS)) throw new Error(`Unknown constant "${name}". Known: ${Object.keys(CONSTANTS).join(', ')}`);
      try { a.consts[name] = JSON.parse(val); } catch { a.consts[name] = val; }
    } else if (key === 'seats') a.seats = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'out') a.out = val;
    else if (key === 'rotate') a.rotate = !['0', 'false', 'no'].includes(val);
    else if (['players', 'games', 'jitter', 'threads'].includes(key)) {
      a[key] = Number(val);
      if (!Number.isFinite(a[key])) throw new Error(`--${key} must be a number`);
    } else if (key === 'seed') a.seed = /^\d+$/.test(val) ? Number(val) : val;
    else throw new Error(`Unknown option --${key}`);
  }
  if (!a.seats) a.seats = ['medium'];
  if (a.players === null) a.players = a.seats.length > 1 ? a.seats.length : 4;
  if (![2, 3, 4, 5].includes(a.players)) throw new Error('--players must be 2, 3, 4 or 5');
  if (a.seats.length === 1) a.seats = Array(a.players).fill(a.seats[0]);
  if (a.seats.length !== a.players) throw new Error(`--seats lists ${a.seats.length} bots for ${a.players} players`);
  const known = botLevels().map((l) => l.id);
  for (const s of a.seats) if (!known.includes(s) && !isHardN(s) && !PROBES.includes(s)) throw new Error(`--seats: unknown bot "${s}" (${known.join(', ')}, hard:N)`);
  if (a.jitter < 0 || a.jitter > 100) throw new Error('--jitter is a percentage 0..100');
  if (!Number.isInteger(a.games) || a.games < 1) throw new Error('--games must be a positive integer');
  if (!Number.isInteger(a.threads) || a.threads < 1) throw new Error('--threads must be a positive integer');
  a.rules = resolveVariants(a.variants); // throws on a bad name or value
  return a;
}

function defaultOut(a) {
  const tag = (o) => Object.entries(o).map(([k, v]) => `${k.toLowerCase().replace(/_/g, '-')}-${String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/[^a-z0-9.-]/gi, '')}`).join('-');
  const consts = tag(a.consts);
  const who = a.seats.join('-').replace(/:/g, '');
  const name = `sim-${a.players}p-${who}-n${a.games}-s${a.seed}${a.rotate ? '' : '-fixed'}${a.jitter ? `-j${a.jitter}` : ''}${consts ? `-${consts}` : ''}.json`;
  return resolve(HERE, 'tmp', name.toLowerCase());
}

// ---------- recording ----------
/** One compact record from a finished game state. `deals[h]` = { tr, ex } noted when the hand was dealt. */
export function recordGame(g, levels, deals) {
  const r = g.result;
  return {
    n: g.n,
    lv: [...levels],
    fd: g.firstDealer,
    tot: r.totals,
    win: r.winners,
    tied: r.tiedOnTotal,
    tb: r.tiebreakUsed,
    lh: r.lastHandScores,
    h: g.handLog.map((h, i) => {
      const climb = h.tricks.filter((t) => t.half === 'climb');
      const descent = h.tricks.filter((t) => t.half === 'descent');
      const minus = h.minusPosition ? climb[h.minusPosition - 1] : null;
      return {
        s: h.scores, ct: h.climbTricks, dt: h.descentTricks,
        cv: h.climbValues, bv: h.keptValues,
        cr: h.climbRowValues, mp: h.minusPosition || 0, mw: h.minusWinner === null ? -1 : h.minusWinner,
        ml: minus ? minus.leader : -1, mn: minus ? cardNumber(minus.winningCard) : 0, mt: minus && minus.byTrump ? 1 : 0,
        cn: climb.map((t) => cardNumber(t.winningCard)), ctr: climb.map((t) => (t.byTrump ? 1 : 0)).join(''),
        rv: h.rowValues, rs: h.reshuffled ? 1 : 0,
        ck: h.colt ? h.coltTrick : 0, cw: h.coltWinner === null ? -1 : h.coltWinner,
        top: h.topHomeSeat === null ? -1 : h.topHomeSeat, h1: h.home1Seat === null ? -1 : h.home1Seat,
        cs: climb.map((t) => t.winner).join(''), cl: climb.map((t) => t.leader).join(''),
        ds: descent.map((t) => t.winner).join(''),
        ld: h.tricks.filter((t) => t.winner === t.leader).length,
        tr: deals[i].tr, ex: deals[i].ex,
      };
    }),
  };
}

// ---------- playing ----------
function makeChooser(id, jitter, rngBot, rngJit) {
  const bot = simBot(id);
  return (view) => {
    if (jitter > 0 && rngNext(rngJit) * 100 < jitter) {
      const legal = legalActionsFromView(view);
      return legal[rngInt(rngJit, legal.length)];
    }
    return bot.chooseAction(view, rngBot);
  };
}

function playToEnd(state, choosers) {
  let guard = 0;
  const deals = [];
  let dealtFor = -1;
  while (state.toAct !== null) {
    if (state.handNo !== dealtFor) {
      dealtFor = state.handNo;
      deals[dealtFor] = {
        tr: state.hands.map((h) => h.filter((c) => cardSuit(c) === CONSTANTS.TRUMP_CLIMB || cardSuit(c) === CONSTANTS.TRUMP_DESCENT).length),
        ex: state.hands.map((h) => h.filter((c) => cardNumber(c) <= 2 || cardNumber(c) >= 11).length),
      };
    }
    const seat = state.toAct;
    const act = choosers[seat](viewFor(state, seat));
    applyAction(state, act, { silent: true });
    if (++guard > 5000) throw new Error('livelock');
  }
  return deals;
}

/** Plays games [from, to) of the run. Pure function of the arguments (CONSTANTS are set for the run, then restored). */
export function runRange(a, from, to) {
  const saved = {};
  for (const [k, v] of Object.entries(a.consts)) { saved[k] = CONSTANTS[k]; CONSTANTS[k] = v; }
  try {
    const n = a.players;
    const games = [];
    for (let i = from; i < to; i++) {
      const seed = deriveSeed(a.seed, 'game', i);
      const levels = Array.from({ length: n }, (_, s) => a.seats[a.rotate ? (s + i) % n : s]);
      const choosers = levels.map((lv, s) => makeChooser(lv, a.jitter, makeRng(deriveSeed(seed, 'bot', s)), makeRng(deriveSeed(seed, 'jitter', s))));
      const g = createGame({ seed, players: n, rules: {} });
      const deals = playToEnd(g, choosers);
      games.push(recordGame(g, levels, deals));
    }
    return games;
  } finally {
    for (const [k, v] of Object.entries(saved)) CONSTANTS[k] = v;
  }
}

export function runSim(a) {
  return runRange(a, 0, a.games);
}

/** Splits the run across worker threads; output order and content are the same as runSim. */
export async function runSimThreaded(a) {
  const t0 = Date.now();
  if (a.threads <= 1 || a.games < 2 * a.threads) return { games: runSim(a), ms: Date.now() - t0 };
  const size = Math.ceil(a.games / a.threads);
  const jobs = [];
  for (let from = 0; from < a.games; from += size) {
    const to = Math.min(a.games, from + size);
    jobs.push(new Promise((res, rej) => {
      const w = new Worker(SELF, { workerData: { a, from, to } });
      w.once('message', res);
      w.once('error', rej);
    }));
  }
  const parts = await Promise.all(jobs);
  return { games: parts.flat(), ms: Date.now() - t0 };
}

// ---------- worker entry ----------
if (!isMainThread && workerData && workerData.a) {
  parentPort.postMessage(runRange(workerData.a, workerData.from, workerData.to));
}

// ---------- main ----------
if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const { games, ms } = await runSimThreaded(a);
    const out = a.out ? resolve(a.out) : defaultOut(a);
    const meta = {
      tool: 'snowy-river-sim', version: 3, players: a.players, seats: a.seats, rotate: a.rotate, games: a.games, seed: a.seed,
      jitter: a.jitter, rules: a.rules, variants: {}, consts: a.consts,
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ meta, games }) + '\n');
    console.error(`${a.games} games in ${(ms / 1000).toFixed(1)}s`);
    console.log(out);
  } catch (e) {
    console.error(`sim: ${e.message}`);
    process.exit(2);
  }
}
