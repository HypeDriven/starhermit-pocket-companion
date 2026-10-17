// StarHermit adapter (src/platform.js) over the shared SDK with a stubbed fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The SDK is a classic browser script: evaluate it the way a <script> tag
// would, against a stand-in global.
const holder = {};
new Function('self', 'module', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(holder, undefined);
const SDK = holder.StarHermit;

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `h.${b64u({ sub: 'user-77aa88bb', game_scope: 'pc-slug', exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;

function install(href) {
  const calls = [];
  const saves = {};
  const etags = {};
  let version = 0;
  const kv = { music: 0.1, 'ui.language': { choice: 'pt-BR' } };
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', init });
    const r = (status, body) => new Response(body, { status });
    const j = (o) => r(200, JSON.stringify(o));
    if (url === '/api/v1/users/user-77aa88bb/profile') return j({ username: 'hidden', nickname: 'Moss' });
    if (url === '/api/v1/users/user-77aa88bb/avatar') return r(404, '');
    if (url.includes('/cloud-saves/')) {
      // Versioned slot like the platform: /info carries the ETag, a PUT must
      // match it (If-Match) or target an empty slot (If-None-Match: *), else 412.
      const rest = decodeURIComponent(url.split('/cloud-saves/')[1]);
      const key = rest.replace(/\/info$/, '');
      if (rest.endsWith('/info')) return j(saves[key] ? { exists: true, etag: etags[key] } : { exists: false });
      if (init.method === 'PUT') {
        const hd = init.headers || {};
        if ((hd['If-Match'] && hd['If-Match'] !== etags[key]) || (hd['If-None-Match'] === '*' && saves[key])) {
          return r(412, JSON.stringify({ error: 'precondition failed', etag: etags[key] }));
        }
        saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        etags[key] = `"v${++version}"`;
        return j({ etag: etags[key] });
      }
      return saves[key] ? r(200, saves[key]) : r(404, '');
    }
    if (url.endsWith('/settings') && init.method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return j({}); }
    if (url.endsWith('/settings')) return j({ settings: kv });
    if (url.endsWith('/controls')) return j({ actions: [{ action: 'hint', codes: ['KeyQ'] }] });
    if (url.endsWith('/leaderboards')) return j([{ id: 'b1', key: 'high-score' }]);
    if (url.startsWith('/api/v1/leaderboards/b1/entries')) return j({ items: [{ userId: 'user-77aa88bb', score: 50, ticks: 9 }] });
    return r(404, '');
  };
  const u = new URL(href);
  const loc = { hash: u.hash, search: u.search, pathname: u.pathname, origin: u.origin, hostname: u.hostname, href };
  globalThis.window = { addEventListener() {} };
  globalThis.document = { addEventListener() {}, hidden: false };
  globalThis.fetch = fetch;
  globalThis.StarHermit = SDK.create({ window: { location: loc, history: { replaceState() {} } }, fetch, setTimeout: () => 0, clearTimeout: () => {} });
  return { calls, saves, etags, kv, fetch, loc };
}

test('hosted: token, identity, cloud save game:<slug>, settings, bindings, board', async () => {
  const h = install(`https://pc-slug.starhermit.com/#game_token=${TOKEN}`);
  const { Platform } = await import('../src/platform.js?hosted');
  const p = new Platform();
  p.init();
  assert.equal(p.hosted, true);
  assert.equal(p.userId, 'user-77aa88bb');
  assert.equal(p.slug, 'pc-slug');
  assert.deepEqual(await p.loadIdentity(), { name: 'Moss', avatar: null, guest: false });

  const doc = { profile: { name: 'Moss' }, boards: {} };
  p.docProvider = () => doc;
  p.scheduleCloudSave();
  assert.equal(await p.flushCloudSave(), true);
  assert.deepEqual(Object.keys(h.saves), ['game:pc-slug']);
  assert.deepEqual(await p.cloudLoad(), doc);

  assert.deepEqual(await p.loadRemoteSettings(), { music: 0.1, 'ui.language': { choice: 'pt-BR' } });
  await p.syncSettings({ music: 0.1, haptics: false, 'ui.language': { choice: 'de-DE' } }); // ui.* never mirrored
  const patches = h.calls.filter((c) => c.method === 'PATCH');
  assert.deepEqual(patches.map((c) => JSON.parse(c.init.body)), [{ settings: { haptics: false } }]);

  assert.deepEqual(await p.loadBindings({ hint: ['KeyH'], undo: ['KeyU'] }), { hint: ['KeyQ'], undo: ['KeyU'] });
  const board = await p.loadLeaderboard();
  assert.deepEqual(board, [{ name: 'Moss', me: true, score: 50, ticks: 9 }]);
  assert.ok(!h.calls.some((c) => /\/time|\/boards|\/presence|\/activity|\/telemetry/.test(c.url)), 'no own-server routes');
  assert.match(p.inviteLink(), /\/game-invite\/user-77aa88bb\/pc-slug$/);
});

test('standalone: no request at all (even on localhost)', async () => {
  const h = install('http://localhost:8080/index.html');
  const { Platform } = await import('../src/platform.js?standalone');
  const p = new Platform();
  p.init();
  p.docProvider = () => ({});
  assert.equal(p.hosted, false);
  assert.deepEqual(await p.loadIdentity(), { name: 'Guest', avatar: null, guest: true });
  assert.equal(await p.cloudLoad(), null);
  p.scheduleCloudSave();
  assert.deepEqual(await p.loadRemoteSettings(), {});
  assert.equal(await p.syncSettings({ music: 1 }), null);
  assert.deepEqual(await p.loadBindings({ hint: ['KeyH'] }), { hint: ['KeyH'] });
  assert.equal(await p.loadLeaderboard(), null);
  assert.equal(p.inviteLink(), null);
  assert.equal(p.canSignIn(), false);
  assert.ok(Math.abs(p.now() - Date.now()) < 50);
  assert.equal(h.calls.length, 0);
});

test('hosted: a save that lost to another device reloads, merges and saves on top', async () => {
  const h = install(`https://x.test/#game_token=${TOKEN}`);
  const { Platform } = await import('../src/platform.js?conflict');
  const { mergeProfile, mergeBoards } = await import('../src/storage.js');
  const p = new Platform();
  p.init();
  assert.equal(await p.cloudLoad(), null); // empty slot → next write is If-None-Match: *
  const other = SDK.create({ window: { location: h.loc, history: { replaceState() {} } }, fetch: h.fetch, setTimeout: () => 0, clearTimeout: () => {} });
  other.init();
  const remote = { profile: { name: 'Moss', journey: { c1s2: { stars: 3, bestScore: 400, completedAt: 5 } }, achievements: { 'first-light': 10 }, sessionsPlayed: 7, discoveries: ['feed', 'wash'], settings: { music: 0.9 } }, boards: { 'stage:c1s2': [{ name: 'Moss', score: 400, ticks: 30 }] } };
  assert.equal(await other.writeSave(JSON.stringify(remote)), true);
  let local = { profile: { name: 'Moss', journey: { c1s1: { stars: 2, bestScore: 200, completedAt: 3 } }, achievements: {}, sessionsPlayed: 2, discoveries: ['pet'], settings: { music: 0.2 } }, boards: { 'stage:c1s1': [{ name: 'Moss', score: 200, ticks: 20 }] } };
  p.docProvider = () => local;
  const got = new Promise((resolve) => { p.onSaveConflict = resolve; });
  p.scheduleCloudSave();
  assert.equal(await p.flushCloudSave(), false);
  const doc = await got;
  assert.deepEqual(doc, remote);
  const profile = mergeProfile(doc.profile, local.profile, { keepLocalSettings: true });
  assert.deepEqual(Object.keys(profile.journey).sort(), ['c1s1', 'c1s2']);
  assert.equal(profile.sessionsPlayed, 7);
  assert.deepEqual(profile.discoveries.sort(), ['feed', 'pet', 'wash']);
  assert.equal(profile.settings.music, 0.2); // this device's settings on a conflict
  assert.deepEqual(Object.keys(mergeBoards(doc.boards, local.boards)).sort(), ['stage:c1s1', 'stage:c1s2']);
  local = { profile, boards: mergeBoards(doc.boards, local.boards) };
  p.scheduleCloudSave();
  assert.equal(await p.flushCloudSave(), true);
});
