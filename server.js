/**
 * Pocket Companion — authoritative host script (StarHermit).
 * Zero-dependency Node server: static files, time sync, daily info, and
 * replay-validated leaderboards. Declared via starhermit.txt (server=server.js).
 *
 * Competitive claims are untrusted: every submitted score is re-simulated
 * from the replay envelope before it is accepted.
 */
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailyConfig, scoreChaseConfig, challengeConfig, getStage, CONTENT_VERSION } from './src/content.js';
import { verifyReplay } from './src/session.js';
import { fnv1a } from './src/rules.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(ROOT, 'data');
const BOARDS_FILE = join(DATA_DIR, 'leaderboards.json');
const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.opus': 'audio/ogg',
};

/* ---------------- durable boards ---------------- */
let boards = {};
async function loadBoards() {
  try { boards = JSON.parse(await readFile(BOARDS_FILE, 'utf8')); }
  catch { boards = {}; }
}
async function saveBoards() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(BOARDS_FILE, JSON.stringify(boards));
}

/* ---------------- helpers ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}

/** Resolve a board id to its content config (authoritative side). */
function contentForBoard(boardId) {
  const [kind, arg, extra] = boardId.split(':');
  if (extra !== undefined) return null;
  if (kind === 'daily') {
    // dailyConfig indexes a weekday table — reject malformed day keys instead
    // of throwing (a bad key would otherwise turn into a 500).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arg || '') || !Number.isFinite(Date.parse(arg + 'T00:00:00Z')) || new Date(arg + 'T00:00:00Z').toISOString().slice(0, 10) !== arg) return null;
    return dailyConfig(arg);
  }
  if (kind === 'chase') return scoreChaseConfig(Number(arg) >>> 0);
  if (kind === 'stage') return getStage(arg) || challengeConfig(arg);
  return null;
}

/** Plausibility/rate checks applied even when replay validation succeeds. */
function plausible(replay, verified) {
  if (!replay || typeof replay !== 'object') return false;
  if (replay.contentVersion !== CONTENT_VERSION) return false;
  if (!Array.isArray(replay.commands) || replay.commands.length === 0 || replay.commands.length > 5000) return false;
  if (verified.score.total < 0 || verified.score.total > 500000) return false;
  if (verified.ticks > 4000) return false;
  return true;
}

const rateBuckets = new Map();
function rateLimited(key, limit = 12, windowMs = 60_000) {
  const now = Date.now();
  const b = rateBuckets.get(key) || { count: 0, reset: now + windowMs };
  if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
  b.count += 1;
  rateBuckets.set(key, b);
  return b.count > limit;
}

/* ---------------- API ---------------- */
async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || 'anon';

  if (url.pathname === '/api/v1/time') {
    return json(res, 200, { now: Date.now() });
  }

  if (url.pathname === '/api/v1/me') {
    // Guest identity unless a real host shell injects one.
    return json(res, 200, { name: 'Guest', guest: true });
  }

  if (url.pathname === '/api/v1/daily') {
    const day = new Date().toISOString().slice(0, 10);
    const cfg = dailyConfig(day);
    return json(res, 200, {
      day, seed: cfg.seed, contentVersion: CONTENT_VERSION,
      ruleset: cfg.stageId, excluded: false, // defective days are excluded, never replaced
      endsAt: Date.parse(day + 'T23:59:59Z'),
    });
  }

  if (url.pathname === '/api/v1/presence' || url.pathname === '/api/v1/activity/start' || url.pathname === '/api/v1/activity/end') {
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/v1/telemetry') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' });
    // Aggregate-only funnel: keep counts, drop payloads beyond category.
    try { await readBody(req); } catch { return json(res, 400, { error: 'bad-json' }); }
    return json(res, 202, { ok: true });
  }

  const boardMatch = url.pathname.match(/^\/api\/v1\/boards\/([^/]+)(\/submit)?$/);
  if (boardMatch) {
    let boardId;
    try { boardId = decodeURIComponent(boardMatch[1]); } catch { return json(res, 400, { error: 'bad-board' }); }
    const isSubmit = !!boardMatch[2];

    if (isSubmit) {
      if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' });
      if (rateLimited('submit:' + ip)) return json(res, 429, { error: 'rate-limited' });
      let body;
      try { body = await readBody(req); }
      catch (e) { return json(res, 400, { error: e.message }); }

      const cfg = contentForBoard(boardId);
      if (!cfg) return json(res, 400, { error: 'unknown-board' });
      const replay = body.replay;

      // Authoritative validation: re-simulate the replay.
      const verified = verifyReplay(cfg, replay);
      if (!verified.ok) return json(res, 422, { error: 'replay-invalid', detail: verified.reason });
      if (verified.score.total !== Number(body.score)) return json(res, 422, { error: 'score-mismatch' });
      if (verified.status !== 'complete') return json(res, 422, { error: 'not-completed' });

      // Plausibility/rate checks against the authoritative verdict (the values
      // returned by verifyReplay), not against client-declared fields.
      if (!plausible(replay, verified)) return json(res, 400, { error: 'implausible-score' });

      const name = String(body.name || 'Guest').slice(0, 24).replace(/[<>&"]/g, '');
      const entry = {
        name, score: verified.score.total, ticks: verified.ticks,
        invalidAttempts: verified.invalidAttempts,
        assists: verified.assists,
        ruleset: cfg.stageId, contentVersion: CONTENT_VERSION, seed: cfg.seed,
        duration: verified.ticks, submittedAt: Date.now(),
        id: fnv1a(name + verified.finalHash).toString(16),
      };
      const list = boards[boardId] || (boards[boardId] = []);
      if (!list.some((e) => e.id === entry.id)) { // idempotent by replay hash
        list.push(entry);
        list.sort((a, b) => b.score - a.score || a.invalidAttempts - b.invalidAttempts || a.ticks - b.ticks || a.id.localeCompare(b.id));
        boards[boardId] = list.slice(0, 100);
        await saveBoards();
      }
      return json(res, 200, { ok: true, validated: true, rank: boards[boardId].findIndex((e) => e.id === entry.id) + 1 });
    }

    // Fetch board.
    const list = (boards[boardId] || []).slice(0, 50);
    return json(res, 200, { entries: list, validated: true, board: boardId });
  }

  return json(res, 404, { error: 'not-found' });
}

/* ---------------- static ---------------- */
async function serveStatic(req, res, url) {
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'bad-path' }); }
  if (path.split(/[\\/]/).some(p => p.startsWith('.'))) return json(res, 403, { error: 'forbidden' });
  if (path === '/') path = '/index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT) || file.includes('data' + '/') || path.endsWith('server.js')) {
    return json(res, 403, { error: 'forbidden' });
  }
  try {
    const data = await readFile(file);
    const ext = extname(file);
    const immutable = /^\.(js|css)$/.test(ext);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=3600' : 'no-store',
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not-found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    console.error('[server]', e);
    json(res, 500, { error: 'internal' });
  }
});

await loadBoards();
server.listen(PORT, () => console.log(`Pocket Companion serving on http://localhost:${PORT}`));
