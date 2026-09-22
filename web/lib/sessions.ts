import { z } from 'zod';
import { researchSchema } from './research.ts';
import { providers, type Mode, type Result } from './trio.ts';

export type Turn = { question: string; result: Result; mode: Mode; imageName?: string };
export type Session = { id: string; title: string; turns: Turn[]; time: string };
const provider = z.enum(['openai', 'claude', 'gemini']);
const answers = z.object({ openai: z.string().max(120000).optional(), claude: z.string().max(120000).optional(), gemini: z.string().max(120000).optional() });
const nonnegative = z.number().finite().nonnegative();
const usageCounts = { calls: nonnegative.int(), reportedCalls: nonnegative.int(), inputTokens: nonnegative.int(), outputTokens: nonnegative.int(), costUSD: nonnegative.nullable() };
const providerUsage = z.object({ ...usageCounts, model: z.string().max(100) });
const usage = z.object({ ...usageCounts, byProvider: z.object({ openai: providerUsage.optional(), claude: providerUsage.optional(), gemini: providerUsage.optional() }) });
const result = z.object({ researchRequested: z.boolean().optional(), research: researchSchema.optional(), drafts: answers, reviews: answers, revisions: answers.optional(), answer: z.string().max(120000), by: provider.optional(), errors: z.array(z.string().max(4000)).max(30), seconds: nonnegative, demo: z.boolean(), fallback: z.boolean().optional(), usage: usage.optional() });
const session = z.object({ id: z.string().min(1).max(100), title: z.string().max(20000), time: z.string().max(100), turns: z.array(z.object({ question: z.string().min(1).max(20000), mode: z.enum(['council', 'deep', 'fast', 'compare']), imageName: z.string().max(255).optional(), result })).min(1) });
const maxStoredCharacters = 5_000_000;

/** Only write snapshots the reader can restore. Never truncate model contributions. */
export function serializeSessions(sessions: Session[]): string {
  const snapshot = JSON.stringify(z.array(session).max(30).parse(sessions));
  if (snapshot.length > maxStoredCharacters) throw new Error('Session history exceeds browser storage limits.');
  return snapshot;
}

/** Restore only well-formed records; strip unknown fields, including injected credentials. */
export function parseSessions(raw: string | null): Session[] {
  if (!raw || raw.length > maxStoredCharacters) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  return value.slice(0, 30).flatMap(item => {
    const parsed = session.safeParse(item);
    if (!parsed.success || unique.has(parsed.data.id)) return [];
    unique.add(parsed.data.id); return [parsed.data];
  });
}

/** Complete user/assistant pairs only; comparisons retain all model perspectives. */
export function conversationHistory(turns: Turn[]): { role: 'user' | 'assistant'; content: string }[] {
  return turns.filter(t => !t.result.demo).slice(-6).flatMap(t => {
    const answer = t.result.answer || providers.filter(p => t.result.drafts[p.id]).map(p => `${p.name}:\n${t.result.drafts[p.id]}`).join('\n\n');
    const question = t.question + (t.imageName ? '\n[An image was attached to this earlier question. Its bytes are not part of the text history. Ask for it again if needed; do not assume a current image is the same one.]' : '');
    return answer ? [{ role: 'user' as const, content: question }, { role: 'assistant' as const, content: answer.slice(0, 30000) }] : [];
  });
}

export function sessionMarkdown(turns: Turn[]): string {
  return turns.map(t => [
    `# ${t.question}`,
    t.imageName ? '> An image was attached to this question. Image data is not included in this export; reattach the original to revisit visual details.' : '',
    t.result.researchRequested ? '> Web research requested via OpenAI. Search charges are excluded from cost estimates.' : '',
    t.result.research ? `## Shared web research\n\nResearched: ${t.result.research.at}\n\n${t.result.research.text}\n\n### Sources cited in the research brief\n\n${t.result.research.sources.map((s, i) => `${i + 1}. <${s.url}>`).join('\n')}` : t.result.researchRequested ? '> No cited research brief was available. This answer still needs current-source verification.' : '',
    t.result.demo ? '> Illustrative demo — no live models were called.' : '',
    `Mode: ${t.mode} · ${t.result.seconds}s`,
    t.result.usage ? `Reported usage: ${t.result.usage.inputTokens} input + ${t.result.usage.outputTokens} output tokens across ${t.result.usage.reportedCalls}/${t.result.usage.calls} calls. Standard-rate cost estimate: ${t.result.usage.costUSD === null ? 'unavailable' : '$' + t.result.usage.costUSD.toFixed(4)} (excludes discounts and taxes).` : '',
    t.result.fallback ? '> Synthesis failed. This is a single-model fallback answer.' : '',
    t.result.answer ? `## ${t.result.fallback ? 'Fallback answer' : 'Combined answer'}\n\n${t.result.answer}` : '',
    ...providers.filter(p => t.result.drafts[p.id]).map(p => `## ${p.name} draft\n\n${t.result.drafts[p.id]}`),
    ...providers.filter(p => t.result.reviews[p.id]).map(p => `## ${p.name} review\n\n${t.result.reviews[p.id]}`),
    ...providers.filter(p => t.result.revisions?.[p.id]).map(p => `## ${p.name} revised answer\n\n${t.result.revisions![p.id]}`),
    t.result.errors.length ? `## Run notes\n\n${t.result.errors.map(e => `- ${e}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')).join('\n\n---\n\n');
}
