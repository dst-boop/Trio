import { readJsonBody, JsonBodyError } from '@/lib/request-json';
import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { readWorkspace, writeWorkspace, workspaceWriteSchema } from '@/lib/account-store';
import { workspaceVersion } from '@/lib/workspace-version';

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
  if (request.headers.get('x-trio-workspace-version') !== String(workspaceVersion)) return reply({ error: 'Trio has updated its saved history format. Download any unsaved work, then reload this page before saving.' }, 409);
  let body;
  try { body = await readJsonBody(request, 20_000_000); }
  catch (error) {
    const status = error instanceof JsonBodyError ? error.status : 400;
    return reply({ error: status === 413 ? 'Workspace is too large. Export a backup and remove older sessions.' : error instanceof JsonBodyError ? error.message : 'Could not read the workspace.' }, status);
  }
  let input;
  try { input = workspaceWriteSchema.parse(body); }
  catch { return reply({ error: 'Invalid workspace backup.' }, 400); }
  try {
    if (!env.DB) throw new Error('Database unavailable');
    if (!await writeWorkspace(env.DB, user.userId, input)) return reply({ error: 'Another tab or device saved newer changes. Download your backup before loading the latest workspace.' }, 409);
    return reply({ revision: input.revision + 1 });
  } catch { return reply({ error: 'Could not save your workspace. Keep this tab open and download a backup.' }, 503); }
}
