'use client';
import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { defaultQualitySettings, qualityEstimate, type QualitySettings } from '@/evaluation/hosted-config';
import { providers, type ProviderId } from '@/lib/trio';
import type { SavedConnection } from '@/lib/saved-connections';
import type { QualityRun, qualityReport } from '@/lib/quality-store';

type Report = Awaited<ReturnType<typeof qualityReport>>['report'];
const statusLabel:Record<string,string>={running:'Ready to continue',complete:'Complete',cancelled:'Cancelled',timeout:'Time limit reached',call_limit:'Call limit reached',interrupted:'Interrupted — partial results saved'};
export function QualityCheck({accountId,open,onOpenChange,live,onConnections}:{accountId:string;open:boolean;onOpenChange:(v:boolean)=>void;live:boolean;onConnections:()=>void}) {
  const [settings,setSettings]=useState<QualitySettings>(defaultQualitySettings);
  const [connections,setConnections]=useState<SavedConnection[]>([]);
  const [runs,setRuns]=useState<QualityRun[]>([]),[current,setCurrent]=useState<QualityRun|null>(null);
  const [report,setReport]=useState<Report|null>(null),[error,setError]=useState('');
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[executing,setExecuting]=useState(false),[paused,setPaused]=useState(false);
  const version=useRef(0),continueRun=useRef(false),startId=useRef(crypto.randomUUID());
  async function api(query='',body?:unknown) {
    const response=await fetch('/api/quality'+query,{method:body?'POST':'GET',signal:AbortSignal.timeout((body as {action?:string}|undefined)?.action==='step'?165_000:30_000),headers:{'Content-Type':'application/json','X-Trio-Account':accountId},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json() as {error?:string;run:QualityRun;runs:QualityRun[];connections:SavedConnection[];report:Report};if(!response.ok)throw new Error(data.error||'Could not load the quality check.');return data;
  }
  function saveRun(run:QualityRun) {setCurrent(run);setRuns(old=>[run,...old.filter(r=>r.id!==run.id)]);}
  async function load() {
    const epoch=version.current;setLoading(true);setError('');
    try {const data=await api();if(epoch!==version.current)return;setRuns(data.runs);setConnections(data.connections);setCurrent(old=>data.runs.find((r:QualityRun)=>r.id===old?.id)??data.runs[0]??null);}
    catch(e){if(epoch===version.current)setError((e as Error).message);}finally{if(epoch===version.current)setLoading(false);}
  }
  useEffect(()=>{
    version.current++;continueRun.current=false;setBusy(false);setExecuting(false);setReport(null);setCurrent(null);setRuns([]);setConnections([]);
    if(open)void load();
    return()=>{version.current++;continueRun.current=false;};
    // Opening/account changes invalidate responses from the previous view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open,accountId]);
  async function drive(initial:QualityRun) {
    const epoch=version.current;continueRun.current=true;setBusy(true);setExecuting(true);setPaused(false);setError('');
    let run=initial;
    try {
      while(continueRun.current && epoch===version.current && run.status==='running') {
        if(!live)break;
        const data=await api('',{action:'step',id:run.id,step:run.completedSteps});
        if(epoch!==version.current)return;
        const previous=run.completedSteps;run=data.run;saveRun(run);
        // Another tab owns the phase, or this response was a duplicate. Stop
        // locally; never spin or schedule a second phase from stale progress.
        if(run.inFlight||run.completedSteps===previous)break;
      }
    }catch(e){if(epoch===version.current)setError((e as Error).message+' Reload progress before continuing.');}
    finally{if(epoch===version.current){setBusy(false);setExecuting(false);continueRun.current=false;}}
  }
  async function start() {
    if(busy||!live)return;
    const epoch=version.current;setBusy(true);setError('');
    try{const data=await api('',{action:'start',id:startId.current,settings,live:true});if(epoch!==version.current)return;saveRun(data.run);await drive(data.run);}
    catch(e){if(epoch===version.current)setError((e as Error).message);}
    finally{if(epoch===version.current)setBusy(false);}
  }
  async function cancel() {
    if(!current)return;continueRun.current=false;const epoch=version.current;
    try{const data=await api('',{action:'cancel',id:current.id});if(epoch===version.current){saveRun(data.run);setPaused(false);}}
    catch(e){if(epoch===version.current)setError((e as Error).message);}
  }
  async function view() {
    if(!current)return;const epoch=version.current;setError('');setBusy(true);
    try{const data=await api('?id='+current.id);if(epoch===version.current){saveRun(data.run);setReport(data.report);}}
    catch(e){if(epoch===version.current)setError((e as Error).message);}finally{if(epoch===version.current)setBusy(false);}
  }
  async function download(part:'report'|'sheet'|'key') {
    if(!current)return;
    if(part==='key'&&!window.confirm('Grade the blinded sheet before opening the identity key. Reveal and download identities now?'))return;
    const epoch=version.current;setBusy(true);setError('');
    try{const data=await api('?id='+current.id+'&export='+part);if(epoch!==version.current)return;const blob=new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='trio-quality-'+current.id+'-'+part+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    catch(e){if(epoch===version.current)setError((e as Error).message);}finally{if(epoch===version.current)setBusy(false);}
  }
  const models=Object.fromEntries(connections.map(c=>[c.provider,c.model]));
  const estimate=qualityEstimate(settings,models);
  const ready=settings.providers.length>=2&&settings.providers.every(p=>connections.some(c=>c.provider===p&&c.saved&&c.enabled));
  const active=runs.some(r=>r.status==='running'||r.inFlight);
  const selecting=!current;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="quality-dialog"><DialogTitle>Quality check</DialogTitle><DialogDescription>Compare independent answers with the team on synthetic tasks. Results stay private to your account.</DialogDescription>
    <p className="quality-note">These tests measure exact answers on a small fixed suite. They do not prove general accuracy or usefulness for client work. Grade the blinded sheet before viewing answers or the identity key.</p>
    {!live&&<p className="quality-warning">Quality checks require Live mode. Turn off Demo mode in Connections to start or continue a check. Viewing saved results is free.</p>}
    {loading?<p role="status">Loading saved checks…</p>:<>
      {runs.length>0&&<div className="quality-history"><label>Saved checks<Select value={current?.id??'new'} disabled={busy} onValueChange={id=>{setCurrent(runs.find(r=>r.id===id)??null);setReport(null);setError('');startId.current=crypto.randomUUID();}}><SelectTrigger aria-label="Saved quality checks"><SelectValue /></SelectTrigger><SelectContent>{!active&&<SelectItem value="new">New quality check</SelectItem>}{runs.map(r=><SelectItem key={r.id} value={r.id}>{new Date(r.startedAt).toLocaleString()} · {statusLabel[r.status]}</SelectItem>)}</SelectContent></Select></label></div>}
      {selecting?<div className="quality-setup">
        <div className="quality-fields"><label>Suite<Select value={settings.suite} onValueChange={v=>setSettings(s=>({...s,suite:v as QualitySettings['suite']}))}><SelectTrigger aria-label="Quality suite"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="core">Core · 6 cases</SelectItem><SelectItem value="representative">Representative · 25 cases</SelectItem><SelectItem value="all">All · 31 cases</SelectItem></SelectContent></Select></label>
        <label>Team mode<Select value={settings.mode} onValueChange={v=>setSettings(s=>({...s,mode:v as QualitySettings['mode']}))}><SelectTrigger aria-label="Quality team mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="fast">Quick synthesis</SelectItem><SelectItem value="council">Council</SelectItem><SelectItem value="deep">Deep Council</SelectItem></SelectContent></Select></label></div>
        <fieldset><legend>Saved providers</legend>{providers.map(p=>{const saved=connections.find(c=>c.provider===p.id);return <label className="quality-provider" key={p.id}><Checkbox checked={settings.providers.includes(p.id)} aria-label={'Include '+p.name} onCheckedChange={checked=>setSettings(s=>{const selected=checked?[...s.providers,p.id]:s.providers.filter(id=>id!==p.id);return {...s,providers:selected,baseline:selected.includes(s.baseline)?s.baseline:selected[0]??'claude'};})} /><span>{p.name}<small>{saved?.saved&&saved.enabled?saved.model:'Save and enable this connection first'}</small></span></label>;})}</fieldset>
        <div className="quality-fields"><label>Comparison baseline<Select value={settings.baseline} onValueChange={v=>setSettings(s=>({...s,baseline:v as ProviderId}))}><SelectTrigger aria-label="Quality baseline"><SelectValue /></SelectTrigger><SelectContent>{providers.filter(p=>settings.providers.includes(p.id)).map(p=><SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent></Select></label><label>Hard call cap<input aria-label="Quality call cap" type="number" min="1" max="500" value={settings.maxCalls} onChange={e=>setSettings(s=>({...s,maxCalls:Number(e.target.value)}))} /></label><label>Time limit (seconds)<input aria-label="Quality time limit" type="number" min="1" max="3600" value={settings.timeoutSeconds} onChange={e=>setSettings(s=>({...s,timeoutSeconds:Number(e.target.value)}))} /></label></div>
        <div className="quality-cost"><strong>{estimate.caseCount} cases · {estimate.nominalCalls} nominal calls · cap {settings.maxCalls}</strong><p>Providers bill you directly. {estimate.illustrativeUSD===null?'A dollar estimate is unavailable for these model IDs.':`Illustrative cost: $${estimate.illustrativeUSD.toFixed(2)} if each nominal call uses 2,000 input and 1,000 output tokens at the configured standard rates.`} Actual usage can be higher or lower. This is a call cap, not a dollar cap; retries count toward it.</p>{settings.maxCalls<estimate.nominalCalls&&<p>The cap is below the nominal call count. Expect a partial report.</p>}<p>Keep this screen open while running. Closing or refreshing pauses after the current step; reopen and continue. The time limit includes pauses. An interrupted step is never automatically replayed.</p></div>
        <div className="quality-actions"><button className="run-button" disabled={busy||!live||!ready||active||!Number.isInteger(settings.maxCalls)||settings.maxCalls<1||settings.maxCalls>500||!Number.isInteger(settings.timeoutSeconds)||settings.timeoutSeconds<1||settings.timeoutSeconds>3600} onClick={()=>void start()}>Start paid quality check</button><button className="subtle-button" onClick={onConnections}>Connections</button></div>
      </div>:<div className="quality-progress">
        <h3>{executing?'Running quality check…':statusLabel[current.status]}</h3><p>{current.settings.suite} · {current.settings.mode} · baseline {providers.find(p=>p.id===current.settings.baseline)?.name}</p>
        <Progress value={100*current.completedSteps/current.totalSteps} aria-label="Quality check progress" />
        <p role="status">{current.completedSteps} of {current.totalSteps} steps saved · {current.calls} of {current.settings.maxCalls} call attempts reserved</p>
        <p className="quality-note">Deadline: {new Date(current.deadline).toLocaleTimeString()}. Attempts without usage reports may still be billed. {current.inFlight?'A step is in flight. It may finish after cancellation; no further calls will start.':''}</p>
        {current.status==='interrupted'&&<p className="quality-warning">A step could not be confirmed. It will not be retried automatically. Download the partial report; check Connections before starting another paid run.</p>}
        <div className="quality-actions">{current.status==='running'&&<>{executing?<button className="subtle-button" disabled={paused} onClick={()=>{continueRun.current=false;setPaused(true);}}>Pause after this step</button>:<button className="run-button" disabled={busy||!live||current.inFlight} onClick={()=>void drive(current)}>Continue quality check</button>}<button className="subtle-button" onClick={()=>void cancel()}>Cancel quality check</button></>}
        <button className="subtle-button" disabled={busy} onClick={()=>void load()}>Reload progress</button><button className="subtle-button" disabled={busy} onClick={()=>void view()}>View results</button></div>
        <div className="quality-actions"><button className="subtle-button" disabled={busy} onClick={()=>void download('report')}>Download report</button><button className="subtle-button" disabled={busy||current.status==='running'||current.inFlight} onClick={()=>void download('sheet')}>Download blinded sheet</button><button className="subtle-button" disabled={busy||current.status==='running'||current.inFlight} onClick={()=>void download('key')}>Download identity key</button></div>
        {report&&<section className="quality-results"><h3>Your private results</h3><p>{report.summary.team.passed} / {report.summary.team.total} team answers passed the exact-answer check; {report.summary.team.notRun} unrun. {report.summary.degradedPhases} degraded phases.</p><p>{report.comparison.overall.eligible} comparable cases: {report.comparison.overall.correctedErrors} baseline-wrong/team-right; {report.comparison.overall.introducedErrors} baseline-right/team-wrong. Separate samples do not establish that collaboration caused either outcome.</p><p className="quality-note">{report.limitations}</p>{report.results.map(row=><details key={row.id}><summary>{row.id} · team: {row.team.status} · baseline: {row.baseline[current.settings.baseline]?.status}</summary><p>{row.question}</p>{row.context&&<pre>{row.context}</pre>}<p>Expected: {row.expected}</p>{providers.filter(p=>row.baseline[p.id]).map(p=><div key={p.id}><strong>{p.name}: {row.baseline[p.id]?.status}</strong><pre>{row.answers?.baseline[p.id]??'No saved answer'}</pre></div>)}<strong>Team: {row.team.status}</strong><pre>{row.answers?.team??'No saved answer'}</pre><p>{[...row.baselineRun.notes,...row.teamRun.notes].join(' ')}</p><p>Attempts: {row.baselineRun.httpCalls+row.teamRun.httpCalls}. Baseline: {row.baselineRun.elapsedMs??'—'} ms; team: {row.teamRun.elapsedMs??'—'} ms. Report download includes per-provider usage.</p></details>)}</section>}
      </div>}
    </>}{error&&<p role="alert" className="quality-warning">{error}</p>}
  </DialogContent></Dialog>;
}
