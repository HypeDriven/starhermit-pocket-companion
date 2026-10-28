/**
 * Pocket Companion — the save model: the profile (progression, achievements,
 * discoveries, dailies, bests, tutorial flags), the local casual boards, the
 * cloud merge, the old browser build's cloud document, the session-result
 * bookkeeping and the game's own options. Pure (no storage, no platform, no
 * clock: callers pass `now`), shared by the engine client (native/*.ts) and
 * the node tests. Moved here from the browser build's src/storage.js and the
 * results code of src/main.js, unchanged in what they decide.
 *
 * The engine save is { v, profile, boards }: the same { profile, boards }
 * document the browser build mirrored to its cloud slot (game:<slug>) through
 * the JS SDK; readForeign() reads that text.
 */

export const SAVE_VERSION = 2;
export const DOC_VERSION = 1;

/** The browser build's settings model (kept in the profile for older saves; see OPTION_KEYS). */
export const DEFAULT_SETTINGS = {
  music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.7,
  gfx: { preset: 'auto' },
  reducedMotion: false,
  highContrast: false,
  palette: 'default',
  largeText: false,
  leftHanded: false,
  holdToRepeat: false,
  timingAssist: false,
  haptics: true,
  captions: true,
  cameraShake: true,
  tutorialSeen: {},
};

/**
 * The game's own options (engine `settings`, synced with the account). Volumes, graphics,
 * reduced motion, high contrast, larger text and the language are the runtime's Options.
 */
export const DEFAULT_OPTIONS = { palette: 'default', leftHanded: false, timingAssist: false, haptics: true, captions: true };
export const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
export const PALETTES = ['default', 'deuteranopia', 'protanopia', 'tritanopia'];
/** Every key the browser build mirrored to the account's settings KV. */
export const BROWSER_KEYS = Object.keys(DEFAULT_SETTINGS);

/** A valid subset of the game's options from anything. */
export function pickOptions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (PALETTES.includes(raw.palette)) out.palette = raw.palette;
  for (const k of ['leftHanded', 'timingAssist', 'haptics', 'captions']) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  return out;
}

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

const clone = (x) => JSON.parse(JSON.stringify(x));
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** The earlier of two timestamps (0 = unknown). */
const earliest = (a, b) => { const x = num(a), y = num(b); return x && y ? Math.min(x, y) : x || y; };

export const DEFAULT_PROFILE = {
  v: SAVE_VERSION,
  name: 'Guest',
  createdAt: 0,
  settings: { ...DEFAULT_SETTINGS },
  journey: {},              // stageId -> {stars, bestScore, completedAt}
  lessonsDone: {},
  discoveries: [],          // action ids ever discovered (profile-wide)
  decorUnlocked: [],
  daily: {},                // dayKey -> {score, completed}
  dailyDays: [],            // distinct day keys completed (for streak)
  achievements: {},         // id -> unlockedAt
  bestScores: {},           // stageId -> total
  sessionsPlayed: 0,
  lastTheme: 'hearthwood',
};

/** v1 → v2 profile migration: settings gained captions/cameraShake; dailyDays added. */
export function migrateProfile(p) {
  const src = obj(p) ? clone(p) : {};
  const out = { ...clone(DEFAULT_PROFILE), ...src };
  out.settings = { ...DEFAULT_SETTINGS, ...(obj(src.settings) || {}) };
  if (!obj(out.settings.gfx)) out.settings.gfx = { preset: 'auto' };
  delete out.settings.graphicsTier;
  if (!obj(out.settings.tutorialSeen)) out.settings.tutorialSeen = {};
  for (const k of ['journey', 'lessonsDone', 'daily', 'achievements', 'bestScores']) out[k] = obj(out[k]) || {};
  for (const k of ['discoveries', 'decorUnlocked', 'dailyDays']) if (!Array.isArray(out[k])) out[k] = [];
  if (out.dailyDays.length === 0 && Object.keys(out.daily).length) out.dailyDays = Object.keys(out.daily);
  if (typeof out.name !== 'string' || !out.name) out.name = 'Guest';
  out.sessionsPlayed = num(out.sessionsPlayed);
  out.v = SAVE_VERSION;
  return out;
}

/**
 * Cloud merge (another device saved first, or the old cloud slot): neither side's progress is
 * dropped. Journey records keep the most stars and best score, daily results and per-stage bests
 * keep the higher score, achievements keep the earliest unlock, discoveries / decor / lessons /
 * daily days are unioned, sessions played takes the larger count. Settings, name and theme come
 * from the remote copy unless `keepLocalSettings`; tutorial flags are unioned either way.
 */
export function mergeProfile(remote, local, { keepLocalSettings = false } = {}) {
  const r = migrateProfile(remote || {}), l = migrateProfile(local || {});
  const journey = { ...r.journey };
  for (const [id, b] of Object.entries(l.journey)) {
    const a = journey[id];
    journey[id] = !a ? b : {
      stars: Math.max(num(a.stars), num(b.stars)),
      bestScore: Math.max(num(a.bestScore), num(b.bestScore)),
      completedAt: earliest(a.completedAt, b.completedAt),
    };
  }
  const daily = { ...r.daily };
  for (const [k, v] of Object.entries(l.daily)) daily[k] = !daily[k] || num(v?.score) > num(daily[k]?.score) ? v : daily[k];
  const bestScores = { ...r.bestScores };
  for (const [k, v] of Object.entries(l.bestScores)) bestScores[k] = Math.max(num(bestScores[k]), num(v));
  const achievements = { ...r.achievements };
  for (const [k, v] of Object.entries(l.achievements)) achievements[k] = achievements[k] ? earliest(achievements[k], v) || achievements[k] : v;
  const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];
  const pref = keepLocalSettings ? l : r;
  return {
    ...l,
    name: pref.name === 'Guest' ? (keepLocalSettings ? r : l).name : pref.name,
    settings: { ...pref.settings, tutorialSeen: { ...r.settings.tutorialSeen, ...l.settings.tutorialSeen } },
    lastTheme: pref.lastTheme,
    createdAt: earliest(r.createdAt, l.createdAt),
    journey, daily, bestScores, achievements,
    lessonsDone: { ...r.lessonsDone, ...l.lessonsDone },
    discoveries: union(r.discoveries, l.discoveries),
    decorUnlocked: union(r.decorUnlocked, l.decorUnlocked),
    dailyDays: union(r.dailyDays, l.dailyDays).sort(),
    sessionsPlayed: Math.max(num(r.sessionsPlayed), num(l.sessionsPlayed)),
  };
}

const sortBoard = (list) => list.sort((a, b) => num(b.score) - num(a.score) || num(a.ticks) - num(b.ticks));

/** Local casual boards from both sides, de-duplicated, best 50 per board. */
export function mergeBoards(remote, local) {
  const out = {};
  const r = obj(remote) || {}, l = obj(local) || {};
  for (const id of new Set([...Object.keys(r), ...Object.keys(l)])) {
    const seen = new Set();
    out[id] = sortBoard([...(Array.isArray(l[id]) ? l[id] : []), ...(Array.isArray(r[id]) ? r[id] : [])]
      .filter((e) => { if (!obj(e)) return false; const k = JSON.stringify(e); if (seen.has(k)) return false; seen.add(k); return true; }))
      .slice(0, 50);
  }
  return out;
}

/* ------------------------------------------------------------------ the save document */
export function defaultSave() { return { v: DOC_VERSION, profile: migrateProfile(null), boards: {} }; }

/** A save document from anything. */
export function normalize(raw) {
  const d = obj(raw) || {};
  return { v: DOC_VERSION, profile: migrateProfile(d.profile), boards: mergeBoards({}, d.boards) };
}

/** Merge two saves; this device's settings and name win only with keepLocalSettings. */
export function mergeSave(remote, local, opts = {}) {
  const a = normalize(remote), b = normalize(local);
  return { v: DOC_VERSION, profile: migrateProfile(mergeProfile(a.profile, b.profile, opts)), boards: mergeBoards(a.boards, b.boards) };
}

export function sameSave(a, b) { return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)); }

/** The browser build's cloud slot text ({ profile, boards }) → { save, options } or null. */
export function readForeign(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const d = JSON.parse(text);
    if (!obj(d)) return null;
    if (obj(d.profile)) return { save: normalize(d), options: pickOptions(d.profile.settings) };
    if ('journey' in d || 'achievements' in d || 'daily' in d) return { save: normalize({ profile: d }), options: pickOptions(d.settings) };
    return null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ local casual boards */
export function submitLocalScore(doc, boardId, entry) {
  const list = Array.isArray(doc.boards[boardId]) ? doc.boards[boardId] : [];
  list.push(entry);
  doc.boards[boardId] = sortBoard(list).slice(0, 50);
  return doc.boards[boardId];
}
export function getLocalBoard(doc, boardId) { return Array.isArray(doc.boards[boardId]) ? doc.boards[boardId] : []; }

/* ------------------------------------------------------------------ bookkeeping */
export function recordDiscovery(profile, id) {
  if (profile.discoveries.includes(id)) return false;
  profile.discoveries.push(id);
  return true;
}

/** Idempotent achievement unlock; true on first unlock. */
export function unlockAchievement(profile, id, now) {
  if (!ACHIEVEMENTS.some((a) => a.id === id) || profile.achievements[id]) return false;
  profile.achievements[id] = now || 1;
  return true;
}

const isMastery = (cfg) => /s8$/.test(cfg.id || '') && cfg.mastery !== false;

/**
 * Achievements after a session ends: { state, bondLevel, cfg } of the finished session. Returns
 * the newly unlocked ids.
 */
export function evaluateAchievements(profile, { state: s, bondLevel, cfg }, now) {
  const unlocked = [];
  const tryUnlock = (id, cond) => { if (cond && unlockAchievement(profile, id, now)) unlocked.push(id); };
  tryUnlock('first-light', s.status === 'complete');
  tryUnlock('full-pantry', ['feed', 'wash', 'play', 'rest', 'pet', 'sing', 'toss', 'snack'].every((a) => s.discovered.includes(a)));
  tryUnlock('deep-bond', bondLevel >= 5);
  tryUnlock('old-friends', bondLevel >= 6);
  tryUnlock('mastery-trial', s.status === 'complete' && isMastery(cfg));
  tryUnlock('room-of-ones-own', s.decorPlaced.length >= 5);
  tryUnlock('gentle-hands', s.status === 'complete' && s.invalidAttempts === 0 && s.commandCount >= 5);
  tryUnlock('streak-three', (profile.dailyDays || []).length >= 3);
  return unlocked;
}

/** Journey stars for a completed stage: par → 3, 1.5 × par → 2, else 1. */
export function starsFor(tick, par) { return tick <= par ? 3 : tick <= par * 1.5 ? 2 : 1; }

/**
 * A finished session's progression (main.js _finishSession): journey stars and best, the
 * daily result (first completion recorded, later ones only raise the score), sessions played
 * and the per-content best. Returns { stars, best, isBest }.
 */
export function recordResult(profile, { mode, cfg, state, total, now }) {
  const completed = state.status === 'complete';
  let stars = 0;
  if (mode === 'journey' && completed) {
    stars = starsFor(state.tick, cfg.par);
    const prev = profile.journey[cfg.id];
    profile.journey[cfg.id] = {
      stars: Math.max(stars, num(prev?.stars)),
      bestScore: Math.max(total, num(prev?.bestScore)),
      completedAt: now,
    };
  }
  if (mode === 'daily' && completed && cfg.dailyKey) {
    if (!profile.daily[cfg.dailyKey]) {
      profile.daily[cfg.dailyKey] = { score: total, completed: true };
      if (!profile.dailyDays.includes(cfg.dailyKey)) profile.dailyDays.push(cfg.dailyKey);
    } else if (total > profile.daily[cfg.dailyKey].score) {
      profile.daily[cfg.dailyKey].score = total;
    }
  }
  profile.sessionsPlayed += 1;
  profile.bestScores[cfg.id] = Math.max(num(profile.bestScores[cfg.id]), total);
  const best = profile.bestScores[cfg.id];
  return { stars, best, isBest: total >= best };
}

/** Journey stages unlocked: the first, then each after a completed one. */
export function journeyUnlockedCount(profile, stages) {
  let n = 1;
  for (let i = 0; i < stages.length - 1; i++) {
    if (profile.journey[stages[i].id]) n = i + 2;
    else break;
  }
  return Math.min(n, stages.length);
}
