const baseUrl = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${baseUrl}/signin-with-chatgpt?return_to=%2Fdemo`, { waitUntil: 'networkidle' });
  const png = await page.getByRole('heading', { name: 'One question. Three perspectives.' }).screenshot();
  const file = { name: 'team-screenshot.png', mimeType: 'image/png', buffer: png };
  await page.getByLabel('Choose image').setInputFiles(file);
  await page.getByAltText('Attached image preview').waitFor();
  await page.getByText('Demo ignores this image. Switch to Live in Connections to analyze it.').waitFor();
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await page.getByRole('button', { name: 'Run demo', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByPlaceholder('Paste your API key').first().fill('fake-image-key');
  await page.getByRole('switch', { name: 'Demo mode', exact: true }).click();
  await page.getByRole('switch', { name: 'Remember sessions on this device', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByLabel('Choose text context').setInputFiles({ name: 'instructions.txt', mimeType: 'text/plain', buffer: Buffer.from('Describe the visible layout') });
  let calls = 0;
  await page.route('**/api/ask', async route => {
    calls++; const body = route.request().postDataJSON();
    assert.equal(body.context, 'Describe the visible layout');
    if (calls < 3) assert.deepEqual(body.image, { mimeType: 'image/png', data: png.toString('base64') });
    else assert.equal(body.image, undefined);
    if (calls > 1) assert.match(body.history[0].content, /bytes are not part of the text history/);
    assert.ok(!JSON.stringify(body.history).includes(png.toString('base64')));
    await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'final', result: { drafts: { openai: 'Three model cards' }, reviews: {}, answer: `Image answer ${calls}`, by: 'openai', errors: [], seconds: 1, demo: false } }) + '\n' });
  });
  const ask = async question => { await page.getByRole('textbox', { name: 'Your question' }).fill(question); await page.getByRole('button', { name: 'Ask Trio', exact: true }).click(); await page.getByRole('button', { name: 'Ask Trio', exact: true }).waitFor(); };
  await ask('Describe this screenshot');
  await page.getByText('Image answer 1', { exact: true }).waitFor();
  let saved = await page.evaluate(() => localStorage.getItem('trio-sessions'));
  assert.ok(saved.includes('team-screenshot.png')); assert.ok(!saved.includes(png.toString('base64'))); assert.ok(!saved.includes('fake-image-key'));
  assert.equal(JSON.parse(saved)[0].turns[0].imageName, undefined, 'Demo does not pretend to analyze the image');
  await ask('Which card is in the middle?');
  await page.getByRole('button', { name: 'Remove image', exact: true }).click();
  await ask('Summarize without the image');
  await page.getByRole('combobox', { name: 'Answer mode', exact: true }).selectOption('compare');
  await page.getByText('Up to 3 calls + retries', { exact: true }).waitFor();
  await page.getByLabel('Choose image').setInputFiles(file);
  await page.getByAltText('Attached image preview').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mkdir('test-output', { recursive: true });
  await page.locator('.prompt-section').screenshot({ path: 'test-output/images-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('button', { name: 'New session', exact: false }).click();
  await page.getByRole('button', { name: 'Discard and start new', exact: true }).click();
  assert.equal(await page.getByAltText('Attached image preview').count(), 0);
  await page.getByLabel('Choose image').setInputFiles({ name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg></svg>') });
  await page.getByText('Choose a PNG, JPEG, or WebP image with a matching file type.').waitFor();
  assert.equal(await page.getByAltText('Attached image preview').count(), 0);
  // A late file decode cannot carry an image into a different session.
  await page.evaluate(() => { const original = window.createImageBitmap; window.createImageBitmap = async (...args) => { const bitmap = await original(...args); await new Promise(resolve => window.finishImageDecode = resolve); return bitmap; }; });
  await page.getByLabel('Choose image').setInputFiles(file);
  await page.waitForFunction(() => !!window.finishImageDecode);
  await page.getByRole('button', { name: 'New session', exact: false }).click();
  await page.getByRole('button', { name: 'Discard and start new', exact: true }).click();
  await page.evaluate(async () => { window.finishImageDecode(); await new Promise(requestAnimationFrame); });
  assert.equal(await page.getByAltText('Attached image preview').count(), 0);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByAltText('Attached image preview').count(), 0);
  const base = { question: 'q', connections: Object.fromEntries(['openai', 'claude', 'gemini'].map(id => [id, { key: '', model: 'model', enabled: true }])), mode: 'fast', lead: 'openai' };
  for (const image of [{ mimeType: 'image/png', data: 'https://example.com/a.png' }, { mimeType: 'image/svg+xml', data: btoa('<svg></svg>') }, { mimeType: 'image/jpeg', data: png.toString('base64') }]) {
    const response = await page.request.post(`${baseUrl}/api/ask`, { data: { ...base, image } }); assert.equal(response.status(), 400); assert.match((await response.json()).error, /image format/);
  }
  const valid = await page.request.post(`${baseUrl}/api/ask`, { data: { ...base, image: { mimeType: 'image/png', data: png.toString('base64') } } });
  assert.equal(valid.status(), 400); assert.match((await valid.json()).error, /Connect at least one/);
  const huge = await page.request.post(`${baseUrl}/api/ask`, { headers: { 'Content-Type': 'application/json' }, data: 'x'.repeat(8_000_001) }); assert.equal(huge.status(), 413);
  assert.equal(calls, 3); assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log('Image browser checks passed: preview, demo separation, text plus image, follow-ups, removal, metadata-only persistence, session isolation, late decode, API validation, mobile.');
