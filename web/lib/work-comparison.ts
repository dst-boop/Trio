import { z } from 'zod';
import { estimateStandardCost } from './usage.ts';
import type { ProviderId, Usage } from './trio.ts';
import { timeZoneSchema } from './current-time.ts';

const provider = z.enum(['openai', 'claude', 'gemini']);
export const comparisonTask = z.object({
  title: z.string().trim().min(1).max(100),
  question: z.string().trim().min(10).max(4000),
  context: z.string().trim().max(8000),
  criteria: z.string().trim().min(10).max(2000),
  source: z.enum(['your-work', 'sample']),
}).strict();
export const comparisonSettings = z.object({
  baseline: provider,
  providers: z.array(provider).min(2).max(3).refine(p => new Set(p).size === p.length),
  maxCalls: z.number().int().min(1).max(30),
  timeoutSeconds: z.number().int().min(30).max(1800),
  timeZone: timeZoneSchema.default('UTC'),
}).strict().refine(s => s.providers.includes(s.baseline), 'The final writer must participate.');
const score = z.number().int().min(0).max(2);
const answerRating = z.object({useful: score, grounded: score, clear: score}).strict();
export const comparisonRatings = z.object({
  A: answerRating,
  B: answerRating,
  preference: z.enum(['A', 'B', 'tie', 'neither']),
  notes: z.string().trim().max(2000),
}).strict();
export type ComparisonTask = z.infer<typeof comparisonTask>;
export type ComparisonSettings = z.infer<typeof comparisonSettings>;
export type ComparisonRatings = z.infer<typeof comparisonRatings>;
export type AnswerLabel = 'A' | 'B';
export type ComparisonArm = 'single' | 'council';
export type ComparisonPhase = {
  arm: ComparisonArm;
  state: 'complete' | 'failed';
  answer: string;
  by?: ProviderId;
  elapsedMs: number;
  httpCalls: number;
  degraded: boolean;
  notes: string[];
  usage?: Usage;
};
export const defaultComparisonSettings: ComparisonSettings = {baseline:'openai',providers:['openai','claude','gemini'],maxCalls:12,timeoutSeconds:600,timeZone:'UTC'};
export const emptyComparisonTask: ComparisonTask = {title:'',question:'',context:'',criteria:'',source:'your-work'};
export const ratingRubric = [
  {key:'useful',label:'Useful',description:'Could you use this deliverable for the task? 0 = unusable, 1 = substantial edits, 2 = usable with minor or no edits.'},
  {key:'grounded',label:'Grounded in the facts',description:'Does it use the supplied facts without inventing important details? 0 = material errors, 1 = gaps to check, 2 = no material issues you found.'},
  {key:'clear',label:'Clear and actionable',description:'Is it easy to understand and act on? 0 = unclear, 1 = partly clear, 2 = clear next steps or a ready draft.'},
] as const;
export const comparisonSamples: ComparisonTask[] = [
  {title:'Fictional sample: meeting follow-up',source:'sample',question:'Draft a follow-up email of no more than 180 words and an internal checklist from these meeting notes. Use placeholders for names. Do not claim the email was sent.',context:'Fictional operations meeting. The client wants a one-page progress report every Friday. We agreed to send a draft report template on Tuesday; the client will approve or request changes by Thursday. The client has not named the person who will approve the template. Our analyst needs the current project milestones before producing the draft. We did not agree on a delivery date for those milestones. No budget or new service was approved.',criteria:'Capture the two agreed deadlines and both owners. Ask who approves the template and when we can receive the milestones without inventing an agreement. Separate external email from internal tasks. Do not introduce fees, budgets, dates or commitments absent from the notes.'},
  {title:'Fictional sample: plan a constrained day',source:'sample',question:'Make a realistic work plan for today, with a short timeline and a deferral list. Explain the one most important tradeoff.',context:'Fictional day: working hours 9:00-17:00. Fixed meeting 10:00-11:00 and lunch 12:00-12:30. A proposal due 14:00 needs 90 minutes. Reviewing that proposal takes a separate 30 minutes after drafting. A client follow-up due 16:00 takes 45 minutes. Inbox takes 30 minutes. Routine reporting takes 120 minutes and is due tomorrow at 17:00. Leave 30 minutes of buffer today. None of the tasks can be delegated. Avoid scheduling work outside working hours.',criteria:'Meet the proposal and follow-up deadlines, preserve fixed commitments and buffer, place the review after drafting, and account for task durations. If work is deferred, say how much and why. Do not claim to change a calendar or set a reminder.'},
  {title:'Fictional sample: test a business idea',source:'sample',question:'Design a two-week experiment for this idea. Give the hypothesis, test steps, evidence to record, and a decision rule. Keep the plan under 350 words.',context:'Fictional solo consultant wants to offer a weekly operations summary for small service businesses. They can spend 6 hours total and up to $100 over two weeks. They know 8 business owners but have not interviewed them. They have no paying customers for this service, no mailing list and no evidence of demand. They can manually prepare one sample using fictional data. No software should be built in this experiment.',criteria:'Fit within both budgets. Distinguish compliments from observable commitment. Do not assume respondents buy. State what would disconfirm the idea, avoid revenue guarantees, and explain the limitations of a small convenience sample.'},
];

export function comparisonEstimate(settings: ComparisonSettings, models: Partial<Record<ProviderId,string>>) {
  const nominalCalls = 2 * settings.providers.length + 2;
  let illustrativeUSD: number | null = 0;
  for (const p of settings.providers) {
    const cost = estimateStandardCost(models[p] ?? '', {input:2000,output:1000,cached:0});
    if (cost === null) { illustrativeUSD = null; break; }
    illustrativeUSD += cost * (2 + (p === settings.baseline ? 2 : 0));
  }
  return {nominalCalls,illustrativeUSD};
}

/** Presentation only. Stored original answers and grades are never rewritten. */
export function blindComparisonText(answer: string, models: Partial<Record<ProviderId,string>>) {
  let text = answer;
  for (const id of [...new Set(Object.values(models))].filter(Boolean).sort((a,b)=>b.length-a.length)) {
    text = text.split(id).join('[model]');
  }
  // Do not remove generic company names such as Google: these can be facts in
  // a business task. Wording, citations and style can still reveal an origin.
  return text.replace(/\b(?:ChatGPT|OpenAI|Anthropic|Claude|Gemini)\b/gi,'[model]');
}

export const comparisonLimitations = 'These are separate samples, not proof that collaboration caused an improvement. Your ratings record your judgment, not verified accuracy or measured time savings. Wording or style may reveal an origin despite hidden labels. Use the results to decide what to try next on similar work.';
export const comparisonAccounting = 'Calls are durable HTTP-attempt reservations; an interrupted dispatch may reserve an attempt without sending it. Failed calls can still be billed. Dollar amounts use configured standard token rates, are estimates rather than charges, and are unknown when usage is incomplete. Provider invoices remain authoritative.';
