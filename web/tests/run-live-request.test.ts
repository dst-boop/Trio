import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { runLiveRequest, runStartupTimeoutMs, runIdleTimeoutMs, runStartupTimeoutMessage, runIdleTimeoutMessage } from '../lib/run-live-request.ts';
import type { RunEvent } from '../lib/trio.ts';
const encoder = new TextEncoder();
const result = { answer: 'Completed', drafts: { claude: 'A draft' }, reviews: {}, errors: [], seconds: 1, demo: false };
const signal = () => new AbortController().signal;
const headers = { 'Content-Type': 'application/json', 'X-Trio-Account': 'one' };
const finish = JSON.stringify({ type: 'final', result }) + '\n';

test('startup timeout releases even a fetch that ignores abort, makes one request, and rejects late completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveFetch!: (value: Response) => void, requestSignal!: AbortSignal, calls = 0, cancelled = false;
  const events: RunEvent[] = [];
  const fetcher = (async (url, init) => { calls++; assert.equal(url, '/api/ask'); assert.equal(init?.body, 'payload'); assert.deepEqual(init?.headers, headers); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store'); requestSignal = init!.signal!; return new Promise<Response>(resolve => { resolveFetch = resolve; }); }) as typeof fetch;
  const pending = runLiveRequest('payload', headers, signal(), e => events.push(e), fetcher);
  const rejected = assert.rejects(pending, { message: runStartupTimeoutMessage });
  t.mock.timers.tick(runStartupTimeoutMs); await rejected;
  assert.ok(requestSignal.aborted); assert.equal(calls, 1);
  resolveFetch(new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(finish)); }, cancel() { cancelled = true; return new Promise(() => {}); } })));
  await settle(); assert.ok(cancelled); assert.deepEqual(events, []);
});

test('idle timeout aborts a stalled stream, preserves partial events, and never waits for cancellation cleanup', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false, requestSignal!: AbortSignal; const events: RunEvent[] = [];
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(JSON.stringify({ type: 'draft', provider: 'claude', text: 'Partial run draft' }) + '\n')); }, cancel() { cancelled = true; return new Promise(() => {}); } });
  const pending = runLiveRequest('', headers, signal(), e => events.push(e), (async (_url, init) => { requestSignal = init!.signal!; return new Response(body); }) as typeof fetch);
  const rejected = assert.rejects(pending, { message: runIdleTimeoutMessage });
  await settle(); t.mock.timers.tick(runIdleTimeoutMs - 1); assert.equal(requestSignal.aborted, false);
  t.mock.timers.tick(1); await rejected; await settle();
  assert.ok(requestSignal.aborted); assert.ok(cancelled); assert.equal(body.locked, false); assert.deepEqual(events.map(e => e.type), ['draft']);
});

test('valid progress renews inactivity across long work; unknown or blank records do not', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const events: RunEvent[] = [];
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const pending = runLiveRequest('', headers, signal(), e => events.push(e), (async () => new Response(body)) as typeof fetch);
  await settle();
  for (const stage of ['research', 'draft', 'review', 'revision', 'synthesis']) {
    t.mock.timers.tick(runIdleTimeoutMs - 1); controller.enqueue(encoder.encode(JSON.stringify({ type: 'stage', stage }) + '\n')); await settle();
  }
  t.mock.timers.tick(runIdleTimeoutMs - 1); controller.enqueue(encoder.encode(finish));
  assert.deepEqual(await pending, result); assert.equal(events.length, 6); assert.equal(body.locked, false);
  const stalledBody = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const stalled = runLiveRequest('', headers, signal(), () => assert.fail('No recognized event'), (async () => new Response(stalledBody)) as typeof fetch);
  const rejected = assert.rejects(stalled, { message: runIdleTimeoutMessage }); await settle();
  t.mock.timers.tick(runIdleTimeoutMs - 1); controller.enqueue(encoder.encode('\n{"type":"future_heartbeat"}\n')); await settle();
  t.mock.timers.tick(1); await rejected;
});

test('Stop before startup or during streaming remains a user cancellation and does not retry', async () => {
  const stopped = new AbortController(); stopped.abort(); let calls = 0;
  await assert.rejects(runLiveRequest('', headers, stopped.signal, () => {}, (async () => { calls++; return new Response(); }) as typeof fetch), { name: 'AbortError' }); assert.equal(calls, 0);
  for (const starting of [true, false]) {
    const stop = new AbortController(); let requestSignal!: AbortSignal;
    const pending = runLiveRequest('', headers, stop.signal, () => {}, (async (_url, init) => { calls++; requestSignal = init!.signal!; return starting ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } })); }) as typeof fetch);
    const rejected = assert.rejects(pending, { name: 'AbortError' }); await settle(); stop.abort(); await rejected; assert.ok(requestSignal.aborted);
  }
  assert.equal(calls, 2);
});

test('app errors remain actionable, malformed/oversized errors stay bounded, and stalled errors time out', async t => {
  for (const [body, expected] of [[JSON.stringify({ error: 'Sign in to Trio.' }), 'Sign in to Trio.'], ['<html>private diagnostics</html>', 'Could not start this session. Check your connection and try again.'], [JSON.stringify({ error: 'x'.repeat(32001) }), 'Could not start this session. Check your connection and try again.']]) {
    await assert.rejects(runLiveRequest('', headers, signal(), () => assert.fail('No events'), (async () => new Response(body, { status: 401 })) as typeof fetch), { message: expected });
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = new ReadableStream<Uint8Array>({ cancel() { return new Promise(() => {}); } });
  const pending = runLiveRequest('', headers, signal(), () => {}, (async () => new Response(body, { status: 502 })) as typeof fetch);
  const rejected = assert.rejects(pending, { message: runStartupTimeoutMessage }); await settle(); t.mock.timers.tick(runStartupTimeoutMs); await rejected; await settle(); assert.equal(body.locked, false);
});
