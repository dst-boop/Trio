'use client';
import { useState } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { AnswerFeedback as Feedback } from '@/lib/answer-feedback';

export function AnswerFeedback({ value, busy, account, onSave }: { value?: Feedback; busy?: boolean; account: boolean; onSave: (value: Feedback | null) => boolean }) {
  const [open, setOpen] = useState(false), [rating, setRating] = useState<Feedback['rating']>('helpful'), [note, setNote] = useState('');
  function edit(next: Feedback['rating']) { setRating(next); setNote(value?.note ?? ''); setOpen(true); }
  function save(next: Feedback | null) { if (!busy && onSave(next)) setOpen(false); }
  return <div className="answer-feedback">
    <span>Your feedback</span>
    <button type="button" disabled={busy} aria-pressed={value?.rating === 'helpful'} onClick={() => edit('helpful')}><ThumbsUp size={14} />Helpful</button>
    <button type="button" disabled={busy} aria-pressed={value?.rating === 'needs-work'} onClick={() => edit('needs-work')}><ThumbsDown size={14} />Needs work</button>
    {value && <small>Recorded with this answer{value.note ? ' · note added' : ''}</small>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="feedback-dialog"><DialogTitle>Feedback on this answer</DialogTitle><DialogDescription>{account ? 'Private to your account and saved with this conversation.' : 'Kept with this conversation; browser history settings control whether it survives a reload.'} Saving feedback makes no AI request. It can inform memory suggestions when you choose “Suggest from conversation”; you review those notes before saving them.</DialogDescription>
      <form onSubmit={e => { e.preventDefault(); save({ rating, ...(note.trim() ? { note: note.trim() } : {}) }); }}>
        <label>How useful was this response?<select aria-label="Answer rating" value={rating} disabled={busy} onChange={e => setRating(e.target.value as Feedback['rating'])}><option value="helpful">Helpful</option><option value="needs-work">Needs work</option></select></label>
        <label>What should improve or stay the same? <span>(optional)</span><textarea aria-label="Feedback note" value={note} disabled={busy} maxLength={2000} onChange={e => setNote(e.target.value)} placeholder="For example: Show a worked example, explain uncertainty, or cite the source for a specific claim." /></label>
        <small>{note.length.toLocaleString()} / 2,000 characters. Avoid passwords, API keys, and sensitive details. Feedback does not verify facts or train model weights.</small>
        <div className="dialog-actions">{value && <button type="button" className="subtle-button" disabled={busy} onClick={() => save(null)}>Remove feedback</button>}<button type="button" className="subtle-button" onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="run-button" disabled={busy}>Save feedback</button></div>
      </form>
    </DialogContent></Dialog>
  </div>;
}
