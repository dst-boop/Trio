'use client';

import { maxSessionInstructions } from '@/lib/instructions';

export function SessionInstructions({ value, busy, demo, onChange }: { value: string; busy: boolean; demo: boolean; onChange: (value: string) => void }) {
  return <details className="session-instructions"><summary><strong>Session instructions</strong><span>{value.trim() ? 'Configured for this session' : 'Optional · guide every model'}</span></summary>
    <div className="instructions-editor"><label htmlFor="session-instructions">Audience, constraints, and answer format</label><textarea id="session-instructions" aria-label="Session instructions" value={value} disabled={busy} maxLength={maxSessionInstructions} onChange={event => onChange(event.target.value)} placeholder={'Audience: a small team with limited technical experience.\nConstraints: keep the plan under $500 and identify assumptions.\nFormat: a short recommendation, tradeoffs, and three next steps.'} />
    <div className="instructions-actions"><span>{value.length.toLocaleString()} / {maxSessionInstructions.toLocaleString()} characters</span><button className="subtle-button" disabled={busy || !value} onClick={() => onChange('')}>Clear instructions</button></div>
    <p>{demo ? 'Demo ignores these instructions. They apply when you switch to Live.' : 'Every model receives these instructions for future questions in this session. Your current question takes precedence when it conflicts.'}</p><small>Completed answers keep the instructions they used. New sessions start blank. Local history and backups include session instructions.</small></div>
  </details>;
}

export function InstructionsUsed({ value }: { value?: string }) {
  return value ? <details className="instructions-used"><summary>Instructions used for this answer</summary><pre>{value}</pre></details> : null;
}
