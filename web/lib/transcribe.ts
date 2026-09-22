import { audioMime, transcriptionModel, transcriptionSchema } from './audio.ts';
import { readProviderJson } from './provider-response.ts';
class TranscriptionError extends Error {}

/** One explicit paid request. Audio and keys are never written to Trio storage. */
export async function transcribeAudio(input: unknown, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  const parsed = transcriptionSchema.safeParse(input);
  if (!parsed.success) throw new Error('Choose a supported recording under 4 MB and add your OpenAI API key.');
  const { key, audio } = parsed.data;
  const timeout = AbortSignal.timeout(120_000), combined = AbortSignal.any([signal, timeout]);
  const form = new FormData();
  form.set('file', new Blob([Uint8Array.from(atob(audio.data), c => c.charCodeAt(0))], { type: audioMime(audio.format) }), 'recording.' + audio.format);
  form.set('model', transcriptionModel); form.set('response_format', 'json');
  try {
    combined.throwIfAborted();
    const response = await fetcher('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: combined, redirect: 'manual', cache: 'no-store' });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new TranscriptionError('OpenAI rejected access. Check your API key and transcription permissions.');
      if (response.status === 429) throw new TranscriptionError('OpenAI is limiting requests. Check your API billing and limits.');
      throw new TranscriptionError('OpenAI could not transcribe this recording. Check its format, length, and your account access before trying again.');
    }
    let data;
    try { data = await readProviderJson(response, combined); }
    catch { combined.throwIfAborted(); throw new TranscriptionError('OpenAI returned an unreadable transcript. Try a shorter recording.'); }
    if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 60_000) throw new TranscriptionError('No usable transcript was returned. Try a shorter, clearer recording.');
    return data.text.trim();
  } catch (error) {
    if (signal.aborted) throw new Error('Transcription cancelled. OpenAI may still bill work already started.');
    if (timeout.aborted) throw new Error('Transcription timed out. OpenAI may still bill work already started.');
    // Only our fixed messages may escape. Transport diagnostics can include credentials.
    if (error instanceof TranscriptionError) throw error;
    throw new Error('Could not reach OpenAI. Check your connection before trying again.');
  }
}
