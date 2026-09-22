import { readRunStream } from './read-run-stream.ts';
import type { Result, RunEvent } from './trio.ts';

export const runStartupTimeoutMs = 30_000;
// Providers have 120 seconds per attempt. Leave room for their timeout/failover events.
export const runIdleTimeoutMs = 150_000;
export const runStartupTimeoutMessage = 'Trio took too long to start this request. No completed answer was saved. Your prompt is still here; retry when ready.';
export const runIdleTimeoutMessage = 'The connection stopped sending updates. No completed answer was saved. Partial text is shown below; retry when ready.';
const interruptedMessage = 'Connection interrupted. Try again.';

/** Read only a small app error envelope, never an unbounded proxy/HTML error body. */
async function startError(response: Response, signal: AbortSignal): Promise<string> {
  const fallback = 'Could not start this session. Check your connection and try again.';
  if (!response.body) return fallback;
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let bytes = 0, text = '';
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32_000) return fallback;
      text += decoder.decode(value, { stream: true });
    }
    const data: unknown = JSON.parse(text + decoder.decode());
    return data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error.trim() && data.error.length <= 2000 ? data.error : fallback;
  } catch { signal.throwIfAborted(); return fallback; }
  finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}

/** Bound startup and inactivity independently; active multi-stage work has no total-time cap. */
export async function runLiveRequest(payload: string, headers: HeadersInit, stop: AbortSignal, onEvent: (event: RunEvent) => void, fetcher: typeof fetch = fetch): Promise<Result> {
  stop.throwIfAborted();
  const request = new AbortController(), signal = AbortSignal.any([stop, request.signal]);
  let timer: ReturnType<typeof setTimeout>;
  let rejectInterrupted!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  const onAbort = () => rejectInterrupted(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const arm = (ms: number, message: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => request.abort(new Error(message)), ms);
  };
  arm(runStartupTimeoutMs, runStartupTimeoutMessage);
  const execute = async () => {
    let response: Response;
    try { response = await fetcher('/api/ask', { method: 'POST', headers, body: payload, signal, cache: 'no-store', redirect: 'error' }); }
    catch { signal.throwIfAborted(); throw new Error(interruptedMessage); }
    // A late fetch implementation must not deliver events after cancellation or timeout.
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
    if (!response.ok) throw new Error(await startError(response, signal));
    arm(runIdleTimeoutMs, runIdleTimeoutMessage);
    return readRunStream(response.body, signal, event => {
      signal.throwIfAborted();
      // Only validated application events count as progress, not blank/unknown records.
      arm(runIdleTimeoutMs, runIdleTimeoutMessage);
      onEvent(event);
    });
  };
  try { return await Promise.race([execute(), interrupted]); }
  finally {
    clearTimeout(timer!); signal.removeEventListener('abort', onAbort);
    request.abort(); // Release the underlying request as well as the stream reader.
  }
}
