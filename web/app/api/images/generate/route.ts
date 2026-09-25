import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountReply as reply } from '@/lib/account-api';
import { JsonBodyError, readJsonBody } from '@/lib/request-json';
import { imageGenerationSchema } from '@/lib/image-generation';
import { generateImage } from '@/lib/generate-image';
import { env } from 'cloudflare:workers';
import { CredentialError } from '@/lib/credential-store';
import { resolveRequestKey } from '@/lib/workspace-keys';

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user || request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'Sign in again to create images.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid request origin.' }, 403);
  let input;
  try { input = imageGenerationSchema.safeParse(await readJsonBody(request)); }
  catch (error) { return reply({ error: error instanceof JsonBodyError ? error.message : 'Could not read the image request.' }, error instanceof JsonBodyError ? error.status : 400); }
  if (!input.success) return reply({ error: 'Enter a description under 4,000 characters, valid image settings, and your OpenAI API key.' }, 400);
  try { input.data.key = await resolveRequestKey(env, request, user.userId, 'openai', input.data.key); }
  catch (error) { return reply({ error: error instanceof CredentialError ? error.message : 'Saved key unavailable.' }, error instanceof CredentialError ? error.status : 503); }
  try { return reply({ image: await generateImage(input.data, request.signal) }); }
  catch (error) { return reply({ error: error instanceof Error ? error.message : 'Image generation failed.' }, 502); }
}
