import type { Result, RunEvent } from './trio.ts';

/** Partial text is display-only. Only a final event may be saved as a turn. */
export function applyRunEvent(result: Result, event: RunEvent): Result {
  if (event.type === 'final' && event.result) return event.result;
  if (event.type === 'error' && event.text) return { ...result, errors: [...result.errors, event.text] };
  if (event.type === 'usage' && event.usage) return { ...result, usage: event.usage };
  if (event.type === 'stage' && event.stage === 'research') return { ...result, researchRequested: true };
  if (event.type === 'research' && event.research) return { ...result, researchRequested: true, research: event.research };
  if (event.phase === 'research') return event.type === 'contribution_start' ? { ...result, researchRequested: true, research: undefined } : result;
  if (!event.provider) return result;
  if (event.type === 'draft' || event.type === 'review' || event.type === 'revision') {
    const bucket = event.type === 'draft' ? 'drafts' : event.type === 'review' ? 'reviews' : 'revisions';
    return { ...result, [bucket]: { ...result[bucket], [event.provider]: event.text ?? '' } };
  }
  if ((event.type === 'contribution_start' || event.type === 'contribution_delta') && event.phase) {
    const reset = event.type === 'contribution_start';
    if (event.phase === 'synthesis') return { ...result, by: event.provider, answer: reset ? '' : result.answer + (event.text ?? '') };
    const bucket = event.phase === 'draft' ? 'drafts' : event.phase === 'review' ? 'reviews' : 'revisions';
    const answers = { ...result[bucket] };
    if (reset) delete answers[event.provider];
    else answers[event.provider] = (answers[event.provider] ?? '') + (event.text ?? '');
    return { ...result, [bucket]: answers };
  }
  return result;
}
