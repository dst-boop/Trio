import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRIO_BASE_URL || 'http://127.0.0.1:8787';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local built preview only.');
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  for (const zone of ['America/New_York', 'Asia/Tokyo', undefined]) {
    const page = await browser.newPage({ timezoneId: zone ?? 'UTC' }), errors = [];
    page.on('pageerror', error => errors.push(error.message)); let payload;
    await page.route('**/api/ask', route => { payload = route.request().postDataJSON(); return route.fulfill({ status: 503, json: { error: 'Local test: provider calls disabled.' } }); });
    await page.goto(base + '/demo', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByPlaceholder('Paste your API key').first().fill('fake-local-time-test');
    await page.getByRole('switch', { name: 'Demo mode', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const question = page.getByRole('textbox', { name: 'Your question', exact: true });
    await question.fill('What date is tomorrow?');
    if (!zone) await page.evaluate(() => { Intl.DateTimeFormat = function () { throw new Error('Simulated unavailable browser time zone'); }; });
    const sent = page.waitForRequest(request => request.url().endsWith('/api/ask'));
    await page.getByRole('button', { name: 'Ask Trio', exact: true }).click(); await sent;
    await page.getByText('Local test: provider calls disabled.', { exact: true }).first().waitFor();
    assert.equal(payload.timeZone, zone); assert.equal(payload.current_time, undefined, 'The browser cannot supply the server clock');
    assert.equal(payload.question, 'What date is tomorrow?');
    assert.equal(await question.inputValue(), payload.question);
    assert.deepEqual(errors, []); await page.close();
  }
  // Actual Worker input validation, with every provider disabled to avoid API calls.
  const client = await browser.newContext();
  const connection = { key: '', enabled: false, model: 'model' };
  const body = { question: 'Tomorrow?', connections: { openai: connection, claude: connection, gemini: connection }, mode: 'fast', lead: 'claude' };
  const headers = { Origin: base, 'oai-authenticated-user-id': 'local_time_test', 'oai-authenticated-user-email': 'time@sites.test' };
  for (const timeZone of ['UTC', 'America/New_York', undefined, 'Mars/Base', 'UTC; private-fragment', 'x'.repeat(101), null]) {
    const response = await client.request.post(base + '/api/ask', { headers, data: { ...body, timeZone } });
    assert.equal(response.status(), 400); assert.match(response.headers()['cache-control'], /no-store/);
    const result = await response.json();
    if (timeZone === undefined || ['UTC', 'America/New_York'].includes(timeZone)) assert.equal(result.error, 'Connect at least one model.');
    else assert.match(result.error, /Check your time zone/);
    assert.ok(!JSON.stringify(result).includes('private-fragment'));
  }
  await client.close();
  console.log('Current time browser/Worker checks passed: browser zones, unavailable-zone fallback, server validation, private errors, intact questions, no provider calls or account writes.');
} finally { await browser.close(); }
