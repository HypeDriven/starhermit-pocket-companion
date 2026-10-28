// The browser build's pure game modules (shared with the node tests), typed
// for this client: the rules (src/rules.js: integer needs, actions, cravings,
// bond, scoring, the seeded streams), the content (src/content.js: themes,
// decor, the 48 Journey stages, lessons, practice, challenges, the Daily and
// Score chase), the session (src/session.js: validated commands, undo, the
// replay envelope, snapshots) and the save model (src/progress.js).
import * as rules from "../src/rules.js";
import * as content from "../src/content.js";
import * as sessionMod from "../src/session.js";
import * as progress from "../src/progress.js";

export type Need = "hunger" | "hygiene" | "fun" | "energy";
export type Needs = Record<Need, number>;
export interface ActionDef { id: string; label: string; kind: string; ticks: number; blurb: string; takesItem?: boolean }
export interface Legal { id: string; label: string; kind: string; legal: boolean; reason: string | null; ticks: number }
export interface Craving { need: Need; expiresTick: number }
export interface LastEvent { action: string; kind: string; careGain: number; bondGain: number; discoveryGain: number; cravingBonus: boolean }
export interface State {
  stageId: string; seed: number; tick: number; commandCount: number; needs: Needs;
  goals: { bondLevel: number; care: number; discoveries: number; decor: number };
  tickLimit: number; maxCommands: number; allowedActions: string[]; allowedDecor: string[];
  bondPoints: number; discovered: string[]; decorPlaced: string[]; craving: Craving | null;
  score: { care: number; discovery: number; bond: number; timeBonus: number };
  invalidAttempts: number; status: "active" | "complete" | "expired" | "neglected"; terminalReason: string | null;
  lastEvent: LastEvent | null;
}
export interface ActResult { ok: boolean; reason?: string; careGain: number; bondGain: number; discoveryGain: number; cravingBonus: boolean; duplicate?: boolean }
export interface Score { care: number; discovery: number; bond: number; timeBonus: number; invalidAttempts: number; total: number }
export interface ContentCfg {
  id: string; name: string; seed: number; theme?: string; intro?: string; chapter?: number; index?: number;
  allowedActions: string[]; allowedDecor: string[]; decay: Needs; goals: { bondLevel?: number; care?: number; discoveries?: number; decor?: number };
  tickLimit: number; maxCommands: number; par: number; mastery?: boolean; teaches?: string[]; dailyKey?: string; stageId?: string;
}
export interface Lesson { id: string; title: string; stageId: string; steps: { text: string; require: { action?: string; invalid?: string; craving?: boolean } }[] }
export interface Theme { id: string; name: string; palette: Record<"floor" | "wall" | "wallAccent" | "rug" | "sky" | "glow" | "key", number> }
export interface Session {
  content: ContentCfg; mode: string; ranked: boolean; undoEnabled: boolean; state: State;
  _undoStack: unknown[];
  readonly legal: Legal[]; readonly score: Score; readonly bondLevel: number; readonly terminal: boolean;
  act(type: string, args?: Record<string, unknown>): ActResult;
  undo(): boolean;
  snapshot(): unknown;
  exportReplay(): unknown;
  markAwayBaseline(): void;
  awaySummary(): { ticks: number; scoreDelta: number } | null;
}
export interface SessionCtor {
  new (cfg: ContentCfg, opts: { mode: string; undo: boolean; ranked: boolean; assists?: string[]; now?: number }): Session;
  restore(cfg: ContentCfg, snapshot: unknown, opts: { mode: string; undo: boolean; ranked: boolean; envelope?: unknown }): { session: Session; away: { ticks: number } };
}

export interface Profile {
  name: string; settings: Record<string, unknown> & { tutorialSeen: Record<string, boolean> };
  journey: Record<string, { stars: number; bestScore: number; completedAt: number }>;
  discoveries: string[]; daily: Record<string, { score: number; completed: boolean }>; dailyDays: string[];
  achievements: Record<string, number>; bestScores: Record<string, number>; sessionsPlayed: number;
}
export interface BoardEntry { name: string; score: number; ticks: number; me?: boolean }
export interface SaveDoc { v: number; profile: Profile; boards: Record<string, BoardEntry[]> }
export interface Options { palette: string; leftHanded: boolean; timingAssist: boolean; haptics: boolean; captions: boolean }
export interface Achievement { id: string; name: string; desc: string }

interface RulesApi {
  NEEDS: Need[]; ACTIONS: Record<string, ActionDef>; INVALID_REASONS: Record<string, string>; BOND_LEVELS: number[];
  makeRng(seed: number): { next(): number; range(n: number): number; state: number };
  fnv1a(s: string): number;
  moodOf(state: State): string;
}
interface ContentApi {
  THEMES: Theme[]; DEFAULT_THEME: string; DECOR_ITEMS: { id: string; name: string; slot: string }[];
  JOURNEY_STAGES: ContentCfg[]; LESSONS: Lesson[]; PRACTICE_DIFFICULTIES: { id: string; name: string }[];
  CHALLENGES: { id: string; name: string; blurb: string }[];
  getStage(id: string): ContentCfg | null; getLesson(id: string): Lesson | null;
  practiceConfig(id: string, seed: number): ContentCfg; challengeConfig(id: string): ContentCfg | null;
  dailyConfig(key: string): ContentCfg; scoreChaseConfig(seed: number): ContentCfg; dailyKeyFor(d: Date): string;
}
interface ProgressApi {
  ACHIEVEMENTS: Achievement[]; DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[]; BROWSER_KEYS: string[]; PALETTES: string[];
  pickOptions(raw: unknown): Partial<Options>;
  defaultSave(): SaveDoc; normalize(raw: unknown): SaveDoc; sameSave(a: unknown, b: unknown): boolean;
  mergeSave(remote: unknown, local: unknown, opts?: { keepLocalSettings?: boolean }): SaveDoc;
  readForeign(text: string): { save: SaveDoc; options: Partial<Options> } | null;
  submitLocalScore(doc: SaveDoc, id: string, e: BoardEntry): BoardEntry[]; getLocalBoard(doc: SaveDoc, id: string): BoardEntry[];
  recordDiscovery(p: Profile, id: string): boolean;
  evaluateAchievements(p: Profile, s: { state: State; bondLevel: number; cfg: ContentCfg }, now: number): string[];
  recordResult(p: Profile, r: { mode: string; cfg: ContentCfg; state: State; total: number; now: number }): { stars: number; best: number; isBest: boolean };
  journeyUnlockedCount(p: Profile, stages: ContentCfg[]): number;
}

export const Rules = rules as unknown as RulesApi;
export const Content = content as unknown as ContentApi;
export const Progress = progress as unknown as ProgressApi;
export const SessionClass = (sessionMod as unknown as { Session: SessionCtor }).Session;
