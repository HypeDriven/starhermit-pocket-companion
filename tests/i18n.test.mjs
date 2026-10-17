// Every player-facing key used in markup (index.html data-i18n*), code
// (main.js / ui.js / audio captions / rules messages) and content (stages,
// lessons, challenges, practice, daily, chase, decor, actions, achievements)
// exists in all nine locales with the same {placeholders}. DUMP=1 lists keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STRINGS, EN } from '../src/strings.js';
import * as content from '../src/content.js';
import { ACTIONS, INVALID_REASONS } from '../src/rules.js';
import { ACHIEVEMENTS } from '../src/storage.js';

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const lit = /'((?:[^'\\]|\\.)*)'/.source;
const all = (src, re, keys, groups = [1]) => { for (const m of src.matchAll(re)) for (const g of groups) if (m[g] != null) keys.add(m[g].replace(/\\'/g, "'")); };

export function usedKeys() {
  const keys = new Set();
  for (const m of read('index.html').matchAll(/data-i18n(?:-aria|-placeholder|-title)?="([^"]*)"/g)) keys.add(unescape(m[1]));
  const main = read('src/main.js');
  const uiAll = read('src/ui.js');
  // renderGraphics uses its own gfx-i18n translator (`const t = this.gt`)
  const ui = uiAll.slice(0, uiAll.indexOf('  renderGraphics(gfx')) + uiAll.slice(uiAll.indexOf('  _refreshGraphicsInfo() {'));
  for (const src of [main, ui]) {
    all(src, new RegExp(`\\bt\\(${lit}`, 'g'), keys);
    all(src, new RegExp(`\\bt\\([^()]*?\\?\\s*${lit}\\s*:\\s*${lit}`, 'g'), keys, [1, 2]);
  }
  all(main, new RegExp(`\\? ${lit} : st\\.craving\\.need === '\\w+' \\? ${lit} : st\\.craving\\.need === '\\w+' \\? ${lit} : ${lit}`, 'g'), keys, [1, 2, 3, 4]);
  all(main, new RegExp(`\\? ${lit}\\s*: status === 'neglected'\\s*\\? ${lit}\\s*: ${lit}`, 'g'), keys, [1, 2, 3]);
  all(main.slice(main.indexOf('const note = {'), main.indexOf("el.textContent = note")), new RegExp(`: ${lit}`, 'g'), keys);
  all(ui.slice(ui.indexOf('const NEED_CRAVING_TEXT'), ui.indexOf('const ACTION_ICONS')), new RegExp(`: ${lit}`, 'g'), keys);
  all(ui, new RegExp(`(?:slider|toggle|select)\\('\\w+', ${lit}(?:, ${lit})?`, 'g'), keys, [1, 2]);
  all(ui, new RegExp(`\\['\\w+', ${lit}\\]`, 'g'), keys);                    // palette options
  all(ui, new RegExp(`row\\('Display name', nameInput, settings\\._hosted \\? ${lit}`, 'g'), keys);
  const audio = read('src/audio.js');
  all(audio.slice(audio.indexOf('EVENT_CAPTIONS'), audio.indexOf('export class')), new RegExp(`: ${lit}`, 'g'), keys);
  all(audio, new RegExp(`caption: ${lit}`, 'g'), keys);
  for (const k of ['Guest', 'Not possible right now.', 'Display name', 'wishes…', 'Daily — {date}', 'Practice — {level}', 'Score Chase #{n}']) keys.add(k);
  for (const k of Object.keys(EN)) keys.add(k);
  for (const a of Object.values(ACTIONS)) { keys.add(a.label); keys.add(a.blurb); }
  for (const v of Object.values(INVALID_REASONS)) keys.add(v);
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  for (const s of content.JOURNEY_STAGES) { keys.add(s.name); if (s.intro) keys.add(s.intro); }
  for (const l of content.LESSONS) { keys.add(l.title); for (const st of l.steps) keys.add(st.text); }
  for (const c of content.CHALLENGES) { keys.add(c.name); const cfg = content.challengeConfig(c.id); keys.add(cfg.name); if (cfg.intro) keys.add(cfg.intro); }
  for (const d of content.PRACTICE_DIFFICULTIES) { keys.add(d.name); const cfg = content.practiceConfig(d.id, 1); if (cfg.intro) keys.add(cfg.intro); }
  keys.add(content.dailyConfig('2026-01-01').intro);
  keys.add(content.scoreChaseConfig(1).intro);
  for (const d of content.DECOR_ITEMS) keys.add(d.name);
  // ids caught by the ternary pattern are not strings
  for (const k of [...keys]) if (k === '' || /^(overlay|board|teach)\.$|^(graphics|general)$/.test(k)) keys.delete(k);
  return keys;
}

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every used key exists in every translated locale with matching placeholders', () => {
  const keys = usedKeys();
  if (process.env.DUMP) console.log([...keys].sort().map((k) => JSON.stringify(k)).join('\n'));
  assert.ok(keys.size > 250, 'key scan found ' + keys.size);
  const missing = [];
  for (const loc of LOCALES) {
    if (loc.startsWith('en-')) continue;
    for (const k of keys) {
      const v = STRINGS[loc][k];
      if (typeof v !== 'string' || !v) missing.push(loc + ': ' + k);
      else if (ph(v) !== ph(EN[k] ?? k)) missing.push(loc + ' placeholders: ' + k);
    }
  }
  assert.deepEqual(missing, []);
});

test('nine locales; en-GB overrides only real keys; symbolic keys have en-US text', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort());
  const keys = usedKeys();
  for (const k of Object.keys(STRINGS['en-GB'])) assert.ok(keys.has(k), 'unknown en-GB key ' + k);
  for (const k of ['overlay.settings', 'overlay.help', 'overlay.pause', 'overlay.decor', 'board.daily', 'board.stage', 'board.chase', 'teach.craving', 'help.intro', 'help.keyboard', 'help.gamepad']) assert.ok(EN[k], 'EN text for ' + k);
});
