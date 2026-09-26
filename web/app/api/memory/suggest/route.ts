import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountReply as reply } from '@/lib/account-api';
import { readJsonBody, JsonBodyError } from '@/lib/request-json';
import { readMemory } from '@/lib/memory-store';
import { readWorkspace } from '@/lib/account-store';
import { suggestionRequestSchema, suggestMemory, MemorySuggestionError } from '@/lib/memory-suggestions';
import { CredentialError, readSavedConnections, resolveCredential } from '@/lib/credential-store';
import { resolveRequestKey, workspaceAvailability } from '@/lib/workspace-keys';
import { savedKeyReference, workspaceKeyReference } from '@/lib/saved-connections';
import { providers } from '@/lib/trio';
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user || request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'Your account changed. Reload Trio before suggesting memory.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid request origin.' }, 403);
  let input;
  try { input = suggestionRequestSchema.parse(await readJsonBody(request, 4096)); }
  catch (error) { return reply({ error: 'Choose a saved conversation and a connected model.' }, error instanceof JsonBodyError ? error.status : 400); }
  try {
    if (!env.DB) throw new Error();
    const [workspace, memory] = await Promise.all([readWorkspace(env.DB, user.userId), readMemory(env.DB, user.userId)]);
    if (workspace.revision !== input.revision) return reply({ error: 'The saved workspace changed. Wait for it to finish saving or load the latest conversation before suggesting memory. Your notes are unchanged.' }, 409);
    const session = workspace.sessions.find(item => item.id === input.sessionId);
    if (!session) return reply({ error: 'Save this conversation to your account before suggesting memory.' }, 404);
    const saved = (await readSavedConnections(env.DB, user.userId)).connections;
    if (input.connection.key === savedKeyReference && !saved.find(item => item.provider === input.connection.provider)?.enabled) return reply({ error: 'The selected saved connection is disabled. Enable it in Connections or choose another model.' }, 409);
    // Redact every saved and included key, even disabled ones, before a provider sees source text.
    const included = workspaceAvailability(env);
    const keys: string[] = [];
    for (const provider of providers) {
      if (saved.find(item => item.provider === provider.id)?.saved) {
        try { keys.push(await resolveCredential(env.DB, env.TRIO_CREDENTIAL_KEY, request, user.userId, provider.id, savedKeyReference)); }
        catch { throw new CredentialError(`The saved ${provider.name} connection could not be read for secret redaction. Reload or replace it in Connections before suggesting memory, even if you selected a different model.`, 409); }
      }
      if (included[provider.id]) keys.push(await resolveRequestKey(env, request, user.userId, provider.id, workspaceKeyReference));
    }
    input.connection.key = await resolveRequestKey(env, request, user.userId, input.connection.provider, input.connection.key);
    keys.push(input.connection.key);
    request.signal.throwIfAborted();
    const suggestion = await suggestMemory(session, memory.notes, input.connection, keys, request.signal);
    return reply({ suggestion });
  } catch (error) {
    if (request.signal.aborted) return reply({ error: 'Suggestion stopped. A dispatched request may still be billed.' }, 499);
    if (error instanceof CredentialError || error instanceof MemorySuggestionError) return reply({ error: error.message }, error.status);
    return reply({ error: 'Saved conversations, memory or connections are unavailable. Nothing was saved; write memory manually or try again.' }, 503);
  }
}
