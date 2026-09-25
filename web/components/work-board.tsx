'use client';
import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { WorkPlanPanel } from '@/components/work-plan';
import { NextActions } from '@/components/next-actions';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { openWork, workSummary } from '@/lib/work-actions';
import type { Session } from '@/lib/sessions';
import type { WorkPlan } from '@/lib/work-plan';
import type { ActionFilter } from '@/lib/work-action-view';

export function WorkBoard({ sessions, busy, open, onOpenChange, onSave, onOpenSession }: { sessions: Session[]; busy: boolean; open: boolean; onOpenChange: (open: boolean) => void; onSave: (id: string, index: number, plan: WorkPlan | null) => boolean; onOpenSession: (id: string) => void }) {
  const [filter, setFilter] = useState('open'), [tab, setTab] = useState('actions');
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<ActionFilter>('open'), [actionSearch, setActionSearch] = useState('');
  const summary = workSummary(sessions), actions = openWork(sessions);
  const modeNames = { single: 'Single answer', fast: 'Quick synthesis', council: 'Council', deep: 'Deep Council', compare: 'Compare' };
  const plans = sessions.flatMap(s => s.turns.flatMap((t, index) => t.work && !t.result.demo ? [{ session: s, turn: t, index }] : []));
  const visible = plans.filter(p => filter === 'all' || !p.turn.work!.outcome || p.turn.work!.actions.some(a => !a.completedAt));
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="work-dialog work-board"><DialogTitle>Your work</DialogTitle><DialogDescription>Choose your next action, update a plan, or record what happened. Generating an answer does not complete real-world work.</DialogDescription>
    <div className="work-stats"><div><strong>{summary.open}</strong><span>Open actions</span></div><div><strong>{summary.completedActions}</strong><span>Marked complete</span></div><div><strong>{summary.outcomes}</strong><span>Recorded outcomes</span></div></div>
    <Tabs value={tab} onValueChange={setTab} className="work-board-tabs"><TabsList aria-label="Your work views"><TabsTrigger value="actions">Next actions</TabsTrigger><TabsTrigger value="plans">Plans</TabsTrigger><TabsTrigger value="results">Results · 7 days</TabsTrigger></TabsList>
    <TabsContent value="actions"><NextActions sessions={sessions} busy={busy} onSave={onSave} filter={actionFilter} setFilter={setActionFilter} search={actionSearch} setSearch={setActionSearch} onOpenPlan={(id, index) => { setFilter('all'); setSelectedPlan(JSON.stringify([id, index])); setTab('plans'); }} /></TabsContent>
    <TabsContent value="results">
    <section className="value-ledger" aria-label="Last seven days"><h3>Last 7 days · your reported results</h3><p>{summary.weekly.used} used ({summary.weekly.edited} with edits), {summary.weekly.notUsed} not used. {summary.weekly.confirmed} corrections confirmed by you; {summary.weekly.rejected} rejected.</p>{summary.weekly.measured > 0 && <p>{Math.abs(summary.weekly.minutesSaved)} minutes {summary.weekly.minutesSaved >= 0 ? 'saved' : 'extra time spent'}, estimated across {summary.weekly.measured} of {summary.weekly.recorded} recorded results.</p>}<p className="muted">These are your assessments, not a measured productivity gain or an accuracy benchmark. Missing time estimates are excluded. Results are grouped by the time you recorded them.</p>{summary.weekly.recorded > 0 && <div className="ledger-table-scroll"><table><thead><tr><th>Mode</th><th>Used</th><th>With edits</th><th>Not used</th><th>Corrections confirmed</th><th>Minutes saved</th></tr></thead><tbody>{Object.entries(summary.byMode).map(([mode, count]) => <tr key={mode}><th>{modeNames[mode as keyof typeof modeNames]}</th><td>{count.used}</td><td>{count.edited}</td><td>{count.notUsed}</td><td>{count.confirmed}</td><td>{count.measured ? count.minutesSaved : '—'}</td></tr>)}</tbody></table></div>}</section>
    </TabsContent><TabsContent value="plans">
    <label>Show plans<select value={filter} onChange={e => setFilter(e.target.value)}><option value="open">In progress</option><option value="all">All plans and outcomes</option></select></label>
    {!plans.length && <p className="work-board-empty">Start with a guided brief or your own question. After a live answer, choose “Create action plan” to keep the next steps here.</p>}
    {plans.length > 0 && !visible.length && <p className="work-board-empty">Every result has been recorded and no actions remain open. Choose “All plans and outcomes” to review them.</p>}
    <div className="work-board-plans">{visible.map(({ session, turn, index }) => { const key = JSON.stringify([session.id, index]); return <details key={key} open={selectedPlan === key} onToggle={event => { if (event.currentTarget.open) setSelectedPlan(key); else setSelectedPlan(current => current === key ? null : current); }}><summary><span>{turn.work!.goal}</span><small>{actions.filter(a => a.sessionId === session.id && a.turnIndex === index).length} open actions{turn.work!.outcome ? ' · Outcome recorded' : ''}</small></summary><button className="subtle-button" disabled={busy} onClick={() => { onOpenChange(false); onOpenSession(session.id); }}>Open conversation: {session.title.slice(0, 80)}</button><WorkPlanPanel reviewed={!!turn.result.reviewedAnswer} value={turn.work} question={turn.question} busy={busy} onSave={plan => onSave(session.id, index, plan)} /></details>; })}</div>
    </TabsContent></Tabs>
  </DialogContent></Dialog>;
}
