import { Check, Minus, CircleAlert } from 'lucide-react';
import { answerLabel, coverageStateNames, evidenceLimit, runCoverage } from '@/lib/run-coverage';
import type { Mode, Result } from '@/lib/trio';

export function RunCoverage({ result, mode }: { result: Result; mode: Mode }) {
  if (result.demo) return null;
  const steps = runCoverage(result, mode);
  const review = steps.find(s => s.phase === 'review')!;
  return <details className="run-coverage"><summary>Review &amp; evidence <span>{review.state === 'complete' ? 'Peer reviews returned' : review.state === 'partial' ? 'Some reviews missing' : 'No peer review'}</span></summary><div><p>{evidenceLimit}</p><dl>{steps.map(step => <div key={step.phase}><dt>{step.label}<span className={`coverage-state ${step.state}`}>{coverageStateNames[step.state]}</span></dt><dd>{step.detail}</dd></div>)}</dl></div></details>;
}

export function RunPipeline({ result, mode, busy, stage }: { result: Result; mode: Mode; busy: boolean; stage: string }) {
  const steps = runCoverage(result, mode).filter(s => s.phase === 'research' ? result.researchRequested : s.phase === 'review' ? mode === 'council' || mode === 'deep' : s.phase === 'revision' ? mode === 'deep' : s.phase === 'synthesis' ? mode !== 'compare' && mode !== 'single' : true);
  return <div className="pipeline" aria-label="Run progress" aria-live="polite">{steps.map((step, i) => {
    // Partial streamed text must not earn a completion check after Stop or interruption.
    const state = busy ? step.phase === stage ? 'current' : 'pending' : stage === 'failed' ? 'interrupted' : step.state;
    const status = state === 'current' ? 'In progress' : state === 'pending' ? 'Pending' : state === 'interrupted' ? 'Run interrupted' : coverageStateNames[state];
    return <div key={step.phase} className={state} aria-label={`${step.label}: ${status}`}><span aria-hidden="true">{state === 'complete' ? <Check size={13} /> : state === 'partial' || state === 'unavailable' ? <CircleAlert size={13} /> : state === 'skipped' ? <Minus size={13} /> : `0${i + 1}`}</span>{step.label}{['partial', 'skipped', 'unavailable', 'sample'].includes(state) && <small>{status}</small>}{state === 'current' && <i className="pulse-dot" />}</div>;
  })}</div>;
}

export { answerLabel };
