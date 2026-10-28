// Every player-facing key used by the engine client (native/*.ts: T / N
// literals, the audio captions) and the content (stages, lessons, challenges,
// practice, daily, chase, decor, actions, invalid reasons, achievements)
// exists in all nine locales with the same {placeholders}. DUMP=1 lists keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STRINGS, EN } from '../src/strings.js';
import { LOCALES, t, setLocale, contentName, pickLocale } from '../src/i18n.js';
import * as content from '../src/content.js';
import { ACTIONS, INVALID_REASONS } from '../src/rules.js';
import { ACHIEVEMENTS } from '../src/progress.js';
import { pickPlatformLocale, platformStrings } from '../src/platform-i18n.js';

const NATIVE = new URL('../native/', import.meta.url);

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(NATIVE).filter((n) => n.endsWith('.ts'))) {
    const s = readFileSync(new URL(f, NATIVE), 'utf8');
    for (const m of s.matchAll(/\b[TN]\("((?:[^"\\]|\\.)*)"/g)) keys.add(m[1].replace(/\\"/g, '"'));
  }
  const audio = readFileSync(new URL('audio.ts', NATIVE), 'utf8');
  for (const m of audio.slice(audio.indexOf('export const CAPTIONS'), audio.indexOf('const clips')).matchAll(/: "([^"]+)"/g)) keys.add(m[1]);
  for (const k of ['Guest', 'Not possible right now.', 'Daily — {date}', 'Practice — {level}', 'Score Chase #{n}']) keys.add(k);
  for (const k of Object.keys(EN)) keys.add(k);
  for (const k of [...keys]) if (/^\w+\.$/.test(k)) keys.delete(k); // prefixes of built keys (overlay., board., teach.)
  for (const a of Object.values(ACTIONS)) { keys.add(a.label); keys.add(a.blurb); }
  for (const v of Object.values(INVALID_REASONS)) keys.add(v);
  for (const a of ACHIEVEMENTS) { keys.add(a.name); keys.add(a.desc); }
  for (const s of content.JOURNEY_STAGES) { keys.add(s.name); if (s.intro) keys.add(s.intro); }
  for (const l of content.LESSONS) { keys.add(l.title); for (const st of l.steps) keys.add(st.text); }
  for (const c of content.CHALLENGES) { const cfg = content.challengeConfig(c.id); keys.add(cfg.name); if (cfg.intro) keys.add(cfg.intro); }
  for (const d of content.PRACTICE_DIFFICULTIES) { keys.add(d.name); const cfg = content.practiceConfig(d.id, 1); if (cfg.intro) keys.add(cfg.intro); }
  keys.add(content.dailyConfig('2026-01-01').intro);
  keys.add(content.scoreChaseConfig(1).intro);
  for (const d of content.DECOR_ITEMS) keys.add(d.name);
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

test('nine locales; en-GB overrides only real keys', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort());
  const keys = usedKeys();
  for (const k of Object.keys(STRINGS['en-GB'])) assert.ok(keys.has(k), 'unknown en-GB key ' + k);
});

test('locale picking, content names and the account strings', () => {
  assert.equal(pickLocale('de'), 'de-DE');
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('ja-JP'), 'en-US');
  setLocale('de-DE');
  assert.equal(t('Feed'), STRINGS['de-DE'].Feed);
  assert.match(contentName('Daily — 2026-01-01'), /2026-01-01/);
  setLocale('en-US');
  assert.equal(contentName('Practice — Gentle'), 'Practice — Gentle');
  for (const loc of LOCALES) assert.ok(platformStrings(pickPlatformLocale(loc)).lbRank.includes('{rank}'));
});
