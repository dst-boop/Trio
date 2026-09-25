import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountReply as reply, readSmallJson } from '@/lib/account-api';
import { saveConnectionSchema, deleteConnectionSchema } from '@/lib/saved-connections';
import { CredentialError, readSavedConnections, saveCredential, deleteCredential } from '@/lib/credential-store';
import { workspaceAvailability } from '@/lib/workspace-keys';

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user || request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'Sign in again to load saved connections.' }, 401);
  try { if (!env.DB) throw new Error(); return reply({ ...(await readSavedConnections(env.DB, user.userId)), workspace: workspaceAvailability(env) }); }
  catch { return reply({ error: 'Saved connections could not be loaded. Retry before saving changes.' }, 503); }
}
async function mutate(request: Request, remove: boolean) {
  const user = await getChatGPTUser();
  if (!user || request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'Your account changed. Sign in again before saving connections.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid request origin.' }, 403);
  let input;
  try { input = (remove ? deleteConnectionSchema : saveConnectionSchema).parse(await readSmallJson(request)); }
  catch { return reply({ error: 'Enter a valid API key and model ID.' }, 400); }
  try {
    if (!env.DB) throw new Error();
    return reply({ connection: remove ? await deleteCredential(env.DB, user.userId, input) : await saveCredential(env.DB, env.TRIO_CREDENTIAL_KEY, user.userId, input) });
  } catch (error) { return reply({ error: error instanceof CredentialError ? error.message : 'Could not confirm your change. Reload saved connections before retrying.' }, error instanceof CredentialError ? error.status : 503); }
}
export const PUT = (request: Request) => mutate(request, false);
export const DELETE = (request: Request) => mutate(request, true);
