import { z } from 'zod';

/** Only provider citation metadata becomes a source; never scrape URLs from prose. */
export function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\s<>\u0000-\u001f\u007f]/.test(value)) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048 ? url.href : null; } catch { return null; }
}
export const sourceSchema = z.object({ url: z.string().max(2048).refine(v => safeSourceUrl(v) !== null), title: z.string().max(300) });
export const researchSchema = z.object({ text: z.string().max(120000), sources: z.array(sourceSchema).max(60), at: z.string().max(40) });
export type Research = z.infer<typeof researchSchema>;

export function readResearch(data: any): Research {
  const output = Array.isArray(data?.output) ? data.output : [];
  if (!output.some((item: any) => item.type === 'web_search_call' && item.status === 'completed')) throw new Error('Web research did not return a completed search.');
  const sources: Research['sources'] = [];
  const parts = output.flatMap((item: any) => Array.isArray(item.content) ? item.content : []).filter((part: any) => part.type === 'output_text' && typeof part.text === 'string');
  const text = parts.map((part: any) => {
    const inserts = new Map<number, number[]>();
    for (const citation of Array.isArray(part.annotations) ? part.annotations : []) {
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
      let end = Number.isInteger(citation.end_index) && citation.end_index >= 0 && citation.end_index <= part.text.length ? citation.end_index : part.text.length;
      for (const marker of part.text.matchAll(/\uE200[^\uE201]*\uE201/g)) if (end > marker.index && end < marker.index + marker[0].length) end = marker.index + marker[0].length;
      inserts.set(end, [...new Set([...(inserts.get(end) ?? []), index])]);
    }
    let text = part.text;
    for (const [end, indices] of [...inserts].sort((a, b) => b[0] - a[0])) text = text.slice(0, end) + indices.map(index => ` [${index + 1}](<${sources[index].url}>)`).join('') + text.slice(end);
    return text.replace(/\uE200[^\uE201]*\uE201/g, '');
  }).join('\n\n').trim();
  if (!text || text.length > 120000 || !sources.length) throw new Error('Web research did not return a usable cited brief.');
  return { text, sources, at: new Date().toISOString() };
}
