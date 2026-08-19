/**
 * Pocket Companion — audio: original synthesized transients on dedicated
 * buses (music / effects / ambience / voice), seeded pitch variants for
 * replay consistency, focus-aware ducking, and caption hooks.
 */
import { makeRng } from './rules.js';

export class AudioEngine {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.ctx = null;
    this.buses = {};
    this._ambienceNodes = null;
    this._musicTimer = null;
    this._musicStep = 0;
    this._pendingUnlock = () => this.unlock();
    this.onCaption = null; // (text) => void
  }

  /** Must be called from a user gesture. Idempotent. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.gain.value = 0.9;
    master.connect(this.ctx.destination);
    this.master = master;
    for (const bus of ['music', 'effects', 'ambience', 'voice']) {
      const g = this.ctx.createGain();
      g.gain.value = this.getSettings()[bus] ?? 0.7;
      g.connect(master);
      this.buses[bus] = g;
    }
    document.removeEventListener('pointerdown', this._pendingUnlock);
    document.removeEventListener('keydown', this._pendingUnlock);
    this._startAmbience();
    this._startMusic();
  }

  armUnlockOnGesture() {
    document.addEventListener('pointerdown', this._pendingUnlock, { once: false });
    document.addEventListener('keydown', this._pendingUnlock, { once: false });
  }

  applySettings() {
    if (!this.ctx) return;
    const s = this.getSettings();
    for (const bus of Object.keys(this.buses)) {
      this.buses[bus].gain.setTargetAtTime(s[bus] ?? 0.7, this.ctx.currentTime, 0.05);
    }
  }

  duck(hidden) {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(hidden ? 0 : 0.9, this.ctx.currentTime, 0.2);
  }

  _caption(text) { if (this.getSettings().captions && this.onCaption) this.onCaption(text); }

  /** Short synthesized transient. variantSeed makes pitch deterministic. */
  blip({ bus = 'effects', type = 'sine', freq = 440, dur = 0.15, gain = 0.5, slide = 0, variantSeed = 0, caption = '' }) {
    if (caption) this._caption(caption);
    if (!this.ctx) return;
    const rng = makeRng(variantSeed >>> 0);
    const detune = 1 + (rng.range(100) - 50) / 400; // ±12.5%
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq * detune, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, (freq + slide) * detune), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g); g.connect(this.buses[bus] || this.master);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  /** Map logical events to sounds (event hierarchy: ack < move < goal < round). */
  event(name, seed = 0) {
    switch (name) {
      case 'ack': this.blip({ freq: 660, dur: 0.07, gain: 0.25, variantSeed: seed }); break;
      case 'invalid': this.blip({ type: 'square', freq: 180, dur: 0.12, gain: 0.2, slide: -60, caption: 'not allowed' }); break;
      case 'feed': this.blip({ type: 'triangle', freq: 320, dur: 0.2, gain: 0.4, slide: 120, variantSeed: seed, caption: 'munch munch' }); break;
      case 'wash': this.blip({ type: 'sine', freq: 900, dur: 0.25, gain: 0.3, slide: 400, variantSeed: seed, caption: 'splish splash' }); break;
      case 'play': this.blip({ type: 'square', freq: 520, dur: 0.12, gain: 0.3, slide: 200, variantSeed: seed, caption: 'boing!' }); break;
      case 'rest': this.blip({ type: 'sine', freq: 260, dur: 0.5, gain: 0.3, slide: -80, caption: 'zzz…' }); break;
      case 'pet': this.blip({ type: 'sine', freq: 740, dur: 0.14, gain: 0.3, slide: 120, variantSeed: seed, caption: 'purr' }); break;
      case 'sing': this._melody([523, 659, 784], 0.14, seed, 'la la la'); break;
      case 'toss': this.blip({ type: 'triangle', freq: 440, dur: 0.16, gain: 0.35, slide: 330, variantSeed: seed, caption: 'wheee!' }); break;
      case 'snack': this.blip({ type: 'triangle', freq: 500, dur: 0.12, gain: 0.35, slide: 60, variantSeed: seed, caption: 'nom' }); break;
      case 'decorate': this.blip({ type: 'triangle', freq: 620, dur: 0.2, gain: 0.35, slide: 160, caption: 'placed!' }); break;
      case 'craving': this.blip({ bus: 'voice', freq: 880, dur: 0.18, gain: 0.3, slide: 220, caption: 'Mote wishes for something…' }); break;
      case 'craving-met': this._melody([784, 988], 0.1, seed, 'wish granted!'); break;
      case 'discovery': this._melody([659, 784, 1047], 0.12, seed, 'new discovery!'); break;
      case 'bond-up': this._melody([523, 698, 880, 1047], 0.12, seed, 'bond level up!'); break;
      case 'complete': this._melody([523, 659, 784, 1047, 1319], 0.16, seed, 'session complete!'); break;
      case 'expired': this._melody([440, 392, 330], 0.2, seed, 'time is up'); break;
      case 'neglected': this._melody([330, 294, 262], 0.25, seed, 'Mote needs you'); break;
      case 'ui-open': this.blip({ freq: 520, dur: 0.06, gain: 0.2 }); break;
      case 'ui-close': this.blip({ freq: 390, dur: 0.06, gain: 0.2 }); break;
    }
  }

  _melody(freqs, step, seed, caption) {
    if (caption) this._caption(caption);
    freqs.forEach((f, i) => {
      setTimeout(() => this.blip({ freq: f, dur: step * 1.6, gain: 0.3, variantSeed: seed + i }), i * step * 1000);
    });
  }

  /** Quiet ambient bed — filtered noise shaped per theme. */
  _startAmbience() {
    if (!this.ctx || this._ambienceNodes) return;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.4;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 500; filt.Q.value = 0.4;
    const g = this.ctx.createGain(); g.gain.value = 0.15;
    src.connect(filt); filt.connect(g); g.connect(this.buses.ambience);
    src.start();
    this._ambienceNodes = { src, filt, g };
  }

  /** Adaptive music: a slow pentatonic pad; intensity follows average need. */
  _startMusic() {
    if (!this.ctx || this._musicTimer) return;
    const scale = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3];
    this._musicTimer = setInterval(() => {
      if (document.hidden) return;
      const step = this._musicStep++;
      const f = scale[[0, 2, 4, 3, 1, 5, 2, 0][step % 8]];
      this.blip({ bus: 'music', type: 'sine', freq: f, dur: 1.6, gain: 0.12 });
      if (step % 2 === 0) this.blip({ bus: 'music', type: 'triangle', freq: f / 2, dur: 2.2, gain: 0.08 });
    }, 2200);
  }

  stopMusic() { clearInterval(this._musicTimer); this._musicTimer = null; }
}
