// The save model (src/progress.js): the save document, the two-device merge,
// the browser build's cloud document as a foreign save, the old settings KV as
// game options, the session-result bookkeeping (journey stars, the daily,
// bests, local boards, achievements) and journey unlocking. The signed-in
// paths (foreign save, legacy settings, score posting) can't be live-tested
// here; their logic is covered by these.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/progress.js';
import * as rules from '../src/rules.js';
import * as content from '../src/content.js';
import { Session } from '../src/session.js';

const json = (x) => JSON.parse(JSON.stringify(x));

test('default and normalized saves are JSON-safe and complete', () => {
  const d = P.defaultSave();
  assert.equal(d.v, P.DOC_VERSION);
  assert.equal(d.profile.name, 'Guest');
  assert.deepEqual(json(d), d);
  const n = P.normalize({ profile: { journey: { c1s1: { stars: 2, bestScore: 10, completedAt: 5 } }, settings: { music: 0.2 } }, boards: { x: [{ name: 'a', score: 3, ticks: 4 }] } });
  assert.equal(n.profile.journey.c1s1.stars, 2);
  assert.equal(n.profile.settings.music, 0.2);
  assert.equal(n.profile.settings.effects, P.DEFAULT_SETTINGS.effects);
  assert.equal(n.boards.x.length, 1);
  assert.deepEqual(P.normalize(null).profile.dailyDays, []);
});

test('merge keeps the best of both devices and stays JSON-safe', () => {
  const a = P.normalize({ profile: {
    journey: { c1s1: { stars: 1, bestScore: 50, completedAt: 200 }, c1s2: { stars: 3, bestScore: 10, completedAt: 0 } },
    daily: { '2026-01-01': { score: 10, completed: true } }, achievements: { 'first-light': 300 },
    discoveries: ['feed'], dailyDays: ['2026-01-01'], bestScores: { c1s1: 50 }, sessionsPlayed: 4,
  }, boards: { 'stage:c1s1': [{ name: 'A', score: 50, ticks: 10 }] } });
  const b = P.normalize({ profile: {
    journey: { c1s1: { stars: 3, bestScore: 40, completedAt: 100 }, c1s2: { stars: 1, bestScore: 20, completedAt: 0 } },
    daily: { '2026-01-01': { score: 30, completed: true }, '2026-01-02': { score: 5, completed: true } },
    achievements: { 'first-light': 100, 'deep-bond': 400 }, discoveries: ['wash'], dailyDays: ['2026-01-02'], bestScores: { c1s1: 60 }, sessionsPlayed: 2,
  }, boards: { 'stage:c1s1': [{ name: 'B', score: 70, ticks: 9 }] } });
  const m = P.mergeSave(a, b);
  assert.deepEqual(m.profile.journey.c1s1, { stars: 3, bestScore: 50, completedAt: 100 });
  assert.equal(m.profile.journey.c1s2.completedAt, 0, 'no Infinity for unknown times');
  assert.equal(m.profile.daily['2026-01-01'].score, 30);
  assert.ok(m.profile.daily['2026-01-02']);
  assert.equal(m.profile.achievements['first-light'], 100);
  assert.equal(m.profile.achievements['deep-bond'], 400);
  assert.deepEqual(m.profile.discoveries.sort(), ['feed', 'wash']);
  assert.deepEqual(m.profile.dailyDays, ['2026-01-01', '2026-01-02']);
  assert.equal(m.profile.bestScores.c1s1, 60);
  assert.equal(m.profile.sessionsPlayed, 4);
  assert.deepEqual(m.boards['stage:c1s1'].map((e) => e.name), ['B', 'A']);
  assert.deepEqual(json(m), m);
  assert.ok(P.sameSave(P.mergeSave(m, m), m), 'merging a save with itself changes nothing');
});

test('settings and name: the remote copy wins at start-up, this device on a conflict', () => {
  const remote = { profile: { name: 'Remote', settings: { palette: 'protanopia', tutorialSeen: { a: true } } } };
  const local = { profile: { name: 'Local', settings: { palette: 'default', tutorialSeen: { b: true } } } };
  const up = P.mergeSave(remote, local);
  assert.equal(up.profile.name, 'Remote');
  assert.equal(up.profile.settings.palette, 'protanopia');
  const conflict = P.mergeSave(remote, local, { keepLocalSettings: true });
  assert.equal(conflict.profile.name, 'Local');
  assert.deepEqual(Object.keys(conflict.profile.settings.tutorialSeen).sort(), ['a', 'b']);
});

test('the browser build\'s cloud document reads as a foreign save with its options', () => {
  const old = JSON.stringify({ profile: { name: 'Kit', settings: { palette: 'tritanopia', leftHanded: true, haptics: false, music: 0.1, gfx: { preset: 'high' } }, journey: { c1s1: { stars: 3, bestScore: 99, completedAt: 1 } } }, boards: { 'daily:2026-01-01': [{ name: 'Kit', score: 9, ticks: 3 }] } });
  const r = P.readForeign(old);
  assert.ok(r);
  assert.equal(r.save.profile.journey.c1s1.stars, 3);
  assert.equal(r.save.boards['daily:2026-01-01'][0].score, 9);
  assert.deepEqual(r.options, { palette: 'tritanopia', leftHanded: true, haptics: false });
  assert.equal(P.readForeign('not json'), null);
  assert.equal(P.readForeign(''), null);
  assert.equal(P.readForeign('{"x":1}'), null);
});

test('options pick only valid values; the old KV keys are all known', () => {
  assert.deepEqual(P.pickOptions({ palette: 'nope', captions: 'yes', timingAssist: true }), { timingAssist: true });
  for (const k of P.OPTION_KEYS) assert.ok(P.BROWSER_KEYS.includes(k));
});

/** Play a content config with the validator's greedy policy until it ends. */
function playOut(cfg, mode) {
  const s = new Session(cfg, { mode, undo: false, ranked: false, now: 1 });
  let i = 0;
  while (!s.terminal && i++ < 2000) {
    const legal = s.legal.filter((a) => a.legal && a.kind !== 'pass');
    const st = s.state;
    const low = [...rules.NEEDS].sort((a, b) => st.needs[a] - st.needs[b]);
    const want = { hunger: ['feed', 'snack'], hygiene: ['wash'], fun: ['play', 'toss', 'sing', 'pet'], energy: ['rest'] };
    let pick = null;
    for (const n of low) { pick = want[n].find((id) => legal.some((a) => a.id === id)); if (pick) break; }
    s.act(pick || 'wait');
  }
  return s;
}

test('a finished journey stage records stars, best, achievements and the local board', () => {
  const doc = P.defaultSave();
  const cfg = content.getStage('c1s1');
  const s = playOut(cfg, 'journey');
  assert.equal(s.state.status, 'complete');
  const rec = P.recordResult(doc.profile, { mode: 'journey', cfg, state: s.state, total: s.score.total, now: 1234 });
  assert.equal(rec.stars, P.starsFor(s.state.tick, cfg.par));
  assert.ok(rec.isBest);
  assert.equal(doc.profile.journey.c1s1.completedAt, 1234);
  assert.equal(doc.profile.sessionsPlayed, 1);
  const ach = P.evaluateAchievements(doc.profile, { state: s.state, bondLevel: s.bondLevel, cfg }, 1234);
  assert.ok(ach.includes('first-light'));
  assert.deepEqual(P.evaluateAchievements(doc.profile, { state: s.state, bondLevel: s.bondLevel, cfg }, 2000), [], 'achievements unlock once');
  P.submitLocalScore(doc, 'stage:c1s1', { name: 'Guest', score: 5, ticks: 9 });
  P.submitLocalScore(doc, 'stage:c1s1', { name: 'Guest', score: 8, ticks: 9 });
  assert.deepEqual(P.getLocalBoard(doc, 'stage:c1s1').map((e) => e.score), [8, 5]);
  assert.equal(P.journeyUnlockedCount(doc.profile, content.JOURNEY_STAGES), 2);
});

test('the daily records the first completion; later runs only raise the score', () => {
  const p = P.defaultSave().profile;
  const cfg = content.dailyConfig('2026-03-04');
  const state = { status: 'complete', tick: 50 };
  P.recordResult(p, { mode: 'daily', cfg, state, total: 100, now: 1 });
  P.recordResult(p, { mode: 'daily', cfg, state, total: 80, now: 2 });
  assert.equal(p.daily['2026-03-04'].score, 100);
  P.recordResult(p, { mode: 'daily', cfg, state, total: 120, now: 3 });
  assert.equal(p.daily['2026-03-04'].score, 120);
  assert.deepEqual(p.dailyDays, ['2026-03-04']);
});
