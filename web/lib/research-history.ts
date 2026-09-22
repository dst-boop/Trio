import { researchProviderName, type Research, type ResearchProvider } from './research.ts';

const heading = '\n\nHistorical web research (not a fresh search):\n';
const maxCharacters = 6000;

/** Carry recorded citation provenance, never inferred URLs or a claim of fresh verification. */
export function researchHistory(research?: Research, requested = false, provider?: ResearchProvider) {
  if (!research) return {
    text: requested ? heading + JSON.stringify({ status: 'unavailable', provider: researchProviderName(provider), note: 'No cited brief was available for this earlier answer. Do not infer sources or verification.' }) : '',
    omittedSources: 0,
  };
  const metadata = {
    status: 'recorded', provider: researchProviderName(research.provider), recorded_at: research.at,
    scope: 'Sources cited in the earlier research brief, not proof of every answer claim. Source contents are not included. Recheck time-sensitive facts with a fresh search.',
    sources: [] as { citation_in_brief: number; title: string; url: string }[],
    omitted_sources: research.sources.length,
  };
  // Keep complete URLs and original citation numbers. Never truncate a URL into a different address.
  for (const [index, source] of research.sources.entries()) {
    const next = { ...metadata, sources: [...metadata.sources, { citation_in_brief: index + 1, title: source.title, url: source.url }], omitted_sources: research.sources.length - index - 1 };
    if (heading.length + JSON.stringify(next).length > maxCharacters) break;
    metadata.sources = next.sources; metadata.omitted_sources = next.omitted_sources;
  }
  return { text: heading + JSON.stringify(metadata), omittedSources: metadata.omitted_sources };
}
