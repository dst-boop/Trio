import { z } from 'zod';
import type { Connections } from './trio.ts';

export type ResearchProvider = 'openai' | 'claude';
export type ResearchChoice = ResearchProvider | 'auto';
export const researchProviderName = (provider?: ResearchProvider) => provider === 'claude' ? 'Claude' : 'OpenAI';
export function selectResearchProvider(connections: Connections, choice: ResearchChoice = 'auto'): ResearchProvider {
  const ready = (id: ResearchProvider) => connections[id]?.enabled && connections[id]?.key.trim();
  if (choice !== 'auto' && ready(choice)) return choice;
  if (choice === 'auto') { if (ready('openai')) return 'openai'; if (ready('claude')) return 'claude'; }
  throw new Error(choice === 'auto' ? 'Web research requires an enabled OpenAI or Claude API connection.' : `Web research requires an enabled ${researchProviderName(choice)} API connection.`);
}

/** Paused content is request-local and is sent back only to Anthropic, unchanged. */
export class ResearchPaused extends Error {
  content: unknown[];
  constructor(content: unknown[]) { super('Claude research paused before completing. Try a narrower question.'); this.name = 'ResearchPaused'; this.content = content; }
}

/** Only provider citation metadata becomes a source; never scrape URLs from prose. */
export function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\s<>\u0000-\u001f\u007f]/.test(value)) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048 ? url.href : null; } catch { return null; }
}
export const sourceSchema = z.object({ url: z.string().max(2048).refine(v => safeSourceUrl(v) !== null), title: z.string().max(300) });
export const researchSchema = z.object({ text: z.string().max(120000), sources: z.array(sourceSchema).max(60), at: z.string().max(40), provider: z.enum(['openai', 'claude']).optional() });
export type Research = z.infer<typeof researchSchema>;

/** Provider JSON is untrusted: blocks may be missing, malformed or non-objects. */
type Block = { type?: unknown; status?: unknown; text?: unknown; content?: unknown; citations?: unknown } | null | undefined;
type Citation = { type?: unknown; url?: unknown; title?: unknown; end_index?: unknown } | null | undefined;
type CitedText = { text: string; annotations?: unknown };
const blocks = <T = Block>(value: unknown): T[] => Array.isArray(value) ? value : [];

export function readResearch(data: unknown, provider: ResearchProvider = 'openai'): Research {
  const response = data as { output?: unknown; content?: unknown } | null | undefined;
  const output = blocks(response?.output);
  const content = blocks(response?.content);
  const searched = provider === 'openai' ? output.some(item => item?.type === 'web_search_call' && item.status === 'completed') : content.some(item => item?.type === 'web_search_tool_result' && blocks(item.content).some(result => result?.type === 'web_search_result'));
  if (!searched) throw new Error('Web research did not return a completed search.');
  const sources: Research['sources'] = [];
  const isText = (type: string) => (part: Block): part is Block & { text: string } => part?.type === type && typeof part.text === 'string';
  const parts: CitedText[] = provider === 'openai' ? output.flatMap(item => blocks(item?.content)).filter(isText('output_text')) : content.filter(isText('text')).map(part => ({ text: part.text, annotations: blocks<Citation>(part.citations).filter(citation => citation?.type === 'web_search_result_location').map(citation => ({ ...citation, type: 'url_citation', end_index: part.text.length })) }));
  const text = parts.map(part => {
    const inserts = new Map<number, number[]>();
    for (const citation of blocks<Citation>(part.annotations)) {
      if (citation?.type !== 'url_citation') continue;
      const url = safeSourceUrl(citation.url);
      if (!url) continue;
      let index = sources.findIndex(source => source.url === url);
      if (index < 0) {
        if (sources.length >= 60) continue;
        index = sources.length;
        sources.push({ url, title: typeof citation.title === 'string' ? citation.title.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 300) : new URL(url).hostname });
      }
      // Append links without deleting underlying claims. Unusable offsets go at the end.
      let end = typeof citation.end_index === 'number' && Number.isInteger(citation.end_index) && citation.end_index >= 0 && citation.end_index <= part.text.length ? citation.end_index : part.text.length;
      for (const marker of part.text.matchAll(/\uE200[^\uE201]*\uE201/g)) if (end > marker.index && end < marker.index + marker[0].length) end = marker.index + marker[0].length;
      inserts.set(end, [...new Set([...(inserts.get(end) ?? []), index])]);
    }
    let text = part.text;
    for (const [end, indices] of [...inserts].sort((a, b) => b[0] - a[0])) text = text.slice(0, end) + indices.map(index => ` [${index + 1}](<${sources[index].url}>)`).join('') + text.slice(end);
    return text.replace(/\uE200[^\uE201]*\uE201/g, '');
  }).join('\n\n').trim();
  if (!text || text.length > 120000 || !sources.length) throw new Error('Web research did not return a usable cited brief.');
  return { text, sources, at: new Date().toISOString(), provider };
}
