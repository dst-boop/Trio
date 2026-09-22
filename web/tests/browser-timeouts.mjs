import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.timeoutMode = 'startup'; window.trioCalls = 0; window.trioAborts = 0;
    window.fetch = async function (url, init) {
      if (url !== '/api/ask') return original.call(this, url, init);
      window.trioCalls++; init.signal.addEventListener('abort', () => window.trioAborts++, { once: true });
      if (window.timeoutMode === 'startup') return new Promise(() => {}); // Deliberately ignores cancellation.
      return new Response(new ReadableStream({
        start(c) {
          window.trioStream = c;
          const event = window.timeoutMode === 'complete'
            ? { type: 'final', result: { answer: 'Recovered completed answer', drafts: { openai: 'Completed draft' }, reviews: {}, errors: [], seconds: 1, demo: false } }
            : { type: 'contribution_delta', phase: 'draft', provider: 'openai', text: 'Partial before the stalled connection' };
          c.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
        },
        cancel() { window.trioCancels = (window.trioCancels || 0) + 1; return new Promise(() => {}); },
      }));
    };
  });
  await page.goto(base + '/signin-with-chatgpt?return_to=%2Fdemo', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByPlaceholder('Paste your API key').first().fill('fake-timeout-key');
  await page.getByRole('switch', { name: 'Demo mode', exact: true }).click();
  await page.getByRole('switch', { name: 'Remember sessions on this device', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.clock.install({ time: new Date('2026-09-22T10:00:00Z') }); await page.clock.pauseAt(new Date('2026-09-22T10:00:01Z'));
  const question = page.getByRole('textbox', { name: 'Your question', exact: true });
  const run = page.getByRole('button', { name: 'Ask Trio', exact: true });
  await question.fill('Keep this prompt if the network fails'); await run.click();
  await page.waitForFunction(() => window.trioCalls === 1); await page.clock.fastForward(30_001);
  await page.locator('.error-box').getByText(/Trio took too long to start/).waitFor(); assert.ok(await run.isEnabled());
  assert.equal(await question.inputValue(), 'Keep this prompt if the network fails'); assert.equal(await page.locator('.session-open').count(), 0);
  assert.equal(await page.evaluate(() => window.trioAborts), 1);
  await page.evaluate(() => { window.timeoutMode = 'idle'; }); await run.click();
  await page.getByText('Partial before the stalled connection', { exact: true }).waitFor();
  await page.clock.fastForward(149_000); assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 1);
  await page.clock.fastForward(1_001); await page.locator('.error-box').getByText(/connection stopped sending updates/).waitFor();
  assert.ok(await run.isEnabled()); assert.equal(await question.inputValue(), 'Keep this prompt if the network fails');
  assert.equal(await page.locator('.session-open').count(), 0); assert.equal(await page.evaluate(() => window.trioCalls), 2, 'No automatic retry');
  assert.equal(await page.evaluate(() => window.trioAborts), 2); assert.equal(await page.evaluate(() => window.trioCancels), 1);
  await page.getByText('Partial before the stalled connection', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mkdir('test-output', { recursive: true }); await page.screenshot({ path: 'test-output/timeout-mobile.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.evaluate(() => { window.timeoutMode = 'complete'; }); await run.click();
  await page.getByText('Recovered completed answer', { exact: true }).waitFor();
  await page.clock.fastForward(150_001); assert.equal(await page.locator('.session-open').count(), 1); assert.equal(await page.locator('.error-box').count(), 0);
  const saved = await page.evaluate(() => localStorage.getItem('trio-sessions')); assert.ok(saved.includes('Recovered completed answer')); assert.ok(!saved.includes('Partial before')); assert.ok(!saved.includes('fake-timeout-key'));
  await page.evaluate(() => { window.timeoutMode = 'startup'; }); await question.fill('Stop this pending request'); await run.click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.locator('.error-box').getByText('Session stopped. Partial contributions are shown below.', { exact: true }).waitFor();
  await page.clock.fastForward(150_001); assert.equal(await page.evaluate(() => localStorage.getItem('trio-sessions')), saved);
  assert.equal(await page.evaluate(() => window.trioCalls), 4); assert.deepEqual(errors, []);
  console.log('Timeout browser checks passed: pending startup, idle partial stream, prompt retained, no incomplete save or automatic retry, cancellation, explicit retry recovery, no stale timers, Stop, key privacy and mobile.');
} finally { await browser.close(); }
