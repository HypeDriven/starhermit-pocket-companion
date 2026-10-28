// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the emote and dust budgets scaled within the tier by the level
// (frame().levelIndex, at most 2×), as the browser build scaled them by its
// hardware level. The runtime owns the rest of what the old Graphics panel
// did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout. The old panel's
// per-effect overrides are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 512 | 1024 | 2048;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  particles: "low" | "medium" | "high";
  /** Room detail: props, procedural surface textures. */
  detailed: boolean;
  /** Ambient motion: window light pool, dust motes, lamp and window shimmer. */
  ambient: boolean;
  budget: Budget;
}

/** gfx.js TABLE. */
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", reflections: false, particles: "low", detailed: false, ambient: false },
  balanced: { shadows: 512, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, particles: "medium", detailed: true, ambient: true },
  high: { shadows: 1024, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", detailed: true, ambient: true },
  ultra: { shadows: 2048, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", detailed: true, ambient: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texScale: 0.5, body: [24, 18], sprites: 60, motes: 40, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", texScale: 0.5, body: [32, 24], sprites: 160, motes: 50, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", texScale: 1, body: [40, 30], sprites: 400, motes: 70, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", texScale: 1.5, body: [56, 40], sprites: 600, motes: 120, bloomRes: 1, aoRes: 1 },
};
/** gfx.js PARTICLE_BUDGET: the Particles tier's cap. */
const PARTICLE_CAP = { low: 60, medium: 160, high: 1200 };
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const SPRITE_MAX = 1200, MOTE_MAX = 240;

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset], body: [...BUDGETS[preset].body] as [number, number] };
  const k = Math.min(2, Math.pow(1.23, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sprites = Math.min(SPRITE_MAX, Math.round(b.sprites * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js spriteCap: the preset's budget under the Particles tier's cap. */
export function spriteCap(l: Look): number { return Math.min(PARTICLE_CAP[l.particles], l.budget.sprites); }
