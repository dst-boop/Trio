import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { setAnswerFeedback } from '../lib/answer-feedback.ts';
import { answerFeedbackSchema, sessionMarkdown, serializeSessions, parseSessions, conversationHistory, type Session } from '../lib/sessions.ts';
import { exportBackup, parseBackup } from '../lib/backups.ts';
import { suggestMemory } from '../lib/memory-suggestions.ts';
import { branchConversation } from '../lib/branch-conversation.ts';

const result = { answer: 'A completed answer', drafts: { claude: 'A draft' }, reviews: {}, errors: [], seconds: 1, demo: false };
const source: Session = { id: 'one', title: 'A discussion', time: '', turns: [{ question: 'First question', mode: 'fast', result }, { question: 'Compare options', mode: 'compare', result: { ...result, answer: '' } }] };

test('feedback updates one live turn, preserves originals, supports Compare, and removes cleanly', () => {
  const original = structuredClone(source), other = { ...source, id: 'two' };
  const updated = setAnswerFeedback([source, other], 'one', 0, { rating: 'needs-work', note: '  Show a worked example  ' });
  assert.deepEqual(source, original); assert.equal(updated[1], other); assert.equal(updated[0].turns[0].result, result);
  assert.deepEqual(updated[0].turns[0].feedback, { rating: 'needs-work', note: 'Show a worked example' }); assert.equal(updated[0].turns[1], source.turns[1]);
  const comparison = setAnswerFeedback(updated, 'one', 1, { rating: 'helpful' });
  assert.equal(comparison[0].turns[1].feedback?.rating, 'helpful');
  assert.deepEqual(setAnswerFeedback(setAnswerFeedback(comparison, 'one', 0, null), 'one', 1, null), [source, other]);
  assert.deepEqual(conversationHistory(updated[0].turns), conversationHistory(source.turns), 'Feedback is not silently sent in normal follow-ups');
});

test('invalid targets, demos, empty answers, oversized notes and full storage fail without mutation', () => {
  for (const index of [-1, 2, 0.5]) assert.throws(() => setAnswerFeedback([source], 'one', index, { rating: 'helpful' }));
  assert.throws(() => setAnswerFeedback([source], 'missing', 0, { rating: 'helpful' }));
  for (const bad of [{ ...result, demo: true }, { ...result, answer: '', drafts: {} }]) assert.throws(() => setAnswerFeedback([{ ...source, turns: [{ ...source.turns[0], result: bad }] }], 'one', 0, { rating: 'helpful' }));
  assert.equal(answerFeedbackSchema.safeParse({ rating: 'verified' }).success, false);
  assert.throws(() => setAnswerFeedback([source], 'one', 0, { rating: 'helpful', note: 'x'.repeat(2001) }));
  const full = { ...source, turns: Array.from({ length: 45 }, () => ({ ...source.turns[0], result: { ...result, answer: 'x'.repeat(120000) } })) };
  assert.throws(() => setAnswerFeedback([full], 'one', 0, { rating: 'helpful' })); assert.equal(full.turns[0].feedback, undefined);
});

test('V4 backups, history, Markdown and branches preserve feedback while stripping unknown metadata', () => {
  const records = setAnswerFeedback([source], 'one', 0, { rating: 'needs-work', note: 'Explain uncertainty' });
  const exported = exportBackup(records); assert.equal(JSON.parse(exported).version, 4);
  assert.deepEqual(parseBackup(exported), records); assert.deepEqual(parseSessions(serializeSessions(records)), records);
  assert.match(sessionMarkdown(records[0].turns), /Your feedback\n\nNeeds work\n\nExplain uncertainty/);
  assert.deepEqual(branchConversation(records, 'one', 0, 'Copy', 'copy').session.turns[0].feedback, records[0].turns[0].feedback);
  assert.equal(z.object({ version: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).safeParse(JSON.parse(exported)).success, false);
  for (const version of [1, 2, 3]) assert.deepEqual(parseBackup(JSON.stringify({ ...JSON.parse(exportBackup([source])), version })), [source]);
  const injected = JSON.parse(exported); injected.sessions[0].turns[0].feedback.key = 'never-persist';
  assert.ok(!JSON.stringify(parseBackup(JSON.stringify(injected))).includes('never-persist'));
});

test('memory suggestions receive explicit bounded feedback as data with accuracy safeguards, without auto-saving', async () => {
  const feedback = { rating: 'needs-work' as const, note: 'Use short worked examples. My correction is a claim, not proof.' };
  const records = setAnswerFeedback([source], 'one', 0, feedback); const snapshot = structuredClone(records);
  let calls = 0;
  const fetcher = (async (url, init) => {
    calls++; assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(init!.body as string), input = JSON.parse(body.messages[0].content);
    assert.deepEqual(input.conversation[0].user_feedback, feedback); assert.equal(input.conversation[1].user_feedback, undefined);
    assert.match(body.system, /not proof of accuracy/); assert.match(body.system, /do not turn a rating into an inferred preference/); assert.match(body.system, /do not.*store factual corrections as verified facts/);
    assert.ok(!body.system.includes(feedback.note));
    return Response.json({ content: [{ type: 'text', text: '- Prefers short worked examples.' }] });
  }) as typeof fetch;
  assert.equal(await suggestMemory(records[0], '', { provider: 'claude', key: 'fake-key', model: 'claude-sonnet-5' }, new AbortController().signal, fetcher), '- Prefers short worked examples.');
  assert.equal(calls, 1); assert.deepEqual(records, snapshot);
});
