import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate, callProvider } from '../lib/orchestrate.ts';
import { freshConnections, type RunEvent } from '../lib/trio.ts';

function setup(fail?: (id: string, stage: string) => boolean) {
  const calls: { id: string; stage: string; body: any }[] = [];
  const connections = freshConnections();
  Object.values(connections).forEach(c => c.key = 'test-key-not-real');
  const fetcher = (async (url: string, init: RequestInit) => {
    const id = url.includes('openai') ? 'openai' : url.includes('anthropic') ? 'claude' : 'gemini';
    const body = JSON.parse(init.body as string);
    const system = body.instructions ?? body.system ?? body.system_instruction;
    const stage = system.startsWith('Review') ? 'review' : system.startsWith('Write the final') ? 'final' : 'draft';
    calls.push({ id, stage, body });
    if (fail?.(id, stage)) return new Response('{}', { status: 429 });
    const text = `${id} ${stage} response`;
    return Response.json(id === 'openai' ? { output: [{ content: [{ type: 'output_text', text }] }] } : id === 'claude' ? { content: [{ type: 'text', text }] } : { steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] });
  }) as typeof fetch;
  return { input: { question: 'What is the plan?', context: 'Reference context', connections, mode: 'council' as const, lead: 'claude' as const }, calls, fetcher };
}
test('council makes 3 drafts, 3 reviews and 1 synthesis with shared context', async () => {
  const s = setup(), events: RunEvent[] = [];
  const result = await orchestrate(s.input, e => events.push(e), new AbortController().signal, s.fetcher);
  assert.equal(s.calls.length, 7); assert.equal(result.by, 'claude'); assert.equal(Object.keys(result.reviews).length, 3);
  assert.deepEqual(events.filter(e => e.type === 'stage').map(e => e.stage), ['draft', 'review', 'synthesis']);
  assert.equal(result.answer, 'claude final response');
  assert.ok(JSON.stringify(s.calls[0].body).includes('Reference context'));
  for (const call of s.calls.filter(c => c.stage === 'review')) { const prompt = call.body.input ?? call.body.messages[0].content; const context = JSON.parse(prompt); assert.equal(context.drafts.length, 3); assert.ok(context.drafts.every((d: any) => /^[ABC]$/.test(d.label))); }
  assert.equal(s.calls[0].body.store, false);
});
test('provider draft outage is isolated and synthesis fails over', async () => {
  const s = setup((id, stage) => id === 'gemini' || id === 'claude' && stage === 'final');
  const result = await orchestrate(s.input, () => {}, new AbortController().signal, s.fetcher);
  assert.equal(result.by, 'openai'); assert.equal(Object.keys(result.drafts).length, 2); assert.equal(result.errors.length, 2);
});
test('compare never reviews or synthesizes', async () => {
  const s = setup(); const result = await orchestrate({ ...s.input, mode: 'compare' }, () => {}, new AbortController().signal, s.fetcher);
  assert.equal(s.calls.length, 3); assert.equal(result.answer, '');
});
test('quick synthesis skips review and single provider is supported', async () => {
  const s = setup(); s.input.connections.gemini.enabled = false; s.input.connections.openai.enabled = false;
  const result = await orchestrate({ ...s.input, mode: 'fast' }, () => {}, new AbortController().signal, s.fetcher);
  assert.equal(s.calls.length, 2); assert.equal(result.by, 'claude');
});
test('all synthesis failures return an explicitly marked draft fallback', async () => {
  const s = setup((id, stage) => stage === 'final'); const result = await orchestrate(s.input, () => {}, new AbortController().signal, s.fetcher);
  assert.equal(result.fallback, true); assert.ok(result.answer.endsWith('draft response'));
});
test('all draft failures reject with an actionable error', async () => {
  const s = setup(() => true); await assert.rejects(orchestrate(s.input, () => {}, new AbortController().signal, s.fetcher), /All providers failed/);
});
test('no keys cannot make requests', async () => {
  const s = setup(); s.input.connections = freshConnections(); await assert.rejects(orchestrate(s.input, () => {}, new AbortController().signal, s.fetcher), /Connect at least/); assert.equal(s.calls.length, 0);
});
test('provider errors cannot reflect secret-bearing response text', async () => {
  const fetcher = (async () => new Response('secret-should-not-appear', { status: 401 })) as typeof fetch;
  await assert.rejects(callProvider('openai', 'secret-should-not-appear', 'gpt-6-astra', 'system', 'hello', new AbortController().signal, fetcher), e => e instanceof Error && !e.message.includes('secret-should-not-appear') && e.message.includes('401'));
});
