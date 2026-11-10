// describe.js - plain-English text for actions and events (log lines, button labels).
//
// Pure: takes data, returns strings. `names` is an optional per-seat label array supplied by
// the UI (e.g. ['You', 'Mia', 'Easy bot 2']); without it seats are 'Seat 1', 'Seat 2', ...
// A seat called "You" gets second-person verbs. Every line must be safe to show to the whole
// table: 'summit-chosen' names the seat that locked in, never the side (R10.6).

import { cardName, brumbyName } from './cards.js';
import { SUIT_NAMES } from './rules.js';

export function seatName(seat, names) {
  return names && names[seat] ? names[seat] : `Seat ${seat + 1}`;
}

/** 'wins' -> 'win' when the subject is "You". */
function verb(subject, v) {
  if (!/^You\b/.test(subject)) return v;
  if (v === 'has') return 'have';
  if (v === 'is') return 'are';
  if (v === 'chases') return 'chase';
  if (v === 'watches') return 'watch';
  if (v === 'sends') return 'send';
  return v.replace(/s$/, ''); // every other verb used here takes a plain -s
}

function plural(k, one, many) {
  return `${k} ${k === 1 ? one : many}`;
}

function list(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const signed = (x) => `${x > 0 ? '+' : ''}${x}`;

export function describeAction(action, half = 'climb') {
  if (!action) return '';
  switch (action.type) {
    case 'play': return `Play ${cardName(action.card, half)}`;
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
      return `New game for ${ev.players} players: ${plural(ev.handsPerGame, 'hand', 'hands')}. Chase costs ${ev.chaseCost}.`;
    case 'hand-started': {
      const d = who(ev.dealer);
      const l = who(ev.leader);
      return `Hand ${ev.handNo + 1} of ${ev.handsPerGame}: ${d} ${verb(d, 'deals')} ${ev.handSize} cards each; ${l} ${verb(l, 'leads')} the climb. ${SUIT_NAMES[ev.trump]} is trumps.`;
    }
    case 'card-played': {
      const s = who(ev.seat);
      const c = cardName(ev.card, ev.half);
      if (ev.asLeader || ev.setsSuit) return `${s} ${verb(s, 'leads')} ${c}.`;
      if (ev.offSuit) return `${s} ${verb(s, 'has')} no ${SUIT_NAMES[ev.ledSuit]} and ${verb(s, 'plays')} ${c}${ev.trump ? ' (trumps)' : ''}.`;
      return `${s} ${verb(s, 'plays')} ${c}.`;
    }
    case 'trick-won': {
      const s = who(ev.winner);
      const how = ev.byTrump ? `${SUIT_NAMES[ev.trump]} trumps it` : `highest ${SUIT_NAMES[ev.ledSuit]}`;
      return `${s} ${verb(s, 'wins')} ${ev.half} trick ${ev.halfTrickNo} with ${cardName(ev.card, ev.half)} (${how}).`;
    }
    case 'marker-moved':
      if (ev.summit) return 'The mob reaches the summit.';
      return `The mob climbs to step ${ev.to} of ${ev.climbTricks}.`;
    case 'summit-opened': {
      const row = ev.row.map(brumbyName).join(', ');
      return `The summit. Everyone turns their hand round; ${SUIT_NAMES[ev.trump]} is trumps for the descent. The row: ${row} (worth ${signed(ev.rowValue)}). Everyone chooses in secret: Chase (${-ev.chaseCost}) or Watch.`;
    }
    case 'summit-chosen': {
      const s = who(ev.seat);
      return `${s} ${verb(s, 'has')} chosen (${ev.chosen} of ${ev.of}).`;
    }
    case 'summit-revealed': {
      const c = ev.chasers.map(who);
      const w = ev.watchers.map(who);
      if (!c.length) return 'Reveal: everyone watches. Every Brumby card will be sent off.';
      const parts = [`${list(c)} ${c.length === 1 ? verb(c[0], 'chases') : 'chase'}`];
      if (w.length) parts.push(`${list(w)} ${w.length === 1 ? verb(w[0], 'watches') : 'watch'}`);
      return `Reveal: ${parts.join('; ')}.`;
    }
    case 'descent-started': {
      const l = who(ev.leader);
      return `The descent: highest wins again, reading the turned numbers. ${l} ${verb(l, 'leads')}.`;
    }
    case 'brumby-kept': {
      const s = who(ev.winner);
      return `${s} ${verb(s, 'keeps')} ${brumbyName(ev.card)}.`;
    }
    case 'brumby-discarded': {
      const s = who(ev.winner);
      return `${s} watched, so ${brumbyName(ev.card)} is sent off.`;
    }
    case 'hand-ended': {
      const scores = ev.scores.map((x, s) => `${who(s)} ${signed(x)}`).join(', ');
      return `Hand ${ev.handNo + 1} is over. Scores: ${scores}.`;
    }
    case 'brumby-reshuffled':
      return 'Fewer than 6 Brumby cards are left: all 12 are shuffled together.';
    case 'game-over': {
      const names2 = ev.winners.map(who);
      if (ev.shared) return `Shared win: ${list(names2)} on ${ev.winningScore}${ev.tiedOnTotal.length > 1 ? `, level on the last hand too (${ev.lastHandScores[ev.winners[0]]} each)` : ''}.`;
      const w = names2[0];
      if (ev.tiebreakUsed) {
        const others = ev.tiedOnTotal.filter((s) => s !== ev.winners[0]).map((s) => ev.lastHandScores[s]);
        return `${w} ${verb(w, 'wins')} on ${ev.winningScore}, by the tiebreak: most points in the last hand (${ev.lastHandScores[ev.winners[0]]} against ${others.join(', ')}).`;
      }
      return `${w} ${verb(w, 'wins')} with ${plural(ev.winningScore, 'point', 'points')}, ${ev.margin} ahead.`;
    }
    default:
      return null;
  }
}
