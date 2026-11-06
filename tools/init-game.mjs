// init-game.mjs - fills in the {{TOKENS}} of a fresh copy of the starter kit. Run once, in the new
// repo:   npm run init -- --name="My Game" --slug=my-game --tagline="One line." --description="One sentence."
//
//   --name         display name                      {{GAME_NAME}}
//   --slug         kebab-case id (repo, storage keys) {{GAME_SLUG}}
//   --tagline      the landing-page strap line        {{GAME_TAGLINE}}
//   --description  the meta description               {{GAME_DESCRIPTION}}
//   --url          public address, trailing slash     {{PUBLISH_URL}}   (default: wombatgamefactory.com/<slug>-game/)
//   --rulebook     rule book file under rules/        {{RULEBOOK_FILE}} (default: rules/<slug>-rule-book-v1.pdf)
//
// Values are escaped for the file they go into (JS strings, JSON, HTML). The tool edits the files
// in place: it is a one-time scaffold step, not a generator. It prints how many TODO(game)
// markers are left; `npm run sweep -- --strict` fails until none are.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// README.md is left alone on purpose: this kit's README describes the kit, and the new game
// gets a README of its own.
const FILES = ['index.html', 'package.json', 'src/game-config.js'];

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (!m) { console.error(`Bad argument "${a}" (use --name=value)`); process.exit(2); }
  return [m[1], m[2]];
}));
const need = (k) => { if (!args[k]) { console.error(`init: --${k} is required`); process.exit(2); } return args[k]; };

const name = need('name');
// The slug is the game's name (snowy-river); the repo and URL add "-game". Accept either form.
const slug = need('slug').replace(/-game$/, '');
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { console.error('init: --slug must be lower-case kebab-case, e.g. snowy-river'); process.exit(2); }
const values = {
  GAME_NAME: name,
  GAME_SLUG: slug,
  GAME_TAGLINE: args.tagline || name,
  GAME_DESCRIPTION: args.description || `${name}: a card game for your browser.`,
  PUBLISH_URL: args.url || `https://www.wombatgamefactory.com/${slug}-game/`,
  RULEBOOK_FILE: args.rulebook || `rules/${slug}-rule-book-v1.pdf`,
};
if (!values.PUBLISH_URL.endsWith('/')) values.PUBLISH_URL += '/';

const escapeFor = (file, v) => {
  if (file.endsWith('.js')) return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  if (file.endsWith('.json')) return JSON.stringify(v).slice(1, -1);
  if (file.endsWith('.html')) return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return v;
};

let changed = 0;
for (const file of FILES) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;
  let text = fs.readFileSync(full, 'utf8');
  const before = text;
  for (const [token, value] of Object.entries(values)) text = text.split(`{{${token}}}`).join(escapeFor(file, value));
  if (text !== before) { fs.writeFileSync(full, text); changed++; console.log(`filled ${file}`); }
}
if (!changed) console.log('init: no {{TOKENS}} found; nothing to do (already initialised?)');

// Report what is still to do. (The marker pattern is built in pieces so this file does not trip the sweep.)
const MARKER = new RegExp('TO' + 'DO\\(game\\)', 'g');
let todo = 0; let tokens = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!['node_modules', '.git', 'tmp'].includes(e.name)) walk(rel); continue; }
    if (!/\.(js|mjs|html|css|md|json)$/.test(e.name)) continue;
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (rel === 'README.md' || rel === 'tools/init-game.mjs' || rel === 'tests/qa/sweep.mjs') continue; // they talk about the markers
    todo += (text.match(MARKER) || []).length;
    tokens += (text.match(/\{\{[A-Z_]+\}\}/g) || []).length;
  }
};
walk('');
console.log(`${todo} TODO(game) markers left; ${tokens} unfilled {{TOKENS}} left.`);
