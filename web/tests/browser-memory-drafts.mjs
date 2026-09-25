import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(base + '/signin-with-chatgpt?return_to=%2Fdemo', { waitUntil: 'networkidle' });
  const accountId = (await (await page.request.get(base + '/api/workspace')).json()).accountId;
  const session = { id: 'memory-draft-test', title: 'Memory draft test', time: '', turns: [{ question: 'Help me plan', mode: 'fast', result: { answer: 'A saved answer', drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false } }] };
  let profile = { revision: 1, notes: 'Prefer practical examples.', enabled: false }, writes = 0, failSave = false;
  await page.route('**/api/workspace', route => { assert.equal(route.request().method(), 'GET'); return route.fulfill({ json: { revision: 1, sessions: [session], accountId } }); });
  await page.route('**/api/memory', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: profile });
    assert.equal(route.request().method(), 'PUT'); writes++;
    if (failSave) return route.fulfill({ status: 503, json: { error: 'Memory was not confirmed saved. Keep your edits and retry.' } });
    profile = { ...route.request().postDataJSON(), revision: profile.revision + 1 };
    return route.fulfill({ json: profile });
  });
  // Never call a provider. Deliberately deliver a suggestion after abort to test the stale-response guard.
  await page.addInitScript(() => {
    const original = window.fetch; window.suggestionAborts = 0;
    window.fetch = function (url, init) {
      if (url !== '/api/memory/suggest') return original.call(this, url, init);
      init.signal.addEventListener('abort', () => window.suggestionAborts++, { once: true });
      return new Promise(resolve => { window.finishSuggestion = text => resolve(new Response(JSON.stringify({ suggestion: text }), { headers: { 'Content-Type': 'application/json' } })); });
    };
  });
  await page.goto(base + '/workspace', { waitUntil: 'networkidle' });
  await page.getByRole('group', { name: 'Session: Memory draft test', exact: true }).locator('.session-open').click();
  const open = () => page.getByRole('button', { name: /Personal memory/ }).click();
  const notes = page.getByRole('textbox', { name: 'Personal memory notes', exact: true });
  const close = () => page.locator('.memory-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Discard unsaved memory changes?', exact: true });
  const keep = () => confirm.getByRole('button', { name: 'Keep editing', exact: true }).click();
  const discard = () => confirm.getByRole('button', { name: 'Discard changes', exact: true }).click();
  const warnsOnUnload = () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  await open(); await notes.waitFor(); assert.equal(await warnsOnUnload(), false);
  await notes.fill('Keep my unsaved notes.'); assert.equal(await warnsOnUnload(), true);
  await close(); await confirm.waitFor(); await keep(); assert.equal(await notes.inputValue(), 'Keep my unsaved notes.');
  await notes.focus(); await page.keyboard.press('Escape'); await confirm.waitFor();
  // Target the newly opened confirmation after focus has entered its keyboard scope.
  await confirm.getByRole('button', { name: 'Keep editing', exact: true }).focus();
  await page.keyboard.press('Escape'); await confirm.waitFor({ state: 'hidden' }); assert.equal(await notes.inputValue(), 'Keep my unsaved notes.');
  await page.mouse.click(5, 5); await confirm.waitFor();
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => { const r = document.querySelector('[data-slot="alert-dialog-content"]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1; });
    assert.equal(await confirm.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    await confirm.getByRole('button', { name: 'Discard changes', exact: true }).scrollIntoViewIfNeeded();
  }
  await page.setViewportSize({ width: 390, height: 844 }); await mkdir('test-output', { recursive: true });
  await page.screenshot({ path: 'test-output/memory-draft-confirm-mobile.png', animations: 'disabled' });
  await discard(); await page.locator('.memory-dialog').waitFor({ state: 'hidden' }); assert.equal(await warnsOnUnload(), false); assert.equal(writes, 0);
  await page.setViewportSize({ width: 1440, height: 1050 }); await open(); assert.equal(await notes.inputValue(), profile.notes);
  // Changing just the enable switch must also require a decision; reverting all edits removes the warning.
  const enabled = page.getByRole('switch', { name: 'Use personal memory', exact: true });
  await enabled.click(); await close(); await confirm.waitFor(); await keep(); assert.equal(await enabled.getAttribute('aria-checked'), 'true');
  await enabled.click(); assert.equal(await warnsOnUnload(), false); await close(); await page.locator('.memory-dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Connections', exact: true }).click(); await page.getByPlaceholder('Paste your API key').first().fill('fake-draft-key'); await page.getByRole('button', { name: 'Done', exact: true }).click();
  await open(); await page.getByRole('button', { name: 'Suggest from conversation', exact: true }).click();
  await page.waitForFunction(() => Boolean(window.finishSuggestion)); await page.evaluate(() => window.finishSuggestion('Review this suggested draft.'));
  await page.getByText('Suggested draft — not saved.', { exact: false }).waitFor(); await close(); await confirm.waitFor(); await keep(); assert.equal(await notes.inputValue(), 'Review this suggested draft.'); assert.equal(writes, 0);
  // Keeping the editor preserves the requested suggestion; confirmed discard aborts it.
  await page.getByRole('button', { name: 'Suggest from conversation', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Replace this memory draft?', exact: true }).getByRole('button', { name: 'Replace with a suggestion', exact: true }).click();
  await page.getByRole('button', { name: 'Stop suggestion', exact: true }).waitFor(); await close(); await confirm.waitFor();
  await keep(); assert.equal(await page.getByRole('button', { name: 'Stop suggestion', exact: true }).count(), 1);
  await page.evaluate(() => window.finishSuggestion('Updated suggested draft.'));
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Personal memory notes"]')?.value === 'Updated suggested draft.');
  await page.getByRole('button', { name: 'Suggest from conversation', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Replace this memory draft?', exact: true }).getByRole('button', { name: 'Replace with a suggestion', exact: true }).click();
  await page.getByRole('button', { name: 'Stop suggestion', exact: true }).waitFor(); await close(); await confirm.waitFor(); await discard();
  await page.evaluate(() => window.finishSuggestion('Late response after discard.')); await open();
  assert.equal(await notes.inputValue(), profile.notes); assert.ok(await page.evaluate(() => window.suggestionAborts >= 1));
  await notes.fill('Review this suggested draft.');
  failSave = true; await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.getByText('Memory was not confirmed saved. Keep your edits and retry.', { exact: true }).waitFor();
  await close(); await confirm.waitFor(); await keep(); assert.equal(await notes.inputValue(), 'Review this suggested draft.'); assert.equal(await warnsOnUnload(), true);
  failSave = false; await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.locator('.memory-dialog').waitFor({ state: 'hidden' }); assert.equal(await confirm.count(), 0); assert.equal(await warnsOnUnload(), false);
  assert.equal(profile.notes, 'Review this suggested draft.'); assert.equal(writes, 2);
  await open(); assert.equal(await notes.inputValue(), profile.notes); await close(); await page.locator('.memory-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log('Memory draft checks passed: Close/Escape/backdrop, keep/discard, switch-only edits, revert, beforeunload cleanup, suggested drafts, late-response cancellation, failed-save preservation, successful save, mobile/landscape; no real writes or provider calls.');
} finally { await browser.close(); }
