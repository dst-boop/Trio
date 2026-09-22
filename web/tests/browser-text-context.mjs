const baseUrl = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  await page.route('**/api/ask', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'final', result: { drafts: { openai: 'Context answer' }, reviews: {}, answer: 'Context answer', by: 'openai', errors: [], seconds: 1, demo: false } }) + '\n' });
  });
  await page.goto(`${baseUrl}/signin-with-chatgpt?return_to=%2Fdemo`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByPlaceholder('Paste your API key').first().fill('fake-context-key');
  await page.getByRole('switch', { name: 'Demo mode', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: 'Your question' });
  const ask = page.getByRole('button', { name: 'Ask Trio', exact: true });
  const attachment = page.locator('.attachment');
  const upload = async (name, text = 'private context') => page.getByLabel('Choose text context').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  const submit = async question => { await prompt.fill(question); await ask.click(); await ask.waitFor(); };
  await submit('Existing conversation');
  await page.getByRole('button', { name: 'New session', exact: false }).click();
  await page.evaluate(() => {
    const original = File.prototype.text;
    window.pendingFiles = {};
    File.prototype.text = function () {
      if (this.name === 'broken.txt') return Promise.reject(new Error('private device path must not appear'));
      if (this.name.startsWith('slow-')) return new Promise((resolve, reject) => { window.pendingFiles[this.name] = { resolve, reject }; });
      return original.call(this);
    };
  });
  const settle = async (name, reject = false) => page.evaluate(async ({ name, reject }) => {
    const pending = window.pendingFiles[name];
    if (reject) pending.reject(new Error('stale private file failure'));
    else pending.resolve(`Contents of ${name}`);
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  }, { name, reject });

  // Neither the button nor the keyboard shortcut may send the previous context while a new file loads.
  await upload('slow-remove.txt'); await page.getByRole('status').filter({ hasText: 'Loading context…' }).waitFor();
  await prompt.fill('Wait for my attachment'); assert.equal(await ask.isDisabled(), true);
  await prompt.press('Control+Enter'); assert.equal(requests.length, 1);
  await page.getByRole('button', { name: 'Remove attachment', exact: true }).click();
  await settle('slow-remove.txt'); assert.equal(await attachment.count(), 0); assert.equal(await ask.isEnabled(), true);

  // The newest choice wins even when an earlier read completes last.
  await upload('slow-first.txt'); await upload('latest.md', 'The chosen context');
  await attachment.getByText('latest.md', { exact: true }).waitFor();
  await settle('slow-first.txt'); assert.equal(await attachment.innerText(), 'latest.md');
  await upload('broken.txt'); await page.getByText('Could not read this text file. Choose the file again.', { exact: true }).waitFor();
  assert.equal(await attachment.innerText(), 'latest.md'); assert.equal(await ask.isEnabled(), true);
  assert.ok(!(await page.locator('body').innerText()).includes('private device path'));
  await submit('Use the selected context'); assert.equal(requests[1].context, 'The chosen context');

  // Switching to a saved conversation invalidates a pending read, including a late failure.
  await upload('slow-switch.txt');
  await page.locator('.session-list').getByRole('button', { name: 'Existing conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Discard and switch', exact: true }).click();
  await settle('slow-switch.txt', true); assert.equal(await attachment.count(), 0);
  await submit('Follow up without attachment'); assert.equal(requests[2].context, undefined);

  // Starting a new conversation also cancels the pending load.
  await upload('slow-new.txt'); await page.getByRole('button', { name: 'New session', exact: false }).click();
  await page.getByRole('button', { name: 'Discard and start new', exact: true }).click();
  await settle('slow-new.txt'); assert.equal(await attachment.count(), 0);

  // A rejected replacement invalidates older reads without deleting the last usable attachment.
  await upload('retained.txt', 'Retained context'); await attachment.getByText('retained.txt', { exact: true }).waitFor();
  await upload('slow-invalid.txt'); await upload('not-text.pdf'); await settle('slow-invalid.txt');
  assert.equal(await attachment.innerText(), 'retained.txt');
  await prompt.fill('Still usable'); assert.equal(await ask.isEnabled(), true);
  await upload('too-large.txt', 'x'.repeat(60001));
  await page.getByText('Use a text file smaller than 60 KB.', { exact: true }).waitFor();
  assert.equal(await attachment.innerText(), 'retained.txt');
  await page.setViewportSize({ width: 390, height: 844 });
  await upload('slow-mobile.txt'); await page.getByText('Loading context…', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Remove attachment', exact: true }).click(); await settle('slow-mobile.txt');
  assert.equal(await attachment.count(), 0); assert.deepEqual(errors, []); assert.equal(requests.length, 3);
} finally { await browser.close(); }
console.log('Text-context browser checks passed: loading blocks submission, cancel, latest selection wins, safe read errors, preserved context, session isolation, invalid replacements, mobile.');
