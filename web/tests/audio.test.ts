import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendTranscript, audioSchema, readAudioFile, transcriptionModel } from '../lib/audio.ts';
import { transcribeAudio } from '../lib/transcribe.ts';

const bytes = Buffer.from('RIFF0000WAVEfmt 0000000000000000');
const audio = { format: 'wav', data: bytes.toString('base64') };
const input = { key: 'private-test-key', audio };
const signal = () => new AbortController().signal;
test('audio validates canonical bytes, size, extension, and supported container signatures', async () => {
  assert.ok(audioSchema.safeParse(audio).success);
  for (const value of [{ ...audio, data: audio.data + '\n' }, { ...audio, data: btoa('not audio at all') }, { ...audio, data: Buffer.alloc(4_000_001).toString('base64') }, { ...audio, format: 'html' }, { ...audio, url: 'https://example.com' }]) assert.equal(audioSchema.safeParse(value).success, false);
  for (const [format, data] of [['mp3', 'ID30000000000'], ['mp3', '\xff\xfb0000000000'], ['m4a', '0000ftypM4A '], ['webm', '\x1a\x45\xdf\xa300000000']]) assert.ok(audioSchema.safeParse({ format, data: btoa(data) }).success);
  assert.deepEqual(await readAudioFile(new File([bytes], 'note.wav')), { ...audio, name: 'note.wav' });
  await assert.rejects(readAudioFile(new File([bytes], 'note.exe')), /Choose an MP3/);
  await assert.rejects(readAudioFile(new File(['private'], 'note.wav')), /supported audio header/);
});
test('transcription sends only the audio and its own key to the fixed OpenAI endpoint', async () => {
  let calls = 0;
  const text = await transcribeAudio(input, signal(), async (url, init) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'manual'); assert.equal(init?.cache, 'no-store');
    assert.deepEqual(init?.headers, { Authorization: 'Bearer private-test-key' });
    const form = init?.body as FormData;
    assert.deepEqual([...form.keys()].sort(), ['file', 'model', 'response_format']);
    assert.equal(form.get('model'), transcriptionModel); assert.equal(form.get('response_format'), 'json');
    const file = form.get('file') as File; assert.equal(file.name, 'recording.wav'); assert.equal(file.type, 'audio/wav'); assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    return Response.json({ text: ' A voice note 🌍 ' });
  });
  assert.equal(text, 'A voice note 🌍'); assert.equal(calls, 1);
});
test('invalid transcription input and pre-cancelled requests make no provider calls', async () => {
  const fetcher: typeof fetch = async () => { assert.fail('Network should not run'); };
  for (const value of [{ ...input, key: 'bad\nkey' }, { ...input, audio: { ...audio, data: 'broken' } }, { ...input, prompt: 'hidden context' }]) await assert.rejects(transcribeAudio(value, signal(), fetcher), /supported recording/);
  await assert.rejects(transcribeAudio(input, AbortSignal.abort(), fetcher), /cancelled/);
});
test('provider failures discard sensitive diagnostics, never retry, and do not wait for cleanup', async () => {
  for (const status of [302, 400, 401, 403, 429, 500]) {
    let calls = 0, cancelled = false;
    await assert.rejects(transcribeAudio(input, signal(), async () => {
      calls++; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('private-test-key')); }, cancel() { cancelled = true; return new Promise(() => {}); } }), { status });
    }), error => { assert.ok(error instanceof Error); assert.ok(!error.message.includes(input.key)); return true; });
    assert.equal(calls, 1); assert.equal(cancelled, true);
  }
  await assert.rejects(transcribeAudio(input, signal(), async () => { throw new Error('OpenAI rejected access. private-test-key'); }), /Could not reach OpenAI/);
});
test('transcription rejects malformed, empty, oversized and invalid UTF-8 responses', async () => {
  for (const response of [Response.json({ text: '' }), Response.json({ text: 1 }), Response.json({ text: 'a'.repeat(60_001) }), new Response('bad private-test-key'), new Response(new Uint8Array([255])), new Response('x'.repeat(2_000_001))]) {
    await assert.rejects(transcribeAudio(input, signal(), async () => response), error => { assert.ok(error instanceof Error); assert.ok(!error.message.includes(input.key)); return true; });
  }
});
test('cancellation interrupts a pending transcript body without waiting for transport cleanup', async () => {
  const abort = new AbortController(); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const result = transcribeAudio(input, abort.signal, async () => new Response(new ReadableStream({ start() { started(); }, cancel() { return new Promise(() => {}); } })));
  await ready; abort.abort(); await assert.rejects(result, /cancelled/);
});
test('adding reviewed text preserves the question and rejects overflow without truncation', () => {
  assert.equal(appendTranscript('Existing question', '  Reviewed words  '), 'Existing question\n\nReviewed words');
  assert.equal(appendTranscript('', 'Words'), 'Words');
  assert.equal(appendTranscript('x'.repeat(19_997), 'y').length, 20_000);
  assert.throws(() => appendTranscript('x'.repeat(19_998), 'y'), /20,000/);
  assert.throws(() => appendTranscript('Keep this', ' '), /some transcript text/);
});
