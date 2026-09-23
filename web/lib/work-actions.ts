import { serializeSessions, type Session } from './sessions.ts';
import { workPlanSchema, type WorkPlan } from './work-plan.ts';
import type { Mode } from './trio.ts';

/** Work belongs to a completed live answer, never a partial or prepared example. */
export function setWorkPlan(sessions: Session[], sessionId: string, turnIndex: number, plan: WorkPlan | null): Session[] {
  const turn = sessions.find(s => s.id === sessionId)?.turns[turnIndex];
  if (!Number.isInteger(turnIndex) || !turn || turn.result.demo || !(turn.result.answer || Object.values(turn.result.drafts).some(Boolean))) throw new Error('Choose a completed live answer for this plan.');
  const parsed = plan === null ? undefined : workPlanSchema.parse(plan);
  if (parsed?.outcome && parsed.outcome.correction !== 'not-assessed' && !turn.result.reviewedAnswer) throw new Error('Correction assessments require an answer checked by the team.');
  const next = sessions.map(s => s.id !== sessionId ? s : { ...s, turns: s.turns.map((t, i) => {
    if (i !== turnIndex) return t;
    const { work: previous, ...rest } = t;
    return parsed ? { ...rest, work: parsed } : rest;
  }) });
  serializeSessions(next);
  return next;
}

export function openWork(sessions: Session[]) {
  return sessions.flatMap(session => session.turns.flatMap((turn, turnIndex) => turn.result.demo ? [] : (turn.work?.actions ?? []).filter(action => !action.completedAt).map(action => ({ sessionId: session.id, sessionTitle: session.title, turnIndex, goal: turn.work!.goal, action }))));
}

export function workSummary(sessions: Session[], now = new Date()) {
  const plans = sessions.flatMap(s => s.turns.filter(t => !t.result.demo && t.work).map(t => t.work!));
  const empty = () => ({ recorded: 0, used: 0, edited: 0, notUsed: 0, confirmed: 0, rejected: 0, measured: 0, minutesSaved: 0 });
  const weekly = empty(), byMode: Partial<Record<Mode, ReturnType<typeof empty>>> = {};
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  for (const session of sessions) for (const turn of session.turns) {
    const outcome = !turn.result.demo && turn.work?.outcome;
    if (!outcome) continue;
    const recorded = Date.parse(outcome.recordedAt);
    if (recorded < cutoff || recorded > now.getTime()) continue;
    const mode = byMode[turn.mode] ??= empty();
    for (const totals of [weekly, mode]) {
      totals.recorded++;
      if (outcome.disposition === 'not-used') totals.notUsed++;
      else { totals.used++; if (outcome.disposition === 'edited') totals.edited++; }
      if (turn.result.reviewedAnswer && outcome.correction === 'confirmed') totals.confirmed++;
      if (turn.result.reviewedAnswer && outcome.correction === 'rejected') totals.rejected++;
      if (outcome.minutesSaved !== undefined) { totals.measured++; totals.minutesSaved += outcome.minutesSaved; }
    }
  }
  return { open: openWork(sessions).length, completedActions: plans.reduce((n, p) => n + p.actions.filter(a => a.completedAt).length, 0), outcomes: plans.filter(p => p.outcome).length, weekly, byMode };
}
