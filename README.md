# Snowy River

A trick-taking card game for 2 to 4 players, played in the browser. About 20 to 30 minutes a game, ages 10 and up.

*The big horses win going up. At the summit, turn your hand round.* Every card has two numbers, one for the climb and an upside-down one for the descent, and the two add up to 13. Climb the mountain with the mob, then turn your whole hand round, and the weedy ponies become the best cards in the game. At the summit everyone secretly chooses: **Chase** the mob down the far side, or **Watch** from the top.

**Play it online: <https://www.wombatgamefactory.com/snowy-river-game/>**

## How a game goes

- The deck is 48 horse cards in four suits (Escape, Climb, Descent and Home), numbered 1 to 12. Each card has two numbers: the climb number at the top and the descent number, 13 minus it, upside down at the bottom. Everyone is dealt 12 cards, climb side up. The cards not dealt stay out of the game, unseen. A game is three hands with two or three players and four hands with four.
- **The climb: six tricks.** The player left of the dealer leads any card. You must follow the suit led if you can; if you cannot, you may play anything. **Escape is trumps** on the climb: if any Escape card is played, the highest Escape card wins. Otherwise the highest card of the suit led wins. The winner leads the next trick, and the mob climbs one step up the **Mountain** card after every trick.
- **Every trick is 1 point,** up or down. You keep the tricks you win in one pile.
- **The summit.** After the sixth trick everyone turns their whole hand round, so the numbers that were at the bottom now count, and the Mountain card turns over. **Home is trumps** from here. Six **Brumby** cards are laid out face up in a row, one for each descent trick, and the Colt may be among them. Everyone secretly picks a **Chase** or a **Watch** card, and the cards are turned over together.
- **Chase or Watch.** A watcher pays nothing. A chaser pays 2 (3 with two players) and keeps the Brumby card of every descent trick they win. Most Brumby cards are worth points, a few (flint stones, wombat holes) cost you, and the Colt is worth 4. A watcher who wins a descent trick sends that Brumby card off instead.
- **The descent: six tricks.** The player who won the last climb trick leads. The same rules, reading the turned numbers, with Home as trumps. The winner of each trick takes the next Brumby card from the row, left to right.
- **Scoring.** A watcher scores 1 per trick. A chaser scores 1 per trick, plus the Brumby cards they kept, minus the Chase cost, and can finish a hand below zero. The 12 Brumby cards are used up over two hands and then shuffled again.
- The highest total after the last hand wins. A tie goes to the most points in the last hand; if that is level too, the win is shared.

The page has a How to play section with the same rules in more detail.

## What is in the game

- 2 to 4 seats. Each seat can be a human or an Easy, Medium or Hard bot. Set every seat to a bot to watch a game.
- Pass and play: with two or more humans on one device, a cover hides each hand between turns, and the Chase or Watch choice is made behind it so nobody sees it before the cards are turned.
- When you follow, a mark on each playable card shows whether it would win the trick as it stands, and every card you cannot play says why.
- For learners, you play every card yourself, even when only one is legal. Tick "Play forced cards for me" on the setup screen to have those played automatically.
- A reckoning after every hand shows what each player did and how each score was made: tricks, Brumby cards kept, the Chase cost and the hand total. The Mountain card, the Brumby row and each chaser's kept cards show the state of the hand as it goes.
- A local stats screen with CSV and JSON export. Results stay in your browser.
- A built-in "report a problem" button (also Ctrl+Shift+B) that saves a JSON snapshot of the game as it stands, for bug reports. Nothing is sent automatically; it prepares an email to info@wombatgamefactory.com.
- The live site uses Google Analytics behind a cookie-consent banner. It counts games started and finished, and for each finished game sends a short anonymous summary: number of players, the kind of seat that won (human, a bot level, or shared), the winning score and margin, whether the tiebreak was used, and how many hands nobody chased, how many chasers there were and what they kept. No names or free text are sent. Neither the banner nor Analytics loads on localhost.

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

Runs every Node test suite: the engine's purity, the rules (one check per numbered rule), a replay of games recorded from a reference simulator written in Python, a smoke test that plays thousands of bot games, the game controller, the bots, the simulator, the stats store, the analytics whitelist and the interface helpers. It needs only Node.js.

```sh
npm run test:browser
```

Drives the real page in headless Chromium: full games against each bot level at 2 to 4 players, pass-and-play with the secret summit choices, the Mountain card, the Brumby row and the reckoning, the stats screen and exports, the bug reporter and several screen widths. This one needs [Playwright](https://playwright.dev) (`npm install -g playwright`, then `npx playwright install chromium`); the tests look for it in the global npm folder, or in the folder named by the `PLAYWRIGHT_PATH` environment variable. It takes several minutes, so it can be run in sections: `node tests/ui-browser.mjs --part=landing,human4` (the section names are listed at the top of `tests/ui-browser.mjs`).

Two more scripts are for people preparing a release:

```sh
npm run qa      # a longer browser run from a sub-path, with screenshots in your temp folder
npm run sweep   # checks that nothing private or oversized is in the files that would be published
```

## The bots

- **Easy** plays a random legal card and makes a random Chase or Watch choice.
- **Medium** follows a set of rules of thumb for which card to play, valuing each descent trick by the Brumby card it wins, and decides whether to chase by playing out the rest of the hand on sampled deals.
- **Hard** samples the cards it cannot see, plays each candidate move out over those samples, and picks the one with the best expected score margin over the best opponent. It runs in a Web Worker so the page never freezes.

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
tests/                     Node suites, Playwright suites, the simulator and tests/qa (QA run and sweep)
```

The engine never touches the page, so the same code runs in the browser, in the Node tests and in the simulator.

## Credits

Game design: Dean Morris, Wombat Game Factory. Inspired by the Australian poem "The Man from Snowy River" by A. B. "Banjo" Paterson (1890).
