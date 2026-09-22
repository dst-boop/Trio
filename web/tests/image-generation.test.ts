import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage } from '../lib/generate-image.ts';
import { imageGenerationModel } from '../lib/image-generation.ts';
import { readProviderJson } from '../lib/provider-response.ts';
const image = { mimeType: 'image/jpeg', data: Buffer.from([255, 216, 255, ...new Array(30).fill(0)]).toString('base64') };
const input = { key: 'private-image-key', prompt: 'A futuristic observatory', size: '1024x1024', quality: 'medium' };
const signal = () => new AbortController().signal;
test('one image request goes only to the fixed OpenAI endpoint with explicit output settings', async () => {
  let calls = 0;
  const result = await generateImage(input, signal(), async (url, init) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
    assert.deepEqual(init?.headers, { Authorization: 'Bearer private-image-key', 'Content-Type': 'application/json' });
    const { key, ...options } = input;
    assert.deepEqual(JSON.parse(init!.body as string), { ...options, model: imageGenerationModel, n: 1, output_format: 'jpeg', output_compression: 90, background: 'opaque', moderation: 'auto' });
    return Response.json({ data: [{ b64_json: image.data }] });
  });
  assert.deepEqual(result, image); assert.equal(calls, 1);
});
test('invalid options, unexpected context and pre-cancelled requests never reach OpenAI', async () => {
  const fetcher: typeof fetch = async () => { assert.fail('No provider request expected'); };
  for (const invalid of [{ ...input, prompt: '' }, { ...input, prompt: 'x'.repeat(4001) }, { ...input, key: 'bad\nkey' }, { ...input, size: 'auto' }, { ...input, quality: 'max' }, { ...input, memory: 'private context' }, { ...input, model: 'other' }]) await assert.rejects(generateImage(invalid, signal(), fetcher), /Enter a description/);
  await assert.rejects(generateImage(input, AbortSignal.abort(), fetcher), /cancelled/);
});
test('provider errors discard diagnostics without retrying or awaiting cleanup', async () => {
  for (const status of [302, 400, 401, 403, 429, 500]) {
    let calls = 0, cancelled = false;
    await assert.rejects(generateImage(input, signal(), async () => { calls++; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('private-image-key')); }, cancel() { cancelled = true; return new Promise(() => {}); } }), { status }); }), error => { assert.ok(error instanceof Error); assert.ok(!error.message.includes(input.key)); return true; });
    assert.equal(calls, 1); assert.equal(cancelled, true);
  }
  await assert.rejects(generateImage(input, signal(), async () => { throw new Error('OpenAI rejected access. private-image-key'); }), /Could not reach OpenAI/);
});
test('generation rejects remote URLs, malformed raster data and oversized decoded images', async () => {
  for (const data of [{ data: [{ url: 'https://example.com/private' }] }, { data: [] }, { data: [{ b64_json: image.data }, { b64_json: image.data }] }, { data: [{ b64_json: btoa('<svg>not an image</svg>') }] }, { data: [{ b64_json: image.data + '\n' }] }, { data: [{ b64_json: Buffer.from([255, 216, 255, ...new Array(4_000_000).fill(0)]).toString('base64') }] }]) {
    let calls = 0; await assert.rejects(generateImage(input, signal(), async () => { calls++; return Response.json(data); }), /supported JPEG/); assert.equal(calls, 1);
  }
});
test('image response budget allows larger base64 while preserving the default text response cap', async () => {
  const large = Response.json({ data: [{ b64_json: image.data }], metadata: 'x'.repeat(2_100_000) });
  assert.deepEqual(await generateImage(input, signal(), async () => large.clone()), image);
  await assert.rejects(readProviderJson(large.clone(), signal()), /oversized/);
  for (const response of [new Response('x'.repeat(6_000_001)), new Response(new Uint8Array([255])), new Response('{private-image-key')]) await assert.rejects(generateImage(input, signal(), async () => response), /unreadable or oversized/);
  for (const limit of [0, NaN, Infinity, 10_000_001]) await assert.rejects(readProviderJson(Response.json({}), signal(), limit), /Invalid provider response limit/);
});
test('cancelling a pending image response interrupts reading without waiting for cleanup', async () => {
  const abort = new AbortController(); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const result = generateImage(input, abort.signal, async () => new Response(new ReadableStream({ start() { started(); }, cancel() { return new Promise(() => {}); } })));
  await ready; abort.abort(); await assert.rejects(result, /cancelled/);
});
