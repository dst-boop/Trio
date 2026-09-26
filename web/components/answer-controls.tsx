'use client';

import { useId } from 'react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { providers, type Mode, type ProviderId } from '@/lib/trio';

type Choice = { title: string; desc: string; calls: string };
export function AnswerControls({ mode, lead, modes, loading, busy, runMode, demo, research, onMode, onLead }: { mode: Mode; lead: ProviderId; modes: Record<Mode, Choice>; loading: boolean; busy: boolean; runMode: Mode; demo: boolean; research: boolean; onMode: (mode: Mode) => void; onLead: (lead: ProviderId) => void }) {
  const id = useId();
  return <section className="answer-controls" aria-label="Next answer settings">
    <div className="answer-controls-heading"><strong>{busy ? 'Next question’s answer mode' : 'Answer mode'}</strong>{busy && <span role="status">{modes[runMode].title} is running. These choices apply to your next question.</span>}</div>
    <RadioGroup className="answer-mode-choices" aria-label="Answer mode" value={mode} onValueChange={value => onMode(value as Mode)} disabled={loading}>
      {(Object.entries(modes) as [Mode, Choice][]).map(([value, choice]) => <label className="answer-mode-choice" key={value} htmlFor={`${id}-${value}`}><RadioGroupItem id={`${id}-${value}`} value={value} aria-label={choice.title} /><span>{choice.title}</span></label>)}
    </RadioGroup>
    <div className="answer-controls-detail"><div><p>{modes[mode].desc}</p><small>{demo ? 'Prepared example · no API usage' : modes[mode].calls + (research ? ' · research adds calls and search fees' : '')}</small></div><label><span>{mode === 'single' ? 'Answer model' : 'Final writer'}</span><Select value={lead} onValueChange={value => onLead(value as ProviderId)} disabled={loading}><SelectTrigger aria-label="Answer model"><SelectValue /></SelectTrigger><SelectContent>{providers.map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent></Select></label></div>
  </section>;
}
