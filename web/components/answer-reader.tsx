'use client';

import { useId, useRef, useState } from 'react';
import { Answer } from '@/components/answer';

/** Long responses open in place, without trapping reading inside another scrollbar. */
export function AnswerReader({ text, label = 'Answer' }: { text: string; label?: string }) {
  const id = useId(), viewport = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 1800 || text.split('\n').length > 28;
  const excerpt = text.slice(0, 1400).split('\n').slice(0, 18).join('\n');
  const boundary = Math.max(excerpt.lastIndexOf('\n\n'), excerpt.lastIndexOf('. '));
  const preview = (boundary > 700 ? excerpt.slice(0, boundary + 1) : excerpt).trimEnd() + '\n\n…';
  return <div className={`answer-reader${expanded ? ' is-expanded' : ''}`}>
    {long && !expanded && <div className="reader-preview-label"><span>Response preview</span><button type="button" className="subtle-button" aria-controls={id} aria-expanded={false} onClick={() => setExpanded(true)}>Read full response ↓</button></div>}
    <div ref={viewport} id={id} className="answer-reader-viewport" role="region" aria-label={label}><Answer text={long && !expanded ? preview : text} /></div>
    {long && <div className="answer-reader-tools"><button type="button" className="subtle-button" aria-controls={id} aria-expanded={expanded} onClick={() => {
      if (expanded) viewport.current?.scrollIntoView({ block: 'start' });
      setExpanded(value => !value);
    }}>{expanded ? 'Show less' : 'Read full response'}<span aria-hidden="true">{expanded ? '↑' : '↓'}</span></button><span>{expanded ? 'Full response' : 'Full text is included when you copy or export'}</span></div>}
  </div>;
}
