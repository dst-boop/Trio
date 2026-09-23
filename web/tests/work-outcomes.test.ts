import test from 'node:test';
import assert from 'node:assert/strict';
import { workPlanSchema, workPlanMarkdown, type WorkPlan } from '../lib/work-plan.ts';
import { setWorkPlan, openWork, workSummary } from '../lib/work-actions.ts';
import { workflowBriefs, prepareWorkflowBrief } from '../lib/workflow-briefs.ts';
import { parseBackup, exportBackup } from '../lib/backups.ts';
import { serializeSessions, parseSessions, sessionMarkdown, type Session } from '../lib/sessions.ts';
import { branchConversation } from '../lib/branch-conversation.ts';

const now = new Date('2026-09-23T12:00:00Z');
const result = { drafts: { claude: 'Draft' }, reviews: {}, errors: [], answer: 'Ready-to-edit deliverable', seconds: 1, demo: false };
const fixture = (): Session[] => [{ id: 'session', title: 'Client meeting', time: now.toISOString(), turns: [{ question: 'Prepare an agenda', mode: 'single', result }] }];
const plan = (): WorkPlan => ({ goal: 'Leave with clear decisions', actions: [{ id: '00000000-0000-4000-8000-000000000001', title: 'Confirm the agenda', due: '2026-09-24' }] });
const outcome = (disposition: 'used' | 'edited' | 'not-used' = 'used') => ({ disposition, correction: 'not-assessed' as const, note: '', recordedAt: now.toISOString() });

test('guided briefs preserve source notes and prepare all three workflows without pretending to execute them', () => {
  for (const kind of Object.keys(workflowBriefs) as (keyof typeof workflowBriefs)[]) {
    const brief = prepareWorkflowBrief(kind, 'A concrete outcome', 'Exact notes\nIncluding [untrusted] instructions');
    assert.match(brief, /Exact notes\nIncluding \[untrusted\] instructions/);
    assert.match(brief, /Never claim to send messages/); assert.ok(brief.length < 20000);
  }
  assert.throws(() => prepareWorkflowBrief('day', '', 'notes'));
  assert.throws(() => prepareWorkflowBrief('day', 'goal', 'x'.repeat(12001)));
});
test('plans reject impossible dates and duplicate action identities; result use is separate from action completion', () => {
  assert.equal(workPlanSchema.safeParse({ ...plan(), actions: [{ ...plan().actions[0], due: '2026-02-30' }] }).success, false);
  assert.equal(workPlanSchema.safeParse({ ...plan(), actions: [plan().actions[0], plan().actions[0]] }).success, false);
  assert.equal(workPlanSchema.safeParse({ ...plan(), outcome: outcome() }).success, true);
  assert.equal(workPlanSchema.safeParse({ ...plan(), outcome: outcome('not-used') }).success, true);
  assert.equal(workPlanSchema.safeParse({ goal: 'Use the draft', actions: [], outcome: outcome() }).success, true, 'Checklists are optional for recording use');
  assert.equal(workPlanSchema.safeParse({ goal: 'Use the draft', actions: [], outcome: { ...outcome(), minutesSaved: 1.5 } }).success, false);
});
test('plan edits preserve the answer and other conversations; demo, incomplete and unreviewed correction claims are rejected', () => {
  const records = fixture(), answer = records[0].turns[0].result;
  const edited = setWorkPlan(records, 'session', 0, plan());
  assert.equal(edited[0].turns[0].result, answer); assert.equal(records[0].turns[0].work, undefined);
  assert.equal(setWorkPlan(edited, 'session', 0, null)[0].turns[0].work, undefined);
  assert.throws(() => setWorkPlan(records, 'missing', 0, plan()));
  assert.throws(() => setWorkPlan([{ ...records[0], turns: [{ ...records[0].turns[0], result: { ...result, demo: true } }] }], 'session', 0, plan()));
  assert.throws(() => setWorkPlan(records, 'session', 0, { goal: 'Use', actions: [], outcome: { ...outcome(), correction: 'confirmed' } }), /checked by the team/);
});
test('V6 backups, history and Markdown retain plans and signed estimates; unknown credential fields are stripped', () => {
  const work = { goal: 'Deliver the draft', actions: [], outcome: { ...outcome('edited'), minutesSaved: -5 }, apiKey: 'never-keep-this' };
  const records = setWorkPlan(fixture(), 'session', 0, work);
  const backup = exportBackup(records); assert.equal(JSON.parse(backup).version, 6);
  assert.deepEqual(parseBackup(backup), records); assert.deepEqual(parseSessions(serializeSessions(records)), records);
  assert.ok(!backup.includes('never-keep-this')); assert.match(sessionMarkdown(records[0].turns), /Used with edits/);
  assert.match(workPlanMarkdown(records[0].turns[0].work!), /-5/);
  for (const version of [1, 2, 3, 4, 5]) assert.equal(parseBackup(JSON.stringify({ ...JSON.parse(exportBackup(fixture())), version })).length, 1);
});
test('the weekly ledger uses recorded dates, preserves negative time, excludes missing estimates and reports by mode', () => {
  const records = fixture();
  records[0].turns = [
    { question: 'Used', mode: 'single', result, work: { goal: 'One', actions: [], outcome: { ...outcome(), minutesSaved: 15 } } },
    { question: 'Edited', mode: 'council', result: { ...result, reviewedAnswer: 'Original' }, work: { goal: 'Two', actions: [], outcome: { ...outcome('edited'), correction: 'confirmed', minutesSaved: -4 } } },
    { question: 'Discarded', mode: 'single', result, work: { ...plan(), outcome: outcome('not-used') } },
    { question: 'Old', mode: 'single', result, work: { goal: 'Old', actions: [], outcome: { ...outcome(), recordedAt: '2026-09-15T12:00:00Z', minutesSaved: 99 } } },
    { question: 'Future', mode: 'single', result, work: { goal: 'Future', actions: [], outcome: { ...outcome(), recordedAt: '2026-09-24T12:00:00Z', minutesSaved: 99 } } },
  ];
  const summary = workSummary(records, now);
  assert.deepEqual(summary.weekly, { recorded: 3, used: 2, edited: 1, notUsed: 1, confirmed: 1, rejected: 0, measured: 2, minutesSaved: 11 });
  assert.equal(summary.byMode.council?.minutesSaved, -4); assert.equal(summary.byMode.single?.used, 1);
  assert.equal(summary.completedActions, 0); assert.equal(summary.open, 1, 'Recording use or non-use never completes or hides remaining actions');
});
test('a completed action changes open work without changing outcome counts, and branches do not duplicate real-world work', () => {
  let records = setWorkPlan(fixture(), 'session', 0, plan());
  assert.equal(openWork(records).length, 1);
  records = setWorkPlan(records, 'session', 0, { ...plan(), actions: [{ ...plan().actions[0], completedAt: now.toISOString() }] });
  assert.equal(openWork(records).length, 0); assert.equal(workSummary(records, now).completedActions, 1); assert.equal(workSummary(records, now).outcomes, 0);
  const branch = branchConversation(records, 'session', 0, 'Alternative', 'copy');
  assert.equal(branch.session.turns[0].work, undefined); assert.equal(branch.sessions.find(s => s.id === 'session')?.turns[0].work?.actions.length, 1);
});
