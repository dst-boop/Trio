import { z } from 'zod';

export const workDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Choose a valid calendar date.');
export const workActionSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(240),
  due: workDate.optional(), completedAt: z.string().datetime().optional(),
});
const minutes = z.number().int().min(-100000).max(100000);
export const workPlanSchema = z.object({
  goal: z.string().trim().min(1).max(300),
  actions: z.array(workActionSchema).max(20).refine(actions => new Set(actions.map(a => a.id)).size === actions.length),
  outcome: z.object({ disposition: z.enum(['used', 'edited', 'not-used']), correction: z.enum(['not-assessed', 'confirmed', 'rejected']), note: z.string().trim().max(2000), recordedAt: z.string().datetime(), minutesSaved: minutes.optional() }).optional(),
});
export type WorkPlan = z.infer<typeof workPlanSchema>;

export function workPlanMarkdown(plan: WorkPlan): string {
  return ['## Your action plan', plan.goal,
    ...plan.actions.map(a => `- [${a.completedAt ? 'x' : ' '}] ${a.title}${a.due ? ` (planned: ${a.due})` : ''}${a.completedAt ? ` — marked complete ${a.completedAt}` : ''}`),
    'Dates are planning dates, not scheduled reminders. Completion and outcomes are user-reported; Trio has not verified external execution.',
    plan.outcome ? `### Recorded outcome\n\n${{ used: 'Used', edited: 'Used with edits', 'not-used': 'Not used' }[plan.outcome.disposition]}\n\nCorrection assessment: ${plan.outcome.correction} (user-reported)\n\n${plan.outcome.note}\n\nRecorded: ${plan.outcome.recordedAt}` : '',
    plan.outcome?.minutesSaved !== undefined ? `Estimated minutes saved: ${plan.outcome.minutesSaved} (user-reported; negative means extra time).` : '',
  ].filter(Boolean).join('\n\n');
}
