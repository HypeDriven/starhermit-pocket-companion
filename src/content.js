/**
 * Pocket Companion — versioned content: themes, decor, journey stages,
 * tutorials, challenges, daily rulesets, and an offline content validator.
 * Dependency-light: imports only the rules module.
 */
import { ACTIONS, NEEDS, fnv1a, createGame, applyCommand, legalActions, isTerminal, bondLevel } from './rules.js';

export const CONTENT_VERSION = 1;
export const BUILD_VERSION = '1.0.0';

/* ------------------------------------------------------------------ *
 * Visual themes (presentation themes travel with content data).
 * ------------------------------------------------------------------ */
export const THEMES = [
  {
    id: 'hearthwood', name: 'Hearthwood',
    palette: { floor: 0x8a6b4f, wall: 0xd9c3a5, wallAccent: 0xb5895e, rug: 0xa34a3a, sky: 0x2b3a55, glow: 0xffc978, key: 0xffe0b3 },
    props: ['lamp', 'plant', 'shelf', 'window', 'cushion'],
    ambience: 'fireplace',
  },
  {
    id: 'tidepool', name: 'Tidepool',
    palette: { floor: 0x7fa8a0, wall: 0xcfe6e2, wallAccent: 0x6fa8a8, rug: 0x3f7f8f, sky: 0x9fd4e8, glow: 0xbff2ff, key: 0xeafcff },
    props: ['lamp', 'plant', 'window', 'cushion', 'shell'],
    ambience: 'waves',
  },
  {
    id: 'ember-dusk', name: 'Ember Dusk',
    palette: { floor: 0x5e4a52, wall: 0x8f6f7a, wallAccent: 0xc98a6b, rug: 0xd97b4a, sky: 0x3a2740, glow: 0xff9a5c, key: 0xffc49a },
    props: ['lamp', 'shelf', 'window', 'cushion', 'lantern'],
    ambience: 'crickets',
  },
  {
    id: 'meadow-dawn', name: 'Meadow Dawn',
    palette: { floor: 0x8fae6a, wall: 0xe9efd2, wallAccent: 0x9dbb72, rug: 0xe0a83c, sky: 0xbfe3ef, glow: 0xfff3b0, key: 0xfffbe0 },
    props: ['plant', 'window', 'cushion', 'shelf', 'flowers'],
    ambience: 'birds',
  },
  {
    id: 'starlit-den', name: 'Starlit Den',
    palette: { floor: 0x3f4260, wall: 0x6b6f96, wallAccent: 0x8f93bd, rug: 0x5a7fc9, sky: 0x141830, glow: 0xaac4ff, key: 0xcdd8ff },
    props: ['lamp', 'window', 'shelf', 'cushion', 'telescope'],
    ambience: 'night',
  },
];

export const DEFAULT_THEME = 'hearthwood';

/* ------------------------------------------------------------------ *
 * Decor items (cosmetic only — never affect rules).
 * ------------------------------------------------------------------ */
export const DECOR_ITEMS = [
  { id: 'rug-round', name: 'Round Rug', slot: 'floor' },
  { id: 'plant-fern', name: 'Potted Fern', slot: 'floor' },
  { id: 'lamp-paper', name: 'Paper Lamp', slot: 'light' },
  { id: 'shelf-oak', name: 'Oak Shelf', slot: 'wall' },
  { id: 'cushion-moon', name: 'Moon Cushion', slot: 'floor' },
  { id: 'poster-comet', name: 'Comet Poster', slot: 'wall' },
  { id: 'toy-blocks', name: 'Toy Blocks', slot: 'floor' },
  { id: 'bowl-gilded', name: 'Gilded Bowl', slot: 'table' },
  { id: 'curtains-star', name: 'Star Curtains', slot: 'window' },
  { id: 'clock-drift', name: 'Driftwood Clock', slot: 'wall' },
  { id: 'terrarium', name: 'Moss Terrarium', slot: 'table' },
  { id: 'banner-felt', name: 'Felt Banner', slot: 'wall' },
];

/* ------------------------------------------------------------------ *
 * Journey stages — 48 authored definitions across 6 chapters.
 * Mechanics are introduced in isolation, combined, then mastered.
 * ------------------------------------------------------------------ */

const CARE4 = ['feed', 'wash', 'play', 'rest', 'wait'];
const BOND = ['pet', 'sing', 'toss'];
const DECOR_POOL = DECOR_ITEMS.map((d) => d.id);

function stage(id, chapter, index, opts) {
  return {
    contentVersion: CONTENT_VERSION,
    id, chapter, index,
    name: opts.name,
    seed: (fnv1a('journey:' + id) >>> 0) || 1,
    tutorial: !!opts.tutorial,
    theme: opts.theme || THEMES[(chapter - 1) % THEMES.length].id,
    intro: opts.intro || '',
    allowedActions: opts.allowedActions || CARE4,
    allowedDecor: opts.allowedDecor || [],
    decay: opts.decay || { hunger: 4, hygiene: 3, fun: 4, energy: 2 },
    startNeeds: opts.startNeeds,
    goals: opts.goals,
    tickLimit: opts.tickLimit,
    maxCommands: opts.maxCommands || 0,
    cravingEvery: opts.cravingEvery ?? 22,
    timeBonusPerTick: opts.timeBonusPerTick ?? 6,
    par: opts.par, // par ticks for a comfortable clear
    mastery: !!opts.mastery,
    teaches: opts.teaches || [],
  };
}

function buildJourney() {
  const S = [];
  // Chapter 1 — Feeding & washing (two needs, isolated).
  const c1 = [
    ['First Supper', 'Mote is peckish. Feed it until the bowl is empty of worry.', { goals: { care: 60 }, tickLimit: 60, decay: { hunger: 6, hygiene: 1, fun: 1, energy: 1 }, allowedActions: ['feed', 'wait'], par: 12, tutorial: true, teaches: ['feed'] }],
    ['Bubble Trouble', 'A dusty arrival. Time for a bath.', { goals: { care: 80 }, tickLimit: 85, decay: { hunger: 1, hygiene: 6, fun: 1, energy: 1 }, allowedActions: ['wash', 'wait'], par: 14, tutorial: true, teaches: ['wash'] }],
    ['Full and Fresh', 'Keep both Hunger and Cleanliness tended together.', { goals: { care: 160 }, tickLimit: 90, decay: { hunger: 5, hygiene: 5, fun: 1, energy: 1 }, allowedActions: ['feed', 'wash', 'wait'], par: 24 }],
    ['A First Friend', 'Care builds Trust. Reach Bond level 1.', { goals: { bondLevel: 1 }, tickLimit: 110, decay: { hunger: 5, hygiene: 4, fun: 2, energy: 2 }, allowedActions: ['feed', 'wash', 'pet', 'wait'], par: 40, teaches: ['pet'] }],
    ['Picky Evening', 'Mote starts half full — careful timing earns more Trust.', { goals: { bondLevel: 1, care: 120 }, tickLimit: 110, decay: { hunger: 5, hygiene: 4, fun: 2, energy: 2 }, allowedActions: ['feed', 'wash', 'pet', 'wait'], startNeeds: { hunger: 800, hygiene: 700, fun: 600, energy: 850 }, par: 44 }],
    ['Steady Hands', 'A longer sit. Keep needs from bottoming out.', { goals: { care: 260 }, tickLimit: 150, decay: { hunger: 5, hygiene: 4, fun: 2, energy: 2 }, allowedActions: ['feed', 'wash', 'pet', 'wait'], par: 60 }],
    ['Snack Discovery', 'Something new: mooncake snacks. Try one.', { goals: { discoveries: 1, care: 150 }, tickLimit: 120, allowedActions: ['feed', 'wash', 'pet', 'snack', 'wait'], par: 40, teaches: ['snack'] }],
    ['Hearth Trial', 'Mastery: combine everything you know about care.', { goals: { bondLevel: 2, care: 300 }, tickLimit: 160, allowedActions: ['feed', 'wash', 'pet', 'snack', 'wait'], par: 66, mastery: true }],
  ];
  c1.forEach(([name, intro, o], i) => S.push(stage(`c1s${i + 1}`, 1, i + 1, { name, intro, ...o })));

  // Chapter 2 — Fun & energy (play/rest cycle).
  const c2 = [
    ['Blanket Tag', 'Mote wants to play! Watch its Energy.', { goals: { care: 120 }, tickLimit: 90, allowedActions: ['play', 'rest', 'wait'], decay: { hunger: 1, hygiene: 1, fun: 6, energy: 3 }, par: 20, tutorial: true, teaches: ['play', 'rest'] }],
    ['Worn Whiskers', 'Play hard, then nap. Balance the cycle.', { goals: { care: 220 }, tickLimit: 130, allowedActions: ['play', 'rest', 'wait'], decay: { hunger: 2, hygiene: 1, fun: 6, energy: 4 }, par: 40 }],
    ['Whole Picture', 'All four needs now drain. Keep the whole companion well.', { goals: { care: 300 }, tickLimit: 170, allowedActions: CARE4, par: 60 }],
    ['Sing a Little', 'A quiet tune goes a long way. Discover Sing.', { goals: { discoveries: 1, care: 200 }, tickLimit: 150, allowedActions: [...CARE4, 'sing'], par: 50, teaches: ['sing'] }],
    ['Yarn Ball', 'Discover the Toss. Great fun, real tiredness.', { goals: { discoveries: 1, care: 240 }, tickLimit: 150, allowedActions: [...CARE4, 'toss'], par: 52, teaches: ['toss'] }],
    ['Busy Burrow', 'Needs drain faster. Plan two actions ahead.', { goals: { care: 380 }, tickLimit: 180, allowedActions: CARE4, decay: { hunger: 6, hygiene: 5, fun: 6, energy: 3 }, par: 66 }],
    ['Trust Falls', 'Bond care matters now — reach Bond level 3.', { goals: { bondLevel: 3 }, tickLimit: 200, allowedActions: [...CARE4, ...BOND, 'snack'], par: 80 }],
    ['Tide Trial', 'Mastery: the full care cycle under pressure.', { goals: { bondLevel: 3, care: 420 }, tickLimit: 200, allowedActions: [...CARE4, ...BOND, 'snack'], decay: { hunger: 6, hygiene: 5, fun: 6, energy: 4 }, par: 84, mastery: true }],
  ];
  c2.forEach(([name, intro, o], i) => S.push(stage(`c2s${i + 1}`, 2, i + 1, { name, intro, ...o })));

  // Chapter 3 — Cravings (reading needs).
  const c3 = [
    ['A Little Craving', 'Mote sometimes wishes for something. Grant it for a bonus.', { goals: { care: 300 }, tickLimit: 170, allowedActions: [...CARE4, 'pet'], cravingEvery: 14, par: 58, tutorial: true, teaches: ['craving'] }],
    ['Wishing Well', 'Cravings come quicker now. Catch them.', { goals: { care: 380, bondLevel: 2 }, tickLimit: 180, allowedActions: [...CARE4, 'pet'], cravingEvery: 12, par: 62 }],
    ['Mixed Wishes', 'Cravings plus faster Fun drain.', { goals: { care: 420, bondLevel: 2 }, tickLimit: 190, allowedActions: [...CARE4, ...BOND], cravingEvery: 13, decay: { hunger: 5, hygiene: 4, fun: 7, energy: 3 }, par: 66 }],
    ['Gratitude', 'Discovery points stack. Find everything available.', { goals: { discoveries: 4 }, tickLimit: 200, allowedActions: [...CARE4, ...BOND, 'snack'], cravingEvery: 14, par: 60 }],
    ['Hungry Heart', 'Hunger dominates. Cravings point the way.', { goals: { care: 460 }, tickLimit: 190, allowedActions: [...CARE4, 'snack'], cravingEvery: 11, decay: { hunger: 8, hygiene: 3, fun: 4, energy: 3 }, par: 66 }],
    ['Grimy Games', 'Cleanliness dominates. Keep the bubbles coming.', { goals: { care: 460 }, tickLimit: 190, allowedActions: [...CARE4, 'sing'], cravingEvery: 11, decay: { hunger: 3, hygiene: 8, fun: 4, energy: 3 }, par: 66 }],
    ['Restless Night', 'Energy dominates. Nap smart, not often.', { goals: { care: 460, bondLevel: 3 }, tickLimit: 200, allowedActions: [...CARE4, ...BOND], cravingEvery: 12, decay: { hunger: 4, hygiene: 3, fun: 5, energy: 6 }, par: 72 }],
    ['Ember Trial', 'Mastery: cravings, full cycle, tight clock.', { goals: { bondLevel: 4, care: 520 }, tickLimit: 210, allowedActions: [...CARE4, ...BOND, 'snack'], cravingEvery: 12, decay: { hunger: 6, hygiene: 5, fun: 6, energy: 4 }, par: 88, mastery: true }],
  ];
  c3.forEach(([name, intro, o], i) => S.push(stage(`c3s${i + 1}`, 3, i + 1, { name, intro, ...o })));

  // Chapter 4 — Room customization.
  const c4 = [
    ['A Room of One\'s Own', 'Place a decoration. It costs nothing and means a lot.', { goals: { decor: 1 }, tickLimit: 100, allowedActions: [...CARE4, 'decorate'], allowedDecor: DECOR_POOL.slice(0, 3), par: 20, tutorial: true, teaches: ['decorate'] }],
    ['Cozy Corners', 'Three decorations make a den.', { goals: { decor: 3, care: 200 }, tickLimit: 170, allowedActions: [...CARE4, 'decorate'], allowedDecor: DECOR_POOL.slice(0, 5), par: 56 }],
    ['Curator', 'Discover every decoration on offer.', { goals: { discoveries: 5 }, tickLimit: 200, allowedActions: [...CARE4, 'pet', 'decorate'], allowedDecor: DECOR_POOL.slice(0, 6), par: 60 }],
    ['Warm Welcome', 'A decorated room and a content companion.', { goals: { decor: 4, bondLevel: 3 }, tickLimit: 210, allowedActions: [...CARE4, ...BOND, 'decorate'], allowedDecor: DECOR_POOL.slice(0, 8), par: 76 }],
    ['Meadow Morning', 'Dawn light, new things, quick needs.', { goals: { decor: 4, care: 420 }, tickLimit: 200, allowedActions: [...CARE4, ...BOND, 'decorate'], allowedDecor: DECOR_POOL.slice(0, 8), decay: { hunger: 6, hygiene: 5, fun: 6, energy: 4 }, par: 74 }],
    ['Full House', 'Six placed pieces, all needs tended.', { goals: { decor: 6, care: 460 }, tickLimit: 220, allowedActions: [...CARE4, ...BOND, 'snack', 'decorate'], allowedDecor: DECOR_POOL.slice(0, 10), par: 80 }],
    ['Open House', 'Everything unlocked. Show off.', { goals: { decor: 6, discoveries: 8 }, tickLimit: 230, allowedActions: [...CARE4, ...BOND, 'snack', 'decorate'], allowedDecor: DECOR_POOL, par: 78 }],
    ['Meadow Trial', 'Mastery: full house, full heart, full clock.', { goals: { decor: 6, bondLevel: 4, care: 500 }, tickLimit: 240, allowedActions: [...CARE4, ...BOND, 'snack', 'decorate'], allowedDecor: DECOR_POOL, decay: { hunger: 6, hygiene: 5, fun: 6, energy: 4 }, par: 92, mastery: true }],
  ];
  c4.forEach(([name, intro, o], i) => S.push(stage(`c4s${i + 1}`, 4, i + 1, { name, intro, ...o })));

  // Chapter 5 — Pressure (tight limits, restricted tools).
  const c5 = [
    ['Half Pantry', 'No snacks, faster hunger. Stretch every meal.', { goals: { care: 420 }, tickLimit: 180, allowedActions: [...CARE4, 'pet'], decay: { hunger: 7, hygiene: 4, fun: 5, energy: 3 }, par: 64 }],
    ['Low Suds', 'Washing is off today. Keep Fun and Hunger up instead.', { goals: { care: 380 }, tickLimit: 180, allowedActions: ['feed', 'play', 'rest', 'pet', 'sing', 'wait'], decay: { hunger: 6, hygiene: 2, fun: 7, energy: 3 }, par: 62 }],
    ['Quiet Day', 'No toys, no songs. Gentle care only.', { goals: { bondLevel: 3, care: 380 }, tickLimit: 200, allowedActions: [...CARE4, 'pet'], par: 70 }],
    ['Tick Tock', 'A short clock. Every action counts.', { goals: { care: 300 }, tickLimit: 120, allowedActions: [...CARE4, ...BOND], decay: { hunger: 6, hygiene: 5, fun: 6, energy: 4 }, timeBonusPerTick: 10, par: 50 }],
    ['Frugal Care', 'Only 40 actions allowed. Waste nothing.', { goals: { care: 520 }, tickLimit: 260, maxCommands: 40, allowedActions: [...CARE4, ...BOND, 'snack'], decay: { hunger: 6, hygiene: 5, fun: 6, energy: 4 }, par: 96 }],
    ['Storm Watch', 'Everything drains at once. Stay calm, stay ordered.', { goals: { care: 560 }, tickLimit: 230, allowedActions: [...CARE4, ...BOND, 'snack'], decay: { hunger: 7, hygiene: 6, fun: 7, energy: 5 }, cravingEvery: 12, par: 96 }],
    ['Long Night', 'A marathon sit. Bond deep.', { goals: { bondLevel: 5 }, tickLimit: 300, allowedActions: [...CARE4, ...BOND, 'snack'], decay: { hunger: 5, hygiene: 4, fun: 5, energy: 3 }, par: 120 }],
    ['Starlit Trial', 'Mastery: pressure from every direction.', { goals: { bondLevel: 4, care: 640 }, tickLimit: 280, maxCommands: 75, allowedActions: [...CARE4, ...BOND, 'snack'], decay: { hunger: 7, hygiene: 6, fun: 7, energy: 5 }, cravingEvery: 12, par: 116, mastery: true }],
  ];
  c5.forEach(([name, intro, o], i) => S.push(stage(`c5s${i + 1}`, 5, i + 1, { name, intro, ...o })));

  // Chapter 6 — Mastery combinations.
  const c6 = [
    ['Second Nature', 'Everything at once: care, bond, cravings, decor.', { goals: { bondLevel: 4, decor: 4 }, tickLimit: 260, allowedActions: [...CARE4, ...BOND, 'snack', 'decorate'], allowedDecor: DECOR_POOL.slice(0, 8), cravingEvery: 13, par: 92 }],
    ['The Long Game', 'Deep bond under a fixed move budget.', { goals: { bondLevel: 4 }, tickLimit: 340, maxCommands: 95, allowedActions: [...CARE4, ...BOND, 'snack'], cravingEvery: 14, par: 128 }],
    ['Perfect Week', 'High care target, high clock, no snacks.', { goals: { care: 700 }, tickLimit: 280, allowedActions: [...CARE4, ...BOND], decay: { hunger: 6, hygiene: 6, fun: 6, energy: 4 }, cravingEvery: 13, par: 108 }],
    ['Collector', 'Every decoration placed, every interaction found.', { goals: { decor: 8, discoveries: 10 }, tickLimit: 300, allowedActions: [...CARE4, ...BOND, 'snack', 'decorate'], allowedDecor: DECOR_POOL, par: 100 }],
    ['Whirlwind', 'Fast drains, fast cravings, fast you.', { goals: { care: 720, bondLevel: 4 }, tickLimit: 260, allowedActions: [...CARE4, ...BOND, 'snack'], decay: { hunger: 8, hygiene: 7, fun: 8, energy: 5 }, cravingEvery: 10, par: 108 }],
    ['Old Friends', 'Bond level 5 — a true companion.', { goals: { bondLevel: 5 }, tickLimit: 460, maxCommands: 160, allowedActions: [...CARE4, ...BOND, 'snack', 'decorate'], allowedDecor: DECOR_POOL, cravingEvery: 13, par: 136 }],
    ['Grand Gathering', 'Care, decor, discoveries — all of it.', { goals: { care: 800, decor: 8, discoveries: 11 }, tickLimit: 340, allowedActions: [...CARE4, ...BOND, 'snack', 'decorate'], allowedDecor: DECOR_POOL, cravingEvery: 12, par: 130 }],
    ['Pocket Master', 'The final trial. Everything you have learned, together.', { goals: { bondLevel: 6, care: 900, decor: 8 }, tickLimit: 400, maxCommands: 120, allowedActions: [...CARE4, ...BOND, 'snack', 'decorate'], allowedDecor: DECOR_POOL, decay: { hunger: 7, hygiene: 6, fun: 7, energy: 5 }, cravingEvery: 11, par: 148, mastery: true }],
  ];
  c6.forEach(([name, intro, o], i) => S.push(stage(`c6s${i + 1}`, 6, i + 1, { name, intro, ...o })));

  return S;
}

export const JOURNEY_STAGES = buildJourney();

export function getStage(id) {
  return JOURNEY_STAGES.find((s) => s.id === id) || null;
}

/* ------------------------------------------------------------------ *
 * Learn mode — interactive lessons; each requires performing the action
 * through the same legal-action API used by play.
 * ------------------------------------------------------------------ */
export const LESSONS = [
  {
    id: 'lesson-feed', title: 'Lesson 1 — Feeding', stageId: 'c1s1',
    steps: [
      { text: 'This is Mote, your pocket companion. Its Hunger bar is dropping. Press **Feed** (or key 1).', require: { action: 'feed' } },
      { text: 'Mote is full now. Try to **Feed** again anyway — the game refuses illegal actions and tells you why.', require: { invalid: 'feed' } },
    ],
  },
  {
    id: 'lesson-wash', title: 'Lesson 2 — Washing', stageId: 'c1s2',
    steps: [
      { text: 'Cleanliness matters too. Press **Wash** when the hygiene bar dips.', require: { action: 'wash' } },
      { text: 'Great. Illegal actions are refused with a reason — try to **Wash** a clean Mote to see.', require: { invalid: 'wash' } },
    ],
  },
  {
    id: 'lesson-play-rest', title: 'Lesson 3 — Play & Rest', stageId: 'c2s1',
    steps: [
      { text: 'Fun drains quickly. **Play** raises Fun but costs Energy.', require: { action: 'play' } },
      { text: 'Energy is low after play. **Rest** restores it.', require: { action: 'rest' } },
    ],
  },
  {
    id: 'lesson-craving', title: 'Lesson 4 — Cravings', stageId: 'c3s1',
    steps: [
      { text: 'Sometimes Mote wishes for something — watch for the thought bubble. Grant any wish you see.', require: { craving: true } },
      { text: 'Bonus points! Cravings are seeded — the same day always offers the same wishes.', require: { action: 'wait' } },
    ],
  },
  {
    id: 'lesson-decorate', title: 'Lesson 5 — Decorating', stageId: 'c4s1',
    steps: [
      { text: 'Open **Decorate** and place any item. It is free and permanent for the session.', require: { action: 'decorate' } },
    ],
  },
];

export function getLesson(id) { return LESSONS.find((l) => l.id === id) || null; }

/* ------------------------------------------------------------------ *
 * Practice difficulties
 * ------------------------------------------------------------------ */
export const PRACTICE_DIFFICULTIES = [
  { id: 'gentle', name: 'Gentle', decay: { hunger: 3, hygiene: 2, fun: 3, energy: 1 }, tickLimit: 240, goals: { bondLevel: 2 }, cravingEvery: 26 },
  { id: 'steady', name: 'Steady', decay: { hunger: 5, hygiene: 4, fun: 5, energy: 3 }, tickLimit: 220, goals: { bondLevel: 3 }, cravingEvery: 20 },
  { id: 'brisk', name: 'Brisk', decay: { hunger: 7, hygiene: 6, fun: 7, energy: 4 }, tickLimit: 220, goals: { bondLevel: 4 }, cravingEvery: 14 },
  { id: 'storm', name: 'Storm', decay: { hunger: 9, hygiene: 8, fun: 9, energy: 6 }, tickLimit: 240, goals: { bondLevel: 5 }, cravingEvery: 10 },
];

export function practiceConfig(difficultyId, seed) {
  const d = PRACTICE_DIFFICULTIES.find((x) => x.id === difficultyId) || PRACTICE_DIFFICULTIES[1];
  return {
    contentVersion: CONTENT_VERSION,
    id: `practice-${d.id}`, stageId: `practice-${d.id}`, name: `Practice — ${d.name}`,
    seed: (seed >>> 0) || 1, theme: DEFAULT_THEME,
    allowedActions: [...CARE4, ...BOND, 'snack'], allowedDecor: DECOR_POOL.slice(0, 6),
    decay: d.decay, goals: d.goals, tickLimit: d.tickLimit, maxCommands: 0,
    cravingEvery: d.cravingEvery, timeBonusPerTick: 6, par: Math.floor(d.tickLimit / 2),
    intro: 'A relaxed session. Undo is available and results are never ranked.',
  };
}

/* ------------------------------------------------------------------ *
 * Challenge variants (constrained goals).
 * ------------------------------------------------------------------ */
export const CHALLENGES = [
  { id: 'challenge-moves', name: 'Forty-Five Moves', blurb: 'Reach Bond 4 with only 45 actions.', base: 'c5s5', modify: { maxCommands: 45, tickLimit: 300, goals: { bondLevel: 4 } } },
  { id: 'challenge-speed', name: 'Beat the Clock', blurb: 'Care 400 before tick 120 — time bonus tripled.', base: 'c5s4', modify: { goals: { care: 400 }, tickLimit: 120, timeBonusPerTick: 18 } },
  { id: 'challenge-restricted', name: 'Bare Paws', blurb: 'Only Feed, Rest and Pet. Bond 2, Care 320.', base: 'c5s3', modify: { allowedActions: ['feed', 'rest', 'pet', 'wait'], goals: { bondLevel: 2, care: 320 }, tickLimit: 260 } },
  { id: 'challenge-cravings', name: 'Wishful Thinking', blurb: 'Cravings every 8 ticks. Care 500.', base: 'c3s2', modify: { cravingEvery: 8, goals: { care: 500 }, tickLimit: 220 } },
  { id: 'challenge-decor', name: 'Interior Designer', blurb: 'Place 8 decorations in 100 ticks.', base: 'c4s7', modify: { goals: { decor: 8 }, tickLimit: 100, timeBonusPerTick: 12 } },
];

export function challengeConfig(challengeId) {
  const c = CHALLENGES.find((x) => x.id === challengeId);
  if (!c) return null;
  const base = getStage(c.base);
  const merged = { ...base, ...c.modify, goals: { ...base.goals, ...(c.modify.goals || {}) } };
  return {
    ...merged,
    id: c.id, stageId: c.id, name: c.name, intro: c.blurb,
    seed: (fnv1a('challenge:' + c.id) >>> 0) || 1,
  };
}

/* ------------------------------------------------------------------ *
 * Daily challenge — one shared seed + ruleset per UTC day, immutable.
 * ------------------------------------------------------------------ */
export function dailyKeyFor(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function dailyConfig(dayKey) {
  const key = dayKey || dailyKeyFor();
  const seed = (fnv1a('daily:' + key) >>> 0) || 1;
  // Deterministic, bounded variation by weekday — published forever once used.
  const weekday = new Date(key + 'T00:00:00Z').getUTCDay();
  const themes = THEMES.map((t) => t.id);
  const variants = [
    { decay: { hunger: 6, hygiene: 4, fun: 5, energy: 3 }, cravingEvery: 16, goals: { bondLevel: 3, care: 420 }, tickLimit: 200 },
    { decay: { hunger: 4, hygiene: 6, fun: 5, energy: 3 }, cravingEvery: 15, goals: { care: 460 }, tickLimit: 200 },
    { decay: { hunger: 5, hygiene: 4, fun: 7, energy: 4 }, cravingEvery: 14, goals: { bondLevel: 4 }, tickLimit: 220 },
    { decay: { hunger: 7, hygiene: 5, fun: 6, energy: 4 }, cravingEvery: 13, goals: { care: 500 }, tickLimit: 210 },
    { decay: { hunger: 5, hygiene: 5, fun: 6, energy: 5 }, cravingEvery: 14, goals: { bondLevel: 4, care: 400 }, tickLimit: 230 },
    { decay: { hunger: 6, hygiene: 6, fun: 6, energy: 4 }, cravingEvery: 12, goals: { care: 540 }, tickLimit: 220 },
    { decay: { hunger: 5, hygiene: 4, fun: 6, energy: 3 }, cravingEvery: 15, goals: { bondLevel: 4, care: 380 }, tickLimit: 260 },
  ];
  const v = variants[weekday];
  return {
    contentVersion: CONTENT_VERSION,
    id: `daily-${key}`, stageId: `daily-${key}`, name: `Daily — ${key}`,
    seed, theme: themes[seed % themes.length],
    allowedActions: [...CARE4, ...BOND, 'snack'], allowedDecor: DECOR_POOL.slice(0, seed % 4 + 3),
    decay: v.decay, goals: v.goals, tickLimit: v.tickLimit, maxCommands: 0,
    cravingEvery: v.cravingEvery, timeBonusPerTick: 8, par: Math.floor(v.tickLimit / 2),
    intro: 'One shared seed for everyone today. Ranked.',
    dailyKey: key,
  };
}

/* ------------------------------------------------------------------ *
 * Score-chase (asynchronous comparison) boards.
 * ------------------------------------------------------------------ */
export function scoreChaseConfig(seedNumber) {
  const seed = (seedNumber >>> 0) || 1;
  return {
    contentVersion: CONTENT_VERSION,
    id: `chase-${seed}`, stageId: `chase-${seed}`, name: `Score Chase #${seed}`,
    seed, theme: THEMES[seed % THEMES.length].id,
    allowedActions: [...CARE4, ...BOND, 'snack'], allowedDecor: DECOR_POOL.slice(0, 6),
    decay: { hunger: 6, hygiene: 5, fun: 6, energy: 4 },
    goals: { care: 500, bondLevel: 3 }, tickLimit: 220, maxCommands: 0,
    cravingEvery: 15, timeBonusPerTick: 8, par: 100,
    intro: 'Chase the highest total score on a shared validated seed.',
  };
}

/* ------------------------------------------------------------------ *
 * Generic config → rules config adapter.
 * ------------------------------------------------------------------ */
export function toRulesConfig(contentCfg) {
  return {
    stageId: contentCfg.stageId || contentCfg.id,
    seed: contentCfg.seed,
    tickLimit: contentCfg.tickLimit,
    maxCommands: contentCfg.maxCommands,
    decay: contentCfg.decay,
    goals: contentCfg.goals,
    allowedActions: contentCfg.allowedActions,
    allowedDecor: contentCfg.allowedDecor,
    startNeeds: contentCfg.startNeeds,
    cravingEvery: contentCfg.cravingEvery,
    timeBonusPerTick: contentCfg.timeBonusPerTick,
  };
}

/* ------------------------------------------------------------------ *
 * Offline content validator — proves basic legality, reachable goals,
 * bounded duration, and absence of soft locks for every stage.
 * Returns {ok, errors:[...]}.
 * ------------------------------------------------------------------ */

/** Greedy policy: address the lowest need with the best legal action. */
function greedyPick(state) {
  const legal = legalActions(state).filter((a) => a.legal && a.kind !== 'pass');
  const wantsDecor =
    (state.goals.decor && state.decorPlaced.length < state.goals.decor) ||
    (state.goals.discoveries && state.discovered.length < state.goals.discoveries);
  if (wantsDecor) {
    const deco = legal.find((a) => a.id === 'decorate');
    const item = state.allowedDecor.find((i) => !state.decorPlaced.includes(i));
    if (deco && item) return { type: 'decorate', args: { item } };
  }
  const actionForNeed = {
    hunger: ['feed', 'snack'], hygiene: ['wash'], fun: ['play', 'toss', 'sing', 'pet'], energy: ['rest'],
  };
  const sorted = [...NEEDS].sort((a, b) => state.needs[a] - state.needs[b]);
  for (const need of sorted) {
    for (const id of actionForNeed[need]) {
      if (legal.some((a) => a.id === id)) return { type: id, args: {} };
    }
  }
  // Bond targets: spam the cheapest legal bond/care action.
  if (legal.length) {
    legal.sort((a, b) => a.ticks - b.ticks);
    return { type: legal[0].id, args: {} };
  }
  return { type: 'wait', args: {} };
}

export function validateContent(cfg, { maxTicks = 4000 } = {}) {
  const errors = [];
  if (!cfg.id || !cfg.seed) errors.push(`${cfg.id || '?'}: missing id/seed`);
  if (!Array.isArray(cfg.allowedActions) || cfg.allowedActions.length === 0) errors.push(`${cfg.id}: no actions`);
  for (const a of cfg.allowedActions || []) if (!ACTIONS[a]) errors.push(`${cfg.id}: unknown action ${a}`);
  for (const d of cfg.allowedDecor || []) if (!DECOR_ITEMS.some((x) => x.id === d)) errors.push(`${cfg.id}: unknown decor ${d}`);
  if (!cfg.tickLimit || cfg.tickLimit <= 0 || cfg.tickLimit > maxTicks) errors.push(`${cfg.id}: unbounded or absurd tick limit`);
  const hasGoal = cfg.goals && (cfg.goals.bondLevel || cfg.goals.care || cfg.goals.discoveries || cfg.goals.decor);
  if (!hasGoal) errors.push(`${cfg.id}: no goals`);
  if (errors.length) return { ok: false, errors };

  // Reachability + no-softlock: greedy bot must finish before the limit.
  const state = createGame(toRulesConfig(cfg));
  let i = 0;
  while (!isTerminal(state) && i < 2000) {
    const pick = greedyPick(state);
    const r = applyCommand(state, { id: `v${i}`, type: pick.type, args: pick.args });
    if (!r.ok) applyCommand(state, { id: `v${i}w`, type: 'wait', args: {} });
    i++;
  }
  if (state.status !== 'complete') {
    errors.push(`${cfg.id}: greedy solver could not reach goals (ended ${state.status}/${state.terminalReason} at tick ${state.tick}, bond ${bondLevel(state)}, care ${state.score.care}, disc ${state.discovered.length}, decor ${state.decorPlaced.length})`);
  } else if (state.tick >= cfg.tickLimit) {
    errors.push(`${cfg.id}: solved but over tick limit`);
  }
  return { ok: errors.length === 0, errors, solvedTick: state.tick, bond: bondLevel(state) };
}

export function validateAllContent(log = () => {}) {
  const all = [
    ...JOURNEY_STAGES,
    ...PRACTICE_DIFFICULTIES.map((d) => practiceConfig(d.id, 12345)),
    ...CHALLENGES.map((c) => challengeConfig(c.id)),
    dailyConfig('2026-01-01'), dailyConfig('2026-01-02'), dailyConfig('2026-01-03'),
    dailyConfig('2026-01-04'), dailyConfig('2026-01-05'), dailyConfig('2026-01-06'), dailyConfig('2026-01-07'),
    scoreChaseConfig(7),
  ];
  let ok = true;
  for (const cfg of all) {
    const r = validateContent(cfg);
    if (!r.ok) { ok = false; r.errors.forEach((e) => log('FAIL ' + e)); }
    else log(`ok   ${cfg.id} (solved at tick ${r.solvedTick}/${cfg.tickLimit})`);
  }
  return ok;
}

/** Serialize a stage config for hashing / replay envelopes. */
export function contentHash(cfg) {
  return fnv1a(JSON.stringify(toRulesConfig(cfg))).toString(16).padStart(8, '0');
}
