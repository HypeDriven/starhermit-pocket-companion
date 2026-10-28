// Pocket Companion on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (src/rules.js), content
// (src/content.js) and session (src/session.js: validated commands, undo,
// the replay envelope, snapshots) are the browser build's, unchanged; this
// module is what src/main.js and src/ui.js did around them — the state
// machine (title → modes / journey / lessons / setup → the room ⇄ pause,
// settings, help, decorations → results → progression), every mode (Learn,
// Journey, Daily, Practice, Challenge, Score chase), the action tray and
// keys, tapping Mote, hints, undo, lessons, cravings, the results with the
// local board and the high-score post, the resumable session snapshot and
// the lifecycle (a hidden window pauses the session, as visibilitychange
// did). Screens are drawn by screens.ts (starhermit:ui), the room by
// render.ts (starhermit:scene).
//
// The game is turn-based: needs drain per rules tick and ticks pass only
// when the player acts, so nothing advances in real time or while away
// (the old "while you were away" summary reports the ticks a restored or
// paused session already had). Dates (the Daily's UTC day, the Score chase
// seed) and timestamps come from the platform's clock (serverNow), with the
// device's clock until it answers. Toasts, captions and floating numbers run
// on the runtime's fixed steps, so play scripts replay exactly.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { Content, Progress, Rules, SessionClass, type ContentCfg, type Lesson, type Session, type State } from "./game.ts";
import * as audio from "./audio.ts";
import { S, T, contentName } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type ScreenName = "title" | "modes" | "journey" | "learn" | "setup" | "game" | "results" | "board" | "profile";
export type OverlayName = "pause" | "settings" | "help" | "decor";
export interface SetupView { cfg: ContentCfg; ranked: boolean; dailyDone: number | null; kind: "practice" | "challenge" | null; picked: string | null }
export interface ResultsView {
  completed: boolean; status: string; score: { care: number; discovery: number; bond: number; timeBonus: number; invalidAttempts: number; total: number };
  tick: number; stars: number; best: number; isBest: boolean; achievements: string[]; hasNext: boolean;
}
export interface BoardView { title: string; subtitle: string; friends: boolean; entries: { name: string; score: number; ticks: number; me?: boolean }[] | null }

const NEED_BEST_ACTION: Record<string, string[]> = {
  hunger: ["feed", "snack"], hygiene: ["wash"], fun: ["play", "toss", "sing", "pet"], energy: ["rest"],
};

export const app = {
  screen: "title" as ScreenName,
  /** Open sheets, the top one shown (settings and help open over the pause sheet). */
  overlays: [] as OverlayName[],
  openedFrame: 0,
  screenFrame: 0,
  focusNext: null as string | null,
  /** boot → profile-ready → preparing → active ↔ paused → results (main.js machine). */
  machine: "profile-ready" as "profile-ready" | "preparing" | "active" | "paused" | "results",
  session: null as Session | null,
  mode: "practice",
  setup: null as SetupView | null,
  lastSetup: null as { cfg: ContentCfg; mode: string } | null,
  lesson: null as Lesson | null,
  lessonStep: 0,
  results: null as ResultsView | null,
  lb: null as platform.Posted | "posting" | null,
  board: null as BoardView | null,
  boardContext: null as { boardId: string; friends: boolean } | null,
  suggested: null as string | null,
  hover: null as string | null,
  toasts: [] as { text: string; until: number }[],
  caption: null as { text: string; until: number } | null,
  floats: [] as { text: string; x: number; y: number; at: number }[],
  resume: null as platform.Snapshot | null,
  cravingAnnounced: false,
};
let clockMs = 0;
/** Seconds on the fixed-step clock. */
export const now = (): number => clockMs / 1000;
export const fresh = (): boolean => frame().frame !== app.openedFrame;
export const topOverlay = (): OverlayName | null => app.overlays[app.overlays.length - 1] ?? null;

// ------------------------------------------------------------------ helpers
export function announce(text: string, assertive = false): void {
  if (text) ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
export function toast(text: string): void {
  app.toasts.push({ text, until: now() + 3.2 });
  if (app.toasts.length > 4) app.toasts.shift();
}
function haptic(ms: number): void { if (platform.options.haptics) { try { vibrate(ms); } catch { /* no motor */ } } }
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
export const dailyKey = (): string => Content.dailyKeyFor(new Date(platform.nowMs()));
export const profile = () => platform.save().profile;

// ------------------------------------------------------------------ screens and overlays
export function showScreen(name: ScreenName): void {
  app.screen = name;
  app.openedFrame = app.screenFrame = frame().frame;
  app.toasts = [];
  ui.setFocus(null);
  render.setActive(name === "game");
}
export function goto(where: ScreenName): void {
  audio.event("ui-open");
  if (where === "board") { void loadBoard(app.boardContext?.friends ?? false); return; }
  showScreen(where);
  app.focusNext = where === "title" ? "btn-play" : null;
}
export function openOverlay(name: OverlayName): void {
  if (app.overlays.includes(name)) return;
  app.overlays.push(name);
  app.openedFrame = frame().frame;
  announce(T("overlay." + name));
}
/** Closes the top sheet (closing the pause sheet resumes). */
export function closeOverlay(): void {
  const top = app.overlays.pop();
  app.openedFrame = frame().frame;
  if (top === "pause") resume();
}
/** Escape / the pause key over sheets: every sheet closes and a paused session resumes. */
export function closeAllOverlays(): void {
  const wasPaused = app.overlays.includes("pause");
  app.overlays = [];
  app.openedFrame = frame().frame;
  if (wasPaused) resume();
}

// ------------------------------------------------------------------ title, modes, setup
export function journeyUnlocked(): number { return Progress.journeyUnlockedCount(profile(), Content.JOURNEY_STAGES); }
const isRankable = (): boolean => !platform.options.timingAssist;
export function startMode(mode: string): void {
  audio.event("ui-open");
  app.mode = mode;
  if (mode === "learn") { showScreen("learn"); return; }
  if (mode === "journey") { showScreen("journey"); return; }
  if (mode === "daily") {
    const cfg = Content.dailyConfig(dailyKey());
    const done = profile().daily[cfg.dailyKey!];
    prepare(cfg, isRankable() && !done, done ? done.score : null, null, null);
  } else if (mode === "practice") {
    prepare(Content.practiceConfig("steady", randomSeed()), false, null, "practice", "steady");
  } else if (mode === "challenge") {
    const first = Content.CHALLENGES[0]!.id;
    prepare(Content.challengeConfig(first)!, isRankable(), null, "challenge", first);
  } else if (mode === "chase") {
    prepare(Content.scoreChaseConfig(Rules.fnv1a("chase:" + dailyKey()) >>> 0), isRankable(), null, null, null);
  }
}
const randomSeed = (): number => (Math.random() * 0xffffffff) >>> 0;
function prepare(cfg: ContentCfg, ranked: boolean, dailyDone: number | null, kind: SetupView["kind"], picked: string | null): void {
  app.setup = { cfg, ranked, dailyDone, kind, picked };
  showScreen("setup");
  app.machine = "preparing";
}
/** A practice difficulty or challenge chosen on the setup screen. */
export function chooseSetup(kind: "practice" | "challenge", id: string): void {
  const cfg = kind === "practice" ? Content.practiceConfig(id, randomSeed()) : Content.challengeConfig(id)!;
  app.setup = { cfg, ranked: kind === "challenge" && isRankable(), dailyDone: null, kind, picked: id };
}
export function prepareStage(stageId: string): void {
  const cfg = Content.getStage(stageId);
  if (!cfg) return;
  app.mode = "journey";
  prepare(cfg, false, null, null, null);
}
export function startLesson(lessonId: string): void {
  const lesson = Content.getLesson(lessonId);
  if (!lesson) return;
  app.lesson = lesson;
  app.lessonStep = 0;
  app.mode = "learn";
  beginSession(Content.getStage(lesson.stageId)!);
}

// ------------------------------------------------------------------ session lifecycle
export function beginSession(cfgIn?: ContentCfg): void {
  const src = cfgIn ?? app.setup?.cfg;
  if (!src) return;
  const cfg = JSON.parse(JSON.stringify(src)) as ContentCfg; // detach
  const assists: string[] = [];
  if (platform.options.timingAssist) {
    for (const k of Object.keys(cfg.decay) as (keyof typeof cfg.decay)[]) cfg.decay[k] = Math.max(1, Math.round(cfg.decay[k] / 2));
    assists.push("timing-assist");
  }
  const undo = app.mode === "practice" || app.mode === "learn";
  const dailyDone = app.mode === "daily" && !!cfg.dailyKey && !!profile().daily[cfg.dailyKey];
  const ranked = isRankable() && !dailyDone && (app.mode === "daily" || app.mode === "challenge" || app.mode === "chase");
  if (app.mode !== "learn") app.lesson = null;
  app.session = new SessionClass(cfg, { mode: app.mode, undo, ranked, assists, now: platform.nowMs() });
  app.lastSetup = { cfg: src, mode: app.mode };
  platform.clearSnapshot();
  app.resume = null;
  enterPlayfield(cfg);
}
function enterPlayfield(cfg: ContentCfg): void {
  const s = app.session!;
  app.machine = "active";
  app.overlays = [];
  app.suggested = null;
  app.hover = null;
  app.floats = [];
  app.cravingAnnounced = false;
  showScreen("game");
  render.setTheme(cfg.theme || Content.DEFAULT_THEME, cfg.seed);
  render.setDecor(s.state.decorPlaced);
  render.setMood(Rules.moodOf(s.state));
  saveSnapshot();
  announce(T("{name}. {objective}. Session started.", { name: contentName(cfg.name), objective: objectiveText(cfg) }), true);
  if (app.lesson) showLessonStep();
}

// ------------------------------------------------------------------ actions
let resolving = false;
export function act(type: string, args: Record<string, unknown> = {}): void {
  const s = app.session;
  if (!s || app.machine !== "active" || resolving || !type) return;
  resolving = true; // input locked during the shortest resolution phase
  const prevBond = s.bondLevel;
  const result = s.act(type, args);
  const st = s.state;
  if (!result.ok) {
    audio.event("invalid");
    render.invalidWobble();
    const reason = T(Rules.INVALID_REASONS[result.reason ?? ""] ?? "Not possible right now.");
    announce(reason, true);
    toast(reason);
    haptic(30);
    lessonProgress(type, result.ok, false); // lessons may require a refusal
    afterAction(st);
    resolving = false;
    return;
  }
  audio.event(st.lastEvent?.action ?? type);
  if (result.discoveryGain > 0) {
    audio.event("discovery");
    const label = Rules.ACTIONS[type] ? T(Rules.ACTIONS[type]!.label) : type;
    toast(T("Discovered: {action}! +{n}", { action: label, n: result.discoveryGain }));
    Progress.recordDiscovery(profile(), type);
    if (type === "decorate" && args.item) Progress.recordDiscovery(profile(), "decor:" + String(args.item));
    platform.persist();
  }
  if (result.cravingBonus) audio.event("craving-met");
  const newBond = s.bondLevel;
  if (newBond > prevBond) {
    audio.event("bond-up");
    toast(T("Bond level {n}!", { n: newBond }));
    announce(T("Bond level up — level {n}.", { n: newBond }));
  }
  render.react(st.lastEvent?.action ?? type, Rules.ACTIONS[type]?.kind ?? "pass", { discovery: result.discoveryGain > 0, cravingMet: result.cravingBonus });
  render.setMood(Rules.moodOf(st));
  if (type === "decorate") render.setDecor(st.decorPlaced);
  const gain = result.careGain + result.discoveryGain;
  if (gain > 0) floatText(`+${gain}`);
  haptic(12);
  lessonProgress(type, true, result.cravingBonus);
  afterAction(st);
  if (s.terminal) finishSession();
  resolving = false;
}
function floatText(text: string): void {
  const p = render.creatureAnchor();
  if (p) app.floats.push({ text, x: p.x, y: p.y, at: now() });
}
function afterAction(st: State): void {
  saveSnapshot();
  if (st.craving && !app.cravingAnnounced) {
    app.cravingAnnounced = true;
    audio.event("craving");
    const n = st.craving.need;
    announce(n === "hunger" ? T("Mote is hungry.") : n === "hygiene" ? T("Mote wants a bath.") : n === "fun" ? T("Mote wants to play.") : T("Mote is sleepy."));
  } else if (!st.craving) app.cravingAnnounced = false;
}
/** Tapping Mote performs a contextual pet when legal; otherwise Mote still answers the touch. */
export function creatureTapped(): void {
  const s = app.session;
  if (!s) return;
  if (app.machine === "active" && s.legal.some((a) => a.id === "pet" && a.legal)) act("pet");
  else {
    render.react("pet", "ack");
    audio.event("ack");
    announce(T("Mote wiggles happily."));
  }
}
/** A tray slot: decorate opens the drawer, every other action acts. */
export function trayAction(id: string): void {
  if (id === "decorate") openDecor();
  else act(id);
}
export function openDecor(): void {
  if (!app.session || app.machine !== "active") return;
  openOverlay("decor");
}
export function decorate(item: string): void { act("decorate", { item }); }
export function undo(): void {
  const s = app.session;
  if (!s || !s.undoEnabled) return;
  if (app.machine !== "active" && app.machine !== "paused") return;
  if (s.undo()) {
    audio.event("ui-close");
    toast(T("Undone"));
    afterAction(s.state);
    render.setMood(Rules.moodOf(s.state));
    render.setDecor(s.state.decorPlaced);
  } else announce(T("Nothing to undo."));
}
/** Hints use the same legal-action API as play: the craving's best action, else the lowest need's. */
export function hint(): void {
  const s = app.session;
  if (!s || app.machine !== "active") return;
  const legal = s.legal;
  const st = s.state;
  const ok = (id: string): boolean => legal.some((a) => a.id === id && a.legal);
  let suggestion: string | null = null;
  if (st.craving) suggestion = NEED_BEST_ACTION[st.craving.need]!.find(ok) ?? null;
  if (!suggestion) {
    const lowest = [...Rules.NEEDS].sort((a, b) => st.needs[a] - st.needs[b])[0]!;
    suggestion = NEED_BEST_ACTION[lowest]!.find(ok) ?? null;
  }
  if (!suggestion) suggestion = legal.find((a) => a.legal && a.kind !== "pass")?.id ?? legal.find((a) => a.legal)?.id ?? null;
  app.suggested = suggestion;
  if (suggestion) {
    const def = Rules.ACTIONS[suggestion]!;
    announce(T("Hint: try {action}. {blurb}", { action: T(def.label), blurb: T(def.blurb) }));
    toast(T("Hint: {action}", { action: T(def.label) }));
  }
}
export function camera(): void { if (app.session) toast(T("Camera recentered")); }

// ------------------------------------------------------------------ pause / leave
export function pause(): void {
  if (!app.session || app.machine !== "active") return;
  app.machine = "paused";
  app.session.markAwayBaseline();
  app.overlays = ["pause"];
  app.openedFrame = frame().frame;
  app.focusNext = "btn-resume";
  audio.event("ui-open");
  announce(T("overlay.pause"));
}
function resume(): void {
  if (app.machine !== "paused" || !app.session) return;
  app.machine = "active";
  app.overlays = app.overlays.filter((o) => o !== "pause");
  const away = app.session.awaySummary();
  if (away && away.ticks > 0) toast(T("While paused: {n} ticks, {score} pts", { n: away.ticks, score: away.scoreDelta }));
  audio.event("ui-close");
  ui.setFocus(null);
}
export function resumeFromSheet(): void { app.overlays = app.overlays.filter((o) => o !== "pause"); app.openedFrame = frame().frame; resume(); }
export function leave(): void {
  app.overlays = [];
  endPlayfield();
  // the left session's last safe snapshot stays: the title offers it again (the browser build did after a reload)
  app.resume = platform.loadSnapshot();
  goto("modes");
}
function endPlayfield(): void {
  app.lesson = null;
  app.session = null;
  app.machine = "profile-ready";
}
export function retry(): void {
  if (!app.lastSetup) { goto("modes"); return; }
  app.mode = app.lastSetup.mode;
  if (app.mode === "learn" && app.lesson === null) app.mode = "journey";
  beginSession(app.lastSetup.cfg);
}
export function next(): void {
  if (app.lastSetup?.mode === "journey") {
    const stages = Content.JOURNEY_STAGES;
    const idx = stages.findIndex((s) => s.id === app.lastSetup!.cfg.id);
    const nxt = stages[idx + 1];
    if (nxt && idx + 1 < journeyUnlocked()) { app.mode = "journey"; beginSession(nxt); return; }
  }
  goto("modes");
}

// ------------------------------------------------------------------ lessons
function showLessonStep(): void {
  const step = app.lesson?.steps[app.lessonStep];
  if (step) announce(`${T(app.lesson!.title)} — ${T(step.text).replace(/\*\*/g, "")}`);
}
function lessonProgress(type: string, ok: boolean, cravingMet: boolean): void {
  const lesson = app.lesson;
  if (!lesson || app.machine !== "active") return;
  const step = lesson.steps[app.lessonStep];
  if (!step) return;
  let done = false;
  if (step.require.action && ok && type === step.require.action) done = true;
  if (step.require.invalid && !ok && type === step.require.invalid) done = true;
  if (step.require.craving && cravingMet) done = true;
  if (!done) return;
  app.lessonStep++;
  audio.event("ack");
  if (app.lessonStep >= lesson.steps.length) {
    profile().settings.tutorialSeen[lesson.id] = true;
    platform.persist();
    toast(T("Lesson complete! Finish the stage to keep going."));
    announce(T("Lesson complete. You can finish the stage now."));
    app.lesson = null;
  } else showLessonStep();
}

// ------------------------------------------------------------------ results & progression
function finishSession(): void {
  const s = app.session!;
  app.machine = "results";
  const st = s.state;
  const score = s.score;
  const cfg = s.content;
  const p = profile();
  const completed = st.status === "complete";
  audio.event(completed ? "complete" : st.status === "neglected" ? "neglected" : "expired");
  haptic(140);
  const t = platform.nowMs();
  const rec = Progress.recordResult(p, { mode: app.mode, cfg, state: st, total: score.total, now: t });
  const newAch = Progress.evaluateAchievements(p, { state: st, bondLevel: s.bondLevel, cfg }, t);
  const boardId = app.mode === "daily" ? `daily:${cfg.dailyKey}` : app.mode === "chase" ? `chase:${cfg.seed}` : `stage:${cfg.id}`;
  Progress.submitLocalScore(platform.save(), boardId, { name: p.name, score: score.total, ticks: st.tick, me: true });
  platform.persist();
  platform.clearSnapshot();
  app.boardContext = { boardId, friends: false };
  app.results = {
    completed, status: st.status, score, tick: st.tick, stars: rec.stars, best: rec.best, isBest: rec.isBest,
    achievements: newAch.map((id) => Progress.ACHIEVEMENTS.find((a) => a.id === id)?.name ?? id),
    hasNext: app.mode === "journey" && completed,
  };
  showScreen("results");
  app.focusNext = app.results.hasNext ? "btn-next" : "btn-retry";
  announce(T("Session over. {headline}. Total score {total}.", { headline: resultsHeadline(), total: score.total }), true);
  postToLeaderboard(s.ranked ? Math.max(0, score.total) : null);
}
export function resultsHeadline(): string {
  const r = app.results;
  if (!r) return "";
  return r.completed ? T("Session complete — Mote is thriving!") : r.status === "neglected" ? T("Mote got overwhelmed — but nothing is lost. Try again!") : T("Time is up — good effort!");
}
function postToLeaderboard(total: number | null): void {
  app.lb = null;
  if (total == null || !platform.signedIn()) return;
  const session = app.session;
  app.lb = "posting";
  void platform.postScore(total).then((r) => { if (app.session === session) app.lb = r; });
}
export function leaderboardLine(): string | null {
  const lb = app.lb;
  if (!lb) return null;
  if (lb === "posting") return S("lbPosting");
  return !lb.posted ? S("lbNotPosted") : lb.rank ? S("lbRank", { rank: lb.rank }) : S("lbPosted");
}
/** The leaderboard screen: the platform's board when signed in, else the local casual board. */
export async function loadBoard(friends: boolean): Promise<void> {
  if (!app.boardContext) app.boardContext = { boardId: `daily:${dailyKey()}`, friends: false };
  app.boardContext.friends = friends;
  const { boardId } = app.boardContext;
  const local = (): BoardView["entries"] => Progress.getLocalBoard(platform.save(), boardId);
  if (app.screen !== "board") showScreen("board");
  if (platform.signedIn()) {
    app.board = { title: T("Leaderboard — global"), subtitle: T("Platform board · read-only"), friends, entries: null };
    const entries = await platform.hostedBoard(friends);
    app.board = entries
      ? { title: T("Leaderboard — global"), subtitle: T("Platform board · read-only"), friends, entries: entries.map((e) => ({ name: e.name || "Player", score: e.score, ticks: 0, me: e.me })) }
      : { title: T("Leaderboard — global"), subtitle: T("Casual local board"), friends, entries: local() };
  } else {
    app.board = { title: T("Leaderboard — {board}", { board: T("board." + boardId.split(":")[0]) }), subtitle: T("Casual local board"), friends, entries: local() };
  }
}

// ------------------------------------------------------------------ resume (last safe snapshot)
function findContent(id: string): ContentCfg | null {
  return Content.getStage(id) || Content.challengeConfig(id) ||
    (id.startsWith("daily-") ? Content.dailyConfig(id.slice(6)) : null) ||
    (id.startsWith("practice-") ? Content.practiceConfig(id.slice(9), 1) : null) ||
    (id.startsWith("chase-") ? Content.scoreChaseConfig(Number(id.slice(6))) : null);
}
export function resumeName(): string | null {
  const snap = app.resume;
  if (!snap) return null;
  const cfg = findContent(snap.contentId);
  return cfg ? T("{name} · tick {n}", { name: contentName(cfg.name), n: (snap.snapshot as { tick?: number }).tick ?? 0 }) : null;
}
export function resumeSession(): void {
  const snap = app.resume;
  app.resume = null;
  if (!snap) return;
  const cfg = findContent(snap.contentId);
  if (!cfg) { platform.clearSnapshot(); return; }
  try {
    const dailyDone = snap.mode === "daily" && !!cfg.dailyKey && !!profile().daily[cfg.dailyKey];
    const { session, away } = SessionClass.restore(cfg, snap.snapshot, {
      mode: snap.mode, envelope: snap.envelope, undo: snap.mode === "practice" || snap.mode === "learn",
      ranked: isRankable() && !dailyDone && (snap.mode === "daily" || snap.mode === "challenge" || snap.mode === "chase"),
    });
    app.session = session;
    app.mode = snap.mode;
    app.lesson = null;
    app.lastSetup = { cfg, mode: snap.mode };
    enterPlayfield(cfg);
    toast(T("Welcome back — {n} ticks passed while you were away", { n: away.ticks }));
    announce(T("Session resumed. {n} ticks passed while you were away.", { n: away.ticks }));
  } catch (e) {
    console.warn(`resume: ${String(e)}`);
    platform.clearSnapshot();
  }
}
function saveSnapshot(): void {
  const s = app.session;
  if (!s || s.terminal) return;
  platform.saveSnapshot({ contentId: s.content.id, mode: app.mode, snapshot: s.snapshot(), envelope: s.exportReplay() });
}

// ------------------------------------------------------------------ text helpers
export function objectiveText(cfg: ContentCfg): string {
  const g = cfg.goals || {};
  const parts: string[] = [];
  if (g.bondLevel) parts.push(T("reach Bond level {n}", { n: g.bondLevel }));
  if (g.care) parts.push(T("earn {n} care points", { n: g.care }));
  if (g.discoveries) parts.push(T("make {n} discoveries", { n: g.discoveries }));
  if (g.decor) parts.push(T("place {n} decorations", { n: g.decor }));
  return parts.length ? T("Objective: {goals}", { goals: parts.join(T(" and ")) }) : T("Keep Mote happy");
}
export function objectiveProgress(s: Session): string {
  const st = s.state, g = s.content.goals || {};
  const prog: string[] = [];
  if (g.bondLevel) prog.push(T("Bond {n}/{total}", { n: s.bondLevel, total: g.bondLevel }));
  if (g.care) prog.push(T("Care {n}/{total}", { n: s.score.care, total: g.care }));
  if (g.discoveries) prog.push(T("Found {n}/{total}", { n: st.discovered.length, total: g.discoveries }));
  if (g.decor) prog.push(T("Decor {n}/{total}", { n: st.decorPlaced.length, total: g.decor }));
  return prog.join(" · ") || T("{n} ticks left", { n: st.tickLimit - st.tick });
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(S("inviteCopied")); } catch { toast(S("inviteFailed", { link })); }
}
/** The guest name (local boards); signed in, the account's name wins. */
export function setGuestName(name: string): void {
  if (platform.signedIn()) return;
  profile().name = name.slice(0, 24) || "Guest";
  platform.persist();
}
export function displayName(): string {
  if (platform.signedIn()) return platform.displayName() || T("Guest");
  const n = profile().name;
  return !n || n === "Guest" ? T("Guest") : n;
}

// ------------------------------------------------------------------ keys and pads (ui.js keydown)
/** Tray slot n (1–10) → the session's nth allowed action. */
function slotAction(n: number): string | null {
  const s = app.session;
  return s ? s.state.allowedActions[n - 1] ?? null : null;
}
onAction((e) => {
  if (!e.pressed) return;
  const a = e.action;
  if (ui.capturingKeys()) return;
  if (a === "pause") {
    if (!fresh()) return;
    if (app.overlays.length) later(closeAllOverlays);
    else if (app.screen === "game") later(pause);
    return;
  }
  if (app.overlays.length || app.screen !== "game") return;
  const m = /^slot(\d+)$/.exec(a);
  if (m) {
    const id = slotAction(Number(m[1]));
    if (id) later(() => trayAction(id));
    return;
  }
  if (a === "hint") later(hint);
  else if (a === "undo") later(undo);
  else if (a === "camera") later(camera);
});

// ------------------------------------------------------------------ tapping Mote
/** The room's view (the old canvas) in window pixels, set by screens.ts. */
export const view: render.Rect = { x: 0, y: 0, width: 0, height: 0 };
/** Rectangles (window pixels) where a press belongs to the UI, set by screens.ts each frame. */
export const hudRects: render.Rect[] = [];
const presses: { x: number; y: number }[] = [];
let lastTouch = -1e9;
onTouch((e) => {
  lastTouch = now();
  if (!e.control && e.phase === "start") presses.push({ x: e.x, y: e.y });
});
onPointerButton((e) => {
  if (e.button !== 0 || !e.pressed || now() - lastTouch < 0.6) return;
  presses.push({ x: e.x, y: e.y });
});
const inside = (r: render.Rect, x: number, y: number): boolean => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height;
function pointerInput(wasPlaying: boolean): void {
  const list = presses.splice(0);
  // a press that closed a sheet this frame belongs to that widget, not the room
  if (!wasPlaying || app.screen !== "game" || app.overlays.length || !app.session) return;
  for (const p of list) {
    if (!inside(view, p.x, p.y) || hudRects.some((r) => inside(r, p.x, p.y))) continue;
    if (render.hitsCreature(p.x, p.y)) creatureTapped();
  }
}

// ------------------------------------------------------------------ the clock and the frame
let hidden = false;
onFixedUpdate(() => {
  if (hidden) return;
  clockMs += 1000 / 60;
});
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  audio.setCaptionHandler((key) => { if (platform.options.captions) app.caption = { text: "♪ " + T(key), until: now() + 2.2 }; });
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  render.setTheme(Content.DEFAULT_THEME, 1);
  showScreen("title");
  app.focusNext = "btn-play";
  const snap = platform.loadSnapshot();
  if (snap && findContent(snap.contentId)) app.resume = snap;
  else if (snap) platform.clearSnapshot();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onProgressMerged(() => toast(T("Progress synced from your account")));
onSessionEnded(() => toast(S("signedOut")));
onSuspend(() => {
  hidden = true;
  // Backgrounding pauses solo play (the player resumes from the pause sheet).
  if (app.machine === "active") pause();
  audio.setSuspended(true);
  platform.flush();
});
onResume(() => { hidden = false; audio.setSuspended(false); });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(platform.options.palette, ui.preferences().highContrast);
  audio.update();
  const t = now();
  app.toasts = app.toasts.filter((x) => x.until >= t);
  if (app.caption && app.caption.until < t) app.caption = null;
  app.floats = app.floats.filter((f) => t - f.at < 1.1);
});
onRender(() => {
  hudRects.length = 0;
  const wasPlaying = app.screen === "game" && !app.overlays.length;
  // the hover/focus highlight on Mote follows the tray (set by screens.ts while it builds)
  app.hover = null;
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput(wasPlaying);
  const legal = app.hover && app.session ? app.session.legal.find((x) => x.id === app.hover) : null;
  render.setHighlight(legal ? legal.legal : null);
  const f = frame();
  render.update(frameDt, f.width, f.height, view);
});
