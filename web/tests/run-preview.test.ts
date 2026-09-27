import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunPreview, previewIntervalMs } from '../lib/run-preview.ts';
import { applyRunEvent } from '../lib/run-events.ts';
import type { Result, RunEvent } from '../lib/trio.ts';

const empty = (): Result => ({ answer: '', drafts: {}, reviews: {}, errors: [], demo: false, seconds: 0 });
const delta = (text: string): RunEvent => ({ type: 'contribution_delta', phase: 'synthesis', provider: 'openai', text });

test('a thousand streamed chunks retain every character with at most 22 preview paints', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const paints: Result[] = [];
  const preview = createRunPreview(result => paints.push(result));
  let result = empty();
  for (let i = 0; i < 1000; i++) {
    const event = delta(String(i % 10));
    result = applyRunEvent(result, event); preview.update(result, event);
    if (i === 0) assert.equal(paints[0].answer, '0', 'The first text is immediate');
    t.mock.timers.tick(1);
  }
  preview.flush();
  assert.equal(paints.at(-1)?.answer, '0123456789'.repeat(100));
  assert.ok(paints.length <= 22, `${paints.length} paints for 1000 chunks`);
  preview.dispose();
});

test('resets and authoritative final results cannot be overwritten by a pending preview', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const paints: Result[] = [], preview = createRunPreview(result => paints.push(result));
  let result = empty();
  const accept = (event: RunEvent) => { result = applyRunEvent(result, event); preview.update(result, event); };
  accept(delta('Old')); accept(delta(' partial'));
  accept({ type: 'contribution_start', provider: 'openai', phase: 'synthesis' });
  assert.equal(paints.at(-1)?.answer, '');
  t.mock.timers.tick(previewIntervalMs * 2);
  assert.equal(paints.at(-1)?.answer, '');
  accept(delta('New')); accept(delta(' partial'));
  const final = { ...empty(), answer: 'Authoritative completed answer' };
  accept({ type: 'final', result: final });
  assert.equal(paints.at(-1), final);
  t.mock.timers.tick(previewIntervalMs * 2);
  assert.equal(paints.at(-1), final);
  preview.dispose();
});

test('cancellation drops queued paints and ignores later events', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const paints: Result[] = [], preview = createRunPreview(result => paints.push(result));
  preview.update({ ...empty(), answer: 'First' }, delta('First'));
  preview.update({ ...empty(), answer: 'Queued' }, delta('Queued'));
  preview.dispose(); preview.flush();
  preview.update({ ...empty(), answer: 'Late' }, delta('Late'));
  t.mock.timers.tick(previewIntervalMs * 2);
  assert.deepEqual(paints.map(result => result.answer), ['First']);
});

test('interleaved model text remains isolated and an error is shown immediately', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const paints: Result[] = [], preview = createRunPreview(result => paints.push(result));
  let result = empty();
  for (const provider of ['openai', 'claude', 'gemini'] as const) {
    const event: RunEvent = { type: 'contribution_delta', phase: 'draft', provider, text: provider };
    result = applyRunEvent(result, event); preview.update(result, event);
  }
  const error: RunEvent = { type: 'error', text: 'A provider disconnected.' };
  result = applyRunEvent(result, error); preview.update(result, error);
  assert.deepEqual(paints.at(-1)?.drafts, { openai: 'openai', claude: 'claude', gemini: 'gemini' });
  assert.deepEqual(paints.at(-1)?.errors, ['A provider disconnected.']);
  preview.dispose();
});
