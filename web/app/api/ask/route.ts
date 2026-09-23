import { readJsonBody, JsonBodyError } from '@/lib/request-json';
import { accountReply as reply } from '@/lib/account-api';
import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { orchestrate } from '@/lib/orchestrate';
import { selectResearchProvider } from '@/lib/research';
import { instructionsSchema } from '@/lib/instructions';
import { timeZoneSchema } from '@/lib/current-time';
import { env } from 'cloudflare:workers';
import { readMemory } from '@/lib/memory-store';
import { imageSchema } from '@/lib/images';
import { pdfSchema, attachmentBytes, maxAttachmentBytes } from '@/lib/pdf';

const connection = z.object({ key: z.string().max(1024), model: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/), enabled: z.boolean() });
const schema = z.object({ timeZone: timeZoneSchema.optional(), personalize: z.boolean().optional(), instructions: instructionsSchema.optional(), webResearch: z.boolean().optional(), researchProvider: z.enum(['auto', 'openai', 'claude']).optional(), question: z.string().trim().min(1).max(20000), context: z.string().max(60000).optional(), image: imageSchema.optional(), pdf: pdfSchema.optional(), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(30000) })).max(12).optional(), connections: z.object({ openai: connection, claude: connection, gemini: connection }), reviewAnswer: z.string().trim().min(1).max(120000).optional(), mode: z.enum(['single', 'council', 'deep', 'fast', 'compare']), lead: z.enum(['openai', 'claude', 'gemini']) }).refine(data => attachmentBytes(data.image, data.pdf) <= maxAttachmentBytes, 'Images and PDFs together must be under 4 MB.');
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return reply({ error: 'Sign in to Trio to run live models. Your keys have not been sent to any provider.' }, 401);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return reply({ error: 'Invalid request origin.' }, 403);
  // Keys remain request-scoped. Reject bad uploads before checking memory or calling providers.
  let body;
  try { body = await readJsonBody(request, 8_000_000); }
  catch (error) { return reply({ error: error instanceof JsonBodyError ? error.message : 'Could not read the request.' }, error instanceof JsonBodyError ? error.status : 400); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return reply({ error: 'Check your answer mode, time zone, prompt, session instructions (up to 6,000 characters), model IDs, context length, image format (PNG, JPEG, or WebP), and PDF format. Images and PDFs together must be under 4 MB.' }, 400);
  if (!Object.values(parsed.data.connections).some(c => c.enabled && c.key.trim())) return reply({ error: 'Connect at least one model.' }, 400);
  if (parsed.data.mode === 'single' && !(parsed.data.connections[parsed.data.lead].enabled && parsed.data.connections[parsed.data.lead].key.trim())) return reply({ error: 'Connect the selected answer model or choose another model.' }, 400);
  if (parsed.data.reviewAnswer && (parsed.data.mode !== 'council' || Object.values(parsed.data.connections).filter(c => c.enabled && c.key.trim()).length < 2)) return reply({ error: 'Team review requires Council and at least two connected models.' }, 400);
  if (parsed.data.webResearch) { try { selectResearchProvider(parsed.data.connections, parsed.data.researchProvider); } catch (error) { return reply({ error: error instanceof Error ? error.message : 'Connect a research provider.' }, 400); } }
  let memory: string | undefined;
  if (parsed.data.personalize) {
    if (request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'Your account changed. Reload before starting a personalized answer.' }, 401);
    try { if (!env.DB) throw new Error(); const profile = await readMemory(env.DB, user.userId); if (profile.enabled) memory = profile.notes; }
    catch { return reply({ error: 'Personal memory could not be checked. Retry before running your models.' }, 503); }
  }
  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (request.signal.aborted) cancel();
  else request.signal.addEventListener('abort', cancel, { once: true });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const emit = (event: unknown) => { if (!abort.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')); };
      orchestrate({ ...parsed.data, memory }, emit, abort.signal).catch(e => { if (!abort.signal.aborted) emit({ type: 'error', text: e instanceof Error ? e.message : 'The session failed.' }); }).finally(() => { request.signal.removeEventListener('abort', cancel); if (!abort.signal.aborted) controller.close(); });
    },
    cancel() { abort.abort(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
}
