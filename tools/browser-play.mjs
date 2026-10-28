// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3): on the desktop Journey stage 1
// is played by the number keys and a click on Mote, paused by Escape and
// resumed, to its results; on the phone lesson 1 is played by finger (Feed
// from the tray, a tap on Mote, the refused Feed) and the pause and settings
// sheets open; sideways the Beat the Clock challenge is played by finger with
// the pause sheet and help. Widgets and Mote's named target are found through
// the page's accessibility mirror of the engine's UI. Screenshots of each step
// go to --shots. Fails on console errors or warnings, the runtime's error
// screen, or a view that does not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true })).or(page.getByText(name, { exact: true })).first();
  /** A press on a widget (or a table target): the mouse on the desktop, a finger on the phones. */
  const press = async (name, last = false) => {
    const el = last ? page.getByRole('button', { name, exact: true }).last() : find(name);
    await el.waitFor({ timeout: 15000 });
    const b = await el.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  const results = async () => { await page.getByText('Session complete', { exact: false }).first().waitFor({ timeout: 60000 }); await page.waitForTimeout(600); };
  let reached = false;
  try {
    await shot('title');
    if (v.name === 'desktop') {
      await press('Play');
      await press('Journey. 48 authored stages with mastery trials.');
      await press('1. First Supper. New: Feed');
      await press('Start');
      await find('Mote').waitFor({ timeout: 30000 });
      await page.waitForTimeout(2500);
      await shot('journey-1');
      await page.keyboard.press('Escape');
      await find('Resume').waitFor({ timeout: 15000 });
      await shot('pause');
      await press('Resume');
      await page.waitForTimeout(400);
      await page.keyboard.press('Digit1');
      await page.waitForTimeout(600);
      await shot('journey-1-fed');
      // a click on Mote pets it; it meets the craving and the stage's goal (the rules plan it so)
      await press('Mote');
      for (let i = 0; i < 80; i++) {
        if (await page.getByText('Session complete', { exact: false }).count()) break;
        await page.keyboard.press(i % 3 === 0 ? 'Digit1' : 'Digit3');
        await page.waitForTimeout(150);
      }
      await results();
      await shot('journey-1-results');
    } else if (v.name === 'phone') {
      await press('Play');
      await press('Learn. Short interactive lessons, one rule at a time.');
      await press('Lesson 1 — Feeding. Not yet completed');
      await find('Mote').waitFor({ timeout: 30000 });
      await page.waitForTimeout(2500);
      await shot('lesson-1');
      await press('Pause and menu');
      await find('Resume').waitFor({ timeout: 15000 });
      await shot('pause');
      // the sheet's Settings (the top bar's ⚙ has the same name)
      await press('Settings', true);
      await find('Done').waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      await shot('settings');
      await press('Done');
      await press('Resume');
      await page.waitForTimeout(400);
      await press('Feed');
      await page.waitForTimeout(500);
      await shot('lesson-1-fed');
      await press('Mote');
      await results();
      await shot('lesson-1-results');
    } else {
      await press('Play');
      await press('Challenge. Move limits, speed targets, restricted tools.');
      await press('Beat the Clock');
      // the setup scrolls on a short landscape screen: wheel it down to Start
      await page.mouse.move(422, 200);
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(600);
      await press('Start');
      await find('Mote').waitFor({ timeout: 30000 });
      await page.waitForTimeout(2500);
      await shot('challenge');
      for (const a of ['Play', 'Feed', 'Wash', 'Rest']) await press(a);
      await page.waitForTimeout(500);
      await shot('challenge-acted');
      await press('Pause and menu');
      await find('Resume').waitFor({ timeout: 15000 });
      await shot('pause');
      await press('Resume');
    }
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
