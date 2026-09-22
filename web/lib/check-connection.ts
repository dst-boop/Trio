import { connectionCheckSchema, type ConnectionStatus } from './connection-status.ts';
import { readProviderJson } from './provider-response.ts';

/** Read metadata only: no generation, prompt, attachment, or other provider's credentials. */
export async function checkConnection(input: unknown, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ConnectionStatus> {
  const parsed = connectionCheckSchema.safeParse(input);
  if (!parsed.success) return 'invalid';
  const { provider, key, model } = parsed.data;
  const endpoints = { openai: 'https://api.openai.com/v1/models/', claude: 'https://api.anthropic.com/v1/models/', gemini: 'https://generativelanguage.googleapis.com/v1beta/models/' };
  const headers: Record<string, string> = provider === 'openai' ? { Authorization: `Bearer ${key}` } : provider === 'claude' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'x-goog-api-key': key };
  const timeout = AbortSignal.timeout(15_000);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    combined.throwIfAborted();
    // Workers requires manual redirect handling; the non-2xx branch rejects it
    // without forwarding the API key to another destination.
    const response = await fetcher(endpoints[provider] + encodeURIComponent(model), { method: 'GET', headers, signal: combined, redirect: 'manual', cache: 'no-store' });
    if (!response.ok) {
      // Vendor diagnostics can contain credentials. Never read or forward them.
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) return 'credentials';
      if (response.status === 404) return 'model';
      if (response.status === 429) return 'limited';
      return response.status >= 500 ? 'unavailable' : 'rejected';
    }
    try {
      const data = await readProviderJson(response, combined);
      const recognized = provider === 'gemini' ? typeof data.name === 'string' && /^models\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(data.name) : typeof data.id === 'string' && data.id.length > 0 && (provider === 'openai' ? data.object : data.type) === 'model';
      return recognized ? 'checked' : 'unreadable';
    } catch {
      combined.throwIfAborted();
      return 'unreadable';
    }
  } catch {
    if (signal.aborted) return 'cancelled';
    if (timeout.aborted) return 'timeout';
    return 'network';
  }
}
