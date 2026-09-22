const baseUrl = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const empty = { drafts: {}, reviews: {}, answer: '', errors: [], seconds: 2, demo: false };
  const turns = [
    { question: 'Compare two options', mode: 'compare', result: { ...empty, drafts: { openai: 'Earlier option A', claude: 'Earlier option B' } } },
    { question: 'Challenge the original plan', mode: 'deep', result: { ...empty, drafts: { openai: 'Original before critique' }, reviews: { claude: 'A specific objection' }, revisions: { openai: 'Revised after critique' }, answer: 'Revised after critique', by: 'openai', fallback: true, errors: ['Synthesis unavailable'], usage: { calls: 4, reportedCalls: 3, inputTokens: 300, outputTokens: 60, costUSD: null, byProvider: { openai: { model: 'gpt-6-astra', calls: 4, reportedCalls: 3, inputTokens: 300, outputTokens: 60, costUSD: null } } } } },
    { question: 'Latest question', mode: 'council', result: { ...empty, drafts: { openai: 'Latest draft' }, answer: 'Latest answer stays in view', by: 'openai' } },
  ];
  await page.goto(`${baseUrl}/signin-with-chatgpt?return_to=%2Fdemo`, { waitUntil: 'networkidle' });
  await page.evaluate(turns => {
    localStorage.setItem('trio-remember', 'true');
    localStorage.setItem('trio-sessions', JSON.stringify([{ id: 'history', title: turns[0].question, turns, time: new Date().toISOString() }]));
    localStorage.setItem('trio-active-session', 'history');
  }, turns);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Latest answer stays in view', { exact: true }).waitFor();
  assert.equal(await page.locator('.history-turn-body').count(), 0, 'Closed history does not render all model output');
  await page.getByText('2 earlier questions in this session', { exact: true }).click();
  await page.getByRole('button', { name: 'Question 1 Compare two options', exact: true }).click();
  const comparison = page.locator('[data-history-turn="0"]');
  await comparison.getByText('Earlier option A', { exact: true }).waitFor();
  await comparison.getByText('Earlier option B', { exact: true }).waitFor();
  assert.equal(await comparison.getByRole('tab', { name: 'Perspectives 2' }).getAttribute('data-state'), 'active');
  await page.getByRole('button', { name: 'Question 2 Challenge the original plan', exact: true }).click();
  const deep = page.locator('[data-history-turn="1"]');
  await deep.getByText('Single-model fallback · Synthesis did not complete.').waitFor();
  await deep.getByRole('button', { name: 'Copy earlier answer', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Revised after critique');
  await deep.getByRole('tab', { name: 'Perspectives 1' }).click();
  await deep.getByText('Original before critique', { exact: true }).waitFor();
  await deep.getByRole('tab', { name: 'Reviews 1' }).click();
  await deep.getByText('A specific objection', { exact: true }).waitFor();
  await deep.getByRole('tab', { name: 'Revisions 1' }).click();
  await deep.getByText('Revised after critique', { exact: true }).waitFor();
  await deep.getByText('Synthesis unavailable', { exact: true }).waitFor();
  await deep.getByText('Partial usage · 360 reported tokens').click();
  await deep.getByText('Usage reported for 3 of 4 calls.', { exact: false }).waitFor();
  assert.equal(await page.getByText('Latest answer stays in view', { exact: true }).count(), 1);
  await mkdir('test-output', { recursive: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No history overflow at ${width}px`);
  }
  await deep.screenshot({ path: 'test-output/history-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await page.getByText('3 earlier questions in this session', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Question 3 Latest question', exact: true }).click();
  await page.locator('[data-history-turn="2"]').getByText('Latest answer stays in view', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Run demo', exact: true }).waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('3 earlier questions in this session', { exact: true }).click();
  await page.getByRole('button', { name: 'Question 2 Challenge the original plan', exact: true }).click();
  await page.locator('[data-history-turn="1"]').getByRole('tab', { name: 'Revisions 1' }).click();
  await page.locator('[data-history-turn="1"]').getByText('Revised after critique', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log('History browser checks passed: lazy rendering, earlier comparisons/reviews/revisions, copy, usage, fallback notes, current-run isolation, persistence, mobile.');
