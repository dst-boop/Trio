import { openQuestionOptions } from './workspace-ui.mjs';
const baseUrl = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); let calls = 0;
  const sessions = [
    { id: 'one', title: 'Product roadmap', instructions: 'For founders', turns: [{ question: 'How should we launch?', mode: 'fast', result: { drafts: { claude: 'Review the starfruit milestone' }, reviews: {}, answer: 'Original product answer', errors: [], seconds: 1, demo: false } }], time: '' },
    { id: 'two', title: 'Engineering decisions', turns: [{ question: 'Which architecture?', mode: 'compare', result: { drafts: { gemini: 'An unusual database tradeoff' }, reviews: {}, answer: '', errors: [], seconds: 1, demo: false } }], time: '' },
    { id: 'three', title: 'Writing project', turns: [{ question: 'Write an outline', mode: 'fast', result: { drafts: {}, reviews: {}, answer: 'Original writing answer', errors: [], seconds: 1, demo: false } }], time: '' },
  ];
  await page.addInitScript(sessions => { if (!localStorage.getItem('library-fixture')) { localStorage.setItem('library-fixture', '1'); localStorage.setItem('trio-remember', 'true'); localStorage.setItem('trio-sessions', JSON.stringify(sessions)); localStorage.setItem('trio-active-session', 'one'); } }, sessions);
  await page.route('**/api/ask', async route => { calls++; await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'final', result: { drafts: { openai: 'Follow-up answer' }, reviews: {}, answer: 'Follow-up answer', by: 'openai', errors: [], seconds: 1, demo: false } }) + '\n' }); });
  await page.goto(`${baseUrl}/signin-with-chatgpt?return_to=%2Fdemo`, { waitUntil: 'networkidle' });
  const search = page.getByRole('textbox', { name: 'Search sessions', exact: true });
  const row = title => page.getByRole('group', { name: `Session: ${title}`, exact: true });
  const menu = async title => row(title).getByRole('button', { name: 'Session actions', exact: true }).click();
  await search.fill('STARFRUIT'); assert.equal(await page.locator('.session-open').count(), 1); await row('Product roadmap').waitFor();
  await search.fill('database tradeoff'); await row('Engineering decisions').waitFor(); assert.equal(await page.locator('.session-open').count(), 1);
  await page.getByRole('textbox', { name: 'Your question' }).fill('Keep this unsent prompt');
  await search.fill('no matching phrase'); await page.getByText('No matching conversations. Try another word or clear the search.').waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Your question' }).inputValue(), 'Keep this unsent prompt');
  await page.getByRole('button', { name: 'Clear session search', exact: true }).click();
  await menu('Product roadmap'); await page.getByRole('menuitem', { name: 'Rename session' }).click();
  const name = page.getByRole('textbox', { name: 'Session name', exact: true }); await name.fill(' '); assert.equal(await page.getByRole('button', { name: 'Save name', exact: true }).isDisabled(), true);
  await name.fill('Launch project'); await name.press('Enter'); await row('Launch project').waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Your question' }).inputValue(), 'Keep this unsent prompt');
  await page.getByRole('button', { name: 'Connections', exact: true }).click(); await page.getByPlaceholder('Paste your API key').first().fill('fake-library-key'); await page.getByRole('switch', { name: 'Demo mode', exact: true }).click(); await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Ask Trio', exact: true }).click(); await page.getByRole('button', { name: 'Ask Trio', exact: true }).waitFor(); await row('Launch project').waitFor();
  let saved = JSON.parse(await page.evaluate(() => localStorage.getItem('trio-sessions'))); assert.equal(saved[0].title, 'Launch project'); assert.equal(saved[0].turns.length, 2); assert.equal(saved[0].turns[0].question, 'How should we launch?'); assert.equal(saved[0].instructions, 'For founders');
  // Export any saved conversation without changing the active one.
  await menu('Engineering decisions'); const downloading = page.waitForEvent('download'); await page.getByRole('menuitem', { name: 'Export Markdown' }).click(); const download = await downloading;
  let markdown = ''; for await (const chunk of await download.createReadStream()) markdown += chunk; assert.match(markdown, /Which architecture/); assert.match(markdown, /unusual database tradeoff/); assert.ok(!markdown.includes('Follow-up answer'));
  await page.getByRole('textbox', { name: 'Your question' }).fill('Keep draft while deleting another session');
  await menu('Engineering decisions'); await page.getByRole('menuitem', { name: 'Delete session' }).click(); await page.getByRole('button', { name: 'Keep session', exact: true }).click(); await row('Engineering decisions').waitFor();
  await menu('Engineering decisions'); await page.getByRole('menuitem', { name: 'Delete session' }).click(); await page.getByRole('button', { name: 'Delete session', exact: true }).click();
  assert.equal(await row('Engineering decisions').count(), 0); assert.equal(await page.getByRole('textbox', { name: 'Your question' }).inputValue(), 'Keep draft while deleting another session');
  assert.equal(await page.evaluate(() => localStorage.getItem('trio-active-session')), 'one');
  await page.reload({ waitUntil: 'networkidle' }); await row('Launch project').waitFor(); assert.equal(await row('Engineering decisions').count(), 0);
  await mkdir('test-output', { recursive: true }); await page.locator('.trio-sidebar').screenshot({ path: 'test-output/session-library-desktop.png' });
  // A mobile menu opens the dialog outside the sidebar and survives a viewport change.
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click(); await menu('Writing project'); await page.getByRole('menuitem', { name: 'Rename session' }).click();
  await name.fill('Writing on mobile'); await mkdir('test-output', { recursive: true }); await page.locator('.session-action-dialog').screenshot({ path: 'test-output/session-library-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1050 }); assert.equal(await name.inputValue(), 'Writing on mobile'); await page.getByRole('button', { name: 'Save name', exact: true }).click(); await row('Writing on mobile').waitFor();
  // Deleting the active conversation clears its draft and instructions, while keeping other sessions.
  await page.getByRole('textbox', { name: 'Your question' }).fill('Draft to clear');
  await menu('Launch project'); await page.getByRole('menuitem', { name: 'Delete session' }).click(); await page.getByRole('button', { name: 'Delete session', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Your question' }).inputValue(), ''); assert.equal(await page.evaluate(() => localStorage.getItem('trio-active-session')), '');
  await openQuestionOptions(page); await page.locator('.session-instructions > summary').click(); assert.equal(await page.getByRole('textbox', { name: 'Session instructions', exact: true }).inputValue(), '');
  saved = JSON.parse(await page.evaluate(() => localStorage.getItem('trio-sessions'))); assert.equal(saved.length, 1); assert.equal(saved[0].title, 'Writing on mobile');
  assert.ok(!JSON.stringify(saved).includes('fake-library-key')); assert.equal(calls, 1); assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log('Session library browser checks passed: content search, no-match recovery, rename, follow-up title preservation, targeted export, delete confirmation and isolation, persistence, mobile dialog continuity, key privacy.');
