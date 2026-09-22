import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readResearch, safeSourceUrl } from '../lib/research.ts';
import { callProvider, orchestrate } from '../lib/orchestrate.ts';
import { freshConnections, type Result, type RunEvent } from '../lib/trio.ts';
import { applyRunEvent } from '../lib/run-events.ts';
import { serializeSessions, parseSessions, sessionMarkdown } from '../lib/sessions.ts';

const signal = () => new AbortController().signal;
const citation = { type: 'url_citation', url: 'https://example.org/report', title: 'Primary report', start_index: 14, end_index: 31 };
const researchResponse = () => ({ status: 'completed', output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text', text: 'Evidence: 42. citeturn0search0', annotations: [citation] }] }], usage: { input_tokens: 100, output_tokens: 50 } });
function connections() { const c = freshConnections(); for (const id of ['openai', 'claude', 'gemini'] as const) c[id].key = `fake-${id}`; return c; }
function response(text = 'Completed answer') { return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text }] }], content: [{ type: 'text', text }], steps: [{ type: 'model_output', content: [{ type: 'text', text }] }], usage: { input_tokens: 10, output_tokens: 5, total_input_tokens: 10, total_output_tokens: 5 } }); }
function stream(events: unknown[]) { return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }); }

test('research uses provider metadata, preserves claims, deduplicates sources, and makes inline citations clickable', () => {
  const data = researchResponse(); data.output[1].content![0].annotations.push({ ...citation, end_index: 999 });
  const result = readResearch(data);
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].title, 'Primary report');
  assert.match(result.text, /Evidence: 42/); assert.match(result.text, /\[1\]\(<https:\/\/example.org\/report>\)/); assert.ok(!result.text.includes(''));
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'https://user:pass@evil.test', '//example.org', 'https://a.test/<x>', 'https://a.test/\nx']) assert.equal(safeSourceUrl(url), null);
  const bad = researchResponse(); bad.output[1].content![0].annotations = [{ ...citation, url: 'javascript:alert(1)' }];
  assert.throws(() => readResearch(bad), /cited brief/);
  assert.throws(() => readResearch({ output: [{ content: [{ type: 'output_text', text: 'Fake https://example.org' }] }] }), /completed search/);
});

test('streamed and nonstreamed research use native bounded search requests and authoritative citations', async () => {
  for (const streaming of [true, false]) {
    let result: any; const usage: unknown[] = [];
    const fetcher = (async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(init!.body as string);
      assert.deepEqual(body.tools, [{ type: 'web_search' }]); assert.equal(body.tool_choice, 'required'); assert.equal(body.max_tool_calls, 3); assert.equal(body.store, false);
      return streaming ? stream([{ type: 'response.output_text.delta', delta: 'Unfinished' }, { type: 'response.completed', response: researchResponse() }]) : Response.json(researchResponse());
    }) as typeof fetch;
    const text = await callProvider('openai', 'fake', 'model', 'system', 'q', signal(), fetcher, u => usage.push(u), streaming ? () => {} : undefined, undefined, r => result = r);
    assert.equal(text, result.text); assert.ok(!text.includes('Unfinished')); assert.equal(result.sources.length, 1); assert.equal(usage.length, 1);
  }
});

test('research is opt-in and requires enabled OpenAI before any provider is charged', async () => {
  const c = connections(); c.openai.enabled = false; let called = false;
  await assert.rejects(orchestrate({ question: 'q', webResearch: true, connections: c, mode: 'deep', lead: 'claude' }, () => {}, signal(), (async () => { called = true; return response(); }) as typeof fetch), /OpenAI/);
  assert.equal(called, false);
  await orchestrate({ question: 'q', connections: connections(), mode: 'compare', lead: 'claude' }, () => {}, signal(), (async (_url, init) => { assert.equal(JSON.parse(init!.body as string).tools, undefined); return response(); }) as typeof fetch);
});

test('a single shared brief reaches every Deep Council stage with sources and accounts for search charges', async () => {
  const requests: any[] = [], events: RunEvent[] = [];
  const fetcher = (async (_url, init) => { const body = JSON.parse(init!.body as string); requests.push(body); if (body.tools) return Response.json(researchResponse()); return response(); }) as typeof fetch;
  const result = await orchestrate({ question: 'Current facts?', webResearch: true, connections: connections(), mode: 'deep', lead: 'claude' }, event => events.push(event), signal(), fetcher);
  assert.equal(requests.length, 11); assert.equal(requests.filter(r => r.tools).length, 1);
  for (const body of requests.slice(1)) { const s = JSON.stringify(body); assert.ok(s.includes('Evidence: 42')); assert.ok(s.includes(citation.url)); assert.ok(s.includes('untrusted evidence')); assert.ok(!s.includes('fake-openai')); }
  assert.equal(result.usage!.calls, 11); assert.equal(result.usage!.reportedCalls, 11); assert.equal(result.usage!.costUSD, null); assert.equal(result.usage!.byProvider.openai!.costUSD, null);
  assert.equal(events[0].stage, 'research'); assert.ok(events.some(e => e.type === 'research'));
});

test('failed research is explicit and cannot contaminate subsequent model prompts', async () => {
  let calls = 0;
  const fetcher = (async (_url, init) => { const body = JSON.parse(init!.body as string); calls++; if (body.tools) return new Response('secret vendor details', { status: 403 }); assert.ok(JSON.stringify(body).includes('Web research failed')); assert.ok(!JSON.stringify(body).includes('secret vendor')); return response(); }) as typeof fetch;
  const result = await orchestrate({ question: 'q', webResearch: true, connections: connections(), mode: 'compare', lead: 'openai' }, () => {}, signal(), fetcher);
  assert.equal(calls, 4); assert.equal(result.research, undefined); assert.equal(result.researchRequested, true); assert.match(result.errors[0], /continuing without a cited brief/); assert.ok(!JSON.stringify(result).includes('secret vendor'));
});

test('broken research streams retry once without leaking partial evidence or resetting search limits', async () => {
  let searches = 0; const events: RunEvent[] = [];
  const fetcher = (async (_url, init) => { const body = JSON.parse(init!.body as string); if (body.tools) { searches++; assert.equal(body.max_tool_calls, 3); if (body.stream) return stream([{ type: 'response.output_text.delta', delta: 'Unverified fragment' }]); return Response.json(researchResponse()); } assert.ok(!JSON.stringify(body).includes('Unverified fragment')); return response(); }) as typeof fetch;
  const result = await orchestrate({ question: 'q', webResearch: true, connections: connections(), mode: 'compare', lead: 'openai' }, event => events.push(event), signal(), fetcher);
  assert.equal(searches, 2); assert.equal(result.usage!.calls, 5); assert.equal(result.usage!.reportedCalls, 4); assert.equal(result.research!.sources.length, 1); assert.ok(!JSON.stringify(events).includes('Unverified fragment'));
  let state: Result = { drafts: {}, reviews: {}, errors: [], answer: '', seconds: 0, demo: false };
  for (const event of events) state = applyRunEvent(state, event);
  assert.deepEqual(state, result);
});

test('stopping during research prevents drafting, retry, and a saved final result', async () => {
  const controller = new AbortController(); let calls = 0; const events: RunEvent[] = [];
  const fetcher = (async () => { calls++; controller.abort(); throw new Error('Aborted'); }) as typeof fetch;
  await assert.rejects(orchestrate({ question: 'q', webResearch: true, connections: connections(), mode: 'council', lead: 'openai' }, event => events.push(event), controller.signal, fetcher));
  assert.equal(calls, 1); assert.equal(events.some(e => e.type === 'final'), false);
});

test('completed responses without citation metadata never become a research brief', async () => {
  let searches = 0;
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    if (body.tools) {
      searches++;
      const data = researchResponse(); data.output[1].content![0].annotations = [];
      return body.stream ? stream([{ type: 'response.completed', response: data }]) : Response.json(data);
    }
    assert.ok(!JSON.stringify(body).includes('Evidence: 42'));
    return response();
  }) as typeof fetch;
  const result = await orchestrate({ question: 'q', webResearch: true, connections: connections(), mode: 'compare', lead: 'openai' }, () => {}, signal(), fetcher);
  assert.equal(searches, 2); assert.equal(result.research, undefined); assert.equal(result.researchRequested, true);
  assert.ok(result.errors.some(error => error.includes('without a cited brief'))); assert.equal(result.usage!.calls, 5);
});

test('sources and research survive history and export while unknown credentials are stripped', () => {
  const result: Result = { drafts: {}, reviews: {}, errors: [], answer: 'answer', seconds: 1, demo: false, researchRequested: true, research: { ...readResearch(researchResponse()), apiKey: 'secret' } as any };
  const turns = [{ question: 'q', mode: 'fast' as const, result }];
  const stored = serializeSessions([{ id: 'x', title: 'q', time: '', turns }]);
  assert.ok(!stored.includes('secret')); assert.equal(parseSessions(stored)[0].turns[0].result.research!.sources[0].url, citation.url);
  assert.ok(sessionMarkdown(turns).includes(citation.url)); assert.ok(sessionMarkdown(turns).includes('Shared web research'));
  result.research!.sources[0].url = 'javascript:alert(1)'; assert.throws(() => serializeSessions([{ id: 'x', title: 'q', time: '', turns }]));
});
