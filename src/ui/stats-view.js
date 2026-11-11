// stats-view.js - the stats screen markup (a dialog body) and the download helper. Pure string
// builders except download(), which needs the DOM. Numbers always come with their counts so a
// small sample is obvious.
// The 'Chase, Watch and the Brumby row' section is Snowy River's own v5 section (summarise().extra); records
// of the v4 game (rules_code 'v4') get 'The mob and the summit' instead (extra4). The screen shows ONE rules
// code at a time (the newest, 'std' = v5, unless the player picks another), so v4 and v5 never mix.
// Keep the section titles in step with tests/stats-browser.mjs.

import { esc } from './assets.js';
import { summarise, KINDS } from './stats-store.js';

const KIND_LABEL = { human: 'Human', easy: 'Easy bot', medium: 'Medium bot', hard: 'Hard bot' };
const LEVEL_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const num = (x, dp = 1) => (x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(dp));
const small = (n) => (n < 10 ? ' <span class="st__small" title="Fewer than 10 games: treat with care">(small sample)</span>' : '');
const codeLabel = (c) => (c === 'std' ? 'Current rules (v5)' : c === 'v4' ? 'Old rules (v4, before 10/11/2026)' : c);
const rateOf = (d, what) => (d ? ` of ${what}` : '');

function table(head, rows) {
  return `<div class="st__scroll"><table class="st__table"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function filterHtml(s) {
  if (s.codes.length < 2) return '';
  const opts = s.codes.map((c) => `<option value="${esc(c.code)}"${s.filter === c.code ? ' selected' : ''}>${esc(codeLabel(c.code))} (${c.games})</option>`);
  return `<label class="st__filter">Show rules <select data-action="stats-filter" aria-label="Show games played under these rules">${opts.join('')}</select></label>`;
}

/** The rules code the screen shows: the one asked for if it exists, else 'std', else the busiest. */
export function effectiveFilter(codes, filter) {
  if (codes.some((c) => c.code === filter)) return filter;
  return codes.some((c) => c.code === 'std') ? 'std' : (codes[0] ? codes[0].code : 'all');
}

/** The v5 measures: Chase and Watch, Brumby cards kept, the Colt. */
function v5Section(s) {
  const ex = s.extra;
  const colt = Object.entries(ex.coltByKind).map(([k, n]) => `${KIND_LABEL[k] || k} ${n}`).join(', ');
  return `<h3>Chase, Watch and the Brumby row</h3>
    <p class="st__muted">Over ${ex.hands} hand${ex.hands === 1 ? '' : 's'} (${ex.tricks} tricks played). A chaser keeps the Brumby card each descent trick they win and pays the chase cost; a watcher sends it off.${small(s.total)}</p>
    ${table(['Measure', 'Count', 'Rate'], [
      `<tr><th scope="row">Chase rate (seats that chased)</th><td>${ex.chases} of ${ex.seatHands}</td><td>${pct(ex.chases, ex.seatHands)}${rateOf(ex.seatHands, 'seat-hands')}</td></tr>`,
      `<tr><th scope="row">Nobody chased</th><td>${ex.nobodyChased}</td><td>${pct(ex.nobodyChased, ex.hands)}${rateOf(ex.hands, 'hands')}</td></tr>`,
      `<tr><th scope="row">Brumby value won by chasers</th><td>${ex.keptValue} in ${ex.keptCards} cards</td><td>${num(ex.chases ? ex.keptValue / ex.chases : null)} per chaser</td></tr>`,
      `<tr><th scope="row">Average hand total of a chaser</th><td>${ex.chases}</td><td>${num(ex.chases ? ex.chaserNet / ex.chases : null)}</td></tr>`,
      `<tr><th scope="row">Colt in the row</th><td>${ex.coltRows}</td><td>${pct(ex.coltRows, ex.hands)}${rateOf(ex.hands, 'hands')}</td></tr>`,
      `<tr><th scope="row">Colt kept by a chaser (+4)</th><td>${ex.coltKept} of ${ex.coltRows}</td><td>${pct(ex.coltKept, ex.coltRows)}${rateOf(ex.coltRows, 'Colt hands')}</td></tr>`,
      `<tr><th scope="row">Colt trick won by the top Home holder</th><td>${ex.coltTopHome} of ${ex.coltRows}</td><td>${pct(ex.coltTopHome, ex.coltRows)}${rateOf(ex.coltRows, 'Colt hands')}</td></tr>`,
      `<tr><th scope="row">Human Chase rate</th><td>${ex.humanChases} of ${ex.humanHands}</td><td>${pct(ex.humanChases, ex.humanHands)}${rateOf(ex.humanHands, 'human hands')}</td></tr>`,
    ])}
    ${colt ? `<p class="st__muted">Colt trick won by: ${esc(colt)}.</p>` : ''}`;
}

/** The v4 game's section, for records relabelled 'v4'. */
function v4Section(s) {
  const ex = s.extra4;
  return `<h3>The mob and the summit</h3>
    <p class="st__muted">Over ${ex.hands} hand${ex.hands === 1 ? '' : 's'} (${ex.tricks} tricks played) under the old rules. A chaser at the heels brought the mob home; any other chaser fell.${small(s.total)}</p>
    ${table(['Measure', 'Count', 'Rate'], [
      `<tr><th scope="row">Mob brought home</th><td>${ex.mobsHome}</td><td>${pct(ex.mobsHome, ex.hands)}${rateOf(ex.hands, 'hands')}</td></tr>`,
      `<tr><th scope="row">Mob escaped (a Brumby was added)</th><td>${ex.escapes}</td><td>${pct(ex.escapes, ex.hands)}${rateOf(ex.hands, 'hands')}</td></tr>`,
      `<tr><th scope="row">Nobody chased</th><td>${ex.nobodyChased}</td><td>${pct(ex.nobodyChased, ex.hands)}${rateOf(ex.hands, 'hands')}</td></tr>`,
      `<tr><th scope="row">Chasers per hand</th><td>${ex.chases}</td><td>${num(ex.hands ? ex.chases / ex.hands : null)} on average</td></tr>`,
      `<tr><th scope="row">Chasers who fell</th><td>${ex.falls}</td><td>${pct(ex.falls, ex.chases)}${rateOf(ex.chases, 'chasers')}</td></tr>`,
    ])}`;
}

/** The whole stats dialog body. `filter` is 'all' or a rules_code. */
export function statsHtml(data, filter = 'all') {
  const games = data && Array.isArray(data.games) ? data.games : [];
  let s = summarise(games, filter);
  if (s.allTotal) s = summarise(games, effectiveFilter(s.codes, filter));
  if (!s.allTotal) {
    return '<div class="st"><p class="st__empty">No games recorded yet. Finish a game and your results will appear here. They are kept in this browser only.</p></div>';
  }

  const kindRows = KINDS.filter((k) => s.byKind[k].seats).map((k) => {
    const t = s.byKind[k];
    return `<tr><th scope="row">${KIND_LABEL[k]}</th><td>${t.seats}</td><td>${t.wins}</td><td>${pct(t.wins, t.seats)}${small(t.seats)}</td></tr>`;
  });
  const vsRows = Object.entries(s.humanVs).filter(([, v]) => v.games).map(([level, v]) =>
    `<tr><th scope="row">Human v ${LEVEL_LABEL[level]} bot</th><td>${v.games}</td><td>${pct(v.humanWins, v.humanSeats)}</td><td>${pct(v.botWins, v.botSeats)}${small(v.games)}</td></tr>`);
  const posRows = s.bySeat.map((t, i) => (t.seats ? `<tr><th scope="row">Seat ${i + 1}</th><td>${t.seats}</td><td>${t.wins}</td><td>${pct(t.wins, t.seats)}${small(t.seats)}</td></tr>` : ''));
  const playerRows = Object.keys(s.byPlayers).sort().map((n) => {
    const p = s.byPlayers[n];
    return `<tr><th scope="row">${n} players</th><td>${p.games}</td><td>${num(p.hands ? p.scoreSum / p.hands : null)}</td><td>${num(p.marginSum / p.games)}</td><td>${num(p.winSum / p.games)}${small(p.games)}</td></tr>`;
  });
  const t = s.ties;
  const ruleRows = s.byRules.map((r) =>
    `<tr><th scope="row">${esc(codeLabel(r.code))}</th><td>${r.games}</td><td>${num(r.hands ? r.scoreSum / r.hands : null)}</td><td>${num(r.marginSum / r.games)}</td><td>${pct(r.tied, r.games)}</td><td>${pct(r.tiebreak, r.games)}</td><td>${pct(r.shared, r.games)}${small(r.games)}</td></tr>`);

  return `<div class="st">
    <p class="st__lead"><b>${s.total}</b> game${s.total === 1 ? '' : 's'} played${s.filter === 'all' ? '' : ` under ${esc(codeLabel(s.filter))}`}. Average score per hand <b>${num(s.avgScorePerHand)}</b>, average winning margin <b>${num(s.avgMargin)}</b>.${small(s.total)}</p>
    ${filterHtml(s)}
    <h3>Win rate by seat type</h3>
    <p class="st__muted">A seat wins when it is a winner, so a shared win counts for each winner. With N players a fair share is 1 in N.</p>
    ${table(['Seat type', 'Seats played', 'Wins', 'Win rate'], kindRows)}
    ${vsRows.length ? `<h3>Human against each bot level</h3><p class="st__muted">Games with at least one human and at least one bot of that level. Win rate is per seat.</p>${table(['Matchup', 'Games', 'Human win rate', 'Bot win rate'], vsRows)}` : ''}
    <h3>Win rate by seat position</h3>
    ${table(['Position', 'Games', 'Wins', 'Win rate'], posRows)}
    <h3>Scores by player count</h3>
    ${table(['Players', 'Games', 'Avg score per hand', 'Avg margin', 'Avg winning score'], playerRows)}
${s.filter === 'v4' ? v4Section(s) : v5Section(s)}
    <h3>Ties and the tiebreak</h3>
    <p class="st__muted">${s.filter === 'v4' ? 'The tiebreak was the most mobs brought home; if that was level too, the win was shared.' : 'The tiebreak is the most points in the last hand; if that is level too, the win is shared.'}</p>
    <p>Level on the top total: <b>${t.tied}</b> of ${t.games} (${pct(t.tied, t.games)}). Tiebreak decided it: <b>${t.tiebreak}</b> (${pct(t.tiebreak, t.games)}). Win shared: <b>${t.shared}</b> (${pct(t.shared, t.games)}).${small(t.games)}</p>
    <h3>By rules</h3>
    <p class="st__muted">Games played under different rules are never mixed: the current rules (v5, split cards and the Brumby row) and, if you played before 10/11/2026, the old v4 rules.</p>
    ${table(['Rules', 'Games', 'Avg score per hand', 'Avg margin', 'Level on top', 'Tiebreak decided', 'Shared win'], ruleRows)}
    <p class="st__muted">Stored in this browser only (last 2000 games). Nothing here is sent anywhere.</p>
  </div>`;
}

export function statsButtonsHtml(hasData) {
  const dis = hasData ? '' : ' disabled title="No games recorded yet"';
  return `<button type="button" class="btn btn--small" data-action="export-csv"${dis}>Export CSV</button>`
    + `<button type="button" class="btn btn--small" data-action="export-json"${dis}>Export JSON</button>`
    + `<button type="button" class="btn btn--small" data-action="clear-stats"${dis}>Clear</button>`;
}

/** Blob + <a download>. Returns true if the click was issued. Never throws. */
export function download(filename, text, mime) {
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch {
    return false;
  }
}
