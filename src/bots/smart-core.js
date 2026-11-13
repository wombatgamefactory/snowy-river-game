// smart-core.js - T3 PLACEHOLDER (v6 engine, 13/11/2026). Task T4 writes the line-by-line port of the v6
// Python simulator's card play here (sim/snowy-river-sim-v6.py: play_smart, play_naive, key, pw, worth_fn,
// unseen_max, legal, winner_of). Until then the names that importers ask for exist and throw "not ported",
// except cardIndex / cardId, which are real (fixture alphabet: suit id x 12 + n - 1, 60 cards).

import { fullDeck, SUITS } from '../engine/index.js';

export const PLACEHOLDER = true;
export const UP = 0; // the climb: highest wins, Escape trumps
export const DOWN = 1; // the descent: lowest wins, Home trumps
export const TRUMP_UP = 0; // Python ESCAPE
export const TRUMP_DOWN = 3; // Python HOME

const DECK = fullDeck(5); // all 60 cards, code order
const INDEX = new Map(DECK.map((c, i) => [c, i]));

/** 'escape-1' -> 0 ... 'home-12' -> 47, 'muster-12' -> 59. */
export function cardIndex(card) {
  const i = INDEX.get(card);
  if (i === undefined) throw new Error(`Not a card: ${JSON.stringify(card)}`);
  return i;
}
export const cardId = (ci) => DECK[ci];
export const cardSuitIndex = (ci) => SUITS.indexOf(DECK[ci].slice(0, DECK[ci].indexOf('-')));

const notPorted = (name) => () => { throw new Error(`smart-core.js ${name}: not ported to v6 yet (task T4)`); };

export const trickWinnerIndex = notPorted('trickWinnerIndex');
export const unseenFlags = notPorted('unseenFlags');
export const playSmart = notPorted('playSmart');
export const playNaive = notPorted('playNaive');
export const playFast = notPorted('playFast');
export const trickValue = notPorted('trickValue');
export const descentStakes = notPorted('descentStakes');
export const runDescentFast = notPorted('runDescentFast');
export const strongCount = notPorted('strongCount');
export const quick = notPorted('quick');
export const mcDiff = notPorted('mcDiff');
