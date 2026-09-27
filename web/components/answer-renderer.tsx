'use client';

import { useRef, useState, type ComponentProps } from 'react';
import Markdown, { type Components } from 'react-markdown';
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

// Stable component identities preserve code selection and copy state as text streams.
const plugins = [remarkGfm];
/** react-markdown passes its hast `node`; it must not reach the DOM. */
function withoutNode<P extends { node?: unknown }>(props: P): Omit<P, 'node'> { const rest = { ...props }; delete rest.node; return rest; }
const components: Components = {
    pre: props => <CodeBlock {...withoutNode(props)} />,
    a: ({ href, children, ...props }) => href ? <a {...withoutNode(props)} href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span className="unloaded-image">[Image: {alt || 'model-provided image'}]</span>,
    table: props => <div className="answer-table" role="region" aria-label="Answer table" tabIndex={0}><table {...withoutNode(props)} /></div>,
};

/** No raw HTML, embedded media, or executable links from model-generated text. */
export function Answer({ text }: { text: string }) {
  return <div className="prose-answer"><Markdown remarkPlugins={plugins} skipHtml components={components}>{text}</Markdown></div>;
}
