/**
 * Pocket Companion — platform adapter (StarHermit).
 * Launch-token handshake (fragment #game_token, read once and stripped),
 * Bearer auth on every REST call, 45-min launch-token refresh, account
 * nickname, cloud saves (single slot, stored zip + base64), read-only
 * platform leaderboards, and the game's own replay-validated boards as an
 * authenticated backend with graceful casual-board fallback.
 * Hosted mode activates iff a launch token was read; localStorage remains
 * the offline cache. Tokens live in memory only, never in storage.
 */

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
  } catch { return null; }
}

export class Platform {
  constructor() {
    // Launch context (memory only; the token is never persisted).
    this.token = null;         // short-lived launch token
    this.userId = null;        // JWT sub
    this.slug = null;          // JWT game_scope — never hard-coded
    this.hosted = false;       // true iff a launch token was read
    this.ownServer = false;    // local dev server (server.js) answering /api
    this.timeOffset = 0;       // own-server clock minus client ms
    this.identity = { name: 'Guest', avatar: null, guest: true };
    this.syncState = 'offline'; // offline | loading | saving | synced | error
    this.onSyncChange = null;  // syncState display hook
    this.docProvider = null;   // () => doc to cloud-save (wired by the game)
    this._saveTimer = null;
    this._refreshTimer = null;
    this._suspended = false;   // suppress cloud saves while applying a remote doc
    this._profileCache = new Map();
    this._presenceTimer = null;
    this._telemetryQueue = [];
  }

  /* ================= launch token ================= */

  /** Read the launch token once (fragment first, query for local dev), strip it. */
  init() {
    let token = null;
    try {
      const frag = window.location.hash;
      if (frag) {
        const params = new URLSearchParams(frag.startsWith('#') ? frag.slice(1) : frag);
        token = params.get('game_token');
        if (token) {
          params.delete('game_token');
          const rest = params.toString();
          history.replaceState(null, '',
            window.location.pathname + window.location.search + (rest ? `#${rest}` : ''));
        }
      }
      if (!token) {
        // Query fallbacks are local-dev conveniences only; the platform
        // always launches with the fragment form.
        const q = new URLSearchParams(window.location.search);
        token = q.get('game_token') || q.get('token') || q.get('launch');
        if (!token) this.slug = q.get('game'); // dev-scope hint
      }
    } catch { /* location unavailable — offline embedded context */ }
    if (!token) return;
    const claims = decodeJwtPayload(token);
    if (!claims || !claims.sub) return;
    this.token = token;
    this.userId = String(claims.sub);
    if (claims.game_scope) this.slug = String(claims.game_scope);
    this.hosted = true;
    this._scheduleRefresh(45 * 60 * 1000);
  }

  authHeaders() {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  async _fetch(path, opts = {}, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(path, {
        ...opts,
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          ...this.authHeaders(),
          ...(opts.headers || {}),
        },
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 429) return { ok: false, rateLimited: true, retryAfter: Number(res.headers.get('retry-after')) || 5 };
      if (!res.ok) return { ok: false, error: body.error || `http-${res.status}` };
      return { ok: true, data: body };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? 'timeout' : 'offline' };
    } finally { clearTimeout(t); }
  }

  _scheduleRefresh(ms) {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.refreshToken(), ms);
  }

  /** Scoped launch tokens may re-mint: swap the new token in, retry on failure. */
  async refreshToken() {
    if (!this.hosted || !this.slug) return;
    const r = await this._fetch(`/api/v1/games/${encodeURIComponent(this.slug)}/launch-token`, { method: 'POST', body: '{}' }, 8000);
    if (r.ok && typeof r.data.token === 'string' && r.data.token) {
      this.token = r.data.token;
      this._scheduleRefresh(45 * 60 * 1000);
    } else {
      this._scheduleRefresh(60 * 1000); // retry failures ~60 s
    }
  }

  /* ================= time (own dev server only) ================= */

  /**
   * Synchronize clock with the game's own dev server (round-trip adjusted).
   * The platform documents no time endpoint, so hosted mode keeps device time.
   */
  async syncTime() {
    if (this.hosted) return { synced: false, offset: 0 };
    const t0 = Date.now();
    const r = await this._fetch('/api/v1/time');
    const t1 = Date.now();
    if (r.ok && typeof r.data.now === 'number') {
      this.ownServer = true;
      this.timeOffset = r.data.now - Math.round((t0 + t1) / 2);
      return { synced: true, offset: this.timeOffset };
    }
    return { synced: false, offset: 0 };
  }

  now() { return Date.now() + this.timeOffset; }

  /* ================= identity ================= */

  /**
   * Load the account profile: nickname only (never the username), with a
   * generated fallback. Never calls /api/v1/me (403 for launch tokens).
   */
  async loadIdentity() {
    if (!this.hosted) return this.identity;
    let nickname = await this.profileFor(this.userId);
    this.identity = { name: nickname, avatar: null, guest: false };
    return this.identity;
  }

  /** Resolve a user id to its display nickname (cached; "Player "+id8 fallback). */
  async profileFor(userId) {
    const id = String(userId ?? '');
    if (!this.hosted || !id) return null;
    if (this._profileCache.has(id)) return this._profileCache.get(id);
    let name = null;
    const r = await this._fetch(`/api/v1/users/${encodeURIComponent(id)}/profile`);
    if (r.ok && r.data && typeof r.data.nickname === 'string' && r.data.nickname.trim()) {
      name = r.data.nickname.trim().slice(0, 24);
    }
    if (!name) name = 'Player ' + id.slice(0, 8);
    this._profileCache.set(id, name);
    return name;
  }

  /* ================= cloud saves (single slot, zip + base64) ================= */

  setSync(state) {
    this.syncState = state;
    this.onSyncChange?.(state);
  }

  suspendSave(fn) {
    this._suspended = true;
    try { fn(); } finally { this._suspended = false; }
  }

  /** Load the remote doc; 404 = none. Remote is preferred on conflict. */
  async cloudLoad() {
    if (!this.hosted || !this.slug) return null;
    this.setSync('loading');
    const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.slug)}`, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!res) { this.setSync('error'); return null; }
    if (res.status === 404) { this.setSync('synced'); return null; }
    if (!res.ok) { this.setSync('error'); return null; }
    try {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const raw = unzipFirstEntry(bytes);
      this.setSync('synced');
      return JSON.parse(new TextDecoder().decode(raw));
    } catch {
      this.setSync('error');
      return null;
    }
  }

  /** Debounced cloud mirror (~2 s) of whatever docProvider returns. */
  scheduleCloudSave() {
    if (!this.hosted || !this.slug || this._suspended || !this.docProvider) return;
    this.setSync('saving');
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flushCloudSave(), 2000);
  }

  async flushCloudSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!this.hosted || !this.slug || this._suspended || !this.docProvider) return;
    try {
      const doc = this.docProvider();
      const bytes = zipStore('save.json', new TextEncoder().encode(JSON.stringify(doc)));
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.slug)}`, {
        method: 'PUT',
        headers: { ...this.authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ dataBase64: bytesToBase64(bytes) }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok && res.status !== 404) throw new Error(`cloud save -> ${res.status}`);
      this.setSync('synced');
    } catch {
      this.setSync('error'); // localStorage already holds the data; next save retries
    }
  }

  attachFlush() {
    const flush = () => this.flushCloudSave();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }

  /* ================= leaderboards ================= */

  /**
   * Platform leaderboard (read-only): games/{slug} → leaderboardId → entries,
   * with user ids resolved to nicknames. Null when unavailable/no board.
   */
  async loadLeaderboard({ friends = false, pageSize = 20 } = {}) {
    if (!this.hosted || !this.slug) return null;
    const g = await this._fetch(`/api/v1/games/${encodeURIComponent(this.slug)}`);
    if (!g.ok) return null;
    const lbId = g.data && g.data.leaderboardId;
    if (!lbId) return null;
    const e = await this._fetch(
      `/api/v1/leaderboards/${encodeURIComponent(lbId)}/entries?friendsOnly=${friends ? 1 : 0}&page=1&pageSize=${pageSize}`);
    if (!e.ok) return null;
    const rows = Array.isArray(e.data.entries) ? e.data.entries : [];
    return Promise.all(rows.map(async (row) => {
      const uid = row.userId ?? row.user?.id ?? '';
      return {
        name: (await this.profileFor(uid)) ?? 'Player',
        me: String(uid) === this.userId,
        score: row.score ?? 0,
        ticks: row.ticks ?? row.elapsedMs ?? 0,
      };
    }));
  }

  /**
   * Submit a replay-validated score to the game's own declared backend,
   * authenticated (Bearer + account id) so entries attach to the account.
   * Falls back to the local casual board when no backend answers.
   */
  async submitScore(boardId, payload) {
    if (this.hosted && this.userId) payload = { ...payload, playerId: this.userId };
    if (!this.hosted && !this.ownServer) return { ok: false, error: 'offline', casual: true };
    return this._fetch(`/api/v1/boards/${encodeURIComponent(boardId)}/submit`, {
      method: 'POST', body: JSON.stringify(payload),
    }, 12000);
  }

  /** Read the own dev server's validated board (local development only). */
  async fetchBoard(boardId, { friends = false } = {}) {
    if (this.hosted || !this.ownServer) return { ok: false, error: 'offline' };
    return this._fetch(`/api/v1/boards/${encodeURIComponent(boardId)}${friends ? '?friends=1' : ''}`);
  }

  /* ================= presence / activity / telemetry (own dev server only) ================= */

  startPresence() {
    if (!this.ownServer || this.hosted || this._presenceTimer) return;
    const beat = () => this._fetch('/api/v1/presence', { method: 'POST', body: '{}' }, 4000);
    beat();
    this._presenceTimer = setInterval(beat, 45000);
  }
  stopPresence() { clearInterval(this._presenceTimer); this._presenceTimer = null; }

  startActivity(mode) { if (this.ownServer && !this.hosted) this._fetch('/api/v1/activity/start', { method: 'POST', body: JSON.stringify({ mode }) }, 4000); }
  endActivity(mode) { if (this.ownServer && !this.hosted) this._fetch('/api/v1/activity/end', { method: 'POST', body: JSON.stringify({ mode }) }, 4000); }

  /** Anonymous, consent-gated funnel telemetry (own dev server only). */
  telemetry(event, detail, consent) {
    if (!consent) return;
    const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
    if (!allowed.includes(event)) return;
    this._telemetryQueue.push({ e: event, d: String(detail || '').slice(0, 64), t: Date.now() });
    if (this._telemetryQueue.length >= 10) this.flushTelemetry();
  }
  flushTelemetry() {
    if (this.hosted || !this.ownServer || this._telemetryQueue.length === 0) { this._telemetryQueue = []; return; }
    const batch = this._telemetryQueue.splice(0);
    this._fetch('/api/v1/telemetry', { method: 'POST', body: JSON.stringify({ events: batch }) }, 4000);
  }
}

export { zipStore, unzipFirstEntry, bytesToBase64, base64ToBytes };
