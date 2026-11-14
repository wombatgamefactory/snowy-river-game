// components.js - HTML string builders for the game screen: the half banner (direction and trumps), seats (the hand
// score so far and the Climb and Brumby cards each seat has taken), the Climb row, the Brumby row, the current trick,
// the hand, the beat at the summit, the score pad, the log and the overlays (the pass-and-play cover, the reckoning
// at the end of a hand, the end of the game). Pure string functions of a view-model `vm` built in main.js; no DOM
// access, no game logic: every number comes from the board (events) or the engine.
//
// v6 rules: highest wins on the climb (Escape is trumps) and every climb trick takes the next Climb card (+1, or the
// one -1); at the summit the Climb row is empty, lowest wins and Home is trumps, and every descent trick takes the next
// Brumby card. The score is the cards you took. There is no choice and no turning of the hand.
//
// vm = { board, names, types, humanSeats, me, shown, hand, half, reasons, hints, myTurn, view,
//        ui, log, state (read-only: handLog, result, params), frame (the playback frame or null) }

import { SUIT_NAMES, cardSuit, cardName, isCardPhase, rowCardValue, rowCardName } from '../engine/index.js';
import { esc, img, cardImg, cardBackImg, brumbyImg, brumbyBackImg, climbImg, climbBackImg, badgeImg, avatarId } from './assets.js';
import { turnPrompt, waitingText, tiebreakText, phaseParts, phaseNote, bannerText, winnerBanner, rowSentence } from './text.js';
import { halfOf } from './board.js';

export { esc };

const youName = (n) => n === 'You';
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const signed = (x) => (x > 0 ? `+${x}` : `${x}`);
const sum = (ids) => ids.reduce((a, id) => a + rowCardValue(id), 0);
const tone = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : 'zero');
const trumpOf = (b) => (halfOf(b) === 'descent' ? b.trumpDescent : b.trumpClimb);
/** The hand score so far: the Climb cards and Brumby cards a seat has taken (R7.1). */
export const handScoreOf = (b, s) => sum(b.climbCards[s]) + sum(b.kept[s]);

export function typeLabel(type) {
  if (type === 'human') return 'Human';
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} bot`;
}

function badge(vm, s) {
  const t = vm.types[s];
  return `<span class="badge badge--${t === 'human' ? 'human' : 'bot'}">${esc(typeLabel(t))}</span>`;
}

function avatar(s, cls = 'seat__avatar') {
  return img(avatarId(s), { cls, alt: '', label: '', w: 96, h: 96, fallback: `<span class="${esc(cls)} avatar-chip avatar-chip--${(s % 5) + 1}" aria-hidden="true">${s + 1}</span>` });
}

// ---------- seats ----------

/** The Climb cards or Brumby cards a seat has taken, face up in a small fan, with their sum. */
function takenHtml(label, ids, imgFn, cls, bump) {
  const fan = ids.length
    ? `<span class="taken__fan" style="--k:${ids.length}">${ids.map((id, i) => `<span class="taken__card${bump && i === ids.length - 1 ? ' is-new' : ''}" style="--i:${i}" title="${esc(`${rowCardName(id)} (${signed(rowCardValue(id))})`)}">${imgFn(id, 'taken__img')}</span>`).join('')}</span>`
    : '<span class="taken__none">none yet</span>';
  const total = sum(ids);
  return `<div class="taken taken--${cls}${bump ? ' fx-bump' : ''}" aria-label="${esc(`${label} cards taken: ${ids.length ? ids.map(rowCardName).join(', ') : 'none yet'}`)}"><span class="taken__head"><span class="taken__label">${esc(label)}</span><b class="taken__sum taken__sum--${tone(total)}">${ids.length ? signed(total) : '0'}</b></span>${fan}</div>`;
}

export function seatHtml(vm, s, area) {
  const b = vm.board;
  const name = vm.names[s];
  const toAct = b.toAct === s && b.phase !== 'over';
  const tags = [];
  if (b.phase !== 'over' && b.dealer === s) tags.push('<span class="tag tag--dealer" title="Dealer this hand">Dealer</span>');
  if (toAct) tags.push(`<span class="tag tag--turn">${vm.types[s] === 'human' && vm.humanSeats.length === 1 ? 'Your turn' : 'To play'}</span>`);
  const cards = b.handCounts[s];
  const winning = b.trick && b.trick.winner === s;
  const prize = b.fx && b.fx.prize && b.fx.prize.seat === s ? b.fx.prize.half : null;
  const score = handScoreOf(b, s);
  return `<article class="seat area-${area}${toAct ? ' is-turn' : ''}${winning ? ' is-winning' : ''}" data-seat="${s}" aria-label="${esc(name)}">
    <header class="seat__head">
      ${avatar(s)}
      <div class="seat__id"><b class="seat__name">${esc(name)}</b>${badge(vm, s)}<span class="seat__hand" title="Cards in hand" aria-label="${plural(cards, 'card', 'cards')} in hand"><b class="seat__cardsnum" data-cards="${s}">${cards}</b> ${cards === 1 ? 'card' : 'cards'}</span></div>
    </header>
    ${tags.length ? `<div class="seat__tags">${tags.join('')}</div>` : ''}
    <div class="seat__score">
      <span class="hscore${prize ? ' fx-bump' : ''}" title="The Climb cards and Brumby cards ${esc(youName(name) ? 'you have' : `${name} has`)} taken this hand"><span class="hscore__label">Hand score</span><b class="hscore__num hscore__num--${tone(score)}" data-hand-score="${s}">${signed(score)}</b></span>
      <span class="total" title="Total over finished hands">Total <b>${b.totals[s]}</b></span>
    </div>
    ${takenHtml('Climb cards', b.climbCards[s], climbImg, 'climb', prize === 'climb')}
    ${takenHtml('Brumby cards', b.kept[s], brumbyImg, 'brumby', prize === 'descent')}
  </article>`;
}

// ---------- the table: half banner, opponents, the stage, my seat ----------

export function tableHtml(vm) {
  const n = vm.board.n;
  const seats = [];
  for (let k = 0; k < n; k++) {
    const s = (vm.me + k) % n;
    seats.push(seatHtml(vm, s, k === 0 ? 'me' : `r${k}`));
  }
  return `<div class="table" data-n="${n}">
    ${statusHtml(vm)}
    <div class="opps" data-opp="${n - 1}">${seats.slice(1).join('')}</div>
    <div class="stage">
      <div class="stage__climb">${climbRowHtml(vm)}</div>
      <div class="stage__row">${rowHtml(vm)}</div>
      <div class="stage__trick">${trickHtml(vm)}</div>
    </div>
    ${seats[0]}
  </div>`;
}

// ---------- status: the half banner (direction and trumps) and what to do now ----------

/**
 * The ride: six climb steps, the summit, six descent steps. It shows where the hand is and where the switch happens.
 * `done` = tricks completed this hand (0..12).
 */
function rideHtml(b) {
  const done = b.trickNo;
  const items = [];
  for (let i = 0; i < 12; i++) {
    if (i === 6) items.push('<li class="ride__summit" title="The summit: after the sixth trick the lowest card wins and Home is trumps"><span aria-hidden="true">&#9650;</span><b>Summit</b></li>');
    const half = i < 6 ? 'climb' : 'descent';
    const state = i < done ? 'is-done' : (i === done && b.phase !== 'over' ? 'is-now' : '');
    items.push(`<li class="ride__step ride__step--${half} ${state}" aria-label="${half === 'climb' ? 'Climb' : 'Descent'} trick ${(i % 6) + 1}${state === 'is-done' ? ', played' : state === 'is-now' ? ', now' : ''}">${(i % 6) + 1}</li>`);
  }
  return `<ol class="ride" aria-label="Twelve tricks: six up the mountain, the summit, six down">${items.join('')}</ol>`;
}

export function statusHtml(vm) {
  const b = vm.board;
  const names = vm.names;
  let head;
  if (b.phase === 'over') head = '<div class="phasebar phasebar--over" role="status"><span class="phasebar__name">Game over</span></div>';
  else {
    const half = halfOf(b);
    const p = phaseParts(b.phase);
    const trump = trumpOf(b);
    const icon = badgeImg(trump, 'phasebar__badge');
    const meta = `Hand ${Math.min(b.handNo + 1, b.handsPerGame)} of ${b.handsPerGame} &middot; Dealer: ${esc(names[b.dealer])}`;
    head = `<div class="phasebar phasebar--${half}" role="status" aria-label="${esc(`${p.name}: ${p.rule}. ${SUIT_NAMES[trump]} is trumps.`)}">${icon}<span class="phasebar__name">${esc(p.name)}</span><span class="phasebar__rule">${esc(p.rule)}</span><strong class="phasebar__range">${esc(phaseNote(b.phase, trump))}</strong>${rideHtml(b)}<small class="phasebar__meta">${meta}</small></div>`;
  }
  let prompt = '';
  if (vm.frame && b.banner && b.banner.kind !== 'trick') prompt = bannerText(b.banner, names);
  else if (vm.myTurn && vm.view && !vm.frame) prompt = turnPrompt(vm.view);
  else prompt = waitingText(b, names, vm.types);
  return `<div class="status">${head}<p class="status__prompt" id="prompt">${esc(prompt)}</p></div>`;
}

// ---------- the Climb row and the Brumby row ----------

/** One slot of a row: the card face up with its value under it, a placeholder face down, or who took it. */
function slotHtml(vm, { i, kind, id, taken, dealtId, next, fresh }) {
  const imgFn = kind === 'climb' ? climbImg : brumbyImg;
  const valueOf = (x) => rowCardValue(x);
  const label = kind === 'climb' ? 'Climb card' : 'Brumby card';
  if (id) {
    const v = valueOf(id);
    const colt = id === 'colt';
    return `<li class="rslot rslot--${kind}${next ? ' is-next' : ''}${fresh ? ' is-new' : ''}${colt ? ' is-colt' : ''}${v < 0 ? ' is-bad' : ''}" data-pos="${i + 1}" aria-label="${esc(`${label} ${i + 1}: ${rowCardName(id)}${next ? ', the prize for the next trick' : ''}`)}"><span class="rslot__n">${i + 1}</span><span class="rslot__card">${imgFn(id, 'rslot__img')}</span><b class="rslot__val rslot__val--${tone(v)}">${signed(v)}</b></li>`;
  }
  const who = taken ? vm.names[taken.seat] : '';
  const v = dealtId ? valueOf(dealtId) : null;
  const what = dealtId ? rowCardName(dealtId) : label;
  return `<li class="rslot rslot--${kind} is-taken" data-pos="${i + 1}" title="${esc(taken ? `${what}: taken by ${who}` : '')}" aria-label="${esc(`${label} ${i + 1} taken: ${taken ? `${what}, by ${who}` : ''}`)}"><span class="rslot__n">${i + 1}</span><span class="rslot__gone" data-seat="${taken ? taken.seat : ''}">${taken ? avatar(taken.seat, 'rslot__avatar') : ''}</span>${v === null ? '' : `<b class="rslot__val rslot__val--${tone(v)}">${signed(v)}</b>`}</li>`;
}

/** The six Climb cards of this hand, face up from the deal; the next card to be won is lit; taken slots show who has it. */
export function climbRowHtml(vm) {
  const b = vm.board;
  const dealt = b.climbRowDealt.length > 0;
  const fresh = !!(b.fx && b.fx.prize && b.fx.prize.half === 'climb');
  const slots = Array.from({ length: b.climbTricksPerHand }, (_, i) => {
    if (!dealt) return `<li class="rslot rslot--climb rslot--down"><span class="rslot__n">${i + 1}</span><span class="rslot__card">${climbBackImg('rslot__img')}</span></li>`;
    const id = b.climbRow[i];
    const next = b.climbNext === i && b.phase === 'climb';
    return slotHtml(vm, { i, kind: 'climb', id, taken: b.climbTaken[i], dealtId: b.climbRowDealt[i], next, fresh: next && (fresh || (b.banner && b.banner.kind === 'deal')) });
  }).join('');
  let line;
  const minus = b.climbRowDealt.findIndex((id) => rowCardValue(id) < 0);
  if (!dealt) line = '';
  else if (b.phase === 'climb') line = b.climbNext === null ? 'The Climb row is empty.' : `Climb trick ${b.climbNext + 1} takes ${rowCardName(b.climbRowDealt[b.climbNext])}.${minus >= 0 && minus > b.climbNext ? ` The -1 card is on trick ${minus + 1}.` : ''}`;
  else line = 'The Climb row is empty: all six taken. That is the summit.';
  return `<div class="row row--climb" aria-label="The Climb row">
    <p class="row__title">The Climb row <small class="row__rule">${b.phase === 'climb' ? 'highest wins' : 'won on the way up'} &middot; ${badgeImg(b.trumpClimb, 'row__badge')}${esc(SUIT_NAMES[b.trumpClimb])} ${b.phase === 'climb' ? 'trumps' : 'was trumps'}</small></p>
    <ol class="row__slots row__slots--climb">${slots}</ol>
    <p class="row__line" id="climb-line">${esc(line)}</p>
  </div>`;
}

/** The six Brumby cards of this hand, face up from the summit; the next card to be won is lit; taken slots show who has it. */
export function rowHtml(vm) {
  const b = vm.board;
  const dealt = b.row.length > 0;
  const fresh = !!((b.fx && b.fx.prize && b.fx.prize.half === 'descent') || (b.banner && b.banner.kind === 'summit'));
  const slots = Array.from({ length: b.descentTricksPerHand }, (_, i) => {
    if (!dealt) return `<li class="rslot rslot--brumby rslot--down" aria-label="Brumby card ${i + 1}, face down in the deck"><span class="rslot__n">${i + 1}</span><span class="rslot__card">${brumbyBackImg('rslot__img')}</span></li>`;
    const id = b.row[i];
    const next = b.rowNext === i && b.phase === 'descent';
    return slotHtml(vm, { i, kind: 'brumby', id, taken: b.rowTaken[i], dealtId: b.rowDealt[i], next, fresh: next && fresh });
  }).join('');
  const total = sum(b.rowDealt);
  const left = sum(b.row.filter(Boolean));
  const taken = b.row.filter((x) => x === null).length;
  let line;
  if (!dealt) line = 'Dealt at the summit: six Brumby cards, one for each descent trick.';
  else line = taken >= b.row.length ? `All six taken. The row was worth ${signed(total)}.` : `Row worth ${signed(total)}; ${signed(left)} still to win.${b.rowDealt.includes('colt') && b.row.includes('colt') ? ' The Colt is in it.' : ''}`;
  const discard = b.discard.length
    ? `<details class="row__discard" data-panel="discard"${vm.ui.panels.discard ? ' open' : ''}><summary>Discard <b>${b.discard.length}</b></summary><span class="row__thumbs">${b.discard.map((id) => `<span class="row__thumb" title="${esc(rowCardName(id))}">${brumbyImg(id, 'row__thumbimg')}</span>`).join('')}</span></details>`
    : '<span class="row__pile">Discard <b>0</b></span>';
  return `<div class="row row--brumby" aria-label="The Brumby row">
    <p class="row__title">The Brumby row <small class="row__rule">lowest wins &middot; ${badgeImg(b.trumpDescent, 'row__badge')}${esc(SUIT_NAMES[b.trumpDescent])} trumps</small></p>
    <ol class="row__slots row__slots--brumby${dealt ? '' : ' is-down'}">${slots}</ol>
    <p class="row__line" id="row-line">${esc(line)}</p>
    <div class="row__piles"><span class="row__pile">Deck <b>${b.deckCount}</b></span>${discard}</div>
  </div>`;
}

// ---------- the current trick ----------

/** The row card the trick of this half-number takes, from the board (null when none). */
function prizeOf(b, half, halfNo) {
  const dealt = half === 'descent' ? b.rowDealt : b.climbRowDealt;
  return dealt[halfNo - 1] || null;
}

export function trickHtml(vm) {
  const b = vm.board;
  const names = vm.names;
  const t = b.trick;
  const startSeat = t ? t.leader : (b.toAct !== null ? b.toAct : 0);
  const order = t ? t.seats : Array.from({ length: b.n }, (_, k) => (startSeat + k) % b.n);
  const slots = order.map((s) => {
    const idx = t ? t.plays.findIndex((x) => x.seat === s) : -1;
    const p = idx >= 0 ? t.plays[idx] : null;
    if (!p) return `<li class="tplay tplay--empty"><span class="tplay__slot"></span><span class="tplay__who">${esc(names[s])}</span></li>`;
    const win = t.winner === s;
    const tags = [];
    if (idx === 0) tags.push('led');
    if (p.trump && p.offSuit) tags.push('trumps');
    else if (p.trump) tags.push('trump');
    else if (p.offSuit) tags.push('off-suit');
    if (win) tags.push('wins');
    const titles = { 'off-suit': 'Off-suit: it cannot win this trick', trumps: 'A trump played on another suit: it beats every card of the suit led', trump: 'A trump card' };
    return `<li class="tplay${win ? ' is-winner' : ''}${p.offSuit && !p.trump ? ' is-offsuit' : ''}${t.winner !== null && !win ? ' is-lost' : ''}"><span class="tplay__card">${cardImg(p.card, { alt: cardName(p.card) })}</span><span class="tplay__who">${esc(names[s])}</span><span class="tplay__tags">${tags.map((x) => `<i class="mark mark--${x}"${titles[x] ? ` title="${titles[x]}"` : ''}>${x}</i>`).join('')}</span></li>`;
  }).join('');
  const half = t ? t.half : halfOf(b);
  const halfNo = t ? t.halfTrickNo : Math.min((half === 'descent' ? (b.rowNext === null ? 6 : b.rowNext) : (b.climbNext === null ? 5 : b.climbNext)) + 1, 6);
  const halfName = half === 'descent' ? 'Descent' : 'Climb';
  const prize = b.phase === 'over' ? null : prizeOf(b, half, halfNo);
  const prizeChip = prize ? ` <span class="prize prize--${tone(rowCardValue(prize))}" title="${esc(`This trick takes ${rowCardName(prize)}`)}">takes ${signed(rowCardValue(prize))}</span>` : '';
  let title;
  if (t && t.ledSuit) title = `${halfName} trick ${halfNo} of 6 &middot; <span class="led led--${t.ledSuit}">${badgeImg(t.ledSuit, 'led__badge')}${esc(`${SUIT_NAMES[t.ledSuit]} led`)}</span>${prizeChip}`;
  else title = `${halfName} trick ${halfNo} of 6${prizeChip}`;
  let banner = b.banner && b.banner.kind === 'trick' ? b.banner : null;
  if (!banner && t && t.done) banner = { winner: t.winner, card: t.winningCard, phase: t.half, byTrump: t.byTrump };
  let msg = '';
  if (banner) msg = winnerBanner(banner, names);
  else if (b.phase === 'over') msg = '';
  else if (!t) msg = b.toAct !== null ? `${names[b.toAct]} ${youName(names[b.toAct]) ? 'lead' : 'leads'} the next trick.` : '';
  if (b.phase === 'over') return '<div class="trick"><p class="trick__title">Game over</p></div>';
  return `<div class="trick trick--${esc(half)}"><p class="trick__title">${title}</p><ol class="tplays">${slots}</ol><p class="trick__msg${banner ? ' is-banner' : ''}" id="trick-msg">${esc(msg)}</p></div>`;
}

// ---------- the hand ----------

export function handHtml(vm) {
  const hand = vm.hand;
  if (!hand) return '';
  const playing = vm.myTurn && isCardPhase(vm.state.phase);
  const trump = trumpOf(vm.board);
  const items = hand.map((card, i) => {
    const reason = vm.reasons.get(card) || null;
    const hint = vm.hints.get(card) || null;
    const legal = playing && !reason;
    const suit = cardSuit(card);
    const cls = ['card', `card--${suit}`];
    if (suit === trump) cls.push('is-trump');
    if (!playing) cls.push('is-wait');
    else if (legal) cls.push('is-legal'); else cls.push('is-blocked');
    if (i === 0 || cardSuit(hand[i - 1]) !== suit) cls.push('is-first');
    if (vm.ui.selected === card) cls.push('is-selected');
    let mark = '';
    if (legal && hint && hint.kind === 'follow') mark = `<span class="card__hint ${hint.wins ? 'is-win' : 'is-lose'}" aria-hidden="true">${hint.wins ? '&#10003;' : '&#10007;'}</span>`;
    const title = !playing ? `${cardName(card)}: wait for your turn` : (reason || `Play ${cardName(card)}`);
    const hintSr = legal && hint && hint.kind === 'follow' ? (hint.wins ? ' (would win the trick as it stands)' : ' (would not win)') : '';
    return `<button type="button" class="${cls.join(' ')}" data-action="play" data-card="${card}" title="${esc(title)}" aria-label="${esc(cardName(card) + hintSr)}"${legal ? '' : ' aria-disabled="true"'}>${cardImg(card)}${mark}</button>`;
  }).join('');
  return `<div class="hand" role="group" aria-label="Your hand, sorted by suit">${items}</div>`;
}

export function handBoxHtml(vm) {
  const who = vm.humanSeats.length > 1 ? `${esc(vm.names[vm.shown])}'s hand` : 'Your hand';
  if (vm.hand === null) {
    // Pass-and-play and it is not this human's decision (or nobody is human): never show a hand.
    if (vm.humanSeats.length === 0) return '';
    return `<div class="handbox handbox--hidden"><p class="handbox__title">Hands are hidden</p>${cardBackImg('handbox__back')}</div>`;
  }
  const playing = vm.myTurn && isCardPhase(vm.state.phase);
  const half = halfOf(vm.board);
  const trumpName = SUIT_NAMES[trumpOf(vm.board)];
  const dir = half === 'descent' ? 'lowest' : 'highest';
  const legend = playing && vm.view.trick && vm.view.trick.ledSuit
    ? `<p class="legend"><span class="hint-dot is-win">&#10003;</span> would win the trick as it stands (any ${esc(trumpName)} beats the other suits, then the ${dir} of the suit led) <span class="hint-dot is-lose">&#10007;</span> would not. Dimmed cards cannot be played: hover or tap one to see why.</p>`
    : (playing ? `<p class="legend">You lead: play any card. ${esc(trumpName)} is trumps (the gold line under a card) and the ${dir} card wins. Dimmed cards cannot be played: hover or tap one to see why.</p>` : '');
  const title = `${who} <span>${half === 'descent' ? 'lowest wins' : 'highest wins'} &middot; ${esc(trumpName)} is trumps &middot; sorted by suit</span>`;
  return `<div class="handbox${vm.myTurn ? ' is-turn' : ''}">
    <p class="handbox__title">${title}</p>
    <div class="hand-wrap">${handHtml(vm)}</div>
    ${legend}
    <p class="preview" id="preview" aria-live="polite"></p>
    <p class="note" id="note" role="status">${esc(vm.ui.note || '')}</p>
  </div>`;
}

// ---------- the summit ----------

/** The Brumby row as a strip of small cards, with the value under each. */
function rowStrip(ids, cls = 'summit__row') {
  return `<ol class="${cls}" aria-label="The Brumby row, left to right">${ids.map((id, i) => `<li class="${id === 'colt' ? 'is-colt' : ''}"><span class="rslot__n">${i + 1}</span><span class="rslot__card">${brumbyImg(id, 'summit__brumby')}</span><b class="rslot__val rslot__val--${tone(rowCardValue(id))}">${signed(rowCardValue(id))}</b></li>`).join('')}</ol>`;
}

/**
 * The summit, as its own beat (shown for a few seconds during playback): the Climb row is empty, the direction and
 * the trumps change, and the Brumby row is dealt. Nothing here is secret, so it is shown to a pass-and-play table too.
 */
export function summitHtml(vm) {
  const b = vm.board;
  if (!b.banner || b.banner.kind !== 'summit') return '';
  const ban = b.banner;
  const names = vm.names;
  const leader = names[ban.leader];
  return `<div class="overlay overlay--summit" data-overlay="summit"><div class="end end--summit" role="status">
    <p class="end__kicker">The summit</p>
    <h2>Over the top: now the lowest card wins</h2>
    <div class="summit__swap" aria-hidden="true">
      <span class="summit__side summit__side--was">${badgeImg(b.trumpClimb, 'summit__badge')}<b>${esc(SUIT_NAMES[b.trumpClimb])}</b><small>was trumps, highest won</small></span>
      <span class="summit__arrow">&rarr;</span>
      <span class="summit__side summit__side--now">${badgeImg(b.trumpDescent, 'summit__badge')}<b>${esc(SUIT_NAMES[b.trumpDescent])}</b><small>is trumps, lowest wins</small></span>
    </div>
    <p class="summit__label">The Climb row is empty. The Brumby row is dealt: one card for each descent trick, worth ${signed(ban.rowValue)} in all.</p>
    ${rowStrip(ban.row)}
    <p class="summit__colt"${ban.colt ? '' : ' hidden'}>${ban.colt ? esc(rowSentence(ban.row)) : ''}</p>
    <p class="summit__note">${esc(leader)} ${youName(leader) ? 'lead' : 'leads'} the descent, having won the last climb trick. Every card in the row goes to whoever wins its trick, good or bad.</p>
    ${vm.humanSeats.length ? '<div class="end__buttons"><button type="button" class="btn btn--primary btn--big" data-action="continue" id="summit-continue" data-autofocus>Start the descent</button></div>' : ''}
  </div></div>`;
}

// ---------- score pad and log ----------

export function padHtml(vm) {
  const b = vm.board;
  const log = vm.state.handLog;
  const names = vm.names;
  const rows = [];
  for (let h = 0; h < b.handsPerGame; h++) {
    if (h < log.length && (h < b.handNo || b.phase === 'over')) {
      const rec = log[h];
      const tip = (s) => `Climb cards ${signed(rec.climbValues[s])}, Brumby cards ${signed(rec.keptValues[s])}`;
      rows.push(`<tr><th scope="row">Hand ${h + 1}</th>${rec.scores.map((x, s) => `<td title="${esc(tip(s))}">${signed(x)}</td>`).join('')}</tr>`);
    } else if (h === b.handNo && b.phase !== 'over') {
      rows.push(`<tr class="is-now"><th scope="row">Hand ${h + 1} <small>so far</small></th>${names.map((_, s) => `<td title="Climb cards and Brumby cards taken so far this hand">${signed(handScoreOf(b, s))}</td>`).join('')}</tr>`);
    } else {
      rows.push(`<tr class="is-todo"><th scope="row">Hand ${h + 1}</th>${names.map(() => '<td>&middot;</td>').join('')}</tr>`);
    }
  }
  return `<table class="pad"><caption class="sr-only">Score pad</caption>
    <thead><tr><th scope="col"></th>${names.map((n, s) => `<th scope="col" title="${esc(n)}">${avatar(s, 'pad__avatar')}<span class="pad__name">${esc(n)}</span></th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr><th scope="row">Total</th>${b.totals.map((t) => `<td>${t}</td>`).join('')}</tr></tfoot></table>`;
}

export function logHtml(vm) {
  const items = vm.log.slice().reverse().slice(0, 60).map((l) => `<li class="log__item log__item--${l.kind || 'info'}">${esc(l.text)}</li>`).join('');
  return `<ol class="log__list" id="log" aria-label="What has happened, newest first">${items || '<li class="log__item">Nothing yet.</li>'}</ol>`;
}

export function sideHtml(vm) {
  const open = (k, d = true) => (vm.ui.panels[k] === undefined ? d : vm.ui.panels[k]) ? ' open' : '';
  return `<aside class="side">
    <details class="panel" data-panel="pad"${open('pad')}><summary>Score pad</summary>${padHtml(vm)}</details>
    <details class="panel" data-panel="log"${open('log')}><summary>What happened</summary>${logHtml(vm)}</details>
  </aside>`;
}

// ---------- overlays ----------

/** Pass-and-play cover: nothing from the game is in the DOM while it is up. */
export function coverHtml(vm, seat) {
  const name = vm.names[seat];
  return `<div class="cover" id="cover" role="dialog" aria-modal="true" aria-labelledby="cover-title">
    <div class="cover__card">
      ${avatar(seat, 'cover__avatar')}
      <p class="cover__kicker">Pass the device</p>
      <h2 id="cover-title">Pass to ${esc(name)}</h2>
      <p class="cover__msg">It is your turn to play. Everyone else look away.</p>
      <button type="button" class="btn btn--primary btn--big" data-action="reveal" data-seat="${seat}">I am ${esc(name)}: show my hand</button>
    </div>
  </div>`;
}

/** What each seat took this hand, in cards and sums. */
function reckonRow(vm, ev, s) {
  const bd = ev.breakdown[s];
  const names = vm.names;
  const thumbs = (ids, imgFn, label) => (ids.length
    ? `<span class="reck__cards" aria-label="${esc(`${label} taken`)}">${ids.map((id) => `<span class="reck__card" title="${esc(`${rowCardName(id)} (${signed(rowCardValue(id))})`)}">${imgFn(id, 'reck__img')}</span>`).join('')}</span>`
    : '<small class="reck__none">none</small>');
  const sumText = `Climb ${signed(bd.climbValue)} &middot; Brumby ${signed(bd.keptValue)}`;
  return `<li class="reck__row" data-seat="${s}">
    ${avatar(s, 'reck__avatar')}
    <span class="reck__who"><b>${esc(names[s])}</b><small>${esc(`${plural(bd.climbCards.length, 'Climb card', 'Climb cards')}, ${plural(bd.kept.length, 'Brumby card', 'Brumby cards')}`)}</small></span>
    <span class="reck__what"><span class="reck__kind"><i>Climb cards</i><b class="taken__sum--${tone(bd.climbValue)}">${signed(bd.climbValue)}</b>${thumbs(bd.climbCards, climbImg, 'Climb cards')}</span><span class="reck__kind"><i>Brumby cards</i><b class="taken__sum--${tone(bd.keptValue)}">${signed(bd.keptValue)}</b>${thumbs(bd.kept, brumbyImg, 'Brumby cards')}</span></span>
    <b class="reck__score reck__score--${tone(bd.score)}" aria-label="${esc(`${signed(bd.score)} points: ${sumText.replace(/&middot;/g, ',')}`)}">${signed(bd.score)}</b>
    <span class="reck__total">Total <b>${ev.totals[s]}</b></span>
  </li>`;
}

/** The end-of-hand reckoning. `modal.event` is the engine's hand-ended event. */
export function handSummaryHtml(vm, modal) {
  const ev = modal.event;
  const names = vm.names;
  const last = vm.state.phase === 'over' && modal.handNo === vm.state.handLog.length - 1;
  const rows = names.map((_, s) => reckonRow(vm, ev, s)).join('');
  const bits = [`The Climb row was worth ${signed(ev.climbRowValues.reduce((a, x) => a + x, 0))} in all and the Brumby row ${signed(ev.rowValue)}.`];
  if (ev.minusWinner !== null && ev.minusWinner !== undefined) bits.push(`${names[ev.minusWinner]} took the -1 Climb card (trick ${ev.minusPosition}).`);
  if (ev.colt) bits.push(`${names[ev.coltWinner]} won the Colt (descent trick ${ev.coltTrick}, +4).`);
  const reshuffle = !last && vm.board.deckCount < vm.state.params.reshuffleBelow ? ' Fewer than 6 Brumby cards are left, so all 12 are shuffled before the next hand.' : '';
  const title = `Hand ${modal.handNo + 1} of ${vm.board.handsPerGame} is over`;
  return `<div class="overlay overlay--hand" data-overlay="hand"><div class="end end--hand" role="dialog" aria-modal="true" aria-labelledby="hand-title">
    <p class="end__kicker">The reckoning</p>
    <h2 id="hand-title">${esc(title)}</h2>
    <p class="end__note end__note--lead">${esc(bits.join(' '))}</p>
    <ol class="reck" aria-label="Scores for this hand">${rows}</ol>
    <p class="end__note">Your score for the hand is the Climb cards and Brumby cards you took; tricks themselves score nothing.${esc(reshuffle)}</p>
    <div class="end__buttons"><button type="button" class="btn btn--primary btn--big" data-action="continue" id="continue">${last ? 'See the final result' : 'Deal the next hand'}</button></div>
  </div></div>`;
}

export function gameEndHtml(vm) {
  const result = vm.state.result;
  const names = vm.names;
  const winners = result.winners;
  const wName = winners.map((s) => names[s]);
  let headline;
  if (result.shared) headline = `Shared win: ${wName.slice(0, -1).join(', ')}${wName.length > 1 ? ' and ' : ''}${wName[wName.length - 1]}`;
  else headline = `${wName[0]} ${youName(wName[0]) ? 'win' : 'wins'}!`;
  const rows = result.ranking.map((r) => {
    const win = winners.includes(r.seat);
    const eq = result.ranking.filter((x) => x.rank === r.rank).length > 1 ? '=' : '';
    return `<li class="rank${win ? ' is-winner' : ''}"><span class="rank__pos">${eq}${r.rank}</span>${avatar(r.seat, 'rank__avatar')}<span class="rank__who"><b>${esc(names[r.seat])}</b>${badge(vm, r.seat)}${win ? `<i class="crown">${result.shared ? 'Shared win' : 'Winner'}</i>` : ''}</span><span class="rank__total"><b>${r.total}</b> pts <small>last hand ${r.lastHandScore}</small></span></li>`;
  }).join('');
  const tb = tiebreakText(result, names);
  const padRows = vm.state.handLog.map((h, i) => `<tr><th scope="row">Hand ${i + 1}</th>${h.scores.map((x) => `<td>${signed(x)}</td>`).join('')}</tr>`).join('');
  return `<div class="overlay" data-overlay="end"><div class="end end--game" role="dialog" aria-modal="true" aria-labelledby="end-title">
    <p class="end__kicker">Game over</p>
    <h2 id="end-title">${esc(headline)}</h2>
    ${tb ? `<p class="end__tiebreak" id="tiebreak">${esc(tb)}</p>` : ''}
    <ol class="ranking" aria-label="Final ranking">${rows}</ol>
    <details class="panel"><summary>Score pad</summary><table class="pad pad--end"><thead><tr><th></th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>${padRows}</tbody><tfoot><tr><th>Total</th>${result.totals.map((t) => `<td>${t}</td>`).join('')}</tr></tfoot></table></details>
    <div class="end__buttons" id="end-buttons">
      <button type="button" class="btn btn--primary btn--big" data-action="again">Play again</button>
      <button type="button" class="btn" data-action="new">Change setup</button>
      <button type="button" class="btn btn--quiet" data-action="review">Look at the table</button>
      <button type="button" class="btn btn--quiet" data-action="open-stats">Stats</button>
    </div>
  </div></div>`;
}

export function endBarHtml(vm) {
  const result = vm.state.result;
  const w = result.winners.map((s) => vm.names[s]).join(' and ');
  return `<div class="endbar" role="status"><span><b>Game over.</b> ${esc(result.shared ? `Shared win: ${w}.` : `${w} ${youName(w) ? 'win' : 'wins'}.`)}</span><button type="button" class="btn btn--primary" data-action="again">Play again</button><button type="button" class="btn" data-action="show-end">Show result</button><button type="button" class="btn btn--quiet" data-action="open-stats">Stats</button></div>`;
}
