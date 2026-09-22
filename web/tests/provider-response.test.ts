import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readProviderJson, maxProviderResponseBytes, maxAnswerCharacters } from '../lib/provider-response.ts';
import { callProvider, orchestrate } from '../lib/orchestrate.ts';
import { freshConnections, type ProviderId, type RunEvent } from '../lib/trio.ts';

const signal = () => new AbortController().signal;
const encoder = new TextEncoder();
function answer(id: ProviderId, text: unknown) {
  const content = [{ type: id === 'openai' ? 'output_text' : 'text', text }];
  return { status: 'completed', stop_reason: 'end_turn', ...(id === 'openai' ? { output: [{ content }] } : id === 'claude' ? { content } : { steps: [{ type: 'model_output', content }] }), usage: { input_tokens: 4, output_tokens: 2, total_input_tokens: 4, total_output_tokens: 2 } };
}
const fetchJSON = (data: unknown) => (async () => Response.json(data)) as typeof fetch;

test('bounded JSON preserves split UTF-8 and accepts the exact byte boundary', async () => {
  const bytes = encoder.encode(JSON.stringify({ text: 'Hello 🌍, 日本語' })); let offset = 0;
  const response = new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } }));
  assert.deepEqual(await readProviderJson(response, signal()), { text: 'Hello 🌍, 日本語' });
  const atLimit = JSON.stringify({ text: 'x'.repeat(maxProviderResponseBytes - 11) });
  assert.equal(encoder.encode(atLimit).length, maxProviderResponseBytes);
  assert.equal((await readProviderJson(new Response(atLimit), signal())).text.length, maxProviderResponseBytes - 11);
});

test('actual response bytes are bounded even without a trustworthy length header and the body is cancelled', async () => {
  for (const length of [undefined, '1', String(maxProviderResponseBytes + 1)]) {
    let cancelled = false;
    const bytes = encoder.encode(JSON.stringify({ text: '🌍'.repeat(500_000) }));
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(bytes); }, cancel() { cancelled = true; } }), { headers: length ? { 'content-length': length } : {} });
    await assert.rejects(readProviderJson(response, signal()), /oversized/);
    assert.equal(cancelled, true); assert.equal(response.body!.locked, false);
  }
});

test('malformed JSON, UTF-8, roots and stream errors produce only safe diagnostics', async () => {
  for (const data of ['secret-key-not-json', 'null', '[]', '"secret-key"', encoder.encode('{"text":"\ufffd"}').map(() => 255)]) {
    await assert.rejects(readProviderJson(new Response(data), signal()), e => e instanceof Error && /unreadable/.test(e.message) && !e.message.includes('secret-key'));
  }
  const broken = new Response(new ReadableStream({ pull(c) { c.error(new Error('secret-key-in-network-error')); } }));
  await assert.rejects(readProviderJson(broken, signal()), e => e instanceof Error && !e.message.includes('secret-key'));
});

test('JSON cancellation releases an idle reader even if vendor cleanup never resolves', { timeout: 1000 }, async () => {
  const controller = new AbortController(); let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }));
  const pending = callProvider('claude', 'k', 'm', 's', 'q', controller.signal, (async () => response) as typeof fetch);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, /abort/i); assert.equal(cancelled, true); assert.equal(response.body!.locked, false);
  let fetched = false;
  await assert.rejects(callProvider('claude', 'k', 'm', 's', 'q', controller.signal, (async () => { fetched = true; return Response.json({}); }) as typeof fetch), /abort/i);
  assert.equal(fetched, false);
});

test('JSON timeouts remain distinguishable from malformed responses', { timeout: 1000 }, async () => {
  const controller = new AbortController(); const response = new Response(new ReadableStream());
  const pending = readProviderJson(response, controller.signal);
  setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), 5);
  await assert.rejects(pending, e => e instanceof DOMException && e.name === 'TimeoutError');
});

for (const id of ['openai', 'claude', 'gemini'] as const) {
  test(`${id} bounds JSON answers without truncating and counts usage even if the text is rejected`, async () => {
    assert.equal((await callProvider(id, 'k', 'm', 's', 'q', signal(), fetchJSON(answer(id, 'x'.repeat(maxAnswerCharacters))))).length, maxAnswerCharacters);
    let usage: unknown;
    await assert.rejects(callProvider(id, 'k', 'm', 's', 'q', signal(), fetchJSON(answer(id, 'x'.repeat(maxAnswerCharacters + 1))), u => usage = u), /oversized answer/);
    assert.deepEqual(usage, { input: 4, output: 2, cached: 0 });
    for (const text of [{ secret: 'private vendor payload' }, ['private vendor payload'], 42]) {
      await assert.rejects(callProvider(id, 'k', 'm', 's', 'q', signal(), fetchJSON(answer(id, text))), e => e instanceof Error && /unreadable answer/.test(e.message) && !e.message.includes('private vendor payload'));
    }
  });
}

test('a bad JSON recovery cannot contaminate other models or trigger an unbounded retry', async () => {
  const connections = freshConnections(); Object.values(connections).forEach(c => c.key = 'fake-key');
  connections.gemini.enabled = false;
  const calls = { openai: 0, claude: 0 }; const events: RunEvent[] = [];
  const fetcher = (async (url, init) => {
    const id = String(url).includes('openai') ? 'openai' : 'claude'; calls[id]++;
    assert.ok(!String(init!.body).includes('bad-response-marker'));
    if (id === 'openai') {
      if (calls.openai === 1) return new Response('data: {"type":"response.output_text.delta","delta":"Partial"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
      return Response.json({ output: [], diagnostic: 'bad-response-marker' + 'x'.repeat(maxProviderResponseBytes) });
    }
    return Response.json(answer('claude', 'Usable answer'));
  }) as typeof fetch;
  const result = await orchestrate({ question: 'q', connections, mode: 'fast', lead: 'openai' }, e => events.push(e), signal(), fetcher);
  assert.equal(calls.openai, 2); assert.equal(result.drafts.openai, undefined); assert.equal(result.answer, 'Usable answer');
  assert.equal(result.by, 'claude'); assert.equal(result.usage?.byProvider.openai?.reportedCalls, 0); assert.equal(result.usage?.costUSD, null);
  assert.match(result.errors.join(), /oversized/); assert.ok(!JSON.stringify(result).includes('bad-response-marker'));
  assert.equal(events.filter(e => e.type === 'final').length, 1);
});

test('oversized Claude research is rejected before drafts while the rest of the run continues', async () => {
  const connections = freshConnections(); connections.claude.key = 'fake-key';
  let calls = 0;
  const fetcher = (async (_url, init) => {
    calls++; const body = JSON.parse(init!.body as string);
    if (body.tools) return Response.json({ ...answer('claude', 'Unusable evidence'), diagnostic: 'x'.repeat(maxProviderResponseBytes) });
    assert.ok(!String(init!.body).includes('Unusable evidence'));
    assert.match(body.system, /research failed/);
    return Response.json(answer('claude', 'Answer with unverified current details'));
  }) as typeof fetch;
  const result = await orchestrate({ question: 'q', connections, mode: 'compare', lead: 'claude', webResearch: true }, () => {}, signal(), fetcher);
  assert.equal(calls, 2); assert.equal(result.research, undefined); assert.match(result.drafts.claude!, /unverified/);
  assert.match(result.errors.join(), /oversized/);
});

test('coalesced OpenAI stream completions obey the same text validation and limits', async () => {
  for (const text of ['x'.repeat(maxAnswerCharacters + 1), { diagnostic: 'private vendor data' }]) {
    const response = new Response('data: ' + JSON.stringify({ type: 'response.completed', response: answer('openai', text) }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
    await assert.rejects(callProvider('openai', 'k', 'm', 's', 'q', signal(), (async () => response) as typeof fetch, undefined, () => {}), /interrupted/);
  }
});

test('cancelling an idle Claude JSON research response never starts drafts or saves a result', { timeout: 1000 }, async () => {
  const connections = freshConnections(); connections.claude.key = 'fake-key';
  const controller = new AbortController(); const events: RunEvent[] = []; let calls = 0, cancelled = false;
  const fetcher = (async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); }) as typeof fetch;
  const pending = orchestrate({ question: 'q', connections, mode: 'deep', lead: 'claude', webResearch: true }, e => events.push(e), controller.signal, fetcher);
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, /abort/i);
  assert.equal(calls, 1); assert.equal(cancelled, true); assert.ok(!events.some(e => e.type === 'final' || e.phase === 'draft'));
});
