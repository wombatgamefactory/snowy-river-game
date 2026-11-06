// scoring.js - the player at the mob's heels, hand scores, and the game result: totals, ranking,
// tiebreak (mobs brought home), shared wins.
//
// R9 (every case):
//   watcher                           +1 per climb trick, whatever happens (R9.1)
//   chaser who brings the mob home    climb tricks + the mob, mob = 3 + 2 x Brumby cards (R9.2)
//   chaser who does not (falls)       -1, and the climb tricks score nothing (R9.3)
//   descent tricks                    nothing on their own (R7.7, R9.4)
// R11.5-R11.7: highest total wins; tied -> the tied player who brought the mob home most often;
// still tied -> a shared win.

/**
 * R8.1 / R8.2 / R14.4: the seat at the mob's heels after a descent: the most descent tricks, a tie
 * going to the tied player whose own last descent-trick win is the latest.
 * @param {number[]} descentTricks  by seat
 * @param {number[]} lastDescentWin by seat: index of the latest descent trick won, -1 if none
 * @returns {{ seat:number, tied:number[], tie:boolean }}  tied = every seat on the top count
 */
export function heelsOf(descentTricks, lastDescentWin) {
  const top = Math.max(...descentTricks);
  const tied = descentTricks.map((d, s) => (d === top ? s : -1)).filter((s) => s >= 0);
  let seat = tied[0];
  for (const s of tied) if (lastDescentWin[s] > lastDescentWin[seat]) seat = s;
  return { seat, tied, tie: tied.length > 1 };
}

/**
 * The reckoning of a hand that has just ended (R9).
 * @param {object} state     at the moment the hand ends (choices revealed, counts final)
 * @param {number|null} home the chaser who brought the mob home, or null (nobody chased / watcher at heels)
 * @returns {{ scores:number[], outcomes:string[], breakdown:object[] }}
 *   outcomes[s]: 'watched' | 'home' | 'fell'
 *   breakdown[s]: { seat, choice, climbTricks, descentTricks, climbPoints, mobPoints, fallPoints, score, outcome }
 */
export function reckonHand(state, home) {
  const n = state.n;
  const P = state.params;
  const breakdown = [];
  for (let s = 0; s < n; s++) {
    const choice = state.choices[s];
    const climb = state.climbTricks[s];
    let climbPoints = 0; let mobPoints = 0; let fallPoints = 0; let outcome;
    if (choice === 'chase' && s === home) { // R9.2
      outcome = 'home';
      climbPoints = climb * P.climbTrickValue;
      mobPoints = state.mob;
    } else if (choice === 'chase') { // R9.3: even with no climb tricks at all
      outcome = 'fell';
      fallPoints = P.fallScore;
    } else { // R9.1
      outcome = 'watched';
      climbPoints = climb * P.climbTrickValue;
    }
    breakdown.push({ seat: s, choice, climbTricks: climb, descentTricks: state.descentTricks[s], climbPoints, mobPoints, fallPoints, score: climbPoints + mobPoints + fallPoints, outcome });
  }
  return { scores: breakdown.map((b) => b.score), outcomes: breakdown.map((b) => b.outcome), breakdown };
}

/**
 * The result of a finished game (also usable mid-game as a provisional standing).
 * @param {{ n:number, totals:number[], mobsHome:number[], handLog:object[], measures:{tricks:number} }} state
 * @returns {{
 *   totals: number[], mobsHome: number[], handScores: number[][],
 *   winners: number[], shared: boolean, tiebreakUsed: boolean, tiedOnTotal: number[],
 *   ranking: {seat:number, total:number, mobsHome:number, rank:number}[],
 *   winningScore: number, margin: number, hands: number, tricks: number }}
 *   winners: seats that win (more than one = shared win, R11.7).
 *   tiedOnTotal: the seats on the top total (R11.8: the tiebreak applies among these only).
 *   tiebreakUsed: mobs brought home separated players tied on the top total (R11.6, R11.9).
 *   margin: top total minus the next-best total (0 on a tie).
 *   ranking: by total, then mobs brought home, most first; equal on both = equal rank (R11.9).
 */
export function gameResult(state) {
  const n = state.n;
  const totals = [...state.totals];
  const mobsHome = [...state.mobsHome];
  const top = Math.max(...totals);
  const tied = totals.map((t, s) => (t === top ? s : -1)).filter((s) => s >= 0);
  let winners = tied;
  if (tied.length > 1) {
    const most = Math.max(...tied.map((s) => mobsHome[s]));
    winners = tied.filter((s) => mobsHome[s] === most); // still tied -> shared
  }
  const better = (a, b) => totals[a] > totals[b] || (totals[a] === totals[b] && mobsHome[a] > mobsHome[b]);
  const seats = Array.from({ length: n }, (_, s) => s);
  const ranking = [...seats]
    .sort((a, b) => totals[b] - totals[a] || mobsHome[b] - mobsHome[a] || a - b)
    .map((s) => ({ seat: s, total: totals[s], mobsHome: mobsHome[s], rank: 1 + seats.filter((o) => better(o, s)).length }));
  const sorted = [...totals].sort((a, b) => b - a);
  return {
    totals,
    mobsHome,
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
