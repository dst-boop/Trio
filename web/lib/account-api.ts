export const accountReply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
export async function readSmallJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new Error('Expected JSON.');
  const reader = request.body?.getReader(); if (!reader) throw new Error('Request body required.');
  let text = ''; let bytes = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 32_000) { void reader.cancel().catch(() => {}); throw new Error('Request too large.'); } text += decoder.decode(value, { stream: true }); }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
