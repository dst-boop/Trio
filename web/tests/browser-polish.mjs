import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRIO_BASE_URL || 'http://localhost:5173';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Use a local preview');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async function (url, init) {
      if (url !== '/api/ask') return original.call(this, url, init);
      window.testRequests = (window.testRequests || 0) + 1;
      return new Response(new ReadableStream({
        start(controller) {
          window.testStream = controller;
          init.signal.addEventListener('abort', () => { try { controller.error(new DOMException('Stopped', 'AbortError')); } catch {} }, { once: true });
        },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
  });
  await page.goto(base + '/signin-with-chatgpt?return_to=%2Fdemo', { waitUntil: 'networkidle' });
  await mkdir('test-output', { recursive: true });
  await page.screenshot({ path: 'test-output/polish-desktop.png' });
  await page.getByRole('button', { name: /Prepare a client meeting/ }).click();
  await page.getByLabel('Desired outcome', { exact: true }).fill('Agree on the project deadline');
  await page.getByLabel('Workflow notes', { exact: true }).fill('The launch is planned for October.');
  await page.getByRole('button', { name: 'Use brief in Live mode', exact: true }).click();
  assert.match(await page.getByRole('textbox', { name: 'Your question', exact: true }).inputValue(), /Agree on the project deadline/);
  assert.equal(await page.evaluate(() => window.testRequests || 0), 0, 'Preparing a brief never starts a paid request');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByPlaceholder('Paste your API key').first().fill('synthetic-performance-key');
  await page.getByRole('switch', { name: 'Remember sessions on this device', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your question', exact: true }).fill('Write a concise implementation plan');
  await page.getByRole('button', { name: 'Ask Trio', exact: true }).click();
  await page.waitForFunction(() => !!window.testStream);
  const beginning = 'Start with a small, measurable test.\n\n```js\nconst ready = true;\n```\n\n';
  const emit = event => page.evaluate(event => window.testStream.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n')), event);
  await emit({ type: 'contribution_start', phase: 'draft', provider: 'openai' });
  await emit({ type: 'contribution_delta', phase: 'draft', provider: 'openai', text: beginning });
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  await page.getByRole('button', { name: 'Copy code', exact: true }).getByText('Copied').waitFor();
  await page.evaluate(() => {
    window.originalCodeNode = document.querySelector('.code-block pre');
    window.previewPaints = 0;
    window.paintObserver = new MutationObserver(() => window.previewPaints++);
    window.paintObserver.observe(document.querySelector('.answer-reader-viewport'), { childList: true, subtree: true, characterData: true });
  });
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let sent = 0;
      const timer = setInterval(() => {
        window.testStream.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'contribution_delta', phase: 'draft', provider: 'openai', text: 'abc ' }) + '\n'));
        if (++sent === 200) { clearInterval(timer); resolve(); }
      }, 2);
    });
  });
  await page.waitForFunction(() => document.querySelector('.answer-reader-viewport').textContent.includes('abc '.repeat(199).trim()));
  const metrics = await page.evaluate(() => {
    window.paintObserver.disconnect();
    return { chunks: 200, previewMutations: window.previewPaints, codeNodeRetained: window.originalCodeNode === document.querySelector('.code-block pre') };
  });
  assert.ok(metrics.previewMutations < 100, JSON.stringify(metrics));
  assert.equal(metrics.codeNodeRetained, true, 'Streaming must not remount completed code blocks');
  await page.getByRole('button', { name: 'Copy code', exact: true }).getByText('Copied').waitFor();
  const answer = beginning + 'abc '.repeat(200);
  await emit({ type: 'final', result: { answer, drafts: { openai: answer }, reviews: {}, by: 'openai', demo: false, errors: [], seconds: 1 } });
  await page.getByRole('button', { name: 'Ask Trio', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('trio-sessions'))[0].turns[0].result.answer), answer);
  await page.screenshot({ path: 'test-output/polish-answer.png' });
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const button = await page.getByRole('button', { name: 'Ask Trio', exact: true }).boundingBox();
    assert.ok(button && button.y >= 0 && button.y + button.height <= viewport.height, 'Submit stays on screen');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-output/polish-answer-mobile.png' });
  await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click();
  await page.getByRole('button', { name: /^New session/ }).click();
  await page.screenshot({ path: 'test-output/polish-mobile.png' });
  assert.deepEqual(errors, []);
  await writeFile('test-output/polish-stream-metrics.json', JSON.stringify(metrics, null, 2));
  console.log('Polish browser checks passed: guided briefs, no automatic calls, stream batching, retained code, exact saved answer, mobile and landscape composer.', metrics);
} finally { await browser.close(); }
