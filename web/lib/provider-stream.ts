import type { ProviderId } from './trio.ts';
import { readUsage, type Tokens } from './usage.ts';
import { readResearch, type Research } from './research.ts';

/** Safe to surface: vendor payloads and parser errors can contain credentials. */
export class StreamInterrupted extends Error {
  constructor() { super('The response stream was interrupted.'); this.name = 'StreamInterrupted'; }
}

async function* events(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<any> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', data = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1_000_000) throw new StreamInterrupted();
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (!line) {
          const payload = data.trim(); data = '';
          if (payload && payload !== '[DONE]') yield JSON.parse(payload);
        } else if (line.startsWith('data:')) {
          data += line.slice(5).replace(/^ /, '') + '\n';
          if (data.length > 1_000_000) throw new StreamInterrupted();
        }
      }
      if (done) break; // An unterminated SSE frame is not a completion marker.
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

/** Only visible answer text is forwarded; thought/tool events stay server-side. */
export async function readProviderStream(id: ProviderId, body: ReadableStream<Uint8Array>, signal: AbortSignal, onDelta: (text: string) => void, onUsage?: (tokens: Tokens | null) => void, onResearch?: (research: Research) => void): Promise<string> {
  let text = '', complete = false, usage: any = null, finalClaudeUsage = false;
  const steps = new Map<number, string>();
  const add = (piece: unknown) => {
    if (typeof piece !== 'string' || !piece) return;
    if (text.length + piece.length > 120000) throw new StreamInterrupted();
    text += piece; onDelta(piece);
  };
  try {
    for await (const event of events(body, signal)) {
      const type = id === 'gemini' ? event.event_type : event.type;
      if (type === 'error') throw new StreamInterrupted();
      if (id === 'openai') {
        if (type === 'response.output_text.delta') add(event.delta);
        if (type === 'response.failed' || type === 'response.incomplete') {
          onUsage?.(readUsage(id, event.response)); throw new StreamInterrupted();
        }
        if (type === 'response.completed') {
          onUsage?.(readUsage(id, event.response));
          if (event.response?.status && event.response.status !== 'completed') throw new StreamInterrupted();
          complete = true;
          // The terminal response is authoritative if a provider coalesced deltas.
          const output = (event.response?.output ?? []).flatMap((item: any) => item.content ?? []).filter((part: any) => part.type === 'output_text').map((part: any) => part.text ?? '').join('\n');
          if (output) text = output;
          if (onResearch) { const research = readResearch(event.response); text = research.text; onResearch(research); }
        }
      } else if (id === 'claude') {
        if (type === 'message_start') usage = event.message?.usage ?? null;
        if (type === 'content_block_start' && event.content_block?.type === 'text') add(event.content_block.text);
        if (type === 'content_block_delta' && event.delta?.type === 'text_delta') add(event.delta.text);
        if (type === 'message_delta') {
          usage = { ...usage, ...event.usage };
          if (event.usage?.output_tokens !== undefined) finalClaudeUsage = true;
          if (['max_tokens', 'model_context_window_exceeded'].includes(event.delta?.stop_reason)) {
            onUsage?.(readUsage(id, { usage })); throw new StreamInterrupted();
          }
        }
        if (type === 'message_stop') { onUsage?.(finalClaudeUsage ? readUsage(id, { usage }) : null); complete = true; }
      } else {
        if (type === 'step.start') steps.set(event.index, event.step?.type);
        if (type === 'step.delta' && steps.get(event.index) === 'model_output' && event.delta?.type === 'text') add(event.delta.text);
        if (type === 'interaction.completed') {
          onUsage?.(readUsage(id, event.interaction));
          if (event.interaction?.status !== 'completed') throw new StreamInterrupted();
          complete = true;
        }
      }
      if (complete) break;
    }
    if (!complete || !text.trim() || text.length > 120000) throw new StreamInterrupted();
    return text.trim();
  } catch {
    signal.throwIfAborted();
    throw new StreamInterrupted();
  }
}
