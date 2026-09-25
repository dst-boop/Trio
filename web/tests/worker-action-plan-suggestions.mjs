import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url), wrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wrangler('miniflare'), { build } = wrangler('esbuild');
const root = fileURLToPath(new URL('../', import.meta.url));
const master = Buffer.alloc(32, 9).toString('base64');
const keys = { openai:'synthetic-action-openai-key', claude:'synthetic-action-disabled-claude-key', gemini:'synthetic-action-included-gemini-key' };
const bundle = await build({ absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['cloudflare:workers'], logLevel: 'silent', plugins: [{ name: 'fixture-identity', setup(build) {
  build.onResolve({ filter: /chatgpt-auth$/ }, () => ({ path: 'identity', namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export async function getChatGPTUser() { return globalThis.fixtureIdentity; }', loader: 'js' }));
} }], stdin: { resolveDir: root, loader: 'ts', contents: `
import { POST as suggest } from './app/api/work-plan/suggest/route.ts';
import * as connections from './app/api/connections/route.ts';
import { writeWorkspace, readWorkspace } from './lib/account-store.ts';
export default { async fetch(request, env) {
  const userId = request.headers.get('fixture-user');
  globalThis.fixtureIdentity = userId ? {userId, email:userId+'@test.invalid'} : null;
  const path = new URL(request.url).pathname;
  if (path === '/seed') { const input=await request.json(); await writeWorkspace(env.DB,userId,input); return Response.json({ok:true}); }
  if (path === '/workspace') return Response.json(await readWorkspace(env.DB,userId));
  if (path === '/api/connections') return connections[request.method](request);
  return suggest(request);
} };` } });
let upstreamCalls = 0, providerResponse = 'normal';
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: { TRIO_CREDENTIAL_KEY:master, TRIO_WORKSPACE_GEMINI_KEY:keys.gemini }, async outboundService(request) {
  upstreamCalls++; const url = new URL(request.url);
  assert.equal(url.hostname,'api.openai.com'); assert.equal(request.headers.get('authorization'),'Bearer '+keys.openai);
  const body=await request.json(); assert.equal(body.stream,undefined); assert.equal(body.tools,undefined);
  for(const key of Object.values(keys)) assert.ok(!JSON.stringify(body).includes(key),'Credential text must be removed before sending the source');
  if(providerResponse==='error') return Response.json({error:'private diagnostic '+keys.openai},{status:429});
  const text=providerResponse==='invalid'?JSON.stringify({goal:'Invalid',actions:['Do it'],completed:true}):JSON.stringify({goal:'Review '+keys.openai,actions:['Draft the template '+keys.claude,'Confirm the approver '+keys.gemini]});
  return Response.json({output:[{content:[{type:'output_text',text}]}],usage:{input_tokens:80,output_tokens:40}});
} });
const input = {sessionId:'one',turnIndex:0,revision:1,connection:{provider:'openai',key:'__TRIO_SAVED_KEY__',model:'gpt-6-astra'}};
async function call(path='/api/work-plan/suggest', method='POST', body=input, account='alice', pin=account, origin='https://trio.test') {
  return mf.dispatchFetch('https://trio.test'+path,{method,headers:{...(account?{'fixture-user':account}:{}),'X-Trio-Account':pin||'',Origin:origin,'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)})});
}
const source={id:'one',title:'Synthetic action drafting',time:'',turns:[{question:'Fictional task '+keys.claude,mode:'single',result:{answer:'Prepare a template '+keys.openai+' and confirm an approver '+keys.gemini,drafts:{},reviews:{},errors:[],seconds:1,demo:false}}]};
try {
  const db=await mf.getD1Database('DB');
  for(const file of readdirSync(root+'drizzle').filter(name=>name.endsWith('.sql')).sort()) for(const statement of readFileSync(root+'drizzle/'+file,'utf8').split('--> statement-breakpoint').map(text=>text.trim()).filter(Boolean)) await db.prepare(statement).run();
  await call('/seed','POST',{revision:0,sessions:[source]});
  for(const provider of ['openai','claude']) assert.equal((await call('/api/connections','PUT',{provider,revision:0,key:keys[provider],model:provider==='openai'?'gpt-6-astra':'claude-sonnet-5',enabled:provider==='openai'})).status,200);
  const before=await (await call('/workspace','GET')).text();
  for(const args of [
    [input,null], [input,'alice','bob'], [input,'alice','alice','https://other.test'],
    [{...input,revision:0}], [{...input,sessionId:'missing'}], [{...input,turnIndex:1}],
    [{...input,question:'Injected source'}], [{...input,connection:{...input.connection,provider:'claude'}}],
  ]) { const response=await call('/api/work-plan/suggest','POST',...args); assert.ok([400,401,403,404,409].includes(response.status),String(response.status)); await response.text(); }
  const oversized=await call('/api/work-plan/suggest','POST',{...input,junk:'x'.repeat(5000)}); assert.equal(oversized.status,413);
  assert.equal(upstreamCalls,0,'Validation, account, origin, stale workspace and unavailable source fail before provider calls');
  const other=await call('/api/work-plan/suggest','POST',input,'bob'); assert.equal(other.status,409); assert.equal(upstreamCalls,0);
  const success=await call(); assert.equal(success.status,200); assert.equal(success.headers.get('cache-control'),'private, no-store');
  const text=await success.text(); for(const key of Object.values(keys)) assert.ok(!text.includes(key)); const data=JSON.parse(text);
  assert.equal(data.accountId,'alice'); assert.equal(data.revision,1); assert.equal(data.provider,'openai'); assert.equal(data.usage.calls,1); assert.equal(data.usage.reportedCalls,1); assert.equal(data.suggestion.actions.length,2);
  assert.equal(upstreamCalls,1); assert.equal(await (await call('/workspace','GET')).text(),before,'Drafting cannot save plans, completion or outcomes');
  assert.ok(!('completedAt' in data.suggestion)); assert.ok(!('outcome' in data.suggestion));
  for(const outcome of ['invalid','error']) { providerResponse=outcome; const previous=upstreamCalls; const failed=await call(); assert.equal(failed.status,502); const diagnostic=await failed.text(); assert.ok(!diagnostic.includes(keys.openai)); assert.equal(upstreamCalls,previous+1,'No automatic paid repair or retry'); }
  providerResponse='normal';
  const storedClaude=await db.prepare("SELECT cipher FROM provider_credentials WHERE user_id = 'alice' AND provider = 'claude'").first();
  await db.prepare("UPDATE provider_credentials SET cipher = 'unreadable-fixture' WHERE user_id = 'alice' AND provider = 'claude'").run();
  const callsBeforeUnreadable=upstreamCalls, unreadable=await call();
  assert.equal(unreadable.status,409); assert.match((await unreadable.json()).error,/saved Claude connection could not be read for secret redaction/); assert.equal(upstreamCalls,callsBeforeUnreadable);
  await db.prepare("UPDATE provider_credentials SET cipher = ? WHERE user_id = 'alice' AND provider = 'claude'").bind(storedClaude.cipher).run();
  await call('/seed','POST',{revision:1,sessions:[{...source,turns:[{...source.turns[0],result:{...source.turns[0].result,demo:true}}]}]});
  const previous=upstreamCalls; assert.equal((await call('/api/work-plan/suggest','POST',{...input,revision:2})).status,400); assert.equal(upstreamCalls,previous);
  console.log('Worker action-plan suggestions passed: real API, saved workspace revision fence, account/origin isolation, actual encrypted and included key resolution/redaction, one selected provider, strict output, usage, no retries, no plan or outcome writes, zero real network.');
} finally { await mf.dispose(); }
