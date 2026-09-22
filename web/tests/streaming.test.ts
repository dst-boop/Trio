import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callProvider, orchestrate } from '../lib/orchestrate.ts';
import { applyRunEvent } from '../lib/run-events.ts';
import { freshConnections, type ProviderId, type RunEvent, type Result } from '../lib/trio.ts';

const empty = (): Result => ({ drafts: {}, reviews: {}, errors: [], answer: '', seconds: 0, demo: false });
const signal = () => new AbortController().signal;
function sse(events: unknown[], end = true) {
  const bytes = new TextEncoder().encode(': keepalive\r\n\r\n' + events.map(event => 'event: ignored-name\r\ndata: ' + JSON.stringify(event, null, 1).replaceAll('\n', '\r\ndata: ') + '\r\n\r\n').join('') + (end ? 'data: [DONE]\r\n\r\n' : ''));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) { if (offset >= bytes.length) { controller.close(); return; } controller.enqueue(bytes.slice(offset, offset += 7)); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function fixture(id: ProviderId, text = 'Hello 🌍') {
  if (id === 'openai') return [
    { type: 'response.reasoning_text.delta', delta: 'private reasoning' },
    { type: 'response.output_text.delta', delta: text.slice(0, 3) },
    { type: 'response.output_text.delta', delta: text.slice(3) },
    { type: 'response.completed', response: { status: 'completed', output: [{ content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  if (id === 'claude') return [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 2 } } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private reasoning' } },
    { type: 'content_block_start', content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    { type: 'message_delta', usage: { output_tokens: 3 } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return [
    { event_type: 'step.start', index: 0, step: { type: 'thought' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'private reasoning' } },
    { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
    { event_type: 'step.delta', index: 1, delta: { type: 'text', text } },
    { event_type: 'interaction.completed', interaction: { status: 'completed', usage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 2 } } },
  ];
}
for (const id of ['openai', 'claude', 'gemini'] as const) {
  test(`${id} streams split UTF-8 SSE, excludes reasoning, and reports terminal usage once`, async () => {
    const deltas: string[] = [], usage: unknown[] = [];
    const fetcher = (async (_url, init) => { assert.equal(JSON.parse(init!.body as string).stream, true); return sse(fixture(id)); }) as typeof fetch;
    const text = await callProvider(id, 'fake-key', 'model', 'system', 'question', signal(), fetcher, u => usage.push(u), t => deltas.push(t));
    assert.equal(text, 'Hello 🌍'); assert.equal(deltas.join(''), text);
    assert.deepEqual(usage, [{ input: id === 'claude' ? 12 : 10, output: id === 'gemini' ? 7 : 5, cached: id === 'claude' ? 2 : 0 }]);
  });
  test(`${id} refuses a stream without its completion event`, async () => {
    const fetcher = (async () => sse(fixture(id).slice(0, -1))) as typeof fetch;
    await assert.rejects(callProvider(id, 'fake-key', 'model', 'system', 'q', signal(), fetcher, undefined, () => {}), /interrupted/);
  });
}

test('Claude initial usage alone does not masquerade as final token totals', async () => {
  let usage: unknown = 'unset';
  const fetcher = (async () => sse(fixture('claude').filter((e: any) => e.type !== 'message_delta'))) as typeof fetch;
  await callProvider('claude', 'k', 'm', 's', 'q', signal(), fetcher, u => usage = u, () => {});
  assert.equal(usage, null);
});

test('explicitly truncated non-streaming responses are never treated as completed answers', async () => {
  for (const id of ['openai', 'claude', 'gemini'] as const) {
    const body = { status: 'incomplete', stop_reason: 'max_tokens', output: [{ content: [{ type: 'output_text', text: 'Cut off' }] }], content: [{ type: 'text', text: 'Cut off' }], steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Cut off' }] }] };
    await assert.rejects(callProvider(id, 'k', 'm', 's', 'q', signal(), (async () => Response.json(body)) as typeof fetch), /did not complete/);
  }
});

test('vendor stream errors and malformed JSON never reflect diagnostics', async () => {
  for (const response of [sse([{ type: 'error', error: { message: 'secret-test-key' } }]), new Response('data: secret-test-key\n\n', { headers: { 'Content-Type': 'text/event-stream' } })]) {
    await assert.rejects(callProvider('openai', 'secret-test-key', 'model', 's', 'q', signal(), (async () => response) as typeof fetch, undefined, () => {}), e => e instanceof Error && !e.message.includes('secret-test-key'));
  }
});

function setup() {
  const connections = freshConnections();
  Object.values(connections).forEach(c => c.key = 'fake-key');
  return { question: 'Plan?', connections, mode: 'deep' as const, lead: 'claude' as const };
}
test('Deep Council streams every phase while only completed answers enter later prompts', async () => {
  const events: RunEvent[] = [], calls: any[] = [];
  const fetcher = (async (url, init) => {
    const id: ProviderId = String(url).includes('openai') ? 'openai' : String(url).includes('anthropic') ? 'claude' : 'gemini';
    const body = JSON.parse(init!.body as string); calls.push(body);
    return sse(fixture(id, `${id} completed response`));
  }) as typeof fetch;
  const result = await orchestrate(setup(), e => events.push(e), signal(), fetcher);
  assert.equal(calls.length, 10);
  assert.deepEqual([...new Set(events.filter(e => e.type === 'contribution_delta').map(e => e.phase))], ['draft', 'review', 'revision', 'synthesis']);
  assert.equal(result.usage?.reportedCalls, 10);
  assert.equal(result.answer, 'claude completed response');
  assert.deepEqual(events.reduce(applyRunEvent, empty()), result);
});

test('broken stream retries once, clears partial output, and counts unknown billed usage', async () => {
  const input = setup(); input.connections.claude.enabled = false; input.connections.gemini.enabled = false;
  const events: RunEvent[] = [], bodies: any[] = [];
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(init!.body as string); bodies.push(body);
    if (bodies.length === 1) return sse([{ type: 'response.output_text.delta', delta: 'Broken draft' }]);
    if (bodies.length === 2) { assert.equal(body.stream, undefined); return Response.json({ output: [{ content: [{ type: 'output_text', text: 'Recovered draft' }] }], usage: { input_tokens: 10, output_tokens: 5 } }); }
    assert.ok(body.input.includes('Recovered draft')); assert.ok(!body.input.includes('Broken draft'));
    return sse(fixture('openai', 'Final answer'));
  }) as typeof fetch;
  const result = await orchestrate({ ...input, mode: 'fast' }, e => events.push(e), signal(), fetcher);
  assert.equal(result.usage?.calls, 3); assert.equal(result.usage?.reportedCalls, 2); assert.equal(result.usage?.costUSD, null);
  assert.equal(result.drafts.openai, 'Recovered draft'); assert.match(result.errors.join(), /retrying once/);
  const starts = events.filter(e => e.type === 'contribution_start' && e.phase === 'draft'); assert.equal(starts.length, 2);
  let view = empty();
  for (const event of events) { view = applyRunEvent(view, event); if (event === starts[1]) assert.equal(view.drafts.openai, undefined); }
  assert.deepEqual(view, result);
});

test('synthesis failover replaces partial answers and never adds them to prompts', async () => {
  const input = setup(); input.connections.gemini.enabled = false;
  const events: RunEvent[] = [];
  const fetcher = (async (url, init) => {
    const id = String(url).includes('openai') ? 'openai' : 'claude';
    const body = JSON.parse(init!.body as string), synthesis = (body.system ?? body.instructions).startsWith('Write the final');
    assert.ok(!JSON.stringify(body).includes('Broken synthesis'));
    if (synthesis && id === 'claude') return body.stream ? sse([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Broken synthesis' } }]) : new Response('{}', { status: 429 });
    return sse(fixture(id, synthesis ? 'Recovered synthesis' : `${id} draft`));
  }) as typeof fetch;
  const result = await orchestrate({ ...input, mode: 'fast' }, e => events.push(e), signal(), fetcher);
  assert.equal(result.by, 'openai'); assert.equal(result.answer, 'Recovered synthesis');
  assert.deepEqual(events.reduce(applyRunEvent, empty()), result);
});

test('cancellation closes a pending stream without retrying or saving a final result', async () => {
  const input = setup(); input.connections.claude.enabled = false; input.connections.gemini.enabled = false;
  const controller = new AbortController(); let calls = 0, cancelled = false;
  const events: RunEvent[] = [];
  const fetcher = (async () => {
    calls++;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Partial"}\n\n')); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  await assert.rejects(orchestrate(input, e => { events.push(e); if (e.type === 'contribution_delta') controller.abort(); }, controller.signal, fetcher), /abort|cancel/i);
  assert.equal(calls, 1); assert.equal(cancelled, true); assert.ok(!events.some(e => e.type === 'final'));
});

test('an idle stream can be cancelled before any text arrives', async () => {
  const controller = new AbortController(); let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const pending = callProvider('openai', 'k', 'm', 's', 'q', controller.signal, (async () => response) as typeof fetch, undefined, () => {});
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, /abort/i); assert.equal(cancelled, true);
});
