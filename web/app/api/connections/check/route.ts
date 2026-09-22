import { getChatGPTUser } from '@/app/chatgpt-auth';
import { accountReply as reply, readSmallJson } from '@/lib/account-api';
import { checkConnection } from '@/lib/check-connection';

export async function POST(request: Request) {
  if (!await getChatGPTUser()) return reply({ status: 'signin' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ status: 'origin' }, 403);
  let input;
  try { input = await readSmallJson(request); } catch { return reply({ status: 'invalid' }, 400); }
  const status = await checkConnection(input, request.signal);
  return reply({ status }, status === 'checked' ? 200 : status === 'invalid' ? 400 : 502);
}
