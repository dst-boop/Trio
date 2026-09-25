import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { actionGroup, changeActionCompletion, localWorkDate, workActionView } from '../lib/work-action-view.ts';
import { workSummary } from '../lib/work-actions.ts';
import type { Session } from '../lib/sessions.ts';
import type { WorkPlan } from '../lib/work-plan.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const result = { drafts: {}, reviews: {}, answer: 'A completed answer', errors: [], seconds: 1, demo: false };
const fixture = (): Session[] => [{ id: 'one', title: 'Client preparation', time: '', turns: [{ question: 'Plan', mode: 'single', result, work: { goal: 'Prepare the review', actions: [
  { id: id(1), title: 'Later milestone', due: '2026-10-01' },
  { id: id(2), title: 'Today agenda', due: '2026-09-25' },
  { id: id(3), title: 'Earlier draft', due: '2026-09-23' },
  { id: id(4), title: 'Undated follow-up' },
  { id: id(5), title: 'Finished task', due: '2026-09-22', completedAt: '2026-09-24T18:00:00.000Z' },
] } }] }, { id: 'two', title: 'Internal operations', time: '', turns: [{ question: 'Other', mode: 'single', result, work: { goal: 'Reduce repeated work', actions: [
  { id: id(1), title: 'Other plan with the same action ID', due: '2026-09-24' },
  { id: id(6), title: 'Finished later', completedAt: '2026-09-25T11:00:00.000Z' },
] } }] }];

test('open work sorts by calendar date, retains source identity, and excludes completed and demo actions', () => {
  const sessions = fixture(), before = structuredClone(sessions);
  sessions.push({ ...sessions[0], id: 'demo', turns: [{ ...sessions[0].turns[0], result: { ...result, demo: true } }] });
  const actions = workActionView(sessions, '2026-09-25');
  assert.deepEqual(actions.map(item => item.group), ['past', 'past', 'today', 'upcoming', 'undated']);
  assert.deepEqual(actions.map(item => item.action.title), ['Earlier draft', 'Other plan with the same action ID', 'Today agenda', 'Later milestone', 'Undated follow-up']);
  assert.equal(actions[1].sessionId, 'two'); assert.equal(actions[1].turnIndex, 0);
  assert.deepEqual(sessions.slice(0, 2), before);
  assert.throws(() => workActionView(sessions, '2026-02-30'));
});

test('filters and literal search combine across action, goal and conversation while keeping completed separate', () => {
  const sessions = fixture();
  assert.equal(workActionView(sessions, '2026-09-25', 'today').length, 3);
  assert.deepEqual(workActionView(sessions, '2026-09-25', 'upcoming').map(item => item.action.id), [id(1)]);
  assert.deepEqual(workActionView(sessions, '2026-09-25', 'undated').map(item => item.action.id), [id(4)]);
  assert.deepEqual(workActionView(sessions, '2026-09-25', 'completed').map(item => item.action.id), [id(6), id(5)]);
  assert.equal(workActionView(sessions, '2026-09-25', 'open', '  CLIENT  ').length, 4);
  assert.equal(workActionView(sessions, '2026-09-25', 'today', 'reduce repeated').length, 1);
  assert.equal(workActionView(sessions, '2026-09-25', 'open', 'finished').length, 0);
  assert.equal(workActionView(sessions, '2026-09-25', 'completed', 'finished').length, 2);
  assert.equal(workActionView(sessions, '2026-09-25', 'open', '.*').length, 0);
});

test('calendar grouping handles year and leap-day transitions without parsing planning dates as local timestamps', () => {
  assert.equal(actionGroup({ id: id(1), title: 'Year end', due: '2026-12-31' }, '2027-01-01'), 'past');
  assert.equal(actionGroup({ id: id(1), title: 'Leap day', due: '2028-02-29' }, '2028-03-01'), 'past');
  assert.equal(actionGroup({ id: id(1), title: 'Today', due: '2028-02-29' }, '2028-02-29'), 'today');
  assert.match(localWorkDate(new Date(2026, 0, 2, 1, 2)), /^2026-01-02$/);
  const moduleURL = new URL('../lib/work-action-view.ts', import.meta.url).href;
  for (const [TZ, timestamp, expected] of [['America/New_York', '2026-03-08T04:30:00Z', '2026-03-07'], ['Pacific/Kiritimati', '2026-12-31T12:30:00Z', '2027-01-01']]) {
    const script = `import {localWorkDate} from ${JSON.stringify(moduleURL)}; process.stdout.write(localWorkDate(new Date(${JSON.stringify(timestamp)})));`;
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' }), expected);
  }
});

test('completion and reopening touch one action only, preserve dates and outcomes, and never invent time saved', () => {
  const sessions = fixture(), original = sessions[0].turns[0].work!;
  const plan: WorkPlan = { ...original, outcome: { disposition: 'edited', correction: 'not-assessed', note: 'My own note', recordedAt: '2026-09-25T09:00:00.000Z', minutesSaved: -4 } };
  const now = new Date('2026-09-25T12:00:00.000Z');
  const changed = changeActionCompletion(plan, id(2), true, now);
  assert.equal(changed.actions[1].completedAt, now.toISOString()); assert.equal(changed.actions[1].due, '2026-09-25');
  assert.deepEqual(changed.outcome, plan.outcome); assert.deepEqual(changed.actions[0], plan.actions[0]); assert.equal(plan.actions[1].completedAt, undefined);
  assert.equal(changeActionCompletion(changed, id(2), true, new Date('2026-09-26')).actions[1].completedAt, now.toISOString(), 'An already-completed action retains its timestamp');
  assert.deepEqual(changeActionCompletion(changed, id(2), false), plan);
  const undated = changeActionCompletion(plan, id(4), true, now);
  assert.equal(Object.hasOwn(undated.actions[3], 'due'), false);
  assert.equal(Object.hasOwn(changeActionCompletion(undated, id(4), false).actions[3], 'due'), false);
  assert.throws(() => changeActionCompletion(plan, id(99), true), /no longer available/);
  sessions[0].turns[0].work = changeActionCompletion(original, id(2), true, now);
  assert.equal(workSummary(sessions, now).outcomes, 0); assert.equal(workSummary(sessions, now).weekly.measured, 0);
  assert.equal(sessions[1].turns[0].work!.actions[0].completedAt, undefined, 'Same IDs in other plans remain untouched');
});
