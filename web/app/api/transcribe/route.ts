import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountReply as reply } from '@/lib/account-api';
import { JsonBodyError, readJsonBody } from '@/lib/request-json';
import { transcriptionSchema } from '@/lib/audio';
import { transcribeAudio } from '@/lib/transcribe';
import { env } from 'cloudflare:workers';
import { CredentialError } from '@/lib/credential-store';
import { resolveRequestKey } from '@/lib/workspace-keys';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user || request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'Sign in again to transcribe audio.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid request origin.' }, 403);
  let input;
  try { input = transcriptionSchema.safeParse(await readJsonBody(request, 6_000_000)); }
  catch (error) { return reply({ error: error instanceof JsonBodyError ? error.message : 'Could not read the recording.' }, error instanceof JsonBodyError ? error.status : 400); }
  if (!input.success) return reply({ error: 'Choose a supported recording under 4 MB and add your OpenAI API key.' }, 400);
  try { input.data.key = await resolveRequestKey(env, request, user.userId, 'openai', input.data.key); }
  catch (error) { return reply({ error: error instanceof CredentialError ? error.message : 'Saved key unavailable.' }, error instanceof CredentialError ? error.status : 503); }
  try { return reply({ transcript: await transcribeAudio(input.data, request.signal) }); }
  catch (error) { return reply({ error: error instanceof Error ? error.message : 'Transcription failed. Try again.' }, 502); }
}
