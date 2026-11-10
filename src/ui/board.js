// board.js - the presentation model: what the table looks like, and how it changes event by event.
//
// One call of applyAction can play many forced moves, win the last climb trick, reach the summit,
// finish the descent, end the hand, deal the next one and even end the game. So the screen cannot
// simply draw `state` after each action: it would jump over the last trick of every hand. Instead the
// UI keeps a small "board" (everything that is drawn: the trick on the table, hand counts, the turn,
// the marker, the Brumby row, the kept piles, the discard, the summit choices as far as they are
// public, the pad) and walks the returned events over it, one frame per beat, so every trick, marker
// step, turn of the hands and reveal is seen.
//
//   boardFromState(state, humanSeats)    the board for a live state
//   reduceBoard(board, event, ctx)       the board after one engine event (a fresh copy)
//   buildFrames(board, events, ctx)      the frames to show, in order, for one action's events
//
// No rules live here: every number comes from an event (who won, where the marker went, the row, the
// scores). The one piece of presentation arithmetic is the order of a turned hand, which is the engine's
// own sortCards(hand, 'descent'). The board never holds an unrevealed summit choice: only `chosen`
// (locked in) until the reveal. tests/ui-node.mjs replays thousands of actions and requires that
// walking the events over the board before the action gives exactly boardFromState(state after the
// action). Pure and DOM-free.

import { sortCards } from '../engine/index.js';

const copy = (x) => JSON.parse(JSON.stringify(x));

/** Fields that only exist while a frame is on screen (excluded from the live-board equality test). */
export const TRANSIENT = ['fx', 'last', 'banner'];

/** The row slots already taken this hand: { seat, to: 'kept' | 'discard' } or null, parallel to `row`. */
function takenFromTricks(state) {
  if (!state.row.length) return [];
  const taken = state.row.map(() => null);
  for (const t of state.tricks) if (t.half === 'descent' && t.prize) taken[t.halfTrickNo - 1] = { seat: t.winner, to: t.prizeTo };
  return taken;
}

/**
 * @param {object} state        the live engine state
 * @param {number[]} humanSeats seats whose hand the UI may need to show (others get null)
 */
export function boardFromState(state, humanSeats = []) {
  const n = state.n;
  const P = state.params;
  let trick = null;
  if (state.trick) {
    const t = state.trick;
    trick = {
      n: t.n, half: t.half, halfTrickNo: t.halfTrickNo, phase: t.phase, leader: t.leader, seats: [...t.seats], ledSuit: t.ledSuit, trump: t.trump,
      plays: t.plays.map((p) => ({ seat: p.seat, card: p.card, offSuit: p.offSuit, trump: p.trump })),
      winner: null, winningCard: null, byTrump: false, done: false,
    };
  }
  return {
    n,
    handsPerGame: P.handsPerGame,
    climbTricksPerHand: P.climbTricks,
    chaseCost: P.chaseCost,
    handNo: state.handNo,
    handSize: P.handSize,
    phase: state.phase,
    dealer: state.dealer,
    toAct: state.toAct,
    trickNo: state.trickNo, // completed tricks this hand
    marker: state.marker, // climb tricks played, 0..6
    handsTurned: state.handsTurned,
    trump: state.handsTurned ? P.trumpDescent : P.trumpClimb,
    climbTricks: [...state.climbTricks],
    descentTricks: [...state.descentTricks],
    choiceOrder: [...state.choiceOrder],
    chosen: state.choices.map((c) => c !== null),
    choices: state.choices.map((c) => (state.revealed ? c : null)), // public only after the reveal
    revealed: state.revealed,
    row: [...state.row], // 6 slots once the summit opens, null = taken
    rowDealt: [...state.rowDealt],
    rowTaken: takenFromTricks(state),
    rowNext: state.row.length ? state.descentTrickNo : null, // 0-based position of the next prize
    kept: state.kept.map((k) => [...k]),
    discard: [...state.brumbyDiscard],
    deckCount: state.brumbyDeck.length,
    handCounts: state.hands.map((h) => h.length),
    totals: [...state.totals],
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
      b.handsTurned = false;
      b.trump = ev.trump;
      b.climbTricks = Array.from({ length: n }, () => 0);
      b.descentTricks = Array.from({ length: n }, () => 0);
      b.choiceOrder = [];
      b.chosen = Array.from({ length: n }, () => false);
      b.choices = Array.from({ length: n }, () => null);
      b.revealed = false;
      b.row = [];
      b.rowDealt = [];
      b.rowTaken = [];
      b.rowNext = null;
      b.kept = Array.from({ length: n }, () => []);
      b.deckCount = ev.deckCount;
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
          n: ev.trickNo, half: ev.half, halfTrickNo: ev.halfTrickNo, phase: ev.phase, leader: ev.seat, seats: Array.from({ length: n }, (_, k) => (ev.seat + k) % n), ledSuit: null, trump: b.trump, plays: [],
          winner: null, winningCard: null, byTrump: false, done: false,
        };
      }
      const t = b.trick;
      t.ledSuit = ev.ledSuit;
      t.plays.push({ seat: ev.seat, card: ev.card, offSuit: ev.offSuit, trump: ev.trump });
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
      b.trickNo = ev.trickNo;
      const decided = copy(t);
      decided.winner = ev.winner;
      decided.winningCard = ev.card;
      decided.byTrump = ev.byTrump;
      decided.done = true;
      b.last = { trick: decided, event: copy(ev) };
      b.fx = { won: ev.winner, phase: ev.phase };
      b.trick = null;
      b.toAct = ev.winner; // the winner leads next (or the summit follows: summit-opened sets it)
      return b;
    }
    case 'marker-moved':
      b.marker = ev.to;
      b.fx = { marker: { from: ev.from, to: ev.to, summit: ev.summit } };
      return b;
    case 'summit-opened':
      b.phase = 'summit';
      b.handsTurned = true;
      b.trump = ev.trump;
      b.hands = b.hands.map((h) => (h === null ? null : sortCards(h, 'descent')));
      b.row = [...ev.row];
      b.rowDealt = [...ev.row];
      b.rowTaken = ev.row.map(() => null);
      b.rowNext = 0;
      b.deckCount = ev.deckCount;
      b.choiceOrder = [...ev.order];
      b.chosen = Array.from({ length: n }, () => false);
      b.choices = Array.from({ length: n }, () => null);
      b.revealed = false;
      b.toAct = ev.order[0];
      b.banner = { kind: 'turn', row: [...ev.row], rowValue: ev.rowValue, colt: ev.colt, chaseCost: ev.chaseCost };
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
      b.banner = { kind: 'reveal', chasers: [...ev.chasers], watchers: [...ev.watchers], chaseCost: ev.chaseCost };
      return b;
    case 'descent-started':
      b.phase = 'descent';
      b.toAct = ev.leader;
      b.banner = { kind: 'descent', leader: ev.leader, chasers: [...ev.chasers] };
      return b;
    case 'brumby-kept': {
      const i = ev.position - 1;
      b.row[i] = null;
      b.rowTaken[i] = { seat: ev.winner, to: 'kept' };
      b.rowNext = ev.position;
      b.kept[ev.winner] = [...ev.kept];
      b.fx = { prize: { seat: ev.winner, to: 'kept', card: ev.card } };
      b.banner = { kind: 'prize', seat: ev.winner, to: 'kept', card: ev.card, value: ev.value };
      return b;
    }
    case 'brumby-discarded': {
      const i = ev.position - 1;
      b.row[i] = null;
      b.rowTaken[i] = { seat: ev.winner, to: 'discard' };
      b.rowNext = ev.position;
      b.discard.push(ev.card);
      b.fx = { prize: { seat: ev.winner, to: 'discard', card: ev.card } };
      b.banner = { kind: 'prize', seat: ev.winner, to: 'discard', card: ev.card, value: ev.value };
      return b;
    }
    case 'hand-ended': {
      b.totals = [...ev.totals];
      b.handNo = ev.handNo + 1;
      b.trick = null;
      b.toAct = null;
      for (let s = 0; s < n; s++) { b.discard.push(...b.kept[s]); b.kept[s] = []; } // the engine files every kept card, then any left in the row
      for (const id of b.row) if (id !== null) b.discard.push(id);
      b.row = [];
      b.rowTaken = [];
      b.rowNext = null;
      b.fx = { handEnded: true };
      return b;
    }
    case 'brumby-reshuffled':
      b.deckCount = ev.deckCount;
      b.discard = [];
      b.banner = { kind: 'reshuffle', deckCount: ev.deckCount };
      return b;
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
  'marker-moved': 600,
  'summit-opened': 2800, // the hands turn, the Mountain turns, the row is laid out
  'summit-chosen': 250,
  'summit-revealed': 2600, // the Chase and Watch cards face up
  'descent-started': 900,
  'brumby-kept': 1000,
  'brumby-discarded': 1000,
  'brumby-reshuffled': 900,
};

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
        decided.trick.byTrump = ev.byTrump;
        decided.trick.done = true;
        decided.banner = { kind: 'trick', winner: ev.winner, card: ev.card, phase: ev.phase, byTrump: ev.byTrump };
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
      default:
        if (HOLDS[ev.type] !== undefined) {
          push(reduceBoard(b, ev, ctx), { kind: ev.type, hold: HOLDS[ev.type], log: ctx.describe(ev, ctx.names), logKind: ev.type === 'summit-chosen' ? 'info' : 'event' });
        }
        break;
    }
  });
  return frames;
}
