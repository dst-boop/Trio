import { setDemoMode } from './workspace-ui.mjs';
const baseUrl = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';

// The Connections switch sends independentWriter only for multi-model modes with three
// connected models, and a result written that way says the writer did not draft.
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${baseUrl}/signin-with-chatgpt?return_to=%2Fdemo`, { waitUntil: 'networkidle' });
  await page.getByRole('radio', { name: 'Council', exact: true }).check();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  for (const index of [0, 1, 2]) await page.getByPlaceholder('Paste your API key').nth(index).fill('offline-test-key-' + index);
  await setDemoMode(page, false);
  const writerSwitch = page.getByRole('switch', { name: 'Final answer by a model that did not draft' });
  assert.equal(await writerSwitch.getAttribute('aria-checked'), 'false', 'off by default');
  await writerSwitch.click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const bodies = [];
  await page.route('**/api/ask', async route => {
    const body = route.request().postDataJSON(); bodies.push(body);
    const result = { drafts: { openai: 'Draft one', gemini: 'Draft two' }, reviews: {}, answer: 'An independently written answer', errors: [], seconds: 2, demo: false, by: 'claude', ...(body.independentWriter ? { independentWriter: true } : {}) };
    await route.fulfill({ contentType: 'application/x-ndjson', body: [{ type: 'stage', stage: 'draft' }, { type: 'final', result }].map(e => JSON.stringify(e)).join('\n') });
  });
  await page.getByRole('textbox', { name: 'Your question' }).fill('Plan the launch');
  await page.getByRole('button', { name: 'Ask Trio', exact: true }).click();
  await page.getByText('An independently written answer', { exact: true }).waitFor();
  assert.equal(bodies[0].independentWriter, true); assert.equal(bodies[0].mode, 'council');
  await page.getByText(/Written by Claude, which did not draft/).waitFor();
  // Compare never uses a separate writer, so the option is not sent for it.
  await page.getByRole('radio', { name: 'Compare', exact: true }).check();
  await page.getByRole('textbox', { name: 'Your question' }).fill('Compare the options');
  await page.getByRole('button', { name: 'Ask Trio', exact: true }).click();
  for (let i = 0; i < 100 && bodies.length < 2; i++) await page.waitForTimeout(100);
  assert.equal(bodies.length, 2, 'the Compare question reached the endpoint');
  assert.equal(bodies[1].independentWriter, false);
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log('Independent writer browser checks passed: off by default, sent for Council with three models, not for Compare, and labelled on the answer.');
