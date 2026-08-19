/**
 * Pocket Companion — bootstrap + controller.
 * Owns the game-state machine:
 *   boot → title → profile-ready → mode-select → preparing → tutorial/countdown
 *        → active ↔ paused → resolving → results → progression
 * Wires platform, storage, audio, render, session, and UI modules.
 */
import * as rules from './rules.js';
import * as content from './content.js';
import { Session } from './session.js';
import { Store, ACHIEVEMENTS, DEFAULT_SETTINGS } from './storage.js';
import { Platform } from './platform.js';
import { AudioEngine } from './audio.js';
import { Renderer3D, webglAvailable } from './render.js';
import { UI } from './ui.js';

const NEED_BEST_ACTION = {
  hunger: ['feed', 'snack'], hygiene: ['wash'],
  fun: ['play', 'toss', 'sing', 'pet'], energy: ['rest'],
};

class Game {
  constructor() {
    this.store = new Store();
    this.platform = new Platform();
    this.audio = new AudioEngine(() => this.store.profile.settings);
    this.ui = new UI(this._uiHandlers());
    this.renderer = null;
    this.session = null;
    this.mode = null;
    this.pendingConfig = null;
    this.pendingOptions = null;
    this.lesson = null;
    this.lessonStep = 0;
    this.lastSetup = null;
    this._hudRaf = 0;
    this._resolving = false;
    this.machine = 'boot';
    this._boardContext = null;
  }

  /* ================= boot ================= */
  async boot() {
    const s = this.store.profile.settings;
    this.ui.applyAccessibilityClasses(s);
    this.ui.renderSettings({ ...s, _name: this.store.profile.name }, (patch) => this._settingsChanged(patch));
    this.audio.armUnlockOnGesture();
    this.audio.onCaption = (t) => this.ui.caption(t);

    // Renderer (optional — the game stays playable without WebGL).
    const field = document.getElementById('playfield');
    if (webglAvailable()) {
      this.renderer = new Renderer3D(field, { decorSeed: 1 });
      const tier = this._resolveTier();
      if (!this.renderer.init(tier)) this.renderer = null;
      else {
        this.renderer.setReducedMotion(s.reducedMotion);
        this.renderer.onCreatureTap = () => this._creatureTapped();
        this.renderer.start();
      }
    }
    if (!this.renderer) console.info('[boot] WebGL unavailable — DOM-only mode');

    // Host integration: time sync, identity, presence.
    await this.platform.syncTime();
    const id = await this.platform.loadIdentity();
    if (!id.guest) {
      this.store.profile.name = id.name;
      this.store.saveProfile();
    }
    document.getElementById('profile-chip').textContent = this.store.profile.name;

    this._refreshTitle();
    this.ui.showScreen('title');
    this.machine = 'profile-ready';
    this.platform.telemetry('start', 'boot', s.telemetryConsent);

    // Lifecycle: backgrounding pauses solo play and rendering.
    document.addEventListener('visibilitychange', () => {
      const hidden = document.hidden;
      if (this.renderer) this.renderer.setHidden(hidden);
      this.audio.duck(hidden);
      if (hidden && this.machine === 'active') this._pause(true);
    });
    window.addEventListener('resize', () => this.renderer?.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.renderer?.resize(), 60));

    // Offer resume of the last safe snapshot.
    const snap = this.store.loadSessionSnapshot();
    if (snap && snap.snapshot && snap.contentId) this._offerResume(snap);
  }

  _resolveTier() {
    const t = this.store.profile.settings.graphicsTier;
    if (t !== 'auto') return t;
    const cores = navigator.hardwareConcurrency || 4;
    const mobile = /Mobi|Android/i.test(navigator.userAgent);
    return mobile || cores <= 4 ? 'medium' : 'high';
  }

  _refreshTitle() {
    const p = this.store.profile;
    const today = content.dailyKeyFor(new Date(this.platform.now()));
    document.getElementById('daily-status').textContent =
      p.daily[today] ? `Done today — ${p.daily[today].score} pts` : `Not yet played · ${today}`;
    const done = Object.keys(p.journey).length;
    document.getElementById('journey-status').textContent = `${done} / ${content.JOURNEY_STAGES.length} stages`;
  }

  _offerResume(snap) {
    const cfg = this._findContent(snap.contentId);
    if (!cfg) { this.store.clearSessionSnapshot(); return; }
    const card = document.createElement('button');
    card.className = 'card';
    card.innerHTML = `<strong>Resume session</strong><span class="card-sub">${cfg.name} · tick ${snap.snapshot.tick ?? 0}</span>`;
    card.addEventListener('click', () => {
      try {
        const { session, away } = Session.restore(cfg, snap.snapshot, { mode: snap.mode, envelope: snap.envelope });
        this.session = session;
        this.mode = snap.mode;
        this._enterPlayfield(cfg);
        this.ui.toast(`Welcome back — ${away.ticks} ticks passed while you were away`);
        this.ui.announce(`Session resumed. ${away.ticks} ticks passed while you were away.`);
      } catch (e) {
        console.warn('[resume] failed', e);
        this.store.clearSessionSnapshot();
      }
      card.remove();
    });
    document.querySelector('.title-cards').appendChild(card);
  }

  _findContent(id) {
    return content.getStage(id) ||
      content.challengeConfig(id) ||
      (id.startsWith('daily-') ? content.dailyConfig(id.slice(6)) : null) ||
      (id.startsWith('practice-') ? content.practiceConfig(id.slice(9), 1) : null) ||
      (id.startsWith('chase-') ? content.scoreChaseConfig(Number(id.slice(6))) : null);
  }

  /* ================= UI intents ================= */
  _uiHandlers() {
    return {
      goto: (where) => this._goto(where),
      startMode: (mode) => this._startMode(mode),
      beginSession: () => this._beginSession(),
      stageStart: (id) => this._prepareStage(id),
      lessonStart: (id) => this._startLesson(id),
      action: (type) => this._act(type),
      keyAction: (type) => this._act(type === 'decorate' ? null : type) ?? (type === 'decorate' && this._openDecor()),
      decorate: (item) => this._act('decorate', { item }),
      openDecor: () => this._openDecor(),
      hoverAction: (id, legal) => this.renderer?.highlight(id == null ? null : legal),
      pause: () => this._pause(),
      resume: (fromOverlay) => this._resume(fromOverlay),
      leave: () => this._leave(),
      undo: () => this._undo(),
      hint: () => this._hint(),
      camera: () => this.renderer && this.ui.toast('Camera recentered'),
      retry: () => this._retry(),
      next: () => this._next(),
      boardTab: (friends) => this._loadBoard(friends),
      settingsChanged: (patch) => this._settingsChanged(patch),
    };
  }

  _goto(where) {
    this.audio.event('ui-open');
    if (where === 'journey') {
      const unlocked = this._journeyUnlockedCount();
      this.ui.renderJourney(content.JOURNEY_STAGES, this.store.profile.journey, unlocked);
    } else if (where === 'profile') {
      this._renderProfile();
    } else if (where === 'title') {
      this._refreshTitle();
    }
    this.ui.showScreen(where);
  }

  _journeyUnlockedCount() {
    const stages = content.JOURNEY_STAGES;
    let n = 1;
    for (let i = 0; i < stages.length - 1; i++) {
      if (this.store.profile.journey[stages[i].id]) n = i + 2;
      else break;
    }
    return Math.min(n, stages.length);
  }

  /* ================= mode setup ================= */
  _startMode(mode) {
    this.audio.event('ui-open');
    this.mode = mode;
    if (mode === 'learn') {
      this.ui.renderLessons(content.LESSONS, this.store.profile.settings.tutorialSeen || {});
      this.ui.showScreen('learn');
      return;
    }
    if (mode === 'journey') { this._goto('journey'); return; }

    if (mode === 'daily') {
      const cfg = content.dailyConfig(content.dailyKeyFor(new Date(this.platform.now())));
      const done = this.store.profile.daily[cfg.dailyKey];
      this._prepare(cfg, {
        ranked: this._isRankable(),
        extra: done ? `<p class="muted">You already completed today's challenge (${done.score} pts) — replays are casual.</p>` : '',
      });
    } else if (mode === 'practice') {
      this.pendingOptions = { kind: 'practice', choices: content.PRACTICE_DIFFICULTIES.map((d) => d.id), picked: 'steady' };
      const cfg = content.practiceConfig('steady', (Math.random() * 0xffffffff) >>> 0);
      this._prepare(cfg, { ranked: false, options: this._optionsHTML('practice', content.PRACTICE_DIFFICULTIES.map((d) => [d.id, d.name])) });
    } else if (mode === 'challenge') {
      this.pendingOptions = { kind: 'challenge', choices: content.CHALLENGES.map((c) => c.id), picked: content.CHALLENGES[0].id };
      const cfg = content.challengeConfig(content.CHALLENGES[0].id);
      this._prepare(cfg, { ranked: this._isRankable(), options: this._optionsHTML('challenge', content.CHALLENGES.map((c) => [c.id, c.name])) });
    } else if (mode === 'chase') {
      const seed = (rules.fnv1a('chase:' + content.dailyKeyFor(new Date(this.platform.now()))) >>> 0);
      const cfg = content.scoreChaseConfig(seed);
      this._prepare(cfg, { ranked: this._isRankable() });
    }
  }

  _optionsHTML(kind, choices) {
    return choices.map(([id, name]) =>
      `<button class="btn setup-choice" data-kind="${kind}" data-id="${id}">${name}</button>`).join('');
  }

  _prepare(cfg, opts = {}) {
    this.pendingConfig = cfg;
    const rulesText = [
      cfg.allowedActions.map((a) => rules.ACTIONS[a]?.label || a).join(', '),
      cfg.tickLimit ? `${cfg.tickLimit}-tick limit` : 'no time limit',
      cfg.maxCommands ? `${cfg.maxCommands}-move limit` : null,
    ].filter(Boolean).join(' · ');
    this.ui.renderSetup({
      name: cfg.name,
      intro: (opts.extra || '') + (cfg.intro || ''),
      rules: rulesText,
      duration: `~${Math.max(1, Math.round(cfg.tickLimit / 40))} min`,
      ranked: opts.ranked,
      rankedLabel: opts.ranked ? 'Ranked' : 'Casual — not ranked',
      optionsHTML: opts.options || '',
    });
    this.ui.showScreen('setup');
    // Bind setup choice buttons.
    document.querySelectorAll('.setup-choice').forEach((b) => {
      b.addEventListener('click', () => {
        const { kind, id } = b.dataset;
        this.pendingOptions.picked = id;
        const cfg2 = kind === 'practice'
          ? content.practiceConfig(id, (Math.random() * 0xffffffff) >>> 0)
          : content.challengeConfig(id);
        this._prepare(cfg2, { ranked: kind === 'challenge' && this._isRankable(), options: this._optionsHTML(kind, kind === 'practice' ? content.PRACTICE_DIFFICULTIES.map((d) => [d.id, d.name]) : content.CHALLENGES.map((c) => [c.id, c.name])) });
      });
    });
    this.machine = 'preparing';
  }

  _prepareStage(stageId) {
    const cfg = content.getStage(stageId);
    if (!cfg) return;
    this.mode = 'journey';
    this._prepare(cfg, { ranked: false });
  }

  _isRankable() {
    return !this.store.profile.settings.timingAssist;
  }

  _startLesson(lessonId) {
    const lesson = content.getLesson(lessonId);
    if (!lesson) return;
    this.lesson = lesson;
    this.lessonStep = 0;
    const cfg = content.getStage(lesson.stageId);
    this.mode = 'learn';
    this.pendingConfig = cfg;
    this._beginSession();
  }

  /* ================= session lifecycle ================= */
  _beginSession() {
    const cfg = JSON.parse(JSON.stringify(this.pendingConfig)); // detach
    const s = this.store.profile.settings;
    const assists = [];
    if (s.timingAssist) {
      for (const k of Object.keys(cfg.decay)) cfg.decay[k] = Math.max(1, Math.round(cfg.decay[k] / 2));
      assists.push('timing-assist');
    }
    const undo = this.mode === 'practice' || this.mode === 'learn';
    const ranked = this._isRankable() && (this.mode === 'daily' || this.mode === 'challenge' || this.mode === 'chase');
    this.session = new Session(cfg, { mode: this.mode, undo, ranked, timestampOffset: this.platform.timeOffset, assists });
    this.lastSetup = { cfg, mode: this.mode };
    this.store.clearSessionSnapshot();
    this._enterPlayfield(cfg);
    this.platform.startActivity(this.mode);
    this.platform.startPresence();
    this.platform.telemetry('start', this.mode + ':' + cfg.id, s.telemetryConsent);
  }

  _enterPlayfield(cfg) {
    this.machine = 'active';
    this.ui.closeAllOverlays();
    this.ui.showScreen('game');
    // The playfield was display:none at boot — resize now that it has layout.
    if (this.renderer) requestAnimationFrame(() => { this.renderer.resize(); this.renderer.start(); });
    this.ui.buildActionTray(this.session.legal, this.store.profile.settings.keybinds);
    this.ui.el('btn-undo').style.display = this.session.undoEnabled ? '' : 'none';
    this.ui.setCompatMessage(!this.renderer);
    if (this.renderer) {
      this.renderer.setTheme(cfg.theme || content.DEFAULT_THEME);
      this.renderer.setDecor(this.session.state.decorPlaced);
      this.renderer.decorSeed = cfg.seed;
      this.renderer.setMood(rules.moodOf(this.session.state));
    }
    this.ui.renderHelp(this.session.legal, this.store.profile.settings.keybinds);
    this._updateHUD();
    this._hudLoop();
    this._saveSnapshot();
    this.ui.announce(`${cfg.name}. ${this._objectiveText(cfg)}. Session started.`, true);
    if (this.lesson) this._showLessonStep();
  }

  _hudLoop() {
    cancelAnimationFrame(this._hudRaf);
    const tick = () => {
      if (this.machine !== 'active' && this.machine !== 'paused') return;
      if (this.renderer?.ok) {
        this.ui.positionCravingBubble(this.renderer.anchorToScreen('creature'));
      }
      this._hudRaf = requestAnimationFrame(tick);
    };
    this._hudRaf = requestAnimationFrame(tick);
  }

  /* ================= actions ================= */
  _act(type, args = {}) {
    if (!this.session || this.machine !== 'active' || this._resolving) return;
    if (!type) return;
    this._resolving = true; // input locked during the shortest resolution phase
    const prevBond = this.session.bondLevel;
    const before = { ...this.session.state.needs };
    const result = this.session.act(type, args);
    const st = this.session.state;

    if (!result.ok) {
      this.audio.event('invalid');
      this.renderer?.invalidWobble();
      const reason = rules.INVALID_REASONS[result.reason] || 'Not possible right now.';
      this.ui.announce(reason, true);
      this.ui.toast(reason);
      this._haptic(30);
      this._lessonProgress(type, result, before); // lessons may require a refusal
      this._afterAction(st);
      this._resolving = false;
      return;
    }

    // Presentation: audio + render reaction + float text.
    this.audio.event(st.lastEvent?.action || type, st.seed + st.tick);
    if (result.discoveryGain > 0) {
      this.audio.event('discovery');
      const label = rules.ACTIONS[type]?.label || type;
      this.ui.toast(`Discovered: ${label}! +${result.discoveryGain}`);
      this.store.recordDiscovery(type);
      if (type === 'decorate' && args.item) this.store.recordDiscovery('decor:' + args.item);
    }
    if (result.cravingBonus) this.audio.event('craving-met');
    const newBond = this.session.bondLevel;
    if (newBond > prevBond) {
      this.audio.event('bond-up');
      this.ui.toast(`Bond level ${newBond}!`);
      this.ui.announce(`Bond level up — level ${newBond}.`);
    }
    if (this.renderer) {
      this.renderer.react(st.lastEvent?.action || type, rules.ACTIONS[type]?.kind || 'pass', {
        discovery: result.discoveryGain > 0, cravingMet: result.cravingBonus,
      });
      this.renderer.setMood(rules.moodOf(st));
      if (type === 'decorate') this.renderer.setDecor(st.decorPlaced);
      const pos = this.renderer.anchorToScreen('creature');
      if (pos && !pos.behind) {
        const field = document.getElementById('playfield').getBoundingClientRect();
        const gain = result.careGain + result.discoveryGain;
        if (gain > 0) this.ui.floatText(pos.x - field.left, pos.y - field.top, `+${gain}`);
      }
    }
    this._haptic(12);
    this._lessonProgress(type, result, before);

    if (this.session.terminal) {
      this._afterAction(st);
      this._finishSession();
      // Cosmetic animation may continue, but the logical state is settled.
      this._resolving = false;
      return;
    }
    this._afterAction(st);
    this._resolving = false;
  }

  _afterAction(st) {
    this.ui.refreshActionTray(this.session.legal);
    this._updateHUD();
    this._saveSnapshot();
    if (st.craving && !this._cravingAnnounced) {
      this._cravingAnnounced = true;
      this.audio.event('craving');
      this.ui.announce(`Mote ${st.craving.need === 'hunger' ? 'is hungry' : st.craving.need === 'hygiene' ? 'wants a bath' : st.craving.need === 'fun' ? 'wants to play' : 'is sleepy'}.`);
    } else if (!st.craving) {
      this._cravingAnnounced = false;
    }
  }

  _creatureTapped() {
    // Tapping Mote performs a contextual pet when legal.
    if (this.session && this.session.legal.some((a) => a.id === 'pet' && a.legal)) this._act('pet');
    else if (this.session) this.ui.announce('Mote wiggles happily.');
  }

  _openDecor() {
    if (!this.session) return;
    this.ui.renderDecor(this.session.state.allowedDecor, this.session.state.decorPlaced);
    this.ui.openOverlay('decor');
  }

  _undo() {
    if (!this.session || !this.session.undoEnabled) return;
    if (this.session.undo()) {
      this.audio.event('ui-close');
      this.ui.toast('Undone');
      this._afterAction(this.session.state);
      if (this.renderer) {
        this.renderer.setMood(rules.moodOf(this.session.state));
        this.renderer.setDecor(this.session.state.decorPlaced);
      }
    } else {
      this.ui.announce('Nothing to undo.');
    }
  }

  _hint() {
    if (!this.session || this.machine !== 'active') return;
    const legal = this.session.legal;
    const st = this.session.state;
    // Tutorial/hints use the same legal-action API as play.
    let suggestion = null;
    if (st.craving) {
      for (const id of NEED_BEST_ACTION[st.craving.need]) {
        if (legal.some((a) => a.id === id && a.legal)) { suggestion = id; break; }
      }
    }
    if (!suggestion) {
      const lowest = [...rules.NEEDS].sort((a, b) => st.needs[a] - st.needs[b])[0];
      for (const id of NEED_BEST_ACTION[lowest]) {
        if (legal.some((a) => a.id === id && a.legal)) { suggestion = id; break; }
      }
    }
    if (!suggestion) suggestion = legal.find((a) => a.legal && a.kind !== 'pass')?.id
      || legal.find((a) => a.legal)?.id; // last resort: pass the time
    this.ui.markSuggested(suggestion);
    if (suggestion) {
      const def = rules.ACTIONS[suggestion];
      this.ui.announce(`Hint: try ${def.label}. ${def.blurb}`);
      this.ui.toast(`Hint: ${def.label}`);
    }
  }

  /* ================= pause / leave ================= */
  _pause(auto = false) {
    if (!this.session || this.machine !== 'active') return;
    this.machine = 'paused';
    this.session.markAwayBaseline();
    if (!auto) this.ui.openOverlay('pause');
    this.audio.event('ui-open');
  }

  _resume(fromOverlay) {
    if (this.machine !== 'paused') return;
    this.machine = 'active';
    if (!fromOverlay) this.ui.closeOverlay('pause');
    const away = this.session.awaySummary();
    if (away && away.ticks > 0) this.ui.toast(`While paused: ${away.ticks} ticks, ${away.scoreDelta} pts`);
    this.audio.event('ui-close');
  }

  _leave() {
    this.ui.closeAllOverlays();
    this._endPlayfield();
    this._goto('modes');
  }

  _endPlayfield() {
    cancelAnimationFrame(this._hudRaf);
    this.ui.hideLessonBanner();
    this.lesson = null;
    this.platform.endActivity(this.mode);
    this.platform.stopPresence();
    this.session = null;
    this.machine = 'profile-ready';
  }

  _retry() {
    if (!this.lastSetup) return this._goto('modes');
    this.pendingConfig = this.lastSetup.cfg;
    this.mode = this.lastSetup.mode;
    this.platform.telemetry('retry', this.lastSetup.cfg.id, this.store.profile.settings.telemetryConsent);
    this._beginSession();
  }

  _next() {
    if (this.lastSetup?.mode === 'journey') {
      const stages = content.JOURNEY_STAGES;
      const idx = stages.findIndex((s) => s.id === this.lastSetup.cfg.id);
      const next = stages[idx + 1];
      if (next && idx + 1 < this._journeyUnlockedCount()) {
        this._prepareStage(next.id);
        this._beginSession();
        return;
      }
    }
    this._goto('modes');
  }

  /* ================= lessons ================= */
  _showLessonStep() {
    const step = this.lesson.steps[this.lessonStep];
    if (!step) return;
    this.ui.showLessonBanner(`<strong>${this.lesson.title}</strong> — ${step.text}`);
    this.platform.telemetry('tutorial-step', `${this.lesson.id}:${this.lessonStep}`, this.store.profile.settings.telemetryConsent);
  }

  _lessonProgress(type, result, before) {
    if (!this.lesson || this.machine !== 'active') return;
    const step = this.lesson.steps[this.lessonStep];
    if (!step) return;
    let done = false;
    if (step.require.action && result.ok && type === step.require.action) done = true;
    if (step.require.invalid && !result.ok && type === step.require.invalid) done = true;
    if (step.require.craving && result.cravingBonus) done = true;
    if (done) {
      this.lessonStep++;
      this.audio.event('ack');
      if (this.lessonStep >= this.lesson.steps.length) {
        this.store.profile.settings.tutorialSeen[this.lesson.id] = true;
        this.store.saveProfile();
        this.ui.hideLessonBanner();
        this.ui.toast('Lesson complete! Finish the stage to keep going.');
        this.ui.announce('Lesson complete. You can finish the stage now.');
        this.lesson = null;
      } else {
        this._showLessonStep();
      }
    }
  }

  /* ================= results & progression ================= */
  _finishSession() {
    this.machine = 'results';
    const st = this.session.state;
    const score = this.session.score;
    const cfg = this.session.content;
    const p = this.store.profile;
    const completed = st.status === 'complete';

    this.audio.event(completed ? 'complete' : st.status === 'neglected' ? 'neglected' : 'expired');
    this._haptic([40, 60, 40]);

    // Progression.
    let stars = 0;
    if (this.mode === 'journey' && completed) {
      stars = st.tick <= cfg.par ? 3 : st.tick <= cfg.par * 1.5 ? 2 : 1;
      const prev = p.journey[cfg.id];
      p.journey[cfg.id] = {
        stars: Math.max(stars, prev?.stars || 0),
        bestScore: Math.max(score.total, prev?.bestScore || 0),
        completedAt: Date.now(),
      };
    }
    if (this.mode === 'daily' && completed && cfg.dailyKey) {
      if (!p.daily[cfg.dailyKey]) {
        p.daily[cfg.dailyKey] = { score: score.total, completed: true };
        if (!p.dailyDays.includes(cfg.dailyKey)) p.dailyDays.push(cfg.dailyKey);
      } else if (score.total > p.daily[cfg.dailyKey].score) {
        p.daily[cfg.dailyKey].score = score.total;
      }
    }
    p.sessionsPlayed += 1;
    p.bestScores[cfg.id] = Math.max(p.bestScores[cfg.id] || 0, score.total);
    this.store.saveProfile();

    const newAchievements = this.store.evaluateAchievements(this.session)
      .map((id) => ACHIEVEMENTS.find((a) => a.id === id)?.name).filter(Boolean);

    // Score submission: ranked boards are replay-validated by the host.
    const best = p.bestScores[cfg.id];
    const boardId = this.mode === 'daily' ? `daily:${cfg.dailyKey}` : this.mode === 'chase' ? `chase:${cfg.seed}` : `stage:${cfg.id}`;
    let comparison = score.total >= best ? 'New personal best!' : `Personal best: ${best}`;
    if (this.session.ranked) {
      const replay = this.session.exportReplay();
      this.platform.submitScore(boardId, {
        name: p.name, score: score.total, ticks: st.tick,
        invalidAttempts: st.invalidAttempts, assists: replay.assists,
        contentVersion: replay.contentVersion, seed: replay.seed,
        ruleset: cfg.stageId, duration: st.tick, replay,
      }).then((r) => {
        if (r?.ok) this.ui.toast('Score submitted to the ranked board');
        else if (r?.casual) {
          this.store.submitLocalScore(boardId, { name: p.name, score: score.total, ticks: st.tick, me: true });
          this.ui.toast('Offline — score saved to the casual board');
        } else this.ui.toast('Score rejected: ' + (r?.error || 'unknown'));
      });
    } else {
      this.store.submitLocalScore(boardId, { name: p.name, score: score.total, ticks: st.tick, me: true });
    }

    this._boardContext = { boardId, friends: false };
    const headline = completed
      ? 'Session complete — Mote is thriving!'
      : st.status === 'neglected'
        ? 'Mote got overwhelmed — but nothing is lost. Try again!'
        : 'Time is up — good effort!';
    this.ui.renderResults({
      headline,
      rows: [
        ['Care', score.care], ['Discoveries', score.discovery],
        ['Bond', score.bond], ['Time bonus', score.timeBonus],
        ['Invalid actions', score.invalidAttempts],
        ['Elapsed', `${st.tick} ticks`],
        ...(stars ? [['Stars', '★'.repeat(stars)]] : []),
      ],
      total: score.total,
      comparison,
      achievements: newAchievements,
      hasNext: this.mode === 'journey' && completed,
    });
    this.store.clearSessionSnapshot();
    this.ui.showScreen('results');
    this.platform.endActivity(this.mode);
    this.platform.stopPresence();
    this.platform.telemetry('round-end', `${this.mode}:${st.status}:${score.total}`, p.settings.telemetryConsent);
    // Open the board in the background data, not visually.
  }

  async _loadBoard(friends) {
    if (!this._boardContext) {
      // Default board: today's daily.
      this._boardContext = { boardId: `daily:${content.dailyKeyFor(new Date(this.platform.now()))}`, friends: false };
    }
    this._boardContext.friends = friends;
    const { boardId } = this._boardContext;
    const r = await this.platform.fetchBoard(boardId, { friends });
    let entries, subtitle;
    if (r.ok) {
      entries = r.data.entries || [];
      subtitle = r.data.validated ? 'Validated by replay' : 'Casual board';
    } else {
      entries = this.store.getLocalBoard(boardId);
      subtitle = 'Casual local board (offline)';
    }
    this.ui.renderBoard({
      title: 'Leaderboard — ' + boardId.split(':')[0],
      subtitle: subtitle + (friends ? ' · friends only' : ''),
      entries, friends,
    });
    this.ui.showScreen('board');
  }

  _renderProfile() {
    const p = this.store.profile;
    this.ui.renderProfile({
      sessionsPlayed: p.sessionsPlayed,
      stagesDone: Object.keys(p.journey).length,
      discoveries: p.discoveries.length,
      dailies: Object.keys(p.daily).length,
      achievements: ACHIEVEMENTS.map((a) => ({ ...a, unlocked: !!p.achievements[a.id] })),
    });
  }

  /* ================= settings ================= */
  _settingsChanged(patch) {
    const s = this.store.profile.settings;
    if ('_name' in patch) {
      this.store.profile.name = patch._name || 'Guest';
      document.getElementById('profile-chip').textContent = this.store.profile.name;
    } else {
      Object.assign(s, patch);
    }
    this.store.saveProfile();
    this.ui.applyAccessibilityClasses(s);
    this.audio.applySettings();
    if (this.renderer) {
      this.renderer.setReducedMotion(s.reducedMotion);
      this.renderer.setQuality(this._resolveTier());
    }
    this.platform.telemetry('settings-change', Object.keys(patch).join(','), s.telemetryConsent);
  }

  _haptic(pattern) {
    if (this.store.profile.settings.haptics && navigator.vibrate) navigator.vibrate(pattern);
  }

  _saveSnapshot() {
    if (!this.session) return;
    try {
      this.store.saveSessionSnapshot({
        contentId: this.session.content.id,
        mode: this.mode,
        snapshot: this.session.snapshot(),
        envelope: this.session.exportReplay(),
      });
    } catch { /* storage full — non-fatal */ }
  }

  _objectiveText(cfg) {
    const g = cfg.goals || {};
    const parts = [];
    if (g.bondLevel) parts.push(`reach Bond level ${g.bondLevel}`);
    if (g.care) parts.push(`earn ${g.care} care points`);
    if (g.discoveries) parts.push(`make ${g.discoveries} discoveries`);
    if (g.decor) parts.push(`place ${g.decor} decorations`);
    return parts.length ? 'Objective: ' + parts.join(' and ') : 'Keep Mote happy';
  }

  _updateHUD() {
    const st = this.session.state;
    const cfg = this.session.content;
    const score = this.session.score;
    const g = cfg.goals || {};
    const prog = [];
    if (g.bondLevel) prog.push(`Bond ${this.session.bondLevel}/${g.bondLevel}`);
    if (g.care) prog.push(`Care ${score.care}/${g.care}`);
    if (g.discoveries) prog.push(`Found ${st.discovered.length}/${g.discoveries}`);
    if (g.decor) prog.push(`Decor ${st.decorPlaced.length}/${g.decor}`);
    const lvl = this.session.bondLevel;
    this.ui.updateHUD({
      objective: this._objectiveText(cfg),
      objectiveProgress: prog.join(' · ') || `${st.tickLimit - st.tick} ticks left`,
      needs: st.needs,
      score: score.total,
      scoreDetail: `care ${score.care} · discovery ${score.discovery} · bond ${score.bond} · bonus ${score.timeBonus}`,
      tick: st.tick, tickLimit: st.tickLimit,
      commandCount: st.commandCount, maxCommands: st.maxCommands,
      bondLevel: lvl,
      bondNext: lvl < rules.BOND_LEVELS.length - 1 ? rules.BOND_LEVELS[lvl + 1] : null,
      craving: st.craving,
      mood: rules.moodOf(st),
      canUndo: this.session.undoEnabled && this.session._undoStack.length > 0,
    });
  }
}

/* ================= boot ================= */
const game = new Game();
game.boot().catch((e) => {
  console.error('[boot] fatal', e);
  document.getElementById('live-region').textContent = 'Failed to start: ' + e.message;
});

// Results screen → leaderboard shortcut.
document.getElementById('results-comparison').addEventListener('click', () => game._loadBoard(false));
