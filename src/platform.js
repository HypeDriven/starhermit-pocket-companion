/**
 * Pocket Companion — platform adapter over the shared StarHermit SDK
 * (starhermit-sdk.js, loaded as a classic script before the game modules):
 * launch token + renewal, sign-in, account nickname + avatar, cloud save
 * (slot game:<slug>), per-player settings KV, keyboard bindings, invite link
 * and the `high-score` platform leaderboard (post + read). Hosted mode is "the SDK holds a
 * token"; without one no request is made at all and play is local. The
 * game never calls its own server routes (/api, /ws): the device clock is
 * authoritative and boards/achievements are local. localStorage remains the
 * offline cache.
 */

/** The SDK instance (window.StarHermit; tests may inject one on globalThis). */
function sdk() { return globalThis.StarHermit || null; }

export class Platform {
  constructor() {
    this.identity = { name: 'Guest', avatar: null, guest: true };
    this.syncState = 'offline'; // offline | loading | saving | synced | error
    this.onSyncChange = null;  // syncState display hook
    this.onAuthChange = null;  // ({ signedIn }) after the platform session ends
    this.docProvider = null;   // () => doc to cloud-save (wired by the game)
    this._suspended = false;   // suppress cloud saves while applying a remote doc
    this._sentSettings = {};
  }

  get hosted() { return !!(sdk() && sdk().signedIn); }
  get userId() { return this.hosted ? String(sdk().userId) : null; }
  get slug() { return this.hosted ? sdk().slug : null; }

  /* ================= launch token ================= */

  /** Read the launch token (no-op when index.html already did) and wire events. */
  init() {
    const sh = sdk();
    if (!sh) return;
    if (!sh.signedIn) sh.init();
    sh.on('saved', (ok) => this.setSync(ok ? 'synced' : 'error'));
    sh.on('auth', (a) => {
      if (!a.signedIn) { this.identity = { ...this.identity, avatar: null, guest: true }; this.setSync('offline'); }
      this.onAuthChange?.({ signedIn: !!a.signedIn });
    });
  }

  canSignIn() { return !!(sdk() && sdk().canSignIn()); }
  signIn() { return !!(sdk() && sdk().signIn()); }
  inviteLink() { return this.hosted ? sdk().inviteLink() : null; }

  /* ================= time ================= */

  /** Device clock: there is no client-reachable time route. */
  now() { return Date.now(); }

  /* ================= identity ================= */

  /**
   * Load the account profile: nickname (never the username) with a
   * generated fallback, plus the avatar. Never calls /api/v1/me.
   */
  async loadIdentity() {
    if (!this.hosted) return this.identity;
    const [p, avatar] = await Promise.all([sdk().profile(), sdk().avatarUrl()]);
    this.identity = { name: (p ? p.displayName : 'Player ' + this.userId.slice(0, 6)).slice(0, 24), avatar, guest: false };
    return this.identity;
  }

  /** Resolve a user id to its display nickname ("Player "+id fallback). */
  async profileFor(userId) {
    const id = String(userId ?? '');
    if (!this.hosted || !id) return null;
    const p = await sdk().profile(id);
    return (p ? p.displayName : 'Player ' + id.slice(0, 6)).slice(0, 24);
  }

  /* ================= cloud save (slot game:<slug>) ================= */

  setSync(state) {
    this.syncState = state;
    this.onSyncChange?.(state);
  }

  suspendSave(fn) {
    this._suspended = true;
    try { fn(); } finally { this._suspended = false; }
  }

  /** Load the remote doc (null = none). Remote is preferred on conflict. */
  async cloudLoad() {
    if (!this.hosted) return null;
    this.setSync('loading');
    const doc = await sdk().loadJSON();
    this.setSync('synced');
    return doc && typeof doc === 'object' ? doc : null;
  }

  /** Debounced cloud mirror (~2 s) of whatever docProvider returns. */
  scheduleCloudSave() {
    if (!this.hosted || this._suspended || !this.docProvider) return;
    this.setSync('saving');
    sdk().saveJSON(this.docProvider(), 2000);
  }

  async flushCloudSave(keepalive = false) {
    if (!this.hosted || this._suspended) return false;
    return sdk().flushSave(keepalive);
  }

  attachFlush() {
    const flush = () => this.flushCloudSave(true);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }

  /* ================= settings KV + controls ================= */

  /** Platform-stored preferences ({} when signed out / none). */
  async loadRemoteSettings() {
    if (!this.hosted) return {};
    const s = (await sdk().getSettings()) || {};
    this._settingsLoaded = true; // no PATCH before the platform values were read
    for (const [k, v] of Object.entries(s)) this._sentSettings[k] = JSON.stringify(v);
    return s;
  }

  /** Mirror changed top-level preference keys with one PATCH. */
  syncSettings(prefs) {
    if (!this.hosted || !this._settingsLoaded || this._suspended) return Promise.resolve(null);
    const patch = {};
    for (const [k, v] of Object.entries(prefs || {})) {
      const json = JSON.stringify(v);
      if (this._sentSettings[k] !== json) { patch[k] = v; this._sentSettings[k] = json; }
    }
    return Object.keys(patch).length ? sdk().patchSettings(patch) : Promise.resolve(null);
  }

  /** { action: codes[] } with the player's platform overrides applied. */
  loadBindings(defaults) {
    const copy = () => Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, v.slice()]));
    if (!this.hosted) return Promise.resolve(copy());
    return sdk().loadBindings(defaults).catch(copy);
  }

  /* ================= leaderboards ================= */

  /**
   * Post a finished ranked session to the `high-score` board through the game's
   * score-script.js (StarHermit.submitScores) → { posted, rank }.
   */
  async submitScore(total) {
    if (!this.hosted) return { posted: false, rank: null };
    const keys = await sdk().submitScores({ 'high-score': total });
    if (!keys || !keys.includes('high-score')) return { posted: false, rank: null };
    try {
      const r = await sdk().leaderboard('high-score', { pageSize: 100 });
      const me = (r.items || []).find((i) => String(i.userId) === this.userId);
      return { posted: true, rank: me ? me.rank : null };
    } catch { return { posted: true, rank: null }; }
  }

  /**
   * The `high-score` board, with user ids resolved to nicknames. Null when
   * unavailable / no board.
   */
  async loadLeaderboard({ friends = false, pageSize = 20 } = {}) {
    if (!this.hosted) return null;
    const r = await sdk().leaderboard('high-score', { pageSize, scope: friends ? 'friends' : undefined });
    if (!r || !r.board) return null;
    return Promise.all((r.items || []).map(async (row) => {
      const uid = row.userId ?? '';
      return {
        name: (await this.profileFor(uid)) ?? 'Player',
        me: String(uid) === this.userId,
        score: row.score ?? 0,
        ticks: row.ticks ?? row.elapsedMs ?? 0,
      };
    }));
  }
}
