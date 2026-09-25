import type { Session } from './sessions.ts';
import { workDate, workPlanSchema, type WorkPlan } from './work-plan.ts';

export type ActionFilter = 'open' | 'today' | 'upcoming' | 'undated' | 'completed';
export type ActionGroup = 'past' | 'today' | 'upcoming' | 'undated' | 'completed';
export const actionGroupLabels: Record<ActionGroup, string> = { past: 'Past planned dates', today: 'Today', upcoming: 'Upcoming', undated: 'No planned date', completed: 'Marked complete' };
export function localWorkDate(now = new Date()): string {
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function actionGroup(action: WorkPlan['actions'][number], today: string): ActionGroup {
  if (action.completedAt) return 'completed';
  if (!action.due) return 'undated';
  return action.due < today ? 'past' : action.due === today ? 'today' : 'upcoming';
}
export function workActionView(sessions: Session[], today: string, filter: ActionFilter = 'open', search = '') {
  workDate.parse(today);
  const query = search.trim().toLocaleLowerCase();
  const rank: Record<ActionGroup, number> = { past: 0, today: 1, upcoming: 2, undated: 3, completed: 4 };
  return sessions.flatMap(session => session.turns.flatMap((turn, turnIndex) => turn.result.demo ? [] : (turn.work?.actions ?? []).map(action => ({
    sessionId: session.id, sessionTitle: session.title, turnIndex, goal: turn.work!.goal, action, group: actionGroup(action, today),
  })))).filter(item => {
    const match = filter === 'open' ? item.group !== 'completed' : filter === 'today' ? item.group === 'past' || item.group === 'today' : item.group === filter;
    return match && (!query || [item.action.title, item.goal, item.sessionTitle].some(text => text.toLocaleLowerCase().includes(query)));
  }).sort((a, b) => rank[a.group] - rank[b.group] || (a.group === 'completed'
    ? Date.parse(b.action.completedAt!) - Date.parse(a.action.completedAt!)
    : (a.action.due ?? '').localeCompare(b.action.due ?? '')));
}

/** Change exactly one action on the latest plan; completion never creates an outcome. */
export function changeActionCompletion(plan: WorkPlan, actionId: string, completed: boolean, now = new Date()): WorkPlan {
  if (!plan.actions.some(action => action.id === actionId)) throw new Error('This action is no longer available. Open its plan to review the latest version.');
  return workPlanSchema.parse({ ...plan, actions: plan.actions.map(action => {
    if (action.id !== actionId) return action;
    const { completedAt, ...rest } = action;
    return completed ? { ...rest, completedAt: completedAt ?? now.toISOString() } : rest;
  }) });
}
