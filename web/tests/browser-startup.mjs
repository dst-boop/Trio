import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRIO_BASE_URL || 'http://127.0.0.1:8787';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local built preview only.');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
let release;
try {
  const page = await browser.newPage(), errors = [];
  page.setDefaultTimeout(10_000); page.on('pageerror', error => errors.push(error.message));
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/workspace-*.js', async route => { await held; await route.continue(); });
  await page.goto(base + '/demo', { waitUntil: 'commit' });
  await page.getByText('Getting your workspace ready…', { exact: true }).waitFor();
  assert.equal(await page.locator('textarea, input, button').count(), 0, 'Do not accept clicks or drafts before hydration');
  assert.equal(await page.getByRole('link', { name: 'reload your workspace', exact: true }).getAttribute('href'), '/demo');
  release(); await page.waitForLoadState('networkidle');
  const question = page.getByRole('textbox', { name: 'Your question', exact: true });
  await question.fill('My first question stays');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('dialog', { name: 'Connect your AI team', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await question.inputValue(), 'My first question stays');
  assert.equal(await page.locator('.account-loading').count(), 0);
  assert.deepEqual(errors, []);

  const failed = await browser.newPage(); let blocked = 0;
  // Without any bootstrap JavaScript, the server-rendered recovery link still works.
  await failed.route('**/*.js', route => { blocked++; return route.abort('failed'); });
  await failed.goto(base + '/demo', { waitUntil: 'networkidle' });
  await failed.getByText('Getting your workspace ready…', { exact: true }).waitFor();
  assert.ok(blocked > 0); assert.equal(await failed.locator('textarea, input, button').count(), 0);
  await failed.unroute('**/*.js');
  await failed.getByRole('link', { name: 'reload your workspace', exact: true }).click();
  await failed.getByRole('textbox', { name: 'Your question', exact: true }).fill('Recovered without a dead control');

  // When the runtime loads but one route chunk fails, retain framework recovery.
  const partial = await browser.newPage();
  await partial.route('**/workspace-*.js', route => route.abort('failed'));
  await partial.goto(base + '/demo', { waitUntil: 'networkidle' });
  await partial.getByText('This page couldn’t load', { exact: true }).waitFor();
  await partial.unroute('**/workspace-*.js');
  await partial.getByRole('button', { name: 'Reload', exact: true }).click();
  await partial.getByRole('textbox', { name: 'Your question', exact: true }).fill('Recovered from a missing route chunk');

  const noScript = await browser.newContext({ javaScriptEnabled: false });
  const disabled = await noScript.newPage();
  await disabled.goto(base + '/demo', { waitUntil: 'networkidle' });
  // Playwright's text locator excludes noscript nodes; check rendered body text.
  assert.match(await disabled.locator('body').innerText(), /Trio needs JavaScript to run\./);
  assert.equal(await disabled.locator('textarea, input, button').count(), 0);
  assert.equal(await disabled.getByRole('link', { name: 'reload your workspace', exact: true }).getAttribute('href'), '/demo');
  await noScript.close();

  const account = await browser.newPage({ extraHTTPHeaders: { 'oai-authenticated-user-id': 'local_startup_test', 'oai-authenticated-user-email': 'startup@sites.test' } });
  let attempts = 0, writes = 0;
  await account.route('**/api/workspace', route => {
    if (route.request().method() !== 'GET') writes++;
    if (++attempts === 1) return route.fulfill({ status: 503, json: { error: 'Temporary local test failure.' } });
    return route.fulfill({ json: { accountId: 'local_startup_test', revision: 0, sessions: [] } });
  });
  await account.route('**/api/memory', route => route.fulfill({ json: { revision: 0, notes: '', enabled: false } }));
  await account.goto(base + '/workspace', { waitUntil: 'networkidle' });
  await account.getByRole('alert').filter({ hasText: 'Temporary local test failure.' }).waitFor();
  assert.equal(await account.getByRole('textbox', { name: 'Your question', exact: true }).count(), 0);
  await account.getByRole('button', { name: 'Retry loading', exact: true }).click();
  await account.getByRole('textbox', { name: 'Your question', exact: true }).fill('Ready after account recovery');
  assert.equal(attempts, 2); assert.equal(writes, 0);
  console.log('Startup passed: delayed scripts prevent early draft loss; first hydrated click works; failed chunk recovers by native reload; JavaScript-disabled guidance; account failure/retry; no writes.');
} finally { release?.(); await browser.close(); }
