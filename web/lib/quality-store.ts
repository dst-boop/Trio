import { createHash } from 'node:crypto';
import { evaluateQuality, evaluationReport, redactReport, type CaseReport, type PhaseReport } from '../evaluation/runner.ts';
import type { QualityCase } from '../evaluation/cases.ts';
import { blindReview } from '../evaluation/blind.ts';
import { qualitySettings, suiteCases, qualityEstimate, type QualitySettings } from '../evaluation/hosted-config.ts';
import { freshConnections, providers, type Connections, type ProviderId } from './trio.ts';
import { readSavedConnections, resolveCredential } from './credential-store.ts';
import { savedKeyReference } from './saved-connections.ts';

export class QualityError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
type Config = QualitySettings & {cases:QualityCase[];engineVersion:1;models: Partial<Record<ProviderId,string>>; revisions: Partial<Record<ProviderId,number>>};
type Run = {user_id:string;id:string;status:string;config:string;started_at:number;deadline:number;finished_at:number|null;cursor:number;calls:number;lease:string|null;lease_until:number|null;blind_seed:string};
const phaseLimitMs = 120_000;
const configOf = (run: Run): Config => JSON.parse(run.config);
const read = (db:D1Database,user:string,id:string) => db.prepare('SELECT * FROM quality_runs WHERE user_id = ? AND id = ?').bind(user,id).first<Run>();
const terminal = async (db:D1Database,user:string) => {
  // Never replay an uncertain billed phase. A lost Worker becomes an explicitly
  // interrupted partial report. Expiry exceeds the phase's abort deadline.
  await db.batch([
    db.prepare("UPDATE quality_runs SET status = CASE WHEN status = 'running' THEN 'interrupted' ELSE status END, finished_at = COALESCE(finished_at, ?), lease = NULL, lease_until = NULL WHERE user_id = ? AND lease IS NOT NULL AND lease_until < ?").bind(Date.now(),user,Date.now()),
    db.prepare("UPDATE quality_runs SET status = 'timeout', finished_at = ? WHERE user_id = ? AND status = 'running' AND lease IS NULL AND deadline <= ?").bind(Date.now(),user,Date.now()),
  ]);
};
const publicRun = (run:Run) => {
  const config=configOf(run);
  return {id:run.id,status:run.status,settings:qualitySettings.parse({suite:config.suite,mode:config.mode,baseline:config.baseline,providers:config.providers,maxCalls:config.maxCalls,timeoutSeconds:config.timeoutSeconds}),models:config.models,startedAt:run.started_at,deadline:run.deadline,finishedAt:run.finished_at,completedSteps:run.cursor,totalSteps:config.cases.length*2,calls:run.calls,inFlight:Boolean(run.lease),...qualityEstimate(config,config.models)};
};
export type QualityRun = ReturnType<typeof publicRun>;
export async function listQualityRuns(db:D1Database,user:string) {
  await terminal(db,user);
  const runs=await db.prepare('SELECT * FROM quality_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 30').bind(user).all<Run>();
  return runs.results.map(publicRun);
}
async function resolveConnections(db:D1Database,master:string|undefined,request:Request,user:string,config:Config) {
  const connections=freshConnections();
  for(const p of providers) {
    connections[p.id]={key:'',model:config.models[p.id] ?? p.model,enabled:config.providers.includes(p.id)};
    if(!connections[p.id].enabled)continue;
    // The revision and ciphertext are checked from the same row read.
    connections[p.id].key=await resolveCredential(db,master,request,user,p.id,savedKeyReference,config.revisions[p.id]);
  }
  return connections;
}
export async function startQualityRun(db:D1Database,master:string|undefined,request:Request,user:string,id:string,settings:QualitySettings) {
  await terminal(db,user);
  const existing=await read(db,user,id);
  if(existing)return publicRun(existing);
  const saved=(await readSavedConnections(db,user)).connections;
  const selected=settings.providers.map(p=>saved.find(c=>c.provider===p)!);
  if(selected.some(c=>!c.saved||!c.enabled))throw new QualityError('Save and enable at least two selected providers in Connections before starting.');
  const config:Config={...settings,cases:suiteCases(settings.suite),engineVersion:1,models:Object.fromEntries(selected.map(c=>[c.provider,c.model])),revisions:Object.fromEntries(selected.map(c=>[c.provider,c.revision]))};
  const connections=await resolveConnections(db,master,request,user,config);
  // User-controlled model names must also pass through the shared redactor.
  if(JSON.stringify(redactReport(config,connections))!==JSON.stringify(config))throw new QualityError('Check your saved model IDs before starting.');
  const now=Date.now();
  await db.prepare("INSERT INTO quality_runs (user_id,id,status,config,started_at,deadline,blind_seed) VALUES (?,?,'running',?,?,?,?) ON CONFLICT DO NOTHING").bind(user,id,JSON.stringify(config),now,now+settings.timeoutSeconds*1000,crypto.randomUUID()).run();
  const run=await read(db,user,id);
  if(!run)throw new QualityError('Another quality check is already active. Reload to resume or cancel it.');
  return publicRun(run);
}
export async function cancelQualityRun(db:D1Database,user:string,id:string) {
  await db.prepare("UPDATE quality_runs SET status = 'cancelled', finished_at = ? WHERE user_id = ? AND id = ? AND status = 'running'").bind(Date.now(),user,id).run();
  const run=await read(db,user,id);
  if(!run)throw new QualityError('Quality check not found.',404);
  return publicRun(run);
}
export async function stepQualityRun(db:D1Database,master:string|undefined,request:Request,user:string,id:string,step:number,fetcher:typeof fetch=fetch) {
  await terminal(db,user);
  const run=await read(db,user,id);
  if(!run)throw new QualityError('Quality check not found.',404);
  if(run.status!=='running'||run.cursor!==step||run.lease)return publicRun(run);
  const config=configOf(run);
  if(config.engineVersion!==1)throw new QualityError('This saved run uses an older evaluator. Cancel it before starting a new check.');
  const token=crypto.randomUUID(),start=Date.now();
  const claimed=await db.prepare("UPDATE quality_runs SET lease = ?, lease_until = ? WHERE user_id = ? AND id = ? AND status = 'running' AND cursor = ? AND lease IS NULL AND deadline > ?").bind(token,start+phaseLimitMs+30_000,user,id,step,start).run();
  if(!claimed.meta.changes)return publicRun((await read(db,user,id))!);
  let outcome='running';
  try {
    const connections=await resolveConnections(db,master,request,user,config);
    const stop=new AbortController();
    // A claimed, potentially billed phase owns its deadline. Closing a browser
    // connection must not itself abort the provider calls. The route extends
    // Worker lifetime with waitUntil; a platform kill still expires the lease.
    const signal=AbortSignal.any([stop.signal,AbortSignal.timeout(Math.max(1,Math.min(phaseLimitMs,run.deadline-Date.now())))]);
    // Every actual HTTP attempt is durably reserved before dispatch. A crash
    // between reservation and dispatch may overcount; it can never undercount.
    const guarded:typeof fetch=async(url,init)=>{
      signal.throwIfAborted();
      const pins=config.providers.map(()=> 'AND EXISTS (SELECT 1 FROM provider_credentials WHERE user_id = ? AND provider = ? AND revision = ? AND enabled = 1 AND cipher IS NOT NULL)').join(' ');
      const reservation=await db.prepare("UPDATE quality_runs SET calls = calls + 1 WHERE user_id = ? AND id = ? AND lease = ? AND status = 'running' AND calls < ? AND deadline > ? AND lease_until > ? "+pins).bind(user,id,token,config.maxCalls,Date.now(),Date.now(),...config.providers.flatMap(p=>[user,p,config.revisions[p]!])).run();
      if(!reservation.meta.changes){stop.abort();throw new Error('Quality check stopped.');}
      signal.throwIfAborted();
      return fetcher(url,{...init,signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});
    };
    const phase=step%2?'team':'baseline';
    const report=await evaluateQuality(connections,{...config,cases:[config.cases[Math.floor(step/2)]],phases:[phase],includeAnswers:true,maxCalls:Math.max(1,config.maxCalls-run.calls),timeoutSeconds:Math.max(1,Math.ceil((run.deadline-Date.now())/1000))},signal,guarded);
    const latest=(await read(db,user,id))!;
    const completed=step+1>=config.cases.length*2;
    outcome=latest.status!=='running'?latest.status:Date.now()>=run.deadline?'timeout':report.status==='call_limit'?'call_limit':signal.aborted?'interrupted':completed?'complete':latest.calls>=config.maxCalls?'call_limit':'running';
    const row=redactReport(report.results[0],connections);
    (phase==='baseline'?row.baselineRun:row.teamRun).httpCalls=latest.calls-run.calls;
    // Commit only while owning the original lease. Cancellation may set the
    // status, but can still retain already-paid results without scheduling more.
    await db.batch([
      db.prepare('INSERT INTO quality_phases (user_id,run_id,step,report) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM quality_runs WHERE user_id = ? AND id = ? AND lease = ?) ON CONFLICT DO NOTHING').bind(user,id,step,JSON.stringify(row),user,id,token),
      db.prepare("UPDATE quality_runs SET cursor = cursor + 1, status = CASE WHEN status = 'cancelled' THEN status ELSE ? END, finished_at = CASE WHEN status = 'cancelled' THEN finished_at WHEN ? = 'running' THEN NULL ELSE ? END, lease = NULL, lease_until = NULL WHERE user_id = ? AND id = ? AND lease = ?").bind(outcome,outcome,Date.now(),user,id,token),
    ]);
  } catch {
    // Never return raw provider/crypto/storage diagnostics or retry the phase.
    await db.prepare("UPDATE quality_runs SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'interrupted' END, finished_at = COALESCE(finished_at, ?), lease = NULL, lease_until = NULL WHERE user_id = ? AND id = ? AND lease = ?").bind(Date.now(),user,id,token).run();
  }
  return publicRun((await read(db,user,id))!);
}

export async function qualityReport(db:D1Database,user:string,id:string) {
  await terminal(db,user);
  const run=await read(db,user,id);
  if(!run)throw new QualityError('Quality check not found.',404);
  const config=configOf(run),connections=freshConnections();
  for(const p of providers)connections[p.id]={enabled:config.providers.includes(p.id),key:'',model:config.models[p.id]??p.model};
  const empty=():PhaseReport=>({state:'not_run',degraded:false,httpCalls:0,elapsedMs:null,providerElapsedMs:{},notes:[]});
  const rows:CaseReport[]=config.cases.map(item=>({...item,baseline:Object.fromEntries(config.providers.map(p=>[p,{status:'not_run'}])),team:{status:'not_run'},baselineRun:empty(),teamRun:empty(),answers:{baseline:{}}}));
  const phases=await db.prepare('SELECT step,report FROM quality_phases WHERE user_id = ? AND run_id = ? ORDER BY step').bind(user,id).all<{step:number;report:string}>();
  for(const entry of phases.results) {
    const phase:CaseReport=JSON.parse(entry.report),row=rows[Math.floor(entry.step/2)];
    if(entry.step%2){row.team=phase.team;row.teamRun=phase.teamRun;row.answers!.team=phase.answers?.team;}
    else{row.baseline=phase.baseline;row.baselineRun=phase.baselineRun;row.answers!.baseline=phase.answers?.baseline??{};}
  }
  const report=evaluationReport(connections,config,rows,{status:run.status,calls:run.calls,startedAt:new Date(run.started_at).toISOString(),finishedAt:run.finished_at?new Date(run.finished_at).toISOString():null});
  return {run:publicRun(run),report:{...report,callAccounting:'Calls are durable HTTP-attempt reservations. An interrupted dispatch may reserve an attempt without sending it. Failed or interrupted calls can still be billed; provider invoices remain authoritative.'}};
}
export async function qualityBlindExport(db:D1Database,user:string,id:string,part:'sheet'|'key') {
  const {run,report}=await qualityReport(db,user,id);
  if(run.status==='running'||run.inFlight)throw new QualityError('Finish or cancel the run before exporting a stable grading sheet.');
  const stored=(await read(db,user,id))!;
  let counter=0;
  const index=(max:number)=>createHash('sha256').update(stored.blind_seed+':'+counter++).digest().readUInt32BE(0)%max;
  try { const blind=blindReview(report,index);return part==='sheet'?blind.review:blind.key; }
  catch {throw new QualityError('At least two completed answers for one case are needed for a grading sheet.');}
}
