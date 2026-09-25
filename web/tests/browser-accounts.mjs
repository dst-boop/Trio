import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const baseUrl = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } }); const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Better thinking, together.' }).waitFor();
  assert.equal((await page.request.get(baseUrl + '/api/workspace')).status(), 401);
  assert.equal((await page.request.post(baseUrl + '/api/ask', { data: {} })).status(), 401);
  const forged = await page.request.get(baseUrl + '/api/workspace', { headers: { 'oai-authenticated-user-id': 'someone-else', 'oai-authenticated-user-email': 'else@example.com' } }); assert.equal(forged.status(), 401);
  await mkdir('test-output', { recursive: true }); await page.screenshot({ path: 'test-output/accounts-welcome.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'test-output/accounts-welcome-mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('link', { name: 'Sign in with ChatGPT' }).click(); await page.getByText('Saved to your account', { exact: true }).waitFor();
  const snapshot = await (await page.request.get(baseUrl + '/api/workspace')).json();
  await context.setExtraHTTPHeaders({ 'X-Trio-Account': snapshot.accountId, 'X-Trio-Workspace-Version': '6' });
  assert.equal((await page.request.put(baseUrl + '/api/workspace', { headers: { origin: baseUrl, 'X-Trio-Account': 'different-account' }, data: { revision: snapshot.revision, sessions: [] } })).status(), 401);
  const fixture = { id: 'legacy-private', title: 'My existing project', time: '', turns: [{ question: 'Private legacy question', mode: 'fast', result: { answer: 'Private legacy answer', drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false } }] };
  const cleared = await page.request.put(baseUrl + '/api/workspace', { headers: { origin: baseUrl }, data: { revision: snapshot.revision, sessions: [] } }); assert.equal(cleared.status(), 200);
  await page.evaluate(s => { localStorage.setItem('trio-remember','true'); localStorage.setItem('trio-sessions', JSON.stringify([s])); }, fixture);
  await page.reload({ waitUntil: 'networkidle' }); await page.getByText('Saved to your account', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /My existing project/ }).count(), 0);
  await page.getByRole('button', { name: 'Back up & restore', exact: true }).click(); await page.getByRole('button', { name: 'Preview browser sessions', exact: true }).click();
  await page.getByRole('button', { name: /Import 1 session/ }).click(); await page.getByRole('group', { name: 'Session: My existing project', exact: true }).waitFor();
  await page.getByText('Saved to your account', { exact: true }).waitFor();
  const stored = await (await page.request.get(baseUrl + '/api/workspace')).json(); assert.equal(stored.sessions.length, 1);
  assert.equal((await page.request.put(baseUrl + '/api/workspace', { headers: { origin: 'https://evil.example' }, data: { revision: stored.revision, sessions: [] } })).status(), 403);
  assert.equal((await page.request.put(baseUrl + '/api/workspace', { headers: { origin: baseUrl }, data: { revision: stored.revision, sessions: [], userId: 'someone-else' } })).status(), 400);
  await page.getByRole('group', { name: 'Session: My existing project', exact: true }).locator('.session-open').click();
  await page.route('**/api/ask', route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'final', result: { answer: 'Saved live answer', drafts: { openai: 'Saved live answer' }, reviews: {}, errors: [], seconds: 1, demo: false } }) + '\n' }));
  await page.getByRole('button', { name: 'Connections', exact: true }).click(); await page.getByPlaceholder('Paste your API key').first().fill('fake-account-key'); await page.getByRole('switch', { name: 'Demo mode', exact: true }).click(); await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('textbox', { name: 'Your question', exact: true }).fill('Account follow-up'); await page.getByRole('button', { name: 'Ask Trio', exact: true }).click(); await page.getByText('Saved to your account', { exact: true }).waitFor();
  const live = await (await page.request.get(baseUrl + '/api/workspace')).json(); assert.equal(live.sessions[0].turns.length, 2); assert.ok(!JSON.stringify(live).includes('fake-account-key'));
  // A fresh browser context with the same signed-in account sees its server history.
  const otherContext = await browser.newContext(); const other = await otherContext.newPage();
  await other.goto(baseUrl + '/signin-with-chatgpt?return_to=%2Fworkspace'); await other.getByRole('group', { name: 'Session: My existing project', exact: true }).waitFor();
  assert.equal(await other.evaluate(() => localStorage.getItem('trio-sessions')), null);
  // Two old views cannot silently overwrite one another.
  const row = page.getByRole('group', { name: 'Session: My existing project', exact: true });
  await row.getByRole('button', { name: 'Session actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Rename session' }).click();
  await page.getByRole('textbox', { name: 'Session name', exact: true }).fill('Saved from first device'); await page.getByRole('button', { name: 'Save name', exact: true }).click(); await page.getByText('Saved to your account', { exact: true }).waitFor();
  await other.getByRole('group', { name: 'Session: My existing project', exact: true }).getByRole('button', { name: 'Session actions', exact: true }).click(); await other.getByRole('menuitem', { name: 'Rename session' }).click();
  await other.getByRole('textbox', { name: 'Session name', exact: true }).fill('Stale device version'); await other.getByRole('button', { name: 'Save name', exact: true }).click();
  await other.getByText('Account history needs attention').waitFor(); assert.equal((await (await page.request.get(baseUrl + '/api/workspace')).json()).sessions[0].title, 'Saved from first device');
  await other.getByRole('button', { name: 'Load latest workspace', exact: true }).click(); await other.getByRole('alertdialog').getByRole('button', { name: 'Replace this tab with saved history', exact: true }).click(); await other.getByRole('group', { name: 'Session: Saved from first device', exact: true }).waitFor();
  let failSave = true;
  await page.route('**/api/workspace', route => route.request().method() === 'PUT' && failSave ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary save failure' }) }) : route.continue());
  await page.getByRole('group', { name: 'Session: Saved from first device', exact: true }).getByRole('button', { name: 'Session actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Rename session' }).click(); await page.getByRole('textbox', { name: 'Session name', exact: true }).fill('Recovered after retry'); await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await page.getByText('Temporary save failure', { exact: true }).waitFor(); assert.equal((await (await page.request.get(baseUrl + '/api/workspace')).json()).sessions[0].title, 'Saved from first device');
  failSave = false; await page.getByRole('button', { name: 'Retry saving', exact: true }).click(); await page.getByText('Saved to your account', { exact: true }).waitFor(); assert.equal((await (await page.request.get(baseUrl + '/api/workspace')).json()).sessions[0].title, 'Recovered after retry');
  // The server commits, but the browser never receives its acknowledgment.
  await page.unroute('**/api/workspace');
  const beforeLost = await (await page.request.get(baseUrl + '/api/workspace')).json();
  const attempts = []; let loseResponse = true;
  await page.route('**/api/workspace', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    attempts.push(route.request().postDataJSON());
    if (!loseResponse) return route.continue();
    loseResponse = false; const saved = await route.fetch(); assert.equal(saved.status(), 200); await route.abort('connectionreset');
  });
  const rename = async (from, to) => {
    await page.getByRole('group', { name: `Session: ${from}`, exact: true }).getByRole('button', { name: 'Session actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Rename session' }).click(); await page.getByRole('textbox', { name: 'Session name', exact: true }).fill(to); await page.getByRole('button', { name: 'Save name', exact: true }).click();
  };
  await rename('Recovered after retry', 'Committed without acknowledgment'); await page.getByText('Account history needs attention').waitFor();
  const committed = await (await page.request.get(baseUrl + '/api/workspace')).json(); assert.equal(committed.revision, beforeLost.revision + 1); assert.equal(committed.sessions[0].title, 'Committed without acknowledgment');
  await rename('Committed without acknowledgment', 'Edited after lost response');
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click(); await page.getByText('Saved to your account', { exact: true }).waitFor();
  const afterRetry = await (await page.request.get(baseUrl + '/api/workspace')).json(); assert.equal(afterRetry.revision, beforeLost.revision + 2); assert.equal(afterRetry.sessions[0].title, 'Edited after lost response');
  assert.equal(attempts.length, 3); assert.deepEqual(attempts[1], attempts[0]); assert.notEqual(attempts[2].requestId, attempts[0].requestId); assert.equal(attempts[2].revision, committed.revision);
  await page.getByRole('link', { name: 'Sign out', exact: true }).click(); await page.getByRole('link', { name: 'Sign in with ChatGPT' }).waitFor();
  assert.equal((await page.request.get(baseUrl + '/api/workspace')).status(), 401);
  assert.equal((await page.request.post(baseUrl + '/api/ask', { data: {} })).status(), 401);
  await otherContext.close(); assert.deepEqual(errors, []);
} finally { await browser.close(); }
console.log('Accounts browser: landing, sign-in/out, private API, explicit migration, cross-device history and stale-write protection passed');
