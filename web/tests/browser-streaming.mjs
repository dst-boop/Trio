const baseUrl = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const fetchOriginal = window.fetch;
    window.fetch = async function(url, init) {
      if (url !== '/api/ask') return fetchOriginal.call(this, url, init);
      window.trioRequest = JSON.parse(init.body);
      return new Response(new ReadableStream({
        start(controller) { window.trioStream = controller; init.signal.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')), { once: true }); },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
  });
  const emit = async (...events) => page.evaluate(events => { for (const event of events) window.trioStream.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n')); }, events);
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByPlaceholder('Paste your API key').first().fill('streaming-fake-key');
  await page.getByRole('switch', { name: 'Demo mode', exact: true }).click();
  await page.getByRole('switch', { name: 'Remember sessions on this device', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your question' }).fill('Stream the plan');
  await page.getByRole('button', { name: 'Ask Trio', exact: true }).click();
  await page.waitForFunction(() => !!window.trioStream);
  await emit({ type: 'stage', stage: 'draft' }, { type: 'contribution_start', phase: 'draft', provider: 'openai' }, { type: 'contribution_delta', phase: 'draft', provider: 'openai', text: 'First words arrive' });
  await page.getByText('First words arrive', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 1);
  assert.equal(await page.locator('.session-list .session-open').count(), 0, 'Partial turns are not saved');
  await emit({ type: 'contribution_delta', phase: 'draft', provider: 'openai', text: ' before completion.' });
  await page.getByText('First words arrive before completion.', { exact: true }).waitFor();
  await emit({ type: 'contribution_start', phase: 'draft', provider: 'openai' }, { type: 'contribution_delta', phase: 'draft', provider: 'openai', text: 'Replacement draft' });
  await page.getByText('Replacement draft', { exact: true }).waitFor();
  assert.equal(await page.getByText('First words arrive before completion.', { exact: true }).count(), 0);
  await emit({ type: 'draft', provider: 'openai', text: 'Completed draft' }, { type: 'stage', stage: 'synthesis' }, { type: 'contribution_start', phase: 'synthesis', provider: 'openai' }, { type: 'contribution_delta', phase: 'synthesis', provider: 'openai', text: 'Partial combined answer' });
  await page.getByText('Partial combined answer', { exact: true }).waitFor();
  const result = { drafts: { openai: 'Completed draft' }, reviews: {}, answer: 'Completed combined answer', by: 'openai', errors: [], seconds: 2, demo: false };
  await emit({ type: 'final', result });
  await page.evaluate(() => window.trioStream.close());
  await page.getByRole('button', { name: 'Ask Trio', exact: true }).waitFor();
  await page.getByText('Completed combined answer', { exact: true }).waitFor();
  assert.equal(await page.locator('.session-list .session-open').count(), 1);
  const saved = await page.evaluate(() => localStorage.getItem('trio-sessions'));
  assert.ok(saved.includes('Completed combined answer')); assert.ok(!saved.includes('Partial combined answer')); assert.ok(!saved.includes('streaming-fake-key'));
  await page.getByRole('textbox', { name: 'Your question' }).fill('Cancel this follow-up');
  await page.getByRole('button', { name: 'Ask Trio', exact: true }).click();
  await emit({ type: 'contribution_start', phase: 'draft', provider: 'openai' }, { type: 'contribution_delta', phase: 'draft', provider: 'openai', text: 'Unfinished follow-up' });
  await page.getByText('Unfinished follow-up', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByText('Session stopped. Partial contributions are shown below.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('trio-sessions')), saved);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mkdir('test-output', { recursive: true });
  await page.screenshot({ path: 'test-output/streaming-mobile.png', fullPage: true });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Completed combined answer', { exact: true }).waitFor();
  assert.equal(await page.getByText('Unfinished follow-up', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log('Streaming browser checks passed: incremental text, clean restarts, synthesis transition, completed-only persistence, cancellation, key privacy, mobile.');
