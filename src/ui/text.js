// text.js - the sentences the UI shows: trick log lines, turn prompts, hover hints, the summit stakes,
// tiebreak explanations. Pure functions of data (no DOM), so they run in Node tests.
//
// `names` is the per-seat label array from the controller ('You', 'Mia', 'Easy bot 2' ...).
// A seat called "You" gets second-person verbs ("You led", "your hand").

import { SUIT_NAMES, cardSuit, cardName, legalActionsFromView } from '../engine/index.js';

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

/** "Home was led". */
export function ledText(suit) {
  return `${suitName(suit)} was led`;
}

/** The phase banner: "THE CLIMB: highest wins" / "THE DESCENT: lowest wins" / "THE SUMMIT". */
export function phaseText(phase) {
  if (phase === 'climb') return 'The climb: highest wins';
  if (phase === 'descent') return 'The descent: lowest wins';
  if (phase === 'summit') return 'The summit: Chase or Watch';
  if (phase === 'over') return 'Game over';
  return '';
}

/**
 * One plain-English line for a finished trick, e.g.
 * "Mia led Home 7; Sam had no Home and threw Climb 4 (the mob breaks away); Ann followed with Home 2 and wins."
 * @param {{leader:number, ledSuit:string|null, phase:string, plays:{seat:number, card:string, offSuit:boolean}[]}} trick
 * @param {object} ev  the trick-won event
 */
export function trickSentence(trick, ev, names) {
  const led = trick.ledSuit;
  const climb = (trick.phase || ev.phase) === 'climb';
  const parts = trick.plays.map((p, i) => {
    const who = names[p.seat];
    const win = p.seat === ev.winner;
    let clause;
    if (i === 0) clause = `${who} led ${cardName(p.card)}`;
    else if (cardSuit(p.card) === led) clause = `${who} followed with ${cardName(p.card)}`;
    else clause = `${who} had no ${suitName(led)} and threw ${cardName(p.card)}${climb ? ' (the mob breaks away a step)' : ''}`;
    if (win) clause += ` and ${v(who, 'wins')}`;
    return clause;
  });
  return `${parts.join('; ')}.`;
}

/** The short banner under the trick: "Sam wins with Home 4 (lowest wins the descent)". */
export function winnerBanner(banner, names) {
  const who = names[banner.winner];
  const how = banner.phase === 'descent' ? 'lowest wins the descent' : 'highest wins the climb';
  return `${who} ${v(who, 'wins')} with ${cardName(banner.card)} (${how})`;
}

/** The banner split into its name and its rule: 'The climb' / 'highest wins'. */
export function phaseParts(phase) {
  const [name, rule] = phaseText(phase).split(': ');
  return { name: name || '', rule: rule || '' };
}

/** "Cards run 1 to 12 in each suit" (min and max from the engine's constants). */
export function rankRangeText(min, max) {
  return `Cards run ${min} to ${max} in each suit`;
}

/** Which end of the range is best in this phase: '12 is best' in the climb, '1 is best' in the descent. */
export function phaseBest(phase, min, max) {
  if (phase === 'climb') return `${max} is best`;
  if (phase === 'descent') return `${min} is best`;
  return '';
}

/**
 * The goal of the descent, in words, for the big line in the banner: who chased, what they must do, and what each
 * human at the table needs. Null outside the descent (and before the cards are turned). The personal lines are for
 * every human seat (the choices are public once turned), worded in the second person for a seat called You.
 */
export function descentGoal(board, names, humanSeats = []) {
  if (board.phase !== 'descent' || !board.revealed) return null;
  const chasers = board.choices.map((c, s) => (c === 'chase' ? s : -1)).filter((s) => s >= 0);
  if (!chasers.length) return null;
  const who = chasers.map((s) => names[s]);
  const main = `${chasers.length === 1 ? 'Chaser' : 'Chasers'} (${list(who)}): win the MOST descent tricks to reach the mob's heels and bring the mob home.`;
  const extra = 'A chaser who is not at the heels falls (-1). If a watcher is at the heels, the mob escapes.';
  const personal = humanSeats.filter((s) => board.choices[s]).map((s) => {
    const name = names[s];
    const chased = board.choices[s] === 'chase';
    let text;
    if (isYou(name)) text = chased ? 'You chased: you need the most descent tricks.' : 'You watched: block the chasers by winning descent tricks yourself.';
    else text = chased ? `${name} chased: needs the most descent tricks.` : `${name} watched: blocks the chasers by winning descent tricks.`;
    return { seat: s, choice: board.choices[s], text };
  });
  return { main, extra, personal, chasers };
}

/** R12.10: the stakes line for the viewer's summit decision. */
export function stakesText(view) {
  const n = view.stakes.climbTricks;
  const m = view.stakes.mob;
  return { chase: `Chase: risk your ${n} climb point${n === 1 ? '' : 's'} for the mob, worth ${m}; if you fall, ${view.stakes.fall}.`, watch: `Watch: bank ${n} point${n === 1 ? '' : 's'}.` };
}

const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * The one-line caption for a playback beat that is not a trick (board.banner): the reveal, the heels, the
 * mob home or escaping, the Brumby card. Everything comes from the event fields kept on the banner.
 */
export function bannerText(banner, names, board) {
  if (!banner) return '';
  const who = (s) => names[s];
  switch (banner.kind) {
    case 'summit': return 'The mob has reached the summit. Everyone chooses in secret: Chase or Watch.';
    case 'reveal': {
      const c = banner.chasers.map(who);
      const w = board.choices.map((x, s) => (x === 'watch' ? who(s) : null)).filter(Boolean);
      if (!c.length) return 'The cards are turned: everyone watches.';
      const parts = [`${list(c)} ${c.length === 1 ? v(c[0], 'chases', 'chase') : 'chase'}`];
      if (w.length) parts.push(`${list(w)} ${w.length === 1 ? v(w[0], 'watches', 'watch') : 'watch'}`);
      return `The cards are turned: ${parts.join('; ')}.`;
    }
    case 'nobody': return 'Nobody chases, so the hand ends here and the mob runs free.';
    case 'descent': return 'The descent: now the lowest card of the suit led wins.';
    case 'heels': {
      const s = who(banner.seat);
      return `${s} ${isYou(s) ? 'are' : 'is'} at the mob's heels with ${banner.tricks} descent trick${banner.tricks === 1 ? '' : 's'}${banner.tie ? ', winning the later trick of those tied' : ''}.`;
    }
    case 'home': {
      const s = who(banner.seat);
      return `${s} ${v(s, 'brings')} the mob home: ${banner.climbTricks} + ${banner.mob} = ${banner.score} points.`;
    }
    case 'escaped': {
      if (banner.reason === 'watcher-at-heels') return `${who(banner.heels)} watched from the top, so the mob escapes and every chaser falls.`;
      return 'The mob escapes.';
    }
    case 'brumby':
      if (banner.added) return `A Brumby card goes under the Colt: the mob will be worth ${banner.nextMob}.`;
      return `All ${banner.brumbies} Brumby cards are already under the Colt, so the mob stays at ${banner.nextMob}.`;
    default: return '';
  }
}

/** The callout beside the marker for one step of its climb (board.fx.marker). */
export function stepCallout(fx) {
  if (!fx) return null;
  if (fx.step === 1) return { text: '+1', off: false, title: 'The climb trick moves the mob one step' };
  return { text: '+1 off-suit', off: true, title: 'An off-suit card in the trick: the mob climbs another step' };
}

/** What the human should do now, as a sentence. `view` = the seat's view. */
export function turnPrompt(view) {
  if (view.phase === 'summit') {
    const st = stakesText(view);
    return `The mob is at the summit. Choose in secret: ${st.chase} ${st.watch}`;
  }
  const t = view.trick;
  const hand = view.hand;
  const acts = legalActionsFromView(view);
  const led = t ? t.ledSuit : null;
  const how = view.phase === 'descent' ? 'The lowest card of the suit led wins the descent.' : 'The highest card of the suit led wins the climb.';
  if (led === null) return `You lead. Play any card: everyone else must follow its suit if they can. ${how}`;
  const follow = hand.filter((c) => cardSuit(c) === led);
  if (follow.length) {
    if (acts.length === 1) return `${ledText(led)}. ${cardName(acts[0].card)} is the only card you can play.`;
    return `${ledText(led)}. You hold ${suitName(led)}, so you must follow suit. ${how}`;
  }
  if (acts.length === 1) return `${ledText(led)} and you have none. ${cardName(acts[0].card)} is your last card, so you play it.`;
  if (view.phase === 'climb') return `${ledText(led)} and you have no ${suitName(led)}. Play anything: it cannot win, and an off-suit card moves the mob one step further up the mountain.`;
  return `${ledText(led)} and you have no ${suitName(led)}. Play anything: a card of another suit cannot win this trick.`;
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
  const name = cardName(pv.card);
  if (pv.kind === 'lead') {
    return `${name}: you would lead ${suitName(cardSuit(pv.card))}. Everyone else must follow suit if they can.`;
  }
  const off = pv.offSuit ? ' It is off-suit, so it cannot win, and it moves the mob one step further.' : '';
  if (pv.wins) {
    if (pv.final) return `${name} wins the trick.`;
    return `${name} would win the trick as it stands; ${pv.remaining} still to play.`;
  }
  const w = names[pv.winnerSeat];
  if (pv.final) return `${name} loses: ${w} ${v(w, 'wins')} with ${cardName(pv.winnerCard)}.${off}`;
  return `${name} would not win as it stands (${w} ${isYou(w) ? 'are' : 'is'} ahead with ${cardName(pv.winnerCard)}; ${pv.remaining} still to play).${off}`;
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
 * The tiebreak explanation for the end screen (R11.6, R11.7, R11.10). It names only players who were
 * tied on the top total, or returns '' when nobody was tied at the top.
 */
export function tiebreakText(result, names) {
  const tied = result.tiedOnTotal;
  if (tied.length < 2) return '';
  const label = (s) => names[s];
  const join = (seats) => (seats.length === 1 ? label(seats[0]) : seats.length === 2 ? `${label(seats[0])} and ${label(seats[1])}` : `${seats.slice(0, -1).map(label).join(', ')} and ${label(seats[seats.length - 1])}`);
  const head = `${join(tied)} tied on ${result.winningScore}.`;
  const counts = `Mobs brought home: ${tied.map((s) => `${label(s)} ${result.mobsHome[s]}`).join(', ')}.`;
  if (result.shared && !result.tiebreakUsed) return `${head} ${counts} Still level, so the win is shared.`;
  if (result.tiebreakUsed) {
    const w = result.winners;
    return `${head} Tiebreak: who brought the mob home most often. ${counts} ${join(w)} ${w.length > 1 ? 'share the win' : (isYou(label(w[0])) ? 'win' : 'wins')}.`;
  }
  return head;
}

/** One-line summary of the hand for the log. */
export function handEndText(ev, names) {
  const scores = ev.scores.map((x, s) => `${names[s]} ${x}`).join(', ');
  return `Hand ${ev.handNo + 1} scores: ${scores}.`;
}

/** The outcome word for the reckoning. */
export function outcomeText(outcome) {
  return { watched: 'Watched: climb tricks banked', home: 'Brought the mob home', fell: 'Fell: -1, climb tricks lost' }[outcome] || '';
}
