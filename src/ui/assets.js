// assets.js - the one place that turns an art id into an <img>.
//
// Every image in the UI is asked for by manifest id (assets/manifest.json): `img('card-back')`,
// `cardImg('escape-7')`. Missing art never leaves a broken image: an unknown id, a failed manifest
// load or a 404 on the file all end in a small text chip carrying the id's label (a card face
// falls back to a plain face with its number and suit shape). The page is built to look finished
// with the chips and to improve by itself when the art is there.
// Art ids follow assets/manifest.json. Keep BUILT_IN in
// step with the manifest (ui-node checks it).

import { SUITS, SUIT_ICONS, cardFace, cardSuit, cardNumber, cardName, fullDeck, brumbyFace, brumbyValue, brumbyName, climbCardFace, climbCardValue, climbCardName } from '../engine/index.js';

const BASE = 'assets/';

// Built-in id -> file table, used until (and if) assets/manifest.json loads. It mirrors the
// manifest, so the page works even if the manifest fetch fails (offline, file://, 404).
const BUILT_IN = {
  'card-back': 'cards/card-back.webp',
  'brumby-back': 'cards/brumby-back.webp',
  'brumby-plus2': 'cards/brumby-plus2.webp',
  'brumby-plus1': 'cards/brumby-plus1.webp',
  'brumby-flint': 'cards/brumby-flint.webp',
  'brumby-wombat': 'cards/brumby-wombat.webp',
  colt: 'cards/colt.webp',
  'climb-plus1': 'cards/climb-plus1.webp',
  'climb-minus1': 'cards/climb-minus1.webp',
  'climb-back': 'cards/climb-back.webp',
  favicon: 'favicon.png',
};
for (const s of SUITS) { BUILT_IN[`badge-${s}`] = `badge-${s}.webp`; BUILT_IN[`icon-${s}`] = `icon-${s}.webp`; }
for (let s = 1; s <= 5; s++) BUILT_IN[`avatar-${s}`] = `avatar-${s}.webp`;
for (const c of fullDeck(5)) BUILT_IN[cardFace(c)] = `cards/${cardFace(c)}.webp`;

const table = new Map(Object.entries(BUILT_IN).map(([id, file]) => [id, { file, w: 0, h: 0 }]));

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Reads assets/manifest.json ({ assets: [...] } or a bare array). Never throws; on any failure the built-in table stays. */
export async function loadManifest(timeoutMs = 2500) {
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const res = await fetch(`${BASE}manifest.json`, ctl ? { signal: ctl.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data && data.assets);
    if (!Array.isArray(list)) return false;
    for (const a of list) {
      if (a && typeof a.id === 'string' && typeof a.file === 'string') {
        if (a.status === 'missing') table.delete(a.id); // known to be absent: go straight to the chip, no 404
        else table.set(a.id, { file: a.file, w: a.width || 0, h: a.height || 0 });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Replaces the table from an already parsed manifest (tests). */
export function useManifest(data) {
  const list = Array.isArray(data) ? data : data.assets;
  table.clear();
  for (const a of list) if (a.status !== 'missing') table.set(a.id, { file: a.file, w: a.width || 0, h: a.height || 0 });
}

/** URL for an art id, or null if the id is unknown or marked missing. */
export function assetUrl(id) {
  const a = table.get(id);
  return a ? BASE + a.file : null;
}

/** Every id the built-in table knows (tests compare it with the manifest). */
export function builtInIds() {
  return Object.keys(BUILT_IN);
}

/** A text chip standing in for art. */
export function chip(label, cls = '') {
  return `<span class="asset-chip ${esc(cls)}" role="img" aria-label="${esc(label)}">${esc(label)}</span>`;
}

/**
 * An <img> for an art id, as an HTML string. Options: alt, cls, label (chip text if the art
 * is missing; defaults to alt or the id), w / h (intrinsic size attributes, stops layout jumps),
 * fallback (an HTML string to use instead of the plain chip when the art is missing).
 */
export function img(id, { alt = '', cls = '', label = '', w = 0, h = 0, fallback = '' } = {}) {
  const url = assetUrl(id);
  const text = label || alt || id;
  if (!url) return fallback || chip(text, cls);
  const size = w && h ? ` width="${w}" height="${h}"` : '';
  return `<img class="${esc(cls)}" src="${url}" alt="${esc(alt)}" data-asset="${esc(id)}" data-label="${esc(text)}"${size} decoding="async" draggable="false">`;
}

/** Glyph for each suit icon (a shape, so suits never rely on colour alone). */
const GLYPHS = { trophy: '▲', stockwhip: '●', hat: '■', saddle: '★', horseshoe: '◆' };
export const suitGlyph = (suit) => GLYPHS[SUIT_ICONS[suit]] || '?';

/** A card face drawn in HTML: its number and the suit shape, in the suit's colour (used when the art is missing). */
export function cardChip(card, cls = '') {
  const suit = cardSuit(card);
  return `<span class="asset-chip cardimg cardchip cardchip--${suit} ${esc(cls)}" role="img" aria-label="${esc(cardName(card))}"><b>${cardNumber(card)}</b><i aria-hidden="true">${suitGlyph(suit)}</i></span>`;
}

/** A card face as an <img> (the aspect ratio is fixed by CSS), or the drawn face when there is no art. One number per card, always upright. */
export function cardImg(card, { cls = '', alt = '' } = {}) {
  const c = `cardimg ${cls}`.trim();
  return img(cardFace(card), { cls: c, alt, label: cardName(card), w: 300, h: 428, fallback: cardChip(card, cls) });
}

/** A Brumby card (landscape, its value printed on it) by engine id ('brumby-plus2-3', 'colt', ...). */
export function brumbyImg(id, cls = '') {
  const v = brumbyValue(id);
  const text = `${v > 0 ? '+' : ''}${v}`;
  return img(brumbyFace(id), { cls: `brumbyimg ${cls}`.trim(), alt: brumbyName(id), label: text, w: 480, h: 336, fallback: `<span class="asset-chip brumbyimg brumbychip brumbychip--${v > 0 ? 'good' : 'bad'} ${esc(cls)}" role="img" aria-label="${esc(brumbyName(id))}">${text}</span>` });
}

/** The face-down Brumby deck card (landscape). */
export function brumbyBackImg(cls = '') {
  return img('brumby-back', { cls: `brumbyimg ${cls}`.trim(), alt: '', label: 'Brumby card', w: 480, h: 336, fallback: `<span class="asset-chip brumbyimg brumbychip ${esc(cls)}" role="img" aria-label="Brumby card, face down"></span>` });
}

/** A Climb card (landscape, +1 or -1 printed on it) by engine id ('climb-plus1-3', 'climb-minus1'). */
export function climbImg(id, cls = '') {
  const v = climbCardValue(id);
  const text = `${v > 0 ? '+' : ''}${v}`;
  return img(climbCardFace(id), { cls: `brumbyimg climbimg ${cls}`.trim(), alt: climbCardName(id), label: text, w: 480, h: 336, fallback: `<span class="asset-chip brumbyimg climbimg brumbychip brumbychip--${v > 0 ? 'good' : 'bad'} ${esc(cls)}" role="img" aria-label="${esc(climbCardName(id))}">${text}</span>` });
}

/** The face-down Climb card (landscape). */
export function climbBackImg(cls = '') {
  return img('climb-back', { cls: `brumbyimg climbimg ${cls}`.trim(), alt: '', label: 'Climb card', w: 480, h: 336, fallback: `<span class="asset-chip brumbyimg climbimg brumbychip ${esc(cls)}" role="img" aria-label="Climb card, face down"></span>` });
}

export function cardBackImg(cls = '') {
  return img('card-back', { cls: `cardimg ${cls}`.trim(), alt: '', label: 'Card back', w: 300, h: 429, fallback: `<span class="asset-chip cardimg cardchip cardchip--back ${esc(cls)}" role="img" aria-label="Card back"></span>` });
}

/** The suit badge (a coloured disc, the colour-blind cue). */
export function badgeImg(kind, cls = '') {
  return img(`badge-${kind}`, { cls: `badge-suit ${cls}`.trim(), alt: '', label: kind, w: 64, h: 64, fallback: `<span class="badge-suit badge-suit--${esc(kind)} ${esc(cls)}" aria-hidden="true">${suitGlyph(kind)}</span>` });
}

/** Seat avatar: seat k uses avatar-(k+1), wrapping after five. */
export function avatarId(seat) {
  return `avatar-${(seat % 5) + 1}`;
}

/**
 * Once per page: turns any <img data-asset> that fails to load into its text chip.
 * `error` does not bubble, so the listener is a capture listener on the document.
 */
export function installImageFallback(doc = document) {
  doc.addEventListener('error', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'IMG' || !el.dataset || !el.dataset.asset) return;
    const span = doc.createElement('span');
    span.className = `asset-chip ${el.className || ''}`.trim();
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', el.dataset.label || el.dataset.asset);
    span.textContent = el.dataset.label || el.dataset.asset;
    el.replaceWith(span);
  }, true);
}
