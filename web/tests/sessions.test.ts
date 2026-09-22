import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessions, conversationHistory, sessionMarkdown, type Turn } from '../lib/sessions.ts';

const turn: Turn = { question: 'Which option?', mode: 'compare', result: { drafts: { openai: 'Choose A', claude: 'Choose B', gemini: 'Test both' }, reviews: {}, answer: '', errors: [], seconds: 2, demo: false } };
const session = { id: 'session-1', title: turn.question, turns: [turn], time: '2026-09-22T00:00:00Z' };
test('history restoration rejects corrupted records without losing valid sessions', () => {
  const saved = [null, { id: 'broken', turns: [null] }, session, session];
  assert.deepEqual(parseSessions(JSON.stringify(saved)), [session]);
  assert.deepEqual(parseSessions('{broken'), []);
  assert.deepEqual(parseSessions('null'), []);
});
test('unknown fields and injected keys cannot survive restoration', () => {
  const saved = { ...session, connections: { openai: { key: 'private-key' } }, turns: [{ ...turn, result: { ...turn.result, apiKey: 'private-key', drafts: { ...turn.result.drafts, secret: 'private-key' } } }] };
  assert.ok(!JSON.stringify(parseSessions(JSON.stringify([saved]))).includes('private-key'));
});
test('comparison follow-ups retain the answers and exclude demo turns', () => {
  const demo = { ...turn, result: { ...turn.result, demo: true }, question: 'Demo only' };
  const history = conversationHistory([demo, turn]);
  assert.equal(history.length, 2); assert.equal(history[0].content, turn.question);
  assert.match(history[1].content, /ChatGPT:\nChoose A/); assert.match(history[1].content, /Claude:\nChoose B/);
  assert.ok(!JSON.stringify(history).includes('Demo only'));
});
test('follow-up history preserves bounded complete turn pairs', () => {
  const history = conversationHistory(Array.from({ length: 9 }, (_, i) => ({ ...turn, question: `Q${i}`, result: { ...turn.result, answer: 'a'.repeat(31000) } })));
  assert.equal(history.length, 12); assert.equal(history[0].content, 'Q3'); assert.equal(history[1].content.length, 30000);
  assert.ok(history.every((v, i) => v.role === (i % 2 ? 'assistant' : 'user')));
});
test('exports preserve fallback and failure context', () => {
  const exported = sessionMarkdown([{ ...turn, result: { ...turn.result, answer: 'Choose A', fallback: true, errors: ['Synthesis unavailable'] } }]);
  assert.match(exported, /single-model draft fallback/); assert.match(exported, /Synthesis unavailable/); assert.match(exported, /## Claude draft/);
});
