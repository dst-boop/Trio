import { z } from 'zod';

export const maxAudioBytes = 4_000_000;
export const transcriptionModel = 'gpt-4o-mini-transcribe';
const formats = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', webm: 'audio/webm' } as const;
export type AudioInput = { format: keyof typeof formats; data: string };
export type AttachedAudio = AudioInput & { name: string };
export const audioMime = (format: AudioInput['format']) => formats[format];

// Basic container checks, not a decoder. OpenAI validates codecs and complete file structure.
function validAudio(audio: AudioInput): boolean {
  try {
    const bytes = atob(audio.data);
    if (bytes.length < 12 || bytes.length > maxAudioBytes || btoa(bytes) !== audio.data) return false;
    if (audio.format === 'wav') return bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WAVE';
    if (audio.format === 'mp3') return bytes.startsWith('ID3') || bytes.charCodeAt(0) === 255 && (bytes.charCodeAt(1) & 0xe0) === 0xe0;
    if (audio.format === 'm4a') return bytes.slice(4, 8) === 'ftyp';
    return bytes.slice(0, 4) === '\x1a\x45\xdf\xa3';
  } catch { return false; }
}
export const audioSchema = z.object({ format: z.enum(['mp3', 'wav', 'm4a', 'webm']), data: z.string().min(1).max(Math.ceil(maxAudioBytes / 3) * 4) }).strict().refine(validAudio);
export const transcriptionSchema = z.object({ key: z.string().trim().min(1).max(1024).regex(/^[!-~]+$/), audio: audioSchema }).strict();

export async function readAudioFile(file: File): Promise<AttachedAudio> {
  const format = file.name.split('.').at(-1)?.toLowerCase();
  if (!format || !(format in formats) || !file.size || file.size > maxAudioBytes) throw new Error('Choose an MP3, WAV, M4A, or WebM recording under 4 MB.');
  let buffer: Uint8Array;
  try { buffer = new Uint8Array(await file.arrayBuffer()); } catch { throw new Error('Could not read this recording. Choose it again.'); }
  let bytes = '';
  for (let offset = 0; offset < buffer.length; offset += 32768) bytes += String.fromCharCode(...buffer.subarray(offset, offset + 32768));
  const parsed = audioSchema.safeParse({ format, data: btoa(bytes) });
  if (!parsed.success) throw new Error('This file does not have a supported audio header. Choose another recording.');
  return { ...parsed.data, name: file.name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 255) };
}

/** Never silently truncate a transcript or replace an existing question. */
export function appendTranscript(question: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) throw new Error('Review and enter some transcript text first.');
  const combined = question + (question ? '\n\n' : '') + text;
  if (combined.length > 20_000) throw new Error('The question and transcript together exceed 20,000 characters. Shorten the transcript before adding it.');
  return combined;
}
