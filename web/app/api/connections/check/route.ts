import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountReply as reply, readSmallJson } from '@/lib/account-api';
import { checkConnection } from '@/lib/check-connection';
import { env } from 'cloudflare:workers';
import { CredentialError, resolveCredential } from '@/lib/credential-store';
import { connectionCheckSchema } from '@/lib/connection-status';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return reply({ status: 'signin' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ status: 'origin' }, 403);
  let input;
  try { input = connectionCheckSchema.parse(await readSmallJson(request)); } catch { return reply({ status: 'invalid' }, 400); }
  try { input.key = await resolveCredential(env.DB, env.TRIO_CREDENTIAL_KEY, request, user.userId, input.provider, input.key); }
  catch (error) { return reply({ status: 'saved', error: error instanceof CredentialError ? error.message : 'Saved key unavailable.' }, error instanceof CredentialError ? error.status : 503); }
  const status = await checkConnection(input, request.signal);
  return reply({ status }, status === 'checked' ? 200 : status === 'invalid' ? 400 : 502);
}
