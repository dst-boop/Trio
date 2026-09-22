import { providers, type Mode, type Phase, type Result } from './trio.ts';

export type CoverageState = 'complete' | 'partial' | 'skipped' | 'unavailable' | 'sample';
export type CoverageStep = { phase: Phase; label: string; state: CoverageState; detail: string };
export const coverageStateNames: Record<CoverageState, string> = { complete: 'Completed', partial: 'Partial', skipped: 'Skipped', unavailable: 'Unavailable', sample: 'Sample' };
export const evidenceLimit = 'Model agreement and citations do not prove accuracy. Review the sources and unresolved disagreements before relying on important claims.';
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Derive coverage from a completed result, never current settings or streamed partial text. */
export function runCoverage(result: Result, mode: Mode): CoverageStep[] {
  const drafts = providers.filter(p => result.drafts[p.id]?.trim());
  const reviews = providers.filter(p => result.reviews[p.id]?.trim());
  const revisions = providers.filter(p => result.revisions?.[p.id]?.trim());
  const hasReviews = mode === 'council' || mode === 'deep';
  const coverage = (n: number): CoverageState => !n ? 'unavailable' : n < drafts.length ? 'partial' : 'complete';
  const sources = result.research?.sources.length ?? 0;
  const steps: CoverageStep[] = [
    { phase: 'research', label: 'Web research', state: sources ? 'complete' : result.researchRequested ? 'unavailable' : 'skipped', detail: sources ? `${count(sources, 'source')} in one shared research brief. Individual claims in the final answer have not been independently verified.` : result.researchRequested ? 'Research was requested, but no cited brief was returned. Current claims still need source verification.' : 'No web research was requested. The models did not browse for this answer.' },
    { phase: 'draft', label: 'Independent thinking', state: drafts.length ? 'complete' : 'unavailable', detail: drafts.length ? `${count(drafts.length, 'model draft')} returned: ${drafts.map(p => p.name).join(', ')}.${drafts.length === 1 ? ' No cross-model comparison was possible.' : ''}` : 'No model draft was returned.' },
    { phase: 'review', label: 'Peer review', state: reviews.length ? coverage(reviews.length) : !hasReviews || drafts.length < 2 ? 'skipped' : 'unavailable', detail: reviews.length ? `${reviews.length} of ${drafts.length} model reviews returned.${reviews.length < drafts.length ? ' Some reviews did not finish.' : ''} Reviews are model critiques, not external fact-checks.` : !hasReviews ? 'This mode does not include peer review.' : drafts.length < 2 ? 'Peer review needs at least two completed model drafts.' : 'No peer reviews returned. The answer was written without completed peer critique.' },
    { phase: 'revision', label: 'Revise answers', state: revisions.length ? coverage(revisions.length) : mode !== 'deep' || !reviews.length ? 'skipped' : 'unavailable', detail: revisions.length ? `${revisions.length} of ${drafts.length} revised answers returned. Original drafts remain available.` : mode !== 'deep' ? 'This mode does not include a revision round.' : !reviews.length ? 'Revisions were skipped because no peer reviews returned.' : 'No revised answers returned. The original drafts were used.' },
    { phase: 'synthesis', label: 'Write answer', state: result.fallback ? 'unavailable' : result.answer.trim() ? 'complete' : mode === 'compare' ? 'skipped' : 'unavailable', detail: result.fallback ? 'Synthesis did not complete. A single model’s draft or revision is shown as the fallback.' : mode === 'compare' ? 'Compare keeps the perspectives separate; no combined answer was requested.' : result.answer.trim() ? `${drafts.length > 1 ? 'The model combined the available contributions' : 'One model wrote the answer'}. This is not a guarantee of correctness.` : 'No final answer was returned.' },
  ];
  return result.demo ? steps.map(step => ({ ...step, state: 'sample', detail: 'Prepared example. No model APIs or live checks were used.' })) : steps;
}

export function answerLabel(result: Result): string {
  if (result.demo) return 'Sample answer';
  if (result.fallback) return 'Single-model fallback';
  if (!result.answer) return 'Independent perspectives';
  return providers.filter(p => result.drafts[p.id]?.trim()).length > 1 ? 'Combined answer' : 'Single-model answer';
}

export function coverageMarkdown(result: Result, mode: Mode): string {
  if (result.demo) return '';
  return '## Review and evidence\n\n' + runCoverage(result, mode).map(step => `- ${step.label} — ${coverageStateNames[step.state]}: ${step.detail}`).join('\n') + '\n\n' + evidenceLimit;
}
