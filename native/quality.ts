// The look per graphics level. Shadows, AO, bloom, the grade and anti-aliasing
// come from the engine's levelSettings() for the frame's level; the art columns
// here (the browser build's src/gfx.js TABLE / BUDGETS) stay keyed by its
// quality tier, with the emote and dust budgets scaled within the tier by the
// level's particle budget (at most 2×). The runtime owns the rest of what the
// old Graphics panel did: Auto and the level choice, render scale and the
// pixel-ratio cap, adaptive resolution, the frame-rate limit and readout. The
// old panel's per-effect overrides are not offered (the runtime's Options
// choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Surface shading: Lambert (Low), Standard (Balanced), clear-coated Physical (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Procedural room textures × authored size. */
  texScale: number;
  /** Mote's body sphere segments. */
  body: [number, number];
  /** Emote particles alive at once. */
  sprites: number;
  /** Dust motes in the window light. */
  motes: number;
}
interface Art {
  reflections: boolean;
  particles: "low" | "medium" | "high";
  /** Room detail: props, procedural surface textures. */
  detailed: boolean;
  /** Ambient motion: window light pool, dust motes, lamp and window shimmer. */
  ambient: boolean;
}
export interface Look extends Art {
  preset: QualityTier;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  budget: Budget;
}

/** gfx.js TABLE, without the engine's effects. */
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, particles: "low", detailed: false, ambient: false },
  balanced: { reflections: true, particles: "medium", detailed: true, ambient: true },
  high: { reflections: true, particles: "high", detailed: true, ambient: true },
  ultra: { reflections: true, particles: "high", detailed: true, ambient: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texScale: 0.5, body: [24, 18], sprites: 60, motes: 40 },
  balanced: { material: "standard", texScale: 0.5, body: [32, 24], sprites: 160, motes: 50 },
  high: { material: "physical", texScale: 1, body: [40, 30], sprites: 400, motes: 70 },
  ultra: { material: "physical", texScale: 1.5, body: [56, 40], sprites: 600, motes: 120 },
};
/** gfx.js PARTICLE_BUDGET: the Particles tier's cap. */
const PARTICLE_CAP = { low: 60, medium: 160, high: 1200 };
/** Each tier's first level: its budgets are authored for this level's particle budget. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
export const SPRITE_MAX = 1200, MOTE_MAX = 240;

/** The look for a level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset], body: [...BUDGETS[preset].body] as [number, number] };
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.sprites = Math.min(SPRITE_MAX, Math.round(b.sprites * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
/** gfx.js spriteCap: the preset's budget under the Particles tier's cap. */
export function spriteCap(l: Look): number { return Math.min(PARTICLE_CAP[l.particles], l.budget.sprites); }
