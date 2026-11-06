// components.js - HTML string builders for the game screen: the phase banner, seats (with climb and
// descent piles), the Mountain card with the mob marker, the Colt with its Brumby cards, the current
// trick, the hand, the summit decision, the reveal, the score pad, the log and the overlays
// (pass-and-play cover, the reckoning at the end of a hand, the end of the game). Pure string functions
// of a view-model `vm` built in main.js; no DOM access, no game logic: every number comes from the
// board (events) or the engine, and "who is at the heels" is the engine's own heelsOf().
//
// vm = { board, names, types, humanSeats, me, shown, hand, reasons, hints, myTurn, view,
//        ui, log, state (read-only: handLog, result, params), frame (the playback frame or null) }

import { SUIT_NAMES, CONSTANTS, cardSuit, cardName, isCardPhase, heelsOf, mobValueFor } from '../engine/index.js';
import { esc, img, cardImg, cardBackImg, badgeImg, avatarId } from './assets.js';
import { turnPrompt, waitingText, winnerBanner, tiebreakText, phaseText, phaseParts, stakesText, outcomeText, bannerText, stepCallout, rankRangeText, phaseBest, descentGoal } from './text.js';

export { esc };

const youName = (n) => n === 'You';
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const signed = (x) => (x > 0 ? `+${x}` : `${x}`);

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

/** The seat at the mob's heels right now (the engine's tie rule), or null outside the descent. */
export function heelsSeat(b) {
  if (b.phase !== 'descent' || !b.descentTricks.some((d) => d > 0)) return null;
  return heelsOf(b.descentTricks, b.lastDescentWin).seat;
}

/** The seats in the order of the heels race: the first is at the heels now (the engine's tie rule), then the next, and so on. */
export function standing(b, take = 2) {
  const out = [];
  let pool = b.descentTricks.map((_, s) => s);
  while (out.length < take && pool.length) {
    const h = heelsOf(pool.map((s) => b.descentTricks[s]), pool.map((s) => b.lastDescentWin[s]));
    const seat = pool[h.seat];
    out.push(seat);
    pool = pool.filter((s) => s !== seat);
  }
  return out;
}

/** The seat's summit card as the table may show it: face down before the reveal (R12.5). */
function choiceChip(vm, s) {
  const b = vm.board;
  if (b.revealed && b.choices[s]) {
    const c = b.choices[s];
    return `<span class="schip schip--choice schip--${c}" title="${c === 'chase' ? 'Chose Chase' : 'Chose Watch'}">${img(c, { cls: 'schip__card', alt: '', label: '', w: 24, h: 34, fallback: '' })}<b>${c === 'chase' ? 'Chase' : 'Watch'}</b></span>`;
  }
  if (b.phase === 'summit') {
    // The viewer's own choice may be shown to the viewer only (from the view, never the board).
    const own = vm.view && vm.view.seat === s && vm.view.choices[s];
    if (own) return `<span class="schip schip--choice schip--own" title="Your choice, still face down to everyone else">${img(own, { cls: 'schip__card', alt: '', label: '', w: 24, h: 34, fallback: '' })}<b>${own === 'chase' ? 'Chase' : 'Watch'}</b><i>face down</i></span>`;
    return `<span class="schip schip--choice" title="Summit choice, face down until everyone has chosen">${cardBackImg('schip__card')}<b>${b.chosen[s] ? 'Chosen' : 'Choosing'}</b>${b.chosen[s] ? '<i>face down</i>' : ''}</span>`;
  }
  // The same row is kept (empty) through the climb, so a seat is the same height before, at and after the summit.
  if (b.phase === 'climb') return '<span class="schip schip--slot" aria-hidden="true"></span>';
  return '';
}

// ---------- seats ----------

const MINI_MAX = 14;
function pileHtml(kind, count, bump, heels = false) {
  const minis = Array.from({ length: Math.min(count, MINI_MAX) }, () => `<i class="mini mini--${kind === 'climb' ? 'up' : 'side'}"></i>`).join('');
  const title = kind === 'climb' ? 'Climb tricks won this hand: 1 point each if kept' : "Descent tricks won this hand: the most puts you at the mob's heels";
  return `<span class="pile pile--${kind}${bump ? ' fx-bump' : ''}${heels ? ' is-heels' : ''}" title="${esc(title)}" aria-label="${plural(count, `${kind} trick`, `${kind} tricks`)}"><span class="pile__minis" aria-hidden="true">${minis}</span><b>${count}</b><i>${kind}</i></span>`;
}

export function seatHtml(vm, s, area) {
  const b = vm.board;
  const name = vm.names[s];
  const toAct = b.toAct === s && b.phase !== 'over';
  const heels = heelsSeat(b) === s;
  const tags = [];
  // The heels tag comes first, directly above the descent pile (which is on the left and rings in the same colour).
  if (heels) tags.push(`<span class="tag tag--heels" title="Most descent tricks so far: at the mob's heels">${badgeImg('home', 'tag__badge')}At the heels</span>`);
  if (b.phase !== 'over' && b.dealer === s) tags.push('<span class="tag tag--dealer" title="Dealer this hand">Dealer</span>');
  if (toAct) tags.push(`<span class="tag tag--turn">${b.phase === 'summit' ? 'Choosing' : (vm.types[s] === 'human' && vm.humanSeats.length === 1 ? 'Your turn' : 'To play')}</span>`);
  const cards = b.handCounts[s];
  const winning = b.trick && b.trick.winner === s;
  const wonNow = b.fx && b.fx.won === s ? b.fx.phase : null;
  return `<article class="seat area-${area}${toAct ? ' is-turn' : ''}${winning ? ' is-winning' : ''}${heels ? ' is-heels' : ''}" data-seat="${s}" aria-label="${esc(name)}">
    <header class="seat__head">
      ${avatar(s)}
      <div class="seat__id"><b class="seat__name">${esc(name)}</b>${badge(vm, s)}<span class="seat__hand" title="Cards in hand" aria-label="${plural(cards, 'card', 'cards')} in hand"><b class="seat__cardsnum" data-cards="${s}">${cards}</b> ${cards === 1 ? 'card' : 'cards'}</span></div>
    </header>
    ${tags.length ? `<div class="seat__tags">${tags.join('')}</div>` : ''}
    <div class="seat__piles">${pileHtml('descent', b.descentTricks[s], wonNow === 'descent', heels)}${pileHtml('climb', b.climbTricks[s], wonNow === 'climb')}${choiceChip(vm, s)}</div>
    <footer class="seat__score">
      <span class="total" title="Total over finished hands; mobs brought home break a tie">Total <b>${b.totals[s]}</b></span>${b.mobsHome[s] ? `<span class="plus" title="Mobs brought home: the tiebreak">${badgeImg('home', 'tag__badge')}${b.mobsHome[s]} home</span>` : ''}
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
      <div class="stage__colt">${coltHtml(vm)}</div>
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
    const icon = b.phase === 'climb' ? badgeImg('climb', 'phasebar__badge') : b.phase === 'descent' ? badgeImg('descent', 'phasebar__badge') : img('mob-marker', { cls: 'phasebar__badge phasebar__badge--mob', alt: '', label: '', w: 36, h: 36, fallback: '' });
    const meta = `Hand ${Math.min(b.handNo + 1, b.handsPerGame)} of ${b.handsPerGame} &middot; Trick ${b.trickNo + 1} &middot; Dealer: ${esc(names[b.dealer])}`;
    const best = phaseBest(b.phase, CONSTANTS.RANK_MIN, CONSTANTS.RANK_MAX);
    head = `<div class="phasebar phasebar--${esc(b.phase)}" role="status" aria-label="${esc(phaseText(b.phase))}">${icon}<span class="phasebar__name">${esc(p.name)}</span>${p.rule ? `<span class="phasebar__rule">${esc(p.rule)}${best ? ` <em class="phasebar__best">(${esc(best)})</em>` : ''}</span>` : ''}<strong class="phasebar__range">${esc(rankRangeText(CONSTANTS.RANK_MIN, CONSTANTS.RANK_MAX))}</strong><small class="phasebar__meta">${meta}</small></div>`;
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
 * Where each step's circle is printed on the 480 x 336 art, in px (measured on assets/cards/mountain-7.webp
 * and mountain-6.webp, step 0 at the bottom). The two sides differ, so each has its own table.
 */
const MOUNTAIN_ART = { w: 480, h: 336 };
export const MOUNTAIN_STEPS = {
  '0-7': [[132, 310], [186, 268], [188, 212], [124, 192], [118, 138], [174, 120], [186, 74], [228, 48]],
  '0-6': [[180, 308], [224, 262], [200, 208], [138, 162], [152, 124], [192, 92], [226, 54]],
};

/** [left %, top %] of a step on the Mountain card. */
export function stepPosition(side, step) {
  const pts = MOUNTAIN_STEPS[side] || MOUNTAIN_STEPS['0-7'];
  const p = pts[Math.max(0, Math.min(pts.length - 1, step))];
  return [+(p[0] / MOUNTAIN_ART.w * 100).toFixed(2), +(p[1] / MOUNTAIN_ART.h * 100).toFixed(2)];
}

/** The Mountain card (0-7, or 0-6 for five players) with the marker on its step and the callout of the step just taken. */
export function mountainHtml(vm) {
  const b = vm.board;
  const side = b.mountainSide;
  const [left, top] = stepPosition(side, b.marker);
  const fx = b.fx && b.fx.marker ? b.fx.marker : null;
  const call = stepCallout(fx);
  const callout = call ? `<span class="mountain__callout${call.off ? ' is-off' : ''}" style="left:${left}%;top:${top}%" title="${esc(call.title)}">${esc(call.text)}</span>` : '';
  const marker = `<span class="mountain__marker" data-side="${esc(side)}" data-step="${b.marker}" style="left:${left}%;top:${top}%">${img('mob-marker', { cls: 'mountain__piece', alt: 'The mob', label: 'Mob', w: 64, h: 64 })}</span>`;
  let fxText = '';
  if (fx) fxText = `${call.off ? 'Off-suit card: ' : ''}the mob climbs${fx.steps > 1 ? ` ${fx.steps} steps` : ' a step'}${fx.offSuit ? ` (1 + ${fx.offSuit} off-suit)` : ''}${fx.step === fx.of && fx.summit ? ': the summit!' : ''}`;
  const heels = heelsSeat(b);
  let line = '';
  let standingLine = '';
  if (b.phase === 'descent') {
    line = heels !== null ? `At the mob's heels: <b>${esc(vm.names[heels])}</b> with ${plural(b.descentTricks[heels], 'descent trick', 'descent tricks')}` : "At the mob's heels: nobody yet (the most descent tricks)";
    const order = heels !== null ? standing(b, 2) : [];
    if (order.length === 2 && b.descentTricks[order[1]] > 0) standingLine = `Leading: ${esc(vm.names[order[0]])} (${b.descentTricks[order[0]]}), next: ${esc(vm.names[order[1]])} (${b.descentTricks[order[1]]})`;
  }
  return `<div class="mountain" data-side="${esc(side)}">
    <div class="mountain__card">${img(`mountain-${side === '0-6' ? 6 : 7}`, { cls: 'mountain__img', alt: `Mountain card, steps ${side}`, label: `Mountain ${side}`, w: 480, h: 336 })}${marker}${callout}</div>
    <p class="mountain__title" aria-live="polite">The mob is on step <b data-marker>${b.marker}</b> of ${b.summitStep}${line ? '' : ` &middot; the summit is step ${b.summitStep}`}</p>
    <p class="mountain__fx" aria-live="polite">${esc(fxText)}</p>
    ${line ? `<p class="mountain__heels">${line}</p>` : ''}${standingLine ? `<p class="mountain__standing">${standingLine}</p>` : ''}
  </div>`;
}

/** The Colt card with its Brumby cards tucked under it, and what the mob is worth. */
export function coltHtml(vm) {
  const b = vm.board;
  const k = b.brumbies;
  const fan = Array.from({ length: k }, (_, i) => `<span class="brumby" style="--i:${i}">${img('brumby-front', { cls: 'brumby__img', alt: '', label: '+2', w: 84, h: 120, fallback: '<span class="brumby__img asset-chip">+2</span>' })}<i class="brumby__chip">+2</i></span>`).join('');
  const next = mobValueFor(vm.state.params, k);
  const nextLine = next !== b.mob ? `<small class="mob__next">Next hand: ${next}</small>` : '';
  const sum = `Colt ${vm.state.params.mobBase} + ${plural(k, 'Brumby card', 'Brumby cards')} x ${vm.state.params.brumbyValue}`;
  return `<div class="colt" aria-label="The mob: the Colt card and ${plural(k, 'Brumby card', 'Brumby cards')}, worth ${b.mob}">
    <div class="colt__pile" style="--k:${k}">${fan}${img('colt', { cls: 'colt__img', alt: 'The Colt card', label: 'Colt', w: 480, h: 336 })}</div>
    <p class="mob"><span class="mob__label">The mob is worth</span> <b class="mob__value" data-mob>${b.mob}</b><small class="mob__sum">${esc(sum)}</small>${nextLine}</p>
  </div>`;
}

// ---------- the current trick ----------

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
    if (p.offSuit) tags.push('off-suit');
    if (win) tags.push('wins');
    const offTitle = t.phase === 'climb' ? 'Off-suit: it cannot win, and the mob climbs a step' : 'Off-suit: it cannot win this trick';
    return `<li class="tplay${win ? ' is-winner' : ''}${p.offSuit ? ' is-offsuit' : ''}${t.winner !== null && !win ? ' is-lost' : ''}"><span class="tplay__card">${cardImg(p.card, { alt: cardName(p.card) })}</span><span class="tplay__who">${esc(names[s])}</span><span class="tplay__tags">${tags.map((x) => `<i class="mark mark--${x}"${x === 'off-suit' ? ` title="${offTitle}"` : ''}>${x}</i>`).join('')}</span></li>`;
  }).join('');
  let title;
  if (!t) title = `Trick ${b.trickNo + 1}`;
  else if (t.ledSuit) title = `Trick ${t.n} &middot; <span class="led led--${t.ledSuit}">${badgeImg(t.ledSuit, 'led__badge')}${esc(`${SUIT_NAMES[t.ledSuit]} led`)}</span>`;
  else title = `Trick ${t.n}`;
  let banner = b.banner && b.banner.kind === 'trick' ? b.banner : null;
  if (!banner && t && t.done) banner = { winner: t.winner, card: t.winningCard, phase: t.phase };
  let msg = '';
  if (banner) msg = winnerBanner(banner, names);
  else if (b.phase === 'summit') msg = 'At the summit: everyone chooses Chase or Watch in secret.';
  else if (b.phase === 'over') msg = '';
  else if (!t) msg = b.toAct !== null ? `${names[b.toAct]} ${youName(names[b.toAct]) ? 'lead' : 'leads'} the next trick.` : '';
  if (b.phase === 'over') return '<div class="trick"><p class="trick__title">Game over</p></div>';
  return `<div class="trick trick--${esc(t ? t.phase : b.phase)}"><p class="trick__title">${title}</p><ol class="tplays">${slots}</ol><p class="trick__msg${banner ? ' is-banner' : ''}" id="trick-msg">${esc(msg)}</p></div>`;
}

// ---------- the hand ----------

export function handHtml(vm) {
  const hand = vm.hand;
  if (!hand) return '';
  const playing = vm.myTurn && isCardPhase(vm.state.phase);
  const items = hand.map((card, i) => {
    const reason = vm.reasons.get(card) || null;
    const hint = vm.hints.get(card) || null;
    const legal = playing && !reason;
    const suit = cardSuit(card);
    const cls = ['card', `card--${suit}`];
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
  const rule = vm.state.phase === 'descent' ? 'lowest' : 'highest';
  const legend = playing && vm.view.trick && vm.view.trick.ledSuit
    ? `<p class="legend"><span class="hint-dot is-win">&#10003;</span> would win the trick as it stands (${rule} of the suit led wins) <span class="hint-dot is-lose">&#10007;</span> would not. Dimmed cards cannot be played: hover or tap one to see why.</p>`
    : (playing ? '<p class="legend">You lead: play any card. Dimmed cards cannot be played: hover or tap one to see why.</p>' : '');
  const title = `${who} <span>sorted by suit; each suit runs ${CONSTANTS.RANK_MIN} to ${CONSTANTS.RANK_MAX}</span>`;
  return `<div class="handbox${vm.myTurn ? ' is-turn' : ''}">
    <p class="handbox__title">${title}</p>
    <div class="hand-wrap">${handHtml(vm)}</div>
    ${legend}
    <p class="preview" id="preview" aria-live="polite"></p>
    <p class="note" id="note" role="status">${esc(vm.ui.note || '')}</p>
  </div>`;
}

// ---------- the summit ----------

/**
 * The summit decision (R5): a Chase card and a Watch card as buttons, each with the stakes from
 * view.stakes (R12.10). data-action="decide" with the action as JSON in data-decision; main.js sends it
 * to the controller. Shown to one human at a time, in a modal.
 */
export function decisionHtml(vm) {
  if (!vm.myTurn || vm.state.phase !== 'summit' || !vm.view) return '';
  const st = stakesText(vm.view);
  const btn = (choice, label, line) => `<button type="button" class="decide decide--${choice}" data-action="decide" data-decision='${JSON.stringify({ type: 'summit', choice })}' aria-label="${esc(`${label}. ${line}`)}">${img(choice, { cls: 'decide__card', alt: '', label, w: 150, h: 214 })}<span class="decide__stakes">${esc(line)}</span></button>`;
  return `<div class="decision" role="group" aria-label="Chase or Watch">
    <div class="decision__buttons">${btn('chase', 'Chase', st.chase)}${btn('watch', 'Watch', st.watch)}</div>
  </div>`;
}

/** The summit as its own step: an overlay with the two cards. Nothing here names a side before the reveal. */
export function summitModalHtml(vm) {
  if (!vm.myTurn || vm.state.phase !== 'summit' || !vm.view) return '';
  const v = vm.view;
  const who = vm.humanSeats.length > 1 ? `${esc(vm.names[vm.shown])}, choose in secret` : 'Choose in secret';
  const heldLine = `You hold ${plural(v.stakes.climbTricks, 'climb trick', 'climb tricks')} (${plural(v.stakes.climbPoints, 'point', 'points')}). The mob is worth ${v.stakes.mob}.`;
  return `<div class="overlay overlay--summit" data-overlay="summit"><div class="end end--summit" role="dialog" aria-modal="true" aria-labelledby="summit-title">
    <p class="end__kicker">The summit</p>
    <h2 id="summit-title" tabindex="-1" data-autofocus>${who}: Chase or Watch?</h2>
    <p class="summit__held">${esc(heldLine)}</p>
    ${decisionHtml(vm)}
    <p class="summit__rule">To bring the mob home you must win the most descent tricks; a tie goes to whoever won the later trick.</p>
    <p class="summit__note">Everyone's card is turned together. Chasers need the most descent tricks to bring the mob home. If nobody chases, the hand ends here and everyone banks their climb tricks.</p>
  </div></div>`;
}

/** The reveal: every seat's Chase or Watch card turned face up (shown for a beat during playback). */
export function revealHtml(vm) {
  const b = vm.board;
  if (!b.revealed) return '';
  // The cards are turned together, so they are laid out the way the seats sit round the table: the viewer
  // first, then clockwise (the engine's collection order starts at the last climb winner, which put an
  // opponent first and "You" in the middle of the row).
  const n = b.choices.length;
  const order = Array.from({ length: n }, (_, k) => (vm.me + k) % n);
  const faces = order.map((s) => {
    const c = b.choices[s];
    return `<li class="reveal__seat reveal__seat--${c}">${img(c, { cls: 'reveal__card', alt: c === 'chase' ? 'Chase' : 'Watch', label: c, w: 120, h: 171 })}<span class="reveal__who">${esc(vm.names[s])}</span></li>`;
  }).join('');
  const nobody = b.banner && b.banner.kind === 'nobody';
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
      rows.push(`<tr><th scope="row">Hand ${h + 1}</th>${rec.scores.map((x, s) => `<td title="${esc(`${rec.choices[s] || '-'}, ${rec.climbTricks[s]} climb, ${rec.descentTricks[s]} descent: ${outcomeText(rec.outcomes[s])}`)}">${x}</td>`).join('')}</tr>`);
    } else if (h === b.handNo && b.phase !== 'over') {
      rows.push(`<tr class="is-now"><th scope="row">Hand ${h + 1} <small>climb</small></th>${names.map((_, s) => `<td title="Climb tricks so far">${b.climbTricks[s]}</td>`).join('')}</tr>`);
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

/** What each seat did this hand, in words and sums (R9.5: every case). */
function reckonRow(vm, ev, s) {
  const bd = ev.breakdown[s];
  const names = vm.names;
  let what;
  let sum = '';
  if (bd.outcome === 'home') {
    what = 'Brought the mob home';
    sum = `${bd.climbPoints} climb + ${bd.mobPoints} mob`;
  } else if (bd.outcome === 'fell') {
    what = 'Fell: -1';
    sum = bd.climbTricks ? `${plural(bd.climbTricks, 'climb trick', 'climb tricks')} lost` : 'no climb tricks to lose';
  } else {
    what = 'Watched';
    sum = bd.climbTricks ? `banks ${plural(bd.climbTricks, 'climb trick', 'climb tricks')}` : 'no climb tricks';
  }
  const choice = bd.choice === 'chase' ? 'chase' : 'watch';
  const descent = ev.endReason === 'descent' ? `${plural(bd.descentTricks, 'descent trick', 'descent tricks')}` : '';
  return `<li class="reck__row reck__row--${esc(bd.outcome)}" data-seat="${s}">
    ${avatar(s, 'reck__avatar')}
    <span class="reck__who"><b>${esc(names[s])}</b>${ev.heelsSeat === s ? ` <i class="mark mark--heels">at the heels</i>` : ''}<small>${descent ? `${esc(descent)}` : ''}</small></span>
    <span class="reck__choice">${img(choice, { cls: 'reck__card', alt: '', label: '', w: 28, h: 40, fallback: '' })}<b>${choice === 'chase' ? 'Chase' : 'Watch'}</b></span>
    <span class="reck__what"><b>${esc(what)}</b><small>${esc(sum)}</small></span>
    <b class="reck__score" aria-label="${signed(bd.score)} points">${signed(bd.score)}</b>
    <span class="reck__total">Total <b>${ev.totals[s]}</b></span>
  </li>`;
}

/** The end-of-hand reckoning (R9.5: every case). `modal.event` is the engine's hand-ended event. */
export function handSummaryHtml(vm, modal) {
  const ev = modal.event;
  const names = vm.names;
  const last = vm.state.phase === 'over' && modal.handNo === vm.state.handLog.length - 1;
  const rows = names.map((_, s) => reckonRow(vm, ev, s)).join('');
  const nameOf = (s) => names[s];
  let note;
  let kind;
  if (ev.endReason === 'nobody-chases') {
    kind = 'nobody';
    note = 'Nobody chased: the hand ended at the summit, the mob ran free and everyone banked their climb tricks.';
  } else if (ev.broughtHomeBy !== null) {
    kind = 'home';
    const h = nameOf(ev.broughtHomeBy);
    note = `${h} ${youName(h) ? 'were' : 'was'} at the mob's heels and brought it home: climb tricks + the mob (${ev.mobValue}). Any other chaser fell for -1.`;
  } else {
    kind = 'escaped';
    const h = nameOf(ev.heelsSeat);
    note = `${h} ${youName(h) ? 'were' : 'was'} at the mob's heels but watched, so the mob escaped and every chaser fell for -1.`;
  }
  const tie = ev.tieAtHeels && ev.heelsSeat !== null ? ` Level on descent tricks, ${nameOf(ev.heelsSeat)} won the later one.` : '';
  const brumby = ev.broughtHomeBy !== null
    ? 'The Brumby cards go back to the box: next hand the mob is worth 3.'
    : (ev.brumbyAdded ? `A Brumby card goes under the Colt (${plural(ev.brumbiesAfter, 'card', 'cards')} now): the mob will be worth ${vm.state.params.mobBase + vm.state.params.brumbyValue * ev.brumbiesAfter}.` : `All ${ev.brumbiesAfter} Brumby cards are already under the Colt, so nothing is added.`);
  const title = `Hand ${modal.handNo + 1} of ${vm.board.handsPerGame} is over`;
  return `<div class="overlay overlay--hand" data-overlay="hand"><div class="end end--hand end--${kind}" role="dialog" aria-modal="true" aria-labelledby="hand-title">
    <p class="end__kicker">The reckoning</p>
    <h2 id="hand-title">${esc(title)}</h2>
    <p class="end__note end__note--lead">${esc(note + tie)} ${esc(brumby)}</p>
    <ol class="reck" aria-label="Scores for this hand">${rows}</ol>
    <p class="end__note">Watch: +1 per climb trick. Chase and bring the mob home: climb tricks + the mob. Chase and fall: -1.</p>
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
    return `<li class="rank${win ? ' is-winner' : ''}"><span class="rank__pos">${eq}${r.rank}</span>${avatar(r.seat, 'rank__avatar')}<span class="rank__who"><b>${esc(names[r.seat])}</b>${badge(vm, r.seat)}${win ? `<i class="crown">${result.shared ? 'Shared win' : 'Winner'}</i>` : ''}</span><span class="rank__total"><b>${r.total}</b> pts <small>${badgeImg('home', 'tag__badge')}${plural(r.mobsHome, 'mob', 'mobs')} home</small></span></li>`;
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
