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
import { Store, ACHIEVEMENTS, DEFAULT_SETTINGS, migrateProfile, mergeProfile, mergeBoards } from './storage.js';
import { Platform } from './platform.js';
import { platformStrings, pickPlatformLocale } from './platform-i18n.js';
import { t, getLocale, onLocaleChange, contentName } from './i18n.js';

// StarHermit account strings in the game language (read at use time).
const ps = () => platformStrings(pickPlatformLocale(getLocale()));
import { AudioEngine } from './audio.js';
import { Renderer3D, webglAvailable } from './render.js';
import { resolve as resolveGfx } from './gfx.js';
import { UI, DEFAULT_BINDINGS } from './ui.js';

const NEED_BEST_ACTION = {
  hunger: ['feed', 'snack'], hygiene: ['wash'],
  fun: ['play', 'toss', 'sing', 'pet'], energy: ['rest'],
};

class Game {
  constructor() {
    this.store = new Store();
    this.platform = new Platform();
    this.store.onSaved = () => this.platform.scheduleCloudSave();
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
    // Host integration first: launch token, cloud doc (merged with local
    // progress, local doc backed up), then platform identity. Each
    // step degrades gracefully to local guest play.
    this.platform.init();
    this.platform.docProvider = () => ({ profile: this.store.profile, boards: this.store.allBoards() });
    this._wirePlatform();
    if (this.platform.hosted) {
      this.platform.attachFlush();
      this.platform.onSyncChange = () => this._renderAccountLine();
      try {
        const remote = await this.platform.cloudLoad();
        if (remote) this._applyRemoteDoc(remote);
      } catch (e) {
        console.warn('[cloud] load failed, keeping local progress', e);
      }
      await this._applyRemoteSettings();
    }
    this.platform.loadBindings(DEFAULT_BINDINGS).then((b) => {
      this.ui.setBindings(b);
      if (this.session) this.ui.buildActionTray(this.session.legal);
    });

    const s = this.store.profile.settings;
    this.ui.applyAccessibilityClasses(s);
    this.ui.renderSettings({ ...s, _name: this.store.profile.name, _hosted: this.platform.hosted }, (patch) => this._settingsChanged(patch));
    this.audio.armUnlockOnGesture();
    this.audio.onCaption = (text) => this.ui.caption(t(text));

    // Renderer (optional — the game stays playable without WebGL).
    const field = document.getElementById('playfield');
    if (webglAvailable()) {
      this.renderer = new Renderer3D(field, { decorSeed: 1 });
      if (!this.renderer.init(s.gfx)) this.renderer = null;
      else {
        this.renderer.setReducedMotion(s.reducedMotion);
        this.renderer.onCreatureTap = () => this._creatureTapped();
        this.renderer.start();
      }
    }
    if (!this.renderer) {
      console.info('[boot] WebGL unavailable — DOM-only mode');
      document.body.dataset.gfxPreset = resolveGfx(s.gfx, 'low').preset;
    }
    this.ui.renderGraphics(s.gfx, (words) => this.renderer?.graphicsInfo(words) ?? null, (gfx) => this._settingsChanged({ gfx }));

    // Host integration: account identity (device clock; no own-server calls).
    const id = await this.platform.loadIdentity();
    if (!id.guest) {
      this.store.profile.name = id.name;
      this.store.saveProfile();
    }
    this._renderAccountLine();

    this._refreshTitle();
    this.ui.showScreen('title');
    this.machine = 'profile-ready';

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

  _refreshTitle() {
    const p = this.store.profile;
    const today = content.dailyKeyFor(new Date(this.platform.now()));
    document.getElementById('daily-status').textContent =
      p.daily[today] ? t('Done today — {score} pts', { score: p.daily[today].score }) : t('Not yet played · {date}', { date: today });
    const done = Object.keys(p.journey).length;
    document.getElementById('journey-status').textContent = t('{done} / {total} stages', { done, total: content.JOURNEY_STAGES.length });
  }

  /**
   * Merge a cloud doc into this device's progress (start-up load and
   * `saveconflict`): best of both per record, nothing dropped (the local doc is
   * backed up first). Settings come from the cloud copy at start-up and stay
   * this device's on a conflict. The merged doc is then saved back.
   */
  _applyRemoteDoc(remote, { keepLocalSettings = false } = {}) {
    try {
      this.platform.suspendSave(() => {
        this.store.backupProfile();
        if (remote && typeof remote === 'object') {
          if (remote.profile) this.store.profile = mergeProfile(migrateProfile(remote.profile), this.store.profile, { keepLocalSettings });
          if (remote.boards && typeof remote.boards === 'object') this.store.replaceBoards(mergeBoards(remote.boards, this.store.allBoards()));
        }
        this.store.saveProfile();
      });
      this.platform.scheduleCloudSave();
      if (!keepLocalSettings) this.ui.toast(t('Progress synced from your account'));
    } catch (e) {
      console.warn('[cloud] apply failed', e);
    }
  }

  /** Platform settings KV wins over local values for known preference keys. */
  async _applyRemoteSettings() {
    const remote = await this.platform.loadRemoteSettings();
    const s = this.store.profile.settings;
    this.platform.suspendSave(() => {
      let changed = false;
      for (const [k, v] of Object.entries(remote)) {
        // platform-owned ui.* keys (ui.language) are not game settings
        if (k.startsWith('ui.') || !(k in DEFAULT_SETTINGS) || v == null) continue;
        if (typeof v !== typeof DEFAULT_SETTINGS[k] || JSON.stringify(s[k]) === JSON.stringify(v)) continue;
        s[k] = v;
        changed = true;
      }
      if (changed) this.store.saveProfile();
    });
    this.platform.syncSettings(this._prefs());
  }

  /** Player preferences mirrored to the StarHermit settings KV. */
  _prefs() {
    const s = this.store.profile.settings;
    return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, s[k]]));
  }

  /** Sign-in / invite buttons on the title, sign-out handling. */
  _wirePlatform() {
    const signIn = document.getElementById('btn-signin');
    const invite = document.getElementById('btn-invite');
    const label = () => { signIn.textContent = ps().signIn; invite.textContent = ps().invite; };
    label();
    onLocaleChange(label);
    signIn.addEventListener('click', () => this.platform.signIn());
    invite.addEventListener('click', async () => {
      const link = this.platform.inviteLink();
      if (!link) return;
      try {
        await navigator.clipboard.writeText(link);
        this.ui.toast(ps().inviteCopied);
      } catch {
        this.ui.toast(ps().inviteFailed.replace('{link}', link));
      }
    });
    this.platform.onAuthChange = ({ signedIn }) => {
      if (!signedIn) this.ui.toast(ps().signedOut);
      this._renderAccountLine();
    };
    // Another device saved first: reload, merge (best of both; this device's
    // settings and session kept), save the merged doc again.
    this.platform.onSaveConflict = (remote) => {
      if (remote) this._applyRemoteDoc(remote, { keepLocalSettings: true });
      else this.platform.scheduleCloudSave();
      this._renderAccountLine();
    };
    onLocaleChange(() => this._relocalize());
  }

  /**
   * Live language switching: static markup is re-applied by i18n.js; screens,
   * HUD, tray, lesson banner and settings built in code re-render in place.
   * The session and its clock are untouched.
   */
  _relocalize() {
    this.ui.relabel();
    this._renderAccountLine();
    this._refreshTitle();
    const screen = document.querySelector('.screen.active')?.id?.replace('screen-', '');
    if (screen === 'journey') this.ui.renderJourney(content.JOURNEY_STAGES, this.store.profile.journey, this._journeyUnlockedCount());
    if (screen === 'learn') this.ui.renderLessons(content.LESSONS, this.store.profile.settings.tutorialSeen || {});
    if (screen === 'profile') this._renderProfile();
    if (screen === 'setup' && this._lastPrepare) this._prepare(...this._lastPrepare);
    if (screen === 'results' && this._results) this.ui.renderResults({ ...this._results(), quiet: true });
    if (screen === 'board' && this._boardContext) this._loadBoard(this._boardContext.friends);
    if (this._lb) this._refreshLeaderboardLine();
    if (this.session && (this.machine === 'active' || this.machine === 'paused')) {
      this._updateHUD();
      if (this.lesson) this._showLessonStep(true);
      if (!document.getElementById('overlay-decor').classList.contains('hidden')) this.ui.renderDecor(this.session.state.allowedDecor, this.session.state.decorPlaced);
    }
  }

  /** Profile chip (+ avatar) + small cloud sync status (hosted only). */
  _renderAccountLine() {
    const chip = document.getElementById('profile-chip');
    if (chip) chip.textContent = this._displayName();
    const avatar = document.getElementById('profile-avatar');
    const src = this.platform.hosted ? this.platform.identity.avatar : null;
    if (avatar) {
      if (src) avatar.src = src;
      avatar.classList.toggle('hidden', !src);
    }
    document.getElementById('btn-signin')?.classList.toggle('hidden', !this.platform.canSignIn());
    document.getElementById('btn-invite')?.classList.toggle('hidden', !this.platform.inviteLink());
    const el = document.getElementById('sync-status');
    if (!el) return;
    if (!this.platform.hosted) { el.classList.add('hidden'); return; }
    const note = {
      loading: 'syncing…', saving: 'saving…',
      synced: 'cloud synced', error: 'sync failed — kept on this device',
    }[this.platform.syncState];
    el.textContent = note ? t(note) : '';
    el.classList.toggle('hidden', !note);
  }

  /** The default guest name is shown in the game language. */
  _displayName() {
    const name = this.store.profile.name;
    return !name || name === 'Guest' ? t('Guest') : name;
  }

  _offerResume(snap) {
    const cfg = this._findContent(snap.contentId);
    if (!cfg) { this.store.clearSessionSnapshot(); return; }
    const card = document.createElement('button');
    card.className = 'card';
    const label = () => { card.innerHTML = `<strong>${t('Resume session')}</strong><span class="card-sub">${t('{name} · tick {n}', { name: contentName(cfg.name), n: snap.snapshot.tick ?? 0 })}</span>`; };
    label();
    const off = onLocaleChange(label);
    card.addEventListener('click', () => {
      try {
        const { session, away } = Session.restore(cfg, snap.snapshot, {
          mode: snap.mode,
          envelope: snap.envelope,
          undo: snap.mode === 'practice' || snap.mode === 'learn',
          ranked: this._isRankable()
            && !(snap.mode === 'daily' && cfg.dailyKey && this.store.profile.daily[cfg.dailyKey])
            && (snap.mode === 'daily' || snap.mode === 'challenge' || snap.mode === 'chase'),
        });
        this.session = session;
        this.mode = snap.mode;
        this._enterPlayfield(cfg);
        this.ui.toast(t('Welcome back — {n} ticks passed while you were away', { n: away.ticks }));
        this.ui.announce(t('Session resumed. {n} ticks passed while you were away.', { n: away.ticks }));
      } catch (e) {
        console.warn('[resume] failed', e);
        this.store.clearSessionSnapshot();
      }
      off();
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
      camera: () => this.renderer && this.ui.toast(t('Camera recentered')),
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
        ranked: this._isRankable() && !done,
        extra: done ? () => `<p class="muted">${t('You already completed today\'s challenge ({score} pts) — replays are casual.', { score: done.score })}</p>` : '',
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
    return () => choices.map(([id, name]) =>
      `<button class="btn setup-choice" data-kind="${kind}" data-id="${id}">${t(name)}</button>`).join('');
  }

  _prepare(cfg, opts = {}) {
    this.pendingConfig = cfg;
    this._lastPrepare = [cfg, opts];
    const rulesText = [
      cfg.allowedActions.map((a) => (rules.ACTIONS[a] ? t(rules.ACTIONS[a].label) : a)).join(', '),
      cfg.tickLimit ? t('{n}-tick limit', { n: cfg.tickLimit }) : t('no time limit'),
      cfg.maxCommands ? t('{n}-move limit', { n: cfg.maxCommands }) : null,
    ].filter(Boolean).join(' · ');
    const extra = typeof opts.extra === 'function' ? opts.extra() : (opts.extra || '');
    this.ui.renderSetup({
      name: contentName(cfg.name),
      intro: extra + (cfg.intro ? t(cfg.intro) : ''),
      rules: rulesText,
      duration: t('~{n} min', { n: Math.max(1, Math.round(cfg.tickLimit / 40)) }),
      ranked: opts.ranked,
      rankedLabel: opts.ranked ? t('Ranked') : t('Casual — not ranked'),
      optionsHTML: typeof opts.options === 'function' ? opts.options() : (opts.options || ''),
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
    const dailyDone = this.mode === 'daily' && cfg.dailyKey && !!this.store.profile.daily[cfg.dailyKey];
    const ranked = this._isRankable() && !dailyDone && (this.mode === 'daily' || this.mode === 'challenge' || this.mode === 'chase');
    this.session = new Session(cfg, { mode: this.mode, undo, ranked, timestampOffset: this.platform.timeOffset, assists });
    this.lastSetup = { cfg, mode: this.mode };
    this.store.clearSessionSnapshot();
    this._enterPlayfield(cfg);
  }

  _enterPlayfield(cfg) {
    this.machine = 'active';
    this.ui.closeAllOverlays();
    this.ui.showScreen('game');
    // The playfield was display:none at boot — resize now that it has layout.
    if (this.renderer) requestAnimationFrame(() => { this.renderer.resize(); this.renderer.start(); });
    this.ui.buildActionTray(this.session.legal);
    this.ui.el('btn-undo').style.display = this.session.undoEnabled ? '' : 'none';
    this.ui.setCompatMessage(!this.renderer);
    if (this.renderer) {
      // Seed first: setTheme/setDecor derive deterministic layouts from it.
      this.renderer.decorSeed = cfg.seed;
      this.renderer.setTheme(cfg.theme || content.DEFAULT_THEME);
      this.renderer.setDecor(this.session.state.decorPlaced);
      this.renderer.setMood(rules.moodOf(this.session.state));
    }
    this.ui.renderHelp(this.session.legal);
    this._updateHUD();
    this._hudLoop();
    this._saveSnapshot();
    this.ui.announce(t('{name}. {objective}. Session started.', { name: contentName(cfg.name), objective: this._objectiveText(cfg) }), true);
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
      const reason = t(rules.INVALID_REASONS[result.reason] || 'Not possible right now.');
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
      const label = rules.ACTIONS[type] ? t(rules.ACTIONS[type].label) : type;
      this.ui.toast(t('Discovered: {action}! +{n}', { action: label, n: result.discoveryGain }));
      this.store.recordDiscovery(type);
      if (type === 'decorate' && args.item) this.store.recordDiscovery('decor:' + args.item);
    }
    if (result.cravingBonus) this.audio.event('craving-met');
    const newBond = this.session.bondLevel;
    if (newBond > prevBond) {
      this.audio.event('bond-up');
      this.ui.toast(t('Bond level {n}!', { n: newBond }));
      this.ui.announce(t('Bond level up — level {n}.', { n: newBond }));
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
      this.ui.announce(t(st.craving.need === 'hunger' ? 'Mote is hungry.' : st.craving.need === 'hygiene' ? 'Mote wants a bath.' : st.craving.need === 'fun' ? 'Mote wants to play.' : 'Mote is sleepy.'));
    } else if (!st.craving) {
      this._cravingAnnounced = false;
    }
  }

  _creatureTapped() {
    // Tapping Mote performs a contextual pet when legal.
    if (this.session && this.session.legal.some((a) => a.id === 'pet' && a.legal)) this._act('pet');
    else if (this.session) {
      // Not a legal pet right now (overjoyed, resolving, finished): still answer the touch.
      if (this.renderer) this.renderer.react('pet', 'ack');
      this.audio.event('ack');
      this.ui.announce(t('Mote wiggles happily.'));
    }
  }

  _openDecor() {
    if (!this.session) return;
    this.ui.renderDecor(this.session.state.allowedDecor, this.session.state.decorPlaced);
    this.ui.openOverlay('decor');
  }

  _undo() {
    if (!this.session || !this.session.undoEnabled) return;
    if (this.machine !== 'active' && this.machine !== 'paused') return;
    if (this.session.undo()) {
      this.audio.event('ui-close');
      this.ui.toast(t('Undone'));
      this._afterAction(this.session.state);
      if (this.renderer) {
        this.renderer.setMood(rules.moodOf(this.session.state));
        this.renderer.setDecor(this.session.state.decorPlaced);
      }
    } else {
      this.ui.announce(t('Nothing to undo.'));
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
      this.ui.announce(t('Hint: try {action}. {blurb}', { action: t(def.label), blurb: t(def.blurb) }));
      this.ui.toast(t('Hint: {action}', { action: t(def.label) }));
    }
  }

  /* ================= pause / leave ================= */
  _pause(auto = false) {
    if (!this.session || this.machine !== 'active') return;
    this.machine = 'paused';
    this.session.markAwayBaseline();
    // Auto-pause (tab backgrounded) must also show the pause sheet —
    // otherwise there is no Resume control when the player returns.
    this.ui.openOverlay('pause');
    this.audio.event('ui-open');
  }

  _resume(fromOverlay) {
    if (this.machine !== 'paused') return;
    this.machine = 'active';
    if (!fromOverlay) this.ui.closeOverlay('pause');
    const away = this.session.awaySummary();
    if (away && away.ticks > 0) this.ui.toast(t('While paused: {n} ticks, {score} pts', { n: away.ticks, score: away.scoreDelta }));
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
    this.session = null;
    this.machine = 'profile-ready';
  }

  _retry() {
    if (!this.lastSetup) return this._goto('modes');
    this.pendingConfig = this.lastSetup.cfg;
    this.mode = this.lastSetup.mode;
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
  _showLessonStep(quiet = false) {
    const step = this.lesson.steps[this.lessonStep];
    if (!step) return;
    this.ui.showLessonBanner(`<strong>${t(this.lesson.title)}</strong> — ${t(step.text)}`, quiet);
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
        this.ui.toast(t('Lesson complete! Finish the stage to keep going.'));
        this.ui.announce(t('Lesson complete. You can finish the stage now.'));
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
    const hasNext = this.mode === 'journey' && completed;

    // Scores also stay on the local board; ranked sessions post to the
    // platform `high-score` board when signed in (see _postToLeaderboard).
    const best = p.bestScores[cfg.id];
    const boardId = this.mode === 'daily' ? `daily:${cfg.dailyKey}` : this.mode === 'chase' ? `chase:${cfg.seed}` : `stage:${cfg.id}`;
    const isBest = score.total >= best;
    this.store.submitLocalScore(boardId, { name: p.name, score: score.total, ticks: st.tick, me: true });

    this._boardContext = { boardId, friends: false };
    const status = st.status, tick = st.tick;
    // Results texts are rebuilt on a language change (see _relocalize).
    this._results = () => ({
      headline: t(completed
        ? 'Session complete — Mote is thriving!'
        : status === 'neglected'
          ? 'Mote got overwhelmed — but nothing is lost. Try again!'
          : 'Time is up — good effort!'),
      rows: [
        [t('Care'), score.care], [t('Discoveries'), score.discovery],
        [t('Bond'), score.bond], [t('Time bonus'), score.timeBonus],
        [t('Invalid actions'), score.invalidAttempts],
        [t('Elapsed'), t('{n} ticks', { n: tick })],
        ...(stars ? [[t('Stars'), '★'.repeat(stars)]] : []),
      ],
      total: score.total,
      comparison: isBest ? t('New personal best!') : t('Personal best: {n}', { n: best }),
      achievements: newAchievements.map((a) => t(a)),
      hasNext,
    });
    this.ui.renderResults(this._results());
    this.store.clearSessionSnapshot();
    this.ui.showScreen('results');
    this._postToLeaderboard(this.session.ranked ? Math.max(0, score.total) : null);
  }

  /** Signed in only: post a ranked session's total and show the board rank. */
  _postToLeaderboard(total) {
    const line = document.getElementById('results-lb');
    this._lb = null;
    if (total == null || !this.platform.hosted) { line.hidden = true; return; }
    const session = this.session;
    this._lb = { state: 'posting' };
    this._refreshLeaderboardLine();
    this.platform.submitScore(total).then((r) => {
      if (this.session !== session) return;
      this._lb = { state: !r.posted ? 'notPosted' : r.rank ? 'rank' : 'posted', rank: r.rank };
      this._refreshLeaderboardLine();
    });
  }

  _refreshLeaderboardLine() {
    const line = document.getElementById('results-lb');
    const lb = this._lb;
    if (!line || !lb) return;
    const s = ps();
    line.hidden = false;
    line.textContent = lb.state === 'posting' ? s.lbPosting : lb.state === 'notPosted' ? s.lbNotPosted
      : lb.state === 'rank' ? s.lbRank.replace('{rank}', lb.rank) : s.lbPosted;
  }

  async _loadBoard(friends) {
    if (!this._boardContext) {
      // Default board: today's daily.
      this._boardContext = { boardId: `daily:${content.dailyKeyFor(new Date(this.platform.now()))}`, friends: false };
    }
    this._boardContext.friends = friends;
    const { boardId } = this._boardContext;
    let entries, subtitle, title;
    if (this.platform.hosted) {
      // Global boards are platform-owned: read-only, nicknames resolved.
      title = t('Leaderboard — global');
      try {
        entries = await this.platform.loadLeaderboard({ friends, pageSize: 20 });
      } catch { entries = null; /* fall through to the casual board */ }
      subtitle = entries ? t('Platform board · read-only') : t('Casual local board');
      if (!entries) entries = this.store.getLocalBoard(boardId);
    } else {
      title = t('Leaderboard — {board}', { board: t('board.' + boardId.split(':')[0]) });
      entries = this.store.getLocalBoard(boardId);
      subtitle = t('Casual local board');
    }
    this.ui.renderBoard({
      title,
      subtitle: subtitle + (friends ? ' · ' + t('friends only') : ''),
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
      if (this.platform.hosted) return; // the platform account name wins
      this.store.profile.name = patch._name || 'Guest';
      document.getElementById('profile-chip').textContent = this._displayName();
    } else {
      Object.assign(s, patch);
    }
    this.store.saveProfile();
    this.ui.applyAccessibilityClasses(s);
    this.audio.applySettings();
    if (this.renderer) {
      this.renderer.setReducedMotion(s.reducedMotion);
      if ('gfx' in patch) this.renderer.setGraphics(s.gfx);
    } else if ('gfx' in patch) {
      document.body.dataset.gfxPreset = resolveGfx(s.gfx, 'low').preset;
    }
    this.platform.syncSettings(this._prefs());
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
    if (g.bondLevel) parts.push(t('reach Bond level {n}', { n: g.bondLevel }));
    if (g.care) parts.push(t('earn {n} care points', { n: g.care }));
    if (g.discoveries) parts.push(t('make {n} discoveries', { n: g.discoveries }));
    if (g.decor) parts.push(t('place {n} decorations', { n: g.decor }));
    return parts.length ? t('Objective: {goals}', { goals: parts.join(t(' and ')) }) : t('Keep Mote happy');
  }

  _updateHUD() {
    const st = this.session.state;
    const cfg = this.session.content;
    const score = this.session.score;
    const g = cfg.goals || {};
    const prog = [];
    if (g.bondLevel) prog.push(t('Bond {n}/{total}', { n: this.session.bondLevel, total: g.bondLevel }));
    if (g.care) prog.push(t('Care {n}/{total}', { n: score.care, total: g.care }));
    if (g.discoveries) prog.push(t('Found {n}/{total}', { n: st.discovered.length, total: g.discoveries }));
    if (g.decor) prog.push(t('Decor {n}/{total}', { n: st.decorPlaced.length, total: g.decor }));
    const lvl = this.session.bondLevel;
    this.ui.updateHUD({
      objective: this._objectiveText(cfg),
      objectiveProgress: prog.join(' · ') || t('{n} ticks left', { n: st.tickLimit - st.tick }),
      needs: st.needs,
      score: score.total,
      scoreDetail: t('care {care} · discovery {discovery} · bond {bond} · bonus {bonus}', { care: score.care, discovery: score.discovery, bond: score.bond, bonus: score.timeBonus }),
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
  document.getElementById('live-region').textContent = t('Failed to start: {error}', { error: e.message });
});

// Results screen → leaderboard shortcut.
document.getElementById('results-comparison').addEventListener('click', () => game._loadBoard(false));
