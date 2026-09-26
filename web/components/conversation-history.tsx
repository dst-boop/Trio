'use client';

import { AnswerFeedback } from '@/components/answer-feedback';
import { WorkPlanPanel } from '@/components/work-plan';
import type { WorkPlan } from '@/lib/work-plan';
import type { AnswerFeedback as Feedback } from '@/lib/answer-feedback';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AnswerReader as Answer } from '@/components/answer-reader';
import { ResearchPanel } from '@/components/research-panel';
import { RunCoverage } from '@/components/run-coverage';
import { InstructionsUsed, MemoryUsed } from '@/components/session-instructions';
import { UsageSummary } from '@/components/usage-summary';
import { providers, type Result } from '@/lib/trio';
import type { Turn } from '@/lib/sessions';

const modeNames = { single: 'Single answer', council: 'Council', deep: 'Deep Council', fast: 'Quick synthesis', compare: 'Compare' };

function Contributions({ result, bucket }: { result: Result; bucket: 'drafts' | 'reviews' | 'revisions' }) {
  const answers = result[bucket] ?? {};
  const participating = providers.filter(provider => answers[provider.id]);
  return participating.length ? <div className="history-contributions">{participating.map(provider => <section key={provider.id}><h4 style={{ color: provider.color }}>{provider.name}</h4><Answer text={answers[provider.id]!} /></section>)}</div> : <p className="muted">No {bucket === 'drafts' ? 'perspectives' : bucket} were returned for this question.</p>;
}

function PastTurn({ turn, onBranch, onFeedback, onWork, account, busy }: { onWork?: (plan: WorkPlan | null) => boolean; turn: Turn; onBranch?: () => void; onFeedback?: (value: Feedback | null) => boolean; account: boolean; busy?: boolean }) {
  const { result } = turn;
  async function copy() {
    try { await navigator.clipboard.writeText(result.answer); toast.success('Earlier answer copied'); }
    catch { toast.error('Clipboard unavailable. Select and copy the answer manually.'); }
  }
  return <div className="history-turn-body">
    <div className="history-turn-meta"><span>{modeNames[turn.mode]} · {result.seconds}s{result.by ? ` · ${providers.find(provider => provider.id === result.by)?.name}` : ''}</span>{result.answer && <button className="subtle-button" onClick={() => void copy()}><Copy size={14} />Copy earlier answer</button>}</div>
    {result.demo && <p className="demo-notice">ILLUSTRATIVE DEMO · No model APIs were called.</p>}
    {onBranch && !result.demo && <button className="subtle-button branch-turn" disabled={busy} onClick={onBranch}>Continue from here ↗</button>}
    <InstructionsUsed value={turn.instructions} />
    <MemoryUsed value={turn.result.memory} />
    {turn.imageName && <p className="revision-note">Image used: {turn.imageName}. Reattach it to revisit visual details; image data is not saved.</p>}
    {turn.pdfName && <p className="revision-note">PDF used: {turn.pdfName}. Reattach it to revisit document details; PDF data is not saved.</p>}
    {result.fallback && <p className="revision-note">Single-model fallback · Synthesis did not complete.</p>}
    {result.reviewedAnswer && <details className="original-answer"><summary>Original answer before team review</summary><Answer text={result.reviewedAnswer} /></details>}
    <RunCoverage result={result} mode={turn.mode} />
    <Tabs defaultValue={turn.mode === 'compare' ? 'drafts' : 'answer'}>
      <TabsList className="result-tabs history-tabs" aria-label="Earlier question contributions">
        <TabsTrigger value="answer">Answer</TabsTrigger>
        <TabsTrigger value="drafts">Perspectives {Object.keys(result.drafts).length}</TabsTrigger>
        <TabsTrigger value="reviews">Reviews {Object.keys(result.reviews).length}</TabsTrigger>
        {turn.mode === 'deep' && <TabsTrigger value="revisions">Revisions {Object.keys(result.revisions ?? {}).length}</TabsTrigger>}
      </TabsList>
      <TabsContent value="answer">{result.answer ? <Answer text={result.answer} /> : <p className="muted">Compare keeps the model perspectives separate. Read them in Perspectives.</p>}</TabsContent>
      <TabsContent value="drafts"><Contributions result={result} bucket="drafts" /></TabsContent>
      <TabsContent value="reviews"><Contributions result={result} bucket="reviews" /></TabsContent>
      {turn.mode === 'deep' && <TabsContent value="revisions"><Contributions result={result} bucket="revisions" /></TabsContent>}
    </Tabs>
    {result.researchRequested && <ResearchPanel research={result.research} provider={result.researchBy} />}
    {result.usage && !result.demo && <UsageSummary usage={result.usage} />}
    {!result.demo && (result.answer || Object.values(result.drafts).some(Boolean)) && onFeedback && <AnswerFeedback value={turn.feedback} busy={busy} account={account} onSave={onFeedback} />}
    {!result.demo && onWork && <WorkPlanPanel reviewed={!!turn.result.reviewedAnswer} value={turn.work} question={turn.question} busy={!!busy} onSave={onWork} />}
    {result.errors.length > 0 && <div className="error-box"><strong>Run notes</strong>{[...new Set(result.errors)].map((error, index) => <p key={index}>{error}</p>)}</div>}
  </div>;
}

/** Accordion content mounts on expansion so long threads do not render every answer. */
export function ConversationHistory({ turns, onBranch, onFeedback, onWork, account = false, busy }: { onWork?: (index: number, plan: WorkPlan | null) => boolean; turns: Turn[]; onBranch?: (index: number) => void; onFeedback?: (index: number, value: Feedback | null) => boolean; account?: boolean; busy?: boolean }) {
  if (!turns.length) return null;
  return <details className="previous-turns"><summary>{turns.length} earlier {turns.length === 1 ? 'question' : 'questions'} in this session</summary>
    <Accordion type="single" collapsible className="history-accordion">{turns.map((turn, index) => <AccordionItem key={index} value={String(index)} data-history-turn={index}>
      <AccordionTrigger><span className="history-question"><span>Question {index + 1}</span>{turn.question}</span></AccordionTrigger>
      <AccordionContent><PastTurn onWork={onWork ? plan => onWork(index, plan) : undefined} turn={turn} busy={busy} account={account} onFeedback={onFeedback ? value => onFeedback(index, value) : undefined} onBranch={onBranch ? () => onBranch(index) : undefined} /></AccordionContent>
    </AccordionItem>)}</Accordion>
  </details>;
}
