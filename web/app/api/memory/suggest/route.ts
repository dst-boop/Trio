import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountReply as reply, readSmallJson } from '@/lib/account-api';
import { readMemory } from '@/lib/memory-store';
import { readWorkspace } from '@/lib/account-store';
import { suggestionRequestSchema, suggestMemory } from '@/lib/memory-suggestions';
import { CredentialError, resolveCredential } from '@/lib/credential-store';
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user || request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'Sign in again to suggest personal memory.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid request origin.' }, 403);
  let input; try { input = suggestionRequestSchema.parse(await readSmallJson(request)); } catch { return reply({ error: 'Choose a saved conversation and a connected model.' }, 400); }
  let workspace, memory;
  try { input.connection.key = await resolveCredential(env.DB, env.TRIO_CREDENTIAL_KEY, request, user.userId, input.connection.provider, input.connection.key); }
  catch (error) { return reply({ error: error instanceof CredentialError ? error.message : 'Saved key unavailable.' }, error instanceof CredentialError ? error.status : 503); }
  try { if (!env.DB) throw new Error(); [workspace, memory] = await Promise.all([readWorkspace(env.DB, user.userId), readMemory(env.DB, user.userId)]); }
  catch { return reply({ error: 'Saved conversations or personal memory are unavailable. Try again.' }, 503); }
  const session = workspace.sessions.find(s => s.id === input.sessionId);
  if (!session) return reply({ error: 'Save this conversation to your account before suggesting memory.' }, 404);
  try {
    const suggestion = await suggestMemory(session, memory.notes, input.connection, request.signal);
    return reply({ suggestion });
  } catch (error) { return reply({ error: error instanceof Error ? error.message : 'Could not suggest memory. Try again.' }, 502); }
}
