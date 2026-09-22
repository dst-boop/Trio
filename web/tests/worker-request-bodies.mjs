import assert from 'node:assert/strict';
// Exercise raw request bytes in the built Worker as well as direct reader unit tests.
const base = process.env.TRIO_BASE_URL || 'http://127.0.0.1:8787';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('This test is only for a local Worker preview.');
const send = async (method, url, { headers, data } = {}) => {
  const body = data === undefined ? undefined : typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  // These fixtures never contain a valid write or enabled provider. One retry is safe
  // only for Wrangler's explicit local-restart response, not an application failure.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { method, headers: { ...headers, Connection: 'close' }, body, signal: AbortSignal.timeout(30000), redirect: "error" });
    const text = await response.text();
    if (attempt === 0 && response.status === 503 && text.startsWith('Your worker restarted mid-request.')) { console.log('Local Worker restarted; retrying validation fixture once.'); continue; }
    return { status: () => response.status, headers: () => Object.fromEntries(response.headers), json: async () => JSON.parse(text) };
  }
};
const client = { get: (url, options) => send("GET", url, options), post: (url, options) => send("POST", url, options), put: (url, options) => send("PUT", url, options) };
const invalidUtf8 = Buffer.from([123, 34, 113, 117, 101, 115, 116, 105, 111, 110, 34, 58, 34, 255, 34, 125]);
const headers = { Origin: base, 'Content-Type': 'application/json' };
const expectError = async (response, status, message) => {
  assert.equal(response.status(), status); assert.match(response.headers()['cache-control'], /no-store/);
  const body = await response.json(); assert.equal(body.error, message); assert.ok(!JSON.stringify(body).includes('private-fragment'));
};
  // Only the local preview receives synthetic edge identity headers. Hosted access uses Sites sign-in.
  Object.assign(headers, { 'oai-authenticated-user-id': 'local_request_body_test', 'oai-authenticated-user-email': 'body-test@sites.test' });
  const snapshot = await (await client.get(base + '/api/workspace', { headers })).json();
  for (const data of [invalidUtf8, Buffer.from('{private-fragment')]) await expectError(await client.post(base + '/api/ask', { headers, data }), 400, 'Could not read valid JSON.');
  await expectError(await client.post(base + '/api/ask', { headers, data: ' '.repeat(8_000_001) }), 413, 'Request too large.');
  await expectError(await client.post(base + '/api/ask', { headers: { ...headers, 'Content-Type': 'application/jsonp' }, data: '{}' }), 415, 'Expected JSON.');
  // A complete, valid body reaches input validation, but disabled providers guarantee no paid API calls.
  const connection = { key: '', model: 'model', enabled: false };
  await expectError(await client.post(base + '/api/ask', { headers, data: { question: 'No provider should run 🌍', mode: 'fast', lead: 'claude', connections: { openai: connection, claude: connection, gemini: connection } } }), 400, 'Connect at least one model.');
  const accountHeaders = { ...headers, 'X-Trio-Account': snapshot.accountId, 'X-Trio-Workspace-Version': '4' };
  const put = (data, extra = {}) => client.put(base + '/api/workspace', { headers: { ...accountHeaders, ...extra }, data });
  await expectError(await put(invalidUtf8), 400, 'Could not read valid JSON.');
  await expectError(await put(' '.repeat(20_000_001)), 413, 'Workspace is too large. Export a backup and remove older sessions.');
  await expectError(await put('{}', { 'Content-Type': 'text/application/json' }), 415, 'Expected JSON.');
  for (const data of [invalidUtf8, ' '.repeat(32_001)]) assert.equal((await client.put(base + '/api/memory', { headers: accountHeaders, data })).status(), 400);
  assert.equal((await client.post(base + '/api/connections/check', { headers, data: invalidUtf8 })).status(), 400);
  assert.deepEqual(await (await client.get(base + '/api/workspace', { headers })).json(), snapshot, 'Rejected uploads must not write history or advance its revision');
  console.log('Request body endpoints passed: invalid UTF-8 and media types, 8 MB/20 MB/32 KB limits, valid JSON reaches validation, safe no-store errors, saved history unchanged, no provider calls.');
