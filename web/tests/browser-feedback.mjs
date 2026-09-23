import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TRIO_BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
const result = { answer: 'A completed answer', drafts: { claude: 'A completed perspective' }, reviews: {}, errors: [], seconds: 1, demo: false };
const fixture = { id: 'feedback-test', title: 'Feedback discussion', time: '', turns: [{ question: 'Earlier comparison', mode: 'compare', result: { ...result, answer: '' } }, { question: 'Latest question', mode: 'fast', result }] };
try {
  for (const account of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); const errors = []; let aiCalls = 0, snapshot, headers;
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/\/api\/(ask|memory\/suggest)$/.test(r.url())) aiCalls++; });
    await page.goto(base + '/signin-with-chatgpt?return_to=%2Fdemo', { waitUntil: 'networkidle' });
    const read = async () => account ? (await (await page.request.get(base + '/api/workspace')).json()).sessions : page.evaluate(() => JSON.parse(localStorage.getItem('trio-sessions')));
    const save = async action => {
      const response = account ? page.waitForResponse(r => r.url().endsWith('/api/workspace') && r.request().method() === 'PUT') : null;
      await action(); if (response) assert.equal((await response).status(), 200);
    };
    try {
      if (account) {
        snapshot = await (await page.request.get(base + '/api/workspace')).json(); headers = { Origin: base, 'X-Trio-Account': snapshot.accountId, 'X-Trio-Workspace-Version': '6' };
        assert.equal((await page.request.put(base + '/api/workspace', { headers, data: { revision: snapshot.revision, sessions: [fixture] } })).status(), 200);
        // Stale clients must not silently strip feedback or overwrite newer history.
        assert.equal((await page.request.put(base + '/api/workspace', { headers: { ...headers, 'X-Trio-Workspace-Version': '3' }, data: { revision: snapshot.revision + 1, sessions: [] } })).status(), 409);
        await page.goto(base + '/workspace', { waitUntil: 'networkidle' }); await page.locator('.session-open').filter({ hasText: fixture.title }).click();
      } else {
        await page.evaluate(fixture => { localStorage.setItem('trio-remember', 'true'); localStorage.setItem('trio-active-session', fixture.id); localStorage.setItem('trio-sessions', JSON.stringify([fixture])); }, fixture);
        await page.reload({ waitUntil: 'networkidle' });
      }
      const latest = page.locator('.results-section > .answer-feedback');
      await latest.getByRole('button', { name: 'Needs work', exact: true }).click();
      await page.getByLabel('Feedback note', { exact: true }).fill('Use short worked examples and identify uncertain claims.');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal((await read())[0].turns[1].feedback, undefined);
      await latest.getByRole('button', { name: 'Needs work', exact: true }).click(); assert.equal(await page.getByLabel('Feedback note', { exact: true }).inputValue(), '');
      await page.getByLabel('Feedback note', { exact: true }).fill('Use short worked examples and identify uncertain claims.');
      if (!account) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => { const r = document.querySelector('.feedback-dialog')?.getBoundingClientRect(); return r && r.top >= 0 && r.bottom <= innerHeight; });
        assert.equal(await page.locator('.feedback-dialog').evaluate(el => el.scrollWidth > el.clientWidth), false);
        await mkdir('test-output', { recursive: true }); await page.screenshot({ path: 'test-output/feedback-mobile.png', animations: 'disabled' });
      }
      await save(() => page.getByRole('button', { name: 'Save feedback', exact: true }).click());
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      let records = await read(); assert.equal(records[0].turns[1].feedback.rating, 'needs-work'); assert.deepEqual(records[0].turns[1].result, fixture.turns[1].result);
      await page.setViewportSize({ width: 1440, height: 1050 });
      if (account) {
        await page.goto(base + '/signout-with-chatgpt?return_to=%2F', { waitUntil: 'networkidle' });
        assert.equal((await page.request.get(base + '/api/workspace')).status(), 401);
        await page.goto(base + '/signin-with-chatgpt?return_to=%2Fworkspace', { waitUntil: 'networkidle' });
      } else await page.reload({ waitUntil: 'networkidle' });
      if (account) await page.locator('.session-open').filter({ hasText: fixture.title }).click();
      assert.equal(await latest.getByRole('button', { name: 'Needs work', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.locator('.previous-turns > summary').click(); await page.getByRole('button', { name: /Question 1 Earlier comparison/ }).click();
      const earlier = page.locator('[data-history-turn="0"] .answer-feedback'); await earlier.getByRole('button', { name: 'Helpful', exact: true }).click();
      await save(() => page.getByRole('button', { name: 'Save feedback', exact: true }).click());
      records = await read(); assert.equal(records[0].turns[0].feedback.rating, 'helpful'); assert.equal(records[0].turns[1].feedback.rating, 'needs-work');
      await latest.getByRole('button', { name: 'Helpful', exact: true }).click(); assert.match(await page.getByLabel('Feedback note', { exact: true }).inputValue(), /worked examples/);
      await save(() => page.getByRole('button', { name: 'Save feedback', exact: true }).click()); assert.equal((await read())[0].turns[1].feedback.rating, 'helpful');
      const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export session as Markdown', exact: true }).click();
      const stream = await (await download).createReadStream(); let markdown = ''; for await (const chunk of stream) markdown += chunk; assert.match(markdown, /Your feedback/); assert.match(markdown, /worked examples/);
      await latest.getByRole('button', { name: 'Helpful', exact: true }).click(); await save(() => page.getByRole('button', { name: 'Remove feedback', exact: true }).click());
      records = await read(); assert.equal(records[0].turns[1].feedback, undefined); assert.equal(records[0].turns[0].feedback.rating, 'helpful');
      assert.equal(aiCalls, 0, 'Feedback must not call providers or memory suggestions'); assert.deepEqual(errors, []);
      if (!account) {
        await page.evaluate(fixture => { localStorage.setItem('trio-sessions', JSON.stringify([{ ...fixture, turns: fixture.turns.map(t => ({ ...t, result: { ...t.result, demo: true } })) }])); }, fixture);
        await page.reload({ waitUntil: 'networkidle' }); assert.equal(await page.locator('.answer-feedback').count(), 0);
        await page.locator('.previous-turns > summary').click(); await page.getByRole('button', { name: /Question 1 Earlier comparison/ }).click(); assert.equal(await page.locator('.answer-feedback').count(), 0);
      }
    } finally {
      if (snapshot) { await page.goto(base + '/demo', { waitUntil: 'networkidle' }); const latest = await (await page.request.get(base + '/api/workspace')).json(); assert.equal((await page.request.put(base + '/api/workspace', { headers, data: { revision: latest.revision, sessions: snapshot.sessions } })).status(), 200); }
      await page.close();
    }
  }
  console.log('Feedback passed: guest and authenticated D1 save/edit/remove/reload, latest and earlier Compare answers, cancel, no AI requests, export, demo exclusion, mobile dialog, stale-client rejection.');
} finally { await browser.close(); }
