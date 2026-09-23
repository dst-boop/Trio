import { orchestrate } from '../lib/orchestrate.ts';
import { providers, type Connections, type Mode, type ProviderId, type Result, type Usage } from '../lib/trio.ts';
import { qualityCases, scoreAnswer, type QualityCase, type Verdict } from './cases.ts';
import { compareOutcomes } from './comparison.ts';

export type EvaluationOptions = { mode: 'fast' | 'council' | 'deep'; baseline?: ProviderId; maxCalls: number; timeoutSeconds: number; includeAnswers?: boolean; cases?: QualityCase[] };
type PhaseReport = { state: 'not_run' | 'completed' | 'failed'; degraded: boolean; httpCalls: number; elapsedMs: number | null; providerElapsedMs: Partial<Record<ProviderId, number>>; usage?: Usage; notes: string[] };
type CaseReport = { id: string; category: string; question: string; context?: string; expected: string | number; baseline: Partial<Record<ProviderId, Verdict>>; team: Verdict; baselineRun: PhaseReport; teamRun: PhaseReport; answers?: { baseline: Partial<Record<ProviderId, string>>; team?: string } };
const emptyPhase = (): PhaseReport => ({ state: 'not_run', degraded: false, httpCalls: 0, elapsedMs: null, providerElapsedMs: {}, notes: [] });

/** Defense in depth for report strings, including misconfigured model IDs and provider text. */
export function redactReport<T>(value: T, connections: Connections): T {
  const secrets = Object.values(connections).map(c => c.key).filter(Boolean).sort((a, b) => b.length - a.length);
  const clean = (item: unknown): unknown => {
    if (typeof item === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), item);
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, clean(entry)]));
    return item;
  };
  return clean(value) as T;
}

/** No automatic re-run of cases. The existing provider retries count against one shared HTTP-call limit. */
export async function evaluateQuality(connections: Connections, options: EvaluationOptions, external: AbortSignal, fetcher: typeof fetch = fetch) {
  const active = providers.filter(p => connections[p.id].enabled);
  if (!active.length || active.some(p => !connections[p.id].key.trim())) throw new Error('Every selected provider needs an API key before evaluation.');
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 500 || !Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > 3600) throw new Error('Invalid evaluation limits.');
  const baseline = options.baseline ?? (active.find(p => p.id === 'claude')?.id ?? active[0].id);
  if (!active.some(p => p.id === baseline)) throw new Error('The fixed baseline must be a selected provider.');
  const selected = options.cases ?? qualityCases, startedAt = new Date().toISOString();
  const signal = AbortSignal.any([external, AbortSignal.timeout(options.timeoutSeconds * 1000)]);
  let calls = 0, limitReached = false;
  const guardedFetch: typeof fetch = async (url, init) => {
    signal.throwIfAborted();
    if (calls >= options.maxCalls) { limitReached = true; throw new Error('Evaluation call limit reached.'); }
    calls++;
    const response = await fetcher(url, init);
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
    return response;
  };
  const results: CaseReport[] = selected.map(item => ({ id: item.id, category: item.category, question: item.question, ...(item.context ? { context: item.context } : {}), expected: item.expected, baseline: Object.fromEntries(active.map(p => [p.id, { status: 'not_run' }])), team: { status: 'not_run' }, baselineRun: emptyPhase(), teamRun: emptyPhase(), ...(options.includeAnswers ? { answers: { baseline: {} } } : {}) }));
  let status: 'complete' | 'call_limit' | 'cancelled' | 'timeout' = 'complete';
  const lead = active.find(p => p.id === 'claude')?.id ?? active[0].id;
  outer: for (const [index, item] of selected.entries()) {
    const row = results[index];
    for (const phase of ['baseline', 'team'] as const) {
      if (signal.aborted) { status = external.aborted ? 'cancelled' : 'timeout'; break outer; }
      if (calls >= options.maxCalls) { status = 'call_limit'; break outer; }
      const run = phase === 'baseline' ? row.baselineRun : row.teamRun;
      const beforeCalls = calls, phaseStarted = performance.now();
      const providerStarted: Partial<Record<ProviderId, number>> = {};
      const completedDrafts: Partial<Record<ProviderId, string>> = {};
      let latestUsage: Usage | undefined, result: Result | undefined;
      try {
        result = await orchestrate({ question: item.question, context: item.context, connections, mode: phase === 'baseline' ? 'compare' : options.mode, lead }, event => {
          if (event.usage) latestUsage = event.usage;
          if (phase === 'baseline' && event.phase === 'draft' && event.type === 'contribution_start' && event.provider) providerStarted[event.provider] ??= performance.now();
          if (event.type === 'draft' && event.provider && event.text) {
            completedDrafts[event.provider] = event.text;
            if (phase === 'baseline' && providerStarted[event.provider] !== undefined) run.providerElapsedMs[event.provider] = Math.round(performance.now() - providerStarted[event.provider]!);
          }
        }, signal, guardedFetch);
        run.state = 'completed'; run.usage = result.usage ?? latestUsage; run.notes = result.errors;
        run.degraded = Boolean(result.fallback || result.errors.length || active.some(p => !result!.drafts[p.id]));
        if (phase === 'baseline') for (const p of active) { row.baseline[p.id] = scoreAnswer(result.drafts[p.id], item.expected); if (row.answers) row.answers.baseline[p.id] = result.drafts[p.id]; }
        else { row.team = scoreAnswer(result.answer, item.expected); if (row.answers) row.answers.team = result.answer; }
      } catch {
        run.state = 'failed'; run.degraded = true; run.usage = latestUsage; run.notes = ['This evaluation phase did not complete.'];
        if (phase === 'baseline') for (const p of active) { row.baseline[p.id] = scoreAnswer(completedDrafts[p.id], item.expected); if (row.answers) row.answers.baseline[p.id] = completedDrafts[p.id]; }
        else row.team = { status: 'no_answer' };
      }
      run.httpCalls = calls - beforeCalls;
      run.elapsedMs = Math.round(performance.now() - phaseStarted);
      if (signal.aborted) { status = external.aborted ? 'cancelled' : 'timeout'; break outer; }
      if (limitReached) { status = 'call_limit'; break outer; }
    }
  }
  const count = (verdicts: Verdict[]) => ({ passed: verdicts.filter(v => v.status === 'pass').length, total: verdicts.length, notRun: verdicts.filter(v => v.status === 'not_run').length });
  return redactReport({
    version: 2, baseline, startedAt, finishedAt: new Date().toISOString(), status, mode: options.mode, calls, maxCalls: options.maxCalls,
    models: Object.fromEntries(active.map(p => [p.id, connections[p.id].model])),
    comparison: compareOutcomes(results, baseline, active.map(p => p.id)),
    summary: { baseline: Object.fromEntries(active.map(p => [p.id, count(results.map(r => r.baseline[p.id]!))])), team: count(results.map(r => r.team)), degradedPhases: results.reduce((n, r) => n + Number(r.baselineRun.degraded) + Number(r.teamRun.degraded), 0) },
    limitations: 'Small synthetic regression suite, not proof of general accuracy, fairness, or freedom from bias. Independent baselines and team runs are separate samples. JSON-format failures are distinct from wrong values. No fresh web research, private conversations, or human quality judgments are included. Exact JSON tasks do not measure open-ended usefulness. Paired outcome differences concern separate samples and do not prove that collaboration caused an error or correction. Format failures and degraded/incomplete phases are excluded from paired correctness counts. Baseline calls run concurrently: use providerElapsedMs and usage.byProvider for individual comparisons; baseline phase totals describe the whole concurrent group, not a single model. calls and per-phase httpCalls count actual HTTP attempts; usage call counters may include attempts blocked by the budget. Reported usage may omit charges from interrupted or failed calls; provider invoices remain authoritative.',
    results,
  }, connections);
}
