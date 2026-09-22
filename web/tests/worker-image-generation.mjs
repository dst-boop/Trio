import assert from 'node:assert/strict';
const base = process.env.TRIO_BASE_URL || 'http://127.0.0.1:8787';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local Worker preview only.');
const identity = { 'oai-authenticated-user-id': 'local_image_generation_test', 'oai-authenticated-user-email': 'images-test@sites.test' };
const headers = { ...identity, Origin: base, 'Content-Type': 'application/json', 'X-Trio-Account': identity['oai-authenticated-user-id'] };
async function request(extra, body = '{}') {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(base + '/api/images/generate', { method: 'POST', headers: { ...extra, Connection: 'close' }, body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    // Only rejected validation fixtures can be retried, and only for this local preview restart.
    if (attempt === 0 && response.status === 503 && text.startsWith('Your worker restarted mid-request.')) continue;
    assert.match(response.headers.get('cache-control'), /private, no-store/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(!text.includes('private-fragment')); return { status: response.status, data: JSON.parse(text) };
  }
}
const before = await (await fetch(base + '/api/workspace', { headers: identity })).json();
assert.equal((await request({ Origin: base, 'Content-Type': 'application/json' })).status, 401);
assert.equal((await request({ ...headers, 'X-Trio-Account': 'someone_else' })).status, 401);
assert.equal((await request({ ...headers, Origin: 'https://elsewhere.invalid' })).status, 403);
assert.equal((await request({ ...headers, 'Content-Type': 'text/plain' })).status, 415);
assert.equal((await request(headers, '{private-fragment')).status, 400);
assert.equal((await request(headers, new Uint8Array([255]))).status, 400);
assert.equal((await request(headers, ' '.repeat(32_001))).status, 413);
const invalid = { prompt: 'No model should be called', size: '1024x1024', quality: 'medium', key: '' };
for (const input of [{}, invalid, { ...invalid, key: 'private-fragment', size: 'arbitrary' }, { ...invalid, key: 'private-fragment', prompt: 'x'.repeat(4001) }]) assert.equal((await request(headers, JSON.stringify(input))).status, 400);
assert.deepEqual(await (await fetch(base + '/api/workspace', { headers: identity })).json(), before);
console.log('Built Worker image endpoint passed: authentication/account pin/origin, media type, malformed/UTF-8/oversized requests, schema validation, private errors, no history writes or provider calls.');
