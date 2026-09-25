'use client';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { actionGroupLabels, changeActionCompletion, localWorkDate, workActionView, type ActionFilter, type ActionGroup } from '@/lib/work-action-view';
import type { Session } from '@/lib/sessions';
import type { WorkPlan } from '@/lib/work-plan';

const groupOrder: ActionGroup[] = ['past', 'today', 'upcoming', 'undated', 'completed'];
export function NextActions({ sessions, busy, onSave, onOpenPlan }: { sessions: Session[]; busy: boolean; onSave: (id: string, index: number, plan: WorkPlan | null) => boolean; onOpenPlan: (id: string, index: number) => void }) {
  const [filter, setFilter] = useState<ActionFilter>('open'), [search, setSearch] = useState('');
  const [today, setToday] = useState(localWorkDate);
  const actions = workActionView(sessions, today, filter, search);
  const hasPlans = sessions.some(s => s.turns.some(t => !t.result.demo && t.work));
  useEffect(() => {
    const refresh = () => setToday(localWorkDate());
    refresh(); const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  function complete(item: (typeof actions)[number], checked: boolean) {
    if (busy) return;
    const plan = sessions.find(s => s.id === item.sessionId)?.turns[item.turnIndex]?.work;
    if (!plan) { toast.error('This plan is no longer available.'); return; }
    try {
      if (onSave(item.sessionId, item.turnIndex, changeActionCompletion(plan, item.action.id, checked))) toast.success(checked ? 'Marked complete. Use the Completed filter to reopen it.' : 'Action reopened. It is back in your open actions.');
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not update this action.'); }
  }
  return <div className="next-actions">
    <p className="work-date-note">Today: <time dateTime={today}>{today}</time> · your device&apos;s local date. Planned dates do not schedule reminders.</p>
    <div className="work-action-filters"><label>Show actions<select aria-label="Action filter" value={filter} onChange={event => setFilter(event.target.value as ActionFilter)}><option value="open">All open actions</option><option value="today">Today and past dates</option><option value="upcoming">Upcoming</option><option value="undated">No planned date</option><option value="completed">Completed</option></select></label><label>Find an action<input type="search" aria-label="Search actions" placeholder="Action, goal or conversation…" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} /></label></div>
    {!actions.length && <div className="work-board-empty">{!hasPlans ? <p>After a live answer, choose “Create action plan” to keep your next steps here.</p> : search ? <><p>No actions match this search and filter.</p><button className="subtle-button" onClick={() => { setSearch(''); setFilter('open'); }}>Show all open actions</button></> : filter === 'open' ? <p>No open actions. Review your plans or the Completed filter to reopen an action.</p> : <p>No actions in this view. Choose another filter to see the rest of your work.</p>}</div>}
    {groupOrder.map(group => {
      const items = actions.filter(item => item.group === group); if (!items.length) return null;
      return <section className={`next-action-group group-${group}`} key={group} aria-label={actionGroupLabels[group]}><h3>{actionGroupLabels[group]} <span>{items.length}</span></h3><ul>{items.map(item => <li key={JSON.stringify([item.sessionId, item.turnIndex, item.action.id])}>
        <label className="next-action-check"><input type="checkbox" checked={Boolean(item.action.completedAt)} disabled={busy} aria-label={`${item.action.completedAt ? 'Reopen' : 'Complete'}: ${item.action.title}`} onChange={event => complete(item, event.target.checked)} /><span>{item.action.title}</span></label>
        <div className="next-action-details"><p>{item.goal}</p><small>{item.sessionTitle} · Answer {item.turnIndex + 1}</small><div className="next-action-footer"><small>{item.action.due ? <>Planned: <time dateTime={item.action.due}>{item.action.due}</time></> : 'No planned date'}</small><button className="subtle-button" onClick={() => onOpenPlan(item.sessionId, item.turnIndex)}>Open plan</button></div></div>
      </li>)}</ul></section>;
    })}
    <p className="muted work-completion-note">Completion is recorded by you. Recording completion does not record an outcome or a time estimate.</p>
  </div>;
}
