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
  let profile = { revision: 7, notes: 'Saved preferences 🌍', enabled: true }, writes = [];
  await page.route('**/api/workspace', route => { assert.equal(route.request().method(), 'GET'); return route.fulfill({ json: { revision: 0, sessions: [], accountId } }); });
  await page.route('**/api/memory', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: profile });
    const body = route.request().postDataJSON(); writes.push(body);
    assert.equal(route.request().headers()['x-trio-account'], accountId);
    if (body.revision !== profile.revision) return route.fulfill({ status: 409, json: { error: 'Personal memory changed on another device. Reload before saving.' } });
    profile = { ...body, revision: profile.revision + 1 }; return route.fulfill({ json: profile });
  });
  await page.route('**/api/memory/suggest', () => assert.fail('A memory backup must not call a model'));
  await page.addInitScript(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      if (this.name === 'delayed.json') return new Promise(resolve => { window.finishMemoryFile = resolve; });
      return original.call(this);
    };
  });
  await page.goto(base + '/workspace', { waitUntil: 'networkidle' });
  const open = () => page.getByRole('button', { name: /Personal memory/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Personal memory', exact: true });
  const notes = page.getByRole('textbox', { name: 'Personal memory notes', exact: true });
  const enabled = page.getByRole('switch', { name: 'Use personal memory', exact: true });
  const file = page.getByLabel('Choose personal memory backup', { exact: true });
  const preview = page.getByRole('textbox', { name: 'Notes in memory backup', exact: true });
  const confirm = page.getByRole('alertdialog', { name: 'Discard unsaved memory changes?', exact: true });
  const close = () => dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const apply = () => dialog.getByRole('button', { name: 'Replace draft with imported notes', exact: true }).click();
  const save = () => dialog.getByRole('button', { name: 'Save memory', exact: true }).click();
  const warns = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  const backup = (notes, enabled = true) => JSON.stringify({ format: 'trio-personal-memory', version: 1, exportedAt: '2026-09-22T12:00:00.000Z', memory: { notes, enabled } });
  const choose = async (text, name = 'my-memory.json') => { await file.setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) }); };
  async function download(label) { const promise = page.waitForEvent('download'); await dialog.getByRole('button', { name: label, exact: true }).click(); const result = await promise; assert.match(result.suggestedFilename(), /^trio-personal-memory-.*\.json$/); return JSON.parse(await readFile(await result.path(), 'utf8')); }
  await open(); await notes.waitFor(); assert.equal(await warns(), false);
  let exported = await download('Download memory'); assert.deepEqual(exported.memory, { notes: profile.notes, enabled: true }); assert.ok(!('revision' in exported)); assert.ok(!JSON.stringify(exported).includes(accountId));
  await notes.fill('Unsaved edits'); exported = await download('Download memory draft'); assert.equal(exported.memory.notes, 'Unsaved edits'); assert.equal(writes.length, 0);
  await choose(backup('Imported notes 🌍')); await preview.waitFor(); assert.equal(await preview.inputValue(), 'Imported notes 🌍'); assert.equal(await notes.inputValue(), 'Unsaved edits'); assert.equal(await enabled.getAttribute('aria-checked'), 'true');
  assert.equal(await dialog.getByRole('button', { name: 'Save memory', exact: true }).isDisabled(), true);
  await close(); await confirm.waitFor(); await confirm.getByRole('button', { name: 'Keep editing', exact: true }).click(); assert.equal(await preview.inputValue(), 'Imported notes 🌍');
  await apply(); assert.equal(await notes.inputValue(), 'Imported notes 🌍'); assert.equal(await enabled.getAttribute('aria-checked'), 'false'); assert.equal(writes.length, 0);
  await enabled.click(); await save(); await dialog.waitFor({ state: 'hidden' }); assert.deepEqual(writes[0], { revision: 7, notes: 'Imported notes 🌍', enabled: true }); assert.equal(await warns(), false);
  await open(); await choose(backup('', false)); await preview.waitFor(); await apply(); assert.equal(await notes.inputValue(), ''); await save(); await dialog.waitFor({ state: 'hidden' }); assert.equal(profile.notes, ''); assert.equal(profile.enabled, false);
  // A restore uses the local account revision, never the file's former account metadata.
  await open(); await choose(backup('Restored draft for conflict')); await preview.waitFor(); await apply();
  profile = { revision: profile.revision + 1, notes: 'Changed on another device', enabled: true };
  await save(); await dialog.getByText('Personal memory changed on another device. Reload before saving.', { exact: true }).waitFor();
  assert.equal(await notes.inputValue(), 'Restored draft for conflict'); assert.equal(profile.notes, 'Changed on another device');
  exported = await download('Download memory draft'); assert.equal(exported.memory.notes, 'Restored draft for conflict'); assert.equal(exported.memory.enabled, false);
  await dialog.getByRole('button', { name: 'Reload saved memory', exact: true }).click(); await page.getByRole('alertdialog', { name: 'Reload saved memory?', exact: true }).getByRole('button', { name: 'Discard draft and reload', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Personal memory notes"]')?.value === 'Changed on another device');
  assert.equal(await warns(), false);
  await choose('{private-file-fragment'); await dialog.getByRole('alert').waitFor(); assert.equal(await notes.inputValue(), profile.notes); assert.ok(!(await dialog.getByRole('alert').innerText()).includes('private-file-fragment'));
  await choose(JSON.stringify({ format: 'trio-workspace', version: 4 })); await dialog.getByText(/Conversation backups belong in Back up/).waitFor(); assert.equal(await notes.inputValue(), profile.notes);
  // Pending file reads are cancelled explicitly or on discard, and late data cannot reappear.
  await choose(backup('late'), 'delayed.json'); await page.waitForFunction(() => Boolean(window.finishMemoryFile)); assert.equal(await warns(), true);
  await dialog.getByRole('button', { name: 'Cancel reading', exact: true }).click(); await page.evaluate(text => window.finishMemoryFile(text), backup('Late cancelled file')); assert.equal(await preview.count(), 0); assert.equal(await warns(), false);
  await choose(backup('late'), 'delayed.json'); await dialog.getByRole('button', { name: 'Cancel reading', exact: true }).waitFor();
  await close(); await confirm.waitFor(); await confirm.getByRole('button', { name: 'Discard changes', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.evaluate(text => window.finishMemoryFile(text), backup('Late discarded file')); await open(); assert.equal(await preview.count(), 0); assert.equal(await notes.inputValue(), profile.notes);
  await choose(backup('Private preferences. '.repeat(180)), 'long-memory-name-'.repeat(12) + '.json'); await preview.waitFor(); assert.equal(await warns(), true);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport); assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await dialog.getByRole('button', { name: 'Replace draft with imported notes', exact: true }).scrollIntoViewIfNeeded();
  }
  await page.setViewportSize({ width: 390, height: 844 }); await mkdir('test-output', { recursive: true }); await page.screenshot({ path: 'test-output/memory-backup-mobile.png', animations: 'disabled' });
  await page.keyboard.press('Escape'); await confirm.waitFor(); await confirm.getByRole('button', { name: 'Keep editing', exact: true }).click(); await preview.waitFor();
  await dialog.getByRole('button', { name: 'Cancel memory import', exact: true }).click(); assert.equal(await notes.inputValue(), profile.notes); assert.equal(await warns(), false); await close();
  assert.equal(writes.length, 3); assert.deepEqual(errors, []);
  console.log('Personal memory backup browser checks passed: saved/draft downloads, preview without writes, explicit disabled restore, enable-and-save, empty notes, conflict preservation/export/reload, invalid files, stale-read cancellation, discard/keep, mobile/landscape, no provider requests.');
} finally { await browser.close(); }
