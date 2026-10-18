// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a Practice (Steady) session and keeps caring for the companion with the on-screen action tray
// (pet, snack, sing, toss, play…), retrying from the results screen — the creature bounces, emotes,
// particles burst and the window light / dust motes animate the whole time.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#btn-settings-top', { state: 'visible', timeout: 30000 });
  await page.click('#btn-settings-top');
  await page.waitForSelector('#overlay-settings:not(.hidden)');
  await page.click('#settings-tab-graphics');
  await page.waitForSelector('#gfx-section:not(.hidden)');
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#btn-settings-close');
  await page.waitForSelector('#overlay-settings.hidden', { state: 'attached' });
}

const ACTIONS = ['pet', 'snack', 'sing', 'toss', 'play', 'pet', 'feed', 'wash'];
let k = 0;

async function step(page) {
  if (await page.locator('#screen-results.active').count()) {
    await page.click('#btn-retry', { timeout: 3000 });
    return page.waitForSelector('#screen-game.active', { timeout: 10000 });
  }
  for (let i = 0; i < ACTIONS.length; i++) {
    const btn = page.locator(`#action-tray .action-btn[data-action="${ACTIONS[k++ % ACTIONS.length]}"]:not([disabled])`);
    if (await btn.count()) return btn.click({ timeout: 2000 });
  }
  return page.locator('#action-tray .action-btn[data-action="wait"]').click({ timeout: 2000 });
}

export async function start(page) {
  await page.click('#btn-play');
  await page.waitForSelector('#screen-modes.active');
  await page.locator('.mode-card[data-mode="practice"]').click();
  await page.waitForSelector('#screen-setup.active');
  await page.locator('.setup-choice[data-id="steady"]').click();
  await page.click('#btn-start-session');
  await page.waitForSelector('#action-tray .action-btn', { timeout: 15000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(600).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
