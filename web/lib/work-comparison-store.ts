import { createHash } from 'node:crypto';
import { orchestrate } from './orchestrate.ts';
import { redactReport } from '../evaluation/runner.ts';
import { freshConnections, providers, type ProviderId, type Usage } from './trio.ts';
import { readSavedConnections, resolveCredential } from './credential-store.ts';
import { savedKeyReference } from './saved-connections.ts';
import { blindComparisonText, comparisonAccounting, comparisonLimitations, comparisonSettings, type ComparisonTask, type ComparisonSettings, type ComparisonRatings, type ComparisonPhase, type AnswerLabel } from './work-comparison.ts';

export class ComparisonError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
type Config = {engineVersion:1;task:ComparisonTask;settings:ComparisonSettings;models:Partial<Record<ProviderId,string>>;revisions:Partial<Record<ProviderId,number>>};
type StoredRun = {user_id:string;id:string;status:string;config:string;started_at:number;deadline:number;finished_at:number|null;cursor:number;calls:number;lease:string|null;lease_until:number|null;blind_seed:string;ratings:string|null;rated_at:number|null};
const phaseLimitMs = 120_000;
const configOf = (run:StoredRun):Config => JSON.parse(run.config);
const read = (db:D1Database,user:string,id:string) => db.prepare('SELECT * FROM work_comparison_runs WHERE user_id = ? AND id = ?').bind(user,id).first<StoredRun>();
async function expire(db:D1Database,user:string) {
  const now=Date.now();
  await db.batch([
    db.prepare("UPDATE work_comparison_runs SET status = CASE WHEN status = 'running' THEN 'interrupted' ELSE status END, finished_at = COALESCE(finished_at, ?), lease = NULL, lease_until = NULL WHERE user_id = ? AND lease IS NOT NULL AND lease_until <= ?").bind(now,user,now),
    db.prepare("UPDATE work_comparison_runs SET status = 'timeout', finished_at = ? WHERE user_id = ? AND status = 'running' AND lease IS NULL AND deadline <= ?").bind(now,user,now),
  ]);
}
function publicRun(run:StoredRun) {
  const config=configOf(run);
  return {id:run.id,title:config.task.title,source:config.task.source,status:run.status,settings:comparisonSettings.parse(config.settings),models:config.models,startedAt:run.started_at,deadline:run.deadline,finishedAt:run.finished_at,completedSteps:run.cursor,totalSteps:2,calls:run.calls,inFlight:Boolean(run.lease),ratedAt:run.rated_at};
}
export type ComparisonRun = ReturnType<typeof publicRun>;
async function required(db:D1Database,user:string,id:string) {
  const run=await read(db,user,id);
  if(!run)throw new ComparisonError('Comparison not found.',404);
  return run;
}
async function resolveConnections(db:D1Database,master:string|undefined,request:Request,user:string,config:Config) {
  const connections=freshConnections();
  const saved=(await readSavedConnections(db,user)).connections;
  for(const p of providers) {
    connections[p.id]={key:'',model:config.models[p.id]??p.model,enabled:config.settings.providers.includes(p.id)};
    if(connections[p.id].enabled)connections[p.id].key=await resolveCredential(db,master,request,user,p.id,savedKeyReference,config.revisions[p.id]);
    else if(saved.some(c=>c.provider===p.id&&c.saved))connections[p.id].key=await resolveCredential(db,master,request,user,p.id,savedKeyReference);
  }
  return connections;
}
export async function listComparisons(db:D1Database,user:string) {
  await expire(db,user);
  const rows=await db.prepare('SELECT * FROM work_comparison_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 50').bind(user).all<StoredRun>();
  return rows.results.map(publicRun);
}
export async function startComparison(db:D1Database,master:string|undefined,request:Request,user:string,id:string,task:ComparisonTask,settings:ComparisonSettings) {
  await expire(db,user);
  const existing=await read(db,user,id);
  if(existing)return publicRun(existing);
  const saved=(await readSavedConnections(db,user)).connections;
  const selected=settings.providers.map(p=>saved.find(c=>c.provider===p)!);
  if(selected.some(c=>!c?.saved||!c.enabled))throw new ComparisonError('Save and enable each selected provider in Connections first.');
  const config:Config={engineVersion:1,task,settings,models:Object.fromEntries(selected.map(c=>[c.provider,c.model])),revisions:Object.fromEntries(selected.map(c=>[c.provider,c.revision]))};
  const connections=await resolveConnections(db,master,request,user,config);
  if(JSON.stringify(redactReport(config,connections))!==JSON.stringify(config))throw new ComparisonError('Remove credential text from the task and check your saved model IDs.');
  const now=Date.now();
  await db.prepare("INSERT INTO work_comparison_runs (user_id,id,status,config,started_at,deadline,blind_seed) VALUES (?,?,'running',?,?,?,?) ON CONFLICT DO NOTHING").bind(user,id,JSON.stringify(config),now,now+settings.timeoutSeconds*1000,crypto.randomUUID()).run();
  const run=await read(db,user,id);
  if(!run)throw new ComparisonError('Another comparison is active. Reload to continue or cancel it.');
  return publicRun(run);
}
export async function cancelComparison(db:D1Database,user:string,id:string) {
  await db.prepare("UPDATE work_comparison_runs SET status = 'cancelled', finished_at = ? WHERE user_id = ? AND id = ? AND status = 'running'").bind(Date.now(),user,id).run();
  return publicRun(await required(db,user,id));
}
export async function stepComparison(db:D1Database,master:string|undefined,request:Request,user:string,id:string,step:number,fetcher:typeof fetch=fetch) {
  await expire(db,user);
  const run=await required(db,user,id);
  if(run.status!=='running'||run.cursor!==step||run.lease)return publicRun(run);
  const config=configOf(run),settings=config.settings;
  if(config.engineVersion!==1)throw new ComparisonError('This saved comparison uses an older engine. Cancel it before starting another.');
  const token=crypto.randomUUID(),started=Date.now();
  const claim=await db.prepare("UPDATE work_comparison_runs SET lease = ?, lease_until = ? WHERE user_id = ? AND id = ? AND status = 'running' AND cursor = ? AND lease IS NULL AND deadline > ?").bind(token,started+phaseLimitMs+30_000,user,id,step,started).run();
  if(!claim.meta.changes)return publicRun(await required(db,user,id));
  try {
    const connections=await resolveConnections(db,master,request,user,config);
    // Unselected keys remain disabled and exist here only for redaction. A
    // pasted key must not become task data sent to another selected provider.
    if(JSON.stringify(redactReport(config,connections))!==JSON.stringify(config))throw new ComparisonError('Remove credential text from the task.');
    const stop=new AbortController();
    const signal=AbortSignal.any([stop.signal,AbortSignal.timeout(Math.max(1,Math.min(phaseLimitMs,run.deadline-Date.now())))]);
    const guarded:typeof fetch=async(url,init)=>{
      signal.throwIfAborted();
      const pins=settings.providers.map(()=> 'AND EXISTS (SELECT 1 FROM provider_credentials WHERE user_id = ? AND provider = ? AND revision = ? AND enabled = 1 AND cipher IS NOT NULL)').join(' ');
      const reservation=await db.prepare("UPDATE work_comparison_runs SET calls = calls + 1 WHERE user_id = ? AND id = ? AND lease = ? AND status = 'running' AND calls < ? AND deadline > ? AND lease_until > ? "+pins).bind(user,id,token,settings.maxCalls,Date.now(),Date.now(),...settings.providers.flatMap(p=>[user,p,config.revisions[p]!])).run();
      if(!reservation.meta.changes){stop.abort();throw new Error('Comparison stopped.');}
      signal.throwIfAborted();
      return fetcher(url,{...init,signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});
    };
    const arm=step===0?'single':'council';
    const phase:ComparisonPhase={arm,state:'failed',answer:'',elapsedMs:0,httpCalls:0,degraded:true,notes:[]};
    let latestUsage:Usage|undefined;
    try {
      // Both arms start independently from identical task data. Neither sees
      // the other's output, account memory, conversation, or external tools.
      const result=await orchestrate({question:config.task.question,context:config.task.context,instructions:config.task.criteria,timeZone:settings.timeZone,connections,mode:arm,lead:settings.baseline},event=>{if(event.type==='usage')latestUsage=event.usage;},signal,guarded,new Date(run.started_at));
      phase.answer=result.answer;
      phase.state=result.answer.trim()&&!result.demo?'complete':'failed';
      phase.by=result.by;
      phase.degraded=phase.state!=='complete'||Boolean(result.fallback)||result.errors.length>0||result.by!==settings.baseline||arm==='council'&&(Object.keys(result.drafts).length<settings.providers.length||Object.keys(result.reviews).length<settings.providers.length);
      phase.notes=result.errors;
      phase.usage=result.usage;
    } catch {
      phase.notes=['This answer could not be completed. The paid phase will not be replayed automatically.'];
      phase.usage=latestUsage;
    }
    const latest=await required(db,user,id);
    phase.elapsedMs=Date.now()-started;
    phase.httpCalls=latest.calls-run.calls;
    // A blocked attempt may be counted by orchestration before the durable
    // guard rejects it. Missing or mismatched usage can never look like $0.
    if(phase.usage&&(phase.usage.calls!==phase.httpCalls||phase.usage.reportedCalls!==phase.httpCalls)) {
      phase.usage.costUSD=null;
      for(const providerUsage of Object.values(phase.usage.byProvider))providerUsage.costUSD=null;
    }
    const outcome=latest.status!=='running'?latest.status:Date.now()>=run.deadline?'timeout':signal.aborted?(latest.calls>=settings.maxCalls?'call_limit':'interrupted'):phase.state==='failed'?'interrupted':step===1?'complete':latest.calls>=settings.maxCalls?'call_limit':'running';
    await db.batch([
      db.prepare('INSERT INTO work_comparison_phases (user_id,run_id,step,report) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM work_comparison_runs WHERE user_id = ? AND id = ? AND lease = ?) ON CONFLICT DO NOTHING').bind(user,id,step,JSON.stringify(redactReport(phase,connections)),user,id,token),
      db.prepare("UPDATE work_comparison_runs SET cursor = cursor + 1, status = CASE WHEN status = 'cancelled' THEN status ELSE ? END, finished_at = CASE WHEN status = 'cancelled' THEN finished_at WHEN ? = 'running' THEN NULL ELSE ? END, lease = NULL, lease_until = NULL WHERE user_id = ? AND id = ? AND lease = ?").bind(outcome,outcome,Date.now(),user,id,token),
    ]);
  } catch {
    await db.prepare("UPDATE work_comparison_runs SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'interrupted' END, finished_at = COALESCE(finished_at, ?), lease = NULL, lease_until = NULL WHERE user_id = ? AND id = ? AND lease = ?").bind(Date.now(),user,id,token).run();
  }
  return publicRun(await required(db,user,id));
}
async function phasesOf(db:D1Database,user:string,id:string) {
  const rows=await db.prepare('SELECT report FROM work_comparison_phases WHERE user_id = ? AND run_id = ? ORDER BY step').bind(user,id).all<{report:string}>();
  return rows.results.map(row=>JSON.parse(row.report) as ComparisonPhase);
}
function labelsOf(run:StoredRun):Record<AnswerLabel,'single'|'council'> {
  return createHash('sha256').update(run.blind_seed).digest()[0]%2?{A:'council',B:'single'}:{A:'single',B:'council'};
}
function canRate(run:StoredRun,phases:ComparisonPhase[]) {
  return !run.lease&&run.status!=='running'&&phases.length===2&&phases.every(p=>p.state==='complete'&&p.answer.trim());
}
export async function comparisonReport(db:D1Database,user:string,id:string) {
  await expire(db,user);
  const run=await required(db,user,id),config=configOf(run),phases=await phasesOf(db,user,id);
  const ready=canRate(run,phases),labels=labelsOf(run);
  const base={run:publicRun(run),task:config.task,ready,limitations:comparisonLimitations,accounting:comparisonAccounting};
  if(run.ratings) {
    const ratings:ComparisonRatings=JSON.parse(run.ratings);
    return {...base,view:'revealed' as const,ratings,answers:(['A','B'] as const).map(label=>({label,...phases.find(p=>p.arm===labels[label])!})),preferredArm:ratings.preference==='A'||ratings.preference==='B'?labels[ratings.preference]:ratings.preference};
  }
  if(ready)return {...base,view:'blind' as const,answers:(['A','B'] as const).map(label=>({label,text:blindComparisonText(phases.find(p=>p.arm===labels[label])!.answer,config.models)})),degraded:phases.some(p=>p.degraded)};
  // No draft, per-arm latency or usage is exposed while a pair is running.
  // A terminal incomplete pair cannot be graded: diagnostics are transparent.
  return {...base,view:'incomplete' as const,phases:run.status==='running'||run.lease?[]:phases};
}
export type ComparisonReport = Awaited<ReturnType<typeof comparisonReport>>;
export async function rateComparison(db:D1Database,master:string|undefined,request:Request,user:string,id:string,ratings:ComparisonRatings) {
  await expire(db,user);
  const run=await required(db,user,id);
  // The first committed grade is the only one that preceded the reveal.
  // An ambiguous network retry returns that same receipt, never overwrites it.
  if(run.ratings)return comparisonReport(db,user,id);
  if(!canRate(run,await phasesOf(db,user,id)))throw new ComparisonError('Two completed answers are needed before rating.');
  // Notes must not echo a saved credential. Replaced/deleted credentials need
  // not be recovered: validate against the user's currently saved keys only.
  const saved=(await readSavedConnections(db,user)).connections,connections=freshConnections();
  for(const c of saved)if(c.saved)connections[c.provider].key=await resolveCredential(db,master,request,user,c.provider,savedKeyReference);
  const clean=redactReport(ratings,connections);
  if(JSON.stringify(clean)!==JSON.stringify(ratings))throw new ComparisonError('Remove credential text from your rating notes.');
  await db.prepare('UPDATE work_comparison_runs SET ratings = ?, rated_at = ? WHERE user_id = ? AND id = ? AND ratings IS NULL AND lease IS NULL AND status != ?').bind(JSON.stringify(ratings),Date.now(),user,id,'running').run();
  const report=await comparisonReport(db,user,id);
  if(report.view!=='revealed')throw new ComparisonError('Ratings could not be confirmed. Reload the comparison before retrying.');
  return report;
}
export async function deleteComparison(db:D1Database,user:string,id:string) {
  await expire(db,user);
  const run=await required(db,user,id);
  if(run.status==='running'||run.lease)throw new ComparisonError('Cancel the comparison and wait for its active phase before deleting it.');
  await db.batch([
    db.prepare('DELETE FROM work_comparison_phases WHERE user_id = ? AND run_id = ?').bind(user,id),
    db.prepare('DELETE FROM work_comparison_runs WHERE user_id = ? AND id = ? AND status != ? AND lease IS NULL').bind(user,id,'running'),
  ]);
}
