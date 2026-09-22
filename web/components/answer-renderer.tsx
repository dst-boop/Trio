'use client';

import { useRef, useState, type ComponentProps } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';

function CodeBlock({ children, ...props }: ComponentProps<'pre'>) {
  const block = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(block.current?.textContent ?? '');
      setCopied(true); toast.success('Code copied');
    } catch { toast.error('Clipboard unavailable. Select and copy the code manually.'); }
  }
  return <div className="code-block"><div className="code-toolbar"><span>Code</span><button onClick={() => void copy()} aria-label="Copy code">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy'}</button></div><pre ref={block} {...props}>{children}</pre></div>;
}

/** No raw HTML, embedded media, or executable links from model-generated text. */
export function Answer({ text }: { text: string }) {
  return <div className="prose-answer"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
    a: ({ node: _node, href, children, ...props }) => href ? <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span className="unloaded-image">[Image: {alt || 'model-provided image'}]</span>,
    table: ({ node: _node, ...props }) => <div className="answer-table" role="region" aria-label="Answer table" tabIndex={0}><table {...props} /></div>,
  }}>{text}</Markdown></div>;
}
