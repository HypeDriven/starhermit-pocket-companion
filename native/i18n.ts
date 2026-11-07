// Localization: assets/strings.json (en-US text as the keys, the nine StarHermit
// locales) through the engine's strings, with its starhermit.* account strings,
// in the interface language the runtime reports (Options › Language, else the
// account's or the device's). Every string is drawn through T() each frame, so a
// change shows on the next frame and never touches the session or its clock.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { contentName as nameOf } from "../src/i18n.js";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** An en-US source string (or symbolic key) in the player's language; `{name}` placeholders from vars. A text with no entry is itself. */
export function T(key: string, vars?: Vars | null): string {
  const k = String(key);
  if (strings.has(k)) return strings.t(k, vars ?? undefined);
  return vars ? k.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : k;
}
/** Marks an en-US key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** The engine's account strings. */
export function S(key: string, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }
/** A session's display name (Daily, Practice and Score chase names keep their date, level or number). */
export function contentName(name: string): string { return nameOf(name, T) as string; }
/** The help texts carried HTML (<em>, <strong>, <kbd>): plain text here. */
export function plain(s: string): string { return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&"); }
