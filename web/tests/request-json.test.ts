import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { readJsonBody, JsonBodyError, requestBodyTimeoutMs } from '../lib/request-json.ts';
import { readSmallJson } from '../lib/account-api.ts';
const encoder = new TextEncoder();
const request = (body?: BodyInit, signal?: AbortSignal, headers: Record<string, string> = {}) => new Request('https://trio.test/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, signal, ...{ duplex: 'half' } });
const status = (code: number) => (error: unknown) => error instanceof JsonBodyError && error.status === code;

test('byte limits cover actual multibyte data regardless of Content-Length and allow exact-boundary input', async () => {
  const source = JSON.stringify({ text: '🌍 café' }), bytes = encoder.encode(source);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { if (i === bytes.length) c.close(); else c.enqueue(bytes.slice(i, ++i)); } });
  assert.deepEqual(await readJsonBody(request(body, undefined, { 'Content-Length': '0' }), bytes.length), { text: '🌍 café' });
  assert.equal(body.locked, false);
  await assert.rejects(readJsonBody(request(source, undefined, { 'Content-Length': '0' }), bytes.length - 1), status(413));
  assert.deepEqual(await readJsonBody(request('{}', undefined, { 'Content-Type': 'Application/JSON; charset=utf-8', 'Content-Length': '99999999' }), 2), {});
});

test('oversized uploads return promptly even when cancellation never acknowledges, with the lock released', { timeout: 1000 }, async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(33)); }, cancel() { cancelled = true; return new Promise(() => {}); } });
  await assert.rejects(readJsonBody(request(body), 32), status(413)); assert.ok(cancelled); assert.equal(body.locked, false);
});

test('malformed UTF-8, incomplete JSON and transport diagnostics never expose submitted fragments', async () => {
  for (const value of [encoder.encode('{"secret-value":'), new Uint8Array([34, 255, 34]), new Uint8Array([34, 0xe2, 0x82]), null]) {
    const body = new ReadableStream<Uint8Array>({ start(c) { if (value) { c.enqueue(value); c.close(); } else c.error(new Error('private-transport-diagnostic')); } });
    await assert.rejects(readJsonBody(request(body)), error => error instanceof JsonBodyError && error.status === 400 && error.message === 'Could not read valid JSON.');
    assert.equal(body.locked, false);
  }
});

test('aborted uploads reject before or during reading without reflecting the abort reason', { timeout: 1000 }, async () => {
  for (const already of [true, false]) {
    const stop = new AbortController(); let cancelled = false;
    if (already) stop.abort(new Error('private-abort-reason'));
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise(() => {}); } });
    const pending = readJsonBody(request(body, stop.signal));
    const rejected = assert.rejects(pending, error => error instanceof JsonBodyError && error.status === 400 && error.message === 'Request was interrupted. Try again.');
    if (!already) { await settle(); stop.abort(new Error('private-abort-reason')); }
    await rejected; assert.ok(cancelled); assert.equal(body.locked, false);
  }
});

test('stalled uploads time out without waiting for cleanup; completed requests release their timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return new Promise(() => {}); } });
  const pending = readJsonBody(request(body)); const rejected = assert.rejects(pending, status(408));
  await settle(); t.mock.timers.tick(requestBodyTimeoutMs - 1); assert.equal(cancelled, 0);
  t.mock.timers.tick(1); await rejected; assert.equal(cancelled, 1); assert.equal(body.locked, false);
  assert.deepEqual(await readJsonBody(request('{"done":true}')), { done: true });
  t.mock.timers.tick(requestBodyTimeoutMs); assert.equal(cancelled, 1);
});

test('missing body and non-JSON media types fail safely; small account requests retain their 32 KB budget', async () => {
  await assert.rejects(readJsonBody(request()), status(400));
  for (const type of ['text/plain', 'text/application/json', 'application/jsonp', 'application/json-other']) await assert.rejects(readJsonBody(request('{}', undefined, { 'Content-Type': type })), status(415));
  assert.deepEqual(await readSmallJson(request('{"enabled":false}')), { enabled: false });
  await assert.rejects(readSmallJson(request(JSON.stringify({ notes: 'x'.repeat(32000) }))), status(413));
});
