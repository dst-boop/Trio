// Included (operator-paid) keys are capped per account per day in the real Worker
// runtime and D1; the account's own keys are never counted or refused.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url), wrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wrangler('miniflare'), { build } = wrangler('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers'], logLevel: 'silent', plugins: [{ name: 'fixture-identity', setup(build) {
  build.onResolve({ filter: /chatgpt-auth$/ }, () => ({ path: 'identity', namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export async function getChatGPTUser() { return globalThis.fixtureIdentity; }', loader: 'js' }));
} }], stdin: { resolveDir: root, loader: 'ts', contents: `
import { POST as ask } from './app/api/ask/route.ts';
import { POST as image } from './app/api/images/generate/route.ts';
export default { async fetch(request) {
  const userId = request.headers.get('fixture-user');
  globalThis.fixtureIdentity = userId ? { userId, email: userId + '@test.invalid' } : null;
  return ({ '/api/ask': ask, '/api/images/generate': image })[new URL(request.url).pathname](request);
} };` } });
const keysSeen = [];
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
  bindings: { TRIO_WORKSPACE_OPENAI_KEY: 'workspace-openai-key', TRIO_WORKSPACE_DAILY_CALLS: '3' },
  outboundService(request) {
    const url = new URL(request.url);
    assert.equal(url.hostname, 'api.openai.com');
    keysSeen.push(request.headers.get('authorization'));
    if (url.pathname === '/v1/responses') return Response.json({ output: [{ content: [{ type: 'output_text', text: 'Fixture answer' }] }] });
    if (url.pathname === '/v1/images/generations') return Response.json({ data: [{ b64_json: Buffer.from([255, 216, 255, ...new Array(30).fill(0)]).toString('base64') }] });
    throw new Error('Unexpected network request');
  } });
const connections = key => ({ openai: { key, model: 'model', enabled: true }, claude: { key: '', model: 'model', enabled: false }, gemini: { key: '', model: 'model', enabled: false } });
const included = '__TRIO_WORKSPACE_KEY__';
const call = (path, body, account = 'alice') => mf.dispatchFetch('https://trio.test' + path, { method: 'POST', headers: { 'fixture-user': account, 'X-Trio-Account': account, Origin: 'https://trio.test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const askBody = (key, mode = 'single') => ({ question: 'Fixture', connections: connections(key), mode, lead: 'openai' });
try {
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync(root + 'drizzle').filter(name => name.endsWith('.sql')).sort()) for (const statement of readFileSync(root + 'drizzle/' + file, 'utf8').split('--> statement-breakpoint').map(text => text.trim()).filter(Boolean)) await db.prepare(statement).run();
  const used = async account => (await db.prepare('SELECT calls FROM workspace_usage WHERE user_id = ?').bind(account).first())?.calls ?? 0;

  // Quick synthesis on one included model reserves 2; one more call fits, then the cap holds.
  const quick = await call('/api/ask', askBody(included, 'fast'));
  assert.equal(quick.status, 200); await quick.text();
  assert.equal(await used('alice'), 2);
  const picture = await call('/api/images/generate', { key: included, prompt: 'Fixture', size: '1024x1024', quality: 'low' });
  assert.equal(picture.status, 200, await picture.clone().text());
  assert.equal(await used('alice'), 3);
  const upstreamBefore = keysSeen.length;
  const refused = await call('/api/ask', askBody(included));
  assert.equal(refused.status, 429);
  assert.match((await refused.json()).error, /used up.*own API key/);
  const refusedImage = await call('/api/images/generate', { key: included, prompt: 'Fixture', size: '1024x1024', quality: 'low' });
  assert.equal(refusedImage.status, 429);
  assert.equal(keysSeen.length, upstreamBefore, 'a refused request never reaches the provider');

  // The user's own key is not counted and still works after the included allowance is gone.
  const own = await call('/api/ask', askBody('own-private-key'));
  assert.equal(own.status, 200); await own.text();
  assert.equal(keysSeen.at(-1), 'Bearer own-private-key');
  assert.equal(await used('alice'), 3);
  // Another account has its own allowance.
  const bob = await call('/api/ask', askBody(included), 'bob');
  assert.equal(bob.status, 200); await bob.text();
  assert.equal(await used('bob'), 1);
  // Raw keys must be printable ASCII: a control character is a clear 400, not a misleading network error.
  const badKey = await call('/api/ask', askBody('sk-line\nbreak'));
  assert.equal(badKey.status, 400);
  // An ask without an Origin header is refused before anything else runs.
  const noOrigin = await mf.dispatchFetch('https://trio.test/api/ask', { method: 'POST', headers: { 'fixture-user': 'alice', 'X-Trio-Account': 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify(askBody('own-private-key')) });
  assert.equal(noOrigin.status, 403);
  console.log('worker workspace budget: ok');
} finally { await mf.dispose(); }
