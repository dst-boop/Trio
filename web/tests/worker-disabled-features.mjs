// Tools listed in TRIO_DISABLED_FEATURES refuse requests in the real Worker runtime before
// any provider call, and an ask never reads personal memory when memory is turned off.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), wrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wrangler('miniflare'), { build } = wrangler('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers', 'node:crypto'], logLevel: 'silent', plugins: [{ name: 'fixture-identity', setup(build) {
  build.onResolve({ filter: /chatgpt-auth$/ }, () => ({ path: 'identity', namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export async function getChatGPTUser() { return { userId: "alice", email: "alice@test.invalid" }; }', loader: 'js' }));
} }], stdin: { resolveDir: root, loader: 'ts', contents: `
import * as quality from './app/api/quality/route.ts';
import * as comparison from './app/api/work-comparison/route.ts';
import * as memory from './app/api/memory/route.ts';
import { POST as memorySuggest } from './app/api/memory/suggest/route.ts';
import { POST as planSuggest } from './app/api/work-plan/suggest/route.ts';
import { POST as audio } from './app/api/transcribe/route.ts';
import { POST as image } from './app/api/images/generate/route.ts';
import { POST as ask } from './app/api/ask/route.ts';
const routes = { '/api/quality': quality, '/api/work-comparison': comparison, '/api/memory': memory, '/api/memory/suggest': { POST: memorySuggest }, '/api/work-plan/suggest': { POST: planSuggest }, '/api/transcribe': { POST: audio }, '/api/images/generate': { POST: image }, '/api/ask': { POST: ask } };
export default { fetch: request => routes[new URL(request.url).pathname][request.method](request) };` } });
let providerCalls = 0;
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
  bindings: { TRIO_DISABLED_FEATURES: 'quality,comparison,work,audio,image,memory' },
  outboundService(request) { providerCalls++; assert.equal(new URL(request.url).hostname, 'api.openai.com'); return Response.json({ output: [{ content: [{ type: 'output_text', text: 'Fixture answer' }] }] }); } });
const call = (path, method = 'POST', body = {}) => mf.dispatchFetch('https://trio.test' + path, { method, headers: { 'X-Trio-Account': 'alice', Origin: 'https://trio.test', 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
try {
  for (const [path, method] of [['/api/quality', 'GET'], ['/api/quality', 'POST'], ['/api/work-comparison', 'GET'], ['/api/memory', 'GET'], ['/api/memory', 'PUT'], ['/api/memory/suggest', 'POST'], ['/api/work-plan/suggest', 'POST'], ['/api/transcribe', 'POST'], ['/api/images/generate', 'POST']]) {
    const response = await call(path, method);
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.match((await response.json()).error, /turned off/);
  }
  assert.equal(providerCalls, 0);
  // With memory off, a personalized ask still runs (no DB is bound, so reading memory would fail with 503).
  const connections = { openai: { key: 'own-private-key', model: 'model', enabled: true }, claude: { key: '', model: 'model', enabled: false }, gemini: { key: '', model: 'model', enabled: false } };
  const answer = await call('/api/ask', 'POST', { question: 'Fixture', personalize: true, connections, mode: 'single', lead: 'openai' });
  assert.equal(answer.status, 200, await answer.clone().text());
  assert.ok(!(await answer.text()).includes('Personal memory could not be checked'));
  console.log('Worker disabled features passed: every gated route refuses with 404 and no provider call; asks skip memory when it is off.');
} finally { await mf.dispose(); }
