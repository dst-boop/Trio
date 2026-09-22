import { z } from 'zod';
import { orchestrate } from '@/lib/orchestrate';
import { selectResearchProvider } from '@/lib/research';
import { instructionsSchema } from '@/lib/instructions';
import { imageSchema } from '@/lib/images';
import { pdfSchema, attachmentBytes, maxAttachmentBytes } from '@/lib/pdf';

const connection = z.object({ key: z.string().max(1024), model: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/), enabled: z.boolean() });
const schema = z.object({ instructions: instructionsSchema.optional(), webResearch: z.boolean().optional(), researchProvider: z.enum(['auto', 'openai', 'claude']).optional(), question: z.string().trim().min(1).max(20000), context: z.string().max(60000).optional(), image: imageSchema.optional(), pdf: pdfSchema.optional(), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(30000) })).max(12).optional(), connections: z.object({ openai: connection, claude: connection, gemini: connection }), mode: z.enum(['council', 'deep', 'fast', 'compare']), lead: z.enum(['openai', 'claude', 'gemini']) }).refine(data => attachmentBytes(data.image, data.pdf) <= maxAttachmentBytes, 'Images and PDFs together must be under 4 MB.');
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  if (!request.headers.get('content-type')?.includes('application/json')) return Response.json({ error: 'Expected JSON.' }, { status: 415 });
  // Keys are supplied per request, used only with fixed vendor endpoints, and never logged or persisted.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: 'Request body required.' }, { status: 400 });
  let length = 0; const chunks: Uint8Array[] = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 8000000) { await reader.cancel(); return Response.json({ error: 'Request too large.' }, { status: 413 }); } chunks.push(value); }
  const bytes = new Uint8Array(length); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return Response.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: 'Check your prompt, session instructions (up to 6,000 characters), model IDs, context length, image format (PNG, JPEG, or WebP), and PDF format. Images and PDFs together must be under 4 MB.' }, { status: 400 });
  if (!Object.values(parsed.data.connections).some(c => c.enabled && c.key.trim())) return Response.json({ error: 'Connect at least one model.' }, { status: 400 });
  if (parsed.data.webResearch) { try { selectResearchProvider(parsed.data.connections, parsed.data.researchProvider); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Connect a research provider.' }, { status: 400 }); } }
  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (request.signal.aborted) cancel();
  else request.signal.addEventListener('abort', cancel, { once: true });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const emit = (event: unknown) => { if (!abort.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')); };
      orchestrate(parsed.data, emit, abort.signal).catch(e => { if (!abort.signal.aborted) emit({ type: 'error', text: e instanceof Error ? e.message : 'The session failed.' }); }).finally(() => { request.signal.removeEventListener('abort', cancel); if (!abort.signal.aborted) controller.close(); });
    },
    cancel() { abort.abort(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
