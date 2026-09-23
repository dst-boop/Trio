'use client';
import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { WorkPlanPanel } from '@/components/work-plan';
import { openWork, workSummary } from '@/lib/work-actions';
import type { Session } from '@/lib/sessions';
import type { WorkPlan } from '@/lib/work-plan';

export function WorkBoard({ sessions, busy, open, onOpenChange, onSave, onOpenSession }: { sessions: Session[]; busy: boolean; open: boolean; onOpenChange: (open: boolean) => void; onSave: (id: string, index: number, plan: WorkPlan | null) => boolean; onOpenSession: (id: string) => void }) {
  const [filter, setFilter] = useState('open');
  const summary = workSummary(sessions), actions = openWork(sessions);
  const modeNames = { single: 'Single answer', fast: 'Quick synthesis', council: 'Council', deep: 'Deep Council', compare: 'Compare' };
  const plans = sessions.flatMap(s => s.turns.flatMap((t, index) => t.work && !t.result.demo ? [{ session: s, turn: t, index }] : []));
  const visible = plans.filter(p => filter === 'all' || !p.turn.work!.outcome || p.turn.work!.actions.some(a => !a.completedAt));
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="work-dialog work-board"><DialogTitle>Your work</DialogTitle><DialogDescription>Action plans across your saved conversations. Open a plan to update it; generating an answer does not mark real-world work complete.</DialogDescription>
    <div className="work-stats"><div><strong>{summary.open}</strong><span>Open actions</span></div><div><strong>{summary.completedActions}</strong><span>Marked complete</span></div><div><strong>{summary.outcomes}</strong><span>Recorded outcomes</span></div></div>
    <section className="value-ledger" aria-label="Last seven days"><h3>Last 7 days · your reported results</h3><p>{summary.weekly.used} used ({summary.weekly.edited} with edits), {summary.weekly.notUsed} not used. {summary.weekly.confirmed} corrections confirmed by you; {summary.weekly.rejected} rejected.</p>{summary.weekly.measured > 0 && <p>{Math.abs(summary.weekly.minutesSaved)} minutes {summary.weekly.minutesSaved >= 0 ? 'saved' : 'extra time spent'}, estimated across {summary.weekly.measured} of {summary.weekly.recorded} recorded results.</p>}<p className="muted">These are your assessments, not a measured productivity gain or an accuracy benchmark. Missing time estimates are excluded. Results are grouped by the time you recorded them.</p>{summary.weekly.recorded > 0 && <div className="ledger-table-scroll"><table><thead><tr><th>Mode</th><th>Used</th><th>With edits</th><th>Not used</th><th>Corrections confirmed</th><th>Minutes saved</th></tr></thead><tbody>{Object.entries(summary.byMode).map(([mode, count]) => <tr key={mode}><th>{modeNames[mode as keyof typeof modeNames]}</th><td>{count.used}</td><td>{count.edited}</td><td>{count.notUsed}</td><td>{count.confirmed}</td><td>{count.measured ? count.minutesSaved : '—'}</td></tr>)}</tbody></table></div>}</section>
    <label>Show plans<select aria-label="Work filter" value={filter} onChange={e => setFilter(e.target.value)}><option value="open">In progress</option><option value="all">All plans and outcomes</option></select></label>
    {!plans.length && <p className="work-board-empty">Start with a guided brief or your own question. After a live answer, choose “Create action plan” to keep the next steps here.</p>}
    {plans.length > 0 && !visible.length && <p className="work-board-empty">Every result has been recorded and no actions remain open. Choose “All plans and outcomes” to review them.</p>}
    <div className="work-board-plans">{visible.map(({ session, turn, index }) => <details key={`${session.id}:${index}`}><summary><span>{turn.work!.goal}</span><small>{turn.work!.outcome ? 'Outcome recorded' : `${actions.filter(a => a.sessionId === session.id && a.turnIndex === index).length} open actions`}</small></summary><button className="subtle-button" onClick={() => { onOpenChange(false); onOpenSession(session.id); }}>Open conversation: {session.title.slice(0, 80)}</button><WorkPlanPanel reviewed={!!turn.result.reviewedAnswer} value={turn.work} question={turn.question} busy={busy} onSave={plan => onSave(session.id, index, plan)} /></details>)}</div>
  </DialogContent></Dialog>;
}
