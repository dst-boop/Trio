import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectResearchProvider, readResearch } from '../lib/research.ts';
import { callProvider, orchestrate } from '../lib/orchestrate.ts';
import { freshConnections, type RunEvent } from '../lib/trio.ts';
import { parseSessions, serializeSessions, sessionMarkdown } from '../lib/sessions.ts';
import { exportBackup, parseBackup } from '../lib/backups.ts';

const signal = () => new AbortController().signal;
const searchBlocks = [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'current evidence' } }, { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', url: 'https://example.org/evidence', title: 'Evidence report', encrypted_content: 'opaque-provider-only' }] }];
const cited = { type: 'text', text: 'A supported finding.', citations: [{ type: 'web_search_result_location', url: 'https://example.org/evidence', title: 'Evidence report', encrypted_index: 'opaque-citation-index', cited_text: 'Source excerpt' }] };
const research = () => ({ stop_reason: 'end_turn', content: [...structuredClone(searchBlocks), structuredClone(cited)], usage: { input_tokens: 20, output_tokens: 10 } });
function connections() { const c = freshConnections(); for (const id of ['openai', 'claude', 'gemini'] as const) c[id].key = 'fake-' + id; return c; }
function answer() { return Response.json({ status: 'completed', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Answer' }], output: [{ content: [{ type: 'output_text', text: 'Answer' }] }], steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Answer' }] }], usage: { input_tokens: 10, output_tokens: 5, total_input_tokens: 10, total_output_tokens: 5 } }); }

test('automatic researcher selection prefers connected OpenAI, then Claude, and honors explicit choices', () => {
  const c = connections(); assert.equal(selectResearchProvider(c), 'openai'); assert.equal(selectResearchProvider(c, 'claude'), 'claude');
  c.openai.enabled = false; assert.equal(selectResearchProvider(c), 'claude'); assert.throws(() => selectResearchProvider(c, 'openai'), /OpenAI/);
  c.claude.key = ' '; assert.throws(() => selectResearchProvider(c), /OpenAI or Claude/);
});

test('Claude citations produce links without exposing encrypted content or counting guessed URLs', () => {
  const result = readResearch(research(), 'claude');
  assert.equal(result.provider, 'claude'); assert.equal(result.sources.length, 1); assert.match(result.text, /A supported finding\. \[1\]\(<https:\/\/example.org\/evidence>\)/);
  assert.ok(!JSON.stringify(result).includes('opaque-')); assert.ok(!JSON.stringify(result).includes('Source excerpt'));
  const data = research(); data.content = [structuredClone(cited)] as any;
  assert.throws(() => readResearch(data, 'claude'), /completed search/);
  const unsafe = research(); (unsafe.content.at(-1) as any).citations[0].url = 'javascript:alert(1)';
  assert.throws(() => readResearch(unsafe, 'claude'), /cited brief/);
});

test('Claude research uses the native bounded basic-search tool and a complete JSON response', async () => {
  let result: any; let deltas = 0;
  const fetcher = (async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal((init!.headers as any)['x-api-key'], 'fake-claude');
    const body = JSON.parse(init!.body as string); assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]); assert.equal(body.stream, undefined); assert.equal(body.messages.length, 1);
    return Response.json(research());
  }) as typeof fetch;
  const text = await callProvider('claude', 'fake-claude', 'model', 'system', 'question', signal(), fetcher, undefined, () => deltas++, undefined, r => result = r);
  assert.equal(deltas, 0); assert.equal(text, result.text); assert.equal(result.provider, 'claude');
});

test('one paused search continues unchanged only with Claude and counts both calls across Deep Council', async () => {
  let searches = 0; const otherPrompts: string[] = [], events: RunEvent[] = [];
  const fetcher = (async (url, init) => {
    const body = JSON.parse(init!.body as string);
    if (body.tools) {
      searches++; assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(body.tools[0].max_uses, 3);
      if (searches === 1) return Response.json({ stop_reason: 'pause_turn', content: searchBlocks, usage: { input_tokens: 10, output_tokens: 5 } });
      assert.equal(searches, 2); assert.deepEqual(body.messages[1], { role: 'assistant', content: searchBlocks }); assert.equal(body.messages[0].content.includes('Current evidence'), true);
      return Response.json({ stop_reason: 'end_turn', content: [cited], usage: { input_tokens: 20, output_tokens: 10 } });
    }
    otherPrompts.push(JSON.stringify(body)); return answer();
  }) as typeof fetch;
  const result = await orchestrate({ question: 'Current evidence?', webResearch: true, researchProvider: 'claude', connections: connections(), mode: 'deep', lead: 'gemini' }, e => events.push(e), signal(), fetcher);
  assert.equal(searches, 2); assert.equal(otherPrompts.length, 10); assert.equal(result.usage!.calls, 12); assert.equal(result.usage!.reportedCalls, 12); assert.equal(result.usage!.costUSD, null);
  assert.equal(result.researchBy, 'claude'); assert.equal(result.research!.provider, 'claude'); assert.equal(events[0].provider, 'claude');
  for (const prompt of otherPrompts) { assert.ok(prompt.includes('A supported finding.')); assert.ok(!prompt.includes('opaque-provider-only')); assert.ok(!prompt.includes('opaque-citation-index')); }
  assert.ok(!JSON.stringify(result).includes('opaque-')); assert.ok(result.errors.some(e => e.includes('continuing once')));
});

test('repeated pause and tool failures produce explicit unavailable research without an unbounded loop', async () => {
  for (const failure of ['pause_turn', 'tool_error', 'refusal']) {
    let searches = 0;
    const fetcher = (async (_url, init) => { const body = JSON.parse(init!.body as string); if (!body.tools) { assert.ok(JSON.stringify(body).includes('Web research failed')); return answer(); } searches++; return Response.json(failure === 'pause_turn' ? { stop_reason: 'pause_turn', content: searchBlocks } : failure === 'refusal' ? { ...research(), stop_reason: 'refusal' } : { stop_reason: 'end_turn', content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable', message: 'secret vendor diagnostics' } }, cited] }); }) as typeof fetch;
    const result = await orchestrate({ question: 'q', webResearch: true, researchProvider: 'claude', connections: connections(), mode: 'compare', lead: 'openai' }, () => {}, signal(), fetcher);
    assert.equal(searches, failure === 'pause_turn' ? 2 : 1); assert.equal(result.research, undefined); assert.equal(result.researchBy, 'claude'); assert.ok(!JSON.stringify(result).includes('secret vendor'));
  }
});

test('stopping before the pause continuation prevents further calls and final persistence', async () => {
  const controller = new AbortController(); let calls = 0; const events: RunEvent[] = [];
  const fetcher = (async () => { calls++; return Response.json({ stop_reason: 'pause_turn', content: searchBlocks }); }) as typeof fetch;
  await assert.rejects(orchestrate({ question: 'q', webResearch: true, researchProvider: 'claude', connections: connections(), mode: 'council', lead: 'openai' }, e => { events.push(e); if (e.type === 'error' && e.text?.includes('continuing once')) controller.abort(); }, controller.signal, fetcher));
  assert.equal(calls, 1); assert.equal(events.some(e => e.type === 'final'), false);
});

test('Claude-only automatic research retains attribution through history, exports, and backups', async () => {
  const c = connections(); c.openai.enabled = false; c.gemini.enabled = false;
  const result = await orchestrate({ question: 'q', webResearch: true, connections: c, mode: 'fast', lead: 'claude' }, () => {}, signal(), (async (_url, init) => JSON.parse(init!.body as string).tools ? Response.json(research()) : answer()) as typeof fetch);
  const sessions = [{ id: 's', title: 'q', time: '', turns: [{ question: 'q', mode: 'fast' as const, result }] }];
  assert.equal(result.usage!.calls, 3); assert.equal(parseSessions(serializeSessions(sessions))[0].turns[0].result.research!.provider, 'claude');
  assert.equal(parseBackup(exportBackup(sessions))[0].turns[0].result.researchBy, 'claude'); assert.match(sessionMarkdown(sessions[0].turns), /via Claude/);
  const legacy = structuredClone(sessions); delete legacy[0].turns[0].result.research!.provider; delete legacy[0].turns[0].result.researchBy;
  assert.equal(parseSessions(serializeSessions(legacy)).length, 1); assert.match(sessionMarkdown(legacy[0].turns), /via OpenAI/);
});
