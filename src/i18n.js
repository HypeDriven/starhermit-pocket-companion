// Pocket Companion — game language. Strings are keyed by their en-US text
// (src/strings.js; EN holds the symbolic keys) in the nine StarHermit locales.
// The engine client (native/i18n.ts) sets the locale from the runtime's
// interface language (Options › Language); the node tests read the tables
// directly. Pure: no DOM, no storage.

import { STRINGS, EN } from './strings.js';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];

let locale = 'en-US';
let table = STRINGS['en-US'];

/** Translate an en-US string (or symbolic key); {name} placeholders filled from vars. */
export function t(key, vars) {
  let s = table[key] ?? STRINGS['en-US'][key] ?? EN[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

export function getLocale() { return locale; }

/** The nearest shipped locale for a BCP 47 tag. */
export function pickLocale(tag) {
  const s = String(tag || 'en-US');
  if (LOCALES.includes(s)) return s;
  const lang = s.toLowerCase().split(/[-_]/)[0];
  const region = (s.split(/[-_]/)[1] || '').toUpperCase();
  if (lang === 'en') return ['GB', 'IE', 'AU', 'NZ', 'ZA', 'IN'].includes(region) ? 'en-GB' : 'en-US';
  if (lang === 'es') return region === 'ES' ? 'es-ES' : 'es-419';
  if (lang === 'fr') return region === 'CA' ? 'fr-CA' : 'fr-FR';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

export function setLocale(next) {
  locale = LOCALES.includes(next) ? next : pickLocale(next);
  table = STRINGS[locale] || STRINGS['en-US'];
}

/** Session names (content cfg.name) in the current language. */
export function contentName(name) {
  const s = String(name || '');
  let m;
  if ((m = /^Daily — (.+)$/.exec(s))) return t('Daily — {date}', { date: m[1] });
  if ((m = /^Practice — (.+)$/.exec(s))) return t('Practice — {level}', { level: t(m[1]) });
  if ((m = /^Score Chase #(.+)$/.exec(s))) return t('Score Chase #{n}', { n: m[1] });
  return t(s);
}
