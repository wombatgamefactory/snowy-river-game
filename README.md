# Snowy River

A trick-taking card game for 2 to 5 players, played in the browser. About 20 to 30 minutes a game, ages 10 and up.

*The big horses win going up. Over the top, the smallest horse wins.* Every card has one number. Climb the mountain with the highest card, then turn the whole game round: over the top the lowest card wins, and the weedy ponies become the best cards in the game. Every trick wins you a card from the row on the table, a Climb card on the way up and a Brumby card on the way down, so the question is always what this trick is worth and whether you want it.

**Play it online: <https://www.wombatgamefactory.com/snowy-river-game/>**

## How a game goes

- The deck is 48 horse cards in four suits (Escape, Climb, Descent and Home), numbered 1 to 12, with one number on each card. With five players the violet Muster suit joins in, which makes 60 cards. Everyone is dealt 12 cards and the cards not dealt stay out of the game, unseen. A game is one hand for each player, or three hands with two players.
- **The Climb row.** Each hand starts with six Climb cards laid face up in a row: five worth +1 and one worth -1. The row is shuffled every hand, so nobody knows in advance which trick wins the -1.
- **The climb: six tricks, highest wins.** The player left of the dealer leads any card. You must follow the suit led if you can; if you cannot, you may play anything. **Escape is trumps** on the climb: if any Escape card is played, the highest Escape card wins. Otherwise the highest card of the suit led wins. The winner takes the next Climb card and leads the next trick.
- **The summit.** When the Climb row is empty, the direction flips. The banner changes, and six Brumby cards are dealt face up in a row, one for each descent trick. The twelve Brumby cards are +2 (five of them), +1 (three), Flint stones -1, two Wombat holes -2, and the Colt, worth +4.
- **The descent: six tricks, lowest wins.** The player who won the last climb trick leads. The same rules, but the **lowest** card wins, and **Home is trumps**: if any Home card is played, the lowest Home card wins. Otherwise the lowest card of the suit led wins. The winner takes the next Brumby card, good or bad. There is no choice and no bidding: you keep what you win. The Muster is never trumps.
- **Scoring.** Your score for a hand is the Climb cards and Brumby cards you took. Tricks themselves score nothing, and a hand can end below zero. The Brumby deck lasts two hands and is then shuffled again.
- The highest total after the last hand wins. A tie goes to the most points in the last hand; if that is level too, the win is shared.

The page has a How to play section with the same rules in more detail.

## What is in the game

- 2 to 5 seats. Each seat can be a human or an Easy, Medium or Hard bot. Set every seat to a bot to watch a game.
- Pass and play: with two or more humans on one device, a cover hides each hand between turns.
- A banner shows which half of the hand you are in, the direction (highest or lowest wins) and the trump suit, with a strip that counts the twelve tricks. The Climb row and the Brumby row are on the table, with the next card to be won lit.
- When you follow, a mark on each playable card shows whether it would win the trick as it stands, and every card you cannot play says why.
- For learners, you play every card yourself, even when only one is legal. Tick "Play forced cards for me" on the setup screen to have those played automatically.
- A reckoning after every hand shows the Climb cards and Brumby cards each player took and how each score was made.
- A local stats screen with CSV and JSON export. Results stay in your browser.
- A built-in "report a problem" button (also Ctrl+Shift+B) that saves a JSON snapshot of the game as it stands, for bug reports. Nothing is sent automatically; it prepares an email to info@wombatgamefactory.com.
- The live site uses Google Analytics behind a cookie-consent banner. It counts games started and finished, and for each finished game sends a short anonymous summary: number of players, the kind of seat that won (human, a bot level, or shared), the winning score and margin, whether the tiebreak was used, and how many hands had the Colt in the row and how many hands ended below zero. No names or free text are sent. Neither the banner nor Analytics loads on localhost.

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

Runs every Node test suite: the engine's purity, the rules (one check per numbered rule), a replay of games recorded from a reference simulator written in Python, a smoke test that plays thousands of bot games at every player count, the game controller, the bots, the simulator, the stats store, the analytics whitelist and the interface helpers. It needs only Node.js.

```sh
npm run test:browser
```

Drives the real page in headless Chromium: full games against each bot level at 2 to 5 players, pass-and-play, the banner, the Climb row and the Brumby row, the summit and the reckoning, the stats screen and exports, the bug reporter and several screen widths. This one needs [Playwright](https://playwright.dev) (`npm install -g playwright`, then `npx playwright install chromium`); the tests look for it in the global npm folder, or in the folder named by the `PLAYWRIGHT_PATH` environment variable. It takes several minutes, so it can be run in sections: `node tests/ui-browser.mjs --part=landing,human4` (the section names are listed at the top of `tests/ui-browser.mjs`).

Two more scripts are for people preparing a release:

```sh
npm run qa      # a longer browser run from a sub-path, with screenshots in your temp folder
npm run sweep   # checks that nothing private or oversized is in the files that would be published
```

## The bots

- **Easy** plays a random legal card.
- **Medium** follows a set of rules of thumb for which card to play. It values each trick by the card it wins (it ducks the -1 Climb card and the Wombat holes, and goes for the Colt), and it saves its strongest card for the best prize still to come.
- **Hard** samples the cards it cannot see, plays each candidate move out over those samples with Medium playing every seat, and picks the one with the best expected score margin over the best opponent. It runs in a Web Worker so the page never freezes.

The simulator can also seat a few fixed-policy players that the page does not offer, for example a plain "play what you would in any trick-taker" player.

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
