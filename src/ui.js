/**
 * Pocket Companion — UI module: semantic DOM shell over the canvas.
 * Owns screens, overlays, HUD, focus management, keyboard/gamepad input,
 * settings forms, announcements, and the accessibility mirror.
 * Never touches rules state directly — it renders view models and emits
 * intents through handler callbacks.
 */
import { ACTIONS, NEEDS, INVALID_REASONS, BOND_LEVELS } from './rules.js';
import { DECOR_ITEMS } from './content.js';

const NEED_LABELS = { hunger: 'Hunger', hygiene: 'Cleanliness', fun: 'Fun', energy: 'Energy' };
const NEED_CRAVING_TEXT = {
  hunger: '🍲 wishes for food', hygiene: '🫧 wishes for a bath',
  fun: '🧶 wishes to play', energy: '💤 wishes for a nap',
};
const ACTION_ICONS = {
  feed: '🍲', snack: '🥮', wash: '🫧', play: '🧶', rest: '💤',
  pet: '🤚', sing: '🎵', toss: '⚾', decorate: '🪑', wait: '⏳',
};
const DEFAULT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export class UI {
  constructor(handlers) {
    this.h = handlers; // intents: startMode, action, decorate, pause, resume, leave, undo, hint, camera, retry, next, goto, settingsChanged, boardTab, lessonStart, stageStart
    this.el = (id) => document.getElementById(id);
    this._focusMemory = new Map();
    this._actionButtons = new Map();
    this._keymap = new Map();
    this._lastFocus = null;
    this._captionTimer = null;
    this._gamepadIndex = -1;
    this._gamepadPrev = {};
    this._bindStatic();
    this._bindKeyboard();
    this._pollGamepad();
  }

  /* ---------------- static bindings ---------------- */
  _bindStatic() {
    document.querySelectorAll('[data-goto]').forEach((b) =>
      b.addEventListener('click', () => this.h.goto(b.dataset.goto)));
    this.el('btn-play').addEventListener('click', () => this.h.goto('modes'));
    this.el('card-daily').addEventListener('click', () => this.h.startMode('daily'));
    this.el('card-journey').addEventListener('click', () => this.h.goto('journey'));
    this.el('card-profile').addEventListener('click', () => this.h.goto('profile'));
    document.querySelectorAll('.mode-card').forEach((b) =>
      b.addEventListener('click', () => this.h.startMode(b.dataset.mode)));
    this.el('btn-start-session').addEventListener('click', () => this.h.beginSession());
    this.el('btn-pause').addEventListener('click', () => this.h.pause());
    this.el('btn-pause-mobile').addEventListener('click', () => this.h.pause());
    this.el('btn-resume').addEventListener('click', () => this.h.resume());
    this.el('btn-leave').addEventListener('click', () => this.h.leave());
    this.el('btn-hint').addEventListener('click', () => this.h.hint());
    this.el('btn-undo').addEventListener('click', () => this.h.undo());
    this.el('btn-camera').addEventListener('click', () => this.h.camera());
    this.el('btn-retry').addEventListener('click', () => this.h.retry());
    this.el('btn-next').addEventListener('click', () => this.h.next());
    this.el('btn-results-modes').addEventListener('click', () => this.h.goto('modes'));
    this.el('btn-settings-top').addEventListener('click', () => this.openOverlay('settings'));
    this.el('btn-help-top').addEventListener('click', () => this.openOverlay('help'));
    this.el('btn-pause-settings').addEventListener('click', () => this.openOverlay('settings'));
    this.el('btn-pause-help').addEventListener('click', () => this.openOverlay('help'));
    this.el('btn-settings-close').addEventListener('click', () => this.closeOverlay('settings'));
    this.el('btn-help-close').addEventListener('click', () => this.closeOverlay('help'));
    this.el('btn-decor-close').addEventListener('click', () => this.closeOverlay('decor'));
    this.el('tab-global').addEventListener('click', () => this.h.boardTab(false));
    this.el('tab-friends').addEventListener('click', () => this.h.boardTab(true));
    // Clicking an overlay backdrop closes it (safe cancel).
    document.querySelectorAll('.overlay').forEach((ov) =>
      ov.addEventListener('pointerdown', (e) => { if (e.target === ov) this.closeOverlay(ov.id.replace('overlay-', '')); }));
  }

  /* ---------------- screens ---------------- */
  showScreen(name) {
    const prev = document.querySelector('.screen.active');
    if (prev) this._focusMemory.set(prev.id, document.activeElement);
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    this.el('toast-layer').innerHTML = '';
    const screen = this.el('screen-' + name);
    screen.classList.add('active');
    // Focus the first actionable element for keyboard/screen-reader users.
    const target = this._focusMemory.get('screen-' + name);
    const focusable = (target && screen.contains(target) ? target : screen.querySelector('button, [tabindex]'));
    if (focusable) requestAnimationFrame(() => focusable.focus({ preventScroll: true }));
  }

  /* ---------------- overlays with focus trap ---------------- */
  openOverlay(name) {
    const ov = this.el('overlay-' + name);
    if (!ov || !ov.classList.contains('hidden')) return;
    this._lastFocus = document.activeElement;
    ov.classList.remove('hidden');
    const first = ov.querySelector('.btn-primary, button');
    if (first) first.focus();
    this.announce(name + ' opened');
  }

  closeOverlay(name) {
    const ov = this.el('overlay-' + name);
    if (!ov || ov.classList.contains('hidden')) return;
    ov.classList.add('hidden');
    if (this._lastFocus && document.contains(this._lastFocus)) this._lastFocus.focus({ preventScroll: true });
  }

  closeAllOverlays() {
    document.querySelectorAll('.overlay').forEach((o) => o.classList.add('hidden'));
  }

  isOverlayOpen() {
    return [...document.querySelectorAll('.overlay')].some((o) => !o.classList.contains('hidden'));
  }

  /* ---------------- announcements / captions / toasts ---------------- */
  announce(text, assertive = false) {
    const region = this.el(assertive ? 'alert-region' : 'live-region');
    region.textContent = '';
    requestAnimationFrame(() => { region.textContent = text; });
  }

  caption(text) {
    const line = this.el('caption-line');
    line.textContent = '♪ ' + text;
    line.classList.add('show');
    clearTimeout(this._captionTimer);
    this._captionTimer = setTimeout(() => line.classList.remove('show'), 2200);
  }

  toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    this.el('toast-layer').appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  floatText(x, y, text) {
    const layer = this.el('float-text-layer');
    const el = document.createElement('div');
    el.className = 'float-text';
    el.textContent = text;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    layer.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }

  /* ---------------- action tray ---------------- */
  buildActionTray(actions, keybinds) {
    const tray = this.el('action-tray');
    tray.innerHTML = '';
    this._actionButtons.clear();
    this._keymap.clear();
    actions.forEach((a, i) => {
      const def = ACTIONS[a.id];
      const btn = document.createElement('button');
      btn.className = 'action-btn';
      btn.dataset.action = a.id;
      btn.dataset.legal = String(a.legal);
      const key = keybinds?.[a.id] || DEFAULT_KEYS[i] || '';
      btn.innerHTML = `<span class="a-icon" aria-hidden="true">${ACTION_ICONS[a.id] || '•'}</span>` +
        `<span class="a-label">${def ? def.label : a.id}</span>` +
        (key ? `<span class="a-key">${key}</span>` : '');
      btn.setAttribute('aria-label', `${def ? def.label : a.id}${a.legal ? '' : ' — unavailable: ' + (INVALID_REASONS[a.reason] || '')}`);
      btn.addEventListener('click', () => {
        if (a.id === 'decorate') this.h.openDecor();
        else this.h.action(a.id);
      });
      btn.addEventListener('pointerenter', () => this.h.hoverAction(a.id, a.legal));
      btn.addEventListener('pointerleave', () => this.h.hoverAction(null));
      btn.addEventListener('focus', () => this.h.hoverAction(a.id, a.legal));
      btn.addEventListener('blur', () => this.h.hoverAction(null));
      tray.appendChild(btn);
      this._actionButtons.set(a.id, btn);
      if (key) this._keymap.set(key, a.id);
    });
  }

  refreshActionTray(actions) {
    for (const a of actions) {
      const btn = this._actionButtons.get(a.id);
      if (!btn) continue;
      btn.dataset.legal = String(a.legal);
      const def = ACTIONS[a.id];
      btn.setAttribute('aria-label', `${def ? def.label : a.id}${a.legal ? '' : ' — unavailable: ' + (INVALID_REASONS[a.reason] || '')}`);
    }
  }

  markSuggested(actionId) {
    this._actionButtons.forEach((b) => b.classList.remove('suggested'));
    if (actionId && this._actionButtons.has(actionId)) {
      this._actionButtons.get(actionId).classList.add('suggested');
    }
  }

  /* ---------------- HUD ---------------- */
  updateHUD(vm) {
    // vm: {objective, objectiveProgress, needs{0..1000}, lowNeeds[], score, scoreDetail,
    //      tick, tickLimit, commandCount, maxCommands, bondLevel, bondNext, craving, mood}
    this.el('objective-text').textContent = vm.objective;
    this.el('objective-progress').textContent = vm.objectiveProgress;
    for (const need of NEEDS) {
      const row = document.querySelector(`.need-row[data-need="${need}"]`);
      if (!row) continue;
      const pct = vm.needs[need] / 10;
      row.querySelector('.need-fill').style.width = pct.toFixed(0) + '%';
      row.querySelector('.need-val').textContent = Math.round(pct);
      row.classList.toggle('low', vm.needs[need] < 250);
    }
    this.el('score-total').textContent = String(vm.score);
    this.el('score-detail').textContent = vm.scoreDetail;
    this.el('bond-level').textContent = 'Lv ' + vm.bondLevel;
    this.el('bond-progress').textContent = vm.bondNext != null ? `next at ${vm.bondNext}` : 'max';
    this.el('tick-display').textContent = vm.tickLimit
      ? `Tick ${vm.tick} / ${vm.tickLimit}` : `Tick ${vm.tick}`;
    this.el('moves-display').textContent = vm.maxCommands
      ? `Moves ${vm.commandCount} / ${vm.maxCommands}` : '';
    const bubble = this.el('craving-bubble');
    if (vm.craving) {
      bubble.textContent = NEED_CRAVING_TEXT[vm.craving.need] || 'wishes…';
      bubble.classList.remove('hidden');
    } else {
      bubble.classList.add('hidden');
    }
    this.el('btn-undo').disabled = !vm.canUndo;
  }

  positionCravingBubble(pos) {
    const bubble = this.el('craving-bubble');
    if (bubble.classList.contains('hidden') || !pos || pos.behind) return;
    const field = this.el('playfield').getBoundingClientRect();
    bubble.style.left = Math.max(60, Math.min(field.width - 60, pos.x - field.left)) + 'px';
    bubble.style.top = Math.max(50, pos.y - field.top) + 'px';
  }

  setCompatMessage(show) { this.el('compat-message').classList.toggle('hidden', !show); }

  showLessonBanner(html) {
    const b = this.el('lesson-banner');
    b.innerHTML = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    b.classList.remove('hidden');
    this.announce(b.textContent);
  }
  hideLessonBanner() { this.el('lesson-banner').classList.add('hidden'); }

  /* ---------------- setup screen ---------------- */
  renderSetup(vm) {
    // vm: {name, intro, rules[], duration, players, ranked, rankedLabel, optionsHTML}
    this.el('setup-heading').textContent = vm.name;
    this.el('setup-summary').innerHTML =
      `<p>${vm.intro}</p><dl>` +
      `<dt>Rules</dt><dd>${vm.rules}</dd>` +
      `<dt>Expected length</dt><dd>${vm.duration}</dd>` +
      `<dt>Players</dt><dd>1</dd>` +
      `<dt>Result</dt><dd><span class="ranked-badge ${vm.ranked ? 'ranked' : 'casual'}">${vm.rankedLabel}</span></dd>` +
      `</dl>`;
    this.el('setup-options').innerHTML = vm.optionsHTML || '';
  }

  /* ---------------- results ---------------- */
  renderResults(vm) {
    this.el('results-headline').textContent = vm.headline;
    const tbody = this.el('results-table').querySelector('tbody');
    tbody.innerHTML = '';
    for (const [label, value] of vm.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${label}</td><td>${value}</td>`;
      tbody.appendChild(tr);
    }
    const tr = document.createElement('tr');
    tr.className = 'total';
    tr.innerHTML = `<td>Total</td><td>${vm.total}</td>`;
    tbody.appendChild(tr);
    this.el('results-comparison').textContent = vm.comparison || '';
    const ach = this.el('results-achievements');
    ach.innerHTML = '';
    for (const a of vm.achievements || []) {
      const chip = document.createElement('span');
      chip.className = 'achievement-chip';
      chip.textContent = '🏅 ' + a;
      ach.appendChild(chip);
    }
    this.el('btn-next').style.display = vm.hasNext ? '' : 'none';
    this.announce(`Session over. ${vm.headline}. Total score ${vm.total}.`, true);
  }

  /* ---------------- journey / learn / profile / boards ---------------- */
  renderJourney(stages, progress, unlockedCount) {
    const grid = this.el('journey-grid');
    grid.innerHTML = '';
    let chapter = 0;
    stages.forEach((s, i) => {
      if (s.chapter !== chapter) {
        chapter = s.chapter;
        const h = document.createElement('div');
        h.className = 'chapter-label';
        h.textContent = `Chapter ${chapter}`;
        grid.appendChild(h);
      }
      const p = progress[s.id];
      const unlocked = i < unlockedCount;
      const btn = document.createElement('button');
      btn.className = 'card journey-card' + (s.mastery ? ' mastery' : '') + (p ? ' done' : '') + (unlocked ? '' : ' locked');
      btn.setAttribute('role', 'listitem');
      btn.disabled = !unlocked;
      const stars = p ? '★'.repeat(p.stars) + '☆'.repeat(3 - p.stars) : '';
      btn.innerHTML = `<strong>${s.index}. ${s.name}</strong>` +
        `<span>${s.mastery ? 'Mastery trial' : s.teaches.length ? 'New: ' + s.teaches.join(', ') : 'Stage'}</span>` +
        (p ? `<span class="stars" aria-label="${p.stars} of 3 stars">${stars}</span>` : '');
      btn.addEventListener('click', () => this.h.stageStart(s.id));
      grid.appendChild(btn);
    });
    const done = Object.keys(progress).length;
    this.el('journey-status').textContent = `${done} / ${stages.length} stages`;
  }

  renderLessons(lessons, done) {
    const list = this.el('lesson-list');
    list.innerHTML = '';
    lessons.forEach((l) => {
      const btn = document.createElement('button');
      btn.className = 'card' + (done[l.id] ? ' done' : '');
      btn.setAttribute('role', 'listitem');
      btn.innerHTML = `<strong>${l.title}</strong><span>${done[l.id] ? 'Completed — replay any time' : 'Not yet completed'}</span>`;
      btn.addEventListener('click', () => this.h.lessonStart(l.id));
      list.appendChild(btn);
    });
  }

  renderProfile(vm) {
    const body = this.el('profile-body');
    const achList = vm.achievements.map((a) =>
      `<div class="card ${a.unlocked ? 'unlocked' : ''}"><strong>${a.unlocked ? '🏅' : '🔒'} ${a.name}</strong><span>${a.desc}</span></div>`).join('');
    body.innerHTML =
      `<div class="stat-grid">
        <div class="stat"><strong>${vm.sessionsPlayed}</strong>sessions played</div>
        <div class="stat"><strong>${vm.stagesDone}</strong>journey stages</div>
        <div class="stat"><strong>${vm.discoveries}</strong>interactions discovered</div>
        <div class="stat"><strong>${vm.dailies}</strong>daily challenges</div>
      </div>
      <h3>Achievements</h3>
      <div class="achievement-list">${achList}</div>`;
  }

  renderBoard(vm) {
    this.el('board-heading').textContent = vm.title;
    this.el('board-subtitle').textContent = vm.subtitle;
    this.el('tab-global').setAttribute('aria-selected', String(!vm.friends));
    this.el('tab-friends').setAttribute('aria-selected', String(vm.friends));
    const list = this.el('board-list');
    list.innerHTML = '';
    if (!vm.entries.length) {
      list.innerHTML = '<li>No scores yet — be the first!</li>';
      return;
    }
    vm.entries.forEach((e, i) => {
      const li = document.createElement('li');
      if (e.me) li.className = 'me';
      li.innerHTML = `<span>${i + 1}. ${e.name}</span><span>${e.score} pts · ${e.ticks} ticks</span>`;
      list.appendChild(li);
    });
  }

  /* ---------------- decor drawer ---------------- */
  renderDecor(allowed, placed) {
    const list = this.el('decor-list');
    list.innerHTML = '';
    for (const id of allowed) {
      const item = DECOR_ITEMS.find((d) => d.id === id);
      if (!item) continue;
      const isPlaced = placed.includes(id);
      const btn = document.createElement('button');
      btn.className = 'card decor-item' + (isPlaced ? ' placed' : '');
      btn.innerHTML = `<strong>${item.name}</strong><span>${isPlaced ? 'Placed ✓' : 'Tap to place'}</span>`;
      btn.disabled = isPlaced;
      btn.addEventListener('click', () => this.h.decorate(id));
      list.appendChild(btn);
    }
  }

  /* ---------------- help (generated from current mappings) ---------------- */
  renderHelp(actions, keybinds) {
    const cards = actions.map((a) => {
      const def = ACTIONS[a.id];
      if (!def) return '';
      const key = keybinds?.[a.id] || '';
      return `<div class="card"><strong>${ACTION_ICONS[a.id] || ''} ${def.label}${key ? ` <kbd>${key}</kbd>` : ''}</strong>` +
        `<span>${def.blurb} Costs ${def.ticks} tick${def.ticks === 1 ? '' : 's'}.</span></div>`;
    }).join('');
    this.el('help-body').innerHTML =
      `<p>Care for Mote by reading its four needs — Hunger, Cleanliness, Fun, Energy — and choosing an action.
       Every action advances the clock and all needs slowly drain. Fulfil the objective before time runs out.
       Thought bubbles are <em>cravings</em>: grant them for bonus Trust. Neglect never causes permanent loss.</p>
       <p><strong>Keyboard:</strong> number keys act · <kbd>H</kbd> hint · <kbd>U</kbd> undo (practice) ·
       <kbd>C</kbd> camera · <kbd>Esc</kbd> pause · arrow keys move between buttons.</p>
       <p><strong>Gamepad:</strong> D-pad moves focus · <kbd>A</kbd> confirm · <kbd>B</kbd> cancel · <kbd>Start</kbd> pause.</p>
       <div class="achievement-list">${cards}</div>`;
  }

  /* ---------------- settings ---------------- */
  renderSettings(settings, onChange) {
    const body = this.el('settings-body');
    body.innerHTML = '';
    const row = (label, control, hint = '') => {
      const div = document.createElement('div');
      div.className = 'setting-row';
      div.innerHTML = `<label>${label}</label>`;
      div.appendChild(control);
      if (hint) { const h = document.createElement('p'); h.className = 'hint'; h.textContent = hint; div.appendChild(h); }
      body.appendChild(div);
    };
    const slider = (key, label) => {
      const input = document.createElement('input');
      input.type = 'range'; input.min = 0; input.max = 1; input.step = 0.05; input.value = settings[key];
      input.setAttribute('aria-label', label);
      input.addEventListener('input', () => onChange({ [key]: Number(input.value) }));
      row(label, input);
    };
    const toggle = (key, label, hint = '') => {
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = !!settings[key];
      input.setAttribute('aria-label', label);
      input.addEventListener('change', () => onChange({ [key]: input.checked }));
      row(label, input, hint);
    };
    const select = (key, label, options, hint = '') => {
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', label);
      for (const [v, text] of options) {
        const o = document.createElement('option');
        o.value = v; o.textContent = text;
        if (settings[key] === v) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => onChange({ [key]: sel.value }));
      row(label, sel, hint);
    };
    slider('music', 'Music volume');
    slider('effects', 'Effects volume');
    slider('ambience', 'Ambience volume');
    slider('voice', 'Voice volume');
    toggle('captions', 'Captions', 'Text cues for meaningful audio.');
    select('graphicsTier', 'Graphics tier', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], 'Lower tiers help older devices.');
    toggle('reducedMotion', 'Reduced motion', 'Removes camera sway, shake, and dense particles.');
    toggle('highContrast', 'High contrast');
    select('palette', 'Color palette', [['default', 'Default'], ['deuteranopia', 'Deuteranopia-safe'], ['protanopia', 'Protanopia-safe'], ['tritanopia', 'Tritanopia-safe']]);
    toggle('largeText', 'Larger text');
    toggle('leftHanded', 'Left-handed layout');
    toggle('holdToRepeat', 'Hold-to-repeat actions', 'Hold a button to repeat instead of toggling.');
    toggle('timingAssist', 'Timing assist', 'Slower need drain. Sessions with assists are not ranked.');
    toggle('haptics', 'Haptics', 'Vibration on supported devices.');
    toggle('telemetryConsent', 'Anonymous usage stats', 'Only funnel events; never text or personal data.');
    const nameInput = document.createElement('input');
    nameInput.type = 'text'; nameInput.maxLength = 24; nameInput.value = settings._name || '';
    if (settings._hosted) nameInput.disabled = true;
    nameInput.setAttribute('aria-label', 'Display name');
    nameInput.addEventListener('change', () => onChange({ _name: nameInput.value.slice(0, 24) }));
    row('Display name', nameInput, settings._hosted ? 'Signed in — the platform account name is shown.' : '');
  }

  /* ---------------- settings applied to DOM ---------------- */
  applyAccessibilityClasses(s) {
    document.body.dataset.motion = s.reducedMotion ? 'reduced' : 'full';
    document.body.dataset.contrast = s.highContrast ? 'high' : 'normal';
    document.body.dataset.text = s.largeText ? 'large' : 'normal';
    document.body.dataset.handed = s.leftHanded ? 'left' : 'right';
    document.body.dataset.palette = s.palette || 'default';
  }

  /* ---------------- keyboard ---------------- */
  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      const tag = document.activeElement?.tagName;
      const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      if (e.key === 'Escape') {
        if (this.isOverlayOpen()) { this.closeAllOverlays(); this.h.resume(true); }
        else this.h.pause();
        e.preventDefault();
        return;
      }
      if (typing) return;
      if (this._keymap.has(e.key)) { this.h.keyAction(this._keymap.get(e.key)); e.preventDefault(); return; }
      switch (e.key.toLowerCase()) {
        case 'h': this.h.hint(); e.preventDefault(); break;
        case 'u': this.h.undo(); e.preventDefault(); break;
        case 'c': this.h.camera(); e.preventDefault(); break;
      }
    });
  }

  /* ---------------- gamepad ---------------- */
  _pollGamepad() {
    const poll = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const pad = [...pads].find(Boolean);
      if (pad) {
        const pressed = (i) => !!pad.buttons[i]?.pressed;
        const edge = (name, down) => {
          const was = this._gamepadPrev[name];
          this._gamepadPrev[name] = down;
          return down && !was;
        };
        if (edge('a', pressed(0))) (document.activeElement?.click?.(), 0);
        if (edge('b', pressed(1))) { if (this.isOverlayOpen()) this.closeAllOverlays(); }
        if (edge('start', pressed(9))) this.h.pause();
        const x = pad.axes[0] || 0, y = pad.axes[1] || 0;
        const nav = (dir, down) => { if (edge(dir, down)) this._moveFocus(dir); };
        nav('left', pressed(14) || x < -0.6);
        nav('right', pressed(15) || x > 0.6);
        nav('up', pressed(12) || y < -0.6);
        nav('down', pressed(13) || y > 0.6);
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }

  _moveFocus(dir) {
    const focusables = [...document.querySelectorAll('.screen.active button:not([disabled]), .overlay:not(.hidden) button:not([disabled])')]
      .filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const cur = focusables.indexOf(document.activeElement);
    let next = cur;
    if (dir === 'right' || dir === 'down') next = cur < 0 ? 0 : (cur + 1) % focusables.length;
    else next = cur < 0 ? focusables.length - 1 : (cur - 1 + focusables.length) % focusables.length;
    focusables[next].focus();
  }
}

export { NEED_LABELS, ACTION_ICONS, BOND_LEVELS };
