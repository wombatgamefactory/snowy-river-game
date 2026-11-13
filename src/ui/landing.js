// landing.js - the landing page, which is also the setup screen (a sell sheet with a form in it),
// plus the How to play text that the in-game Rules dialog reuses. Pure string builders and two small
// form helpers; main.js owns the wiring.
// Snowy River has no Playtest switches: there is no rules panel, no rules note and no
// variant plumbing here; every game is the standard (v6) rules. There is no rule book link: the printed
// rule book describes the older rules, so the game's own How to play is the only rules text.

import { SUIT_ORDER, SUIT_NAMES, SUIT_ICONS } from '../engine/index.js';
import { GAME_NAME, GAME_TAGLINE, FOOTER_VERSION, MAX_SEATS, PLAYER_COUNTS, AT_A_GLANCE } from '../game-config.js';
import { assetUrl, img, badgeImg, esc } from './assets.js';

export { MAX_SEATS, PLAYER_COUNTS };

/** The bot levels offered, in menu order. A level that is not registered is shown but disabled. */
export const LEVELS = [
  { id: 'easy', label: 'Easy' },
  { id: 'medium', label: 'Medium' },
  { id: 'hard', label: 'Hard' },
];

export const DEFAULT_SETUP = {
  players: 4,
  seats: [
    { type: 'human', name: '' }, { type: 'easy', name: '' }, { type: 'easy', name: '' }, { type: 'easy', name: '' }, { type: 'easy', name: '' },
  ], // one entry for each of the five seats; only the first `players` are used
  rules: {}, // always the standard rules
  autoPlayForced: false, // off by default so new players see, and click, the only card they may play
};

const ICON_PLAYERS = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="13" cy="12" r="6" fill="#d9963a"/><path d="M3 34c0-7 4.5-12 10-12s10 5 10 12z" fill="#d9963a"/><circle cx="28" cy="12" r="6" fill="#b4532f"/><path d="M18 34c0-7 4.5-12 10-12s10 5 10 12z" fill="#b4532f"/></svg>';
const ICON_TIME = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="15" fill="none" stroke="#d9963a" stroke-width="3"/><path d="M20 10v10l7 4" stroke="#b4532f" stroke-width="3.2" stroke-linecap="round" fill="none"/></svg>';
const ICON_AGE = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="7" y="5" width="20" height="28" rx="3" fill="#d9963a" transform="rotate(-10 17 19)"/><rect x="14" y="8" width="20" height="28" rx="3" fill="#b4532f" stroke="#2b1a10" stroke-width="1.5" transform="rotate(8 24 22)"/></svg>';

// ---------- How to play ----------

/** The rules in plain steps, as a new player needs them, in teaching order. */
export function howToPlayHtml() {
  const suits = SUIT_ORDER.map((k) => `<li>${badgeImg(k, 'how__badge')}<span>${esc(SUIT_NAMES[k])} <small>${esc(SUIT_ICONS[k])}${k === 'muster' ? ', 5 players only' : ''}</small></span></li>`).join('');
  return `<div class="how">
    <p class="how__lead">Every hand is the ride. Going up the mountain, the big horses win. Over the top, the smallest horse wins. The mob is laid out below you, brumby by brumby, with wombat holes among them, and sometimes the Colt from old Regret. Win the good cards, dodge the bad ones.</p>
    <ol class="how__steps">
      <li><h3>The cards</h3><p>48 horse cards: four suits, each running 1 to 12, with <b>one number</b> on every card. With five players the violet <b>Muster</b> suit joins in (60 cards); it is never trumps. Three more things sit on the table: the six <b>Climb cards</b> (five worth +1 and one worth -1), the twelve <b>Brumby cards</b> (+2, +1, Flint stones -1, Wombat holes -2 and the Colt +4), and nothing else to track.</p>
        <ul class="how__suits" aria-label="The suits">${suits}</ul></li>
      <li><h3>The deal</h3><p>Everyone gets 12 cards. Cards not dealt stay out, unseen. A game is one hand for each player, or three hands with two players. The six Climb cards are shuffled and laid face up in a row each hand, so the -1 lands on a different trick every time.</p></li>
      <li><h3>The climb: six tricks, highest wins</h3><p>The player left of the dealer leads. <b>Follow suit if you can;</b> otherwise play anything. <b>Escape is trumps</b> on the climb: if any Escape card is played, the highest Escape card wins. Otherwise the highest card of the suit led wins. The winner takes <b>the next Climb card</b> (worth +1, or the one -1) and leads the next trick.</p></li>
      <li><h3>The summit</h3><p>When the Climb row is empty you are over the top. The direction flips: <b>the lowest card wins</b> and <b>Home is trumps</b>. Six Brumby cards are dealt face up in a row, one for each descent trick.</p></li>
      <li><h3>The descent: six tricks, lowest wins</h3><p>The player who won the last climb trick leads. Follow suit if you can. If any Home card is played, the lowest Home card wins; otherwise the lowest card of the suit led wins. The winner takes <b>the next card in the Brumby row</b>, good or bad, and leads the next trick. There is no choice: you keep what you win.</p></li>
      <li><h3>Scoring and winning</h3><p>Add up the Climb cards and Brumby cards you took. Tricks themselves score nothing, and a hand can end below zero. The Brumby deck lasts two hands and is then reshuffled. The highest total after the last hand wins. A tie goes to the most points in the last hand; if still level, the win is shared.</p></li>
    </ol>
    <p class="how__tip">The 1 is the weedy Timor pony: useless going up, the best card coming down. The player who swept the climb with the big horses has nothing left for the descent.</p>
  </div>`;
}

// ---------- the page ----------

/** The hero: the key art with the title in it (assets hero-wide), whole at every width. */
function heroHtml() {
  const wide = assetUrl('hero-wide');
  if (!wide) {
    const glyphs = SUITS.map((s) => badgeImg(s, 'hero__suit')).join('');
    return `<div class="hero__art hero__art--plain"><p class="hero__title">${esc(GAME_NAME)}</p><p class="hero__suits" aria-hidden="true">${glyphs}</p></div>`;
  }
  return `<div class="hero__art">${img('hero-wide', { alt: `${GAME_NAME}: a rider on the mountain, the wild mob streaming down the slope`, cls: 'hero__img', label: GAME_NAME, w: 1600, h: 670 })}</div>`;
}

/** Options for a seat's type select. `levels` is botLevels() (what the registry offers). */
export function seatTypeOptions(levels, selected) {
  const offered = levels.filter((l) => l.offered !== false);
  const have = new Set(offered.map((l) => l.id));
  const known = new Set(LEVELS.map((l) => l.id));
  const extra = offered.filter((l) => !known.has(l.id)).map((l) => ({ id: l.id, label: l.label }));
  const opts = [{ id: 'human', label: 'Human', ok: true }, ...[...LEVELS, ...extra].map((l) => ({ id: l.id, label: `${l.label} bot`, ok: have.has(l.id) }))];
  return opts.map((o) => `<option value="${o.id}"${o.id === selected ? ' selected' : ''}${o.ok ? '' : ' disabled'}>${esc(o.label)}${o.ok ? '' : ' (not available yet)'}</option>`).join('');
}

function have(levels, id) {
  return id === 'human' || levels.some((l) => l.id === id && l.offered !== false);
}

function seatFieldset(i, levels, setup) {
  const seat = setup.seats[i];
  const type = have(levels, seat.type) ? seat.type : 'easy';
  return `<fieldset class="seatform" data-seat="${i}"${i >= setup.players ? ' hidden' : ''}>
      <legend>Seat ${i + 1}</legend>
      <label class="field"><span>Player</span><select name="type${i}">${seatTypeOptions(levels, type)}</select></label>
      <label class="field"><span>Name <small>(optional)</small></span><input name="name${i}" type="text" maxlength="16" autocomplete="off" value="${esc(seat.name)}" placeholder="${i === 0 ? 'You' : `Seat ${i + 1}`}"></label>
    </fieldset>`;
}

/** The whole landing / setup page. `levels` is botLevels(); `setup` the form defaults; `message` an error. */
export function landingHtml(levels, setup = DEFAULT_SETUP, message = '') {
  const seats = Array.from({ length: MAX_SEATS }, (_, i) => seatFieldset(i, levels, setup)).join('');
  const radios = PLAYER_COUNTS.map((n) => `<label class="seg"><input type="radio" name="players" value="${n}"${setup.players === n ? ' checked' : ''}><span>${n} players</span></label>`).join('');
  return `<div class="landing">
    <nav class="topnav" aria-label="Site">
      <span class="topnav__brand">${esc(GAME_NAME)}</span>
      <span class="topnav__links" id="topnav-links">
        <button type="button" class="linkbtn" data-action="open-rules">How to play</button>
        <button type="button" class="linkbtn" data-action="open-stats">Stats</button>
      </span>
    </nav>
    <header class="hero">
      ${heroHtml()}
      <h1 class="sr-only">${esc(GAME_NAME)}</h1>
      <div class="hero__text">
        <p class="hero__hook">${esc(GAME_TAGLINE)}</p>
        <p class="hero__sub">A trick-taking card game from Banjo Paterson's poem, for ${esc(AT_A_GLANCE.players)} players. Every hand is the ride: up the mountain the big horses win, then over the top the weedy ponies take over. The mob is laid out below you, brumby by brumby, with wombat holes among them, and maybe the Colt. Win the good ones, dodge the bad ones. Play against bots or pass the device to friends.</p>
        <p class="hero__links"><a class="btn btn--quiet" href="#how">How to play</a></p>
      </div>
    </header>
    <ul class="stats" aria-label="At a glance">
      <li>${ICON_PLAYERS}<div><b>${esc(AT_A_GLANCE.players)}</b><span>Players</span></div></li>
      <li>${ICON_TIME}<div><b>${esc(AT_A_GLANCE.minutes)}</b><span>Minutes</span></div></li>
      <li>${ICON_AGE}<div><b>${esc(AT_A_GLANCE.age)}</b><span>Ages</span></div></li>
    </ul>
    <section class="panel setup-panel" aria-labelledby="setup-title">
      <h2 id="setup-title">Set up a game</h2>
      <form id="setup-form" novalidate>
        <fieldset class="players"><legend>Players</legend><div class="segs">${radios}</div></fieldset>
        <div class="setup__seats">${seats}</div>
        <p class="hint">Set every seat to a bot to watch a game. With two or more humans you pass the device, and a cover hides each hand between turns.</p>
        <label class="check"><input type="checkbox" name="autoPlayForced" id="autoPlayForced"${setup.autoPlayForced ? ' checked' : ''}><span><b>Play forced cards for me</b><small>When you have only one card you are allowed to play, play it automatically. Leave this off while you learn which cards are legal.</small></span></label>
        <p class="form-msg" role="alert">${esc(message)}</p>
        <button type="submit" class="btn btn--primary btn--big" id="start">Start game</button>
      </form>
    </section>
    <section class="panel" id="how" aria-labelledby="how-title">
      <h2 id="how-title">How to play</h2>
      ${howToPlayHtml()}
    </section>
    <footer class="footer">
      <span><b>Game design: Dean Morris</b> &middot; Wombat Game Factory &middot; London, UK</span>
      <span>${esc(FOOTER_VERSION)}</span>
    </footer>
  </div>`;
}

// ---------- form helpers ----------

/** Reads the form into a setup object (never throws). */
export function readSetup(form) {
  const v = (n) => (form.elements[n] ? form.elements[n].value : '');
  const checked = form.querySelector('input[name="players"]:checked');
  const players = checked ? Number(checked.value) : 4;
  const seats = Array.from({ length: MAX_SEATS }, (_, i) => ({ type: v(`type${i}`) || (i === 0 ? 'human' : 'easy'), name: v(`name${i}`).trim() }));
  const auto = form.elements.autoPlayForced;
  return { players, seats, rules: {}, autoPlayForced: !!(auto && auto.checked) };
}

/** Shows only the seats that are in play. */
export function syncSetupForm(form) {
  const setup = readSetup(form);
  form.querySelectorAll('fieldset.seatform').forEach((fs) => { fs.hidden = Number(fs.dataset.seat) >= setup.players; });
}

/** The rules code for a setup: always 'std' (there are no Playtest switches). */
export function safeCode() {
  return 'std';
}

/** Typed names made unique (case-insensitive): two "Sam"s become "Sam" and "Sam 2". */
export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    if (!n) return n;
    const key = n.toLowerCase();
    const k = (seen.get(key) || 0) + 1;
    seen.set(key, k);
    return k === 1 ? n : `${n} ${k}`;
  });
}

/** Whether a setup has two or more humans (pass-and-play). */
export function humanCount(setup) {
  return setup.seats.slice(0, setup.players).filter((s) => s.type === 'human').length;
}
