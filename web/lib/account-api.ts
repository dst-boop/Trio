import { readJsonBody } from './request-json.ts';
export const accountReply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
export async function readSmallJson(request: Request): Promise<unknown> {
  return readJsonBody(request);
}
