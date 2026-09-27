import test from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../lib/demo-run.ts';
import type { Mode, Result } from '../lib/trio.ts';

const start = (): Result => ({ drafts: {}, reviews: {}, errors: [], answer: '', seconds: 0, demo: true });
async function replay(mode: Mode, signal = new AbortController().signal) {
  const stages: string[] = [], partials: Result[] = []; let answerReady = 0;
  const result = await runDemo(mode, 'claude', start(), signal, { result: r => partials.push(r), stage: s => stages.push(s), answerReady: () => answerReady++ });
  return { result, stages, partials, answerReady };
}

test('each demo mode shows the same stages a live run of that mode would', async () => {
  const single = await replay('single');
  assert.deepEqual(Object.keys(single.result.drafts), ['claude']);
  assert.equal(single.result.answer, single.result.drafts.claude); assert.equal(single.result.by, 'claude');
  assert.deepEqual(single.stages, []); assert.equal(single.answerReady, 0);

  const compare = await replay('compare');
  assert.equal(Object.keys(compare.result.drafts).length, 3); assert.equal(compare.result.answer, '');

  const council = await replay('council');
  assert.deepEqual(council.stages, ['review', 'synthesis']); assert.equal(Object.keys(council.result.reviews).length, 3);
  assert.equal(council.result.revisions, undefined); assert.ok(council.result.answer); assert.equal(council.answerReady, 1);

  const deep = await replay('deep');
  assert.deepEqual(deep.stages, ['review', 'revision', 'synthesis']); assert.equal(Object.keys(deep.result.revisions ?? {}).length, 3);
  assert.ok(deep.result.demo, 'demo results stay labelled as demo');
});

test('progress reports every partial result, and stopping keeps what already arrived', async () => {
  const controller = new AbortController();
  const partials: Result[] = [];
  const run = runDemo('council', 'claude', start(), controller.signal, { result: r => { partials.push(r); if (partials.length === 2) controller.abort(); }, stage: () => {}, answerReady: () => {} });
  await assert.rejects(run, (error: Error) => error.name === 'AbortError');
  assert.equal(partials.length, 2);
  assert.equal(Object.keys(partials.at(-1)!.drafts).length, 2, 'the last partial holds both finished drafts');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(runDemo('single', 'claude', start(), aborted.signal, { result: () => {}, stage: () => {}, answerReady: () => {} }), (error: Error) => error.name === 'AbortError');
});
