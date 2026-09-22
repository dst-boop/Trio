import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualityCases, scoreAnswer } from '../evaluation/cases.ts';
import { evaluationConfig } from '../evaluation/config.ts';
import { evaluateQuality, redactReport } from '../evaluation/runner.ts';
import { freshConnections, type ProviderId } from '../lib/trio.ts';
const configured = () => { const c = freshConnections(); for (const p of ['openai', 'claude', 'gemini'] as const) c[p].key = 'fake-private-' + p; return c; };
const options = { mode: 'council' as const, maxCalls: 60, timeoutSeconds: 30 };
const signal = () => new AbortController().signal;
function response(id: ProviderId, text: string) {
  return Response.json(id === 'openai' ? { output: [{ content: [{ type: 'output_text', text }] }] } : id === 'claude' ? { content: [{ type: 'text', text }] } : { steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] });
}
function request(url: RequestInfo | URL, init?: RequestInit) {
  const id: ProviderId = String(url).includes('openai') ? 'openai' : String(url).includes('anthropic') ? 'claude' : 'gemini';
  const body = JSON.parse(init!.body as string), payload = JSON.parse(body.messages?.[0].content ?? body.input);
  const question = (payload.task ?? payload).question, item = qualityCases.find(c => c.question === question)!;
  assert.ok(item); assert.equal(body.tools, undefined, 'Evaluation never enables paid search');
  return { id, item, system: body.instructions ?? body.system ?? body.system_instruction };
}

test('local scoring distinguishes exact values, incorrect answers, format failures and missing responses', () => {
  assert.deepEqual(scoreAnswer('{"answer":2050}', 2050), { status: 'pass', value: 2050 });
  assert.equal(scoreAnswer('```json\n{"answer":"tie"}\n```', 'tie').status, 'pass');
  assert.equal(scoreAnswer('{"answer":100}', 96).status, 'incorrect');
  for (const text of ['The answer is 96', '{"answer":"96"}', '{"answer":1e999}', 'null', '[]', '{"other":96}', '{"answer":96} trailing text']) assert.equal(scoreAnswer(text, 96).status, 'format_error');
  assert.equal(scoreAnswer('', 96).status, 'no_answer'); assert.equal(scoreAnswer(undefined, 'tie').status, 'no_answer');
});

test('the full synthetic suite records individual and team outcomes separately using the real orchestrator', async () => {
  let calls = 0;
  const fetcher = (async (url, init) => { calls++; const { id, item, system } = request(url, init); const answer = id === 'openai' && item.id === 'units' && system.startsWith('Answer the user') ? 999 : item.expected; return response(id, JSON.stringify({ answer })); }) as typeof fetch;
  const report = await evaluateQuality(configured(), options, signal(), fetcher);
  assert.equal(calls, 60); assert.equal(report.calls, 60); assert.equal(report.status, 'complete');
  assert.equal(report.summary.baseline.openai.passed, 5); assert.equal(report.summary.baseline.claude.passed, 6); assert.equal(report.summary.team.passed, 6);
  assert.equal(report.summary.degradedPhases, 0); assert.ok(report.results.every(r => r.answers === undefined));
  assert.match(report.limitations, /not proof of general accuracy/); assert.match(report.limitations, /separate samples/);
  assert.ok(!JSON.stringify(report).includes('fake-private-'));
});

test('the HTTP budget includes provider retries, stops subsequent work, and distinguishes a correct fallback from full collaboration', async () => {
  let calls = 0;
  const fetcher = (async (url, init) => { calls++; const { id, item } = request(url, init); return response(id, JSON.stringify({ answer: item.expected })); }) as typeof fetch;
  const report = await evaluateQuality(configured(), { ...options, maxCalls: 4 }, signal(), fetcher);
  assert.equal(calls, 4); assert.equal(report.status, 'call_limit'); assert.equal(report.calls, 4);
  assert.equal(report.results[0].team.status, 'pass'); assert.equal(report.results[0].teamRun.degraded, true);
  assert.ok(report.results.slice(1).every(r => r.team.status === 'not_run' && Object.values(r.baseline).every(v => v.status === 'not_run')));
  const single = configured(); single.claude.enabled = single.gemini.enabled = false; calls = 0;
  const retry = (async (url, init) => { calls++; const { id, item } = request(url, init); return calls === 1 ? new Response('data: {"type":"response.output_text.delta","delta":"Partial"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) : response(id, JSON.stringify({ answer: item.expected })); }) as typeof fetch;
  const retried = await evaluateQuality(single, { ...options, maxCalls: 4, cases: qualityCases.slice(0, 1) }, signal(), retry);
  assert.equal(calls, 4); assert.equal(retried.calls, 4); assert.equal(retried.status, 'complete'); assert.equal(retried.results[0].team.status, 'pass');
});

test('missing credentials and invalid limits fail before networking; pre-cancelled runs are explicitly incomplete', async () => {
  const fetcher = (async () => { assert.fail('No request was authorized'); }) as typeof fetch;
  const incomplete = configured(); incomplete.gemini.key = '';
  await assert.rejects(evaluateQuality(incomplete, options, signal(), fetcher), /Every selected provider/);
  for (const maxCalls of [0, -1, 501, 1.5]) await assert.rejects(evaluateQuality(configured(), { ...options, maxCalls }, signal(), fetcher), /limits/);
  const stopped = new AbortController(); stopped.abort(); const report = await evaluateQuality(configured(), options, stopped.signal, fetcher);
  assert.equal(report.status, 'cancelled'); assert.equal(report.calls, 0); assert.equal(report.summary.team.notRun, 6);
});

test('cancellation retains completed baseline drafts and marks the remaining phases unrun', async () => {
  const stop = new AbortController(); const c = configured(); let calls = 0;
  const fetcher = (async (url, init) => {
    calls++; const { id, item } = request(url, init);
    if (id === 'openai') return response(id, JSON.stringify({ answer: item.expected }));
    return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  }) as typeof fetch;
  const timer = setTimeout(() => stop.abort(), 50);
  try {
    const report = await evaluateQuality(c, { ...options, includeAnswers: true }, stop.signal, fetcher);
    assert.equal(report.status, 'cancelled'); assert.equal(calls, 3); assert.equal(report.results[0].baseline.openai?.status, 'pass');
    assert.equal(report.results[0].baselineRun.state, 'failed'); assert.equal(report.results[0].team.status, 'not_run');
    assert.equal(report.results[0].answers?.baseline.openai, '{"answer":2050}');
  } finally { clearTimeout(timer); }
});

test('the overall deadline aborts pending provider requests and reports a timeout', { timeout: 5000 }, async () => {
  let cancelled = 0;
  const fetcher = (async (_url, init) => new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => { cancelled++; reject(init!.signal!.reason); }, { once: true }))) as typeof fetch;
  const keepAlive = setTimeout(() => {}, 2000);
  try { const report = await evaluateQuality(configured(), { ...options, timeoutSeconds: 1 }, signal(), fetcher); assert.equal(report.status, 'timeout'); assert.equal(cancelled, 3); assert.equal(report.calls, 3); assert.equal(report.results[0].team.status, 'not_run'); }
  finally { clearTimeout(keepAlive); }
});

test('optional output and nested report strings redact credentials without corrupting booleans or numbers', async () => {
  const c = configured(); c.claude.key = 'true'; c.gemini.key = 'quote"line\nkey';
  assert.deepEqual(redactReport({ ok: true, count: 3, text: 'true quote"line\nkey fake-private-openai', nested: ['quote"line\nkey'] }, c), { ok: true, count: 3, text: '[redacted] [redacted] [redacted]', nested: ['[redacted]'] });
  c.claude.enabled = c.gemini.enabled = false;
  const fetcher = (async () => response('openai', JSON.stringify({ answer: c.openai.key }))) as typeof fetch;
  const report = await evaluateQuality(c, { ...options, includeAnswers: true, cases: qualityCases.slice(0, 1) }, signal(), fetcher);
  assert.ok(JSON.stringify(report).includes('[redacted]')); assert.ok(!JSON.stringify(report).includes(c.openai.key));
});

test('configuration previews cost bounds, explicitly selects providers/cases, and rejects ambiguous options', () => {
  const defaults = evaluationConfig([], {}); assert.equal(defaults.run, false); assert.equal(defaults.preview.nominalCalls, 60); assert.equal(defaults.preview.providers.every(p => !p.keyPresent), true);
  const selected = evaluationConfig(['--providers', 'claude', '--cases', 'units', '--mode', 'deep', '--max-calls', '5'], { ANTHROPIC_API_KEY: 'fake', CLAUDE_MODEL: 'selected-model' });
  assert.equal(selected.connections.openai.enabled, false); assert.equal(selected.connections.claude.model, 'selected-model'); assert.equal(selected.preview.nominalCalls, 3);
  for (const args of [['--run', '--run'], ['--providers', 'openai,openai'], ['--cases', 'missing'], ['--mode', 'compare'], ['--output'], ['--max-calls', '1.5'], ['--timeout-seconds', '3601'], ['--unknown']]) assert.throws(() => evaluationConfig(args, {}));
});

test('CLI preview never networks, existing output fails before charges, and a simulated live run writes a usable new report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trio-quality-'));
  const script = fileURLToPath(new URL('../scripts/evaluate-quality.mjs', import.meta.url));
  const env = { ...process.env, OPENAI_API_KEY: 'fake-cli-openai', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', OPENAI_MODEL: 'test-model', CLAUDE_MODEL: '', GEMINI_MODEL: '' };
  const noNetwork = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => { console.log("UNEXPECTED_NETWORK"); throw new Error("blocked by test"); };');
  try {
    const preview = execFileSync(process.execPath, ['--import', noNetwork, script], { cwd: directory, env, encoding: 'utf8' });
    assert.match(preview, /preview only: no API calls/); assert.ok(!preview.includes('UNEXPECTED_NETWORK')); assert.ok(!preview.includes(env.OPENAI_API_KEY));
    const existing = join(directory, 'existing.json'); writeFileSync(existing, 'keep me');
    const blocked = spawnSync(process.execPath, ['--import', noNetwork, script, '--run', '--providers', 'openai', '--output', existing], { cwd: directory, env, encoding: 'utf8' });
    assert.equal(blocked.status, 2); assert.ok(!blocked.stdout.includes('UNEXPECTED_NETWORK')); assert.equal(readFileSync(existing, 'utf8'), 'keep me');
    const fakeResponse = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = async () => Response.json({output:[{content:[{type:"output_text",text:"{\\"answer\\":2050}"}]}]});');
    const output = join(directory, 'simulated.json');
    const run = spawnSync(process.execPath, ['--import', fakeResponse, script, '--run', '--providers', 'openai', '--cases', 'units', '--max-calls', '3', '--output', output], { cwd: directory, env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr); const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.calls, 3); assert.equal(report.status, 'complete'); assert.equal(report.summary.team.passed, 1); assert.equal(report.results[0].answers, undefined);
    assert.ok(!readFileSync(output, 'utf8').includes(env.OPENAI_API_KEY));
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('trio-quality-'));
    rmSync(target, { recursive: true, force: true });
  }
});
