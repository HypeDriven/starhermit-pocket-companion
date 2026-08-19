/**
 * Pocket Companion — rules engine.
 * Pure, deterministic, dependency-free ES module (runs in browser and Node).
 *
 * All simulation quantities are integers (permille, 0..1000) so replays hash
 * identically on every platform. Formatting happens only in presentation.
 */

export const RULES_VERSION = 3;
export const STATE_VERSION = 2;

export const NEEDS = ['hunger', 'hygiene', 'fun', 'energy'];
export const NEED_MAX = 1000;
export const NEGLECT_THRESHOLD = 50;

/** Bond level thresholds (cumulative bond points). */
export const BOND_LEVELS = [0, 30, 75, 140, 230, 350, 500, 700, 950, 1250, 1600];
export const MAX_BOND_LEVEL = BOND_LEVELS.length - 1;

/* ------------------------------------------------------------------ *
 * Seeded random streams (mulberry32). Separate streams per concern so
 * cosmetic randomness can never perturb rules randomness.
 * ------------------------------------------------------------------ */
export function makeRng(seed) {
  let s = seed >>> 0;
  return {
    get state() { return s >>> 0; },
    set state(v) { s = v >>> 0; },
    next() { // returns uint32
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0);
    },
    range(n) { return n <= 0 ? 0 : this.next() % n; },
  };
}

/** Stable string hash (fnv1a) — used for content ids and state hashing. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------ *
 * Action definitions. Effects are permille deltas applied (clamped)
 * before decay for the action's tick cost. `gate` returns null when
 * legal, or a machine-readable reason code when illegal.
 * ------------------------------------------------------------------ */
export const ACTIONS = {
  feed: {
    id: 'feed', label: 'Feed', kind: 'care', ticks: 3,
    effects: { hunger: 320, hygiene: -15 },
    gate: (s) => s.needs.hunger > 930 ? 'full' : null,
    blurb: 'A warm bowl of berry mash. Fills Hunger.',
  },
  snack: {
    id: 'snack', label: 'Snack', kind: 'care', ticks: 2,
    effects: { hunger: 120, fun: 50, hygiene: -10 },
    gate: (s) => s.needs.hunger > 960 ? 'full' : null,
    blurb: 'A tiny mooncake treat. A little Hunger, a little Fun.',
  },
  wash: {
    id: 'wash', label: 'Wash', kind: 'care', ticks: 3,
    effects: { hygiene: 360, fun: -25 },
    gate: (s) => s.needs.hygiene > 950 ? 'already-clean' : null,
    blurb: 'Bubble bath time. Restores Cleanliness.',
  },
  play: {
    id: 'play', label: 'Play', kind: 'care', ticks: 4,
    effects: { fun: 340, energy: -110, hunger: -55 },
    gate: (s) => s.needs.energy < 130 ? 'too-tired' : null,
    blurb: 'A game of blanket tag. Big Fun, costs Energy.',
  },
  rest: {
    id: 'rest', label: 'Rest', kind: 'care', ticks: 5,
    effects: { energy: 380, hunger: -70 },
    gate: (s) => s.needs.energy > 900 ? 'not-sleepy' : null,
    blurb: 'Tuck in for a nap. Restores Energy.',
  },
  pet: {
    id: 'pet', label: 'Pet', kind: 'bond', ticks: 1,
    effects: { fun: 70 },
    gate: (s) => s.needs.fun > 980 ? 'overjoyed' : null,
    blurb: 'Gentle head pats. Small Fun, builds Trust.',
  },
  sing: {
    id: 'sing', label: 'Sing', kind: 'bond', ticks: 2,
    effects: { fun: 130, energy: -35 },
    gate: (s) => s.needs.energy < 60 ? 'too-tired' : null,
    blurb: 'A soft humming tune. Fun with a small Energy cost.',
  },
  toss: {
    id: 'toss', label: 'Toss Ball', kind: 'bond', ticks: 2,
    effects: { fun: 190, energy: -95, hunger: -40 },
    gate: (s) => s.needs.energy < 110 ? 'too-tired' : null,
    blurb: 'Toss the yarn ball. Great Fun, tiring.',
  },
  decorate: {
    id: 'decorate', label: 'Decorate', kind: 'room', ticks: 0,
    effects: {},
    takesItem: true,
    gate: (s, args) => {
      const item = args && args.item;
      if (!item || !s.allowedDecor.includes(item)) return 'unknown-item';
      return null;
    },
    blurb: 'Place a room decoration. Free — makes the room yours.',
  },
  wait: {
    id: 'wait', label: 'Wait', kind: 'pass', ticks: 1,
    effects: {},
    gate: () => null,
    blurb: 'Let a quiet moment pass.',
  },
};

export const INVALID_REASONS = {
  'full': 'Not hungry right now — the bowl would go to waste.',
  'already-clean': 'Already squeaky clean.',
  'too-tired': 'Too tired for that. Try Rest first.',
  'not-sleepy': 'Wide awake — no nap needed.',
  'overjoyed': 'Could not possibly be happier.',
  'unknown-item': 'That decoration is not available here.',
  'unknown-action': 'That action does not exist.',
  'action-unavailable': 'That action is not available in this session.',
  'game-over': 'This session has already ended.',
  'bad-command': 'Malformed command.',
};

/* ------------------------------------------------------------------ *
 * Game creation
 * ------------------------------------------------------------------ */

/**
 * config: {
 *   stageId, seed (uint32), tickLimit (0 = none), maxCommands (0 = none),
 *   decay: {hunger,hygiene,fun,energy} permille per tick,
 *   goals: {bondLevel?, care?, discoveries?, decor?},
 *   allowedActions: [ids], allowedDecor: [itemIds],
 *   startNeeds?: {…permille}, cravingEvery?: ticks (0 disables),
 *   timeBonusPerTick?: points
 * }
 */
export function createGame(config) {
  const start = config.startNeeds || {};
  const state = {
    v: STATE_VERSION,
    stageId: String(config.stageId || 'practice'),
    seed: (config.seed >>> 0) || 1,
    tick: 0,
    commandCount: 0,
    needs: {
      hunger: clampNeed(start.hunger ?? 650),
      hygiene: clampNeed(start.hygiene ?? 650),
      fun: clampNeed(start.fun ?? 550),
      energy: clampNeed(start.energy ?? 800),
    },
    decay: {
      hunger: intOr(config.decay?.hunger, 4),
      hygiene: intOr(config.decay?.hygiene, 3),
      fun: intOr(config.decay?.fun, 4),
      energy: intOr(config.decay?.energy, 2),
    },
    goals: {
      bondLevel: intOr(config.goals?.bondLevel, 0),
      care: intOr(config.goals?.care, 0),
      discoveries: intOr(config.goals?.discoveries, 0),
      decor: intOr(config.goals?.decor, 0),
    },
    tickLimit: intOr(config.tickLimit, 0),
    maxCommands: intOr(config.maxCommands, 0),
    allowedActions: (config.allowedActions || Object.keys(ACTIONS)).slice(),
    allowedDecor: (config.allowedDecor || []).slice(),
    cravingEvery: intOr(config.cravingEvery, 22),
    timeBonusPerTick: intOr(config.timeBonusPerTick, 6),
    bondPoints: 0,
    discovered: [],       // action ids or "decor:<item>" first used this session
    decorPlaced: [],      // item ids currently placed
    craving: null,        // {need, expiresTick}
    nextCravingTick: 0,
    score: { care: 0, discovery: 0, bond: 0, timeBonus: 0 },
    invalidAttempts: 0,
    status: 'active',     // active | complete | expired | neglected
    terminalReason: null,
    lastEvent: null,      // presentation cue for the most recent command
    seenIds: [],
    rngRules: 0,
    log: [],              // terse per-command records for "while you were away"
  };
  const rng = makeRng(state.seed);
  // Warm the rules stream so identical seeds with different stage ids diverge.
  rng.state = (rng.state ^ fnv1a(state.stageId)) >>> 0;
  state.rngRules = rng.state;
  return state;
}

function clampNeed(v) { return Math.max(0, Math.min(NEED_MAX, Math.round(Number(v) || 0))); }
function intOr(v, d) { return Number.isFinite(v) ? Math.round(v) : d; }

/* ------------------------------------------------------------------ *
 * Legality
 * ------------------------------------------------------------------ */

/** Returns [{id, label, kind, legal, reason, ticks}] for every allowed action. */
export function legalActions(state) {
  if (state.status !== 'active') {
    return state.allowedActions.map((id) => ({
      id, label: ACTIONS[id]?.label || id, kind: ACTIONS[id]?.kind || 'pass',
      legal: false, reason: 'game-over', ticks: ACTIONS[id]?.ticks || 0,
    }));
  }
  return state.allowedActions.map((id) => {
    const def = ACTIONS[id];
    if (!def) return { id, label: id, kind: 'pass', legal: false, reason: 'unknown-action', ticks: 0 };
    const reason = def.takesItem
      ? (state.allowedDecor.length ? null : 'unknown-item')
      : def.gate(state);
    return { id, label: def.label, kind: def.kind, legal: reason === null, reason, ticks: def.ticks };
  });
}

export function isLegal(state, type, args) {
  const def = ACTIONS[type];
  if (!def) return 'unknown-action';
  if (state.status !== 'active') return 'game-over';
  if (!state.allowedActions.includes(type)) return 'action-unavailable';
  return def.gate(state, args || {});
}

/* ------------------------------------------------------------------ *
 * Command application (deterministic; mutates state; returns result)
 * ------------------------------------------------------------------ */

let commandSeqFallback = 0;

export function makeCommand(type, args, id) {
  return {
    id: id || `c${Date.now().toString(36)}-${(commandSeqFallback++).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    type: String(type || ''),
    args: args && typeof args === 'object' ? { ...args } : {},
  };
}

/**
 * Apply a validated command. Returns a result object; on illegal commands the
 * state is untouched except for the invalid-attempt counter (an authoritative
 * penalty, not a simulation change).
 */
export function applyCommand(state, command) {
  if (!command || typeof command !== 'object' || typeof command.type !== 'string' ||
      (command.id != null && typeof command.id !== 'string') ||
      (command.args != null && (typeof command.args !== 'object' || Array.isArray(command.args)))) {
    return { ok: false, reason: 'bad-command' };
  }
  const id = command.id || `auto-${state.commandCount}`;
  if (state.seenIds.includes(id)) {
    return { ok: true, duplicate: true, tick: state.tick, status: state.status };
  }
  const cmd = { id, type: command.type, args: command.args || {} };
  const def = ACTIONS[cmd.type];
  const illegal = isLegal(state, cmd.type, cmd.args);
  if (illegal) {
    state.invalidAttempts += 1;
    state.seenIds.push(id);
    trimSeen(state);
    return { ok: false, reason: illegal, invalidAttempts: state.invalidAttempts };
  }

  // --- resolve ---
  const before = { ...state.needs };
  const rng = makeRng(0); rng.state = state.rngRules;

  let careGain = 0;
  let bondGain = 0;
  let discoveryGain = 0;
  let cravingBonus = false;

  for (const need of NEEDS) {
    const delta = def.effects[need] || 0;
    if (delta > 0) {
      const restored = Math.min(NEED_MAX - state.needs[need], delta);
      state.needs[need] += restored;
      careGain += Math.floor(restored / 10);
      // Trust grows from every act of care, and faster when a real need is met.
      bondGain += Math.floor(restored / 30);
      if (before[need] < 400) bondGain += Math.floor(restored / 20) + 3;
      if (state.craving && state.craving.need === need && restored > 0) {
        cravingBonus = true;
        careGain += 60;
        bondGain += 5;
      }
    } else if (delta < 0) {
      state.needs[need] = Math.max(0, state.needs[need] + delta);
    }
  }
  if (cravingBonus) state.craving = null;

  if (def.takesItem) {
    const item = String(cmd.args.item);
    if (!state.decorPlaced.includes(item)) {
      state.decorPlaced.push(item);
      bondGain += 2;
      if (!state.discovered.includes('decor:' + item)) {
        state.discovered.push('decor:' + item);
        discoveryGain += 150;
      }
    }
  } else if (def.kind !== 'pass' && !state.discovered.includes(def.id)) {
    state.discovered.push(def.id);
    discoveryGain += 150;
  }

  // advance ticks + decay
  for (let i = 0; i < def.ticks; i++) {
    state.tick += 1;
    for (const need of NEEDS) {
      state.needs[need] = Math.max(0, state.needs[need] - state.decay[need]);
    }
    maybeSpawnCraving(state, rng);
  }

  state.rngRules = rng.state;
  state.bondPoints += bondGain;
  state.score.care += careGain;
  state.score.discovery += discoveryGain;
  state.score.bond += bondGain;
  state.commandCount += 1;
  state.seenIds.push(id);
  trimSeen(state);

  state.lastEvent = {
    tick: state.tick, action: def.id, kind: def.kind,
    before, after: { ...state.needs },
    careGain, bondGain, discoveryGain, cravingBonus,
    variant: def.kind === 'pass' ? 0 : rng.range(4),
  };
  state.log.push({ t: state.tick, a: def.id, c: careGain + discoveryGain, b: bondGain });
  if (state.log.length > 64) state.log.splice(0, state.log.length - 64);

  checkTerminal(state);

  return {
    ok: true, tick: state.tick, status: state.status,
    careGain, bondGain, discoveryGain, cravingBonus,
    terminal: state.terminalReason || undefined,
  };
}

function trimSeen(state) {
  if (state.seenIds.length > 512) state.seenIds.splice(0, state.seenIds.length - 512);
}

function maybeSpawnCraving(state, rng) {
  if (state.cravingEvery <= 0 || state.craving) return;
  if (state.tick < state.nextCravingTick) return;
  const candidates = NEEDS.filter((n) => state.needs[n] < 700);
  if (candidates.length === 0) { state.nextCravingTick = state.tick + 6; return; }
  const need = candidates[rng.range(candidates.length)];
  state.craving = { need, expiresTick: state.tick + 25 };
  state.nextCravingTick = state.tick + state.cravingEvery + rng.range(8);
}

/** Expire stale cravings without advancing time (called on read paths). */
export function refreshCraving(state) {
  if (state.craving && state.tick > state.craving.expiresTick) state.craving = null;
}

export function bondLevel(state) {
  let lvl = 0;
  for (let i = 0; i < BOND_LEVELS.length; i++) if (state.bondPoints >= BOND_LEVELS[i]) lvl = i;
  return lvl;
}

function goalsMet(state) {
  const g = state.goals;
  if (g.bondLevel && bondLevel(state) < g.bondLevel) return false;
  if (g.care && state.score.care < g.care) return false;
  if (g.discoveries && state.discovered.length < g.discoveries) return false;
  if (g.decor && state.decorPlaced.length < g.decor) return false;
  return (g.bondLevel || g.care || g.discoveries || g.decor) ? true : false;
}

function checkTerminal(state) {
  if (state.status !== 'active') return;
  if (goalsMet(state)) {
    state.status = 'complete';
    state.terminalReason = 'goals-met';
    if (state.tickLimit > 0 && state.tick < state.tickLimit) {
      state.score.timeBonus = (state.tickLimit - state.tick) * state.timeBonusPerTick;
    }
    return;
  }
  if (NEEDS.every((n) => state.needs[n] < NEGLECT_THRESHOLD)) {
    state.status = 'neglected';
    state.terminalReason = 'needs-emptied';
    return;
  }
  if (state.maxCommands > 0 && state.commandCount >= state.maxCommands) {
    state.status = 'expired';
    state.terminalReason = 'move-limit';
    return;
  }
  if (state.tickLimit > 0 && state.tick >= state.tickLimit) {
    state.status = 'expired';
    state.terminalReason = 'time-up';
  }
}

export function isTerminal(state) { return state.status !== 'active'; }

/** Score breakdown — integers; format only in presentation. */
export function scoreBreakdown(state) {
  const c = state.score;
  return {
    care: c.care,
    discovery: c.discovery,
    bond: c.bond,
    timeBonus: c.timeBonus,
    invalidAttempts: state.invalidAttempts,
    total: c.care + c.discovery + c.bond + c.timeBonus,
  };
}

/**
 * Tie-break ordering (per spec): objective completion, fewer invalid actions,
 * lower elapsed ticks, then stable session id.
 */
export function compareResults(a, b) {
  const rank = (s) => s.status === 'complete' ? 2 : s.status === 'expired' ? 1 : 0;
  if (rank(a) !== rank(b)) return rank(b) - rank(a);
  if (scoreBreakdown(b).total !== scoreBreakdown(a).total) return scoreBreakdown(b).total - scoreBreakdown(a).total;
  if (a.invalidAttempts !== b.invalidAttempts) return a.invalidAttempts - b.invalidAttempts;
  if (a.tick !== b.tick) return a.tick - b.tick;
  return String(a.stageId).localeCompare(String(b.stageId));
}

/* ------------------------------------------------------------------ *
 * Mood (derived, deterministic) — drives presentation only.
 * ------------------------------------------------------------------ */
export function moodOf(state) {
  const n = state.needs;
  const min = Math.min(n.hunger, n.hygiene, n.fun, n.energy);
  const avg = Math.floor((n.hunger + n.hygiene + n.fun + n.energy) / 4);
  if (state.status === 'complete') return 'proud';
  if (state.status === 'neglected') return 'miserable';
  if (n.energy < 150) return 'sleepy';
  if (min < 180) return 'sad';
  if (min < 340 || avg < 450) return 'worried';
  if (avg > 780) return 'joyful';
  return 'content';
}

/* ------------------------------------------------------------------ *
 * Serialization + hashing + migration
 * ------------------------------------------------------------------ */
export function serialize(state) {
  return JSON.parse(JSON.stringify(state));
}

export function deserialize(data) {
  if (!data || typeof data !== 'object') throw new Error('bad-state');
  const migrated = migrateState(data);
  // Re-clamp everything defensively: state on disk is untrusted.
  const s = migrated;
  for (const n of NEEDS) s.needs[n] = clampNeed(s.needs[n]);
  s.tick = Math.max(0, intOr(s.tick, 0));
  s.commandCount = Math.max(0, intOr(s.commandCount, 0));
  s.invalidAttempts = Math.max(0, intOr(s.invalidAttempts, 0));
  s.bondPoints = Math.max(0, intOr(s.bondPoints, 0));
  if (!Array.isArray(s.discovered)) s.discovered = [];
  if (!Array.isArray(s.decorPlaced)) s.decorPlaced = [];
  if (!Array.isArray(s.seenIds)) s.seenIds = [];
  if (!Array.isArray(s.log)) s.log = [];
  if (!Array.isArray(s.allowedActions)) s.allowedActions = Object.keys(ACTIONS);
  if (!Array.isArray(s.allowedDecor)) s.allowedDecor = [];
  if (!s.craving || typeof s.craving !== 'object') s.craving = null;
  if (!['active', 'complete', 'expired', 'neglected'].includes(s.status)) s.status = 'active';
  return s;
}

/** v1 → v2: introduced cravings, decor, log, and per-need decay objects. */
export function migrateState(data) {
  const s = JSON.parse(JSON.stringify(data));
  if (s.v === STATE_VERSION) return s;
  if (s.v === 1) {
    s.v = 2;
    if (typeof s.decay === 'number') {
      const d = s.decay;
      s.decay = { hunger: d, hygiene: d, fun: d, energy: Math.max(1, d - 1) };
    }
    s.craving = null;
    s.nextCravingTick = s.nextCravingTick ?? 0;
    s.cravingEvery = s.cravingEvery ?? 22;
    s.decorPlaced = s.decorPlaced || [];
    s.allowedDecor = s.allowedDecor || [];
    s.log = s.log || [];
    s.goals = { bondLevel: 0, care: 0, discoveries: 0, decor: 0, ...(s.goals || {}) };
    s.score = { care: 0, discovery: 0, bond: 0, timeBonus: 0, ...(s.score || {}) };
    return s;
  }
  throw new Error(`unsupported-state-version:${s.v}`);
}

/** Canonical hash of everything that affects future simulation. */
export function hashState(state) {
  const canonical = {
    stageId: state.stageId, seed: state.seed, tick: state.tick,
    cc: state.commandCount, n: state.needs, d: state.decay, g: state.goals,
    tl: state.tickLimit, mc: state.maxCommands, aa: state.allowedActions,
    ad: state.allowedDecor, ce: state.cravingEvery, tb: state.timeBonusPerTick,
    bp: state.bondPoints, disc: state.discovered, dp: state.decorPlaced,
    cr: state.craving, nct: state.nextCravingTick, sc: state.score,
    ia: state.invalidAttempts, st: state.status, tr: state.terminalReason,
    rng: state.rngRules,
  };
  return fnv1a(stableStringify(canonical)).toString(16).padStart(8, '0');
}

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
