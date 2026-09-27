// A run that outlives TRIO_RUN_TIMEOUT_SECONDS is stopped with a clear error event and a
// closed stream, in the real Worker runtime; the per-attempt provider timeout never fires first.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), wrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wrangler('miniflare'), { build } = wrangler('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers'], logLevel: 'silent', plugins: [{ name: 'fixture-identity', setup(build) {
  build.onResolve({ filter: /chatgpt-auth$/ }, () => ({ path: 'identity', namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export async function getChatGPTUser() { return { userId: "alice", email: "alice@test.invalid" }; }', loader: 'js' }));
} }], stdin: { resolveDir: root, loader: 'ts', contents: `import { POST } from './app/api/ask/route.ts'; export default { fetch: request => POST(request) };` } });
let providerCalls = 0;
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], bindings: { TRIO_RUN_TIMEOUT_SECONDS: '1' },
  outboundService() { providerCalls++; return new Promise(() => {}); } }); // a provider that never answers
try {
  const connections = { openai: { key: 'own-private-key', model: 'model', enabled: true }, claude: { key: '', model: 'model', enabled: false }, gemini: { key: '', model: 'model', enabled: false } };
  const started = Date.now();
  const response = await mf.dispatchFetch('https://trio.test/api/ask', { method: 'POST', headers: { Origin: 'https://trio.test', 'X-Trio-Account': 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Slow?', connections, mode: 'single', lead: 'openai' }) });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  const seconds = (Date.now() - started) / 1000;
  assert.ok(seconds < 20, `the stream closed after ${seconds}s instead of at the run limit`);
  assert.ok(providerCalls >= 1);
  assert.ok(events.some(event => event.type === 'error' && /1-second limit and was stopped/.test(event.text)), JSON.stringify(events));
  assert.ok(!events.some(event => event.type === 'final'), 'a stopped run never reports a final answer');
  console.log('Worker run deadline passed: limit error event, closed stream, no final answer.');
} finally { await mf.dispose(); }
