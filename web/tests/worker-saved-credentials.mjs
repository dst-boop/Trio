import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url), wrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wrangler('miniflare'), { build } = wrangler('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const master = Buffer.alloc(32, 7).toString('base64');
const bundle = await build({ absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers'], logLevel: 'silent', plugins: [{ name: 'fixture-identity', setup(build) {
  build.onResolve({ filter: /chatgpt-auth$/ }, () => ({ path: 'identity', namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export async function getChatGPTUser() { return globalThis.fixtureIdentity; }', loader: 'js' }));
} }], stdin: { resolveDir: root, loader: 'ts', contents: `
import * as connections from './app/api/connections/route.ts';
import { POST as check } from './app/api/connections/check/route.ts';
import { POST as ask } from './app/api/ask/route.ts';
import { POST as audio } from './app/api/transcribe/route.ts';
import { POST as image } from './app/api/images/generate/route.ts';
import { POST as memory } from './app/api/memory/suggest/route.ts';
import { writeWorkspace, readWorkspace } from './lib/account-store.ts';
import { exportBackup } from './lib/backups.ts';
import { sessionMarkdown } from './lib/sessions.ts';
export default { async fetch(request, env) {
  const userId = request.headers.get('fixture-user');
  globalThis.fixtureIdentity = userId ? {userId, email:userId+'@test.invalid'} : null;
  const path = new URL(request.url).pathname;
  if (path === '/export') { const snapshot=await readWorkspace(env.DB, userId); return Response.json({snapshot,backup:exportBackup(snapshot.sessions),markdown:snapshot.sessions.map(s=>sessionMarkdown(s.turns))}); }
  if (path === '/seed') { await writeWorkspace(env.DB, userId, {revision:0,sessions:[{id:'one', title:'Test',time:'',turns:[{question:'I like plain language',mode:'single',result:{answer:'Noted',drafts:{},reviews:{},errors:[],seconds:1,demo:false}}]}]}); return Response.json({ok:true}); }
  if (path === '/api/connections') return connections[request.method](request);
  return ({'/api/connections/check':check,'/api/ask':ask,'/api/transcribe':audio,'/api/images/generate':image,'/api/memory/suggest':memory})[path](request);
} };` } });
let upstreamCalls = 0;
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { TRIO_CREDENTIAL_KEY: master }, outboundService(request) {
  upstreamCalls++;
  const url = new URL(request.url);
  assert.equal(url.hostname, 'api.openai.com');
  assert.equal(request.headers.get('authorization'), 'Bearer synthetic-private-key');
  if (url.pathname === '/v1/models/model') return Response.json({ id: 'model', object: 'model' });
  if (url.pathname === '/v1/responses') return Response.json({ output: [{ content: [{ type: 'output_text', text: 'Fixture answer' }] }] });
  if (url.pathname === '/v1/audio/transcriptions') return Response.json({ text: 'Fixture transcript' });
  if (url.pathname === '/v1/images/generations') return Response.json({ data: [{ b64_json: Buffer.from([255,216,255,...new Array(30).fill(0)]).toString('base64') }] });
  throw new Error('Unexpected network request');
} });
const ref = '__TRIO_SAVED_KEY__';
const keyInput = { provider:'openai', revision:0, key:'synthetic-private-key', model:'model', enabled:true };
const connections = { openai:{key:ref,model:'model',enabled:true},claude:{key:'',model:'model',enabled:false},gemini:{key:'',model:'model',enabled:false} };
async function call(path, method = 'GET', body, account = 'alice', pin = account, origin = 'https://trio.test') {
  return mf.dispatchFetch('https://trio.test'+path, { method, headers: { ...(account ? {'fixture-user':account} : {}), 'X-Trio-Account':pin || '', Origin:origin, 'Content-Type':'application/json' }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
}
const consumerBodies = [
  ['/api/connections/check',{provider:'openai',key:ref,model:'model'}],
  ['/api/ask',{question:'Fixture',connections,mode:'single',lead:'openai'}],
  ['/api/transcribe',{key:ref,audio:{format:'wav',data:Buffer.from('RIFF0000WAVEfmt 0000000000000000').toString('base64')}}],
  ['/api/images/generate',{key:ref,prompt:'Fixture',size:'1024x1024',quality:'low'}],
  ['/api/memory/suggest',{sessionId:'one',revision:1,connection:{provider:'openai',key:ref,model:'model'}}],
];
try {
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync(root+'drizzle').filter(name=>name.endsWith('.sql')).sort()) for (const statement of readFileSync(root+'drizzle/'+file,'utf8').split('--> statement-breakpoint').map(text=>text.trim()).filter(Boolean)) await db.prepare(statement).run();
  for (const method of ['GET','PUT','DELETE']) assert.equal((await call('/api/connections',method,method==='GET'?undefined:keyInput,null)).status,401);
  assert.equal((await call('/api/connections','PUT',keyInput,'alice','bob')).status,401);
  assert.equal((await call('/api/connections','PUT',keyInput,'alice','alice','https://other.test')).status,403);
  assert.equal((await call('/api/connections','PUT',{...keyInput,key:ref})).status,400);
  const saved = await call('/api/connections','PUT',keyInput); assert.equal(saved.status,200);
  const metadata = await (await call('/api/connections')).text();
  assert.ok(!metadata.includes(keyInput.key)); assert.ok(!metadata.includes('cipher')); assert.match(metadata,/no-match|"saved":true/);
  const rows = (await db.prepare('SELECT * FROM provider_credentials').all()).results;
  assert.ok(!JSON.stringify(rows).includes(keyInput.key));
  assert.equal((await (await call('/api/connections', 'GET',undefined,'bob')).json()).connections.every(c=>!c.saved),true);
  await call('/seed','POST',{});
  const exported=await (await call('/export')).text();
  for(const secret of [keyInput.key,master,rows[0].cipher,ref]) assert.ok(!exported.includes(secret),'Workspace, backup and Markdown must exclude saved credential material');
  for (const [path,body] of consumerBodies) {
    const before = upstreamCalls;
    for (const [user,pin] of [['alice','bob'],['bob','bob']]) { const response=await call(path,'POST',body,user,pin); assert.ok([401,409].includes(response.status),path+': '+response.status); }
    assert.equal(upstreamCalls,before,'Account errors must not contact any provider');
    const response=await call(path,'POST',body); assert.equal(response.status,200,path+': '+await response.clone().text());
    const text=await response.text(); assert.ok(!text.includes(keyInput.key)); assert.ok(upstreamCalls>before,path+' must resolve the saved key and reach its provider');
  }
  const withMissing = { ...connections, claude:{key:ref,model:'model',enabled:true} };
  const single = await call('/api/ask','POST',{question:'Only the selected provider',connections:withMissing,mode:'single',lead:'openai'});
  assert.equal(single.status,200);assert.ok(!(await single.text()).includes('saved key was removed'),'Unused saved connections must not affect Single mode');
  const council = await call('/api/ask','POST',{question:'Keep healthy contributions',connections:withMissing,mode:'council',lead:'openai'});
  assert.equal(council.status,200);const councilEvents=(await council.text()).trim().split('\n').map(JSON.parse);
  const final=councilEvents.find(event=>event.type==='final').result;assert.equal(final.answer,'Fixture answer');assert.ok(final.errors.some(error=>error.includes('Claude')&&error.includes('removed')),'Skipped saved connections stay visible in the saved result');
  assert.equal((await call('/api/ask','POST',{question:'Review',reviewAnswer:'Original',connections:withMissing,mode:'council',lead:'openai'})).status,409,'Do not silently weaken an explicitly requested team review');
  assert.equal((await call('/api/connections','DELETE',{provider:'openai',revision:1})).status,200);
  for(const revision of [0,1]) assert.equal((await call('/api/connections','PUT',{...keyInput,revision})).status,409);
  const before=upstreamCalls;
  for(const [path,body] of consumerBodies) assert.equal((await call(path,'POST',body)).status,409,path);
  assert.equal(upstreamCalls,before,'Deleted keys fail before provider calls');
  console.log('Worker saved credentials passed: real D1/encryption, five actual API consumers, account/origin isolation, no plaintext reads, stale writes and deletion, zero real network.');
} finally { await mf.dispose(); }
