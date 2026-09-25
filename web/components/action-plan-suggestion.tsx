'use client';
import { useEffect, useRef, useState } from 'react';
import { planSuggestionResponseSchema, type PlanSuggestionResponse, type SuggestedActions } from '@/lib/action-plan-suggestions';
import { providers, type Connections, type ProviderId } from '@/lib/trio';
import { UsageSummary } from '@/components/usage-summary';
import { z } from 'zod';

export type PlanDraftContext = {
  accountId: string;
  sessionId: string;
  turnIndex: number;
  revision: number;
  ready: boolean;
  live: boolean;
  connections: Connections;
  preferred: ProviderId;
};
export function ActionPlanSuggestion({ context, busy, onUse, onPending, onPreview }: { context: PlanDraftContext; busy: boolean; onUse: (suggestion: SuggestedActions) => void; onPending: (pending: boolean) => void; onPreview: (available: boolean) => void }) {
  const [chosen, setChosen] = useState<ProviderId>(context.preferred);
  const available = providers.filter(provider => context.connections[provider.id].enabled && context.connections[provider.id].key.trim());
  const provider = available.find(item => item.id === chosen)?.id ?? available.find(item => item.id === context.preferred)?.id ?? available[0]?.id;
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const [proposal, setProposal] = useState<PlanSuggestionResponse | null>(null), [applied, setApplied] = useState(false);
  const version = useRef(0), active = useRef(false), controller = useRef<AbortController | null>(null);
  const callbacks = useRef({ onPending, onPreview }); callbacks.current = { onPending, onPreview };
  useEffect(() => {
    version.current++; controller.current?.abort(); active.current = false;
    setPending(false); setProposal(null); setError(''); setApplied(false);
    callbacks.current.onPending(false); callbacks.current.onPreview(false);
    return () => { version.current++; controller.current?.abort(); active.current = false; callbacks.current.onPending(false); callbacks.current.onPreview(false); };
  }, [context.accountId, context.sessionId, context.turnIndex]);
  function stop() {
    version.current++; controller.current?.abort(); active.current = false; setPending(false); onPending(false);
    setError('Drafting stopped. An already dispatched request may still be billed. Your manual draft is unchanged.');
  }
  async function generate() {
    if (active.current || busy || !context.ready || !context.live || !provider) return;
    const requestVersion = ++version.current, abort = new AbortController(); controller.current = abort;
    active.current = true; setPending(true); onPending(true); setError(''); setProposal(null); setApplied(false); onPreview(false);
    const source = { accountId: context.accountId, sessionId: context.sessionId, turnIndex: context.turnIndex, revision: context.revision };
    const connection = context.connections[provider];
    try {
      const response = await fetch('/api/work-plan/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trio-Account': source.accountId }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(110_000)]), body: JSON.stringify({ sessionId: source.sessionId, turnIndex: source.turnIndex, revision: source.revision, connection: { provider, key: connection.key, model: connection.model } }) });
      const data = await response.json().catch(() => null);
      if (requestVersion !== version.current) return;
      if (!response.ok) throw new Error(z.object({ error: z.string().max(500) }).safeParse(data).data?.error ?? 'Could not prepare an action plan. Nothing was saved.');
      const parsed = planSuggestionResponseSchema.parse(data);
      if (parsed.accountId !== source.accountId || parsed.sessionId !== source.sessionId || parsed.turnIndex !== source.turnIndex || parsed.revision !== source.revision || parsed.provider !== provider || parsed.model !== connection.model) throw new Error('The answer or account changed. Close this editor and reopen the saved answer before drafting actions.');
      setProposal(parsed); onPreview(true);
    } catch (error) {
      if (requestVersion === version.current) setError(error instanceof DOMException && error.name === 'TimeoutError' ? 'Drafting timed out. A dispatched request may still be billed. Nothing was saved.' : error instanceof Error && !(error instanceof z.ZodError) ? error.message : 'The model returned an unusable plan. Nothing was saved.');
    } finally {
      if (requestVersion === version.current) { active.current = false; setPending(false); onPending(false); }
    }
  }
  return <section className="plan-suggestion" aria-label="Draft actions from this answer">
    <h3>Let Trio prepare a checklist</h3>
    <p>Send this saved question and completed answer to one connected model. Review the proposed actions before using them. Add your planning dates in the editor.</p>
    <small>One additional API call, billed by that provider. Long text may be shortened. Original files, earlier messages, personal memory and web search are not included.</small>
    <div className="plan-suggestion-controls"><label>Model for action draft<select aria-label="Model for action draft" value={provider ?? ''} disabled={pending || busy || !available.length} onChange={event => setChosen(event.target.value as ProviderId)}>{!available.length && <option value="">Connect a model first</option>}{available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="button" className="subtle-button" disabled={pending || busy || !context.ready || !context.live || !provider} onClick={() => void generate()}>{proposal ? 'Draft again · 1 API call' : 'Draft actions · 1 API call'}</button>{pending && <button type="button" className="subtle-button" onClick={stop}>Stop drafting</button>}</div>
    {!context.live && <p className="muted">Live mode is required to ask a model. You can still build the checklist manually.</p>}
    {!context.ready && <p className="muted">Wait for this conversation to finish saving. Resolve any workspace save error before drafting actions.</p>}
    {!provider && <p className="muted">Add or enable a model in Connections to use drafting.</p>}
    {pending && <p role="status">Preparing a proposed checklist… Nothing will be saved automatically.</p>}
    {error && <p role="alert">{error}</p>}
    {proposal && <div className="plan-suggestion-preview"><h4>Proposed checklist · review required</h4><p><strong>{proposal.suggestion.goal}</strong></p>{proposal.suggestion.actions.length ? <ol>{proposal.suggestion.actions.map((action, index) => <li key={index}>{action}</li>)}</ol> : <p>No concrete next actions were identified. Add only the actions you need manually.</p>}{proposal.shortened && <p className="muted">The source was shortened. Check the original answer for omitted conditions or steps.</p>}<p className="muted">Check each action against the answer. Using these actions replaces the goal and checklist in this unsaved editor. It does not save a plan or mark anything done.</p><button type="button" className="subtle-button" disabled={busy || applied || !proposal.suggestion.actions.length} onClick={() => { onUse(proposal.suggestion); setApplied(true); onPreview(false); }}>{applied ? 'Added to your editor' : 'Use these actions'}</button><UsageSummary usage={proposal.usage} /><small>This additional drafting usage is shown here; it is not added to the original answer&apos;s usage. Providers may bill failed or stopped requests too.</small></div>}
  </section>;
}
