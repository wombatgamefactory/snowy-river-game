// text.js - the sentences the UI shows: trick log lines, turn prompts, hover hints, the summit stakes,
// tiebreak explanations. Pure functions of data (no DOM), so they run in Node tests.
//
// `names` is the per-seat label array from the controller ('You', 'Mia', 'Easy bot 2' ...).
// A seat called "You" gets second-person verbs ("You led", "your hand").

import { SUIT_NAMES, cardSuit, cardName, brumbyName, brumbyValue, legalActionsFromView } from '../engine/index.js';

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

/** The phase banner: "The climb: highest wins" / "The summit: Chase or Watch" / "The descent: highest wins". */
export function phaseText(phase) {
  if (phase === 'climb') return 'The climb: highest wins';
  if (phase === 'descent') return 'The descent: highest wins';
  if (phase === 'summit') return 'The summit: Chase or Watch';
  if (phase === 'over') return 'Game over';
  return '';
}

/** The banner split into its name and its rule: 'The climb' / 'highest wins'. */
export function phaseParts(phase) {
  const [name, rule] = phaseText(phase).split(': ');
  return { name: name || '', rule: rule || '' };
}

/** The line under the banner: which number to read, and what is trumps. */
export function phaseNote(phase, trump) {
  const t = trump ? `${suitName(trump)} is trumps.` : '';
  if (phase === 'climb') return `Read the big number at the top of each card. ${t}`.trim();
  if (phase === 'summit') return `Hands turned: the numbers that were at the bottom now count. ${t}`.trim();
  if (phase === 'descent') return `Your hand is turned round: read the number now at the top. ${t}`.trim();
  return '';
}

/**
 * One plain-English line for a finished trick, e.g.
 * "Mia led Home 7; Sam had no Home and trumped with Escape 3; Ann followed with Home 2 and wins."
 * @param {{leader:number, ledSuit:string|null, phase:string, half?:string, plays:{seat:number, card:string, offSuit:boolean, trump?:boolean}[]}} trick
 * @param {object} ev  the trick-won event
 */
export function trickSentence(trick, ev, names) {
  const led = trick.ledSuit;
  const half = trick.half || trick.phase || ev.half;
  const parts = trick.plays.map((p, i) => {
    const who = names[p.seat];
    const win = p.seat === ev.winner;
    const c = cardName(p.card, half);
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
  return `${who} ${v(who, 'wins')} with ${cardName(banner.card, banner.phase)}${how}`;
}

/** "+2" / "-1" for a Brumby id. */
export const brumbyValueText = (id) => signed(brumbyValue(id));

/**
 * The goal of the descent, in words, for the block under the banner: who chased, what a chaser keeps, and what each
 * human at the table is doing. Null outside the descent (and before the cards are turned). The personal lines are for
 * every human seat (the choices are public once turned), worded in the second person for a seat called You.
 */
export function descentGoal(board, names, humanSeats = []) {
  if (board.phase !== 'descent' || !board.revealed) return null;
  const chasers = board.choices.map((c, s) => (c === 'chase' ? s : -1)).filter((s) => s >= 0);
  const cost = board.chaseCost;
  const main = chasers.length
    ? `${chasers.length === 1 ? 'Chaser' : 'Chasers'} (${list(chasers.map((s) => names[s]))}): win a trick to keep its Brumby card.`
    : 'Nobody chased: every Brumby card will be sent off.';
  const extra = `Every trick is 1 point. Chasing costs ${cost}; a watcher who wins a trick sends its Brumby card off.`;
  const personal = humanSeats.filter((s) => board.choices[s]).map((s) => {
    const name = names[s];
    const chased = board.choices[s] === 'chase';
    let text;
    if (isYou(name)) text = chased ? `You chased: you paid ${cost}, and keep the Brumby card of every trick you win.` : 'You watched: every trick you win is a point, and its Brumby card is sent off.';
    else text = chased ? `${name} chased: paid ${cost}, keeps the Brumby card of every trick won.` : `${name} watched: every trick is a point, and the Brumby cards won are sent off.`;
    return { seat: s, choice: board.choices[s], text };
  });
  return { main, extra, personal, chasers };
}

/** The stakes lines for the viewer's summit decision (from view.stakes). */
export function stakesText(view) {
  const st = view.stakes;
  const sign = st.rowValue >= 0 ? '+' : '';
  return {
    chase: `Chase: pay ${st.chaseCost}. Keep the Brumby card of every descent trick you win. The row is worth ${sign}${st.rowValue} in all.`,
    watch: 'Watch: pay nothing. Every trick is still 1 point, but the Brumby cards you win are sent off.',
  };
}

/** One sentence naming what the row holds, for the summit. */
export function rowSentence(row) {
  const ids = row.filter(Boolean);
  const total = ids.reduce((a, id) => a + brumbyValue(id), 0);
  const colt = ids.indexOf('colt');
  const where = colt >= 0 ? ` The Colt (+4) is number ${row.indexOf('colt') + 1}.` : '';
  return `The row is worth ${signed(total)} in all.${where}`;
}

/**
 * The one-line caption for a playback beat that is not a trick (board.banner): the turn at the summit, the
 * reveal, the descent, the Brumby card won. Everything comes from the event fields kept on the banner.
 */
export function bannerText(banner, names, board) {
  if (!banner) return '';
  const who = (s) => names[s];
  switch (banner.kind) {
    case 'turn': return `The summit! Everyone turns their hand round: the numbers that were at the bottom now count, and Home is trumps. The row is turned up: ${signed(banner.rowValue)} in all.`;
    case 'reveal': {
      const c = banner.chasers.map(who);
      const w = banner.watchers.map(who);
      if (!c.length) return 'The cards are turned: everyone watches, so every Brumby card will be sent off.';
      const parts = [`${list(c)} ${c.length === 1 ? v(c[0], 'chases', 'chase') : 'chase'}`];
      if (w.length) parts.push(`${list(w)} ${w.length === 1 ? v(w[0], 'watches', 'watch') : 'watch'}`);
      return `The cards are turned: ${parts.join('; ')}.`;
    }
    case 'descent': return `The descent: ${who(banner.leader)} ${v(who(banner.leader), 'leads')} (the last to win a climb trick). Home is trumps.`;
    case 'prize': {
      const s = who(banner.seat);
      const name = brumbyName(banner.card);
      return banner.to === 'kept' ? `${s} ${v(s, 'keeps')} ${name}.` : `${s} watched, so ${name} is sent off.`;
    }
    case 'reshuffle': return 'Fewer than 6 Brumby cards are left: all 12 are shuffled together.';
    default: return '';
  }
}

/** The callout beside the marker for the step just taken (board.fx.marker). */
export function stepCallout(fx) {
  if (!fx) return null;
  if (fx.summit) return { text: 'The summit!', title: 'The sixth climb trick: the mob is at the top' };
  return { text: `Step ${fx.to}`, title: 'Each climb trick moves the mob up one step' };
}

/** What the human should do now, as a sentence. `view` = the seat's view. */
export function turnPrompt(view) {
  if (view.phase === 'summit') {
    return `The mob is laid out. Choose in secret: Chase (pay ${view.chaseCost}, keep the Brumby cards you win) or Watch.`;
  }
  const t = view.trick;
  const hand = view.hand;
  const acts = legalActionsFromView(view);
  const led = t ? t.ledSuit : null;
  const trump = suitName(view.trump);
  const how = `Any ${trump} played beats every other suit; otherwise the highest of the suit led wins.`;
  const prize = view.phase === 'descent' && view.rowNext !== null && view.row[view.rowNext]
    ? ` The winner takes the next Brumby card, ${brumbyName(view.row[view.rowNext])} (kept by a chaser, sent off by a watcher).` : '';
  if (led === null) return `You lead. Play any card: everyone else must follow its suit if they can. ${how}${prize}`;
  const half = view.half;
  const follow = hand.filter((c) => cardSuit(c) === led);
  if (follow.length) {
    if (acts.length === 1) return `${ledText(led)}. ${cardName(acts[0].card, half)} is the only card you can play.${prize}`;
    return `${ledText(led)}. You hold ${suitName(led)}, so you must follow suit. ${how}${prize}`;
  }
  if (acts.length === 1) return `${ledText(led)} and you have none. ${cardName(acts[0].card, half)} is your last card, so you play it.${prize}`;
  return `${ledText(led)} and you have no ${suitName(led)}. Play anything: ${trump} would trump it; any other suit cannot win.${prize}`;
}

/** The sentence for the status line when a bot or another human is to act. */
export function waitingText(board, names, seatTypes) {
  if (board.phase === 'over') return 'Game over.';
  if (board.toAct === null) return '';
  const who = names[board.toAct];
  const bot = seatTypes && seatTypes[board.toAct] !== 'human';
  if (board.phase === 'summit') return `${who} ${isYou(who) ? 'are' : 'is'} choosing Chase or Watch in secret.`;
  return `${who} ${isYou(who) ? 'are' : 'is'} ${bot ? 'thinking' : 'to play'}.`;
}

/** "1 point" / "3 points". */
export const points = (k) => `${k} point${k === 1 ? '' : 's'}`;

/** Hover / tap hint for a card the human may play, from previewCard(). */
export function previewText(pv, names) {
  if (!pv) return '';
  const half = pv.half || 'climb';
  const name = cardName(pv.card, half);
  const trumpNote = pv.trumps ? ' It is a trump, so it beats every other suit.' : '';
  let prize = '';
  if (pv.prizeId) {
    const b = brumbyName(pv.prizeId);
    prize = pv.chase ? ` The winner of this trick takes ${b}; you chased, so you keep it if you win.` : ` The winner takes ${b}; you watched, so you would send it off.`;
  }
  if (pv.kind === 'lead') {
    return `${name}: you would lead ${suitName(cardSuit(pv.card))}. Everyone else must follow suit if they can.${pv.isTrumpSuit ? ' It is a trump suit.' : ''}${prize}`;
  }
  if (pv.wins) {
    if (pv.final) return `${name} wins the trick.${trumpNote}${prize}`;
    return `${name} would win the trick as it stands; ${pv.remaining} still to play.${trumpNote}${prize}`;
  }
  const w = names[pv.winnerSeat];
  if (pv.final) return `${name} loses: ${w} ${v(w, 'wins')} with ${cardName(pv.winnerCard, half)}.`;
  return `${name} would not win as it stands (${w} ${isYou(w) ? 'are' : 'is'} ahead with ${cardName(pv.winnerCard, half)}; ${pv.remaining} still to play).${prize}`;
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
