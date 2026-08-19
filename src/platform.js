/**
 * Pocket Companion — platform adapter.
 * Token-aware same-origin /api access when hosted; graceful offline fallback
 * with local (casual-labelled) leaderboards. Never persists tokens.
 */
export class Platform {
  constructor() {
    const params = new URLSearchParams(location.search);
    this.launchToken = params.get('token') || null; // short-lived, memory only
    this.scope = params.get('game') || null;        // read from launch context, not hard-coded
    this.hosted = !!this.launchToken;
    this.apiAvailable = false; // set when same-origin /api answers, token or not
    this.timeOffset = 0; // server - client ms
    this.identity = { name: 'Guest', avatar: null, guest: true };
    this._presenceTimer = null;
    this._telemetryQueue = [];
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
          ...(this.launchToken ? { authorization: `Bearer ${this.launchToken}` } : {}),
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

  /** Synchronize clock with host (round-trip adjusted). */
  async syncTime() {
    const t0 = Date.now();
    const r = await this._fetch('/api/v1/time');
    const t1 = Date.now();
    if (r.ok && typeof r.data.now === 'number') {
      this.apiAvailable = true;
      this.timeOffset = r.data.now - Math.round((t0 + t1) / 2);
      return { synced: true, offset: this.timeOffset };
    }
    return { synced: false, offset: 0 };
  }

  now() { return Date.now() + this.timeOffset; }

  /** Load host identity (display name/avatar only where useful). */
  async loadIdentity() {
    if (!this.hosted) return this.identity;
    const r = await this._fetch('/api/v1/me');
    if (r.ok && r.data && r.data.name) {
      this.identity = { name: String(r.data.name).slice(0, 24), avatar: r.data.avatar || null, guest: !!r.data.guest, hidden: !!r.data.hidden };
      if (this.identity.hidden) this.identity = { name: 'Guest', avatar: null, guest: true };
    }
    return this.identity;
  }

  startPresence() {
    if (!this.hosted || this._presenceTimer) return;
    const beat = () => this._fetch('/api/v1/presence', { method: 'POST', body: '{}' }, 4000);
    beat();
    this._presenceTimer = setInterval(beat, 45000);
  }
  stopPresence() { clearInterval(this._presenceTimer); this._presenceTimer = null; }

  startActivity(mode) { if (this.hosted) this._fetch('/api/v1/activity/start', { method: 'POST', body: JSON.stringify({ mode }) }, 4000); }
  endActivity(mode) { if (this.hosted) this._fetch('/api/v1/activity/end', { method: 'POST', body: JSON.stringify({ mode }) }, 4000); }

  /** Submit a replay-validated score. Falls back to local casual board offline. */
  async submitScore(boardId, payload) {
    if (!this.apiAvailable) return { ok: false, error: 'offline', casual: true };
    return this._fetch(`/api/v1/boards/${encodeURIComponent(boardId)}/submit`, {
      method: 'POST', body: JSON.stringify(payload),
    }, 12000);
  }

  async fetchBoard(boardId, { friends = false } = {}) {
    if (!this.apiAvailable) return { ok: false, error: 'offline' };
    return this._fetch(`/api/v1/boards/${encodeURIComponent(boardId)}${friends ? '?friends=1' : ''}`);
  }

  /** Anonymous, consent-gated funnel telemetry. */
  telemetry(event, detail, consent) {
    if (!consent) return;
    const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
    if (!allowed.includes(event)) return;
    this._telemetryQueue.push({ e: event, d: String(detail || '').slice(0, 64), t: Date.now() });
    if (this._telemetryQueue.length >= 10) this.flushTelemetry();
  }
  flushTelemetry() {
    if (!this.hosted || this._telemetryQueue.length === 0) { this._telemetryQueue = []; return; }
    const batch = this._telemetryQueue.splice(0);
    this._fetch('/api/v1/telemetry', { method: 'POST', body: JSON.stringify({ events: batch }) }, 4000);
  }
}
