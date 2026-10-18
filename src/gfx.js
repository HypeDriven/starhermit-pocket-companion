/**
 * Pocket Companion — graphics quality model: presets, per-category overrides,
 * StarHermit hardware-level detection, per-preset budgets and a cost summary. Pure (no three.js) so the settings panel,
 * the renderer and the unit tests agree on what a setting means.
 */

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],       // image-based lighting (room environment map)
  particles: ['low', 'medium', 'high'],
  detail: ['plain', 'detailed'],    // props, procedural surface textures, plush sheen
  ambient: ['off', 'on'],           // window light pool, drifting dust motes, lamp + window shimmer
};

// Each preset: a row of tiers, a render scale and a device-pixel-ratio cap.
const TABLE = {
  low: { scale: 1, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', reflections: 'off', particles: 'low', detail: 'plain', ambient: 'off' },
  balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', particles: 'medium', detail: 'detailed', ambient: 'on' },
  high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', detail: 'detailed', ambient: 'on' },
  ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', detail: 'detailed', ambient: 'on' },
};

export const SHADOW_MAP = { off: 0, low: 512, medium: 1024, high: 2048 };
export const PARTICLE_BUDGET = { low: 60, medium: 160, high: 1200 }; // Particles tier cap; the preset budget applies too

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Gameplay, layout and
 * hit areas are identical on every preset — only visuals change.
 *   material  surface shading: lambert (Low) / standard (Balanced) / physical — clear-coat floor, pot and
 *             eyes, plush sheen (High, Ultra)
 *   texScale  procedural room textures (floor, plaster, wainscot, rug, yarn, sky) × authored size
 *   body      creature body sphere segments [width, height]
 *   sprites   emote particles alive at once (the Particles tier caps it further: low 60, medium 160)
 *   motes     dust motes in the window light (Ambient on), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', texScale: 0.5, body: [24, 18], sprites: 60, motes: 40, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', texScale: 0.5, body: [32, 24], sprites: 160, motes: 50, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', texScale: 1, body: [40, 30], sprites: 400, motes: 70, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', texScale: 1.5, body: [56, 40], sprites: 600, motes: 120, bloomRes: 1, aoRes: 1 },
};

/** A preset's concrete budget for a hardware level (effect counts scale ≤ 2× within the preset). */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
  b.sprites = Math.min(SPRITE_MAX, Math.round(b.sprites * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return b;
}
export const SPRITE_MAX = 1200;
export const MOTE_MAX = 240;

/** Live emote-particle cap for a resolved setting (Particles tier within the preset's budget). */
export function spriteCap(r) {
  return Math.min(PARTICLE_BUDGET[r.particles] ?? PARTICLE_BUDGET.low, r.budget.sprites);
}


/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, renderScale, dprCap: row.dprCap, scale: row.scale * renderScale };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // The composer runs only when something needs it (MSAA uses a multisampled
  // composer target, so the canvas itself never pays for antialiasing).
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias !== 'off';
  return out;
}

/** Saved settings after choosing a preset: overrides are cleared, scale/toggles kept. */
export function choosePreset(saved, preset) {
  const s = saved || {};
  const out = { preset: preset === 'auto' || PRESETS.includes(preset) ? preset : 'auto' };
  if (s.render_scale != null) out.render_scale = s.render_scale;
  if (s.adaptive != null) out.adaptive = s.adaptive;
  if (s.show_fps != null) out.show_fps = s.show_fps;
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

const WORDS = {
  noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoFull: 'full ambient occlusion',
  bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing',
};

/**
 * Short cost summary, e.g. "1024² shadows · ambient occlusion · bloom · SMAA · 1280×720 px".
 * `words` localizes the phrases (defaults to English).
 */
export function describe(r, pixels, words = WORDS) {
  const w = { ...WORDS, ...words };
  const parts = [
    r.shadows === 'off' ? w.noShadows : w.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoFull : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    r.antialias === 'off' ? w.noAA : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Map the pre-2026 single "graphicsTier" setting onto the preset model. */
export function fromLegacyTier(tier) {
  return { preset: { low: 'low', medium: 'balanced', high: 'high' }[tier] || 'auto' };
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
