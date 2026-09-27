import { z } from 'zod';

const errorEnvelope = z.object({ error: z.string().trim().min(1).max(2000) });

/** Gateways can return HTML or empty bodies; never expose JSON parser diagnostics. */
export async function readWorkspaceResponse(response: Response, operation: 'load' | 'save'): Promise<unknown> {
  const fallback = operation === 'save'
    ? 'Your save was not confirmed. Retry saving, or download a backup before closing this tab.'
    : 'Your saved workspace is temporarily unavailable. Please retry loading.';
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new Error(response.status === 409 ? 'Another tab or device saved newer changes. Download your backup before loading the latest workspace.' : fallback); }
  if (!response.ok) throw new Error(errorEnvelope.safeParse(data).data?.error ?? (response.status === 409
    ? 'Another tab or device saved newer changes. Download your backup before loading the latest workspace.' : fallback));
  return data;
}
