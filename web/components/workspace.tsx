'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { QualityCheck } from '@/components/quality-check';
import { WorkComparison } from '@/components/work-comparison';
import { WorkflowBriefs } from '@/components/workflow-briefs';
import { WorkPlanPanel } from '@/components/work-plan';
import { WorkBoard } from '@/components/work-board';
import { ActionConfirmation } from '@/components/action-confirmation';
import { setWorkPlan, workSummary } from '@/lib/work-actions';
import type { WorkPlan } from '@/lib/work-plan';
import type { Input as RunInput } from '@/lib/orchestrate';
import { MessageSquare, Settings2, ChevronRight, Square } from 'lucide-react';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { AnswerReader as Prose } from '@/components/answer-reader';
import { UsageSummary } from '@/components/usage-summary';
import { InstructionsUsed, MemoryUsed } from '@/components/session-instructions';
import { SessionActionDialogs, type SessionAction } from '@/components/session-library';
import { renameSession } from '@/lib/session-library';
import { SessionBackups } from '@/components/session-backups';
import { mergeBackup } from '@/lib/backups';
import { selectResearchProvider, type ResearchChoice } from '@/lib/research';
import { RunCoverage, RunPipeline } from '@/components/run-coverage';
import { ResearchPanel } from '@/components/research-panel';
import { BranchConversation } from '@/components/branch-conversation';
import { DraftNavigation, type DraftDestination } from '@/components/draft-navigation';
import { branchConversation } from '@/lib/branch-conversation';
import { AnswerFeedback } from '@/components/answer-feedback';
import { setAnswerFeedback, type AnswerFeedback as Feedback } from '@/lib/answer-feedback';
import { ConversationHistory } from '@/components/conversation-history';
import { runLiveRequest } from '@/lib/run-live-request';
import { createRunPreview } from '@/lib/run-preview';
import { applyRunEvent } from '@/lib/run-events';
import { parseSessions, serializeSessions, conversationContext, sessionMarkdown, type Turn, type Session } from '@/lib/sessions';
import { Toaster, toast } from 'sonner';
import { PersonalMemory, usePersonalMemory } from '@/components/personal-memory';
import { useAccountWorkspace } from '@/components/use-account-workspace';
import { useSavedConnections } from '@/components/use-saved-connections';
import { useWorkspacePreferences } from '@/components/use-workspace-preferences';
import { AudioTranscription } from '@/components/audio-transcription';
import { ImageGeneration } from '@/components/image-generation';
import { providers, freshConnections, type Connections, type Mode, type Result } from '@/lib/trio';
import { applyWorkspaceConnections } from '@/lib/workspace-keys';
import { modes } from '@/components/answer-modes';
import { Composer } from '@/components/composer';
import { ConnectionsDialog } from '@/components/connections-dialog';
import { HelpDialog } from '@/components/help-dialog';
import { ResultTabs } from '@/components/result-tabs';
import { ToolsDialog } from '@/components/tools-dialog';
import { WorkspaceSidebar, type WorkspacePanel } from '@/components/workspace-sidebar';
import { useDraftAttachments } from '@/components/use-draft-attachments';
import { runDemo, demoQuestion } from '@/lib/demo-run';

const emptyResult = (demo: boolean): Result => ({ drafts: {}, reviews: {}, errors: [], answer: '', seconds: 0, demo });
type ReviewTarget = { result: Result; request: Pick<RunInput, 'question' | 'instructions' | 'context' | 'image' | 'pdf' | 'history' | 'webResearch' | 'researchProvider'>; imageName?: string; pdfName?: string };
const noTurns: Turn[] = [];

function browserTimeZone(): string | undefined { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } }

export default function Home({ account }: { account?: { userId: string; displayName: string; email: string } }) {
  const [qualityOpen, setQualityOpen] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
  const [workspaceRecovery, setWorkspaceRecovery] = useState<'reload' | 'signout' | null>(null);
  const [temporaryDemoAccount, setTemporaryDemoAccount] = useState<string | null>(null);
  const focusAfterReload = useRef(false);
  // Choices tied to one account never carry over to the next. Adjusting state while
  // rendering (not in an effect) avoids a render with the previous account's values.
  const [stateAccount, setStateAccount] = useState(account?.userId);
  if (stateAccount !== account?.userId) { setStateAccount(account?.userId); setWorkspaceRecovery(null); setTemporaryDemoAccount(null); }
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
  const [branchPoint, setBranchPoint] = useState<number | null>(null);
  const [draftDestination, setDraftDestination] = useState<DraftDestination | null>(null);
  const [connections, setConnections] = useState<Connections>(freshConnections);
  const savedConnections = useSavedConnections(account?.userId, setConnections);
  const [sessionQuery, setSessionQuery] = useState(''), [sessionAction, setSessionAction] = useState<SessionAction>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const personalMemory = usePersonalMemory(account?.userId);
  const memoryStatus = personalMemory.loading ? 'Loading…' : personalMemory.error || !personalMemory.profile ? 'Unavailable' : personalMemory.profile.enabled ? 'On' : 'Off';
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [mediaTool, setMediaTool] = useState<'audio' | 'image' | null>(null);
  const [settings, setSettings] = useState(false), [help, setHelp] = useState(false);
  const preferences = useWorkspacePreferences(account?.userId);
  const temporaryDemo = temporaryDemoAccount === (account?.userId ?? 'guest');
  const { mode, lead } = preferences.value;
  const demo = temporaryDemo || preferences.value.demo;
  const { setMode, setLead } = preferences;
  const setDemo = (value: boolean) => { setTemporaryDemoAccount(null); preferences.setDemo(value); };
  const [prompt, setPrompt] = useState('');
  const [instructions, setInstructions] = useState('');
  const [researchProvider, setResearchProvider] = useState<ResearchChoice>('auto');
  const [webResearch, setWebResearch] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]), [current, setCurrent] = useState<string | null>(null);
  const turns = useMemo(() => sessions.find(s => s.id === current)?.turns ?? noTurns, [sessions, current]);
  const [busy, setBusy] = useState(false), [stage, setStage] = useState('');
  const attachments = useDraftAttachments(busy, () => setReviewTarget(null));
  const followUpContext = useMemo(() => conversationContext(turns), [turns]);
  const openActions = useMemo(() => workSummary(sessions).open, [sessions]);
  const [working, setWorking] = useState<Result | null>(null), [runningQuestion, setRunningQuestion] = useState(''), [tab, setTab] = useState('answer');
  const [remember, setRemember] = useState(false), [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [clearHistory, setClearHistory] = useState(false), [runMode, setRunMode] = useState<Mode>('council');
  const abortRef = useRef<AbortController | null>(null), promptRef = useRef<HTMLTextAreaElement>(null);
  const newConversationBlocked = !current && sessions.length >= 30;
  const hasDraft = Boolean(prompt || attachments.present || (!current && instructions));
  const connected = providers.filter(p => connections[p.id].key.trim() && connections[p.id].enabled).length;
  const cloud = useAccountWorkspace(account?.userId, sessions, saved => {
    setSessions(saved); setCurrent(null); setInstructions(''); resetDraft(); setLoaded(true);
  });
  useEffect(() => { if (cloud.ready && focusAfterReload.current) { focusAfterReload.current = false; promptRef.current?.focus(); } }, [cloud.ready]);
  if (workspaceRecovery && !cloud.error) setWorkspaceRecovery(null); // the problem it offered to recover from is gone
  useEffect(() => {
    if (account) return;
    // Browser storage exists only after hydration, so guest history is read here rather than in initial state.
    /* eslint-disable react-hooks/set-state-in-effect */
    try {
      const enabled = localStorage.getItem('trio-remember') === 'true'; setRemember(enabled);
      if (enabled) {
        const saved = parseSessions(localStorage.getItem('trio-sessions')); setSessions(saved);
        const active = localStorage.getItem('trio-active-session');
        const restored = active === null ? saved[0] : saved.find(s => s.id === active);
        if (restored) { setInstructions(restored.instructions ?? restored.turns.at(-1)?.instructions ?? ''); setCurrent(restored.id); setStage('done'); setTab(restored.turns.at(-1)?.mode === 'compare' ? 'drafts' : 'answer'); }
      }
    } catch {} setLoaded(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [account]);
  useEffect(() => {
    if (!loaded || account) return;
    try {
      const snapshot = remember ? serializeSessions(sessions) : null;
      localStorage.setItem('trio-remember', String(remember));
      if (snapshot !== null) { localStorage.setItem('trio-sessions', snapshot); localStorage.setItem('trio-active-session', current ?? ''); }
      else { localStorage.removeItem('trio-sessions'); localStorage.removeItem('trio-active-session'); }
      setStorageError(false); // eslint-disable-line react-hooks/set-state-in-effect -- reports the outcome of writing to browser storage
    } catch { setStorageError(true); }
  }, [sessions, remember, loaded, current, account]);
  useEffect(() => () => { abortRef.current?.abort(); }, []);
  useEffect(() => {
    if (!hasDraft && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasDraft, busy]);
  /** Empty the composer: unsent text, attachments and any in-progress preview. */
  function resetDraft() { setWorking(null); setRunningQuestion(''); setPrompt(''); attachments.clearAll(); }
  const openPanel = (panel: WorkspacePanel) => ({ quality: setQualityOpen, comparison: setComparisonOpen, work: setWorkOpen, settings: setSettings, memory: setMemoryOpen, backups: setBackupsOpen, help: setHelp, clearHistory: setClearHistory })[panel](true);
  function newSession() { if (busy) return; setInstructions(''); setCurrent(null); resetDraft(); promptRef.current?.focus(); }
  function navigate(destination: DraftDestination) {
    if (busy) return;
    if (destination.type === 'new') newSession();
    else {
      const session = sessions.find(s => s.id === destination.id);
      if (!session) { toast.error('That conversation is no longer available. Your draft is still here.'); setDraftDestination(null); return; }
      document.getElementById("conversation-scroll")?.scrollTo({ top: 0 });
      setCurrent(session.id); setInstructions(session.instructions ?? session.turns.at(-1)?.instructions ?? '');
      resetDraft(); setStage('done'); setTab(session.turns.at(-1)?.mode === 'compare' ? 'drafts' : 'answer');
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
      setSessions(copy.sessions); setCurrent(copy.session.id); setInstructions(copy.session.instructions ?? '');
      resetDraft(); setSessionQuery(''); setStage('done'); setTab(copy.session.turns.at(-1)!.mode === 'compare' ? 'drafts' : 'answer'); setBranchPoint(null);
      toast.success('New conversation created. Your original is unchanged.'); promptRef.current?.focus();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not create the conversation.'); }
  }
  function saveWork(sessionId: string, index: number, plan: WorkPlan | null): boolean {
    if (busy) return false;
    try {
      const next = setWorkPlan(sessions, sessionId, index, plan);
      setSessions(next);
      return true;
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not save this plan.'); return false; }
  }
  function saveFeedback(index: number, feedback: Feedback | null): boolean {
    if (busy || !current) return false;
    try {
      const updated = setAnswerFeedback(sessions, current, index, feedback);
      setSessions(updated);
      toast.success(feedback ? 'Feedback recorded. Memory changes still need your review.' : 'Feedback removed from this answer.');
      return true;
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not record feedback.'); return false; }
  }
  function saveTurn(question: string, result: Result, chosenMode: Mode, usedInstructions: string, imageName?: string, pdfName?: string) { const next = [...turns, { question, result, mode: chosenMode, ...(!result.demo && usedInstructions ? { instructions: usedInstructions } : {}), ...(!result.demo && imageName ? { imageName } : {}), ...(!result.demo && pdfName ? { pdfName } : {}) }]; const id = current ?? crypto.randomUUID(); setCurrent(id); setSessions(prev => [{ id, instructions, title: prev.find(s => s.id === id)?.title ?? next[0].question, turns: next, time: new Date().toISOString() }, ...prev.filter(s => s.id !== id)]); }
  async function run(teamReview = false) {
    if (busy || preferences.loading || savedConnections.loading || attachments.loading) return;
    if (newConversationBlocked) { toast('Your workspace has 30 conversations. Back up and delete one before starting another.'); return; }
    if (attachments.tooLarge) { toast.error('Images and PDFs together must be under 4 MB. Remove or replace a file.'); return; }
    const target = teamReview && reviewTarget?.result === turns.at(-1)?.result ? reviewTarget : null;
    if (teamReview && (!target || connected < 2 || demo)) { toast('Team review needs the original answer from this tab and at least two connected models.'); return; }
    const chosenMode: Mode = teamReview ? 'council' : mode;
    const request = target?.request ?? { question: demo ? demoQuestion : prompt.trim(), instructions: instructions.trim(), webResearch, researchProvider, context: attachments.context?.text, pdf: attachments.pdf ? { mimeType: attachments.pdf.mimeType, data: attachments.pdf.data } : undefined, image: attachments.image ? { mimeType: attachments.image.mimeType, data: attachments.image.data } : undefined, history: followUpContext.messages };
    const question = request.question;
    const imageName = target ? target.imageName : attachments.image?.name, pdfName = target ? target.pdfName : attachments.pdf?.name;
    if (!question) return;
    if (!demo && !connected) { setSettings(true); toast('Add an API key to start a live session.'); return; }
    if (!demo && chosenMode === 'single' && !(connections[lead].enabled && connections[lead].key.trim())) { setSettings(true); toast('Connect the selected answer model or choose another model.'); return; }
    let researcher: 'openai' | 'claude' | undefined;
    if (!demo && request.webResearch) { try { researcher = selectResearchProvider(connections, request.researchProvider); } catch (error) { setSettings(true); toast.error(error instanceof Error ? error.message : 'Connect a research provider.'); return; } }
    document.getElementById("conversation-scroll")?.scrollTo({ top: 0 });
    setBusy(true); setRunMode(chosenMode); setStage(!demo && request.webResearch ? 'research' : 'draft'); setWorking({ ...emptyResult(demo), researchRequested: !demo && request.webResearch, researchBy: researcher, ...(target ? { reviewedAnswer: target.result.answer } : {}) }); setRunningQuestion(question); setTab(chosenMode === 'single' ? 'answer' : 'drafts');
    const controller = new AbortController(); abortRef.current = controller;
    const preview = createRunPreview(setWorking);
    controller.signal.addEventListener('abort', preview.dispose, { once: true });
    let result = { ...emptyResult(demo), ...(target ? { reviewedAnswer: target.result.answer } : {}) };
    try {
      if (demo) {
        // Keep each partial result, so a stopped demo still shows what arrived.
        result = await runDemo(chosenMode, lead, result, controller.signal, { result: partial => { result = partial; setWorking(partial); }, stage: setStage, answerReady: () => setTab('answer') });
      } else {
        result = await runLiveRequest(JSON.stringify({ ...request, timeZone: browserTimeZone(), personalize: Boolean(account), connections, mode: chosenMode, lead, ...(target ? { reviewAnswer: target.result.answer } : {}) }), { 'Content-Type': 'application/json', ...(account ? { 'X-Trio-Account': account.userId } : {}) }, controller.signal, event => {
          if (event.type === 'stage') { setStage(event.stage!); if (event.stage === 'synthesis') setTab('answer'); }
          result = applyRunEvent(result, event);
          if (event.type === 'final' && chosenMode !== 'compare') setTab('answer');
          preview.update(result, event);
        });
      }
      saveTurn(question, result, chosenMode, request.instructions ?? '', imageName, pdfName);
      setReviewTarget(!demo && chosenMode === 'single' ? { result, request, imageName, pdfName } : null);
      setWorking(null); setRunningQuestion(''); if (!demo && !teamReview) setPrompt(''); setStage('done');
    } catch (error) { if (controller.signal.aborted) { toast('Session stopped. No result was saved.'); setWorking({ ...result, errors: [...result.errors, 'Session stopped. Partial contributions are shown below.'] }); } else { const text = error instanceof Error ? error.message : 'Something went wrong.'; toast.error(text); setWorking({ ...result, errors: [...result.errors, text] }); } setStage('failed'); }
    finally { preview.dispose(); controller.signal.removeEventListener('abort', preview.dispose); setBusy(false); abortRef.current = null; }
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
    <WorkspaceSidebar account={account} busy={busy} status={account ? cloud.status : 'Stored on this device'} openActions={openActions} connected={connected} memoryStatus={memoryStatus} sessions={sessions} current={current} query={sessionQuery} onQuery={setSessionQuery}
      onNavigate={requestNavigation} onSessionAction={setSessionAction} onExport={s => downloadSession(s.turns)} onOpen={openPanel} onFocusComposer={() => promptRef.current?.focus()}
      onSignOut={e => { if (busy || cloud.status === 'Saving…') { e.preventDefault(); toast('Wait for the current run and save to finish before signing out.'); } else if (cloud.error) { e.preventDefault(); setWorkspaceRecovery('signout'); } }} />
    <main className="workspace conversation-workspace">
      <header className="topbar"><div className="breadcrumb"><SidebarTrigger className="mobile-menu" /><span>Workspace</span><ChevronRight size={14} /><strong>{current ? "Conversation" : "New conversation"}</strong></div><div className="top-actions">{displayed && <button className="subtle-button question-jump" onClick={() => document.getElementById("conversation-scroll")?.scrollTo({ top: 0 })}>Latest answer ↑</button>}{busy && <button className="subtle-button stop-current" onClick={() => abortRef.current?.abort()}><Square size={14} />Stop current run</button>}<span className={`mode-badge ${demo ? '' : 'live'}`}>{demo ? 'Demo workspace' : 'Live workspace'}</span><button className="subtle-button" aria-label="Connections" onClick={() => setSettings(true)}><Settings2 size={15} /><span>Connections</span></button></div></header>
      <div className="conversation-scroll" id="conversation-scroll" tabIndex={0} aria-label="Conversation"><div className="work-body">
        {sessions.length >= 30 && <div className="session-capacity" role="status"><strong>Conversation limit reached</strong><p>All 30 conversations are kept. You can continue an existing discussion, or back up and delete one before starting another.</p><button className="subtle-button" disabled={busy} onClick={() => setBackupsOpen(true)}>Back up conversations</button></div>}
        {account && cloud.error && <div className="error-box" role="alert"><strong>Account history needs attention</strong><p>{cloud.error}</p><button disabled={busy} onClick={() => setBackupsOpen(true)}>Download a backup</button>{cloud.conflict ? <button disabled={busy} onClick={() => setWorkspaceRecovery('reload')}>Load latest workspace</button> : <button onClick={cloud.retry}>Retry saving</button>}</div>}
        {storageError && <div className="error-box" role="alert"><strong>Browser history could not be updated</strong><p>{remember ? 'Recent changes are only in this tab. Export important sessions before closing or refreshing; the previous saved copy may be older.' : 'Browser storage is unavailable. Previously saved history may still be on this device.'}</p>{turns.length > 0 && <button onClick={exportSession}>Export current session</button>}</div>}
        <div className={`page-intro${displayed ? " has-answer" : ""}`}><div><div className="eyebrow"><span className="mini-line" /> COLLECTIVE INTELLIGENCE</div><h1>One question. <span>Three perspectives.</span></h1><p>Choose a single answer or bring in the team.</p></div><span className="intro-symbol" aria-hidden>◈</span></div>
        <div className="connection-summary"><span>{demo ? 'Prepared example · no live answers' : connected + ' model' + (connected === 1 ? '' : 's') + ' connected'}</span><button disabled={busy || preferences.loading || savedConnections.loading} onClick={() => { if (demo && connected) setDemo(false); else setSettings(true); }}>{demo ? connected ? 'Use live models' : 'Set up live answers' : 'Manage connections'}</button></div>
        {!displayed && <div className="workspace-starters"><WorkflowBriefs busy={busy || preferences.loading} prompt={prompt} onApply={text => { setPrompt(text); setDemo(false); promptRef.current?.focus(); toast('Brief prepared. Review it, then choose Ask Trio.'); }} /></div>}
        {displayed && <section className="results-section" key={`${current ?? "new"}:${turns.length}:${working ? "working" : "saved"}`}><div className="question-title"><MessageSquare size={17} /><h2>{question}</h2></div>{displayed.demo && <div className="demo-notice">ILLUSTRATIVE DEMO · Prepared sample responses. No model APIs were called.</div>}{busy && <RunPipeline result={displayed} mode={displayMode} busy={busy} stage={stage} />}
          {displayed.researchRequested && <ResearchPanel research={displayed.research} provider={displayed.researchBy} loading={busy && stage === "research"} />}
          <ResultTabs displayed={displayed} displayMode={displayMode} busy={busy} demo={demo} stage={stage} tab={tab} onTab={setTab} canBranch={!working && !displayed.demo && turns.length > 0} onBranch={() => setBranchPoint(turns.length - 1)} onCopy={text => void copy(text)} canExport={turns.length > 0} onExport={exportSession} />
          {!busy && <details className="run-details"><summary>{modes[displayMode].title} · Run details &amp; evidence</summary><RunPipeline result={displayed} mode={displayMode} busy={false} stage={stage} />{!working && <RunCoverage result={displayed} mode={displayMode} />}</details>}
          {displayed.reviewedAnswer && <details className="original-answer"><summary>Original answer before team review</summary><Prose text={displayed.reviewedAnswer} /></details>}
          {!busy && !demo && reviewTarget && reviewTarget.result === turns.at(-1)?.result && <div className="team-review-action"><button className="run-button" disabled={connected < 2} onClick={() => void run(true)}>Have the team check this</button><p>{connected < 2 ? 'Connect at least two models for team review.' : 'Uses the original question, attachments and instructions, with current connections and personal memory. Adds a Council run; your original answer and unsent question stay available.'}</p></div>}
          {!working && <><InstructionsUsed value={turns.at(-1)?.instructions} /><MemoryUsed value={turns.at(-1)?.result.memory} /></>}
          {!working && turns.at(-1)?.imageName && <p className="revision-note">Image used: {turns.at(-1)?.imageName}. Image data is not saved; reattach it to revisit visual details.</p>}{!working && turns.at(-1)?.pdfName && <p className="revision-note">PDF used: {turns.at(-1)?.pdfName}. PDF data is not saved; reattach it to revisit document details.</p>}{displayed.usage && !displayed.demo && <UsageSummary usage={displayed.usage} />}
          {displayed.errors.length > 0 && <div className="error-box" role="alert"><strong>Some steps could not finish</strong>{Array.from(new Set(displayed.errors)).map((e, i) => <p key={i}>{e}</p>)}<button onClick={() => setSettings(true)}>Check connections</button></div>}
          {!busy && !working && !displayed.demo && (displayed.answer || Object.values(displayed.drafts).some(Boolean)) && <AnswerFeedback key={current + ':' + (turns.length - 1)} value={turns.at(-1)?.feedback} busy={busy} account={!!account} onSave={value => saveFeedback(turns.length - 1, value)} />}
          {!working && current && !turns.at(-1)?.result.demo && <WorkPlanPanel suggestionContext={account ? { accountId: account.userId, sessionId: current, turnIndex: turns.length - 1, revision: cloud.revision, ready: cloud.ready && !cloud.error && cloud.status === 'Saved to your account', live: !demo, connections, preferred: lead } : undefined} reviewed={!!turns.at(-1)?.result.reviewedAnswer} key={'work:' + current + ':' + (turns.length - 1)} value={turns.at(-1)?.work} question={turns.at(-1)?.question ?? ''} busy={busy} onSave={plan => saveWork(current, turns.length - 1, plan)} />}
          <ConversationHistory onWork={current ? (index, plan) => saveWork(current, index, plan) : undefined} account={!!account} onFeedback={saveFeedback} key={current ?? 'new'} turns={working ? turns : turns.slice(0, -1)} busy={busy} onBranch={current ? setBranchPoint : undefined} />
        </section>}


      </div></div>
      <div className="composer-dock"><Composer mode={mode} lead={lead} runMode={runMode} onMode={setMode} onLead={setLead} preferencesLoading={preferences.loading} preferencesError={Boolean(preferences.error)} busy={busy} demo={demo} webResearch={webResearch} instructionsSet={Boolean(instructions.trim())}
        prompt={prompt} onPrompt={setPrompt} promptRef={promptRef} hasTurns={turns.length > 0} attachments={attachments} runBlocked={preferences.loading || savedConnections.loading || newConversationBlocked}
        onRun={() => void run()} onStop={() => abortRef.current?.abort()} onOpenTools={() => setToolsOpen(true)} /></div>
    </main>
    {/* Keep media drafts mounted independently of the optional tools panel. */}
    <AudioTranscription open={mediaTool === 'audio'} onOpenChange={open => setMediaTool(open ? 'audio' : null)} accountId={account?.userId} apiKey={connections.openai.enabled ? connections.openai.key : ''} live={!demo} question={prompt} onAppend={value => { setPrompt(value); promptRef.current?.focus(); }} onConnections={() => setSettings(true)} />
    <ImageGeneration open={mediaTool === 'image'} onOpenChange={open => setMediaTool(open ? 'image' : null)} accountId={account?.userId} apiKey={connections.openai.enabled ? connections.openai.key : ''} live={!demo} question={prompt} replacingImage={Boolean(attachments.image)} onAttach={attachments.attachGeneratedImage} onConnections={() => setSettings(true)} />
    <ToolsDialog open={toolsOpen} onOpenChange={setToolsOpen} onRestoreFocus={() => { if (!mediaTool) promptRef.current?.focus(); }} busy={busy} demo={demo} temporaryDemo={temporaryDemo} mode={mode} attachmentsLoading={attachments.imageLoading || attachments.pdfLoading} onMedia={setMediaTool}
      followUp={turns.length > 0 ? followUpContext : null} sessionKey={current ?? 'new'} instructions={instructions} onInstructions={changeInstructions} webResearch={webResearch} onWebResearch={setWebResearch} researchProvider={researchProvider} onResearchProvider={setResearchProvider}
      preferences={preferences} prompt={prompt} onApplyBrief={text => { setPrompt(text); setDemo(false); promptRef.current?.focus(); }} />
    <DraftNavigation destination={draftDestination} onCancel={() => setDraftDestination(null)} onDiscard={() => { if (draftDestination) navigate(draftDestination); }} onFocus={() => promptRef.current?.focus()} />
    {account && <QualityCheck key={account.userId} accountId={account.userId} open={qualityOpen} onOpenChange={setQualityOpen} live={!demo} onConnections={() => { setQualityOpen(false); setSettings(true); }} />}
    {account && <WorkComparison key={'comparison-'+account.userId} accountId={account.userId} open={comparisonOpen} onOpenChange={setComparisonOpen} live={!demo} onConnections={() => { setComparisonOpen(false); setSettings(true); }} />}
    <ActionConfirmation open={workspaceRecovery !== null} onOpenChange={next => { if (!next) setWorkspaceRecovery(null); }} title={workspaceRecovery === 'reload' ? 'Load the latest account history?' : 'Sign out with unsaved changes?'} description={workspaceRecovery === 'reload' ? 'This replaces this tab’s sessions with the latest saved account history. Download a backup first to keep unsaved changes. Your unsent question, attachments and new-conversation instructions will also be cleared; copy them first if needed.' : 'Some workspace changes have not saved. Signing out may lose those changes and your unsent question or attachments. Cancel and download a backup first to keep the workspace changes.'} confirmLabel={workspaceRecovery === 'reload' ? 'Replace this tab with saved history' : 'Sign out anyway'} cancelLabel="Keep this tab" destructive disabled={busy || cloud.status === 'Saving…' || !cloud.error || (workspaceRecovery === 'reload' && !cloud.conflict)} onConfirm={() => {
      if (busy || cloud.status === 'Saving…' || !cloud.error || (workspaceRecovery === 'reload' && !cloud.conflict)) return false;
      if (workspaceRecovery === 'reload') { focusAfterReload.current = true; cloud.reload(); }
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- sign-out is a Worker route, not a Next page; it needs a full navigation.
      else if (workspaceRecovery === 'signout') window.location.assign('/signout-with-chatgpt?return_to=%2F');
      else return false;
    }} />
    <WorkBoard sessions={sessions} busy={busy} hasDraft={hasDraft} onPrepareDay={text => {
      if (busy || preferences.loading) { toast('Wait for the workspace to finish loading before preparing a new question.'); return false; }
      if (sessions.length >= 30) { toast.error('Your workspace has 30 saved conversations. Back up and remove an older conversation before starting another. You can still copy this brief.'); return false; }
      if (!text.trim() || text.length > 20000) { toast.error('The prepared question must contain 1–20,000 characters.'); return false; }
      newSession(); setPrompt(text); setDemo(false); toast('Day-planning question prepared. Review the text, models and settings, then choose Ask Trio.'); return true;
    }} onFocusComposer={() => promptRef.current?.focus()} open={workOpen} onOpenChange={setWorkOpen} onSave={saveWork} onOpenSession={id => requestNavigation({ type: 'session', id })} />
    <SessionActionDialogs action={sessionAction} sessions={sessions} busy={busy} clearsDraft={hasDraft && sessionAction?.id === current} onClose={() => setSessionAction(null)} onRename={(id, title) => { if (busy) return; try { setSessions(renameSession(sessions, id, title)); setSessionAction(null); toast.success('Session renamed'); } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not rename this session.'); } }} onDelete={id => { if (busy) return; setSessions(prev => prev.filter(s => s.id !== id)); if (current === id) newSession(); setSessionAction(null); toast.success('Session deleted'); }} />
    {account && <PersonalMemory accountId={account.userId} open={memoryOpen} onOpenChange={setMemoryOpen} memory={personalMemory} connections={connections} sessionId={current} workspaceRevision={cloud.revision} sessionSaved={cloud.ready && !cloud.error && cloud.status === 'Saved to your account'} busy={busy} />}
    <SessionBackups sessions={sessions} busy={busy} remember={account ? true : remember} account={Boolean(account)} open={backupsOpen} onOpenChange={setBackupsOpen} onImport={incoming => { if (busy) return; setSessions(mergeBackup(sessions, incoming).sessions); }} />
    <BranchConversation source={sessions.find(s => s.id === current)} turnIndex={branchPoint} count={sessions.length} busy={busy} hasUnsent={Boolean(prompt) || attachments.present} onClose={() => setBranchPoint(null)} onCreate={createBranch} />
    <ConnectionsDialog open={settings} onOpenChange={setSettings} account={account} busy={busy} connected={connected} demo={demo} temporaryDemo={temporaryDemo} onDemo={setDemo} preferences={preferences} savedConnections={savedConnections} connections={connections} onConnections={setConnections} lead={lead} onLead={setLead} remember={remember} onRemember={setRemember}
      onClearTabKeys={() => { setConnections(applyWorkspaceConnections(freshConnections(), savedConnections.workspace)); setTemporaryDemoAccount(account?.userId ?? 'guest'); }}
      onForgetAll={() => { setTemporaryDemoAccount(account?.userId ?? 'guest'); void savedConnections.forgetAll(); }} />
    <HelpDialog open={help} onOpenChange={setHelp} account={Boolean(account)} />
    <AlertDialog open={clearHistory} onOpenChange={setClearHistory}><AlertDialogContent><AlertDialogTitle>Clear session history?</AlertDialogTitle><AlertDialogDescription>{account ? "This deletes all sessions from your online account and clears the current conversation." : "This removes all saved sessions from this device and clears the current conversation."} Export any answers you want to keep first.{hasDraft && ' Your unsent question, attached files, and new-conversation instructions will also be cleared.'}</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>Keep sessions</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { setSessions([]); newSession(); toast('Session history cleared'); }}>Clear all sessions</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <Toaster theme="dark" position="bottom-right" richColors />
  </SidebarProvider>;
}
