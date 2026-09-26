import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url), wrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wrangler('miniflare'), { build } = wrangler('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const master = Buffer.alloc(32, 8).toString('base64');
const keys = { openai: 'synthetic-memory-openai-key', claude: 'synthetic-memory-disabled-claude-key', gemini: 'synthetic-memory-included-gemini-key' };
const bundle = await build({ absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers'], logLevel: 'silent', plugins: [{ name: 'fixture-identity', setup(build) {
  build.onResolve({ filter: /chatgpt-auth$/ }, () => ({ path: 'identity', namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export async function getChatGPTUser() { return globalThis.fixtureIdentity; }', loader: 'js' }));
} }], stdin: { resolveDir: root, loader: 'ts', contents: `
import { POST as suggest } from './app/api/memory/suggest/route.ts';
import * as connections from './app/api/connections/route.ts';
import { writeWorkspace, readWorkspace } from './lib/account-store.ts';
import { writeMemory, readMemory } from './lib/memory-store.ts';
export default { async fetch(request, env) {
  const userId = request.headers.get('fixture-user');
  globalThis.fixtureIdentity = userId ? {userId, email:userId+'@test.invalid'} : null;
  const path = new URL(request.url).pathname;
  if (path === '/seed') { const input=await request.json(); await writeWorkspace(env.DB,userId,input.workspace); await writeMemory(env.DB,userId,input.memory); return Response.json({ok:true}); }
  if (path === '/snapshot') return Response.json({workspace:await readWorkspace(env.DB,userId),memory:await readMemory(env.DB,userId)});
  if (path === '/api/connections') return connections[request.method](request);
  return suggest(request);
} };` } });
let upstreamCalls = 0, providerResponse = 'normal';
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { TRIO_CREDENTIAL_KEY: master, TRIO_WORKSPACE_GEMINI_KEY: keys.gemini }, async outboundService(request) {
  upstreamCalls++;
  assert.equal(new URL(request.url).hostname, 'api.openai.com');
  assert.equal(request.headers.get('authorization'), 'Bearer ' + keys.openai);
  const body = await request.json();
  for (const key of Object.values(keys)) assert.ok(!JSON.stringify(body).includes(key), 'No connected credential can leave in memory source text');
  if (providerResponse === 'error') return Response.json({ error: 'private diagnostic ' + keys.openai }, { status: 429 });
  const text = providerResponse === 'long' ? 'x'.repeat(4001) : `- Prefers concise explanations. ${keys.openai} ${keys.claude} ${keys.gemini}`;
  return Response.json({ output: [{ content: [{ type: 'output_text', text }] }] });
} });
const source = { id: 'one', title: 'Synthetic memory suggestion', time: '', turns: [{ question: 'Explain this ' + keys.openai, mode: 'single', result: { answer: 'Answer ' + keys.claude, drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false }, feedback: { rating: 'needs-work', note: 'Shorter please ' + keys.gemini } }] };
const input = { sessionId: 'one', revision: 1, connection: { provider: 'openai', key: '__TRIO_SAVED_KEY__', model: 'gpt-6-astra' } };
async function call(path = '/api/memory/suggest', method = 'POST', body = input, account = 'alice', pin = account, origin = 'https://trio.test') {
  return mf.dispatchFetch('https://trio.test' + path, { method, headers: { ...(account ? { 'fixture-user': account } : {}), 'X-Trio-Account': pin || '', Origin: origin, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
}
try {
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync(root + 'drizzle').filter(name => name.endsWith('.sql')).sort()) for (const statement of readFileSync(root + 'drizzle/' + file, 'utf8').split('--> statement-breakpoint').map(text => text.trim()).filter(Boolean)) await db.prepare(statement).run();
  await call('/seed', 'POST', { workspace: { revision: 0, sessions: [source] }, memory: { revision: 0, notes: 'Existing ' + keys.gemini, enabled: true } });
  for (const provider of ['openai', 'claude']) assert.equal((await call('/api/connections', 'PUT', { provider, revision: 0, key: keys[provider], model: provider === 'openai' ? 'gpt-6-astra' : 'claude-sonnet-5', enabled: provider === 'openai' })).status, 200);
  const before = await (await call('/snapshot', 'GET')).text();
  for (const args of [
    [input, null], [input, 'alice', 'bob'], [input, 'alice', 'alice', 'https://other.test'],
    [{ ...input, revision: 0 }], [{ ...input, sessionId: 'missing' }],
    [{ sessionId: 'one', connection: input.connection }], [{ ...input, accountId: 'bob' }],
    [{ ...input, connection: { ...input.connection, provider: 'claude' } }],
  ]) {
    const response = await call('/api/memory/suggest', 'POST', ...args);
    assert.ok([400, 401, 403, 404, 409].includes(response.status), String(response.status));
    await response.text();
  }
  assert.equal((await call('/api/memory/suggest', 'POST', { ...input, junk: 'x'.repeat(5000) })).status, 413);
  assert.equal(upstreamCalls, 0, 'Invalid, stale and unauthorized requests stop before a provider call');
  const success = await call(); assert.equal(success.status, 200); assert.equal(success.headers.get('cache-control'), 'private, no-store');
  const text = await success.text(); for (const key of Object.values(keys)) assert.ok(!text.includes(key));
  assert.equal(JSON.parse(text).suggestion.match(/\[redacted\]/g).length, 3);
  assert.equal(upstreamCalls, 1); assert.equal(await (await call('/snapshot', 'GET')).text(), before, 'Suggestion does not save memory or conversation changes');
  for (const outcome of ['error', 'long']) {
    providerResponse = outcome; const previous = upstreamCalls, failed = await call(); assert.equal(failed.status, 502);
    const diagnostic = await failed.text(); for (const key of Object.values(keys)) assert.ok(!diagnostic.includes(key));
    assert.equal(upstreamCalls, previous + 1, 'No automatic paid retry');
  }
  const stored = await db.prepare("SELECT cipher FROM provider_credentials WHERE user_id = 'alice' AND provider = 'claude'").first();
  await db.prepare("UPDATE provider_credentials SET cipher = 'unreadable-fixture' WHERE user_id = 'alice' AND provider = 'claude'").run();
  const previous = upstreamCalls, unreadable = await call(); assert.equal(unreadable.status, 409); assert.match((await unreadable.json()).error, /saved Claude connection could not be read for secret redaction/); assert.equal(upstreamCalls, previous);
  await db.prepare("UPDATE provider_credentials SET cipher = ? WHERE user_id = 'alice' AND provider = 'claude'").bind(stored.cipher).run();
  console.log('Worker memory suggestions passed: real API, revision and identity checks, saved and included key redaction, safe output/errors, no retries or automatic writes, zero real network.');
} finally { await mf.dispose(); }
