import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRIO_BASE_URL || 'http://localhost:5173';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const session = { id: 'recovery', title: 'Saved conversation', time: '', turns: [{ question: 'Question', mode: 'single', result: { answer: 'Saved answer', drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false } }] };
  let snapshot = { accountId: 'local_seedy', revision: 1, sessions: [session] };
  let failure = 'conflict', loadFailure = false;
  const attempts = [];
  await page.route('**/api/workspace', route => {
    if (route.request().method() === 'GET') return loadFailure
      ? route.fulfill({ status: 502, contentType: 'text/html', body: '<html>private upstream detail</html>' })
      : route.fulfill({ json: snapshot });
    const body = route.request().postDataJSON(); attempts.push(body);
    if (failure === 'conflict') return route.fulfill({ status: 409, contentType: 'text/html', body: '<html>private conflict detail</html>' });
    if (failure === 'empty') return route.fulfill({ status: 503, body: '' });
    if (failure === 'malformed') return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>private success detail</html>' });
    snapshot = { ...snapshot, sessions: body.sessions, revision: body.revision + 1 };
    return route.fulfill({ json: { revision: snapshot.revision } });
  });
  await page.route('**/api/preferences', route => route.fulfill({ json: { accountId: 'local_seedy', revision: 0, demo: true, mode: 'single', lead: 'openai' } }));
  await page.route('**/api/memory', route => route.fulfill({ json: { revision: 0, notes: '', enabled: false } }));
  await page.route('**/api/connections', route => route.fulfill({ json: { connections: ['openai', 'claude', 'gemini'].map(provider => ({ provider, revision: 0, saved: false, enabled: true, model: 'model' })) } }));
  await page.route('**/api/ask', () => { throw new Error('No provider calls expected'); });
  await page.goto(base + '/signin-with-chatgpt?return_to=%2Fworkspace', { waitUntil: 'networkidle' });
  const rename = async (from, to) => {
    await page.getByRole('group', { name: `Session: ${from}`, exact: true }).getByRole('button', { name: 'Session actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename session', exact: true }).click();
    await page.getByRole('textbox', { name: 'Session name', exact: true }).fill(to);
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await page.getByText('Account history needs attention', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(), /private (conflict|upstream|success) detail|Unexpected token|JSON input/);
  };
  await rename('Saved conversation', 'Unconfirmed rename');
  await page.getByRole('button', { name: 'Load latest workspace', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry saving', exact: true }).count(), 0);
  assert.equal(attempts.length, 1);
  await page.getByRole('button', { name: 'Load latest workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Keep this tab', exact: true }).click();
  await page.getByRole('group', { name: 'Session: Unconfirmed rename', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load latest workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Replace this tab with saved history', exact: true }).click();
  await page.getByRole('group', { name: 'Session: Saved conversation', exact: true }).waitFor();
  for (const kind of ['empty', 'malformed']) {
    failure = kind;
    const from = snapshot.sessions[0].title, to = `Recovered ${kind}`;
    await rename(from, to);
    const attempted = attempts.at(-1);
    assert.equal(snapshot.sessions[0].title, from);
    failure = '';
    await page.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await page.getByText('Saved to your account', { exact: true }).waitFor();
    assert.deepEqual(attempts.at(-1), attempted, 'Retry keeps the same idempotent save attempt');
    assert.equal(snapshot.sessions[0].title, to);
  }
  loadFailure = true;
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Retry loading', exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /private upstream detail|Unexpected token/);
  loadFailure = false;
  await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
  await page.getByRole('group', { name: `Session: ${snapshot.sessions[0].title}`, exact: true }).waitFor();
  assert.equal(attempts.length, 5); assert.deepEqual(errors, []);
  console.log('Workspace recovery passed: HTML conflicts, explicit reload/cancel, empty errors, malformed acknowledgments, exact retries, load recovery, private diagnostics; no real writes or provider calls.');
} finally { await browser.close(); }
