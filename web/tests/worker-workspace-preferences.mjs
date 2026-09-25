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
import * as preferences from './app/api/preferences/route.ts';
import { readWorkspacePreferences } from './lib/workspace-preferences-store.ts';
export default { async fetch(request, env) {
  const userId = request.headers.get('fixture-user');
  globalThis.fixtureIdentity = userId ? {userId, email:userId+'@test.invalid'} : null;
  if (new URL(request.url).pathname === '/included') return Response.json(await readWorkspacePreferences(env.DB,userId,{gemini:true}));
  return preferences[request.method](request);
} };` } });
let upstreamCalls = 0;
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], outboundService() { upstreamCalls++; throw new Error('Preference operations must never contact a provider'); } });
async function call(method = 'GET', body, account = 'alice', pin = account, origin = 'https://trio.test', path = '/api/preferences') {
  return mf.dispatchFetch('https://trio.test'+path, { method, headers: { ...(account ? {'fixture-user':account} : {}), 'X-Trio-Account':pin || '', Origin:origin, 'Content-Type':'application/json' }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
}
const defaults = { revision:0, demo:true, mode:'single', lead:'openai' };
try {
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync(root+'drizzle').filter(name=>name.endsWith('.sql')).sort()) for (const statement of readFileSync(root+'drizzle/'+file,'utf8').split('--> statement-breakpoint').map(text=>text.trim()).filter(Boolean)) await db.prepare(statement).run();
  for (const method of ['GET','PUT']) {
    assert.equal((await call(method,method==='PUT'?defaults:undefined,null)).status,401);
    assert.equal((await call(method,method==='PUT'?defaults:undefined,'alice','bob')).status,401);
  }
  assert.equal((await call('PUT',defaults,'alice','alice','https://other.test')).status,403);
  const initial = await call(); assert.equal(initial.status,200); assert.equal(initial.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(await initial.json(),{...defaults,accountId:'alice'});
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM workspace_preferences').first()).count,0,'Reads do not create preferences');
  await db.prepare("INSERT INTO provider_credentials (user_id,provider,cipher,iv,model,enabled,revision,updated_at) VALUES ('alice','claude','not-decrypted','fixture-iv','model',1,1,'now')").run();
  assert.equal((await (await call()).json()).lead,'claude','First-use model is an enabled saved connection, without decrypting it');
  assert.equal((await (await call('GET',undefined,'bob','bob','https://trio.test','/included')).json()).lead,'gemini','Included connection is usable on first visit');
  assert.equal((await call('PUT',{...defaults,revision:50},'new-account')).status,409);
  assert.equal(await db.prepare("SELECT revision FROM workspace_preferences WHERE user_id = 'new-account'").first(),null,'Invalid first write cannot create a default record');
  await db.prepare("INSERT INTO provider_credentials (user_id,provider,cipher,iv,model,enabled,revision,updated_at) VALUES ('disabled','gemini','fixture-cipher','fixture-iv','model',0,1,'now')").run();
  assert.equal((await (await call('GET',undefined,'disabled','disabled','https://trio.test','/included')).json()).lead,'openai','Disabled saved key remains disabled; included fallback only fills an empty connection');
  await db.prepare("INSERT INTO provider_credentials (user_id,provider,cipher,iv,model,enabled,revision,updated_at) VALUES ('disabled-empty','gemini',NULL,NULL,'model',0,1,'now')").run();
  assert.equal((await (await call('GET',undefined,'disabled-empty','disabled-empty','https://trio.test','/included')).json()).lead,'openai','An included key does not enable a disabled key-less connection');
  for (const body of [{...defaults,key:'synthetic-secret'}, {...defaults,accountId:'bob'}, {...defaults,mode:'bad'}, {...defaults,revision:-1}]) assert.equal((await call('PUT',body)).status,400);
  const oversized = await call('PUT',{...defaults,junk:'x'.repeat(2000)}); assert.equal(oversized.status,413); assert.ok(!(await oversized.text()).includes('xxx'));
  const first = {...defaults,demo:false,mode:'fast',lead:'claude'};
  assert.equal((await call('PUT',first)).status,200);
  assert.deepEqual(await (await call()).json(),{...first,revision:1,accountId:'alice'});
  assert.equal((await call('PUT',first)).status,200,'Lost acknowledgement can safely retry the identical intent');
  assert.equal((await (await call()).json()).revision,1,'Retry does not write again');
  assert.equal((await call('PUT',{...first,mode:'deep'})).status,409,'Stale different intent must conflict');
  assert.deepEqual(await (await call('GET',undefined,'bob')).json(),{...defaults,accountId:'bob'});
  const results = await Promise.all([
    call('PUT',{...first,revision:1,mode:'council'}).then(async r=>({status:r.status,data:await r.json()})),
    call('PUT',{...first,revision:1,lead:'gemini'}).then(async r=>({status:r.status,data:await r.json()})),
  ]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  assert.equal((await (await call()).json()).revision,2);
  assert.equal((await call('PUT',first)).status,409,'Old retry cannot overwrite a later revision');
  assert.equal((await call('PUT',{...defaults,lead:'gemini'},'bob')).status,200);
  assert.equal((await (await call('GET',undefined,'bob')).json()).lead,'gemini');
  const stored = (await db.prepare('SELECT * FROM workspace_preferences').all()).results;
  assert.equal(stored.length,2); assert.ok(!JSON.stringify(stored).includes('not-decrypted')); assert.equal(upstreamCalls,0);
  console.log('Worker workspace preferences passed: actual D1 and API, first-use availability, account/origin isolation, read-only hydration, idempotent saves, concurrent stale-tab conflicts, strict size/schema limits, and zero provider calls.');
} finally { await mf.dispose(); }
