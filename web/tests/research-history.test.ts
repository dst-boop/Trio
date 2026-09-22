import test from 'node:test';
import assert from 'node:assert/strict';
import { researchHistory } from '../lib/research-history.ts';
import { conversationContext, serializeSessions, sessionMarkdown, type Turn } from '../lib/sessions.ts';
import { orchestrate } from '../lib/orchestrate.ts';
import { freshConnections, type ProviderId } from '../lib/trio.ts';
import type { Research } from '../lib/research.ts';
const research: Research = { at: '2026-09-20T12:00:00.000Z', provider: 'claude', text: 'An earlier brief with an uncited https://unverified.example/ link.', sources: [{ title: 'Primary report', url: 'https://example.org/report' }, { title: 'Counterevidence', url: 'https://example.org/review' }] };
const turn: Turn = { question: 'What does the evidence show?', mode: 'fast', result: { answer: 'Evidence with caveats.', drafts: {}, reviews: {}, errors: [], seconds: 1, demo: false, researchRequested: true, researchBy: 'claude', research } };
const data = (text: string) => JSON.parse(text.slice(text.indexOf('{')));

test('follow-ups carry recorded citation numbers, dates and provider without inventing sources or fresh verification', () => {
  const history = researchHistory(research), metadata = data(history.text);
  assert.equal(metadata.recorded_at, research.at); assert.equal(metadata.provider, 'Claude');
  assert.deepEqual(metadata.sources, research.sources.map((s, i) => ({ citation_in_brief: i + 1, ...s })));
  assert.equal(history.omittedSources, 0); assert.equal(metadata.omitted_sources, 0);
  assert.match(history.text, /not a fresh search/); assert.match(metadata.scope, /not proof of every answer claim/);
  assert.match(metadata.scope, /Source contents are not included/);
  assert.ok(!history.text.includes('unverified.example')); assert.ok(!history.text.includes(research.text));
  assert.equal(data(researchHistory({ ...research, provider: undefined }).text).provider, 'OpenAI', 'Legacy research was OpenAI');
});

test('large source lists keep whole URLs and original numbering within 6,000 characters with an exact omission count', () => {
  const large = { ...research, sources: Array.from({ length: 60 }, (_, i) => ({ title: '🌍'.repeat(150), url: `https://example.org/${i}?detail=` + 'a'.repeat(1900) })) };
  const history = researchHistory(large), metadata = data(history.text);
  assert.ok(history.text.length <= 6000); assert.ok(metadata.sources.length > 0); assert.ok(history.omittedSources > 0);
  assert.equal(metadata.sources.length + history.omittedSources, 60); assert.equal(metadata.omitted_sources, history.omittedSources);
  metadata.sources.forEach((s: { citation_in_brief: number; title: string; url: string }, i: number) => assert.deepEqual(s, { citation_in_brief: i + 1, ...large.sources[i] }));
  assert.equal(history.text.isWellFormed(), true);
  assert.ok(!history.text.includes(large.sources[metadata.sources.length].url), 'An omitted URL must not be partially appended');
});

test('answer and source provenance share the 30,000-character history limit without changing stored originals', () => {
  const compared = structuredClone(turn); compared.mode = 'compare'; compared.result.answer = '';
  compared.result.drafts = { openai: 'A'.repeat(120000), claude: 'B'.repeat(120000), gemini: 'C'.repeat(120000) };
  const record = { id: 'one', title: compared.question, time: '', turns: [compared] }, before = serializeSessions([record]);
  const context = conversationContext([compared]), assistant = context.messages[1].content;
  assert.ok(assistant.length <= 30000); assert.equal(context.researchAnswers, 1); assert.equal(context.omittedSources, 0); assert.equal(context.shortenedAnswers, 1);
  for (const [name, letter] of [['ChatGPT', 'A'], ['Claude', 'B'], ['Gemini', 'C']]) assert.ok(assistant.includes(name + ':\n' + letter.repeat(9000)));
  assert.ok(assistant.includes(research.at)); assert.ok(assistant.includes(research.sources[1].url));
  assert.equal(serializeSessions([record]), before); assert.ok(sessionMarkdown([compared]).includes('C'.repeat(120000))); assert.ok(sessionMarkdown([compared]).includes(research.text));
});

test('unavailable research is explicit; ordinary answers, demo examples and old excluded turns add no source context', () => {
  assert.deepEqual(researchHistory(), { text: '', omittedSources: 0 });
  const absent = researchHistory(undefined, true, 'claude'); assert.equal(data(absent.text).status, 'unavailable'); assert.match(absent.text, /Do not infer sources/);
  const ordinary = { ...turn, result: { ...turn.result, researchRequested: false, research: undefined } };
  const missing = { ...turn, result: { ...turn.result, research: undefined } };
  assert.match(conversationContext([missing]).messages[1].content, /No cited brief was available/);
  assert.equal(conversationContext([ordinary]).messages[1].content, turn.result.answer);
  const excluded = conversationContext([turn, ...Array(6).fill(ordinary), { ...turn, result: { ...turn.result, demo: true } }]);
  assert.equal(excluded.researchAnswers, 0); assert.equal(excluded.omittedTurns, 1); assert.ok(!JSON.stringify(excluded.messages).includes(research.at));
});

test('all Council stages receive the recorded provenance as context without an extra search request', async () => {
  const connections = freshConnections(); Object.values(connections).forEach(c => c.key = 'fake-key');
  const history = conversationContext([turn]).messages; let calls = 0;
  const fetcher = (async (url, init) => {
    calls++; const id: ProviderId = String(url).includes('openai') ? 'openai' : String(url).includes('anthropic') ? 'claude' : 'gemini';
    const body = JSON.parse(init!.body as string), payload = JSON.parse(body.messages?.[0].content ?? body.input);
    assert.deepEqual((payload.task ?? payload).conversation, history); assert.equal(body.tools, undefined);
    const system = body.instructions ?? body.system ?? body.system_instruction; assert.ok(!system.includes(research.at));
    return Response.json(id === 'openai' ? { output: [{ content: [{ type: 'output_text', text: 'A response' }] }] } : id === 'claude' ? { content: [{ type: 'text', text: 'A response' }] } : { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'A response' }] }] });
  }) as typeof fetch;
  await orchestrate({ question: 'Where did that come from?', history, connections, mode: 'council', lead: 'claude' }, () => {}, new AbortController().signal, fetcher);
  assert.equal(calls, 7);
});
