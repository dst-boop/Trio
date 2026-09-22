import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUsage, estimateStandardCost, summarizeUsage } from '../lib/usage.ts';
import { orchestrate, callProvider } from '../lib/orchestrate.ts';
import { freshConnections, type RunEvent } from '../lib/trio.ts';
import { parseSessions, sessionMarkdown } from '../lib/sessions.ts';

test('normalizes vendor usage without double-counting reasoning or ignoring cache inputs', () => {
  assert.deepEqual(readUsage('openai', { usage: { input_tokens: 100, output_tokens: 40, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 15 } } }), { input: 100, output: 40, cached: 20 });
  assert.deepEqual(readUsage('claude', { usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } }), { input: 130, output: 40, cached: 30 });
  assert.deepEqual(readUsage('gemini', { usage: { total_input_tokens: 100, total_output_tokens: 25, total_thought_tokens: 15, total_cached_tokens: 20 } }), { input: 100, output: 40, cached: 20 });
});

test('missing and malformed usage is unknown, while reported zero is valid', () => {
  for (const data of [{}, { usage: {} }, { usage: { input_tokens: -1, output_tokens: 2 } }, { usage: { input_tokens: '10', output_tokens: 2 } }]) assert.equal(readUsage('openai', data), null);
  assert.equal(readUsage('claude', { usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: -1, cache_creation_input_tokens: 2 } }), null);
  assert.deepEqual(readUsage('openai', { usage: { input_tokens: 0, output_tokens: 0 } }), { input: 0, output: 0, cached: 0 });
});

test('standard rates expire and unknown or cached models have no invented cost', () => {
  const tokens = { input: 1_000_000, output: 1_000_000, cached: 0 }, now = Date.parse('2026-09-22');
  assert.equal(estimateStandardCost('claude-sonnet-5', tokens, now), 12);
  assert.equal(estimateStandardCost('custom-model', tokens, now), null);
  assert.equal(estimateStandardCost('claude-sonnet-5', { ...tokens, cached: 10 }, now), null);
  assert.equal(estimateStandardCost('gemini-3.8-flash', tokens, Date.parse('2027-01-01')), null);
});

test('in-flight provider rows never price incomplete token counts as a complete bill', () => {
  const pending = { model: 'gpt-6-astra', calls: 2, reportedCalls: 1, inputTokens: 100, outputTokens: 20, costUSD: .002 };
  const snapshot = summarizeUsage({ openai: pending });
  assert.equal(snapshot.costUSD, null); assert.equal(snapshot.byProvider.openai?.costUSD, null);
  assert.equal(pending.costUSD, .002, 'The running accumulator remains intact for eventual complete usage');
  pending.reportedCalls = 2;
  assert.equal(summarizeUsage({ openai: pending }).costUSD, .002);
});

function fixture(failFinal = false, missingGemini = false) {
  const connections = freshConnections(); Object.values(connections).forEach(c => c.key = 'fake-key');
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string), system = body.instructions ?? body.system ?? body.system_instruction;
    if (failFinal && url.includes('anthropic') && system.startsWith('Write the final')) return new Response('{}', { status: 500 });
    if (url.includes('openai')) return Response.json({ usage: { input_tokens: 100, output_tokens: 20 }, output: [{ content: [{ type: 'output_text', text: 'Answer' }] }] });
    if (url.includes('anthropic')) return Response.json({ usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text: 'Answer' }] });
    return Response.json({ ...(missingGemini ? {} : { usage: { total_input_tokens: 100, total_output_tokens: 15, total_thought_tokens: 5 } }), steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Answer' }] }] });
  }) as typeof fetch;
  return { input: { question: 'Usage?', connections, mode: 'council' as const, lead: 'claude' as const }, fetcher };
}

test('council aggregates seven calls, streams usage, and persists/exports it without keys', async () => {
  const f = fixture(), events: RunEvent[] = [];
  const result = await orchestrate(f.input, e => events.push(e), new AbortController().signal, f.fetcher);
  assert.equal(result.usage?.calls, 7); assert.equal(result.usage?.reportedCalls, 7);
  assert.equal(result.usage?.inputTokens, 700); assert.equal(result.usage?.outputTokens, 140);
  assert.equal(result.usage?.byProvider.claude?.calls, 3);
  assert.equal(events.filter(e => e.type === 'usage').length, 7);
  const turns = [{ question: 'Usage?', mode: 'council' as const, result }];
  const saved = parseSessions(JSON.stringify([{ id: 'usage', title: 'Usage?', time: '', turns }]));
  assert.deepEqual(saved[0].turns[0].result.usage, result.usage);
  assert.match(sessionMarkdown(turns), /700 input \+ 140 output/);
  assert.ok(!JSON.stringify(result).includes('fake-key'));
});

test('failover and missing metadata show partial totals with no complete cost', async () => {
  const f = fixture(true, true);
  const result = await orchestrate(f.input, () => {}, new AbortController().signal, f.fetcher);
  assert.equal(result.by, 'openai'); assert.equal(result.usage?.calls, 8);
  assert.equal(result.usage?.reportedCalls, 5); assert.equal(result.usage?.costUSD, null);
  assert.equal(result.usage?.byProvider.claude?.costUSD, null);
  assert.equal(result.usage?.byProvider.gemini?.inputTokens, 0);
});

test('empty responses still report billed usage before failing', async () => {
  let tokens;
  const fetcher = (async () => Response.json({ usage: { input_tokens: 9, output_tokens: 8 }, output: [] })) as typeof fetch;
  await assert.rejects(callProvider('openai', 'key', 'model', 'system', 'input', new AbortController().signal, fetcher, value => { tokens = value; }), /No text/);
  assert.deepEqual(tokens, { input: 9, output: 8, cached: 0 });
});

test('deep council includes all revision calls in usage, saved sessions and exports', async () => {
  const f = fixture(), events: RunEvent[] = [];
  const result = await orchestrate({ ...f.input, mode: 'deep' }, e => events.push(e), new AbortController().signal, f.fetcher);
  assert.equal(result.usage?.calls, 10);
  assert.equal(result.usage?.reportedCalls, 10);
  assert.equal(result.usage?.inputTokens, 1000);
  assert.equal(result.usage?.outputTokens, 200);
  assert.equal(result.usage?.byProvider.claude?.calls, 4);
  assert.equal(events.filter(e => e.type === 'usage').length, 10);
  const turns = [{ question: 'Usage?', mode: 'deep' as const, result }];
  const saved = parseSessions(JSON.stringify([{ id: 'deep-usage', title: 'Usage?', time: '', turns }]));
  assert.deepEqual(saved[0].turns[0].result, result);
  assert.match(sessionMarkdown(turns), /1000 input \+ 200 output/);
  assert.match(sessionMarkdown(turns), /## Claude revised answer/);
});
