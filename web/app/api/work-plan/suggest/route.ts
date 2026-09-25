import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountReply as reply } from '@/lib/account-api';
import { readJsonBody, JsonBodyError } from '@/lib/request-json';
import { readWorkspace } from '@/lib/account-store';
import { CredentialError, readSavedConnections, resolveCredential } from '@/lib/credential-store';
import { resolveRequestKey, workspaceAvailability } from '@/lib/workspace-keys';
import { savedKeyReference, workspaceKeyReference } from '@/lib/saved-connections';
import { providers } from '@/lib/trio';
import { actionPlanSource, planSuggestionRequestSchema, suggestActionPlan, PlanSuggestionError } from '@/lib/action-plan-suggestions';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user || request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'Your account changed. Reload Trio before drafting an action plan.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid request origin.' }, 403);
  let input;
  try { input = planSuggestionRequestSchema.parse(await readJsonBody(request, 4096)); }
  catch (error) { return reply({ error: 'Choose a saved answer and a connected model.' }, error instanceof JsonBodyError ? error.status : 400); }
  try {
    if (!env.DB) throw new Error();
    const workspace = await readWorkspace(env.DB, user.userId);
    if (workspace.revision !== input.revision) return reply({ error: 'The saved workspace changed. Finish saving or load the latest workspace before drafting actions. Your manual plan draft is still here.' }, 409);
    const turn = workspace.sessions.find(session => session.id === input.sessionId)?.turns[input.turnIndex];
    if (!turn) return reply({ error: 'Save this completed answer to your account before drafting actions.' }, 404);
    actionPlanSource(turn);
    // Redact every saved and included key, even disabled keys, without sending
    // them to any provider. Only the explicitly selected connection is used.
    const saved = (await readSavedConnections(env.DB, user.userId)).connections;
    if (input.connection.key === savedKeyReference && !saved.find(item => item.provider === input.connection.provider)?.enabled) return reply({ error: 'The selected saved connection is disabled. Enable it in Connections or choose another model.' }, 409);
    const included = workspaceAvailability(env);
    const keys: string[] = [];
    for (const provider of providers) {
      if (saved.find(item => item.provider === provider.id)?.saved) {
        try { keys.push(await resolveCredential(env.DB, env.TRIO_CREDENTIAL_KEY, request, user.userId, provider.id, savedKeyReference)); }
        catch { throw new CredentialError(`The saved ${provider.name} connection could not be read for secret redaction. Reload or replace it in Connections before drafting, even if you selected a different model.`, 409); }
      }
      if (included[provider.id]) keys.push(await resolveRequestKey(env, request, user.userId, provider.id, workspaceKeyReference));
    }
    input.connection.key = await resolveRequestKey(env, request, user.userId, input.connection.provider, input.connection.key);
    keys.push(input.connection.key);
    request.signal.throwIfAborted();
    const result = await suggestActionPlan(turn, input.connection, keys, request.signal);
    return reply({ accountId: user.userId, sessionId: input.sessionId, turnIndex: input.turnIndex, revision: input.revision, ...result });
  } catch (error) {
    if (request.signal.aborted) return reply({ error: 'Drafting stopped. A dispatched request may still be billed.' }, 499);
    if (error instanceof CredentialError || error instanceof PlanSuggestionError) return reply({ error: error.message }, error.status);
    return reply({ error: 'The saved answer or connections are unavailable. Nothing was saved; add actions manually or try again.' }, 503);
  }
}
