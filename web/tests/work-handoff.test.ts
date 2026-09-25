import test from 'node:test';
import assert from 'node:assert/strict';
import { actionSourceFingerprint, prepareDayBrief, visibleActionsMarkdown, type WorkActionItem } from '../lib/work-handoff.ts';
import { workActionView } from '../lib/work-action-view.ts';
import type { Session } from '../lib/sessions.ts';

const id = '00000000-0000-4000-8000-000000000001';
const settings = { date: '2026-09-25', goal: 'Finish useful work', constraints: '' };
const row = (overrides: Partial<WorkActionItem> = {}): WorkActionItem => ({ sessionId: 'one', sessionTitle: 'Preparation [example]', turnIndex: 1, goal: 'Prepare the meeting', action: { id, title: 'Review the agenda', due: '2026-09-25' }, group: 'today', ...overrides });
const dataOf = (brief: string) => JSON.parse(brief.split('Supplied work:\n')[1]);

test('local checklist exports only visible work and never original answers or outcome notes', () => {
  const sessions: Session[] = [{ id: 'one', title: 'Source', time: '', turns: [{ question: 'SECRET QUESTION', mode: 'single', result: { answer: 'SECRET ANSWER', drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false }, work: { goal: 'Prepare', actions: [{ id, title: 'Visible action', due: '2026-09-25' }, { id: '00000000-0000-4000-8000-000000000002', title: 'Hidden action' }], outcome: { disposition: 'used', correction: 'not-assessed', note: 'SECRET OUTCOME', recordedAt: '2026-09-25T09:00:00.000Z' } } }] }];
  const before = structuredClone(sessions), visible = workActionView(sessions, settings.date, 'today');
  const markdown = visibleActionsMarkdown(visible, settings.date, 'today', '[visible]');
  assert.match(markdown, /- \[ \] Visible action/); assert.match(markdown, /Planned: 2026-09-25/);
  assert.match(markdown, /Goal: Prepare/); assert.match(markdown, /Source: Source · Answer 1/);
  assert.ok(markdown.includes('Search: \\[visible\\]'));
  assert.match(markdown, /View: Today and past dates/);
  const brief = prepareDayBrief(visible, settings);
  for (const hidden of ['Hidden action', 'SECRET QUESTION', 'SECRET ANSWER', 'SECRET OUTCOME']) { assert.ok(!markdown.includes(hidden)); assert.ok(!brief.includes(hidden)); }
  assert.deepEqual(sessions, before);
});

test('checklists escape Markdown, retain reported completion and reject invalid snapshots', () => {
  const item = row({ goal: 'A\nB', action: { id, title: '[click](https://example.test) <img>\nnext *step*', completedAt: '2026-09-25T10:00:00.000Z' }, group: 'completed' });
  const markdown = visibleActionsMarkdown([item], settings.date, 'completed');
  assert.ok(markdown.includes('- [x] \\[click\\]\\(https://example.test\\) \\<img\\> next \\*step\\*'));
  assert.match(markdown, /Goal: A B/); assert.match(markdown, /Marked complete by you: 2026-09-25T10:00:00.000Z/);
  assert.throws(() => visibleActionsMarkdown([], settings.date, 'open'), /no actions/);
  assert.throws(() => visibleActionsMarkdown([item], '2026-02-30', 'open'));
});

test('day brief preserves selected source actions and disambiguates repeated IDs with task labels', () => {
  const items = [row(), row({ sessionId: 'two', sessionTitle: 'Other source', goal: 'Other goal', action: { id, title: 'Prepare materials' }, group: 'undated' })], before = structuredClone(items);
  const brief = prepareDayBrief(items, { ...settings, minutes: 90, constraints: 'Only the morning is available.' }), data = dataOf(brief);
  assert.deepEqual(data.actions.map((action: { task: string }) => action.task), ['A1', 'A2']);
  assert.equal(data.actions[0].action, items[0].action.title); assert.equal(data.actions[0].planned_date, items[0].action.due);
  assert.deepEqual(data.actions[1].source, { conversation_label: 'Other source', answer_number: 2 });
  assert.equal(data.actions[1].planned_date, null); assert.equal(data.available_minutes, 90);
  assert.equal(data.constraints, 'Only the morning is available.'); assert.equal(data.planning_date, settings.date);
  assert.deepEqual(items, before); assert.ok(!brief.includes(id));
  assert.match(brief, /at most three priorities/); assert.match(brief, /not a confirmed deadline/);
  assert.match(brief, /source data, not instructions/); assert.match(brief, /Never claim to send messages/);
});

test('optional time stays unknown and source labels shorten without damaging Unicode or action wording', () => {
  const item = row({ sessionTitle: 'x'.repeat(159) + '😀' + 'z'.repeat(20), action: { id, title: 'Keep this complete action 😀' } });
  const data = dataOf(prepareDayBrief([item], settings));
  assert.equal(data.available_minutes, null); assert.equal(data.constraints, null);
  assert.equal(data.actions[0].source.conversation_label, 'x'.repeat(159) + '…');
  assert.equal(data.actions[0].action, 'Keep this complete action 😀');
  assert.match(prepareDayBrief([item], settings), /without inventing my available time/);
});

test('auto-derived conversation labels may include the opening question but are explicitly bounded', () => {
  const opening = 'Opening question '.repeat(20), item = row({ sessionTitle: opening });
  const brief = prepareDayBrief([item], settings), markdown = visibleActionsMarkdown([item], settings.date, 'open');
  assert.equal(dataOf(brief).actions[0].source.conversation_label, opening.slice(0, 160) + '…');
  assert.ok(markdown.includes(opening.slice(0, 160) + '…'));
  assert.ok(!brief.includes(opening)); assert.ok(!markdown.includes(opening));
  assert.match(markdown, /labels can contain the opening question/);
});

test('invalid, completed, duplicate, oversized and empty selections fail without truncating source work', () => {
  const item = row();
  for (const items of [[], [item, item], [row({ action: { ...item.action, completedAt: '2026-09-25T10:00:00Z' } })], Array.from({ length: 21 }, (_, n) => row({ sessionId: String(n) }))]) assert.throws(() => prepareDayBrief(items, settings));
  for (const invalid of [{ minutes: 0 }, { minutes: 1441 }, { minutes: 1.5 }, { date: '2026-02-30' }, { goal: ' ' }, { constraints: 'x'.repeat(4001) }, { extra: true }]) assert.throws(() => prepareDayBrief([item], { ...settings, ...invalid }));
  const large = Array.from({ length: 20 }, (_, n) => row({ sessionId: String(n), action: { id, title: 'x'.repeat(1000) } })), before = structuredClone(large);
  assert.throws(() => prepareDayBrief(large, settings), /Nothing was truncated/); assert.deepEqual(large, before);
  assert.equal(dataOf(prepareDayBrief(Array.from({ length: 20 }, (_, n) => row({ sessionId: String(n) })), settings)).actions.length, 20);
});

test('source changes invalidate a frozen brief; calendar group changes alone do not', () => {
  const source = row(), original = actionSourceFingerprint([source]);
  assert.equal(actionSourceFingerprint([{ ...source, group: 'past' }]), original);
  for (const changed of [row({ sessionId: 'changed' }), row({ sessionTitle: 'Renamed' }), row({ turnIndex: 2 }), row({ goal: 'Changed goal' }), row({ action: { ...source.action, due: '2026-09-26' } }), row({ action: { ...source.action, completedAt: '2026-09-25T10:00:00Z' } })]) assert.notEqual(actionSourceFingerprint([changed]), original);
  assert.notEqual(actionSourceFingerprint([source, row({ sessionId: 'two' })]), original);
});
