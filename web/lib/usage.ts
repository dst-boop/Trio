import type { ProviderId, ProviderUsage, Usage } from './trio.ts';

export type Tokens = { input: number; output: number; cached: number };
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Missing metadata remains unknown, never a zero-token bill. */
export function readUsage(id: ProviderId, data: any): Tokens | null {
  const u = data?.usage;
  if (!u) return null;
  const input = id === 'gemini' ? u.total_input_tokens : u.input_tokens;
  const output = id === 'gemini' ? u.total_output_tokens : u.output_tokens;
  const thought = id === 'gemini' ? (u.total_thought_tokens ?? 0) : 0;
  const cacheRead = id === 'openai' ? (u.input_tokens_details?.cached_tokens ?? 0) : id === 'claude' ? (u.cache_read_input_tokens ?? 0) : (u.total_cached_tokens ?? 0);
  const cacheWrite = id === 'claude' ? (u.cache_creation_input_tokens ?? 0) : 0;
  if (![input, output, thought, cacheRead, cacheWrite].every(count)) return null;
  const tokens = { input: input + (id === 'claude' ? cacheRead + cacheWrite : 0), output: output + thought, cached: cacheRead + cacheWrite };
  return Object.values(tokens).every(count) ? tokens : null;
}

// Standard USD / million tokens, verified 2026-09-22. Cached and negotiated rates
// are deliberately not estimated. Expire the table before Gemini's intro ends.
// Sources: developers.openai.com/api/docs/models/gpt-6-astra,
// platform.claude.com/docs/en/about-claude/pricing, ai.google.dev/gemini-api/docs/pricing.
const rates: Record<string, [number, number]> = { 'gpt-6-astra': [10, 50], 'claude-sonnet-5': [2, 10], 'claude-opus-5': [5, 25], 'gemini-3.8-flash': [.75, 3.75] };
export function estimateStandardCost(model: string, tokens: Tokens, now = Date.now()): number | null {
  const rate = rates[model];
  if (!rate || tokens.cached || now >= Date.parse('2027-01-01T00:00:00Z')) return null;
  return (tokens.input * rate[0] + tokens.output * rate[1]) / 1_000_000;
}

export function summarizeUsage(byProvider: Partial<Record<ProviderId, ProviderUsage>>): Usage {
  const snapshot = structuredClone(byProvider);
  for (const entry of Object.values(snapshot)) if (entry.calls !== entry.reportedCalls) entry.costUSD = null;
  const entries = Object.values(snapshot);
  const sum = (field: 'calls' | 'reportedCalls' | 'inputTokens' | 'outputTokens') => entries.reduce((total, value) => total + value[field], 0);
  const calls = sum('calls'), reportedCalls = sum('reportedCalls');
  return { calls, reportedCalls, inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    costUSD: calls > 0 && calls === reportedCalls && entries.every(value => value.costUSD !== null) ? entries.reduce((total, value) => total + value.costUSD!, 0) : null,
    byProvider: snapshot };
}
