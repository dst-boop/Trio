import { openQuestionOptions, closeQuestionOptions } from './workspace-ui.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRIO_BASE_URL || 'http://localhost:5173';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local preview only.');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
page.setDefaultTimeout(20_000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(base + '/signin-with-chatgpt?return_to=%2Fdemo', { waitUntil: 'networkidle' });
  const accountId = (await (await page.request.get(base + '/api/workspace')).json()).accountId;
  let writes = 0, askBody;
  await page.route('**/api/workspace', route => { if (route.request().method() !== 'GET') writes++; return route.fulfill({ json: { revision: 0, sessions: [], accountId } }); });
  await page.route('**/api/memory', route => route.fulfill({ json: { revision: 1, notes: 'Private personal context', enabled: true } }));
  await page.route('**/api/ask', route => { askBody = route.request().postDataJSON(); return route.fulfill({ status: 502, json: { error: 'Simulated stop before model calls.' } }); });
  await page.addInitScript(() => {
    const original = window.fetch; window.imageCalls = []; window.imageAborts = 0;
    window.fetch = function (url, init) {
      if (url !== '/api/images/generate') return original.call(this, url, init);
      window.imageCalls.push({ body: JSON.parse(init.body), headers: init.headers });
      init.signal.addEventListener('abort', () => window.imageAborts++, { once: true });
      return new Promise(resolve => { window.finishImage = (body, status = 200) => resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })); });
    };
  });
  await page.goto(base + '/workspace', { waitUntil: 'networkidle' });
  // A deterministic raster fixture, not an actual generated image or a paid request.
  const jpeg = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1024; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#342255'; ctx.fillRect(0, 0, 1024, 1024); ctx.fillStyle = '#e1caff'; ctx.font = '48px sans-serif'; ctx.fillText('Local image fixture', 285, 520); return canvas.toDataURL('image/jpeg').split(',')[1]; });
  const image = { mimeType: 'image/jpeg', data: jpeg };
  const open = async () => { await openQuestionOptions(page); await page.getByRole('button', { name: 'Create image', exact: true }).click(); };
  const dialog = page.getByRole('dialog', { name: 'Create an image', exact: true });
  const prompt = page.getByRole('textbox', { name: 'Image description', exact: true });
  const preview = page.getByAltText('AI-generated result for your image description');
  const confirm = page.getByRole('alertdialog', { name: 'Discard this image draft?', exact: true });
  const close = () => dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const start = () => dialog.getByRole('button', { name: /^(Generate with OpenAI|Generate another image)$/ }).click();
  const warns = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  await open(); assert.equal(await dialog.getByRole('button', { name: 'Generate with OpenAI', exact: true }).isDisabled(), true);
  await prompt.fill('A luminous observatory'); assert.equal(await warns(), true);
  await dialog.getByRole('button', { name: 'Connections', exact: true }).click();
  for (let i = 0; i < 3; i++) await page.getByPlaceholder('Paste your API key').nth(i).fill('fake-image-key-' + i);
  await page.getByRole('switch', { name: 'Demo mode', exact: true }).click(); await page.getByRole('button', { name: 'Done', exact: true }).click();
  // Closing the parent panel must preserve the description retained via Connections.
  await openQuestionOptions(page); await closeQuestionOptions(page);
  await page.getByRole('textbox', { name: 'Your question', exact: true }).fill('Review this visual concept.');
  await open(); assert.equal(await prompt.inputValue(), 'A luminous observatory'); assert.equal(await page.evaluate(() => window.imageCalls.length), 0);
  await dialog.getByRole('button', { name: 'Use current question as description', exact: true }).click(); assert.equal(await prompt.inputValue(), 'Review this visual concept.');
  await prompt.fill('A luminous observatory'); await page.getByLabel('Image shape', { exact: true }).selectOption('1536x1024'); await page.getByLabel('Image quality', { exact: true }).selectOption('low');
  await start(); await dialog.getByRole('button', { name: 'Stop image generation', exact: true }).waitFor(); await page.evaluate(image => window.finishImage({ image }), image); await preview.waitFor();
  assert.equal(await preview.evaluate(el => el.naturalWidth), 1024);
  const originalPreview = await preview.getAttribute('src');
  const downloadPromise = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download JPEG', exact: true }).click(); const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^trio-generated-.*\.jpg$/); assert.equal((await readFile(await download.path())).toString('base64'), jpeg);
  await prompt.fill('A changed description'); await start(); await page.evaluate(() => window.finishImage({ error: 'OpenAI is limiting requests. Check your API billing and limits.' }, 502)); await dialog.getByRole('alert').waitFor(); assert.equal(await preview.getAttribute('src'), originalPreview);
  await dialog.getByText('Description used', { exact: true }).click(); await dialog.getByText('A luminous observatory', { exact: true }).waitFor();
  await start(); await dialog.getByRole('button', { name: 'Stop image generation', exact: true }).click(); await page.evaluate(image => window.finishImage({ image }), image); assert.equal(await preview.getAttribute('src'), originalPreview);
  await start(); await close(); await confirm.waitFor(); await page.evaluate(image => window.finishImage({ image }), image); await confirm.getByRole('button', { name: 'Keep working', exact: true }).click(); assert.equal(await preview.getAttribute('src'), originalPreview);
  await start(); await page.evaluate(() => window.finishImage({ image: { mimeType: 'image/jpeg', data: btoa('\xff\xd8\xff' + 'x'.repeat(30)) } })); await dialog.getByRole('alert').waitFor(); assert.match(await dialog.getByRole('alert').innerText(), /decode/); assert.equal(await preview.getAttribute('src'), originalPreview);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport); assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await dialog.getByRole('button', { name: 'Attach to question', exact: true }).scrollIntoViewIfNeeded();
  }
  await page.setViewportSize({ width: 390, height: 844 }); await mkdir('test-output', { recursive: true }); await page.screenshot({ path: 'test-output/image-generation-mobile.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Attach to question', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.getByAltText('Attached image preview').waitFor(); assert.equal(await page.getByRole('textbox', { name: 'Your question', exact: true }).inputValue(), 'Review this visual concept.');
  await page.getByRole('button', { name: 'Ask Trio', exact: true }).click(); await page.getByRole('alert').getByText('Simulated stop before model calls.', { exact: true }).waitFor();
  assert.deepEqual(askBody.image, image); assert.equal(askBody.question, 'Review this visual concept.');
  assert.ok(!JSON.stringify(askBody).includes('A changed description')); assert.equal(writes, 0);
  await open(); assert.equal(await prompt.inputValue(), ''); await prompt.fill('Another image'); await start(); await page.evaluate(image => window.finishImage({ image }), image); await preview.waitFor();
  await dialog.getByRole('button', { name: 'Replace attached image', exact: true }).waitFor();
  await close(); await confirm.waitFor(); await confirm.getByRole('button', { name: 'Discard image draft', exact: true }).click();
  assert.equal(await page.getByAltText('Attached image preview').count(), 1);
  const pdf = Buffer.alloc(3_999_900, 32); pdf.write('%PDF-1.7\n');
  await page.getByLabel('Choose PDF', { exact: true }).setInputFiles({ name: 'large-document.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.getByText('large-document.pdf', { exact: true }).waitFor();
  await open(); await prompt.fill('Image with an existing PDF'); await start(); await page.evaluate(image => window.finishImage({ image }), image); await preview.waitFor();
  await dialog.getByRole('button', { name: 'Replace attached image', exact: true }).click(); await dialog.getByRole('alert').waitFor(); assert.match(await dialog.getByRole('alert').innerText(), /together exceed 4 MB/);
  await preview.waitFor(); await close(); await confirm.waitFor(); await confirm.getByRole('button', { name: 'Discard image draft', exact: true }).click();
  assert.equal(await page.getByAltText('Attached image preview').count(), 1); await page.getByText('large-document.pdf', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove image', exact: true }).click(); await page.getByRole('button', { name: 'Remove PDF', exact: true }).click(); await page.getByRole('textbox', { name: 'Your question', exact: true }).fill(''); assert.equal(await warns(), false);
  const calls = await page.evaluate(() => window.imageCalls); assert.equal(calls.length, 7);
  for (const call of calls) { assert.equal(call.headers['X-Trio-Account'], accountId); assert.deepEqual(Object.keys(call.body).sort(), ['key', 'prompt', 'quality', 'size']); assert.equal(call.body.key, 'fake-image-key-0'); assert.ok(!JSON.stringify(call).includes('Private personal context')); }
  assert.equal(calls[0].body.size, '1536x1024'); assert.equal(calls[0].body.quality, 'low'); assert.ok(await page.evaluate(() => window.imageAborts >= 2));
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })); assert.ok(!stored.includes('fake-image-key')); assert.ok(!stored.includes(jpeg));
  assert.deepEqual(errors, []);
  console.log('Image generation browser checks passed: explicit billing/gating, Connections draft retention, settings, private payload, JPEG download, previous-result retention, abort/late results, invalid raster decoding, mobile/landscape, question attachment and model payload, replacement label, PDF byte budget preserves both files, discard, no storage or paid requests.');
} finally { await browser.close(); }
