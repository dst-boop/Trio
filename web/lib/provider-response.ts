import type { ProviderId } from './trio.ts';

export const maxProviderResponseBytes = 2_000_000;
export const maxAnswerCharacters = 120_000;

/** Bound decoded network bytes before parsing; never surface a vendor/parser diagnostic. */
export async function readProviderJson(response: Response, signal: AbortSignal): Promise<Record<string, any>> {
  if (!response.body) throw new Error('The provider returned an unreadable response.');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    // Headers are only an early rejection hint; count actual bytes even if omitted or incorrect.
    if (Number(response.headers.get('content-length')) > maxProviderResponseBytes) throw new Error();
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) { text += decoder.decode(); break; }
      bytes += value.byteLength;
      if (bytes > maxProviderResponseBytes) throw new Error();
      text += decoder.decode(value, { stream: true });
    }
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, any>;
  } catch {
    signal.throwIfAborted();
    throw new Error('The provider returned an unreadable or oversized response. Try a shorter question or another model.');
  } finally {
    signal.removeEventListener('abort', cancel);
    // Closing a vendor connection must not delay Stop or failover if its cleanup stalls.
    cancel(); reader.releaseLock();
  }
}

/** Extract visible text only; malformed blocks cannot become strings or vendor diagnostics. */
export function readProviderText(id: ProviderId, data: Record<string, any>): string {
  let parts: any[];
  if (id === 'claude') parts = Array.isArray(data.content) ? data.content : [];
  else {
    const items = id === 'openai' ? data.output : data.steps;
    parts = (Array.isArray(items) ? items : []).filter(item => id === 'openai' || item?.type === 'model_output').flatMap(item => Array.isArray(item?.content) ? item.content : []);
  }
  let text = '';
  for (const part of parts) {
    if (part?.type !== (id === 'openai' ? 'output_text' : 'text')) continue;
    if (typeof part.text !== 'string') throw new Error('The provider returned an unreadable answer.');
    const separator = text ? '\n' : '';
    if (text.length + separator.length + part.text.length > maxAnswerCharacters) throw new Error('The provider returned an oversized answer. Try a shorter question or another model.');
    text += separator + part.text;
  }
  if (!text.trim()) throw new Error('No text returned. The response may have been blocked or exceeded its output limit.');
  return text.trim();
}
