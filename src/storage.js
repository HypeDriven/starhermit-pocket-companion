/**
 * Pocket Companion — persistence: versioned, checksummed local saves,
 * settings, progression, achievements, and local (casual) leaderboards.
 * Never stores credentials or tokens.
 */
import { fnv1a } from './rules.js';

export const SAVE_VERSION = 2;
const KEY_PROFILE = 'pocket-companion:profile';
const KEY_SESSION = 'pocket-companion:last-session';
const KEY_LOCAL_BOARDS = 'pocket-companion:boards';

export const DEFAULT_SETTINGS = {
  music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.7,
  graphicsTier: 'auto',       // auto | low | medium | high
  reducedMotion: false,
  highContrast: false,
  palette: 'default',         // default | deuteranopia | protanopia | tritanopia
  largeText: false,
  leftHanded: false,
  holdToRepeat: false,
  timingAssist: false,        // assist flag — sessions with it are unranked
  haptics: true,
  captions: true,
  cameraShake: true,
  tutorialSeen: {},
  keybinds: null,             // player overrides for desktop bindings
  telemetryConsent: false,
};

export const ACHIEVEMENTS = [
  { id: 'first-light', name: 'First Light', desc: 'Complete your first session.' },
  { id: 'full-pantry', name: 'Full Pantry', desc: 'Discover every care interaction in one session.' },
  { id: 'deep-bond', name: 'Deep Bond', desc: 'Reach Bond level 5 in any session.' },
  { id: 'streak-three', name: 'Three Suns', desc: 'Complete the daily challenge on 3 different days.' },
  { id: 'mastery-trial', name: 'Trial Keeper', desc: 'Complete any mastery stage in the Journey.' },
  { id: 'room-of-ones-own', name: 'A Room of One\'s Own', desc: 'Place 5 decorations in one session.' },
  { id: 'gentle-hands', name: 'Gentle Hands', desc: 'Complete a session with zero invalid actions.' },
  { id: 'old-friends', name: 'Old Friends', desc: 'Reach Bond level 6. A long-term promise.' },
];

const DEFAULT_PROFILE = {
  v: SAVE_VERSION,
  name: 'Guest',
  createdAt: 0,
  settings: { ...DEFAULT_SETTINGS },
  journey: {},              // stageId -> {stars, bestScore, completedAt}
  lessonsDone: {},
  discoveries: [],          // action ids ever discovered (profile-wide)
  decorUnlocked: [],        // decor ids earned through play
  daily: {},                // dayKey -> {score, completed}
  dailyDays: [],            // distinct day keys completed (for streak)
  achievements: {},         // id -> unlockedAt
  bestScores: {},           // stageId -> total
  sessionsPlayed: 0,
  lastTheme: 'hearthwood',
};

function checksum(obj) {
  return fnv1a(JSON.stringify(obj)).toString(16).padStart(8, '0');
}

function storageAvailable() {
  try {
    const k = '__pc_test';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch { return false; }
}

export class Store {
  constructor() {
    this.available = typeof localStorage !== 'undefined' && storageAvailable();
    this._mem = new Map(); // fallback when storage is blocked
    this.onSaved = null;   // cloud-mirror hook (wired by the platform adapter)
    this.profile = this.loadProfile();
  }

  _get(key) {
    if (this.available) return localStorage.getItem(key);
    return this._mem.get(key) ?? null;
  }
  _set(key, value) {
    if (this.available) localStorage.setItem(key, value);
    else this._mem.set(key, value);
  }

  loadProfile() {
    const raw = this._get(KEY_PROFILE);
    if (!raw) return structuredClone(DEFAULT_PROFILE);
    try {
      const wrapped = JSON.parse(raw);
      if (checksum(wrapped.data) !== wrapped.checksum) {
        console.warn('[store] profile checksum mismatch — starting fresh, preserving a backup');
        this._set(KEY_PROFILE + ':backup', raw);
        return structuredClone(DEFAULT_PROFILE);
      }
      return migrateProfile(wrapped.data);
    } catch {
      return structuredClone(DEFAULT_PROFILE);
    }
  }

  saveProfile() {
    const data = this.profile;
    data.v = SAVE_VERSION;
    this._set(KEY_PROFILE, JSON.stringify({ data, checksum: checksum(data) }));
    this.onSaved?.();
  }

  /** Preserve the current local doc before a remote cloud doc replaces it. */
  backupProfile() {
    const raw = this._get(KEY_PROFILE);
    if (raw) this._set(KEY_PROFILE + ':pre-cloud', raw);
  }

  /** Last safe local snapshot (crash recovery). */
  saveSessionSnapshot(payload) { this._set(KEY_SESSION, JSON.stringify(payload)); }
  loadSessionSnapshot() {
    try { const raw = this._get(KEY_SESSION); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }
  clearSessionSnapshot() { this._set(KEY_SESSION, ''); }

  /** Local casual leaderboard (used when no host validation is available). */
  submitLocalScore(boardId, entry) {
    let boards = {};
    try { boards = JSON.parse(this._get(KEY_LOCAL_BOARDS) || '{}'); } catch { boards = {}; }
    const list = boards[boardId] || [];
    list.push(entry);
    list.sort((a, b) => b.score - a.score || a.ticks - b.ticks);
    boards[boardId] = list.slice(0, 50);
    this._set(KEY_LOCAL_BOARDS, JSON.stringify(boards));
    return boards[boardId];
  }
  getLocalBoard(boardId) {
    try { return (JSON.parse(this._get(KEY_LOCAL_BOARDS) || '{}'))[boardId] || []; }
    catch { return []; }
  }
  allBoards() {
    try { return JSON.parse(this._get(KEY_LOCAL_BOARDS) || '{}'); }
    catch { return {}; }
  }
  replaceBoards(boards) { this._set(KEY_LOCAL_BOARDS, JSON.stringify(boards || {})); }

  /** Idempotent achievement unlock; returns true on first unlock. */
  unlockAchievement(id) {
    if (!ACHIEVEMENTS.some((a) => a.id === id)) return false;
    if (this.profile.achievements[id]) return false;
    this.profile.achievements[id] = Date.now();
    this.saveProfile();
    return true;
  }

  recordDiscovery(actionId) {
    if (!this.profile.discoveries.includes(actionId)) {
      this.profile.discoveries.push(actionId);
      this.saveProfile();
    }
  }

  /** Evaluate achievements after a session ends. Returns newly unlocked ids. */
  evaluateAchievements(session) {
    const unlocked = [];
    const s = session.state;
    const tryUnlock = (id, cond) => { if (cond && this.unlockAchievement(id)) unlocked.push(id); };
    tryUnlock('first-light', s.status === 'complete');
    tryUnlock('full-pantry', ['feed', 'wash', 'play', 'rest', 'pet', 'sing', 'toss', 'snack'].every((a) => s.discovered.includes(a)));
    tryUnlock('deep-bond', session.bondLevel >= 5);
    tryUnlock('old-friends', session.bondLevel >= 6);
    tryUnlock('mastery-trial', s.status === 'complete' && !!this._isMastery(session));
    tryUnlock('room-of-ones-own', s.decorPlaced.length >= 5);
    tryUnlock('gentle-hands', s.status === 'complete' && s.invalidAttempts === 0 && s.commandCount >= 5);
    tryUnlock('streak-three', (this.profile.dailyDays || []).length >= 3);
    return unlocked;
  }
  _isMastery(session) { return /s8$/.test(session.content.id || '') && (session.content.mastery !== false); }
}

/** v1 → v2 profile migration: settings gained captions/cameraShake; dailyDays added. */
export function migrateProfile(p) {
  const out = { ...structuredClone(DEFAULT_PROFILE), ...p };
  out.settings = { ...DEFAULT_SETTINGS, ...(p.settings || {}) };
  if (!Array.isArray(out.dailyDays)) out.dailyDays = [];
  if (out.dailyDays.length === 0 && out.daily && Object.keys(out.daily).length) {
    out.dailyDays = Object.keys(out.daily);
  }
  out.v = SAVE_VERSION;
  return out;
}
