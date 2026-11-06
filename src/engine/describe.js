// describe.js - plain-English text for actions and events (log lines, button labels).
//
// Pure: takes data, returns strings. `names` is an optional per-seat label array supplied by
// the UI (e.g. ['You', 'Mia', 'Easy bot 2']); without it seats are 'Seat 1', 'Seat 2', ...
// A seat called "You" gets second-person verbs. Every line must be safe to show to the whole
// table: 'summit-chosen' names the seat that locked in, never the side (R12.5).

import { cardName } from './cards.js';
import { SUIT_NAMES } from './rules.js';

export function seatName(seat, names) {
  return names && names[seat] ? names[seat] : `Seat ${seat + 1}`;
}

/** 'wins' -> 'win' when the subject is "You". */
function verb(subject, v) {
  if (!/^You\b/.test(subject)) return v;
  if (v === 'has') return 'have';
  if (v === 'is') return 'are';
  if (v === 'goes') return 'go';
  if (v === 'brings') return 'bring';
  if (v === 'falls') return 'fall';
  if (v === 'chases') return 'chase';
  if (v === 'watches') return 'watch';
  return v.replace(/s$/, ''); // every other verb used here takes a plain -s
}

function plural(k, one, many) {
  return `${k} ${k === 1 ? one : many}`;
}

function list(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function describeAction(action) {
  if (!action) return '';
  switch (action.type) {
    case 'play': return `Play ${cardName(action.card)}`;
    case 'summit': return action.choice === 'chase' ? 'Chase' : 'Watch';
    default: return JSON.stringify(action);
  }
}

/**
 * One log line per event, or null for events not worth a line.
 * @param {object} ev
 * @param {string[]} [names]
 */
export function describeEvent(ev, names) {
  const who = (s) => seatName(s, names);
  switch (ev.type) {
    case 'game-started':
      return `New game for ${ev.players} players: ${plural(ev.handsPerGame, 'hand', 'hands')}, the summit is step ${ev.summitStep}.`;
    case 'hand-started': {
      const d = who(ev.dealer);
      const l = who(ev.leader);
      return `Hand ${ev.handNo + 1} of ${ev.handsPerGame}: ${d} ${verb(d, 'deals')} ${ev.handSize} cards each; ${l} ${verb(l, 'leads')} the climb. The mob is worth ${ev.mob}.`;
    }
    case 'card-played': {
      const s = who(ev.seat);
      if (ev.asLeader || ev.setsSuit) return `${s} ${verb(s, 'leads')} ${cardName(ev.card)}.`;
      if (ev.offSuit) return `${s} ${verb(s, 'has')} no ${SUIT_NAMES[ev.ledSuit]} and ${verb(s, 'plays')} ${cardName(ev.card)}.`;
      return `${s} ${verb(s, 'plays')} ${cardName(ev.card)}.`;
    }
    case 'trick-won': {
      const s = who(ev.winner);
      const how = ev.phase === 'descent' ? 'lowest' : 'highest';
      return `${s} ${verb(s, 'wins')} trick ${ev.trickNo} with ${cardName(ev.card)}: ${how} ${SUIT_NAMES[ev.ledSuit]} wins the ${ev.phase}.`;
    }
    case 'marker-moved': {
      const extra = ev.offSuit ? ` (1 + ${ev.offSuit} off-suit)` : '';
      if (ev.summit) {
        if (ev.forced) return `The cards are nearly gone: the mob is driven to the summit (step ${ev.to}).`;
        return `The mob climbs ${plural(ev.steps, 'step', 'steps')}${extra} and reaches the summit${ev.overshoot ? ', with steps to spare' : ''}.`;
      }
      return `The mob climbs ${plural(ev.steps, 'step', 'steps')}${extra} to step ${ev.to} of ${ev.summitStep}.`;
    }
    case 'summit-reached':
      return `The summit, after ${plural(ev.summitTrick, 'climb trick', 'climb tricks')}. Everyone chooses in secret: Chase or Watch. The mob is worth ${ev.mob}.`;
    case 'summit-chosen': {
      const s = who(ev.seat);
      return `${s} ${verb(s, 'has')} chosen (${ev.chosen} of ${ev.of}).`;
    }
    case 'summit-revealed': {
      const c = ev.chasers.map(who);
      const w = ev.watchers.map(who);
      if (!c.length) return `Reveal: everyone watches.`;
      const parts = [`${list(c)} ${c.length === 1 ? verb(c[0], 'chases') : 'chase'}`];
      if (w.length) parts.push(`${list(w)} ${w.length === 1 ? verb(w[0], 'watches') : 'watch'}`);
      return `Reveal: ${parts.join('; ')}.`;
    }
    case 'nobody-chased':
      return 'Nobody chases. "We may bid the mob good day." The hand ends at once and the mob escapes.';
    case 'descent-started': {
      const l = who(ev.leader);
      return `The descent: the lowest card of the suit led wins. ${l} ${verb(l, 'leads')}.`;
    }
    case 'at-the-heels': {
      const s = who(ev.seat);
      const k = ev.descentTricks[ev.seat];
      const tie = ev.tie ? ', and won the later descent trick of those tied' : '';
      return `${s} ${verb(s, 'is')} at the mob's heels with ${plural(k, 'descent trick', 'descent tricks')}${tie}.`;
    }
    case 'mob-home': {
      const s = who(ev.seat);
      return `${s} ${verb(s, 'brings')} the mob home: ${ev.climbTricks} + ${ev.mob} = ${ev.score} points.`;
    }
    case 'mob-escaped': {
      if (ev.reason === 'watcher-at-heels') {
        const s = who(ev.heels);
        return `${s} watched, so the mob escapes${ev.fallen.length ? `; ${list(ev.fallen.map(who))} ${ev.fallen.length === 1 ? verb(who(ev.fallen[0]), 'falls') : 'fall'} (-1)` : ''}.`;
      }
      return 'The mob escapes.';
    }
    case 'brumby-added':
      if (ev.added) return `A Brumby card goes under the Colt: the mob is worth ${ev.nextMob}${ev.lastHand ? ' (the game is over)' : ' next hand'}.`;
      return `All ${ev.brumbies} Brumby cards are already under the Colt: the mob stays at ${ev.nextMob}.`;
    case 'hand-ended': {
      const scores = ev.scores.map((x, s) => `${who(s)} ${x > 0 ? '+' : ''}${x}`).join(', ');
      return `Hand ${ev.handNo + 1} is over. Scores: ${scores}.`;
    }
    case 'game-over': {
      const names2 = ev.winners.map(who);
      if (ev.shared) return `Shared win: ${list(names2)} on ${ev.winningScore}${ev.tiedOnTotal.length > 1 ? `, level on mobs brought home too (${ev.mobsHome[ev.winners[0]]} each)` : ''}.`;
      const w = names2[0];
      if (ev.tiebreakUsed) {
        const others = ev.tiedOnTotal.filter((s) => s !== ev.winners[0]).map((s) => ev.mobsHome[s]);
        return `${w} ${verb(w, 'wins')} on ${ev.winningScore}, by the tiebreak: mobs brought home (${ev.mobsHome[ev.winners[0]]} against ${others.join(', ')}).`;
      }
      return `${w} ${verb(w, 'wins')} with ${plural(ev.winningScore, 'point', 'points')}, ${ev.margin} ahead.`;
    }
    default:
      return null;
  }
}
