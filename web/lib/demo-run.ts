import { providers, type Mode, type ProviderId, type Result } from './trio.ts';

// Prepared, clearly labeled examples for Demo mode. They never call a provider
// and never enter live conversation context.
export const demoQuestion = 'Design a practical 30-day plan to turn an idea into a validated product.';
const demoDrafts = [
  'Start with the problem, not the product.\n\nWeek 1: Interview 8–10 people in one customer segment. Ask about the last time they encountered the problem and how they solve it today.\n\nWeek 2: Test a simple offer before building.\n\nWeek 3: Deliver the core result manually for three pilot users.\n\nWeek 4: Compare repeat use, willingness to pay, and the effort to deliver. Build only what the evidence supports.',
  'Define what would disprove the idea before testing it.\n\nChoose one audience and one painful workflow. Record existing workarounds, their cost, and who owns the buying decision. Avoid asking whether people “like” the idea.\n\nUse a concierge pilot with a clear success measure. Separate polite enthusiasm from a concrete commitment. At day 30, decide whether to continue, change the customer segment, or stop.',
  'Create a small learning loop: observe → prototype → test → measure.\n\nMap the workflow and find the slowest or most frustrating step. Make a clickable prototype around that single step, then test with five prospective users.\n\nTrack task completion and reasons for abandonment. Use a simple experiment log so each week starts with evidence from the previous one. A small sample is directional evidence, not proof of market demand.',
];
const demoReviews = [
  'Strongest shared idea: test one painful problem with a narrow audience.\n\nImprovement: choose the decision criteria before the pilot. Interviews alone do not validate willingness to pay.\n\nOpen question: which audience can you reach in the first week?',
  'The plans agree on a small experiment, but agreement is not external validation.\n\nAvoid treating 8–10 interviews as statistically representative. Capture contradictory evidence, not just positive feedback. Make the stop or pivot decision explicit.',
  'Combine the practical weekly plan with a clear experiment log.\n\nMeasure an actual behavior, such as repeated use or a pilot commitment. Keep the prototype small enough to revise during the month. Pricing and sample size remain assumptions to test.',
];
const demoRevisions = [
  '## Revised plan\n\nInterview one reachable customer segment, then run a small concierge pilot. Before the pilot, write down the behavior that would justify continuing: repeated use, a concrete commitment, or a measurable improvement over the current workaround.\n\n### Changes and remaining uncertainties\n\nAdded decision criteria before testing, in response to the reviews. Interviews can reveal problems but cannot establish willingness to pay. The appropriate threshold depends on the business; this small sample cannot prove demand.',
  '## Revised plan\n\nKeep an experiment log with the hypothesis, evidence for and against it, and the next decision. Pair interviews with a task-based prototype test and a paid or otherwise concrete pilot commitment. Decide at day 30 whether to continue, change the audience, or stop.\n\n### Changes and remaining uncertainties\n\nAdded observable task completion and a weekly schedule from the other drafts. A commitment is stronger evidence than praise, but still does not establish retention. Pricing needs a separate test.',
  '## Revised plan\n\nUse the prototype to test a single painful workflow, then deliver the outcome manually for a small pilot group. Record task completion, repeat use, and delivery effort. Define stop criteria before starting, and document contradictory feedback.\n\n### Changes and remaining uncertainties\n\nReplaced a prototype-only success measure with a real pilot commitment. Five prototype users provide directional usability feedback, not a reliable estimate of market demand. Repeat the experiment with a broader sample before scaling.',
];
const demoFinal = 'Make the first 30 days a learning sprint. Your goal is evidence that a specific group will act on your offer.\n\n01 — Find the problem · Days 1–7\nPick one reachable customer segment. Interview 8–10 people about a recent experience, current workarounds, and the cost of the problem. Record evidence that challenges your idea.\n\n02 — Test the offer · Days 8–14\nWrite a one-sentence promise and build a simple prototype. Ask five prospective users to complete the core task. Define a measurable success threshold before you run the pilot.\n\n03 — Deliver the outcome · Days 15–23\nRun a small, hands-on pilot with three users. Deliver the result manually where possible. Track completion, repeated use, time saved, and willingness to commit.\n\n04 — Decide with evidence · Days 24–30\nCompare results with your original threshold. Continue if the behavior supports the idea; revise the audience or offer if it does not. Document what you still do not know.\n\nKeep in mind\nThese sample sizes are a starting point, not statistical validation. Positive feedback is weaker evidence than repeated use or a concrete commitment.\n\nYour first move: name the customer segment and the one problem you want to test.';

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const cancel = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export type DemoProgress = { result: (result: Result) => void; stage: (stage: string) => void; answerReady: () => void };

/** Replays the prepared example with the same stages a live run of `mode` would show. */
export async function runDemo(mode: Mode, lead: ProviderId, start: Result, signal: AbortSignal, progress: DemoProgress): Promise<Result> {
  let result = start;
  const participants = mode === 'single' ? providers.filter(p => p.id === lead) : providers;
  for (const participant of participants) { await delay(500, signal); result = { ...result, drafts: { ...result.drafts, [participant.id]: demoDrafts[providers.indexOf(participant)] } }; progress.result(result); }
  if (mode === 'council' || mode === 'deep') { progress.stage('review'); for (let i = 0; i < providers.length; i++) { await delay(400, signal); result = { ...result, reviews: { ...result.reviews, [providers[i].id]: demoReviews[i] } }; progress.result(result); } }
  if (mode === 'deep') { progress.stage('revision'); for (let i = 0; i < providers.length; i++) { await delay(400, signal); result = { ...result, revisions: { ...result.revisions, [providers[i].id]: demoRevisions[i] } }; progress.result(result); } }
  if (mode === 'single') result = { ...result, answer: result.drafts[lead]!, by: lead };
  else if (mode !== 'compare') { progress.stage('synthesis'); progress.answerReady(); await delay(700, signal); result = { ...result, answer: demoFinal, by: lead }; }
  return { ...result, seconds: mode === 'single' ? 0.5 : mode === 'deep' ? 4.6 : mode === 'council' ? 3.4 : mode === 'fast' ? 2.2 : 1.5 };
}
