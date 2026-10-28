// The look of the top bar, HUD rails, action tray, sheets and screens: the
// browser build's css/style.css, rewritten class-based in tools/ui-style.css
// and converted once with `starhermit css` into assets/ui-style.json (`npm
// run css`), registered at start with the theme the runtime's own widgets
// (scroll bars, focus rings, selects, text fields) take. The colour-vision
// palettes (the game's Color palette option) and the runtime's high-contrast
// option are the old body[data-palette] / body[data-contrast] token sets.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  bg: "#241d2b", "bg-soft": "#2f2638", panel: "#fff8ee0f", "panel-hover": "#fff8ee1f", "panel-border": "#ffefdc29",
  text: "#f5ead9", "text-dim": "#c9b9a6", accent: "#ffb65c", "accent-2": "#8fd3a0", danger: "#e06a6a",
  "need-hunger": "#f0a35c", "need-hygiene": "#6cc4d9", "need-fun": "#e08ab0", "need-energy": "#a89ae0", "focus-ring": "#ffe08a",
};
/** body[data-palette=…]: colour-vision safe accents (gameplay colours also carry icons and labels). */
const PALETTES: Record<string, Tokens> = {
  default: {},
  deuteranopia: { accent: "#5cc8ff", "accent-2": "#ffd35c", "need-fun": "#c9a0e0" },
  protanopia: { accent: "#5cc8ff", "accent-2": "#ffe98a", "need-hunger": "#e0c05c" },
  tritanopia: { accent: "#ff8a7a", "accent-2": "#5ce0d3", "need-hygiene": "#7ad0c0" },
};
/** body[data-contrast="high"]. */
const CONTRAST: Tokens = {
  bg: "#000000", "bg-soft": "#101010", text: "#ffffff", "text-dim": "#e8e8e8",
  panel: "#ffffff1f", "panel-hover": "#ffffff33", "panel-border": "#ffffff", "focus-ring": "#ffffff",
};

let current: Tokens = { ...BASE };
export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 10, radius: 12,
    text: BASE.text!, muted: BASE["text-dim"]!, panel: BASE["bg-soft"]!, control: "#3a3043", hovered: "#433849",
    pressed: "#4b4052", field: "#3a3043", accent: BASE.accent!, focus: BASE["focus-ring"]!, outline: "#5a4d5f",
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "$focus-ring", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$panel-border", radius: 4 } } },
    tooltip: { background: "$bg-soft", text: { color: "$text" }, radius: 6, padding: 6 },
    // .overlay: rgba(10, 6, 14, 0.6) behind the sheets.
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#0a060e99" } } },
  });
  key = "";
}

let key = "";
/** The palette's and high contrast's tokens (cheap when unchanged). */
export function applyTokens(palette: string, highContrast: boolean): void {
  const k = `${palette}|${highContrast}`;
  if (k === key) return;
  key = k;
  current = { ...BASE, ...(PALETTES[palette] ?? {}), ...(highContrast ? CONTRAST : {}) };
  ui.setTokens(current);
  ui.setTheme({ text: current.text!, muted: current["text-dim"]!, accent: current.accent!, focus: current["focus-ring"]! });
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
