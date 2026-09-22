import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Exercise the actual workerd fetch implementation, not a Node fetch stub.
// Use the runtime and bundler already pinned by Wrangler in the lockfile.
const require = createRequire(import.meta.url);
const wrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wrangler('miniflare');
const { build } = wrangler('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'silent', stdin: { resolveDir: root, loader: 'ts', contents: `
import { checkConnection } from './lib/check-connection.ts';
import { callProvider } from './lib/orchestrate.ts';
import { generateImage } from './lib/generate-image.ts';
import { transcribeAudio } from './lib/transcribe.ts';
export default { async fetch(request) {
  const [action, provider] = new URL(request.url).pathname.slice(1).split('/');
  const signal = new AbortController().signal;
  try {
    if (action === 'check') return Response.json({ status: await checkConnection({ provider, key:'synthetic-'+provider, model:'model' }, signal) });
    if (action === 'text') return Response.json({ text: await callProvider(provider, 'synthetic-'+provider, 'model', 'Test instructions', 'Synthetic question', signal) });
    if (action === 'image') return Response.json({ image: await generateImage({ key:'synthetic-openai', prompt:'Synthetic fixture', size:'1024x1024', quality:'low' }, signal) });
    if (action === 'audio') return Response.json({ text: await transcribeAudio({ key:'synthetic-openai', audio:{format:'wav',data:btoa('RIFF0000WAVEfmt 0000000000000000')} }, signal) });
    return new Response('Unknown fixture', {status:400});
  } catch (error) { return Response.json({ error:error.message }); }
} };` } });
let redirects = 0, requests = 0, upstreamStatus = 200;
const jpeg = Buffer.from([255, 216, 255, ...new Array(30).fill(0)]).toString('base64');
const cases = [
  ['check/openai', 'https://api.openai.com', '/v1/models/model', 'GET', 'openai', { id:'model', object:'model' }],
  ['check/claude', 'https://api.anthropic.com', '/v1/models/model', 'GET', 'claude', { id:'model', type:'model' }],
  ['check/gemini', 'https://generativelanguage.googleapis.com', '/v1beta/models/model', 'GET', 'gemini', { name:'models/model' }],
  ['text/openai', 'https://api.openai.com', '/v1/responses', 'POST', 'openai', { output:[{content:[{type:'output_text',text:'Fixture answer'}]}] }],
  ['text/claude', 'https://api.anthropic.com', '/v1/messages', 'POST', 'claude', { content:[{type:'text',text:'Fixture answer'}] }],
  ['text/gemini', 'https://generativelanguage.googleapis.com', '/v1beta/interactions', 'POST', 'gemini', { steps:[{type:'model_output',content:[{type:'text',text:'Fixture answer'}]}] }],
  ['image/openai', 'https://api.openai.com', '/v1/images/generations', 'POST', 'openai', { data:[{b64_json:jpeg}] }],
  ['audio/openai', 'https://api.openai.com', '/v1/audio/transcriptions', 'POST', 'openai', { text:'Fixture transcript' }],
];
// A closed outbound service returns fixtures directly. Miniflare's fetchMock
// bridge uses Node fetch, which can follow redirects before workerd sees them.
// This service performs no network I/O and leaves redirect handling to workerd.
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], outboundService(request) {
  const url = new URL(request.url);
  if (url.hostname === 'unexpected.invalid') { redirects++; return Response.json({}); }
  const fixture = cases.find(([,origin,path,method]) => url.origin === origin && url.pathname === path && request.method === method);
  assert.ok(fixture, 'No unexpected external request is allowed');
  requests++;
  const [, , , , provider, success] = fixture;
  const headers = request.headers;
  assert.equal(headers.get(provider === 'openai' ? 'authorization' : provider === 'claude' ? 'x-api-key' : 'x-goog-api-key'), (provider === 'openai' ? 'Bearer ' : '') + 'synthetic-' + provider);
  for (const other of ['openai','claude','gemini'].filter(id => id !== provider)) assert.ok(!JSON.stringify([...headers]).includes('synthetic-' + other));
  assert.equal(headers.get('cache-control'), 'no-cache');
  return Response.json(upstreamStatus === 200 ? success : { error:'Do not echo synthetic-private-diagnostic' }, { status:upstreamStatus, headers:upstreamStatus >= 300 && upstreamStatus < 400 ? { Location:'https://unexpected.invalid/leak' } : {} });
} });
try {
  for (const status of [200, 401, 301, 302, 303, 307, 308]) {
    upstreamStatus = status;
    for (const [action] of cases) {
      const result = await (await mf.dispatchFetch('http://local.test/' + action)).json();
      assert.equal(redirects, 0, `Redirect forwarded during ${action} with status ${status}`);
      if (status === 200) {
        if (action.startsWith('check/')) assert.equal(result.status, 'checked');
        else if (action.startsWith('image/')) assert.deepEqual(result.image, { mimeType:'image/jpeg', data:jpeg });
        else assert.equal(result.text, action.startsWith('audio/') ? 'Fixture transcript' : 'Fixture answer');
      } else if (action.startsWith('check/')) assert.equal(result.status, status === 401 ? 'credentials' : 'rejected', `${action}: ${status}`);
      else { assert.equal(typeof result.error, 'string'); assert.ok(!result.error.includes('Could not reach'), 'The runtime must reach the mocked provider'); }
      assert.ok(!JSON.stringify(result).includes('synthetic-private-diagnostic'));
      assert.equal(redirects, 0, 'Redirect destination must receive no keys, prompts, or files');
    }
  }
  assert.equal(requests, cases.length * 7);
  console.log(`Worker provider transport passed: ${requests} actual-runtime requests; three vendors, metadata/text/image/audio, credential failures, five redirect codes, no redirect forwarding, no real network or keys.`);
} finally { await mf.dispose(); }
