import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSchema, maxImageBytes, readImageFile, type ImageInput } from '../lib/images.ts';
import { callProvider, orchestrate } from '../lib/orchestrate.ts';
import { freshConnections, type ProviderId } from '../lib/trio.ts';
import { parseSessions, serializeSessions, conversationHistory, sessionMarkdown } from '../lib/sessions.ts';

const image: ImageInput = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' };
test('image validation accepts raster bytes and rejects URLs, SVG, mismatches, and excessive data', () => {
  assert.equal(imageSchema.safeParse(image).success, true);
  for (const invalid of [{ mimeType: 'image/svg+xml', data: btoa('<svg></svg>') }, { ...image, data: 'https://example.com/image.png' }, { ...image, uri: 'https://example.com/image.png', data: undefined }, { ...image, mimeType: 'image/jpeg' }, { ...image, data: image.data + '\n' }, { ...image, data: 'A'.repeat(6_000_000) }, { ...image, data: btoa('\x89PNG\r\n\x1a\n' + 'x'.repeat(maxImageBytes)) }]) assert.equal(imageSchema.safeParse(invalid).success, false);
  assert.equal(imageSchema.safeParse({ mimeType: 'image/jpeg', data: btoa('\xff\xd8\xff' + 'x'.repeat(15)) }).success, true);
  assert.equal(imageSchema.safeParse({ mimeType: 'image/webp', data: btoa('RIFFxxxxWEBP' + 'x'.repeat(15)) }).success, true);
});

test('browser file loading verifies decoding and dimensions before accepting a preview', async () => {
  const original = globalThis.createImageBitmap; let closed = false;
  try {
    globalThis.createImageBitmap = (async () => ({ width: 1, height: 1, close() { closed = true; } })) as typeof createImageBitmap;
    const file = new File([Uint8Array.from(atob(image.data), c => c.charCodeAt(0))], 'diagram.png', { type: 'image/png' });
    assert.deepEqual(await readImageFile(file), { ...image, name: 'diagram.png' }); assert.equal(closed, true);
    globalThis.createImageBitmap = (async () => ({ width: 8001, height: 1, close() {} })) as typeof createImageBitmap;
    await assert.rejects(readImageFile(file), /8,000 pixels/);
    globalThis.createImageBitmap = async () => { throw new Error('Malformed image'); };
    await assert.rejects(readImageFile(file), /could not be decoded/);
    await assert.rejects(readImageFile(new File([new Uint8Array(maxImageBytes + 1)], 'large.png')), /4 MB/);
  } finally { globalThis.createImageBitmap = original; }
});

function assertBody(id: ProviderId, body: any) {
  const content = id === 'claude' ? body.messages[0].content : id === 'openai' ? body.input[0].content : body.input;
  const picture = content[0], text = content[1];
  if (id === 'openai') { assert.equal(picture.type, 'input_image'); assert.equal(picture.image_url, `data:image/png;base64,${image.data}`); assert.equal(text.type, 'input_text'); }
  else if (id === 'claude') assert.deepEqual(picture, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } });
  else assert.deepEqual(picture, { type: 'image', mime_type: 'image/png', data: image.data });
  assert.ok(!text.text.includes(image.data), 'Image bytes never become text tokens in the prompt');
  return text.text as string;
}
function response(id: ProviderId) {
  const text = 'Visible finding with uncertainty';
  return Response.json(id === 'openai' ? { output: [{ content: [{ type: 'output_text', text }] }], usage: { input_tokens: 100, output_tokens: 10 } } : id === 'claude' ? { content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 10 } } : { steps: [{ type: 'model_output', content: [{ type: 'text', text }] }], usage: { total_input_tokens: 100, total_output_tokens: 10 } });
}
for (const id of ['openai', 'claude', 'gemini'] as const) test(`${id} sends image bytes in its native image part`, async () => {
  const fetcher = (async (_url, init) => { assert.equal(assertBody(id, JSON.parse(init!.body as string)), 'Question'); return response(id); }) as typeof fetch;
  await callProvider(id, 'fake-key', 'model', 'system', 'Question', new AbortController().signal, fetcher, undefined, () => {}, image);
});

test('image rejection gives useful guidance without reflecting vendor diagnostics', async () => {
  await assert.rejects(callProvider('openai', 'private-test-key', 'custom-model', 'system', 'q', new AbortController().signal, (async () => new Response('private-test-key rejected', { status: 400 })) as typeof fetch, undefined, () => {}, image), e => e instanceof Error && /Check image support/.test(e.message) && !e.message.includes('private-test-key'));
});

test('all Deep Council stages and stream recovery retain shared image context', async () => {
  const connections = freshConnections(); Object.values(connections).forEach(c => c.key = 'fake-key');
  let calls = 0;
  const fetcher = (async (url, init) => {
    calls++; const id: ProviderId = String(url).includes('openai') ? 'openai' : String(url).includes('anthropic') ? 'claude' : 'gemini';
    const body = JSON.parse(init!.body as string);
    const prompt = JSON.parse(assertBody(id, body));
    assert.ok(JSON.stringify(prompt).includes('What is in the image?'));
    assert.match(body.instructions ?? body.system ?? body.system_instruction, /untrusted reference data/);
    if (calls === 1) return new Response('data: {"type":"response.output_text.delta","delta":"Unfinished"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    return response(id);
  }) as typeof fetch;
  const result = await orchestrate({ question: 'What is in the image?', image, connections, mode: 'deep', lead: 'claude' }, () => {}, new AbortController().signal, fetcher);
  assert.equal(calls, 11); assert.equal(Object.keys(result.revisions!).length, 3);
  assert.ok(!JSON.stringify(result).includes(image.data)); assert.equal(result.usage?.costUSD, null);
  assert.ok(Object.values(result.usage!.byProvider).every(row => row.costUSD === null));
});

test('history retains an image reference while stripping bytes and warning future models', () => {
  const turns = [{ question: 'Read the diagram', mode: 'fast' as const, imageName: 'diagram.png', image, result: { drafts: {}, reviews: {}, answer: 'Finding', errors: [], seconds: 1, demo: false } }];
  const raw = serializeSessions([{ id: 'image-session', title: 'Read the diagram', time: '', turns }]);
  assert.ok(!raw.includes(image.data)); assert.equal(parseSessions(raw)[0].turns[0].imageName, 'diagram.png');
  assert.match(conversationHistory(turns)[0].content, /bytes are not part of the text history/);
  assert.match(sessionMarkdown(turns), /Image data is not included/);
});
