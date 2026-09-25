import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url),wrangler=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare}=wrangler('miniflare'),{build}=wrangler('esbuild');
const root=fileURLToPath(new URL('../',import.meta.url)),master=Buffer.alloc(32,9).toString('base64');
const bundle=await build({absWorkingDir:root,bundle:true,write:false,platform:'node',format:'esm',target:'es2022',external:['cloudflare:workers','node:crypto'],logLevel:'silent',plugins:[{name:'fixture-identity',setup(b){b.onResolve({filter:/chatgpt-auth$/},()=>({path:'identity',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export async function getChatGPTUser(){return globalThis.fixtureIdentity}',loader:'js'}));}}],stdin:{resolveDir:root,loader:'ts',contents:`
import * as comparison from './app/api/work-comparison/route.ts';
import * as connections from './app/api/connections/route.ts';
import {stepComparison} from './lib/work-comparison-store.ts';
export default {async fetch(request,env){const user=request.headers.get('fixture-user');globalThis.fixtureIdentity=user?{userId:user,email:user+'@test.invalid'}:null;
if(new URL(request.url).pathname==='/disconnected'){const body=await request.json(),stop=new AbortController();stop.abort();const accepted=new Request(request.url,{headers:request.headers,signal:stop.signal});return Response.json({run:await stepComparison(env.DB,env.TRIO_CREDENTIAL_KEY,accepted,user,body.id,body.step)});}
const routes=new URL(request.url).pathname==='/api/connections'?connections:comparison;return routes[request.method](request);}};
`}});
const keys={openai:'fixture-comparison-openai-secret',claude:'fixture-comparison-claude-secret',gemini:'fixture-comparison-gemini-secret'};
const models={openai:'gpt-6-astra',claude:'claude-sonnet-5',gemini:'gemini-3.8-flash'};
let attempts=0,hold=false,held,release,gate=Promise.resolve(),responses='normal',baselineOnly=false,forbidSingleMarker=false,requests=[];
const singleMarker='independent-marker-not-to-forward';
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{TRIO_CREDENTIAL_KEY:master},async outboundService(request){
  attempts++;const url=new URL(request.url),p=url.hostname==='api.openai.com'?'openai':url.hostname==='api.anthropic.com'?'claude':url.hostname==='generativelanguage.googleapis.com'?'gemini':null;
  assert.ok(p,'Only expected providers receive a key');assert.ok((request.headers.get('authorization')??request.headers.get('x-api-key')??request.headers.get('x-goog-api-key'))?.includes(keys[p]));
  const body=await request.json();requests.push({p,body});assert.equal(body.tools,undefined);if(baselineOnly)assert.equal(p,'openai');
  if(forbidSingleMarker)assert.ok(!JSON.stringify(body).includes(singleMarker),'Council must not see the independently sampled baseline answer');
  if(hold){held?.();await gate;}
  if(responses==='fail'||responses==='degraded'&&p==='gemini')return new Response('private upstream diagnostic '+keys[p],{status:429});
  if(responses==='retry'&&body.stream)return new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n',{headers:{'Content-Type':'text/event-stream'}});
  const text=(baselineOnly?singleMarker:'A completed deliverable')+' ChatGPT gpt-6-astra '+keys[p]+(responses==='echo-unselected'?' '+keys.gemini:'');
  const usage=responses==='unknown'?undefined:p==='gemini'?{total_input_tokens:100,total_output_tokens:30}:{input_tokens:100,output_tokens:30};
  return Response.json(p==='openai'?{output:[{content:[{type:'output_text',text}]}],usage}:p==='claude'?{content:[{type:'text',text}],stop_reason:'end_turn',usage}:{steps:[{type:'model_output',content:[{type:'text',text}]}],usage});
}});
async function call(body,path='/api/work-comparison',user='alice',pin=user,origin='https://trio.test') {return mf.dispatchFetch('https://trio.test'+path,{method:body?'POST':'GET',headers:{'fixture-user':user??'','X-Trio-Account':pin??'',Origin:origin,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
const task={title:'A fictional work task',source:'sample',question:'Draft a concise follow-up email and checklist.',context:'Send the draft Tuesday; receive approval Thursday. Approver unknown.',criteria:'Preserve both deadlines. Ask for the approver. Invent no commitments.'};
const settings={providers:['openai','claude','gemini'],baseline:'openai',maxCalls:12,timeoutSeconds:600,timeZone:'America/New_York'};
const start=(id=randomUUID(),overrides={})=>({action:'start',id,live:true,task,settings:{...settings,...overrides}});
const grades={A:{useful:2,grounded:1,clear:2},B:{useful:1,grounded:2,clear:1},preference:'A',notes:'The chosen draft preserves both commitments.'};
const json=async response=>{assert.equal(response.status,200,await response.clone().text());assert.match(response.headers.get('cache-control'),/private, no-store/);return response.json();};
const step=async run=>(await json(await call({action:'step',id:run.id,step:run.completedSteps}))).run;
const complete=async(overrides={})=>{let run=(await json(await call(start(randomUUID(),overrides)))).run;while(run.status==='running')run=await step(run);return run;};
const report=async run=>json(await call(undefined,'/api/work-comparison?id='+run.id));
const cancel=async run=>json(await call({action:'cancel',id:run.id}));
function noSecrets(data){for(const secret of [...Object.values(keys),master,'__TRIO_SAVED_KEY__'])assert.ok(!JSON.stringify(data).includes(secret),'No credentials in stored or returned data');}
try {
  const db=await mf.getD1Database('DB');for(const file of readdirSync(root+'drizzle').filter(x=>x.endsWith('.sql')).sort())for(const sql of readFileSync(root+'drizzle/'+file,'utf8').split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
  for(const p of Object.keys(keys))assert.equal((await mf.dispatchFetch('https://trio.test/api/connections',{method:'PUT',headers:{'fixture-user':'alice','X-Trio-Account':'alice',Origin:'https://trio.test','Content-Type':'application/json'},body:JSON.stringify({provider:p,key:keys[p],model:models[p],enabled:true,revision:0})})).status,200);
  assert.equal((await call(undefined,'/api/work-comparison',null)).status,401);
  assert.equal((await call(start(),'/api/work-comparison','alice','bob')).status,401);
  assert.equal((await call(start(),'/api/work-comparison','alice','alice','https://evil.test')).status,403);
  for(const invalid of [{...start(),live:false},{...start(),keys},{...start(),task:{...task,criteria:''}},start(randomUUID(),{maxCalls:31}),start(randomUUID(),{providers:['claude','gemini']})])assert.equal((await call(invalid)).status,400);
  assert.equal((await call({...start(),task:{...task,context:keys.claude}})).status,409,'Do not save a task containing a configured key');assert.equal(attempts,0);
  assert.equal((await call({...start(randomUUID(),{providers:['openai','claude']}),task:{...task,context:keys.gemini}})).status,409,'Unselected saved credentials cannot become task data or cross providers');assert.equal(attempts,0);
  await db.prepare("UPDATE provider_credentials SET enabled=0 WHERE user_id='alice' AND provider='gemini'").run();
  assert.equal((await call({...start(randomUUID(),{providers:['openai','claude']}),task:{...task,criteria:keys.gemini}})).status,409,'Disabled saved keys are also covered by redaction');
  await db.prepare("UPDATE provider_credentials SET enabled=1 WHERE user_id='alice' AND provider='gemini'").run();
  const initial=start(),pair=await Promise.all([call(initial),call(initial)]);let run=(await json(pair[0])).run;assert.equal((await json(pair[1])).run.id,run.id);
  assert.equal((await call(start())).status,409,'One active run per account');assert.equal(attempts,0);
  assert.equal((await call({action:'rate',id:run.id,ratings:grades})).status,409);
  assert.equal((await call({action:'delete',id:run.id})).status,409);
  const frozenClock='2026-09-24T23:59:59.000Z';
  await db.prepare("UPDATE work_comparison_runs SET started_at=? WHERE user_id='alice' AND id=?").bind(Date.parse(frozenClock),run.id).run();
  baselineOnly=true;
  await Promise.all([call({action:'step',id:run.id,step:0}),call({action:'step',id:run.id,step:0})]);
  assert.equal(attempts,1,'Concurrent steps cannot duplicate the baseline call');
  const halfway=await report(run);run=halfway.run;assert.equal(run.completedSteps,1);assert.equal(halfway.view,'incomplete');assert.deepEqual(halfway.phases,[]);assert.ok(!JSON.stringify(halfway).includes(singleMarker),'Do not expose a completed arm before both are ready');
  await json(await call({action:'step',id:run.id,step:0}));assert.equal(attempts,1);
  assert.equal((await call({action:'step',id:run.id,step:1},'/api/work-comparison','bob')).status,404);
  assert.equal((await call(undefined,'/api/work-comparison?id='+run.id,'bob')).status,404);
  baselineOnly=false;forbidSingleMarker=true;run=await step(run);forbidSingleMarker=false;
  assert.equal(run.status,'complete');assert.equal(run.calls,8);assert.equal(attempts,8);
  const allInputs=requests.map(r=>JSON.parse(r.body.input??r.body.messages[0].content));
  assert.equal(allInputs.filter(input=>!input.task).length,4,'One independent baseline and three fresh team drafts');
  for(const entry of allInputs){const input=entry.task??entry;assert.equal(input.question,task.question);assert.equal(input.reference_text,task.context);assert.equal(input.session_instructions,task.criteria);assert.deepEqual(input.conversation,[]);assert.equal(input.personal_memory,'');assert.deepEqual(input.current_time,{utc:frozenClock,time_zone:'America/New_York',local_date:'2026-09-24'},'Both arms use the run-start clock even when the execution date changes');}
  assert.equal(requests.at(-1).p,'openai','The chosen baseline is also the synthesis writer');
  const blind=await report(run);assert.equal(blind.view,'blind');assert.equal(blind.ready,true);assert.equal(blind.degraded,false);assert.equal(blind.answers.length,2);
  for(const answer of blind.answers){assert.deepEqual(Object.keys(answer).sort(),['label','text']);assert.ok(!answer.text.includes('gpt-6-astra'));assert.ok(!answer.text.includes('ChatGPT'));}
  assert.deepEqual(blind,await report(run),'Reload keeps the same mapping');assert.deepEqual(blind,await json(await call(undefined,'/api/work-comparison?id='+run.id+'&export=key')),'Query parameters cannot bypass reveal');
  noSecrets(blind);noSecrets(await db.prepare('SELECT * FROM work_comparison_phases').all());
  assert.equal((await call({action:'rate',id:run.id,ratings:{...grades,A:{useful:2}}})).status,400);
  assert.equal((await call({action:'rate',id:run.id,ratings:grades},'/api/work-comparison','bob')).status,404);
  assert.equal((await call({action:'rate',id:run.id,ratings:{...grades,notes:keys.openai}})).status,409);
  const opposite={...grades,preference:'B',notes:'Competing tab'};
  const receipts=await Promise.all([call({action:'rate',id:run.id,ratings:grades}),call({action:'rate',id:run.id,ratings:opposite})]);
  const revealed=await json(receipts[0]),other=await json(receipts[1]);assert.equal(revealed.view,'revealed');assert.deepEqual(revealed.ratings,other.ratings,'Competing first ratings return the same immutable receipt');
  assert.equal(revealed.run.ratedAt,other.run.ratedAt);assert.ok(revealed.run.ratedAt);assert.equal(revealed.answers.find(a=>a.arm==='single').httpCalls,1);assert.equal(revealed.answers.find(a=>a.arm==='council').httpCalls,7);
  assert.ok(revealed.answers.every(a=>a.usage.costUSD>0));assert.ok(revealed.answers.every(a=>a.answer.includes('ChatGPT')),'Reveal includes original text, not masked presentation');
  for(const answer of blind.answers)assert.equal(revealed.answers.find(a=>a.label===answer.label).answer.includes(singleMarker),answer.text.includes(singleMarker));
  assert.deepEqual((await json(await call({action:'rate',id:run.id,ratings:opposite}))).ratings,revealed.ratings,'Retry cannot revise ratings after reveal');noSecrets(revealed);
  const before=attempts;let limited=await complete({maxCalls:3});assert.equal(limited.status,'call_limit');assert.equal(limited.calls,3);assert.ok(attempts-before<=3&&attempts-before>=1,'An aborted dispatch may reserve without sending; it can never exceed the cap');assert.equal((await report(limited)).view,'incomplete');assert.equal((await call({action:'rate',id:limited.id,ratings:grades})).status,409);
  responses='unknown';const unknown=await complete();assert.equal((await json(await call({action:'rate',id:unknown.id,ratings:grades}))).answers[0].usage.costUSD,null);responses='normal';
  responses='degraded';const degraded=await complete();assert.equal((await report(degraded)).degraded,true);assert.equal((await report(degraded)).view,'blind');const degradedReveal=await json(await call({action:'rate',id:degraded.id,ratings:grades}));assert.ok(degradedReveal.answers.some(a=>a.degraded));noSecrets(degradedReveal);responses='normal';
  responses='fail';const failed=await complete();assert.equal(failed.status,'interrupted');assert.equal((await report(failed)).view,'incomplete');noSecrets(await report(failed));responses='normal';
  responses='retry';const retryBefore=attempts;const retried=await complete({providers:['openai','claude'],maxCalls:2});assert.equal(retried.calls,2);assert.equal(attempts-retryBefore,2);assert.equal(retried.status,'call_limit');responses='normal';
  let disconnected=(await json(await call(start()))).run;const disconnectedResponse=await call({id:disconnected.id,step:0},'/disconnected');assert.equal(disconnectedResponse.status,200);disconnected=(await disconnectedResponse.json()).run;assert.equal(disconnected.completedSteps,1,'A browser disconnect does not cancel accepted work');await cancel(disconnected);
  let cancelRun=(await json(await call(start()))).run;hold=true;gate=new Promise(resolve=>release=resolve);const entered=new Promise(resolve=>held=resolve);const pending=step(cancelRun);await entered;
  assert.equal((await cancel(cancelRun)).run.status,'cancelled');assert.equal((await call(start())).status,409);assert.equal((await call({action:'delete',id:cancelRun.id})).status,409);hold=false;release();cancelRun=await pending;assert.equal(cancelRun.status,'cancelled');assert.equal(cancelRun.calls,1);assert.equal((await report(cancelRun)).ready,false);
  let changed=(await json(await call(start()))).run;changed=await step(changed);const changeBefore=attempts;hold=true;gate=new Promise(resolve=>release=resolve);const changeEntered=new Promise(resolve=>held=resolve);const changing=step(changed);await changeEntered;await db.prepare("UPDATE provider_credentials SET revision=revision+1 WHERE user_id='alice' AND provider='gemini'").run();hold=false;release();assert.equal((await changing).status,'interrupted');assert.ok(attempts<=changeBefore+3,'A credential replacement fences every later attempt');
  const lost=(await json(await call(start()))).run;await db.prepare("UPDATE work_comparison_runs SET lease='lost',lease_until=?,calls=1 WHERE user_id='alice' AND id=?").bind(Date.now()-1,lost.id).run();const lostBefore=attempts;assert.equal((await step(lost)).status,'interrupted');assert.equal(attempts,lostBefore,'Lost phases are not replayed');
  const expired=(await json(await call(start()))).run;await db.prepare("UPDATE work_comparison_runs SET deadline=? WHERE user_id='alice' AND id=?").bind(Date.now()-1,expired.id).run();assert.equal((await step(expired)).status,'timeout');assert.equal(attempts,lostBefore);
  const pinned=(await json(await call(start()))).run;await db.prepare("UPDATE provider_credentials SET revision=revision+1 WHERE user_id='alice' AND provider='claude'").run();assert.equal((await step(pinned)).status,'interrupted');assert.equal(attempts,lostBefore);
  assert.match((await report(pinned)).phases[0].notes.join(' '),/Claude.*Reload Connections/,'A changed-key preparation failure retains an actionable provider-specific diagnostic');
  // A damaged, unselected saved key must fail closed for redaction, but the
  // already-paid output and a safe repair hint survive for the account owner.
  let damaged=(await json(await call(start(randomUUID(),{providers:['openai','claude']})))).run;damaged=await step(damaged);
  const originalRow=await db.prepare("SELECT cipher,iv FROM provider_credentials WHERE user_id='alice' AND provider='gemini'").first();
  await db.prepare("UPDATE provider_credentials SET cipher='invalid-fixture-ciphertext' WHERE user_id='alice' AND provider='gemini'").run();
  const damagedBefore=attempts;damaged=await step(damaged);assert.equal(attempts,damagedBefore);assert.equal(damaged.status,'interrupted');
  const damagedReport=await report(damaged);assert.equal(damagedReport.phases[0].state,'complete');assert.equal(damagedReport.phases[1].state,'failed');assert.match(damagedReport.phases[1].notes.join(' '),/Gemini.*Reload Connections/);assert.ok(!JSON.stringify(damagedReport).includes('invalid-fixture-ciphertext'));noSecrets(damagedReport);
  await db.prepare("UPDATE provider_credentials SET cipher=?,iv=? WHERE user_id='alice' AND provider='gemini'").bind(originalRow.cipher,originalRow.iv).run();
  // Fixed seeds exercise both label assignments deterministically. A constant
  // single=A implementation must fail without relying on random test luck.
  const assignments=[];
  responses='echo-unselected';
  for(const seed of ['seed-0','seed-2']) {
    const shuffled=await complete({providers:['openai','claude']});
    await db.prepare("UPDATE work_comparison_runs SET blind_seed=? WHERE user_id='alice' AND id=?").bind(seed,shuffled.id).run();
    const sheet=await report(shuffled);assert.equal(sheet.view,'blind');noSecrets(sheet);
    const receipt=await json(await call({action:'rate',id:shuffled.id,ratings:grades}));
    assignments.push(receipt.answers.find(a=>a.label==='A').arm);noSecrets(receipt);
    assert.equal(receipt.run.calls,6,'Two-provider comparisons make six nominal calls');
  }
  assert.deepEqual(assignments,['single','council']);responses='normal';
  const revision=(await db.prepare("SELECT revision FROM provider_credentials WHERE user_id='alice' AND provider='gemini'").first()).revision;
  assert.equal((await mf.dispatchFetch('https://trio.test/api/connections',{method:'PUT',headers:{'fixture-user':'alice','X-Trio-Account':'alice',Origin:'https://trio.test','Content-Type':'application/json'},body:JSON.stringify({provider:'gemini',key:'x',model:models.gemini,enabled:false,revision})})).status,200);
  const placeholder=await call({...start(randomUUID(),{providers:['openai','claude']}),task:{...task,context:'Example notes'}});assert.equal(placeholder.status,409);assert.match((await placeholder.json()).error,/Gemini.*placeholder key/,'The error identifies a disabled placeholder connection without echoing its value');
  assert.equal((await mf.dispatchFetch('https://trio.test/api/connections',{method:'PUT',headers:{'fixture-user':'alice','X-Trio-Account':'alice',Origin:'https://trio.test','Content-Type':'application/json'},body:JSON.stringify({provider:'gemini',key:keys.gemini,model:models.gemini,enabled:true,revision:revision+1})})).status,200);
  // Viewing/rating saved results never calls a provider, including after keys
  // are disabled or deleted. Ratings do not require the run's pinned revision.
  const disabled=await complete();await db.prepare("UPDATE provider_credentials SET enabled=0,revision=revision+1 WHERE user_id='alice'").run();const disabledBefore=attempts;assert.equal((await json(await call({action:'rate',id:disabled.id,ratings:grades}))).view,'revealed');assert.equal(attempts,disabledBefore);
  await db.prepare("UPDATE provider_credentials SET cipher=NULL,iv=NULL,revision=revision+1 WHERE user_id='alice'").run();assert.equal((await report(disabled)).view,'revealed');
  assert.equal((await call({action:'delete',id:run.id},'/api/work-comparison','bob')).status,404);
  await json(await call({action:'delete',id:run.id}));assert.equal((await call(undefined,'/api/work-comparison?id='+run.id)).status,404);assert.equal((await db.prepare('SELECT count(*) AS n FROM work_comparison_phases WHERE run_id=?').bind(run.id).first()).n,0);
  noSecrets(await json(await call()));noSecrets(await db.prepare('SELECT * FROM work_comparison_runs').all());noSecrets(await db.prepare('SELECT * FROM work_comparison_phases').all());
  console.log('Worker work comparison passed: independent task arms, same final writer, server-held blind mapping, atomic immutable ratings, account isolation, call caps/retries, credential fencing, cancellation/crash/deadline handling, redacted private results and deletion; no real network.');
}finally{release?.();await mf.dispose();}
