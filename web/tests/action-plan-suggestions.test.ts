import test from 'node:test';
import assert from 'node:assert/strict';
import { actionPlanSource, planSuggestionRequestSchema, suggestActionPlan, suggestedActionsSchema, redactPlanText } from '../lib/action-plan-suggestions.ts';
import type { Turn } from '../lib/sessions.ts';
import type { ProviderId } from '../lib/trio.ts';

const turn: Turn = { question: 'Prepare a fictional meeting follow-up.', mode: 'single', result: { answer: 'Draft the template. Ask the client to name an approver. Do not send until reviewed.', drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false } };
const connection = { provider: 'openai' as const, key: 'synthetic-plan-key', model: 'gpt-6-astra' };
const suggestion = { goal: 'Prepare a reviewable follow-up', actions: ['Draft the template for review.', 'Ask the client to identify the approver.'] };
const output = (id: ProviderId, text: string, withUsage = true) => Response.json(id === 'openai' ? { output: [{ content: [{ type: 'output_text', text }] }], ...(withUsage ? { usage: { input_tokens: 80, output_tokens: 40 } } : {}) } : id === 'claude' ? { content: [{ type: 'text', text }], stop_reason: 'end_turn', ...(withUsage ? { usage: { input_tokens: 80, output_tokens: 40 } } : {}) } : { steps: [{ type: 'model_output', content: [{ type: 'text', text }] }], status: 'completed', ...(withUsage ? { usage: { total_input_tokens: 80, total_output_tokens: 40 } } : {}) });

test('action drafts strictly reject inferred completion, outcomes, dates and invalid source selectors', () => {
  assert.ok(suggestedActionsSchema.safeParse(suggestion).success);
  for (const value of [{ ...suggestion, completed: true }, { ...suggestion, outcome: 'used' }, { ...suggestion, due: '2026-09-30' }, { ...suggestion, actions: [{ title: 'Do it', completedAt: 'now' }] }, { ...suggestion, actions: Array(13).fill('Do it') }, { ...suggestion, goal: '' }]) assert.equal(suggestedActionsSchema.safeParse(value).success, false);
  const request = { sessionId: 'one', turnIndex: 0, revision: 1, connection };
  assert.ok(planSuggestionRequestSchema.safeParse(request).success);
  for (const patch of [{ turnIndex: -1 }, { revision: -1 }, { accountId: 'other' }, { question: 'arbitrary replacement' }, { connection: { ...connection, key: 'short' } }]) assert.equal(planSuggestionRequestSchema.safeParse({ ...request, ...patch }).success, false);
});

test('source is one completed live answer, with bounded balanced Compare excerpts and explicit shortening', () => {
  const source = actionPlanSource(turn); assert.equal(source.shortened, false);
  assert.throws(() => actionPlanSource({ ...turn, result: { ...turn.result, demo: true } }), /completed live/);
  assert.throws(() => actionPlanSource({ ...turn, result: { ...turn.result, answer: '' } }), /no completed text/);
  const sourceTurn = { ...turn, question: 'Q'.repeat(5000), mode: 'compare' as const, result: { ...turn.result, answer: '', drafts: { openai: 'A'.repeat(20000), claude: 'B'.repeat(20000), gemini: 'C'.repeat(20000) } } };
  const clipped = actionPlanSource(sourceTurn); assert.equal(clipped.question.length, 4000); assert.ok(clipped.answer.length <= 24000); assert.equal(clipped.shortened, true);
  for (const label of ['ChatGPT:', 'Claude:', 'Gemini:']) assert.ok(clipped.answer.includes(label));
});

test('each provider receives one non-streaming extraction call with no unrelated memory or execution capability', async () => {
  for (const id of ['openai', 'claude', 'gemini'] as const) {
    let calls = 0;
    const source = { ...turn, instructions: 'Unrelated session preference', result: { ...turn.result, memory: 'Private memory never included', reviews: { claude: 'Prior critique not included' } } };
    const result = await suggestActionPlan(source, { ...connection, provider: id }, [], new AbortController().signal, async (_, init) => {
      calls++; const body = JSON.parse(init!.body as string); assert.equal(body.stream, undefined); assert.equal(body.tools, undefined); assert.equal(init!.redirect, 'manual');
      const all = JSON.stringify(body); assert.ok(!all.includes('Private memory')); assert.ok(!all.includes('Prior critique')); assert.ok(!all.includes('Unrelated session'));
      assert.match(all, /Do not invent facts/); assert.match(all, /Do not mark actions complete/); assert.ok(all.includes(turn.question));
      return output(id, JSON.stringify(suggestion));
    });
    assert.equal(calls, 1); assert.deepEqual(result.suggestion, suggestion); assert.equal(result.usage.calls, 1); assert.equal(result.usage.reportedCalls, 1);
  }
});

test('stored and temporary keys are redacted from source and parsed outputs, including disabled providers', async () => {
  const keys = [connection.key, 'disabled-other-provider-key', 'included-workspace-key'];
  const before = structuredClone(turn);
  const source = { ...turn, question: keys.join(' '), result: { ...turn.result, answer: keys.join(' ') } };
  const result = await suggestActionPlan(source, connection, keys, new AbortController().signal, async (_, init) => {
    for (const key of keys) assert.ok(!(init!.body as string).includes(key));
    return output('openai', JSON.stringify({ goal: keys[0], actions: [keys[1], keys[2]] }));
  });
  for (const key of keys) assert.ok(!JSON.stringify(result).includes(key));
  assert.deepEqual(turn, before); assert.equal(redactPlanText('long-key-plus long-key', ['long-key', 'long-key-plus']), '[redacted] [redacted]');
  await assert.rejects(() => suggestActionPlan(turn, { ...connection, model: keys[1] }, keys, new AbortController().signal, async () => { assert.fail('Secret model ID must not be sent'); }), /model ID/);
});

test('one enclosing JSON fence is accepted locally without an additional call', async () => {
  let calls = 0;
  const result = await suggestActionPlan(turn, connection, [], new AbortController().signal, async () => { calls++; return output('openai', '```json\n' + JSON.stringify(suggestion) + '\n```'); });
  assert.deepEqual(result.suggestion, suggestion); assert.equal(calls, 1);
});

test('no paid repair occurs for malformed, oversized, truncated, refused or failed responses', async () => {
  const responses = [() => output('openai', 'Here is the plan:\n```json\n' + JSON.stringify(suggestion) + '\n```'), () => output('openai', JSON.stringify({ ...suggestion, complete: true })), () => output('openai', 'X'.repeat(12001)), () => Response.json({ status: 'incomplete', output: [{ content: [{ type: 'output_text', text: JSON.stringify(suggestion) }] }] }), () => Response.json({ error: 'sensitive provider diagnostic synthetic-plan-key' }, { status: 429 })];
  for (const next of responses) {
    let calls = 0;
    await assert.rejects(() => suggestActionPlan(turn, connection, [], new AbortController().signal, async () => { calls++; return next(); }), error => !String(error).includes('synthetic-plan-key'));
    assert.equal(calls, 1);
  }
});

test('missing usage remains unknown and cancellation or an invalid source does not dispatch', async () => {
  const result = await suggestActionPlan(turn, connection, [], new AbortController().signal, async () => output('openai', JSON.stringify({ goal: 'No action needed', actions: [] }), false));
  assert.equal(result.usage.costUSD, null); assert.equal(result.usage.reportedCalls, 0); assert.equal(result.suggestion.actions.length, 0);
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(() => suggestActionPlan(turn, connection, [], controller.signal, async () => { calls++; return output('openai', '{}'); }));
  await assert.rejects(() => suggestActionPlan({ ...turn, result: { ...turn.result, demo: true } }, connection, [], new AbortController().signal, async () => { calls++; return output('openai', '{}'); }));
  assert.equal(calls, 0);
});
