import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { readWorkspace, writeWorkspace, workspaceWriteSchema } from '@/lib/account-store';

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return reply({ error: 'Sign in to open your workspace.' }, 401);
  if (request.headers.has('x-trio-account') && request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'The signed-in account changed. Reload to open the current account.' }, 401);
  try {
    if (!env.DB) throw new Error('Database unavailable');
    return reply({ ...await readWorkspace(env.DB, user.userId), accountId: user.userId });
  } catch { return reply({ error: 'Your saved workspace is temporarily unavailable. Please retry.' }, 503); }
}
export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return reply({ error: 'Your sign-in expired. Export unsaved work, then sign in again.' }, 401);
  if (request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'The signed-in account changed. Download your unsaved work, then reload.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid request origin.' }, 403);
  if (request.headers.get('x-trio-workspace-version') !== '3') return reply({ error: 'Trio has updated its saved history format. Download any unsaved work, then reload this page before saving.' }, 409);
  if (!request.headers.get('content-type')?.includes('application/json')) return reply({ error: 'Expected JSON.' }, 415);
  const reader = request.body?.getReader();
  if (!reader) return reply({ error: 'Request body required.' }, 400);
  let raw = ''; let size = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 20_000_000) { void reader.cancel().catch(() => {}); return reply({ error: 'Workspace is too large. Export a backup and remove older sessions.' }, 413); }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } catch { return reply({ error: 'Could not read the workspace.' }, 400); }
  finally { reader.releaseLock(); }
  let input;
  try { input = workspaceWriteSchema.parse(JSON.parse(raw)); }
  catch { return reply({ error: 'Invalid workspace backup.' }, 400); }
  try {
    if (!env.DB) throw new Error('Database unavailable');
    if (!await writeWorkspace(env.DB, user.userId, input)) return reply({ error: 'Another tab or device saved newer changes. Download your backup before loading the latest workspace.' }, 409);
    return reply({ revision: input.revision + 1 });
  } catch { return reply({ error: 'Could not save your workspace. Keep this tab open and download a backup.' }, 503); }
}
