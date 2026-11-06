// actions.js - applyAction (returns events).
//
// applyAction(state, action) mutates `state` and RETURNS the events it produced; nothing is
// logged into the state. It throws, before changing anything, if getActionBlockReason refuses.
//
// After the action, every decision that has exactly ONE legal option is applied at once and its
// events carry `auto: true` (R4.13): the only card of the led suit, the last card of a hand. The
// summit choice always has two options, so it is never auto-applied (R18.2). Hand ends and the next
// deal happen inside the same call, so one call can return the last trick, the reckoning, the next
// deal and even the game result. The UI walks those events (board.js).
//
// A completed trick (state.tricks, and handLog[h].tricks) is:
//   { n, phase: 'climb'|'descent', leader, seats, ledSuit, plays: [{ seat, card, offSuit }],
//     winner, winningCard, offSuit (count), markerFrom, markerTo (climb only, else null) }
//
// Event types, in the order they can occur (fields where each is pushed below):
//   game-started, hand-started, card-played, trick-won,
//   marker-moved (climb), summit-reached, summit-chosen (no side!), summit-revealed,
//   nobody-chased | descent-started, at-the-heels, mob-home | mob-escaped, brumby-added,
//   hand-ended, game-over

import { cardSuit } from './cards.js';
import { isCardPhase, getActionBlockReason, getValidActions, trickWinner } from './legality.js';
import { dealHand } from './state.js';
import { heelsOf, reckonHand, gameResult } from './scoring.js';

/**
 * Applies one action by state.toAct, then any forced (single-option) decisions.
 * @param {object} state
 * @param {object} action
 * @param {{silent?: boolean}} [opts]  silent: skip building events (search / simulator speed)
 * @returns {object[]} events (empty array when silent)
 */
export function applyAction(state, action, opts = {}) {
  const reason = getActionBlockReason(state, action);
  if (reason !== null) throw new Error(reason);
  const events = opts.silent ? null : [];
  doAction(state, action, events, false);
  runForced(state, events);
  return events || [];
}

/**
 * Applies single-option decisions until a real choice or the end. A card play by one of
 * state.manualSeats is left for that seat to make, even when it is the only legal card.
 */
function runForced(state, events) {
  const manual = state.manualSeats || [];
  while (state.toAct !== null) {
    if (isCardPhase(state.phase) && manual.includes(state.toAct)) return;
    const acts = getValidActions(state);
    if (acts.length !== 1) return;
    doAction(state, acts[0], events, true);
  }
}

function doAction(state, action, events, auto) {
  if (action.type === 'play') playCard(state, action.card, events, auto);
  else if (action.type === 'summit') chooseAtSummit(state, action.choice, events);
}

// ---------- card play ----------

function playCard(state, card, events, auto) {
  const seat = state.toAct;
  const n = state.n;
  if (state.trick === null) {
    state.trick = { n: state.trickNo + 1, phase: state.phase, leader: seat, seats: Array.from({ length: n }, (_, k) => (seat + k) % n), ledSuit: null, plays: [] };
  }
  const t = state.trick;
  state.hands[seat] = state.hands[seat].filter((c) => c !== card);
  const lead = t.ledSuit === null;
  if (lead) t.ledSuit = cardSuit(card);
  const offSuit = !lead && cardSuit(card) !== t.ledSuit;
  t.plays.push({ seat, card, offSuit });
  if (events) {
    events.push({ type: 'card-played', handNo: state.handNo, trickNo: t.n, phase: t.phase, seat, card, asLeader: t.plays.length === 1, setsSuit: lead, ledSuit: t.ledSuit, offSuit, auto });
  }
  const i = t.seats.indexOf(seat);
  if (i < t.seats.length - 1) {
    state.toAct = t.seats[i + 1];
    return;
  }
  resolveTrick(state, events);
}

function resolveTrick(state, events) {
  const t = state.trick;
  const m = state.measures;
  const P = state.params;
  const descent = t.phase === 'descent';
  const win = trickWinner(t.plays, t.ledSuit, descent); // R4.4 highest / R7.3 lowest of the led suit
  const w = win.seat;
  const offSuit = t.plays.filter((p) => p.offSuit).length;
  const record = {
    n: t.n, phase: t.phase, leader: t.leader, seats: [...t.seats], ledSuit: t.ledSuit,
    plays: t.plays.map((p) => ({ seat: p.seat, card: p.card, offSuit: p.offSuit })),
    winner: w, winningCard: win.card, offSuit, markerFrom: null, markerTo: null,
  };
  const cards = t.plays.map((p) => p.card);
  state.trick = null;
  state.trickNo++;
  m.tricks++;

  if (!descent) {
    // R4.6 the winner takes the trick to their climb pile; R4.7 the mob climbs.
    state.climbPiles[w].push(...cards);
    state.climbTricks[w]++;
    m.climbTricks++;
    const from = state.marker;
    const steps = P.markerStepBase + offSuit;
    const raw = from + steps;
    const to = Math.min(raw, P.summitStep); // R4.8 the marker stops at the summit
    state.marker = to;
    record.markerFrom = from;
    record.markerTo = to;
    m.offSuitSteps += offSuit;
    state.tricks.push(record);
    const climbsPlayed = state.trickNo;
    let reached = P.clock === 'fixed' ? climbsPlayed >= P.fixedSummitTrick : raw >= P.summitStep; // R4.9 (overshoot counts)
    // Guard for probe constants only: never let the climb use up the cards (R4.11 makes this
    // unreachable with the standard constants; the smoke test checks it never fires).
    let forced = false;
    if (!reached && state.hands[w].length <= 1) { reached = true; forced = true; }
    if (events) {
      events.push({ type: 'trick-won', handNo: state.handNo, trickNo: record.n, phase: 'climb', winner: w, card: win.card, ledSuit: record.ledSuit, plays: record.plays.map((p) => ({ ...p })), offSuit, climbTricks: [...state.climbTricks], descentTricks: [...state.descentTricks] });
      events.push({ type: 'marker-moved', handNo: state.handNo, trickNo: record.n, from, to, steps, base: P.markerStepBase, offSuit, summit: reached, overshoot: Math.max(0, raw - P.summitStep), forced, summitStep: P.summitStep });
    }
    if (reached) { enterSummit(state, w, forced, raw > P.summitStep, events); return; }
    state.leader = w; // the winner leads the next climb trick
    state.toAct = w;
    return;
  }

  // R7.4 / R7.5 the descent: the winner takes the trick to their descent pile and leads.
  state.descentPiles[w].push(...cards);
  state.descentTricks[w]++;
  state.lastDescentWin[w] = state.descentTrickNo;
  state.descentTrickNo++;
  m.descentTricks++;
  state.tricks.push(record);
  if (events) {
    events.push({ type: 'trick-won', handNo: state.handNo, trickNo: record.n, phase: 'descent', winner: w, card: win.card, ledSuit: record.ledSuit, plays: record.plays.map((p) => ({ ...p })), offSuit, climbTricks: [...state.climbTricks], descentTricks: [...state.descentTricks] });
  }
  if (state.hands.every((h) => h.length === 0)) { endHand(state, 'descent', events); return; } // R7.6
  state.leader = w;
  state.toAct = w;
}

// ---------- the summit ----------

/** R4.10 / R5.1: the climb is over; collect one secret choice per seat, starting with the next leader (R5.5). */
function enterSummit(state, lastWinner, forced, overshoot, events) {
  const n = state.n;
  const m = state.measures;
  state.phase = 'summit';
  state.summitTrick = state.trickNo;
  state.forcedSummit = forced;
  state.leader = lastWinner; // R7.1 the winner of the last climb trick leads the descent
  state.choices = Array.from({ length: n }, () => null);
  state.choiceOrder = Array.from({ length: n }, (_, k) => (lastWinner + k) % n);
  state.revealed = false;
  state.toAct = state.choiceOrder[0];
  m.summitTrickSum += state.summitTrick;
  if (forced) m.forcedSummits++;
  if (overshoot) m.overshoots++;
  if (events) {
    events.push({ type: 'summit-reached', handNo: state.handNo, trickNo: state.trickNo, summitTrick: state.summitTrick, marker: state.marker, summitStep: state.params.summitStep, climbTricks: [...state.climbTricks], mob: state.mob, order: [...state.choiceOrder], cardsLeft: state.hands[0].length, forced });
  }
}

function chooseAtSummit(state, choice, events) {
  const seat = state.toAct;
  state.choices[seat] = choice;
  const chosen = state.choices.filter((c) => c !== null).length;
  // The event names the seat but NEVER the side: it goes to every viewer (R5.2, R12.5).
  if (events) events.push({ type: 'summit-chosen', handNo: state.handNo, seat, chosen, of: state.n });
  const next = state.choiceOrder.find((s) => state.choices[s] === null);
  if (next !== undefined) { state.toAct = next; return; }
  revealChoices(state, events);
}

/** R5.6 every choice is shown at once; then nobody-chases (R6) or the descent (R7). */
function revealChoices(state, events) {
  const n = state.n;
  const m = state.measures;
  state.revealed = true;
  const chasers = [];
  const watchers = [];
  for (let s = 0; s < n; s++) (state.choices[s] === 'chase' ? chasers : watchers).push(s);
  m.chaserCounts[chasers.length]++;
  for (const s of chasers) m.chasesBySeat[s]++;
  if (events) events.push({ type: 'summit-revealed', handNo: state.handNo, choices: [...state.choices], chasers, watchers, climbTricks: [...state.climbTricks], mob: state.mob });
  if (chasers.length === 0) {
    m.nobodyChased++;
    // R6.1 / R6.2 the hand ends at once; cards still in hand are not played (or shown, R6.5).
    if (events) events.push({ type: 'nobody-chased', handNo: state.handNo, mob: state.mob, cardsLeft: state.hands[0].length });
    endHand(state, 'nobody-chases', events);
    return;
  }
  state.phase = 'descent';
  state.toAct = state.leader; // R7.1
  if (events) events.push({ type: 'descent-started', handNo: state.handNo, leader: state.leader, chasers, cardsLeft: state.hands[0].length });
}

// ---------- the end of a hand (R11.4) ----------

function endHand(state, reason, events) {
  const n = state.n;
  const m = state.measures;
  const P = state.params;
  state.phase = 'handEnd';
  state.toAct = null;

  // 1. the player at the mob's heels (descent hands only)
  let heels = null;
  let tieAtHeels = false;
  if (reason === 'descent') {
    const h = heelsOf(state.descentTricks, state.lastDescentWin);
    heels = h.seat;
    tieAtHeels = h.tie;
    if (tieAtHeels) m.tieAtHeels++;
    if (events) events.push({ type: 'at-the-heels', handNo: state.handNo, seat: heels, descentTricks: [...state.descentTricks], tied: h.tied, tie: h.tie, lastDescentWin: [...state.lastDescentWin], chased: state.choices[heels] === 'chase' });
  }

  // 2. the outcome
  const home = heels !== null && state.choices[heels] === 'chase' ? heels : null; // R8.4 / R8.5

  // 3. score every seat (R9)
  const rk = reckonHand(state, home);
  for (let s = 0; s < n; s++) state.totals[s] += rk.scores[s];
  const chaserSeats = state.choices.map((c, s) => (c === 'chase' ? s : -1)).filter((s) => s >= 0);
  const falls = rk.outcomes.filter((o) => o === 'fell').length;
  m.falls += falls;
  rk.outcomes.forEach((o, s) => { if (o === 'fell') m.fallsBySeat[s]++; });

  // 4. the Colt and the Brumby cards (R10)
  const brumbiesBefore = state.brumbies;
  let brumbyAdded = false;
  let brumbyAtCap = false;
  if (home !== null) {
    state.mobsHome[home]++;
    m.mobsHome++;
    m.mobsHomeBySeat[home]++;
    if (chaserSeats.length === 1) m.loneChaserHomes++;
    if (state.climbTricks[home] === Math.min(...state.climbTricks)) m.fewestClimbHomes++;
    state.brumbies = 0; // R10.4 the Brumby cards are returned
    if (events) events.push({ type: 'mob-home', handNo: state.handNo, seat: home, mob: state.mob, climbTricks: state.climbTricks[home], score: rk.scores[home], brumbiesReturned: brumbiesBefore });
  } else {
    m.escapes++;
    if (heels !== null) m.watcherAtHeels++;
    if (events) events.push({ type: 'mob-escaped', handNo: state.handNo, reason: heels === null ? 'nobody-chased' : 'watcher-at-heels', heels, mob: state.mob, fallen: chaserSeats });
    if (state.brumbies < P.brumbyMax) { state.brumbies++; brumbyAdded = true; m.brumbiesAdded++; } // R10.2
    else { brumbyAtCap = true; m.brumbyCapHits++; } // R10.3 an escape at the cap adds nothing
    if (events) events.push({ type: 'brumby-added', handNo: state.handNo, added: brumbyAdded, atCap: brumbyAtCap, brumbies: state.brumbies, nextMob: P.mobBase + P.brumbyValue * state.brumbies, lastHand: state.handNo + 1 >= P.handsPerGame });
  }

  // 5. the record (R9.7)
  const rec = {
    handNo: state.handNo,
    dealer: state.dealer,
    firstLeader: (state.dealer + 1) % n,
    handSize: state.handSize,
    summitStep: P.summitStep,
    mobValue: state.mob,
    brumbiesBefore,
    brumbiesAfter: state.brumbies,
    summitTrick: state.summitTrick,
    forcedSummit: state.forcedSummit,
    choices: [...state.choices],
    chasers: chaserSeats.length,
    chaserSeats,
    climbTricks: [...state.climbTricks],
    descentTricks: [...state.descentTricks],
    descentTricksPlayed: state.descentTrickNo,
    scores: rk.scores,
    outcomes: rk.outcomes,
    breakdown: rk.breakdown,
    heelsSeat: heels,
    tieAtHeels,
    broughtHomeBy: home,
    endReason: reason, // 'descent' | 'nobody-chases'
    brumbyAdded,
    brumbyAtCap,
    falls,
    totalsAfter: [...state.totals],
    tricks: state.tricks,
  };
  m.hands++;
  state.handLog.push(rec);
  state.tricks = [];
  if (events) {
    const { tricks, ...summary } = rec;
    events.push({ type: 'hand-ended', ...JSON.parse(JSON.stringify(summary)), totals: [...state.totals], mobsHome: [...state.mobsHome] });
  }

  // 6. next hand, or the end of the game
  state.handNo++;
  if (state.handNo >= P.handsPerGame) {
    state.phase = 'over';
    state.toAct = null;
    state.result = gameResult(state);
    if (events) events.push({ type: 'game-over', ...JSON.parse(JSON.stringify(state.result)) });
    return;
  }
  dealHand(state, events); // R13.3 everything gathered and reshuffled
}
