import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountReply as reply, readSmallJson } from '@/lib/account-api';
import { memoryProfileSchema } from '@/lib/memory';
import { readMemory, writeMemory } from '@/lib/memory-store';
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user || request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'Sign in again to load personal memory.' }, 401);
  try { if (!env.DB) throw new Error(); return reply(await readMemory(env.DB, user.userId)); }
  catch { return reply({ error: 'Could not load personal memory. Retry before using it.' }, 503); }
}
export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user || request.headers.get('x-trio-account') !== user.userId) return reply({ error: 'Your account changed. Reload before saving memory.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid request origin.' }, 403);
  let input; try { input = memoryProfileSchema.parse(await readSmallJson(request)); } catch { return reply({ error: 'Memory must be valid text of up to 4,000 characters.' }, 400); }
  try { if (!env.DB) throw new Error(); if (!await writeMemory(env.DB, user.userId, input)) return reply({ error: 'Memory changed on another device. Copy your edits, then reload the latest memory.' }, 409); return reply({ ...input, revision: input.revision + 1 }); }
  catch { return reply({ error: 'Memory was not confirmed saved. Keep your edits and retry.' }, 503); }
}
