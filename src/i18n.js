// Pocket Companion: session names in the current language, through the T() given (native/i18n.ts over the engine's strings; assets/strings.json holds the tables).
'use strict';

export function contentName(name, t) {
  const s = String(name || '');
  let m;
  if ((m = /^Daily — (.+)$/.exec(s))) return t('Daily — {date}', { date: m[1] });
  if ((m = /^Practice — (.+)$/.exec(s))) return t('Practice — {level}', { level: t(m[1]) });
  if ((m = /^Score Chase #(.+)$/.exec(s))) return t('Score Chase #{n}', { n: m[1] });
  return t(s);
}
