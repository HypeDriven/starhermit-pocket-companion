// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event with their captions,
// the quiet ambient bed (two seconds of white noise ×0.4 through a 500 Hz
// lowpass, looped, gain 0.15 on the ambience bus) and the slow pentatonic
// music pad (a sine note every 2.2 s over the eight-step pattern, with a
// triangle an octave down on every other step). The browser build ran the
// bed and the pad live (a noise loop and oscillators on a timer); here they
// are rendered once into clips (createClip, a slice a frame) and looped on
// the music bus — the runtime has no ambience bus: the bed's gain carries
// the old ambience/music volume ratio (0.5 / 0.6). The oscillator fallbacks
// it played while a sample decoded are not ported (a live synthesis graph
// makes clip loads fail on the web runtime): a clip still loading is
// silent, but its caption still shows. The runtime's Options own the
// volumes, the mute and the voice limit. Clips load once the mixer runs
// (natively at once, in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
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
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;
let onCaption: ((key: string) => void) | null = null;
/** The caption line's hook (main.ts shows it when the Captions option is on). */
export function setCaptionHandler(fn: (key: string) => void): void { onCaption = fn; }

/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

/** A logical event's sound (event hierarchy: ack < move < goal < round) and its caption. */
export function event(name: string): void {
  const cap = CAPTIONS[name as Sfx];
  if (cap) onCaption?.(cap);
  if (suspended) return;
  const clip = clips.get(name);
  if (!clip) return;
  try { playClip(clip, { bus: name.startsWith("ui-") ? "interface" : "effects" }); } catch { clips.delete(name); if (!queue.includes(name)) queue.push(name); }
}

// -- the ambient bed and the music pad ------------------------------------------------------------
const RATE = 22050;
const AMB_N = RATE * 2;
const amb = new Float32Array(AMB_N);
let ambPos = 0, ambY1 = 0, ambY2 = 0;
const ambRng = Rules.makeRng(0xa3b1);
/** _startAmbience: white noise ×0.4 through a 500 Hz lowpass (two one-pole stages, run twice round so the loop joins). */
function renderAmbience(count: number): boolean {
  const k = 1 - Math.exp((-2 * Math.PI * 500) / RATE);
  const end = Math.min(2 * AMB_N, ambPos + count);
  for (; ambPos < end; ambPos++) {
    const i = ambPos % AMB_N;
    if (ambPos < AMB_N) amb[i] = ((ambRng.next() / 4294967296) * 2 - 1) * 0.4;
    else {
      ambY1 += k * (amb[i]! - ambY1);
      ambY2 += k * (ambY1 - ambY2);
      amb[i] = ambY2 * 1.6;
    }
  }
  return ambPos >= 2 * AMB_N;
}

/** _startMusic: one step each 2.2 s over [0, 2, 4, 3, 1, 5, 2, 0] of the pentatonic scale. */
const STEP = 2.2, STEPS = 8;
const LOOP_N = Math.round(RATE * STEPS * STEP);
const SCALE = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3];
const PATTERN = [0, 2, 4, 3, 1, 5, 2, 0];
const musicBuf = new Float32Array(LOOP_N);
// blip(): variantSeed 0 detunes every pad note alike (±12.5 % from the seeded stream).
const DETUNE = (() => { const r = Rules.makeRng(0); return 1 + (r.range(100) - 50) / 400; })();
let note = 0;
/** blip(): gain 0 → peak in 10 ms (linear), then exponentially to 0.001 at `dur`; wraps round the loop. */
function renderNote(t0: number, f: number, peak: number, dur: number, tri: boolean): void {
  const len = Math.round((dur + 0.05) * RATE), start = Math.round(t0 * RATE);
  for (let i = 0; i < len; i++) {
    const t = i / RATE;
    const env = t < 0.01 ? peak * (t / 0.01) : t < dur ? peak * Math.pow(0.001 / peak, (t - 0.01) / (dur - 0.01)) : 0;
    const ph = (f * DETUNE * t) % 1;
    const w = tri ? 1 - 4 * Math.abs(ph - 0.5) : Math.sin(ph * 2 * Math.PI);
    musicBuf[(start + i) % LOOP_N] = musicBuf[(start + i) % LOOP_N]! + w * env;
  }
}
function renderMusic(): boolean {
  if (note >= STEPS) return true;
  const f = SCALE[PATTERN[note]!]!;
  renderNote(note * STEP, f, 0.12, 1.6, false);
  if (note % 2 === 0) renderNote(note * STEP, f / 2, 0.08, 2.2, true);
  note++;
  return false;
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

/** Each frame: the clips once the mixer runs (one at a time), then the bed and the pad. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of SFX) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
    return;
  }
  if (loading) return;
  if (!ambClip) {
    if (!renderAmbience(8000)) return;
    try { ambClip = createClip([amb], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); ambPos = 0; }
    return;
  }
  if (!ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: suspended ? 0 : AMB_GAIN, loop: true }); } catch { ambVoice = null; }
    return;
  }
  if (!musicClip) {
    if (!renderMusic()) return;
    try { musicClip = createClip([musicBuf], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); }
    return;
  }
  if (!musicVoice) {
    try { musicVoice = playClip(musicClip, { bus: "music", gain: suspended ? 0 : 1, loop: true }); } catch { musicVoice = null; }
  }
}
