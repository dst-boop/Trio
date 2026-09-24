import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url),wrangler=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare}=wrangler('miniflare'),{build}=wrangler('esbuild');
const root=fileURLToPath(new URL('../',import.meta.url)),master=Buffer.alloc(32,7).toString('base64');
const bundle=await build({absWorkingDir:root,bundle:true,write:false,platform:'node',format:'esm',target:'es2022',external:['cloudflare:workers','node:crypto'],logLevel:'silent',plugins:[{name:'fixture-identity',setup(b){b.onResolve({filter:/chatgpt-auth$/},()=>({path:'identity',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export async function getChatGPTUser(){return globalThis.fixtureIdentity}',loader:'js'}));}}],stdin:{resolveDir:root,loader:'ts',contents:`
import * as quality from './app/api/quality/route.ts';
import * as connections from './app/api/connections/route.ts';
import {stepQualityRun} from './lib/quality-store.ts';
export default {async fetch(request,env){const user=request.headers.get('fixture-user');globalThis.fixtureIdentity=user?{userId:user,email:user+'@test.invalid'}:null;
if(new URL(request.url).pathname==='/disconnected'){const body=await request.json(),stop=new AbortController();stop.abort();const accepted=new Request(request.url,{headers:request.headers,signal:stop.signal});return Response.json({run:await stepQualityRun(env.DB,env.TRIO_CREDENTIAL_KEY,accepted,user,body.id,body.step)});}
const routes=new URL(request.url).pathname==='/api/quality'?quality:connections;return routes[request.method](request);}};
`}});
let attempts=0,release=null,held=null,hold=false,gate=Promise.resolve();
const keys={openai:'quality-openai-private',claude:'quality-claude-private',gemini:'quality-gemini-private'};
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{TRIO_CREDENTIAL_KEY:master},async outboundService(request){
  attempts++;const url=new URL(request.url),p=url.hostname==='api.openai.com'?'openai':url.hostname==='api.anthropic.com'?'claude':url.hostname==='generativelanguage.googleapis.com'?'gemini':null;
  assert.ok(p,'Only expected vendors can receive keys');const credential=request.headers.get('authorization')??request.headers.get('x-api-key')??request.headers.get('x-goog-api-key');assert.ok(credential?.includes(keys[p]));
  const body=await request.json();assert.equal(body.tools,undefined,'No search/tool calls in evaluation');
  if(hold){held?.();await gate;}
  const text=JSON.stringify({answer:2050,echo:keys[p]});
  return Response.json(p==='openai'?{output:[{content:[{type:'output_text',text}]}]}:p==='claude'?{content:[{type:'text',text}]}:{steps:[{type:'model_output',content:[{type:'text',text}]}]});
}});
async function call(body,path='/api/quality',user='alice',pin=user,origin='https://trio.test') {return mf.dispatchFetch('https://trio.test'+path,{method:body?'POST':'GET',headers:{'fixture-user':user??'','X-Trio-Account':pin??'',Origin:origin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
const settings={suite:'core',mode:'council',providers:['openai','claude','gemini'],baseline:'claude',maxCalls:60,timeoutSeconds:900};
const start=(id=randomUUID(),overrides={})=>({action:'start',id,live:true,settings:{...settings,...overrides}});
const json=async response=>{assert.equal(response.status,200,await response.clone().text());return response.json();};
try {
  const db=await mf.getD1Database('DB');for(const file of readdirSync(root+'drizzle').filter(x=>x.endsWith('.sql')).sort())for(const sql of readFileSync(root+'drizzle/'+file,'utf8').split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
  for(const p of Object.keys(keys)){
    const response=await mf.dispatchFetch('https://trio.test/api/connections',{method:'PUT',headers:{'fixture-user':'alice','X-Trio-Account':'alice',Origin:'https://trio.test','Content-Type':'application/json'},body:JSON.stringify({provider:p,key:keys[p],model:'model',enabled:true,revision:0})});assert.equal(response.status,200);
  }
  assert.equal((await call(undefined,'/api/quality',null)).status,401);assert.equal((await call(start(),'/api/quality','alice','bob')).status,401);assert.equal((await call(start(),'/api/quality','alice','alice','https://evil.test')).status,403);
  assert.equal((await call({...start(),live:false})).status,400);assert.equal((await call({...start(),keys})).status,400);assert.equal((await call(start(randomUUID(),{maxCalls:501}))).status,400);assert.equal(attempts,0);
  const initial=start(),starts=await Promise.all([call(initial),call(initial)]);const one=await json(starts[0]),two=await json(starts[1]);assert.equal(one.run.id,two.run.id);assert.equal(attempts,0,'Creating a run alone does not call vendors');
  assert.equal((await call(start())).status,409,'Only one active run per account');
  let run=one.run;
  assert.equal((await json(await call(undefined,'/api/quality?id='+run.id))).report.finishedAt,null,'An unfinished report must not invent a finish time');
  const competing=await Promise.all([call({action:'step',id:run.id,step:0}),call({action:'step',id:run.id,step:0})]);await Promise.all(competing.map(json));assert.equal(attempts,3,'Concurrent requests must not duplicate a billed phase');
  run=(await json(await call(undefined,'/api/quality?id='+run.id))).run;assert.equal(run.completedSteps,1);
  await json(await call({action:'step',id:run.id,step:0}));assert.equal(attempts,3,'Replayed cursor cannot spend');
  assert.equal((await call({action:'step',id:run.id,step:1},'/api/quality','bob')).status,404);assert.equal((await call(undefined,'/api/quality?id='+run.id,'bob')).status,404);
  while(run.status==='running')run=(await json(await call({action:'step',id:run.id,step:run.completedSteps}))).run;
  assert.equal(run.status,'complete');assert.equal(run.calls,60);assert.equal(attempts,60);assert.equal(run.completedSteps,12);
  const report=await json(await call(undefined,'/api/quality?id='+run.id));assert.equal(report.report.results.length,6);assert.equal(report.report.summary.degradedPhases,0);assert.equal(report.report.calls,60);
  assert.equal(report.report.finishedAt,new Date(run.finishedAt).toISOString());
  const sheet=await json(await call(undefined,'/api/quality?id='+run.id+'&export=sheet')),key=await json(await call(undefined,'/api/quality?id='+run.id+'&export=key'));
  assert.deepEqual(sheet,await json(await call(undefined,'/api/quality?id='+run.id+'&export=sheet')),'Downloads preserve the same shuffle');assert.equal(sheet.cases[0].answers.length,4);assert.equal(sheet.cases[0].expected,undefined);assert.equal(sheet.cases[0].arms,undefined);assert.equal(key.cases[0].expected,2050);
  for(const secret of [...Object.values(keys),master,'__TRIO_SAVED_KEY__'])for(const data of [report,sheet,key,await json(await call())])assert.ok(!JSON.stringify(data).includes(secret));
  const stored=await db.prepare('SELECT * FROM quality_phases').all();for(const secret of [...Object.values(keys),master])assert.ok(!JSON.stringify(stored).includes(secret),'Persist only redacted data');
  // The cap counts all attempts including a partial team phase and never leaks
  // into subsequent requests, even when many providers dispatch together.
  let limited=(await json(await call(start(randomUUID(),{maxCalls:4})))).run;const before=attempts;
  for(let i=0;i<3;i++)limited=(await json(await call({action:'step',id:limited.id,step:limited.completedSteps}))).run;
  assert.equal(limited.status,'call_limit');assert.equal(limited.calls,4);assert.equal(attempts-before,4);
  const disconnected=(await json(await call(start()))).run,priorDisconnect=attempts;
  const survived=await json(await call({id:disconnected.id,step:0},'/disconnected'));
  assert.equal(survived.run.status,'running');assert.equal(survived.run.completedSteps,1);assert.equal(attempts,priorDisconnect+3,'An accepted phase ignores a disconnected browser signal');
  await json(await call({action:'cancel',id:disconnected.id}));
  // Cancellation fences all subsequent calls while allowing an already-paid
  // response to finish. A second run remains excluded until it settles.
  const cancelRun=(await json(await call(start(randomUUID(),{providers:['openai','claude'],baseline:'openai'})))).run;
  hold=true;gate=new Promise(resolve=>release=resolve);const entered=new Promise(resolve=>held=resolve);const stepping=call({action:'step',id:cancelRun.id,step:0});await entered;
  const cancelled=await json(await call({action:'cancel',id:cancelRun.id}));assert.equal(cancelled.run.status,'cancelled');assert.equal((await call(start())).status,409);
  hold=false;release();
  await stepping;
  // A replacement during a team phase fences later review/synthesis attempts,
  // even though the original keys were already decrypted for that phase.
  let replacing=(await json(await call(start()))).run;
  replacing=(await json(await call({action:'step',id:replacing.id,step:0}))).run;
  const beforeReplacement=attempts;hold=true;gate=new Promise(resolve=>release=resolve);const replacementEntered=new Promise(resolve=>held=resolve);
  const inTeam=call({action:'step',id:replacing.id,step:1});await replacementEntered;
  await db.prepare("UPDATE provider_credentials SET revision=revision+1 WHERE user_id='alice' AND provider='gemini'").run();hold=false;release();
  assert.equal((await json(await inTeam)).run.status,'interrupted');assert.ok(attempts<=beforeReplacement+3,'No review/synthesis requests after credential replacement');
  // Simulate a Worker dying after reservation: never replay it on reload.
  const lost=(await json(await call(start()))).run;await db.prepare("UPDATE quality_runs SET lease='lost',lease_until=?,calls=1 WHERE user_id='alice' AND id=?").bind(Date.now()-1,lost.id).run();const previous=attempts;
  const interrupted=await json(await call({action:'step',id:lost.id,step:0}));assert.equal(interrupted.run.status,'interrupted');assert.equal(attempts,previous);
  const expired=(await json(await call(start()))).run;await db.prepare("UPDATE quality_runs SET deadline=? WHERE user_id='alice' AND id=?").bind(Date.now()-1,expired.id).run();assert.equal((await json(await call({action:'step',id:expired.id,step:0}))).run.status,'timeout');assert.equal(attempts,previous);
  const changed=(await json(await call(start()))).run;await db.prepare("UPDATE provider_credentials SET revision=revision+1 WHERE user_id='alice' AND provider='claude'").run();assert.equal((await json(await call({action:'step',id:changed.id,step:0}))).run.status,'interrupted');assert.equal(attempts,previous,'Changing a pinned credential stops before spending');
  console.log('Worker quality check passed: durable call cap, competing starts/steps, resume, cancellation, timeout/crash fencing, account isolation, redacted private reports and stable separate blind exports; no real network.');
}finally{release?.();await mf.dispose();}
