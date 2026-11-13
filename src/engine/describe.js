// describe.js - plain-English text for actions and events (log lines, button labels).
//
// Pure: takes data, returns strings. `names` is an optional per-seat label array supplied by
// the UI (e.g. ['You', 'Mia', 'Easy bot 2']); without it seats are 'Seat 1', 'Seat 2', ...
// A seat called "You" gets second-person verbs. Every line is safe to show to the whole table
// (v6 has no hidden choice; nothing here names a card in a hand or out of play).

import { cardName, brumbyName, climbCardName } from './cards.js';
import { SUIT_NAMES } from './rules.js';

export function seatName(seat, names) {
  return names && names[seat] ? names[seat] : `Seat ${seat + 1}`;
}

/** 'wins' -> 'win' when the subject is "You". */
function verb(subject, v) {
  if (!/^You\b/.test(subject)) return v;
  if (v === 'has') return 'have';
  if (v === 'is') return 'are';
  if (v === 'takes') return 'take';
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

export function describeAction(action) {
  if (!action) return '';
  switch (action.type) {
    case 'play': return `Play ${cardName(action.card)}`;
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
      return `New game for ${ev.players} players: ${plural(ev.handsPerGame, 'hand', 'hands')}.`;
    case 'hand-started': {
      const d = who(ev.dealer);
      const l = who(ev.leader);
      const minus = ev.minusPosition ? ` The -1 Climb card is on climb trick ${ev.minusPosition}.` : '';
      return `Hand ${ev.handNo + 1} of ${ev.handsPerGame}: ${d} ${verb(d, 'deals')} ${ev.handSize} cards each; ${l} ${verb(l, 'leads')} the climb. Highest wins; ${SUIT_NAMES[ev.trump]} is trumps.${minus}`;
    }
    case 'card-played': {
      const s = who(ev.seat);
      const c = cardName(ev.card);
      if (ev.asLeader || ev.setsSuit) return `${s} ${verb(s, 'leads')} ${c}.`;
      if (ev.offSuit) return `${s} ${verb(s, 'has')} no ${SUIT_NAMES[ev.ledSuit]} and ${verb(s, 'plays')} ${c}${ev.trump ? ' (trumps)' : ''}.`;
      return `${s} ${verb(s, 'plays')} ${c}.`;
    }
    case 'trick-won': {
      const s = who(ev.winner);
      const how = ev.byTrump ? `${SUIT_NAMES[ev.trump]} trumps it` : `${ev.direction === 'lowest' ? 'lowest' : 'highest'} ${SUIT_NAMES[ev.ledSuit]}`;
      return `${s} ${verb(s, 'wins')} ${ev.half} trick ${ev.halfTrickNo} with ${cardName(ev.card)} (${how}).`;
    }
    case 'climb-card-taken': {
      const s = who(ev.winner);
      return `${s} ${verb(s, 'takes')} ${climbCardName(ev.card)}.`;
    }
    case 'summit-opened': {
      const row = ev.row.map(brumbyName).join(', ');
      const l = who(ev.leader);
      return `The summit. Now lowest wins and ${SUIT_NAMES[ev.trump]} is trumps. The Brumby row: ${row} (worth ${signed(ev.rowValue)}). ${l} ${verb(l, 'leads')} the descent.`;
    }
    case 'brumby-taken': {
      const s = who(ev.winner);
      return `${s} ${verb(s, 'takes')} ${brumbyName(ev.card)}.`;
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
