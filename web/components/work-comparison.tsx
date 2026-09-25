'use client';
import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Answer } from '@/components/answer';
import { UsageSummary } from '@/components/usage-summary';
import { toast } from 'sonner';
import { providers, type ProviderId } from '@/lib/trio';
import type { SavedConnection } from '@/lib/saved-connections';
import { comparisonTask, comparisonSettings, comparisonRatings, comparisonEstimate, comparisonSamples, defaultComparisonSettings, emptyComparisonTask, ratingRubric, type ComparisonTask, type ComparisonRatings } from '@/lib/work-comparison';
import type { ComparisonRun, ComparisonReport } from '@/lib/work-comparison-store';

type DraftRatings = {A:Partial<ComparisonRatings['A']>;B:Partial<ComparisonRatings['B']>;preference:ComparisonRatings['preference']|'';notes:string};
const emptyRatings = ():DraftRatings => ({A:{},B:{},preference:'',notes:''});
const statuses:Record<string,string>={running:'Ready to continue',complete:'Ready to rate',cancelled:'Cancelled',timeout:'Time limit reached',call_limit:'Call cap reached',interrupted:'Interrupted'};
const providerName = (id?:ProviderId) => providers.find(p=>p.id===id)?.name??'Unknown';
function CopyComparisonAnswer({text}:{text:string}) {
  return <button className="subtle-button" onClick={()=>void navigator.clipboard.writeText(text).then(()=>toast('Original answer copied. Review it before use.'),()=>toast('Copy unavailable. Select the text or download the report.'))}>Copy original answer</button>;
}
function RatingsForm({value,onChange,disabled,onSave,preview=false}:{value:DraftRatings;onChange:(v:DraftRatings)=>void;disabled:boolean;onSave:()=>void;preview?:boolean}) {
  const valid=comparisonRatings.safeParse(value).success;
  return <section className="comparison-ratings"><h3>Which draft would you use?</h3><p className="quality-note">Judge each against your success criteria before choosing a preference. Check material facts yourself.</p>
    <div className="comparison-rating-grid">{(['A','B'] as const).map(label=><fieldset key={label}><legend>Answer {label}</legend>{ratingRubric.map(r=><label key={r.key}>{r.label}<small>{r.description}</small><select aria-label={`Answer ${label}: ${r.label}`} disabled={disabled} value={value[label][r.key]??''} onChange={e=>onChange({...value,[label]:{...value[label],[r.key]:Number(e.target.value)}})}><option value="" disabled>Choose a rating</option><option value="0">0</option><option value="1">1</option><option value="2">2</option></select></label>)}</fieldset>)}</div>
    <label>Overall preference<select aria-label="Overall preference" disabled={disabled} value={value.preference} onChange={e=>onChange({...value,preference:e.target.value as DraftRatings['preference']})}><option value="" disabled>Choose a preference</option><option value="A">Answer A</option><option value="B">Answer B</option><option value="tie">About equal</option><option value="neither">Neither is usable</option></select></label>
    <label>What made the difference? (optional)<textarea aria-label="Comparison rating notes" disabled={disabled} maxLength={2000} rows={3} value={value.notes} onChange={e=>onChange({...value,notes:e.target.value})} placeholder="Specific omissions, invented details, useful corrections, or edits needed. No credentials or identifying client details." /></label>
    <p className="quality-note">{preview?'This practice rating is not saved. No providers are called.':'Saving reveals the sources and locks these first ratings. They cannot be edited after you know the sources. Your notes and ratings stay private to your account. Closing this screen or choosing another comparison discards unsaved ratings.'}</p>
    <button className="run-button" disabled={disabled||!valid} onClick={onSave}>{preview?'Try the reveal':'Save ratings and reveal sources'}</button>
  </section>;
}
function ComparisonPreview() {
  const [ratings,setRatings]=useState(emptyRatings),[revealed,setRevealed]=useState(false);
  return <section className="comparison-preview"><h3>Prepared preview · no API calls</h3><p>These two snippets were written for this preview. They are not results from Single answer or Council. Try the rating controls, then start a live comparison with your saved connections.</p>
    <div className="comparison-answers"><article><h4>Answer A</h4><p>We will send the template Tuesday. Please review it by Thursday. Could you confirm who will approve it and when we can receive the project milestones?</p></article><article><h4>Answer B</h4><p>Thank you for meeting. We look forward to helping with your weekly reports and will follow up with next steps soon.</p></article></div>
    <p className="quality-note">Preview task: capture Tuesday and Thursday commitments, the missing approver, and the milestones needed to draft the report.</p>
    {revealed?<p role="status">Practice complete. Your choice was {ratings.preference==='tie'?'about equal':ratings.preference==='neither'?'neither usable':`Answer ${ratings.preference}`}. There are no model identities, usage or saved results for a prepared preview.</p>:<RatingsForm value={ratings} onChange={setRatings} disabled={false} preview onSave={()=>setRevealed(true)} />}
  </section>;
}
export function WorkComparison({accountId,open,onOpenChange,live,onConnections}:{accountId:string;open:boolean;onOpenChange:(v:boolean)=>void;live:boolean;onConnections:()=>void}) {
  const [task,setTask]=useState<ComparisonTask>(emptyComparisonTask),[settings,setSettings]=useState(defaultComparisonSettings);
  const [connections,setConnections]=useState<SavedConnection[]>([]),[runs,setRuns]=useState<ComparisonRun[]>([]);
  const [current,setCurrent]=useState<ComparisonRun|null>(null),[report,setReport]=useState<ComparisonReport|null>(null);
  const [ratings,setRatings]=useState<DraftRatings>(emptyRatings),[error,setError]=useState('');
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[executing,setExecuting]=useState(false),[paused,setPaused]=useState(false),[uncertain,setUncertain]=useState(false),[preview,setPreview]=useState(false),[deleteAsked,setDeleteAsked]=useState(false);
  const version=useRef(0),continueRun=useRef(false),startId=useRef(crypto.randomUUID()),liveRef=useRef(live);
  liveRef.current=live;
  async function api<T={run:ComparisonRun}>(query='',body?:unknown):Promise<T> {
    const response=await fetch('/api/work-comparison'+query,{method:body?'POST':'GET',signal:AbortSignal.timeout((body as {action?:string}|undefined)?.action==='step'?165_000:30_000),headers:{'Content-Type':'application/json','X-Trio-Account':accountId},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json() as {error?:string};if(!response.ok)throw new Error(data.error||'Could not load this comparison.');return data as T;
  }
  function saveRun(run:ComparisonRun) {setCurrent(run);setRuns(old=>[run,...old.filter(r=>r.id!==run.id)]);}
  async function show(id:string,epoch=version.current) {
    const data:ComparisonReport=await api('?id='+id);
    if(epoch!==version.current)return;
    saveRun(data.run);setReport(data);
  }
  async function load(preferredId?:string) {
    const epoch=version.current;setLoading(true);setError('');
    try {
      const data:{runs:ComparisonRun[];connections:SavedConnection[]}=await api();if(epoch!==version.current)return;
      setRuns(data.runs);setConnections(data.connections);
      const selected=data.runs.find(r=>r.id===(preferredId??current?.id))??data.runs[0]??null;
      setCurrent(selected);setReport(null);if(selected?.id!==current?.id)setRatings(emptyRatings());setDeleteAsked(false);
      if(selected)await show(selected.id,epoch);
      if(epoch===version.current){setUncertain(false);startId.current=crypto.randomUUID();}
    }catch(e){if(epoch===version.current)setError((e as Error).message);}
    finally{if(epoch===version.current)setLoading(false);}
  }
  useEffect(()=>{
    version.current++;continueRun.current=false;setBusy(false);setExecuting(false);setLoading(false);setReport(null);setCurrent(null);setRuns([]);setConnections([]);setRatings(emptyRatings());setError('');setPreview(false);setDeleteAsked(false);setUncertain(false);
    if(open)void load();
    return()=>{version.current++;continueRun.current=false;};
    // Every request belongs to an account and open-dialog epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open,accountId]);
  useEffect(()=>{setTask({...emptyComparisonTask});let timeZone='UTC';try{timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;}catch{}setSettings({...defaultComparisonSettings,timeZone});startId.current=crypto.randomUUID();},[accountId]);
  async function drive(initial:ComparisonRun) {
    const epoch=version.current;continueRun.current=true;setBusy(true);setExecuting(true);setPaused(false);setError('');
    let run=initial;
    try {
      while(continueRun.current&&epoch===version.current&&run.status==='running'&&liveRef.current) {
        const data:{run:ComparisonRun}=await api('',{action:'step',id:run.id,step:run.completedSteps});if(epoch!==version.current)return;
        const previous=run.completedSteps;run=data.run;saveRun(run);
        if(run.inFlight||run.completedSteps===previous)break;
      }
      if(epoch===version.current)await show(run.id,epoch);
    }catch(e){if(epoch===version.current)setError((e as Error).message+' Reload progress before continuing.');}
    finally{if(epoch===version.current){setBusy(false);setExecuting(false);continueRun.current=false;}}
  }
  async function start() {
    if(busy||!live||uncertain)return;
    const epoch=version.current;setBusy(true);setUncertain(true);setError('');setPreview(false);
    try {
      const data:{run:ComparisonRun}=await api('',{action:'start',id:startId.current,task,settings,live:true});if(epoch!==version.current)return;
      setUncertain(false);saveRun(data.run);await drive(data.run);
    }catch(e){if(epoch===version.current)setError((e as Error).message+' Reload comparisons before starting again.');}
    finally{if(epoch===version.current)setBusy(false);}
  }
  async function cancel() {
    if(!current)return;continueRun.current=false;const epoch=version.current;
    try{const data=await api('',{action:'cancel',id:current.id});if(epoch===version.current)saveRun(data.run);}
    catch(e){if(epoch===version.current)setError((e as Error).message);}
  }
  async function choose(id:string) {
    setError('');setReport(null);setRatings(emptyRatings());setDeleteAsked(false);setPreview(false);startId.current=crypto.randomUUID();
    if(id==='new'){setCurrent(null);return;}
    const epoch=version.current;setBusy(true);
    try{await show(id,epoch);}catch(e){if(epoch===version.current)setError((e as Error).message);}finally{if(epoch===version.current)setBusy(false);}
  }
  async function rate() {
    if(!current||!comparisonRatings.safeParse(ratings).success)return;
    const epoch=version.current;setBusy(true);setError('');
    try{const data:ComparisonReport=await api('',{action:'rate',id:current.id,ratings});if(data.view!=='revealed')throw new Error('Ratings could not be confirmed.');if(epoch===version.current){setReport(data);saveRun(data.run);}}
    catch(e){if(epoch===version.current)setError((e as Error).message+' Reload to check whether your first ratings were saved.');}
    finally{if(epoch===version.current)setBusy(false);}
  }
  async function download() {
    if(!current)return;const epoch=version.current;setBusy(true);setError('');
    try {
      const data:ComparisonReport=await api('?id='+current.id);if(epoch!==version.current)return;
      const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}));
      const a=document.createElement('a');a.href=url;a.download=`trio-work-comparison-${current.id}-${data.view}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){if(epoch===version.current)setError((e as Error).message);}finally{if(epoch===version.current)setBusy(false);}
  }
  async function remove() {
    if(!current)return;const epoch=version.current;setBusy(true);setError('');
    try{await api('',{action:'delete',id:current.id});if(epoch===version.current){setCurrent(null);setReport(null);await load();}}
    catch(e){if(epoch===version.current)setError((e as Error).message);}finally{if(epoch===version.current)setBusy(false);}
  }
  const models=Object.fromEntries(connections.map(c=>[c.provider,c.model]));
  const estimate=comparisonEstimate(settings,models);
  const active=runs.some(r=>r.status==='running'||r.inFlight);
  const ready=comparisonTask.safeParse(task).success&&comparisonSettings.safeParse(settings).success&&settings.providers.every(p=>connections.some(c=>c.provider===p&&c.saved&&c.enabled));
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="quality-dialog comparison-dialog"><DialogTitle>Compare on your work</DialogTitle><DialogDescription>Give one task to Single answer and Council. Rate two unlabeled drafts, then reveal the sources, usage and time taken.</DialogDescription>
    <p className="quality-note">Both get the same task, facts and success criteria. Your selected model is the preferred final writer for both; any fallback is disclosed after rating. Dates use the run-start time in {current?.settings.timeZone??settings.timeZone}. No conversation history, personal memory, attachments or web research are used. Saved comparisons stay private to your account.</p>
    {loading?<p role="status">Loading private comparisons…</p>:<>
      {runs.length>0&&<label>Saved comparisons<Select value={current?.id??'new'} disabled={busy||uncertain} onValueChange={id=>void choose(id)}><SelectTrigger aria-label="Saved work comparisons"><SelectValue /></SelectTrigger><SelectContent>{!active&&<SelectItem value="new">New comparison</SelectItem>}{runs.map(r=><SelectItem key={r.id} value={r.id}>{r.title} · {r.ratedAt?'Rated':statuses[r.status]} · {new Date(r.startedAt).toLocaleString()}</SelectItem>)}</SelectContent></Select></label>}
      {!current?<section className="comparison-setup">
        <div className="quality-actions"><button className="subtle-button" disabled={busy} onClick={()=>setPreview(v=>!v)}>{preview?'Hide prepared preview':'Try a free prepared preview'}</button></div>
        {preview&&<ComparisonPreview />}
        <label>Start from your own task or a fictional sample<select aria-label="Work comparison task template" disabled={busy||uncertain} value={comparisonSamples.findIndex(s=>s.title===task.title&&s.source===task.source)<0?'own':String(comparisonSamples.findIndex(s=>s.title===task.title&&s.source===task.source))} onChange={e=>setTask(e.target.value==='own'?{...emptyComparisonTask}:{...comparisonSamples[Number(e.target.value)]})}><option value="own">My own anonymized work</option>{comparisonSamples.map((s,i)=><option key={s.title} value={i}>{s.title}</option>)}</select></label>
        <p className="quality-note">Use anonymized facts. Do not paste client identifiers, account numbers or credentials. {task.source==='sample'?'This run will be labeled as a fictional sample, even if you edit its text.':'You supply the task and decide what a useful result looks like.'}</p>
        <label>Comparison name<input aria-label="Comparison name" disabled={busy||uncertain} maxLength={100} value={task.title} onChange={e=>setTask(t=>({...t,title:e.target.value}))} placeholder="e.g. Follow-up draft after an operations meeting" /></label>
        <label>Deliverable you need<textarea aria-label="Comparison task" disabled={busy||uncertain} rows={4} maxLength={4000} value={task.question} onChange={e=>setTask(t=>({...t,question:e.target.value}))} placeholder="What should the answer produce? Include audience, length and constraints." /></label>
        <label>Facts and reference notes<textarea aria-label="Comparison reference notes" disabled={busy||uncertain} rows={5} maxLength={8000} value={task.context} onChange={e=>setTask(t=>({...t,context:e.target.value}))} placeholder="Facts both approaches must use. Leave unknowns explicit." /></label>
        <label>What would make the result useful?<textarea aria-label="Comparison success criteria" disabled={busy||uncertain} rows={3} maxLength={2000} value={task.criteria} onChange={e=>setTask(t=>({...t,criteria:e.target.value}))} placeholder="Required details, errors to avoid, or decisions the draft should support." /></label>
        <fieldset disabled={busy||uncertain}><legend>Saved providers for Council</legend>{providers.map(p=>{const saved=connections.find(c=>c.provider===p.id);return <label className="quality-provider" key={p.id}><Checkbox aria-label={'Compare with '+p.name} checked={settings.providers.includes(p.id)} onCheckedChange={checked=>setSettings(s=>{const selected=checked?[...s.providers,p.id]:s.providers.filter(id=>id!==p.id);return {...s,providers:selected,baseline:selected.includes(s.baseline)?s.baseline:selected[0]??'openai'};})} /><span>{p.name}<small>{saved?.saved&&saved.enabled?saved.model:'Save and enable this connection first'}</small></span></label>;})}</fieldset>
        <div className="quality-fields"><label>Single answer and final writer<select aria-label="Comparison final writer" disabled={busy||uncertain} value={settings.baseline} onChange={e=>setSettings(s=>({...s,baseline:e.target.value as ProviderId}))}>{providers.filter(p=>settings.providers.includes(p.id)).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Hard call cap<input aria-label="Comparison call cap" disabled={busy||uncertain} type="number" min={1} max={30} value={settings.maxCalls} onChange={e=>setSettings(s=>({...s,maxCalls:Number(e.target.value)}))} /></label><label>Time limit (seconds)<input aria-label="Comparison time limit" disabled={busy||uncertain} type="number" min={30} max={1800} value={settings.timeoutSeconds} onChange={e=>setSettings(s=>({...s,timeoutSeconds:Number(e.target.value)}))} /></label></div>
        <div className="quality-cost"><strong>2 answers · {estimate.nominalCalls} nominal calls · cap {settings.maxCalls}</strong><p>{estimate.illustrativeUSD===null?'A dollar estimate is unavailable for these model IDs.':`Illustrative cost: $${estimate.illustrativeUSD.toFixed(2)} at 2,000 input and 1,000 output tokens per nominal call.`} Providers bill you directly. Actual usage varies; the call cap includes retries and is not a dollar cap.</p>{settings.maxCalls<estimate.nominalCalls&&<p>The cap is below the nominal calls. Expect an incomplete pair.</p>}<p>Keep this screen open. Closing it pauses after the active step; return and continue explicitly. The time limit includes pauses. A browser refresh or hosting interruption can stop an active step, which will not be replayed automatically.</p></div>
        {!live&&<p className="quality-warning">Live comparisons require Live mode. Turn off Demo mode in Connections. The free prepared preview works without keys.</p>}
        <div className="quality-actions"><button className="run-button" disabled={busy||!live||!ready||active||uncertain} onClick={()=>void start()}>Start paid comparison</button><button className="subtle-button" disabled={busy} onClick={onConnections}>Connections</button><button className="subtle-button" disabled={busy} onClick={()=>void load(startId.current)}>Reload comparisons</button></div>
      </section>:<section className="comparison-results">
        <h3>{current.title}</h3><p className="comparison-status" role="status">{executing?'Generating the two drafts…':current.ratedAt?'Ratings saved':statuses[current.status]} · {current.completedSteps} of 2 steps saved · {current.calls} of {current.settings.maxCalls} attempts reserved</p>
        <p className="quality-note">{current.source==='sample'?'Fictional sample. ':''}Model IDs were fixed when you started. {current.status==='running'?`Deadline: ${new Date(current.deadline).toLocaleTimeString()}. `:''}{current.inFlight?'A step is in flight. Already-paid responses can finish after cancellation; later calls are fenced.':''}</p>
        {!live&&current.status==='running'&&<p className="quality-warning">Demo mode is on. To continue this saved run, turn it off in Connections.<button className="subtle-button" disabled={busy} onClick={onConnections}>Open Connections</button></p>}
        <div className="quality-actions">{current.status==='running'&&<>{executing?<button className="subtle-button" disabled={paused} onClick={()=>{continueRun.current=false;setPaused(true);}}>{paused?'Pausing after this step…':'Pause after this step'}</button>:<button className="run-button" disabled={busy||!live||current.inFlight} onClick={()=>void drive(current)}>Continue comparison</button>}<button className="subtle-button" onClick={()=>void cancel()}>Cancel comparison</button></>}<button className="subtle-button" disabled={busy} onClick={()=>void load()}>Reload progress</button><button className="subtle-button" disabled={busy||current.inFlight||current.status==='running'} onClick={()=>void download()}>{report?.view==='blind'?'Download unlabeled drafts':'Download comparison report'}</button></div>
        {report&&<>
          <details className="comparison-task"><summary>Task and success criteria</summary><p>{report.task.question}</p><h4>Supplied facts</h4><p>{report.task.context||'No reference notes supplied.'}</p><h4>Success criteria</h4><p>{report.task.criteria}</p></details>
          {report.view==='blind'&&<><p className="quality-note">Sources, per-answer usage and timing remain hidden until your first ratings are saved. Known model labels are masked in this view; wording or style may still reveal an origin.</p>{report.degraded&&<p className="quality-warning">At least one approach had an incomplete team or fallback. You can rate the completed drafts; the revealed report will show the limitations.</p>}<div className="comparison-answers">{report.answers.map(a=><article key={a.label}><h4>Answer {a.label}</h4><Answer text={a.text} /></article>)}</div><RatingsForm value={ratings} onChange={setRatings} disabled={busy} onSave={()=>void rate()} /></>}
          {report.view==='revealed'&&<><div className="comparison-verdict"><h3>Your recorded preference: {report.preferredArm==='single'?'Single answer':report.preferredArm==='council'?'Council':report.preferredArm==='tie'?'About equal':'Neither usable'}</h3><p>First ratings saved {new Date(report.run.ratedAt!).toLocaleString()}. These ratings are locked after reveal.</p>{report.ratings.notes&&<p className="comparison-notes">{report.ratings.notes}</p>}</div><div className="comparison-answers">{report.answers.map(a=><article key={a.label}><h4>Answer {a.label} · {a.arm==='single'?'Single answer':'Council'}</h4><p className="quality-note">Final writer: {providerName(a.by)} · {(a.elapsedMs/1000).toFixed(1)} seconds · {a.httpCalls} attempts reserved</p>{a.degraded&&<p className="quality-warning">Degraded result. {a.notes.join(' ')||'The requested team or final writer could not be used completely.'}</p>}<dl className="comparison-scores">{ratingRubric.map(r=><div key={r.key}><dt>{r.label}</dt><dd>{report.ratings[a.label][r.key]}/2</dd></div>)}</dl><Answer text={a.answer} /><CopyComparisonAnswer text={a.answer} />{a.usage?<UsageSummary usage={a.usage} />:<p className="quality-note">Usage and cost unavailable.</p>}</article>)}</div><details><summary>Configured model IDs</summary>{current.settings.providers.map(p=><p key={p}>{providerName(p)}: {current.models[p]}</p>)}</details></>}
          {report.view==='incomplete'&&current.status!=='running'&&!current.inFlight&&<><p className="quality-warning">This run did not produce two completed drafts. It cannot be rated. Saved outputs and usage are available below; starting another run is a new paid comparison.</p>{report.phases.map(p=><details key={p.arm}><summary>{p.arm==='single'?'Single answer':'Council'} · {p.state} · {p.httpCalls} attempts</summary><p>{p.notes.join(' ')}</p>{p.answer&&<Answer text={p.answer} />}{p.usage&&<UsageSummary usage={p.usage} />}</details>)}</>}
          <p className="quality-note">{report.limitations}</p><p className="quality-note">{report.accounting}</p>
        </>}
        {current.status!=='running'&&!current.inFlight&&<div className="quality-actions"><button className="subtle-button" disabled={busy} onClick={()=>void choose('new')}>New comparison</button>{deleteAsked?<><span>Delete this task, its answers and ratings?</span><button className="subtle-button" disabled={busy} onClick={()=>void remove()}>Delete permanently</button><button className="subtle-button" onClick={()=>setDeleteAsked(false)}>Keep comparison</button></>:<button className="subtle-button" disabled={busy} onClick={()=>setDeleteAsked(true)}>Delete comparison</button>}</div>}
      </section>}
    </>}{error&&<p className="quality-warning" role="alert">{error}</p>}
  </DialogContent></Dialog>;
}
