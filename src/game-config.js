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
export const GAME_TAGLINE = fill('The big horses win going up. Over the top, the smallest horse wins.', 'A plain must-follow trick-taker to prove the kit.');
/** Where the finished game is published (trailing slash). */
export const PUBLISH_URL = fill('https://www.wombatgamefactory.com/snowy-river-game/', 'https://www.wombatgamefactory.com/demo-tricks-game/');
/** No rule book link: the printed rule book (rules/snowy-river-rule-book-v3.pdf, kept in the repo, unlinked) describes the
 *  older rules, so the game's own How to play is the only rules text. Empty on purpose; nothing links to it. */
export const RULEBOOK_URL = '';
/** Footer line under the setup form. */
export const FOOTER_VERSION = 'Version 6 rules';

/** The public contact address for bug reports (never a personal address). */
export const CONTACT_EMAIL = 'info@wombatgamefactory.com';

// The seat counts the game supports (also CONSTANTS.MIN_PLAYERS / MAX_PLAYERS in src/engine/rules.js and the
// "Players" strip on the landing page).
// 2 to 5 players (v6 rules): 5 players add the Muster suit.
export const PLAYER_COUNTS = [2, 3, 4, 5];
export const MAX_SEATS = 5;

/** Short blurb of the At-a-glance strip. */
export const AT_A_GLANCE = { players: '2-5', minutes: '20-30', age: '10+' };

/** Prefix for localStorage keys and export file names. */
export const STORE_PREFIX = GAME_SLUG;
