// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event with their captions,
// the quiet ambient bed (two seconds of white noise ×0.4 through a 500 Hz
// lowpass, looped, gain 0.15 on the ambience bus) and the slow pentatonic
// music pad (a sine note every 2.2 s over the eight-step pattern, with a
// triangle an octave down on every other step). The browser build ran the
// bed and the pad live (a noise loop and oscillators on a timer); here they
// are rendered once by OfflineAudioContext, one context a stem, and looped on
// the music bus — the runtime has no ambience bus: the bed's gain carries
// the old ambience/music volume ratio (0.5 / 0.6). The oscillator fallbacks
// it played while a sample decoded are not ported (a live synthesis graph
// makes clip loads fail on the web runtime): a clip still loading is
// silent, but its caption still shows. The runtime's Options own the
// volumes, the mute and the voice limit. Every clip loads at start; the
// bed and the pad wait for the mixer (in a browser, the first press).
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { Rules } from "./game.ts";

/** sfx/manifest.json: every event has its own sample of the same name. */
const SFX = ["ack", "invalid", "feed", "wash", "play", "rest", "pet", "sing", "toss", "snack", "decorate", "craving", "craving-met",
  "discovery", "bond-up", "complete", "expired", "neglected", "ui-open", "ui-close"] as const;
export type Sfx = (typeof SFX)[number];
/** audio.js EVENT_CAPTIONS (en-US keys, translated where shown). */
export const CAPTIONS: Partial<Record<Sfx, string>> = {
  invalid: "not allowed", feed: "munch munch", wash: "splish splash",
  play: "boing!", rest: "zzz…", pet: "purr", sing: "la la la",
  toss: "wheee!", snack: "nom", decorate: "placed!",
  craving: "Mote wishes for something…", "craving-met": "wish granted!",
  discovery: "new discovery!", "bond-up": "bond level up!",
  complete: "session complete!", expired: "time is up", neglected: "Mote needs you",
};
const clips = new Map<string, AudioClip>();
let suspended = false;
let onCaption: ((key: string) => void) | null = null;
/** The caption line's hook (main.ts shows it when the Captions option is on). */
export function setCaptionHandler(fn: (key: string) => void): void { onCaption = fn; }

/** Loads every clip at once (onStart); a cue whose clip is still loading is silent. */
export function loadSfx(): void {
  for (const name of SFX) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`));
  }
  renderAmbience().then((c) => { ambClip = c; }, (e: unknown) => console.warn(`audio: ${String(e)}`));
  renderMusic().then((c) => { musicClip = c; }, (e: unknown) => console.warn(`audio: ${String(e)}`));
}

/** A logical event's sound (event hierarchy: ack < move < goal < round) and its caption. */
export function event(name: string): void {
  const cap = CAPTIONS[name as Sfx];
  if (cap) onCaption?.(cap);
  if (suspended) return;
  const clip = clips.get(name);
  if (!clip) return;
  try { playClip(clip, { bus: name.startsWith("ui-") ? "interface" : "effects" }); } catch { /* the mixer is full this frame: skip it */ }
}

// -- the ambient bed and the music pad ------------------------------------------------------------
const RATE = 22050;
/** Makes the biquad's level the old two one-poles' (rms measured). */
const AMB_MAKEUP = 0.7923;
/** _startAmbience: white noise ×0.4 through a 500 Hz lowpass (two one-poles then: -3 dB at about 322 Hz); periodic once settled, so the loop joins. */
async function renderAmbience(): Promise<AudioClip> {
  const n = 2 * RATE, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ seed: 0xa3b1, seconds: 2 });
  const lp = off.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 322;
  const g = off.createGain(); g.gain.value = 0.4 * 1.6 * AMB_MAKEUP;
  noise.connect(lp).connect(g).connect(off.destination); noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}

/** _startMusic: one step each 2.2 s over [0, 2, 4, 3, 1, 5, 2, 0] of the pentatonic scale. */
const STEP = 2.2, STEPS = 8;
const SCALE = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3];
const PATTERN = [0, 2, 4, 3, 1, 5, 2, 0];
// blip(): variantSeed 0 detunes every pad note alike (±12.5 % from the seeded stream).
const DETUNE = (() => { const r = Rules.makeRng(0); return 1 + (r.range(100) - 50) / 400; })();
/** blip(): gain 0 → peak in 10 ms (linear), then exponentially to 0.001 at `dur`. */
function addNote(off: OfflineAudioContext, t0: number, f: number, peak: number, dur: number, wave: "sine" | "triangle"): void {
  const o = off.createOscillator(); o.type = wave; o.frequency.value = f * DETUNE;
  const g = off.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(off.destination);
  o.start(t0); o.stop(t0 + dur);
}
async function renderMusic(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(RATE * STEPS * STEP), RATE);
  for (let i = 0; i < STEPS; i++) {
    const f = SCALE[PATTERN[i]!]!;
    addNote(off, i * STEP, f, 0.12, 1.6, "sine");
    if (i % 2 === 0) addNote(off, i * STEP, f / 2, 0.08, 2.2, "triangle");
  }
  return createClip(await off.startRendering());
}

let ambClip: AudioClip | null = null, musicClip: AudioClip | null = null;
let ambVoice: Sound | null = null, musicVoice: Sound | null = null;
const AMB_GAIN = 0.15 * 0.5 / 0.6;
/** A hidden window silences the loops (audio.js duck). */
export function setSuspended(on: boolean): void {
  if (on === suspended) return;
  suspended = on;
  try {
    ambVoice?.fade(on ? 0 : AMB_GAIN, 0.2);
    musicVoice?.fade(on ? 0 : 1, 0.2);
  } catch { /* gone */ }
}

/** Each frame: once the mixer runs and the stems are ready, the bed and the pad. */
export function update(): void {
  if (context.state !== "running") return;
  if (ambClip && !ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: suspended ? 0 : AMB_GAIN, loop: true }); } catch { ambVoice = null; }
  }
  if (musicClip && !musicVoice) {
    try { musicVoice = playClip(musicClip, { bus: "music", gain: suspended ? 0 : 1, loop: true }); } catch { musicVoice = null; }
  }
}
