'use client';

import { useId } from 'react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { providers, type Mode, type ProviderId } from '@/lib/trio';

type Choice = { title: string; desc: string; calls: string };
export function AnswerControls({ mode, lead, modes, loading, busy, runMode, demo, research, onMode, onLead }: { mode: Mode; lead: ProviderId; modes: Record<Mode, Choice>; loading: boolean; busy: boolean; runMode: Mode; demo: boolean; research: boolean; onMode: (mode: Mode) => void; onLead: (lead: ProviderId) => void }) {
  const id = useId();
  return <section className="answer-controls" aria-label="Next answer settings">
    <span className="sr-only">{busy ? `Next question’s settings. ${modes[runMode].title} is running.` : 'Answer settings'}</span>
    <RadioGroup className="answer-mode-choices" aria-label="Answer mode" value={mode} onValueChange={value => onMode(value as Mode)} disabled={loading}>
      {(Object.entries(modes) as [Mode, Choice][]).map(([value, choice]) => <label className="answer-mode-choice" key={value} htmlFor={`${id}-${value}`} title={`${choice.desc} ${demo ? 'No API usage' : choice.calls}`}><RadioGroupItem id={`${id}-${value}`} value={value} aria-label={choice.title} /><span>{choice.title}</span></label>)}
    </RadioGroup>
    <div className="mobile-answer-mode"><Select value={mode} onValueChange={value => onMode(value as Mode)} disabled={loading}><SelectTrigger aria-label="Answer mode"><SelectValue /></SelectTrigger><SelectContent className="mode-menu">{(Object.entries(modes) as [Mode, Choice][]).map(([value, choice]) => <SelectItem key={value} value={value} textValue={choice.title}><span className="mode-menu-option"><strong>{choice.title}</strong><small>{choice.desc}</small></span></SelectItem>)}</SelectContent></Select></div>
    <label className="answer-model-choice"><span className="sr-only">{mode === 'single' ? 'Answer model' : 'Final writer'}</span><Select value={lead} onValueChange={value => onLead(value as ProviderId)} disabled={loading}><SelectTrigger aria-label="Answer model" title={mode === 'single' ? 'Answer model' : 'Final writer'}><SelectValue /></SelectTrigger><SelectContent>{providers.map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</SelectContent></Select></label>
  </section>;
}
