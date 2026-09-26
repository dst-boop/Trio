import { openQuestionOptions } from './workspace-ui.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
const result = { answer: 'Saved answer', drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false };
const fixtures = ['Alpha', 'Beta'].map(title => ({ id: title, title, instructions: 'Saved instructions for ' + title, time: '', turns: [{ question: title + ' question', mode: 'fast', result }] }));
try {
  for (const account of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }), page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message)); let writes = 0;
    await page.goto(base + '/signin-with-chatgpt?return_to=%2Fdemo', { waitUntil: 'networkidle' });
    if (account) {
      const accountId = (await (await page.request.get(base + '/api/workspace')).json()).accountId;
      await page.route('**/api/workspace', route => { if (route.request().method() !== 'GET') { writes++; return route.fulfill({ status: 500 }); } return route.fulfill({ json: { revision: 1, sessions: fixtures, accountId } }); });
      await page.route('**/api/memory', route => route.fulfill({ json: { revision: 0, enabled: false, notes: '' } }));
      await page.goto(base + '/workspace', { waitUntil: 'networkidle' });
      await page.getByRole('group', { name: 'Session: Alpha', exact: true }).locator('.session-open').click();
    } else {
      await page.evaluate(fixtures => { localStorage.setItem('trio-remember', 'true'); localStorage.setItem('trio-sessions', JSON.stringify(fixtures)); localStorage.setItem('trio-active-session', 'Alpha'); }, fixtures);
      await page.reload({ waitUntil: 'networkidle' });
    }
    const question = page.getByRole('textbox', { name: 'Your question', exact: true });
    const confirm = page.getByRole('alertdialog', { name: 'Discard the current draft?', exact: true });
    const select = title => page.getByRole('group', { name: 'Session: ' + title, exact: true }).locator('.session-open').click();
    const start = () => page.getByRole('button', { name: /^New session/ }).click();
    const warns = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
    const upload = name => page.getByLabel('Choose text context').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Private draft context') });
    assert.equal(await warns(), false); await question.fill('Keep this unsent question'); await upload('draft.txt'); await page.locator('.attachment').getByText('draft.txt', { exact: true }).waitFor();
    await select('Alpha'); assert.equal(await confirm.count(), 0); assert.equal(await question.inputValue(), 'Keep this unsent question'); assert.equal(await page.locator('.attachment').count(), 1);
    await select('Beta'); await confirm.getByRole('button', { name: 'Keep editing', exact: true }).click();
    assert.equal(await question.inputValue(), 'Keep this unsent question'); assert.equal(await page.locator('.session-open.active').getAttribute('title'), 'Alpha');
    await start(); await confirm.waitFor(); await page.keyboard.press('Escape'); await confirm.waitFor({ state: 'hidden' }); assert.equal(await question.inputValue(), 'Keep this unsent question');
    assert.equal(await warns(), true);
    // Exercise the native browser refresh warning after a real user interaction, retaining the draft.
    const warned = new Promise(resolve => page.once('dialog', async dialog => { assert.equal(dialog.type(), 'beforeunload'); await dialog.dismiss(); resolve(); }));
    await page.evaluate(() => location.reload()); await warned; assert.equal(await question.inputValue(), 'Keep this unsent question');
    await select('Beta'); await confirm.getByRole('button', { name: 'Discard and switch', exact: true }).click();
    assert.equal(await question.inputValue(), ''); assert.equal(await page.locator('.attachment').count(), 0); assert.equal(await page.locator('.session-open.active').getAttribute('title'), 'Beta'); assert.equal(await warns(), false);
    // New-conversation instructions are not yet in saved history, so protect them too.
    await start(); await openQuestionOptions(page); await page.locator('.session-instructions > summary').click();
    const instructions = page.getByRole('textbox', { name: 'Session instructions', exact: true }); await instructions.fill('Unsaved project requirements');
    await start(); await confirm.getByRole('button', { name: 'Keep editing', exact: true }).click(); assert.equal(await instructions.inputValue(), 'Unsaved project requirements');
    await start(); await confirm.getByRole('button', { name: 'Discard and start new', exact: true }).click(); assert.equal(await instructions.inputValue(), ''); assert.equal(await warns(), false);
    // A pending file may finish while the user decides; Keep retains it and Discard invalidates late reads.
    await page.evaluate(() => { const original = File.prototype.text; File.prototype.text = function () { return this.name.startsWith('slow-') ? new Promise(resolve => window.finishDraftFile = resolve) : original.call(this); }; });
    await upload('slow-keep.txt'); await page.getByText('Loading context…', { exact: true }).waitFor(); await select('Alpha'); await confirm.waitFor();
    await page.evaluate(() => window.finishDraftFile('Keep this file')); await confirm.getByRole('button', { name: 'Keep editing', exact: true }).click(); await page.locator('.attachment').getByText('slow-keep.txt', { exact: true }).waitFor();
    await upload('slow-discard.txt'); await page.getByText('Loading context…', { exact: true }).waitFor(); await select('Alpha'); await confirm.getByRole('button', { name: 'Discard and switch', exact: true }).click();
    await page.evaluate(async () => { window.finishDraftFile('Must not cross sessions'); await new Promise(requestAnimationFrame); }); assert.equal(await page.locator('.attachment').count(), 0);
    await question.fill('Mobile draft'); await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click(); await select('Beta');
    await confirm.waitFor(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.waitForFunction(() => { const r = document.querySelector('[data-slot="alert-dialog-content"]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1; });
    await mkdir('test-output', { recursive: true }); await page.screenshot({ path: `test-output/question-draft-${account ? 'account' : 'guest'}-mobile.png`, animations: 'disabled' });
    await confirm.getByRole('button', { name: 'Keep editing', exact: true }).click(); assert.equal(await question.inputValue(), 'Mobile draft');
    await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click(); await start(); await confirm.waitFor();
    await page.locator('[data-mobile="true"]').waitFor({ state: 'hidden' });
    await confirm.getByRole('button', { name: 'Keep editing', exact: true }).click(); assert.equal(await question.inputValue(), 'Mobile draft');
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.getByRole('group', { name: 'Session: Alpha', exact: true }).getByRole('button', { name: 'Session actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Delete session', exact: true }).click();
    await page.getByText(/Your current unsent question and attached files will also be cleared/).waitFor(); await page.getByRole('button', { name: 'Keep session', exact: true }).click();
    await page.getByRole('button', { name: 'Clear session history', exact: true }).click(); await page.getByText(/Your unsent question, attached files, and new-conversation instructions will also be cleared/).waitFor(); await page.getByRole('button', { name: 'Keep sessions', exact: true }).click();
    await question.fill(''); assert.equal(await warns(), false);
    await page.getByRole('button', { name: 'Run demo', exact: true }).click(); await page.getByRole('button', { name: 'Stop', exact: true }).waitFor(); assert.equal(await warns(), true, 'An active run registers a navigation warning even without a typed draft');
    await page.getByRole('button', { name: 'Stop', exact: true }).click(); await page.getByRole('button', { name: 'Run demo', exact: true }).waitFor(); assert.equal(await warns(), false);
    if (!account) assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('trio-sessions'))), fixtures);
    assert.equal(writes, 0); assert.deepEqual(errors, []); await context.close();
  }
  console.log('Question drafts passed for guest/account: same-session no-op, keep/discard/switch/new, new instructions, native refresh cancellation, active run/Stop warning cleanup, pending file decisions, mobile sidebar, deletion disclosures, no saved-data mutations.');
} finally { await browser.close(); }
