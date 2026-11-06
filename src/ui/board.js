// board.js - the presentation model: what the table looks like, and how it changes event by event.
//
// One call of applyAction can play many forced moves, win the last climb trick, reach the summit,
// finish the descent, end the hand, deal the next one and even end the game. So the screen cannot
// simply draw `state` after each action: it would jump over the last trick of every hand. Instead the
// UI keeps a small "board" (everything that is drawn: the trick on the table, hand counts, the turn,
// the marker, the Brumby stack, the summit choices as far as they are public, the pad) and walks the
// returned events over it, one frame per beat, so every trick, marker step and reveal is seen.
//
//   boardFromState(state, humanSeats)    the board for a live state
//   reduceBoard(board, event, ctx)       the board after one engine event (a fresh copy)
//   buildFrames(board, events, ctx)      the frames to show, in order, for one action's events
//
// No rules live here: every number comes from an event (who won, where the marker went, the scores).
// The board never holds an unrevealed summit choice: only `chosen` (locked in) until the reveal.
// tests/ui-node.mjs replays thousands of actions and requires that walking the events over the
// board before the action gives exactly boardFromState(state after the action). Pure and DOM-free.

const copy = (x) => JSON.parse(JSON.stringify(x));

/** Fields that only exist while a frame is on screen (excluded from the live-board equality test). */
export const TRANSIENT = ['fx', 'last', 'banner'];

/**
 * @param {object} state        the live engine state
 * @param {number[]} humanSeats seats whose hand the UI may need to show (others get null)
 */
export function boardFromState(state, humanSeats = []) {
  const n = state.n;
  let trick = null;
  if (state.trick) {
    const t = state.trick;
    trick = {
      n: t.n, phase: t.phase, leader: t.leader, seats: [...t.seats], ledSuit: t.ledSuit,
      plays: t.plays.map((p) => ({ seat: p.seat, card: p.card, offSuit: p.offSuit })),
      winner: null, winningCard: null, done: false,
    };
  }
  return {
    n,
    handsPerGame: state.params.handsPerGame,
    summitStep: state.params.summitStep,
    mountainSide: state.params.mountainSide,
    handNo: state.handNo,
    handSize: state.handSize,
    phase: state.phase,
    dealer: state.dealer,
    toAct: state.toAct,
    trickNo: state.trickNo, // completed tricks this hand
    marker: state.marker,
    brumbies: state.brumbies,
    mob: state.mob, // this hand's mob value
    climbTricks: [...state.climbTricks],
    descentTricks: [...state.descentTricks],
    lastDescentWin: [...state.lastDescentWin], // who is at the mob's heels now comes from the engine's heelsOf()
    choiceOrder: [...state.choiceOrder],
    chosen: state.choices.map((c) => c !== null),
    choices: state.choices.map((c) => (state.revealed ? c : null)), // public only after the reveal
    revealed: state.revealed,
    handCounts: state.hands.map((h) => h.length),
    totals: [...state.totals],
    mobsHome: [...state.mobsHome],
    trick,
    hands: state.hands.map((h, s) => (humanSeats.includes(s) ? [...h] : null)),
    fx: null,
    last: null,
    banner: null,
  };
}

/**
 * The board after one engine event. `ctx`:
 *   liveHands(seat)   the live state's hand for a human seat (used when a hand is dealt)
 */
export function reduceBoard(board, ev, ctx = {}) {
  const b = copy(board);
  b.fx = null;
  b.banner = null;
  const n = b.n;
  switch (ev.type) {
    case 'game-started':
      return b;
    case 'hand-started': {
      b.handNo = ev.handNo;
      b.dealer = ev.dealer;
      b.handSize = ev.handSize;
      b.phase = 'climb';
      b.toAct = ev.leader;
      b.trickNo = 0;
      b.marker = 0;
      b.brumbies = ev.brumbies;
      b.mob = ev.mob;
      b.climbTricks = Array.from({ length: n }, () => 0);
      b.descentTricks = Array.from({ length: n }, () => 0);
      b.lastDescentWin = Array.from({ length: n }, () => -1);
      b.choiceOrder = [];
      b.chosen = Array.from({ length: n }, () => false);
      b.choices = Array.from({ length: n }, () => null);
      b.revealed = false;
      b.handCounts = Array.from({ length: n }, () => ev.handSize);
      b.trick = null;
      b.last = null;
      b.hands = b.hands.map((h, s) => (h === null ? null : (ctx.liveHands ? [...ctx.liveHands(s)] : [])));
      b.fx = { dealt: true };
      return b;
    }
    case 'card-played': {
      if (ev.asLeader) {
        b.trick = {
          n: ev.trickNo, phase: ev.phase, leader: ev.seat, seats: Array.from({ length: n }, (_, k) => (ev.seat + k) % n), ledSuit: null, plays: [],
          winner: null, winningCard: null, done: false,
        };
      }
      const t = b.trick;
      t.ledSuit = ev.ledSuit;
      t.plays.push({ seat: ev.seat, card: ev.card, offSuit: ev.offSuit });
      b.handCounts[ev.seat]--;
      if (b.hands[ev.seat]) b.hands[ev.seat] = b.hands[ev.seat].filter((c) => c !== ev.card);
      const i = t.seats.indexOf(ev.seat);
      b.toAct = i < t.seats.length - 1 ? t.seats[i + 1] : null;
      b.last = null;
      return b;
    }
    case 'trick-won': {
      const t = b.trick;
      b.climbTricks = [...ev.climbTricks];
      b.descentTricks = [...ev.descentTricks];
      if (ev.phase === 'descent') b.lastDescentWin[ev.winner] = ev.descentTricks.reduce((a, x) => a + x, 0) - 1; // index of this descent trick
      b.trickNo = ev.trickNo;
      const decided = copy(t);
      decided.winner = ev.winner;
      decided.winningCard = ev.card;
      decided.done = true;
      b.last = { trick: decided, event: copy(ev) };
      b.fx = { won: ev.winner, phase: ev.phase };
      b.trick = null;
      b.toAct = ev.winner; // the winner leads next (or the summit follows: summit-reached sets it)
      return b;
    }
    case 'marker-moved':
      b.marker = ev.to;
      b.fx = { marker: { from: ev.from, to: ev.to, steps: ev.steps, offSuit: ev.offSuit, summit: ev.summit, overshoot: ev.overshoot, base: ev.base, step: ev.to - ev.from, of: ev.to - ev.from } };
      return b;
    case 'summit-reached':
      b.phase = 'summit';
      b.choiceOrder = [...ev.order];
      b.chosen = Array.from({ length: n }, () => false);
      b.choices = Array.from({ length: n }, () => null);
      b.revealed = false;
      b.toAct = ev.order[0];
      b.banner = { kind: 'summit' };
      return b;
    case 'summit-chosen': {
      b.chosen[ev.seat] = true;
      const next = b.choiceOrder.find((s) => !b.chosen[s]);
      b.toAct = next === undefined ? null : next;
      return b;
    }
    case 'summit-revealed':
      b.choices = [...ev.choices];
      b.revealed = true;
      b.toAct = null;
      b.banner = { kind: 'reveal', chasers: [...ev.chasers] };
      return b;
    case 'nobody-chased':
      b.toAct = null;
      b.banner = { kind: 'nobody', mob: ev.mob };
      return b;
    case 'descent-started':
      b.phase = 'descent';
      b.toAct = ev.leader;
      b.banner = { kind: 'descent' };
      return b;
    case 'at-the-heels':
      b.toAct = null;
      b.banner = { kind: 'heels', seat: ev.seat, tricks: ev.descentTricks[ev.seat], tie: ev.tie, tied: [...ev.tied] };
      return b;
    case 'mob-home':
      b.mobsHome[ev.seat]++;
      b.brumbies = 0;
      b.banner = { kind: 'home', seat: ev.seat, mob: ev.mob, climbTricks: ev.climbTricks, score: ev.score };
      return b;
    case 'mob-escaped':
      b.banner = { kind: 'escaped', reason: ev.reason, heels: ev.heels, fallen: [...ev.fallen] };
      return b;
    case 'brumby-added':
      b.brumbies = ev.brumbies;
      b.banner = { kind: 'brumby', added: ev.added, atCap: ev.atCap, brumbies: ev.brumbies, nextMob: ev.nextMob, lastHand: ev.lastHand };
      return b;
    case 'hand-ended': {
      b.totals = [...ev.totals];
      b.handNo = ev.handNo + 1;
      b.trick = null;
      b.toAct = null;
      b.fx = { handEnded: true };
      return b;
    }
    case 'game-over':
      b.phase = 'over';
      b.toAct = null;
      return b;
    default:
      return b;
  }
}

/** Compares two boards ignoring transient display fields. */
export function sameBoard(a, b) {
  const strip = (x) => { const c = copy(x); for (const k of TRANSIENT) delete c[k]; return JSON.stringify(c); };
  return strip(a) === strip(b);
}

/** How long each beat stays on screen (ms, before the speed scale), for the events with a log line. */
const HOLDS = {
  'marker-moved': 700, // the last step; each earlier step holds MARKER_STEP_HOLD
  'summit-reached': 1200,
  'summit-chosen': 250,
  'summit-revealed': 2600, // the Chase and Watch cards face up
  'nobody-chased': 1800,
  'descent-started': 1000,
  'at-the-heels': 1500,
  'mob-home': 1500,
  'mob-escaped': 1400,
  'brumby-added': 1300,
};
/** Each step of the marker is its own beat, so a trick that is worth three steps is seen as three. */
const MARKER_STEP_HOLD = 420;

/**
 * Frames for the events of ONE action, starting from `board` (what is on screen now).
 * A frame: { board, hold, kind, log?, logKind?, modal? }
 *   hold   ms to stay on the frame before the next one, BEFORE pacing scale (the UI multiplies);
 *          `Infinity` = wait for the player (a modal). 0 = go straight on.
 * ctx adds `names` (seat labels) and `trickText(trick, event, names)` for the log sentence,
 * `describe(ev, names)` for the other log lines.
 */
export function buildFrames(board, events, ctx) {
  const frames = [];
  let b = board;
  const push = (board2, extra) => { frames.push({ board: board2, hold: 0, kind: 'plain', ...extra }); b = board2; };
  events.forEach((ev) => {
    switch (ev.type) {
      case 'hand-started':
        push(reduceBoard(b, ev, ctx), { kind: 'deal', hold: 450, log: ctx.describe(ev, ctx.names), logKind: 'hand' });
        break;
      case 'card-played':
        push(reduceBoard(b, ev, ctx), { kind: 'card', hold: ev.auto ? 450 : 0 });
        break;
      case 'trick-won': {
        // Beat 1: all the cards are down and the winner is marked; beat 2: the trick is taken.
        const decided = copy(b);
        decided.trick.winner = ev.winner;
        decided.trick.winningCard = ev.card;
        decided.trick.done = true;
        decided.banner = { kind: 'trick', winner: ev.winner, card: ev.card, phase: ev.phase };
        push(decided, { kind: 'decided', hold: 1250 });
        const nb = reduceBoard(b, ev, ctx);
        push(nb, { kind: 'resolve', hold: 700, log: ctx.trickText(nb.last.trick, ev, ctx.names), logKind: 'trick' });
        break;
      }
      case 'hand-ended': {
        // Show the reckoning over the table as it stands, then move on.
        const modal = { kind: 'hand', handNo: ev.handNo, event: copy(ev) };
        push(copy(b), { kind: 'hand-end', hold: Infinity, modal });
        push(reduceBoard(b, ev, ctx), { kind: 'plain', hold: 0 });
        break;
      }
      case 'game-over':
        push(reduceBoard(b, ev, ctx), { kind: 'over', hold: 0, log: ctx.describe(ev, ctx.names), logKind: 'hand' });
        break;
      case 'marker-moved': {
        // One beat per step the marker takes (the base step, then one for each off-suit card), the last
        // beat carrying the log line. fx.marker.step / .of say which step this is; step 1 is the climb
        // trick itself, every later one is an off-suit step to call out.
        const steps = Math.max(1, ev.to - ev.from);
        for (let i = 1; i <= steps; i++) {
          const nb = reduceBoard(b, ev, ctx);
          nb.marker = ev.from + i;
          nb.fx.marker.step = i;
          nb.fx.marker.of = steps;
          const last = i === steps;
          push(nb, { kind: 'marker-moved', hold: last ? HOLDS['marker-moved'] : MARKER_STEP_HOLD, ...(last ? { log: ctx.describe(ev, ctx.names), logKind: 'event' } : {}) });
        }
        break;
      }
      default:
        if (HOLDS[ev.type] !== undefined) {
          push(reduceBoard(b, ev, ctx), { kind: ev.type, hold: HOLDS[ev.type], log: ctx.describe(ev, ctx.names), logKind: ev.type === 'summit-chosen' ? 'info' : 'event' });
        }
        break;
    }
  });
  return frames;
}
