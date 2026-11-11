// main.js - the browser UI: landing/setup page, game screen, bot pacing, playback of what happened,
// pass-and-play cover, end panels, dialogs. All game flow lives in controller.js; the table model
// and its animation frames in board.js; the sentences in text.js; the markup in components.js and
// landing.js; the art in assets.js; bot decisions (in a Web Worker) in bot-driver.js.
//
// ---------------------------------------------------------------------------------------
// HOOKS (stats, analytics, bug reports). Each is called once at the right moment with one info
// object (see sessionInfo()); the call sites below are the only place game events leave this file.
// Each is wrapped by guard() so a failure in a hook can never reach the game. The hooks feed
// stats-store.js (local records), analytics.js (GA4, whitelisted anonymous params) and
// bug-report.js (action log).
//
//   onGameStart(info)      a game has been dealt (new game or Play again)
//   onTrickEnd(info)       a trick has been decided; info.event is the engine's trick-won event
//   onHandEnd(info)        a hand has ended; info.event is the engine's hand-ended event and
//                          info.record the state.handLog entry
//   onGameEnd(info)        the game is over; info.result is the engine's game result, and
//                          info.durationMs the time since onGameStart
//   onRulesOpened(source)  the How to play dialog opened ('dialog'); there is no rule book link any more, so
//                          'pdf' is never sent
//   onGameAbandoned(info)  a game that had started was left before it ended (Quit, Change setup)
//
//   There is no variant-change hook: Snowy River has no Playtest switches and rulesCode is always 'std'
//   (which means the v5 rules from the day the v5 game went live).
//
//   info (sessionInfo): { seed, players, seats: [{ type, name }], names, humanSeats, rules,
//     rulesCode, handNo, startedAt, state } where `state` is the live engine state: read-only.
//   v5 payloads: onTrickEnd info.event is the 'trick-won' event ({ handNo, trickNo, half, halfTrickNo, winner,
//     card, byTrump, trump, ledSuit, plays, climbTricks, descentTricks }); a descent trick is followed (not
//     announced by a hook) by 'brumby-kept' / 'brumby-discarded' in the log. onHandEnd info.event is the
//     'hand-ended' event and info.record the state.handLog entry ({ choices, chasers, chaserSeats, climbTricks,
//     descentTricks, trickCounts, kept, keptValues, costs, scores, breakdown, row, rowValues, rowValue, colt,
//     coltTrick, coltWinner, coltKept, topHomeSeat, reshuffled, totalsAfter, ... }). onGameEnd info.result is the
//     'game-over' event = gameResult() ({ totals, lastHandScores, winners, shared, tiebreakUsed, tiedOnTotal,
//     ranking [{ seat, total, lastHandScore, rank }], winningScore, margin, ... }) and info.state.measures the
//     game counters (chaserCounts, nobodyChased, chasesBySeat, keptValue, coltRows, coltKept, ...).
//
// Dialogs: the DIALOGS table below ('rules' and 'stats').
// The game's own motion: the marker walking up the Mountain one step per trick (board.js frames, then
// animateMarker() below glides it between two renders), the turn of the hands at the summit, the reveal,
// the Brumby row being taken card by card and the reckoning.
// ---------------------------------------------------------------------------------------

import { createController } from './controller.js';
import { botLevels } from '../bots/index.js';
import { describeEvent, getPlayBlockReason, isCardPhase } from '../engine/index.js';
import { GAME_NAME } from '../game-config.js';
import { loadManifest, installImageFallback } from './assets.js';
import { createBotDecider } from './bot-driver.js';
import { makeVm } from './viewmodel.js';
import { boardFromState, buildFrames } from './board.js';
import { trickSentence, previewText, handEndText } from './text.js';
import {
  esc, tableHtml, handBoxHtml, sideHtml, coverHtml, handSummaryHtml, gameEndHtml, endBarHtml, summitModalHtml, revealHtml, turnHtml,
} from './components.js';
import { statsStore, createRecorder, toCsv, toJson, exportFilename } from './stats-store.js';
import { statsHtml, statsButtonsHtml, download } from './stats-view.js';
import * as analytics from './analytics.js';
import { installBugReporter, logAction, logEvent } from './bug-report.js';
import {
  landingHtml, howToPlayHtml, syncSetupForm, readSetup, DEFAULT_SETUP, uniqueNames,
} from './landing.js';

if (/\{\{/.test(document.title)) document.title = GAME_NAME; // before the init tool has filled the page in

// ---------- hooks: local stats, analytics ----------
const guard = (fn) => (arg) => { try { fn(arg); } catch { /* a hook must never break the game */ } };
const recorder = createRecorder(statsStore);

export const onGameStart = guard((info) => { recorder.gameStart(info); analytics.trackGameStart(info); });
export const onTrickEnd = guard((info) => analytics.trackTrickEnd(info));
export const onHandEnd = guard((info) => analytics.trackHandEnd(info));
export const onGameEnd = guard((info) => { recorder.gameEnd(info); analytics.trackGameEnd(info); });
export const onRulesOpened = guard(() => analytics.trackRulesOpened());
export const onGameAbandoned = guard(() => analytics.trackGameAbandoned());
const onStatsOpened = guard(() => analytics.trackStatsViewed());

// ---------- state ----------
const params = new URLSearchParams(location.search);
const DEFAULT_DELAY = params.has('botdelay') ? Math.max(0, Math.min(5000, Number(params.get('botdelay')) || 0)) : 800;
let botDelay = DEFAULT_DELAY; // ~0.8 s per bot card; every pause in the playback scales with it
let seedCounter = params.has('seed') ? Number(params.get('seed')) || 1 : null;
const SPEEDS = [{ label: 'Normal', ms: DEFAULT_DELAY }, { label: 'Fast', ms: Math.round(DEFAULT_DELAY * 0.4) }, { label: 'Instant', ms: 0 }];
let speedIdx = 0;

const app = document.getElementById('app');
const dialogRoot = document.getElementById('dialog-root');
const live = document.getElementById('live');
const coarse = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;

let ctl = null; // the running session's controller, or null on the landing page
let sid = 0; // session counter
let lastSetup = DEFAULT_SETUP;
let setupMessage = '';
let pump = null; // { stamp, sid, cancelled }: the bot turn being played
let processedEvents = null;
let shownBoard = null; // the table as last shown (equals boardFromState once playback has finished)
let startedAt = 0;
let gameOverFired = false;
let logEntries = [];
const decider = createBotDecider();

const ui = {
  selected: null, // touch screens: the card tapped once
  preview: null, // the card whose hint is on show
  note: '', // refusal text under the hand
  endClosed: false, // "Look at the table" closed the end panel
  wantHandFocus: false,
  dialog: null, // a key of DIALOGS ('rules' | 'stats'), or null
  statsFilter: 'all', // the stats screen's rules_code filter
  opener: null,
  panels: {}, // details open/closed memory
  frame: null, // the playback frame being shown, or null for the live table
  modal: null, // the end-of-hand summary waiting for a click
  cache: { hints: new Map(), reasons: new Map(), board: null },
};

// ---------- playback: walking the events of one action over the table ----------
let queue = [];
let running = false;
let waiter = null;
let modalResolve = null;

function wait(ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); waiter = null; resolve(); };
    const timer = setTimeout(done, ms);
    waiter = { resolve: done };
  });
}
const wake = () => { if (waiter) waiter.resolve(); };

function modalWait(auto) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); modalResolve = null; resolve(); };
    const timer = auto === Infinity ? 0 : setTimeout(done, auto);
    modalResolve = done;
  });
}

function addLog(entry) {
  logEntries.push(entry);
  live.textContent = entry.text;
}

async function runPlayback() {
  if (running) return;
  running = true;
  const mySid = sid;
  while (queue.length && sid === mySid && ctl) {
    const f = queue.shift();
    if (f.log) addLog({ text: f.log, kind: f.logKind || 'info' });
    if (f.modal) addLog({ text: handEndText(f.modal.event, ctl.names), kind: 'hand' });
    if (f.hold > 0 || f.modal) {
      ui.frame = f;
      ui.modal = f.modal || null;
      render();
    }
    if (f.modal) {
      // A human reads the reckoning and clicks on; with only bots playing it moves on by itself.
      await modalWait(ctl.humanSeats.length ? Infinity : Math.max(600, 4500 * (botDelay / 800)));
      ui.modal = null;
    } else if (f.hold > 0 && botDelay > 0) {
      await wait(f.hold * (botDelay / 800));
    }
  }
  if (sid !== mySid || !ctl) { running = false; return; }
  ui.frame = null;
  ui.modal = null;
  // Back to the live table; resync from the state in case anything ever drifted.
  shownBoard = boardFromState(ctl.state, ctl.humanSeats);
  running = false;
  render();
}

function startPlayback(events) {
  const ctx = {
    names: ctl.names,
    describe: describeEvent,
    trickText: trickSentence,
    liveHands: (s) => ctl.state.hands[s],
  };
  const frames = buildFrames(shownBoard, events, ctx);
  if (frames.length) shownBoard = frames[frames.length - 1].board;
  queue.push(...frames);
  if (!running) runPlayback();
}

// ---------- sessions ----------
function freshSeed() {
  if (seedCounter !== null) return seedCounter++;
  return Math.floor(Math.random() * 2147483646) + 1; // the UI is the one place the clock-free page may draw a seed
}

function sessionInfo() {
  return {
    seed: ctl.seed,
    players: ctl.seats.length,
    seats: ctl.seats.map((s) => ({ type: s.type, name: s.name })),
    names: [...ctl.names],
    humanSeats: [...ctl.humanSeats],
    rules: { ...ctl.state.rules },
    rulesCode: ctl.state.rulesCode,
    handNo: ctl.state.handNo,
    startedAt,
    state: ctl.state,
  };
}

function resetPlayback() {
  queue = [];
  if (waiter) waiter.resolve();
  if (modalResolve) modalResolve();
  ui.frame = null;
  ui.modal = null;
}

function endSession() {
  if (ctl && !ctl.isFinished() && ctl.state.trickNo + ctl.state.handNo > 0) onGameAbandoned(sessionInfo());
  if (pump) pump.cancelled = true;
  pump = null;
  decider.cancelAll();
  sid += 1; // stops a running playback loop
  resetPlayback();
  running = false;
  ctl = null;
}

function startSession(setup) {
  endSession();
  const seats = setup.seats.slice(0, setup.players);
  const typed = uniqueNames(seats.map((s) => s.name));
  try {
    ctl = createController({
      seats: seats.map((s, i) => ({ type: s.type, name: typed[i] })),
      seed: freshSeed(),
      rules: {},
      autoPlayForced: !!setup.autoPlayForced,
    });
  } catch (err) {
    ctl = null;
    setupMessage = err.message;
    renderLanding(setup);
    return false;
  }
  lastSetup = setup;
  setupMessage = '';
  Object.assign(ui, { selected: null, preview: null, note: '', endClosed: false, wantHandFocus: false });
  logEntries = [];
  for (const l of ctl.log) logEntries.push({ text: l.text, kind: l.event.type === 'hand-started' ? 'hand' : 'info' });
  shownBoard = boardFromState(ctl.state, ctl.humanSeats);
  processedEvents = ctl.lastEvents;
  startedAt = Date.now();
  gameOverFired = false;
  ctl.subscribe(onChange);
  onGameStart(sessionInfo());
  window.scrollTo(0, 0); // the setup page is long: a game must open at its top, not where "Start game" was
  render();
  return true;
}

function onChange() {
  if (!ctl) return;
  if (ctl.lastEvents !== processedEvents) {
    processedEvents = ctl.lastEvents;
    ui.note = '';
    ui.selected = null;
    ui.preview = null;
    fireEventHooks(processedEvents);
    startPlayback(processedEvents);
    return;
  }
  render();
}

function fireEventHooks(events) {
  const info = sessionInfo();
  for (const ev of events) {
    logActionEvent(ev);
    if (ev.type === 'trick-won') onTrickEnd({ ...info, event: ev });
    else if (ev.type === 'hand-ended') onHandEnd({ ...info, event: ev, record: ctl.state.handLog[ev.handNo] });
    else if (ev.type === 'game-over' && !gameOverFired) {
      gameOverFired = true;
      onGameEnd({ ...info, result: ev, durationMs: Date.now() - startedAt });
    }
  }
}

/** Feeds the bug reporter's action log (cards and results, in order). */
function logActionEvent(ev) {
  try {
    const seatType = (s) => (ctl.seats[s] ? ctl.seats[s].type : null);
    if (ev.type === 'card-played') logAction({ kind: 'play', handNo: ev.handNo, trickNo: ev.trickNo, seat: ev.seat, seatType: seatType(ev.seat), card: ev.card, auto: !!ev.auto });
    else if (ev.type === 'trick-won') logAction({ kind: 'trick-won', handNo: ev.handNo, trickNo: ev.trickNo, seat: ev.winner, seatType: seatType(ev.winner), card: ev.card });
    else if (ev.type === 'summit-chosen') logAction({ kind: 'summit-chosen', handNo: ev.handNo, seat: ev.seat, seatType: seatType(ev.seat) });
    else if (ev.type === 'summit-revealed') logAction({ kind: 'summit-revealed', handNo: ev.handNo, choices: ev.choices });
    else if (ev.type === 'marker-moved') logAction({ kind: 'marker-moved', handNo: ev.handNo, trickNo: ev.trickNo, from: ev.from, to: ev.to });
    else if (ev.type === 'summit-opened') logAction({ kind: 'summit-opened', handNo: ev.handNo, row: ev.row, rowValue: ev.rowValue, chaseCost: ev.chaseCost });
    else if (ev.type === 'brumby-kept' || ev.type === 'brumby-discarded') logAction({ kind: ev.type, handNo: ev.handNo, trickNo: ev.trickNo, seat: ev.winner, card: ev.card, value: ev.value });
    else if (ev.type === 'hand-ended') logAction({ kind: 'hand-ended', handNo: ev.handNo, chasers: ev.chasers, scores: ev.scores, totals: ev.totals, rowValue: ev.rowValue });
  } catch { /* silent */ }
}

// ---------- landing ----------
function renderLanding(setup = lastSetup) {
  endSession();
  document.body.dataset.screen = 'landing';
  document.body.dataset.covered = '0';
  app.innerHTML = landingHtml(botLevels(), setup, setupMessage);
  const form = document.getElementById('setup-form');
  if (form) syncSetupForm(form);
  window.scrollTo(0, 0);
}

// ---------- game screen ----------
function buildVm() {
  const board = ui.frame ? ui.frame.board : shownBoard;
  const vm = makeVm({ ctl, ui, board, log: logEntries });
  ui.cache = { hints: vm.hints, reasons: vm.reasons, board };
  return vm;
}

function topbarHtml() {
  return `<div class="topbar"><button type="button" class="linkbtn" data-action="quit">&larr; Setup</button>
    <span class="topbar__title">${esc(GAME_NAME)}</span>
    <span class="topbar__right"><button type="button" class="linkbtn" data-action="speed" title="How fast bots play and tricks are shown">Speed: ${SPEEDS[speedIdx].label}</button><button type="button" class="linkbtn" data-action="open-rules">Rules</button></span></div>`;
}

function gameHtml(vm) {
  const over = vm.state.phase === 'over';
  const showEnd = over && !ui.frame && !ui.endClosed;
  const beat = ui.frame && ui.frame.board.banner ? ui.frame.board.banner.kind : null;
  let overlay = '';
  if (ui.modal) overlay = handSummaryHtml(vm, ui.modal);
  else if (beat === 'reveal') overlay = revealHtml(vm);
  else if (beat === 'turn') overlay = turnHtml(vm);
  else if (!ui.frame && vm.myTurn && vm.state.phase === 'summit') overlay = summitModalHtml(vm);
  else if (showEnd) overlay = gameEndHtml(vm);
  return `${topbarHtml()}
    <div class="game${over && ui.endClosed ? ' game--ended' : ''}" data-busy="${ui.frame ? 1 : 0}">
      ${over && ui.endClosed && !ui.frame ? endBarHtml(vm) : ''}
      <div class="col col--main">
        ${tableHtml(vm)}
        ${handBoxHtml(vm)}
      </div>
      ${sideHtml(vm)}
    </div>${overlay}`;
}

function render() {
  if (!ctl) return;
  document.body.dataset.screen = 'game';
  const st = ctl.state;
  const hadOverlay = overlayKey();
  const hadHandFocus = !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.hand, .decision'));

  if (!ui.frame && !ui.modal && ctl.needsHandoff() && st.phase !== 'over') {
    // Pass-and-play: no hand, trick or log stays in the DOM until the next human confirms.
    app.innerHTML = coverHtml({ names: ctl.names, phase: st.phase }, st.toAct);
    document.body.dataset.covered = '1';
    focusOverlay(hadOverlay);
    return;
  }

  document.body.dataset.covered = '0';
  const vm = buildVm();
  app.innerHTML = gameHtml(vm);
  animateMarker();
  refreshPreview();
  focusOverlay(hadOverlay);
  if (hadHandFocus && keyboardUser) ui.wantHandFocus = true;
  if ((hadHandFocus || ui.wantHandFocus) && vm.myTurn && !coarse) {
    const first = app.querySelector('.hand .card.is-legal, .decision .btn--primary');
    if (first) first.focus({ preventScroll: true });
    ui.wantHandFocus = false;
  }
  document.body.dataset.busy = ui.frame ? '1' : '0';
  if (!ui.frame) pumpBots();
}

/** Which overlay is up ('' for none): the turn beat, the summit modal, the reveal, a reckoning, the end, the cover. */
function overlayKey() {
  const o = app.querySelector('.overlay, .cover');
  return o ? (o.dataset.overlay || 'cover') : '';
}

function focusOverlay(hadOverlay) {
  // Keep the focus where it is while the same overlay is redrawn; a different overlay (the turn beat giving way to
  // the summit modal, say) takes the focus, or a keyboard user would be left on the page behind it.
  if (hadOverlay && hadOverlay === overlayKey()) return;
  // The summit modal has two equal choices: focus its heading, never a side.
  const btn = app.querySelector('.overlay [data-autofocus], .overlay .btn--primary, .cover .btn--primary');
  if (btn) btn.focus({ preventScroll: false });
}

// ---------- the marker climbing the Mountain ----------
// Every render replaces the DOM, so a CSS transition cannot run by itself: the new marker is first put
// where the last one stood, then moved to its step, and the transition does the rest. Only upward moves
// of the same Mountain are animated (a new hand starts again at step 0 without a ride down).
let lastMarker = null;
function animateMarker() {
  const el = app.querySelector('.mountain__marker');
  if (!el) { lastMarker = null; return; }
  const cur = { side: el.dataset.side, step: Number(el.dataset.step), left: el.style.left, top: el.style.top };
  if (lastMarker && lastMarker.side === cur.side && cur.step > lastMarker.step) {
    el.style.transition = 'none';
    el.style.left = lastMarker.left;
    el.style.top = lastMarker.top;
    void el.offsetWidth; // commit the starting position
    el.style.transition = '';
    el.style.left = cur.left;
    el.style.top = cur.top;
  }
  lastMarker = cur;
}

// ---------- hints (hover / focus / tap) ----------
const PREVIEW_HINT = coarse ? 'Tap a card to see what it would do. Tap it again to play it.' : 'Hover or focus a card to see what it would do.';

/** Fills the hint line under the hand without re-rendering the screen. */
function refreshPreview() {
  const text = app.querySelector('#preview');
  if (!text || !ctl) return;
  const { hints, reasons } = ui.cache;
  const card = ui.preview || ui.selected;
  let msg = '';
  if (card && reasons.has(card)) {
    const reason = reasons.get(card);
    if (reason) msg = reason;
    else msg = previewText(hints.get(card), ctl.names);
  } else if (reasons.size) msg = PREVIEW_HINT;
  text.textContent = msg;
  text.classList.toggle('preview--on', !!(card && msg));
  app.querySelectorAll('.hand .card.is-selected').forEach((el) => el.classList.remove('is-selected'));
  if (card && coarse) {
    const el = app.querySelector(`.hand .card[data-card="${card}"]`);
    if (el && ui.selected === card) el.classList.add('is-selected');
  }
}

function setPreview(card) {
  ui.preview = card;
  refreshPreview();
}

// ---------- playing ----------
function handleCard(card) {
  if (!ctl || ui.frame) return;
  const st = ctl.state;
  const seat = st.toAct;
  if (seat === null || !ctl.isHumanTurn() || !isCardPhase(st.phase)) return;
  if (ui.cache.reasons.size === 0) return;
  const reason = getPlayBlockReason(st, seat, card);
  if (reason) { ui.selected = null; ui.preview = null; ui.note = reason; logEvent('refused-click', reason); render(); return; }
  if (coarse && ui.selected !== card) { // first tap on a touch screen previews
    ui.selected = card;
    ui.note = '';
    refreshPreview();
    return;
  }
  const res = ctl.play({ type: 'play', card });
  if (!res.ok) { ui.note = res.error; render(); }
}

/** A decision that is not a card (Chase / Watch at the summit): the action arrives as JSON in data-decision (decisionHtml). */
function handleDecide(json) {
  if (!ctl || ui.frame) return;
  const st = ctl.state;
  if (st.toAct === null || !ctl.isHumanTurn()) return;
  let action;
  try { action = JSON.parse(json); } catch { return; }
  const res = ctl.play(action);
  if (!res.ok) { ui.note = res.error; render(); }
}

// ---------- bots ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pumpBots() {
  if (!ctl || ui.frame || running || !ctl.isBotTurn()) return;
  let task = ctl.botTask();
  if (pump && pump.sid === sid && pump.stamp === task.stamp && !pump.cancelled) return;
  if (pump) pump.cancelled = true;
  const me = ctl;
  const p = { stamp: task.stamp, sid, cancelled: false };
  pump = p;
  (async () => {
    let pace = sleep(botDelay); // ~0.8 s per bot decision, counted from the start of its turn
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await decider.decide(task);
      document.body.dataset.botMode = decider.mode;
      await pace;
      pace = Promise.resolve();
      if (p.cancelled || ctl !== me) return;
      const out = me.applyBotResult(task, result);
      if (out === 'stale') return;
      if (out) return; // applied: onChange started the playback and will ask for the next turn
      task = me.botTask(); // refused: ask again (the failure cap guarantees this ends)
      if (!task) return;
    }
  })();
}

// ---------- dialogs ----------
/** Dialog kinds: { title, body(): html, wide?, buttons?(): html }. */
const DIALOGS = {
  rules: { title: 'How to play', body: () => howToPlayHtml() },
  stats: { title: 'Stats', body: () => statsBody(), wide: true, buttons: () => statsButtonsHtml(hasStats()) },
};

function renderDialog() {
  const def = ui.dialog ? DIALOGS[ui.dialog] : null;
  if (!def) {
    dialogRoot.innerHTML = '';
    app.inert = false;
    if (ui.opener && ui.opener.isConnected) ui.opener.focus();
    ui.opener = null;
    return;
  }
  dialogRoot.innerHTML = `<div class="overlay overlay--dialog" data-overlay="dialog"><div class="dialog${def.wide ? ' dialog--wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
    <button type="button" class="dialog__close" data-action="close-dialog" aria-label="Close">&times;</button>
    <h2 id="dlg-title">${esc(def.title)}</h2>
    ${def.body()}
    <div class="dialog__buttons">${def.buttons ? def.buttons() : ''}<button type="button" class="btn btn--primary" data-action="close-dialog">Close</button></div>
  </div></div>`;
  app.inert = true;
  const close = dialogRoot.querySelector('.dialog__close');
  if (close) close.focus();
}

function openDialog(kind, opener) {
  ui.dialog = kind;
  ui.opener = opener || null;
  if (kind === 'stats') ui.statsFilter = 'all';
  renderDialog();
  if (kind === 'rules') onRulesOpened('dialog');
  else if (kind === 'stats') onStatsOpened();
}

// ---------- stats screen ----------
function hasStats() {
  try { return statsStore.load().games.length > 0; } catch { return false; }
}

function statsBody() {
  try { return statsHtml(statsStore.load(), ui.statsFilter); } catch { return '<p class="st__empty">The stats could not be shown.</p>'; }
}

function exportStats(format) {
  const data = statsStore.load();
  const ok = format === 'csv'
    ? download(exportFilename('csv'), toCsv(data.games), 'text/csv;charset=utf-8')
    : download(exportFilename('json'), toJson(data), 'application/json');
  if (ok) analytics.trackStatsExported();
}

function closeDialog() {
  ui.dialog = null;
  renderDialog();
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const overlay = e.target.closest && e.target.closest('[data-overlay="dialog"]');
  if (overlay && e.target === overlay) return closeDialog();
  if (ui.frame && !ui.modal && e.target.closest && e.target.closest('.stage, .overlay--reveal, .overlay--turn')) wake(); // click the table to skip a pause
  const el = e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  switch (action) {
    case 'play': handleCard(el.dataset.card); break;
    case 'decide': handleDecide(el.dataset.decision); break;
    case 'reveal': if (ctl) ctl.reveal(Number(el.dataset.seat)); break;
    case 'continue': if (modalResolve) modalResolve(); break;
    case 'again': startSession(lastSetup); break;
    case 'new': setupMessage = ''; renderLanding(lastSetup); break;
    case 'quit':
      if (ctl && !ctl.isFinished() && ctl.state.trickNo + ctl.state.handNo > 0 && typeof window.confirm === 'function' && !window.confirm('Leave this game and go back to setup? The game in progress will be lost.')) break;
      setupMessage = '';
      renderLanding(lastSetup);
      break;
    case 'review': ui.endClosed = true; render(); break;
    case 'show-end': ui.endClosed = false; render(); break;
    case 'speed':
      speedIdx = (speedIdx + 1) % SPEEDS.length;
      botDelay = SPEEDS[speedIdx].ms;
      wake();
      if (ctl) render();
      break;
    case 'open-rules': openDialog('rules', el); break;
    case 'open-stats': openDialog('stats', el); break;
    case 'export-csv': exportStats('csv'); break;
    case 'export-json': exportStats('json'); break;
    case 'clear-stats':
      if (window.confirm('Delete all saved results from this browser? This cannot be undone.')) { statsStore.clear(); ui.statsFilter = 'all'; renderDialog(); }
      break;
    case 'close-dialog': closeDialog(); break;
    default: break;
  }
});

app.addEventListener('submit', (e) => {
  if (e.target.id !== 'setup-form') return;
  e.preventDefault();
  setupMessage = '';
  startSession(readSetup(e.target));
});

app.addEventListener('change', (e) => {
  const form = e.target.closest && e.target.closest('#setup-form');
  if (!form) return;
  syncSetupForm(form);
  lastSetup = readSetup(form);
});

// The stats screen's rules filter lives in the dialog, outside #app.
dialogRoot.addEventListener('change', (e) => {
  if (!e.target.matches || !e.target.matches('[data-action="stats-filter"]')) return;
  ui.statsFilter = e.target.value;
  renderDialog();
  const sel = dialogRoot.querySelector('[data-action="stats-filter"]');
  if (sel) sel.focus();
});

// Remember which side panels the player opened or closed (a re-render must not undo it).
app.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d && d.dataset && d.dataset.panel) ui.panels[d.dataset.panel] = d.open;
}, true);

// Hints: pointer hover (mouse/pen only; touch uses tap-to-select) and keyboard focus.
app.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  if (card && card.dataset.card !== ui.preview) setPreview(card.dataset.card);
});
app.addEventListener('pointerout', (e) => {
  if (e.pointerType === 'touch') return;
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  if (!card) return;
  const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.hand .card[data-card]');
  if (!to) setPreview(null);
});
app.addEventListener('focusin', (e) => {
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  if (!card) ui.wantHandFocus = false;
  if (card) setPreview(card.dataset.card);
});
app.addEventListener('focusout', (e) => {
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.hand .card[data-card]');
  if (card && !to) setPreview(null);
});

// True while the last input was the keyboard (so a re-render may hand focus back to the hand).
let keyboardUser = false;
document.addEventListener('pointerdown', () => { keyboardUser = false; ui.wantHandFocus = false; }, true);
document.addEventListener('keydown', (e) => {
  keyboardUser = true;
  if (e.key === 'Escape' && ui.dialog) return closeDialog();
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  if (card && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    const all = [...app.querySelectorAll('.hand .card[data-card]')];
    const i = all.indexOf(card);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
    if (all[j]) { e.preventDefault(); all[j].focus(); }
    return;
  }
  // Keep Tab inside whichever modal is open.
  if (e.key === 'Tab') {
    const modal = dialogRoot.querySelector('.dialog') || app.querySelector('.overlay .end, .cover');
    if (!modal) return;
    const f = [...modal.querySelectorAll('button, a[href], input, select')].filter((x) => !x.disabled);
    if (!f.length) return;
    const first = f[0];
    const lastEl = f[f.length - 1];
    if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
  }
});

// ---------- start ----------
analytics.installAbandonTracking();
installBugReporter(() => ({ ctl, screen: document.body.dataset.screen || null }));
installImageFallback();
loadManifest().then(() => {
  document.body.dataset.ready = '1';
  renderLanding(DEFAULT_SETUP);
});
