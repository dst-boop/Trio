const baseUrl = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${baseUrl}/signin-with-chatgpt?return_to=%2Fdemo`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Deep Council', exact: true }).click();
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await page.getByText('Make the first 30 days a learning sprint.', { exact: false }).waitFor();
  await page.getByRole('tab', { name: 'Revisions 3', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'Changes and remaining uncertainties', exact: true }).count(), 3);
  await page.getByRole('tab', { name: 'Perspectives 3', exact: true }).click();
  await page.getByText('Start with the problem, not the product.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('switch', { name: 'Remember sessions on this device' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Revisions 3', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'Revised plan', exact: true }).count(), 3);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export session as Markdown' }).click();
  const download = await downloadPromise;
  const markdown = await readFile(await download.path(), 'utf8');
  assert.match(markdown, /## Claude revised answer/);
  assert.match(markdown, /## ChatGPT draft/);
  assert.match(markdown, /Illustrative demo/);

  // A mocked live endpoint exercises request mode and incremental revision events.
  await page.getByRole('tab', { name: 'Deep Council', exact: true }).click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByPlaceholder('Paste your API key').nth(0).fill('offline-test-key');
  await page.getByRole('switch', { name: 'Demo mode', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByText('Up to 10 calls + retries', { exact: false }).waitFor();
  const result = { drafts: { openai: 'Original position' }, reviews: { openai: 'Check the assumption' }, revisions: { openai: 'Corrected position with remaining uncertainty' }, answer: 'A careful conclusion', errors: [], seconds: 2, demo: false, by: 'openai' };
  await page.route('**/api/ask', async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.mode, 'deep');
    assert.deepEqual(body.history, [], 'Demo turns must not enter live context');
    const events = [{ type: 'stage', stage: 'draft' }, { type: 'draft', provider: 'openai', text: result.drafts.openai }, { type: 'review', provider: 'openai', text: result.reviews.openai }, { type: 'stage', stage: 'revision' }, { type: 'revision', provider: 'openai', text: result.revisions.openai }, { type: 'final', result }];
    await route.fulfill({ contentType: 'application/x-ndjson', body: events.map(e => JSON.stringify(e)).join('\n') });
  });
  await page.getByRole('textbox', { name: 'Your question' }).fill('Challenge this plan');
  await page.getByRole('button', { name: 'Ask Trio', exact: true }).click();
  await page.getByText('A careful conclusion', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Revisions 1', exact: true }).click();
  await page.getByText('Corrected position with remaining uncertainty', { exact: true }).waitFor();
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('offline-test-key'));
  await page.getByRole('tab', { name: 'Compare', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'Revisions 1', exact: true }).count(), 1, 'Result mode stays attached to the completed run');
  await mkdir('test-output', { recursive: true });
  await page.screenshot({ path: 'test-output/deep-council-desktop.png', fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No overflow at ${width}px`);
  }
  await page.screenshot({ path: 'test-output/deep-council-mobile.png', fullPage: true });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Revisions 1', exact: true }).click();
  await page.getByText('Corrected position with remaining uncertainty', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log('Deep Council browser checks passed: demo, live events, cost notice, original preservation, history, export, key privacy, responsive layout.');
