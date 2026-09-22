import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRIO_BASE_URL || 'http://localhost:5173';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local preview only.');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(base + '/signin-with-chatgpt?return_to=%2Fdemo', { waitUntil: 'networkidle' });
  const accountId = (await (await page.request.get(base + '/api/workspace')).json()).accountId;
  let writes = 0;
  await page.route('**/api/workspace', route => { if (route.request().method() !== 'GET') writes++; return route.fulfill({ json: { revision: 0, sessions: [], accountId } }); });
  await page.route('**/api/memory', route => route.fulfill({ json: { revision: 0, notes: '', enabled: false } }));
  // Simulate the endpoint locally, including a deliberately late response after Stop.
  await page.addInitScript(() => {
    const original = window.fetch; window.audioCalls = []; window.audioAborts = 0;
    window.fetch = function (url, init) {
      if (url !== '/api/transcribe') return original.call(this, url, init);
      window.audioCalls.push({ body: JSON.parse(init.body), headers: init.headers });
      init.signal.addEventListener('abort', () => window.audioAborts++, { once: true });
      return new Promise(resolve => { window.finishAudio = (body, status = 200) => resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })); });
    };
  });
  await page.goto(base + '/workspace', { waitUntil: 'networkidle' });
  const open = () => page.getByRole('button', { name: 'Audio to text', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Turn a recording into a question', exact: true });
  const start = () => dialog.getByRole('button', { name: 'Transcribe with OpenAI', exact: true }).click();
  const close = () => dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard this audio draft?', exact: true });
  const transcript = page.getByRole('textbox', { name: 'Review and edit transcript', exact: true });
  const warns = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  const fixture = { name: 'voice-note.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF0000WAVEfmt 0000000000000000') };
  const choose = async () => { await page.getByLabel('Choose recording', { exact: true }).setInputFiles(fixture); await dialog.getByText('voice-note.wav', { exact: true }).waitFor(); };
  await open(); assert.equal(await dialog.getByRole('button', { name: 'Transcribe with OpenAI', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByPlaceholder('Paste your API key').first().fill('fake-audio-key');
  await page.getByRole('switch', { name: 'Demo mode', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await open(); assert.equal(await warns(), false);
  await page.getByLabel('Choose recording', { exact: true }).setInputFiles({ name: 'bad.wav', mimeType: 'audio/wav', buffer: Buffer.from('not audio') });
  await dialog.getByRole('alert').waitFor(); assert.equal(await page.evaluate(() => window.audioCalls.length), 0);
  await choose(); assert.equal(await warns(), true); assert.equal(await page.evaluate(() => window.audioCalls.length), 0);
  await start(); await dialog.getByRole('button', { name: 'Stop transcription', exact: true }).waitFor();
  await page.evaluate(() => window.finishAudio({ transcript: 'There are fifteen units.' }));
  await transcript.waitFor(); assert.equal(await transcript.inputValue(), 'There are fifteen units.');
  await transcript.fill('There are fifty units.'); await close(); await confirmation.waitFor();
  await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click(); assert.equal(await transcript.inputValue(), 'There are fifty units.');
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await dialog.getByRole('button', { name: 'Add to question', exact: true }).scrollIntoViewIfNeeded();
  }
  await page.setViewportSize({ width: 390, height: 844 }); await mkdir('test-output', { recursive: true });
  await page.screenshot({ path: 'test-output/audio-review-mobile.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Add to question', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('textbox', { name: 'Your question', exact: true }).inputValue(), 'There are fifty units.');
  // Existing text is preserved and oversized combined drafts remain editable.
  await page.getByRole('textbox', { name: 'Your question', exact: true }).fill('x'.repeat(19_999));
  await open(); await choose(); await start(); await page.evaluate(() => window.finishAudio({ transcript: 'More text' })); await transcript.waitFor();
  await dialog.getByRole('button', { name: 'Add to question', exact: true }).click(); await dialog.getByRole('alert').waitFor();
  assert.match(await dialog.getByRole('alert').innerText(), /20,000/); assert.equal(await transcript.inputValue(), 'More text');
  await page.keyboard.press('Escape'); await confirmation.waitFor(); await confirmation.getByRole('button', { name: 'Discard draft', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your question', exact: true }).fill('Existing question');
  await open(); await choose(); await start(); await page.evaluate(() => window.finishAudio({ transcript: 'Reviewed note' })); await transcript.waitFor();
  await dialog.getByRole('button', { name: 'Add to question', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Your question', exact: true }).inputValue(), 'Existing question\n\nReviewed note');
  await page.getByRole('textbox', { name: 'Your question', exact: true }).fill(''); assert.equal(await warns(), false);
  // Cancellation and dismissals invalidate even a transport that ignores AbortSignal.
  await open(); await choose(); await start(); await dialog.getByRole('button', { name: 'Stop transcription', exact: true }).click();
  await page.evaluate(() => window.finishAudio({ transcript: 'Late response must be ignored' })); assert.equal(await transcript.count(), 0);
  await start(); await close(); await confirmation.waitFor(); await page.evaluate(() => window.finishAudio({ transcript: 'Another late response' }));
  await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click(); assert.equal(await transcript.count(), 0);
  await start(); await page.evaluate(() => window.finishAudio({ error: 'OpenAI is limiting requests. Check your API billing and limits.' }, 502));
  await dialog.getByRole('alert').waitFor(); assert.match(await dialog.getByRole('alert').innerText(), /limiting requests/);
  await close(); await confirmation.waitFor(); await confirmation.getByRole('button', { name: 'Discard draft', exact: true }).click();
  assert.equal(await warns(), false); await open(); assert.equal(await transcript.count(), 0); await close();
  const calls = await page.evaluate(() => window.audioCalls); assert.equal(calls.length, 6);
  for (const call of calls) { assert.equal(call.headers['X-Trio-Account'], accountId); assert.deepEqual(Object.keys(call.body).sort(), ['audio', 'key']); assert.equal(call.body.key, 'fake-audio-key'); assert.equal(call.body.audio.format, 'wav'); }
  assert.ok(await page.evaluate(() => window.audioAborts >= 2)); assert.equal(writes, 0);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  assert.ok(!stored.includes('fake-audio-key')); assert.ok(!stored.includes(fixture.buffer.toString('base64')));
  assert.deepEqual(errors, []);
  console.log('Audio browser checks passed: Live/key gating, invalid files, explicit billing action, review/edit/append, overflow, discard/keep/Escape, unload cleanup, cancellation/late responses, fixed failure display, mobile/landscape, no storage or paid calls.');
} finally { await browser.close(); }
