// text.js - the sentences the UI shows: trick log lines, turn prompts, hover hints, the banner text,
// tiebreak explanations. Pure functions of data (no DOM), so they run in Node tests.
//
// `names` is the per-seat label array from the controller ('You', 'Mia', 'Easy bot 2' ...).
// A seat called "You" gets second-person verbs ("You led", "your hand").
// v6 rules: highest wins on the climb (Escape is trumps), lowest wins on the descent (Home is trumps);
// every trick takes the next card of the Climb row, then of the Brumby row.

import { SUIT_NAMES, cardSuit, cardName, rowCardName, rowCardValue, legalActionsFromView } from '../engine/index.js';

const isYou = (name) => name === 'You';

/** 'Sam' -> "Sam's", 'You' -> 'your'. */
export function poss(name) {
  return isYou(name) ? 'your' : `${name}'s`;
}

/** Third-person verb to the form that agrees with the name ('wins' -> 'win' for You). */
function v(name, third, second) {
  return isYou(name) ? (second || third.replace(/s$/, '')) : third;
}

const suitName = (s) => SUIT_NAMES[s];
const signed = (x) => (x > 0 ? `+${x}` : `${x}`);
const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** "Home was led". */
export function ledText(suit) {
  return `${suitName(suit)} was led`;
}

/** The half's banner: "The climb: highest wins" / "The descent: lowest wins". */
export function phaseText(phase) {
  if (phase === 'climb') return 'The climb: highest wins';
  if (phase === 'descent') return 'The descent: lowest wins';
  if (phase === 'over') return 'Game over';
  return '';
}

/** The banner split into its name and its rule: 'The climb' / 'highest wins'. */
export function phaseParts(phase) {
  const [name, rule] = phaseText(phase).split(': ');
  return { name: name || '', rule: rule || '' };
}

/** The line under the banner: what is trumps, and how the trick is decided. */
export function phaseNote(phase, trump) {
  const t = trump ? suitName(trump) : '';
  if (phase === 'climb') return `${t} is trumps: any ${t} card played beats every other suit. Otherwise the highest card of the suit led wins.`;
  if (phase === 'descent') return `${t} is trumps: any ${t} card played beats every other suit (the lowest ${t} wins). Otherwise the lowest card of the suit led wins.`;
  return '';
}

/** The short direction word of a half for labels: 'Highest wins' / 'Lowest wins'. */
export const directionText = (half) => (half === 'descent' ? 'Lowest wins' : 'Highest wins');

/**
 * One plain-English line for a finished trick, e.g.
 * "Mia led Home 7; Sam had no Home and trumped with Escape 3; Ann followed with Home 2 and wins."
 * @param {{leader:number, ledSuit:string|null, phase:string, half?:string, plays:{seat:number, card:string, offSuit:boolean, trump?:boolean}[]}} trick
 * @param {object} ev  the trick-won event
 */
export function trickSentence(trick, ev, names) {
  const led = trick.ledSuit;
  const parts = trick.plays.map((p, i) => {
    const who = names[p.seat];
    const win = p.seat === ev.winner;
    const c = cardName(p.card);
    let clause;
    if (i === 0) clause = `${who} led ${c}`;
    else if (cardSuit(p.card) === led) clause = `${who} followed with ${c}`;
    else if (p.trump) clause = `${who} had no ${suitName(led)} and trumped with ${c}`;
    else clause = `${who} had no ${suitName(led)} and threw ${c}`;
    if (win) clause += ` and ${v(who, 'wins')}`;
    return clause;
  });
  return `${parts.join('; ')}.`;
}

/** The short banner under the trick: "Sam wins with Home 4 (trumps)". */
export function winnerBanner(banner, names) {
  const who = names[banner.winner];
  const how = banner.byTrump ? ' (trumps)' : '';
  return `${who} ${v(who, 'wins')} with ${cardName(banner.card)}${how}`;
}

/** "+2" / "-1" for a Brumby or Climb card id. */
export const rowValueText = (id) => signed(rowCardValue(id));

/** One sentence naming what the Brumby row holds, for the summit. */
export function rowSentence(row, valueOf = rowCardValue) {
  const ids = row.filter(Boolean);
  const total = ids.reduce((a, id) => a + valueOf(id), 0);
  const colt = row.indexOf('colt');
  const where = colt >= 0 ? ` The Colt (+4) is number ${colt + 1}.` : '';
  return `The row is worth ${signed(total)} in all.${where}`;
}

/** What this trick is worth, from view.price: "Climb card -1 (-1 point)". */
export function priceText(price) {
  if (!price) return '';
  const val = price.value;
  return `${rowCardName(price.card)} (${signed(val)} ${val === 1 || val === -1 ? 'point' : 'points'})`;
}

/**
 * The one-line caption for a playback beat that is not a trick (board.banner): the deal, the summit, the card
 * just taken, the reshuffle. Everything comes from the event fields kept on the banner.
 */
export function bannerText(banner, names) {
  if (!banner) return '';
  const who = (s) => names[s];
  switch (banner.kind) {
    case 'deal': return `A new hand. The Climb row is laid out face up: five +1 cards and one -1 card, which is on climb trick ${banner.minusPosition}. Highest wins and Escape is trumps.`;
    case 'summit': return `Over the top! The Climb row is empty. Now the lowest card wins and Home is trumps. The Brumby row is dealt: ${signed(banner.rowValue)} in all.${banner.colt ? ' The Colt is in it.' : ''} ${who(banner.leader)} ${v(who(banner.leader), 'leads')} the descent.`;
    case 'prize': {
      const s = who(banner.seat);
      return `${s} ${v(s, 'takes')} ${rowCardName(banner.card)} (${signed(banner.value)}).`;
    }
    case 'reshuffle': return 'Fewer than 6 Brumby cards are left: all 12 are shuffled together.';
    default: return '';
  }
}

/** What the human should do now, as a sentence. `view` = the seat's view. */
export function turnPrompt(view) {
  const t = view.trick;
  const hand = view.hand;
  const acts = legalActionsFromView(view);
  const led = t ? t.ledSuit : null;
  const trump = suitName(view.trump);
  const how = view.half === 'descent'
    ? `Any ${trump} played beats every other suit (the lowest ${trump} wins); otherwise the lowest card of the suit led wins.`
    : `Any ${trump} played beats every other suit (the highest ${trump} wins); otherwise the highest card of the suit led wins.`;
  const prize = view.price ? ` This trick takes ${priceText(view.price)}.` : '';
  if (led === null) return `You lead. Play any card: everyone else must follow its suit if they can. ${how}${prize}`;
  const follow = hand.filter((c) => cardSuit(c) === led);
  if (follow.length) {
    if (acts.length === 1) return `${ledText(led)}. ${cardName(acts[0].card)} is the only card you can play.${prize}`;
    return `${ledText(led)}. You hold ${suitName(led)}, so you must follow suit. ${how}${prize}`;
  }
  if (acts.length === 1) return `${ledText(led)} and you have none. ${cardName(acts[0].card)} is your last card, so you play it.${prize}`;
  return `${ledText(led)} and you have no ${suitName(led)}. Play anything: ${trump} would trump it; any other suit cannot win.${prize}`;
}

/** The sentence for the status line when a bot or another human is to act. */
export function waitingText(board, names, seatTypes) {
  if (board.phase === 'over') return 'Game over.';
  if (board.toAct === null) return '';
  const who = names[board.toAct];
  const bot = seatTypes && seatTypes[board.toAct] !== 'human';
  return `${who} ${isYou(who) ? 'are' : 'is'} ${bot ? 'thinking' : 'to play'}.`;
}

/** "1 point" / "3 points". */
export const points = (k) => `${k} point${k === 1 ? '' : 's'}`;

/** Hover / tap hint for a card the human may play, from previewCard(). */
export function previewText(pv, names) {
  if (!pv) return '';
  const name = cardName(pv.card);
  const trumpNote = pv.trumps ? ' It is a trump, so it beats every other suit.' : '';
  const prize = pv.prize ? ` The winner takes ${rowCardName(pv.prize)} (${signed(rowCardValue(pv.prize))}).` : '';
  const lowest = pv.half === 'descent';
  if (pv.kind === 'lead') {
    return `${name}: you would lead ${suitName(cardSuit(pv.card))}. Everyone else must follow suit if they can.${pv.isTrumpSuit ? ' It is a trump suit.' : ''}${prize}`;
  }
  if (pv.wins) {
    if (pv.final) return `${name} wins the trick.${trumpNote}${prize}`;
    return `${name} would win the trick as it stands (${lowest ? 'lowest' : 'highest'} so far); ${pv.remaining} still to play.${trumpNote}${prize}`;
  }
  const w = names[pv.winnerSeat];
  if (pv.final) return `${name} loses: ${w} ${v(w, 'wins')} with ${cardName(pv.winnerCard)}.${prize}`;
  return `${name} would not win as it stands (${w} ${isYou(w) ? 'are' : 'is'} ahead with ${cardName(pv.winnerCard)}; ${pv.remaining} still to play).${prize}`;
}

/** Players who share a total, grouped: [[seat, seat], ...] only groups of two or more. */
export function tiedGroups(result) {
  const byTotal = new Map();
  for (const r of result.ranking) {
    if (!byTotal.has(r.total)) byTotal.set(r.total, []);
    byTotal.get(r.total).push(r.seat);
  }
  return [...byTotal.values()].filter((g) => g.length > 1);
}

/**
 * The tiebreak explanation for the end screen. It names only players who were tied on the top total, or
 * returns '' when nobody was tied at the top. The tiebreak is the most points in the last hand.
 */
export function tiebreakText(result, names) {
  const tied = result.tiedOnTotal;
  if (tied.length < 2) return '';
  const label = (s) => names[s];
  const join = (seats) => list(seats.map(label));
  const head = `${join(tied)} tied on ${result.winningScore}.`;
  const last = `Points in the last hand: ${tied.map((s) => `${label(s)} ${result.lastHandScores[s]}`).join(', ')}.`;
  if (result.shared && !result.tiebreakUsed) return `${head} Tiebreak: the most points in the last hand. ${last} Still level, so the win is shared.`;
  if (result.tiebreakUsed) {
    const w = result.winners;
    return `${head} Tiebreak: the most points in the last hand. ${last} ${join(w)} ${w.length > 1 ? 'share the win' : (isYou(label(w[0])) ? 'win' : 'wins')}.`;
  }
  return head;
}

/** One-line summary of the hand for the log. */
export function handEndText(ev, names) {
  const scores = ev.scores.map((x, s) => `${names[s]} ${x}`).join(', ');
  return `Hand ${ev.handNo + 1} scores: ${scores}.`;
}
