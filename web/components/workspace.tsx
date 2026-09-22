'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Archive, ArrowUp, Plus, MessageSquare, Settings2, Paperclip, X, Copy, Download, Check, Layers3, Zap, GitCompareArrows, ShieldCheck, ChevronRight, Square, Lightbulb, Code2, Compass, CircleHelp, Trash2, RefreshCw } from 'lucide-react';
import { SidebarProvider, Sidebar, SidebarContent, SidebarHeader, SidebarFooter, SidebarTrigger } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { Answer as Prose } from '@/components/answer';
import { UsageSummary } from '@/components/usage-summary';
import { SessionInstructions, InstructionsUsed, MemoryUsed } from '@/components/session-instructions';
import { SessionList, SessionActionDialogs, type SessionAction } from '@/components/session-library';
import { renameSession } from '@/lib/session-library';
import { SessionBackups } from '@/components/session-backups';
import { mergeBackup } from '@/lib/backups';
import { selectResearchProvider, type ResearchChoice } from '@/lib/research';
import { RunCoverage, RunPipeline, answerLabel } from '@/components/run-coverage';
import { ResearchPanel } from '@/components/research-panel';
import { BranchConversation } from '@/components/branch-conversation';
import { DraftNavigation, NewSessionButton, type DraftDestination } from '@/components/draft-navigation';
import { branchConversation } from '@/lib/branch-conversation';
import { AnswerFeedback } from '@/components/answer-feedback';
import { setAnswerFeedback, type AnswerFeedback as Feedback } from '@/lib/answer-feedback';
import { ConversationHistory } from '@/components/conversation-history';
import { FollowUpContext } from '@/components/follow-up-context';
import { runLiveRequest } from '@/lib/run-live-request';
import { applyRunEvent } from '@/lib/run-events';
import { readImageFile, type AttachedImage } from '@/lib/images';
import { readPdfFile, attachmentBytes, maxAttachmentBytes, type AttachedPdf } from '@/lib/pdf';
import { parseSessions, serializeSessions, conversationContext, sessionMarkdown, type Turn, type Session } from '@/lib/sessions';
import { Toaster, toast } from 'sonner';
import { PersonalMemory, usePersonalMemory } from '@/components/personal-memory';
import { useAccountWorkspace } from '@/components/use-account-workspace';
import { ProviderConnection } from '@/components/provider-connection';
import { AudioTranscription } from '@/components/audio-transcription';
import { ImageGeneration } from '@/components/image-generation';
import { providers, freshConnections, type Connections, type Mode, type ProviderId, type Result, type RunEvent } from '@/lib/trio';

const modes = { council: { title: 'Council', icon: Layers3, desc: 'Independent answers, peer review, one stronger result.', calls: 'Up to 7 calls + retries' }, deep: { title: 'Deep Council', icon: RefreshCw, desc: 'Challenge, revise, then synthesize. More time and API usage; not a guarantee of accuracy.', calls: 'Up to 10 calls + retries' }, fast: { title: 'Quick synthesis', icon: Zap, desc: 'Three perspectives, combined without the review round.', calls: 'Up to 4 calls + retries' }, compare: { title: 'Compare', icon: GitCompareArrows, desc: 'Independent answers side by side. You make the call.', calls: 'Up to 3 calls + retries' } };
const emptyResult = (demo: boolean): Result => ({ drafts: {}, reviews: {}, errors: [], answer: '', seconds: 0, demo });
const demoQuestion = 'Design a practical 30-day plan to turn an idea into a validated product.';
const demoDrafts = [
  'Start with the problem, not the product.\n\nWeek 1: Interview 8–10 people in one customer segment. Ask about the last time they encountered the problem and how they solve it today.\n\nWeek 2: Test a simple offer before building.\n\nWeek 3: Deliver the core result manually for three pilot users.\n\nWeek 4: Compare repeat use, willingness to pay, and the effort to deliver. Build only what the evidence supports.',
  'Define what would disprove the idea before testing it.\n\nChoose one audience and one painful workflow. Record existing workarounds, their cost, and who owns the buying decision. Avoid asking whether people “like” the idea.\n\nUse a concierge pilot with a clear success measure. Separate polite enthusiasm from a concrete commitment. At day 30, decide whether to continue, change the customer segment, or stop.',
  'Create a small learning loop: observe → prototype → test → measure.\n\nMap the workflow and find the slowest or most frustrating step. Make a clickable prototype around that single step, then test with five prospective users.\n\nTrack task completion and reasons for abandonment. Use a simple experiment log so each week starts with evidence from the previous one. A small sample is directional evidence, not proof of market demand.',
];
const demoReviews = [
  'Strongest shared idea: test one painful problem with a narrow audience.\n\nImprovement: choose the decision criteria before the pilot. Interviews alone do not validate willingness to pay.\n\nOpen question: which audience can you reach in the first week?',
  'The plans agree on a small experiment, but agreement is not external validation.\n\nAvoid treating 8–10 interviews as statistically representative. Capture contradictory evidence, not just positive feedback. Make the stop or pivot decision explicit.',
  'Combine the practical weekly plan with a clear experiment log.\n\nMeasure an actual behavior, such as repeated use or a pilot commitment. Keep the prototype small enough to revise during the month. Pricing and sample size remain assumptions to test.',
];
const demoRevisions = [
  '## Revised plan\n\nInterview one reachable customer segment, then run a small concierge pilot. Before the pilot, write down the behavior that would justify continuing: repeated use, a concrete commitment, or a measurable improvement over the current workaround.\n\n### Changes and remaining uncertainties\n\nAdded decision criteria before testing, in response to the reviews. Interviews can reveal problems but cannot establish willingness to pay. The appropriate threshold depends on the business; this small sample cannot prove demand.',
  '## Revised plan\n\nKeep an experiment log with the hypothesis, evidence for and against it, and the next decision. Pair interviews with a task-based prototype test and a paid or otherwise concrete pilot commitment. Decide at day 30 whether to continue, change the audience, or stop.\n\n### Changes and remaining uncertainties\n\nAdded observable task completion and a weekly schedule from the other drafts. A commitment is stronger evidence than praise, but still does not establish retention. Pricing needs a separate test.',
  '## Revised plan\n\nUse the prototype to test a single painful workflow, then deliver the outcome manually for a small pilot group. Record task completion, repeat use, and delivery effort. Define stop criteria before starting, and document contradictory feedback.\n\n### Changes and remaining uncertainties\n\nReplaced a prototype-only success measure with a real pilot commitment. Five prototype users provide directional usability feedback, not a reliable estimate of market demand. Repeat the experiment with a broader sample before scaling.',
];
const demoFinal = 'Make the first 30 days a learning sprint. Your goal is evidence that a specific group will act on your offer.\n\n01 — Find the problem · Days 1–7\nPick one reachable customer segment. Interview 8–10 people about a recent experience, current workarounds, and the cost of the problem. Record evidence that challenges your idea.\n\n02 — Test the offer · Days 8–14\nWrite a one-sentence promise and build a simple prototype. Ask five prospective users to complete the core task. Define a measurable success threshold before you run the pilot.\n\n03 — Deliver the outcome · Days 15–23\nRun a small, hands-on pilot with three users. Deliver the result manually where possible. Track completion, repeated use, time saved, and willingness to commit.\n\n04 — Decide with evidence · Days 24–30\nCompare results with your original threshold. Continue if the behavior supports the idea; revise the audience or offer if it does not. Document what you still do not know.\n\nKeep in mind\nThese sample sizes are a starting point, not statistical validation. Positive feedback is weaker evidence than repeated use or a concrete commitment.\n\nYour first move: name the customer segment and the one problem you want to test.';
function Mark({ id, small = false }: { id?: ProviderId; small?: boolean }) { const p = providers.find(p => p.id === id); return <span className={`model-mark ${small ? 'small' : ''}`} style={{ color: p?.color ?? '#c4bbff', background: (p?.color ?? '#aa99ff') + '14' }}>{p?.mark ?? '◈'}</span>; }

function browserTimeZone(): string | undefined { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } }

export default function Home({ account }: { account?: { userId: string; displayName: string; email: string } }) {
  const [branchPoint, setBranchPoint] = useState<number | null>(null);
  const [draftDestination, setDraftDestination] = useState<DraftDestination | null>(null);
  const [connections, setConnections] = useState<Connections>(freshConnections);
  const [sessionQuery, setSessionQuery] = useState(''), [sessionAction, setSessionAction] = useState<SessionAction>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const personalMemory = usePersonalMemory(account?.userId);
  const memoryStatus = personalMemory.loading ? 'Loading…' : personalMemory.error || !personalMemory.profile ? 'Unavailable' : personalMemory.profile.enabled ? 'On' : 'Off';
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [settings, setSettings] = useState(false), [help, setHelp] = useState(false);
  const [demo, setDemo] = useState(true), [mode, setMode] = useState<Mode>('council'), [lead, setLead] = useState<ProviderId>('claude');
  const [prompt, setPrompt] = useState(''), [context, setContext] = useState<{ name: string; text: string } | null>(null);
  const [contextLoading, setContextLoading] = useState(false), contextVersion = useRef(0);
  const [instructions, setInstructions] = useState('');
  const [researchProvider, setResearchProvider] = useState<ResearchChoice>('auto');
  const [webResearch, setWebResearch] = useState(false);
  const [attachedImage, setAttachedImage] = useState<AttachedImage | null>(null), [imageLoading, setImageLoading] = useState(false);
  const [attachedPdf, setAttachedPdf] = useState<AttachedPdf | null>(null), [pdfLoading, setPdfLoading] = useState(false);
  const pdfRef = useRef<HTMLInputElement>(null), pdfVersion = useRef(0);
  const attachmentsTooLarge = attachmentBytes(attachedImage, attachedPdf) > maxAttachmentBytes;
  const imageRef = useRef<HTMLInputElement>(null), imageVersion = useRef(0);
  const [sessions, setSessions] = useState<Session[]>([]), [current, setCurrent] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]), [busy, setBusy] = useState(false), [stage, setStage] = useState('');
  const followUpContext = useMemo(() => conversationContext(turns), [turns]);
  const [working, setWorking] = useState<Result | null>(null), [runningQuestion, setRunningQuestion] = useState(''), [tab, setTab] = useState('answer');
  const [remember, setRemember] = useState(false), [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [clearHistory, setClearHistory] = useState(false), [runMode, setRunMode] = useState<Mode>('council');
  const abortRef = useRef<AbortController | null>(null), fileRef = useRef<HTMLInputElement>(null), promptRef = useRef<HTMLTextAreaElement>(null);
  const newConversationBlocked = !current && sessions.length >= 30;
  const hasDraft = Boolean(prompt || context || attachedImage || attachedPdf || contextLoading || imageLoading || pdfLoading || (!current && instructions));
  const connected = providers.filter(p => connections[p.id].key.trim() && connections[p.id].enabled).length;
  const cloud = useAccountWorkspace(account?.userId, sessions, saved => {
    setSessions(saved); setTurns([]); setCurrent(null); setInstructions(''); setWorking(null); setPrompt(''); clearContext(); clearImage(); clearPdf(); setLoaded(true);
  });
  useEffect(() => {
    if (account) return;
    try {
      const enabled = localStorage.getItem('trio-remember') === 'true'; setRemember(enabled);
      if (enabled) {
        const saved = parseSessions(localStorage.getItem('trio-sessions')); setSessions(saved);
        const active = localStorage.getItem('trio-active-session');
        const restored = active === null ? saved[0] : saved.find(s => s.id === active);
        if (restored) { setInstructions(restored.instructions ?? restored.turns.at(-1)?.instructions ?? ''); setCurrent(restored.id); setTurns(restored.turns); setStage('done'); setTab(restored.turns.at(-1)?.mode === 'compare' ? 'drafts' : 'answer'); }
      }
    } catch {} setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded || account) return;
    try {
      const snapshot = remember ? serializeSessions(sessions) : null;
      localStorage.setItem('trio-remember', String(remember));
      if (snapshot !== null) { localStorage.setItem('trio-sessions', snapshot); localStorage.setItem('trio-active-session', current ?? ''); }
      else { localStorage.removeItem('trio-sessions'); localStorage.removeItem('trio-active-session'); }
      setStorageError(false);
    } catch { setStorageError(true); }
  }, [sessions, remember, loaded, current, account]);
  useEffect(() => () => { abortRef.current?.abort(); contextVersion.current++; imageVersion.current++; pdfVersion.current++; }, []);
  useEffect(() => {
    if (!hasDraft && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasDraft, busy]);
  function clearContext() { contextVersion.current++; setContext(null); setContextLoading(false); }
  function clearPdf() { pdfVersion.current++; setAttachedPdf(null); setPdfLoading(false); }
  function clearImage() { imageVersion.current++; setAttachedImage(null); setImageLoading(false); }
  function newSession() { if (busy) return; setTurns([]); setInstructions(''); setCurrent(null); setWorking(null); setPrompt(''); clearContext(); clearImage(); clearPdf(); setRunningQuestion(''); promptRef.current?.focus(); }
  function navigate(destination: DraftDestination) {
    if (busy) return;
    if (destination.type === 'new') newSession();
    else {
      const session = sessions.find(s => s.id === destination.id);
      if (!session) { toast.error('That conversation is no longer available. Your draft is still here.'); setDraftDestination(null); return; }
      setCurrent(session.id); setInstructions(session.instructions ?? session.turns.at(-1)?.instructions ?? ''); setTurns(session.turns);
      setWorking(null); setRunningQuestion(''); setPrompt(''); clearContext(); clearImage(); clearPdf(); setStage('done'); setTab(session.turns.at(-1)?.mode === 'compare' ? 'drafts' : 'answer');
    }
    setDraftDestination(null);
  }
  function requestNavigation(destination: DraftDestination) {
    if (busy) return;
    if (destination.type === 'session' && destination.id === current) { promptRef.current?.focus(); return; }
    if (hasDraft) setDraftDestination(destination); else navigate(destination);
  }
  function changeInstructions(value: string) { if (busy) return; setInstructions(value); if (current) setSessions(prev => prev.map(s => s.id === current ? { ...s, instructions: value } : s)); }
  function createBranch(name: string) {
    if (busy || branchPoint === null || !current) return;
    try {
      const copy = branchConversation(sessions, current, branchPoint, name);
      setSessions(copy.sessions); setCurrent(copy.session.id); setTurns(copy.session.turns); setInstructions(copy.session.instructions ?? '');
      setMode(copy.session.turns.at(-1)!.mode); setWorking(null); setRunningQuestion(''); setPrompt(''); setSessionQuery('');
      clearContext(); clearImage(); clearPdf(); setStage('done'); setTab(copy.session.turns.at(-1)!.mode === 'compare' ? 'drafts' : 'answer'); setBranchPoint(null);
      toast.success('New conversation created. Your original is unchanged.'); promptRef.current?.focus();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not create the conversation.'); }
  }
  function saveFeedback(index: number, feedback: Feedback | null): boolean {
    if (busy || !current) return false;
    try {
      const updated = setAnswerFeedback(sessions, current, index, feedback);
      setSessions(updated); setTurns(updated.find(s => s.id === current)!.turns);
      toast.success(feedback ? 'Feedback recorded. Memory changes still need your review.' : 'Feedback removed from this answer.');
      return true;
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not record feedback.'); return false; }
  }
  function saveTurn(question: string, result: Result) { const next = [...turns, { question, result, mode, ...(!result.demo && instructions.trim() ? { instructions: instructions.trim() } : {}), ...(!result.demo && attachedImage ? { imageName: attachedImage.name } : {}), ...(!result.demo && attachedPdf ? { pdfName: attachedPdf.name } : {}) }]; setTurns(next); const id = current ?? crypto.randomUUID(); setCurrent(id); setSessions(prev => [{ id, instructions, title: prev.find(s => s.id === id)?.title ?? next[0].question, turns: next, time: new Date().toISOString() }, ...prev.filter(s => s.id !== id)]); }
  async function delay(ms: number, signal: AbortSignal) { await new Promise<void>((resolve, reject) => { if (signal.aborted) return reject(new DOMException('Cancelled', 'AbortError')); const cancel = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); }; const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms); signal.addEventListener('abort', cancel, { once: true }); }); }
  async function run() {
    if (busy || imageLoading || contextLoading || pdfLoading) return;
    if (newConversationBlocked) { toast('Your workspace has 30 conversations. Back up and delete one before starting another.'); return; }
    if (attachmentsTooLarge) { toast.error('Images and PDFs together must be under 4 MB. Remove or replace a file.'); return; }
    const question = demo ? demoQuestion : prompt.trim();
    if (!question) return;
    if (!demo && !connected) { setSettings(true); toast('Add an API key to start a live session.'); return; }
    let researcher: 'openai' | 'claude' | undefined;
    if (!demo && webResearch) { try { researcher = selectResearchProvider(connections, researchProvider); } catch (error) { setSettings(true); toast.error(error instanceof Error ? error.message : 'Connect a research provider.'); return; } }
    setBusy(true); setRunMode(mode); setStage(!demo && webResearch ? 'research' : 'draft'); setWorking({ ...emptyResult(demo), researchRequested: !demo && webResearch, researchBy: researcher }); setRunningQuestion(question); setTab('drafts');
    const controller = new AbortController(); abortRef.current = controller;
    let result = emptyResult(demo);
    try {
      if (demo) {
        for (let i = 0; i < providers.length; i++) { await delay(500, controller.signal); result = { ...result, drafts: { ...result.drafts, [providers[i].id]: demoDrafts[i] } }; setWorking(result); }
        if (mode === 'council' || mode === 'deep') { setStage('review'); for (let i = 0; i < providers.length; i++) { await delay(400, controller.signal); result = { ...result, reviews: { ...result.reviews, [providers[i].id]: demoReviews[i] } }; setWorking(result); } }
        if (mode === 'deep') { setStage('revision'); for (let i = 0; i < providers.length; i++) { await delay(400, controller.signal); result = { ...result, revisions: { ...result.revisions, [providers[i].id]: demoRevisions[i] } }; setWorking(result); } }
        if (mode !== 'compare') { setStage('synthesis'); setTab('answer'); await delay(700, controller.signal); result = { ...result, answer: demoFinal, by: lead }; }
        result.seconds = mode === 'deep' ? 4.6 : mode === 'council' ? 3.4 : mode === 'fast' ? 2.2 : 1.5;
      } else {
        const history = followUpContext.messages;
        result = await runLiveRequest(JSON.stringify({ timeZone: browserTimeZone(), personalize: Boolean(account), question, instructions: instructions.trim(), webResearch, researchProvider, context: context?.text, pdf: attachedPdf ? { mimeType: attachedPdf.mimeType, data: attachedPdf.data } : undefined, image: attachedImage ? { mimeType: attachedImage.mimeType, data: attachedImage.data } : undefined, history, connections, mode, lead }), { 'Content-Type': 'application/json', ...(account ? { 'X-Trio-Account': account.userId } : {}) }, controller.signal, event => {
          if (event.type === 'stage') { setStage(event.stage!); if (event.stage === 'synthesis') setTab('answer'); }
          result = applyRunEvent(result, event);
          if (event.type === 'final' && mode !== 'compare') setTab('answer');
          setWorking({ ...result });
        });
      }
      saveTurn(question, result); setWorking(null); setRunningQuestion(''); if (!demo) setPrompt(''); setStage('done');
    } catch (error) { if (controller.signal.aborted) { toast('Session stopped. No result was saved.'); setWorking({ ...result, errors: [...result.errors, 'Session stopped. Partial contributions are shown below.'] }); } else { const text = error instanceof Error ? error.message : 'Something went wrong.'; toast.error(text); setWorking({ ...result, errors: [...result.errors, text] }); } setStage('failed'); }
    finally { setBusy(false); abortRef.current = null; }
  }
  async function attach(file?: File) {
    if (!file || busy) return;
    const version = ++contextVersion.current; setContextLoading(false);
    if (!/\.(txt|md|csv|json|js|ts|tsx|py|html|css)$/i.test(file.name)) return toast.error('Choose a text, Markdown, CSV, JSON, or code file.');
    if (file.size > 60000) return toast.error('Use a text file smaller than 60 KB.');
    setContextLoading(true);
    try { const text = await file.text(); if (version === contextVersion.current) setContext({ name: file.name, text }); }
    catch { if (version === contextVersion.current) toast.error('Could not read this text file. Choose the file again.'); }
    finally { if (version === contextVersion.current) setContextLoading(false); }
  }
  async function attachImage(file?: File) {
    if (!file || busy) return;
    const version = ++imageVersion.current; setImageLoading(true);
    try { const image = await readImageFile(file); if (version === imageVersion.current) setAttachedImage(image); }
    catch (error) { if (version === imageVersion.current) toast.error(error instanceof Error ? error.message : 'Could not load this image.'); }
    finally { if (version === imageVersion.current) setImageLoading(false); }
  }
  async function attachPdf(file?: File) {
    if (!file || busy) return;
    const version = ++pdfVersion.current; setPdfLoading(true);
    try { const pdf = await readPdfFile(file); if (version === pdfVersion.current) setAttachedPdf(pdf); }
    catch (error) { if (version === pdfVersion.current) toast.error(error instanceof Error ? error.message : 'Could not read this PDF.'); }
    finally { if (version === pdfVersion.current) setPdfLoading(false); }
  }
  async function copy(text: string) { try { await navigator.clipboard.writeText(text); toast.success('Copied to clipboard'); } catch { toast.error('Clipboard unavailable. Select and copy the answer manually.'); } }
  function downloadSession(savedTurns: Turn[]) { const url = URL.createObjectURL(new Blob([sessionMarkdown(savedTurns)], { type: 'text/markdown' })); const a = document.createElement('a'); a.href = url; a.download = 'trio-session.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  function exportSession() { downloadSession(turns); }
  const displayed = working ?? turns.at(-1)?.result;
  const question = runningQuestion || turns.at(-1)?.question;
  const displayMode = working ? runMode : turns.at(-1)?.mode ?? mode;

  // Do not expose editable server-rendered controls before event handlers and
  // saved sessions are ready: hydration can otherwise erase an early question.
  if (!loaded || (account && !cloud.ready)) return <main className="account-loading"><h1>Your Trio workspace</h1><p role="status">{account ? cloud.status : 'Getting your workspace ready…'}</p>{account && cloud.error ? <><p role="alert">{cloud.error}</p><button className="run-button" onClick={cloud.reload}>Retry loading</button></> : <p>If loading does not finish, <a href={account ? '/workspace' : '/demo'}>reload your workspace</a>.</p>}<noscript><p>Trio needs JavaScript to run. Enable it in your browser, then reload this page.</p></noscript>{account && <a href="/signout-with-chatgpt?return_to=%2F">Sign out</a>}</main>;
  return <SidebarProvider style={{ '--sidebar-width': '248px' } as React.CSSProperties}>
    <Sidebar className="trio-sidebar">
      <SidebarHeader className="brand"><span className="brand-symbol">◈</span><span>trio<span className="brand-period">.</span></span><span className="brand-caption">WORKSPACE</span></SidebarHeader>
      <SidebarContent className="side-content">
        <NewSessionButton busy={busy} onRequest={() => requestNavigation({ type: 'new' })} />
        <div className="side-label">YOUR WORKSPACE</div>
        <button className="side-nav selected" onClick={() => promptRef.current?.focus()}><Layers3 size={17} /> Collective intelligence</button>
        <button className="side-nav" onClick={() => setSettings(true)}><Settings2 size={17} /> Model connections <span className="nav-count">{connected}/3</span></button>
        {account && <button className="side-nav" disabled={busy} onClick={() => setMemoryOpen(true)}><Lightbulb size={17} />Personal memory<span className="nav-count" role="status">{memoryStatus}</span></button>}
        <button className="side-nav" disabled={busy} onClick={() => setBackupsOpen(true)}><Archive size={17} />Back up & restore</button>
        <div className="history-heading"><span className="side-label">RECENT SESSIONS</span>{sessions.length > 0 && <button aria-label="Clear session history" disabled={busy} onClick={() => setClearHistory(true)}><Trash2 size={14} /></button>}</div>
        <SessionList sessions={sessions} current={current} busy={busy} query={sessionQuery} onQuery={setSessionQuery} onSelect={s => requestNavigation({ type: 'session', id: s.id })} onAction={setSessionAction} onExport={s => downloadSession(s.turns)} />
        <div className="sidebar-bottom-card"><span className="tiny-orbits">◎ <span>✳</span> ✦</span><strong>Different perspectives.<br />A stronger answer.</strong><p>Independent thinking.<br />Collective intelligence.</p><button onClick={() => setHelp(true)}>How Trio works <ChevronRight size={14} /></button></div>
      </SidebarContent>
      <SidebarFooter className="sidebar-foot"><span className="avatar">Y</span><div title={account?.email}>{account?.displayName ?? "Guest workspace"}<small><ShieldCheck size={12} /> {account ? cloud.status : "Stored on this device"}</small>{account ? <a href="/signout-with-chatgpt?return_to=%2F" onClick={e => { if (busy || cloud.status === "Saving…") { e.preventDefault(); toast("Wait for the current run and save to finish before signing out."); } else if (cloud.error && !window.confirm("Some changes have not saved. Sign out anyway? Download a backup first to keep them.")) e.preventDefault(); }}>Sign out</a> : <a href="/signin-with-chatgpt?return_to=%2Fworkspace">Sign in to save online</a>}</div><button aria-label="About Trio" onClick={() => setHelp(true)}><CircleHelp size={17} /></button></SidebarFooter>
    </Sidebar>
    <main className="workspace">
      <header className="topbar"><div className="breadcrumb"><SidebarTrigger className="mobile-menu" /><span>Workspace</span><ChevronRight size={14} /><strong>New possibilities</strong></div><div className="top-actions"><span className={`mode-badge ${demo ? '' : 'live'}`}>{demo ? 'Demo workspace' : 'Live workspace'}</span><button className="subtle-button" aria-label="Connections" onClick={() => setSettings(true)}><Settings2 size={15} /><span>Connections</span></button></div></header>
      <div className="work-body">
        {sessions.length >= 30 && <div className="session-capacity" role="status"><strong>Conversation limit reached</strong><p>All 30 conversations are kept. You can continue an existing discussion, or back up and delete one before starting another.</p><button className="subtle-button" disabled={busy} onClick={() => setBackupsOpen(true)}>Back up conversations</button></div>}
        {account && cloud.error && <div className="error-box" role="alert"><strong>Account history needs attention</strong><p>{cloud.error}</p><button disabled={busy} onClick={() => setBackupsOpen(true)}>Download a backup</button>{cloud.conflict ? <button disabled={busy} onClick={() => { if (window.confirm("Replace this tab’s sessions with the latest account history? Download a backup first to keep unsaved changes. Your unsent question, attached files, and new-conversation instructions will be cleared; copy them first if needed.")) cloud.reload(); }}>Load latest workspace</button> : <button onClick={cloud.retry}>Retry saving</button>}</div>}
        {storageError && <div className="error-box" role="alert"><strong>Browser history could not be updated</strong><p>{remember ? 'Recent changes are only in this tab. Export important sessions before closing or refreshing; the previous saved copy may be older.' : 'Browser storage is unavailable. Previously saved history may still be on this device.'}</p>{turns.length > 0 && <button onClick={exportSession}>Export current session</button>}</div>}
        <div className="page-intro"><div><div className="eyebrow"><span className="mini-line" /> COLLECTIVE INTELLIGENCE</div><h1>One question. <span>Three perspectives.</span></h1><p>Bring your biggest ideas. Let the best minds work together.</p></div><span className="intro-symbol" aria-hidden>◈</span></div>
        <section className="models-grid" aria-label="Your AI team">{providers.map(p => <button key={p.id} className={`model-card ${!connections[p.id].enabled && !demo ? 'muted-card' : ''}`} onClick={() => setSettings(true)} style={{ '--model-color': p.color } as React.CSSProperties}><div className="model-card-top"><Mark id={p.id} /><span className="provider-status">{busy ? (working?.drafts[p.id] ? (stage === 'draft' ? 'Writing…' : 'Draft ready') : !demo && (!connections[p.id].enabled || !connections[p.id].key) ? 'Not participating' : 'Working…') : demo ? 'Demo' : connections[p.id].enabled && connections[p.id].key ? 'Key added' : 'Not connected'}</span></div><div className="model-name">{p.name}<span>{p.company}</span></div><p>{p.id === 'openai' ? 'Explore possibilities. Build the plan.' : p.id === 'claude' ? 'Examine the details. Challenge assumptions.' : 'Connect ideas. Find a fresh perspective.'}</p><div className="model-card-foot"><span>{demo ? 'Illustrative participant' : connections[p.id].model}</span><Plus size={14} /></div></button>)}</section>
        <section className="prompt-section"><div className="section-heading"><h2>{turns.length ? 'Keep the conversation going' : 'What are we working on?'}</h2><span>01 / ASK</span></div><div className="composer"><textarea ref={promptRef} value={prompt} maxLength={20000} disabled={busy} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void run(); } }} placeholder="A complex question, an ambitious idea, a problem worth solving…" aria-label="Your question" />{attachedImage && <div className="image-context"><img src={'data:' + attachedImage.mimeType + ';base64,' + attachedImage.data} alt="Attached image preview" /><div><strong>{attachedImage.name}</strong><p>{demo ? 'Demo ignores this image. Switch to Live in Connections to analyze it.' : 'Included in each step and follow-up until removed. Images add API usage.'}</p><small>Image data stays out of saved history. Reattach after refreshing.</small></div><button aria-label="Remove image" disabled={busy} onClick={clearImage}><X size={16} /></button></div>}{(attachedPdf || pdfLoading) && <div className="image-context pdf-context"><FileText size={36} aria-hidden="true" /><div><strong role="status">{pdfLoading ? 'Loading PDF…' : attachedPdf?.name}</strong><p>{demo ? 'Demo ignores this PDF. Switch to Live in Connections to analyze it.' : 'Included in each step and follow-up until removed. PDF pages add API usage.'}</p><small>Use an unencrypted PDF within your model’s page limit. Only the filename is saved.</small></div><button aria-label="Remove PDF" disabled={busy} onClick={clearPdf}><X size={16} /></button></div>}{attachmentsTooLarge && <p className="attachment-limit" role="alert">Images and PDFs together must be under 4 MB. Remove or replace a file.</p>}<div className="composer-bottom"><input ref={fileRef} type="file" disabled={busy} aria-label="Choose text context" accept=".txt,.md,.csv,.json,.js,.ts,.tsx,.py,.html,.css" hidden onChange={e => { void attach(e.target.files?.[0]); e.target.value = ''; }} /><button className="attach-button" onClick={() => fileRef.current?.click()} disabled={busy} title="Attach a text file"><Paperclip size={17} /><span>Add context</span></button><input ref={imageRef} type="file" disabled={busy} accept="image/png,image/jpeg,image/webp" aria-label="Choose image" hidden onChange={e => { void attachImage(e.target.files?.[0]); e.target.value = ''; }} /><button className="attach-button" onClick={() => imageRef.current?.click()} disabled={busy || imageLoading} title="PNG, JPEG, or WebP under 4 MB"><Plus size={17} /><span>{imageLoading ? 'Loading image…' : 'Add image'}</span></button><input ref={pdfRef} type="file" disabled={busy} accept="application/pdf,.pdf" aria-label="Choose PDF" hidden onChange={e => { void attachPdf(e.target.files?.[0]); e.target.value = ''; }} /><button className="attach-button" onClick={() => pdfRef.current?.click()} disabled={busy} title="Unencrypted PDF; images and PDFs together under 4 MB"><FileText size={17} /><span>Add PDF</span></button>{(context || contextLoading) && <span className="attachment"><span role="status">{contextLoading ? 'Loading context…' : context?.name}</span><button aria-label="Remove attachment" disabled={busy} onClick={clearContext}><X size={13} /></button></span>}<span className="key-hint">⌘ / Ctrl + Enter</span>{busy ? <button className="run-button" onClick={() => abortRef.current?.abort()}><Square size={14} /> Stop</button> : <button className="run-button" disabled={newConversationBlocked || imageLoading || contextLoading || pdfLoading || attachmentsTooLarge || (!demo && !prompt.trim())} onClick={() => void run()}>{demo ? 'Run demo' : 'Ask Trio'}<ArrowUp size={17} /></button>}</div></div><div className="composer-note">{demo ? <>Demo runs a prepared product-validation example. <button onClick={() => setSettings(true)}>Connect models to ask your own question <ChevronRight size={12} /></button></> : <>Prompts and attachments go to enabled providers. {modes[mode].calls}{webResearch ? "; research adds up to two API calls and search charges" : ""}; each provider bills separately.</>}</div></section>
        <div className="creation-tools"><AudioTranscription accountId={account?.userId} apiKey={connections.openai.enabled ? connections.openai.key : ''} live={!demo} disabled={busy} question={prompt} onAppend={value => { setPrompt(value); promptRef.current?.focus(); }} onConnections={() => setSettings(true)} /><ImageGeneration accountId={account?.userId} apiKey={connections.openai.enabled ? connections.openai.key : ''} live={!demo} disabled={busy || imageLoading || pdfLoading} question={prompt} replacingImage={Boolean(attachedImage)} onAttach={image => { if (attachmentBytes(image, attachedPdf) > maxAttachmentBytes) throw new Error('This image and your PDF together exceed 4 MB. Download the image, then remove or replace the PDF before attaching it.'); imageVersion.current++; setAttachedImage(image); setImageLoading(false); }} onConnections={() => setSettings(true)} /></div>
        {!demo && turns.length > 0 && <FollowUpContext context={followUpContext} />}
        <SessionInstructions key={current ?? 'new'} value={instructions} busy={busy} demo={demo} onChange={changeInstructions} />
        <section className="collaboration-settings"><div className="flow-label"><span>COLLABORATION MODE</span><small>{modes[mode].desc}</small></div><Tabs value={mode} onValueChange={v => setMode(v as Mode)}><TabsList className="mode-tabs">{Object.entries(modes).map(([key, m]) => <TabsTrigger key={key} value={key} disabled={busy}><m.icon size={15} />{m.title}</TabsTrigger>)}</TabsList></Tabs></section>
        <section className="research-setting"><div><label htmlFor="web-research">Web research</label><p>OpenAI or Claude searches first. Every model receives the same cited brief.</p><small>{demo ? 'Available in Live mode. Demo never searches.' : 'Adds up to two API calls; search fees apply.'}</small></div><div className="research-controls">{webResearch && !demo && <label>Research provider<select aria-label="Research provider" value={researchProvider} disabled={busy} onChange={e => setResearchProvider(e.target.value as ResearchChoice)}><option value="auto">Automatic · OpenAI, then Claude</option><option value="openai">OpenAI</option><option value="claude">Claude</option></select></label>}<Switch id="web-research" aria-label="Web research" checked={webResearch} onCheckedChange={setWebResearch} disabled={busy || demo} /></div></section>
        {!displayed && <section className="starter-section"><div className="section-heading"><h2>A starting point for your next big thing</h2><span>TRY AN IDEA</span></div><div className="ideas-grid">{[{ icon: Lightbulb, label: 'Shape an idea', text: 'Turn a rough idea into a real plan.', prompt: demoQuestion }, { icon: Code2, label: 'Build something', text: 'Solve a technical challenge together.', prompt: 'Design a secure, simple architecture for a team knowledge-sharing app. Compare the tradeoffs and propose an implementation plan.' }, { icon: Compass, label: 'Think it through', text: 'See a decision from every angle.', prompt: 'Help me decide whether to build a custom tool or buy existing software. Create a decision framework and identify the questions I should answer first.' }].map(item => <button key={item.label} onClick={() => { setPrompt(item.prompt); if (demo && item.prompt !== demoQuestion) toast('Connect models to run this prompt live. Demo uses the product-validation example.'); promptRef.current?.focus(); }}><item.icon size={19} /><strong>{item.label}<ChevronRight size={15} /></strong><p>{item.text}</p></button>)}</div></section>}
        {displayed && <section className="results-section"><div className="question-title"><MessageSquare size={17} /><h2>{question}</h2></div>{displayed.demo && <div className="demo-notice">ILLUSTRATIVE DEMO · Prepared sample responses. No model APIs were called.</div>}<RunPipeline result={displayed} mode={displayMode} busy={busy} stage={stage} />{!busy && !working && <RunCoverage result={displayed} mode={displayMode} />}
          {displayed.researchRequested && <ResearchPanel research={displayed.research} provider={displayed.researchBy} loading={busy && stage === "research"} />}
          <Tabs value={tab} onValueChange={setTab}>{busy && !demo && <p className="revision-note">Responses are arriving live. Partial text may change; only completed runs are saved.</p>}<div className="result-toolbar"><TabsList className="result-tabs"><TabsTrigger value="answer">Synthesis</TabsTrigger><TabsTrigger value="drafts">Perspectives <span>{Object.keys(displayed.drafts).length}</span></TabsTrigger><TabsTrigger value="reviews">Peer reviews <span>{Object.keys(displayed.reviews).length}</span></TabsTrigger>{displayMode === 'deep' && <TabsTrigger value="revisions">Revisions <span>{Object.keys(displayed.revisions ?? {}).length}</span></TabsTrigger>}</TabsList><div className="result-actions">{!working && !displayed.demo && turns.length > 0 && <button className="branch-latest" disabled={busy} onClick={() => setBranchPoint(turns.length - 1)}>Continue from here ↗</button>}<button aria-label="Copy answer" disabled={!displayed.answer} onClick={() => void copy(displayed.answer)}><Copy size={16} /></button><button aria-label="Export session as Markdown" disabled={!turns.length || busy} onClick={exportSession}><Download size={16} /></button></div></div>
          <TabsContent value="answer"><div className="answer-card"><div className="answer-heading"><Mark small /><div><strong>{answerLabel(displayed)}</strong><small>{busy ? 'Your team is working on it…' : displayed.by ? `Written by ${providers.find(p => p.id === displayed.by)?.name} · ${displayed.seconds}s${displayed.demo ? ' · sample' : ''}` : 'Independent perspectives'}</small></div><span className="answer-tag">{displayed.demo ? 'DEMO' : 'TRIO'}</span></div>{displayed.answer ? <Prose text={displayed.answer} /> : <div className="answer-empty">{busy ? <><span className="loading-bar" />{stage === 'research' ? 'Gathering a cited web-research brief…' : stage === 'draft' ? 'Gathering independent perspectives…' : stage === 'review' ? 'Checking the answers for gaps and disagreements…' : stage === 'revision' ? 'Revising answers in response to the critiques…' : 'Combining the strongest ideas…'}</> : displayMode === 'compare' ? <>Compare mode keeps each perspective independent. <button onClick={() => setTab('drafts')}>Read the perspectives →</button></> : 'No combined answer yet. Check the messages below, then retry.'}</div>}</div></TabsContent>
          <TabsContent value="drafts"><div className="perspective-grid">{providers.map(p => <article key={p.id} className="perspective-card"><div><Mark small id={p.id} /><strong>{p.name}</strong></div>{displayed.drafts[p.id] ? <Prose text={displayed.drafts[p.id]!} /> : <p className="muted">{busy ? 'Waiting for this perspective…' : 'No contribution from this model.'}</p>}</article>)}</div></TabsContent>
          <TabsContent value="reviews"><div className="perspective-grid">{Object.keys(displayed.reviews).length ? providers.filter(p => displayed.reviews[p.id]).map(p => <article key={p.id} className="perspective-card"><div><Mark small id={p.id} /><strong>{p.name}’s review</strong></div><Prose text={displayed.reviews[p.id]!} /></article>) : <p className="muted">{['council', 'deep'].includes(displayMode) ? 'Reviews appear after at least two models finish their drafts.' : 'Choose Council or Deep Council to include peer review in your next run.'}</p>}</div></TabsContent>
          {displayMode === 'deep' && <TabsContent value="revisions"><p className="revision-note">Revised answers respond to the peer critiques. Original answers remain in Perspectives; agreement still needs verification.</p><div className="perspective-grid">{providers.filter(p => displayed.drafts[p.id]).map(p => <article key={p.id} className="perspective-card"><div><Mark small id={p.id} /><strong>{p.name}'s revision</strong></div>{displayed.revisions?.[p.id] ? <Prose text={displayed.revisions[p.id]!} /> : <p className="muted">{busy ? 'Revisions follow the peer reviews…' : 'No revised answer returned. The original perspective remains available.'}</p>}</article>)}</div></TabsContent>}
          </Tabs>
          {!working && <><InstructionsUsed value={turns.at(-1)?.instructions} /><MemoryUsed value={turns.at(-1)?.result.memory} /></>}
          {!working && turns.at(-1)?.imageName && <p className="revision-note">Image used: {turns.at(-1)?.imageName}. Image data is not saved; reattach it to revisit visual details.</p>}{!working && turns.at(-1)?.pdfName && <p className="revision-note">PDF used: {turns.at(-1)?.pdfName}. PDF data is not saved; reattach it to revisit document details.</p>}{displayed.usage && !displayed.demo && <UsageSummary usage={displayed.usage} />}
          {displayed.errors.length > 0 && <div className="error-box" role="alert"><strong>Some steps could not finish</strong>{Array.from(new Set(displayed.errors)).map((e, i) => <p key={i}>{e}</p>)}<button onClick={() => setSettings(true)}>Check connections</button></div>}
          {!busy && !working && !displayed.demo && (displayed.answer || Object.values(displayed.drafts).some(Boolean)) && <AnswerFeedback key={current + ':' + (turns.length - 1)} value={turns.at(-1)?.feedback} busy={busy} account={!!account} onSave={value => saveFeedback(turns.length - 1, value)} />}
          <ConversationHistory account={!!account} onFeedback={saveFeedback} key={current ?? 'new'} turns={working ? turns : turns.slice(0, -1)} busy={busy} onBranch={current ? setBranchPoint : undefined} />
        </section>}
        <footer className="workspace-footer"><span><ShieldCheck size={13} /> Your keys. Your workspace.</span><span>Different models can make the same mistake. Verify important answers.</span></footer>
      </div>
    </main>
    <DraftNavigation destination={draftDestination} onCancel={() => setDraftDestination(null)} onDiscard={() => { if (draftDestination) navigate(draftDestination); }} onFocus={() => promptRef.current?.focus()} />
    <SessionActionDialogs action={sessionAction} sessions={sessions} busy={busy} clearsDraft={hasDraft && sessionAction?.id === current} onClose={() => setSessionAction(null)} onRename={(id, title) => { if (busy) return; try { setSessions(renameSession(sessions, id, title)); setSessionAction(null); toast.success('Session renamed'); } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not rename this session.'); } }} onDelete={id => { if (busy) return; setSessions(prev => prev.filter(s => s.id !== id)); if (current === id) newSession(); setSessionAction(null); toast.success('Session deleted'); }} />
    {account && <PersonalMemory accountId={account.userId} open={memoryOpen} onOpenChange={setMemoryOpen} memory={personalMemory} connections={connections} sessionId={current} sessionSaved={cloud.status === "Saved to your account"} busy={busy} />}
    <SessionBackups sessions={sessions} busy={busy} remember={account ? true : remember} account={Boolean(account)} open={backupsOpen} onOpenChange={setBackupsOpen} onImport={incoming => { if (busy) return; setSessions(mergeBackup(sessions, incoming).sessions); }} />
    <BranchConversation source={sessions.find(s => s.id === current)} turnIndex={branchPoint} count={sessions.length} busy={busy} hasUnsent={Boolean(prompt || context || attachedImage || attachedPdf || contextLoading || imageLoading || pdfLoading)} onClose={() => setBranchPoint(null)} onCreate={createBranch} />
    <Dialog open={settings} onOpenChange={setSettings}><DialogContent className="connections-dialog"><DialogTitle>Connect your AI team</DialogTitle><DialogDescription>Use API keys from each provider. Consumer subscriptions and API billing are separate. Keys stay in this tab’s memory and are sent securely to the server only to make your requests.</DialogDescription><div className="connection-mode"><div><strong>Demo mode</strong><p>Explore the workflow with prepared examples.</p></div><Switch checked={demo} disabled={busy} onCheckedChange={setDemo} aria-label="Demo mode" /></div><p className="connection-guidance">1. Get an API key. 2. Paste it below and check access. 3. Turn off Demo mode to ask your own questions. One provider is enough to start.</p><p className="connection-guidance">Access checks look up model details. They do not verify billing, answer quality, or support for every Trio feature.</p>{providers.map(p => <ProviderConnection key={p.id} id={p.id} connection={connections[p.id]} disabled={busy} open={settings} onChange={value => setConnections(c => ({ ...c, [p.id]: value }))} />)}<div className="lead-setting"><label>Preferred synthesis model</label><Select value={lead} onValueChange={v => setLead(v as ProviderId)} disabled={busy}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{providers.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent></Select></div>{account ? <div className="connection-mode"><div><strong>Saved to your account</strong><p>Conversations sync online. API keys and original attachment files are never saved.</p></div></div> : <div className="connection-mode"><div><strong>Remember sessions on this device</strong><p>Stores prompts and answers locally. API keys are never saved.</p></div><Switch checked={remember} onCheckedChange={setRemember} aria-label="Remember sessions on this device" /></div>}<div className="dialog-actions"><button className="subtle-button" disabled={busy} onClick={() => { setConnections(freshConnections()); setDemo(true); toast('API keys cleared'); }}>Clear keys</button><button className="run-button" onClick={() => { setSettings(false); if (!demo && !connected) toast('Add at least one API key to run live.'); }}>Done<Check size={15} /></button></div></DialogContent></Dialog>
    <Dialog open={help} onOpenChange={setHelp}><DialogContent><DialogTitle>Three minds. One workspace.</DialogTitle><DialogDescription>Trio coordinates OpenAI, Anthropic, and Google model APIs.</DialogDescription><div className="help-steps"><p><strong>01 · Think independently</strong>Each enabled model answers your question with the same context.</p><p><strong>02 · Challenge the answers</strong>Council and Deep Council ask each model to review anonymized drafts and flag gaps or disagreements.</p><p><strong>03 · Revise with Deep Council</strong>Each model responds to the peer critiques with a revised answer and a short account of changes and unresolved questions. This adds up to three calls. Revisions appear in their own tab, with originals preserved.</p><p><strong>04 · Bring it together</strong>Your preferred model writes the final answer. If it fails, another participating model takes over.</p><p>Use Session instructions to set an audience, constraints, and preferred format for every live question in the current conversation. Changes apply to future questions; earlier answers retain the instructions they used. New sessions start blank.</p><p>Trio supports text, code, text-file context, image understanding, and native PDF understanding. Use Add PDF for an unencrypted document; the combined image and PDF limit is 4 MB. PDFs are sent at every stage and stay attached for follow-ups until removed; only filenames are saved. Models enforce their own page and context limits. Use Add image for a PNG, JPEG, or WebP under 4 MB. Images are sent at every stage and stay attached for follow-ups until removed; only their filenames are saved. Enable Web research in Live mode to have OpenAI or Claude search first and share a cited brief with every participant. It adds API and search charges. Sources are saved with your session; search access depends on your selected model and account. Use Create image to generate a JPEG with OpenAI, then download it or attach it for the team to review. Audio to text transcribes a recording with OpenAI for you to review before adding it to your question. Both require Live mode and an enabled OpenAI key, incur separate charges, and do not save the original media. Trio does not execute code. A shared answer can still be wrong.</p><p>API usage is billed by each provider. Connect only the models you want to use. {account ? "Completed conversations save to your private account history. API keys and original attachments are never saved." : "Guest sessions stay in memory unless you enable local history. Sign in for live models and account history."}</p></div></DialogContent></Dialog>
    <AlertDialog open={clearHistory} onOpenChange={setClearHistory}><AlertDialogContent><AlertDialogTitle>Clear session history?</AlertDialogTitle><AlertDialogDescription>{account ? "This deletes all sessions from your online account and clears the current conversation." : "This removes all saved sessions from this device and clears the current conversation."} Export any answers you want to keep first.{hasDraft && ' Your unsent question, attached files, and new-conversation instructions will also be cleared.'}</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>Keep sessions</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { setSessions([]); newSession(); toast('Session history cleared'); }}>Clear all sessions</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <Toaster theme="dark" position="bottom-right" richColors />
  </SidebarProvider>;
}
