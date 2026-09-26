import { openQuestionOptions, closeQuestionOptions } from './workspace-ui.mjs';
const baseUrl = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  await page.route('**/api/ask', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'final', result: { drafts: { openai: 'Answer' }, reviews: {}, answer: `Answer ${requests.length}`, by: 'openai', errors: [], seconds: 1, demo: false } }) + '\n' });
  });
  await page.goto(`${baseUrl}/signin-with-chatgpt?return_to=%2Fdemo`, { waitUntil: 'networkidle' });
  const editor = page.getByRole('textbox', { name: 'Session instructions', exact: true });
  const open = async () => { await openQuestionOptions(page); if (!await page.locator('.session-instructions').evaluate(element => element.open)) await page.locator('.session-instructions > summary').click(); };
  const first = 'Audience: founders. Budget: $500. <script>window.injected=true</script>';
  const second = 'Audience: engineers. Format: a decision table.';
  await open(); await editor.fill(first); assert.equal(await editor.getAttribute('maxlength'), '6000');
  await page.getByText('Demo ignores these instructions. They apply when you switch to Live.').waitFor();
  await closeQuestionOptions(page);
  await page.getByRole('button', { name: 'Run demo', exact: true }).click(); await page.getByRole('button', { name: 'Run demo', exact: true }).waitFor();
  assert.equal(requests.length, 0); assert.equal(await page.locator('.instructions-used').count(), 0);
  const connect = async remember => {
    await closeQuestionOptions(page);
    await page.getByRole('button', { name: 'Connections', exact: true }).click(); await page.getByPlaceholder('Paste your API key').first().fill('fake-instruction-key');
    await page.getByRole('switch', { name: 'Demo mode', exact: true }).click();
    if (remember) await page.getByRole('switch', { name: 'Remember sessions on this device', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  };
  const ask = async question => { await closeQuestionOptions(page); await page.getByRole('textbox', { name: 'Your question' }).fill(question); await page.getByRole('button', { name: 'Ask Trio', exact: true }).click(); await page.getByRole('button', { name: 'Ask Trio', exact: true }).waitFor(); };
  await connect(true); await ask('First live question'); assert.equal(requests[0].instructions, first); assert.deepEqual(requests[0].history, []);
  await page.locator('.instructions-used > summary').click(); assert.equal(await page.locator('.instructions-used pre').innerText(), first); assert.equal(await page.evaluate(() => window.injected), undefined);
  await open(); await editor.fill(second);
  assert.equal(await page.locator('.instructions-used pre').innerText(), first, 'Editing preferences cannot rewrite an earlier answer snapshot');
  await ask('Follow up'); assert.equal(requests[1].instructions, second); assert.ok(requests[1].history[0].content.includes(first));
  let saved = JSON.parse(await page.evaluate(() => localStorage.getItem('trio-sessions')));
  assert.equal(saved[0].instructions, second); assert.equal(saved[0].turns[0].instructions, undefined); assert.equal(saved[0].turns[1].instructions, first); assert.equal(saved[0].turns[2].instructions, second);
  await open(); await page.getByRole('button', { name: 'Clear instructions', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' }); await open(); assert.equal(await editor.inputValue(), '', 'Explicitly cleared preferences must not restore an older turn snapshot');
  await connect(false); await ask('Use no standing preferences'); assert.equal(requests[2].instructions, '');
  await page.getByRole('button', { name: 'New session', exact: false }).click(); await open(); assert.equal(await editor.inputValue(), '');
  await editor.fill('For a different project'); await ask('Different project question'); assert.equal(requests[3].instructions, 'For a different project'); assert.deepEqual(requests[3].history, []);
  await page.locator('.session-list').getByRole('button', { name: /Design a practical 30-day plan/ }).click(); await open(); assert.equal(await editor.inputValue(), '');
  await closeQuestionOptions(page);
  await page.locator('.previous-turns > summary').click(); await page.getByRole('button', { name: /Question 2/ }).click();
  const previous = page.locator('[data-history-turn="1"]'); await previous.locator('.instructions-used > summary').click(); assert.equal(await previous.locator('.instructions-used pre').innerText(), first);
  await page.getByRole('button', { name: 'Back up & restore', exact: true }).click();
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download backup', exact: true }).click();
  const download = await downloading; let backup = ''; for await (const chunk of await download.createReadStream()) backup += chunk;
  assert.ok(!backup.includes('fake-instruction-key')); const sessions = JSON.parse(backup).sessions;
  assert.ok(sessions.some(s => s.instructions === 'For a different project')); assert.ok(sessions.some(s => s.turns.some(t => t.instructions === first)));
  await page.keyboard.press('Escape'); await open(); await editor.fill('Audience: a small business team.\nConstraints: limited budget.\nFormat: recommendation, tradeoffs, next steps.');
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('[data-sonner-toast]').waitFor({ state: 'hidden' });
  await mkdir('test-output', { recursive: true }); await page.locator('.session-instructions').screenshot({ path: 'test-output/instructions-mobile.png' });
  const base = { question: 'q', connections: Object.fromEntries(['openai', 'claude', 'gemini'].map(id => [id, { key: '', model: 'model', enabled: true }])), mode: 'fast', lead: 'openai' };
  for (const instructions of ['x'.repeat(6001), { text: 'not a string' }]) {
    const response = await page.request.post(`${baseUrl}/api/ask`, { data: { ...base, instructions } }); assert.equal(response.status(), 400); assert.match((await response.json()).error, /session instructions/);
  }
  const valid = await page.request.post(`${baseUrl}/api/ask`, { data: { ...base, instructions: 'x'.repeat(6000) } }); assert.match((await valid.json()).error, /Connect at least one/);
  assert.equal(requests.length, 4); assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log('Session-instruction browser checks passed: demo separation, live payloads, snapshots, editing and clearing, refresh, session isolation, history, backups, literal text, mobile, API limits.');
