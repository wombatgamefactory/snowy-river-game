// scoring.js - hand scores (R7) and the game result: totals, ranking, the last-hand tiebreak, shared
// wins (R9.4 to R9.8).
//
//   watcher   tricks (1 point each, climb and descent alike)                     R7.2
//   chaser    tricks + the values of the Brumby cards kept - the chase cost      R7.3
//             (3 at 2 players, 2 at 3-4; paid even with no tricks; scores may be negative, R7.4)
// Highest total wins; tied -> the tied player with the most points in the last hand; still tied -> a
// shared win (R9.5, R9.6).

import { brumbyValue } from './cards.js';

/**
 * The scoring of the hand that has just ended (R7).
 * @param {object} state  at the moment the hand ends (choices revealed, counts and kept piles final)
 * @returns {{ scores:number[], breakdown:object[] }}
 *   breakdown[s]: { seat, choice, climbTricks, descentTricks, tricks, trickPoints, kept, keptValue, cost, score }
 */
export function reckonHand(state) {
  const n = state.n;
  const P = state.params;
  const breakdown = [];
  for (let s = 0; s < n; s++) {
    const choice = state.choices[s];
    const climb = state.climbTricks[s];
    const descent = state.descentTricks[s];
    const tricks = climb + descent;
    const trickPoints = tricks * P.trickPoints;
    const kept = [...state.kept[s]];
    const keptValue = kept.reduce((a, id) => a + brumbyValue(id), 0);
    const cost = choice === 'chase' ? P.chaseCost : 0;
    breakdown.push({ seat: s, choice, climbTricks: climb, descentTricks: descent, tricks, trickPoints, kept, keptValue, cost, score: trickPoints + keptValue - cost });
  }
  return { scores: breakdown.map((b) => b.score), breakdown };
}

/**
 * The result of a finished game (also usable mid-game as a provisional standing).
 * @param {{ n:number, totals:number[], handLog:object[], measures:{tricks:number} }} state
 * @returns {{
 *   totals: number[], lastHandScores: number[], handScores: number[][],
 *   winners: number[], shared: boolean, tiebreakUsed: boolean, tiedOnTotal: number[],
 *   ranking: {seat:number, total:number, lastHandScore:number, rank:number}[],
 *   winningScore: number, margin: number, hands: number, tricks: number }}
 *   winners: seats that win (more than one = shared win, R9.5).
 *   tiedOnTotal: the seats on the top total (R9.6: the tiebreak applies among these only).
 *   tiebreakUsed: the last-hand score separated players tied on the top total (R9.7).
 *   margin: top total minus the next-best total (0 on a tie).
 *   ranking: by total, then last-hand score, most first; equal on both = equal rank (R9.7).
 */
export function gameResult(state) {
  const n = state.n;
  const totals = [...state.totals];
  const last = state.handLog.length ? [...state.handLog[state.handLog.length - 1].scores] : Array.from({ length: n }, () => 0);
  const top = Math.max(...totals);
  const tied = totals.map((t, s) => (t === top ? s : -1)).filter((s) => s >= 0);
  let winners = tied;
  if (tied.length > 1) {
    const most = Math.max(...tied.map((s) => last[s]));
    winners = tied.filter((s) => last[s] === most); // still tied -> shared
  }
  const better = (a, b) => totals[a] > totals[b] || (totals[a] === totals[b] && last[a] > last[b]);
  const seats = Array.from({ length: n }, (_, s) => s);
  const ranking = [...seats]
    .sort((a, b) => totals[b] - totals[a] || last[b] - last[a] || a - b)
    .map((s) => ({ seat: s, total: totals[s], lastHandScore: last[s], rank: 1 + seats.filter((o) => better(o, s)).length }));
  const sorted = [...totals].sort((a, b) => b - a);
  return {
    totals,
    lastHandScores: last,
    handScores: state.handLog.map((h) => [...h.scores]),
    winners,
    shared: winners.length > 1,
    tiebreakUsed: winners.length < tied.length,
    tiedOnTotal: tied,
    ranking,
    winningScore: top,
    margin: n > 1 ? sorted[0] - sorted[1] : 0,
    hands: state.handLog.length,
    tricks: state.measures.tricks,
  };
}
