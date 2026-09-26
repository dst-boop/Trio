'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Answer } from '@/components/answer';

/** Keep the full answer available without making the whole workspace grow with it. */
export function AnswerReader({ text, label = 'Answer' }: { text: string; label?: string }) {
  const id = useId(), viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false), [overflows, setOverflows] = useState(false);
  useEffect(() => {
    if (expanded || !viewport.current || !content.current) return;
    const measure = () => setOverflows(content.current!.scrollHeight > viewport.current!.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport.current); observer.observe(content.current);
    return () => observer.disconnect();
  }, [expanded, text]);
  return <div className={`answer-reader${expanded ? ' is-expanded' : ''}`}>
    {(overflows || expanded) && <div className="answer-reader-tools"><span>{expanded ? 'Full page view' : 'Scroll here to read the full response'}</span><button type="button" className="subtle-button" aria-controls={id} aria-expanded={expanded} onClick={() => {
      if (expanded) viewport.current?.scrollIntoView({ block: 'start' });
      setExpanded(value => !value);
    }}>{expanded ? 'Compact view' : 'Expand response'}</button></div>}
    <div ref={viewport} id={id} className="answer-reader-viewport" role="region" aria-label={label} tabIndex={overflows && !expanded ? 0 : undefined}><div ref={content}><Answer text={text} /></div></div>
  </div>;
}
