// sim.mjs - headless bot-v-bot simulator for balance work.
//
//   node tests/sim.mjs --players=4 --seats=medium,hard,easy,medium --games=2000 --seed=1
//        [--rotate=1] [--jitter=5] [--threads=8] [--const.X=Y] [--out=path]
//   (npm run sim -- --players=4 --games=500 ...)
//
//  --players=2..5       table size. Default: the number of --seats entries (or 4).
//  --seats=a,b,c,d      bot per seat. One entry fills every seat. Default: medium for every seat.
//                       Ids from the bot registry: easy | medium | hard | high | low and the archetypes
//                         always (smart cards, always chase)   never (never chase)   random (coin-flip summit)
//                         nothing (chase only with no climb tricks)   naive (naive cards, smart summit)
//                         naive-random (naive cards, coin-flip summit), plus
//                         hard:N        Hard at N sampled worlds per decision (plain "hard" = the real budget)
//                         medium-blind  Medium whose summit sample ignores the voids other seats have shown, as the
//                         naive-blind   Python does (MEDIUM_HONOUR_VOIDS = false, switched per bot, src/ untouched).
//                                       Used for the Python cross-check; plain medium / naive honour shown voids.
//  --games=N            games to play.
//  --seed=S             run seed; game i uses deriveSeed(S, 'game', i); bot and jitter streams are separate
//                       from the game's deal RNG, so a bot's choices never change the deals.
//  --rotate=1|0         1 (default): in game i seat s plays the bot listed at (s + i) mod n, so a bot's strength
//                       is spread over every seat and seat effects cancel out of bot results. 0: list used as given.
//  --jitter=N           N percent chance per decision of playing a random legal action instead of the bot's choice.
//  --variant.NAME=VALUE refused: Snowy River has no Playtest switches.
//  --const.NAME=VALUE   a numeric/JSON entry of the engine's CONSTANTS object (a probe, e.g. --const.MOB_BASE=4,
//                       --const.CLOCK=fixed, --const.SUMMIT_BY_COUNT={"2":8,"3":8,"4":8,"5":7}).
//  --threads=N          worker threads (default 1). Results are identical for any N: games are independent.
//  --out=path           JSON output (default tests/tmp/sim-<auto-name>.json).
//
// Deterministic for a fixed argument list: the JSON holds no clock values (timing goes to stderr).
//
// Record per game (compact; explained in sim-report.mjs):
//   n, lv (bot by seat), fd (first dealer), tot (final totals), win (winners after the tiebreak),
//   tied (seats on the top total), tb (the tiebreak separated them), mh (mobs brought home by seat),
//   h: one entry per hand { s scores, ct climb tricks by seat, dt descent tricks by seat, k summit trick,
//      c choices by seat ('C' / 'W' string), o outcomes by seat ('W' watched, 'H' home, 'F' fell),
//      home (seat that brought the mob home, -1 none), heels (seat at the heels, -1 when nobody chased),
//      th (1 when the later-trick rule decided the heels), m mob value this hand, b Brumby cards under the
//      Colt at the deal, cap (1 when an escape found all 4 Brumby cards already there),
//      ds (sum of the ranks dealt to each seat), de (sum of |rank - 6.5| dealt to each seat) }.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  createGame, applyAction, viewFor, legalActionsFromView, makeRng, deriveSeed, rngInt, rngNext, cardValue,
  CONSTANTS, resolveVariants,
} from '../src/engine/index.js';
import { getBot, botLevels } from '../src/bots/index.js';
import { searchAction } from '../src/bots/hard.js';
import { buildContext, cardChoice, summitCall } from '../src/bots/medium.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// ---------- bots ----------
const isHardN = (id) => /^hard:\d+$/.test(id);

/** Ids with a void-blind twin: the bots whose summit call is the Monte Carlo (smart policy). Value = card style. */
const BLIND = { 'medium-blind': 'smart', 'naive-blind': 'naive' };

/** The bot object for a --seats name. */
export function simBot(id) {
  if (isHardN(id)) { const samples = Number(id.slice(5)); return { id, chooseAction: (view, rng) => searchAction(view, rng, { samples }).action }; }
  if (BLIND[id]) {
    // Medium's own code (buildContext / summitCall / cardChoice) with the shown-voids switch off for the summit sample
    const style = BLIND[id];
    return {
      id,
      chooseAction(view, rng) {
        const legal = legalActionsFromView(view);
        if (legal.length === 1) return legal[0];
        const ctx = buildContext(view, view.seat, view.hand, view.handCounts, rng, { style, voids: false });
        if (view.phase === 'summit') {
          const want = summitCall(ctx).chase ? 'chase' : 'watch'; // one Monte Carlo call per decision
          return legal.find((a) => a.choice === want);
        }
        const card = cardChoice(ctx);
        return legal.find((a) => a.card === card);
      },
    };
  }
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
  for (const s of a.seats) if (!known.includes(s) && !isHardN(s) && !BLIND[s]) throw new Error(`--seats: unknown bot "${s}" (${known.join(', ')}, hard:N, ${Object.keys(BLIND).join(', ')})`);
  if (a.jitter < 0 || a.jitter > 100) throw new Error('--jitter is a percentage 0..100');
  if (!Number.isInteger(a.games) || a.games < 1) throw new Error('--games must be a positive integer');
  if (!Number.isInteger(a.threads) || a.threads < 1) throw new Error('--threads must be a positive integer');
  a.rules = resolveVariants(a.variants); // throws on a bad name or value
  return a;
}

function defaultOut(a) {
  const tag = (o) => Object.entries(o).map(([k, v]) => `${k.toLowerCase().replace(/_/g, '-')}-${v}`).join('-');
  const consts = tag(a.consts);
  const who = a.seats.join('-').replace(/:/g, '');
  const name = `sim-${a.players}p-${who}-n${a.games}-s${a.seed}${a.rotate ? '' : '-fixed'}${a.jitter ? `-j${a.jitter}` : ''}${consts ? `-${consts}` : ''}.json`;
  return resolve(HERE, 'tmp', name.toLowerCase());
}

// ---------- recording ----------
/** One compact record from a finished game state. */
export function recordGame(g, levels, dealt) {
  const r = g.result;
  return {
    n: g.n,
    lv: [...levels],
    fd: g.firstDealer,
    tot: r.totals,
    win: r.winners,
    tied: r.tiedOnTotal,
    tb: r.tiebreakUsed,
    mh: r.mobsHome,
    h: g.handLog.map((h, i) => ({
      s: h.scores, ct: h.climbTricks, dt: h.descentTricks, k: h.summitTrick, c: h.choices.map((x) => (x === 'chase' ? 'C' : 'W')).join(''),
      o: h.outcomes.map((x) => (x === 'home' ? 'H' : x === 'fell' ? 'F' : 'W')).join(''),
      home: h.broughtHomeBy === null ? -1 : h.broughtHomeBy, heels: h.heelsSeat === null ? -1 : h.heelsSeat, th: h.tieAtHeels ? 1 : 0,
      m: h.mobValue, b: h.brumbiesBefore, cap: h.brumbyAtCap ? 1 : 0,
      ds: dealt[i].ds, de: dealt[i].de,
    })),
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

/** The dealt hands of a new hand: sum of ranks and sum of distance from the middle of the ranks, by seat. */
function noteDeal(state, dealt) {
  const mid = (CONSTANTS.RANK_MIN + CONSTANTS.RANK_MAX) / 2;
  dealt.push({
    ds: state.hands.map((h) => h.reduce((x, c) => x + cardValue(c), 0)),
    de: state.hands.map((h) => h.reduce((x, c) => x + Math.abs(cardValue(c) - mid), 0)),
  });
}

function playToEnd(state, choosers) {
  let guard = 0;
  const dealt = [];
  let seen = -1;
  while (state.toAct !== null) {
    if (state.handNo !== seen) { seen = state.handNo; noteDeal(state, dealt); }
    const seat = state.toAct;
    const act = choosers[seat](viewFor(state, seat));
    applyAction(state, act, { silent: true });
    if (++guard > 5000) throw new Error('livelock');
  }
  return dealt;
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
      const dealt = playToEnd(g, choosers);
      games.push(recordGame(g, levels, dealt));
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
      tool: 'card-game-sim', version: 1, players: a.players, seats: a.seats, rotate: a.rotate, games: a.games, seed: a.seed,
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
