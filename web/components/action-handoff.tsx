'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { actionSourceFingerprint, prepareDayBrief, visibleActionsMarkdown, type WorkActionItem } from '@/lib/work-handoff';
import type { ActionFilter } from '@/lib/work-action-view';

const defaultGoal = 'Choose the most useful next steps for my workday';
export function ActionHandoff({ items, today, filter, search, busy, hasDraft, onPrepare }: { items: WorkActionItem[]; today: string; filter: ActionFilter; search: string; busy: boolean; hasDraft: boolean; onPrepare: (prompt: string) => boolean }) {
  const [snapshot, setSnapshot] = useState<{ items: WorkActionItem[]; fingerprint: string; date: string } | null>(null);
  const [goal, setGoal] = useState(defaultGoal), [date, setDate] = useState(today), [minutes, setMinutes] = useState(''), [constraints, setConstraints] = useState('');
  const [discard, setDiscard] = useState(false), [error, setError] = useState('');
  const applying = useRef(false);
  const helpId = useId();
  const trigger = useRef<HTMLButtonElement | null>(null), cancel = useRef<HTMLButtonElement | null>(null);
  const eligible = items.length > 0 && items.length <= 20 && items.every(item => !item.action.completedAt);
  const stale = Boolean(snapshot && snapshot.fingerprint !== actionSourceFingerprint(items));
  const dirty = Boolean(snapshot && (goal !== defaultGoal || date !== snapshot.date || minutes || constraints));
  let preview = '', previewError = '';
  if (snapshot) {
    try { preview = prepareDayBrief(snapshot.items, { goal, date, ...(minutes !== '' ? { minutes: Number(minutes) } : {}), constraints }); }
    catch (error) { previewError = error instanceof Error && error.name !== 'ZodError' ? error.message : 'Use a goal under 300 characters, a valid date, whole minutes from 1 to 1,440, and constraints under 4,000 characters.'; }
  }
  useEffect(() => {
    if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function start() {
    if (!eligible || busy) return;
    applying.current = false; setGoal(defaultGoal); setDate(today); setMinutes(''); setConstraints(''); setError(''); setDiscard(false);
    setSnapshot({ items: structuredClone(items), fingerprint: actionSourceFingerprint(items), date: today });
  }
  function close() { if (dirty) setDiscard(true); else setSnapshot(null); }
  function prepare() {
    if (busy || stale || !preview) return;
    setError(''); applying.current = true;
    if (onPrepare(preview)) setSnapshot(null);
    else { applying.current = false; setError('The question could not be prepared yet. Your brief is still here.'); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast.success('Copied. Review it before using it in another app.'); }
    catch { toast.error('Clipboard unavailable. Download the checklist or select the prepared question to copy it.'); }
  }
  function download() {
    try {
      const text = visibleActionsMarkdown(items, today, filter, search), url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `trio-actions-${today}.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not download these actions.'); }
  }
  return <>
    <div className="action-handoff"><div className="action-handoff-buttons" role="group" aria-label="Action handoff" aria-describedby={helpId}><button className="subtle-button" disabled={!items.length} onClick={() => { try { void copy(visibleActionsMarkdown(items, today, filter, search)); } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not copy these actions.'); } }}>Copy visible actions</button><button className="subtle-button" disabled={!items.length} onClick={download}>Download checklist</button><button ref={trigger} aria-describedby={helpId} className="subtle-button" disabled={!eligible || busy} onClick={start}>Prepare a day plan</button></div><small id={helpId}>Copying and preparation make no AI call. A day-plan brief can include 1–20 open actions from this view; narrow your filter or search when needed.</small></div>
    <Dialog open={snapshot !== null} onOpenChange={open => { if (!open) close(); }}><DialogContent className="work-dialog" onCloseAutoFocus={event => { event.preventDefault(); if (!applying.current) trigger.current?.focus(); }}><DialogTitle>Plan from your saved actions</DialogTitle><DialogDescription>Prepare an editable question from the {snapshot?.items.length ?? 0} open actions you selected through this view. Nothing is sent to a model until you choose Ask Trio.</DialogDescription>
      <form onSubmit={event => event.preventDefault()} onChangeCapture={() => setError('')}>
        <label>Desired result<input required maxLength={300} value={goal} onChange={event => setGoal(event.target.value)} /></label>
        <div className="work-time-fields"><label>Planning date<input type="date" required value={date} onChange={event => setDate(event.target.value)} /></label><label>Available minutes (optional)<input type="number" min={1} max={1440} step={1} value={minutes} onChange={event => setMinutes(event.target.value)} /></label></div>
        <label>Constraints and priorities (optional)<textarea maxLength={4000} rows={4} value={constraints} onChange={event => setConstraints(event.target.value)} placeholder="Fixed commitments, important deadlines, energy or priorities. Leave unknown details blank." /></label>
        <details className="day-brief-preview"><summary>Review the prepared question{preview ? ` · ${preview.length.toLocaleString()} characters` : ''}</summary>{preview && <textarea aria-label="Prepared daily-planning question" readOnly rows={10} value={preview} />}</details>
        {stale && <p role="alert">Your visible work changed while this brief was open. Close and reopen it to include the latest actions, or copy the original snapshot to keep your edits. Your source plans have not been changed.</p>}
        {previewError && <p role="alert">{previewError}</p>}{error && <p role="alert">{error}</p>}
        <p className="muted">This starts a new conversation in Live mode. Your answer mode, model choices and personal-memory setting still apply. Source conversation labels may be shortened; action wording, goals and planning dates are kept.</p>
        {hasDraft && <p className="day-brief-replacement">Your current unsent question, attachments and unsaved new-conversation instructions will be cleared if you replace the draft. Saved conversations and action plans stay intact. Copy this brief instead to keep your current draft.</p>}
        <div className="dialog-actions"><button ref={cancel} type="button" className="subtle-button" onClick={close}>Cancel</button><button type="button" className="subtle-button" disabled={!preview} onClick={() => void copy(preview)}>{stale ? 'Copy original snapshot' : 'Copy brief'}</button><button type="button" onClick={prepare} className="run-button" disabled={busy || stale || !preview}>{hasDraft ? 'Replace draft with day plan' : 'Use in new Live conversation'}</button></div>
      </form>
    </DialogContent></Dialog>
    <AlertDialog open={discard} onOpenChange={setDiscard}><AlertDialogContent onCloseAutoFocus={event => { event.preventDefault(); (snapshot ? cancel.current : trigger.current)?.focus(); }}><AlertDialogTitle>Discard this planning brief?</AlertDialogTitle><AlertDialogDescription>Your edits in this brief will be discarded. Your current question and saved plans stay unchanged.</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction onClick={() => { setDiscard(false); setSnapshot(null); }}>Discard brief</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
}
