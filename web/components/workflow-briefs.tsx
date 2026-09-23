'use client';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { prepareWorkflowBrief, workflowBriefs, type BriefKind } from '@/lib/workflow-briefs';

export function WorkflowBriefs({ busy, prompt, onApply }: { busy: boolean; prompt: string; onApply: (text: string) => void }) {
  const [kind, setKind] = useState<BriefKind | null>(null), [goal, setGoal] = useState(''), [notes, setNotes] = useState(''), [initialNotes, setInitialNotes] = useState(''), [error, setError] = useState('');
  const dirty = Boolean(kind && (goal || notes !== initialNotes));
  useEffect(() => { if (!dirty) return; const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  function close() { if (!dirty || window.confirm('Discard the changes to this brief? Your existing question will stay in the composer.')) setKind(null); }
  return <section className="workflow-starters" aria-label="Guided workflows"><div className="section-heading"><h2>Put Trio to work</h2><span>START WITH AN OUTCOME</span></div><div className="workflow-grid">{(Object.entries(workflowBriefs) as [BriefKind, typeof workflowBriefs[BriefKind]][]).map(([key, brief]) => <button key={key} disabled={busy} onClick={() => { setGoal(''); setNotes(prompt); setInitialNotes(prompt); setError(''); setKind(key); }}><strong>{brief.title}<span aria-hidden="true">↗</span></strong><p>{brief.description}</p></button>)}</div>
    <Dialog open={!!kind} onOpenChange={open => { if (!open) close(); }}><DialogContent className="work-dialog"><DialogTitle>{kind ? workflowBriefs[kind].title : 'Prepare a brief'}</DialogTitle><DialogDescription>Prepare a question for your connected models. Your chosen answer mode still applies. Review the brief before you submit it; preparing it makes no AI call. Current attachments and session instructions stay in place.</DialogDescription><form onSubmit={e => { e.preventDefault(); try { const text = prepareWorkflowBrief(kind!, goal, notes); onApply(text); setKind(null); } catch (e) { setError(e instanceof Error ? e.message : 'Check the brief.'); } }}>
      <label>What result do you need?<input aria-label="Desired outcome" required maxLength={300} value={goal} onChange={e => setGoal(e.target.value)} placeholder="For example: Leave the meeting with clear decisions and next steps" /></label>
      <label>Notes, facts, and constraints<textarea aria-label="Workflow notes" rows={7} maxLength={12000} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Paste the source notes. Include deadlines, available time, audience, and anything that must be checked." /></label>
      <p className="muted">{prompt ? 'This brief will replace your current question. Its full text is included in the notes above.' : 'The brief will appear in your question editor.'} This switches to Live mode. API connections are required before submitting. Messages and calendar changes are prepared as drafts.</p>{notes.length > 12000 && <p role="alert">Your existing question exceeds this brief’s 12,000-character notes limit. Shorten these notes or cancel to keep editing the original; nothing has been truncated.</p>}{error && <p role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="subtle-button" onClick={close}>Cancel</button><button type="submit" className="run-button" disabled={busy || !goal.trim() || notes.length > 12000}>{prompt ? 'Replace question with this brief' : 'Use brief in Live mode'}</button></div>
    </form></DialogContent></Dialog>
  </section>;
}
