const baseUrl = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const result = { drafts: { openai: 'Saved perspective' }, reviews: {}, answer: 'Saved answer', errors: [], seconds: 1, demo: false };
  const session = { id: 'long-history', title: 'Long conversation', time: new Date().toISOString(), turns: Array.from({ length: 205 }, (_, i) => ({ question: `Question ${i + 1}`, mode: 'fast', result })) };
  await page.goto(`${baseUrl}/signin-with-chatgpt?return_to=%2Fdemo`, { waitUntil: 'networkidle' });
  await page.evaluate(s => {
    localStorage.setItem('trio-remember', 'true');
    localStorage.setItem('trio-sessions', JSON.stringify([s]));
    localStorage.setItem('trio-active-session', s.id);
  }, session);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('204 earlier questions in this session', { exact: true }).waitFor();
  const previous = await page.evaluate(() => localStorage.getItem('trio-sessions'));
  // Simulate a browser quota failure without filling the user's actual disk.
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'trio-sessions') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    window.restoreTrioStorage = () => { Storage.prototype.setItem = original; };
  });
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  const warning = page.getByRole('alert').filter({ hasText: 'Browser history could not be updated' });
  await warning.waitFor();
  await page.getByText('205 earlier questions in this session', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('trio-sessions')), previous, 'Failed save preserves the previous snapshot');
  const pendingDownload = page.waitForEvent('download');
  await warning.getByRole('button', { name: 'Export current session', exact: true }).click();
  const download = await pendingDownload;
  const exported = await readFile(await download.path(), 'utf8');
  assert.match(exported, /# Question 205/);
  assert.match(exported, /Design a practical 30-day plan/);
  await page.evaluate(() => window.restoreTrioStorage());
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await page.getByRole('button', { name: 'Run demo', exact: true }).waitFor();
  await page.getByText('206 earlier questions in this session', { exact: true }).waitFor();
  await warning.waitFor({ state: 'detached' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('206 earlier questions in this session', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log('Storage browser checks passed: 200+ turns, quota failure preservation, visible warning, export recovery, resumed saving, refresh.');
