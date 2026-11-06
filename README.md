# Snowy River

A trick-taking card game for 2 to 5 players, played in the browser. About 20 to 30 minutes a game, ages 10 and up.

*High wins the climb. Low wins the descent.* A wild mob of horses runs up the mountain and you ride after it. At the summit everyone secretly chooses: **Chase** it down the far side, or **Watch** from the top and keep what you have won.

**Play it online: <https://www.wombatgamefactory.com/snowy-river-game/>**

## How a game goes

- The deck is 48 horse cards in four suits (Escape, Climb, Descent and Home), numbered 1 to 12. There are no trumps. Everyone is dealt 12 cards (2 or 3 players), 11 (4 players) or 9 (5 players); the rest stay out of the game, unseen. Everybody deals once, so a game is one hand per player (three hands at two players).
- The player left of the dealer leads any card. You must follow the suit led if you can; if you cannot, you may play anything, but a card of another suit never wins.
- **The climb.** The highest card of the suit led wins the trick. Each climb trick is worth 1 point if you keep it. After every trick the mob climbs the **Mountain** card by 1 step, plus 1 more for every card played that was not of the suit led.
- **The summit.** When the mob reaches the top (step 7, or step 6 on the other side of the Mountain card with five players), every player secretly picks a **Chase** or a **Watch** card, and the cards are turned over together. If nobody chases, the hand ends and everyone keeps their climb points.
- **The descent.** Everyone plays on to the last card, and now the lowest card of the suit led wins. The player with the most descent tricks is **at the mob's heels** (a tie goes to whoever won the later trick).
- **Scoring.** A Watcher scores their climb tricks. A Chaser who is at the heels brings the mob home and scores their climb tricks plus the mob, which is worth 3 plus 2 for each **Brumby** card under the **Colt**. Every other Chaser falls for -1. If a Watcher is at the heels, or nobody chases, the mob escapes and a Brumby card goes under the Colt (at most four, so the mob is worth at most 11). When a mob is brought home, the Brumby cards go back.
- The highest total after the last hand wins. If totals are tied, the tied player who brought the mob home most often wins; if that is level too, the win is shared.

The printed rule book is in [`rules/`](rules/snowy-river-rule-book-v3.pdf), and the page has a short how-to-play.

## What is in the game

- 2 to 5 seats. Each seat can be a human or an Easy, Medium or Hard bot. Set every seat to a bot to watch a game.
- Pass and play: with two or more humans on one device, a cover hides each hand between turns, and the Chase or Watch choice is made behind it so nobody sees it before the cards are turned.
- When you follow, a mark on each playable card shows whether it would win the trick as it stands, and every card you cannot play says why.
- For learners, you play every card yourself, even when only one is legal. Tick "Play forced cards for me" on the setup screen to have those played automatically.
- A reckoning after every hand shows what each player did and how each score was made, and the Mountain card, the Colt and its Brumby cards show the state of the mob.
- A local stats screen with CSV and JSON export. Results stay in your browser.
- A built-in "report a problem" button (also Ctrl+Shift+B) that saves a JSON snapshot of the game as it stands, for bug reports. Nothing is sent automatically; it prepares an email to info@wombatgamefactory.com.
- The live site uses Google Analytics behind a cookie-consent banner. It counts games started and finished, and for each finished game sends a short anonymous summary: number of players, the kind of seat that won (human, a bot level, or shared), the winning score and margin, whether the tiebreak was used, and how many mobs were brought home, escaped or not chased. No names or free text are sent. Neither the banner nor Analytics loads on localhost.

## Run it locally

There is no build step and nothing to install. The game is plain JavaScript modules, HTML and CSS.

```sh
npm run dev
```

This serves the folder on <http://localhost:8080> (it uses `npx http-server`, so it needs Node.js and an internet connection the first time). Any other static file server works too: serve the repository root and open `index.html` through it. Opening the file directly from disk will not work in most browsers, because modules need a server.

Two URL options are handy while testing: `?seed=7` makes the deals repeatable, and `?botdelay=50` sets the pause (in milliseconds) before each bot move.

## Tests

```sh
npm test
```

Runs every Node test suite: the engine's purity, the rules (one check per numbered rule), a replay of games recorded from the original Python simulator, a smoke test that plays thousands of bot games, the game controller, the bots, the simulator, the stats store, the analytics whitelist and the interface helpers. It needs only Node.js.

```sh
npm run test:browser
```

Drives the real page in headless Chromium: full games against each bot level at 2 to 5 players, pass-and-play with the secret summit choices, the Mountain, the Colt and the reckoning, the stats screen and exports, the bug reporter and several screen widths. This one needs [Playwright](https://playwright.dev) (`npm install -g playwright`, then `npx playwright install chromium`); the tests look for it in the global npm folder, or in the folder named by the `PLAYWRIGHT_PATH` environment variable. It takes several minutes.

Two more scripts are for people preparing a release:

```sh
npm run qa      # a longer browser run from a sub-path, with screenshots in your temp folder
npm run sweep   # checks that nothing private or oversized is in the files that would be published
```

## The bots

- **Easy** plays a random legal card and makes a random Chase or Watch choice.
- **Medium** follows a short list of rules of thumb for which card to play and when to chase, using only what it can see.
- **Hard** samples the cards it cannot see, plays each candidate move out over those samples, and picks the one with the best expected score. It runs in a Web Worker so the page never freezes.

The simulator can also seat some fixed-policy players that the page does not offer, for example one that always chases and one that never does.

## Simulations

The bots and the rules can be run without a browser. `npm run sim` plays many bot-versus-bot games and writes a JSON record; `tests/sim-report.mjs` summarises it.

```sh
# 400 four-player games, Medium at every seat, with 5% random noise so the seats are not copies of each other
npm run sim -- --players=4 --seats=medium --games=400 --seed=1 --jitter=5 --out=tests/tmp/medium.json

# 200 three-player games, one Hard against two Medium bots
npm run sim -- --players=3 --seats=hard,medium,medium --games=200 --seed=1 --out=tests/tmp/hard-v-medium.json

node tests/sim-report.mjs tests/tmp/medium.json tests/tmp/hard-v-medium.json
```

The header of `tests/sim.mjs` lists every option. Output goes to `tests/tmp/`, which is not tracked.

## Project layout

```text
index.html, style.css      the page and its styles
src/engine/                the rules: pure functions on a plain-JSON game state (no DOM, no clock)
src/bots/                  Easy, Medium and Hard bots (and the simulator's fixed-policy players)
src/ui/                    the interface: setup page, game screen, stats, bug reporter, analytics
assets/                    runtime art, and manifest.json listing every image
rules/                     the printed rule book (PDF)
tests/                     Node suites, Playwright suites, the simulator and tests/qa (QA run and sweep)
```

The engine never touches the page, so the same code runs in the browser, in the Node tests and in the simulator.

## Credits

Game design: Dean Morris, Wombat Game Factory. Inspired by the Australian poem "The Man from Snowy River" by A. B. "Banjo" Paterson (1890).
