export const requestBodyTimeoutMs = 30_000;
export class JsonBodyError extends Error {
  readonly status: 400 | 408 | 413 | 415;
  constructor(message: string, status: 400 | 408 | 413 | 415) { super(message); this.name = 'JsonBodyError'; this.status = status; }
}

/** Count actual bytes, reject malformed UTF-8, and never wait for a cancellation handshake. */
export async function readJsonBody(request: Request, maxBytes = 32_000): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new JsonBodyError('Expected JSON.', 415);
  if (!request.body) throw new JsonBodyError('Request body required.', 400);
  const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let failure: JsonBodyError | undefined, bytes = 0, text = '';
  const interrupted = () => { failure ??= new JsonBodyError('Request was interrupted. Try again.', 400); cancel(); };
  const timer = setTimeout(() => { failure ??= new JsonBodyError('Request upload timed out. Try again.', 408); cancel(); }, requestBodyTimeoutMs);
  request.signal.addEventListener('abort', interrupted, { once: true });
  try {
    if (request.signal.aborted) interrupted();
    while (true) {
      if (failure) throw failure;
      const { value, done } = await reader.read();
      if (failure) throw failure;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new JsonBodyError('Request too large.', 413);
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof JsonBodyError) throw error;
    // Stream, UTF-8, and JSON diagnostics can include submitted data. Never reflect them.
    throw new JsonBodyError('Could not read valid JSON.', 400);
  } finally {
    clearTimeout(timer); request.signal.removeEventListener('abort', interrupted);
    cancel(); reader.releaseLock();
  }
}
