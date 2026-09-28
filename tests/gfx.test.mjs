// Unit tests for the pure graphics quality model (src/gfx.js) and its strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, choosePreset, describe, fromLegacyTier, CATEGORIES, PRESETS } from '../src/gfx.js';
import { gfxStrings, pickLocale, GFX_LOCALES } from '../src/gfx-i18n.js';
import { migrateProfile } from '../src/storage.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 650'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
  assert.equal(detectPreset('NVIDIA GeForce RTX 4090', { mobile: true }), 'balanced', 'mobile caps Auto at balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
});

test('resolve: auto follows detection, presets fill every category', () => {
  const r = resolve({}, 'low');
  assert.equal(r.preset, 'low');
  assert.equal(r.auto, true);
  assert.equal(r.post, false, 'Low renders without a composer');
  assert.equal(r.adaptive, true);
  assert.equal(r.showFps, false);
  for (const p of PRESETS) {
    const rr = resolve({ preset: p }, 'low');
    assert.equal(rr.preset, p);
    assert.equal(rr.auto, false);
    for (const [cat, tiers] of Object.entries(CATEGORIES)) assert.ok(tiers.includes(rr[cat]), `${p}.${cat}`);
  }
  assert.equal(resolve({ preset: 'bogus' }, undefined).preset, 'balanced');
});

test('resolve: overrides win over the preset; invalid overrides are ignored', () => {
  const r = resolve({ preset: 'high', shadows: 'off', bloom: 'nope', particles: 'low' }, 'low');
  assert.equal(r.shadows, 'off');
  assert.equal(r.bloom, presetTier('high', 'bloom'));
  assert.equal(r.particles, 'low');
  assert.equal(resolve({ preset: 'low', antialias: 'msaa' }).post, true, 'MSAA uses the composer target');
});

test('resolve: render scale is clamped to 50–200 %', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.equal(resolve({ preset: 'low' }).dprCap, 1);
});

test('choosing a preset clears overrides but keeps scale and toggles', () => {
  const next = choosePreset({ preset: 'high', shadows: 'off', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'low');
  assert.deepEqual(next, { preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.deepEqual(choosePreset({}, 'auto'), { preset: 'auto' });
});

test('describe summarises cost and pixels', () => {
  const d = describe(resolve({ preset: 'high' }), [1280, 720]);
  assert.match(d, /1024² shadows/);
  assert.match(d, /SMAA/);
  assert.match(d, /1280×720 px/);
  assert.match(describe(resolve({ preset: 'low' })), /no shadows · no anti-aliasing/);
});

test('legacy graphicsTier migrates to a preset', () => {
  assert.deepEqual(fromLegacyTier('medium'), { preset: 'balanced' });
  assert.deepEqual(fromLegacyTier('auto'), { preset: 'auto' });
  const prof = migrateProfile({ v: 2, settings: { graphicsTier: 'high' } });
  assert.deepEqual(prof.settings.gfx, { preset: 'high' });
  assert.equal('graphicsTier' in prof.settings, false);
});

test('graphics strings exist in every required locale', () => {
  for (const l of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) assert.ok(GFX_LOCALES.includes(l), l);
  const en = gfxStrings('en-US');
  for (const l of GFX_LOCALES) {
    const t = gfxStrings(l);
    for (const cat of Object.keys(CATEGORIES)) assert.notEqual(t('cat_' + cat), 'cat_' + cat);
    if (!l.startsWith('en')) assert.notEqual(t('tabGraphics') + t('quality'), en('tabGraphics') + en('quality'), l);
  }
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('pt-PT'), 'pt-BR');
  assert.equal(pickLocale('ja-JP'), 'en-US');
  assert.equal(gfxStrings('de-DE')('auto', { tier: 'Niedrig' }), 'Automatisch (erkannt: Niedrig)');
});

test('localized describe keeps the shadow-map size', async () => {
  const { describeWords } = await import('../src/gfx-i18n.js');
  assert.match(describe(resolve({ preset: 'high' }), null, describeWords(gfxStrings('de-DE'))), /1024²-Schatten/);
});
