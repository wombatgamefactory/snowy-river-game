// game-config.js - the one place a game's name, slug and public address live in code.
//
// The double-brace tokens below are replaced by `npm run init -- --name="My Game" --slug=my-game ...`
// (tools/init-game.mjs). Until then the demo values after each token are used, so the starter
// kit runs as it stands. Tests read these constants instead of hard-coding the name.
//

const fill = (value, fallback) => (String(value).startsWith('{{') ? fallback : value);

/** Display name, e.g. 'My Game'. */
export const GAME_NAME = fill('Snowy River', 'Demo Tricks');
/** kebab-case: repo name, storage keys, export file names, the analytics game_name. */
export const GAME_SLUG = fill('snowy-river', 'demo-tricks');
/** One short strap line for the landing page hero. */
export const GAME_TAGLINE = fill('High wins the climb. Low wins the descent.', 'A plain must-follow trick-taker to prove the kit.');
/** Where the finished game is published (trailing slash). */
export const PUBLISH_URL = fill('https://www.wombatgamefactory.com/snowy-river-game/', 'https://www.wombatgamefactory.com/demo-tricks-game/');
/** The rule book the landing page and the How to play dialog link to (a file under rules/). */
export const RULEBOOK_URL = fill('rules/snowy-river-rule-book-v3.pdf', 'rules/placeholder.md');
/** Footer line under the setup form. */
export const FOOTER_VERSION = 'Rule book v3';

/** The public contact address for bug reports (never a personal address). */
export const CONTACT_EMAIL = 'info@wombatgamefactory.com';

// The seat counts the game supports (also CONSTANTS.MIN_PLAYERS / MAX_PLAYERS in src/engine/rules.js and the
// "Players" strip on the landing page).
// 2 to 4 only for now: the Muster suit for 5 players has no art yet.
export const PLAYER_COUNTS = [2, 3, 4];
export const MAX_SEATS = 4;

/** Short blurb of the At-a-glance strip. */
export const AT_A_GLANCE = { players: '2-4', minutes: '20-30', age: '10+' };

/** Prefix for localStorage keys and export file names. */
export const STORE_PREFIX = GAME_SLUG;
