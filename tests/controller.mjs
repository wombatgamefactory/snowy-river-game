// controller.mjs - drives src/ui/controller.js in Node with scripted "human" choices:
// a full 4-seat human-v-Easy game, a learner game (forced cards not auto-played), a 3-human
// pass-and-play game (hand-off rule; v6 has no secret summit choice), an all-bot 5-seat game, a 2-seat
// game, refusals, the worker path (bot-worker.js message shape) and the bot failure cap.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { createController, MAX_BOT_FAILURES } from '../src/ui/controller.js';
import { registerBot, getBot } from '../src/bots/index.js';
import { makeRng, rngPick } from '../src/engine/index.js';
import { suite, conservation } from './lib.mjs';

const { check, done } = suite('controller');

/** Scripted human: tries an illegal card first when there is one, then a random legal action. */
function humanTurn(ctl, rng, stats) {
  const legal = ctl.legalActions();
  const hand = ctl.state.hands[ctl.toAct()];
  const illegal = hand.find((c) => !legal.some((a) => a.card === c));
  if (illegal) {
    const res = ctl.play({ type: 'play', card: illegal });
    if (!res.ok && res.error) stats.refusalMessages++;
    else stats.badAccept++;
  }
  const res = ctl.play(rngPick(rng, legal));
  if (!res.ok) stats.badRefuse++;
  stats.turns++;
}
const newStats = () => ({ refusalMessages: 0, badAccept: 0, badRefuse: 0, turns: 0 });

// ---------- 4 seats: one human v three Easy bots ----------
{
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }, { type: 'easy' }], seed: 11 });
  const rng = makeRng('h1');
  const stats = newStats();
  let changes = 0;
  let shownOk = true;
  ctl.subscribe(() => changes++);
  let guard = 0;
  while (!ctl.isFinished() && guard++ < 1000) {
    ctl.runBots();
    if (ctl.isHumanTurn()) {
      if (ctl.shownSeat() !== 0 || ctl.needsHandoff()) shownOk = false;
      humanTurn(ctl, rng, stats);
    }
  }
  check('human v 3 Easy: the game finishes', ctl.isFinished() && ctl.state.result !== null && ctl.state.handLog.length === 4);
  check('human v 3 Easy: one human sees their own hand and never needs a hand-off', shownOk);
  check('human v 3 Easy: illegal cards are refused with a message', stats.refusalMessages > 0 && stats.badAccept === 0, `${stats.refusalMessages}`);
  check('human v 3 Easy: legal actions are accepted', stats.badRefuse === 0 && stats.turns > 10, `${stats.turns} turns`);
  check('human v 3 Easy: zero refused bot proposals', ctl.botRefusals === 0);
  check('human v 3 Easy: subscribers are notified', changes > 0);
  check('human v 3 Easy: the log has the start, hands, tricks and the result', ctl.log[0].event.type === 'game-started' && ctl.log.some((l) => l.event.type === 'trick-won') && ctl.log[ctl.log.length - 1].event.type === 'game-over');
  check('human v 3 Easy: the lone human is called "You" in the log', ctl.log.some((l) => /^You (win|lead|play)/.test(l.text)));
  check('human v 3 Easy: no action when nobody may act', ctl.play({ type: 'play', card: 'home-1' }).ok === false && ctl.stepBot() === null);
  check('human v 3 Easy: bots are named by level and seat', ctl.names[1] === 'Easy bot 2' && ctl.names[0] === 'You');
}

// ---------- learner option: autoPlayForced false ----------
{
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }, { type: 'easy' }], seed: 12, autoPlayForced: false });
  const rng = makeRng('h2');
  const stats = newStats();
  let guard = 0;
  while (!ctl.isFinished() && guard++ < 1000) {
    ctl.runBots();
    if (ctl.isHumanTurn()) humanTurn(ctl, rng, stats);
  }
  const autoHuman = ctl.log.filter((l) => l.event.type === 'card-played' && l.event.seat === 0 && l.event.auto).length;
  check('autoPlayForced false: the game finishes and the human seat is manual', ctl.isFinished() && ctl.autoPlayForced === false && ctl.state.manualSeats.join() === '0');
  check('autoPlayForced false: no human card is auto-played', autoHuman === 0 && stats.badRefuse === 0);
  const def = createController({ seats: [{ type: 'human' }, { type: 'easy' }], seed: 3 });
  check('autoPlayForced defaults to true (no manual seats); 2 seats accepted', def.autoPlayForced === true && def.state.manualSeats.length === 0 && def.state.n === 2);
}

// ---------- 3 humans, pass-and-play ----------
{
  const ctl = createController({ seats: [{ type: 'human', name: 'Ann' }, { type: 'human', name: 'Bo' }, { type: 'easy' }, { type: 'human', name: 'Cy' }], seed: 'pp' });
  const rng = makeRng('pp');
  const stats = newStats();
  let handoffs = 0; let leak = false; let guard = 0;
  while (!ctl.isFinished() && guard++ < 2000) {
    ctl.runBots();
    if (!ctl.isHumanTurn()) continue;
    const seat = ctl.toAct();
    if (ctl.needsHandoff()) {
      handoffs++;
      if (ctl.shownSeat() === seat) leak = true; // a hand-off is only for a new human
      ctl.reveal(seat);
    }
    if (ctl.needsHandoff() || ctl.shownSeat() !== seat) leak = true;
    if (ctl.state.phase === 'summit') leak = true; // v6: the summit is never a resting phase (R5.5)
    humanTurn(ctl, rng, stats);
  }
  check('pass-and-play: the game finishes', ctl.isFinished());
  check('pass-and-play: a hand-off happens before each new human\'s decision', handoffs > 20, `${handoffs}`);
  check('pass-and-play: a hand is never shown before its owner confirms; no summit pause (R5.5, R10.13)', !leak);
  check('pass-and-play: names from setup are used', ctl.names[0] === 'Ann' && ctl.log.some((l) => /Ann|Bo|Cy/.test(l.text)));
}

// ---------- two humans and a bot, 8 games: every human decision shows the right hand ----------
{
  let wrongSeatShown = 0; let decisions = 0; let finished = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const ctl = createController({ seats: [{ type: 'human', name: 'Ann' }, { type: 'human', name: 'Bo' }, { type: 'easy' }], seed: `pp2-${seed}` });
    const rng = makeRng(`pp2-${seed}`);
    const stats = newStats();
    let guard = 0;
    while (!ctl.isFinished() && guard++ < 2000) {
      ctl.runBots();
      if (!ctl.isHumanTurn()) continue;
      const seat = ctl.toAct();
      decisions++;
      if (ctl.needsHandoff()) ctl.reveal(seat);
      if (ctl.shownSeat() !== seat) wrongSeatShown++;
      humanTurn(ctl, rng, stats);
    }
    if (ctl.isFinished()) finished++;
  }
  check('pass-and-play (2 humans + a bot, 8 games): every game finishes and every decision shows the deciding human\'s hand', finished === 8 && decisions > 100 && wrongSeatShown === 0, `${wrongSeatShown} wrong of ${decisions}`);
}

// ---------- all bots, 5 seats (the most there are, R1.10) ----------
{
  const ctl = createController({ seats: Array.from({ length: 5 }, () => ({ type: 'easy' })), seed: 'bots' });
  ctl.runBots();
  check('all bots, 5 seats: the game plays to the end with no human input', ctl.isFinished() && ctl.state.rulesCode === 'std' && conservation(ctl.state).ok && ctl.state.handLog.length === 5);
  check('controller: 6 seats are refused (2 to 5 players, R1.10)', (() => { try { createController({ seats: Array.from({ length: 6 }, () => ({ type: 'easy' })), seed: 1 }); return false; } catch { return true; } })());
  check('controller: a rules switch is refused (there are none)', (() => { try { createController({ seats: [{ type: 'easy' }, { type: 'easy' }], seed: 1, rules: { TRUMP: 'red' } }); return false; } catch { return true; } })());
  check('all bots: nobody\'s hand is shown', ctl.shownSeat() === null && !ctl.needsHandoff());
}

// ---------- worker path: botTask / applyBotResult (the bot-worker.js message shape) ----------
{
  const ctl = createController({ seats: [{ type: 'easy' }, { type: 'medium' }, { type: 'easy' }], seed: 'w' });
  let guard = 0; let staleOk = true;
  while (!ctl.isFinished() && guard++ < 2000) {
    const task = JSON.parse(JSON.stringify(ctl.botTask()));
    const rng = { s: task.rng.s };
    const action = getBot(task.level).chooseAction(task.view, rng);
    const r = ctl.applyBotResult(task, { action, rng });
    if (!Array.isArray(r)) staleOk = false;
    if (!ctl.isFinished() && ctl.applyBotResult(task, { action, rng }) !== 'stale') staleOk = false;
  }
  check('worker path: a game finishes through botTask / applyBotResult; an old answer is stale', ctl.isFinished() && staleOk);
}

// ---------- the failure cap ----------
{
  registerBot({ id: 'broken', label: 'Broken', offered: false, chooseAction: () => ({ type: 'play', card: 'nope' }) });
  const ctl = createController({ seats: [{ type: 'broken' }, { type: 'easy' }, { type: 'easy' }], seed: 'cap' });
  ctl.runBots();
  check(`failure cap: a bot refused ${MAX_BOT_FAILURES} times in a row still lets the game finish`, ctl.isFinished() && ctl.botRefusals > 0);
  check('unknown bot levels are refused at setup', (() => { try { createController({ seats: [{ type: 'nobody' }, { type: 'easy' }, { type: 'easy' }], seed: 1 }); return false; } catch { return true; } })());
  check('a controller needs a seed', (() => { try { createController({ seats: [{ type: 'easy' }, { type: 'easy' }] }); return false; } catch { return true; } })());
}

done();
