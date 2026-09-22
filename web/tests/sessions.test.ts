import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessions, serializeSessions, conversationHistory, sessionMarkdown, type Turn } from '../lib/sessions.ts';

const turn: Turn = { question: 'Which option?', mode: 'compare', result: { drafts: { openai: 'Choose A', claude: 'Choose B', gemini: 'Test both' }, reviews: {}, answer: '', errors: [], seconds: 2, demo: false } };
const session = { id: 'session-1', title: turn.question, turns: [turn], time: '2026-09-22T00:00:00Z' };

test('long conversations survive the same storage limits used when saving', () => {
  const long = { ...session, turns: Array.from({ length: 205 }, (_, i) => ({ ...turn, question: `Question ${i}` })) };
  assert.deepEqual(parseSessions(serializeSessions([long])), [long]);
});

test('saving rejects unreadable snapshots without truncating answers', () => {
  const largeTurn = { ...turn, result: { ...turn.result, answer: 'a'.repeat(120000) } };
  assert.throws(() => serializeSessions([{ ...session, turns: Array(43).fill(largeTurn) }]), /storage limits/);
  assert.throws(() => serializeSessions([{ ...session, turns: [{ ...turn, result: { ...turn.result, answer: 'a'.repeat(120001) } }] }]));
  assert.throws(() => serializeSessions(Array.from({ length: 31 }, (_, i) => ({ ...session, id: String(i) }))));
});

test('saving strips unknown fields before they reach browser storage', () => {
  const snapshot = serializeSessions([{ ...session, ...{ connections: { openai: { key: 'not-for-storage' } } }, turns: [{ ...turn, result: { ...turn.result, ...{ key: 'not-for-storage' } } }] }]);
  assert.ok(!snapshot.includes('not-for-storage'));
  assert.deepEqual(parseSessions(snapshot), [session]);
});
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
  assert.match(exported, /single-model fallback answer/); assert.match(exported, /Synthesis unavailable/); assert.match(exported, /## Claude draft/);
});

test('deep council restoration and export retain originals, reviews and revisions', () => {
  const deep: Turn = { ...turn, mode: 'deep', result: { ...turn.result, reviews: { claude: 'Check the assumption' }, revisions: { openai: 'Choose A after checking the assumption' }, answer: 'A with caveats' } };
  const saved = { ...session, turns: [deep] };
  assert.deepEqual(parseSessions(JSON.stringify([saved])), [saved]);
  const exported = sessionMarkdown([deep]);
  assert.match(exported, /Mode: deep/);
  assert.match(exported, /## ChatGPT draft\n\nChoose A/);
  assert.match(exported, /## Claude review\n\nCheck the assumption/);
  assert.match(exported, /## ChatGPT revised answer\n\nChoose A after checking the assumption/);
  assert.equal(conversationHistory([deep])[1].content, 'A with caveats');
});
