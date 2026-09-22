import { z } from 'zod';
import { resultSchema } from './sessions.ts';
import { researchSchema } from './research.ts';
import type { Result, RunEvent } from './trio.ts';

// A final event contains all Deep Council contributions and can include JSON escaping.
export const maxRunEventCharacters = 10_000_000;
const provider = z.enum(['openai', 'claude', 'gemini']);
const phase = z.enum(['research', 'draft', 'review', 'revision', 'synthesis']);
const text = z.string().max(120000);
const eventSchemas = {
  stage: z.object({ type: z.literal('stage'), stage: phase, provider: provider.optional() }),
  research: z.object({ type: z.literal('research'), research: researchSchema }),
  draft: z.object({ type: z.literal('draft'), provider, text }),
  review: z.object({ type: z.literal('review'), provider, text }),
  revision: z.object({ type: z.literal('revision'), provider, text }),
  error: z.object({ type: z.literal('error'), text: z.string().max(4000), provider: provider.optional() }),
  usage: z.object({ type: z.literal('usage'), usage: resultSchema.shape.usage.unwrap() }),
  contribution_start: z.object({ type: z.literal('contribution_start'), phase, provider }),
  contribution_delta: z.object({ type: z.literal('contribution_delta'), phase, provider, text }),
  final: z.object({ type: z.literal('final'), result: resultSchema }),
};

/** The first valid final event ends a run; connection closure is not a second completion signal. */
export async function readRunStream(body: ReadableStream<Uint8Array> | null, signal: AbortSignal, onEvent: (event: RunEvent) => void): Promise<Result> {
  if (!body) throw new Error('Connection interrupted. Try again.');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const consume = (line: string): Result | undefined => {
    if (line.length > maxRunEventCharacters) throw new Error();
    if (!line.trim()) return;
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') throw new Error();
    // Unknown event types are ignored for forwards compatibility; known events must be valid.
    if (!Object.hasOwn(eventSchemas, value.type)) return;
    const event = eventSchemas[value.type as keyof typeof eventSchemas].parse(value);
    onEvent(event);
    return event.type === 'final' ? event.result : undefined;
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const result = consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (result) return result;
      }
      if (buffer.length > maxRunEventCharacters) throw new Error();
      if (done) {
        const result = consume(buffer);
        if (result) return result;
        throw new Error();
      }
    }
  } catch {
    signal.throwIfAborted();
    // Neither parser diagnostics nor raw response fragments belong in the UI or saved history.
    throw new Error('Connection interrupted. Try again.');
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel(); reader.releaseLock();
  }
}
