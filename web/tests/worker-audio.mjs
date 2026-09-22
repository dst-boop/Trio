import assert from 'node:assert/strict';
const base = process.env.TRIO_BASE_URL || 'http://127.0.0.1:8787';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local Worker preview only.');
const identity = { 'oai-authenticated-user-id': 'local_audio_test', 'oai-authenticated-user-email': 'audio-test@sites.test' };
const headers = { ...identity, Origin: base, 'Content-Type': 'application/json', 'X-Trio-Account': 'local_audio_test' };
async function request(extra, body = '{}') {
  // All fixtures are rejected before provider access; retry only a local Wrangler restart.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(base + '/api/transcribe', { method: 'POST', headers: { ...extra, Connection: 'close' }, body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
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
assert.equal((await request(headers, ' '.repeat(6_000_001))).status, 413);
for (const input of [{}, { key: 'private-fragment', audio: { format: 'wav', data: btoa('invalid recording') } }, { key: '', audio: { format: 'wav', data: btoa('RIFF0000WAVEfmt 0000') } }]) assert.equal((await request(headers, JSON.stringify(input))).status, 400);
assert.deepEqual(await (await fetch(base + '/api/workspace', { headers: identity })).json(), before);
console.log('Built Worker audio endpoint passed: authentication, account pin, same origin, media type, malformed/UTF-8/oversized bodies, schema validation, private safe errors, no history writes or provider calls.');
