import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const fits = async locator => {
  await locator.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="dialog-content"], [data-slot="alert-dialog-content"]')].every(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1; }));
  const dimensions = await locator.evaluate(el => ({ overflow: getComputedStyle(el).overflowY, background: getComputedStyle(el).backgroundColor, horizontal: el.scrollWidth > el.clientWidth + 1, scrolls: el.scrollHeight > el.clientHeight }));
  assert.equal(dimensions.horizontal, false); assert.equal(dimensions.overflow, 'auto'); assert.notEqual(dimensions.background, 'rgba(0, 0, 0, 0)');
  return dimensions;
};
try {
  await page.goto(base + '/signin-with-chatgpt?return_to=%2Fdemo', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'About Trio', exact: true }).click();
  for (const viewport of [{ width: 1440, height: 844 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport); const dialog = page.getByRole('dialog'); assert.ok((await fits(dialog)).scrolls);
    await dialog.locator('.help-steps p').last().scrollIntoViewIfNeeded(); assert.ok(await dialog.evaluate(el => el.scrollTop > 0));
    await dialog.getByRole('button', { name: 'Close', exact: true }).scrollIntoViewIfNeeded();
    if (viewport.width === 390) { await mkdir('test-output', { recursive: true }); await page.screenshot({ path: 'test-output/help-mobile.png', animations: 'disabled' }); }
  }
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const fixture = { id: 'long-title', title: 'A'.repeat(20000), time: '', turns: [{ question: 'Preserve this conversation', mode: 'fast', result: { answer: 'Saved answer', drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false } }] };
  await page.evaluate(fixture => { localStorage.setItem('trio-remember', 'true'); localStorage.setItem('trio-active-session', fixture.id); localStorage.setItem('trio-sessions', JSON.stringify([fixture])); }, fixture);
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Session actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Delete session', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 }); const confirmation = page.getByRole('alertdialog'); await fits(confirmation);
  assert.ok((await confirmation.textContent()).length < 600, 'A long title must not bury the decision buttons');
  await confirmation.getByRole('button', { name: 'Keep session', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-output/delete-long-title-mobile.png', animations: 'disabled' });
  await confirmation.getByRole('button', { name: 'Keep session', exact: true }).click(); assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('trio-sessions')))).length, 1);
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.getByRole('button', { name: 'Clear session history', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 420 }); await fits(page.getByRole('alertdialog')); await page.getByRole('button', { name: 'Keep sessions', exact: true }).click();
  // Memory requests are held or failed deliberately; no account or memory records are mutated.
  const accountId = (await (await page.request.get(base + '/api/workspace')).json()).accountId;
  let writes = 0; await page.route('**/api/workspace', route => { if (route.request().method() !== 'GET') { writes++; return route.fulfill({ status: 500, json: { error: 'Unexpected test write' } }); } return route.fulfill({ json: { revision: 0, sessions: [], accountId } }); });
  const queued = [], waiters = [];
  const nextMemory = () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiters.push(resolve));
  await page.route('**/api/memory', route => { if (route.request().method() !== 'GET') { writes++; return route.fulfill({ status: 500 }); } const waiter = waiters.shift(); if (waiter) waiter(route); else queued.push(route); });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(base + '/workspace', { waitUntil: 'domcontentloaded' });
  const initial = await nextMemory(); const memory = page.locator('button.side-nav').filter({ hasText: 'Personal memory' });
  await memory.locator('[role=status]').getByText('Loading…', { exact: true }).waitFor(); await memory.click(); await page.getByText('Loading personal memory…', { exact: true }).waitFor();
  await initial.fulfill({ status: 503, json: { error: 'Unavailable' } }); await memory.locator('[role=status]').getByText('Unavailable', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry loading memory', exact: true }).click(); const retry = await nextMemory(); await memory.locator('[role=status]').getByText('Loading…', { exact: true }).waitFor();
  await retry.fulfill({ json: { revision: 1, enabled: true, notes: 'Prefer practical examples' } }); await memory.locator('[role=status]').getByText('On', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); await fits(page.locator('.memory-dialog'));
  await page.locator('.memory-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload({ waitUntil: 'domcontentloaded' }); const off = await nextMemory(); await off.fulfill({ json: { revision: 2, enabled: false, notes: '' } }); await memory.locator('[role=status]').getByText('Off', { exact: true }).waitFor();
  assert.equal(writes, 0); assert.deepEqual(errors, []);
  console.log('Dialog checks passed: desktop/mobile/landscape Help, internal scrolling and close, long-title deletion cancellation, short-screen clear-history confirmation, memory loading/error/retry/on/off, no account mutations.');
} finally { await browser.close(); }
