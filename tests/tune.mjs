/** Balance probe: greedy-solve every content item and report outcome. */
import { validateContent, JOURNEY_STAGES, PRACTICE_DIFFICULTIES, practiceConfig, CHALLENGES, challengeConfig, dailyConfig, scoreChaseConfig } from '../src/content.js';

const all = [
  ...JOURNEY_STAGES,
  ...PRACTICE_DIFFICULTIES.map((d) => practiceConfig(d.id, 12345)),
  ...CHALLENGES.map((c) => challengeConfig(c.id)),
  ...['2026-01-01','2026-01-02','2026-01-03','2026-01-04','2026-01-05','2026-01-06','2026-01-07'].map(dailyConfig),
  scoreChaseConfig(7),
];
let fails = 0;
for (const cfg of all) {
  const r = validateContent(cfg);
  const goalDesc = Object.entries(cfg.goals).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(',');
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${cfg.id.padEnd(22)} goals[${goalDesc}] limit=${cfg.tickLimit} solved=${r.solvedTick ?? '-'} bond=${r.bond ?? '-'}`);
  if (!r.ok) fails++;
}
console.log(fails ? `\n${fails} failing` : '\nall pass');
