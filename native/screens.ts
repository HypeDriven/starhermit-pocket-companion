// The browser build's DOM shell (index.html, src/ui.js and css/style.css) as
// starhermit:ui, built every frame over the room: the top bar (title, player
// name, sync note, Help and Settings), the room screen (the objective, needs
// and bond rail; the score, clock and Hint / Undo / Camera / Pause rail; the
// room view with the craving bubble, the floating points, the lesson card and
// the phone pause button; the action tray with its key badges, mirrored for
// the left-handed layout), Mote as a named target, the toasts and the caption
// line, the pause, settings, help and decoration sheets, and every full-page
// screen (title with the hero Mote, modes, journey map, lessons, setup,
// results, leaderboard, profile). The old media queries are layouts picked
// by the window's logical size: wide (≥ 1024 px: three columns), compact
// (701–1023 px: the status blocks in a row above, the score rail beside the
// room), phone (≤ 700 px: status above, tray below, pause in the room) and
// short landscape (≤ 900 × 500 px: a narrow status rail beside the room).
// The room view's rectangle goes to main.ts (view → render.ts), and the page
// is painted around it.
import { frame, openMenu } from "starhermit:engine";
import { bindings, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, Progress, Rules, type Need } from "./game.ts";
import { N, S, T, contentName, currentLocale, plain } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, beginSession, camera, chooseSetup, closeOverlay, copyInvite, decorate, displayName, fresh, goto, hint,
  hudRects, journeyUnlocked, later, leaderboardLine, leave, loadBoard, next, now, objectiveProgress, objectiveText, openOverlay,
  pause, prepareStage, profile, resultsHeadline, resumeFromSheet, resumeName, resumeSession, retry, setGuestName, signIn, startLesson,
  startMode, topOverlay, trayAction, undo, view, dailyKey,
} from "./main.ts";
import { token } from "./style.ts";

// ------------------------------------------------------------------ layout
type Kind = "wide" | "compact" | "phone" | "land";
interface Layout { lw: number; lh: number; sc: number; kind: Kind }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const kind: Kind = lw >= 1024 ? "wide" : lw <= 900 && lw > lh && lh <= 500 ? "land" : lw <= 700 ? "phone" : "compact";
  return { lw, lh, sc, kind };
}
const lastSize = new Map<string, ui.Rect>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn {
  id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; selected?: boolean;
  content?: () => void; width?: number; height?: number;
}
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 2;
function button(b: Btn): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.content) opts.content = b.content;
  else if (b.width != null && buttonWidth(b.text, style) > b.width) {
    const inner = b.width - 40;
    opts.content = () => { ui.style(style === "btn-primary" || style === "btn-big" ? "wrap-dark" : "wrap").paragraph(b.text, Math.max(20, inner)); };
  } else if (b.name && b.name !== b.text) opts.content = () => { ui.label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) later(b.act);
}
/** Buttons at their own widths (or stretched) in rows that wrap at `width` (flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 10, stretch = false, justify: "start" | "center" = "center"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      if (stretch) {
        const total = row.reduce((n, b) => n + bw(b), 0);
        const extra = (width - total - gap * (row.length - 1)) / row.length;
        for (const b of row) button({ ...b, width: bw(b) + extra });
      } else for (const b of row) button(b);
    }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
function rect(r: ui.Rect): void { hudRects.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }
/** A box over a window rectangle (window px) drawn by a placed role-none widget. */
function paint(id: string, x: number, y: number, w: number, h: number, drawFn: (r: ui.Rect) => void): void {
  if (w <= 0 || h <= 0) return;
  const sc = ui.preferences().scale, sa = frame().safeArea;
  ui.place(id, { anchor: "top-start", x: (x - sa.left) / sc, y: (y - sa.top) / sc }, () => {
    ui.widget("", { role: "none", size: { width: w / sc, height: h / sc }, draw: drawFn });
  });
}
function toWindow(x: number, y: number, w: number, h: number): ui.Rect {
  const sc = ui.preferences().scale, sa = frame().safeArea;
  return { x: sa.left + x * sc, y: sa.top + y * sc, width: w * sc, height: h * sc };
}
/** CSS repeat(auto-fit, minmax(min, 1fr)). */
function cardGrid(id: string, count: number, w: number, min: number, gap: number, cell: (i: number, cw: number) => void, maxCols = 99, maxW = Infinity): void {
  const cols = Math.max(1, Math.min(count, maxCols, Math.floor((w + gap) / (min + gap))));
  const cw = Math.min(maxW, (w - (cols - 1) * gap) / cols);
  ui.column(id, () => {
    for (let r = 0; r * cols < count; r++) {
      ui.row(`${id}-r${r}`, () => { for (let i = r * cols; i < Math.min(count, (r + 1) * cols); i++) cell(i, cw); }, { spacing: gap, align: "stretch", ...(maxW < Infinity ? { width: w, justify: "center" as const } : {}) });
    }
  }, { spacing: gap, width: w });
}
/** A .card button: a bold title and dim lines. */
function cardButton(id: string, title: string, lines: string[], cw: number, act: () => void, opts: { style?: string; disabled?: boolean; selected?: boolean; extra?: () => void } = {}): void {
  const inner = cw - 38;
  button({
    id, text: title, name: [title, ...lines].join(". "), style: opts.style ?? "card", width: cw, act,
    ...(opts.disabled ? { disabled: true } : {}), ...(opts.selected !== undefined ? { selected: opts.selected } : {}),
    content: () => ui.column(`${id}-face`, () => {
      para(title, inner, "card-title");
      for (const l of lines) para(l, inner, "card-sub");
      opts.extra?.();
    }, { spacing: 4, width: inner }),
  });
}
const uc = (s: string): string => s.toLocaleUpperCase(currentLocale());
/** The first keyboard key of an action ("1", "H", "Esc"). */
const GLYPH: Record<string, string> = { Escape: "Esc", "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→" };
function keyOf(action: string): string {
  try {
    const b = bindings(action).find((x) => x.device === "keyboard");
    return b ? (GLYPH[b.label] ?? b.label.replace(/^Digit /, "")) : "";
  } catch { return ""; }
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  if (app.screen === "game") playScreen(L);
  else fullScreen(L);
  header(L);
  const top = topOverlay();
  if (top === "pause") pauseSheet(L);
  else if (top === "settings") settingsSheet(L);
  else if (top === "help") helpSheet(L);
  else if (top === "decor") decorSheet(L);
  toasts(L);
  caption(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}
const HEADER = 56;
function header(L: Layout): void {
  const bar = ui.place("topbar", { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.row("topbar-row", () => {
      ui.style("game-title").label("Pocket Companion");
      ui.spacer();
      if (L.lw > 360) ui.style("chip-name").id("profile-chip").label(displayName());
      const st = platform.syncState();
      const note = st === "loading" ? T("syncing…") : st === "saving" ? T("saving…") : st === "synced" ? T("cloud synced") : st === "error" ? T("sync failed — kept on this device") : "";
      if (note && L.lw > 520) ui.style("sync").id("sync-status").label(note);
      button({ id: "btn-help-top", text: "?", name: T("Help"), style: "icon-btn", width: 44, act: () => openOverlay("help") });
      button({ id: "btn-settings-top", text: "⚙", name: T("Settings"), style: "icon-btn", width: 44, act: () => openOverlay("settings") });
    }, { style: "topbar", width: L.lw, height: HEADER, align: "center", spacing: 8 });
  });
  rect(bar);
}

// ------------------------------------------------------------------ the room screen
function playScreen(L: Layout): void {
  const s = app.session;
  if (!s) return;
  const f = frame();
  const left = platform.options.leftHanded;
  const top = HEADER;
  const trayH = (lastSize.get("tray")?.height ?? 80 * L.sc) / L.sc;
  let field: { x: number; y: number; w: number; h: number };
  let statusBuild: (() => void) | null = null;
  if (L.kind === "wide") {
    field = { x: 260, y: top, w: L.lw - 520, h: L.lh - top - trayH };
  } else if (L.kind === "land") {
    field = { x: 200, y: top, w: L.lw - 200, h: L.lh - top - trayH };
  } else if (L.kind === "compact") {
    const sh = (lastSize.get("status-row")?.height ?? 150 * L.sc) / L.sc;
    field = { x: 0, y: top + sh, w: L.lw - 220, h: L.lh - top - sh - trayH };
  } else {
    const sh = (lastSize.get("status-row")?.height ?? 200 * L.sc) / L.sc;
    field = { x: 0, y: top + sh, w: L.lw, h: Math.max(140, L.lh - top - sh - trayH) };
  }
  Object.assign(view, toWindow(field.x, field.y, Math.max(1, field.w), Math.max(1, field.h)));
  // the page around the room view (the canvas sat in the grid's centre track)
  const bg = token("bg"), v = view;
  paint("page-t", 0, 0, f.width, v.y, (r) => draw.rect(r.x, r.y, r.width, r.height, bg));
  paint("page-b", 0, v.y + v.height, f.width, f.height - v.y - v.height, (r) => draw.rect(r.x, r.y, r.width, r.height, bg));
  paint("page-l", 0, v.y, v.x, v.height, (r) => draw.rect(r.x, r.y, r.width, r.height, bg));
  paint("page-r", v.x + v.width, v.y, f.width - v.x - v.width, v.height, (r) => draw.rect(r.x, r.y, r.width, r.height, bg));
  // Mote as a named target (tap to pet), then the room overlays
  const cr = render.creatureRect();
  if (cr && !app.overlays.length) ui.target("Mote", cr, { role: "button" });
  roomOverlays(L, field);
  // rails
  if (L.kind === "wide") {
    rail("hud-left", 0, top, 260, field.h, (w) => { objectiveBlock(w); needsBlock(w); bondBlock(w); });
    rail("hud-right", L.lw - 260, top, 260, field.h, (w) => { scoreBlock(w); clockBlock(w); hudActions(w, true); });
  } else if (L.kind === "land") {
    rail("hud-left", 0, top, 200, field.h, (w) => { objectiveBlock(w); needsBlock(w); bondBlock(w); scoreBlock(w); });
  } else if (L.kind === "compact") {
    statusBuild = () => {
      const w = (L.lw - 24 - 20) / 3;
      ui.row("status-blocks", () => {
        ui.column("sb-1", () => objectiveBlock(w), { width: w });
        ui.column("sb-2", () => needsBlock(w), { width: w });
        ui.column("sb-3", () => bondBlock(w), { width: w });
      }, { spacing: 10, align: "stretch" });
    };
    rail("hud-right", L.lw - 220, field.y, 220, field.h, (w) => { scoreBlock(w); clockBlock(w); hudActions(w, true); });
  } else {
    statusBuild = () => {
      const w = L.lw - 16;
      const half = (w - 10) / 2;
      ui.row("status-top", () => {
        ui.column("sb-1", () => objectiveBlock(half), { width: half });
        ui.column("sb-3", () => { bondBlock(half); }, { width: half });
      }, { spacing: 10, align: "stretch" });
      needsBlock(w);
    };
  }
  if (statusBuild) {
    const r = ui.place("status", { anchor: "top-start", x: 0, y: top }, () => {
      lastSize.set("status-row", ui.column("status-row", statusBuild!, { width: L.lw, spacing: 10, padding: L.kind === "phone" ? 8 : 12 }));
    });
    rect(r);
  }
  tray(L, left);
}
/** A .hud-rail column at a logical rectangle; its content scrolls when taller. */
function rail(id: string, x: number, y: number, w: number, h: number, build: (inner: number) => void): void {
  const pad = w <= 200 ? 4 : 12;
  const r = ui.place(id, { anchor: "top-start", x, y }, () => {
    const prev = lastSize.get(`${id}-in`);
    const scroll = !!prev && prev.height / ui.preferences().scale > h - 2 * pad + 1;
    const iw = w - 2 * pad - (scroll ? 14 : 0);
    const body = (): void => { lastSize.set(`${id}-in`, ui.column(`${id}-in`, () => build(iw), { spacing: 10, width: iw })); };
    ui.column(id, () => {
      if (scroll) ui.scrollArea(`${id}-scroll`, { width: w - 2 * pad, height: h - 2 * pad }, body);
      else body();
    }, { width: w, height: h, padding: pad, spacing: 0 });
  });
  rect(r);
}
function block(id: string, w: number, title: string, build: (inner: number) => void): void {
  // the short-landscape rail's blocks: padding 6 × 8 (style.css landscape media query)
  const narrow = w < 200;
  ui.column(id, () => {
    ui.style("hud-h").label(uc(title));
    build(w - (narrow ? 18 : 30));
  }, { style: "hud-block", width: w, spacing: narrow ? 2 : 4, ...(narrow ? { padding: { top: 6, bottom: 6, start: 8, end: 8 } } : {}) });
}
function objectiveBlock(w: number): void {
  const s = app.session!;
  block("hud-objective", w, T("Objective"), (iw) => {
    para(objectiveText(s.content), iw, "text", "objective-text");
    para(objectiveProgress(s), iw, "muted", "objective-progress");
  });
}
const NEED_ICON: Record<Need, string> = { hunger: "🍲", hygiene: "🫧", fun: "🧶", energy: "💤" };
const NEED_LABEL: Record<Need, string> = { hunger: N("Hunger"), hygiene: N("Cleanliness"), fun: N("Fun"), energy: N("Energy") };
const NEED_TOKEN: Record<Need, string> = { hunger: "need-hunger", hygiene: "need-hygiene", fun: "need-fun", energy: "need-energy" };
function needsBlock(w: number): void {
  const st = app.session!.state;
  block("needs-panel", w, T("Needs"), (iw) => {
    // the short-landscape rail is narrow: a slimmer icon and value column and a capped label
    const narrow = iw < 220;
    const iconW = narrow ? 18 : 22, valW = narrow ? 28 : 34, gap = narrow ? 4 : 6;
    const labelW = Math.min(narrow ? iw * 0.44 : 110, Math.max(...Rules.NEEDS.map((n) => textWidth(T(NEED_LABEL[n]), "need-low"))) + 4);
    const barW = Math.max(24, iw - iconW - labelW - valW - 3 * gap);
    for (const need of Rules.NEEDS) {
      const val = st.needs[need];
      const low = val < 250;
      ui.row(`need-${need}`, () => {
        ui.column(`need-${need}-i`, () => ui.style("text").label(NEED_ICON[need]), { width: iconW });
        ui.column(`need-${need}-l`, () => ui.style(low ? "need-low" : "need-label").label(T(NEED_LABEL[need])), { width: labelW, clip: true });
        const color = token(NEED_TOKEN[need]);
        const pulse = low && !ui.preferences().reducedMotion ? 0.55 + 0.45 * Math.abs(Math.cos(now() * Math.PI)) : 1;
        ui.widget(T(NEED_LABEL[need]), {
          role: "meter", value: val / 10, min: 0, max: 100, size: { width: barW, height: 12 },
          draw: (r, state) => {
            const rr = r.height / 2;
            draw.roundRect(r.x, r.y, r.width, r.height, rr / state.scale, "#00000059");
            const fw = r.width * Math.max(0, Math.min(1, val / 1000));
            if (fw > 1) draw.roundRect(r.x, r.y, fw, r.height, rr / state.scale, color + (pulse < 1 ? Math.round(pulse * 255).toString(16).padStart(2, "0") : ""));
            draw.strokeRoundRect(r.x, r.y, r.width, r.height, rr / state.scale, low && ui.preferences().reducedMotion ? token("danger") : token("panel-border"), low && ui.preferences().reducedMotion ? 2 : 1);
          },
        });
        ui.column(`need-${need}-v`, () => ui.style("need-val").id(`need-${need}-val`).label(String(Math.round(val / 10))), { width: valW, align: "end" });
      }, { spacing: gap, align: "center", width: iw });
    }
  });
}
function bondBlock(w: number): void {
  const s = app.session!;
  const lvl = s.bondLevel;
  block("hud-bond", w, T("Bond"), (iw) => {
    const nextAt = lvl < Rules.BOND_LEVELS.length - 1 ? T("next at {n}", { n: Rules.BOND_LEVELS[lvl + 1]! }) : T("max");
    const a = T("Lv {n}", { n: lvl });
    if (textWidth(a, "text") + textWidth(nextAt, "muted") + 6 <= iw) {
      ui.row("bond-row", () => { ui.style("text").id("bond-level").label(a); ui.style("muted").id("bond-progress").label(nextAt); }, { spacing: 6, align: "end" });
    } else { para(a, iw, "text", "bond-level"); para(nextAt, iw, "muted", "bond-progress"); }
  });
}
function scoreBlock(w: number): void {
  const sc = app.session!.score;
  block("hud-score", w, T("Score"), (iw) => {
    ui.style("score-total").id("score-total").label(String(sc.total));
    para(T("care {care} · discovery {discovery} · bond {bond} · bonus {bonus}", { care: sc.care, discovery: sc.discovery, bond: sc.bond, bonus: sc.timeBonus }), iw, "muted", "score-detail");
  });
}
function clockBlock(w: number): void {
  const st = app.session!.state;
  block("hud-clock", w, T("Clock"), (iw) => {
    para(st.tickLimit ? T("Tick {n} / {total}", { n: st.tick, total: st.tickLimit }) : T("Tick {n}", { n: st.tick }), iw, "text", "tick-display");
    if (st.maxCommands) para(T("Moves {n} / {total}", { n: st.commandCount, total: st.maxCommands }), iw, "muted", "moves-display");
  });
}
/** Hint / Undo / Camera / Pause with their key badges (the old .hud-actions). */
function hudActions(w: number, withPause: boolean): void {
  const s = app.session!;
  const list: Btn[] = [];
  const kb = (id: string, label: string, action: string, act: () => void, disabled = false): Btn => {
    const k = keyOf(action);
    return {
      id, text: label, name: label, act, disabled,
      width: Math.min(w, buttonWidth(label, "btn") + (k ? textWidth(k, "a-key") + 18 : 0)),
      content: () => ui.row(`${id}-face`, () => { ui.style("text").label(label); if (k) ui.style("a-key").label(k); }, { spacing: 8, align: "center" }),
    };
  };
  list.push(kb("btn-hint", T("💡 Hint"), "hint", hint));
  if (s.undoEnabled) list.push(kb("btn-undo", T("↩ Undo"), "undo", undo, !(s._undoStack.length > 0)));
  list.push(kb("btn-camera", T("🎥 Camera"), "camera", camera));
  if (withPause) list.push(kb("btn-pause", T("⏸ Pause"), "pause", pause));
  ui.column("hud-actions", () => { for (const b of list) button(b); }, { spacing: 10, width: w });
}

/** The room's overlays: phone pause button, lesson card, craving bubble, floating points. */
function roomOverlays(L: Layout, field: { x: number; y: number; w: number; h: number }): void {
  const s = app.session!;
  const sc = L.sc, sa = frame().safeArea;
  // craving bubble over Mote's head
  const st = s.state;
  if (st.craving) {
    const text = T(({ hunger: N("🍲 wishes for food"), hygiene: N("🫧 wishes for a bath"), fun: N("🧶 wishes to play"), energy: N("💤 wishes for a nap") } as Record<string, string>)[st.craving.need] ?? N("wishes…"));
    const p = render.creatureAnchor();
    if (p) {
      const bw = textWidth(text, "bubble-text") + 24, bh = 36;
      const cx = Math.max(field.x + 60, Math.min(field.x + field.w - 60, (p.x - sa.left) / sc));
      const cy = Math.max(field.y + 50, (p.y - sa.top) / sc);
      ui.place("craving-bubble", { anchor: "top-start", x: cx - bw / 2, y: cy - bh - 8 }, () => {
        ui.column("craving-col", () => {
          ui.column("craving-box", () => ui.style("bubble-text").id("craving-text").label(text), { style: "bubble", align: "center" });
          ui.widget("", { role: "none", size: { width: bw, height: 8 }, draw: (r) => {
            const mx = r.x + r.width / 2;
            draw.polygon([[mx - 8 * sc, r.y], [mx + 8 * sc, r.y], [mx, r.y + 8 * sc]], "#fff8ee");
          } });
        }, { spacing: 0, align: "center" });
      });
    }
  }
  // floating points (rise 40 % of their height and fade over 1.1 s)
  for (const [i, fl] of app.floats.entries()) {
    const age = (now() - fl.at) / 1.1;
    paint(`float-${i}`, fl.x - 40 * sc, fl.y - 20 * sc, 80 * sc, 40 * sc, (r) => {
      const rise = (ui.preferences().reducedMotion ? 0 : age) * 0.4 * r.height;
      const a = Math.round(Math.max(0, 1 - age) * 255).toString(16).padStart(2, "0");
      draw.text(fl.text, r.x + r.width / 2, r.y + r.height * 0.25 - rise, {
        size: 20 * sc, weight: "800", align: "center", color: token("accent") + a, shadow: { color: "#00000099", x: 0, y: 1 * sc },
      });
    });
  }
  // the lesson card (top of the room; full width on phones)
  const step = app.lesson?.steps[app.lessonStep];
  if (step) {
    const narrow = L.kind === "phone" || L.kind === "land";
    const w = L.kind === "phone" ? field.w - 12 : L.kind === "land" ? Math.min(field.w * 0.46, 300) : Math.min(560, field.w - 24);
    const x = narrow ? field.x + 6 : field.x + (field.w - w) / 2;
    const text = `${T(app.lesson!.title)} — ${T(step.text).replace(/\*\*/g, "")}`;
    const r = ui.place("lesson-banner", { anchor: "top-start", x, y: field.y + (narrow ? 6 : 12) }, () => {
      lastSize.set("lesson", ui.column("lesson-card", () => para(text, w - 36, "lesson-text", "lesson-text"), { style: "lesson", width: w }));
    });
    rect(r);
  }
  // phone and short landscape: a pause button in the room (the right rail is hidden there)
  if (L.kind === "phone" || L.kind === "land") {
    const r = ui.place("pause-mobile", { anchor: "top-start", x: field.x + field.w - 52, y: field.y + (step && L.kind === "phone" ? (lastSize.get("lesson")?.height ?? 0) / sc + 14 : 8) }, () => {
      button({ id: "btn-pause-mobile", text: "⏸", name: T("Pause and menu"), style: "icon-btn", width: 44, act: pause });
    });
    rect(r);
  }
}

/** The action tray: one button per allowed action with its icon, name and key (left-handed: mirrored). */
const ACTION_ICONS: Record<string, string> = {
  feed: "🍲", snack: "🥮", wash: "🫧", play: "🧶", rest: "💤", pet: "🤚", sing: "🎵", toss: "⚾", decorate: "🪑", wait: "⏳",
};
function tray(L: Layout, leftHanded: boolean): void {
  const s = app.session!;
  const legal = s.legal;
  const sc = L.sc;
  const gap = L.kind === "phone" || L.kind === "land" ? 6 : 10;
  const pad = L.kind === "phone" ? 8 : 12;
  const avail = L.lw - 2 * pad;
  const minW = L.kind === "phone" || L.kind === "land" ? 64 : 76;
  const items = legal.map((a, i) => {
    const def = Rules.ACTIONS[a.id];
    const label = def ? T(def.label) : a.id;
    return { a, i, label, w: Math.max(minW, textWidth(label, "a-label") + 22) };
  });
  if (leftHanded) items.reverse();
  // rows that wrap at the tray's width (phones: equal shares of the row)
  const wrap = (per: number): (typeof items)[] => {
    const rows: (typeof items)[] = [[]];
    let used = 0;
    for (const it of items) {
      const row = rows[rows.length - 1]!;
      if (row.length && (used + gap + it.w > avail || row.length >= per)) { rows.push([]); used = 0; }
      used += (rows[rows.length - 1]!.length ? gap : 0) + it.w;
      rows[rows.length - 1]!.push(it);
    }
    return rows;
  };
  // balanced rows (5 + 5 rather than 9 + 1), as wide as they fit
  let rows = wrap(99);
  if (rows.length > 1) {
    const balanced = wrap(Math.ceil(items.length / rows.length));
    if (balanced.length === rows.length) rows = balanced;
  }
  const trayH = (lastSize.get("tray")?.height ?? 80 * sc) / sc;
  const r = ui.place("action-tray", { anchor: "top-start", x: 0, y: L.lh - trayH }, () => {
    lastSize.set("tray", ui.column("tray", () => {
      rows.forEach((row, ri) => ui.row(`tray-r${ri}`, () => {
        const extra = rows.length > 1 && L.kind === "phone" ? (avail - row.reduce((n, it) => n + it.w, 0) - gap * (row.length - 1)) / row.length : 0;
        for (const it of row) actionButton(it.a.id, it.a.legal, it.a.reason, it.i, it.label, it.w + extra);
      }, { spacing: gap, justify: "center", width: avail }));
    }, { width: L.lw, spacing: gap, padding: pad, align: "center" }));
  });
  rect(r);
}
function actionButton(id: string, legalNow: boolean, reason: string | null, slot: number, label: string, w: number): void {
  const key = keyOf(`slot${slot + 1}`);
  const name = legalNow ? label : T("{action} — unavailable: {reason}", { action: label, reason: Rules.INVALID_REASONS[reason ?? ""] ? T(Rules.INVALID_REASONS[reason ?? ""]!) : "" });
  const style = app.suggested === id ? "action-btn-hint" : legalNow ? "action-btn" : "action-btn-off";
  const res = ui.style(style).id(`act-${id}`).widget(name, {
    role: "button", size: { width: w, height: 60 },
    draw: (r, st) => {
      const s = st.scale, cx = r.x + r.width / 2;
      const dim = legalNow ? "" : "8c";
      draw.text(ACTION_ICONS[id] ?? "•", cx, r.y + 4 * s, { size: 20 * s, align: "center", color: token("text") + dim });
      draw.text(label, cx, r.y + 27 * s, { size: 15 * s, align: "center", color: (legalNow ? token("text") : token("text-dim")) + dim, maxWidth: r.width - 6 * s });
      if (key) draw.text(key, cx, r.y + 45 * s, { size: 11 * s, align: "center", color: token("text-dim") });
    },
  });
  if (res.hovered || res.focused) app.hover = id;
  if (res.activated && fresh()) later(() => trayAction(id));
}

// ------------------------------------------------------------------ toasts and captions
function toasts(L: Layout): void {
  if (!app.toasts.length) return;
  const w = Math.min(L.lw - 32, 520);
  ui.place("toast-stack", { anchor: "top", y: HEADER + 4 }, () => {
    ui.column("toast-col", () => {
      app.toasts.forEach((t, i) => ui.column(`toast-${i}`, () => para(t.text, w - 40, "toast-text", `toast-${i}-text`), { style: "toast" }));
    }, { spacing: 8, align: "center" });
  });
}
function caption(L: Layout): void {
  if (!app.caption) return;
  const trayH = app.screen === "game" ? (lastSize.get("tray")?.height ?? 80 * L.sc) / L.sc : 70;
  ui.place("caption-line", { anchor: "bottom", y: trayH + 4 }, () => {
    ui.column("caption-box", () => para(app.caption!.text, Math.min(L.lw * 0.9, 600) - 28, "caption-text", "caption-text"), { style: "caption" });
  });
}

// ------------------------------------------------------------------ sheets (.overlay .sheet)
function sheet(L: Layout, label: string, wide: boolean, build: (inner: number) => void, footer?: (inner: number) => void): void {
  const w = Math.min(wide ? 640 : 420, L.lw - 24), inner = w - 46;
  const maxH = L.lh - 24;
  const key = `sheet-${label}`;
  const prev = lastSize.get(key);
  const footH = (lastSize.get(`${key}-foot`)?.height ?? 0) / L.sc;
  const scroll = !!prev && prev.height / L.sc > maxH - 46 - footH - 16;
  const open = ui.dialog(label, "", true, () => {
    ui.column(`${key}-panel`, () => {
      const body = (): void => { lastSize.set(key, ui.column(`${key}-in`, () => build(inner - (scroll ? 14 : 0)), { spacing: 14, width: inner - (scroll ? 14 : 0) })); };
      if (scroll) ui.scrollArea(`${key}-scroll`, { width: inner, height: Math.max(80, maxH - 46 - footH - 16) }, body, frame().frame - app.openedFrame <= 6 ? { scrollTo: { top: 0 } } : undefined);
      else body();
      if (footer) lastSize.set(`${key}-foot`, ui.column(`${key}-foot`, () => footer(inner), { spacing: 10, width: inner, padding: { top: 16 } }));
    }, { style: "sheet", width: w, spacing: 0 });
  });
  if (!open && fresh()) later(closeOverlay);
}
function pauseSheet(L: Layout): void {
  const compact = L.kind === "phone" || L.kind === "land";
  sheet(L, T("Paused"), false, (w) => {
    para(T("Paused"), w, "h2", "pause-heading");
  }, (w) => {
    button({ id: "btn-resume", text: T("Resume"), style: "btn-primary", width: w, act: resumeFromSheet });
    if (compact && app.session) {
      button({ id: "btn-pause-hint", text: T("💡 Hint"), width: w, act: () => { resumeFromSheet(); hint(); } });
      if (app.session.undoEnabled) button({ id: "btn-pause-undo", text: T("↩ Undo"), width: w, disabled: !(app.session._undoStack.length > 0), act: undo });
    }
    button({ id: "btn-pause-settings", text: T("Settings"), width: w, act: () => openOverlay("settings") });
    button({ id: "btn-pause-help", text: T("Help"), width: w, act: () => openOverlay("help") });
    button({ id: "btn-leave", text: T("Leave session"), style: "btn-danger", width: w, act: leave });
  });
}
/** A labelled select row. */
function selectRow(id: string, label: string, idx: number, options: string[], w: number, set: (i: number) => void): void {
  const stack = w < 380;
  const build = (): void => {
    para(label, stack ? w : w * 0.45, "strong", `${id}-label`);
    if (!stack) ui.spacer();
    const pick = ui.id(id).select(label, idx, options, { width: stack ? w : Math.min(w * 0.52, 260) } as ui.WidgetOptions);
    if (pick !== idx) later(() => set(pick));
  };
  if (stack) ui.column(`${id}-row`, build, { width: w, spacing: 4 });
  else ui.row(`${id}-row`, build, { width: w, align: "center", height: 48 });
}
/** A check box row with a wrapped label and hint (a role "checkbox" widget: built-in labels don't wrap). */
function toggleRow(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void, hintText = ""): void {
  ui.column(`${id}-wrap`, () => {
    ui.row(`${id}-row`, () => {
      para(T(label), w - 56, "strong", `${id}-label`);
      ui.spacer();
      const res = ui.id(id).widget(T(label), {
        role: "checkbox", checked: on, size: { width: 44, height: 44 },
        draw: (r, st) => {
          const s = st.scale, box = 26 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
          draw.roundRect(bx, by, box, box, 5, on ? token("accent") : "#3a3043");
          draw.strokeRoundRect(bx, by, box, box, 5, token("text-dim"), 2);
          if (on) draw.text("✓", bx + box / 2, by + 2 * s, { size: 19 * s, color: "#241a10", align: "center", weight: "bold" });
        },
      });
      if (res.activated && fresh()) later(() => set(!on));
    }, { width: w, align: "center", spacing: 8 });
    if (hintText) para(T(hintText), w, "muted", `${id}-hint`);
  }, { width: w, spacing: 0 });
}
const PALETTE_NAMES = [N("Default"), N("Deuteranopia-safe"), N("Protanopia-safe"), N("Tritanopia-safe")];
let nameDraft: string | null = null;
function settingsSheet(L: Layout): void {
  const o = platform.options;
  sheet(L, T("Settings"), true, (w) => {
    para(T("Settings"), w, "h2", "settings-heading");
    para(T("Sound, graphics, language, larger text, high contrast and reduced motion are in the StarHermit Options."), w, "muted", "options-note");
    flow("settings-runtime", [
      { id: "btn-options", text: T("Open Options"), act: () => openMenu() },
      { id: "btn-rebind", text: T("Key bindings"), act: () => requestRebind() },
    ], w, 10, false, "start");
    selectRow("set-palette", T("Color palette"), Math.max(0, Progress.PALETTES.indexOf(o.palette)), PALETTE_NAMES.map((p) => T(p)), w,
      (i) => platform.setOption("palette", Progress.PALETTES[i]!));
    toggleRow("set-captions", N("Captions"), o.captions, w, (v) => platform.setOption("captions", v), N("Text cues for meaningful audio."));
    toggleRow("set-left", N("Left-handed layout"), o.leftHanded, w, (v) => platform.setOption("leftHanded", v));
    toggleRow("set-assist", N("Timing assist"), o.timingAssist, w, (v) => platform.setOption("timingAssist", v), N("Slower need drain. Sessions with assists are not ranked."));
    toggleRow("set-haptics", N("Haptics"), o.haptics, w, (v) => platform.setOption("haptics", v), N("Vibration on supported devices."));
    para(T("Display name"), w, "strong", "name-label");
    if (platform.signedIn()) para(T("Signed in — the platform account name is shown."), w, "muted", "name-note");
    else {
      const cur = nameDraft ?? (profile().name === "Guest" ? "" : profile().name);
      const val = ui.textField("set-name", cur, { maxChars: 24, width: Math.min(w, 320), placeholder: T("Guest") } as ui.WidgetOptions & { maxChars: number; width: number; placeholder: string });
      if (val !== cur) nameDraft = val;
      if (nameDraft !== null && (ui.submitted("set-name") || ui.focused() !== "set-name")) { const n = nameDraft; nameDraft = null; later(() => setGuestName(n)); }
    }
  }, (w) => {
    button({ id: "btn-settings-close", text: T("Done"), style: "btn-primary", width: w, act: () => { if (nameDraft !== null) { setGuestName(nameDraft); nameDraft = null; } closeOverlay(); } });
  });
}
function helpSheet(L: Layout): void {
  const s = app.session;
  const actions = s ? s.state.allowedActions : Object.keys(Rules.ACTIONS);
  sheet(L, T("How to play"), true, (w) => {
    para(T("How to play"), w, "h2", "help-heading");
    para(plain(T("help.intro")), w, "text", "help-intro");
    const kbd = (a: string): string => keyOf(a) || "—";
    para(plain(T("help.keyboard", { hint: kbd("hint"), undo: kbd("undo"), camera: kbd("camera"), pause: kbd("pause") })), w, "text", "help-keys");
    para(plain(T("help.gamepad")), w, "text", "help-pad");
    cardGrid("help-cards", actions.length, w, 220, 8, (i, cw) => {
      const def = Rules.ACTIONS[actions[i]!];
      if (!def) return;
      const k = s ? keyOf(`slot${i + 1}`) : "";
      ui.column(`help-card-${i}`, () => {
        para(`${ACTION_ICONS[def.id] ?? ""} ${T(def.label)}${k ? `  [${k}]` : ""}`, cw - 38, "card-title");
        para(`${T(def.blurb)} ${(def.ticks === 1 ? T("Costs {n} tick.", { n: def.ticks }) : T("Costs {n} ticks.", { n: def.ticks }))}`, cw - 38, "card-sub");
      }, { style: "info-card", width: cw, spacing: 4 });
    });
  }, (w) => {
    button({ id: "btn-help-close", text: T("Close"), style: "btn-primary", width: w, act: closeOverlay });
  });
}
function decorSheet(L: Layout): void {
  const s = app.session;
  if (!s) return;
  const placed = s.state.decorPlaced;
  sheet(L, T("Decorate the room"), false, (w) => {
    para(T("Decorate the room"), w, "h2", "decor-heading");
    const items = s.state.allowedDecor.map((id) => Content.DECOR_ITEMS.find((d) => d.id === id)).filter((d) => !!d);
    cardGrid("decor-list", items.length, w, 130, 10, (i, cw) => {
      const item = items[i]!;
      const isPlaced = placed.includes(item.id);
      cardButton(`decor-${item.id}`, T(item.name), [isPlaced ? T("Placed ✓") : T("Tap to place")], cw, () => decorate(item.id),
        { style: isPlaced ? "card-done" : "card", disabled: isPlaced || app.machine !== "active" });
    });
  }, (w) => {
    button({ id: "btn-decor-close", text: T("Done"), style: "btn-primary", width: w, act: closeOverlay });
  });
}

// ------------------------------------------------------------------ full-page screens (.screen)
function fullScreen(L: Layout): void {
  const f = frame();
  paint("page", 0, 0, f.width, f.height, (r) => draw.rect(r.x, r.y, r.width, r.height, token("bg")));
  const bodyH = L.lh - HEADER;
  const pad = 16;
  const key = `screen-${app.screen}`;
  const prev = lastSize.get(key);
  const scroll = !!prev && prev.height / L.sc > bodyH + 1;
  const cw = L.lw - 2 * pad - (scroll ? 14 : 0);
  const opening = f.frame - app.screenFrame <= 6;
  ui.place("screen", { anchor: "top-start", x: 0, y: HEADER }, () => {
    const body = (): void => {
      const center = app.screen === "title" && !scroll;
      const r = ui.column(`${key}-body`, () => buildScreen(cw, L), {
        width: L.lw - (scroll ? 14 : 0), align: "center", spacing: 14, padding: { top: 18, bottom: 18, start: pad, end: pad },
        ...(center ? { height: bodyH, justify: "center" as const } : {}),
      });
      if (!center) lastSize.set(key, r);
      else lastSize.set(key, { ...r, height: (lastSize.get(`${key}-content`)?.height ?? 0) + 36 * L.sc });
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: L.lw, height: bodyH }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
}
function buildScreen(w: number, L: Layout): void {
  switch (app.screen) {
    case "title": titleScreen(w, L); break;
    case "modes": modesScreen(w); break;
    case "journey": journeyScreen(w); break;
    case "learn": learnScreen(w); break;
    case "setup": setupScreen(w); break;
    case "results": resultsScreen(w); break;
    case "board": boardScreen(w); break;
    case "profile": profileScreen(w); break;
    default: break;
  }
}
const backBtn = (to: "title" | "modes"): void => button({ id: "btn-back", text: T("← Back"), act: () => goto(to) });

// ------------------------------------------------------------------ title
/** The CSS hero Mote: lamplight halo, floor shadow, gradient body with cheeks, belly and eyes; it bobs. */
function heroMote(L: Layout): void {
  const size = Math.max(70, Math.min(130, 0.14 * L.lh));
  const boxW = Math.max(160, Math.min(280, 0.3 * L.lh)), boxH = Math.max(90, Math.min(180, 0.18 * L.lh));
  ui.widget("", {
    role: "none", size: { width: boxW, height: boxH },
    draw: (r, st) => {
      const s = st.scale;
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      draw.box(r.x - r.width * 0.1, r.y - r.height * 0.2, r.width * 1.2, r.height * 1.4, {
        background: { type: "radial", radius: "closest-side", stops: [{ color: "#ffbe6e38", at: 0 }, { color: "#ffbe6e0f", at: 0.6 }, { color: "#ffbe6e00", at: 1 }] },
      });
      const sw = Math.max(60, Math.min(110, 0.11 * L.lh)) * s;
      draw.box(cx - sw / 2, r.y + r.height * 0.96 - 12 * s, sw, 12 * s, {
        radius: 999, background: { type: "radial", radius: "closest-side", stops: [{ color: "#00000073", at: 0 }, { color: "#00000000", at: 1 }] },
      });
      const bob = st.reducedMotion ? 0 : (Math.sin(now() * (2 * Math.PI / 3.2)) * 0.5 - 0.5) * 0.08 * size * s;
      const d = size * s, x = cx - d / 2, y = cy - d / 2 + bob;
      draw.box(x, y, d, d, {
        radius: [d * 0.5, d * 0.5, d * 0.45, d * 0.45],
        background: [
          { type: "radial", shape: "circle", center: { x: 0.3, y: 0.6 }, radius: { x: 0.09, y: 0.09 }, stops: [{ color: "#f0908a8c", at: 0 }, { color: "#f0908a8c", at: 0.78 }, { color: "#f0908a00", at: 1 }] },
          { type: "radial", shape: "circle", center: { x: 0.7, y: 0.6 }, radius: { x: 0.09, y: 0.09 }, stops: [{ color: "#f0908a8c", at: 0 }, { color: "#f0908a8c", at: 0.78 }, { color: "#f0908a00", at: 1 }] },
          { type: "radial", center: { x: 0.5, y: 0.8 }, radius: { x: 0.3, y: 0.2 }, stops: [{ color: "#fff3e0", at: 0 }, { color: "#fff3e0", at: 0.92 }, { color: "#fff3e000", at: 1 }] },
          { type: "radial", center: { x: 0.35, y: 0.28 }, radius: "farthest-corner", stops: [{ color: "#fff0dc", at: 0 }, { color: "#f2c9a0", at: 0.55 }, { color: "#cf9c72", at: 1 }] },
        ],
        shadow: [{ x: -6, y: -8, blur: 16, color: "#78462840", inset: true }, { x: 4, y: 5, blur: 10, color: "#ffffff59", inset: true }],
      } as ui.Style);
      for (const ex of [0.33, 0.67]) {
        const er = d * 0.065;
        draw.circle(x + d * ex, y + d * 0.45, er, "#2a2430");
        draw.circle(x + d * ex - er * 0.3, y + d * 0.45 - er * 0.35, er * 0.38, "#ffffff");
      }
    },
  });
}
function titleScreen(w: number, L: Layout): void {
  const p = profile();
  const today = dailyKey();
  lastSize.set("screen-title-content", ui.column("title-content", () => {
    heroMote(L);
    button({ id: "btn-play", text: T("Play"), style: "btn-big", act: () => goto("modes") });
    const cards: [string, string, string[], () => void][] = [];
    const resume = resumeName();
    if (resume) cards.push(["card-resume", T("Resume session"), [resume], resumeSession]);
    const done = p.daily[today];
    cards.push(["card-daily", T("Daily Challenge"), [done ? T("Done today — {score} pts", { score: done.score }) : T("Not yet played · {date}", { date: today })], () => startMode("daily")]);
    cards.push(["card-journey", T("Journey"), [T("{done} / {total} stages", { done: Object.keys(p.journey).length, total: Content.JOURNEY_STAGES.length })], () => goto("journey")]);
    cards.push(["card-profile", T("Profile"), [T("Bond, discoveries & achievements")], () => goto("profile")]);
    const tw = Math.min(w, 720);
    cardGrid("title-cards", cards.length, tw, 180, 12, (i, cw) => { const c = cards[i]!; cardButton(c[0], c[1], c[2], cw, c[3]); }, cards.length, 230);
    const foot: Btn[] = [];
    if (platform.inviteLink()) foot.push({ id: "btn-invite", text: S("invite"), act: copyInvite });
    if (!platform.signedIn()) foot.push({ id: "btn-signin", text: S("signIn"), act: signIn });
    if (foot.length) flow("title-account", foot, tw, 10);
  }, { align: "center", spacing: 14, width: w }));
}

// ------------------------------------------------------------------ modes, journey, learn, setup
const MODES: [string, string, string][] = [
  ["learn", N("Learn"), N("Short interactive lessons, one rule at a time.")],
  ["journey", N("Journey"), N("48 authored stages with mastery trials.")],
  ["daily", N("Daily"), N("Today's shared seed. Ranked.")],
  ["practice", N("Practice"), N("Relaxed play. Undo available, never ranked.")],
  ["challenge", N("Challenge"), N("Move limits, speed targets, restricted tools.")],
  ["chase", N("Score Chase"), N("Chase the board on a shared validated seed.")],
];
function modesScreen(w: number): void {
  para(T("Choose a mode"), w, "h2", "modes-heading");
  const gw = Math.min(w, 760);
  cardGrid("mode-grid", MODES.length, gw, 210, 12, (i, cw) => {
    const [id, name, desc] = MODES[i]!;
    cardButton(`mode-${id}`, T(name), [T(desc)], cw, () => startMode(id));
  });
  backBtn("title");
}
function journeyScreen(w: number): void {
  const p = profile();
  const unlocked = journeyUnlocked();
  para(T("Journey"), w, "h2", "journey-heading");
  const gw = Math.min(w, 860);
  const stages = Content.JOURNEY_STAGES;
  ui.column("journey-grid", () => {
    for (let ch = 1; ch <= 6; ch++) {
      para(T("Chapter {n}", { n: ch }), gw, "chapter", `chapter-${ch}`);
      const list = stages.map((s, i) => ({ s, i })).filter((x) => x.s.chapter === ch);
      cardGrid(`chapter-${ch}-grid`, list.length, gw, 150, 10, (k, cw) => {
        const { s, i } = list[k]!;
        const rec = p.journey[s.id];
        const sub = s.mastery ? T("Mastery trial") : s.teaches?.length ? T("New: {list}", { list: s.teaches.map((t) => Rules.ACTIONS[t] ? T(Rules.ACTIONS[t]!.label) : T("teach." + t)).join(", ") }) : T("Stage");
        const lines = [sub];
        if (rec) lines.push("★".repeat(rec.stars) + "☆".repeat(3 - rec.stars));
        cardButton(`stage-${s.id}`, `${s.index}. ${T(s.name)}`, lines, cw, () => prepareStage(s.id),
          { style: s.mastery ? "card-mastery" : rec ? "card-done" : "card", disabled: i >= unlocked });
      });
    }
  }, { spacing: 10, width: gw });
  backBtn("modes");
}
function learnScreen(w: number): void {
  const seen = profile().settings.tutorialSeen || {};
  para(T("Lessons"), w, "h2", "learn-heading");
  const lw = Math.min(w, 520);
  ui.column("lesson-list", () => {
    for (const l of Content.LESSONS) {
      cardButton(`lesson-${l.id}`, T(l.title), [seen[l.id] ? T("Completed — replay any time") : T("Not yet completed")], lw, () => startLesson(l.id), { style: seen[l.id] ? "card-done" : "card" });
    }
  }, { spacing: 10, width: lw });
  backBtn("modes");
}
function setupScreen(w: number): void {
  const su = app.setup;
  if (!su) return;
  const cfg = su.cfg;
  para(contentName(cfg.name), w, "h2", "setup-heading");
  const sw = Math.min(w, 620);
  const iw = sw - 42;
  const rulesText = [
    cfg.allowedActions.map((a) => (Rules.ACTIONS[a] ? T(Rules.ACTIONS[a]!.label) : a)).join(", "),
    cfg.tickLimit ? T("{n}-tick limit", { n: cfg.tickLimit }) : T("no time limit"),
    cfg.maxCommands ? T("{n}-move limit", { n: cfg.maxCommands }) : null,
  ].filter(Boolean).join(" · ");
  ui.column("setup-summary", () => {
    if (su.dailyDone !== null) para(T("You already completed today's challenge ({score} pts) — replays are casual.", { score: su.dailyDone }), iw, "muted", "setup-done");
    if (cfg.intro) para(T(cfg.intro), iw, "text", "setup-intro");
    const facts: [string, string | null][] = [
      [T("Rules"), rulesText], [T("Expected length"), T("~{n} min", { n: Math.max(1, Math.round(cfg.tickLimit / 40)) })], [T("Players"), "1"], [T("Result"), null],
    ];
    const kw = Math.max(...facts.map(([k]) => textWidth(k, "dim"))) + 16;
    for (const [i, [k, v]] of facts.entries()) {
      const valueW = iw < 360 ? iw : iw - kw;
      const val = (): void => {
        if (v !== null) para(v, valueW, "text", `setup-fact-${i}`);
        else ui.column("setup-badge", () => ui.style(su.ranked ? "badge-text" : "badge-casual-text").id("ranked-badge").label(su.ranked ? T("Ranked") : T("Casual — not ranked")), { style: su.ranked ? "badge" : "badge-casual" });
      };
      if (iw < 360) ui.column(`setup-row-${i}`, () => { ui.style("dim").label(k); val(); }, { spacing: 2, width: iw });
      else ui.row(`setup-row-${i}`, () => { ui.column(`setup-k-${i}`, () => ui.style("dim").label(k), { width: kw }); ui.column(`setup-v-${i}`, val, { width: valueW }); }, { width: iw, align: "start" });
    }
  }, { style: "setup-summary", width: sw, spacing: 8 });
  if (su.kind) {
    const list = su.kind === "practice" ? Content.PRACTICE_DIFFICULTIES.map((d) => [d.id, d.name] as const) : Content.CHALLENGES.map((c) => [c.id, c.name] as const);
    flow("setup-options", list.map(([id, name]) => ({ id: `choice-${id}`, text: T(name), selected: su.picked === id, act: () => chooseSetup(su.kind!, id) })), Math.min(w, 640), 10);
  }
  ui.column("setup-actions", () => {
    button({ id: "btn-start-session", text: T("Start"), style: "btn-big", act: () => beginSession() });
    backBtn("modes");
  }, { spacing: 12, align: "center" });
}

// ------------------------------------------------------------------ results, board, profile
function resultsScreen(w: number): void {
  const r = app.results;
  if (!r) return;
  para(T("Results"), w, "h2", "results-heading");
  para(resultsHeadline(), w, "headline", "results-headline");
  const tw = Math.min(420, w);
  const rows: [string, string | number][] = [
    [T("Care"), r.score.care], [T("Discoveries"), r.score.discovery], [T("Bond"), r.score.bond], [T("Time bonus"), r.score.timeBonus],
    [T("Invalid actions"), r.score.invalidAttempts], [T("Elapsed"), T("{n} ticks", { n: r.tick })],
  ];
  if (r.stars) rows.push([T("Stars"), "★".repeat(r.stars)]);
  ui.column("results-table", () => {
    rows.forEach(([k, v], i) => ui.row(`res-${i}`, () => {
      ui.column(`res-${i}-k`, () => para(k, tw - 150, "td"), { width: tw - 140 });
      ui.column(`res-${i}-v`, () => ui.style("td-num").id(`res-${i}-n`).label(String(v)), { width: 100, align: "end" });
    }, { style: "row-line", width: tw, spacing: 0, align: "center" }));
    ui.row("res-total", () => {
      ui.column("res-total-k", () => ui.style("td-total").label(T("Total")), { width: tw - 140 });
      ui.column("res-total-v", () => ui.style("td-total-num").id("results-total").label(String(r.score.total)), { width: 100, align: "end" });
    }, { style: "row-total", width: tw, spacing: 0, align: "center" });
  }, { width: tw, spacing: 0 });
  const cmp = r.isBest ? T("New personal best!") : T("Personal best: {n}", { n: r.best });
  button({ id: "results-comparison", text: cmp, name: `${cmp} — ${T("View the leaderboard")}`, act: () => void loadBoard(false) });
  const lb = leaderboardLine();
  if (lb) para(lb, w, "lb", "results-lb");
  if (r.achievements.length) {
    ui.row("results-achievements", () => {
      for (const [i, a] of r.achievements.entries()) ui.column(`ach-${i}`, () => ui.style("chip-text").label("🏅 " + T(a)), { style: "ach-chip" });
    }, { spacing: 8, justify: "center" });
  }
  const btns: Btn[] = [{ id: "btn-retry", text: T("↻ Retry"), act: retry }];
  if (r.hasNext) btns.push({ id: "btn-next", text: T("Next →"), style: "btn-primary", act: next });
  btns.push({ id: "btn-results-modes", text: T("Modes"), act: () => goto("modes") });
  flow("results-actions", btns, Math.min(w, 520), 12);
}
function boardScreen(w: number): void {
  const b = app.board;
  const bw = Math.min(w, 520);
  para(b?.title ?? T("Leaderboard"), w, "h2", "board-heading");
  if (b) para(b.subtitle + (b.friends ? " · " + T("friends only") : ""), w, "muted", "board-subtitle");
  ui.row("board-tabs", () => {
    button({ id: "tab-global", text: T("Global"), selected: !b?.friends, act: () => void loadBoard(false) });
    button({ id: "tab-friends", text: T("Friends"), selected: !!b?.friends, act: () => void loadBoard(true) });
  }, { spacing: 8, role: "radiogroup" });
  ui.column("board-list", () => {
    if (!b || b.entries === null) { para(T("Loading…"), bw, "muted", "board-loading"); return; }
    if (!b.entries.length) { para(T("No scores yet — be the first!"), bw, "text", "board-empty"); return; }
    b.entries.forEach((e, i) => ui.row(`board-${i}`, () => {
      ui.column(`board-${i}-n`, () => para(`${i + 1}. ${e.name}`, bw * 0.5, "td"), { width: bw * 0.5 });
      ui.spacer();
      ui.style("td-num").label(e.ticks ? T("{score} pts · {ticks} ticks", { score: e.score, ticks: e.ticks }) : `${e.score}`);
    }, { style: e.me ? "board-row-me" : "board-row", width: bw, align: "center" }));
  }, { width: bw, spacing: 0 });
  backBtn("title");
}
function profileScreen(w: number): void {
  const p = profile();
  const pw = Math.min(w, 620);
  para(T("Profile"), w, "h2", "profile-heading");
  const stats: [number, string][] = [
    [p.sessionsPlayed, T("sessions played")], [Object.keys(p.journey).length, T("journey stages")],
    [p.discoveries.length, T("interactions discovered")], [Object.keys(p.daily).length, T("daily challenges")],
  ];
  cardGrid("stat-grid", stats.length, pw, 150, 10, (i, cw) => {
    const [n, label] = stats[i]!;
    ui.column(`stat-${i}`, () => { ui.style("stat-num").label(String(n)); para(label, cw - 30, "text"); }, { style: "stat", width: cw, spacing: 2 });
  });
  para(T("Achievements"), pw, "h3", "ach-heading");
  cardGrid("achievement-list", Progress.ACHIEVEMENTS.length, pw, 220, 8, (i, cw) => {
    const a = Progress.ACHIEVEMENTS[i]!;
    const on = !!p.achievements[a.id];
    ui.column(`achv-${a.id}`, () => {
      para(`${on ? "🏅" : "🔒"} ${T(a.name)}`, cw - 38, "card-title");
      para(T(a.desc), cw - 38, "card-sub");
    }, { style: on ? "info-card-on" : "info-card", width: cw, spacing: 4 });
  });
  backBtn("title");
}
