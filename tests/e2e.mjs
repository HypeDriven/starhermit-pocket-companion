/**
 * Pocket Companion — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → Play → Practice (Steady) → care for Mote through the on-screen
 *   action tray to a real "Session complete — Mote is thriving!" result (the
 *   practice objective is Bond level 3, reached by the same greedy needs
 *   policy the game's own content validator proves reachable).
 *   Also exercises pause/resume, settings + help overlays, the Hint button
 *   and the Undo button through the visible controls.
 * A second pass runs the load → practice → tap-a-few-care-actions flow on a
 * mobile touch viewport (where the right HUD rail is hidden and only the
 * bottom action tray is used).
 *
 * The game exposes no state handle on `window`, so the test observes the
 * visible, semantic DOM only: it reads the four need bars, the Bond level,
 * the tick counter and each action-tray button's `data-legal` flag
 * (ui.js renders legality exactly as `rules.legalActions` returns it), then
 * picks the next legal care action with the same greedy policy the shipped
 * content validator (content.js `greedyPick`) uses. Every action is a real
 * click/tap on a visible action-tray button that routes through the normal
 * controller → Session → applyCommand path. No game code is modified and no
 * read-modify wrapper is installed.
 *
 * Serving: the repo ships `server.js` (the StarHermit authoritative script
 * declared by starhermit.txt), but the game is fully playable offline — the
 * platform adapter's `syncTime` only sets `apiAvailable=true` when `/api/v1/time`
 * returns a `now`, so with `{}` answers the client degrades to its documented
 * offline path (local casual boards) with zero console noise. Per the sibling
 * convention (picture-logic/blockstead/balance-spire) this test embeds a
 * minimal node:http static server on an ephemeral port and answers /api/*
 * probes with 200 `{}`. If the UI ever strictly requires the backend this
 * can be swapped for spawning `server.js`; today it is not needed.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/pocket-companion-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No StarHermit backend here: answer API probes with empty JSON (200) so
    // the platform adapter degrades to offline without console noise.
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- read the visible, semantic DOM (no game handle needed) ----------

// Reads the live HUD: need bars (permille), Bond level, tick counter, total
// score, craving bubble, and each action button's legality flag.
const readState = (page) => page.evaluate(() => {
  const active = (id) => document.getElementById(id).classList.contains('active');
  const screen = active('screen-results') ? 'results'
    : active('screen-game') ? 'game'
    : active('screen-setup') ? 'setup'
    : active('screen-modes') ? 'modes'
    : active('screen-title') ? 'title'
    : 'other';
  const needs = {};
  for (const n of ['hunger', 'hygiene', 'fun', 'energy']) {
    const v = document.querySelector(`.need-row[data-need="${n}"] .need-val`);
    needs[n] = v ? parseInt(v.textContent, 10) * 10 : null;
  }
  const legal = {};
  document.querySelectorAll('#action-tray .action-btn').forEach((b) => {
    legal[b.dataset.action] = b.dataset.legal === 'true';
  });
  const tm = (document.getElementById('tick-display').textContent || '').match(/Tick (\d+)/);
  const bm = (document.getElementById('bond-level').textContent || '').match(/Lv (\d+)/);
  return {
    screen,
    needs,
    legal,
    tick: tm ? parseInt(tm[1], 10) : null,
    tickLimit: (document.getElementById('tick-display').textContent || '').match(/\d+\s*\/\s*(\d+)/)?.length ? parseInt((document.getElementById('tick-display').textContent || '').match(/\d+\s*\/\s*(\d+)/)[1], 10) : null,
    bondLevel: bm ? parseInt(bm[1], 10) : null,
    score: parseInt(document.getElementById('score-total').textContent, 10) || 0,
    cravingHidden: document.getElementById('craving-bubble').classList.contains('hidden'),
  };
});

const screenActive = (page, name) =>
  page.waitForSelector(`#screen-${name}.active`, { state: 'visible', timeout: 15000 });

const ACTION_TICKS = { wait: 1, pet: 1, snack: 2, sing: 2, toss: 2, feed: 3, wash: 3, play: 4, rest: 5 };

// Same greedy needs policy the shipped content validator proves reaches the
// practice goal (content.js greedyPick): address the lowest need with the best
// legal care action, otherwise the cheapest legal non-pass action, else wait.
function pickAction(st) {
  const ASN = { hunger: ['feed', 'snack'], hygiene: ['wash'], fun: ['play', 'toss', 'sing', 'pet'], energy: ['rest'] };
  const sorted = ['hunger', 'hygiene', 'fun', 'energy'].sort((a, b) => st.needs[a] - st.needs[b]);
  for (const need of sorted) {
    for (const id of ASN[need]) if (st.legal[id]) return id;
  }
  const ids = Object.keys(st.legal).filter((id) => st.legal[id]);
  const cands = ids.filter((id) => id !== 'wait');
  const list = (cands.length ? cands : ids).sort((a, b) => ACTION_TICKS[a] - ACTION_TICKS[b]);
  return list[0] || 'wait';
}

const actionButton = (page, id) => page.locator(`#action-tray .action-btn[data-action="${id}"]`);

// Click a legal care action and wait for its tick cost to land, so the engine
// has accepted it before the next move.
async function doAction(page, id) {
  const before = (await readState(page)).tick;
  await actionButton(page, id).click();
  await page.waitForFunction((prev) => {
    const tm = (document.getElementById('tick-display').textContent || '').match(/Tick (\d+)/);
    return tm && parseInt(tm[1], 10) > prev;
  }, before, { timeout: 4000 });
}

// Play the practice round to a real completion on the visible action tray.
async function playToCompletion(page) {
  for (let guard = 0; guard < 120; guard++) {
    const st = await readState(page);
    if (st.screen === 'results') return st;
    if (st.screen !== 'game') throw new Error(`expected game screen while solving, got "${st.screen}"`);
    const id = pickAction(st);
    if (!st.legal[id]) throw new Error(`picked illegal action ${id}: ${JSON.stringify(st.legal)}`);
    await doAction(page, id);
    // Refuse to burn the whole guard on a run drifting toward neglect (should
    // not happen: the validator proves the policy reaches Bond 3).
    const now = await readState(page);
    const minNeed = Math.min(...Object.values(now.needs));
    if (minNeed < 20) throw new Error('needs bottomed out before goals: ' + JSON.stringify(now.needs));
  }
  throw new Error('did not reach results within guard limit');
}

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    // load → title
    await page.goto(BASE, { waitUntil: 'load' });
    await screenActive(page, 'title');
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible`);

    // Play → Practice (Steady) → Start
    await page.click('#btn-play');
    await screenActive(page, 'modes');
    ok(`${name}: mode select screen reached`);

    await page.locator('.mode-card[data-mode="practice"]').click();
    await screenActive(page, 'setup');
    const setupName = (await page.textContent('#setup-heading')).trim();
    await page.locator('.setup-choice[data-id="steady"]').click();
    await screenActive(page, 'setup');
    await page.click('#btn-start-session');
    await screenActive(page, 'game');

    // Real practice session state (no state handle needed — read the HUD).
    await page.waitForSelector('#action-tray .action-btn', { timeout: 10000 });
    const st0 = await readState(page);
    if (st0.screen !== 'game') throw new Error(`not in play: ${st0.screen}`);
    if (st0.tickLimit !== 220) throw new Error(`expected Steady 220-tick limit, got ${st0.tickLimit}`);
    if (st0.bondLevel !== 0) throw new Error(`expected Bond Lv 0 at start, got Lv ${st0.bondLevel}`);
    const legalCount = Object.values(st0.legal).filter(Boolean).length;
    if (legalCount < 4) throw new Error(`expected several care actions, got ${legalCount} legal`);
    await page.screenshot({ path: SHOT('play', name) });
    ok(`${name}: Practice — Steady session active (tick ${st0.tick}/${st0.tickLimit}, ${legalCount} legal actions, bond Lv ${st0.bondLevel})`);

    if (full) {
      // pause / resume via the visible buttons
      await page.click('#btn-pause');
      await page.waitForSelector('#overlay-pause:not(.hidden)', { timeout: 8000 });
      await page.screenshot({ path: SHOT('pause', name) });
      await page.click('#btn-resume');
      await page.waitForSelector('#overlay-pause', { state: 'hidden', timeout: 8000 });
      ok(`${name}: pause (⏸ Pause) and resume work`);

      // settings overlay open → Done, and help overlay open → Close
      await page.click('#btn-settings-top');
      await page.waitForSelector('#overlay-settings:not(.hidden)', { timeout: 8000 });
      await page.click('#btn-settings-close');
      await page.waitForSelector('#overlay-settings', { state: 'hidden', timeout: 8000 });
      await page.click('#btn-help-top');
      await page.waitForSelector('#overlay-help:not(.hidden)', { timeout: 8000 });
      const helpText = (await page.textContent('#help-body')) || '';
      if (!/Care for Mote/.test(helpText)) throw new Error('help overlay missing rule text');
      await page.click('#btn-help-close');
      await page.waitForSelector('#overlay-help', { state: 'hidden', timeout: 8000 });
      ok(`${name}: settings and help overlays open/close`);

      // Hint: highlights a suggested action button (suggested class)
      await page.click('#btn-hint');
      await page.waitForFunction(() => !!document.querySelector('#action-tray .action-btn.suggested'), null, { timeout: 4000 });
      const suggested = await page.evaluate(() => document.querySelector('#action-tray .action-btn.suggested')?.dataset.action);
      ok(`${name}: hint highlights a suggested action ("${suggested}")`);

      // Undo: perform one care action, undo it, tick returns
      const preAction = await readState(page);
      const first = pickAction(preAction);
      await doAction(page, first);
      const afterAction = await readState(page);
      if (afterAction.tick <= preAction.tick) throw new Error('care action did not advance tick');
      await page.click('#btn-undo');
      await page.waitForFunction((prev) => {
        const tm = (document.getElementById('tick-display').textContent || '').match(/Tick (\d+)/);
        return tm && parseInt(tm[1], 10) === prev;
      }, preAction.tick, { timeout: 4000 });
      const afterUndo = await readState(page);
      if (afterUndo.tick !== preAction.tick) throw new Error(`undo did not restore tick ${preAction.tick} (got ${afterUndo.tick})`);
      ok(`${name}: a care action (${first}) advanced to tick ${afterAction.tick}; undo returned to tick ${afterUndo.tick}`);

      // play to a real completion on the visible board
      await page.screenshot({ path: SHOT('mid', name) });
      const done = await playToCompletion(page);

      // results screen
      await page.waitForSelector('#screen-results.active', { timeout: 8000 });
      const headline = (await page.textContent('#results-headline')).trim();
      if (!/Session complete — Mote is thriving!/.test(headline)) throw new Error(`unexpected results headline: "${headline}"`);
      const rows = await page.locator('#results-table tbody tr').count();
      if (rows < 6) throw new Error(`score breakdown too short: ${rows} rows`);
      const achievementChips = await page.locator('#results-achievements .achievement-chip').count();
      await page.screenshot({ path: SHOT('results', name) });
      ok(`${name}: practice completed on-screen — results shown ("${headline}", ${rows} score rows, ${achievementChips} achievements)`);

      // persistence: session counted and a casual local board entry recorded
      const prof = await page.evaluate(() => {
        const raw = localStorage.getItem('pocket-companion:profile');
        return raw ? JSON.parse(raw).data : null;
      });
      if (!prof || !(prof.sessionsPlayed > 0)) throw new Error('practice completion not persisted: ' + JSON.stringify(prof));
      const boards = await page.evaluate(() => {
        const raw = localStorage.getItem('pocket-companion:boards');
        return raw ? JSON.parse(raw) : null;
      });
      const bd = boards && boards['stage:practice-steady'];
      if (!bd || bd.length < 1) throw new Error('local casual board entry not recorded');
      ok(`${name}: progress persisted (sessions: ${prof.sessionsPlayed}, casual board: ${bd.length} entry, achievements: ${Object.keys(prof.achievements || {}).length})`);
    } else {
      // mobile: make a few real care actions via touchscreen.tap
      let tapped = 0;
      for (let i = 0; i < 3; i++) {
        const st = await readState(page);
        const id = pickAction(st);
        const bb = await actionButton(page, id).boundingBox();
        if (!bb || bb.width < 1 || bb.height < 1) throw new Error(`tap target ${id} too small: ` + JSON.stringify(bb));
        const before = st.tick;
        await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await page.waitForFunction((prev) => {
          const tm = (document.getElementById('tick-display').textContent || '').match(/Tick (\d+)/);
          return tm && parseInt(tm[1], 10) > prev;
        }, before, { timeout: 4000 });
        tapped++;
      }
      const stFinal = await readState(page);
      if (stFinal.tick < tapped) throw new Error(`expected >=${tapped} ticks consumed, got ${stFinal.tick}`);
      if (stFinal.score < 1) throw new Error('no care points earned on mobile');
      await page.screenshot({ path: SHOT('mobile-play', name) });
      ok(`${name}: started practice and performed ${tapped} care actions via touch (tick ${stFinal.tick}, score ${stFinal.score})`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — pocket-companion, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
