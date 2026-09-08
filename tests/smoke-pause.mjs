/**
 * Targeted smoke test for review fixes (dev only, not shipped):
 *  1. Auto-pause on tab background must show the pause sheet (previously a
 *     soft lock: no Resume control was reachable after backgrounding).
 *  2. Resume must restore play (action tray works again).
 *  3. Resume-from-snapshot keeps practice undo enabled (previously lost).
 * Run: node tests/smoke-pause.mjs
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.opus': 'audio/ogg', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    if (p.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'] });
const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/GL Driver|swiftshader|Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.click('#btn-play');
  await page.locator('.mode-card[data-mode="practice"]').click();
  await page.click('#btn-start-session');
  await page.waitForSelector('#screen-game.active #action-tray .action-btn', { timeout: 15000 });

  // Simulate tab backgrounding during active play.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForSelector('#overlay-pause:not(.hidden)', { timeout: 4000 });
  console.log('ok - auto-pause on background shows the pause sheet (Resume reachable)');

  // Back to foreground; resume via the sheet.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.click('#btn-resume');
  await page.waitForSelector('#overlay-pause', { state: 'hidden', timeout: 4000 });
  const tickBefore = await page.evaluate(() => document.getElementById('tick-display').textContent);
  await page.locator('#action-tray .action-btn[data-action="pet"]').click();
  await page.waitForFunction((prev) => document.getElementById('tick-display').textContent !== prev, tickBefore, { timeout: 4000 });
  console.log('ok - resume after auto-pause restores play (Pet advanced the tick)');

  // Reload mid-session and resume from the snapshot; undo must still work in practice.
  await page.reload({ waitUntil: 'load' });
  const resumeCard = page.locator('.title-cards .card', { hasText: 'Resume session' });
  await resumeCard.waitFor({ timeout: 8000 });
  await resumeCard.click();
  await page.waitForSelector('#screen-game.active', { timeout: 8000 });
  const undoVisible = await page.locator('#btn-undo').isVisible();
  if (!undoVisible) throw new Error('undo button hidden after snapshot resume in practice');
  await page.locator('#action-tray .action-btn[data-action="pet"]').click();
  await page.waitForFunction(() => !document.getElementById('btn-undo').disabled, null, { timeout: 4000 });
  console.log('ok - snapshot resume keeps practice undo enabled');

  if (errors.length) throw new Error('page errors:\n  ' + errors.join('\n  '));
  console.log('ok - no page errors');
  console.log('\nSMOKE PASS — pause/resume + snapshot-resume fixes verified');
} catch (e) {
  console.error('\nSMOKE FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
