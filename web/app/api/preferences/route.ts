import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountReply as reply } from '@/lib/account-api';
import { readJsonBody, JsonBodyError } from '@/lib/request-json';
import { workspacePreferencesSchema } from '@/lib/workspace-preferences';
import { readWorkspacePreferences, writeWorkspacePreferences } from '@/lib/workspace-preferences-store';
import { workspaceAvailability } from '@/lib/workspace-keys';

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user || request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'Sign in again to load workspace preferences.' }, 401);
  try {
    if (!env.DB) throw new Error();
    return reply({ ...await readWorkspacePreferences(env.DB, user.userId, workspaceAvailability(env)), accountId: user.userId });
  } catch { return reply({ error: 'Could not load saved preferences. This tab is using temporary choices.' }, 503); }
}

export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user || request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'Your account changed. Reload Trio before saving preferences.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid request origin.' }, 403);
  let input;
  try { input = workspacePreferencesSchema.parse(await readJsonBody(request, 1024)); }
  catch (error) { return reply({ error: 'Invalid workspace preferences.' }, error instanceof JsonBodyError ? error.status : 400); }
  try {
    if (!env.DB) throw new Error();
    if (!await writeWorkspacePreferences(env.DB, user.userId, input)) return reply({ error: 'Preferences changed in another tab or device. Load saved preferences to continue saving.' }, 409);
    return reply({ ...input, revision: input.revision + 1, accountId: user.userId });
  } catch { return reply({ error: 'Preferences were not confirmed saved. Your choices still work in this tab; retry saving.' }, 503); }
}
