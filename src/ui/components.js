// components.js - HTML string builders for the game screen: the phase banner, seats (one trick pile, the
// Brumby cards a chaser has kept), the Mountain card with the mob marker, the Brumby row, the current trick,
// the hand (turned round after the summit), the summit decision, the reveal, the score pad, the log and the
// overlays (the turn at the summit, the pass-and-play cover, the reckoning at the end of a hand, the end of
// the game). Pure string functions of a view-model `vm` built in main.js; no DOM access, no game logic:
// every number comes from the board (events) or the engine.
//
// vm = { board, names, types, humanSeats, me, shown, hand, half, reasons, hints, myTurn, view,
//        ui, log, state (read-only: handLog, result, params), frame (the playback frame or null) }

import { SUIT_NAMES, cardSuit, cardName, isCardPhase, brumbyValue, brumbyName } from '../engine/index.js';
import { esc, img, cardImg, cardBackImg, brumbyImg, brumbyBackImg, choiceArt, badgeImg, avatarId } from './assets.js';
import { turnPrompt, waitingText, tiebreakText, phaseText, phaseParts, phaseNote, stakesText, bannerText, stepCallout, descentGoal, winnerBanner, rowSentence } from './text.js';

export { esc };

const youName = (n) => n === 'You';
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const signed = (x) => (x > 0 ? `+${x}` : `${x}`);
const sum = (ids) => ids.reduce((a, id) => a + brumbyValue(id), 0);

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

/** The seat's summit card as the table may show it: face down before the reveal. */
function choiceChip(vm, s) {
  const b = vm.board;
  const small = (c) => img(choiceArt(c, b.chaseCost), { cls: 'schip__card', alt: '', label: '', w: 24, h: 34, fallback: '' });
  if (b.revealed && b.choices[s]) {
    const c = b.choices[s];
    return `<span class="schip schip--choice schip--${c}" title="${c === 'chase' ? `Chose Chase (pays ${b.chaseCost})` : 'Chose Watch'}">${small(c)}<b>${c === 'chase' ? 'Chase' : 'Watch'}</b>${c === 'chase' ? `<i>-${b.chaseCost}</i>` : ''}</span>`;
  }
  if (b.phase === 'summit') {
    // The viewer's own choice may be shown to the viewer only (from the view, never the board).
    const own = vm.view && vm.view.seat === s && vm.view.choices[s];
    if (own) return `<span class="schip schip--choice schip--own" title="Your choice, still face down to everyone else">${small(own)}<b>${own === 'chase' ? 'Chase' : 'Watch'}</b><i>face down</i></span>`;
    return `<span class="schip schip--choice" title="Summit choice, face down until everyone has chosen">${cardBackImg('schip__card')}<b>${b.chosen[s] ? 'Chosen' : 'Choosing'}</b>${b.chosen[s] ? '<i>face down</i>' : ''}</span>`;
  }
  // The same row is kept (empty) through the climb, so a seat is the same height before, at and after the summit.
  if (b.phase === 'climb') return '<span class="schip schip--slot" aria-hidden="true"></span>';
  return '';
}

// ---------- seats ----------

const MINI_MAX = 14;
/** One pile of tricks (R4.7): 1 point each, up or down. */
function pileHtml(count, bump, up, down) {
  const minis = Array.from({ length: Math.min(count, MINI_MAX) }, () => '<i class="mini"></i>').join('');
  const title = `Tricks won this hand: ${up} on the climb and ${down} on the descent. Every trick is 1 point.`;
  return `<span class="pile${bump ? ' fx-bump' : ''}" title="${esc(title)}" aria-label="${plural(count, 'trick', 'tricks')} won this hand"><span class="pile__minis" aria-hidden="true">${minis}</span><b>${count}</b><i>${count === 1 ? 'trick' : 'tricks'}</i></span>`;
}

/** The Brumby cards a chaser has kept this hand, face up, with what they are worth. */
function keptHtml(vm, s) {
  const b = vm.board;
  if (!(b.revealed && b.choices[s] === 'chase' && b.phase !== 'over')) return '';
  const k = b.kept[s];
  const bump = b.fx && b.fx.prize && b.fx.prize.seat === s && b.fx.prize.to === 'kept';
  const fan = k.length ? `<span class="kept__fan" style="--k:${k.length}">${k.map((id, i) => `<span class="kept__card${bump && i === k.length - 1 ? ' is-new' : ''}" style="--i:${i}" title="${esc(brumbyName(id))}">${brumbyImg(id, 'kept__img')}</span>`).join('')}</span><b class="kept__sum">${signed(sum(k))}</b>` : '<span class="kept__none">none yet</span>';
  return `<div class="seat__kept${bump ? ' fx-bump' : ''}" aria-label="Brumby cards kept: ${k.length ? esc(k.map(brumbyName).join(', ')) : 'none yet'}"><span class="kept__label">Kept</span>${fan}</div>`;
}

export function seatHtml(vm, s, area) {
  const b = vm.board;
  const name = vm.names[s];
  const toAct = b.toAct === s && b.phase !== 'over';
  const tags = [];
  if (b.phase !== 'over' && b.dealer === s) tags.push('<span class="tag tag--dealer" title="Dealer this hand">Dealer</span>');
  if (toAct) tags.push(`<span class="tag tag--turn">${b.phase === 'summit' ? 'Choosing' : (vm.types[s] === 'human' && vm.humanSeats.length === 1 ? 'Your turn' : 'To play')}</span>`);
  const cards = b.handCounts[s];
  const winning = b.trick && b.trick.winner === s;
  const wonNow = !!(b.fx && b.fx.won === s);
  const tricks = b.climbTricks[s] + b.descentTricks[s];
  return `<article class="seat area-${area}${toAct ? ' is-turn' : ''}${winning ? ' is-winning' : ''}" data-seat="${s}" aria-label="${esc(name)}">
    <header class="seat__head">
      ${avatar(s)}
      <div class="seat__id"><b class="seat__name">${esc(name)}</b>${badge(vm, s)}<span class="seat__hand" title="Cards in hand" aria-label="${plural(cards, 'card', 'cards')} in hand"><b class="seat__cardsnum" data-cards="${s}">${cards}</b> ${cards === 1 ? 'card' : 'cards'}</span></div>
    </header>
    ${tags.length ? `<div class="seat__tags">${tags.join('')}</div>` : ''}
    <div class="seat__piles">${pileHtml(tricks, wonNow, b.climbTricks[s], b.descentTricks[s])}${choiceChip(vm, s)}</div>
    ${keptHtml(vm, s)}
    <footer class="seat__score">
      <span class="total" title="Total over finished hands">Total <b>${b.totals[s]}</b></span>
    </footer>
  </article>`;
}

// ---------- the table: phase banner, opponents, the stage, my seat ----------

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
      <div class="stage__mountain">${mountainHtml(vm)}</div>
      <div class="stage__row">${rowHtml(vm)}</div>
      <div class="stage__trick">${trickHtml(vm)}</div>
    </div>
    ${seats[0]}
  </div>`;
}

// ---------- status: the phase banner and what to do now ----------

export function statusHtml(vm) {
  const b = vm.board;
  const names = vm.names;
  let head;
  if (b.phase === 'over') head = '<div class="phasebar phasebar--over" role="status"><span class="phasebar__name">Game over</span></div>';
  else {
    const p = phaseParts(b.phase);
    const icon = b.phase === 'climb' ? badgeImg('escape', 'phasebar__badge') : b.phase === 'descent' ? badgeImg('home', 'phasebar__badge') : img('mob-marker', { cls: 'phasebar__badge phasebar__badge--mob', alt: '', label: '', w: 36, h: 36, fallback: '' });
    const half = b.phase === 'climb' ? `Climb trick ${Math.min(b.marker + 1, b.climbTricksPerHand)} of ${b.climbTricksPerHand}` : b.phase === 'descent' ? `Descent trick ${Math.min((b.rowNext || 0) + 1, b.row.length)} of ${b.row.length}` : 'Six tricks up, six down';
    const meta = `Hand ${Math.min(b.handNo + 1, b.handsPerGame)} of ${b.handsPerGame} &middot; ${half} &middot; Dealer: ${esc(names[b.dealer])}`;
    head = `<div class="phasebar phasebar--${esc(b.phase)}" role="status" aria-label="${esc(phaseText(b.phase))}">${icon}<span class="phasebar__name">${esc(p.name)}</span>${p.rule ? `<span class="phasebar__rule">${esc(p.rule)}</span>` : ''}<strong class="phasebar__range">${esc(phaseNote(b.phase, b.trump))}</strong><small class="phasebar__meta">${meta}</small></div>`;
  }
  const g = b.phase === 'descent' ? descentGoal(b, names, vm.humanSeats) : null;
  const goal = g ? `<div class="goal" role="note"><p class="goal__main">${esc(g.main)}</p><p class="goal__extra">${esc(g.extra)}</p>${g.personal.map((x) => `<p class="goal__me goal__me--${x.choice}">${esc(x.text)}</p>`).join('')}</div>` : '';
  let prompt = '';
  if (vm.frame && b.banner && b.banner.kind !== 'trick') prompt = bannerText(b.banner, names, b);
  else if (vm.myTurn && vm.view && !vm.frame) prompt = turnPrompt(vm.view);
  else prompt = waitingText(b, names, vm.types);
  return `<div class="status">${head}${goal}<p class="status__prompt" id="prompt">${esc(prompt)}</p></div>`;
}

// ---------- the Mountain card with the mob marker ----------

/**
 * Where each step's circle is printed on the 480 x 336 climb side (measured on assets/cards/mountain-up.webp):
 * step 0 is the foot of the road, steps 1 to 6 the six numbered circles. The marker stands in the lower half of its circle.
 * The descent side has no circles, so no marker.
 */
const MOUNTAIN_ART = { w: 480, h: 336 };
export const MOUNTAIN_STEPS = {
  climb: [[40, 322], [97, 296], [311, 232], [227, 201], [96, 158], [177, 132], [320, 87]],
};

/** [left %, top %] of a step on the climb side of the Mountain card. */
export function stepPosition(side, step) {
  const pts = MOUNTAIN_STEPS[side] || MOUNTAIN_STEPS.climb;
  const p = pts[Math.max(0, Math.min(pts.length - 1, step))];
  return [+(p[0] / MOUNTAIN_ART.w * 100).toFixed(2), +(p[1] / MOUNTAIN_ART.h * 100).toFixed(2)];
}

/** The Mountain card: the climb side with the marker on its step; turned over at the summit to the descent side. */
export function mountainHtml(vm) {
  const b = vm.board;
  const side = b.handsTurned ? 'descent' : 'climb';
  const trumpName = SUIT_NAMES[b.trump];
  let card = '';
  if (side === 'climb') {
    const [left, top] = stepPosition('climb', b.marker);
    const fx = b.fx && b.fx.marker ? b.fx.marker : null;
    const call = stepCallout(fx);
    const callout = call ? `<span class="mountain__callout" style="left:${left}%;top:${top}%" title="${esc(call.title)}">${esc(call.text)}</span>` : '';
    const marker = `<span class="mountain__marker" data-side="${side}" data-step="${b.marker}" style="left:${left}%;top:${top}%">${img('mob-marker', { cls: 'mountain__piece', alt: 'The mob', label: 'Mob', w: 64, h: 64 })}</span>`;
    card = `${img('mountain-up', { cls: 'mountain__img', alt: `Mountain card, climb side: Escape is trumps`, label: 'Mountain, climb side', w: 480, h: 336 })}${marker}${callout}`;
  } else {
    card = img('mountain-down', { cls: 'mountain__img', alt: 'Mountain card, descent side: Home is trumps', label: 'Mountain, descent side', w: 480, h: 336 });
  }
  const title = side === 'climb'
    ? `The climb: <b data-marker>${b.marker}</b> of ${b.climbTricksPerHand} tricks played`
    : `The descent: <b data-marker>${Math.min(b.rowNext === null ? b.row.length : b.rowNext, 6)}</b> of 6 tricks played`;
  const fxText = b.fx && b.fx.marker ? (b.fx.marker.summit ? 'The mob reaches the summit!' : `The mob climbs to step ${b.fx.marker.to}`) : '';
  const flip = b.banner && b.banner.kind === 'turn' ? 1 : 0; // the Mountain turns over once, at the summit
  return `<div class="mountain" data-side="${side}" data-flip="${flip}">
    <div class="mountain__card">${card}</div>
    <p class="mountain__title" aria-live="polite">${title}</p>
    <p class="mountain__trump" data-trump="${esc(b.trump)}">${badgeImg(b.trump, 'mountain__badge')}<span><b>${esc(trumpName)}</b> is trumps ${side === 'climb' ? 'going up' : 'going down'}</span></p>
    <p class="mountain__fx" aria-live="polite">${esc(fxText)}</p>
  </div>`;
}

// ---------- the Brumby row: the mob laid out below the summit ----------

/** The six Brumby cards of this hand, face up from the summit; the next card to be won is lit; taken slots show who has it. */
export function rowHtml(vm) {
  const b = vm.board;
  const dealt = b.row.length > 0;
  const slots = Array.from({ length: b.climbTricksPerHand }, (_, i) => {
    if (!dealt) return `<li class="rslot rslot--down" aria-label="Brumby card ${i + 1}, face down in the deck"><span class="rslot__n">${i + 1}</span>${brumbyBackImg('rslot__img')}</li>`;
    const id = b.row[i];
    if (id) {
      const next = b.rowNext === i && (b.phase === 'descent' || b.phase === 'summit');
      const fresh = next && !!((b.fx && b.fx.prize) || (b.banner && b.banner.kind === 'descent'));
      return `<li class="rslot${next ? ' is-next' : ''}${fresh ? ' is-new' : ''}${id === 'colt' ? ' is-colt' : ''}" data-pos="${i + 1}" aria-label="Brumby card ${i + 1}: ${esc(brumbyName(id))}${next ? ', the prize for the next trick' : ''}"><span class="rslot__n">${i + 1}</span>${brumbyImg(id, 'rslot__img')}</li>`;
    }
    const t = b.rowTaken[i];
    const who = t ? vm.names[t.seat] : '';
    const what = b.rowDealt[i] ? brumbyName(b.rowDealt[i]) : 'Brumby card';
    const gone = t && t.to === 'kept'
      ? `<span class="rslot__gone rslot__gone--kept" data-seat="${t.seat}">${avatar(t.seat, 'rslot__avatar')}<i>kept</i></span>`
      : '<span class="rslot__gone rslot__gone--off"><b aria-hidden="true">&times;</b><i>off</i></span>';
    return `<li class="rslot is-taken" data-pos="${i + 1}" title="${esc(t ? `${what}: ${t.to === 'kept' ? `kept by ${who}` : `sent off (${who} watched)`}` : '')}" aria-label="Brumby card ${i + 1} taken: ${esc(t ? (t.to === 'kept' ? `kept by ${who}` : 'sent off') : '')}"><span class="rslot__n">${i + 1}</span>${gone}</li>`;
  }).join('');
  const total = sum(b.rowDealt);
  const left = sum(b.row.filter(Boolean));
  const taken = b.row.filter((x) => x === null).length;
  let line;
  if (!dealt) line = 'The mob is turned up at the summit: one Brumby card for each descent trick.';
  else if (b.phase === 'summit') line = `The row is worth ${signed(total)} in all.${b.rowDealt.includes('colt') ? ' The Colt is in it.' : ''}`;
  else line = taken >= b.row.length ? `All six taken. The row was worth ${signed(total)}.` : `Row worth ${signed(total)}; ${signed(left)} still to win.`;
  const discard = b.discard.length
    ? `<details class="row__discard" data-panel="discard"${vm.ui.panels.discard ? ' open' : ''}><summary>Discard <b>${b.discard.length}</b></summary><span class="row__thumbs">${b.discard.map((id) => `<span class="row__thumb" title="${esc(brumbyName(id))}">${brumbyImg(id, 'row__thumbimg')}</span>`).join('')}</span></details>`
    : '<span class="row__pile">Discard <b>0</b></span>';
  return `<div class="row" aria-label="The Brumby row">
    <p class="row__title">The mob <small class="row__cost">Chase costs ${b.chaseCost}</small></p>
    <ol class="row__slots${dealt ? '' : ' is-down'}">${slots}</ol>
    <p class="row__line" id="row-line">${esc(line)}</p>
    <div class="row__piles"><span class="row__pile">Deck <b>${b.deckCount}</b></span>${discard}</div>
  </div>`;
}

// ---------- the current trick ----------

export function trickHtml(vm) {
  const b = vm.board;
  const names = vm.names;
  const t = b.trick;
  const startSeat = t ? t.leader : (b.toAct !== null ? b.toAct : 0);
  const order = t ? t.seats : Array.from({ length: b.n }, (_, k) => (startSeat + k) % b.n);
  const turned = t ? t.half === 'descent' : b.handsTurned;
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
    return `<li class="tplay${win ? ' is-winner' : ''}${p.offSuit && !p.trump ? ' is-offsuit' : ''}${t.winner !== null && !win ? ' is-lost' : ''}"><span class="tplay__card">${cardImg(p.card, { alt: cardName(p.card, t.half), turned })}</span><span class="tplay__who">${esc(names[s])}</span><span class="tplay__tags">${tags.map((x) => `<i class="mark mark--${x}"${titles[x] ? ` title="${titles[x]}"` : ''}>${x}</i>`).join('')}</span></li>`;
  }).join('');
  const halfNo = t ? t.halfTrickNo : (b.phase === 'descent' ? (b.rowNext || 0) + 1 : b.marker + 1);
  const halfName = t ? (t.half === 'descent' ? 'Descent' : 'Climb') : (b.phase === 'descent' ? 'Descent' : 'Climb');
  let title;
  if (b.phase === 'summit') title = 'At the summit';
  else if (t && t.ledSuit) title = `${halfName} trick ${halfNo} &middot; <span class="led led--${t.ledSuit}">${badgeImg(t.ledSuit, 'led__badge')}${esc(`${SUIT_NAMES[t.ledSuit]} led`)}</span>`;
  else title = `${halfName} trick ${Math.min(halfNo, 6)}`;
  let banner = b.banner && b.banner.kind === 'trick' ? b.banner : null;
  if (!banner && t && t.done) banner = { winner: t.winner, card: t.winningCard, phase: t.half, byTrump: t.byTrump };
  let msg = '';
  if (banner) msg = winnerBanner(banner, names);
  else if (b.phase === 'summit') msg = 'Everyone chooses Chase or Watch in secret.';
  else if (b.phase === 'over') msg = '';
  else if (!t) msg = b.toAct !== null ? `${names[b.toAct]} ${youName(names[b.toAct]) ? 'lead' : 'leads'} the next trick.` : '';
  if (b.phase === 'over') return '<div class="trick"><p class="trick__title">Game over</p></div>';
  return `<div class="trick trick--${esc(t ? t.half : b.phase)}"><p class="trick__title">${title}</p><ol class="tplays">${slots}</ol><p class="trick__msg${banner ? ' is-banner' : ''}" id="trick-msg">${esc(msg)}</p></div>`;
}

// ---------- the hand ----------

export function handHtml(vm) {
  const hand = vm.hand;
  if (!hand) return '';
  const playing = vm.myTurn && isCardPhase(vm.state.phase);
  const turned = vm.board.handsTurned;
  const half = vm.half;
  const items = hand.map((card, i) => {
    const reason = vm.reasons.get(card) || null;
    const hint = vm.hints.get(card) || null;
    const legal = playing && !reason;
    const suit = cardSuit(card);
    const cls = ['card', `card--${suit}`];
    if (suit === vm.board.trump) cls.push('is-trump');
    if (!playing) cls.push('is-wait');
    else if (legal) cls.push('is-legal'); else cls.push('is-blocked');
    if (i === 0 || cardSuit(hand[i - 1]) !== suit) cls.push('is-first');
    if (vm.ui.selected === card) cls.push('is-selected');
    let mark = '';
    if (legal && hint && hint.kind === 'follow') mark = `<span class="card__hint ${hint.wins ? 'is-win' : 'is-lose'}" aria-hidden="true">${hint.wins ? '&#10003;' : '&#10007;'}</span>`;
    const title = !playing ? `${cardName(card, half)}: wait for your turn` : (reason || `Play ${cardName(card, half)}`);
    const hintSr = legal && hint && hint.kind === 'follow' ? (hint.wins ? ' (would win the trick as it stands)' : ' (would not win)') : '';
    return `<button type="button" class="${cls.join(' ')}" data-action="play" data-card="${card}" title="${esc(title)}" aria-label="${esc(cardName(card, half) + hintSr)}"${legal ? '' : ' aria-disabled="true"'}>${cardImg(card, { turned })}${mark}</button>`;
  }).join('');
  const turning = !!(vm.board.banner && vm.board.banner.kind === 'turn');
  return `<div class="hand${turned ? ' hand--turned' : ''}${turning ? ' hand--turning' : ''}" role="group" aria-label="Your hand, sorted by suit${turned ? ', turned round' : ''}">${items}</div>`;
}

export function handBoxHtml(vm) {
  const who = vm.humanSeats.length > 1 ? `${esc(vm.names[vm.shown])}'s hand` : 'Your hand';
  if (vm.hand === null) {
    // Pass-and-play and it is not this human's decision (or nobody is human): never show a hand.
    if (vm.humanSeats.length === 0) return '';
    return `<div class="handbox handbox--hidden"><p class="handbox__title">Hands are hidden</p>${cardBackImg('handbox__back')}</div>`;
  }
  const playing = vm.myTurn && isCardPhase(vm.state.phase);
  const trumpName = SUIT_NAMES[vm.board.trump];
  const legend = playing && vm.view.trick && vm.view.trick.ledSuit
    ? `<p class="legend"><span class="hint-dot is-win">&#10003;</span> would win the trick as it stands (any ${esc(trumpName)} beats the other suits, then the highest of the suit led) <span class="hint-dot is-lose">&#10007;</span> would not. Dimmed cards cannot be played: hover or tap one to see why.</p>`
    : (playing ? `<p class="legend">You lead: play any card. ${esc(trumpName)} is trumps. Dimmed cards cannot be played: hover or tap one to see why.</p>` : '');
  const how = vm.board.handsTurned ? 'turned round: read the number now at the top' : 'sorted by suit; read the big number at the top';
  const title = `${who} <span>${how}</span>`;
  return `<div class="handbox${vm.myTurn ? ' is-turn' : ''}${vm.board.handsTurned ? ' handbox--turned' : ''}">
    <p class="handbox__title">${title}</p>
    <div class="hand-wrap">${handHtml(vm)}</div>
    ${legend}
    <p class="preview" id="preview" aria-live="polite"></p>
    <p class="note" id="note" role="status">${esc(vm.ui.note || '')}</p>
  </div>`;
}

// ---------- the summit ----------

/**
 * The summit decision: a Chase card and a Watch card as buttons, each with the stakes from view.stakes.
 * data-action="decide" with the action as JSON in data-decision; main.js sends it to the controller.
 * Shown to one human at a time, in a modal.
 */
export function decisionHtml(vm) {
  if (!vm.myTurn || vm.state.phase !== 'summit' || !vm.view) return '';
  const st = stakesText(vm.view);
  const cost = vm.view.chaseCost;
  const btn = (choice, label, line, head) => `<button type="button" class="decide decide--${choice}" data-action="decide" data-decision='${JSON.stringify({ type: 'summit', choice })}' aria-label="${esc(`${label}. ${line}`)}">${img(choiceArt(choice, cost), { cls: 'decide__card', alt: '', label, w: 150, h: 214 })}<span class="decide__head">${esc(head)}</span><span class="decide__stakes">${esc(line)}</span></button>`;
  return `<div class="decision" role="group" aria-label="Chase or Watch">
    <div class="decision__buttons">${btn('chase', 'Chase', st.chase, `Chase: pay ${cost}`)}${btn('watch', 'Watch', st.watch, 'Watch: pay nothing')}</div>
  </div>`;
}

/** The row as a strip of small cards, for the summit modal. */
function rowStrip(ids, cls = 'summit__row') {
  return `<ol class="${cls}" aria-label="The Brumby row, left to right">${ids.map((id, i) => `<li class="${id === 'colt' ? 'is-colt' : ''}"><span class="rslot__n">${i + 1}</span>${brumbyImg(id, 'summit__brumby')}</li>`).join('')}</ol>`;
}

/** The summit as its own step: an overlay with the turned hand, the row and the two cards. Nothing here names a side before the reveal. */
export function summitModalHtml(vm) {
  if (!vm.myTurn || vm.state.phase !== 'summit' || !vm.view) return '';
  const v = vm.view;
  const who = vm.humanSeats.length > 1 ? `${esc(vm.names[vm.shown])}, choose in secret` : 'Choose in secret';
  const hand = v.hand.map((c) => `<li>${cardImg(c, { turned: true })}</li>`).join('');
  return `<div class="overlay overlay--summit" data-overlay="summit"><div class="end end--summit" role="dialog" aria-modal="true" aria-labelledby="summit-title">
    <p class="end__kicker">The summit</p>
    <h2 id="summit-title" tabindex="-1" data-autofocus>${who}: Chase or Watch?</h2>
    <p class="summit__label">Your hand, turned round</p>
    <ol class="summit__hand" aria-label="Your turned hand">${hand}</ol>
    <p class="summit__label">The mob: one Brumby card for each descent trick (worth ${signed(v.stakes.rowValue)} in all)</p>
    ${rowStrip(v.stakes.row)}
    <p class="summit__colt"${v.stakes.row.includes('colt') ? '' : ' hidden'}>${v.stakes.row.includes('colt') ? esc(rowSentence(v.stakes.row)) : ''}</p>
    ${decisionHtml(vm)}
    <p class="summit__note">Everyone's card is turned together. A chaser pays ${v.chaseCost} at the end of the hand and keeps the Brumby card of every trick they win; a watcher pays nothing, and the Brumby cards they win are sent off. Every trick is 1 point either way.</p>
  </div></div>`;
}

/** The turn at the summit: every hand is turned round, the Mountain turns over, the row is laid out (a timed beat during playback). */
export function turnHtml(vm) {
  const b = vm.board;
  if (!b.banner || b.banner.kind !== 'turn') return '';
  const text = bannerText(b.banner, vm.names, b);
  return `<div class="overlay overlay--turn" data-overlay="turn"><div class="end end--turn" role="status">
    <p class="end__kicker">The summit</p>
    <h2>Everyone turns their hand round</h2>
    <div class="turn__pics" aria-hidden="true"><span class="turn__card">${cardImg('descent-1', { alt: '' })}</span><span class="turn__mtn">${img('mountain-down', { cls: 'turn__mtnimg', alt: '', label: '', w: 480, h: 336, fallback: '' })}</span></div>
    ${rowStrip(b.banner.row, 'turn__row')}
    <p class="turn__text">${esc(text)}</p>
  </div></div>`;
}

/** The reveal: every seat's Chase or Watch card turned face up (shown for a beat during playback). */
export function revealHtml(vm) {
  const b = vm.board;
  if (!b.revealed) return '';
  // The cards are turned together, so they are laid out the way the seats sit round the table: the viewer
  // first, then clockwise.
  const n = b.choices.length;
  const order = Array.from({ length: n }, (_, k) => (vm.me + k) % n);
  const faces = order.map((s) => {
    const c = b.choices[s];
    return `<li class="reveal__seat reveal__seat--${c}">${img(choiceArt(c, b.chaseCost), { cls: 'reveal__card', alt: c === 'chase' ? 'Chase' : 'Watch', label: c, w: 120, h: 171 })}<span class="reveal__who">${esc(vm.names[s])}</span></li>`;
  }).join('');
  const nobody = b.banner && b.banner.kind === 'reveal' && b.banner.chasers.length === 0;
  const text = b.banner ? bannerText(b.banner, vm.names, b) : '';
  return `<div class="overlay overlay--reveal" data-overlay="reveal"><div class="end end--reveal" role="status">
    <p class="end__kicker">${nobody ? 'Nobody chased' : 'The summit: the cards are turned'}</p>
    <ul class="reveal" aria-label="Everyone's choice">${faces}</ul>
    <p class="reveal__text">${esc(text)}</p>
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
      const tip = (s) => `${rec.choices[s] === 'chase' ? `Chase (-${rec.costs[s]})` : 'Watch'}: ${rec.trickCounts[s]} ${rec.trickCounts[s] === 1 ? 'trick' : 'tricks'}${rec.choices[s] === 'chase' ? `, ${rec.kept[s].length} Brumby ${rec.kept[s].length === 1 ? 'card' : 'cards'} kept (${signed(rec.keptValues[s])})` : ''}`;
      rows.push(`<tr><th scope="row">Hand ${h + 1}</th>${rec.scores.map((x, s) => `<td title="${esc(tip(s))}">${x}</td>`).join('')}</tr>`);
    } else if (h === b.handNo && b.phase !== 'over') {
      rows.push(`<tr class="is-now"><th scope="row">Hand ${h + 1} <small>tricks</small></th>${names.map((_, s) => `<td title="Tricks won so far this hand">${b.climbTricks[s] + b.descentTricks[s]}</td>`).join('')}</tr>`);
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

/** Pass-and-play cover: nothing from the game is in the DOM while it is up. `vm.phase` words the message. */
export function coverHtml(vm, seat) {
  const name = vm.names[seat];
  const summit = vm.phase === 'summit';
  const msg = summit ? 'The mob is at the summit: choose Chase or Watch in secret. Everyone else look away.' : 'It is your turn to play. Everyone else look away.';
  return `<div class="cover" id="cover" role="dialog" aria-modal="true" aria-labelledby="cover-title">
    <div class="cover__card">
      ${avatar(seat, 'cover__avatar')}
      <p class="cover__kicker">Pass the device</p>
      <h2 id="cover-title">Pass to ${esc(name)}</h2>
      <p class="cover__msg">${esc(msg)}</p>
      <button type="button" class="btn btn--primary btn--big" data-action="reveal" data-seat="${seat}">I am ${esc(name)}: ${summit ? 'make my choice' : 'show my hand'}</button>
    </div>
  </div>`;
}

/** What each seat did this hand, in words and sums. */
function reckonRow(vm, ev, s) {
  const bd = ev.breakdown[s];
  const names = vm.names;
  const chose = bd.choice === 'chase' ? 'chase' : 'watch';
  const trickWord = plural(bd.tricks, 'trick', 'tricks');
  let sumText = `${trickWord} = ${signed(bd.score)}`;
  if (chose === 'chase') sumText = `${trickWord} ${bd.keptValue < 0 ? '-' : '+'} ${Math.abs(bd.keptValue)} kept - ${bd.cost} Chase = ${signed(bd.score)}`;
  const keptThumbs = chose === 'chase' && bd.kept.length ? `<span class="reck__kept" aria-label="Brumby cards kept">${bd.kept.map((id) => `<span class="reck__keptcard" title="${esc(brumbyName(id))}">${brumbyImg(id, 'reck__keptimg')}</span>`).join('')}</span>` : (chose === 'chase' ? '<small>no Brumby cards kept</small>' : '');
  return `<li class="reck__row reck__row--${chose}" data-seat="${s}">
    ${avatar(s, 'reck__avatar')}
    <span class="reck__who"><b>${esc(names[s])}</b><small>${bd.climbTricks} up, ${bd.descentTricks} down</small></span>
    <span class="reck__choice">${img(choiceArt(chose, vm.board.chaseCost), { cls: 'reck__card', alt: '', label: '', w: 28, h: 40, fallback: '' })}<b>${chose === 'chase' ? `Chase -${bd.cost}` : 'Watch'}</b></span>
    <span class="reck__what"><b>${esc(sumText)}</b>${keptThumbs}</span>
    <b class="reck__score" aria-label="${signed(bd.score)} points">${signed(bd.score)}</b>
    <span class="reck__total">Total <b>${ev.totals[s]}</b></span>
  </li>`;
}

/** The end-of-hand reckoning. `modal.event` is the engine's hand-ended event. */
export function handSummaryHtml(vm, modal) {
  const ev = modal.event;
  const names = vm.names;
  const last = vm.state.phase === 'over' && modal.handNo === vm.state.handLog.length - 1;
  const rows = names.map((_, s) => reckonRow(vm, ev, s)).join('');
  const colt = ev.colt
    ? (ev.coltKept ? `${names[ev.coltWinner]} won the Colt (${ev.coltTrick === null ? '' : `descent trick ${ev.coltTrick}, `}+4) and kept it.` : `The Colt (trick ${ev.coltTrick}) was won by ${names[ev.coltWinner]}, who watched, so it was sent off.`)
    : '';
  const row = `The row was worth ${signed(ev.rowValue)}: ${ev.row.map((id) => signed(brumbyValue(id))).join(' ')}.`;
  const chasers = ev.chasers === 0 ? 'Nobody chased, so every Brumby card was sent off.' : '';
  const reshuffle = !last && vm.board.deckCount < vm.state.params.reshuffleBelow ? ' Fewer than 6 Brumby cards are left, so all 12 are shuffled before the next hand.' : '';
  const title = `Hand ${modal.handNo + 1} of ${vm.board.handsPerGame} is over`;
  return `<div class="overlay overlay--hand" data-overlay="hand"><div class="end end--hand" role="dialog" aria-modal="true" aria-labelledby="hand-title">
    <p class="end__kicker">The reckoning</p>
    <h2 id="hand-title">${esc(title)}</h2>
    <p class="end__note end__note--lead">${esc(`${row} ${chasers} ${colt}`.replace(/\s+/g, ' ').trim())}</p>
    <ol class="reck" aria-label="Scores for this hand">${rows}</ol>
    <p class="end__note">Every trick is 1 point. A chaser adds the Brumby cards they kept and pays ${vm.board.chaseCost}; a watcher just scores the tricks.${esc(reshuffle)}</p>
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
  const padRows = vm.state.handLog.map((h, i) => `<tr><th scope="row">Hand ${i + 1}</th>${h.scores.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('');
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
